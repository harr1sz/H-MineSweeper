# Public Alpha Release and Rollback Runbook

## Current status

The product policy is a public Alpha with no account, access code, allowlist,
recruitment, or research-enrollment requirement. The repository remains at
Phase 0.5.

The repository implementation models public entry and a separate public
telemetry session; neither is a product-access credential. No frozen artifact
has yet passed the deployed anonymous-access checks below, so this is not M2
Alpha RC evidence.

## Preconditions

- M0 and M1 exit criteria are evidenced.
- All applicable M2 blockers are closed.
- A fresh browser can load the public Alpha and play solo without credentials,
  registration, consent, or prior browser state.
- Declining telemetry never changes product access.
- `duelExperiment` remains off unless every 1v1 integrity gate passes.
- Required CI passes from a clean checkout with the frozen lockfile.
- The target environment has documented storage, backup, restore, and incident
  ownership.
- Private vulnerability reporting and a public Alpha support route are
  available.

## Build identity

Record before deployment:

```text
release=v0.2.0-alpha.N
commit_sha=
app_version=
protocol_version=
solo_history_schema_version=
server_storage_schema_version=
region=
public_access=true
public_telemetry=true
duel_experiment=false
previous_artifact=
```

Build once. Deploy the immutable artifact that was tested; do not rebuild from
an unrecorded working tree.

Before calling an artifact an Alpha RC, copy
`docs/alpha-release-evidence.example.json` outside the repository, replace
every placeholder with durable evidence, remove `exampleOnly`, and run:

```bash
pnpm verify:release-candidate -- \
  --evidence=/absolute/path/to/alpha-release-evidence.json
```

The checked-in example is deliberately invalid and cannot be used as release
evidence. The gate rejects a duel-enabled public release, mutable image tags,
metrics published after observation begins, missing decision rules, missing
clean-CI or anonymous-smoke receipts, and rollback evidence that cannot prove
deleted telemetry stays deleted. Passing validates the evidence contract; it
does not perform the deployment, observation, backup, or restore rehearsal.

## Reference topology

The intended single-region topology is:

```text
public :443
    |
    v
nginx TLS web gateway :8443
    |-- static SPA + /web-healthz
    |-- /api/* ----------> Fastify :3001
    |-- /realtime/* -----> Fastify WebSocket
    |-- /live|/ready|/version|/health -> Fastify :3001
    v
named SQLite volume /data
```

- The web shell and professional solo path are public and local-first.
- The web container has no Compose startup dependency on server readiness.
  `/web-healthz` is an Nginx-local static health response and is the only web
  container health check. It does not proxy Fastify. `/live`, `/ready`, and
  `/version` remain separate server-surface checks through the public gateway.
  The optional Fastify upstream uses Docker's embedded resolver plus a shared
  Nginx upstream zone, so a cold web start must not require a currently
  resolvable server container.
  A healthy web container therefore proves only that the static gateway can
  answer; it never proves server health, JavaScript execution, or solo entry.
- `H_MINESWEEPER_DUEL_EXPERIMENT` independently gates guest, room, replay, and
  WebSocket surfaces. It defaults to `false`; disabling it must not make public
  solo unavailable or `/ready` fail.
- Guest, room, or optional telemetry capacity exhaustion applies backpressure
  only to the affected surface. It must not turn healthy local solo into a 503.
- Public telemetry sessions are always labeled `public/unsegmented`, use an
  HttpOnly cookie only for preference and ingestion authorization, and never
  unlock product routes or create a participant roster.
- `Dockerfile.server` must produce a Node-targeted bundle, retain `node:sqlite`,
  and embed the workspace game-core package so production does not execute
  TypeScript source.
- `deploy/nginx.conf` remains the same-origin boundary. Access and error logs
  must not become behavioral telemetry or record private payloads.
- Nginx terminates TLS directly for the reference topology. Its unencrypted
  health-check port is not publicly exposed.
- Both images carry OCI version and revision labels. `/version` must report the
  same app version, commit SHA, region, protocol, and schema identity.

The checked-in Compose and smoke/probe helpers implement the intended public
access shape. Release smoke performs a real clean-context Chromium load and
clicks `单人游戏 · 立即开局`; checking only the HTML root is not a solo success.
The recurring synthetic probe defaults to a no-persistent-write path, while its
telemetry lifecycle mode is explicit and separately scheduled. They are release
aids, not deployed evidence: a clean deployment must still prove the
preconditions above.

## Build and configuration

Keep environment and TLS files outside the repository with owner-only
permissions. Never commit telemetry secrets, private keys, tokens, personal
data, raw telemetry, or host paths.

Required release identity and network values include:

```text
H_MINESWEEPER_APP_VERSION=0.2.0-alpha.1
H_MINESWEEPER_BUILD_SHA=<full commit SHA>
H_MINESWEEPER_REGION=<single region identifier>
H_MINESWEEPER_SERVER_IMAGE_REF=<registry/name@sha256:digest>
H_MINESWEEPER_WEB_IMAGE_REF=<registry/name@sha256:digest>
H_MINESWEEPER_PUBLIC_ORIGIN=https://<alpha host>
H_MINESWEEPER_DUEL_EXPERIMENT=false
H_MINESWEEPER_TELEMETRY_SQLITE_FILE=/data/telemetry.sqlite3
H_MINESWEEPER_TELEMETRY_REQUIRE_PERSISTENT_STORE=true
H_MINESWEEPER_TELEMETRY_SECRET=<32+ character secret>
H_MINESWEEPER_MAX_TELEMETRY_SESSIONS=50000
H_MINESWEEPER_MAX_TELEMETRY_AGGREGATE_BUCKETS=10000
VITE_TELEMETRY_ENABLED=true
H_MINESWEEPER_TLS_CERTIFICATE_FILE=<absolute full-chain certificate path>
H_MINESWEEPER_TLS_PRIVATE_KEY_FILE=<absolute private-key path>
```

The final public artifact must make public telemetry settings explicit in its
build identity. A default, stale environment value, or a green container
health check is not proof that the public route is ungated.

Treat `H_MINESWEEPER_TELEMETRY_SECRET` as a persistent data key, not a
disposable deployment secret. Keep the same value across restarts, Alpha RCs,
backup restores, and rollback artifacts for at least the complete raw-event
retention window. Raw events and public telemetry sessions are fixed in code
to a seven-day TTL and cannot be lengthened with deployment configuration.
Back the secret up separately under the same access controls as the
SQLite volume. Never rotate it in place while attributable raw rows remain:
doing so would make old rows unreachable by the user's deletion proof even
though the API could accept the request. A rotation requires an implemented
dual-key deletion window or a tested pseudonym migration; otherwise stop
telemetry collection before changing the key.

Build once and record image digests and OCI labels. Docker administrators can
inspect container environments and secret mounts, so host/Docker access remains
a secret-management boundary. Certificate renewal requires a controlled
gateway reload or replacement followed by the same smoke checks.

## Staging smoke

Use a clean browser profile with no stored state and verify:

- the home page and standard or guided Solo load directly without an access prompt;
- no account, code, allowlist, enrollment, or telemetry preference is required
  before the first board;
- `/live`, `/ready`, `/version`, and compatibility `/health`;
- one terminal solo result, refresh recovery, trend filtering, JSON export,
  deletion, and a simulated storage failure;
- declining or ignoring telemetry leaves all public solo behavior available;
- when public telemetry is enabled, session creation, preference, opt-out,
  batching, deduplication, retention, and deletion all pass independently of
  access;
- public telemetry rows stay `public/unsegmented`; raw rows and public-session
  state expire after seven days and the release has no participant roster;
- rate and capacity limits reject only the affected network surface without
  process failure or loss of local solo;
- logs contain no personal data, full IP, board seed, mine map, replay payload,
  or telemetry payload.

If 1v1 is enabled, also verify dropped progress, reliable sequence continuity,
deadline rollback, invalid protocol messages, replay limits, direct room-link
recovery, and six real two-client matches.

Run the release smoke helper from an environment with the repository
dependencies and Playwright Chromium installed:

```bash
pnpm install --frozen-lockfile
pnpm --filter @h-minesweeper/web exec playwright install --with-deps chromium

HMS_SMOKE_BASE_URL=https://alpha.example.com \
HMS_EXPECTED_APP_VERSION=0.2.0-alpha.1 \
HMS_EXPECTED_BUILD_SHA=<full commit SHA> \
HMS_EXPECTED_REGION=<deployment region> \
HMS_EXPECTED_PROTOCOL_VERSION=2 \
HMS_EXPECTED_LOCAL_SCHEMA_VERSION=HMS-local-history-v1 \
HMS_EXPECTED_SERVER_SCHEMA_VERSION=4 \
pnpm smoke:release
```

It checks the static shell and `/web-healthz` as the web surface; loads the
deployed JavaScript in a new Chromium context; dismisses an unchosen telemetry
prompt without accepting it; clicks `单人游戏 · 立即开局`; and requires the
`经典扫雷` view. It reports `/live`, `/ready`, and `/version` as the server
surface, then runs the one-off telemetry lifecycle probe. If Playwright or its
Chromium binary is unavailable, the browser layer fails explicitly as
`browser probe unavailable`; the successful HTML-shell check is not promoted
to solo-entry success. Browser E2E still separately asserts detailed
no-access-prompt behavior. Neither substitutes for a human clean-profile smoke
against the deployed immutable artifact.

## Deployment

1. Confirm the previous immutable artifact is available.
2. Confirm the deletion-safe rollback method has a durable receipt.
3. Confirm storage backup and free-space thresholds.
4. Confirm the frozen metric policy was published before its observation
   window.
5. Confirm the frozen artifact passed clean CI and anonymous public-access
   smoke.
6. Run `pnpm verify:release-candidate` against the completed evidence file.
7. Deploy the recorded artifact to the single Alpha region.
8. Wait for `/ready`; bad readiness blocks network-dependent surfaces.
9. Run browser smoke against production from a clean profile.
10. Start the stateless regional synthetic probe for the Americas, Europe, and
   East Asia; separately schedule the explicit telemetry lifecycle probe at its
   lower frequency.
