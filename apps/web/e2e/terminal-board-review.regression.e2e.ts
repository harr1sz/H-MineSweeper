import { createBoard } from "@h-minesweeper/game-core";
import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = Date.UTC(2026, 6, 30, 8);
const FIXED_RANDOM_WORD = 0x12345678;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${Array.from(
  { length: 3 },
  () => FIXED_RANDOM_WORD.toString(16).padStart(8, "0"),
).join("")}`;

async function clickBoardCell(page: Page, index: number): Promise<void> {
  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ });
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    position: {
      x: ((index % 9) + 0.5) * (box.width / 9),
      y: (Math.floor(index / 9) + 0.5) * (box.height / 9),
    },
  });
}

test("ISSUE-003 terminal result can review the board and reopen summary", async ({
  page,
}) => {
  await page.addInitScript(
    ({ now, randomWord }) => {
      Date.now = () => now;
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: (array: ArrayBufferView) => {
          const values = array as unknown as {
            readonly length: number;
            [index: number]: number;
          };
          for (let index = 0; index < values.length; index += 1) {
            values[index] = randomWord;
          }
          return array;
        },
      });
    },
    { now: FIXED_NOW, randomWord: FIXED_RANDOM_WORD },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "单人游戏 · 配置开局" }).click();
  await page.getByRole("button", { name: "开始对局" }).click();

  const generated = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1,
  });
  const mineIndex = generated.mines.findIndex((value) => value === 1);
  await clickBoardCell(page, 40);
  await clickBoardCell(page, mineIndex);

  await expect(page.getByRole("heading", { name: "触雷" })).toBeVisible();
  await expect(page.locator(".result-overlay")).toHaveCount(0);
  await expect(
    page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "分析本局" })).toBeVisible();
});
