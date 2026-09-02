import { getAuthToken, IS_PERSONAL_NODE_ALPHA } from "$lib/auth";
import { readPersonalNodeAuthSession } from "$lib/personal-node-auth";

export async function registerBundledPersonalNode() {
	if (!IS_PERSONAL_NODE_ALPHA || !window.cohubPersonalNode) return null;
	const accessToken = await getAuthToken();
	if (!accessToken) throw new Error("Personal Node sign-in is required");
	const session = readPersonalNodeAuthSession();
	if (!session || session.accessToken !== accessToken) {
		throw new Error("Personal Node sign-in session is unavailable");
	}
	return window.cohubPersonalNode.register({
		accessToken,
		refreshToken: session.refreshToken,
		accessTokenExpiresAt: session.accessTokenExpiresAt,
		scope: session.scope,
	});
}
