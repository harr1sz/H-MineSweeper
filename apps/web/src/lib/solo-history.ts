import {
  getSoloConfigError,
  SOLO_PRESETS,
  type SoloBoardConfig,
  type SoloGenerationMode,
  type SoloPreset,
} from "./solo";

export const SOLO_RUN_SCHEMA_VERSION = 1 as const;
export const SOLO_HISTORY_EXPORT_SCHEMA_VERSION = 1 as const;
export const SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION = 1 as const;
export const SOLO_METRIC_RULES_VERSION = 1 as const;
export const SOLO_GAME_RULES_VERSION = 1 as const;
export const SOLO_HISTORY_MAX_RECORDS = 10_000;
export const SOLO_HISTORY_WARNING_RECORDS = 9_500;
export const SOLO_TRAINING_SESSION_IDLE_MS = 30 * 60 * 1_000;
export const SOLO_LEGACY_PERSONAL_BEST_PREFIX = "hms-solo-best-v1";

const DATABASE_NAME = "h-minesweeper-solo-history-v1";
const DATABASE_VERSION = 2;
const RUN_STORE_NAME = "solo-runs-v1";
const LEGACY_PERSONAL_BEST_STORE_NAME = "legacy-personal-bests-v1";

export type SoloRunOutcome = "WON" | "LOST";

export interface SoloRunRecordV1 {
  readonly schemaVersion: typeof SOLO_RUN_SCHEMA_VERSION;
  readonly recordId: string;
  readonly trainingSessionId: string;
  readonly completedAt: string;
  readonly outcome: SoloRunOutcome;
  readonly config: {
    readonly preset: SoloPreset;
    readonly width: number;
    readonly height: number;
    readonly mines: number;
    readonly generationMode: SoloGenerationMode;
  };
  readonly board: {
    readonly seed: string;
    readonly boardHash: string;
    readonly trustStatus: "LOCAL_UNVERIFIED";
  };
  readonly rules: {
    readonly metricRulesVersion: number;
    readonly gameRulesVersion: number;
  };
  readonly metrics: {
    readonly elapsedMs: number;
    readonly board3BV: number | null;
    readonly cps: number | null;
    readonly threeBvPerSecond: number | null;
    readonly ioe: number | null;
    readonly physicalClicks: number;
    readonly semanticActions: number;
    readonly acceptedActions: number;
    readonly wastedActions: number;
    readonly reveals: number;
    readonly flags: number;
    readonly unflags: number;
    readonly chords: number;
  };
}

export interface SoloHistoryExportV1 {
  readonly format: "h-minesweeper-solo-history";
  readonly schemaVersion: typeof SOLO_HISTORY_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly recordCount: number;
  readonly records: readonly SoloRunRecordV1[];
}

export interface SoloHistoryRecoveryExportV1 {
  readonly format: "h-minesweeper-solo-history-recovery";
  readonly schemaVersion: typeof SOLO_HISTORY_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly recordCount: number;
  readonly records: readonly unknown[];
}

export interface SoloLegacyPersonalBestMetadataV1 {
  readonly schemaVersion: typeof SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION;
  readonly kind: "LEGACY_PERSONAL_BEST";
  readonly metadataId: string;
  readonly migratedAt: string;
  readonly source: {
    readonly storage: "localStorage";
    readonly key: string;
    readonly rawValue: string;
  };
  readonly config: {
    readonly width: number;
    readonly height: number;
    readonly mines: number;
    readonly generationMode: SoloGenerationMode;
  };
  readonly best: {
    readonly elapsedMs: number;
    readonly completedAt: string | null;
    readonly metricRulesVersion: string | null;
    readonly gameRulesVersion: number | null;
    readonly trustStatus: "LOCAL_UNVERIFIED";
  };
}

export interface SoloLegacyPersonalBestInvalidSource {
  readonly sourceKey: string;
  readonly rawValue: string | null;
  readonly issues: readonly string[];
}

export interface SoloLegacyPersonalBestMigrationResult {
  readonly metadata: readonly SoloLegacyPersonalBestMetadataV1[];
  readonly rawMetadata: readonly unknown[];
  readonly invalidMetadataCount: number;
  readonly migrated: number;
  readonly skippedExisting: number;
  readonly invalidSources: readonly SoloLegacyPersonalBestInvalidSource[];
}

export interface SoloLegacyPersonalBestRecoveryExportV1 {
  readonly format: "h-minesweeper-solo-legacy-personal-best-recovery";
  readonly schemaVersion: typeof SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly invalidSourceCount: number;
  readonly invalidMetadataCount: number;
  readonly invalidSources: readonly SoloLegacyPersonalBestInvalidSource[];
  readonly rawMetadata: readonly unknown[];
}

export interface SoloLegacyPersonalBestSourceStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface SoloHistoryCapacity {
  readonly recordCount: number;
  readonly warning: boolean;
  readonly full: boolean;
}

export interface SoloHistoryReadResult extends SoloHistoryCapacity {
  readonly records: readonly SoloRunRecordV1[];
  readonly rawRecords: readonly unknown[];
  readonly invalidRecordCount: number;
}

export interface SoloHistoryImportResult extends SoloHistoryCapacity {
  readonly imported: number;
  readonly skippedIdentical: number;
}

export interface SoloHistoryStore {
  read(): Promise<SoloHistoryReadResult>;
  put(record: SoloRunRecordV1): Promise<SoloHistoryCapacity>;
  importRecords(records: readonly unknown[]): Promise<SoloHistoryImportResult>;
  migrateLegacyPersonalBests(
    storage?: SoloLegacyPersonalBestSourceStorage,
    now?: Date,
  ): Promise<SoloLegacyPersonalBestMigrationResult>;
  clear(): Promise<void>;
}

export interface SoloTrendSummary {
  readonly runCount: number;
  readonly winCount: number;
  readonly latestElapsedMs: number | null;
  readonly bestElapsedMs: number | null;
  readonly averageElapsedMs: number | null;
  readonly latestThreeBvPerSecond: number | null;
  readonly bestThreeBvPerSecond: number | null;
  readonly latestIoe: number | null;
  readonly bestIoe: number | null;
}

