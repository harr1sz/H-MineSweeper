import { describe, expect, it } from "vitest";
import {
  CELL_FLAGGED,
  CELL_HIDDEN,
  CELL_REVEALED,
  analyzeVisibleBoard,
  hashVisibleBoardState,
  type GameState,
  type VisibleBoardAnalysis,
  type VisibleBoardProof,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import {
  activeAutoFlaggedIndexes,
  coachMineActionForApplicationStep,
  coachMineActionsForApplication,
  coachSuggestionFromAnalysis,
  createCoachRequest,
  coachMineActionsForAutoMark,
  isCoachActionProven,
  isCoachChordProven,
  isCoachSuggestionApplicable,
  parseCoachRequest,
  parseCoachSuggestion,
  PRACTICE_COACH_FULL_SEARCH_FRONTIER_LIMIT,
  runCoachRequest,
  visibleBoardStateForPractice,
  type CoachRequest,
} from "./practice-coach";

function proof(
  stateHash: string,
  rule: VisibleBoardProof["rule"],
  kind: VisibleBoardProof["kind"],
  targets: readonly number[],
  sources: readonly number[] = [],
): VisibleBoardProof {
  return { stateHash, rule, kind, targets, sources };
}

function analysis(
  board: VisibleBoardState,
  proofs: readonly VisibleBoardProof[],
  status: VisibleBoardAnalysis["status"] = "COMPLETE",
): VisibleBoardAnalysis {
  return {
    status,
    proofs,
    stateHash: hashVisibleBoardState(board),
    searchedNodes: 0,
  };
}

describe("practice coach visible-state boundary", () => {
  it("builds a live snapshot without Board, seed, mine map, or hidden clues", () => {
    const state: GameState = {
      board: {
        spec: {
          width: 3,
          height: 1,
          mines: 1,
          seed: "never-send-this-seed",
          startIndex: 0,
          safeRadius: 0,
        },
        mines: Uint8Array.from([0, 1, 0]),
        adjacent: Uint8Array.from([1, 0, 1]),
      },
      visibility: Uint8Array.from([CELL_REVEALED, CELL_HIDDEN, CELL_FLAGGED]),
      revealedSafeCount: 1,
      outcome: "PLAYING",
    };

    const visibleState = visibleBoardStateForPractice(state);
    const request = createCoachRequest(7, visibleState);

    expect(visibleState).toEqual({
      width: 3,
      height: 1,
      totalMines: 1,
      clues: [1, -1, -1],
      playerClaims: [2],
    });
    expect(Object.keys(request).sort()).toEqual(["requestId", "visibleState"]);
    expect(Object.keys(request.visibleState).sort()).toEqual([
      "clues", "height", "playerClaims", "totalMines", "width",
    ]);
    expect(JSON.stringify(request)).not.toContain("never-send-this-seed");
    expect(JSON.stringify(request)).not.toMatch(/"(?:board|seed|mines|boardHash|hiddenTruth)"/u);
  });

  it("rejects untyped attempts to add hidden fields at either payload level", () => {
    const visibleState = {
      width: 2, height: 1, totalMines: 1, clues: [1, -1], playerClaims: [],
    };
    expect(parseCoachRequest({ requestId: 1, visibleState, seed: "secret" })).toBeNull();
    expect(parseCoachRequest({
      requestId: 1,
      visibleState: { ...visibleState, hiddenTruth: [1] },
    })).toBeNull();
    expect(runCoachRequest({ requestId: 9, visibleState, boardHash: "secret" })).toEqual({
      requestId: 9,
      stateHash: "invalid",
      status: "ERROR",
      mineActions: [],
      safeActions: [],
    });
  });

  it("carries only still-flagged coach-proven mines across the worker boundary", () => {
    const state: GameState = {
      board: {
        spec: { width: 3, height: 1, mines: 1, seed: "x", startIndex: 1, safeRadius: 0 },
        mines: Uint8Array.from([1, 0, 0]),
        adjacent: Uint8Array.from([0, 1, 0]),
      },
      visibility: Uint8Array.from([CELL_FLAGGED, CELL_REVEALED, CELL_HIDDEN]),
      revealedSafeCount: 1,
      outcome: "PLAYING",
    };
    const visible = visibleBoardStateForPractice(state, new Set([0, 2]));

    expect(visible).toEqual({
      width: 3,
      height: 1,
      totalMines: 1,
      clues: [-1, 1, -1],
      playerClaims: [0],
      provenMines: [0],
    });
    expect(createCoachRequest(8, visible).visibleState).toEqual(visible);
    expect(parseCoachRequest({
      requestId: 8,
      visibleState: { ...visible, provenMines: [2] },
    })).toBeNull();
  });

  it("rejects malformed worker responses before the UI can show them", () => {
    const visibleState: VisibleBoardState = {
      width: 2, height: 1, totalMines: 1, clues: [1, -1], playerClaims: [],
    };
    const valid = runCoachRequest(createCoachRequest(10, visibleState));
    expect(parseCoachSuggestion(valid)).toEqual(valid);
    expect(parseCoachSuggestion({ ...valid, seed: "hidden" })).toBeNull();
    expect(parseCoachSuggestion({ ...valid, action: "REVEAL" })).toBeNull();
    expect(parseCoachSuggestion({
      ...valid,
      proof: valid.proof && { ...valid.proof, kind: "SAFE" },
    })).toBeNull();
  });

  it("keeps forbidden fields out of the compile-time request contract", () => {
    const visibleState: VisibleBoardState = {
      width: 2, height: 1, totalMines: 1, clues: [1, -1], playerClaims: [],
    };
    // @ts-expect-error A live coach request cannot carry a seed.
    const forbiddenRequest: CoachRequest = { requestId: 1, visibleState, seed: "secret" };
    expect(Object.keys(forbiddenRequest)).toContain("seed");
  });

  it("rejects terminal snapshots rather than treating a detonated mine as a clue", () => {
    const state = {
      board: {
        spec: { width: 1, height: 1, mines: 1, seed: "x", startIndex: 0, safeRadius: 0 },
        mines: Uint8Array.from([1]),
        adjacent: Uint8Array.from([0]),
      },
      visibility: Uint8Array.from([CELL_REVEALED]),
      revealedSafeCount: 0,
      outcome: "LOST",
    } satisfies GameState;
    expect(() => visibleBoardStateForPractice(state)).toThrow(/playing game state/u);
  });
});

describe("practice coach deterministic suggestions", () => {
  it("derives the corner 3 as flags through the generic single constraint", () => {
    const visibleState: VisibleBoardState = {
      width: 2,
      height: 2,
      totalMines: 3,
      clues: [3, -1, -1, -1],
      playerClaims: [],
    };
    const suggestion = runCoachRequest(createCoachRequest(11, visibleState));
    expect(suggestion).toMatchObject({
      requestId: 11,
      status: "READY",
      action: "FLAG",
      cellIndex: 1,
      proof: { rule: "SINGLE_MINE", kind: "MINE" },
    });
    expect(suggestion.mineActions.map(({ cellIndex }) => cellIndex)).toEqual([1, 2, 3]);
    expect(suggestion.mineActions.every(({ proof: mineProof }) =>
      mineProof.rule === "SINGLE_MINE" && mineProof.kind === "MINE"
    )).toBe(true);
    expect(isCoachSuggestionApplicable(suggestion, visibleState)).toBe(true);
  });

  it("derives the middle mines of 1-2-2-1 through subset constraints", () => {
    const visibleState: VisibleBoardState = {
      width: 4,
      height: 2,
      totalMines: 2,
      clues: [-1, -1, -1, -1, 1, 2, 2, 1],
      playerClaims: [],
    };
    const suggestion = runCoachRequest(createCoachRequest(12, visibleState));
    expect(suggestion).toMatchObject({
      status: "READY",
      action: "FLAG",
      cellIndex: 1,
      proof: { rule: "SUBSET_MINE", kind: "MINE" },
    });
    expect(suggestion.mineActions.map(({ cellIndex }) => cellIndex)).toEqual([1, 2]);
  });

  it("keeps maximum-size boards responsive with honest local partial guidance", () => {
    const width = 100;
    const height = 100;
    const clues = Array.from({ length: width * height }, () => -1);
    clues[0] = 3;
    for (const column of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      clues[5_000 + column] = 0;
    }
    const disjointFrontierSize = 3 + 8 * 9;
    expect(disjointFrontierSize).toBeGreaterThan(
      PRACTICE_COACH_FULL_SEARCH_FRONTIER_LIMIT,
    );

    const suggestion = runCoachRequest(createCoachRequest(13, {
      width,
      height,
      totalMines: 999,
      clues,
      playerClaims: [],
    }));

    expect(suggestion).toMatchObject({
      requestId: 13,
      status: "PARTIAL",
      action: "FLAG",
      cellIndex: 1,
      proof: { rule: "SINGLE_MINE", kind: "MINE" },
    });
    expect(suggestion.mineActions.map(({ cellIndex }) => cellIndex)).toEqual([1, 100, 101]);
  });

  it("finds immediate safe moves from proven coach flags on a large partial frontier", () => {
    const width = 100;
    const height = 100;
    const clues = Array.from({ length: width * height }, () => -1);
    clues[1] = 1;
    for (const column of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      clues[5_000 + column] = 1;
    }
    const suggestion = runCoachRequest(createCoachRequest(131, {
      width,
      height,
      totalMines: 999,
      clues,
      playerClaims: [0],
      provenMines: [0],
    }));

    expect(suggestion).toMatchObject({
      requestId: 131,
      status: "PARTIAL",
      action: "REVEAL",
      proof: { rule: "SINGLE_SAFE", kind: "SAFE", sources: [1] },
    });
    expect(suggestion.safeActions.map(({ cellIndex }) => cellIndex))
      .toEqual(expect.arrayContaining([2, 100, 101, 102]));
  });

  it("still runs GLOBAL analysis on a maximum-size board with a tiny frontier", () => {
    const clues = Array.from({ length: 100 * 100 }, () => -1);
    clues[0] = 1;

    const suggestion = runCoachRequest(createCoachRequest(14, {
      width: 100,
      height: 100,
      totalMines: 1,
      clues,
      playerClaims: [],
    }));

    expect(suggestion).toMatchObject({
      requestId: 14,
      status: "READY",
      action: "REVEAL",
      cellIndex: 2,
      proof: { rule: "GLOBAL_SAFE", kind: "SAFE" },
    });
  });

  it("orders rules first, then UNFLAG, FLAG, REVEAL, then cell index", () => {
    const visibleState: VisibleBoardState = {
      width: 5,
      height: 1,
      totalMines: 2,
      clues: [-1, -1, -1, -1, -1],
      playerClaims: [4],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const request = createCoachRequest(13, visibleState);
    const sameRule = coachSuggestionFromAnalysis(request, analysis(visibleState, [
      proof(stateHash, "SUBSET_SAFE", "SAFE", [3]),
      proof(stateHash, "SUBSET_MINE", "MINE", [1]),
      proof(stateHash, "SUBSET_SAFE", "SAFE", [4]),
      proof(stateHash, "SUBSET_MINE", "MINE", [0]),
    ]));
    expect(sameRule).toMatchObject({ action: "UNFLAG", cellIndex: 4 });

    const strongerRule = coachSuggestionFromAnalysis(request, analysis(visibleState, [
      proof(stateHash, "SUBSET_SAFE", "SAFE", [4]),
      proof(stateHash, "SINGLE_SAFE", "SAFE", [3]),
    ]));
    expect(strongerRule).toMatchObject({ action: "REVEAL", cellIndex: 3 });

    const lowestCell = coachSuggestionFromAnalysis(
      createCoachRequest(14, { ...visibleState, playerClaims: [] }),
      analysis({ ...visibleState, playerClaims: [] }, [
        proof(hashVisibleBoardState({ ...visibleState, playerClaims: [] }), "SINGLE_MINE", "MINE", [2, 0]),
      ]),
    );
    expect(lowestCell).toMatchObject({ action: "FLAG", cellIndex: 0 });
  });

  it("keeps every independent safe proof for honest player feedback", () => {
    const visibleState: VisibleBoardState = {
      width: 5,
      height: 1,
      totalMines: 1,
      clues: [-1, -1, -1, -1, -1],
      playerClaims: [],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(29, visibleState),
      analysis(visibleState, [
        proof(stateHash, "SINGLE_SAFE", "SAFE", [1], [0]),
        proof(stateHash, "SINGLE_SAFE", "SAFE", [3], [4]),
      ]),
    );
    expect(suggestion.safeActions.map(({ cellIndex }) => cellIndex)).toEqual([1, 3]);
    expect(isCoachActionProven(suggestion, visibleState, "REVEAL", 1)).toBe(true);
    expect(isCoachActionProven(suggestion, visibleState, "REVEAL", 3)).toBe(true);
  });

  it("reports a complete board with no proof as no forced move", () => {
    const visibleState: VisibleBoardState = {
      width: 3,
      height: 1,
      totalMines: 1,
      clues: [-1, 1, -1],
      playerClaims: [],
    };
    expect(runCoachRequest(createCoachRequest(15, visibleState))).toEqual({
      requestId: 15,
      stateHash: hashVisibleBoardState(visibleState),
      status: "NO_FORCED_MOVE",
      mineActions: [],
      safeActions: [],
    });
  });

  it("suppresses every action when visible constraints contradict one another", () => {
    const visibleState: VisibleBoardState = {
      width: 2,
      height: 1,
      totalMines: 1,
      clues: [0, -1],
      playerClaims: [],
    };
    const suggestion = runCoachRequest(createCoachRequest(16, visibleState));
    expect(suggestion).toEqual({
      requestId: 16,
      stateHash: hashVisibleBoardState(visibleState),
      status: "CONTRADICTION",
      mineActions: [],
      safeActions: [],
    });
    expect(isCoachSuggestionApplicable(suggestion, visibleState)).toBe(false);
  });

  it("stops when player flag claims exceed a visible clue or the global mine count", () => {
    const localContradiction: VisibleBoardState = {
      width: 3,
      height: 1,
      totalMines: 2,
      clues: [-1, 1, -1],
      playerClaims: [0, 2],
    };
    expect(runCoachRequest(createCoachRequest(27, localContradiction))).toMatchObject({
      status: "CONTRADICTION",
      mineActions: [],
    });

    const globalContradiction: VisibleBoardState = {
      width: 3,
      height: 1,
      totalMines: 1,
      clues: [-1, -1, -1],
      playerClaims: [0, 2],
    };
    expect(runCoachRequest(createCoachRequest(28, globalContradiction))).toMatchObject({
      status: "CONTRADICTION",
      mineActions: [],
    });
  });

  it("stops on cross-constraint claim contradictions but not an unfinished CSP", () => {
    const visibleState: VisibleBoardState = {
      width: 7,
      height: 1,
      totalMines: 2,
      clues: [-1, 1, -1, 1, -1, 1, -1],
      playerClaims: [0, 6],
    };
    expect(runCoachRequest(createCoachRequest(29, visibleState))).toMatchObject({
      status: "CONTRADICTION",
      mineActions: [],
      safeActions: [],
    });

    const partial = analyzeVisibleBoard(visibleState, 1);
    expect(coachSuggestionFromAnalysis(
      createCoachRequest(30, visibleState),
      partial,
    )).toMatchObject({ status: "PARTIAL" });
  });

  it("allows only local SINGLE or SUBSET proofs when search is partial", () => {
    const visibleState: VisibleBoardState = {
      width: 4,
      height: 1,
      totalMines: 2,
      clues: [1, -1, -1, -1],
      playerClaims: [],
    };
    const partial = analyzeVisibleBoard(visibleState, 1);
    const local = coachSuggestionFromAnalysis(createCoachRequest(17, visibleState), partial);
    expect(local).toMatchObject({
      status: "PARTIAL",
      action: "FLAG",
      cellIndex: 1,
      proof: { rule: "SINGLE_MINE" },
    });
    expect(isCoachSuggestionApplicable(local, visibleState)).toBe(true);

    const stateHash = hashVisibleBoardState(visibleState);
    const cspOnly = coachSuggestionFromAnalysis(
      createCoachRequest(18, visibleState),
      analysis(
        visibleState,
        [proof(stateHash, "CSP_SAFE", "SAFE", [2])],
        "PARTIAL",
      ),
    );
    expect(cspOnly).toEqual({
      requestId: 18,
      stateHash,
      status: "PARTIAL",
      mineActions: [],
      safeActions: [],
    });
    expect(isCoachSuggestionApplicable(cspOnly, visibleState)).toBe(false);
  });

  it("fails closed for stale analysis and stale UI state", () => {
    const visibleState: VisibleBoardState = {
      width: 2,
      height: 1,
      totalMines: 1,
      clues: [1, -1],
      playerClaims: [],
    };
    const staleState = { ...visibleState, playerClaims: [1] };
    const staleAnalysis = analyzeVisibleBoard(staleState);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(19, visibleState),
      staleAnalysis,
    );
    expect(suggestion.status).toBe("ERROR");

    const current = runCoachRequest(createCoachRequest(20, visibleState));
    expect(isCoachSuggestionApplicable(current, staleState)).toBe(false);
  });

  it("refuses an action that does not match its proof or current claim", () => {
    const visibleState: VisibleBoardState = {
      width: 2,
      height: 1,
      totalMines: 1,
      clues: [1, -1],
      playerClaims: [],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const mineProof = proof(stateHash, "SINGLE_MINE", "MINE", [1], [0]);
    expect(isCoachSuggestionApplicable({
      requestId: 21,
      stateHash,
      status: "READY",
      mineActions: [],
      safeActions: [],
      action: "REVEAL",
      cellIndex: 1,
      proof: mineProof,
    }, visibleState)).toBe(false);
    expect(isCoachSuggestionApplicable({
      requestId: 22,
      stateHash,
      status: "READY",
      mineActions: [],
      safeActions: [],
      action: "UNFLAG",
      cellIndex: 1,
      proof: proof(stateHash, "SINGLE_SAFE", "SAFE", [1], [0]),
    }, visibleState)).toBe(false);
  });

  it("deduplicates and stably orders every currently provable mine", () => {
    const visibleState: VisibleBoardState = {
      width: 4,
      height: 1,
      totalMines: 3,
      clues: [-1, -1, -1, -1],
      playerClaims: [2],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(23, visibleState),
      analysis(visibleState, [
        proof(stateHash, "SUBSET_MINE", "MINE", [3, 1], [0, 2]),
        proof(stateHash, "SINGLE_MINE", "MINE", [1], [0]),
        proof(stateHash, "SINGLE_MINE", "MINE", [2], [0]),
      ]),
    );
    expect(suggestion.mineActions).toEqual([
      { cellIndex: 1, proof: proof(stateHash, "SINGLE_MINE", "MINE", [1], [0]) },
      { cellIndex: 3, proof: proof(stateHash, "SUBSET_MINE", "MINE", [3, 1], [0, 2]) },
    ]);
  });

  it("prepares an all-or-nothing fail-closed auto-mark batch", () => {
    const visibleState: VisibleBoardState = {
      width: 2,
      height: 2,
      totalMines: 3,
      clues: [3, -1, -1, -1],
      playerClaims: [],
    };
    const suggestion = runCoachRequest(createCoachRequest(24, visibleState));
    expect(coachMineActionsForApplication(suggestion, visibleState)
      .map(({ cellIndex }) => cellIndex)).toEqual([1, 2, 3]);

    const staleVisible = { ...visibleState, playerClaims: [1] };
    expect(coachMineActionsForApplication(suggestion, staleVisible)).toEqual([]);

    const tampered = {
      ...suggestion,
      mineActions: suggestion.mineActions.map((mineAction, index) => index === 1
        ? { ...mineAction, cellIndex: 0 }
        : mineAction),
    };
    expect(coachMineActionsForApplication(tampered, visibleState)).toEqual([]);
  });

  it("rebinds each sequential auto-flag proof only after the expected prior flags", () => {
    const initial: VisibleBoardState = {
      width: 2,
      height: 2,
      totalMines: 3,
      clues: [3, -1, -1, -1],
      playerClaims: [],
    };
    const suggestion = runCoachRequest(createCoachRequest(25, initial));
    const first = coachMineActionForApplicationStep(suggestion, initial, initial, 0);
    expect(first).toMatchObject({ cellIndex: 1, proof: { stateHash: suggestion.stateHash } });

    const afterFirst = { ...initial, playerClaims: [1], provenMines: [1] };
    const second = coachMineActionForApplicationStep(suggestion, initial, afterFirst, 1);
    expect(second).toMatchObject({
      cellIndex: 2,
      proof: { stateHash: hashVisibleBoardState(afterFirst) },
    });
    expect(analyzeVisibleBoard(afterFirst).proofs).toContainEqual(second?.proof);

    const afterSecond = {
      ...initial,
      playerClaims: [1, 2],
      provenMines: [1, 2],
    };
    expect(coachMineActionForApplicationStep(suggestion, initial, afterSecond, 2))
      .toMatchObject({ cellIndex: 3 });
    expect(coachMineActionForApplicationStep(
      suggestion,
      initial,
      { ...initial, playerClaims: [3], provenMines: [3] },
      1,
    )).toBeNull();
    expect(coachMineActionForApplicationStep(
      suggestion,
      initial,
      { ...afterFirst, clues: [2, -1, -1, -1] },
      1,
    )).toBeNull();
    expect(coachMineActionForApplicationStep(suggestion, initial, afterFirst, 2))
      .toBeNull();
  });

  it("never exports CSP or GLOBAL mines from a partial analysis", () => {
    const visibleState: VisibleBoardState = {
      width: 3,
      height: 1,
      totalMines: 1,
      clues: [-1, -1, -1],
      playerClaims: [],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(26, visibleState),
      analysis(visibleState, [
        proof(stateHash, "GLOBAL_MINE", "MINE", [0]),
        proof(stateHash, "CSP_MINE", "MINE", [1]),
        proof(stateHash, "SUBSET_MINE", "MINE", [2]),
      ], "PARTIAL"),
    );
    expect(suggestion.status).toBe("PARTIAL");
    expect(suggestion.mineActions.map(({ cellIndex }) => cellIndex)).toEqual([2]);
    expect(coachMineActionsForApplication(suggestion, visibleState)
      .map(({ cellIndex }) => cellIndex)).toEqual([2]);
  });

  it("keeps GLOBAL and CSP mine proofs as guidance but excludes them from automatic marking", () => {
    const visibleState: VisibleBoardState = {
      width: 4,
      height: 1,
      totalMines: 4,
      clues: [-1, -1, -1, -1],
      playerClaims: [],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(27, visibleState),
      analysis(visibleState, [
        proof(stateHash, "SINGLE_MINE", "MINE", [0]),
        proof(stateHash, "SUBSET_MINE", "MINE", [1]),
        proof(stateHash, "GLOBAL_MINE", "MINE", [2]),
        proof(stateHash, "CSP_MINE", "MINE", [3]),
      ]),
    );

    expect(suggestion.mineActions.map(({ cellIndex }) => cellIndex)).toEqual([0, 1, 2, 3]);
    expect(coachMineActionsForAutoMark(suggestion, visibleState)
      .map(({ cellIndex }) => cellIndex)).toEqual([0]);
    expect(isCoachActionProven(suggestion, visibleState, "FLAG", 3)).toBe(true);
  });

  it("automatically marks every single-clue conclusion but leaves subset deductions as hints", () => {
    const visibleState: VisibleBoardState = {
      width: 5,
      height: 1,
      totalMines: 4,
      clues: [-1, -1, -1, -1, -1],
      playerClaims: [],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const firstGroup = proof(stateHash, "SINGLE_MINE", "MINE", [0, 1, 2], [4]);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(28, visibleState),
      analysis(visibleState, [
        firstGroup,
        proof(stateHash, "SUBSET_MINE", "MINE", [3], [4]),
      ]),
    );

    expect(coachMineActionsForAutoMark(suggestion, visibleState)
      .map(({ cellIndex }) => cellIndex)).toEqual([0, 1, 2]);
  });

  it("waits for an intermediate reveal before auto-marking a former subset conclusion", () => {
    const beforeReveal: VisibleBoardState = {
      width: 3,
      height: 2,
      totalMines: 1,
      clues: [1, 2, -1, -1, -1, -1],
      playerClaims: [],
    };
    const beforeHash = hashVisibleBoardState(beforeReveal);
    const subsetSuggestion = coachSuggestionFromAnalysis(
      createCoachRequest(29, beforeReveal),
      analysis(beforeReveal, [
        proof(beforeHash, "SUBSET_MINE", "MINE", [2], [0, 1]),
      ]),
    );
    expect(coachMineActionsForAutoMark(subsetSuggestion, beforeReveal)).toEqual([]);

    const afterReveal: VisibleBoardState = {
      ...beforeReveal,
      clues: [1, 2, -1, -1, 2, -1],
    };
    const afterHash = hashVisibleBoardState(afterReveal);
    const singleSuggestion = coachSuggestionFromAnalysis(
      createCoachRequest(30, afterReveal),
      analysis(afterReveal, [
        proof(afterHash, "SINGLE_MINE", "MINE", [2], [4]),
      ]),
    );
    expect(coachMineActionsForAutoMark(singleSuggestion, afterReveal)
      .map(({ cellIndex }) => cellIndex)).toEqual([2]);
  });

  it("does not expose stale auto-mark dots after their flags are removed", () => {
    expect(activeAutoFlaggedIndexes(
      new Set([3, 1, 2, 99]),
      Uint8Array.from([
        CELL_HIDDEN,
        CELL_FLAGGED,
        CELL_HIDDEN,
        CELL_FLAGGED,
      ]),
    )).toEqual([1, 3]);
  });

  it("proves a chord only when every unflagged covered neighbor has a safe reveal proof", () => {
    const visibleState: VisibleBoardState = {
      width: 3,
      height: 2,
      totalMines: 1,
      clues: [-1, -1, -1, 1, 1, 1],
      playerClaims: [0],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const complete = coachSuggestionFromAnalysis(
      createCoachRequest(31, visibleState),
      analysis(visibleState, [
        proof(stateHash, "SINGLE_SAFE", "SAFE", [1], [3]),
        proof(stateHash, "SUBSET_SAFE", "SAFE", [2], [5, 4]),
      ]),
    );
    expect(isCoachChordProven(complete, visibleState, 4)).toBe(true);

    const missingOneNeighbor = coachSuggestionFromAnalysis(
      createCoachRequest(32, visibleState),
      analysis(visibleState, [
        proof(stateHash, "SINGLE_SAFE", "SAFE", [1], [3]),
      ]),
    );
    expect(isCoachChordProven(missingOneNeighbor, visibleState, 4)).toBe(false);
    expect(isCoachChordProven(complete, visibleState, 0)).toBe(false);
    expect(isCoachChordProven(complete, visibleState, -1)).toBe(false);
    expect(isCoachChordProven(complete, { ...visibleState, playerClaims: [] }, 4))
      .toBe(false);
  });

  it("does not require cells reached later by zero expansion to have proofs", () => {
    const visibleState: VisibleBoardState = {
      width: 5,
      height: 1,
      totalMines: 1,
      clues: [-1, 1, -1, -1, -1],
      playerClaims: [0],
    };
    const stateHash = hashVisibleBoardState(visibleState);
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(33, visibleState),
      analysis(visibleState, [
        proof(stateHash, "SINGLE_SAFE", "SAFE", [2], [1]),
      ]),
    );
    expect(suggestion.safeActions.map(({ cellIndex }) => cellIndex)).toEqual([2]);
    expect(isCoachChordProven(suggestion, visibleState, 1)).toBe(true);
  });

  it("does not treat a number with no unflagged covered neighbor as a proven chord", () => {
    const visibleState: VisibleBoardState = {
      width: 3,
      height: 1,
      totalMines: 2,
      clues: [-1, 2, -1],
      playerClaims: [0, 2],
    };
    const suggestion = coachSuggestionFromAnalysis(
      createCoachRequest(34, visibleState),
      analysis(visibleState, []),
    );
    expect(isCoachChordProven(suggestion, visibleState, 1)).toBe(false);
  });
});
