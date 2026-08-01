import {
  getSoloConfigError,
  SOLO_PRESETS,
  type SoloBoardConfig,
  type SoloGenerationMode,
  type SoloPreset,
} from "./solo";
import {
  chordCell,
  createBoard,
  createGameState,
  hashBoard,
  hashGameState,
  revealCell,
  toggleFlag,
  type GameState,
  type ActionRejectReason,
  type BoardSpec,
  type CountedBoardActionType,
} from "@h-minesweeper/game-core";

export const SOLO_RUN_SCHEMA_VERSION = 1 as const;
export const SOLO_RUN_SCHEMA_VERSION_V2 = 2 as const;
export const SOLO_REPLAY_SCHEMA_VERSION = 1 as const;
export const SOLO_HISTORY_EXPORT_SCHEMA_VERSION = 2 as const;
export const SOLO_HISTORY_EXPORT_SCHEMA_VERSION_V1 = 1 as const;
export const SOLO_LEGACY_PERSONAL_BEST_SCHEMA_VERSION = 1 as const;
export const SOLO_METRIC_RULES_VERSION = 1 as const;
export const SOLO_GAME_RULES_VERSION = 1 as const;
export const SOLO_HISTORY_MAX_RECORDS = 10_000;
export const SOLO_HISTORY_WARNING_RECORDS = 9_500;
export const SOLO_TRAINING_SESSION_IDLE_MS = 30 * 60 * 1_000;
export const SOLO_LEGACY_PERSONAL_BEST_PREFIX = "hms-solo-best-v1";
export const SOLO_REPLAY_MAX_ACTIONS = 20_000;
export const SOLO_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
export const SOLO_HISTORY_IMPORT_MAX_BYTES = 64 * 1024 * 1024;

const DATABASE_NAME = "h-minesweeper-solo-history-v1";
const DATABASE_VERSION = 3;
const RUN_STORE_NAME = "solo-runs-v1";
const REPLAY_STORE_NAME = "solo-replays-v1";
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

export type SoloReplayStatus =
  | { readonly status: "COMPLETE" }
  | {
      readonly status: "TRUNCATED";
      readonly reason: "ACTION_LIMIT" | "BYTE_LIMIT";
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: "STORAGE_FAILURE" | "UNSUPPORTED";
    };

export interface SoloRunRecordV2 {
  readonly schemaVersion: typeof SOLO_RUN_SCHEMA_VERSION_V2;
  readonly recordId: string;
  readonly trainingSessionId: string;
  readonly completedAt: string;
  readonly outcome: SoloRunOutcome;
  readonly config: SoloRunRecordV1["config"];
  readonly board: {
    readonly spec: BoardSpec;
    readonly boardHash: string;
    readonly generatorRulesVersion: number;
    readonly trustStatus: "LOCAL_UNVERIFIED";
  };
  readonly rules: SoloRunRecordV1["rules"];
  readonly metrics: SoloRunRecordV1["metrics"];
  readonly replay: SoloReplayStatus & {
    readonly schemaVersion: typeof SOLO_REPLAY_SCHEMA_VERSION;
    readonly actionCount: number;
    readonly actionLogHash: string;
  };
}

export type SoloRunRecord = SoloRunRecordV1 | SoloRunRecordV2;

export interface SoloReplayActionV1 {
  readonly seq: number;
  readonly elapsedMs: number;
  readonly actionType: CountedBoardActionType;
  readonly cellIndex: number;
  readonly physicalClicks: number;
  readonly preStateHash: string;
  readonly accepted: boolean;
  readonly rejectReason?: ActionRejectReason;
  readonly postStateHash: string;
}

export interface SoloReplayV1 {
  readonly schemaVersion: typeof SOLO_REPLAY_SCHEMA_VERSION;
  readonly recordId: string;
  readonly initialFlags: readonly number[];
  readonly actions: readonly SoloReplayActionV1[];
}

export interface SoloHistoryExportV2 {
  readonly format: "h-minesweeper-solo-history";
  readonly schemaVersion: typeof SOLO_HISTORY_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly recordCount: number;
  readonly records: readonly SoloRunRecord[];
  readonly replays: readonly SoloReplayV1[];
}

export interface SoloHistoryExportV1 {
  readonly format: "h-minesweeper-solo-history";
  readonly schemaVersion: typeof SOLO_HISTORY_EXPORT_SCHEMA_VERSION_V1;
  readonly exportedAt: string;
  readonly recordCount: number;
  readonly records: readonly SoloRunRecordV1[];
}

export interface SoloHistoryRecoveryExportV1 {
  readonly format: "h-minesweeper-solo-history-recovery";
  readonly schemaVersion: number;
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
  readonly records: readonly SoloRunRecord[];
  readonly rawRecords: readonly unknown[];
  readonly invalidRecordCount: number;
  readonly replayIssueCount: number;
  readonly availableReplayRecordIds: readonly string[];
}

