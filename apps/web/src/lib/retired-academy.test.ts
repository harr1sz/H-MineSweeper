import { describe, expect, it } from "vitest";
import { purgeRetiredAcademyProgress } from "./retired-academy";

describe("retired Academy storage cleanup", () => {
  it("removes every Academy key and preserves unrelated local data", () => {
    const values = new Map<string, string>([
      ["hms-academy-progress-v2", "v2"],
      ["hms-academy-progress-v2-backup", "backup"],
      ["hms-academy-progress-v3", "v3"],
      ["hms-academy-progress-v4", "v4"],
      ["hms-academy-primer-v1", "primer"],
      ["hms-motion-preference", "reduced"],
      ["hms-display-name", "player"],
    ]);
    const storage = {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
    };

    expect(purgeRetiredAcademyProgress(storage)).toHaveLength(5);
    expect([...values]).toEqual([
      ["hms-motion-preference", "reduced"],
      ["hms-display-name", "player"],
    ]);
  });

  it("does not block startup when browser storage is unavailable", () => {
    const storage = {
      get length(): number { throw new DOMException("blocked"); },
      key: () => null,
      removeItem: () => undefined,
    };
    expect(purgeRetiredAcademyProgress(storage)).toEqual([]);
  });

  it("continues deleting other retired keys when one removal is blocked", () => {
    const values = new Map<string, string>([
      ["hms-academy-progress-v3", "blocked"],
      ["hms-academy-progress-v4", "removable"],
      ["hms-solo-preferences-v1", "keep"],
    ]);
    const storage = {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => {
        if (key === "hms-academy-progress-v3") throw new DOMException("blocked");
        values.delete(key);
      },
    };

    expect(purgeRetiredAcademyProgress(storage)).toEqual([
      "hms-academy-progress-v4",
    ]);
    expect([...values]).toEqual([
      ["hms-academy-progress-v3", "blocked"],
      ["hms-solo-preferences-v1", "keep"],
    ]);
  });
});
