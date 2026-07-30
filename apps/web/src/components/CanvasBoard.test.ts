import { describe, expect, it } from "vitest";
import {
  normalizeChangedIndexes,
  resolveBoardAvailableWidth,
  resolveBoardMarkMetrics,
  resolveBoardPalette,
  resolveCanvasPixelRatio,
  resolveResponsiveCellSize,
  shouldRedrawWholeBoard,
} from "./CanvasBoard";

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

  it("caps high-DPI backing stores for large two-layer boards", () => {
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
});
