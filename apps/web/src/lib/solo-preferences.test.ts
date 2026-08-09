import { describe, expect, it } from "vitest";
import {
  loadSoloPreferences,
  resolveSoloLaunchPreferences,
  saveSoloPreferences,
  type SoloPreferencesV1,
} from "./solo-preferences";

const PREFERENCES: SoloPreferencesV1 = {
  schemaVersion: 1,
  preset: "custom",
  config: {
    width: 20,
    height: 16,
    mines: 60,
    mode: "no_guess",
  },
  statsLevel: "analysis",
  boardTheme: "ivory-tactical",
  questionMarksEnabled: true,
  timerFormat: "seconds",
};

describe("solo preferences", () => {
  it("round trips the latest game and display preferences", () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    saveSoloPreferences(PREFERENCES, storage);
    expect(loadSoloPreferences(storage)).toEqual({
      preferences: PREFERENCES,
      errorCode: null,
    });
  });

  it("reports corrupt preferences without deleting or crashing", () => {
    const result = loadSoloPreferences({
      getItem: () => "{not-json",
    });
    expect(result.preferences).toBeNull();
    expect(result.errorCode).toBe("CORRUPT_DATA");
  });

  it("surfaces storage write failures", () => {
    expect(() =>
      saveSoloPreferences(PREFERENCES, {
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).toThrow("SOLO_PREFERENCES_SAVE_FAILED");
  });

  it("lets an explicit route generation mode override the stored mode", () => {
    expect(resolveSoloLaunchPreferences(PREFERENCES, "classic")).toMatchObject({
      config: {
        width: 20,
        height: 16,
        mines: 60,
        mode: "classic",
      },
      preset: "custom",
    });
    expect(resolveSoloLaunchPreferences(PREFERENCES)).toMatchObject({
      config: { mode: "no_guess" },
    });
  });

  it("keeps older v1 preferences and supplies defaults for new options", () => {
    const legacy: SoloPreferencesV1 = {
      schemaVersion: 1,
      preset: PREFERENCES.preset,
      config: PREFERENCES.config,
      statsLevel: PREFERENCES.statsLevel,
      boardTheme: PREFERENCES.boardTheme,
    };

    expect(resolveSoloLaunchPreferences(legacy)).toMatchObject({
      questionMarksEnabled: false,
      timerFormat: "clock",
    });
  });
});
