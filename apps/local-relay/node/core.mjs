import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { requestBodyParts, responseBodyParts } from "./http-body.mjs";

const PROMPT_PATH_PATTERN = /^\/api\/spaces\/([0-9a-f-]{36})\/prompt$/i;
const FEDERATED_FS_PATH_PATTERN =
  /^\/api\/spaces\/([0-9a-f-]{36})\/fs\/(tree|file|dir|node|move)(?:\?.*)?$/i;
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ALPHA_LOCAL_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALPHA_LOCAL_API_DENIED_PATHS = [
	/^\/api\/local-mode(?:\/|$)/,
	new RegExp(`^/api/spaces/${UUID_SOURCE}/env(?:/|$)`, "i"),
];
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 60_000;
const RELAY_ATTACHMENT_REFERENCE_SOURCE =
	"(?:relay-attachment:\\/\\/([0-9a-f-]{36})|(?:\\/relay\\/v1|\\/api\\/alpha\\/v1)\\/nodes\\/[^/\\s]+\\/attachments\\/([0-9a-f-]{36})\\/content)";

function relayAttachmentReferencePattern() {
  return new RegExp(RELAY_ATTACHMENT_REFERENCE_SOURCE, "gi");
}

function publicAttachmentBasePath(relayNodeBaseUrl, nodeId) {
	const pathname = new URL(relayNodeBaseUrl).pathname;
	return pathname.startsWith("/api/alpha/v1/nodes/")
		? pathname
		: `/relay/v1/nodes/${encodeURIComponent(nodeId)}`;
}

export function isAlphaLocalApiRequest(method, path) {
	if (
		typeof method !== "string" ||
		!ALPHA_LOCAL_API_METHODS.has(method) ||
		typeof path !== "string" ||
		!path.startsWith("/")
	) {
    return false;
  }
  let url;
  try {
    url = new URL(path, "https://alpha.internal");
  } catch {
    return false;
  }
  return (
		url.origin === "https://alpha.internal" &&
		url.pathname.startsWith("/api/") &&
		!ALPHA_LOCAL_API_DENIED_PATHS.some((pattern) => pattern.test(url.pathname))
  );
}

export class RelayNodeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RelayNodeError";
    this.code = code;
  }
}

