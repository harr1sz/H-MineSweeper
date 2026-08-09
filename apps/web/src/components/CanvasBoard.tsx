import type { GameState } from "@h-minesweeper/game-core";
import { useLocale } from "../i18n";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { recordMetric } from "../lib/performance";
import type { CoachAction } from "../lib/practice-coach";

export type BoardAction = "REVEAL" | "TOGGLE_FLAG" | "CHORD";

export type BoardTheme = "classic" | "black-gold" | "high-contrast";
export type BoardEffectsProfile = "full" | "lite" | "essential";

export interface BoardInputMeta {
  readonly physicalClicks: number;
  readonly source: "mouse" | "touch" | "pen" | "keyboard";
}

export interface BoardActionVisual {
  readonly id: string | number;
  readonly actionType: BoardAction;
  readonly originIndex: number;
  readonly changedIndexes?: readonly number[];
  readonly accepted?: boolean;
  readonly revealedSafeCount?: number;
}

/**
 * Persistent, visible-state-only coach marks. Callers provide proof sources and
 * the single suggested target; CanvasBoard never derives them from hidden
 * board truth.
 */
export interface BoardCoachOverlay {
  readonly sourceIndexes?: readonly number[] | undefined;
  readonly targetIndex?: number | undefined;
  readonly action?: CoachAction | undefined;
  readonly autoFlaggedIndexes?: readonly number[] | undefined;
}

export interface ResolvedBoardCoachOverlay {
  readonly sourceIndexes: readonly number[];
  readonly targetIndex: number | null;
  readonly action: CoachAction | null;
  readonly autoFlaggedIndexes: readonly number[];
}

export interface BoardCoachOverlayDrawSummary {
  readonly sourceCount: number;
  readonly targetDrawn: boolean;
  readonly autoFlaggedCount: number;
}

export interface BoardPalette {
  readonly canvas: string;
  readonly revealed: string;
  readonly flagged: string;
  readonly mineCell: string;
  readonly pressed: string;
  readonly hiddenA: string;
  readonly hiddenB: string;
  readonly revealedLine: string;
  readonly hiddenLine: string;
  readonly revealedHighlight: string;
  readonly hiddenHighlight: string;
  readonly flag: string;
  readonly mine: string;
  readonly mineCore: string;
  readonly numberStroke: string;
  readonly focus: string;
  readonly focusGuard: string;
  readonly numberColors: readonly string[];
}

export interface CanvasBoardProps {
  game: GameState | null;
  revision: number;
  ariaDescribedBy?: string;
  disabled?: boolean;
  reducedMotion?: boolean;
  showTerminalMines?: boolean;
  terminalDetonatedIndex?: number;
  boardTheme?: BoardTheme;
  effectsProfile?: BoardEffectsProfile;
  actionVisual?: BoardActionVisual;
  coachOverlay?: BoardCoachOverlay | undefined;
  onAction: (
    action: BoardAction,
    cellIndex: number,
    inputMeta: BoardInputMeta,
  ) => void;
  onInputLatency?: (latencyMs: number) => void;
}

const HIDDEN = 0;
const REVEALED = 1;
const FLAGGED = 2;
const MIN_CELL_SIZE = 18;
const MAX_CELL_SIZE = 30;
const COARSE_MAX_CELL_SIZE = 52;
const COARSE_PANNABLE_CELL_SIZE = 32;
const COARSE_ZOOM_MIN_CELL_SIZE = 24;
const ZOOM_STEP = 4;
const DIRTY_REDRAW_THRESHOLD = 0.15;
const MAX_ANIMATED_CELLS = 64;
const MAX_CANVAS_LAYER_PIXELS = 4_000_000;
const LARGE_BOARD_SURFACE_CELL_THRESHOLD = 2_500;
const MAX_COACH_SOURCE_MARKERS = 64;
const MAX_COACH_AUTO_FLAG_MARKERS = 256;

const PALETTES: Readonly<Record<BoardTheme, BoardPalette>> = {
  classic: {
    canvas: "#11161f",
    revealed: "#4b6075",
    flagged: "#332815",
    mineCell: "#4a1d27",
    pressed: "#3a4d63",
    hiddenA: "#172331",
    hiddenB: "#111b27",
    revealedLine: "#71869b",
    hiddenLine: "#30465d",
    revealedHighlight: "#71869b",
    hiddenHighlight: "#51677d",
    flag: "#ffd36f",
    mine: "#ff6f82",
    mineCore: "#141820",
    numberStroke: "#070b11",
    focus: "#f7c66a",
    focusGuard: "#090c11",
    numberColors: [
      "",
      "#74b3ff",
      "#52dfb3",
      "#ff8795",
      "#c3a6ff",
      "#ffc176",
      "#63deef",
      "#ef9cff",
      "#edf2f7",
    ],
  },
  "black-gold": {
    canvas: "#0b0b0d",
    revealed: "#505a66",
    flagged: "#382b13",
    mineCell: "#501c27",
    pressed: "#414650",
    hiddenA: "#171a20",
    hiddenB: "#101319",
    revealedLine: "#7b8490",
    hiddenLine: "#343b46",
    revealedHighlight: "#7b8490",
    hiddenHighlight: "#4c535e",
    flag: "#ffd466",
    mine: "#ff6679",
    mineCore: "#11151c",
    numberStroke: "#060709",
    focus: "#ffd989",
    focusGuard: "#08080a",
    numberColors: [
      "",
      "#79b8ff",
      "#55dfb6",
      "#ff8a98",
      "#c5a9ff",
      "#ffc27a",
      "#65dfef",
      "#eea0ff",
      "#f0ede6",
    ],
  },
  "high-contrast": {
    canvas: "#050506",
    revealed: "#69737f",
    flagged: "#4c3915",
    mineCell: "#651d2b",
    pressed: "#555c68",
    hiddenA: "#191d23",
    hiddenB: "#090c10",
    revealedLine: "#b0b8c2",
    hiddenLine: "#626b78",
    revealedHighlight: "#b0b8c2",
    hiddenHighlight: "#8a929d",
    flag: "#ffe08a",
    mine: "#ff7485",
    mineCore: "#050608",
    numberStroke: "#000000",
    focus: "#ffe7a8",
    focusGuard: "#000000",
    numberColors: [
      "",
      "#8fc5ff",
      "#73e7c2",
      "#ff9eaa",
      "#d0b8ff",
      "#ffd09a",
      "#87e8f3",
      "#f2b4ff",
      "#ffffff",
    ],
  },
};

interface ActiveBoardVisual {
  readonly actionType: BoardAction;
  readonly originIndex: number;
  readonly indexes: readonly number[];
  readonly accepted: boolean;
  readonly startedAt: number;
  readonly durationMs: number;
}

export interface BoardMarkMetrics {
  readonly numberFontSize: number;
  readonly iconSize: number;
  readonly iconLineWidth: number;
}

export function resolveBoardPalette(theme: BoardTheme): BoardPalette {
  return PALETTES[theme];
}

