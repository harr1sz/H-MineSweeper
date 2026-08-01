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
  analyzeVisibleBoard,
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

describe("visible-board replay solver", () => {
  it("matches an exhaustive oracle across every consistent 3x2 visible position", () => {
    const width = 3;
    const height = 2;
    const cellCount = width * height;
    const bitCount = (mask: number) => {
      let value = mask;
      let count = 0;
      while (value > 0) {
        count += value & 1;
        value >>>= 1;
      }
      return count;
    };

    for (let truth = 1; truth < 1 << cellCount; truth += 1) {
      const totalMines = bitCount(truth);
      if (totalMines > 2) continue;
      const safeMask = ((1 << cellCount) - 1) ^ truth;
      for (let revealed = 1; revealed < 1 << cellCount; revealed += 1) {
        if ((revealed & ~safeMask) !== 0) continue;
        const clues = Array.from({ length: cellCount }, (_, index) => {
          if ((revealed & (1 << index)) === 0) return -1;
          return getNeighborIndices(width, height, index).filter(
            (neighbor) => (truth & (1 << neighbor)) !== 0,
          ).length;
        });
        const candidates: number[] = [];
        for (let candidate = 0; candidate < 1 << cellCount; candidate += 1) {
          if (bitCount(candidate) !== totalMines || (candidate & revealed) !== 0) continue;
          const consistent = clues.every((clue, index) =>
            clue < 0 || getNeighborIndices(width, height, index).filter(
              (neighbor) => (candidate & (1 << neighbor)) !== 0,
            ).length === clue,
          );
          if (consistent) candidates.push(candidate);
        }
        expect(candidates.length).toBeGreaterThan(0);

        const analysis = analyzeVisibleBoard({
          width,
          height,
          totalMines,
          clues,
          playerClaims: [0, 5],
        });
        expect(analysis.status).toBe("COMPLETE");
        const provedSafe = new Set(
          analysis.proofs.filter(({ kind }) => kind === "SAFE").flatMap(({ targets }) => targets),
        );
        const provedMines = new Set(
          analysis.proofs.filter(({ kind }) => kind === "MINE").flatMap(({ targets }) => targets),
        );
        for (let index = 0; index < cellCount; index += 1) {
          if ((revealed & (1 << index)) !== 0) continue;
          const alwaysMine = candidates.every((candidate) => (candidate & (1 << index)) !== 0);
          const alwaysSafe = candidates.every((candidate) => (candidate & (1 << index)) === 0);
          expect(provedMines.has(index)).toBe(alwaysMine);
          expect(provedSafe.has(index)).toBe(alwaysSafe);
        }
      }
    }
  });

  it("matches a bounded exhaustive oracle on deterministic 4x4 and 5x5 samples", () => {
    for (const size of [4, 5]) {
      for (let sample = 1; sample <= 8; sample += 1) {
        const cellCount = size * size;
        let random = sample * 0x9e3779b1;
        const nextRandom = () => {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          return random;
        };
        const mineSet = new Set<number>();
        while (mineSet.size < 3) mineSet.add(nextRandom() % cellCount);
        const safeIndexes = Array.from({ length: cellCount }, (_, index) => index)
          .filter((index) => !mineSet.has(index));
        const revealed = new Set<number>();
        for (const index of safeIndexes) {
          if (cellCount - revealed.size <= 12 || nextRandom() % 3 !== 0) revealed.add(index);
        }
        if (revealed.size === 0) revealed.add(safeIndexes[0]!);
        while (cellCount - revealed.size > 12) {
          const next = safeIndexes.find((index) => !revealed.has(index));
          if (next === undefined) break;
          revealed.add(next);
        }
        const hidden = Array.from({ length: cellCount }, (_, index) => index)
          .filter((index) => !revealed.has(index));
        const clues = Array.from({ length: cellCount }, (_, index) => {
          if (!revealed.has(index)) return -1;
          return getNeighborIndices(size, size, index).filter((neighbor) => mineSet.has(neighbor)).length;
        });
        const candidates: Set<number>[] = [];
        for (let mask = 0; mask < 2 ** hidden.length; mask += 1) {
          const candidate = new Set(hidden.filter((_, bit) => ((mask >> bit) & 1) === 1));
          if (candidate.size !== mineSet.size) continue;
          const consistent = clues.every((clue, index) =>
            clue < 0 || getNeighborIndices(size, size, index).filter((neighbor) => candidate.has(neighbor)).length === clue,
          );
          if (consistent) candidates.push(candidate);
        }
        expect(candidates.length).toBeGreaterThan(0);
        const analysis = analyzeVisibleBoard({
          width: size,
          height: size,
          totalMines: mineSet.size,
          clues,
          playerClaims: hidden.filter((_, index) => index % 4 === 0),
        }, 1_000_000);
        expect(analysis.status).toBe("COMPLETE");
        const provedSafe = new Set(analysis.proofs.filter(({ kind }) => kind === "SAFE").flatMap(({ targets }) => targets));
        const provedMines = new Set(analysis.proofs.filter(({ kind }) => kind === "MINE").flatMap(({ targets }) => targets));
        for (const index of hidden) {
          expect(provedSafe.has(index)).toBe(candidates.every((candidate) => !candidate.has(index)));
          expect(provedMines.has(index)).toBe(candidates.every((candidate) => candidate.has(index)));
        }
      }
    }
  });

  it("treats a player flag as a claim rather than mine truth", () => {
    const base = { width: 3, height: 1, totalMines: 1, clues: [-1, 1, -1] };
    const withoutFlag = analyzeVisibleBoard({ ...base, playerClaims: [] });
    const withFlag = analyzeVisibleBoard({ ...base, playerClaims: [0] });

    expect(withoutFlag.status).toBe("COMPLETE");
    expect(withFlag.status).toBe("COMPLETE");
    expect(withFlag.proofs).toEqual([]);
    expect(withFlag.proofs).toEqual(withoutFlag.proofs);
  });

  it("solves a 2-3-2 frontier without requiring the player to flag known mines", () => {
    const analysis = analyzeVisibleBoard({
      width: 5,
      height: 2,
      totalMines: 3,
      clues: [-1, -1, -1, -1, -1, 1, 2, 3, 2, 1],
      playerClaims: [],
    });
    const safe = new Set(analysis.proofs.filter(({ kind }) => kind === "SAFE").flatMap(({ targets }) => targets));
    const mines = new Set(analysis.proofs.filter(({ kind }) => kind === "MINE").flatMap(({ targets }) => targets));

    expect(analysis.status).toBe("COMPLETE");
    expect([...safe]).toEqual(expect.arrayContaining([0, 4]));
    expect([...mines]).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("cannot change conclusions when hidden truth metadata changes", () => {
    const visible = { width: 3, height: 1, totalMines: 1, clues: [-1, 1, -1], playerClaims: [] };
    const leftMine = analyzeVisibleBoard({ ...visible, hiddenTruth: [0] } as typeof visible);
    const rightMine = analyzeVisibleBoard({ ...visible, hiddenTruth: [2] } as typeof visible);
    expect(leftMine).toEqual(rightMine);
  });

  it("returns proof-bound forced cells and deterministic partial status", () => {
    const forced = analyzeVisibleBoard({
      width: 2, height: 1, totalMines: 1, clues: [1, -1], playerClaims: [],
    });
    expect(forced.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "SINGLE_MINE", targets: [1], kind: "MINE" }),
    ]));

    const partial = analyzeVisibleBoard({
      width: 3, height: 1, totalMines: 1, clues: [-1, 1, -1], playerClaims: [],
    }, 1);
    expect(partial.status).toBe("PARTIAL");
    expect(partial.searchedNodes).toBe(1);
  });

  it("uses the global remaining mine count after frontier constraints", () => {
    const analysis = analyzeVisibleBoard({
      width: 4,
      height: 1,
      totalMines: 1,
      clues: [1, -1, -1, -1],
      playerClaims: [3],
    });
    expect(analysis.status).toBe("COMPLETE");
    expect(analysis.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "SINGLE_MINE", targets: [1] }),
      expect.objectContaining({ rule: "GLOBAL_SAFE", targets: [2, 3] }),
    ]));
  });
});