export class SoloHistoryStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SoloHistoryStorageError";
  }
}

export class SoloHistoryCapacityError extends SoloHistoryStorageError {
  constructor(message = "本地历史已达到 10,000 条上限；未删除旧数据，本局也未写入历史。") {
    super(message);
    this.name = "SoloHistoryCapacityError";
  }
}

export class SoloHistoryValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`历史文件校验失败：${issues.join("；")}`);
    this.name = "SoloHistoryValidationError";
    this.issues = issues;
  }
}

export class SoloHistoryConflictError extends SoloHistoryStorageError {
  constructor(recordId: string) {
    super(`记录 ${recordId} 与本地同 ID 记录内容冲突；整批导入已取消。`);
    this.name = "SoloHistoryConflictError";
  }
}

function capacity(recordCount: number): SoloHistoryCapacity {
  return {
    recordCount,
    warning: recordCount >= SOLO_HISTORY_WARNING_RECORDS,
    full: recordCount >= SOLO_HISTORY_MAX_RECORDS,
  };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isMode(value: unknown): value is SoloGenerationMode {
  return value === "classic" || value === "no_guess";
}

function isPreset(value: unknown): value is SoloPreset {
  return (
    value === "beginner" ||
    value === "intermediate" ||
    value === "expert" ||
    value === "custom"
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function reportUnexpectedKeys(
  value: object,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${path}.${key} 是未知字段`);
  }
}

function legacyPersonalBestMetadataId(sourceKey: string): string {
  return `legacy-personal-best-v1:${sourceKey}`;
}

function parseLegacyPersonalBestSourceKey(
  sourceKey: string,
): SoloBoardConfig | null {
  const match =
    /^hms-solo-best-v1:(\d+)x(\d+):(\d+):(classic|no_guess)$/.exec(
      sourceKey,
    );
  if (!match) return null;
  const config: SoloBoardConfig = {
    width: Number(match[1]),
    height: Number(match[2]),
    mines: Number(match[3]),
    mode: match[4] as SoloGenerationMode,
  };
  return getSoloConfigError(config) === undefined ? config : null;
}

export function validateSoloLegacyPersonalBestMetadataV1(
  value: unknown,
  path = "legacyPersonalBest",
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} 必须是对象`];
  }
  const metadata = value as Partial<SoloLegacyPersonalBestMetadataV1>;
  const source = metadata.source as
    | Partial<SoloLegacyPersonalBestMetadataV1["source"]>
    | undefined;
  const config = metadata.config as
    | Partial<SoloLegacyPersonalBestMetadataV1["config"]>
    | undefined;
  const best = metadata.best as
    | Partial<SoloLegacyPersonalBestMetadataV1["best"]>
    | undefined;
  const issues: string[] = [];
  reportUnexpectedKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "metadataId",
      "migratedAt",
      "source",
      "config",
      "best",
    ],
    path,
    issues,
  );
  if (metadata.schemaVersion !== SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION) {
    issues.push(
      `${path}.schemaVersion 必须为 ${SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION}`,
    );
  }
  if (metadata.kind !== "LEGACY_PERSONAL_BEST") {
    issues.push(`${path}.kind 必须是 LEGACY_PERSONAL_BEST`);
  }
  if (typeof metadata.metadataId !== "string" || metadata.metadataId.length < 1) {
    issues.push(`${path}.metadataId 缺失`);
  }
  if (!isIsoDate(metadata.migratedAt)) {
    issues.push(`${path}.migratedAt 必须是规范 ISO 时间`);
  }

  let sourceConfig: SoloBoardConfig | null = null;
  if (!source) {
    issues.push(`${path}.source 缺失`);
  } else {
    reportUnexpectedKeys(
      source,
      ["storage", "key", "rawValue"],
      `${path}.source`,
      issues,
    );
    if (source.storage !== "localStorage") {
      issues.push(`${path}.source.storage 无效`);
    }
    if (typeof source.key !== "string") {
      issues.push(`${path}.source.key 缺失`);
    } else {
      sourceConfig = parseLegacyPersonalBestSourceKey(source.key);
      if (!sourceConfig) {
        issues.push(`${path}.source.key 不是有效的旧版 PB key`);
      }
      if (
        metadata.metadataId !== legacyPersonalBestMetadataId(source.key)
      ) {
        issues.push(`${path}.metadataId 与 source.key 不一致`);
      }
    }
    if (typeof source.rawValue !== "string") {
      issues.push(`${path}.source.rawValue 缺失`);
    }
  }

  if (!config) {
    issues.push(`${path}.config 缺失`);
  } else {
    reportUnexpectedKeys(
      config,
      ["width", "height", "mines", "generationMode"],
      `${path}.config`,
      issues,
    );
    const normalized: SoloBoardConfig | null =
      positiveSafeInteger(config.width) &&
        positiveSafeInteger(config.height) &&
        positiveSafeInteger(config.mines) &&
        isMode(config.generationMode)
        ? {
            width: config.width,
            height: config.height,
            mines: config.mines,
            mode: config.generationMode,
          }
        : null;
    if (!normalized || getSoloConfigError(normalized) !== undefined) {
      issues.push(`${path}.config 无效`);
    } else if (
      sourceConfig &&
      (normalized.width !== sourceConfig.width ||
        normalized.height !== sourceConfig.height ||
        normalized.mines !== sourceConfig.mines ||
        normalized.mode !== sourceConfig.mode)
    ) {
      issues.push(`${path}.config 与 source.key 不一致`);
    }
  }

  if (!best) {
    issues.push(`${path}.best 缺失`);
  } else {
    reportUnexpectedKeys(
      best,
      [
        "elapsedMs",
        "completedAt",
        "metricRulesVersion",
        "gameRulesVersion",
        "trustStatus",
      ],
      `${path}.best`,
      issues,
    );
    if (
      typeof best.elapsedMs !== "number" ||
      !Number.isFinite(best.elapsedMs) ||
      best.elapsedMs <= 0
    ) {
      issues.push(`${path}.best.elapsedMs 无效`);
    }
    if (best.completedAt !== null && !isIsoDate(best.completedAt)) {
      issues.push(`${path}.best.completedAt 无效`);
    }
    if (
      best.metricRulesVersion !== null &&
      (typeof best.metricRulesVersion !== "string" ||
        best.metricRulesVersion.length < 1)
    ) {
      issues.push(`${path}.best.metricRulesVersion 无效`);
    }
    if (
      best.gameRulesVersion !== null &&
      (!Number.isSafeInteger(best.gameRulesVersion) ||
        Number(best.gameRulesVersion) < 1)
    ) {
      issues.push(`${path}.best.gameRulesVersion 无效`);
    }
    if (best.trustStatus !== "LOCAL_UNVERIFIED") {
      issues.push(`${path}.best.trustStatus 无效`);
    }
  }
  return issues;
}

