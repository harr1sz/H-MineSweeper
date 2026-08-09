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
};

describe("solo preferences", () => {
  it("round trips the latest config, mode, stats level, and theme", () => {
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
});
