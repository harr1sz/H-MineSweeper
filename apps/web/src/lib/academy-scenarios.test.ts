import { describe, expect, it } from "vitest";
import { analyzeVisibleBoard } from "@h-minesweeper/game-core";
import {
  ACADEMY_TEACHING_SCENARIOS,
  exerciseForScenario,
  visibleBoardForAcademyExercise,
} from "./academy-scenarios";
import { ACADEMY_CURRICULUM_VERSION, LEARNING_MODULES } from "./learning-contracts";

describe("Academy V3 curriculum", () => {
  it("provides five structured stages for all twelve modules", () => {
    expect(ACADEMY_TEACHING_SCENARIOS).toHaveLength(60);
    for (const module of LEARNING_MODULES) {
      const scenarios = ACADEMY_TEACHING_SCENARIOS.filter(({ conceptId }) => conceptId === module.conceptId);
      expect(scenarios).toHaveLength(5);
      expect(scenarios.map(({ stage }) => stage)).toEqual([
        "DEMO", "GUIDED", "INDEPENDENT", "INDEPENDENT", "CHECKPOINT",
      ]);
      expect(scenarios.at(-1)?.unseenCheckpoint).toBe(true);
    }
  });

  it("keeps boards language neutral, interactive, and versioned", () => {
    for (const scenario of ACADEMY_TEACHING_SCENARIOS) {
      expect(scenario.board.clues).toHaveLength(scenario.board.width * scenario.board.height);
      expect(scenario.interactiveIndexes.length).toBeGreaterThan(0);
      expect(scenario.sourceIndexes.length).toBeGreaterThan(0);
      expect(scenario.minimumCellSize).toBeGreaterThanOrEqual(44);
      expect(scenario.curriculumVersion).toBe(ACADEMY_CURRICULUM_VERSION);
      expect(scenario.copyKeys.title).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it("keeps every authored answer aligned with the production visible-board solver", () => {
    for (const scenario of ACADEMY_TEACHING_SCENARIOS) {
      const analysis = analyzeVisibleBoard(scenario.board, 100_000);
      const safe = new Set(analysis.proofs.filter(({ kind }) => kind === "SAFE").flatMap(({ targets }) => targets));
      const mines = new Set(analysis.proofs.filter(({ kind }) => kind === "MINE").flatMap(({ targets }) => targets));
      for (const expected of scenario.expectedActions) {
        if (expected.action === "REVEAL") expect(safe.has(expected.cellIndex), scenario.id).toBe(true);
        if (expected.action === "FLAG") expect(mines.has(expected.cellIndex), scenario.id).toBe(true);
        if (expected.action === "UNDETERMINED") {
          expect(safe.has(expected.cellIndex) || mines.has(expected.cellIndex), scenario.id).toBe(false);
          expect(analysis.status, scenario.id).toBe("COMPLETE");
        }
      }
    }
  });

  it("binds each rendered exercise to the exact board used for solver analysis", () => {
    for (const scenario of ACADEMY_TEACHING_SCENARIOS) {
      const exercise = exerciseForScenario(scenario);
      expect(exercise.id, scenario.id).toBe(scenario.exerciseId);
      expect(visibleBoardForAcademyExercise(exercise), scenario.id).toEqual(scenario.board);
    }
  });

  it("uses five authored boards per module instead of rotating one answer", () => {
    for (const module of LEARNING_MODULES) {
      const scenarios = ACADEMY_TEACHING_SCENARIOS.filter(({ conceptId }) => conceptId === module.conceptId);
      expect(new Set(scenarios.map(({ exerciseId }) => exerciseId)).size, module.conceptId).toBe(5);
      expect(new Set(scenarios.map(({ board }) => JSON.stringify({
        width: board.width,
        height: board.height,
        clues: board.clues,
        claims: board.playerClaims,
      }))).size, module.conceptId).toBe(5);
      expect(new Set(scenarios.map(({ transform }) => transform)), module.conceptId).toEqual(
        new Set(["IDENTITY", "MIRROR_X", "ROTATE_90", "ROTATE_180"]),
      );
    }
  });
});
