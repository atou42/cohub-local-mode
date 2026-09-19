import type { AgentHarness } from "./model/session.js";

export type HarnessCapabilityCommand = {
	name: string;
	description: string;
	argumentHint?: string;
	category: string;
	insertionText: string;
};

export type HarnessCapabilitySkill = {
	name: string;
	description: string;
	scope: "user" | "repo" | "system" | "admin";
	insertionText: string;
};

export type HarnessCapabilityCatalog = {
	version: 1;
	harness: AgentHarness;
	fetchedAt: string;
	commands: HarnessCapabilityCommand[];
	skills: HarnessCapabilitySkill[];
};
