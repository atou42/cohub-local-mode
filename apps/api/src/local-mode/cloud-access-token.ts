import { resolveAccessToken } from "@neta-art/cohub-cli/auth";
import { resolvePersonalNodeCloudAccessTokenFromEnvironment } from "./personal-node-cloud-auth.js";

type CloudAccessTokenOptions = { forceRefresh?: boolean };
type CloudAccessTokenResolver = (options?: CloudAccessTokenOptions) => Promise<string | null>;

export function createCloudAccessTokenResolver(dependencies: {
  resolvePersonalNodeCloudAccessTokenFromEnvironment: (forceRefresh: boolean) => Promise<string | null | undefined>;
  resolveHostAccessToken: CloudAccessTokenResolver;
}): CloudAccessTokenResolver {
  return async (options) => {
    const token = await dependencies.resolvePersonalNodeCloudAccessTokenFromEnvironment(options?.forceRefresh ?? false);
    if (token !== undefined) return token;
    return dependencies.resolveHostAccessToken(options);
  };
}

export const resolveCloudAccessToken = createCloudAccessTokenResolver({
  resolvePersonalNodeCloudAccessTokenFromEnvironment,
  resolveHostAccessToken: resolveAccessToken,
});