export interface SoloHistoryImportResult extends SoloHistoryCapacity {
  readonly imported: number;
  readonly skippedIdentical: number;
}

export interface SoloHistoryStore {
  read(): Promise<SoloHistoryReadResult>;
  readReplay(recordId: string): Promise<SoloReplayV1 | null>;
  put(
    record: SoloRunRecord,
    replay?: SoloReplayV1,
  ): Promise<SoloHistoryCapacity>;
  importRecords(records: readonly unknown[]): Promise<SoloHistoryImportResult>;
  importDocument(document: SoloHistoryExportV2): Promise<SoloHistoryImportResult>;
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

const ACTION_TYPES = new Set<CountedBoardActionType>([
  "REVEAL",
  "TOGGLE_FLAG",
  "CHORD",
]);

const ACTION_REJECT_REASONS = new Set<ActionRejectReason>([
  "INVALID_INDEX",
  "GAME_OVER",
  "ALREADY_REVEALED",
  "FLAGGED",
  "NOT_REVEALED",
  "NOT_NUMBER",
  "FLAG_COUNT_MISMATCH",
  "NO_HIDDEN_NEIGHBORS",
]);

function validateBoardSpec(
  value: unknown,
  path: string,
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} 必须是对象`];
  }
  const spec = value as Partial<BoardSpec>;
  const issues: string[] = [];
  reportUnexpectedKeys(
    value,
    ["width", "height", "mines", "seed", "startIndex", "safeRadius"],
    path,
    issues,
  );
  if (!positiveSafeInteger(spec.width)) issues.push(`${path}.width 无效`);
  if (!positiveSafeInteger(spec.height)) issues.push(`${path}.height 无效`);
  if (!positiveSafeInteger(spec.mines)) issues.push(`${path}.mines 无效`);
  if (typeof spec.seed !== "string" || spec.seed.length < 1) {
    issues.push(`${path}.seed 缺失`);
  }
  if (!Number.isSafeInteger(spec.startIndex) || Number(spec.startIndex) < 0) {
    issues.push(`${path}.startIndex 无效`);
  }
  if (!Number.isSafeInteger(spec.safeRadius) || Number(spec.safeRadius) < 0) {
    issues.push(`${path}.safeRadius 无效`);
  }
  if (
    positiveSafeInteger(spec.width) &&
    positiveSafeInteger(spec.height) &&
    Number.isSafeInteger(spec.startIndex) &&
    Number(spec.startIndex) >= spec.width * spec.height
  ) {
    issues.push(`${path}.startIndex 超出棋盘`);
  }
  return issues;
}

export function validateSoloReplayV1(
  value: unknown,
  path = "replay",
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} 必须是对象`];
  }
  const replay = value as Partial<SoloReplayV1>;
  const issues: string[] = [];
  reportUnexpectedKeys(
    value,
    ["schemaVersion", "recordId", "initialFlags", "actions"],
    path,
    issues,
  );
  if (replay.schemaVersion !== SOLO_REPLAY_SCHEMA_VERSION) {
    issues.push(`${path}.schemaVersion 无效`);
  }
  if (typeof replay.recordId !== "string" || replay.recordId.length < 1) {
    issues.push(`${path}.recordId 缺失`);
  }
  if (!Array.isArray(replay.initialFlags)) {
    issues.push(`${path}.initialFlags 必须是数组`);
  } else {
    let previous = -1;
    for (const [index, flag] of replay.initialFlags.entries()) {
      if (!Number.isSafeInteger(flag) || Number(flag) < 0) {
        issues.push(`${path}.initialFlags[${index}] 无效`);
      }
      if (Number(flag) <= previous) {
        issues.push(`${path}.initialFlags 必须升序且不重复`);
      }
      previous = Number(flag);
    }
  }
  if (!Array.isArray(replay.actions)) {
    issues.push(`${path}.actions 必须是数组`);
    return issues;
  }
  if (replay.actions.length > SOLO_REPLAY_MAX_ACTIONS) {
    issues.push(`${path}.actions 超过 ${SOLO_REPLAY_MAX_ACTIONS} 条上限`);
  }
  let previousElapsed = -1;
  for (const [index, value] of replay.actions.entries()) {
    const actionPath = `${path}.actions[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${actionPath} 必须是对象`);
      continue;
    }
    const action = value as Partial<SoloReplayActionV1>;
    reportUnexpectedKeys(
      value,
      [
        "seq",
        "elapsedMs",
        "actionType",
        "cellIndex",
        "physicalClicks",
        "preStateHash",
        "accepted",
        "rejectReason",
        "postStateHash",
      ],
      actionPath,
      issues,
    );
    if (action.seq !== index + 1) issues.push(`${actionPath}.seq 不连续`);
    if (!finiteNonNegative(action.elapsedMs)) {
      issues.push(`${actionPath}.elapsedMs 无效`);
    } else if (action.elapsedMs < previousElapsed) {
      issues.push(`${actionPath}.elapsedMs 必须单调递增`);
    } else {
      previousElapsed = action.elapsedMs;
    }
    if (!ACTION_TYPES.has(action.actionType as CountedBoardActionType)) {
      issues.push(`${actionPath}.actionType 无效`);
    }
    if (!Number.isSafeInteger(action.cellIndex) || Number(action.cellIndex) < 0) {
      issues.push(`${actionPath}.cellIndex 无效`);
    }
    if (!positiveSafeInteger(action.physicalClicks)) {
      issues.push(`${actionPath}.physicalClicks 无效`);
    }
    if (typeof action.preStateHash !== "string" || !action.preStateHash) {
      issues.push(`${actionPath}.preStateHash 缺失`);
    }
    if (typeof action.accepted !== "boolean") {
      issues.push(`${actionPath}.accepted 无效`);
    }
    if (
      action.rejectReason !== undefined &&
      !ACTION_REJECT_REASONS.has(action.rejectReason)
    ) {
      issues.push(`${actionPath}.rejectReason 无效`);
    }
    if (action.accepted && action.rejectReason !== undefined) {
      issues.push(`${actionPath}.accepted 动作不能包含 rejectReason`);
    }
    if (typeof action.postStateHash !== "string" || !action.postStateHash) {
      issues.push(`${actionPath}.postStateHash 缺失`);
    }
  }
  if (new TextEncoder().encode(stableJson(value)).byteLength > SOLO_REPLAY_MAX_BYTES) {
    issues.push(`${path} 超过 ${SOLO_REPLAY_MAX_BYTES} 字节上限`);
  }
  return issues;
}

