import { expect, test } from "@playwright/test";

test("ISSUE-006 active runs cannot be silently replaced by config changes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "开始单人游戏" }).click();
  await page.getByRole("button", { name: "开始对局" }).click();

  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ });
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    position: { x: box.width / 2, y: box.height / 2 },
  });
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("button", { name: "结束本局并更改配置" }),
  ).toBeVisible();
  await expect(page.getByLabel("单人开局配置")).toHaveCount(0);

  await page.getByRole("button", { name: "结束本局并更改配置" }).click();
  await expect(page.getByLabel("单人开局配置")).toBeVisible();
  await expect(page.getByRole("button", { name: /^中级 16×16/ })).toBeEnabled();
});
