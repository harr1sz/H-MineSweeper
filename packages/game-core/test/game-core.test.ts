import { describe, expect, it } from "vitest";

import {
  CELL_FLAGGED,
  CELL_HIDDEN,
  CELL_REVEALED,
  CLICK_COUNTING_RULES_VERSION,
  METRIC_RULES_VERSION,
  PRESET_SPECS,
  PROTOCOL_VERSION,
  PROTOTYPE_EXPERT_SEEDS,
  STATISTICS_RULES_VERSION,
  THREE_BV_RULES_VERSION,
  calculate3BV,
  calculate3BVPerSecond,
  calculateCPS,
  calculateGameMetrics,
  calculateGameStatistics,
  calculateIOE,
  certifyNoGuess,
  chordCell,
  countBoardActions,
  createBoard,
  createGameState,
  createXoshiro128StarStar,
  getBoardSpecValidationErrors,
  getDeterministicDeductions,
  getNeighborIndices,
  getProgress,
  hashGameState,
  isProvablySafeCell,
  revealCell,
  solveNoGuess,
  toggleFlag,
  validateBoardSpec,
} from "../src/index.js";
import type { Board, BoardSpec } from "../src/index.js";

function manualBoard(
  width: number,
  height: number,
  mineIndexes: readonly number[],
  startIndex: number,
): Board {
  const mines = new Uint8Array(width * height);
  const adjacent = new Uint8Array(width * height);
  for (const mine of mineIndexes) {
    mines[mine] = 1;
  }
  for (const mine of mineIndexes) {
    for (const neighbor of getNeighborIndices(width, height, mine)) {
      adjacent[neighbor] = (adjacent[neighbor] ?? 0) + 1;
    }
  }
  return {
    spec: {
      width,
      height,
      mines: mineIndexes.length,
      seed: "manual-test-board",
      startIndex,
      safeRadius: 0,
    },
    mines,
    adjacent,
  };
}

describe("public constants and validation", () => {
  it("publishes the fixed protocol, classic presets, and 32 unique seeds", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(PRESET_SPECS.beginner).toEqual({
      width: 9,
      height: 9,
      mines: 10,
      safeRadius: 1,
    });
    expect(PRESET_SPECS.intermediate).toMatchObject({
      width: 16,
      height: 16,
      mines: 40,
    });
    expect(PRESET_SPECS.expert).toMatchObject({
      width: 30,
      height: 16,
      mines: 99,
    });
    expect(PROTOTYPE_EXPERT_SEEDS).toHaveLength(32);
    expect(new Set(PROTOTYPE_EXPERT_SEEDS)).toHaveLength(32);
  });

  it("enforces custom board bounds, density, seed, and safe-area capacity", () => {
    const valid: BoardSpec = {
      width: 100,
      height: 100,
      mines: 4_000,
      seed: "valid",
      startIndex: 0,
      safeRadius: 1,
    };
    expect(validateBoardSpec(valid)).toBe(true);
    expect(getBoardSpecValidationErrors(valid)).toEqual([]);

    expect(validateBoardSpec({ ...valid, width: 101 })).toBe(false);
    expect(validateBoardSpec({ ...valid, mines: 4_001 })).toBe(false);
    expect(validateBoardSpec({ ...valid, seed: "" })).toBe(false);
    expect(validateBoardSpec({ ...valid, startIndex: 10_000 })).toBe(false);
    expect(() => createBoard({ ...valid, mines: 4_001 })).toThrow(
      /Invalid board spec/,
    );
  });
});

