const APP_SHELL_HEIGHT_PROPERTY = "--cohub-app-shell-height";
const WIDTH_EPSILON_PX = 1;

export type IOSStandaloneViewportSample = {
	width: number;
	height: number;
};

export type IOSStandaloneViewportState = {
	phase: "resting" | "focused" | "recovering";
	resting: IOSStandaloneViewportSample;
};

export type IOSStandaloneViewportEvent =
	| { type: "focus"; sample: IOSStandaloneViewportSample }
	| { type: "blur" }
	| { type: "resize"; sample: IOSStandaloneViewportSample };

export type IOSStandaloneViewportTransition = {
	state: IOSStandaloneViewportState;
	heightOverride: number | null;
};

type IOSNavigator = Pick<
	Navigator,
	"maxTouchPoints" | "platform" | "userAgent"
> & {
	standalone?: boolean;
};

function assertPositiveFinite(value: number, name: "width" | "height") {
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`viewport ${name} must be a positive finite number`);
	}
}

function validateSample(
	sample: IOSStandaloneViewportSample,
): IOSStandaloneViewportSample {
	assertPositiveFinite(sample.width, "width");
	assertPositiveFinite(sample.height, "height");
	return sample;
}

function sameViewportWidth(left: number, right: number) {
	return Math.abs(left - right) <= WIDTH_EPSILON_PX;
}

export function isIOSStandaloneViewport(
	navigatorInfo: IOSNavigator,
	displayModeStandalone: boolean,
) {
	const iosDevice =
		/iPad|iPhone|iPod/.test(navigatorInfo.userAgent) ||
		(navigatorInfo.platform === "MacIntel" && navigatorInfo.maxTouchPoints > 1);
	return (
		iosDevice && (navigatorInfo.standalone === true || displayModeStandalone)
	);
}

export function createIOSStandaloneViewportState(
	sample: IOSStandaloneViewportSample,
): IOSStandaloneViewportState {
	return { phase: "resting", resting: { ...validateSample(sample) } };
}

export function transitionIOSStandaloneViewport(
	state: IOSStandaloneViewportState,
	event: IOSStandaloneViewportEvent,
): IOSStandaloneViewportTransition {
	if (event.type === "blur") {
		return {
			state: { ...state, phase: "recovering" },
			heightOverride: state.resting.height,
		};
	}

	const sample = validateSample(event.sample);
	if (event.type === "focus") {
		const resting = sameViewportWidth(state.resting.width, sample.width)
			? {
					width: sample.width,
					height: Math.max(state.resting.height, sample.height),
				}
			: state.phase === "resting"
				? { ...sample }
				: state.resting;
		return {
			state: { phase: "focused", resting },
			heightOverride: null,
		};
	}

	if (state.phase === "focused") {
		return { state, heightOverride: null };
	}

	if (!sameViewportWidth(state.resting.width, sample.width)) {
		return {
			state: { phase: "resting", resting: { ...sample } },
			heightOverride: null,
		};
	}

	if (
		state.phase === "recovering" &&
		sample.height + WIDTH_EPSILON_PX < state.resting.height
	) {
		return { state, heightOverride: state.resting.height };
	}

	return {
		state: { phase: "resting", resting: { ...sample } },
		heightOverride: null,
	};
}

function isKeyboardEditable(target: EventTarget | null): target is HTMLElement {
	if (!(target instanceof HTMLElement)) return false;
	if (target instanceof HTMLTextAreaElement) {
		return !target.disabled && !target.readOnly;
	}
	if (target instanceof HTMLInputElement) {
		return !target.disabled && !target.readOnly && target.type !== "hidden";
	}
	return target.isContentEditable;
}

function readShellSample(shell: HTMLElement): IOSStandaloneViewportSample {
	return {
		width: window.innerWidth,
		height: shell.getBoundingClientRect().height,
	};
}

function setShellHeight(shell: HTMLElement, height: number | null) {
	if (height === null) {
		shell.style.removeProperty(APP_SHELL_HEIGHT_PROPERTY);
		return;
	}
	shell.style.setProperty(APP_SHELL_HEIGHT_PROPERTY, `${height}px`);
}

function installIOSStandaloneViewportRecovery(shell: HTMLElement) {
	const standalone = window.matchMedia("(display-mode: standalone)").matches;
	if (!isIOSStandaloneViewport(navigator, standalone)) return () => {};

	let state = createIOSStandaloneViewportState(readShellSample(shell));
	let scheduledFrame: number | null = null;

	function cancelScheduledFrame() {
		if (scheduledFrame === null) return;
		window.cancelAnimationFrame(scheduledFrame);
		scheduledFrame = null;
	}

	function apply(transition: IOSStandaloneViewportTransition) {
		state = transition.state;
		setShellHeight(shell, transition.heightOverride);
	}

	function rebaseAfterWidthChange() {
		setShellHeight(shell, null);
		cancelScheduledFrame();
		scheduledFrame = window.requestAnimationFrame(() => {
			scheduledFrame = null;
			if (isKeyboardEditable(document.activeElement)) return;
			apply(
				transitionIOSStandaloneViewport(state, {
					type: "resize",
					sample: readShellSample(shell),
				}),
			);
		});
	}

	function handleFocusIn(event: FocusEvent) {
		if (!isKeyboardEditable(event.target)) return;
		cancelScheduledFrame();
		apply(
			transitionIOSStandaloneViewport(state, {
				type: "focus",
				sample: readShellSample(shell),
			}),
		);
	}

	function handleFocusOut(event: FocusEvent) {
		if (!isKeyboardEditable(event.target)) return;
		cancelScheduledFrame();
		scheduledFrame = window.requestAnimationFrame(() => {
			scheduledFrame = null;
			if (isKeyboardEditable(document.activeElement)) return;

			if (!sameViewportWidth(state.resting.width, window.innerWidth)) {
				// `lvh` is only used to establish the new orientation's resting size.
				shell.style.setProperty(APP_SHELL_HEIGHT_PROPERTY, "100lvh");
				scheduledFrame = window.requestAnimationFrame(() => {
					scheduledFrame = null;
					state = createIOSStandaloneViewportState(readShellSample(shell));
					setShellHeight(shell, state.resting.height);
				});
				return;
			}

			apply(transitionIOSStandaloneViewport(state, { type: "blur" }));
		});
	}

	function handleResize() {
		if (isKeyboardEditable(document.activeElement)) return;
		if (!sameViewportWidth(state.resting.width, window.innerWidth)) {
			rebaseAfterWidthChange();
		}
	}

	shell.addEventListener("focusin", handleFocusIn);
	shell.addEventListener("focusout", handleFocusOut);
	window.addEventListener("resize", handleResize);

	return () => {
		cancelScheduledFrame();
		shell.removeEventListener("focusin", handleFocusIn);
		shell.removeEventListener("focusout", handleFocusOut);
		window.removeEventListener("resize", handleResize);
		setShellHeight(shell, null);
	};
}

export function iosStandaloneViewportRecovery(shell: HTMLElement) {
	const destroy = installIOSStandaloneViewportRecovery(shell);
	return { destroy };
}
