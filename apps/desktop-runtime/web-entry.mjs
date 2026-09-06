import { createDesktopWebServer } from "./web-server.mjs";

const loadingAt = performance.now();
const { handler } = await import("web/build/handler.js");
process.stdout.write(`[web] bundle loaded in ${Math.round(performance.now() - loadingAt)}ms\n`);

const origin = new URL(process.env.PUBLIC_API_ORIGIN);
const server = createDesktopWebServer({
	handler,
	webOrigin: origin.origin,
	apiOrigin: process.env.API_BASE_URL,
	gatewayOrigin: process.env.LOCAL_COHUB_GATEWAY_ORIGIN.replace(/^ws:/, "http:").replace(/\/ws$/, ""),
	secret: process.env.COHUB_DESKTOP_INSTANCE_SECRET,
});
server.listen(Number(origin.port), "127.0.0.1");
process.once("SIGTERM", () => {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 5000).unref();
});
