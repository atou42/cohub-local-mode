import { randomUUID } from "node:crypto";
import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import { boardChangedEvent } from "@cohub/core/board";
import { dispatchRealtimeEvent } from "./channels.js";

export async function dispatchBoardChanged(input: Parameters<typeof boardChangedEvent>[0]) {
  const event = boardChangedEvent(input);
  if (event) await dispatchRealtimeEvent(event);
}

export async function dispatchBoardPlaybackChanged(input: {
  spaceId: string;
  boardId: string;
  playback: BoardPlaybackSnapshot | null;
}) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "board.playback.changed",
    spaceId: input.spaceId,
    sessionId: null,
    payload: { boardId: input.boardId, playback: input.playback },
  });
}
