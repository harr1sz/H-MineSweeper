export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_CONSENT_VERSION = "alpha-telemetry-v1";
export const TELEMETRY_RAW_RETENTION_DAYS = 7;
export const TELEMETRY_AGGREGATE_RETENTION_DAYS = 30;

export const TELEMETRY_CONSENT_STORAGE_KEY = "hms-telemetry-consent-v1";
const IDENTITY_KEY = "hms-telemetry-identity-v1";
const VISIT_SESSION_KEY = "hms-telemetry-visit-session-v1";
const LEGACY_QUEUE_KEY = "hms-telemetry-queue-v1";
const TAB_QUEUE_KEY = "hms-telemetry-tab-queue-v1";
export const TELEMETRY_DELETION_STATE_STORAGE_KEY =
  "hms-telemetry-deletion-state-v1";
const VISIT_IDLE_MS = 30 * 60 * 1_000;
const MAX_QUEUE_EVENTS = 200;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_BATCH_EVENTS = 50;
const MAX_BATCH_BYTES = 64 * 1024;
const PENDING_INSTALL_ID = "00000000000000000000000000000000";

export const ALLOWED_TELEMETRY_EVENT_NAMES = [
  "app_ready",
  "mode_selected",
  "solo_run_started",
  "solo_run_terminal",
  "practice_run_started",
  "practice_hint_shown",
  "practice_assist_applied",
  "practice_run_terminal",
  "solo_history_opened",
  "solo_history_filtered",
  "solo_exported",
  "no_guess_generation_finished",
  "practice_no_guess_generation_finished",
  "duel_invite_created",
  "duel_invite_opened",
  "duel_joined",
  "duel_started",
  "duel_completed",
  "duel_dnf",
] as const;

export type AllowedTelemetryEventName =
  (typeof ALLOWED_TELEMETRY_EVENT_NAMES)[number];
export type TelemetryProperty = string | number | boolean | null;

export interface TelemetryEventV1 {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly eventId: string;
  readonly pseudonymousInstallId: string;
  readonly sessionId: string;
  readonly eventName: AllowedTelemetryEventName;
  readonly occurredAt: string;
  readonly consentVersion: string;
  readonly appVersion: string;
  readonly properties: Readonly<Record<string, TelemetryProperty>>;
}

export interface TelemetryConsentV1 {
  readonly schemaVersion: 1;
  readonly consentVersion: typeof TELEMETRY_CONSENT_VERSION;
  readonly enabled: boolean;
  readonly acknowledgedAt: string;
}

interface TelemetryIdentityV1 {
  readonly schemaVersion: 1;
  readonly pseudonymousInstallId: string;
  readonly deletionToken: string;
}

interface VisitSessionV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly lastActivityAt: number;
}

export interface TelemetrySettingsSnapshot {
  readonly available: boolean;
  readonly acknowledged: boolean;
  readonly enabled: boolean;
  readonly hasDeletionCredential: boolean;
  readonly queuedEvents: number;
  readonly error: string | null;
}

export interface TelemetryDeleteResult {
  readonly accepted: true;
  readonly deletionEpoch: number;
  readonly deletedBefore: string;
}

interface PublicTelemetrySessionV1 {
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly batchId: "public";
  readonly cohortSegment: "unsegmented";
}

interface TelemetryDeletionStateV1 {
  readonly schemaVersion: 1;
  readonly pseudonymousInstallId: string;
  readonly deletionEpoch: number;
  readonly deletedBefore: string;
}

interface TelemetryQueueV1 {
  readonly schemaVersion: 1;
  readonly deletionEpoch: number;
  readonly events: readonly TelemetryEventV1[];
}

export interface TelemetryClientOptions {
  readonly enabledByDeployment: boolean;
  readonly appVersion: string;
  readonly storage?: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  >;
  readonly sessionStorage?: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  >;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly withExclusiveLock?: <T>(
    operation: () => Promise<T>,
  ) => Promise<T>;
}

const PROPERTY_ALLOWLIST: Readonly<
  Record<AllowedTelemetryEventName, ReadonlySet<string>>
> = {
  app_ready: new Set([
    "browserFamily",
    "deviceClass",
    "viewportBucket",
    "stageDurationMs",
  ]),
  mode_selected: new Set(["mode", "source", "stageDurationMs"]),
  solo_run_started: new Set([
    "trainingSessionId",
    "preset",
    "generationMode",
    "width",
    "height",
    "mines",
    "stageDurationMs",
  ]),
  solo_run_terminal: new Set([
    "trainingSessionId",
    "preset",
    "generationMode",
    "outcome",
    "elapsedMs",
    "terminalBoardCount",
    "effectiveInteractionMs",
    "runEffectiveInteractionMs",
    "historySaved",
    "historyFailureReason",
    "inputSampleCount",
    "inputP95Ms",
    "stageDurationMs",
  ]),
  practice_run_started: new Set([
    "trainingSessionId",
    "preset",
    "generationMode",
    "width",
    "height",
    "mines",
    "assistMode",
    "stageDurationMs",
  ]),
  practice_hint_shown: new Set([
    "trigger",
    "status",
    "action",
    "stageDurationMs",
  ]),
  practice_assist_applied: new Set([
    "trigger",
    "action",
    "stageDurationMs",
  ]),
  practice_run_terminal: new Set([
    "trainingSessionId",
    "preset",
    "generationMode",
    "outcome",
    "elapsedMs",
    "playerActions",
    "hintsShown",
    "hintsRequested",
    "autoFlags",
    "demonstratedActions",
    "historySaved",
    "historyFailureReason",
    "stageDurationMs",
  ]),
  solo_history_opened: new Set([
    "scope",
    "recordCount",
    "stageDurationMs",
  ]),
  solo_history_filtered: new Set([
    "scope",
    "preset",
    "generationMode",
    "stageDurationMs",
  ]),
  solo_exported: new Set(["format", "recordCount", "stageDurationMs"]),
  no_guess_generation_finished: new Set([
    "preset",
    "success",
    "attempts",
    "elapsedMs",
    "failureReason",
  ]),
  practice_no_guess_generation_finished: new Set([
    "preset",
    "success",
    "attempts",
    "elapsedMs",
    "failureReason",
  ]),
  duel_invite_created: new Set(["source", "stageDurationMs"]),
  duel_invite_opened: new Set(["source", "stageDurationMs"]),
  duel_joined: new Set(["stageDurationMs"]),
  duel_started: new Set(["round", "stageDurationMs"]),
  duel_completed: new Set(["outcome", "rounds", "stageDurationMs"]),
  duel_dnf: new Set(["reason", "round", "stageDurationMs"]),
};

