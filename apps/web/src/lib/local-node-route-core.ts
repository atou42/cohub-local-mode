export type LocalNodeRoute = "private" | "fallback";

type RouteManagerOptions = {
	privateOrigin?: string | null;
	fallbackOrigin: string;
	fetcher?: typeof fetch;
	probeTimeoutMs?: number;
	probeTtlMs?: number;
	now?: () => number;
};

function normalizeOrigin(value: string | null | undefined): string | null {
	const trimmed = value?.trim().replace(/\/+$/, "");
	if (!trimmed) return null;
	const url = new URL(trimmed);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Local node origins must use HTTP or HTTPS");
	}
	return url.origin;
}

function inputMethod(input: RequestInfo | URL, init?: RequestInit) {
	return (init?.method ?? (input instanceof Request ? input.method : "GET"))
		.toUpperCase();
}

function rewriteOrigin(
	input: RequestInfo | URL,
	fromOrigin: string,
	toOrigin: string,
): RequestInfo | URL {
	const raw = input instanceof Request ? input.url : input.toString();
	const url = new URL(raw, fromOrigin);
	if (url.origin !== fromOrigin) return input;
	const target = new URL(toOrigin);
	url.protocol = target.protocol;
	url.host = target.host;
	return input instanceof Request ? new Request(url, input) : url;
}

function websocketOrigin(origin: string) {
	return origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

export class LocalNodeRouteManager {
	readonly privateOrigin: string | null;
	readonly fallbackOrigin: string;
	private readonly fetcher: typeof fetch;
	private readonly probeTimeoutMs: number;
	private readonly probeTtlMs: number;
	private readonly now: () => number;
	private route: LocalNodeRoute;
	private lastProbeAt: number | null = null;
	private probePromise: Promise<LocalNodeRoute> | null = null;

	constructor(options: RouteManagerOptions) {
		this.privateOrigin = normalizeOrigin(options.privateOrigin);
		this.fallbackOrigin = normalizeOrigin(options.fallbackOrigin) ?? "";
		if (!this.fallbackOrigin) throw new Error("Local fallback origin is required");
		this.fetcher = options.fetcher ?? fetch;
		this.probeTimeoutMs = options.probeTimeoutMs ?? 700;
		this.probeTtlMs = options.probeTtlMs ?? 30_000;
		this.now = options.now ?? Date.now;
		this.route = this.privateOrigin ? "private" : "fallback";
	}

	get activeRoute() {
		return this.route;
	}

	private async probePrivate(): Promise<LocalNodeRoute> {
		if (!this.privateOrigin) return "fallback";
		const response = await this.fetcher(
			`${this.privateOrigin}/api/local-mode/route-health`,
			{
				method: "GET",
				credentials: "include",
				cache: "no-store",
				signal: AbortSignal.timeout(this.probeTimeoutMs),
			},
		);
		if (!response.ok || response.headers.get("x-cohub-local-node") !== "1") {
			throw new Error("Private Local Mode health check failed");
		}
		return "private";
	}

	async refresh(force = false): Promise<LocalNodeRoute> {
		if (!this.privateOrigin) return "fallback";
		if (
			!force &&
			this.lastProbeAt !== null &&
			this.now() - this.lastProbeAt < this.probeTtlMs
		) {
			return this.route;
		}
		if (this.probePromise) return this.probePromise;
		this.probePromise = this.probePrivate()
			.catch(() => "fallback" as const)
			.then((route) => {
				this.route = route;
				this.lastProbeAt = this.now();
				return route;
			})
			.finally(() => {
				this.probePromise = null;
			});
		return this.probePromise;
	}

	websocketUrl(fallbackUrl: string): string {
		if (this.route !== "private" || !this.privateOrigin) return fallbackUrl;
		return `${websocketOrigin(this.privateOrigin)}/ws`;
	}

	async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		await this.refresh();
		if (this.route !== "private" || !this.privateOrigin) {
			return this.fetcher(input, init);
		}
		const privateInput = rewriteOrigin(
			input,
			this.fallbackOrigin,
			this.privateOrigin,
		);
		try {
			return await this.fetcher(privateInput, init);
		} catch (error) {
			this.route = "fallback";
			this.lastProbeAt = this.now();
			const method = inputMethod(input, init);
			if (method === "GET" || method === "HEAD") {
				return this.fetcher(input, init);
			}
			throw error;
		}
	}
}