async function readLimitedResponseBytes(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RelayNodeError(
          "local_response_too_large",
          `Local API response exceeds ${maxBytes} bytes`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

export async function readLimitedResponseBody(response, maxBytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readLimitedResponseBytes(response, maxBytes));
}

const requestHeaders = ["content-type", "accept", "range", "if-match", "if-none-match", "if-modified-since", "x-cohub-fs-mutation-id"];
const resultHeaders = ["content-type", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", "retry-after", "x-request-id", "vary"];

function forwardedHeaders(source, names) {
  const incoming = new Headers(source);
  return Object.fromEntries(names.flatMap((name) => incoming.has(name) ? [[name, incoming.get(name)]] : []));
}

export async function resolveLocalAccessToken(
  fetcher,
  localApiOrigin,
  signal,
  { forceRefresh = false } = {},
) {
	let response;
	try {
		const query = new URLSearchParams();
		if (forceRefresh) query.set("refresh", "1");
		if (process.env.COHUB_DESKTOP_INSTANCE_SECRET) query.set("desktop", "1");
		response = await fetcher(
			`${localApiOrigin}/api/local-mode/auth${query.size ? `?${query}` : ""}`,
			{
			method: "GET",
			cache: "no-store",
			signal,
			},
		);
  } catch (error) {
    throw new RelayNodeError(
      "local_api_unavailable",
      `Local Cohub authentication endpoint is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new RelayNodeError(
      "local_auth_failed",
      `Local Cohub authentication returned HTTP ${response.status}`,
    );
  }
  const payload = await response.json().catch(() => null);
  const accessToken = payload?.accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new RelayNodeError(
      "local_auth_invalid",
      "Local Cohub authentication returned no access token",
    );
  }
  return accessToken.trim();
}

function replaceRelayAttachmentUris(value, replacements) {
  if (typeof value === "string") {
    return value.replace(
      relayAttachmentReferencePattern(),
      (uri, schemeId, contentPathId) =>
        replacements.get((schemeId ?? contentPathId).toLowerCase()) ?? uri,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceRelayAttachmentUris(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceRelayAttachmentUris(item, replacements),
      ]),
    );
  }
  return value;
}

function replaceExactStrings(value, replacements) {
  if (typeof value === "string") {
    let next = value;
    for (const [from, to] of replacements) next = next.replaceAll(from, to);
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceExactStrings(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceExactStrings(item, replacements),
      ]),
    );
  }
  return value;
}

async function materializeRelayAttachment(attachment, {
  fetcher,
  attachmentRoot,
  relayNodeBaseUrl,
  relayNodeToken,
  signal,
}) {
  const download = await fetcher(
    `${relayNodeBaseUrl}/attachments/${encodeURIComponent(attachment.id)}/content`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${relayNodeToken}`,
        "x-cohub-relay-node": "1",
      },
      cache: "no-store",
      signal,
    },
  ).catch((error) => {
    throw new RelayNodeError(
      "attachment_download_failed",
      `Relay attachment download failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  if (!download.ok || !download.body) {
    throw new RelayNodeError(
      "attachment_download_failed",
      `Relay attachment download returned HTTP ${download.status}`,
    );
  }
  if (
    download.headers.get("x-cohub-attachment-id") !== attachment.id ||
    Number(download.headers.get("x-cohub-attachment-size")) !== attachment.size ||
    download.headers.get("content-type")?.toLowerCase() !== attachment.contentType ||
    download.headers.get("x-cohub-attachment-sha256")?.toLowerCase() !==
      attachment.sha256
  ) {
    throw new RelayNodeError(
      "attachment_identity_mismatch",
      `Relay attachment ${attachment.id} does not match its declared identity`,
    );
  }
  if (!attachmentRoot) {
    throw new RelayNodeError(
      "attachment_local_storage_missing",
      "Local attachment storage is not configured",
    );
  }
  if (
    attachment.name === "." ||
    attachment.name === ".." ||
    attachment.name.includes("/") ||
    attachment.name.includes("\\") ||
    /[\0\r\n]/.test(attachment.name)
  ) {
    throw new RelayNodeError(
      "attachment_local_path_invalid",
      "Relay attachment name is not a plain filename",
    );
  }
  const directory = resolve(attachmentRoot, attachment.id);
  const target = resolve(directory, attachment.name);
  if (!target.startsWith(`${directory}${sep}`)) {
    throw new RelayNodeError(
      "attachment_local_path_invalid",
      "Relay attachment path escaped local storage",
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.partial`;
  const file = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  const reader = download.body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > attachment.size) {
        throw new RelayNodeError(
          "attachment_identity_mismatch",
          `Relay attachment ${attachment.id} exceeded its declared size`,
        );
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten <= 0) {
          throw new RelayNodeError(
            "attachment_local_write_failed",
            "Local attachment write made no progress",
          );
        }
        offset += bytesWritten;
      }
    }
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  await file.close();
  if (written !== attachment.size || hash.digest("hex") !== attachment.sha256) {
    await rm(temporary, { force: true });
    throw new RelayNodeError(
      "attachment_identity_mismatch",
      `Relay attachment ${attachment.id} bytes failed local verification`,
    );
  }
  await rename(temporary, target);
  return target;
}

async function preparePromptBody(command, options) {
  const attachments = Array.isArray(command.attachments) ? command.attachments : [];
  let parsed;
  try {
    parsed = JSON.parse(command.request.body);
  } catch {
    throw new RelayNodeError("invalid_command", "Relay command body is not valid JSON");
  }
  const referenced = new Set(
    [...command.request.body.matchAll(relayAttachmentReferencePattern())].map(
      (match) => (match[1] ?? match[2]).toLowerCase(),
    ),
  );
  const declared = new Set(attachments.map((item) => item.id.toLowerCase()));
  if ([...referenced].some((id) => !declared.has(id))) {
    throw new RelayNodeError(
      "attachment_ref_not_declared",
      "Prompt contains a relay attachment that is not declared by the command",
    );
  }
  if ([...declared].some((id) => !referenced.has(id))) {
    throw new RelayNodeError(
      "attachment_ref_missing",
      "Command declares an attachment that is not referenced by the prompt",
    );
  }
  if (attachments.length === 0) {
    return { body: command.request.body, responseReplacements: new Map() };
  }
  if (!options.relayNodeBaseUrl || !options.relayNodeToken) {
    throw new RelayNodeError(
      "attachment_relay_auth_missing",
      "Relay attachment authentication is not configured",
    );
  }
  const replacements = new Map();
  const responseReplacements = new Map();
  for (const attachment of attachments) {
    const localUrl = await materializeRelayAttachment(attachment, options);
		const relayUrl = `${publicAttachmentBasePath(options.relayNodeBaseUrl, command.nodeId)}/attachments/${encodeURIComponent(attachment.id)}/content`;
    replacements.set(attachment.id.toLowerCase(), localUrl);
    responseReplacements.set(localUrl, relayUrl);
  }
  return {
    body: JSON.stringify(replaceRelayAttachmentUris(parsed, replacements)),
    responseReplacements,
  };
}

export function restoreRelayAttachmentUris(body, replacements) {
  if (replacements.size === 0) return body;
  try {
    return JSON.stringify(replaceExactStrings(JSON.parse(body), replacements));
  } catch {
    return body;
  }
}

const CONTENT_TYPES_BY_EXTENSION = new Map([
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

function collectMarkdownLinkTargets(value, targets) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))/g)) {
      const target = match[1] ?? match[2];
      if (target) targets.add(target);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMarkdownLinkTargets(item, targets);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectMarkdownLinkTargets(item, targets);
  }
}

