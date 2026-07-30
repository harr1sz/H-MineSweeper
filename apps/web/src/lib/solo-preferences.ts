import {
  SOLO_PRESETS,
  getSoloConfigError,
  type SoloBoardConfig,
  type SoloGenerationMode,
  type SoloPreset,
} from "./solo";

export const SOLO_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const SOLO_PREFERENCES_KEY = "hms-solo-preferences-v1";

export type SoloStatsLevelPreference = "basic" | "advanced" | "analysis";
export type SoloBoardThemePreference =
  | "black-gold"
  | "classic"
  | "high-contrast";

export interface SoloPreferencesV1 {
  readonly schemaVersion: typeof SOLO_PREFERENCES_SCHEMA_VERSION;
  readonly preset: SoloPreset;
  readonly config: SoloBoardConfig;
  readonly statsLevel: SoloStatsLevelPreference;
  readonly boardTheme: SoloBoardThemePreference;
}

export interface SoloPreferenceLoadResult {
  readonly preferences: SoloPreferencesV1 | null;
  readonly error: string | null;
}

export interface ResolvedSoloLaunchPreferences {
  readonly config: SoloBoardConfig;
  readonly preset: SoloPreset;
  readonly statsLevel: SoloStatsLevelPreference;
  readonly boardTheme: SoloBoardThemePreference;
}

function isPreset(value: unknown): value is SoloPreset {
  return (
    value === "beginner" ||
    value === "intermediate" ||
    value === "expert" ||
    value === "custom"
  );
}

function isStatsLevel(value: unknown): value is SoloStatsLevelPreference {
  return value === "basic" || value === "advanced" || value === "analysis";
}

function isBoardTheme(value: unknown): value is SoloBoardThemePreference {
  return (
    value === "black-gold" ||
    value === "classic" ||
    value === "high-contrast"
  );
}

export function isSoloPreferencesV1(value: unknown): value is SoloPreferencesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preferences = value as Partial<SoloPreferencesV1>;
  const config = preferences.config as Partial<SoloBoardConfig> | undefined;
  if (
    preferences.schemaVersion !== SOLO_PREFERENCES_SCHEMA_VERSION ||
    !isPreset(preferences.preset) ||
    !isStatsLevel(preferences.statsLevel) ||
    !isBoardTheme(preferences.boardTheme) ||
    !config ||
    (config.mode !== "classic" && config.mode !== "no_guess")
  ) {
    return false;
  }
  const normalized: SoloBoardConfig = {
    width: Number(config.width),
    height: Number(config.height),
    mines: Number(config.mines),
    mode: config.mode,
  };
  const presetConfig =
    preferences.preset === "custom"
      ? undefined
      : SOLO_PRESETS[preferences.preset];
  return (
    config.width === normalized.width &&
    config.height === normalized.height &&
    config.mines === normalized.mines &&
    getSoloConfigError(normalized) === undefined &&
    (presetConfig === undefined ||
      (presetConfig.width === normalized.width &&
        presetConfig.height === normalized.height &&
        presetConfig.mines === normalized.mines))
  );
}

export function loadSoloPreferences(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): SoloPreferenceLoadResult {
  try {
    const raw = storage?.getItem(SOLO_PREFERENCES_KEY);
    if (!raw) return { preferences: null, error: null };
    const parsed: unknown = JSON.parse(raw);
    if (!isSoloPreferencesV1(parsed)) {
      return {
        preferences: null,
        error:
          "已保存的单人偏好版本无效，已使用安全默认值；原存储内容未自动删除。",
      };
    }
    return { preferences: parsed, error: null };
  } catch (cause) {
    return {
      preferences: null,
      error:
        cause instanceof SyntaxError
          ? "已保存的单人偏好损坏，已使用安全默认值；原存储内容未自动删除。"
          : "无法读取单人偏好，已使用安全默认值；请检查浏览器存储权限。",
    };
  }
}

export function saveSoloPreferences(
  preferences: SoloPreferencesV1,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  if (!isSoloPreferencesV1(preferences)) {
    throw new TypeError("拒绝保存无效的单人偏好。");
  }
  try {
    if (!storage) throw new Error("localStorage unavailable");
    storage.setItem(SOLO_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (cause) {
    throw new Error("单人偏好未能保存；本局可继续，但下次可能恢复为默认值。", {
      cause,
    });
  }
}

export function resolveSoloLaunchPreferences(
  stored: SoloPreferencesV1 | null,
  explicitGenerationMode?: SoloGenerationMode,
): ResolvedSoloLaunchPreferences {
  const generationMode =
    explicitGenerationMode ?? stored?.config.mode ?? "classic";
  const candidate: SoloBoardConfig = {
    ...(stored?.config ?? SOLO_PRESETS.beginner),
    mode: generationMode,
  };
  const valid = getSoloConfigError(candidate) === undefined;
  return {
    config: valid
      ? candidate
      : { ...SOLO_PRESETS.beginner, mode: generationMode },
    preset: valid ? stored?.preset ?? "beginner" : "beginner",
    statsLevel: stored?.statsLevel ?? "basic",
    boardTheme: stored?.boardTheme ?? "black-gold",
  };
}
