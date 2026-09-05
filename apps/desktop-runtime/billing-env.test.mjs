import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { withoutHostedBilling } from "./billing-env.mjs";
import { configureBillingRuntime, createBillingOperations } from "../../packages/billing/src/client.ts";

test("local child processes cannot inherit hosted billing credentials", () => {
	const inherited = {
		...process.env,
		TALESOFAI_BILLING_BASE_URL: "https://billing.example.invalid",
		TALESOFAI_BILLING_BUSINESS_KEY: "test-business",
		TALESOFAI_BILLING_ADMIN_API_KEY: "test-key",
		CLOUD_API_BASE_URL: "https://api.cohub.live",
	};
	const environment = withoutHostedBilling(inherited);
	const stdout = execFileSync(process.execPath, ["-e", 'console.log(JSON.stringify({billing:Object.keys(process.env).filter(k=>k.startsWith("TALESOFAI_BILLING_")),cloud:process.env.CLOUD_API_BASE_URL}))'], { env: environment, encoding: "utf8" });
	assert.deepEqual(JSON.parse(stdout), { billing: [], cloud: inherited.CLOUD_API_BASE_URL });
	assert.equal(inherited.TALESOFAI_BILLING_ADMIN_API_KEY, "test-key");
	configureBillingRuntime({ config: {
		talesofaiBillingBaseUrl: environment.TALESOFAI_BILLING_BASE_URL,
		talesofaiBillingBusinessKey: environment.TALESOFAI_BILLING_BUSINESS_KEY,
		talesofaiBillingAdminApiKey: environment.TALESOFAI_BILLING_ADMIN_API_KEY,
	} });
	assert.equal(createBillingOperations().status.configured, false);
	assert.equal(createBillingOperations().status.provider, "disabled");
});