describe("deterministic board generation", () => {
  const spec: BoardSpec = {
    ...PRESET_SPECS.intermediate,
    seed: "deterministic-board",
    startIndex: 8 * 16 + 8,
  };

  it("has a stable xoshiro128** golden vector", () => {
    const random = createXoshiro128StarStar("golden-vector-v1");
    expect(Array.from({ length: 8 }, () => random.nextUint32())).toEqual([
      2_716_182_772,
      1_902_188_579,
      3_348_931_982,
      2_850_002_119,
      2_080_749_581,
      2_687_341_308,
      95_302_791,
      3_825_984_988,
    ]);
  });

  it("creates byte-identical boards for one spec", () => {
    const first = createBoard(spec);
    const second = createBoard(spec);

    expect(first.mines).toEqual(second.mines);
    expect(first.adjacent).toEqual(second.adjacent);
    expect(first.spec).not.toBe(spec);
  });

  it("places the exact number of mines outside the 3x3 safe area", () => {
    const board = createBoard(spec);
    expect(board.mines.reduce((sum, value) => sum + value, 0)).toBe(40);

    const startX = spec.startIndex % spec.width;
    const startY = Math.floor(spec.startIndex / spec.width);
    for (let y = startY - 1; y <= startY + 1; y += 1) {
      for (let x = startX - 1; x <= startX + 1; x += 1) {
        expect(board.mines[y * spec.width + x]).toBe(0);
      }
    }
  });

  it("computes correct adjacent counts", () => {
    const board = createBoard(spec);
    for (let index = 0; index < board.mines.length; index += 1) {
      const expected = getNeighborIndices(spec.width, spec.height, index).reduce(
        (sum, neighbor) => sum + (board.mines[neighbor] ?? 0),
        0,
      );
      expect(board.adjacent[index]).toBe(expected);
    }
  });

  it("builds and applies an opening on the 10,000-cell custom-board limit", () => {
    const maximum: BoardSpec = {
      width: 100,
      height: 100,
      mines: 4_000,
      seed: "maximum-custom-board",
      startIndex: 5_050,
      safeRadius: 1,
    };
    const board = createBoard(maximum);
    const state = createGameState(board);
    const opening = revealCell(state, maximum.startIndex);

    expect(board.mines).toHaveLength(10_000);
    expect(board.adjacent).toHaveLength(10_000);
    expect(board.mines.reduce((sum, value) => sum + value, 0)).toBe(4_000);
    expect(opening.accepted).toBe(true);
    expect(opening.hitMine).not.toBe(true);
    expect(hashGameState(state)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("game actions", () => {
  it("reveals zero regions in a stable row-major BFS and wins", () => {
    const board = manualBoard(5, 5, [24], 0);
    const first = createGameState(board);
    const second = createGameState(board);

    const firstDelta = revealCell(first, 0);
    const secondDelta = revealCell(second, 0);

    expect(firstDelta.revealed).toEqual(secondDelta.revealed);
    expect(firstDelta.revealed.slice(0, 9).map(({ index }) => index)).toEqual([
      0, 1, 5, 6, 2, 7, 10, 11, 12,
    ]);
    expect(firstDelta.completed).toBe(true);
    expect(first.outcome).toBe("WON");
    expect(getProgress(first)).toBe(1);
  });

  it("flags, unflags, and rejects revealing a flagged cell", () => {
    const state = createGameState(manualBoard(5, 5, [0], 24));

    expect(toggleFlag(state, 0).flagged).toEqual({ index: 0, flagged: true });
    expect(state.visibility[0]).toBe(CELL_FLAGGED);
    expect(revealCell(state, 0)).toMatchObject({
      accepted: false,
      rejectReason: "FLAGGED",
    });
    expect(toggleFlag(state, 0).flagged).toEqual({ index: 0, flagged: false });
    expect(state.visibility[0]).toBe(CELL_HIDDEN);
  });

  it("chords with the exact flag count and completes a board", () => {
    const state = createGameState(manualBoard(5, 5, [0], 6));
    expect(revealCell(state, 6).accepted).toBe(true);
    expect(toggleFlag(state, 0).accepted).toBe(true);

    const delta = chordCell(state, 6);
    expect(delta.accepted).toBe(true);
    expect(delta.hitMine).not.toBe(true);
    expect(delta.completed).toBe(true);
    expect(state.outcome).toBe("WON");
    expect(state.visibility[0]).toBe(CELL_FLAGGED);
  });

  it("loses a chord deterministically when the correct count flags the wrong cell", () => {
    const state = createGameState(manualBoard(5, 5, [0], 6));
    revealCell(state, 6);
    toggleFlag(state, 1);

    const delta = chordCell(state, 6);
    expect(delta).toMatchObject({
      accepted: true,
      hitMine: true,
      revealed: [{ index: 0, value: -1 }],
    });
    expect(state.outcome).toBe("LOST");
    expect(state.visibility[0]).toBe(CELL_REVEALED);
  });

  it("rejects invalid chord counts without changing state", () => {
    const state = createGameState(manualBoard(5, 5, [0], 6));
    revealCell(state, 6);
    const before = hashGameState(state);
    const delta = chordCell(state, 6);

    expect(delta).toMatchObject({
      accepted: false,
      rejectReason: "FLAG_COUNT_MISMATCH",
    });
    expect(hashGameState(state)).toBe(before);
  });

  it("loses on a directly revealed mine", () => {
    const state = createGameState(manualBoard(5, 5, [0], 24));
    const delta = revealCell(state, 0);

    expect(delta).toMatchObject({
      accepted: true,
      hitMine: true,
      revealed: [{ index: 0, value: -1 }],
    });
    expect(state.outcome).toBe("LOST");
  });

  it("hashes equal states equally and detects a one-cell difference", () => {
    const board = manualBoard(5, 5, [0, 24], 12);
    const first = createGameState(board);
    const second = createGameState(board);
    expect(hashGameState(first)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashGameState(first)).toBe(hashGameState(second));

    toggleFlag(second, 0);
    expect(hashGameState(first)).not.toBe(hashGameState(second));
  });
});

describe("versioned board and player statistics", () => {
  it("computes stable 3BV golden values for openings and isolated numbers", () => {
    expect(calculate3BV(manualBoard(5, 5, [24], 0))).toEqual({
      rulesVersion: THREE_BV_RULES_VERSION,
      value: 1,
      openings: 1,
      isolatedNumbers: 0,
    });
    expect(calculate3BV(manualBoard(3, 3, [4], 0))).toEqual({
      rulesVersion: THREE_BV_RULES_VERSION,
      value: 8,
      openings: 0,
      isolatedNumbers: 8,
    });
    expect(calculate3BV(manualBoard(4, 1, [1], 3))).toEqual({
      rulesVersion: THREE_BV_RULES_VERSION,
      value: 2,
      openings: 1,
      isolatedNumbers: 1,
    });
    expect(calculate3BV(manualBoard(5, 1, [2], 0))).toEqual({
      rulesVersion: THREE_BV_RULES_VERSION,
      value: 2,
      openings: 2,
      isolatedNumbers: 0,
    });
  });

  it("rejects malformed board arrays instead of returning a partial 3BV", () => {
    const valid = manualBoard(3, 3, [4], 0);
    expect(() =>
      calculate3BV({
        ...valid,
        adjacent: new Uint8Array(8),
      }),
    ).toThrow(/Invalid board shape/);
    expect(() =>
      calculate3BV({
        ...valid,
        spec: { ...valid.spec, width: 1.5, height: 6 },
      }),
    ).toThrow(/Invalid board shape/);
  });

  it("separates physical clicks, semantic actions, waste, flags, and unflags", () => {
    expect(
      countBoardActions([
        { actionType: "REVEAL", accepted: true },
        { actionType: "REVEAL", accepted: false },
        {
          actionType: "TOGGLE_FLAG",
          accepted: true,
          flagged: true,
        },
        {
          actionType: "TOGGLE_FLAG",
          accepted: true,
          flagged: false,
        },
        { actionType: "CHORD", accepted: true, physicalClicks: 2 },
        { actionType: "CHORD", accepted: false },
      ]),
    ).toEqual({
      rulesVersion: CLICK_COUNTING_RULES_VERSION,
      countedClicks: 7,
      physicalClicks: 7,
      semanticActions: 6,
      acceptedActions: 4,
      wastedActions: 2,
      rejectedActions: 2,
      reveals: 2,
      flagToggles: 2,
      flags: 1,
      unflags: 1,
      chords: 2,
    });
  });

  it("calculates CPS, IOE, 3BV/s, and efficiency over 100 percent", () => {
    const board = manualBoard(3, 3, [4], 0);
    const actions = [
      { actionType: "REVEAL", accepted: true },
      { actionType: "TOGGLE_FLAG", accepted: true, flagged: true },
      { actionType: "CHORD", accepted: true, physicalClicks: 2 },
      { actionType: "CHORD", accepted: false },
    ] as const;

    expect(calculateCPS(4, 2_000)).toBe(2);
    expect(calculateIOE(8, 4)).toBe(2);
    expect(calculate3BVPerSecond(8, 2_000)).toBe(4);
    expect(calculateGameStatistics({ board, elapsedMs: 2_000, actions }))
      .toEqual({
        metricRulesVersion: METRIC_RULES_VERSION,
        rulesVersion: STATISTICS_RULES_VERSION,
        threeBV: {
          rulesVersion: THREE_BV_RULES_VERSION,
          value: 8,
          openings: 0,
          isolatedNumbers: 8,
        },
        elapsedMs: 2_000,
        board3BV: 8,
        actions: {
          rulesVersion: CLICK_COUNTING_RULES_VERSION,
          countedClicks: 5,
          physicalClicks: 5,
          semanticActions: 4,
          acceptedActions: 3,
          wastedActions: 1,
          rejectedActions: 1,
          reveals: 1,
          flagToggles: 1,
          flags: 1,
          unflags: 0,
          chords: 2,
        },
        cps: 2.5,
        ioe: 1.6,
        efficiencyPercent: 160,
        threeBvPerSecond: 4,
        threeBVPerSecond: 4,
        physicalClicks: 5,
        semanticActions: 4,
        acceptedActions: 3,
        wastedActions: 1,
      });
    expect(calculateGameMetrics({ board, elapsedMs: 2_000, actions }))
      .toEqual({
        metricRulesVersion: METRIC_RULES_VERSION,
        elapsedMs: 2_000,
        board3BV: 8,
        cps: 2.5,
        threeBvPerSecond: 4,
        ioe: 1.6,
        physicalClicks: 5,
        semanticActions: 4,
        acceptedActions: 3,
        wastedActions: 1,
      });
  });

  it("returns null for undefined zero-denominator rates and rejects bad input", () => {
    expect(calculateCPS(0, 0)).toBeNull();
    expect(calculateIOE(8, 0)).toBeNull();
    expect(calculate3BVPerSecond(8, 0)).toBeNull();
    expect(() => calculateCPS(-1, 1_000)).toThrow(/countedClicks/);
    expect(() => calculateIOE(1.5, 1)).toThrow(/threeBV/);
    expect(() => calculate3BVPerSecond(1, Number.NaN)).toThrow(
      /elapsedMs/,
    );
    expect(() =>
      countBoardActions([
        {
          actionType: "CHORD",
          accepted: true,
          physicalClicks: 0,
        },
      ]),
    ).toThrow(/physicalClicks/);
    expect(() =>
      countBoardActions([
        {
          actionType: "INVALID",
          accepted: true,
        },
      ] as never),
    ).toThrow(/Unsupported counted action type/);
  });
});

describe("current-state deterministic deductions", () => {
  it("finds strict-subset safe cells without reading hidden mine truth", () => {
    const state = createGameState(manualBoard(3, 2, [0], 5));
    state.visibility[3] = CELL_REVEALED;
    state.visibility[4] = CELL_REVEALED;
    state.visibility[5] = CELL_REVEALED;
    state.revealedSafeCount = 3;

    const beforeHash = hashGameState(state);
    const deductions = getDeterministicDeductions(state);
    const subset = deductions.find(
      (deduction) =>
        deduction.rule === "SUBSET_SAFE" &&
        deduction.targets.includes(2),
    );

    expect(subset).toMatchObject({
      kind: "SAFE",
      targets: [2],
      stateHash: beforeHash,
    });
    expect(isProvablySafeCell(state, 2)).toBe(true);
    expect(isProvablySafeCell(state, 0)).toBe(false);

    revealCell(state, 2);
    expect(hashGameState(state)).not.toBe(beforeHash);
  });
});

describe("no-guess solver", () => {
  it("certifies every phase-zero Expert seed", () => {
    for (const seed of PROTOTYPE_EXPERT_SEEDS) {
      const board = createBoard({
        ...PRESET_SPECS.expert,
        seed,
        startIndex: 255,
      });
      expect(certifyNoGuess(board), seed).not.toBeNull();
    }
  });

  it("certifies a board solved by deterministic count rules", () => {
    const board = manualBoard(5, 5, [2, 5, 6, 15, 24], 22);
    const result = solveNoGuess(board);
    const certificate = certifyNoGuess(board);

    expect(result.solved).toBe(true);
    expect(result.proof[0]?.rule).toBe("INITIAL_SAFE");
    expect(
      result.proof.some(
        ({ rule }) => rule === "SINGLE_MINE" || rule === "SINGLE_SAFE",
      ),
    ).toBe(true);
    expect(result.proof.some(({ rule }) => rule === "SUBSET_SAFE")).toBe(true);
    expect(certificate).toMatchObject({
      solved: true,
      ruleset: "NG-Competitive-v1",
    });
  });

  it("returns no certificate when the opening requires a guess", () => {
    const board = manualBoard(5, 5, [1, 4, 6, 19], 21);
    const result = solveNoGuess(board);

    expect(result.solved).toBe(false);
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(certifyNoGuess(board)).toBeNull();
  });
});
