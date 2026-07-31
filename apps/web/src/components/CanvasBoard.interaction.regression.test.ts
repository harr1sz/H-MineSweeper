import { describe, expect, it } from "vitest";
import { canDoubleClickChord } from "./CanvasBoard";

// Regression: ISSUE-007 — desktop board clicks could scroll the page and had no double-click chord.
// Found by /qa on 2026-07-31.

describe("desktop board interaction semantics", () => {
  it("only treats a double-click on a revealed positive number as a chord", () => {
    expect(canDoubleClickChord(1, 1)).toBe(true);
    expect(canDoubleClickChord(1, 8)).toBe(true);
    expect(canDoubleClickChord(1, 0)).toBe(false);
    expect(canDoubleClickChord(0, 2)).toBe(false);
    expect(canDoubleClickChord(2, 2)).toBe(false);
  });
});
