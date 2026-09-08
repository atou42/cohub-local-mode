type StatusReport = {
	scope: string;
	body: string;
	send: () => Promise<Response | null>;
};

export function createConnectorStatusReporter(input: { onError: (error: unknown) => void; now?: () => number }) {
	const now = input.now ?? Date.now;
	let scope: string | null = null;
	let pending: StatusReport | null = null;
	let inFlight: Promise<void> | null = null;
	let lastSuccess: { scope: string; body: string; at: number } | null = null;
	let failures = 0;
	let retryAt = 0;

	async function drain() {
		while (pending && now() >= retryAt) {
			const report = pending;
			pending = null;
			if (report.scope !== scope) continue;
			if (lastSuccess?.scope === scope && lastSuccess.body === report.body && now() - lastSuccess.at < 30_000) continue;
			let requestedDelay = 0;
			try {
				const response = await report.send();
				if (report.scope !== scope || response === null) continue;
				if (!response.ok) {
					const retryAfter = response.headers.get("retry-after");
					const delay = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - now();
					if (Number.isFinite(delay)) requestedDelay = Math.max(0, Math.min(3_600_000, delay));
					throw new Error(`Connector status report returned HTTP ${response.status}`);
				}
				lastSuccess = { scope: report.scope, body: report.body, at: now() };
				failures = 0;
				retryAt = 0;
			} catch (error) {
				if (report.scope !== scope) continue;
				failures++;
				retryAt = now() + Math.max(requestedDelay, Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)));
				pending ??= report;
				input.onError(error);
				return;
			}
		}
	}

	function flush() {
		if (inFlight) return inFlight;
		const operation = drain().finally(async () => {
			if (inFlight === operation) inFlight = null;
			if (pending && now() >= retryAt) await flush();
		});
		inFlight = operation;
		return operation;
	}

	return {
		publish(report: StatusReport) {
			if (scope !== report.scope) {
				scope = report.scope;
				lastSuccess = null;
				failures = 0;
				retryAt = 0;
			}
			pending = report;
			return flush();
		},
		flush,
	};
}