function replaceMarkdownLinkTargets(value, replacements) {
  if (typeof value === "string") {
    return value.replace(
      /\]\((?:<([^>]+)>|([^\s)]+))/g,
      (match, angleTarget, plainTarget) => {
        const target = angleTarget ?? plainTarget;
        const replacement = replacements.get(target);
        if (!replacement) return match;
        return angleTarget ? `](<${replacement}>` : `](${replacement}`;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceMarkdownLinkTargets(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceMarkdownLinkTargets(item, replacements),
      ]),
    );
  }
  return value;
}

function decodeArtifactTarget(target) {
  try {
    if (/^file:\/\//i.test(target)) return decodeURIComponent(new URL(target).pathname);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;
    return decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return null;
  }
}

async function resolveReturnedArtifact(target, workspaceRoot, maxBytes) {
  const decoded = decodeArtifactTarget(target);
  if (!decoded) return null;
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, decoded);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  if (info.size <= 0 || info.size > maxBytes) {
    throw new RelayNodeError(
      "returned_attachment_size_invalid",
      `Returned attachment ${basename(candidate)} exceeds the relay size boundary`,
    );
  }
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) {
    throw new RelayNodeError(
      "returned_attachment_path_invalid",
      "Returned attachment escaped the Space workspace",
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(realCandidate)) hash.update(chunk);
  return {
    path: realCandidate,
    workspaceTarget: `/workspace/${relative(realRoot, realCandidate)
      .split(sep)
      .map((segment) => encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ))
      .join("/")}`,
    name: basename(realCandidate),
    size: info.size,
    contentType:
      CONTENT_TYPES_BY_EXTENSION.get(extname(realCandidate).toLowerCase()) ??
      "application/octet-stream",
    sha256: hash.digest("hex"),
  };
}

