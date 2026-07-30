import { expect, test } from "@playwright/test";

test("ISSUE-005 skip links transfer focus and leave the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const mainSkipLink = page.getByRole("link", { name: "跳到主要内容" });
  await page.keyboard.press("Tab");
  await expect(mainSkipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(mainSkipLink).not.toBeFocused();

  await page.goto("/#/solo");
  const boardSkipLink = page.getByRole("link", { name: "跳到棋盘" });
  await page.keyboard.press("Tab");
  await expect(boardSkipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#solo-board")).toBeFocused();
  await expect(boardSkipLink).not.toBeFocused();

  const coveringSkipLink = await page.evaluate(() => {
    const element = document.elementFromPoint(12, 12);
    return element?.classList.contains("skip-link") ?? false;
  });
  expect(coveringSkipLink).toBe(false);
});
