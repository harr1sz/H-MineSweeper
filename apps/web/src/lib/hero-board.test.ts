import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type HeroCell = {
  index: number;
  x: number;
  y: number;
  mine: boolean;
  adjacent: number | null;
};

type HeroManifest = {
  board: {
    width: number;
    height: number;
    mines: number;
  };
  cells: HeroCell[];
};

const manifestUrl = new URL(
  "../../public/hero-board-h-v2.manifest.json",
  import.meta.url,
);
const svgUrl = new URL("../../public/hero-board-h-v2.svg", import.meta.url);

function loadManifest(): HeroManifest {
  return JSON.parse(readFileSync(manifestUrl, "utf8")) as HeroManifest;
}

describe("verified H hero board", () => {
  it("uses exactly the intended H-shaped mine coordinates", () => {
    const manifest = loadManifest();
    const actualMines = new Set(
      manifest.cells
        .filter((cell) => cell.mine)
        .map((cell) => `${cell.x},${cell.y}`),
    );
    const expectedMines = new Set<string>();

    for (let y = 1; y <= 7; y += 1) {
      expectedMines.add(`2,${y}`);
      expectedMines.add(`8,${y}`);
    }
    for (let x = 2; x <= 8; x += 1) {
      expectedMines.add(`${x},4`);
    }

    expect(manifest.board).toEqual({ width: 11, height: 9, mines: 19 });
    expect(actualMines).toEqual(expectedMines);
  });

  it("independently recomputes every displayed adjacent-mine number", () => {
    const manifest = loadManifest();
    const mines = new Set(
      manifest.cells
        .filter((cell) => cell.mine)
        .map((cell) => `${cell.x},${cell.y}`),
    );

    expect(manifest.cells).toHaveLength(
      manifest.board.width * manifest.board.height,
    );

    for (const cell of manifest.cells) {
      expect(cell.index).toBe(cell.y * manifest.board.width + cell.x);
      if (cell.mine) {
        expect(cell.adjacent).toBeNull();
        continue;
      }

      let expectedAdjacent = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          if (mines.has(`${cell.x + offsetX},${cell.y + offsetY}`)) {
            expectedAdjacent += 1;
          }
        }
      }
      expect(cell.adjacent, `cell ${cell.x},${cell.y}`).toBe(expectedAdjacent);
    }
  });

  it("renders one marker per mine and never renders a number on a mine", () => {
    const svg = readFileSync(svgUrl, "utf8");
    const manifest = loadManifest();

    expect(svg.match(/aria-label="mine marker"/g)).toHaveLength(
      manifest.board.mines,
    );
    for (const cell of manifest.cells.filter((candidate) => candidate.mine)) {
      expect(svg).toContain(
        `data-index="${cell.index}" data-mine="true" data-adjacent=""`,
      );
    }
  });
});
