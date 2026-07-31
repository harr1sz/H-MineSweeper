# Product Phase and Release Policy

Last updated: 2026-07-30

## Product hierarchy

H-MineSweeper's public-access Alpha has one primary product:

1. **Professional solo training** is the product and the Alpha North Star.
2. **Minesweeper Academy** is a supporting learning entry point.
3. **1v1** is an independently switchable experiment. A duel-only failure turns
   off the duel surface and must not block healthy public solo.

This release does not claim to be a competitive platform, ranked service,
public Beta, or product-market-fit proof.

## Canonical phase meanings

| Term | Meaning | Exit condition |
| --- | --- | --- |
| Phase 0.5 | A functional prototype with public-access solo, Academy, and experimental 1v1 paths | Remains the product-validation phase until public Alpha evidence is decision-ready |
| Alpha RC | A versioned, deployable candidate with the required engineering and operational gates | All applicable M0–M2 gates pass for that immutable artifact |
| Phase 1 complete | The professional-solo hypothesis has enough evidence to expand | Predeclared public Alpha metrics, observation windows, and missing-data rules are satisfied, with no unresolved solo data-integrity stop condition |

A merge, green CI run, deployed release candidate, feature count, or successful
demo does not close Phase 1.

## Milestone sequence

```text
M0 Alpha Truth & Foundation
  -> M1 Professional Solo Memory Loop
  -> M2 Public Alpha Release Candidate
  -> Public Alpha Validation

M2 protocol gate -> 1v1 integrity gate -> duelExperiment=true
                                      -> failure: keep 1v1 off
```

The public Alpha has no access gate, recruitment workflow, closed sample, or
predetermined headcount. Product decisions use real public traffic. Before an
observation window begins, the maintainer must publish the
metric formulas, eligible traffic, exclusions, minimum measurable sample,
window length, version boundaries, missing-data treatment, and Go/revise/stop
thresholds. These rules must not be backfilled or re-scored after seeing
results.

An Alpha RC must carry a completed release-evidence document validated by
`pnpm verify:release-candidate`. The evidence records the immutable artifacts,
clean CI and anonymous smoke receipts, the prepublished metric policy, and one
of the two accepted deletion-safe rollback proofs. A passing validator is a
contract check, not permission to invent missing observations or rehearse
production operations on paper.

Pseudonymous raw telemetry and public-session state have a fixed seven-day
retention period. The retention period is not extended for analysis. Any
product question that needs a longer identifiable window must be answered with
privacy-preserving aggregates or declared unmeasurable under the current
contract; it must not silently retain raw rows for longer.

## Release identity

- Alpha candidates use `v0.2.0-alpha.N`.
- Every candidate records its commit SHA, app version, protocol version, local
  history schema version, server storage schema version, migrations, enabled
  feature flags, and rollback artifact.
- GitHub releases are marked as prereleases.
- One prior immutable artifact remains deployable for rollback.
- A schema change must remain backward compatible with the previous release
  candidate.

## Claims discipline

Public and in-product language must distinguish:

- implemented behavior;
- locally or automatically tested behavior;
- observed Alpha behavior;
- product hypotheses awaiting evidence.

Public Alpha evidence can support an expand/focused-revision/stop decision only
when its denominator, exclusions, missing data, versions, and observation
window are reported. It cannot by itself establish product-market fit,
long-term retention, commercial viability, global availability, fairness at
ranked-service scale, or public Beta readiness.
