import { describe, expect, it } from "vitest";

import {
  buildPracticeLaunchHash,
  parsePracticeLaunchContext,
  practiceErrorCategoryForVerdict,
} from "./practice-launch";

describe("practice launch context", () => {
  it("round-trips a replay-targeted practice launch without carrying the board seed", () => {
    const hash = buildPracticeLaunchHash({
      sourceRecordId: "solo:record-1",
      board: { width: 30, height: 16, mines: 99 },
      originalGenerationMode: "classic",
      errorCategory: "DANGEROUS_CHORD",
      replayStep: 12,
    });

    expect(hash).not.toContain("seed");
    expect(parsePracticeLaunchContext(hash)).toEqual({
      sourceRecordId: "solo:record-1",
      board: { width: 30, height: 16, mines: 99 },
      originalGenerationMode: "classic",
      errorCategory: "DANGEROUS_CHORD",
      replayStep: 12,
    });
  });

  it("rejects malformed or unsafe launch values", () => {
    expect(parsePracticeLaunchContext("#/solo/practice?source=bad%20id&w=999&h=9&m=10&step=0&error=WRONG_FLAG&mode=classic"))
      .toBeNull();
  });

  it("maps replay verdicts to concrete training errors", () => {
    expect(practiceErrorCategoryForVerdict("WRONG_FLAG_CHORD_CHAIN")).toBe("DANGEROUS_CHORD");
    expect(practiceErrorCategoryForVerdict("PROVABLE_SAFE_FLAGGED")).toBe("WRONG_FLAG");
    expect(practiceErrorCategoryForVerdict("PROVABLE_MINE_REVEALED")).toBe("UNPROVEN_GUESS");
    expect(practiceErrorCategoryForVerdict("UNCERTAIN_LOSS")).toBe("UNPROVEN_GUESS");
  });
});
