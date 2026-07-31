import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateReleaseEvidence } from "./release-gate-lib.mjs";

const evidenceArgument = process.argv.find((argument) =>
  argument.startsWith("--evidence="),
);
const evidencePath =
  evidenceArgument?.slice("--evidence=".length) ??
  process.env.HMS_RELEASE_EVIDENCE_FILE;

try {
  if (!evidencePath) {
    throw new Error(
      "Provide --evidence=<path> or HMS_RELEASE_EVIDENCE_FILE",
    );
  }
  const absolutePath = resolve(evidencePath);
  const evidence = JSON.parse(await readFile(absolutePath, "utf8"));
  const errors = validateReleaseEvidence(evidence);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      verification: "release-candidate-evidence",
      evidencePath: absolutePath,
      releaseTag: evidence.release.releaseTag,
      commitSha: evidence.release.commitSha,
      region: evidence.release.region,
      duelExperiment: evidence.release.duelExperiment,
      metricPolicyVersion: evidence.metrics.policyVersion,
      rollbackMethod: evidence.rollback.deletionSafety.method,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      verification: "release-candidate-evidence",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
