import { PersonalAccount } from "./alpha-account.ts";
import { createAlphaHandler, type AlphaEnv } from "./alpha-handler.ts";
import { createAlphaQueueHandler } from "./alpha-queue.ts";
import { LocalNodeRelay } from "./index.ts";
import type { RelayWakeupMessage } from "./protocol.ts";

export { LocalNodeRelay, PersonalAccount };
const handler = createAlphaHandler();
const queue = createAlphaQueueHandler();

export default {
	fetch: handler.fetch,
	queue,
} satisfies ExportedHandler<AlphaEnv, RelayWakeupMessage>;
