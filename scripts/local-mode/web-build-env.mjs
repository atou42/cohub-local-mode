const publicWebSettings = new Set([
  "PUBLIC_API_ORIGIN",
  "PUBLIC_GATEWAY_ORIGIN",
  "PUBLIC_CLOUD_API_ORIGIN",
  "PUBLIC_CLOUD_GATEWAY_ORIGIN",
  "PUBLIC_COHUB_ENV",
  "PUBLIC_COHUB_LOCAL_MODE",
  "PUBLIC_DESKTOP_CLIENT",
  "PUBLIC_PERSONAL_NODE_ALPHA",
  "PUBLIC_LOCAL_PRIVATE_ORIGIN",
  "PUBLIC_LOCAL_RELAY_ENABLED",
  "PUBLIC_LOCAL_RELAY_BASE_PATH",
  "PUBLIC_LOCAL_RELAY_NODE_ID",
  "PUBLIC_LOCAL_FEDERATED_API_URL",
  "PUBLIC_LOGTO_ENDPOINT",
  "PUBLIC_LOGTO_APP_ID",
  "PUBLIC_LOGTO_API_RESOURCE",
  "PUBLIC_MARKETPLACE_APP_ID",
  "PUBLIC_PREVIEW_ORIGIN",
  "PUBLIC_SITE_ORIGIN",
  "PUBLIC_LANDING_MEDIA_BASE",
]);

export function webBuildEnvironment(environment) {
  // Backend object-store settings also use PUBLIC_; they are not browser data.
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !key.startsWith("PUBLIC_") || publicWebSettings.has(key),
  ));
}
