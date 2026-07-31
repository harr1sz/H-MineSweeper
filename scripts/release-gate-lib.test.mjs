import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseEvidence } from "./release-gate-lib.mjs";

const SHA = "0123456789012345678901234567890123456789";
const DIGEST = `sha256:${"a".repeat(64)}`;
const PREVIOUS_DIGEST = `sha256:${"b".repeat(64)}`;

function validEvidence() {
  return {
    schemaVersion: 1,
    release: {
      releaseTag: "v0.2.0-alpha.2",
      appVersion: "0.2.0-alpha.2",
      commitSha: SHA,
      protocolVersion: 2,
      localSchemaVersion: "HMS-local-history-v1",
      serverSchemaVersion: 4,
      region: "asia-east",
      publicAccess: true,
      publicTelemetry: true,
      duelExperiment: false,
      serverImage: `registry.example/hms-server@${DIGEST}`,
      webImage: `registry.example/hms-web@${DIGEST}`,
    },
    metrics: {
      policyVersion: "alpha-solo-v1",
      publishedAt: "2026-08-01T00:00:00.000Z",
      observationStart: "2026-08-02T00:00:00.000Z",
      observationEnd: "2026-08-09T00:00:00.000Z",
      minimumMeasurableSample: 100,
      eligibleTraffic: "Anonymous public solo sessions on the release tag",
      eligibleVersions: ["v0.2.0-alpha.2"],
      exclusions: ["Automated traffic", "Known data-integrity incidents"],
      syntheticExclusions: ["synthetic-probe-v1"],
      missingDataTreatment: "Report missing denominators; do not impute",
      metricDefinitions: [
        {
          id: "solo_completion_rate",
          formula: "completed eligible runs / started eligible runs",
          denominator: "started eligible runs",
        },
      ],
      decisionThresholds: {
        go: "At least 60% completion with no integrity stop condition",
        revise: "Between 35% and 60% completion",
        stop: "Below 35% completion or any integrity stop condition",
      },
    },
    rollback: {
      previousServerImage: `registry.example/hms-server@${PREVIOUS_DIGEST}`,
      previousWebImage: `registry.example/hms-web@${PREVIOUS_DIGEST}`,
      telemetryDataKeyContinuityConfirmed: true,
      storageSnapshotIncludesWal: true,
      deletionSafety: {
        method: "restore_rehearsal",
        completedAt: "2026-08-01T00:00:00.000Z",
        receipt: "https://example.invalid/rehearsal/1",
        restoreRehearsalCompleted: true,
        deletedTelemetryResurrectionCount: 0,
      },
    },
    checks: {
      cleanCiReceipt: "https://example.invalid/actions/1",
      anonymousSmokeReceipt: "https://example.invalid/smoke/1",
    },
  };
}

test("accepts complete fail-closed release evidence", () => {
  assert.deepEqual(validateReleaseEvidence(validEvidence()), []);
});

test("rejects a duel-enabled public release", () => {
  const evidence = validEvidence();
  evidence.release.duelExperiment = true;
  assert.match(
    validateReleaseEvidence(evidence).join("\n"),
    /release\.duelExperiment must be false/,
  );
});

test("rejects mutable images and metrics published after observation starts", () => {
  const evidence = validEvidence();
  evidence.release.webImage = "registry.example/hms-web:latest";
  evidence.metrics.publishedAt = "2026-08-03T00:00:00.000Z";
  const errors = validateReleaseEvidence(evidence).join("\n");
  assert.match(errors, /release\.webImage must use/);
  assert.match(errors, /publishedAt must not be after observationStart/);
});

test("rejects mismatched versions and a current artifact used as rollback", () => {
  const evidence = validEvidence();
  evidence.release.appVersion = "0.2.0-alpha.3";
  evidence.rollback.previousServerImage = evidence.release.serverImage;
  evidence.rollback.previousWebImage = evidence.release.webImage;
  const errors = validateReleaseEvidence(evidence).join("\n");
  assert.match(errors, /releaseTag must equal v \+ release\.appVersion/);
  assert.match(errors, /previousServerImage must differ/);
  assert.match(errors, /previousWebImage must differ/);
});

test("rejects an incomplete deletion-safe restore rehearsal", () => {
  const evidence = validEvidence();
  evidence.rollback.deletionSafety.restoreRehearsalCompleted = false;
  evidence.rollback.deletionSafety.deletedTelemetryResurrectionCount = 1;
  const errors = validateReleaseEvidence(evidence).join("\n");
  assert.match(errors, /restoreRehearsalCompleted must be true/);
  assert.match(errors, /deletedTelemetryResurrectionCount must be 0/);
});

test("accepts previous-artifact schema compatibility as rollback evidence", () => {
  const evidence = validEvidence();
  evidence.rollback.deletionSafety = {
    method: "previous_artifact_compatibility",
    completedAt: "2026-08-01T00:00:00.000Z",
    receipt: "https://example.invalid/compatibility/1",
    previousArtifactOpenedCurrentSchema: true,
  };
  assert.deepEqual(validateReleaseEvidence(evidence), []);
});

test("rejects the checked-in example as real evidence", () => {
  const evidence = validEvidence();
  evidence.exampleOnly = true;
  assert.match(
    validateReleaseEvidence(evidence).join("\n"),
    /exampleOnly must be removed/,
  );
});
