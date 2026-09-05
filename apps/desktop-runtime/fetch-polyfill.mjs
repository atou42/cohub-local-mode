import nodeFetch from "node-fetch";
import { Readable } from "node:stream";

const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;

async function requestInput(input, init = {}) {
	if (!(input instanceof NativeRequest)) return [input, init];
	const method = init.method ?? input.method;
	let body = init.body;
	if (
		body === undefined &&
		input.body &&
		method !== "GET" &&
		method !== "HEAD"
	) {
		body = Buffer.from(await input.arrayBuffer());
	}
	return [
		input.url,
		{
			method,
			headers: init.headers ?? input.headers,
			body,
			signal: init.signal ?? input.signal,
			redirect: init.redirect ?? input.redirect,
		},
	];
}

globalThis.fetch = async (input, init) => {
	const [target, options] = await requestInput(input, init);
	const response = await nodeFetch(target, options);
	const bodyAllowed = ![204, 205, 304].includes(response.status);
	const converted = new NativeResponse(
		bodyAllowed && response.body ? Readable.toWeb(response.body) : null,
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
	Object.defineProperty(converted, "url", { value: response.url });
	Object.defineProperty(converted, "redirected", { value: response.redirected });
	return converted;
};
