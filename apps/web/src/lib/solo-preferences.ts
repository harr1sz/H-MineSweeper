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
export type SoloTimerFormatPreference = "clock" | "seconds";
export type SoloBoardThemePreference =
  | "black-gold"
  | "classic"
  | "high-contrast"
  | "ivory-tactical";

export interface SoloPreferencesV1 {
  readonly schemaVersion: typeof SOLO_PREFERENCES_SCHEMA_VERSION;
  readonly preset: SoloPreset;
  readonly config: SoloBoardConfig;
  readonly statsLevel: SoloStatsLevelPreference;
  readonly boardTheme: SoloBoardThemePreference;
  /** Optional so preferences saved before this setting was introduced remain valid. */
  readonly questionMarksEnabled?: boolean;
  /** Optional so preferences saved before this setting was introduced remain valid. */
  readonly timerFormat?: SoloTimerFormatPreference;
}

export interface SoloPreferenceLoadResult {
  readonly preferences: SoloPreferencesV1 | null;
  readonly errorCode:
    | "INVALID_VERSION"
    | "CORRUPT_DATA"
    | "READ_FAILED"
    | null;
}

export interface ResolvedSoloLaunchPreferences {
  readonly config: SoloBoardConfig;
  readonly preset: SoloPreset;
  readonly statsLevel: SoloStatsLevelPreference;
  readonly boardTheme: SoloBoardThemePreference;
  readonly questionMarksEnabled: boolean;
  readonly timerFormat: SoloTimerFormatPreference;
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
    value === "high-contrast" ||
    value === "ivory-tactical"
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
    (preferences.questionMarksEnabled !== undefined &&
      typeof preferences.questionMarksEnabled !== "boolean") ||
    (preferences.timerFormat !== undefined &&
      preferences.timerFormat !== "clock" &&
      preferences.timerFormat !== "seconds") ||
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
    if (!raw) return { preferences: null, errorCode: null };
    const parsed: unknown = JSON.parse(raw);
    if (!isSoloPreferencesV1(parsed)) {
      return {
        preferences: null,
        errorCode: "INVALID_VERSION",
      };
    }
    return { preferences: parsed, errorCode: null };
  } catch (cause) {
    return {
      preferences: null,
      errorCode:
        cause instanceof SyntaxError
          ? "CORRUPT_DATA"
          : "READ_FAILED",
    };
  }
}

export function saveSoloPreferences(
  preferences: SoloPreferencesV1,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  if (!isSoloPreferencesV1(preferences)) {
    throw new TypeError("INVALID_SOLO_PREFERENCES");
  }
  try {
    if (!storage) throw new Error("localStorage unavailable");
    storage.setItem(SOLO_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (cause) {
    throw new Error("SOLO_PREFERENCES_SAVE_FAILED", {
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
    boardTheme: stored?.boardTheme ?? "classic",
    questionMarksEnabled: stored?.questionMarksEnabled ?? false,
    timerFormat: stored?.timerFormat ?? "clock",
  };
}
