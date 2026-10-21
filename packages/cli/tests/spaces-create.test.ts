import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CohubHttpClient,
  CreateSpaceInput,
  SpaceCreateResponse,
} from "@neta-art/cohub";
import { Command } from "commander";
import {
  buildSpaceCreateInput,
  registerSpaceCreate,
} from "../src/commands/spaces.js";

test("space create input combines a checkpoint with sandbox config", () => {
  assert.deepEqual(
    buildSpaceCreateInput({
      name: "Forked space",
      description: "Continue from a save",
      checkpoint: "  checkpoint-1  ",
      autoDestroy: "idle",
      idleTtl: "3600",
      spec: "boost",
      image: "game",
    }),
    {
      name: "Forked space",
      description: "Continue from a save",
      bootstrapSource: {
        type: "checkpoint",
        checkpointId: "checkpoint-1",
      },
      config: {
        sandbox: {
          autoDestroy: { mode: "idle", ttlSeconds: 3600 },
          spec: "boost",
          image: "game",
        },
      },
    },
  );
});

test("spaces create forwards --checkpoint to the SDK", async () => {
  let receivedInput: CreateSpaceInput | undefined;
  const response = {
    space: { id: "space-1", name: "Forked space" },
    taskRunId: "task-1",
  } as unknown as SpaceCreateResponse;
  const client = {
    spaces: {
      create: async (input: CreateSpaceInput) => {
        receivedInput = input;
        return response;
      },
    },
  } as unknown as CohubHttpClient;
  const program = new Command("cohub");
  const spaces = program.command("spaces");
  const create = registerSpaceCreate(spaces, {
    createClient: () => client,
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    logs.push(values.join(" "));
  };
  try {
    await program.parseAsync([
      "node",
      "cohub",
      "spaces",
      "create",
      "--name",
      "Forked space",
      "--checkpoint",
      "checkpoint-1",
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(receivedInput?.bootstrapSource, {
    type: "checkpoint",
    checkpointId: "checkpoint-1",
  });
  assert.match(logs.join("\n"), /task-1/);
  assert.match(create.helpInformation(), /--checkpoint <id>/);
});