async function uploadReturnedArtifact(artifact, command, options) {
  if (!options.relayNodeBaseUrl || !options.relayNodeToken) {
    throw new RelayNodeError(
      "returned_attachment_relay_missing",
      "Returned attachment relay authentication is not configured",
    );
  }
  const nodeHeaders = {
    authorization: `Bearer ${options.relayNodeToken}`,
    "content-type": "application/json",
    "x-cohub-relay-node": "1",
  };
  const planResponse = await options.fetcher(
    `${options.relayNodeBaseUrl}/attachments`,
    {
      method: "POST",
      headers: nodeHeaders,
      body: JSON.stringify({
        name: artifact.name,
        size: artifact.size,
        contentType: artifact.contentType,
        sha256: artifact.sha256,
      }),
      cache: "no-store",
      signal: options.signal,
    },
  ).catch((error) => {
    throw new RelayNodeError(
      "returned_attachment_plan_failed",
      `Returned attachment plan failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  const plan = await planResponse.json().catch(() => null);
  if (
    !planResponse.ok ||
    plan?.attachment?.nodeId !== command.nodeId ||
    typeof plan?.attachment?.id !== "string" ||
    typeof plan?.upload?.url !== "string"
  ) {
    throw new RelayNodeError(
      "returned_attachment_plan_failed",
      `Returned attachment plan was rejected with HTTP ${planResponse.status}`,
    );
  }
  const uploadUrl = new URL(plan.upload.url);
  const relayBase = new URL(options.relayNodeBaseUrl);
  const expectedPrefix = `${relayBase.pathname}/attachments/${encodeURIComponent(plan.attachment.id)}/content`;
  if (
    uploadUrl.origin !== relayBase.origin ||
    uploadUrl.pathname !== expectedPrefix
  ) {
    throw new RelayNodeError(
      "returned_attachment_plan_invalid",
      "Returned attachment plan points outside the node relay",
    );
  }
  const upload = await options.fetcher(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${options.relayNodeToken}`,
      "content-length": String(artifact.size),
      "content-type": artifact.contentType,
      "x-cohub-content-sha256": artifact.sha256,
      "x-cohub-relay-node": "1",
    },
    body: artifact.bytes ?? createReadStream(artifact.path),
    duplex: "half",
    cache: "no-store",
    signal: options.signal,
  });
  if (!upload.ok) {
    throw new RelayNodeError(
      "returned_attachment_upload_failed",
      `Returned attachment upload failed with HTTP ${upload.status}`,
    );
  }
	return `${publicAttachmentBasePath(options.relayNodeBaseUrl, command.nodeId)}/attachments/${encodeURIComponent(plan.attachment.id)}/content`;
}

async function persistReturnedArtifactProjection(payload, replacements, options) {
  const sessionId = payload?.session?.id;
  const turnId = payload?.turn?.id;
  if (typeof sessionId !== "string" || typeof turnId !== "string") {
    throw new RelayNodeError(
      "returned_attachment_projection_invalid",
      "Returned attachment response has no session or turn identity",
    );
  }
  let response;
  try {
    response = await options.fetcher(
      `${options.localApiOrigin}/api/local-mode/relay-artifacts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.localAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          turnId,
          replacements: [...replacements].map(([from, to]) => ({ from, to })),
        }),
        cache: "no-store",
        signal: options.signal,
      },
    );
  } catch (error) {
    throw new RelayNodeError(
      "local_artifact_projection_failed",
      `Local returned attachment projection failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const retryable = response.status >= 500;
    throw new RelayNodeError(
      retryable
        ? "local_artifact_projection_failed"
        : "returned_attachment_projection_rejected",
      `Local returned attachment projection returned HTTP ${response.status}`,
    );
  }
}

export async function relayReturnedArtifacts(body, command, options, workspaceRoot) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  const assistantFields = {
    assistantContent: payload?.turn?.assistantContent,
    assistantText: payload?.turn?.assistantText,
    summary: payload?.turn?.summary,
  };
  const targets = new Set();
  collectMarkdownLinkTargets(assistantFields, targets);
  if (targets.size === 0) return body;
  const replacements = new Map();
  const projectionReplacements = new Map();
  for (const target of targets) {
    const artifact = await resolveReturnedArtifact(
      target,
      workspaceRoot,
      options.maxAttachmentBytes,
    );
    if (!artifact) continue;
    replacements.set(
      target,
      await uploadReturnedArtifact(artifact, command, options),
    );
    projectionReplacements.set(target, artifact.workspaceTarget);
  }
  if (replacements.size === 0) return body;
  await persistReturnedArtifactProjection(payload, projectionReplacements, options);
  const nextFields = replaceMarkdownLinkTargets(assistantFields, replacements);
  payload.turn.assistantContent = nextFields.assistantContent;
  payload.turn.assistantText = nextFields.assistantText;
  payload.turn.summary = nextFields.summary;
  return JSON.stringify(payload);
}

