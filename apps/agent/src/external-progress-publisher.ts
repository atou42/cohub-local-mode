import type { ContentBlock } from "@cohub/protocol/core";

export type ExternalProgressPublication = {
	seq: number;
	baseSeq: number;
	content: ContentBlock[];
	turnEnd: boolean;
};

export function createExternalProgressPublisher(input: {
	publish: (publication: ExternalProgressPublication) => Promise<void>;
	onError?: (error: Error) => void;
}) {
	let queued: { content: ContentBlock[]; turnEnd: boolean } | null = null;
	let drainPromise: Promise<void> | null = null;
	let publishedSeq = 0;
	let lastError: Error | null = null;

	const startDrain = () => {
		if (drainPromise) return;
		drainPromise = (async () => {
			while (queued) {
				const publication = queued;
				queued = null;
				publishedSeq += 1;
				try {
					await input.publish({
						seq: publishedSeq,
						baseSeq: publishedSeq - 1,
						content: publication.content,
						turnEnd: publication.turnEnd,
					});
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					input.onError?.(lastError);
				}
			}
		})().finally(() => {
			drainPromise = null;
			if (queued) startDrain();
		});
	};

	return {
		enqueue(content: ContentBlock[], turnEnd = false) {
			const snapshot = structuredClone(content);
			queued = {
				content: snapshot,
				turnEnd: turnEnd || queued?.turnEnd === true,
			};
			startDrain();
			return snapshot;
		},
		async flush() {
			for (;;) {
				if (drainPromise) {
					await drainPromise;
					continue;
				}
				if (queued) {
					startDrain();
					continue;
				}
				return;
			}
		},
		getLastError() {
			return lastError;
		},
	};
}
