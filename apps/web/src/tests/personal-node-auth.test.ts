import assert from "node:assert/strict";
import test from "node:test";
import {
	beginPersonalNodeDeviceAuthorization,
	PERSONAL_NODE_AUTH_STORAGE_KEY,
	PersonalNodeAuthError,
	persistPersonalNodeToken,
	pollPersonalNodeDeviceAuthorization,
	readPersonalNodeAuthSession,
	resolvePersonalNodeAccessToken,
} from "$lib/personal-node-auth";

class MemoryStorage implements Storage {
	readonly values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}

test("device authorization and polling use the Alpha relay", async () => {
	const requests: Request[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		if (request.url.endsWith("/auth/device")) {
			return Response.json({
				deviceCode: "device-code",
				userCode: "ABCD-EFGH",
				verificationUri: "https://auth.neta.art/device",
				verificationUriComplete:
					"https://auth.neta.art/device?user_code=ABCD-EFGH",
				expiresInSeconds: 600,
				intervalSeconds: 5,
			});
		}
		return Response.json({ status: "pending" }, { status: 202 });
	};
	const authorization = await beginPersonalNodeDeviceAuthorization(
		"https://dev-cohub.atou.cc",
		fetcher,
	);
	assert.equal(authorization.userCode, "ABCD-EFGH");
	const pending = await pollPersonalNodeDeviceAuthorization(
		"https://dev-cohub.atou.cc",
		authorization.deviceCode,
		fetcher,
	);
	assert.deepEqual(pending, { status: "pending" });
	assert.equal(requests.length, 2);
	assert.equal(requests[0]?.credentials, "omit");
	assert.equal(requests[1]?.credentials, "omit");
});

test("a completed device token persists and refreshes without losing a rotated or retained refresh token", async () => {
	const storage = new MemoryStorage();
	const first = persistPersonalNodeToken(
		{
			status: "complete",
			accessToken: "access-one",
			refreshToken: "refresh-one",
			idToken: "id-one",
			tokenType: "Bearer",
			expiresInSeconds: 1,
			scope: "openid offline_access",
		},
		null,
		storage,
	);
	assert.equal(readPersonalNodeAuthSession(storage)?.accessToken, "access-one");

	const accessToken = await resolvePersonalNodeAccessToken({
		apiOrigin: "https://dev-cohub.atou.cc",
		forceRefresh: true,
		storage,
		fetcher: async () =>
			Response.json({
				status: "complete",
				accessToken: "access-two",
				tokenType: "Bearer",
				expiresInSeconds: 3_600,
				scope: "openid offline_access",
			}),
	});
	assert.equal(accessToken, "access-two");
	const refreshed = readPersonalNodeAuthSession(storage);
	assert.equal(refreshed?.refreshToken, first.refreshToken);
	assert.equal(refreshed?.idToken, first.idToken);
});

test("corrupt stored authentication is surfaced and never replaced with an empty session", () => {
	const storage = new MemoryStorage();
	storage.setItem(PERSONAL_NODE_AUTH_STORAGE_KEY, "{broken");
	assert.throws(
		() => readPersonalNodeAuthSession(storage),
		(error: unknown) =>
			error instanceof PersonalNodeAuthError &&
			error.code === "personal_node_auth_state_corrupt",
	);
	assert.equal(storage.getItem(PERSONAL_NODE_AUTH_STORAGE_KEY), "{broken");
});
