import type { V1Service } from "@kubernetes/client-node";
import { SANDBOX_PUBLIC_PORTS, type SpacePublicEndpoints } from "@cohub/protocol/ports";
import {
  getSandboxPublicRouteName,
  getSandboxPublicServiceName,
  SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP,
  SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_PLURAL,
  SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION,
} from "@cohub/sandbox-controller";
import { config, sessionsNamespace } from "./config.js";
import { getKubernetesClients } from "./k8s.js";

export { getSandboxPublicRouteName, getSandboxPublicServiceName } from "@cohub/sandbox-controller";

type SandboxPublicPort = (typeof SANDBOX_PUBLIC_PORTS)[number];
const GATEWAY_NAMESPACE = "kube-system";
const GATEWAY_NAME = "traefik-gateway";

type HttpRouteObject = {
  apiVersion: `${typeof SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP}/${typeof SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION}`;
  kind: "HTTPRoute";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    resourceVersion?: string;
  };
  spec: {
    parentRefs: Array<{ name: string; namespace: string }>;
    hostnames: string[];
    rules: Array<{
      matches: Array<{
        path: { type: "PathPrefix"; value: "/" };
      }>;
      backendRefs: Array<{ name: string; port: SandboxPublicPort }>;
    }>;
  };
};

const getK8sStatusCode = (error: unknown) => {
  return (error as { statusCode?: number; code?: number }).statusCode
    ?? (error as { statusCode?: number; code?: number }).code
    ?? null;
};

export const getSandboxPublicHostname = (
  spaceId: string,
  port: SandboxPublicPort,
  domain = config.sandboxPublicDomains[0],
) => {
  const prefix = config.env === "prod" ? "s" : "d";
  return `${prefix}-${spaceId}-${port}.${domain}`;
};

export const getSandboxPublicEndpoints = (spaceId: string) => {
  return Object.fromEntries(
    SANDBOX_PUBLIC_PORTS.map((port) => [port, {
      url: `https://${getSandboxPublicHostname(spaceId, port)}`,
      status: "unknown" as const,
    }]),
  ) as SpacePublicEndpoints;
};

const isPortStatus = (value: unknown): value is "listening" | "closed" =>
  value === "listening" || value === "closed";

const getCachedPortStatuses = (sandbox: { meta?: unknown }) => {
  const meta = sandbox.meta && typeof sandbox.meta === "object" && !Array.isArray(sandbox.meta)
    ? sandbox.meta as Record<string, unknown>
    : null;
  const ports = meta?.ports;
  if (!ports || typeof ports !== "object" || Array.isArray(ports)) return new Map<number, { status: "listening" | "closed"; observedAt?: number }>();
  const result = new Map<number, { status: "listening" | "closed"; observedAt?: number }>();
  for (const [key, raw] of Object.entries(ports as Record<string, unknown>)) {
    const port = Number(key);
    if (!Number.isInteger(port)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const status = (raw as { status?: unknown }).status;
    if (!isPortStatus(status)) continue;
    const observedAt = (raw as { observedAt?: unknown }).observedAt;
    result.set(port, { status, observedAt: typeof observedAt === "number" ? observedAt : undefined });
  }
  return result;
};

export const attachSandboxPublicEndpoints = <T extends { spaceId: string; meta?: unknown }>(sandbox: T | null) => {
  if (!sandbox) return null;
  const statuses = getCachedPortStatuses(sandbox);
  const endpoints = getSandboxPublicEndpoints(sandbox.spaceId);
  for (const [portKey, endpoint] of Object.entries(endpoints)) {
    const status = statuses.get(Number(portKey));
    if (status) endpoints[portKey] = { ...endpoint, ...status };
  }
  return {
    ...sandbox,
    publicEndpoints: endpoints,
  };
};

const buildSandboxPublicService = (spaceId: string): V1Service => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: {
    name: getSandboxPublicServiceName(spaceId),
    namespace: sessionsNamespace,
    labels: {
      app: "agent-sandbox",
      "space-id": spaceId,
      "cohub.dev/public-service": "true",
    },
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "agent-sandbox",
      "space-id": spaceId,
    },
    ports: SANDBOX_PUBLIC_PORTS.map((port) => ({
      name: `p${port}`,
      port,
      targetPort: port,
      protocol: "TCP",
    })),
  },
});