export function isSoloReplayV1(value: unknown): value is SoloReplayV1 {
  return validateSoloReplayV1(value).length === 0;
}

export function hashSoloReplay(replay: SoloReplayV1): string {
  const value = stableJson(replay);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `replay-v1-${hash.toString(16).padStart(8, "0")}`;
}

export function verifySoloReplay(
  record: SoloRunRecordV2,
  replay: SoloReplayV1,
): { readonly valid: true; readonly state: GameState } {
  validateReplayPair(record, replay);
  const state = createGameState(createBoard(record.board.spec));
  if (hashBoard(state.board) !== record.board.boardHash) {
    throw new SoloHistoryValidationError([
      `记录 ${record.recordId} 的 boardHash 与规则版本重建结果不一致`,
    ]);
  }
  for (const index of replay.initialFlags) {
    const delta = toggleFlag(state, index);
    if (!delta.accepted) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 的首击前旗 ${index} 无效`,
      ]);
    }
  }
  for (const action of replay.actions) {
    if (hashGameState(state) !== action.preStateHash) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 第 ${action.seq} 步 preStateHash 不一致`,
      ]);
    }
    const delta = action.actionType === "REVEAL"
      ? revealCell(state, action.cellIndex)
      : action.actionType === "TOGGLE_FLAG"
        ? toggleFlag(state, action.cellIndex)
        : chordCell(state, action.cellIndex);
    if (
      delta.accepted !== action.accepted ||
      delta.rejectReason !== action.rejectReason ||
      delta.stateHash !== action.postStateHash
    ) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 第 ${action.seq} 步无法按日志重放`,
      ]);
    }
  }
  if (record.replay.status === "COMPLETE" && state.outcome !== record.outcome) {
    throw new SoloHistoryValidationError([
      `记录 ${record.recordId} 的终局结果与完整 replay 不一致`,
    ]);
  }
  return { valid: true, state };
}

function validateReplayPair(
  record: SoloRunRecord,
  replay: SoloReplayV1 | undefined,
): void {
  if (record.schemaVersion === SOLO_RUN_SCHEMA_VERSION) {
    if (replay) {
      throw new SoloHistoryValidationError([
        `V1 记录 ${record.recordId} 不能包含 replay`,
      ]);
    }
    return;
  }
  if (record.replay.status === "UNAVAILABLE") {
    if (replay) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 标记为不可复盘但包含 replay`,
      ]);
    }
    return;
  }
  if (!replay || replay.recordId !== record.recordId) {
    throw new SoloHistoryValidationError([
      `记录 ${record.recordId} 缺少匹配的 replay`,
    ]);
  }
  if (
    record.replay.actionCount !== replay.actions.length ||
    record.replay.actionLogHash !== hashSoloReplay(replay)
  ) {
    throw new SoloHistoryValidationError([
      `记录 ${record.recordId} 的 replay 摘要与动作日志不一致`,
    ]);
  }
  const cellCount = record.board.spec.width * record.board.spec.height;
  if (
    replay.initialFlags.some((index) => index >= cellCount) ||
    replay.actions.some((action) => action.cellIndex >= cellCount)
  ) {
    throw new SoloHistoryValidationError([
      `记录 ${record.recordId} 的 replay 格子索引超出棋盘`,
    ]);
  }
}

