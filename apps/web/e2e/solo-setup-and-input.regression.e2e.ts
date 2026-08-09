import {
  CELL_HIDDEN,
  CELL_REVEALED,
  createBoard,
  createGameState,
  revealCell,
} from "@h-minesweeper/game-core";
import { expect, test, type Page } from "@playwright/test";
import { createSoloBoardSpec } from "../src/lib/solo";

// Regression: ISSUE-007 — board actions changed page scroll position.
// Regression: ISSUE-008 — solo configuration lived inside the active game screen.
// Regression: ISSUE-009 — revealed numbers did not support double-click chord.
// Found by /qa on 2026-07-31.

const FIXED_NOW = 1_785_513_600_000;
const FIXED_RANDOM_WORD = 0x1234_5678;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${"12345678".repeat(3)}`;

async function openSoloSetup(page: Page): Promise<void> {
  await page.addInitScript(
    ({ fixedNow, fixedRandomWord }) => {
      Date.now = () => fixedNow;
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: <T extends ArrayBufferView | null>(array: T): T => {
          if (array && "length" in array) {
            const values = array as unknown as { length: number; [index: number]: number };
            for (let index = 0; index < values.length; index += 1) {
              values[index] = fixedRandomWord;
            }
          }
          return array;
        },
      });
      localStorage.clear();
    },
    { fixedNow: FIXED_NOW, fixedRandomWord: FIXED_RANDOM_WORD },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "开始单人游戏" }).click();
  await expect(
    page.getByRole("heading", { name: "开始新游戏" }),
  ).toBeVisible();
}

function cellPosition(index: number, width: number, canvasWidth: number) {
  const cellSize = canvasWidth / width;
  return {
    x: (index % width + 0.5) * cellSize,
    y: (Math.floor(index / width) + 0.5) * cellSize,
  };
}

test("solo uses a configuration gateway before rendering the board", async ({
  page,
}) => {
  await openSoloSetup(page);

  await expect(page.locator('canvas[role="grid"]')).toHaveCount(0);
  await page.getByRole("button", { name: /高级 30×16/ }).click();
  await page.getByRole("button", { name: "无猜模式" }).click();
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByRole("button", { name: "详细" }).click();
  await page.getByRole("button", { name: "经典", exact: true }).click();
  await page.getByRole("button", { name: "开始游戏" }).click();

  await expect(page.locator('canvas[role="grid"]')).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "开始新游戏" }),
  ).toHaveCount(0);
  await expect(page.getByText("高级 · 30×16 / 99 · 无猜模式")).toBeVisible();
  await expect(page.getByText(/双击或中键快速展开/)).toBeVisible();
  await page.getByText("操作详情", { exact: true }).click();
  await expect(page.getByText("物理点击")).toBeVisible();
});

test("flag, reveal, double-click chord, and mine hit keep page scroll fixed", async ({
  page,
}) => {
  await openSoloSetup(page);
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByRole("button", { name: "详细" }).click();
  await page.getByRole("button", { name: "开始游戏" }).click();

  const width = 9;
  const height = 9;
  const centerIndex = 4 * width + 4;
  const expected = createGameState(
    createBoard(
      createSoloBoardSpec(
        { width, height, mines: 10, mode: "classic" },
        centerIndex,
        FIXED_SEED,
      ),
    ),
  );
  revealCell(expected, centerIndex);

  const chordIndex = Array.from(expected.visibility).findIndex(
    (visibility, index) => {
      if (
        visibility !== CELL_REVEALED ||
        (expected.board.adjacent[index] ?? 0) === 0
      ) {
        return false;
      }
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (
            nextX < 0 ||
            nextX >= width ||
            nextY < 0 ||
            nextY >= height
          ) {
            continue;
          }
          const neighbor = nextY * width + nextX;
          if (
            expected.visibility[neighbor] === CELL_HIDDEN &&
            expected.board.mines[neighbor] === 0
          ) {
            return true;
          }
        }
      }
      return false;
    },
  );
  expect(chordIndex).toBeGreaterThanOrEqual(0);

  const chordX = chordIndex % width;
  const chordY = Math.floor(chordIndex / width);
  const adjacentMines: number[] = [];
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const nextX = chordX + offsetX;
      const nextY = chordY + offsetY;
      if (
        nextX < 0 ||
        nextX >= width ||
        nextY < 0 ||
        nextY >= height
      ) {
        continue;
      }
      const neighbor = nextY * width + nextX;
      if (expected.board.mines[neighbor] === 1) adjacentMines.push(neighbor);
    }
  }

  const board = page.locator('canvas[role="grid"]');
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  const canvasWidth = box?.width ?? 270;
  const scrollBefore = await page.evaluate(() => window.scrollY);

  const temporaryFlagIndex = chordIndex === 0 ? 1 : 0;
  await board.click({
    button: "right",
    position: cellPosition(temporaryFlagIndex, width, canvasWidth),
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await board.click({
    button: "right",
    position: cellPosition(temporaryFlagIndex, width, canvasWidth),
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  await board.click({ position: cellPosition(centerIndex, width, canvasWidth) });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  for (const mineIndex of adjacentMines) {
    await board.click({
      button: "right",
      position: cellPosition(mineIndex, width, canvasWidth),
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  }

  await board.dblclick({
    position: cellPosition(chordIndex, width, canvasWidth),
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(page.getByText(/揭格 \/ 快速展开/).locator(".."))
    .toContainText("/ 1");

  const mineIndex = Array.from(expected.board.mines).findIndex(
    (mine, index) => mine === 1 && !adjacentMines.includes(index),
  );
  expect(mineIndex).toBeGreaterThanOrEqual(0);
  await board.click({ position: cellPosition(mineIndex, width, canvasWidth) });
  await expect(page.getByRole("heading", { name: "踩雷了" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});