export function isSoloLegacyPersonalBestMetadataV1(
  value: unknown,
): value is SoloLegacyPersonalBestMetadataV1 {
  return validateSoloLegacyPersonalBestMetadataV1(value).length === 0;
}

interface PreparedLegacyPersonalBestMigration {
  readonly metadata: readonly SoloLegacyPersonalBestMetadataV1[];
  readonly invalidSources: readonly SoloLegacyPersonalBestInvalidSource[];
}

function prepareLegacyPersonalBestMigration(
  storage: SoloLegacyPersonalBestSourceStorage | undefined,
  migratedAt: Date,
): PreparedLegacyPersonalBestMigration {
  if (!storage) return { metadata: [], invalidSources: [] };
  const keys = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${SOLO_LEGACY_PERSONAL_BEST_PREFIX}:`)) {
      keys.add(key);
    }
  }
  const metadata: SoloLegacyPersonalBestMetadataV1[] = [];
  const invalidSources: SoloLegacyPersonalBestInvalidSource[] = [];
  for (const sourceKey of [...keys].sort()) {
    const rawValue = storage.getItem(sourceKey);
    const config = parseLegacyPersonalBestSourceKey(sourceKey);
    const issues: string[] = [];
    if (!config) issues.push("旧版 PB key 中的配置无效");
    if (rawValue === null) issues.push("旧版 PB 值在迁移期间消失");
    let parsed: Record<string, unknown> | null = null;
    if (rawValue !== null) {
      try {
        const value: unknown = JSON.parse(rawValue);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          issues.push("旧版 PB 值必须是 JSON 对象");
        } else {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        issues.push("旧版 PB 值不是有效 JSON");
      }
    }
    const elapsedMs = parsed?.elapsedMs;
    if (
      typeof elapsedMs !== "number" ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs <= 0
    ) {
      issues.push("旧版 PB elapsedMs 无效");
    }

    let completedAt: string | null = null;
    const sourceCompletedAt = parsed?.completedAt;
    if (sourceCompletedAt !== undefined && sourceCompletedAt !== null) {
      if (
        typeof sourceCompletedAt === "number" &&
        Number.isFinite(sourceCompletedAt) &&
        sourceCompletedAt >= 0
      ) {
        try {
          completedAt = new Date(sourceCompletedAt).toISOString();
        } catch {
          issues.push("旧版 PB completedAt 无效");
        }
      } else if (isIsoDate(sourceCompletedAt)) {
        completedAt = sourceCompletedAt;
      } else {
        issues.push("旧版 PB completedAt 无效");
      }
    }

    let metricRulesVersion: string | null = null;
    const sourceMetricRulesVersion = parsed?.metricRulesVersion;
    if (
      sourceMetricRulesVersion !== undefined &&
      sourceMetricRulesVersion !== null
    ) {
      if (
        typeof sourceMetricRulesVersion === "string" &&
        sourceMetricRulesVersion.length > 0
      ) {
        metricRulesVersion = sourceMetricRulesVersion;
      } else {
        issues.push("旧版 PB metricRulesVersion 无效");
      }
    }

    let gameRulesVersion: number | null = null;
    const sourceGameRulesVersion = parsed?.gameRulesVersion;
    if (
      sourceGameRulesVersion !== undefined &&
      sourceGameRulesVersion !== null
    ) {
      if (
        Number.isSafeInteger(sourceGameRulesVersion) &&
        Number(sourceGameRulesVersion) >= 1
      ) {
        gameRulesVersion = Number(sourceGameRulesVersion);
      } else {
        issues.push("旧版 PB gameRulesVersion 无效");
      }
    }
    if (
      parsed?.trustStatus !== undefined &&
      parsed.trustStatus !== "LOCAL_UNVERIFIED"
    ) {
      issues.push("旧版 PB trustStatus 无效");
    }

    if (
      issues.length > 0 ||
      !config ||
      rawValue === null ||
      typeof elapsedMs !== "number"
    ) {
      invalidSources.push({ sourceKey, rawValue, issues });
      continue;
    }
    metadata.push({
      schemaVersion: SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION,
      kind: "LEGACY_PERSONAL_BEST",
      metadataId: legacyPersonalBestMetadataId(sourceKey),
      migratedAt: migratedAt.toISOString(),
      source: {
        storage: "localStorage",
        key: sourceKey,
        rawValue,
      },
      config: {
        width: config.width,
        height: config.height,
        mines: config.mines,
        generationMode: config.mode,
      },
      best: {
        elapsedMs,
        completedAt,
        metricRulesVersion,
        gameRulesVersion,
        trustStatus: "LOCAL_UNVERIFIED",
      },
    });
  }
  return { metadata, invalidSources };
}

export function validateSoloRunRecordV1(
  value: unknown,
  path = "record",
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} 必须是对象`];
  }
  const record = value as Partial<SoloRunRecordV1>;
  const config = record.config as
    | Partial<SoloRunRecordV1["config"]>
    | undefined;
  const board = record.board as
    | Partial<SoloRunRecordV1["board"]>
    | undefined;
  const rules = record.rules as
    | Partial<SoloRunRecordV1["rules"]>
    | undefined;
  const metrics = record.metrics as
    | Partial<SoloRunRecordV1["metrics"]>
    | undefined;
  const issues: string[] = [];
  reportUnexpectedKeys(
    value,
    [
      "schemaVersion",
      "recordId",
      "trainingSessionId",
      "completedAt",
      "outcome",
      "config",
      "board",
      "rules",
      "metrics",
    ],
    path,
    issues,
  );

  if (record.schemaVersion !== SOLO_RUN_SCHEMA_VERSION) {
    issues.push(`${path}.schemaVersion 必须为 ${SOLO_RUN_SCHEMA_VERSION}`);
  }
  if (typeof record.recordId !== "string" || record.recordId.length < 1) {
    issues.push(`${path}.recordId 缺失`);
  }
  if (
    typeof record.trainingSessionId !== "string" ||
    record.trainingSessionId.length < 1
  ) {
    issues.push(`${path}.trainingSessionId 缺失`);
  }
  if (!isIsoDate(record.completedAt)) {
    issues.push(`${path}.completedAt 必须是规范 ISO 时间`);
  }
  if (record.outcome !== "WON" && record.outcome !== "LOST") {
    issues.push(`${path}.outcome 无效`);
  }

  if (!config) {
    issues.push(`${path}.config 缺失`);
  } else {
    reportUnexpectedKeys(
      config,
      ["preset", "width", "height", "mines", "generationMode"],
      `${path}.config`,
      issues,
    );
    if (!isPreset(config.preset)) issues.push(`${path}.config.preset 无效`);
    if (!positiveSafeInteger(config.width)) {
      issues.push(`${path}.config.width 无效`);
    }
    if (!positiveSafeInteger(config.height)) {
      issues.push(`${path}.config.height 无效`);
    }
    if (!positiveSafeInteger(config.mines)) {
      issues.push(`${path}.config.mines 无效`);
    }
    if (!isMode(config.generationMode)) {
      issues.push(`${path}.config.generationMode 无效`);
    }
    if (
      positiveSafeInteger(config.width) &&
      positiveSafeInteger(config.height) &&
      positiveSafeInteger(config.mines) &&
      isMode(config.generationMode)
    ) {
      const normalized: SoloBoardConfig = {
        width: config.width,
        height: config.height,
        mines: config.mines,
        mode: config.generationMode,
      };
      if (getSoloConfigError(normalized) !== undefined) {
        issues.push(`${path}.config 超出支持范围`);
      }
      if (
        config.preset === "beginner" ||
        config.preset === "intermediate" ||
        config.preset === "expert"
      ) {
        const preset = SOLO_PRESETS[config.preset];
        if (
          preset.width !== config.width ||
          preset.height !== config.height ||
          preset.mines !== config.mines
        ) {
          issues.push(`${path}.config 与 preset 不一致`);
        }
      }
    }
  }

  if (!board) {
    issues.push(`${path}.board 缺失`);
  } else {
    reportUnexpectedKeys(
      board,
      ["seed", "boardHash", "trustStatus"],
      `${path}.board`,
      issues,
    );
    if (typeof board.seed !== "string" || board.seed.length < 1) {
      issues.push(`${path}.board.seed 缺失`);
    }
    if (typeof board.boardHash !== "string" || board.boardHash.length < 1) {
      issues.push(`${path}.board.boardHash 缺失`);
    }
    if (board.trustStatus !== "LOCAL_UNVERIFIED") {
      issues.push(`${path}.board.trustStatus 无效`);
    }
  }

  if (!rules) {
    issues.push(`${path}.rules 缺失`);
  } else {
    reportUnexpectedKeys(
      rules,
      ["metricRulesVersion", "gameRulesVersion"],
      `${path}.rules`,
      issues,
    );
    if (
      !Number.isSafeInteger(rules.metricRulesVersion) ||
      Number(rules.metricRulesVersion) < 1
    ) {
      issues.push(`${path}.rules.metricRulesVersion 缺失`);
    }
    if (
      !Number.isSafeInteger(rules.gameRulesVersion) ||
      Number(rules.gameRulesVersion) < 1
    ) {
      issues.push(`${path}.rules.gameRulesVersion 缺失`);
    }
  }

  if (!metrics) {
    issues.push(`${path}.metrics 缺失`);
  } else {
    reportUnexpectedKeys(
      metrics,
      [
        "elapsedMs",
        "board3BV",
        "cps",
        "threeBvPerSecond",
        "ioe",
        "physicalClicks",
        "semanticActions",
        "acceptedActions",
        "wastedActions",
        "reveals",
        "flags",
        "unflags",
        "chords",
      ],
      `${path}.metrics`,
      issues,
    );
    const requiredNonNegative: ReadonlyArray<
      keyof SoloRunRecordV1["metrics"]
    > = [
      "elapsedMs",
      "physicalClicks",
      "semanticActions",
      "acceptedActions",
      "wastedActions",
      "reveals",
      "flags",
      "unflags",
      "chords",
    ];
    for (const key of requiredNonNegative) {
      if (!finiteNonNegative(metrics[key])) {
        issues.push(`${path}.metrics.${key} 无效`);
      }
    }
    if (
      metrics.board3BV !== null &&
      !finiteNonNegative(metrics.board3BV)
    ) {
      issues.push(`${path}.metrics.board3BV 无效`);
    }
    for (const key of ["cps", "threeBvPerSecond", "ioe"] as const) {
      if (metrics[key] !== null && !finiteNonNegative(metrics[key])) {
        issues.push(`${path}.metrics.${key} 无效`);
      }
    }
  }
  return issues;
}