type TelemetryPropertyValidator = (value: TelemetryProperty) => boolean;

function enumProperty(
  ...allowedValues: readonly string[]
): TelemetryPropertyValidator {
  const allowed = new Set(allowedValues);
  return (value) => typeof value === "string" && allowed.has(value);
}

const nonNegativeNumber: TelemetryPropertyValidator = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonNegativeInteger: TelemetryPropertyValidator = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boardDimension: TelemetryPropertyValidator = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 5 &&
  value <= 100;
const mineCount: TelemetryPropertyValidator = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= 4_000;
const booleanProperty: TelemetryPropertyValidator = (value) =>
  typeof value === "boolean";
const trainingSessionId: TelemetryPropertyValidator = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/u.test(value);
const practiceHistoryFailureReason: TelemetryPropertyValidator = (value) =>
  value === null ||
  (typeof value === "string" && [
    "QUOTA",
    "SERIALIZATION",
    "STORAGE",
    "REPLAY_LIMIT",
  ].includes(value));

// Keep the browser's practice-event contract as strict as the ingest
// contract. This prevents an invalid persisted event from poisoning every
// later batch with a repeatable server-side 400 response.
const PRACTICE_PROPERTY_VALIDATORS: Readonly<
  Partial<
    Record<
      AllowedTelemetryEventName,
      Readonly<Record<string, TelemetryPropertyValidator>>
    >
  >
> = {
  practice_run_started: {
    trainingSessionId,
    preset: enumProperty("beginner", "intermediate", "expert", "custom"),
    generationMode: enumProperty("classic", "no_guess"),
    width: boardDimension,
    height: boardDimension,
    mines: mineCount,
    assistMode: enumProperty("COACH", "AUTO_MARK_MINES"),
    stageDurationMs: nonNegativeNumber,
  },
  practice_hint_shown: {
    trigger: enumProperty("IDLE", "REQUEST"),
    status: enumProperty(
      "READY",
      "NO_FORCED_MOVE",
      "PARTIAL",
      "CONTRADICTION",
      "ERROR",
    ),
    action: enumProperty("REVEAL", "FLAG", "UNFLAG", "NONE"),
    stageDurationMs: nonNegativeNumber,
  },
  practice_assist_applied: {
    trigger: enumProperty("AUTO_MARK", "DEMONSTRATE"),
    action: enumProperty("REVEAL", "FLAG", "UNFLAG"),
    stageDurationMs: nonNegativeNumber,
  },
  practice_run_terminal: {
    trainingSessionId,
    preset: enumProperty("beginner", "intermediate", "expert", "custom"),
    generationMode: enumProperty("classic", "no_guess"),
    outcome: enumProperty("WON", "LOST"),
    elapsedMs: nonNegativeNumber,
    playerActions: nonNegativeInteger,
    hintsShown: nonNegativeInteger,
    hintsRequested: nonNegativeInteger,
    autoFlags: nonNegativeInteger,
    demonstratedActions: nonNegativeInteger,
    historySaved: booleanProperty,
    historyFailureReason: practiceHistoryFailureReason,
    stageDurationMs: nonNegativeNumber,
  },
  practice_no_guess_generation_finished: {
    preset: enumProperty("beginner", "intermediate", "expert", "custom"),
    success: booleanProperty,
    attempts: nonNegativeInteger,
    elapsedMs: nonNegativeNumber,
    failureReason: enumProperty(
      "ATTEMPT_LIMIT",
      "TIME_LIMIT",
      "GENERATION_ERROR",
    ),
  },
};

const FORBIDDEN_PROPERTY_PATTERN =
  /(name|nickname|invite|room.?code|token|seed|mine.?map|replay|free.?text|full.?ip|latitude|longitude|location)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseConsent(value: string | null): TelemetryConsentV1 | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      parsed.schemaVersion === 1 &&
      parsed.consentVersion === TELEMETRY_CONSENT_VERSION &&
      typeof parsed.enabled === "boolean" &&
      typeof parsed.acknowledgedAt === "string" &&
      Number.isFinite(Date.parse(parsed.acknowledgedAt))
      ? (parsed as unknown as TelemetryConsentV1)
      : null;
  } catch {
    return null;
  }
}

function parseIdentity(value: string | null): TelemetryIdentityV1 | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      parsed.schemaVersion === 1 &&
      typeof parsed.pseudonymousInstallId === "string" &&
      /^[a-f0-9]{32,128}$/.test(parsed.pseudonymousInstallId) &&
      typeof parsed.deletionToken === "string" &&
      /^[a-f0-9]{64,128}$/.test(parsed.deletionToken)
      ? (parsed as unknown as TelemetryIdentityV1)
      : null;
  } catch {
    return null;
  }
}

