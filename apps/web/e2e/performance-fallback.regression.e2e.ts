import { expect, test } from "@playwright/test";

test("ISSUE-004 performance fallback stays unobtrusive", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(() => {
    globalThis.__HMS_PERF__ = {
      pointerNextPaintMs: Array.from({ length: 20 }, () => 40),
    };
    globalThis.__HMS_PERF_COUNTS__ = {
      pointerNextPaintMs: 20,
    };
  });
  await page.waitForTimeout(2_100);
  await page.evaluate(() => {
    globalThis.__HMS_PERF__?.pointerNextPaintMs?.push(
      ...Array.from({ length: 20 }, () => 40),
    );
    if (globalThis.__HMS_PERF_COUNTS__) {
      globalThis.__HMS_PERF_COUNTS__.pointerNextPaintMs = 40;
    }
  });

  await expect(
    page.getByRole("button", { name: "切换装饰效果档位" }),
  ).toContainText("轻量", { timeout: 3_000 });
  await expect(
    page.getByText(/输入或动画帧预算|降低装饰效果/),
  ).toHaveCount(0);
});
