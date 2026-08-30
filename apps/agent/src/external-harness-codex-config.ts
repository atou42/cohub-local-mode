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

const CODEX_MODEL_CONTEXT_WINDOW = 1_050_000;
const CODEX_AUTO_COMPACT_TOKEN_LIMIT = 400_000;

export function buildCodexThreadForkParams(input: {
	threadId: string;
	lastTurnId: string;
	cwd: string;
	accessMode: "full_access" | "read_only";
	writableRoots: readonly string[];
}) {
	return {
		threadId: input.threadId,
		lastTurnId: input.lastTurnId,
		cwd: input.cwd,
		approvalPolicy: "never",
		approvalsReviewer: "user",
		sandbox: input.accessMode === "read_only" ? "read-only" : "workspace-write",
		runtimeWorkspaceRoots: [...input.writableRoots],
		excludeTurns: true,
		deferGoalContinuation: true,
	};
}

export function buildCodexAppServerArgv(
	writableRoots: readonly string[] = [],
) {
	const argv = [
		"codex",
		"app-server",
		"--listen",
		"stdio://",
		"-c",
		`model_context_window=${CODEX_MODEL_CONTEXT_WINDOW}`,
		"-c",
		`model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
		"-c",
		"shell_environment_policy.inherit=all",
		"-c",
		"shell_environment_policy.ignore_default_excludes=true",
		"-c",
		"sandbox_workspace_write.network_access=true",
		"-c",
		`shell_environment_policy.include_only=${JSON.stringify(CODEX_SHELL_ENVIRONMENT_INCLUDE_ONLY)}`,
	];
	if (writableRoots.length > 0) {
		argv.push(
			"-c",
			`sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
		);
	}
	return argv;
}
