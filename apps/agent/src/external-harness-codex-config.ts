const CODEX_SHELL_ENVIRONMENT_INCLUDE_ONLY = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"LC_*",
	"TERM",
	"COLORTERM",
	"COHUB_*",
];

export function buildCodexAppServerArgv() {
	return [
		"codex",
		"app-server",
		"--listen",
		"stdio://",
		"-c",
		"shell_environment_policy.inherit=all",
		"-c",
		"shell_environment_policy.ignore_default_excludes=true",
		"-c",
		"sandbox_workspace_write.network_access=true",
		"-c",
		`shell_environment_policy.include_only=${JSON.stringify(CODEX_SHELL_ENVIRONMENT_INCLUDE_ONLY)}`,
	];
}