function parseVisitSession(value: string | null): VisitSessionV1 | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      parsed.schemaVersion === 1 &&
      typeof parsed.sessionId === "string" &&
      parsed.sessionId.length >= 8 &&
      typeof parsed.lastActivityAt === "number" &&
      Number.isFinite(parsed.lastActivityAt)
      ? (parsed as unknown as VisitSessionV1)
      : null;
  } catch {
    return null;
  }
}

function parseLegacyQueue(value: string | null): TelemetryEventV1[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(isTelemetryEventV1).slice(-MAX_QUEUE_EVENTS)
      : [];
  } catch {
    return [];
  }
}

function parseDeletionState(
  value: string | null,
): TelemetryDeletionStateV1 | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      parsed.schemaVersion === 1 &&
      typeof parsed.pseudonymousInstallId === "string" &&
      /^[a-f0-9]{32,128}$/.test(parsed.pseudonymousInstallId) &&
      typeof parsed.deletionEpoch === "number" &&
      Number.isSafeInteger(parsed.deletionEpoch) &&
      parsed.deletionEpoch >= 1 &&
      typeof parsed.deletedBefore === "string" &&
      Number.isFinite(Date.parse(parsed.deletedBefore))
      ? (parsed as unknown as TelemetryDeletionStateV1)
      : null;
  } catch {
    return null;
  }
}

function parseQueue(
  value: string | null,
): { readonly deletionEpoch: number; readonly events: TelemetryEventV1[] } {
  if (!value) return { deletionEpoch: 0, events: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.deletionEpoch !== "number" ||
      !Number.isSafeInteger(parsed.deletionEpoch) ||
      parsed.deletionEpoch < 0 ||
      !Array.isArray(parsed.events)
    ) {
      return { deletionEpoch: 0, events: [] };
    }
    return {
      deletionEpoch: parsed.deletionEpoch,
      events: parsed.events
        .filter(isTelemetryEventV1)
        .slice(-MAX_QUEUE_EVENTS),
    };
  } catch {
    return { deletionEpoch: 0, events: [] };
  }
}

function isAllowedEventName(
  value: unknown,
): value is AllowedTelemetryEventName {
  return (
    typeof value === "string" &&
    (ALLOWED_TELEMETRY_EVENT_NAMES as readonly string[]).includes(value)
  );
}

export function sanitizeTelemetryProperties(
  eventName: AllowedTelemetryEventName,
  properties: Readonly<Record<string, TelemetryProperty>>,
): Readonly<Record<string, TelemetryProperty>> | null {
  const allowed = PROPERTY_ALLOWLIST[eventName];
  const practiceValidators = PRACTICE_PROPERTY_VALIDATORS[eventName];
  const sanitized: Record<string, TelemetryProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    const practiceValidator = practiceValidators?.[key];
    if (
      !allowed.has(key) ||
      (practiceValidators &&
        (!practiceValidator || !practiceValidator(value))) ||
      FORBIDDEN_PROPERTY_PATTERN.test(key) ||
      value === undefined ||
      (typeof value === "string" && value.length > 64) ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean")
    ) {
      return null;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function isTelemetryEventV1(value: unknown): value is TelemetryEventV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== TELEMETRY_SCHEMA_VERSION ||
    typeof value.eventId !== "string" ||
    value.eventId.length < 8 ||
    typeof value.pseudonymousInstallId !== "string" ||
    typeof value.sessionId !== "string" ||
    !isAllowedEventName(value.eventName) ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    value.consentVersion !== TELEMETRY_CONSENT_VERSION ||
    typeof value.appVersion !== "string" ||
    !isRecord(value.properties)
  ) {
    return false;
  }
  return (
    sanitizeTelemetryProperties(
      value.eventName,
      value.properties as Record<string, TelemetryProperty>,
    ) !== null
  );
}

