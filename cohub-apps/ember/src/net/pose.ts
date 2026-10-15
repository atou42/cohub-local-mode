
export type Pose = {
  x: number;
  y: number;
  level: number;
  walking: boolean;
  left: boolean;
  mic: boolean;
};

const POSE_BYTES = 6;
export const POSE_HZ = 15;
export const POSE_IDLE_MS = 1000;
export const RENDER_DELAY_MS = 120;

const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value);

export const encodePose = (pose: Pose): ArrayBuffer => {
  const bytes = new Uint8Array(POSE_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = (pose.walking ? 1 : 0) | (pose.left ? 2 : 0) | (pose.mic ? 4 : 0);
  view.setInt16(1, Math.round(clamp(pose.x, -32000, 32000)), true);
  view.setInt16(3, Math.round(clamp(pose.y, -32000, 32000)), true);
  bytes[5] = Math.round(clamp(pose.level, 0, 1) * 255);
  return bytes.buffer;
};

export const decodePose = (data: ArrayBuffer | ArrayBufferView): Pose | null => {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength !== POSE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[0] ?? 0;
  return {
    walking: (flags & 1) !== 0,
    left: (flags & 2) !== 0,
    mic: (flags & 4) !== 0,
    x: view.getInt16(1, true),
    y: view.getInt16(3, true),
    level: (bytes[5] ?? 0) / 255,
  };
};

export type PoseTrack = { samples: Array<{ at: number; pose: Pose }> };

export const createTrack = (): PoseTrack => ({ samples: [] });

export const pushSample = (track: PoseTrack, at: number, pose: Pose) => {
  track.samples.push({ at, pose });
  if (track.samples.length > 8) track.samples.splice(0, track.samples.length - 8);
};

export const sampleTrack = (track: PoseTrack, at: number): Pose | null => {
  const samples = track.samples;
  const last = samples.at(-1);
  if (!last) return null;
  if (at >= last.at) return last.pose;
  for (let index = samples.length - 1; index > 0; index -= 1) {
    const after = samples[index];
    const before = samples[index - 1];
    if (!after || !before || at < before.at) continue;
    const span = after.at - before.at;
    const t = span <= 0 ? 1 : (at - before.at) / span;
    return {
      ...after.pose,
      x: before.pose.x + (after.pose.x - before.pose.x) * t,
      y: before.pose.y + (after.pose.y - before.pose.y) * t,
      level: before.pose.level + (after.pose.level - before.pose.level) * t,
    };
  }
  return samples[0]?.pose ?? null;
};

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export const poseToRelay = (pose: Pose) => toBase64(new Uint8Array(encodePose(pose)));
export const poseFromRelay = (value: unknown) => {
  if (typeof value !== "string" || value.length > 16) return null;
  try {
    return decodePose(fromBase64(value));
  } catch {
    return null;
  }
};
