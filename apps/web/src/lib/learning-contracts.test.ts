import { describe, expect, it } from "vitest";
import {
  ACADEMY_PROGRESS_V2_BACKUP_KEY,
  ACADEMY_PROGRESS_V3_STORAGE_KEY,
  ACADEMY_CURRICULUM_VERSION,
  createEmptyAcademyProgressV3,
  migrateAcademyProgressV2,
  loadAcademyProgressV3,
  recordAcademyScenarioResult,
} from "./learning-contracts";

describe("academy progress v3", () => {
  it("migrates legacy completion to practiced but never mastered", () => {
    const legacy = {
      version: 2,
      completedExerciseIds: ["c0-all-mine", "c2-subset-safe"],
    };
    const migrated = migrateAcademyProgressV2(legacy, 123);
    expect(migrated.skills.FOUNDATIONS_FORCED_RULES).toBe("PRACTICED");
    expect(migrated.skills.REASONING_SUBSETS).toBe("PRACTICED");
    expect(Object.values(migrated.skills)).not.toContain("MASTERED");
    expect(migrated.v2Backup).toEqual(legacy);
  });

  it("allows completion with H7 but requires an unseen low-hint checkpoint for mastery", () => {
    const scenario = {
      id: "checkpoint-a",
      conceptId: "REASONING_SUBSETS" as const,
      unseenCheckpoint: true,
    };
    const demonstrated = recordAcademyScenarioResult(
      createEmptyAcademyProgressV3(), scenario, true, 7,
    );
    expect(demonstrated.completedScenarioIds).toContain(scenario.id);
    expect(demonstrated.skills.REASONING_SUBSETS).toBe("PRACTICED");
    expect(demonstrated.masteredCheckpointIds).not.toContain(scenario.id);

    const mastered = recordAcademyScenarioResult(
      createEmptyAcademyProgressV3(), scenario, true, 0,
    );
    expect(mastered.skills.REASONING_SUBSETS).toBe("MASTERED");
  });

  it("unlocks the next module after a checkpoint without granting mastery through H7", () => {
    const progress = createEmptyAcademyProgressV3();
    expect(progress.skills.FOUNDATIONS_NEIGHBORHOOD).toBe("LOCKED");

    const advanced = recordAcademyScenarioResult(
      progress,
      {
        id: "foundations-operations-checkpoint",
        conceptId: "FOUNDATIONS_OPERATIONS",
        unseenCheckpoint: true,
      },
      true,
      7,
    );

    expect(advanced.skills.FOUNDATIONS_OPERATIONS).toBe("PRACTICED");
    expect(advanced.skills.FOUNDATIONS_NEIGHBORHOOD).toBe("LEARNING");
  });

  it("persists an idempotent v2 to v3 migration and keeps the raw backup", () => {
    const values = new Map<string, string>([
      ["hms-academy-progress-v2", JSON.stringify({ version: 2, completedExerciseIds: ["c1-residual-safe"] })],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = loadAcademyProgressV3(storage);
    const second = loadAcademyProgressV3(storage);
    expect(second).toEqual(first);
    expect(values.get(ACADEMY_PROGRESS_V3_STORAGE_KEY)).toBeDefined();
    expect(values.get(ACADEMY_PROGRESS_V2_BACKUP_KEY)).toBe(values.get("hms-academy-progress-v2"));
  });

  it("downgrades mastery once when a redesigned curriculum is loaded", () => {
    const old = {
      ...createEmptyAcademyProgressV3(100),
      curriculumVersion: 0,
      skills: {
        ...createEmptyAcademyProgressV3(100).skills,
        REASONING_SUBSETS: "MASTERED",
      },
      masteredCheckpointIds: ["old-checkpoint"],
    };
    const values = new Map<string, string>([
      [ACADEMY_PROGRESS_V3_STORAGE_KEY, JSON.stringify(old)],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const migrated = loadAcademyProgressV3(storage);
    const reloaded = loadAcademyProgressV3(storage);
    expect(migrated.curriculumVersion).toBe(ACADEMY_CURRICULUM_VERSION);
    expect(migrated.skills.REASONING_SUBSETS).toBe("PRACTICED");
    expect(migrated.masteredCheckpointIds).toEqual([]);
    expect(migrated.previousCurriculumBackup).toBeDefined();
    expect(reloaded).toEqual(migrated);
  });
});
