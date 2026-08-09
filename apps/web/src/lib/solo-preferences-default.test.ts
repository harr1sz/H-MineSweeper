import { describe, expect, it } from "vitest";
import {
  resolveSoloLaunchPreferences,
  type SoloPreferencesV1,
} from "./solo-preferences";

describe("solo board color defaults", () => {
  it("uses classic for a player without saved preferences", () => {
    expect(resolveSoloLaunchPreferences(null).boardTheme).toBe("classic");
  });

  it("keeps an existing player's saved board color", () => {
    const saved: SoloPreferencesV1 = {
      schemaVersion: 1,
      preset: "beginner",
      config: {
        width: 9,
        height: 9,
        mines: 10,
        mode: "classic",
      },
      statsLevel: "basic",
      boardTheme: "black-gold",
    };

    expect(resolveSoloLaunchPreferences(saved).boardTheme).toBe("black-gold");
  });
});
