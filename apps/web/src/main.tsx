import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TelemetryPrivacyProvider } from "./components/TelemetryPrivacy";
import {
  APP_VERSION,
  BUILD_REGION,
  BUILD_SHA,
  DUEL_EXPERIMENT_ENABLED,
  TELEMETRY_ENABLED,
} from "./lib/build-config";
import "./styles.css";

const buildMetadata = {
  "hms-build-app-version": APP_VERSION,
  "hms-build-sha": BUILD_SHA,
  "hms-build-region": BUILD_REGION,
  "hms-build-telemetry-enabled": String(TELEMETRY_ENABLED),
  "hms-build-duel-experiment": String(DUEL_EXPERIMENT_ENABLED),
};
for (const [name, content] of Object.entries(buildMetadata)) {
  document
    .querySelector(`meta[name="${name}"]`)
    ?.setAttribute("content", content);
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <TelemetryPrivacyProvider>
      <App />
    </TelemetryPrivacyProvider>
  </StrictMode>,
);
