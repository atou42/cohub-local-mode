import { createHash } from "node:crypto";

export function localAccountFromVerifiedRegistration(input: {
	accessToken: string;
	account: { accountId?: unknown; userUuid?: unknown };
	deviceId: string;
	issuer: string;
}) {
	// The account endpoint already verified this exact token. The hash binds its
	// claims to that authenticated response; decoding alone is not authorization.
	const claims = JSON.parse(Buffer.from(input.accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
	if (claims.iss !== input.issuer || typeof claims.sub !== "string" || !claims.sub || typeof claims.client_id !== "string" || !claims.client_id || claims.talesofai_uuid !== input.account.userUuid) throw new Error("The verified account does not match the desktop token");
	if (typeof input.account.userUuid !== "string" || !input.account.userUuid.trim() || /[\r\n\0]/.test(input.account.userUuid) || !/^[0-9a-f-]{36}$/i.test(input.deviceId)) throw new Error("The verified desktop identity is invalid");
	const accountId = createHash("sha256").update(`${input.issuer}\0${claims.sub}`).digest("hex");
	if (accountId !== input.account.accountId) throw new Error("The verified account binding is invalid");
	return { accountId, userUuid: input.account.userUuid, subject: claims.sub as string, clientId: claims.client_id as string, issuer: input.issuer, deviceId: input.deviceId };
}
