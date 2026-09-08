import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AuthUserProfile } from "@cohub/identity";
import { hasLoopbackLocalModeEntry } from "./access.js";
import { desktopInstance, hasDesktopAccess } from "./desktop-instance.js";
import { parseLocalDesktopIdentity, readPersonalNodeCloudAuthRecord, type LocalDesktopIdentity } from "./personal-node-cloud-auth.js";

const PREFIX = "cohub-local-v1.";
const LIFETIME_SECONDS = 3_600;
type Dependencies = { env?: NodeJS.ProcessEnv; now?: number; readIdentity?: () => Promise<LocalDesktopIdentity | null | undefined> };

async function identity(deps: Dependencies) {
  const value = deps.readIdentity ? await deps.readIdentity() : (await readPersonalNodeCloudAuthRecord())?.localIdentity;
  return value == null ? value : parseLocalDesktopIdentity(value);
}

function identityFingerprint(value: LocalDesktopIdentity) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireDesktop(request: Request, deps: Dependencies) {
  const env = deps.env ?? process.env;
  const instance = desktopInstance(env);
  if (env.COHUB_NODE_ORIGIN !== "local" || !instance || !hasLoopbackLocalModeEntry(request) || !hasDesktopAccess(request, env)) throw new Error("Local desktop authorization requires its owning instance");
  return instance;
}

export async function createDesktopLocalAccessToken(request: Request, issuer: string, deps: Dependencies = {}) {
  const instance = requireDesktop(request, deps);
  const current = await identity(deps);
  // Legacy installations keep their existing cloud login until their next
  // verified registration establishes the persistent local account binding.
  if (!current) return undefined;
  if (current.issuer !== issuer) throw new Error("Desktop account issuer does not match this installation");
  const now = Math.floor((deps.now ?? Date.now()) / 1_000);
  const payload = Buffer.from(JSON.stringify({
    aud: "cohub-local-api", instanceId: instance.id, binding: identityFingerprint(current),
    sub: current.subject, talesofai_uuid: current.userUuid, iat: now, exp: now + LIFETIME_SECONDS,
  })).toString("base64url");
  const message = `${PREFIX}${payload}`;
  return `${message}.${createHmac("sha256", instance.secret).update(message).digest("base64url")}`;
}

export async function verifyDesktopLocalAccessToken(token: string, request: Request, issuer: string, deps: Dependencies = {}): Promise<AuthUserProfile | undefined> {
  if (!token.startsWith(PREFIX)) return undefined;
  const instance = requireDesktop(request, deps);
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) throw new Error("Local desktop token is invalid");
  const expected = createHmac("sha256", instance.secret).update(`${PREFIX}${parts[1]}`).digest();
  const provided = Buffer.from(parts[2]!, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("Local desktop token signature is invalid");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  const now = Math.floor((deps.now ?? Date.now()) / 1_000);
  if (payload.aud !== "cohub-local-api" || payload.instanceId !== instance.id || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.exp <= now || payload.iat > now + 30 || payload.exp - payload.iat > LIFETIME_SECONDS) throw new Error("Local desktop token is expired or belongs to another instance");
  const current = await identity(deps);
  if (!current || current.issuer !== issuer || payload.binding !== identityFingerprint(current) || payload.sub !== current.subject || payload.talesofai_uuid !== current.userUuid) throw new Error("Local desktop account changed or was disconnected");
  return { uuid: current.userUuid, sub: current.subject, clientId: current.clientId };
}
