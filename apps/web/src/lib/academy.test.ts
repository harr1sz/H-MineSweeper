import { describe, expect, it } from "vitest";
import {
  ACADEMY_EXERCISES,
  ACADEMY_NEIGHBORHOOD_EXERCISES,
  analyzeAcademyExercise,
  createEmptyAcademyProgress,
  evaluateAcademyAnswers,
  getChapterLearningState,
  isAcademyCourseComplete,
  isExerciseMastered,
  isExercisePracticed,
  isChapterUnlocked,
  loadAcademyProgress,
  nextAcademyExercise,
  recordAcademyAttempt,
  saveAcademyProgress,
  transformAcademyExercise,
} from "./academy";

describe("academy content", () => {
  it("keeps every exercise proof-driven and internally valid", () => {
    for (const exercise of [...ACADEMY_EXERCISES, ...ACADEMY_NEIGHBORHOOD_EXERCISES]) {
      expect(exercise.hints).toHaveLength(6);
      expect(exercise.cells).toHaveLength(exercise.width * exercise.height);
      const safe = new Set(exercise.safeTargets);
      for (const index of [...exercise.safeTargets, ...exercise.mineTargets]) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(exercise.cells.length);
        expect(exercise.cells[index]?.kind).toBe("unknown");
      }
      for (const index of exercise.mineTargets) {
        expect(safe.has(index)).toBe(false);
      }
      for (const index of [...exercise.safeTargets, ...exercise.mineTargets]) {
        const x = index % exercise.width;
        const y = Math.floor(index / exercise.width);
        const touchesClue = exercise.cells.some((cell, candidateIndex) => {
          if (cell.kind !== "number") return false;
          const candidateX = candidateIndex % exercise.width;
          const candidateY = Math.floor(candidateIndex / exercise.width);
          return (
            Math.max(
              Math.abs(candidateX - x),
              Math.abs(candidateY - y),
            ) === 1
          );
        });
        expect(touchesClue).toBe(true);
      }
      const proof = analyzeAcademyExercise(exercise);
      expect(proof.solutionCount).toBeGreaterThan(0);
      expect(proof.safeTargets).toEqual(exercise.safeTargets);
      expect(proof.mineTargets).toEqual(exercise.mineTargets);
      expect(proof.trace.rule).toBe(exercise.proofRule);
      expect(proof.proofHash).toHaveLength(8);
      expect(proof.stateHash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("teaches the canonical closed-edge 1-2-1 result", () => {
    const exercise = ACADEMY_EXERCISES.find(
      (entry) => entry.id === "c3-pattern-121",
    );
    const labelIndex = (label: string) => exercise?.cells.findIndex(
      (cell) => cell.kind === "unknown" && cell.label === label,
    );
    expect(exercise?.mineTargets).toEqual([labelIndex("A"), labelIndex("C")]);
    expect(exercise?.safeTargets).toEqual([labelIndex("B")]);
    expect(exercise?.premise).toContain("没有额外未知邻格");
  });

  it("does not publish a bare 2-2 shortcut", () => {
    const corpus = JSON.stringify(ACADEMY_EXERCISES);
    expect(corpus).not.toContain('"2-2"');
  });

  it("uses a real chained 1-1-2 exercise instead of relabeling the subset demo", () => {
    const exercise = ACADEMY_EXERCISES.find(({ id }) => id === "practice-chained-fronts")!;
    const analysis = analyzeAcademyExercise(exercise);
    expect(exercise.cells.filter(({ kind }) => kind === "number").map((cell) => cell.kind === "number" ? cell.value : -1)).toEqual([1, 1, 2]);
    expect(analysis.safeTargets).toHaveLength(2);
    expect(analysis.mineTargets).toHaveLength(2);
  });

  it("keeps beginner-facing Chinese copy free of unexplained internal jargon", () => {
    for (const exercise of [...ACADEMY_EXERCISES, ...ACADEMY_NEIGHBORHOOD_EXERCISES]) {
      const copy = [exercise.title, exercise.objective, exercise.premise, exercise.proof, ...exercise.hints].join(" ");
      expect(copy).not.toMatch(/和弦|多个前沿|接触哪些未开格|\bproof\b/iu);
    }
  });

  it("uses contextual teaching boards instead of one- or two-cell demos", () => {
    for (const exercise of [...ACADEMY_EXERCISES, ...ACADEMY_NEIGHBORHOOD_EXERCISES]) {
      const minimumCells = exercise.chapterId === 0 ? 16 : exercise.chapterId === 1 ? 25 : 30;
      expect(exercise.width * exercise.height).toBeGreaterThanOrEqual(minimumCells);
      expect(exercise.proof).not.toMatch(/\b[A-D]\b|PROOF|STATE|\{[A-D]/u);
    }
  });

  it("preserves every authored conclusion across rotations and mirrors", () => {
    const patterns = ACADEMY_EXERCISES.filter(
      (exercise) => exercise.chapterId >= 2,
    );
    for (const exercise of patterns) {
      for (const transform of [
        "IDENTITY",
        "MIRROR_X",
        "ROTATE_90",
        "ROTATE_180",
      ] as const) {
        const variant = transformAcademyExercise(exercise, transform);
        const proof = analyzeAcademyExercise(variant);
        expect(proof.solutionCount).toBeGreaterThan(0);
        expect(proof.safeTargets).toEqual(variant.safeTargets);
        expect(proof.mineTargets).toEqual(variant.mineTargets);
      }
    }
  });
});

describe("academy progress", () => {
  it("evaluates exact proven targets and rejects guesses", () => {
    const exercise = ACADEMY_EXERCISES.find(
      (entry) => entry.id === "c2-subset-safe",
    )!;
    const safeTarget = exercise.safeTargets[0]!;
    const otherUnknown = exercise.cells.findIndex(
      (cell, index) => cell.kind === "unknown" && index !== safeTarget,
    );
    expect(evaluateAcademyAnswers(exercise, { [safeTarget]: "safe" }).correct).toBe(true);
    expect(evaluateAcademyAnswers(exercise, { [otherUnknown]: "mine", [safeTarget]: "safe" }).correct)
      .toBe(false);
    expect(evaluateAcademyAnswers(exercise, {}).correct).toBe(false);
  });

  it("unlocks chapters sequentially and selects the next exercise", () => {
    let progress = createEmptyAcademyProgress();
    expect(isChapterUnlocked(0, progress)).toBe(true);
    expect(isChapterUnlocked(1, progress)).toBe(false);
    expect(nextAcademyExercise(progress).id).toBe("c0-all-mine");
    for (const exercise of ACADEMY_EXERCISES.filter(
      (entry) => entry.chapterId === 0,
    )) {
      progress = recordAcademyAttempt(progress, exercise, true, 0);
    }
    expect(isChapterUnlocked(1, progress)).toBe(true);
    expect(getChapterLearningState(0, progress)).toBe("LEARNING");
    expect(nextAcademyExercise(progress).chapterId).toBe(1);
  });

  it("does not loop a completed course back to the first exercise", () => {
    let progress = createEmptyAcademyProgress();
    for (const exercise of ACADEMY_EXERCISES.slice(0, -1)) {
      progress = recordAcademyAttempt(progress, exercise, true, 0);
    }
    expect(isAcademyCourseComplete(progress)).toBe(false);
    progress = recordAcademyAttempt(
      progress,
      ACADEMY_EXERCISES.at(-1)!,
      true,
      0,
    );
    expect(isAcademyCourseComplete(progress)).toBe(true);
    expect(nextAcademyExercise(progress).id).toBe(
      ACADEMY_EXERCISES.at(-1)?.id,
    );
  });

  it("requires accuracy, low hints, and orientation coverage for practice", () => {
    const base = ACADEMY_EXERCISES[0]!;
    let progress = createEmptyAcademyProgress();
    const transforms = [
      "IDENTITY",
      "MIRROR_X",
      "ROTATE_90",
      "ROTATE_180",
    ] as const;
    for (let index = 0; index < 10; index += 1) {
      progress = recordAcademyAttempt(
        progress,
        transformAcademyExercise(base, transforms[index % 4]!),
        index !== 9,
        index < 8 ? 2 : 3,
      );
    }
    expect(isExercisePracticed(base.id, progress)).toBe(true);
    expect(isExerciseMastered(base.id, progress)).toBe(false);
  });

  it("reserves mastery for ten perfect no-hint attempts across all variants", () => {
    const base = ACADEMY_EXERCISES[0]!;
    let progress = createEmptyAcademyProgress();
    const transforms = [
      "IDENTITY",
      "MIRROR_X",
      "ROTATE_90",
      "ROTATE_180",
    ] as const;
    for (let index = 0; index < 10; index += 1) {
      progress = recordAcademyAttempt(
        progress,
        transformAcademyExercise(base, transforms[index % 4]!),
        true,
        0,
      );
    }
    expect(isExercisePracticed(base.id, progress)).toBe(true);
    expect(isExerciseMastered(base.id, progress)).toBe(true);
  });

  it("round-trips valid progress and safely rejects corrupt JSON", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const exercise = ACADEMY_EXERCISES[0]!;
    const progress = recordAcademyAttempt(
      createEmptyAcademyProgress(),
      exercise,
      true,
      2,
    );
    saveAcademyProgress(progress, storage);
    expect(loadAcademyProgress(storage).completedExerciseIds).toEqual([
      exercise.id,
    ]);
    values.set("hms-academy-progress-v2", "{broken");
    expect(loadAcademyProgress(storage).completedExerciseIds).toEqual([]);
  });
});