export const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "merged",
  "cancelled",
]);
const ACTIVE_TURN_LIFECYCLE_STATUSES = new Set([
  "queued",
  "running",
  "abort_requested",
]);

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const RETRYABLE_NODE_ERROR_CODES = new Set([
  "attachment_download_failed",
  "local_artifact_projection_failed",
  "local_api_unavailable",
  "local_turn_poll_failed",
]);

export async function executeRelayCommandUntilAvailable(command, {
  retryMinDelayMs = 500,
  retryMaxDelayMs = 10_000,
  onRetry,
  requestTimeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
  deadlineAt,
  ...options
} = {}) {
  if (
    !Number.isInteger(retryMinDelayMs) ||
    !Number.isInteger(retryMaxDelayMs) ||
    retryMinDelayMs <= 0 ||
    retryMaxDelayMs < retryMinDelayMs
  ) {
    throw new Error("Relay retry delays are invalid");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Relay local request timeout must be a positive integer");
  }
  const commandDeadlineAt = deadlineAt ?? Date.now() + requestTimeoutMs;
  if (!Number.isFinite(commandDeadlineAt)) {
    throw new Error("Relay command deadline is invalid");
  }
  let retryDelayMs = retryMinDelayMs;
  for (;;) {
    const remainingMs = commandDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new RelayNodeError(
        "local_api_timeout",
        `Local Cohub command exceeded its ${requestTimeoutMs}ms deadline`,
      );
    }
    try {
      return await executeRelayCommand(command, {
        ...options,
        requestTimeoutMs: Math.max(1, Math.ceil(remainingMs)),
        deadlineAt: commandDeadlineAt,
      });
    } catch (error) {
      if (
        !(error instanceof RelayNodeError) ||
        !RETRYABLE_NODE_ERROR_CODES.has(error.code) ||
        options.signal?.aborted
      ) {
        throw error;
      }
      onRetry?.({ code: error.code, message: error.message, retryDelayMs });
      const waitMs = Math.min(retryDelayMs, Math.max(1, commandDeadlineAt - Date.now()));
      await delay(waitMs, options.signal);
      if (commandDeadlineAt <= Date.now()) {
        throw new RelayNodeError(
          "local_api_timeout",
          `Local Cohub command exceeded its ${requestTimeoutMs}ms deadline`,
        );
      }
      retryDelayMs = Math.min(retryMaxDelayMs, retryDelayMs * 2);
    }
  }
}

export function parseWatchFromPromptResponse(body, requestPath) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  const sessionId = payload?.session?.id;
  const turnId = payload?.turn?.id;
  const turnStatus = payload?.turn?.status;
  if (typeof sessionId !== "string" || typeof turnId !== "string") {
    return null;
  }
  if (typeof turnStatus === "string" && TERMINAL_TURN_STATUSES.has(turnStatus)) {
    return null;
  }
  const spaceMatch =
    typeof requestPath === "string" ? requestPath.match(PROMPT_PATH_PATTERN) : null;
  const spaceId = spaceMatch?.[1];
  if (!spaceId) return null;
  return {
    spaceId,
    sessionId,
    turnId,
    ...(ACTIVE_TURN_LIFECYCLE_STATUSES.has(turnStatus)
      ? { initialStatus: turnStatus }
      : {}),
  };
}

