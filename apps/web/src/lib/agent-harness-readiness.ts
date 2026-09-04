import type { AgentHarness, HarnessReadinessEntry } from "@cohub/protocol";

export function resolveAgentHarnessReadinessView(input: {
	harness: AgentHarness;
	entry: HarnessReadinessEntry | null;
	error?: string | null;
}) {
	if (input.harness === "pi") {
		return {
			available: true,
			label: input.entry?.bundled ? "Included" : "Ready",
			detail: input.entry?.detail ?? "Pi is included with Cohub Connector.",
		};
	}
	if (!input.entry) {
		return {
			available: false,
			label: input.error ? "Status unavailable" : "Checking…",
			detail: input.error ?? "Local Agent status is still loading.",
		};
	}
	const labels = {
		ready: "Ready",
		not_installed: "Not installed",
		sign_in_required: "Sign in required",
		setup_required: "Setup required",
		unavailable: "Unavailable",
	} as const;
	return {
		available: input.entry.state === "ready",
		label: labels[input.entry.state],
		detail: input.entry.detail,
	};
}
