export type SessionRenameTarget = {
	spaceId: string;
	sessionId: string;
	title: string;
};

export function createSessionRenameController(options: {
	getTarget: () => SessionRenameTarget | null;
	rename: (target: SessionRenameTarget, title: string) => Promise<void>;
}) {
	let draft = $state<{
		target: SessionRenameTarget;
		value: string;
		saving: boolean;
		failed: boolean;
	} | null>(null);
	const current = $derived.by(() => {
		const target = options.getTarget();
		return target &&
			draft?.target.spaceId === target.spaceId &&
			draft.target.sessionId === target.sessionId
			? draft
			: null;
	});
	$effect(() => {
		if (!current) draft = null;
	});

	return {
		get state() {
			return {
				renaming: Boolean(current),
				value: current?.value ?? "",
				saving: current?.saving ?? false,
				failed: current?.failed ?? false,
			};
		},
		start() {
			const target = options.getTarget();
			if (target) {
				draft = { target, value: target.title, saving: false, failed: false };
			}
		},
		cancel() {
			draft = null;
		},
		setValue(value: string) {
			if (current) current.value = value;
		},
		async submit() {
			const edit = current;
			if (!edit || edit.saving) return;
			const title = edit.value.trim();
			if (!title || title === edit.target.title) {
				draft = null;
				return;
			}
			edit.saving = true;
			edit.failed = false;
			try {
				await options.rename(edit.target, title);
				if (draft === edit) draft = null;
			} catch {
				edit.failed = true;
			} finally {
				edit.saving = false;
			}
		},
	};
}
