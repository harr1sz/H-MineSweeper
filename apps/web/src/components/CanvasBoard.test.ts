import { describe, expect, it } from "vitest";
import {
  drawBoardCoachOverlay,
  normalizeChangedIndexes,
  resolveBoardAvailableWidth,
  resolveBoardCoachOverlay,
  resolveBoardMarkMetrics,
  resolveBoardPalette,
  resolveCanvasPixelRatio,
  resolveResponsiveCellSize,
  shouldRedrawWholeBoard,
} from "./CanvasBoard";

function recordingContext(): {
  readonly context: CanvasRenderingContext2D;
  readonly operations: string[];
} {
  const operations: string[] = [];
  const context = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    save: () => operations.push("save"),
    restore: () => operations.push("restore"),
    beginPath: () => operations.push("beginPath"),
    closePath: () => operations.push("closePath"),
    fill: () => operations.push("fill"),
    stroke: () => operations.push("stroke"),
    setLineDash: (segments: readonly number[]) => operations.push(`dash:${segments.join(",")}`),
    fillRect: (x: number, y: number, width: number, height: number) =>
      operations.push(`fillRect:${x},${y},${width},${height}`),
    strokeRect: (x: number, y: number, width: number, height: number) =>
      operations.push(`strokeRect:${x},${y},${width},${height}`),
    arc: (x: number, y: number, radius: number) =>
      operations.push(`arc:${x},${y},${radius}`),
    moveTo: (x: number, y: number) => operations.push(`moveTo:${x},${y}`),
    lineTo: (x: number, y: number) => operations.push(`lineTo:${x},${y}`),
  } as unknown as CanvasRenderingContext2D;
  return { context, operations };
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/giu)?.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) {
    throw new Error(`无法计算颜色亮度：${hex}`);
  }
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const brighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