export async function executeRelayCommand(command, {
  fetcher = fetch,
  localApiOrigin = "http://127.0.0.1:8787",
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
	requestTimeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
	deadlineAt,
	relayNodeBaseUrl,
	relayNodeToken,
  spaceStorageRoot,
  signal,
  beforeDispatch,
} = {}) {
  if (!command || typeof command !== "object") {
    throw new RelayNodeError("invalid_command", "Relay command is missing");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Relay local request timeout must be a positive integer");
  }
  if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
    throw new Error("Relay command deadline is invalid");
  }
  const effectiveTimeoutMs = deadlineAt === undefined
    ? requestTimeoutMs
    : Math.ceil(deadlineAt - Date.now());
  if (effectiveTimeoutMs <= 0) {
    throw new RelayNodeError(
      "local_api_timeout",
      `Local Cohub command exceeded its ${requestTimeoutMs}ms deadline`,
    );
  }
  const request = command.request;
  const promptPathMatch =
    request && typeof request.path === "string"
      ? request.path.match(PROMPT_PATH_PATTERN)
      : null;
  const federatedFsPathMatch =
    request && typeof request.path === "string"
      ? request.path.match(FEDERATED_FS_PATH_PATTERN)
      : null;
  const federatedEndpoint = federatedFsPathMatch?.[2];
  const validFederatedMethod =
    (federatedEndpoint === "tree" && request?.method === "GET") ||
    (federatedEndpoint === "file" &&
      (request?.method === "GET" || request?.method === "PUT")) ||
    (federatedEndpoint === "dir" && request?.method === "POST") ||
    (federatedEndpoint === "move" && request?.method === "POST") ||
    (federatedEndpoint === "node" && request?.method === "DELETE");
  const alphaApiRequest = isAlphaLocalApiRequest(request?.method, request?.path);
  if (
    typeof request.path !== "string" ||
    (!promptPathMatch && !validFederatedMethod && !alphaApiRequest)
  ) {
    throw new RelayNodeError(
      "path_not_allowed",
      "Relay node only accepts allowlisted Local Space commands",
    );
  }
  if (typeof request.body !== "string") {
    throw new RelayNodeError("invalid_command", "Relay command body is invalid");
  }
  if (request.bodyEncoding !== undefined && (request.bodyEncoding !== "base64" || Buffer.from(request.body, "base64").toString("base64") !== request.body)) throw new RelayNodeError("invalid_command", "Relay command body encoding is invalid");
  if (request.bodyParts && (request.method === "GET" || request.body || request.bodyEncoding)) throw new RelayNodeError("invalid_command", "Referenced HTTP bodies cannot also have inline content or use GET");
  if (!promptPathMatch && Array.isArray(command.attachments) && command.attachments.length > 0) {
    throw new RelayNodeError(
      "invalid_command",
      "Non-prompt relay commands cannot carry attachments",
    );
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new DOMException("Local API request timed out", "TimeoutError"),
      ),
    effectiveTimeoutMs,
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let response;
  let body;
  let responseEncoding;
  let responseParts;
  let preparedPrompt;
  let requestSent = false;
  try {
    const accessToken = await resolveLocalAccessToken(
      fetcher,
      localApiOrigin,
      requestSignal,
    );
    preparedPrompt = promptPathMatch
      ? await preparePromptBody(command, {
          fetcher,
          attachmentRoot: spaceStorageRoot
            ? resolve(
                spaceStorageRoot,
                promptPathMatch[1],
                "workspace",
                ".cohub",
                "relay-attachments",
              )
            : null,
          relayNodeBaseUrl,
          relayNodeToken,
          signal: requestSignal,
        })
      : { body: request.bodyParts ? requestBodyParts(request.bodyParts, { fetcher, relayNodeBaseUrl, relayNodeToken, signal: requestSignal }) : request.bodyEncoding === "base64" ? Buffer.from(request.body, "base64") : request.body, responseReplacements: new Map() };
    requestSignal.throwIfAborted();
    if (beforeDispatch) {
      let allowed;
      try { allowed = await beforeDispatch(); }
      catch (error) {
        throw new RelayNodeError("command_persistence_failed", "The relay could not persist the command before dispatch", { cause: error });
      }
      if (allowed === false) {
        throw new RelayNodeError("local_api_outcome_unknown", "This write was already dispatched. Its outcome must be checked; it was not sent again.");
      }
    }
    requestSignal.throwIfAborted();
    requestSent = true;
    response = await fetcher(`${localApiOrigin}${request.path}`, {
      method: request.method,
      headers: {
		...(["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.body
			? { "content-type": request.bodyEncoding ? "application/octet-stream" : "application/json" }
			: {}),
        ...forwardedHeaders(request.headers, requestHeaders),
        authorization: `Bearer ${accessToken}`,
        "x-cohub-source-via":
          promptPathMatch || alphaApiRequest ? "web" : "federated_cloud",
        "x-cohub-relay-command-id": command.idempotencyKey,
      },
		...(["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && (request.body || request.bodyParts)
			? { body: preparedPrompt.body }
        : {}),
      ...(request.bodyParts ? { duplex: "half" } : {}),
      signal: requestSignal,
    });
    const transferred = relayNodeBaseUrl && relayNodeToken
      ? await responseBodyParts(response, {
          maxBytes: maxResponseBytes,
          uploadPart: async (bytes, sha256) => {
            const path = await uploadReturnedArtifact({ bytes, size: bytes.length, name: "http-body.bin", contentType: "application/octet-stream", sha256 }, command, { fetcher, relayNodeBaseUrl, relayNodeToken, signal: requestSignal });
            return path.split("/").at(-2);
          },
        })
      : { bytes: await readLimitedResponseBytes(response, maxResponseBytes) };
    responseParts = transferred.bodyParts;
    const bytes = transferred.bytes ?? Buffer.alloc(0);
    const contentType = response.headers.get("content-type") ?? "";
    const isText = /^text\/|\b(?:json|xml|javascript|svg\+xml)\b/i.test(contentType);
    body = isText ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("base64");
    responseEncoding = isText || bytes.length === 0 ? undefined : "base64";
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    // A missing response cannot prove that a dispatched mutation did not commit.
    if (requestSent && request.method !== "GET") {
      throw new RelayNodeError(
        "local_api_outcome_unknown",
        "The local write may have completed, but its response was lost. Check the operation before retrying; it was not automatically sent again.",
        { cause: error },
      );
    }
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new RelayNodeError(
        "local_api_timeout",
        `Local Cohub endpoint did not respond within ${effectiveTimeoutMs}ms`,
        { cause: error },
      );
    }
    if (error instanceof RelayNodeError) throw error;
    throw new RelayNodeError(
      "local_api_unavailable",
      `Local Cohub endpoint is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!responseEncoding && !responseParts) body = restoreRelayAttachmentUris(body, preparedPrompt.responseReplacements);
  let watch = null;
  if (!responseEncoding && !responseParts && response.status >= 200 && response.status < 300) {
    const parsed = parseWatchFromPromptResponse(body, request.path);
    if (parsed) {
      watch = {
        ...parsed,
        responseReplacements: preparedPrompt.responseReplacements,
      };
    }
  }
  const headers = forwardedHeaders(response.headers, resultHeaders);
  return {
    result: { status: response.status, headers, body, ...(responseEncoding ? { bodyEncoding: responseEncoding } : {}), ...(responseParts ? { bodyParts: responseParts } : {}) },
    watch,
  };
}