export function validateSoloRunRecordV2(
  value: unknown,
  path = "record",
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} 必须是对象`];
  }
  const record = value as Partial<SoloRunRecordV2>;
  const board = record.board as Partial<SoloRunRecordV2["board"]> | undefined;
  const replay = record.replay as
    | {
        readonly status?: unknown;
        readonly reason?: unknown;
        readonly schemaVersion?: unknown;
        readonly actionCount?: unknown;
        readonly actionLogHash?: unknown;
      }
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
      "replay",
    ],
    path,
    issues,
  );
  const legacyShape = {
    ...record,
    schemaVersion: SOLO_RUN_SCHEMA_VERSION,
    board: board
      ? {
          seed: board.spec?.seed,
          boardHash: board.boardHash,
          trustStatus: board.trustStatus,
        }
      : undefined,
  };
  issues.push(...validateSoloRunRecordV1(legacyShape, path));
  const filtered = issues.filter(
    (issue) =>
      !issue.includes(".schemaVersion") &&
      !issue.includes("record.replay") &&
      !issue.includes(`${path}.replay`),
  );
  if (record.schemaVersion !== SOLO_RUN_SCHEMA_VERSION_V2) {
    filtered.push(`${path}.schemaVersion 必须为 ${SOLO_RUN_SCHEMA_VERSION_V2}`);
  }
  if (!board) {
    filtered.push(`${path}.board 缺失`);
  } else {
    reportUnexpectedKeys(
      board,
      ["spec", "boardHash", "generatorRulesVersion", "trustStatus"],
      `${path}.board`,
      filtered,
    );
    filtered.push(...validateBoardSpec(board.spec, `${path}.board.spec`));
    if (
      !Number.isSafeInteger(board.generatorRulesVersion) ||
      Number(board.generatorRulesVersion) < 1
    ) {
      filtered.push(`${path}.board.generatorRulesVersion 无效`);
    }
    if (
      board.spec &&
      record.config &&
      (board.spec.width !== record.config.width ||
        board.spec.height !== record.config.height ||
        board.spec.mines !== record.config.mines)
    ) {
      filtered.push(`${path}.board.spec 与 config 不一致`);
    }
  }
  if (!replay) {
    filtered.push(`${path}.replay 缺失`);
  } else {
    reportUnexpectedKeys(
      replay,
      ["status", "reason", "schemaVersion", "actionCount", "actionLogHash"],
      `${path}.replay`,
      filtered,
    );
    if (
      replay.status !== "COMPLETE" &&
      replay.status !== "TRUNCATED" &&
      replay.status !== "UNAVAILABLE"
    ) {
      filtered.push(`${path}.replay.status 无效`);
    }
    if (replay.status === "TRUNCATED") {
      if (replay.reason !== "ACTION_LIMIT" && replay.reason !== "BYTE_LIMIT") {
        filtered.push(`${path}.replay.reason 无效`);
      }
    } else if (replay.status === "UNAVAILABLE") {
      if (
        replay.reason !== "STORAGE_FAILURE" &&
        replay.reason !== "UNSUPPORTED"
      ) {
        filtered.push(`${path}.replay.reason 无效`);
      }
    } else if (replay.reason !== undefined) {
      filtered.push(`${path}.replay.reason 不应存在`);
    }
    if (replay.schemaVersion !== SOLO_REPLAY_SCHEMA_VERSION) {
      filtered.push(`${path}.replay.schemaVersion 无效`);
    }
    if (!finiteNonNegative(replay.actionCount)) {
      filtered.push(`${path}.replay.actionCount 无效`);
    }
    if (typeof replay.actionLogHash !== "string") {
      filtered.push(`${path}.replay.actionLogHash 无效`);
    }
  }
  return [...new Set(filtered)];
}

export function isSoloRunRecordV2(value: unknown): value is SoloRunRecordV2 {
  return validateSoloRunRecordV2(value).length === 0;
}

export function isSoloRunRecord(value: unknown): value is SoloRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return schemaVersion === SOLO_RUN_SCHEMA_VERSION
    ? isSoloRunRecordV1(value)
    : schemaVersion === SOLO_RUN_SCHEMA_VERSION_V2
      ? isSoloRunRecordV2(value)
      : false;
}

function validateImportRecords(
  records: readonly unknown[],
): readonly SoloRunRecord[] {
  if (records.length > SOLO_HISTORY_MAX_RECORDS) {
    throw new SoloHistoryValidationError([
      `单次导入不得超过 ${SOLO_HISTORY_MAX_RECORDS} 条`,
    ]);
  }
  const issues = records.flatMap((record, index) =>
    (record as { schemaVersion?: unknown })?.schemaVersion ===
    SOLO_RUN_SCHEMA_VERSION_V2
      ? validateSoloRunRecordV2(record, `records[${index}]`)
      : validateSoloRunRecordV1(record, `records[${index}]`),
  );
  if (issues.length > 0) throw new SoloHistoryValidationError(issues);

  const byId = new Map<string, SoloRunRecord>();
  for (const record of records as readonly SoloRunRecord[]) {
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

export function parseSoloHistoryImportDocument(
  json: string,
): SoloHistoryExportV2 {
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
  const document = value as {
    readonly format?: unknown;
    readonly schemaVersion?: unknown;
    readonly exportedAt?: unknown;
    readonly recordCount?: unknown;
    readonly records?: unknown;
    readonly replays?: unknown;
  };
  const issues: string[] = [];
  const schemaVersion = document.schemaVersion;
  reportUnexpectedKeys(
    value,
    schemaVersion === SOLO_HISTORY_EXPORT_SCHEMA_VERSION_V1
      ? ["format", "schemaVersion", "exportedAt", "recordCount", "records"]
      : [
          "format",
          "schemaVersion",
          "exportedAt",
          "recordCount",
          "records",
          "replays",
        ],
    "document",
    issues,
  );
  if (document.format !== "h-minesweeper-solo-history") {
    issues.push("format 不是 h-minesweeper-solo-history");
  }
  if (
    schemaVersion !== SOLO_HISTORY_EXPORT_SCHEMA_VERSION_V1 &&
    schemaVersion !== SOLO_HISTORY_EXPORT_SCHEMA_VERSION
  ) {
    issues.push("schemaVersion 必须为 1 或 2");
  }
  if (!isIsoDate(document.exportedAt)) {
    issues.push("exportedAt 必须是规范 ISO 时间");
  }
  if (!Array.isArray(document.records)) {
    issues.push("records 必须是数组");
  }
  const rawRecords = Array.isArray(document.records) ? document.records : [];
  if (
    !Number.isSafeInteger(document.recordCount) ||
    document.recordCount !== rawRecords.length
  ) {
    issues.push("recordCount 与 records 数量不一致");
  }
  if (issues.length > 0) throw new SoloHistoryValidationError(issues);
  const exportedAt = document.exportedAt as string;
  const records = validateImportRecords(rawRecords);
  if (schemaVersion === SOLO_HISTORY_EXPORT_SCHEMA_VERSION_V1) {
    if (records.some((record) => record.schemaVersion !== SOLO_RUN_SCHEMA_VERSION)) {
      throw new SoloHistoryValidationError([
        "V1 导出文件不能包含 V2 运行记录",
      ]);
    }
    return {
      format: "h-minesweeper-solo-history",
      schemaVersion: SOLO_HISTORY_EXPORT_SCHEMA_VERSION,
      exportedAt,
      recordCount: records.length,
      records,
      replays: [],
    };
  }
  if (!Array.isArray(document.replays)) {
    throw new SoloHistoryValidationError(["replays 必须是数组"]);
  }
  const rawReplays = document.replays as readonly unknown[];
  const replayIssues = rawReplays.flatMap((replay, index) =>
    validateSoloReplayV1(replay, `replays[${index}]`),
  );
  if (replayIssues.length > 0) {
    throw new SoloHistoryValidationError(replayIssues);
  }
  const replays = rawReplays as readonly SoloReplayV1[];
  const replayById = new Map<string, SoloReplayV1>();
  for (const replay of replays) {
    const previous = replayById.get(replay.recordId);
    if (previous && stableJson(previous) !== stableJson(replay)) {
      throw new SoloHistoryValidationError([
        `导入批次内 replay recordId ${replay.recordId} 内容冲突`,
      ]);
    }
    replayById.set(replay.recordId, replay);
  }
  for (const record of records) {
    if (record.schemaVersion !== SOLO_RUN_SCHEMA_VERSION_V2) continue;
    const replay = replayById.get(record.recordId);
    if (record.replay.status === "UNAVAILABLE") {
      if (replay) {
        throw new SoloHistoryValidationError([
          `记录 ${record.recordId} 标记为不可复盘但包含 replay`,
        ]);
      }
      continue;
    }
    if (!replay) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 缺少 replay`,
      ]);
    }
    if (
      record.replay.actionCount !== replay.actions.length ||
      record.replay.actionLogHash !== hashSoloReplay(replay)
    ) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 的 replay 摘要与动作日志不一致`,
      ]);
    }
    const cellCount = record.board.spec.width * record.board.spec.height;
    if (
      replay.initialFlags.some((index) => index >= cellCount) ||
      replay.actions.some((action) => action.cellIndex >= cellCount)
    ) {
      throw new SoloHistoryValidationError([
        `记录 ${record.recordId} 的 replay 格子索引超出棋盘`,
      ]);
    }
    verifySoloReplay(record, replay);
  }
  const recordIds = new Set(records.map((record) => record.recordId));
  const orphan = replays.find((replay) => !recordIds.has(replay.recordId));
  if (orphan) {
    throw new SoloHistoryValidationError([
      `replay ${orphan.recordId} 没有对应运行记录`,
    ]);
  }
  return {
    format: "h-minesweeper-solo-history",
    schemaVersion: SOLO_HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt,
    recordCount: records.length,
    records,
    replays: [...replayById.values()],
  };
}

export function parseSoloHistoryImport(json: string): readonly SoloRunRecord[] {
  return parseSoloHistoryImportDocument(json).records;
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
        if (!request.result.objectStoreNames.contains(REPLAY_STORE_NAME)) {
          request.result.createObjectStore(REPLAY_STORE_NAME, {
            keyPath: "recordId",
          });
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

function readResult(
  rawRecords: readonly unknown[],
  rawReplays: readonly unknown[] = [],
): SoloHistoryReadResult {
  const records = rawRecords
    .filter(isSoloRunRecord)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const recordById = new Map(records.map((record) => [record.recordId, record]));
  const validReplayById = new Map(
    rawReplays.filter(isSoloReplayV1).map((replay) => [replay.recordId, replay]),
  );
  let replayIssueCount = rawReplays.length - validReplayById.size;
  const availableReplayRecordIds: string[] = [];
  for (const replay of validReplayById.values()) {
    if (!recordById.has(replay.recordId)) replayIssueCount += 1;
  }
  for (const record of records) {
    if (
      record.schemaVersion === SOLO_RUN_SCHEMA_VERSION_V2 &&
      record.replay.status !== "UNAVAILABLE"
    ) {
      const replay = validReplayById.get(record.recordId);
      if (!replay) replayIssueCount += 1;
      else {
        try {
          validateReplayPair(record, replay);
          availableReplayRecordIds.push(record.recordId);
        } catch { replayIssueCount += 1; }
      }
    }
  }
  return {
    ...capacity(rawRecords.length),
    records,
    rawRecords,
    invalidRecordCount: rawRecords.length - records.length,
    replayIssueCount,
    availableReplayRecordIds,
  };
}

function readResultFromReplayKeys(
  rawRecords: readonly unknown[],
  replayKeys: readonly IDBValidKey[],
): SoloHistoryReadResult {
  const records = rawRecords
    .filter(isSoloRunRecord)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const recordIds = new Set(records.map(({ recordId }) => recordId));
  const replayIds = new Set(replayKeys.filter((key): key is string => typeof key === "string"));
  let replayIssueCount = [...replayIds].filter((recordId) => !recordIds.has(recordId)).length;
  const availableReplayRecordIds: string[] = [];
  for (const record of records) {
    if (record.schemaVersion !== SOLO_RUN_SCHEMA_VERSION_V2 || record.replay.status === "UNAVAILABLE") continue;
    if (replayIds.has(record.recordId)) availableReplayRecordIds.push(record.recordId);
    else replayIssueCount += 1;
  }
  return {
    ...capacity(rawRecords.length),
    records,
    rawRecords,
    invalidRecordCount: rawRecords.length - records.length,
    replayIssueCount,
    availableReplayRecordIds,
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
      const transaction = db.transaction([RUN_STORE_NAME, REPLAY_STORE_NAME], "readonly");
      const failure: { current?: Error } = {};
      const completed = transactionResult(
        transaction,
        () => undefined,
        "读取本地历史失败，现有记录没有被修改。",
        failure,
      );
      const recordsPromise = requestResult(
        transaction.objectStore(RUN_STORE_NAME).getAll(),
        "读取本地历史失败，现有记录没有被修改。",
      );
      const replayKeysPromise = requestResult(
        transaction.objectStore(REPLAY_STORE_NAME).getAllKeys(),
        "读取本地复盘索引失败，现有记录没有被修改。",
      );
      const [rawRecords, replayKeys] = await Promise.all([
        recordsPromise,
        replayKeysPromise,
      ]);
      await completed;
      return readResultFromReplayKeys(rawRecords, replayKeys);
    },

    async readReplay(recordId) {
      const db = await database();
      const transaction = db.transaction(REPLAY_STORE_NAME, "readonly");
      const failure: { current?: Error } = {};
      const completed = transactionResult(
        transaction,
        () => undefined,
        "读取本地复盘失败，现有记录没有被修改。",
        failure,
      );
      const raw = await requestResult(
        transaction.objectStore(REPLAY_STORE_NAME).get(recordId),
        "读取本地复盘失败，现有记录没有被修改。",
      );
      await completed;
      if (raw === undefined) return null;
      const issues = validateSoloReplayV1(raw);
      if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      return raw;
    },

    async put(record, replay) {
      const issues =
        record.schemaVersion === SOLO_RUN_SCHEMA_VERSION_V2
          ? validateSoloRunRecordV2(record)
          : validateSoloRunRecordV1(record);
      if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      if (replay) {
        const replayIssues = validateSoloReplayV1(replay);
        if (replayIssues.length > 0) {
          throw new SoloHistoryValidationError(replayIssues);
        }
      }
      validateReplayPair(record, replay);
      const db = await database();
      const transaction = db.transaction(
        [RUN_STORE_NAME, REPLAY_STORE_NAME],
        "readwrite",
      );
      const failure: { current?: Error } = {};
      let nextCount = 0;
      const completed = transactionResult(
        transaction,
        () => capacity(nextCount),
        "本局成绩未能写入本地历史，请检查浏览器存储权限或剩余空间。",
        failure,
      );
      const store = transaction.objectStore(RUN_STORE_NAME);
      const replayStore = transaction.objectStore(REPLAY_STORE_NAME);
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
          if (!exists) {
            store.add(record);
            if (replay) replayStore.add(replay);
          } else {
            const existingReplayRequest = replayStore.get(record.recordId);
            existingReplayRequest.addEventListener("success", () => {
              if (
                stableJson(existingReplayRequest.result ?? null) !==
                stableJson(replay ?? null)
              ) {
                failure.current = new SoloHistoryConflictError(record.recordId);
                transaction.abort();
              }
            }, { once: true });
          }
        },
        { once: true },
      );
      return completed;
    },

    async importRecords(rawRecords) {
      const records = validateImportRecords(rawRecords);
      for (const record of records) validateReplayPair(record, undefined);
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
          const additions: SoloRunRecord[] = [];
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

    async importDocument(document) {
      const records = validateImportRecords(document.records);
      const replayById = new Map(
        document.replays.map((replay) => [replay.recordId, replay] as const),
      );
      for (const replay of document.replays) {
        const issues = validateSoloReplayV1(replay);
        if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      }
      for (const record of records) {
        validateReplayPair(record, replayById.get(record.recordId));
      }
      const db = await database();
      const transaction = db.transaction(
        [RUN_STORE_NAME, REPLAY_STORE_NAME],
        "readwrite",
      );
      const failure: { current?: Error } = {};
      let result: SoloHistoryImportResult = {
        ...capacity(0),
        imported: 0,
        skippedIdentical: 0,
      };
      const completed = transactionResult(
        transaction,
        () => result,
        "导入本地历史与复盘失败，整批数据均未写入。",
        failure,
      );
      const runStore = transaction.objectStore(RUN_STORE_NAME);
      const replayStore = transaction.objectStore(REPLAY_STORE_NAME);
      const runRequest = runStore.getAll();
      const replayRequest = replayStore.getAll();
      let ready = 0;
      const applyImport = () => {
        ready += 1;
        if (ready !== 2) return;
        const existingRuns = new Map<string, unknown>();
        for (const value of runRequest.result) {
          if (
            value &&
            typeof value === "object" &&
            "recordId" in value
          ) {
            existingRuns.set(
              String((value as { recordId: unknown }).recordId),
              value,
            );
          }
        }
        const existingReplays = new Map<string, unknown>();
        for (const value of replayRequest.result) {
          if (
            value &&
            typeof value === "object" &&
            "recordId" in value
          ) {
            existingReplays.set(
              String((value as { recordId: unknown }).recordId),
              value,
            );
          }
        }
        const additions: SoloRunRecord[] = [];
        let skippedIdentical = 0;
        for (const record of records) {
          const previous = existingRuns.get(record.recordId);
          const replay = replayById.get(record.recordId);
          const previousReplay = existingReplays.get(record.recordId);
          if (previous === undefined) {
            if (previousReplay !== undefined) {
              failure.current = new SoloHistoryConflictError(record.recordId);
              transaction.abort();
              return;
            }
            additions.push(record);
            continue;
          }
          if (
            stableJson(previous) !== stableJson(record) ||
            stableJson(previousReplay ?? null) !== stableJson(replay ?? null)
          ) {
            failure.current = new SoloHistoryConflictError(record.recordId);
            transaction.abort();
            return;
          }
          skippedIdentical += 1;
        }
        const nextCount = runRequest.result.length + additions.length;
        if (nextCount > SOLO_HISTORY_MAX_RECORDS) {
          failure.current = new SoloHistoryCapacityError(
            `导入后将达到 ${nextCount} 条，超过 10,000 条上限；整批导入已取消，旧数据未删除。`,
          );
          transaction.abort();
          return;
        }
        for (const record of additions) {
          runStore.add(record);
          const replay = replayById.get(record.recordId);
          if (replay) replayStore.add(replay);
        }
        result = {
          ...capacity(nextCount),
          imported: additions.length,
          skippedIdentical,
        };
      };
      runRequest.addEventListener("success", applyImport, { once: true });
      replayRequest.addEventListener("success", applyImport, { once: true });
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
      const transaction = db.transaction(
        [RUN_STORE_NAME, REPLAY_STORE_NAME],
        "readwrite",
      );
      const failure: { current?: Error } = {};
      const completed = transactionResult(
        transaction,
        () => undefined,
        "删除本地历史失败，原记录仍可能保留。",
        failure,
      );
      transaction.objectStore(RUN_STORE_NAME).clear();
      transaction.objectStore(REPLAY_STORE_NAME).clear();
      await completed;
    },
  };
}

export function createMemorySoloHistoryStore(
  initialRecords: readonly unknown[] = [],
  initialLegacyPersonalBestMetadata: readonly unknown[] = [],
): SoloHistoryStore {
  let rawRecords = structuredClone([...initialRecords]);
  let rawReplays: SoloReplayV1[] = [];
  let rawLegacyPersonalBestMetadata = structuredClone([
    ...initialLegacyPersonalBestMetadata,
  ]);
  return {
    async read() {
      return readResult(structuredClone(rawRecords), structuredClone(rawReplays));
    },
    async readReplay(recordId) {
      const replay = rawReplays.find((entry) => entry.recordId === recordId);
      return replay ? structuredClone(replay) : null;
    },
    async put(record, replay) {
      const issues =
        record.schemaVersion === SOLO_RUN_SCHEMA_VERSION_V2
          ? validateSoloRunRecordV2(record)
          : validateSoloRunRecordV1(record);
      if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      if (replay) {
        const replayIssues = validateSoloReplayV1(replay);
        if (replayIssues.length > 0) {
          throw new SoloHistoryValidationError(replayIssues);
        }
      }
      validateReplayPair(record, replay);
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
      const replayIndex = rawReplays.findIndex(
        (entry) => entry.recordId === record.recordId,
      );
      if (index < 0) {
        rawRecords.push(next);
        if (replay) rawReplays.push(structuredClone(replay));
      } else if (
        stableJson(rawRecords[index]) !== stableJson(next) ||
        stableJson(replayIndex < 0 ? null : rawReplays[replayIndex]) !==
          stableJson(replay ?? null)
      ) {
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
    async importDocument(document) {
      const records = validateImportRecords(document.records);
      const replayById = new Map(
        document.replays.map((replay) => [replay.recordId, replay] as const),
      );
      for (const replay of document.replays) {
        const issues = validateSoloReplayV1(replay);
        if (issues.length > 0) throw new SoloHistoryValidationError(issues);
      }
      for (const record of records) {
        validateReplayPair(record, replayById.get(record.recordId));
      }
      const nextRecords = structuredClone(rawRecords);
      const nextReplays = structuredClone(rawReplays);
      let imported = 0;
      let skippedIdentical = 0;
      for (const record of records) {
        const recordIndex = nextRecords.findIndex(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            "recordId" in entry &&
            (entry as { recordId: unknown }).recordId === record.recordId,
        );
        const replay = replayById.get(record.recordId);
        const replayIndex = nextReplays.findIndex(
          (entry) => entry.recordId === record.recordId,
        );
        if (recordIndex < 0) {
          if (replayIndex >= 0) throw new SoloHistoryConflictError(record.recordId);
          nextRecords.push(structuredClone(record));
          if (replay) nextReplays.push(structuredClone(replay));
          imported += 1;
        } else if (
          stableJson(nextRecords[recordIndex]) === stableJson(record) &&
          stableJson(replayIndex < 0 ? null : nextReplays[replayIndex]) ===
            stableJson(replay ?? null)
        ) {
          skippedIdentical += 1;
        } else {
          throw new SoloHistoryConflictError(record.recordId);
        }
      }
      if (nextRecords.length > SOLO_HISTORY_MAX_RECORDS) {
        throw new SoloHistoryCapacityError(
          `导入后将达到 ${nextRecords.length} 条，超过 10,000 条上限；整批导入已取消，旧数据未删除。`,
        );
      }
      rawRecords = nextRecords;
      rawReplays = nextReplays;
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
      rawReplays = [];
    },
  };
}

export function sameSoloConfigurationAndRules(
  record: SoloRunRecord,
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
  records: readonly SoloRunRecord[],
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
  records: readonly SoloRunRecord[],
  replaysOrExportedAt: readonly SoloReplayV1[] | Date = [],
  exportedAt = new Date(),
): SoloHistoryExportV2 {
  const replays = Array.isArray(replaysOrExportedAt)
    ? replaysOrExportedAt
    : [];
  const resolvedExportedAt =
    replaysOrExportedAt instanceof Date ? replaysOrExportedAt : exportedAt;
  const sorted = [...records].sort((left, right) =>
    right.completedAt.localeCompare(left.completedAt),
  );
  return {
    format: "h-minesweeper-solo-history",
    schemaVersion: SOLO_HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt: resolvedExportedAt.toISOString(),
    recordCount: sorted.length,
    records: sorted,
    replays: [...replays].sort((left, right) =>
      left.recordId.localeCompare(right.recordId),
    ),
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
