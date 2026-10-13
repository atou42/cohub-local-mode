import type { AppRuntimeContext, Permission } from "@neta-art/cohub";
import { scopeListHasPermission } from "@neta-art/cohub";
import type { ResourceAppKind } from "@cohub/protocol";

export function readScopes(kind: ResourceAppKind): Permission[] {
  return [
    (
      {
        task: "taskrun.view",
        checkpoint: "checkpoint.view",
        cronjob: "cronjob.view",
        app: "space.view",
      } as const
    )[kind],
  ];
}

export function hasScopes(
  context: AppRuntimeContext | null,
  spaceId: string,
  scopes: Permission[],
) {
  if (!context) return false;
  const grants =
    context.permissions?.viewerGrants
      ?.filter((grant) => grant.spaceId === spaceId)
      .flatMap((grant) => grant.scopes) ?? [];
  const owned =
    context.app.homeSpace?.id === spaceId
      ? (context.permissions?.appScopes ?? [])
      : [];
  return scopes.every((scope) =>
    scopeListHasPermission([...grants, ...owned], scope),
  );
}

export function hasAccountScope(
  context: AppRuntimeContext | null,
  scope: Permission,
) {
  return Boolean(context?.permissions?.viewerScopes.includes(scope));
}

export function resourceKey(
  context: AppRuntimeContext,
  spaceId: string,
  kind: ResourceAppKind,
  id: string,
  base = "",
) {
  return context.viewer?.userUuid
    ? JSON.stringify([
        "resource-app:v1",
        context.app.id,
        context.viewer.userUuid,
        spaceId,
        kind,
        id,
        base,
      ])
    : null;
}

export function statusCode(error: unknown) {
  return (error as { status?: number } | null)?.status;
}

export function isAccessError(error: unknown) {
  const status = statusCode(error);
  return status === 401 || status === 403;
}
