import app from "./.svelte-kit/cloudflare/_worker.js";

export default {
	async fetch(request, env, ctx) {
		const response = await app.fetch(request, env, ctx);
		const pathname = new URL(request.url).pathname;

		if (pathname.startsWith("/_app/immutable/") && !response.ok) {
			const headers = new Headers(response.headers);
			headers.set("Cache-Control", "no-store");
			headers.delete("Expires");
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		return response;
	},
};
