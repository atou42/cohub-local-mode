export async function probeLocalAppShell({
	url,
	fetcher = fetch,
	timeoutMs = 10_000,
}) {
	const response = await fetcher(url, {
		cache: "no-store",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/html")) {
		throw new Error(`${url} did not return HTML`);
	}
	const cacheControl = response.headers.get("cache-control") ?? "";
	const directives = new Set(
		cacheControl
			.toLowerCase()
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	);
	if (!directives.has("private") || !directives.has("no-store")) {
		throw new Error(`${url} must return private, no-store`);
	}
	const body = await response.text();
	if (!/_app\/immutable\/entry\/start\.[^"']+\.js/.test(body)) {
		throw new Error(`${url} does not contain the application entrypoint`);
	}
	return body;
}
