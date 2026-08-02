import { useEffect, useRef } from "react";
import { useLocale } from "../i18n";

export interface ReplayBoardCellState {
  readonly cells: Int8Array;
  readonly proofSources: ReadonlySet<number>;
  readonly suggestedSafe: ReadonlySet<number>;
  readonly suggestedMines: ReadonlySet<number>;
  readonly currentTarget?: number;
  readonly numberedSuggestions: readonly number[];
  readonly detonatedMine?: number;
  readonly otherMines: ReadonlySet<number>;
  readonly correctFlags: ReadonlySet<number>;
  readonly wrongFlags: ReadonlySet<number>;
}

export function ReplayBoard({ width, height, state }: {
  readonly width: number;
  readonly height: number;
  readonly state: ReplayBoardCellState;
}) {
  const { t } = useLocale();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellSize = Math.max(10, Math.min(30, Math.floor(760 / width)));
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = width * cellSize * dpr;
    canvas.height = height * cellSize * dpr;
    canvas.style.width = `${width * cellSize}px`;
    canvas.style.height = `${height * cellSize}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = `700 ${Math.max(8, cellSize * 0.5)}px monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let index = 0; index < state.cells.length; index += 1) {
      const x = (index % width) * cellSize;
      const y = Math.floor(index / width) * cellSize;
      const value = state.cells[index] ?? -2;
      context.fillStyle = value >= -1 ? "#202934" : value === -3 ? "#3b321e" : "#121922";
      context.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      context.strokeStyle = "#394553";
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);
      if (value >= 0) {
        context.fillStyle = value === 0 ? "#72808f" : "#e6edf3";
        context.fillText(value === 0 ? "" : String(value), x + cellSize / 2, y + cellSize / 2);
      } else if (value === -3) {
        context.fillStyle = "#ffd36f";
        context.fillText("⚑", x + cellSize / 2, y + cellSize / 2);
      }
      if (state.otherMines.has(index) || state.detonatedMine === index) {
        context.beginPath();
        context.arc(x + cellSize / 2, y + cellSize / 2, Math.max(2, cellSize * 0.18), 0, Math.PI * 2);
        context.fillStyle = state.detonatedMine === index ? "#ff5368" : "#a75b68";
        context.fill();
      }
      if (state.detonatedMine === index) {
        context.strokeStyle = "#ffffff";
        context.lineWidth = Math.max(2, cellSize * 0.1);
        context.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
      }
      if (state.wrongFlags.has(index)) {
        context.strokeStyle = "#ff5368";
        context.lineWidth = Math.max(2, cellSize * 0.08);
        context.beginPath();
        context.moveTo(x + 4, y + 4); context.lineTo(x + cellSize - 4, y + cellSize - 4);
        context.moveTo(x + cellSize - 4, y + 4); context.lineTo(x + 4, y + cellSize - 4);
        context.stroke();
      }
      if (state.correctFlags.has(index)) {
        context.fillStyle = "#65d58a";
        context.fillText("✓", x + cellSize * 0.75, y + cellSize * 0.3);
      }
      if (state.proofSources.has(index)) {
        context.strokeStyle = "#57b7ff";
        context.lineWidth = Math.max(2, cellSize * 0.09);
        context.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
      }
      if (state.suggestedSafe.has(index) || state.suggestedMines.has(index)) {
        context.setLineDash([2, 2]);
        context.strokeStyle = state.suggestedSafe.has(index) ? "#65d58a" : "#ffb15a";
        context.lineWidth = Math.max(2, cellSize * 0.08);
        context.strokeRect(x + 4, y + 4, cellSize - 8, cellSize - 8);
        context.setLineDash([]);
      }
      if (state.currentTarget === index) {
        context.strokeStyle = "#ffffff";
        context.lineWidth = Math.max(2, cellSize * 0.12);
        context.strokeRect(x + 1.5, y + 1.5, cellSize - 3, cellSize - 3);
      }
      const suggestionNumber = state.numberedSuggestions.indexOf(index);
      if (suggestionNumber >= 0) {
        context.beginPath();
        context.arc(x + cellSize * 0.24, y + cellSize * 0.24, Math.max(6, cellSize * 0.2), 0, Math.PI * 2);
        context.fillStyle = "#f0c46a";
        context.fill();
        context.fillStyle = "#11151a";
        context.font = `800 ${Math.max(8, cellSize * 0.34)}px monospace`;
        context.fillText(String(suggestionNumber + 1), x + cellSize * 0.24, y + cellSize * 0.24);
        context.font = `700 ${Math.max(8, cellSize * 0.5)}px monospace`;
      }
    }
  }, [cellSize, height, state, width]);
  const coordinate = (index: number) => `${Math.floor(index / width) + 1},${(index % width) + 1}`;
  const accessibleParts = [
    state.currentTarget === undefined ? "" : t("replay.a11y.target", { coordinate: coordinate(state.currentTarget) }),
    state.proofSources.size === 0 ? "" : t("replay.a11y.sources", { coordinates: [...state.proofSources].map(coordinate).join("; ") }),
    state.suggestedSafe.size === 0 ? "" : t("replay.a11y.safe", { coordinates: [...state.suggestedSafe].map(coordinate).join("; ") }),
    state.suggestedMines.size === 0 ? "" : t("replay.a11y.mines", { coordinates: [...state.suggestedMines].map(coordinate).join("; ") }),
    state.wrongFlags.size === 0 ? "" : t("replay.a11y.wrongFlags", { coordinates: [...state.wrongFlags].map(coordinate).join("; ") }),
    state.detonatedMine === undefined ? "" : t("replay.a11y.detonated", { coordinate: coordinate(state.detonatedMine) }),
  ].filter(Boolean).join(" ");
  const revealedCellCount = Array.from(state.cells).filter((value) => value >= 0).length;
  const terminalMineCount = state.otherMines.size + (state.detonatedMine === undefined ? 0 : 1);
  return <div className="replay-board-scroll">
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={t("replay.boardAria", { width, height })}
      aria-describedby="replay-board-description"
      data-revealed-cell-count={revealedCellCount}
      data-terminal-mine-count={terminalMineCount}
    />
    <p className="sr-only" id="replay-board-description">{accessibleParts}</p>
  </div>;
}