describe("CanvasBoard rendering helpers", () => {
  it("normalizes authoritative changed indexes without reordering them", () => {
    expect(
      normalizeChangedIndexes([4, -1, 2, 4, 7, 1.5, 3], 5),
    ).toEqual([4, 2, 3]);
    expect(normalizeChangedIndexes(undefined, 5)).toEqual([]);
    expect(normalizeChangedIndexes([0], 0)).toEqual([]);
  });

  it("switches to a whole-board redraw at the 15 percent threshold", () => {
    expect(shouldRedrawWholeBoard(14, 100)).toBe(false);
    expect(shouldRedrawWholeBoard(15, 100)).toBe(true);
    expect(shouldRedrawWholeBoard(1, 4)).toBe(true);
    expect(shouldRedrawWholeBoard(0, 100)).toBe(false);
  });

  it("provides readable, distinct palettes for every supported theme", () => {
    for (const theme of [
      "classic",
      "black-gold",
      "high-contrast",
    ] as const) {
      const palette = resolveBoardPalette(theme);
      expect(palette.hiddenA).not.toBe(palette.revealed);
      expect(palette.hiddenB).not.toBe(palette.revealed);
      expect(palette.flagged).not.toBe(palette.revealed);
      expect(palette.mineCell).not.toBe(palette.revealed);
      expect(palette.focus).not.toBe(palette.focusGuard);
      expect(palette.numberStroke).not.toBe(palette.numberColors[1]);
      expect(palette.numberColors).toHaveLength(9);
      expect(palette.numberColors.slice(1).every(Boolean)).toBe(true);
    }
  });

  it("keeps revealed cells visually distinct from both covered-cell shades", () => {
    for (const theme of [
      "classic",
      "black-gold",
      "high-contrast",
    ] as const) {
      const palette = resolveBoardPalette(theme);
      expect(contrastRatio(palette.revealed, palette.hiddenA)).toBeGreaterThanOrEqual(2.2);
      expect(contrastRatio(palette.revealed, palette.hiddenB)).toBeGreaterThanOrEqual(2.2);
    }
  });

  it("keeps numbers and board markers legible at the smallest cell size", () => {
    expect(resolveBoardMarkMetrics(18)).toEqual({
      numberFontSize: 13,
      iconSize: 14,
      iconLineWidth: 1.5,
    });
    expect(resolveBoardMarkMetrics(30)).toEqual({
      numberFontSize: 19,
      iconSize: 22.2,
      iconLineWidth: 2.25,
    });
    expect(resolveBoardMarkMetrics(Number.NaN)).toEqual({
      numberFontSize: 13,
      iconSize: 14,
      iconLineWidth: 1.5,
    });
  });

  it("fits a beginner board inside 320–390px phone layouts", () => {
    const widths = [296, 351, 366];
    for (const viewportWidth of widths) {
      const available = resolveBoardAvailableWidth(viewportWidth, 14, 14);
      const cellSize = resolveResponsiveCellSize(available, 9, true);
      expect(cellSize * 9).toBeLessThanOrEqual(available);
      expect(cellSize).toBeGreaterThanOrEqual(24);
    }
  });

  it("keeps large touch boards pannable without forcing page overflow", () => {
    const available = resolveBoardAvailableWidth(351, 14, 14);
    expect(resolveResponsiveCellSize(available, 16, true)).toBe(32);
    expect(resolveResponsiveCellSize(available, 30, true)).toBe(32);
    expect(resolveResponsiveCellSize(900, 30, false)).toBe(30);
  });

  it("caps high-DPI backing stores for large layered boards", () => {
    expect(resolveCanvasPixelRatio(270, 270, 2)).toBe(2);
    expect(resolveCanvasPixelRatio(1_800, 1_800, 2)).toBeCloseTo(
      Math.sqrt(4_000_000 / (1_800 * 1_800)),
    );
    expect(resolveCanvasPixelRatio(1_800, 1_800, 1)).toBe(1);
    expect(resolveCanvasPixelRatio(4_400, 4_400, 2)).toBeCloseTo(
      Math.sqrt(4_000_000 / (4_400 * 4_400)),
    );
    expect(resolveCanvasPixelRatio(0, 1_800, 2)).toBe(1);
  });

  it("normalizes coach sources, one target, and coach-created flags", () => {
    expect(resolveBoardCoachOverlay({
      sourceIndexes: [7, -1, 0, 7, 5],
      targetIndex: 5,
      action: "FLAG",
      autoFlaggedIndexes: [2, 2, 9, 3],
    }, 4, 2)).toEqual({
      sourceIndexes: [0, 7],
      targetIndex: 5,
      action: "FLAG",
      autoFlaggedIndexes: [2, 3],
    });
    expect(resolveBoardCoachOverlay({
      sourceIndexes: [0],
      targetIndex: 99,
      action: "REVEAL",
      autoFlaggedIndexes: [1],
    }, 2, 2)).toEqual({
      sourceIndexes: [],
      targetIndex: null,
      action: null,
      autoFlaggedIndexes: [1],
    });
  });

  it("bounds coach overlay work on 10,000-cell boards", () => {
    const resolved = resolveBoardCoachOverlay({
      sourceIndexes: Array.from({ length: 10_000 }, (_, index) => index),
      targetIndex: 5_050,
      action: "REVEAL",
      autoFlaggedIndexes: Array.from({ length: 10_000 }, (_, index) => index),
    }, 100, 100);
    expect(resolved.sourceIndexes).toHaveLength(64);
    expect(resolved.sourceIndexes).not.toContain(5_050);
    expect(resolved.autoFlaggedIndexes).toHaveLength(256);
  });

  it("draws static source, target, and auto-flag marks without board truth", () => {
    const first = recordingContext();
    const overlay = {
      sourceIndexes: [0, 5],
      targetIndex: 1,
      action: "FLAG" as const,
      autoFlaggedIndexes: [3],
    };
    const firstSummary = drawBoardCoachOverlay(
      first.context,
      overlay,
      3,
      2,
      20,
      resolveBoardPalette("black-gold"),
    );
    expect(firstSummary).toEqual({
      sourceCount: 2,
      targetDrawn: true,
      autoFlaggedCount: 1,
    });
    expect(first.operations.filter((operation) => operation.startsWith("strokeRect")))
      .toHaveLength(4);

    // There is no time input or animated phase: reduced-motion rendering can
    // call the same helper and receive an identical static command sequence.
    const second = recordingContext();
    drawBoardCoachOverlay(
      second.context,
      overlay,
      3,
      2,
      20,
      resolveBoardPalette("black-gold"),
    );
    expect(second.operations).toEqual(first.operations);
  });

  it("redraws a changed coach target at its new canvas coordinates", () => {
    const first = recordingContext();
    const second = recordingContext();
    const palette = resolveBoardPalette("classic");
    drawBoardCoachOverlay(
      first.context,
      { targetIndex: 1, action: "REVEAL" },
      3,
      2,
      20,
      palette,
    );
    drawBoardCoachOverlay(
      second.context,
      { targetIndex: 4, action: "REVEAL" },
      3,
      2,
      20,
      palette,
    );
    expect(first.operations).toContain("strokeRect:22,2,16,16");
    expect(second.operations).toContain("strokeRect:22,22,16,16");
  });
});
