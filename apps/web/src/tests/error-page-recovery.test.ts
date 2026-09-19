import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the static server-error page retries one stale release without looping", async () => {
	const html = await readFile(
		new URL("../error.html", import.meta.url),
		"utf8",
	);

	assert.match(html, /%sveltekit\.status%/);
	assert.match(html, /cohub:server-error-recovery/);
	assert.match(html, /serviceWorker\.getRegistration/);
	assert.match(html, /sessionStorage/);
	assert.match(html, /location\.replace/);
	assert.match(html, /data-retry/);
});
