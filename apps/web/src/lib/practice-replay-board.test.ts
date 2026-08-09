import { describe, expect, it } from "vitest";
import { buildPracticeReplayBoardCells } from "./practice-replay-board";

describe("practice replay board state", () => {
  const steps = [
    { revealed: [{ index: 0, value: 0 }, { index: 1, value: 1 }] },
    { revealed: [], flagChange: { index: 2, flagged: true } },
    { revealed: [{ index: 3, value: -1 }] },
  ];

  it("uses the verified cumulative terminal snapshot for the final reveal", () => {
    const cells = buildPracticeReplayBoardCells({
      cellCount: 5,
      initialFlags: [],
      steps,
      selectedIndex: 2,
      showAfter: false,
      showTerminalTruth: true,
      terminalCells: [0, 1, -3, -1, -2],
    });

    expect([...cells]).toEqual([0, 1, -3, -1, -2]);
  });

  it("keeps normal step browsing on the selected before or after state", () => {
    const before = buildPracticeReplayBoardCells({
      cellCount: 5,
      initialFlags: [],
      steps,
      selectedIndex: 1,
      showAfter: false,
      showTerminalTruth: false,
      terminalCells: [0, 1, -3, -1, -2],
    });
    const after = buildPracticeReplayBoardCells({
      cellCount: 5,
      initialFlags: [],
      steps,
      selectedIndex: 1,
      showAfter: true,
      showTerminalTruth: false,
      terminalCells: [0, 1, -3, -1, -2],
    });

    expect([...before]).toEqual([0, 1, -2, -2, -2]);
    expect([...after]).toEqual([0, 1, -3, -2, -2]);
  });

  it("restores question marks and their later removal", () => {
    const questionSteps = [
      { revealed: [], questionChange: { index: 2, questioned: false } },
    ];
    const before = buildPracticeReplayBoardCells({
      cellCount: 4,
      initialFlags: [],
      initialQuestions: [2],
      steps: questionSteps,
      selectedIndex: 0,
      showAfter: false,
      showTerminalTruth: false,
      terminalCells: [-2, -2, -2, -2],
    });
    const after = buildPracticeReplayBoardCells({
      cellCount: 4,
      initialFlags: [],
      initialQuestions: [2],
      steps: questionSteps,
      selectedIndex: 0,
      showAfter: true,
      showTerminalTruth: false,
      terminalCells: [-2, -2, -2, -2],
    });

    expect([...before]).toEqual([-2, -2, -4, -2]);
    expect([...after]).toEqual([-2, -2, -2, -2]);
  });
});
