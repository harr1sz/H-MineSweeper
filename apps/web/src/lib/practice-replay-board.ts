interface PracticeReplayBoardStep {
  readonly revealed: readonly { readonly index: number; readonly value: number }[];
  readonly flagChange?: { readonly index: number; readonly flagged: boolean };
}

interface PracticeReplayBoardCellsInput {
  readonly cellCount: number;
  readonly initialFlags: readonly number[];
  readonly steps: readonly PracticeReplayBoardStep[];
  readonly selectedIndex: number;
  readonly showAfter: boolean;
  readonly showTerminalTruth: boolean;
  readonly terminalCells: readonly number[];
}

function applyStep(cells: Int8Array, step: PracticeReplayBoardStep | undefined): void {
  if (!step) return;
  for (const cell of step.revealed) cells[cell.index] = cell.value;
  if (step.flagChange) {
    cells[step.flagChange.index] = step.flagChange.flagged ? -3 : -2;
  }
}

export function buildPracticeReplayBoardCells({
  cellCount,
  initialFlags,
  steps,
  selectedIndex,
  showAfter,
  showTerminalTruth,
  terminalCells,
}: PracticeReplayBoardCellsInput): Int8Array {
  if (showTerminalTruth) return Int8Array.from(terminalCells);

  const cells = new Int8Array(cellCount);
  cells.fill(-2);
  for (const index of initialFlags) cells[index] = -3;
  for (let index = 0; index < selectedIndex; index += 1) {
    applyStep(cells, steps[index]);
  }
  if (showAfter) applyStep(cells, steps[selectedIndex]);
  return cells;
}
