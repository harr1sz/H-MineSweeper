export const APP_VERSION =
  import.meta.env.VITE_APP_VERSION ?? "0.2.0-alpha.1";
export const BUILD_SHA =
  import.meta.env.VITE_BUILD_SHA ?? "development";
export const BUILD_REGION =
  import.meta.env.VITE_BUILD_REGION ?? "local";
export const TELEMETRY_ENABLED =
  import.meta.env.VITE_TELEMETRY_ENABLED === "true";
export const DUEL_EXPERIMENT_ENABLED =
  import.meta.env.VITE_DUEL_EXPERIMENT === "true";
