const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+-alpha\.\d+$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function requireRecord(parent, key, path, errors) {
  const value = parent?.[key];
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireString(parent, key, path, errors) {
  const value = parent?.[key];
  if (!nonEmptyString(value)) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function requireBoolean(parent, key, expected, path, errors) {
  if (parent?.[key] !== expected) {
    errors.push(`${path} must be ${String(expected)}`);
  }
}

function requirePositiveInteger(parent, key, path, errors) {
  const value = parent?.[key];
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${path} must be a positive integer`);
  }
}

function requireTimestamp(parent, key, path, errors) {
  const value = parent?.[key];
  if (!validTimestamp(value)) {
    errors.push(`${path} must be an ISO-8601 timestamp`);
    return Number.NaN;
  }
  return Date.parse(value);
}

function requireStringArray(parent, key, path, errors) {
  const value = parent?.[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => !nonEmptyString(entry))
  ) {
    errors.push(`${path} must be a non-empty array of non-empty strings`);
    return [];
  }
  return value;
}

function requireImmutableImage(parent, key, path, errors) {
  const value = requireString(parent, key, path, errors);
  if (value && !IMAGE_DIGEST_PATTERN.test(value)) {
    errors.push(`${path} must use registry/name@sha256:<64 lowercase hex>`);
  }
}

function validateRelease(release, errors) {
  const releaseTag = requireString(
    release,
    "releaseTag",
    "release.releaseTag",
    errors,
  );
  if (releaseTag && !RELEASE_TAG_PATTERN.test(releaseTag)) {
    errors.push("release.releaseTag must match vX.Y.Z-alpha.N");
  }

  const appVersion = requireString(
    release,
    "appVersion",
    "release.appVersion",
    errors,
  );
  if (releaseTag && appVersion && releaseTag !== `v${appVersion}`) {
    errors.push("release.releaseTag must equal v + release.appVersion");
  }
  const commitSha = requireString(
    release,
    "commitSha",
    "release.commitSha",
    errors,
  );
  if (commitSha && !COMMIT_SHA_PATTERN.test(commitSha)) {
    errors.push("release.commitSha must be a full lowercase 40-character SHA");
  }

  requirePositiveInteger(
    release,
    "protocolVersion",
    "release.protocolVersion",
    errors,
  );
  requireString(
    release,
    "localSchemaVersion",
    "release.localSchemaVersion",
    errors,
  );
  requirePositiveInteger(
    release,
    "serverSchemaVersion",
    "release.serverSchemaVersion",
    errors,
  );
  const region = requireString(release, "region", "release.region", errors);
  if (["development", "local", "unspecified"].includes(region)) {
    errors.push("release.region must identify the deployment region");
  }
  requireBoolean(release, "publicAccess", true, "release.publicAccess", errors);
  requireBoolean(
    release,
    "publicTelemetry",
    true,
    "release.publicTelemetry",
    errors,
  );
  requireBoolean(
    release,
    "duelExperiment",
    false,
    "release.duelExperiment",
    errors,
  );
  requireImmutableImage(
    release,
    "serverImage",
    "release.serverImage",
    errors,
  );
  requireImmutableImage(release, "webImage", "release.webImage", errors);
}

function validateMetrics(metrics, releaseTag, errors) {
  requireString(metrics, "policyVersion", "metrics.policyVersion", errors);
  const publishedAt = requireTimestamp(
    metrics,
    "publishedAt",
    "metrics.publishedAt",
    errors,
  );
  const observationStart = requireTimestamp(
    metrics,
    "observationStart",
    "metrics.observationStart",
    errors,
  );
  const observationEnd = requireTimestamp(
    metrics,
    "observationEnd",
    "metrics.observationEnd",
    errors,
  );
  if (
    Number.isFinite(publishedAt) &&
    Number.isFinite(observationStart) &&
    publishedAt > observationStart
  ) {
    errors.push("metrics.publishedAt must not be after observationStart");
  }
  if (
    Number.isFinite(observationStart) &&
    Number.isFinite(observationEnd) &&
    observationEnd <= observationStart
  ) {
    errors.push("metrics.observationEnd must be after observationStart");
  }

  requirePositiveInteger(
    metrics,
    "minimumMeasurableSample",
    "metrics.minimumMeasurableSample",
    errors,
  );
  requireString(
    metrics,
    "eligibleTraffic",
    "metrics.eligibleTraffic",
    errors,
  );
  requireString(
    metrics,
    "missingDataTreatment",
    "metrics.missingDataTreatment",
    errors,
  );
  const eligibleVersions = requireStringArray(
    metrics,
    "eligibleVersions",
    "metrics.eligibleVersions",
    errors,
  );
  if (releaseTag && !eligibleVersions.includes(releaseTag)) {
    errors.push("metrics.eligibleVersions must include release.releaseTag");
  }
  requireStringArray(metrics, "exclusions", "metrics.exclusions", errors);
  const syntheticExclusions = requireStringArray(
    metrics,
    "syntheticExclusions",
    "metrics.syntheticExclusions",
    errors,
  );
  if (!syntheticExclusions.includes("synthetic-probe-v1")) {
    errors.push(
      "metrics.syntheticExclusions must include synthetic-probe-v1",
    );
  }

  const definitions = metrics.metricDefinitions;
  if (!Array.isArray(definitions) || definitions.length === 0) {
    errors.push("metrics.metricDefinitions must be a non-empty array");
  } else {
    const identifiers = new Set();
    for (const [index, definition] of definitions.entries()) {
      const path = `metrics.metricDefinitions[${index}]`;
      if (!isRecord(definition)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      const identifier = requireString(definition, "id", `${path}.id`, errors);
      requireString(definition, "formula", `${path}.formula`, errors);
      requireString(definition, "denominator", `${path}.denominator`, errors);
      if (identifier) {
        if (identifiers.has(identifier)) {
          errors.push(`${path}.id must be unique`);
        }
        identifiers.add(identifier);
      }
    }
  }

  const thresholds = requireRecord(
    metrics,
    "decisionThresholds",
    "metrics.decisionThresholds",
    errors,
  );
  requireString(thresholds, "go", "metrics.decisionThresholds.go", errors);
  requireString(
    thresholds,
    "revise",
    "metrics.decisionThresholds.revise",
    errors,
  );
  requireString(thresholds, "stop", "metrics.decisionThresholds.stop", errors);
}

function validateRollback(rollback, errors) {
  requireImmutableImage(
    rollback,
    "previousServerImage",
    "rollback.previousServerImage",
    errors,
  );
  requireImmutableImage(
    rollback,
    "previousWebImage",
    "rollback.previousWebImage",
    errors,
  );
  requireBoolean(
    rollback,
    "telemetryDataKeyContinuityConfirmed",
    true,
    "rollback.telemetryDataKeyContinuityConfirmed",
    errors,
  );
  requireBoolean(
    rollback,
    "storageSnapshotIncludesWal",
    true,
    "rollback.storageSnapshotIncludesWal",
    errors,
  );

  const deletionSafety = requireRecord(
    rollback,
    "deletionSafety",
    "rollback.deletionSafety",
    errors,
  );
  const method = requireString(
    deletionSafety,
    "method",
    "rollback.deletionSafety.method",
    errors,
  );
  requireTimestamp(
    deletionSafety,
    "completedAt",
    "rollback.deletionSafety.completedAt",
    errors,
  );
  requireString(
    deletionSafety,
    "receipt",
    "rollback.deletionSafety.receipt",
    errors,
  );
  if (
    method !== "previous_artifact_compatibility" &&
    method !== "restore_rehearsal"
  ) {
    errors.push(
      "rollback.deletionSafety.method must be previous_artifact_compatibility or restore_rehearsal",
    );
  } else if (method === "previous_artifact_compatibility") {
    requireBoolean(
      deletionSafety,
      "previousArtifactOpenedCurrentSchema",
      true,
      "rollback.deletionSafety.previousArtifactOpenedCurrentSchema",
      errors,
    );
  } else {
    requireBoolean(
      deletionSafety,
      "restoreRehearsalCompleted",
      true,
      "rollback.deletionSafety.restoreRehearsalCompleted",
      errors,
    );
    if (deletionSafety.deletedTelemetryResurrectionCount !== 0) {
      errors.push(
        "rollback.deletionSafety.deletedTelemetryResurrectionCount must be 0",
      );
    }
  }
}

function validateChecks(checks, errors) {
  requireString(checks, "cleanCiReceipt", "checks.cleanCiReceipt", errors);
  requireString(
    checks,
    "anonymousSmokeReceipt",
    "checks.anonymousSmokeReceipt",
    errors,
  );
}

export function validateReleaseEvidence(evidence) {
  const errors = [];
  if (!isRecord(evidence)) {
    return ["release evidence must be a JSON object"];
  }
  if (evidence.exampleOnly === true) {
    errors.push("exampleOnly must be removed from real release evidence");
  }
  if (evidence.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  const release = requireRecord(evidence, "release", "release", errors);
  const metrics = requireRecord(evidence, "metrics", "metrics", errors);
  const rollback = requireRecord(evidence, "rollback", "rollback", errors);
  const checks = requireRecord(evidence, "checks", "checks", errors);

  validateRelease(release, errors);
  validateMetrics(metrics, release.releaseTag, errors);
  validateRollback(rollback, errors);
  validateChecks(checks, errors);
  if (
    nonEmptyString(release.serverImage) &&
    release.serverImage === rollback.previousServerImage
  ) {
    errors.push(
      "rollback.previousServerImage must differ from release.serverImage",
    );
  }
  if (
    nonEmptyString(release.webImage) &&
    release.webImage === rollback.previousWebImage
  ) {
    errors.push(
      "rollback.previousWebImage must differ from release.webImage",
    );
  }
  return errors;
}
