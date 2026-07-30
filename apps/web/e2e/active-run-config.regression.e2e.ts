import { expect, test } from "@playwright/test";

test("ISSUE-006 active runs cannot be silently replaced by config changes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "单人游戏 · 立即开局" }).click();

  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ });
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    position: { x: box.width / 2, y: box.height / 2 },
  });
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("button", { name: /^中级 16×16/ }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "无猜模式" })).toBeDisabled();
  await expect(page.getByLabel("自定义宽度")).toBeDisabled();
  await expect(
    page.getByText(/本局进行中，难度与生成规则已锁定/),
  ).toBeVisible();

  await page.getByRole("button", { name: "放弃并换一张" }).click();
  await expect(page.getByText("等待首击", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^中级 16×16/ }),
  ).toBeEnabled();
});