export function resolveBoardMarkMetrics(cellSize: number): BoardMarkMetrics {
  const safeCellSize = Number.isFinite(cellSize) ? Math.max(1, cellSize) : 1;
  return {
    numberFontSize: Math.max(13, Math.floor(safeCellSize * 0.66)),
    iconSize: Math.max(14, safeCellSize * 0.74),
    iconLineWidth: Math.max(1.5, safeCellSize * 0.075),
  };
}

export function resolveBoardAvailableWidth(
  clientWidth: number,
  paddingLeft: number,
  paddingRight: number,
): number {
  const safeClientWidth = Number.isFinite(clientWidth)
    ? Math.max(1, clientWidth)
    : 1;
  const safePaddingLeft = Number.isFinite(paddingLeft)
    ? Math.max(0, paddingLeft)
    : 0;
  const safePaddingRight = Number.isFinite(paddingRight)
    ? Math.max(0, paddingRight)
    : 0;
  return Math.max(
    1,
    Math.floor(safeClientWidth - safePaddingLeft - safePaddingRight - 2),
  );
}

export function resolveResponsiveCellSize(
  availableWidth: number,
  columns: number,
  coarsePointer: boolean,
): number {
  const safeAvailableWidth = Number.isFinite(availableWidth)
    ? Math.max(1, Math.floor(availableWidth))
    : 1;
  const safeColumns = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : 1;
  const fittedSize = Math.floor(safeAvailableWidth / safeColumns);

  if (!coarsePointer) {
    return clamp(fittedSize, MIN_CELL_SIZE, MAX_CELL_SIZE);
  }

  // Beginner boards must fit narrow phones end-to-end. Larger boards keep a
  // usable target size and deliberately pan inside the board viewport.
  if (safeColumns <= 9) {
    return clamp(
      fittedSize,
      COARSE_ZOOM_MIN_CELL_SIZE,
      COARSE_MAX_CELL_SIZE,
    );
  }
  return clamp(
    fittedSize,
    COARSE_PANNABLE_CELL_SIZE,
    COARSE_MAX_CELL_SIZE,
  );
}

export function normalizeChangedIndexes(
  indexes: readonly number[] | undefined,
  cellCount: number,
): number[] {
  if (!indexes || cellCount <= 0) return [];
  const result: number[] = [];
  const seen = new Set<number>();
  for (const index of indexes) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= cellCount ||
      seen.has(index)
    ) {
      continue;
    }
    seen.add(index);
    result.push(index);
  }
  return result;
}

function isCoachAction(value: unknown): value is CoachAction {
  return value === "REVEAL" || value === "FLAG" || value === "UNFLAG";
}

/**
 * Sanitizes coach-provided indexes and bounds overlay work on 10,000-cell
 * custom boards. When a proof has many sources, the closest clues to the
 * target are retained deterministically.
 */
export function resolveBoardCoachOverlay(
  overlay: BoardCoachOverlay | undefined,
  width: number,
  height: number,
): ResolvedBoardCoachOverlay {
  const safeWidth = Number.isSafeInteger(width) && width > 0 ? width : 0;
  const safeHeight = Number.isSafeInteger(height) && height > 0 ? height : 0;
  const cellCount = safeWidth * safeHeight;
  if (!overlay || cellCount <= 0 || !Number.isSafeInteger(cellCount)) {
    return {
      sourceIndexes: [],
      targetIndex: null,
      action: null,
      autoFlaggedIndexes: [],
    };
  }
  const targetIndex = Number.isSafeInteger(overlay.targetIndex) &&
    (overlay.targetIndex as number) >= 0 &&
    (overlay.targetIndex as number) < cellCount &&
    isCoachAction(overlay.action)
    ? overlay.targetIndex as number
    : null;
  const action = targetIndex === null ? null : overlay.action as CoachAction;
  const sourceIndexes = targetIndex === null
    ? []
    : normalizeChangedIndexes(overlay.sourceIndexes, cellCount)
      .filter((index) => index !== targetIndex)
      .sort((left, right) => {
        const targetRow = Math.floor(targetIndex / safeWidth);
        const targetColumn = targetIndex % safeWidth;
        const leftDistance = Math.abs(Math.floor(left / safeWidth) - targetRow) +
          Math.abs((left % safeWidth) - targetColumn);
        const rightDistance = Math.abs(Math.floor(right / safeWidth) - targetRow) +
          Math.abs((right % safeWidth) - targetColumn);
        return leftDistance - rightDistance || left - right;
      })
      .slice(0, MAX_COACH_SOURCE_MARKERS);
  const autoFlaggedIndexes = normalizeChangedIndexes(
    overlay.autoFlaggedIndexes,
    cellCount,
  )
    .sort((left, right) => left - right)
    .slice(0, MAX_COACH_AUTO_FLAG_MARKERS);
  return { sourceIndexes, targetIndex, action, autoFlaggedIndexes };
}

export function shouldRedrawWholeBoard(
  dirtyCellCount: number,
  cellCount: number,
): boolean {
  return (
    cellCount <= 0 ||
    dirtyCellCount >= Math.max(1, Math.ceil(cellCount * DIRTY_REDRAW_THRESHOLD))
  );
}

export function canDoubleClickChord(
  visibility: number,
  adjacent: number,
): boolean {
  return visibility === REVEALED && adjacent > 0;
}

export function resolveCanvasPixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return 1;
  }
  const safeDeviceRatio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const budgetRatio = Math.sqrt(
    MAX_CANVAS_LAYER_PIXELS / (cssWidth * cssHeight),
  );
  return Math.max(0.4, Math.min(safeDeviceRatio, 2, budgetRatio));
}

function limitAnimatedIndexes(
  indexes: readonly number[],
  originIndex: number,
): readonly number[] {
  if (indexes.length <= MAX_ANIMATED_CELLS) return indexes;
  if (originIndex >= 0) return [originIndex];
  return indexes.slice(0, MAX_ANIMATED_CELLS);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cellFromPointer(
  canvas: HTMLCanvasElement,
  event: Pick<PointerEvent, "clientX" | "clientY">,
  width: number,
  height: number,
): number | null {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * width);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * height);
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return y * width + x;
}

function drawFlagMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  metrics: BoardMarkMetrics,
  palette: BoardPalette,
  flagColor = palette.flag,
) {
  const size = metrics.iconSize;
  const poleX = centerX - size * 0.16;
  const top = centerY - size * 0.34;
  const bottom = centerY + size * 0.31;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  context.beginPath();
  context.moveTo(poleX, top);
  context.lineTo(poleX, bottom);
  context.moveTo(centerX - size * 0.32, bottom);
  context.lineTo(centerX + size * 0.14, bottom);
  context.strokeStyle = palette.focusGuard;
  context.lineWidth = metrics.iconLineWidth + 2;
  context.stroke();
  context.strokeStyle = flagColor;
  context.lineWidth = metrics.iconLineWidth;
  context.stroke();

  context.beginPath();
  context.moveTo(poleX + metrics.iconLineWidth * 0.35, top);
  context.lineTo(centerX + size * 0.34, centerY - size * 0.21);
  context.lineTo(poleX + metrics.iconLineWidth * 0.35, centerY + size * 0.02);
  context.closePath();
  context.fillStyle = flagColor;
  context.fill();
  context.strokeStyle = palette.focusGuard;
  context.lineWidth = Math.max(1, metrics.iconLineWidth * 0.55);
  context.stroke();

  context.beginPath();
  context.moveTo(poleX + size * 0.04, top + size * 0.04);
  context.lineTo(centerX + size * 0.22, centerY - size * 0.2);
  context.strokeStyle = "#fff2bd";
  context.lineWidth = Math.max(1, metrics.iconLineWidth * 0.45);
  context.stroke();
  context.restore();
}

function drawMineMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  metrics: BoardMarkMetrics,
  palette: BoardPalette,
) {
  const spikeInner = metrics.iconSize * 0.22;
  const spikeOuter = metrics.iconSize * 0.37;
  const coreRadius = metrics.iconSize * 0.22;

  context.save();
  context.lineCap = "round";
  context.beginPath();
  for (let step = 0; step < 8; step += 1) {
    const angle = (Math.PI * step) / 4;
    context.moveTo(
      centerX + Math.cos(angle) * spikeInner,
      centerY + Math.sin(angle) * spikeInner,
    );
    context.lineTo(
      centerX + Math.cos(angle) * spikeOuter,
      centerY + Math.sin(angle) * spikeOuter,
    );
  }
  context.strokeStyle = palette.mine;
  context.lineWidth = metrics.iconLineWidth;
  context.stroke();

  context.beginPath();
  context.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
  context.fillStyle = palette.mineCore;
  context.fill();
  context.strokeStyle = palette.mine;
  context.lineWidth = metrics.iconLineWidth;
  context.stroke();

  context.beginPath();
  context.arc(
    centerX - coreRadius * 0.32,
    centerY - coreRadius * 0.34,
    Math.max(1.2, metrics.iconLineWidth * 0.72),
    0,
    Math.PI * 2,
  );
  context.fillStyle = "#ffd6dc";
  context.fill();
  context.restore();
}

function drawWrongFlagMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  metrics: BoardMarkMetrics,
  palette: BoardPalette,
) {
  drawFlagMarker(context, centerX, centerY, metrics, palette);
  const radius = metrics.iconSize * 0.34;
  context.save();
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(centerX - radius, centerY - radius);
  context.lineTo(centerX + radius, centerY + radius);
  context.moveTo(centerX + radius, centerY - radius);
  context.lineTo(centerX - radius, centerY + radius);
  context.strokeStyle = palette.focusGuard;
  context.lineWidth = metrics.iconLineWidth + 2.5;
  context.stroke();
  context.strokeStyle = palette.mine;
  context.lineWidth = metrics.iconLineWidth;
  context.stroke();
  context.restore();
}

function drawCorrectFlagMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  metrics: BoardMarkMetrics,
  palette: BoardPalette,
) {
  drawFlagMarker(context, centerX, centerY, metrics, palette);
  context.save();
  context.beginPath();
  context.moveTo(centerX + metrics.iconSize * 0.08, centerY + metrics.iconSize * 0.13);
  context.lineTo(centerX + metrics.iconSize * 0.2, centerY + metrics.iconSize * 0.25);
  context.lineTo(centerX + metrics.iconSize * 0.4, centerY - metrics.iconSize * 0.12);
  context.strokeStyle = "#65d58a";
  context.lineWidth = metrics.iconLineWidth + 1;
  context.stroke();
  context.restore();
}

function coachActionColor(action: CoachAction, palette: BoardPalette): string {
  if (action === "FLAG") return palette.flag;
  if (action === "UNFLAG") return palette.numberColors[5] ?? "#ffc176";
  return palette.numberColors[2] ?? "#52dfb3";
}

function drawCoachActionBadge(
  context: CanvasRenderingContext2D,
  action: CoachAction,
  x: number,
  y: number,
  cellSize: number,
  color: string,
  palette: BoardPalette,
): void {
  const radius = clamp(cellSize * 0.16, 2.8, 5.2);
  const centerX = x + cellSize - radius - 2.2;
  const centerY = y + radius + 2.2;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = palette.focusGuard;
  context.lineWidth = Math.max(1, cellSize * 0.045);
  context.stroke();

  context.strokeStyle = palette.focusGuard;
  context.fillStyle = palette.focusGuard;
  context.lineWidth = Math.max(1, cellSize * 0.055);
  context.lineCap = "round";
  if (action === "REVEAL") {
    context.beginPath();
    context.arc(centerX, centerY, Math.max(1, radius * 0.3), 0, Math.PI * 2);
    context.fill();
    return;
  }
  if (action === "FLAG") {
    context.beginPath();
    context.moveTo(centerX - radius * 0.3, centerY + radius * 0.45);
    context.lineTo(centerX - radius * 0.3, centerY - radius * 0.48);
    context.lineTo(centerX + radius * 0.45, centerY - radius * 0.17);
    context.lineTo(centerX - radius * 0.3, centerY + radius * 0.05);
    context.closePath();
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(centerX - radius * 0.34, centerY - radius * 0.34);
  context.lineTo(centerX + radius * 0.34, centerY + radius * 0.34);
  context.moveTo(centerX + radius * 0.34, centerY - radius * 0.34);
  context.lineTo(centerX - radius * 0.34, centerY + radius * 0.34);
  context.stroke();
}

function drawCoachAutoFlagMarker(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellSize: number,
  palette: BoardPalette,
): void {
  const radius = clamp(cellSize * 0.12, 2.2, 4);
  const centerX = x + cellSize - radius - 2;
  const centerY = y + cellSize - radius - 2;
  context.beginPath();
  context.moveTo(centerX, centerY - radius);
  context.lineTo(centerX + radius, centerY);
  context.lineTo(centerX, centerY + radius);
  context.lineTo(centerX - radius, centerY);
  context.closePath();
  context.fillStyle = palette.focus;
  context.fill();
  context.strokeStyle = palette.focusGuard;
  context.lineWidth = Math.max(1, cellSize * 0.04);
  context.stroke();
}

/**
 * Draws static coach marks on the dedicated coach layer. It intentionally accepts no
 * GameState, so the renderer cannot inspect a mine map or hidden clue value.
 */
export function drawBoardCoachOverlay(
  context: CanvasRenderingContext2D,
  overlay: BoardCoachOverlay | undefined,
  width: number,
  height: number,
  cellSize: number,
  palette: BoardPalette,
): BoardCoachOverlayDrawSummary {
  const resolved = resolveBoardCoachOverlay(overlay, width, height);
  const safeCellSize = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 0;
  if (safeCellSize === 0) {
    return { sourceCount: 0, targetDrawn: false, autoFlaggedCount: 0 };
  }
  context.save();
  context.lineJoin = "round";
  const sourceColor = palette.numberColors[1] ?? "#74b3ff";
  context.setLineDash([
    Math.max(2, safeCellSize * 0.18),
    Math.max(1.5, safeCellSize * 0.12),
  ]);
  for (const index of resolved.sourceIndexes) {
    const x = (index % width) * safeCellSize;
    const y = Math.floor(index / width) * safeCellSize;
    context.globalAlpha = 0.1;
    context.fillStyle = sourceColor;
    context.fillRect(x + 2, y + 2, safeCellSize - 4, safeCellSize - 4);
    context.globalAlpha = 0.88;
    context.strokeStyle = sourceColor;
    context.lineWidth = Math.max(1.2, safeCellSize * 0.055);
    context.strokeRect(x + 2.5, y + 2.5, safeCellSize - 5, safeCellSize - 5);
  }

  context.setLineDash([]);
  context.globalAlpha = 1;
  for (const index of resolved.autoFlaggedIndexes) {
    const x = (index % width) * safeCellSize;
    const y = Math.floor(index / width) * safeCellSize;
    drawCoachAutoFlagMarker(context, x, y, safeCellSize, palette);
  }

  if (resolved.targetIndex !== null && resolved.action !== null) {
    const x = (resolved.targetIndex % width) * safeCellSize;
    const y = Math.floor(resolved.targetIndex / width) * safeCellSize;
    const color = coachActionColor(resolved.action, palette);
    context.globalAlpha = 0.14;
    context.fillStyle = color;
    context.fillRect(x + 1.5, y + 1.5, safeCellSize - 3, safeCellSize - 3);
    context.globalAlpha = 1;
    context.strokeStyle = palette.focusGuard;
    context.lineWidth = Math.max(3.5, safeCellSize * 0.16);
    context.strokeRect(x + 2, y + 2, safeCellSize - 4, safeCellSize - 4);
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, safeCellSize * 0.09);
    context.strokeRect(x + 2.5, y + 2.5, safeCellSize - 5, safeCellSize - 5);
    drawCoachActionBadge(
      context,
      resolved.action,
      x,
      y,
      safeCellSize,
      color,
      palette,
    );
  }
  context.restore();
  return {
    sourceCount: resolved.sourceIndexes.length,
    targetDrawn: resolved.targetIndex !== null,
    autoFlaggedCount: resolved.autoFlaggedIndexes.length,
  };
}

