import { DurableObject } from "cloudflare:workers";
import {
	ALPHA_MAX_DEVICES_PER_ACCOUNT,
	alphaDeviceCredentialMatches,
	createAlphaDeviceRecord,
	parseAlphaDeviceRegistration,
	publicAlphaDevice,
	revokeAlphaDevice,
	rotateAlphaDeviceCredential,
	updateAlphaDeviceRegistration,
	type AlphaDeviceRecord,
} from "./alpha-account-core.ts";
import { RelayProtocolError } from "./protocol.ts";

type AlphaAccountEnv = Record<string, never>;

type StoredAlphaAccountIdentity = {
	accountId: string;
	subject: string;
	userUuid: string;
};

const ACCOUNT_IDENTITY_KEY = "meta:identity";
const DEVICE_PREFIX = "device:";
const INSTALLATION_PREFIX = "installation:";

function response(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

function errorResponse(error: unknown) {
	if (error instanceof RelayProtocolError) {
		return response({ code: error.code, message: error.message }, error.status);
	}
	console.error("[alpha-account] unhandled request error", error);
	return response(
		{ code: "internal_error", message: "Personal Node account request failed" },
		500,
	);
}

async function body<T = Record<string, unknown>>(request: Request) {
	const value = await request.json().catch(() => null);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RelayProtocolError("invalid_json", "Request body must be an object");
	}
	return value as T;
}

function accountIdFromRequest(request: Request) {
	const accountId = request.headers.get("x-cohub-alpha-account-id")?.trim() ?? "";
	if (!/^[0-9a-f]{64}$/.test(accountId)) {
		throw new RelayProtocolError(
			"alpha_identity_invalid",
			"Trusted account identity is incomplete",
			403,
		);
	}
	return accountId;
}

function identityFromRequest(request: Request): StoredAlphaAccountIdentity {
	const accountId = accountIdFromRequest(request);
	const subject = request.headers.get("x-cohub-alpha-subject")?.trim() ?? "";
	const userUuid = request.headers.get("x-cohub-alpha-user-uuid")?.trim() ?? "";
	if (!subject || !userUuid) {
		throw new RelayProtocolError(
			"alpha_identity_invalid",
			"Trusted account identity is incomplete",
			403,
		);
	}
	return { accountId, subject, userUuid };
}

function deviceKey(deviceId: string) {
	return `${DEVICE_PREFIX}${deviceId}`;
}

function installationKey(installationId: string) {
	return `${INSTALLATION_PREFIX}${installationId}`;
}