export function isSoloRunRecordV1(value: unknown): value is SoloRunRecordV1 {
  return validateSoloRunRecordV1(value).length === 0;
}

function validateImportRecords(
  records: readonly unknown[],
): readonly SoloRunRecordV1[] {
  if (records.length > SOLO_HISTORY_MAX_RECORDS) {
    throw new SoloHistoryValidationError([
      `单次导入不得超过 ${SOLO_HISTORY_MAX_RECORDS} 条`,
    ]);
  }
  const issues = records.flatMap((record, index) =>
    validateSoloRunRecordV1(record, `records[${index}]`),
  );
  if (issues.length > 0) throw new SoloHistoryValidationError(issues);

  const byId = new Map<string, SoloRunRecordV1>();
  for (const record of records as readonly SoloRunRecordV1[]) {
    const previous = byId.get(record.recordId);
    if (previous && stableJson(previous) !== stableJson(record)) {
      throw new SoloHistoryValidationError([
        `导入批次内 recordId ${record.recordId} 内容冲突`,
      ]);
    }
    byId.set(record.recordId, record);
  }
  return [...byId.values()];
}

export function parseSoloHistoryImport(json: string): readonly SoloRunRecordV1[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new SoloHistoryValidationError([
      cause instanceof Error ? `JSON 无法解析：${cause.message}` : "JSON 无法解析",
    ]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SoloHistoryValidationError(["导入文件根节点必须是对象"]);
  }
  const document = value as Partial<SoloHistoryExportV1>;
  const issues: string[] = [];
  reportUnexpectedKeys(
    value,
    ["format", "schemaVersion", "exportedAt", "recordCount", "records"],
    "document",
    issues,
  );
  if (document.format !== "h-minesweeper-solo-history") {
    issues.push("format 不是 h-minesweeper-solo-history");
  }
  if (document.schemaVersion !== SOLO_HISTORY_EXPORT_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion 必须为 ${SOLO_HISTORY_EXPORT_SCHEMA_VERSION}`,
    );
  }
  if (!isIsoDate(document.exportedAt)) {
    issues.push("exportedAt 必须是规范 ISO 时间");
  }
  if (!Array.isArray(document.records)) {
    issues.push("records 必须是数组");
  }
  if (
    !Number.isSafeInteger(document.recordCount) ||
    document.recordCount !== document.records?.length
  ) {
    issues.push("recordCount 与 records 数量不一致");
  }
  if (issues.length > 0) throw new SoloHistoryValidationError(issues);
  return validateImportRecords(document.records ?? []);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function requestResult<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () =>
        reject(
          new SoloHistoryStorageError(message, {
            cause: request.error ?? undefined,
          }),
        ),
      { once: true },
    );
  });
}

function transactionResult<T>(
  transaction: IDBTransaction,
  result: () => T,
  message: string,
  failure: { current?: Error },
): Promise<T> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(result()), {
      once: true,
    });
    transaction.addEventListener(
      "abort",
      () =>
        reject(
          failure.current ??
            new SoloHistoryStorageError(message, {
              cause: transaction.error ?? undefined,
            }),
        ),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => {
        failure.current ??= new SoloHistoryStorageError(message, {
          cause: transaction.error ?? undefined,
        });
      },
      { once: true },
    );
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener(
      "upgradeneeded",
      () => {
        if (!request.result.objectStoreNames.contains(RUN_STORE_NAME)) {
          const store = request.result.createObjectStore(RUN_STORE_NAME, {
            keyPath: "recordId",
          });
          store.createIndex("completedAt", "completedAt");
        }
        if (
          !request.result.objectStoreNames.contains(
            LEGACY_PERSONAL_BEST_STORE_NAME,
          )
        ) {
          const store = request.result.createObjectStore(
            LEGACY_PERSONAL_BEST_STORE_NAME,
            { keyPath: "metadataId" },
          );
          store.createIndex("sourceKey", "source.key", { unique: true });
        }
      },
      { once: true },
    );
    request.addEventListener(
      "success",
      () => {
        request.result.addEventListener(
          "versionchange",
          () => request.result.close(),
          { once: true },
        );
        resolve(request.result);
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () =>
        reject(
          new SoloHistoryStorageError("无法打开本地历史数据库。", {
            cause: request.error ?? undefined,
          }),
        ),
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () =>
        reject(
          new SoloHistoryStorageError(
            "本地历史数据库升级被其他页面阻止，请关闭旧页面后重试。",
          ),
        ),
      { once: true },
    );
  });
}

function readResult(rawRecords: readonly unknown[]): SoloHistoryReadResult {
  const records = rawRecords
    .filter(isSoloRunRecordV1)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  return {
    ...capacity(rawRecords.length),
    records,
    rawRecords,
    invalidRecordCount: rawRecords.length - records.length,
  };
}

function legacyPersonalBestMigrationResult(
  rawMetadata: readonly unknown[],
  migrated: number,
  skippedExisting: number,
  invalidSources: readonly SoloLegacyPersonalBestInvalidSource[],
): SoloLegacyPersonalBestMigrationResult {
  const metadata = rawMetadata
    .filter(isSoloLegacyPersonalBestMetadataV1)
    .sort((left, right) => left.source.key.localeCompare(right.source.key));
  return {
    metadata,
    rawMetadata,
    invalidMetadataCount: rawMetadata.length - metadata.length,
    migrated,
    skippedExisting,
    invalidSources,
  };
}

export function createIndexedDbSoloHistoryStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): SoloHistoryStore {
  let databasePromise: Promise<IDBDatabase> | undefined;
  const database = () => {
    if (!factory) {
      return Promise.reject(
        new SoloHistoryStorageError(
          "当前浏览器不支持 IndexedDB，本局成绩未保存到历史。",
        ),
      );
    }
    databasePromise ??= openDatabase(factory).catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  };

  return {
    async read() {
      const db = await database();
      const transaction = db.transaction(RUN_STORE_NAME, "readonly");
      const failure: { current?: Error } = {};
      const completed = transactionResult(
        transaction,
        () => undefined,
        "读取本地历史失败，现有记录没有被修改。",
        failure,
      );
      const rawRecords = await requestResult(
        transaction.objectStore(RUN_STORE_NAME).getAll(),
        "读取本地历史失败，现有记录没有被修改。",
      );
      await completed;
      return readResult(rawRecords);
    },

    async put(record) {
      const issues = validateSoloRunRecordV1(record);
      if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      const db = await database();
      const transaction = db.transaction(RUN_STORE_NAME, "readwrite");
      const failure: { current?: Error } = {};
      let nextCount = 0;
      const completed = transactionResult(
        transaction,
        () => capacity(nextCount),
        "本局成绩未能写入本地历史，请检查浏览器存储权限或剩余空间。",
        failure,
      );
      const store = transaction.objectStore(RUN_STORE_NAME);
      const existingRequest = store.getAll();
      existingRequest.addEventListener(
        "success",
        () => {
          const previous = existingRequest.result.find(
            (value) =>
              value &&
              typeof value === "object" &&
              "recordId" in value &&
              (value as { recordId: unknown }).recordId === record.recordId,
          );
          if (
            previous !== undefined &&
            stableJson(previous) !== stableJson(record)
          ) {
            failure.current = new SoloHistoryConflictError(record.recordId);
            transaction.abort();
            return;
          }
          const exists = previous !== undefined;
          nextCount = existingRequest.result.length + (exists ? 0 : 1);
          if (!exists && nextCount > SOLO_HISTORY_MAX_RECORDS) {
            failure.current = new SoloHistoryCapacityError();
            transaction.abort();
            return;
          }
          if (!exists) store.add(record);
        },
        { once: true },
      );
      return completed;
    },

    async importRecords(rawRecords) {
      const records = validateImportRecords(rawRecords);
      const db = await database();
      const transaction = db.transaction(RUN_STORE_NAME, "readwrite");
      const failure: { current?: Error } = {};
      let result: SoloHistoryImportResult = {
        ...capacity(0),
        imported: 0,
        skippedIdentical: 0,
      };
      const completed = transactionResult(
        transaction,
        () => result,
        "导入本地历史失败，整批数据均未写入。",
        failure,
      );
      const store = transaction.objectStore(RUN_STORE_NAME);
      const existingRequest = store.getAll();
      existingRequest.addEventListener(
        "success",
        () => {
          const existing = new Map<string, unknown>();
          for (const value of existingRequest.result) {
            const key =
              value && typeof value === "object" && "recordId" in value
                ? String((value as { recordId: unknown }).recordId)
                : "";
            if (key) existing.set(key, value);
          }
          const additions: SoloRunRecordV1[] = [];
          let skippedIdentical = 0;
          for (const record of records) {
            const previous = existing.get(record.recordId);
            if (previous === undefined) {
              additions.push(record);
            } else if (stableJson(previous) === stableJson(record)) {
              skippedIdentical += 1;
            } else {
              failure.current = new SoloHistoryConflictError(record.recordId);
              transaction.abort();
              return;
            }
          }
          const nextCount = existingRequest.result.length + additions.length;
          if (nextCount > SOLO_HISTORY_MAX_RECORDS) {
            failure.current = new SoloHistoryCapacityError(
              `导入后将达到 ${nextCount} 条，超过 10,000 条上限；整批导入已取消，旧数据未删除。`,
            );
            transaction.abort();
            return;
          }
          for (const record of additions) store.add(record);
          result = {
            ...capacity(nextCount),
            imported: additions.length,
            skippedIdentical,
          };
        },
        { once: true },
      );
      return completed;
    },

    async migrateLegacyPersonalBests(storage, now = new Date()) {
      let prepared: PreparedLegacyPersonalBestMigration;
      try {
        const sourceStorage =
          storage ??
          (typeof globalThis.localStorage === "undefined"
            ? undefined
            : globalThis.localStorage);
        prepared = prepareLegacyPersonalBestMigration(sourceStorage, now);
      } catch (cause) {
        throw new SoloHistoryStorageError(
          "无法读取旧版个人最佳；源数据没有被修改。",
          { cause },
        );
      }
      const db = await database();
      const transaction = db.transaction(
        LEGACY_PERSONAL_BEST_STORE_NAME,
        "readwrite",
      );
      const failure: { current?: Error } = {};
      let result = legacyPersonalBestMigrationResult(
        [],
        0,
        0,
        prepared.invalidSources,
      );
      const completed = transactionResult(
        transaction,
        () => result,
        "旧版个人最佳元数据迁移失败；源数据没有被修改。",
        failure,
      );
      const store = transaction.objectStore(LEGACY_PERSONAL_BEST_STORE_NAME);
      const existingRequest = store.getAll();
      existingRequest.addEventListener(
        "success",
        () => {
          const existing = new Set<string>();
          const existingSourceKeys = new Set<string>();
          for (const value of existingRequest.result) {
            if (
              value &&
              typeof value === "object" &&
              "metadataId" in value &&
              typeof (value as { metadataId: unknown }).metadataId === "string"
            ) {
              existing.add((value as { metadataId: string }).metadataId);
            }
            if (
              value &&
              typeof value === "object" &&
              "source" in value &&
              (value as { source?: unknown }).source &&
              typeof (value as { source: { key?: unknown } }).source.key ===
                "string"
            ) {
              existingSourceKeys.add(
                (value as { source: { key: string } }).source.key,
              );
            }
          }
          const additions: SoloLegacyPersonalBestMetadataV1[] = [];
          let skippedExisting = 0;
          for (const metadata of prepared.metadata) {
            if (
              existing.has(metadata.metadataId) ||
              existingSourceKeys.has(metadata.source.key)
            ) {
              skippedExisting += 1;
            } else {
              additions.push(metadata);
              existing.add(metadata.metadataId);
              existingSourceKeys.add(metadata.source.key);
            }
          }
          for (const metadata of additions) store.add(metadata);
          result = legacyPersonalBestMigrationResult(
            [...existingRequest.result, ...additions],
            additions.length,
            skippedExisting,
            prepared.invalidSources,
          );
        },
        { once: true },
      );
      return completed;
    },

    async clear() {
      const db = await database();
      const transaction = db.transaction(RUN_STORE_NAME, "readwrite");
      const failure: { current?: Error } = {};
      const completed = transactionResult(
        transaction,
        () => undefined,
        "删除本地历史失败，原记录仍可能保留。",
        failure,
      );
      transaction.objectStore(RUN_STORE_NAME).clear();
      await completed;
    },
  };
}

export function createMemorySoloHistoryStore(
  initialRecords: readonly unknown[] = [],
  initialLegacyPersonalBestMetadata: readonly unknown[] = [],
): SoloHistoryStore {
  let rawRecords = structuredClone([...initialRecords]);
  let rawLegacyPersonalBestMetadata = structuredClone([
    ...initialLegacyPersonalBestMetadata,
  ]);
  return {
    async read() {
      return readResult(structuredClone(rawRecords));
    },
    async put(record) {
      const issues = validateSoloRunRecordV1(record);
      if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      const index = rawRecords.findIndex(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          "recordId" in entry &&
          (entry as { recordId: unknown }).recordId === record.recordId,
      );
      if (index < 0 && rawRecords.length >= SOLO_HISTORY_MAX_RECORDS) {
        throw new SoloHistoryCapacityError();
      }
      const next = structuredClone(record);
      if (index < 0) rawRecords.push(next);
      else if (stableJson(rawRecords[index]) !== stableJson(next)) {
        throw new SoloHistoryConflictError(record.recordId);
      }
      return capacity(rawRecords.length);
    },
    async importRecords(values) {
      const records = validateImportRecords(values);
      const next = structuredClone(rawRecords);
      let imported = 0;
      let skippedIdentical = 0;
      for (const record of records) {
        const previous = next.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            "recordId" in entry &&
            (entry as { recordId: unknown }).recordId === record.recordId,
        );
        if (previous === undefined) {
          next.push(structuredClone(record));
          imported += 1;
        } else if (stableJson(previous) === stableJson(record)) {
          skippedIdentical += 1;
        } else {
          throw new SoloHistoryConflictError(record.recordId);
        }
      }
      if (next.length > SOLO_HISTORY_MAX_RECORDS) {
        throw new SoloHistoryCapacityError(
          `导入后将达到 ${next.length} 条，超过 10,000 条上限；整批导入已取消，旧数据未删除。`,
        );
      }
      rawRecords = next;
      return {
        ...capacity(rawRecords.length),
        imported,
        skippedIdentical,
      };
    },
    async migrateLegacyPersonalBests(storage, now = new Date()) {
      let prepared: PreparedLegacyPersonalBestMigration;
      try {
        prepared = prepareLegacyPersonalBestMigration(storage, now);
      } catch (cause) {
        throw new SoloHistoryStorageError(
          "无法读取旧版个人最佳；源数据没有被修改。",
          { cause },
        );
      }
      const existing = new Set<string>();
      const existingSourceKeys = new Set<string>();
      for (const value of rawLegacyPersonalBestMetadata) {
        if (
          value &&
          typeof value === "object" &&
          "metadataId" in value &&
          typeof (value as { metadataId: unknown }).metadataId === "string"
        ) {
          existing.add((value as { metadataId: string }).metadataId);
        }
        if (
          value &&
          typeof value === "object" &&
          "source" in value &&
          (value as { source?: unknown }).source &&
          typeof (value as { source: { key?: unknown } }).source.key === "string"
        ) {
          existingSourceKeys.add(
            (value as { source: { key: string } }).source.key,
          );
        }
      }
      const additions: SoloLegacyPersonalBestMetadataV1[] = [];
      let skippedExisting = 0;
      for (const metadata of prepared.metadata) {
        if (
          existing.has(metadata.metadataId) ||
          existingSourceKeys.has(metadata.source.key)
        ) {
          skippedExisting += 1;
        } else {
          additions.push(structuredClone(metadata));
          existing.add(metadata.metadataId);
          existingSourceKeys.add(metadata.source.key);
        }
      }
      rawLegacyPersonalBestMetadata = [
        ...rawLegacyPersonalBestMetadata,
        ...additions,
      ];
      return legacyPersonalBestMigrationResult(
        structuredClone(rawLegacyPersonalBestMetadata),
        additions.length,
        skippedExisting,
        prepared.invalidSources,
      );
    },
    async clear() {
      rawRecords = [];
    },
  };
}

export function sameSoloConfigurationAndRules(
  record: SoloRunRecordV1,
  config: SoloBoardConfig,
  preset: SoloPreset,
  metricRulesVersion: number,
  gameRulesVersion: number,
): boolean {
  return (
    record.config.preset === preset &&
    record.config.width === config.width &&
    record.config.height === config.height &&
    record.config.mines === config.mines &&
    record.config.generationMode === config.mode &&
    record.rules.metricRulesVersion === metricRulesVersion &&
    record.rules.gameRulesVersion === gameRulesVersion
  );
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculateSoloTrend(
  records: readonly SoloRunRecordV1[],
  config: SoloBoardConfig,
  preset: SoloPreset,
  metricRulesVersion: number,
  gameRulesVersion: number,
): SoloTrendSummary {
  const comparable = records
    .filter((record) =>
      sameSoloConfigurationAndRules(
        record,
        config,
        preset,
        metricRulesVersion,
        gameRulesVersion,
      ),
    )
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const wins = comparable.filter((record) => record.outcome === "WON");
  const latest = wins[0];
  const elapsed = wins.map((record) => record.metrics.elapsedMs);
  const speeds = wins.flatMap((record) =>
    record.metrics.threeBvPerSecond === null
      ? []
      : [record.metrics.threeBvPerSecond],
  );
  const efficiencies = wins.flatMap((record) =>
    record.metrics.ioe === null ? [] : [record.metrics.ioe],
  );
  return {
    runCount: comparable.length,
    winCount: wins.length,
    latestElapsedMs: latest?.metrics.elapsedMs ?? null,
    bestElapsedMs: elapsed.length === 0 ? null : Math.min(...elapsed),
    averageElapsedMs: average(elapsed),
    latestThreeBvPerSecond:
      latest?.metrics.threeBvPerSecond ?? null,
    bestThreeBvPerSecond:
      speeds.length === 0 ? null : Math.max(...speeds),
    latestIoe: latest?.metrics.ioe ?? null,
    bestIoe:
      efficiencies.length === 0 ? null : Math.max(...efficiencies),
  };
}

export function createSoloHistoryExport(
  records: readonly SoloRunRecordV1[],
  exportedAt = new Date(),
): SoloHistoryExportV1 {
  const sorted = [...records].sort((left, right) =>
    right.completedAt.localeCompare(left.completedAt),
  );
  return {
    format: "h-minesweeper-solo-history",
    schemaVersion: SOLO_HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    recordCount: sorted.length,
    records: sorted,
  };
}

export function createSoloHistoryRecoveryExport(
  rawRecords: readonly unknown[],
  exportedAt = new Date(),
): SoloHistoryRecoveryExportV1 {
  return {
    format: "h-minesweeper-solo-history-recovery",
    schemaVersion: SOLO_HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    recordCount: rawRecords.length,
    records: rawRecords,
  };
}

export function createSoloLegacyPersonalBestRecoveryExport(
  migration: Pick<
    SoloLegacyPersonalBestMigrationResult,
    "invalidSources" | "rawMetadata"
  >,
  exportedAt = new Date(),
): SoloLegacyPersonalBestRecoveryExportV1 {
  const invalidMetadata = migration.rawMetadata.filter(
    (value) => !isSoloLegacyPersonalBestMetadataV1(value),
  );
  return {
    format: "h-minesweeper-solo-legacy-personal-best-recovery",
    schemaVersion: SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    invalidSourceCount: migration.invalidSources.length,
    invalidMetadataCount: invalidMetadata.length,
    invalidSources: migration.invalidSources,
    rawMetadata: invalidMetadata,
  };
}

interface StoredTrainingSession {
  readonly sessionId: string;
  readonly lastActiveAt: number;
  readonly terminalBoardCount?: number;
  readonly effectiveInteractionMs?: number;
}

export interface SoloTrainingSessionProgress {
  readonly sessionId: string;
  readonly terminalBoardCount: number;
  readonly effectiveInteractionMs: number;
}

export function touchTrainingSession(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.sessionStorage,
  now = Date.now(),
  idleMs = SOLO_TRAINING_SESSION_IDLE_MS,
): string {
  const key = "hms-solo-training-session-v1";
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredTrainingSession>) : null;
    const canReuse =
      parsed !== null &&
      typeof parsed.sessionId === "string" &&
      parsed.sessionId.length > 0 &&
      typeof parsed.lastActiveAt === "number" &&
      Number.isFinite(parsed.lastActiveAt) &&
      now >= parsed.lastActiveAt &&
      now - parsed.lastActiveAt < idleMs;
    const sessionId = canReuse
      ? parsed.sessionId!
      : globalThis.crypto.randomUUID();
    const terminalBoardCount =
      canReuse &&
      Number.isSafeInteger(parsed?.terminalBoardCount) &&
      Number(parsed?.terminalBoardCount) >= 0
        ? Number(parsed?.terminalBoardCount)
        : 0;
    const effectiveInteractionMs =
      canReuse &&
      typeof parsed?.effectiveInteractionMs === "number" &&
      Number.isFinite(parsed.effectiveInteractionMs) &&
      parsed.effectiveInteractionMs >= 0
        ? parsed.effectiveInteractionMs
        : 0;
    const next: StoredTrainingSession = {
      sessionId,
      lastActiveAt: now,
      terminalBoardCount,
      effectiveInteractionMs,
    };
    storage?.setItem(key, JSON.stringify(next));
    return sessionId;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

export function getOrCreateTrainingSessionId(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.sessionStorage,
): string {
  return touchTrainingSession(storage);
}

export function recordTrainingSessionTerminal(
  sessionId: string,
  runEffectiveInteractionMs: number,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.sessionStorage,
  now = Date.now(),
): SoloTrainingSessionProgress {
  if (sessionId.length < 1) {
    throw new RangeError("训练会话 ID 不能为空。");
  }
  if (
    !Number.isFinite(runEffectiveInteractionMs) ||
    runEffectiveInteractionMs < 0
  ) {
    throw new RangeError("有效操作时长必须是非负有限数。");
  }
  const fallback: SoloTrainingSessionProgress = {
    sessionId,
    terminalBoardCount: 1,
    effectiveInteractionMs: runEffectiveInteractionMs,
  };
  const key = "hms-solo-training-session-v1";
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredTrainingSession>) : null;
    if (
      parsed?.sessionId !== undefined &&
      parsed.sessionId !== sessionId
    ) {
      return fallback;
    }
    const previousTerminalCount =
      Number.isSafeInteger(parsed?.terminalBoardCount) &&
      Number(parsed?.terminalBoardCount) >= 0
        ? Number(parsed?.terminalBoardCount)
        : 0;
    const previousEffectiveMs =
      typeof parsed?.effectiveInteractionMs === "number" &&
      Number.isFinite(parsed.effectiveInteractionMs) &&
      parsed.effectiveInteractionMs >= 0
        ? parsed.effectiveInteractionMs
        : 0;
    const progress: SoloTrainingSessionProgress = {
      sessionId,
      terminalBoardCount: previousTerminalCount + 1,
      effectiveInteractionMs:
        previousEffectiveMs + runEffectiveInteractionMs,
    };
    storage?.setItem(
      key,
      JSON.stringify({
        ...progress,
        lastActiveAt: now,
      } satisfies StoredTrainingSession),
    );
    return progress;
  } catch {
    return fallback;
  }
}
