import { expect, test } from "@playwright/test";

test("ISSUE-002 rapid first-click input starts only one no-guess worker", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    Object.defineProperty(window, "__hmsWorkerCount", {
      configurable: true,
      value: 0,
      writable: true,
    });
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        const target = window as Window & { __hmsWorkerCount?: number };
        target.__hmsWorkerCount = (target.__hmsWorkerCount ?? 0) + 1;
      }
    };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "单人游戏 · 配置开局" }).click();
  await page.getByRole("button", { name: "无猜模式" }).click();
  await page.getByRole("button", { name: "开始对局" }).click();

  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ });
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");

  const clickPosition = { x: box.width / 2, y: box.height / 2 };
  await board.click({ position: clickPosition });
  await board.click({ position: clickPosition });

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __hmsWorkerCount?: number }).__hmsWorkerCount,
      ),
    )
    .toBe(1);
  await expect(page.getByText("进行中", { exact: true })).toBeVisible({
    timeout: 7_000,
  });
  await expect(page.locator(".mine-board")).toHaveCount(1);
});