export class PersonalAccount extends DurableObject<AlphaAccountEnv> {
	async fetch(request: Request) {
		try {
			if (request.headers.get("x-cohub-alpha-device-auth") === "1") {
				await this.requireBoundAccount(accountIdFromRequest(request));
			} else {
				await this.bindIdentity(identityFromRequest(request));
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/internal/devices") {
				return this.listDevices();
			}
			if (request.method === "POST" && url.pathname === "/internal/devices") {
				return this.registerDevice(request);
			}
			const match = url.pathname.match(
				/^\/internal\/devices\/([0-9a-f-]+)\/(rotate|revoke|authorize|owner-authorize)$/,
			);
			if (!match?.[1] || !match[2]) {
				return response({ code: "not_found", message: "Account route not found" }, 404);
			}
			if (request.method !== "POST") {
				return response({ code: "method_not_allowed", message: "Method not allowed" }, 405);
			}
			const deviceId = match[1].toLowerCase();
			if (match[2] === "rotate") return this.rotateCredential(deviceId, request);
			if (match[2] === "revoke") return this.revokeDevice(deviceId);
			if (match[2] === "owner-authorize") return this.authorizeOwnerDevice(deviceId);
			return this.authorizeDevice(deviceId, request);
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async requireBoundAccount(accountId: string) {
		const existing = await this.ctx.storage.get<StoredAlphaAccountIdentity>(
			ACCOUNT_IDENTITY_KEY,
		);
		if (!existing) {
			throw new RelayProtocolError(
				"alpha_account_not_registered",
				"Personal Node account has not been registered",
				404,
			);
		}
		if (existing.accountId !== accountId) {
			throw new RelayProtocolError(
				"alpha_identity_mismatch",
				"Account identity does not match this Personal Node account",
				403,
			);
		}
	}

	private async bindIdentity(identity: StoredAlphaAccountIdentity) {
		const existing = await this.ctx.storage.get<StoredAlphaAccountIdentity>(
			ACCOUNT_IDENTITY_KEY,
		);
		if (!existing) {
			await this.ctx.storage.put(ACCOUNT_IDENTITY_KEY, identity);
			return;
		}
		if (
			existing.accountId !== identity.accountId ||
			existing.subject !== identity.subject ||
			existing.userUuid !== identity.userUuid
		) {
			throw new RelayProtocolError(
				"alpha_identity_mismatch",
				"Account identity does not match this Personal Node account",
				403,
			);
		}
	}

	private async listDevices() {
		const records = await this.ctx.storage.list<AlphaDeviceRecord>({
			prefix: DEVICE_PREFIX,
		});
		return response({
			devices: [...records.values()]
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.map(publicAlphaDevice),
		});
	}

	private async registerDevice(request: Request) {
		const registration = parseAlphaDeviceRegistration(await body(request));
		const now = new Date().toISOString();
		return this.ctx.storage.transaction(async (storage) => {
			const existingDeviceId = await storage.get<string>(
				installationKey(registration.installationId),
			);
			if (existingDeviceId) {
				const existing = await storage.get<AlphaDeviceRecord>(
					deviceKey(existingDeviceId),
				);
				if (!existing) {
					throw new RelayProtocolError(
						"alpha_account_state_invalid",
						"Device installation index points to a missing device",
						500,
					);
				}
				const updated = updateAlphaDeviceRegistration({
					existing,
					registration,
					now,
				});
				await storage.put(deviceKey(updated.id), updated);
				return response({ device: publicAlphaDevice(updated), deduplicated: true });
			}
			const devices = await storage.list<AlphaDeviceRecord>({
				prefix: DEVICE_PREFIX,
			});
			const activeCount = [...devices.values()].filter(
				(device) => device.status === "active",
			).length;
			if (activeCount >= ALPHA_MAX_DEVICES_PER_ACCOUNT) {
				throw new RelayProtocolError(
					"alpha_device_limit",
					"Personal Node device limit reached",
					409,
				);
			}
			const device = createAlphaDeviceRecord({
				registration,
				deviceId: crypto.randomUUID(),
				now,
			});
			await storage.put({
				[deviceKey(device.id)]: device,
				[installationKey(device.installationId)]: device.id,
			});
			return response(
				{ device: publicAlphaDevice(device), deduplicated: false },
				201,
			);
		});
	}

	private async getDevice(deviceId: string) {
		const device = await this.ctx.storage.get<AlphaDeviceRecord>(
			deviceKey(deviceId),
		);
		if (!device) {
			throw new RelayProtocolError(
				"alpha_device_not_found",
				"Personal Node device not found",
				404,
			);
		}
		return device;
	}

	private async rotateCredential(deviceId: string, request: Request) {
		const input = await body<{ credentialHash?: unknown }>(request);
		const existing = await this.getDevice(deviceId);
		const updated = rotateAlphaDeviceCredential({
			existing,
			credentialHash: input.credentialHash,
			now: new Date().toISOString(),
		});
		await this.ctx.storage.put(deviceKey(deviceId), updated);
		return response({ device: publicAlphaDevice(updated) });
	}

	private async revokeDevice(deviceId: string) {
		const existing = await this.getDevice(deviceId);
		const updated = revokeAlphaDevice(existing, new Date().toISOString());
		await this.ctx.storage.put(deviceKey(deviceId), updated);
		return response({ device: publicAlphaDevice(updated) });
	}

	private async authorizeDevice(deviceId: string, request: Request) {
		const input = await body<{ credentialHash?: unknown }>(request);
		const credentialHash =
			typeof input.credentialHash === "string"
				? input.credentialHash.trim().toLowerCase()
				: "";
		const device = await this.getDevice(deviceId);
		if (!alphaDeviceCredentialMatches(device, credentialHash)) {
			throw new RelayProtocolError(
				"alpha_device_unauthorized",
				"Personal Node device credential is invalid or revoked",
				403,
			);
		}
		const updated = {
			...device,
			lastSeenAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(deviceKey(deviceId), updated);
		return response({ ok: true, device: publicAlphaDevice(updated) });
	}

	private async authorizeOwnerDevice(deviceId: string) {
		const device = await this.getDevice(deviceId);
		if (device.status !== "active") {
			throw new RelayProtocolError(
				"alpha_device_revoked",
				"Personal Node device is revoked",
				403,
			);
		}
		return response({ ok: true, device: publicAlphaDevice(device) });
	}
}
