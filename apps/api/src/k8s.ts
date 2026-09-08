import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
const createKubernetesClients = async () => {
  const { CoreV1Api, CustomObjectsApi, Exec, KubeConfig } = await import("@kubernetes/client-node");
  const kubeConfig = new KubeConfig();

  let kubeconfigPath = process.env.KUBECONFIG;
  if (kubeconfigPath) {
    // Expand ~ to home directory
    if (kubeconfigPath.startsWith("~")) {
      kubeconfigPath = homedir() + kubeconfigPath.slice(1);
    }
    if (existsSync(kubeconfigPath)) {
      kubeConfig.loadFromFile(kubeconfigPath);
    } else {
      logger.warn(
        `KUBECONFIG file not found: ${kubeconfigPath}, falling back to default`,
      );
      kubeConfig.loadFromDefault();
    }
  } else {
    kubeConfig.loadFromDefault();
  }

  return {
    kubeConfig,
    k8sCoreApi: kubeConfig.makeApiClient(CoreV1Api),
    k8sCustomObjectsApi: kubeConfig.makeApiClient(CustomObjectsApi),
    k8sExec: new Exec(kubeConfig),
  };
};

let clients: ReturnType<typeof createKubernetesClients> | undefined;

// Local nodes never use Kubernetes. Keep its generated SDK off their startup path.
export const getKubernetesClients = () => clients ??= createKubernetesClients();
