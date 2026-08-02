import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = Date.UTC(2026, 7, 2, 7);
const FIXED_RANDOM_WORD = 0x2468_ace0;
const FIRST_INDEX = 5_050;

async function useDeterministicEnvironment(page: Page): Promise<void> {
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

async function clickBoardCell(page: Page, index: number): Promise<void> {
  const board = page.getByRole("grid", { name: /^100 乘 100 扫雷棋盘/u });
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    position: {
      x: ((index % 100) + 0.5) * (box.width / 100),
      y: (Math.floor(index / 100) + 0.5) * (box.height / 100),
    },
  });
}

test("100×100 教练覆盖层保持 4ms 预算且空闲倒计时不触发重绘", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useDeterministicEnvironment(page);
  await page.goto("/");
  await page.getByRole("button", { name: "引导练习" }).click();
  await page.getByRole("button", { name: "经典模式" }).click();
  await page.locator(".solo-tabs").getByRole("button", { name: /^自定义 5–100/u }).click();
  await page.getByLabel("自定义宽度").fill("100");
  await page.getByLabel("自定义高度").fill("100");
  await page.getByLabel("自定义雷数").fill("999");
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("grid", { name: /^100 乘 100 扫雷棋盘/u })).toBeVisible();

  await clickBoardCell(page, FIRST_INDEX);
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  // Let the accepted-click visual (at most 150ms) finish before measuring an
  // actually idle coach layer. Otherwise its final rAF can be misclassified
  // as a countdown-driven coach redraw.
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    globalThis.__HMS_PERF__ = {};
    globalThis.__HMS_PERF_COUNTS__ = {};
  });
  await page.getByRole("button", { name: "立即提示" }).click();
  await expect(page.locator(".practice-coach-proof")).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => globalThis.__HMS_PERF__?.boardCoachOverlayDrawMs?.length ?? 0,
  )).toBeGreaterThan(0);

  const firstSnapshot = await page.evaluate(() => ({
    samples: [...(globalThis.__HMS_PERF__?.boardCoachOverlayDrawMs ?? [])],
    count: globalThis.__HMS_PERF_COUNTS__?.boardCoachOverlayDrawMs ?? 0,
  }));
  expect(Math.max(...firstSnapshot.samples)).toBeLessThanOrEqual(4);

  await page.waitForTimeout(600);
  const idleCount = await page.evaluate(
    () => globalThis.__HMS_PERF_COUNTS__?.boardCoachOverlayDrawMs ?? 0,
  );
  expect(idleCount).toBe(firstSnapshot.count);
});
