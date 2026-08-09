import { expect, test } from "@playwright/test";

test("ISSUE-008 100×100 full redraws stay inside the desktop regression budget", async ({
  page,
}) => {
  // Regression: ISSUE-008 — 10,000-cell full redraws exceeded the 4ms target
  // Found by /qa on 2026-07-31
  // Report: .gstack/qa-reports/qa-report-desktop-2026-07-31.md
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^自定义 5–100/ })
    .click();
  await page.getByLabel("自定义宽度").fill("100");
  await page.getByLabel("自定义高度").fill("100");
  await page.getByLabel("自定义雷数").fill("999");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(
    page.getByRole("grid", { name: /^100 乘 100 扫雷棋盘/ }),
  ).toBeVisible();

  await page.evaluate(() => {
    globalThis.__HMS_PERF__ = {};
    globalThis.__HMS_PERF_COUNTS__ = {};
  });
  const themes = ["经典", "高对比", "暖色深色", "象牙战术"];
  for (const [index, theme] of themes.entries()) {
    await page.getByRole("button", { name: "游戏设置" }).click();
    await page
      .getByRole("group", { name: "棋盘显示方案" })
      .getByRole("button", { name: theme })
      .click();
    await page.getByRole("button", { name: "开始游戏" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => globalThis.__HMS_PERF__?.boardFullDrawSimplifiedMs?.length ?? 0,
        ),
      )
      .toBe(index + 1);
  }

  const samples = await page.evaluate(
    () => globalThis.__HMS_PERF__?.boardFullDrawSimplifiedMs ?? [],
  );
  expect(samples).toHaveLength(4);
  expect(Math.max(...samples)).toBeLessThanOrEqual(8);
});
