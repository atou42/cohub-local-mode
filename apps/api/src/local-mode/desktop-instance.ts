import { createHmac, timingSafeEqual } from "node:crypto";

export function desktopInstance(env = process.env) {
  const id = env.COHUB_DESKTOP_INSTANCE_ID;
  const secret = env.COHUB_DESKTOP_INSTANCE_SECRET;
  if (id === undefined && secret === undefined) return null;
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("Desktop instance identity is invalid");
  }
  return { id, secret };
}

export function hasDesktopAccess(request: Request, env = process.env) {
  const instance = desktopInstance(env);
  if (!instance) return true;
  const provided = request.headers.get("x-cohub-desktop-secret") ?? "";
  const expected = Buffer.from(instance.secret);
  const received = Buffer.from(provided);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function desktopInstanceResponse(request: Request, env = process.env) {
  const headers = { "cache-control": "no-store" };
  const instance = desktopInstance(env);
  if (!instance) return Response.json({ message: "not found" }, { status: 404, headers });
  const challenge = new URL(request.url).searchParams.get("challenge");
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return Response.json({ message: "invalid instance challenge" }, { status: 400, headers });
  }
  return Response.json({
    schemaVersion: 1,
    instanceId: instance.id,
    proof: createHmac("sha256", instance.secret)
      .update(`cohub-desktop-v1:${instance.id}:${challenge}`)
      .digest("base64url"),
  }, { headers });
}
