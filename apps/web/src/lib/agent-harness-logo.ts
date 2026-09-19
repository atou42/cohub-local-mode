import type { AgentHarness } from "@neta-art/cohub";

type AgentHarnessLogoAssets = {
	light: string;
	dark: string;
};

const AGENT_HARNESS_LOGO_ASSETS: Record<AgentHarness, AgentHarnessLogoAssets> =
	{
		pi: {
			light: "/agent-harness/pi-auto.svg",
			dark: "/agent-harness/pi-auto.svg",
		},
		codex: {
			light: "/agent-harness/codex-on-light.png",
			dark: "/agent-harness/codex-on-dark.png",
		},
		grok_build: {
			light: "/agent-harness/grok-on-light.svg",
			dark: "/agent-harness/grok-on-dark.svg",
		},
		cursor: {
			light: "/agent-harness/cursor-on-light.svg",
			dark: "/agent-harness/cursor-on-dark.svg",
		},
	};

export function getAgentHarnessLogoAssets(
	harness: AgentHarness,
): AgentHarnessLogoAssets {
	return AGENT_HARNESS_LOGO_ASSETS[harness];
}
