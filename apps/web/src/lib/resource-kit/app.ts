import type { AppRecord, Permission } from "@neta-art/cohub";
import { m } from "$messages";
import type { Locale } from "./core";

type Message = (
	inputs?: Record<string, never>,
	options?: { locale?: Locale },
) => string;

export const APP_SCOPE_OPTIONS: {
	scope: Permission;
	label: Message;
	description: Message;
}[] = [
	{
		scope: "space.view",
		label: m.app_scope_space_view,
		description: m.app_scope_space_view_hint,
	},
	{
		scope: "session.view",
		label: m.app_scope_session_view,
		description: m.app_scope_session_view_hint,
	},
	{
		scope: "file.view",
		label: m.app_scope_file_view,
		description: m.app_scope_file_view_hint,
	},
	{
		scope: "file.edit",
		label: m.app_scope_file_edit,
		description: m.app_scope_file_edit_hint,
	},
	{
		scope: "taskrun.view",
		label: m.app_scope_taskrun_view,
		description: m.app_scope_taskrun_view_hint,
	},
	{
		scope: "session.prompt.readonly",
		label: m.app_scope_session_prompt_readonly,
		description: m.app_scope_session_prompt_readonly_hint,
	},
	{
		scope: "session.prompt.fullaccess",
		label: m.app_scope_session_prompt_fullaccess,
		description: m.app_scope_session_prompt_fullaccess_hint,
	},
	{
		scope: "command.execute",
		label: m.app_scope_command_execute,
		description: m.app_scope_command_execute_hint,
	},
];

export const APP_SCOPE_GROUPS: {
	title: Message;
	scopes: Permission[];
}[] = [
	{
		title: m.app_scope_group_access,
		scopes: APP_SCOPE_OPTIONS.map((option) => option.scope),
	},
];

export function scopeState(
	scopes: Permission[],
	options: { scope: Permission }[],
) {
	const selected = new Set(scopes);
	return Object.fromEntries(
		options.map((option) => [option.scope, selected.has(option.scope)]),
	);
}

export function selectedScopeList(
	state: Record<string, boolean>,
	options: { scope: Permission }[],
) {
	return options.map((option) => option.scope).filter((scope) => state[scope]);
}

export function appStatusTone(status: AppRecord["status"]) {
	if (status === "published") return "text-status-running";
	if (status === "disabled") return "text-error-soft";
	return "text-text-tertiary";
}
