import {
  CELL_HIDDEN,
  createBoard,
  createGameState,
  revealCell,
} from "@h-minesweeper/game-core";
import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = Date.UTC(2026, 7, 2, 6);
const FIXED_RANDOM_WORD = 0x1357_9bdf;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${Array.from(
  { length: 3 },
  () => FIXED_RANDOM_WORD.toString(16).padStart(8, "0"),
).join("")}`;
const FIRST_INDEX = 40;

async function useDeterministicSoloEnvironment(page: Page): Promise<void> {
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
      localStorage.clear();
    },
    { now: FIXED_NOW, randomWord: FIXED_RANDOM_WORD },
  );
}

function acceptedSafeRevealSequence(targetCount = 4): readonly number[] {
  const board = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: FIRST_INDEX,
    safeRadius: 1,
  });
  const state = createGameState(board);
  const accepted = [FIRST_INDEX];
  revealCell(state, FIRST_INDEX);
  for (let index = 0; index < state.visibility.length && accepted.length < targetCount; index += 1) {
    if (state.visibility[index] !== CELL_HIDDEN || board.mines[index] === 1) continue;
    const delta = revealCell(state, index);
    if (delta.accepted && delta.hitMine !== true && delta.revealed.length > 0) {
      accepted.push(index);
    }
  }
  if (accepted.length < targetCount) {
    throw new Error(`deterministic board lacks ${targetCount} accepted safe reveals`);
  }
  return accepted;
}

function neutralFlagTarget(accepted: readonly number[]): number {
  const board = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: FIRST_INDEX,
    safeRadius: 1,
  });
  const state = createGameState(board);
  for (const index of accepted.slice(0, 2)) revealCell(state, index!);
  const acceptedSet = new Set(accepted);
  const target = Array.from(state.visibility).findIndex(
    (visibility, index) => visibility === CELL_HIDDEN && !acceptedSet.has(index),
  );
  if (target < 0) throw new Error("deterministic board lacks a neutral flag target");
  return target;
}

async function enterClassicSolo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "开始单人游戏" }).click();
  await page.getByRole("button", { name: "经典模式" }).click();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
}

async function clickBoardCell(
  page: Page,
  index: number,
  button: "left" | "right" = "left",
): Promise<void> {
  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/u });
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    button,
    position: {
      x: ((index % 9) + 0.5) * (box.width / 9),
      y: (Math.floor(index / 9) + 0.5) * (box.height / 9),
    },
  });
}

async function doubleClickBoardCell(page: Page, index: number): Promise<void> {
  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/u });
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.dblclick({
    position: {
      x: ((index % 9) + 0.5) * (box.width / 9),
      y: (Math.floor(index / 9) + 0.5) * (box.height / 9),
    },
  });
}

test("安全操作从 ×2 展示，重复点击和无效双击保持连击中立", async ({ page }) => {
  await useDeterministicSoloEnvironment(page);
  await enterClassicSolo(page);
  const [first, second, third, fourth] = acceptedSafeRevealSequence();
  await clickBoardCell(page, first!);
  await expect(page.locator(".flow-combo")).toHaveCount(0);
  await clickBoardCell(page, second!);

  const secondCombo = page.locator(".flow-combo");
  await expect(secondCombo).toContainText("连击");
  await expect(secondCombo).toContainText("×2");
  await expect(secondCombo).toHaveClass(/combo-2/u);
  await expect.poll(() => secondCombo.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("combo-pulse");
  await expect.poll(() => secondCombo.locator(".flow-combo-progress > div").evaluate(
    (element) => getComputedStyle(element).animationName,
  )).toBe("combo-countdown");
  const secondHandle = await secondCombo.elementHandle();
  const countdown = secondCombo.locator(".flow-combo-progress > div");
  const beforeFlagMs = await countdown.evaluate((element) =>
    Number(element.getAnimations()[0]?.currentTime ?? 0)
  );
  const flagTarget = neutralFlagTarget([first!, second!, third!]);
  await clickBoardCell(page, flagTarget, "right");
  await expect(secondCombo).toContainText("×2");
  expect(await secondHandle?.evaluate((element) => element.isConnected)).toBe(true);
  const afterFlagMs = await countdown.evaluate((element) =>
    Number(element.getAnimations()[0]?.currentTime ?? 0)
  );
  expect(afterFlagMs).toBeGreaterThanOrEqual(beforeFlagMs);
  await clickBoardCell(page, flagTarget, "right");
  await expect(secondCombo).toContainText("×2");

  await clickBoardCell(page, third!);
  await expect(page.locator(".flow-combo")).toContainText("×3");
  expect(await secondHandle?.evaluate((element) => element.isConnected)).toBe(false);

  await clickBoardCell(page, first!);
  await expect(page.locator(".flow-combo")).toContainText("×3");
  const thirdHandle = await page.locator(".flow-combo").elementHandle();
  await doubleClickBoardCell(page, first!);
  await expect(page.locator(".flow-combo")).toContainText("×3");
  expect(await thirdHandle?.evaluate((element) => element.isConnected)).toBe(true);

  await clickBoardCell(page, fourth!);
  await expect(page.locator(".flow-combo")).toContainText("×4");
});

test("系统减少动态效果时，连击改用静态颜色反馈", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useDeterministicSoloEnvironment(page);
  await enterClassicSolo(page);
  const [first, second] = acceptedSafeRevealSequence();
  await clickBoardCell(page, first!);
  await clickBoardCell(page, second!);

  const combo = page.locator(".flow-combo");
  await expect(combo).toContainText("×2");
  await expect.poll(() => combo.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none");
  const countdown = combo.locator(".flow-combo-progress > div");
  await expect.poll(() => countdown.evaluate((element) => ({
    animationName: getComputedStyle(element).animationName,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ animationName: "none", opacity: "0.55" });
});

test("高连击连续增长时会轮换鼓励文案", async ({ page }) => {
  await useDeterministicSoloEnvironment(page);
  await enterClassicSolo(page);
  const safeReveals = acceptedSafeRevealSequence(14);
  const highStreakMessages: string[] = [];

  for (const [index, cellIndex] of safeReveals.entries()) {
    await clickBoardCell(page, cellIndex);
    if (index + 1 >= 12) {
      highStreakMessages.push(await page.locator(".flow-combo em").innerText());
    }
  }

  await expect(page.locator(".flow-combo")).toContainText("×14");
  expect(new Set(highStreakMessages).size).toBe(highStreakMessages.length);
});
