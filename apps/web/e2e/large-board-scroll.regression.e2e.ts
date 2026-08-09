import { expect, test } from "@playwright/test";

test("ISSUE-007 oversized desktop boards keep both horizontal edges reachable", async ({
  page,
}) => {
  // Regression: ISSUE-007 — centered oversized boards lost their leftmost columns
  // Found by /qa on 2026-07-31
  // Report: .gstack/qa-reports/qa-report-desktop-2026-07-31.md
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "开始单人游戏" }).click();

  await page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^自定义 5–100/ })
    .click();
  await page.getByLabel("自定义宽度").fill("100");
  await page.getByLabel("自定义高度").fill("100");
  await page.getByLabel("自定义雷数").fill("999");
  await page.getByRole("button", { name: "开始游戏" }).click();

  const scroll = page.locator(".solo-board-stage .board-scroll");
  const board = page.getByRole("grid", { name: /^100 乘 100 扫雷棋盘/ });
  await expect(board).toBeVisible();

  await scroll.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const leftGeometry = await page.evaluate(() => {
    const scrollElement = document.querySelector(
      ".solo-board-stage .board-scroll",
    );
    const boardElement = document.querySelector(".solo-board-stage .mine-board");
    if (!(scrollElement instanceof HTMLElement) || !(boardElement instanceof HTMLElement)) {
      throw new Error("棋盘布局不可测量");
    }
    const scrollRect = scrollElement.getBoundingClientRect();
    const boardRect = boardElement.getBoundingClientRect();
    return {
      boardLeft: boardRect.left,
      boardWidth: boardRect.width,
      contentLeft: scrollRect.left + scrollElement.clientLeft,
      scrollWidth: scrollElement.scrollWidth,
    };
  });
  expect(leftGeometry.boardLeft).toBeGreaterThanOrEqual(leftGeometry.contentLeft);
  expect(leftGeometry.scrollWidth).toBeGreaterThanOrEqual(leftGeometry.boardWidth);

  await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const rightGeometry = await page.evaluate(() => {
    const scrollElement = document.querySelector(
      ".solo-board-stage .board-scroll",
    );
    const boardElement = document.querySelector(".solo-board-stage .mine-board");
    if (!(scrollElement instanceof HTMLElement) || !(boardElement instanceof HTMLElement)) {
      throw new Error("棋盘布局不可测量");
    }
    const scrollRect = scrollElement.getBoundingClientRect();
    const boardRect = boardElement.getBoundingClientRect();
    return {
      boardRight: boardRect.right,
      contentRight: scrollRect.right - scrollElement.clientLeft,
    };
  });
  expect(rightGeometry.boardRight).toBeLessThanOrEqual(
    rightGeometry.contentRight + 1,
  );
});