const buildSandboxPublicRoute = (spaceId: string, port: SandboxPublicPort): HttpRouteObject => ({
  apiVersion: `${SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP}/${SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION}`,
  kind: "HTTPRoute",
  metadata: {
    name: getSandboxPublicRouteName(spaceId, port),
    namespace: sessionsNamespace,
    labels: {
      app: "agent-sandbox",
      "space-id": spaceId,
      "cohub.dev/public-route": "true",
    },
  },
  spec: {
    parentRefs: [{
      name: GATEWAY_NAME,
      namespace: GATEWAY_NAMESPACE,
    }],
    hostnames: config.sandboxPublicDomains.map((domain) =>
      getSandboxPublicHostname(spaceId, port, domain),
    ),
    rules: [{
      matches: [{
        path: {
          type: "PathPrefix",
          value: "/",
        },
      }],
      backendRefs: [{
        name: getSandboxPublicServiceName(spaceId),
        port,
      }],
    }],
  },
});

const reconcileSandboxPublicService = async (spaceId: string) => {
  const { k8sCoreApi } = await getKubernetesClients();
  const name = getSandboxPublicServiceName(spaceId);
  const desired = buildSandboxPublicService(spaceId);

  try {
    const existing = await k8sCoreApi.readNamespacedService({
      name,
      namespace: sessionsNamespace,
    });
    desired.metadata = {
      ...(desired.metadata ?? {}),
      resourceVersion: existing.metadata?.resourceVersion,
    };
    desired.spec = {
      ...(desired.spec ?? {}),
      clusterIP: existing.spec?.clusterIP,
      clusterIPs: existing.spec?.clusterIPs,
      internalTrafficPolicy: existing.spec?.internalTrafficPolicy,
      ipFamilies: existing.spec?.ipFamilies,
      ipFamilyPolicy: existing.spec?.ipFamilyPolicy,
      sessionAffinity: existing.spec?.sessionAffinity,
    };
    await k8sCoreApi.replaceNamespacedService({
      name,
      namespace: sessionsNamespace,
      body: desired,
    });
  } catch (error: unknown) {
    if (getK8sStatusCode(error) !== 404) throw error;
    await k8sCoreApi.createNamespacedService({
      namespace: sessionsNamespace,
      body: desired,
    });
  }
};

const reconcileSandboxPublicRoute = async (spaceId: string, port: SandboxPublicPort) => {
  const { k8sCustomObjectsApi } = await getKubernetesClients();
  const name = getSandboxPublicRouteName(spaceId, port);
  const desired = buildSandboxPublicRoute(spaceId, port);

  try {
    const existing = await k8sCustomObjectsApi.getNamespacedCustomObject({
      group: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP,
      version: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION,
      namespace: sessionsNamespace,
      plural: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_PLURAL,
      name,
    }) as { metadata?: { resourceVersion?: string } };
    desired.metadata.resourceVersion = existing.metadata?.resourceVersion;
    await k8sCustomObjectsApi.replaceNamespacedCustomObject({
      group: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP,
      version: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION,
      namespace: sessionsNamespace,
      plural: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_PLURAL,
      name,
      body: desired,
    });
  } catch (error: unknown) {
    if (getK8sStatusCode(error) !== 404) throw error;
    await k8sCustomObjectsApi.createNamespacedCustomObject({
      group: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP,
      version: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION,
      namespace: sessionsNamespace,
      plural: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_PLURAL,
      body: desired,
    });
  }
};

export const reconcileSandboxPublicNetwork = async (spaceId: string) => {
  await reconcileSandboxPublicService(spaceId);
  await Promise.all(SANDBOX_PUBLIC_PORTS.map((port) => reconcileSandboxPublicRoute(spaceId, port)));
};

export const deleteSandboxPublicNetwork = async (spaceId: string) => {
  const { k8sCoreApi, k8sCustomObjectsApi } = await getKubernetesClients();
  await Promise.allSettled([
    ...SANDBOX_PUBLIC_PORTS.map(async (port) => {
      try {
        await k8sCustomObjectsApi.deleteNamespacedCustomObject({
          group: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP,
          version: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION,
          namespace: sessionsNamespace,
          plural: SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_PLURAL,
          name: getSandboxPublicRouteName(spaceId, port),
        });
      } catch (error: unknown) {
        if (getK8sStatusCode(error) !== 404) throw error;
      }
    }),
    (async () => {
      try {
        await k8sCoreApi.deleteNamespacedService({
          name: getSandboxPublicServiceName(spaceId),
          namespace: sessionsNamespace,
        });
      } catch (error: unknown) {
        if (getK8sStatusCode(error) !== 404) throw error;
      }
    })(),
  ]);
};