export class TelemetryClient {
  readonly #enabledByDeployment: boolean;
  readonly #appVersion: string;
  readonly #storage:
    | Pick<Storage, "getItem" | "setItem" | "removeItem">
    | undefined;
  readonly #sessionStorage:
    | Pick<Storage, "getItem" | "setItem" | "removeItem">
    | undefined;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #withExclusiveLock: <T>(
    operation: () => Promise<T>,
  ) => Promise<T>;
  #consent: TelemetryConsentV1 | null = null;
  #identity: TelemetryIdentityV1 | null = null;
  #visitSession: VisitSessionV1 | null = null;
  #queue: TelemetryEventV1[] = [];
  #queueDeletionEpoch = 0;
  #deletionState: TelemetryDeletionStateV1 | null = null;
  #error: string | null = null;
  #uploadWarning: string | null = null;
  #flushing = false;
  #telemetrySessionReady = false;
  #telemetrySessionPromise: Promise<boolean> | null = null;
  #serverPreference: boolean | null = null;
  #preferenceRevision = 0;
  #preferenceWriteQueue: Promise<void> = Promise.resolve();

  constructor(options: TelemetryClientOptions) {
    this.#enabledByDeployment = options.enabledByDeployment;
    this.#appVersion = options.appVersion;
    let storage = options.storage;
    let sessionStorage = options.sessionStorage;
    try {
      storage ??= globalThis.localStorage;
      sessionStorage ??= globalThis.sessionStorage;
    } catch {
      this.#error =
        "浏览器无法提供遥测所需的本地删除凭据；遥测保持关闭，游戏仍可使用。";
    }
    this.#storage = storage;
    this.#sessionStorage = sessionStorage;
    this.#fetch =
      options.fetch ??
      (globalThis.fetch
        ? globalThis.fetch.bind(globalThis)
        : undefined);
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
    const webLocks =
      options.storage === undefined
        ? globalThis.navigator?.locks
        : undefined;
    this.#withExclusiveLock =
      options.withExclusiveLock ??
      (webLocks
        ? async <T>(operation: () => Promise<T>) =>
            await webLocks.request(
              "hms-telemetry-identity-and-deletion",
              { mode: "exclusive" },
              operation,
            )
        : async <T>(operation: () => Promise<T>) => await operation());
    if (
      !options.withExclusiveLock &&
      !webLocks &&
      options.storage === undefined
    ) {
      this.#error =
        "浏览器不支持安全的跨标签页遥测协调；遥测保持关闭，游戏和本地历史不受影响。";
    }

    if (!this.#enabledByDeployment || this.#error) return;
    try {
      this.#consent = parseConsent(
        this.#storage?.getItem(TELEMETRY_CONSENT_STORAGE_KEY) ?? null,
      );
      const storedIdentity = this.#storage?.getItem(IDENTITY_KEY) ?? null;
      this.#identity = parseIdentity(storedIdentity);
      if (storedIdentity && !this.#identity) {
        this.#error =
          "本地遥测删除凭据损坏；已停止采集，避免产生无法由你删除的新事件。";
        return;
      }
      const storedDeletionState =
        this.#storage?.getItem(TELEMETRY_DELETION_STATE_STORAGE_KEY) ?? null;
      this.#deletionState = parseDeletionState(storedDeletionState);
      if (
        storedDeletionState &&
        (!this.#deletionState ||
          !this.#identity ||
          this.#deletionState.pseudonymousInstallId !==
            this.#identity.pseudonymousInstallId)
      ) {
        this.#error =
          "本地遥测删除同步标记损坏；已停止采集，避免重新上传已删除的数据。";
        return;
      }
      const storedQueue = parseQueue(
        this.#sessionStorage?.getItem(TAB_QUEUE_KEY) ?? null,
      );
      this.#queueDeletionEpoch = storedQueue.deletionEpoch;
      this.#queue = storedQueue.events;
      const currentDeletionEpoch = this.#deletionState?.deletionEpoch ?? 0;
      if (this.#queueDeletionEpoch < currentDeletionEpoch) {
        this.#queue = [];
        this.#queueDeletionEpoch = currentDeletionEpoch;
        this.#sessionStorage?.removeItem(TAB_QUEUE_KEY);
      } else if (this.#queueDeletionEpoch > currentDeletionEpoch) {
        this.#error =
          "本地遥测队列版本异常；已停止采集，避免重新上传已删除的数据。";
        this.#queue = [];
        return;
      } else if (this.#queue.length === 0) {
        const legacy = parseLegacyQueue(
          this.#storage?.getItem(LEGACY_QUEUE_KEY) ?? null,
        );
        this.#storage?.removeItem(LEGACY_QUEUE_KEY);
        if (currentDeletionEpoch === 0 && legacy.length > 0) {
          this.#queue = legacy;
          this.persistQueue();
        }
      }
      const oldestQueueEventAt =
        this.#now() - TELEMETRY_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
      const newestQueueEventAt = this.#now() + 5 * 60 * 1_000;
      const compatibleQueue = this.#queue.filter((event) => {
        const occurredAt = Date.parse(event.occurredAt);
        return (
          event.appVersion === this.#appVersion &&
          event.consentVersion === TELEMETRY_CONSENT_VERSION &&
          occurredAt >= oldestQueueEventAt &&
          occurredAt <= newestQueueEventAt
        );
      });
      if (compatibleQueue.length !== this.#queue.length) {
        this.#queue = compatibleQueue;
        this.#uploadWarning =
          "已丢弃与当前版本、同意契约或保留期不兼容的旧遥测队列。";
        this.persistQueue();
      }
      this.#visitSession = parseVisitSession(
        this.#sessionStorage?.getItem(VISIT_SESSION_KEY) ?? null,
      );
      if (this.#consent?.enabled !== true) {
        this.clearOwnedQueue();
      }
    } catch {
      this.#error =
        "浏览器无法提供遥测所需的本地删除凭据；遥测保持关闭，游戏仍可使用。";
    }
  }

  snapshot(): TelemetrySettingsSnapshot {
    return {
      available: this.#enabledByDeployment && this.#error === null,
      acknowledged: this.#consent !== null,
      enabled:
        this.#enabledByDeployment &&
        this.#error === null &&
        this.#consent?.enabled === true,
      hasDeletionCredential: this.#identity !== null,
      queuedEvents: this.#queue.length,
      error: this.#error ?? this.#uploadWarning,
    };
  }

  acknowledge(enabled: boolean): TelemetrySettingsSnapshot {
    if (!this.#enabledByDeployment || this.#error) return this.snapshot();
    this.refreshPersistedConsent();
    if (this.#error) return this.snapshot();
    const persistedDecisionAt =
      this.#consent === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(this.#consent.acknowledgedAt);
    const decisionAt = Math.max(
      this.#now(),
      Number.isFinite(persistedDecisionAt)
        ? persistedDecisionAt + 1
        : Number.NEGATIVE_INFINITY,
    );
    const next: TelemetryConsentV1 = {
      schemaVersion: 1,
      consentVersion: TELEMETRY_CONSENT_VERSION,
      enabled,
      acknowledgedAt: new Date(decisionAt).toISOString(),
    };
    this.#preferenceRevision += 1;
    this.#serverPreference = null;
    try {
      this.#storage?.setItem(
        TELEMETRY_CONSENT_STORAGE_KEY,
        JSON.stringify(next),
      );
      this.#consent = next;
      if (!enabled) {
        this.clearOwnedQueue();
      }
    } catch {
      this.#error =
        "无法保存遥测选择；遥测保持关闭，游戏和本地历史不受影响。";
      this.#consent = null;
      this.#queue = [];
    }
    return this.snapshot();
  }

  synchronizeConsentFromStorage(): TelemetrySettingsSnapshot {
    this.refreshPersistedConsent();
    return this.snapshot();
  }

  async recordPreference(enabled: boolean): Promise<boolean> {
    if (!this.#enabledByDeployment || !this.#fetch) return false;
    this.refreshPersistedConsent();
    if (this.#error) return false;
    const revision = this.#preferenceRevision;
    const preferenceChangedAt = this.#consent?.acknowledgedAt;
    if (!preferenceChangedAt) return false;
    const write = this.#preferenceWriteQueue.then(async () => {
      this.refreshPersistedConsent();
      if (
        this.#error ||
        revision !== this.#preferenceRevision ||
        this.#consent?.enabled !== enabled
      ) {
        return false;
      }
      if (this.#serverPreference === enabled) return true;

      try {
        const send = async (): Promise<Response | null> => {
          if (!(await this.ensureTelemetrySession())) return null;
          this.refreshPersistedConsent();
          if (
            this.#error ||
            revision !== this.#preferenceRevision ||
            this.#consent?.enabled !== enabled
          ) {
            return null;
          }
          return await this.#fetch!("/api/v1/telemetry/preference", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              enabled,
              consentVersion: TELEMETRY_CONSENT_VERSION,
              appVersion: this.#appVersion,
              preferenceChangedAt,
            }),
          });
        };
        let response = await send();
        if (response?.status === 401) {
          this.#telemetrySessionReady = false;
          response = await send();
        }
        if (!response?.ok) return false;
        const result = (await response.json()) as {
          accepted?: unknown;
          applied?: unknown;
        };
        const accepted = result.accepted === true;
        const applied = result.applied === true;
        this.refreshPersistedConsent();
        const stillCurrent =
          !this.#error &&
          revision === this.#preferenceRevision &&
          this.#consent?.enabled === enabled;
        if (accepted && applied && stillCurrent) {
          this.#serverPreference = enabled;
        }
        return accepted && applied && stillCurrent;
      } catch {
        return false;
      }
    });
    this.#preferenceWriteQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return await write;
  }

  track(
    eventName: AllowedTelemetryEventName,
    properties: Readonly<Record<string, TelemetryProperty>> = {},
  ): boolean {
    this.refreshPersistedConsent();
    this.refreshPersistedIdentity();
    this.refreshPersistedDeletionState();
    if (!this.snapshot().enabled) return false;
    const sanitized = sanitizeTelemetryProperties(eventName, properties);
    if (!sanitized) return false;
    try {
      const session = this.ensureVisitSession();
      const event: TelemetryEventV1 = {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventId: this.#randomUUID(),
        pseudonymousInstallId:
          this.#identity?.pseudonymousInstallId ?? PENDING_INSTALL_ID,
        sessionId: session.sessionId,
        eventName,
        occurredAt: new Date(this.#now()).toISOString(),
        consentVersion: TELEMETRY_CONSENT_VERSION,
        appVersion: this.#appVersion,
        properties: sanitized,
      };
      this.#queue.push(event);
      this.trimQueue();
      this.persistQueue();
      return true;
    } catch {
      this.#error =
        "遥测队列无法安全保存；已停止新事件，游戏和本地历史不受影响。";
      return false;
    }
  }

  async flush(keepalive = false): Promise<boolean> {
    return await this.#withExclusiveLock(
      async () => await this.flushExclusive(keepalive),
    );
  }

  private async flushExclusive(keepalive: boolean): Promise<boolean> {
    this.refreshPersistedConsent();
    this.refreshPersistedIdentity();
    this.refreshPersistedDeletionState();
    if (
      !this.snapshot().enabled ||
      this.#flushing ||
      this.#queue.length === 0 ||
      !this.#fetch
    ) {
      return false;
    }
    if (
      this.#serverPreference !== true &&
      !(await this.recordPreference(true))
    ) {
      return false;
    }
    let identity: TelemetryIdentityV1;
    try {
      identity = this.ensureIdentity();
    } catch {
      return false;
    }
    if (
      this.#queue.some(
        (event) =>
          event.pseudonymousInstallId !== identity.pseudonymousInstallId,
      )
    ) {
      this.#queue = this.#queue.map((event) => ({
        ...event,
        pseudonymousInstallId: identity.pseudonymousInstallId,
      }));
      this.persistQueue();
    }
    const events: TelemetryEventV1[] = [];
    const first = this.#queue[0];
    if (!first) return false;
    for (const event of this.#queue) {
      if (
        events.length >= MAX_BATCH_EVENTS ||
        event.pseudonymousInstallId !== first.pseudonymousInstallId ||
        event.sessionId !== first.sessionId ||
        event.consentVersion !== first.consentVersion ||
        event.appVersion !== first.appVersion
      ) {
        continue;
      }
      const candidate = [...events, event];
      const body = JSON.stringify({
        deletionToken: identity.deletionToken,
        deletionEpoch: this.#queueDeletionEpoch,
        events: candidate,
      });
      if (byteLength(body) > MAX_BATCH_BYTES) break;
      events.push(event);
    }
    if (events.length === 0) return false;

    this.#flushing = true;
    try {
      const response = await this.#fetch("/api/v1/telemetry/batch", {
        method: "POST",
        credentials: "same-origin",
        keepalive,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deletionToken: identity.deletionToken,
          deletionEpoch: this.#queueDeletionEpoch,
          events,
        }),
      });
      if (!response.ok) {
        if (response.status === 401) this.#telemetrySessionReady = false;
        if (response.status === 401 || response.status === 403) {
          this.#serverPreference = null;
        }
        return false;
      }
      let acknowledgement: unknown;
      try {
        acknowledgement = await response.json();
      } catch {
        acknowledgement = null;
      }
      const validAcknowledgement =
        isRecord(acknowledgement) &&
        typeof acknowledgement.accepted === "number" &&
        Number.isSafeInteger(acknowledgement.accepted) &&
        acknowledgement.accepted >= 0 &&
        typeof acknowledgement.duplicates === "number" &&
        Number.isSafeInteger(acknowledgement.duplicates) &&
        acknowledgement.duplicates >= 0 &&
        (acknowledgement.discarded === undefined ||
          (typeof acknowledgement.discarded === "number" &&
            Number.isSafeInteger(acknowledgement.discarded) &&
            acknowledgement.discarded >= 0)) &&
        (acknowledgement.deletionEpoch === undefined ||
          (typeof acknowledgement.deletionEpoch === "number" &&
            Number.isSafeInteger(acknowledgement.deletionEpoch) &&
            acknowledgement.deletionEpoch >= this.#queueDeletionEpoch)) &&
        (acknowledgement.deletedBefore === undefined ||
          (typeof acknowledgement.deletedBefore === "string" &&
            Number.isFinite(Date.parse(acknowledgement.deletedBefore)))) &&
        (typeof acknowledgement.deletionEpoch !== "number" ||
          acknowledgement.deletionEpoch === this.#queueDeletionEpoch ||
          (typeof acknowledgement.deletedBefore === "string" &&
            typeof acknowledgement.discarded === "number" &&
            acknowledgement.discarded ===
              events.filter(
                (event) =>
                  Date.parse(event.occurredAt) <=
                  Date.parse(String(acknowledgement.deletedBefore)),
              ).length)) &&
        acknowledgement.accepted +
          acknowledgement.duplicates +
          (typeof acknowledgement.discarded === "number"
            ? acknowledgement.discarded
            : 0) ===
          events.length &&
        (acknowledgement.discarded === undefined ||
          acknowledgement.discarded === 0 ||
          (typeof acknowledgement.deletionEpoch === "number" &&
            acknowledgement.deletionEpoch >= this.#queueDeletionEpoch &&
            typeof acknowledgement.deletedBefore === "string"));
      if (!validAcknowledgement) {
        this.#uploadWarning =
          "服务端遥测确认不完整；待发送事件已保留，游戏和本地历史不受影响。";
        return false;
      }
      if (!isRecord(acknowledgement)) return false;
      this.#uploadWarning = null;
      const acknowledgedDeletionEpoch =
        typeof acknowledgement.deletionEpoch === "number"
          ? acknowledgement.deletionEpoch
          : this.#queueDeletionEpoch;
      if (acknowledgedDeletionEpoch > this.#queueDeletionEpoch) {
        this.applyDeletionState({
          schemaVersion: 1,
          pseudonymousInstallId: identity.pseudonymousInstallId,
          deletionEpoch: acknowledgedDeletionEpoch,
          deletedBefore: String(acknowledgement.deletedBefore),
        });
      }
      const sentIds = new Set(events.map((event) => event.eventId));
      this.#queue = this.#queue.filter((event) => !sentIds.has(event.eventId));
      this.persistQueue();
      return true;
    } catch {
      return false;
    } finally {
      this.#flushing = false;
    }
  }

  async deleteRemoteRawTelemetry(): Promise<TelemetryDeleteResult> {
    return await this.#withExclusiveLock(
      async () => await this.deleteRemoteRawTelemetryExclusive(),
    );
  }

  private async deleteRemoteRawTelemetryExclusive(): Promise<TelemetryDeleteResult> {
    this.refreshPersistedIdentity();
    const identity = this.#identity ?? this.ensureIdentity();
    if (!identity || !this.#fetch) {
      throw new Error("当前设备还没有可删除的服务端原始遥测。");
    }
    const send = async (): Promise<Response | null> => {
      if (!(await this.ensureTelemetrySession())) return null;
      return await this.#fetch!("/api/v1/telemetry/delete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pseudonymousInstallId: identity.pseudonymousInstallId,
          deletionToken: identity.deletionToken,
        }),
      });
    };
    let response = await send();
    if (response?.status === 401) {
      this.#telemetrySessionReady = false;
      if (await this.ensureTelemetrySession(true)) {
        response = await this.#fetch("/api/v1/telemetry/delete", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pseudonymousInstallId: identity.pseudonymousInstallId,
            deletionToken: identity.deletionToken,
          }),
        });
      }
    }
    if (!response) {
      throw new Error("服务端原始遥测删除请求失败，请稍后重试。");
    }
    if (!response.ok) {
      throw new Error("服务端原始遥测删除请求失败，请稍后重试。");
    }
    const result: unknown = await response.json();
    if (
      !isRecord(result) ||
      result.accepted !== true ||
      typeof result.deletionEpoch !== "number" ||
      !Number.isSafeInteger(result.deletionEpoch) ||
      result.deletionEpoch < 1 ||
      typeof result.deletedBefore !== "string" ||
      !Number.isFinite(Date.parse(result.deletedBefore))
    ) {
      throw new Error("服务端未确认删除请求，请稍后重试。");
    }
    const deletionState: TelemetryDeletionStateV1 = {
      schemaVersion: 1,
      pseudonymousInstallId: identity.pseudonymousInstallId,
      deletionEpoch: result.deletionEpoch,
      deletedBefore: result.deletedBefore,
    };
    const applied = this.applyDeletionState(deletionState);
    return {
      accepted: true,
      deletionEpoch: applied.deletionEpoch,
      deletedBefore: applied.deletedBefore,
    };
  }

  private async ensureTelemetrySession(force = false): Promise<boolean> {
    if (!this.#enabledByDeployment || !this.#fetch) return false;
    if (force) this.#telemetrySessionReady = false;
    if (this.#telemetrySessionReady) return true;
    if (this.#telemetrySessionPromise) {
      return await this.#telemetrySessionPromise;
    }

    const request = (async () => {
      try {
        const response = await this.#fetch!("/api/v1/telemetry/session", {
          method: "POST",
          credentials: "same-origin",
        });
        if (!response.ok) return false;
        const body = (await response.json()) as Partial<PublicTelemetrySessionV1>;
        const valid =
          typeof body.sessionId === "string" &&
          body.sessionId.length >= 8 &&
          typeof body.expiresAt === "number" &&
          Number.isSafeInteger(body.expiresAt) &&
          body.expiresAt > this.#now() &&
          body.batchId === "public" &&
          body.cohortSegment === "unsegmented";
        this.#telemetrySessionReady = valid;
        return valid;
      } catch {
        return false;
      }
    })();
    this.#telemetrySessionPromise = request;
    try {
      return await request;
    } finally {
      if (this.#telemetrySessionPromise === request) {
        this.#telemetrySessionPromise = null;
      }
    }
  }

  private refreshPersistedConsent(): void {
    if (!this.#enabledByDeployment || this.#error) return;
    try {
      const stored =
        this.#storage?.getItem(TELEMETRY_CONSENT_STORAGE_KEY) ?? null;
      const next = parseConsent(stored);
      if (stored !== null && !next) {
        this.#preferenceRevision += 1;
        this.#serverPreference = null;
        this.#consent = null;
        this.clearOwnedQueue();
        this.#error =
          "本地遥测选择已损坏；已停止采集并清除待发送事件。游戏和本地历史不受影响。";
        return;
      }
      const unchanged =
        (next === null && this.#consent === null) ||
        (next !== null &&
          this.#consent !== null &&
          next.enabled === this.#consent.enabled &&
          next.consentVersion === this.#consent.consentVersion &&
          next.acknowledgedAt === this.#consent.acknowledgedAt);
      if (unchanged) return;

      this.#preferenceRevision += 1;
      this.#serverPreference = null;
      this.#consent = next;
      if (next?.enabled !== true) {
        this.clearOwnedQueue();
      }
    } catch {
      this.#preferenceRevision += 1;
      this.#serverPreference = null;
      this.#consent = null;
      this.clearOwnedQueue();
      this.#error =
        "无法同步遥测选择；已停止采集并清除待发送事件。游戏和本地历史不受影响。";
    }
  }

  private refreshPersistedDeletionState(): void {
    if (!this.#enabledByDeployment || this.#error) return;
    try {
      const stored =
        this.#storage?.getItem(TELEMETRY_DELETION_STATE_STORAGE_KEY) ?? null;
      const next = parseDeletionState(stored);
      if (stored !== null && !next) {
        this.clearOwnedQueue();
        this.#error =
          "本地遥测删除同步标记损坏；已停止采集，避免重新上传已删除的数据。";
        return;
      }
      if (!next) return;
      if (
        this.#identity &&
        next.pseudonymousInstallId !== this.#identity.pseudonymousInstallId
      ) {
        this.clearOwnedQueue();
        this.#error =
          "本地遥测删除同步标记与删除凭据不一致；已停止采集。";
        return;
      }
      if (
        this.#deletionState &&
        (next.deletionEpoch < this.#deletionState.deletionEpoch ||
          (next.deletionEpoch === this.#deletionState.deletionEpoch &&
            Date.parse(next.deletedBefore) <
              Date.parse(this.#deletionState.deletedBefore)))
      ) {
        this.clearOwnedQueue();
        this.#error =
          "本地遥测删除同步标记发生回退；已停止采集，避免重新上传已删除的数据。";
        return;
      }
      if (
        !this.#deletionState ||
        next.deletionEpoch > this.#deletionState.deletionEpoch ||
        Date.parse(next.deletedBefore) >
          Date.parse(this.#deletionState.deletedBefore)
      ) {
        this.#deletionState = next;
        this.advanceOwnedQueueDeletionBoundary(next);
      }
    } catch {
      this.clearOwnedQueue();
      this.#error =
        "无法同步遥测删除状态；已停止采集，避免重新上传已删除的数据。";
    }
  }

  private applyDeletionState(
    next: TelemetryDeletionStateV1,
  ): TelemetryDeletionStateV1 {
    try {
      const storedRaw =
        this.#storage?.getItem(TELEMETRY_DELETION_STATE_STORAGE_KEY) ?? null;
      const stored = parseDeletionState(storedRaw);
      if (storedRaw && !stored) {
        throw new Error("Invalid persisted telemetry deletion state");
      }
      const candidates = [this.#deletionState, stored, next].filter(
        (candidate): candidate is TelemetryDeletionStateV1 =>
          candidate !== null,
      );
      if (
        candidates.some(
          (candidate) =>
            candidate.pseudonymousInstallId !== next.pseudonymousInstallId,
        )
      ) {
        throw new Error("Telemetry deletion identity mismatch");
      }
      const effective = candidates.reduce((latest, candidate) => {
        if (candidate.deletionEpoch !== latest.deletionEpoch) {
          return candidate.deletionEpoch > latest.deletionEpoch
            ? candidate
            : latest;
        }
        return Date.parse(candidate.deletedBefore) >
          Date.parse(latest.deletedBefore)
          ? candidate
          : latest;
      }, next);
      this.#deletionState = effective;
      this.advanceOwnedQueueDeletionBoundary(effective);
      if (
        !stored ||
        stored.deletionEpoch !== effective.deletionEpoch ||
        stored.deletedBefore !== effective.deletedBefore
      ) {
        this.#storage?.setItem(
          TELEMETRY_DELETION_STATE_STORAGE_KEY,
          JSON.stringify(effective),
        );
      }
      return effective;
    } catch {
      this.clearOwnedQueue();
      this.#error =
        "服务端数据已删除，但本地删除同步标记无法保存；已停止遥测，游戏和本地历史不受影响。";
      return next;
    }
  }

  private refreshPersistedIdentity(): void {
    if (!this.#enabledByDeployment || this.#error) return;
    try {
      const storedRaw = this.#storage?.getItem(IDENTITY_KEY) ?? null;
      const stored = parseIdentity(storedRaw);
      if (storedRaw && !stored) {
        this.clearOwnedQueue();
        this.#error =
          "本地遥测删除凭据损坏；已停止采集，避免产生无法删除的新事件。";
        return;
      }
      if (!stored) {
        if (this.#identity) {
          this.clearOwnedQueue();
          this.#error =
            "本地遥测删除凭据已被移除；已停止采集，避免产生无法删除的新事件。";
        }
        return;
      }
      if (
        this.#deletionState &&
        this.#deletionState.pseudonymousInstallId !==
          stored.pseudonymousInstallId
      ) {
        this.clearOwnedQueue();
        this.#error =
          "本地遥测删除状态与删除凭据不一致；已停止采集。";
        return;
      }
      this.#identity = stored;
    } catch {
      this.clearOwnedQueue();
      this.#error =
        "无法同步本地遥测删除凭据；已停止采集，游戏和本地历史不受影响。";
    }
  }

  private ensureIdentity(): TelemetryIdentityV1 {
    this.refreshPersistedIdentity();
    if (this.#identity) return this.#identity;
    if (this.#error) throw new Error("Telemetry identity is unavailable");
    const created: TelemetryIdentityV1 = {
      schemaVersion: 1,
      pseudonymousInstallId: randomHex(16),
      deletionToken: randomHex(32),
    };
    this.#storage?.setItem(IDENTITY_KEY, JSON.stringify(created));
    const persisted = parseIdentity(
      this.#storage?.getItem(IDENTITY_KEY) ?? null,
    );
    this.#identity = persisted ?? created;
    return this.#identity;
  }

  private ensureVisitSession(): VisitSessionV1 {
    const now = this.#now();
    if (
      !this.#visitSession ||
      now - this.#visitSession.lastActivityAt > VISIT_IDLE_MS
    ) {
      this.#visitSession = {
        schemaVersion: 1,
        sessionId: this.#randomUUID(),
        lastActivityAt: now,
      };
    } else {
      this.#visitSession = { ...this.#visitSession, lastActivityAt: now };
    }
    this.#sessionStorage?.setItem(
      VISIT_SESSION_KEY,
      JSON.stringify(this.#visitSession),
    );
    return this.#visitSession;
  }

  private trimQueue(): void {
    while (
      this.#queue.length > MAX_QUEUE_EVENTS ||
      byteLength(
        JSON.stringify({
          schemaVersion: 1,
          deletionEpoch: this.#queueDeletionEpoch,
          events: this.#queue,
        } satisfies TelemetryQueueV1),
      ) > MAX_QUEUE_BYTES
    ) {
      this.#queue.shift();
    }
  }

  private clearOwnedQueue(
    deletionEpoch = this.#deletionState?.deletionEpoch ??
      this.#queueDeletionEpoch,
  ): void {
    this.#queue = [];
    this.#queueDeletionEpoch = deletionEpoch;
    this.#sessionStorage?.removeItem(TAB_QUEUE_KEY);
    this.#storage?.removeItem(LEGACY_QUEUE_KEY);
  }

  private advanceOwnedQueueDeletionBoundary(
    state: TelemetryDeletionStateV1,
  ): void {
    const deletedBefore = Date.parse(state.deletedBefore);
    this.#queue = this.#queue.filter(
      (event) => Date.parse(event.occurredAt) > deletedBefore,
    );
    this.#queueDeletionEpoch = state.deletionEpoch;
    this.persistQueue();
  }

  private persistQueue(): void {
    if (this.#queue.length === 0) {
      this.#sessionStorage?.removeItem(TAB_QUEUE_KEY);
      return;
    }
    this.#sessionStorage?.setItem(
      TAB_QUEUE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        deletionEpoch: this.#queueDeletionEpoch,
        events: this.#queue,
      } satisfies TelemetryQueueV1),
    );
  }
}

export function detectDeviceClass(
  width = globalThis.innerWidth,
  coarsePointer = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
): "desktop" | "mobile" | "tablet" {
  if (coarsePointer && width < 600) return "mobile";
  if (coarsePointer || width < 1_000) return "tablet";
  return "desktop";
}

export function detectBrowserFamily(
  userAgent = globalThis.navigator?.userAgent ?? "",
): "chrome" | "firefox" | "safari" | "other" {
  if (/Firefox\//i.test(userAgent)) return "firefox";
  if (/Chrome\//i.test(userAgent) && !/(Edg|OPR)\//i.test(userAgent)) {
    return "chrome";
  }
  if (/Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent)) {
    return "safari";
  }
  return "other";
}
