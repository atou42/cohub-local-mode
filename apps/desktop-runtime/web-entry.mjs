import { handler } from "web/build/handler.js";
import { createDesktopWebServer } from "./web-server.mjs";

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