export function CanvasBoard({
  game,
  revision,
  ariaDescribedBy,
  disabled = false,
  reducedMotion = false,
  showTerminalMines = false,
  terminalDetonatedIndex,
  boardTheme = "black-gold",
  effectsProfile = "full",
  actionVisual,
  coachOverlay,
  onAction,
  onInputLatency,
}: CanvasBoardProps) {
  const { t } = useLocale();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const coachCanvasRef = useRef<HTMLCanvasElement>(null);
  const actionRef = useRef(onAction);
  const latencyRef = useRef(onInputLatency);
  const pendingActionPaintsRef = useRef<number[]>([]);
  const pendingPressPaintsRef = useRef<number[]>([]);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const activeTouchPointersRef = useRef(new Set<number>());
  const pinchGestureRef = useRef(false);
  const touchGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const chordTriggeredRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const lastAnimationFrameAtRef = useRef<number | null>(null);
  const activeVisualRef = useRef<ActiveBoardVisual | null>(null);
  const lastActionVisualIdRef = useRef<string | number | null>(null);
  const lastDrawnActionVisualIdRef = useRef<string | number | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const previousVisibilityRef = useRef<Uint8Array | null>(null);
  const previousGameRef = useRef<GameState | null>(null);
  const previousRevisionRef = useRef<number | null>(null);
  const previousFocusRef = useRef<number | null>(null);
  const previousPressedRef = useRef<number | null>(null);
  const previousOutcomeRef = useRef<GameState["outcome"] | null>(null);
  const previousThemeRef = useRef<BoardTheme | null>(null);
  const [baseCellSize, setBaseCellSize] = useState(24);
  const [zoomOffset, setZoomOffset] = useState(0);
  const [coarsePointer] = useState(
    () =>
      window.matchMedia("(pointer: coarse)").matches ||
      window.innerWidth <= 680,
  );
  const [pressedIndex, setPressedIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  actionRef.current = onAction;
  latencyRef.current = onInputLatency;

  const dimensions = game?.board.spec;
  const width = dimensions?.width ?? 30;
  const height = dimensions?.height ?? 16;
  const cellCount = width * height;
  const cellSize = clamp(
    baseCellSize + zoomOffset,
    coarsePointer ? COARSE_ZOOM_MIN_CELL_SIZE : MIN_CELL_SIZE,
    coarsePointer ? COARSE_MAX_CELL_SIZE : MAX_CELL_SIZE,
  );
  const palette = resolveBoardPalette(boardTheme);
  const effectiveEffectsProfile = reducedMotion ? "essential" : effectsProfile;

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateSize = () => {
      const computedStyle = window.getComputedStyle(wrapper);
      const available = resolveBoardAvailableWidth(
        wrapper.clientWidth,
        Number.parseFloat(computedStyle.paddingLeft),
        Number.parseFloat(computedStyle.paddingRight),
      );
      setBaseCellSize(
        resolveResponsiveCellSize(available, width, coarsePointer),
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [coarsePointer, width]);

  useEffect(() => {
    const lastIndex = Math.max(0, width * height - 1);
    setFocusIndex((current) => Math.min(current, lastIndex));
    setPressedIndex(null);
    previousVisibilityRef.current = null;
    previousGameRef.current = null;
    previousRevisionRef.current = null;
    previousFocusRef.current = null;
    previousPressedRef.current = null;
    previousOutcomeRef.current = null;
    setZoomOffset(0);
  }, [height, width]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas || width <= 0 || height <= 0) return;

    const x = focusIndex % width;
    const y = Math.floor(focusIndex / width);
    const cellLeft = canvas.offsetLeft + x * cellSize;
    const cellTop = canvas.offsetTop + y * cellSize;
    const cellRight = cellLeft + cellSize;
    const cellBottom = cellTop + cellSize;
    const viewportRight = wrapper.scrollLeft + wrapper.clientWidth;
    const viewportBottom = wrapper.scrollTop + wrapper.clientHeight;

    if (cellLeft < wrapper.scrollLeft) {
      wrapper.scrollLeft = Math.max(0, cellLeft - cellSize);
    } else if (cellRight > viewportRight) {
      wrapper.scrollLeft = cellRight - wrapper.clientWidth + cellSize;
    }
    if (cellTop < wrapper.scrollTop) {
      wrapper.scrollTop = Math.max(0, cellTop - cellSize);
    } else if (cellBottom > viewportBottom) {
      wrapper.scrollTop = cellBottom - wrapper.clientHeight + cellSize;
    }
  }, [cellSize, focusIndex, height, width]);

  useEffect(() => {
    if (
      !actionVisual ||
      actionVisual.id === lastActionVisualIdRef.current
    ) {
      return;
    }
    lastActionVisualIdRef.current = actionVisual.id;

    const indexes = normalizeChangedIndexes(
      actionVisual.changedIndexes,
      cellCount,
    );
    const originIndex =
      actionVisual.originIndex >= 0 && actionVisual.originIndex < cellCount
        ? actionVisual.originIndex
        : -1;
    if (originIndex >= 0 && !indexes.includes(originIndex)) {
      indexes.push(originIndex);
    }
    if (indexes.length === 0 && originIndex < 0) {
      activeVisualRef.current = null;
      return;
    }

    const accepted = actionVisual.accepted !== false;
    const durationMs =
      effectiveEffectsProfile === "essential"
        ? 0
        : actionVisual.actionType === "CHORD"
          ? effectiveEffectsProfile === "full" ? 150 : 110
          : effectiveEffectsProfile === "full" ? 110 : 80;
    activeVisualRef.current = {
      actionType: actionVisual.actionType,
      originIndex,
      indexes: limitAnimatedIndexes(indexes, originIndex),
      accepted,
      startedAt: performance.now(),
      durationMs,
    };
  }, [actionVisual, cellCount, effectiveEffectsProfile]);

  useEffect(() => {
    if (effectiveEffectsProfile !== "essential") return;
    activeVisualRef.current = null;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, [effectiveEffectsProfile]);

  const draw = useCallback(() => {
    const drawStartedAt = performance.now();
    const canvas = canvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const coachCanvas = coachCanvasRef.current;
    if (!canvas || !overlayCanvas || (coachOverlay !== undefined && !coachCanvas)) return;

    const cssWidth = width * cellSize;
    const cssHeight = height * cellSize;
    const dpr = resolveCanvasPixelRatio(
      cssWidth,
      cssHeight,
      window.devicePixelRatio || 1,
    );
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    let resized = false;
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      resized = true;
    }
    if (
      overlayCanvas.width !== pixelWidth ||
      overlayCanvas.height !== pixelHeight
    ) {
      overlayCanvas.width = pixelWidth;
      overlayCanvas.height = pixelHeight;
      overlayCanvas.style.width = `${cssWidth}px`;
      overlayCanvas.style.height = `${cssHeight}px`;
      resized = true;
    }
    if (
      coachCanvas &&
      (coachCanvas.width !== pixelWidth || coachCanvas.height !== pixelHeight)
    ) {
      coachCanvas.width = pixelWidth;
      coachCanvas.height = pixelHeight;
      coachCanvas.style.width = `${cssWidth}px`;
      coachCanvas.style.height = `${cssHeight}px`;
      resized = true;
    }

    const context = canvas.getContext("2d", { alpha: false });
    const overlayContext = overlayCanvas.getContext("2d");
    const coachContext = coachCanvas?.getContext("2d") ?? null;
    if (!context || !overlayContext || (coachCanvas && !coachContext)) return;
    const markMetrics = resolveBoardMarkMetrics(cellSize);
    const autoFlaggedIndexSet = new Set(normalizeChangedIndexes(
      coachOverlay?.autoFlaggedIndexes,
      cellCount,
    ));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `900 ${markMetrics.numberFontSize}px "JetBrains Mono", "SFMono-Regular", monospace`;
    context.lineJoin = "round";

    const resolveVisibility = (
      storedVisibility: number,
      hasMine: boolean,
    ) =>
      showTerminalMines &&
      game?.outcome === "LOST" &&
      hasMine &&
      storedVisibility === HIDDEN
        ? REVEALED
        : showTerminalMines &&
            game?.outcome === "WON" &&
            hasMine &&
            storedVisibility === HIDDEN
          ? FLAGGED
          : storedVisibility;

    const drawCell = (index: number, drawSurface = true) => {
      const x = (index % width) * cellSize;
      const y = Math.floor(index / width) * cellSize;
      const storedVisibility = game?.visibility[index] ?? HIDDEN;
      const hasMine = game?.board.mines[index] === 1;
      const visibility = resolveVisibility(storedVisibility, hasMine);
      const wrongFlag =
        showTerminalMines &&
        game?.outcome === "LOST" &&
        storedVisibility === FLAGGED &&
        !hasMine;
      const correctFlag =
        showTerminalMines &&
        game?.outcome !== "PLAYING" &&
        storedVisibility === FLAGGED &&
        hasMine;
      const isPressed = index === pressedIndex;
      const isFocused = index === focusIndex;

      if (drawSurface) {
        if (visibility === REVEALED) {
          context.fillStyle = hasMine ? palette.mineCell : palette.revealed;
        } else if (visibility === FLAGGED) {
          context.fillStyle = palette.flagged;
        } else if (isPressed) {
          context.fillStyle = palette.pressed;
        } else {
          context.fillStyle = (index + Math.floor(index / width)) % 2 === 0
            ? palette.hiddenA
            : palette.hiddenB;
        }
        context.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);

        context.strokeStyle =
          visibility === REVEALED
            ? palette.revealedLine
            : palette.hiddenLine;
        context.lineWidth = 1;
        context.strokeRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);

        if (cellCount <= 2_500 && cellSize > MIN_CELL_SIZE) {
          context.beginPath();
          context.moveTo(x + 2.5, y + 2.5);
          context.lineTo(x + cellSize - 2.5, y + 2.5);
          context.strokeStyle =
            visibility === REVEALED
              ? palette.revealedHighlight
              : palette.hiddenHighlight;
          context.lineWidth = Math.max(1, cellSize * 0.045);
          context.stroke();
        }
      }

      const centerX = x + cellSize / 2;
      const centerY = y + cellSize / 2;
      if (wrongFlag) {
        drawWrongFlagMarker(
          context,
          centerX,
          centerY,
          markMetrics,
          palette,
        );
      } else if (correctFlag) {
        drawCorrectFlagMarker(context, centerX, centerY, markMetrics, palette);
      } else if (visibility === FLAGGED) {
        drawFlagMarker(
          context,
          centerX,
          centerY,
          markMetrics,
          palette,
          autoFlaggedIndexSet.has(index) ? palette.focus : palette.flag,
        );
      } else if (visibility === REVEALED && game) {
        if (hasMine) {
          drawMineMarker(context, centerX, centerY, markMetrics, palette);
          if (terminalDetonatedIndex === index) {
            context.strokeStyle = "#ffffff";
            context.lineWidth = Math.max(2, cellSize * 0.1);
            context.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
          }
        } else {
          const value = game.board.adjacent[index] ?? 0;
          if (value > 0) {
            context.fillStyle =
              palette.numberColors[value] ??
              palette.numberColors[8] ??
              "#f0ede6";
            context.strokeStyle = palette.numberStroke;
            context.lineWidth = Math.max(1.4, cellSize * 0.065);
            context.strokeText(String(value), centerX, centerY + 0.5);
            context.fillText(String(value), centerX, centerY + 0.5);
          }
        }
      }

      if (isFocused) {
        context.strokeStyle = palette.focusGuard;
        context.lineWidth = 3;
        context.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
        context.strokeStyle = palette.focus;
        context.lineWidth = 1.5;
        context.strokeRect(x + 3, y + 3, cellSize - 6, cellSize - 6);
      }
    };

    const dirty = new Set<number>();
    const previousVisibility = previousVisibilityRef.current;
    const gameChanged = previousGameRef.current !== game;
    const revisionChanged = previousRevisionRef.current !== revision;
    const outcomeChanged = previousOutcomeRef.current !== (game?.outcome ?? null);
    const themeChanged = previousThemeRef.current !== boardTheme;
    let redrawWholeBoard =
      resized ||
      gameChanged ||
      outcomeChanged ||
      themeChanged ||
      !previousVisibility ||
      previousVisibility.length !== cellCount;

    if (!redrawWholeBoard && revisionChanged && game && previousVisibility) {
      const hasNewActionVisual =
        actionVisual !== undefined &&
        actionVisual.id !== lastDrawnActionVisualIdRef.current;
      const explicitIndexes = hasNewActionVisual
        ? normalizeChangedIndexes(actionVisual.changedIndexes, cellCount)
        : [];
      if (hasNewActionVisual) {
        lastDrawnActionVisualIdRef.current = actionVisual.id;
      }
      if (explicitIndexes.length > 0) {
        for (const index of explicitIndexes) dirty.add(index);
      } else {
        for (let index = 0; index < cellCount; index += 1) {
          if (previousVisibility[index] !== game.visibility[index]) {
            dirty.add(index);
          }
        }
      }
    }

    if (previousFocusRef.current !== focusIndex) {
      if (previousFocusRef.current !== null) dirty.add(previousFocusRef.current);
      dirty.add(focusIndex);
    }
    if (previousPressedRef.current !== pressedIndex) {
      if (previousPressedRef.current !== null) dirty.add(previousPressedRef.current);
      if (pressedIndex !== null) dirty.add(pressedIndex);
    }

    if (!redrawWholeBoard) {
      redrawWholeBoard = shouldRedrawWholeBoard(dirty.size, cellCount);
    }

    const useSimplifiedLargeBoardSurface =
      redrawWholeBoard && cellCount > LARGE_BOARD_SURFACE_CELL_THRESHOLD;
    if (redrawWholeBoard) {
      context.fillStyle = palette.canvas;
      context.fillRect(0, 0, cssWidth, cssHeight);
      if (useSimplifiedLargeBoardSurface) {
        context.fillStyle = palette.hiddenA;
        context.fillRect(0, 0, cssWidth, cssHeight);
        for (let row = 0; row < height; row += 1) {
          let runStart = 0;
          let runColor = palette.hiddenA;
          for (let column = 0; column <= width; column += 1) {
            let nextColor = "";
            if (column < width) {
              const index = row * width + column;
              const storedVisibility = game?.visibility[index] ?? HIDDEN;
              const hasMine = game?.board.mines[index] === 1;
              const visibility = resolveVisibility(storedVisibility, hasMine);
              nextColor =
                visibility === REVEALED
                  ? hasMine
                    ? palette.mineCell
                    : palette.revealed
                  : visibility === FLAGGED
                    ? palette.flagged
                    : index === pressedIndex
                      ? palette.pressed
                      : palette.hiddenA;
            }
            if (nextColor === runColor) continue;
            if (runColor !== palette.hiddenA) {
              context.fillStyle = runColor;
              context.fillRect(
                runStart * cellSize + 1,
                row * cellSize + 1,
                (column - runStart) * cellSize - 2,
                cellSize - 2,
              );
            }
            runStart = column;
            runColor = nextColor;
          }
        }

        context.beginPath();
        for (let column = 0; column <= width; column += 1) {
          const x = clamp(column * cellSize - 0.5, 0.5, cssWidth - 0.5);
          context.moveTo(x, 0.5);
          context.lineTo(x, cssHeight - 0.5);
        }
        for (let row = 0; row <= height; row += 1) {
          const y = clamp(row * cellSize - 0.5, 0.5, cssHeight - 0.5);
          context.moveTo(0.5, y);
          context.lineTo(cssWidth - 0.5, y);
        }
        context.lineWidth = 1;
        context.strokeStyle = palette.hiddenLine;
        context.stroke();

        for (let index = 0; index < cellCount; index += 1) {
          const storedVisibility = game?.visibility[index] ?? HIDDEN;
          const hasMine = game?.board.mines[index] === 1;
          const visibility = resolveVisibility(storedVisibility, hasMine);
          if (visibility !== HIDDEN || index === focusIndex) {
            drawCell(index, false);
          }
        }
      } else {
        for (let index = 0; index < cellCount; index += 1) drawCell(index);
      }
    } else {
      for (const index of dirty) drawCell(index);
    }
    const baseDrawMs = performance.now() - drawStartedAt;
    if (redrawWholeBoard) {
      recordMetric("boardFullDrawMs", baseDrawMs);
      if (useSimplifiedLargeBoardSurface) {
        recordMetric("boardFullDrawSimplifiedMs", baseDrawMs);
      }
    } else if (dirty.size > 0) {
      recordMetric("boardDirtyDrawMs", baseDrawMs);
    }

    if (
      !actionVisual &&
      revisionChanged &&
      previousRevisionRef.current !== null &&
      dirty.size > 0 &&
      effectiveEffectsProfile !== "essential" &&
      !activeVisualRef.current
    ) {
      const inferredIndexes = [...dirty].filter(
        (index) => previousVisibility?.[index] !== game?.visibility[index],
      );
      if (inferredIndexes.length > 0) {
        const inferredAction = inferredIndexes.some(
          (index) =>
            game?.visibility[index] === FLAGGED ||
            previousVisibility?.[index] === FLAGGED,
        )
          ? "TOGGLE_FLAG"
          : "REVEAL";
        activeVisualRef.current = {
          actionType: inferredAction,
          originIndex: inferredIndexes[0] ?? -1,
          indexes: limitAnimatedIndexes(
            inferredIndexes,
            inferredIndexes[0] ?? -1,
          ),
          accepted: true,
          startedAt: performance.now(),
          durationMs: effectiveEffectsProfile === "full" ? 110 : 80,
        };
      }
    }

    const overlayStartedAt = performance.now();
    overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayContext.clearRect(0, 0, cssWidth, cssHeight);
    const visual = activeVisualRef.current;
    let visualIsActive = false;
    if (visual && visual.durationMs > 0) {
      const frameAt = performance.now();
      if (lastAnimationFrameAtRef.current !== null) {
        recordMetric(
          "boardAnimationFrameIntervalMs",
          frameAt - lastAnimationFrameAtRef.current,
        );
      }
      lastAnimationFrameAtRef.current = frameAt;
      const progress = clamp(
        (frameAt - visual.startedAt) / visual.durationMs,
        0,
        1,
      );
      if (progress < 1) {
        visualIsActive = true;
        const opacity = 1 - progress;
        overlayContext.save();
        overlayContext.globalAlpha = opacity;
        overlayContext.strokeStyle = visual.accepted
          ? palette.focus
          : palette.mine;
        overlayContext.fillStyle = visual.accepted
          ? palette.focus
          : palette.mine;
        overlayContext.lineWidth =
          visual.actionType === "CHORD" ? 2 : 1.5;

        if (
          effectiveEffectsProfile === "full" &&
          visual.actionType === "REVEAL"
        ) {
          overlayContext.globalAlpha = opacity * 0.11;
          for (const index of visual.indexes) {
            const x = (index % width) * cellSize;
            const y = Math.floor(index / width) * cellSize;
            overlayContext.fillRect(
              x + 2,
              y + 2,
              cellSize - 4,
              cellSize - 4,
            );
          }
          overlayContext.globalAlpha = opacity;
        }

        if (visual.originIndex >= 0) {
          const x = (visual.originIndex % width) * cellSize;
          const y = Math.floor(visual.originIndex / width) * cellSize;
          const inset =
            visual.actionType === "CHORD"
              ? 2 + progress * 2
              : 3;
          overlayContext.strokeRect(
            x + inset,
            y + inset,
            cellSize - inset * 2,
            cellSize - inset * 2,
          );
        }
        overlayContext.restore();
      }
    }
    if (!visualIsActive) {
      lastAnimationFrameAtRef.current = null;
      if (visual) activeVisualRef.current = null;
    }
    if (visual) {
      recordMetric(
        "boardOverlayDrawMs",
        performance.now() - overlayStartedAt,
      );
    }

    if (coachContext) {
      const coachStartedAt = performance.now();
      coachContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      coachContext.clearRect(0, 0, cssWidth, cssHeight);
      drawBoardCoachOverlay(
        coachContext,
        coachOverlay,
        width,
        height,
        cellSize,
        palette,
      );
      recordMetric("boardCoachOverlayDrawMs", performance.now() - coachStartedAt);
    }

    previousGameRef.current = game;
    previousRevisionRef.current = revision;
    previousFocusRef.current = focusIndex;
    previousPressedRef.current = pressedIndex;
    previousOutcomeRef.current = game?.outcome ?? null;
    previousThemeRef.current = boardTheme;
    if (game) {
      if (
        !previousVisibilityRef.current ||
        previousVisibilityRef.current.length !== game.visibility.length
      ) {
        previousVisibilityRef.current = new Uint8Array(game.visibility);
      } else if (redrawWholeBoard) {
        previousVisibilityRef.current.set(game.visibility);
      } else {
        for (const index of dirty) {
          previousVisibilityRef.current[index] =
            game.visibility[index] ?? HIDDEN;
        }
      }
    } else {
      previousVisibilityRef.current = null;
    }

    const paintedAt = performance.now();
    for (const startedAt of pendingPressPaintsRef.current.splice(0)) {
      recordMetric("pressNextPaintMs", paintedAt - startedAt);
    }
    for (const startedAt of pendingActionPaintsRef.current.splice(0)) {
      const latency = paintedAt - startedAt;
      recordMetric("pointerNextPaintMs", latency);
      latencyRef.current?.(latency);
    }

    if (visualIsActive) {
      animationFrameRef.current = requestAnimationFrame(() => drawRef.current());
    }
  }, [
    actionVisual,
    boardTheme,
    cellSize,
    cellCount,
    coachOverlay,
    effectiveEffectsProfile,
    focusIndex,
    game,
    height,
    palette,
    pressedIndex,
    revision,
    showTerminalMines,
    terminalDetonatedIndex,
    width,
  ]);

  drawRef.current = draw;

  useEffect(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    const frame = requestAnimationFrame(draw);
    animationFrameRef.current = frame;
    return () => {
      cancelAnimationFrame(frame);
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [draw]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  useEffect(() => {
    const cancelMouseGesture = (event: MouseEvent) => {
      if (event.buttons !== 0) return;
      chordTriggeredRef.current = false;
      setPressedIndex(null);
    };
    window.addEventListener("mouseup", cancelMouseGesture);
    return () => window.removeEventListener("mouseup", cancelMouseGesture);
  }, []);

  const runAction = useCallback(
    (action: BoardAction, index: number, inputMeta: BoardInputMeta) => {
      if (disabled || !game) return;
      pendingActionPaintsRef.current.push(performance.now());
      if (
        action === "CHORD" &&
        effectiveEffectsProfile !== "essential"
      ) {
        activeVisualRef.current = {
          actionType: "CHORD",
          originIndex: index,
          indexes: [index],
          accepted: true,
          startedAt: performance.now(),
          durationMs: effectiveEffectsProfile === "full" ? 150 : 110,
        };
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        animationFrameRef.current = requestAnimationFrame(
          () => drawRef.current(),
        );
      }
      actionRef.current(action, index, inputMeta);
    },
    [disabled, effectiveEffectsProfile, game],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse") return;
    if (disabled || !game) return;
    const index = cellFromPointer(event.currentTarget, event.nativeEvent, width, height);
    if (index === null) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and older browser implementations may not expose
      // an active native pointer; capture is an optimization, not a gate.
    }
    pendingPressPaintsRef.current.push(performance.now());
    longPressTriggeredRef.current = false;
    chordTriggeredRef.current = false;
    setPressedIndex(index);
    setFocusIndex(index);

    if (event.pointerType === "touch") {
      activeTouchPointersRef.current.add(event.pointerId);
      if (activeTouchPointersRef.current.size > 1) {
        pinchGestureRef.current = true;
        touchGestureRef.current = null;
        clearLongPress();
        setPressedIndex(null);
        return;
      }
      touchGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        setPressedIndex(null);
        runAction("TOGGLE_FLAG", index, {
          physicalClicks: 1,
          source: "touch",
        });
      }, 350);
      return;
    }

  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse") return;
    clearLongPress();
    if (event.pointerType === "touch") {
      activeTouchPointersRef.current.delete(event.pointerId);
      if (pinchGestureRef.current) {
        if (activeTouchPointersRef.current.size === 0) {
          pinchGestureRef.current = false;
        }
        setPressedIndex(null);
        return;
      }
      if (
        touchGestureRef.current?.pointerId === event.pointerId &&
        touchGestureRef.current.moved
      ) {
        touchGestureRef.current = null;
        setPressedIndex(null);
        return;
      }
      touchGestureRef.current = null;
    }

    const index = cellFromPointer(event.currentTarget, event.nativeEvent, width, height);
    setPressedIndex(null);
    if (index === null || disabled || !game || chordTriggeredRef.current) return;
    if (event.pointerType === "touch") {
      if (!longPressTriggeredRef.current) {
        const action =
          game.visibility[index] === REVEALED &&
          (game.board.adjacent[index] ?? 0) > 0
            ? "CHORD"
            : "REVEAL";
        runAction(action, index, {
          physicalClicks: 1,
          source: "touch",
        });
      }
      return;
    }

    const source = event.pointerType === "pen" ? "pen" : "touch";
    if (event.button === 0) {
      runAction("REVEAL", index, { physicalClicks: 1, source });
    }
    if (event.button === 2) {
      runAction("TOGGLE_FLAG", index, { physicalClicks: 1, source });
    }
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (disabled || !game) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const index = cellFromPointer(
      event.currentTarget,
      event.nativeEvent,
      width,
      height,
    );
    if (index === null) return;

    pendingPressPaintsRef.current.push(performance.now());
    setPressedIndex(index);
    setFocusIndex(index);
    if (
      event.buttons === 3 &&
      chordTriggeredRef.current === false
    ) {
      chordTriggeredRef.current = true;
      runAction("CHORD", index, {
        physicalClicks: 2,
        source: "mouse",
      });
    }
  };

  const handleMouseUp = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const index = cellFromPointer(
      event.currentTarget,
      event.nativeEvent,
      width,
      height,
    );
    setPressedIndex(null);
    if (chordTriggeredRef.current) {
      if (event.buttons === 0) chordTriggeredRef.current = false;
      return;
    }
    if (index === null || disabled || !game) return;
    if (event.button === 0) {
      if (game.visibility[index] === REVEALED) return;
      runAction("REVEAL", index, { physicalClicks: 1, source: "mouse" });
    }
    if (event.button === 1) {
      runAction("CHORD", index, { physicalClicks: 1, source: "mouse" });
    }
    if (event.button === 2) {
      runAction("TOGGLE_FLAG", index, {
        physicalClicks: 1,
        source: "mouse",
      });
    }
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (disabled || !game || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const index = cellFromPointer(
      event.currentTarget,
      event.nativeEvent,
      width,
      height,
    );
    if (
      index === null ||
      !canDoubleClickChord(
        game.visibility[index] ?? HIDDEN,
        game.board.adjacent[index] ?? 0,
      )
    ) {
      return;
    }
    setFocusIndex(index);
    runAction("CHORD", index, {
      physicalClicks: 2,
      source: "mouse",
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!game) return;
    const x = focusIndex % width;
    const y = Math.floor(focusIndex / width);
    let next = focusIndex;
    if (event.key === "ArrowLeft") next = y * width + Math.max(0, x - 1);
    if (event.key === "ArrowRight") next = y * width + Math.min(width - 1, x + 1);
    if (event.key === "ArrowUp") next = Math.max(0, y - 1) * width + x;
    if (event.key === "ArrowDown") next = Math.min(height - 1, y + 1) * width + x;
    if (next !== focusIndex) {
      event.preventDefault();
      setFocusIndex(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      runAction("REVEAL", focusIndex, {
        physicalClicks: 1,
        source: "keyboard",
      });
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      runAction("TOGGLE_FLAG", focusIndex, {
        physicalClicks: 1,
        source: "keyboard",
      });
    }
    if (event.key.toLowerCase() === "c") {
      event.preventDefault();
      runAction("CHORD", focusIndex, {
        physicalClicks: 1,
        source: "keyboard",
      });
    }
  };

  const focusedCellLabel = (() => {
    const row = Math.floor(focusIndex / width) + 1;
    const column = (focusIndex % width) + 1;
    if (!game) return t("board.cell.notStarted", { row, column });
    const visibility = game.visibility[focusIndex] ?? HIDDEN;
    if (visibility === FLAGGED) {
      return t("board.cell.flagged", { row, column });
    }
    if (visibility !== REVEALED) {
      return t("board.cell.hidden", { row, column });
    }
    if (game.board.mines[focusIndex] === 1) {
      return t("board.cell.mine", { row, column });
    }
    const adjacent = game.board.adjacent[focusIndex] ?? 0;
    return adjacent === 0
      ? t("board.cell.empty", { row, column })
      : t("board.cell.number", { row, column, value: adjacent });
  })();

  return (
    <div className="board-viewport">
      <div className="board-zoom-controls" role="group" aria-label={t("board.zoom")}>
        <span aria-live="polite">{t("board.cellWidth", { size: cellSize })}</span>
        <button
          type="button"
          onClick={() => setZoomOffset((current) => current - ZOOM_STEP)}
          disabled={
            cellSize <=
            (coarsePointer ? COARSE_ZOOM_MIN_CELL_SIZE : MIN_CELL_SIZE)
          }
          aria-label={t("board.zoomOut")}
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoomOffset(0)}
          disabled={zoomOffset === 0}
        >
          {t("board.resetZoom")}
        </button>
        <button
          type="button"
          onClick={() => setZoomOffset((current) => current + ZOOM_STEP)}
          disabled={
            cellSize >=
            (coarsePointer ? COARSE_MAX_CELL_SIZE : MAX_CELL_SIZE)
          }
          aria-label={t("board.zoomIn")}
        >
          +
        </button>
      </div>
      <div className="board-scroll" ref={wrapperRef}>
        <div
          className="board-canvas-stack"
          style={{
            width: `${width * cellSize}px`,
            height: `${height * cellSize}px`,
          }}
        >
          <canvas
            ref={canvasRef}
            className={`mine-board${disabled ? " is-disabled" : ""}${reducedMotion ? " reduced-motion" : ""}`}
            role="grid"
            tabIndex={0}
            aria-label={t("board.aria", { width, height, cell: focusedCellLabel })}
            aria-describedby={ariaDescribedBy}
            onContextMenu={(event) => event.preventDefault()}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            onMouseDown={handleMouseDown}
            onMouseLeave={(event) => {
              setPressedIndex(null);
              if (event.buttons === 0) {
                chordTriggeredRef.current = false;
              }
            }}
            onMouseUp={handleMouseUp}
            onPointerCancel={(event) => {
              clearLongPress();
              activeTouchPointersRef.current.delete(event.pointerId);
              if (touchGestureRef.current?.pointerId === event.pointerId) {
                touchGestureRef.current = null;
              }
              if (activeTouchPointersRef.current.size === 0) {
                pinchGestureRef.current = false;
              }
              chordTriggeredRef.current = false;
              setPressedIndex(null);
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={(event) => {
              const gesture = touchGestureRef.current;
              if (
                event.pointerType !== "touch" ||
                gesture === null ||
                gesture.pointerId !== event.pointerId ||
                gesture.moved
              ) {
                return;
              }
              if (
                Math.hypot(
                  event.clientX - gesture.startX,
                  event.clientY - gesture.startY,
                ) > 8
              ) {
                gesture.moved = true;
                clearLongPress();
                setPressedIndex(null);
              }
            }}
            onPointerUp={handlePointerUp}
          />
          {coachOverlay !== undefined && (
            <canvas
              ref={coachCanvasRef}
              aria-hidden="true"
              className="board-coach-canvas"
            />
          )}
          <canvas
            ref={overlayCanvasRef}
            aria-hidden="true"
            className="board-effects-canvas"
          />
        </div>
      </div>
    </div>
  );
}