11. Publish a GitHub prerelease with the identity block, migrations, flags,
   known limitations, and rollback command.

Repository artifacts do not perform deployment. Starting containers, changing
DNS/CDN, creating a prerelease, and scheduling probes remain explicit operator
actions.

## Rollback triggers

Rollback or disable the affected feature for:

- lost or incorrect local history;
- incompatible schema or protocol behavior;
- privacy boundary violations or sensitive logging;
- a telemetry-secret mismatch that prevents deletion of retained raw rows;
- sustained capacity exhaustion or readiness failure;
- an incorrect 1v1 outcome, false integrity DNF, or replay-budget breach.

A duel-only incident turns off `duelExperiment` and rolls back or pauses only
the duel surface. It does not require disabling healthy public solo unless a
shared dependency was affected.

## Rollback procedure

The current v3-to-v4 telemetry migration is forward-only. It is not eligible
for an Internet Alpha release until the recorded previous server artifact can
open the additive v4 schema, or a deletion-safe storage restore rehearsal has
been completed. Restoring an older snapshot is not acceptable if it can
resurrect telemetry deleted after that snapshot. A forward migration test by
itself is not rollback evidence.

1. Disable `duelExperiment` first for duel-only incidents.
2. Stop telemetry collection if its privacy or integrity boundary is unsafe;
   public local solo should remain available when unaffected.
3. Redeploy the recorded prior artifact with the matching persisted telemetry
   data key; do not generate a replacement secret during rollback.
4. Preserve current storage; never clear data as a rollback shortcut.
5. Use the backward-compatible migration path or leave failed legacy data
   read-only and exportable.
6. Verify the anonymous public route, `/ready`, solo-history reads, and one new
   persisted result.
7. Record incident timing, affected release, data impact, and affected public
   Alpha observations.

After rollback, verify that traffic has returned to the recorded version and
commit SHA. Browser validation is still required for public access,
local-history reads, and one new persisted solo result. Take a
storage-consistent snapshot, including database and WAL state, before any
release with migrations.

## Seven-day RC observation

Run two deliberately separate probe classes from independent American,
European, and East Asian locations:

```bash
# Recommended every 60 seconds per region. No durable server row is created.
HMS_PROBE_BASE_URL=https://alpha.example.com \
HMS_PROBE_REGION=americas \
pnpm probe:synthetic

# Recommended every 15 minutes per region. Explicitly creates one telemetry
# session, restores it once, then records the disabled preference.
HMS_PROBE_BASE_URL=https://alpha.example.com \
HMS_PROBE_REGION=americas \
pnpm probe:synthetic:telemetry
```

The default high-frequency probe checks the static HTML shell, static
`/web-healthz`, real JavaScript execution plus the solo-entry click, server
`/live`, server `/ready`, and build identity. It never calls a telemetry,
guest, room, replay, or WebSocket endpoint; its browser layer observes requests
and fails if a page regression touches one of those stateful surfaces. The JSON
result reports `web` and `server` separately; a green web surface must remain
visible even if the server surface is red, while overall probe status still
fails.

The explicit 15-minute stateful probe checks server health and creates exactly
one new seven-day public telemetry session per run. At three regions this is
`3 × 4 × 24 = 288` new sessions per day and at most `2,016` live synthetic
sessions at steady state under a seven-day TTL, or about 4.1% of the default
50,000-session cap. Alert well before synthetic usage plus real traffic reaches
the configured cap; reducing the interval requires a new written capacity
budget. Do not schedule the stateful command at the 60-second stateless cadence.
Synthetic preference acknowledgements use the dedicated
`synthetic-probe-v1` app-version bucket. The probe enables collection, writes
and idempotently replays one allowlisted event, deletes it, proves the stale
event cannot return, opts out, and proves a new batch is rejected. Exclude the
synthetic bucket from all public product and opt-out analysis; it exists only
to verify the endpoint lifecycle.

The browser host must install the repository-pinned Playwright Chromium. An
environment without a working browser records the web browser layer as
unavailable and fails that observation; it cannot substitute `200` from `/`
or `/web-healthz`. Report availability and latency by region and surface for
seven natural days. A measured result is an Alpha engineering gate, not a
formal global SLA or proof of product-market fit.

When `duelExperiment` is disabled, realtime observations are out of scope for
the solo RC and are reported as not probed; `duelIntegrityProbed` remains
`false`. `HMS_PROBE_REALTIME=true` is rejected by the default stateless mode and
is only accepted with the explicit stateful mode. A duel-enabled deployment
must also set `HMS_PROBE_EXPECTED_DUEL=true` for the stateless browser probe so
its UI and `/version` expectations match the immutable artifact. Enabling the
browser entry requires a separate seven-day realtime run with both server and
client flags enabled.

Public product analysis must predeclare its denominator, eligible versions,
window, exclusions, minimum measurable sample, missing-data treatment, and
decision thresholds. The fixed seven-day raw retention is not extended to make
an analysis easier; questions that need a longer identifiable window are
reported as unavailable unless they can be answered from privacy-preserving
aggregates.
