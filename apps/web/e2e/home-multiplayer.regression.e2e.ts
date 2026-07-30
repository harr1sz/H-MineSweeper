import { expect, test } from "@playwright/test";

test("ISSUE-001 keeps the 1v1 product entry visible", async ({ page }) => {
  await page.goto("/");

  const duelEntry = page.getByRole("button", { name: /1v1 对战/ });
  await expect(duelEntry).toBeVisible();
  await duelEntry.click();
  await expect(
    page.getByRole("button", { name: "创建 1v1 房间" }),
  ).toBeVisible();
});
