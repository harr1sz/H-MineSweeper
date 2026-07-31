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

const verifiedAssets = [
  {
    name: "duel H board",
    manifest: "hero-board-h-v2.manifest.json",
    svg: "hero-board-h-v2.svg",
  },
  {
    name: "solo board",
    manifest: "hero-solo-verified-v1.manifest.json",
    svg: "hero-solo-verified-v1.svg",
  },
  {
    name: "academy board",
    manifest: "hero-academy-verified-v1.manifest.json",
    svg: "hero-academy-verified-v1.svg",
  },
] as const;

function publicAssetUrl(asset: string): URL {
  return new URL(`../../public/${asset}`, import.meta.url);
}

function loadManifest(asset: string): HeroManifest {
  return JSON.parse(readFileSync(publicAssetUrl(asset), "utf8")) as HeroManifest;
}

describe("verified H hero board", () => {
  it("uses exactly the intended H-shaped mine coordinates", () => {
    const manifest = loadManifest("hero-board-h-v2.manifest.json");
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

  for (const asset of verifiedAssets) {
    it(`${asset.name} independently recomputes every displayed adjacent-mine number`, () => {
      const manifest = loadManifest(asset.manifest);
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
        expect(cell.adjacent, `${asset.name} cell ${cell.x},${cell.y}`).toBe(
          expectedAdjacent,
        );
      }
    });

    it(`${asset.name} keeps SVG mines and numbers aligned with its manifest`, () => {
      const svg = readFileSync(publicAssetUrl(asset.svg), "utf8");
      const manifest = loadManifest(asset.manifest);

      expect(svg.match(/aria-label="mine marker"/g)).toHaveLength(
        manifest.board.mines,
      );
      for (const cell of manifest.cells) {
        expect(svg).toContain(
          `data-index="${cell.index}" data-mine="${cell.mine}" data-adjacent="${cell.adjacent ?? ""}"`,
        );
      }
    });
  }
});
