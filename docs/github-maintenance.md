# GitHub Maintenance Model

This document defines repository-side policy. Creating GitHub milestones,
labels, rulesets, releases, or issues is a separate external operation.

## Work hierarchy

```text
Milestone
└── Epic parent issue
    ├── 1–3 day child issue
    ├── 1–3 day child issue
    └── 1–3 day child issue
```

Use GitHub's native sub-issue and blocking relationships. Do not encode
dependencies only in prose.

The canonical milestones are:

- `M0 Alpha Truth & Foundation`
- `M1 Professional Solo Memory Loop`
- `M2 Public Alpha Release Candidate`
- `Public Alpha Validation`

One child issue maps to one pull request. Every implementation pull request
uses `Closes #…`.

## Labels

Create exactly these initial labels:

- Priority: `priority:P0`, `priority:P1`, `priority:P2`
- Type: `type:bug`, `type:feature`, `type:research`, `type:test`, `type:ops`,
  `type:security`
- Area: `area:solo`, `area:history`, `area:telemetry`, `area:realtime`,
  `area:server`, `area:a11y`
- Gate: `gate:alpha-blocker`, `gate:duel-experiment`, `gate:deferred`
- Confidence: `confidence:verified`, `confidence:hypothesis`

Research assumptions always carry `type:research` and
`confidence:hypothesis`. A label change to `confidence:verified` must link the
evidence that changed the classification.

## Main ruleset

After the first successful workflow run, apply a ruleset to `main` with:

- changes only through pull requests;
- required status check `typecheck-test-build`;
- force pushes and branch deletion blocked;
- linear history required;
- review conversations resolved before merge.

For the current single-maintainer Alpha, a second approval is not required.
That exception does not bypass required CI. Before making the check required,
open a test pull request and verify that deliberately breaking typecheck,
tests, and production build each prevents a green required check.

## Repository forms

The repository contains:

- configuration bug, feature/PRD, and research issue forms;
- a pull request template covering scope, contracts, evidence,
  accessibility, privacy, and rollback;
- required CI using the lockfile;
- a private security-reporting policy;
- a public contribution-intake policy under the MIT License that does not imply
  automatic acceptance.

## External activation checklist

- [ ] Create the labels and four milestones.
- [ ] Create epic parent issues and native child/blocking relationships.
- [ ] Enable private vulnerability reporting.
- [ ] Run Required CI successfully on a pull request.
- [ ] Prove each CI command can block the check.
- [ ] Apply and inspect the `main` ruleset.
- [ ] Confirm force-push/delete rejection with a safe disposable branch test.
- [ ] Publish the first `v0.2.0-alpha.N` as a prerelease only after M2 exits.

Do not add a GitHub Project, mandatory second-person approval, CODEOWNERS, or
automated acceptance of external pull requests in this phase. The repository is
licensed under MIT; that license does not require the maintainer to accept or
support external contributions.
