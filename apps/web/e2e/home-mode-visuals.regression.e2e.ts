import { expect, test } from "@playwright/test";

test("home modes stay aligned with their copy, background, and selector", async ({
  page,
}) => {
  await page.goto("/");

  const modeSwitch = page.getByRole("group", { name: "游戏模式" });
  const solo = modeSwitch.getByRole("button", { name: /单人游戏/ });
  const academy = modeSwitch.getByRole("button", { name: /扫雷学院/ });
  const duel = modeSwitch.getByRole("button", { name: /1v1 对战/ });
  const hero = page.getByTestId("home-hero-visual");

  await expect(modeSwitch).toHaveCSS(
    "grid-template-columns",
    /^(\d+(\.\d+)?px ){2}\d+(\.\d+)?px$/,
  );

  const tabs = await Promise.all(
    [solo, academy, duel].map((tab) => tab.boundingBox()),
  );
  expect(tabs.every((tab) => tab !== null)).toBe(true);
  expect(tabs[0]?.y).toBeCloseTo(tabs[1]?.y ?? 0, 0);
  expect(tabs[1]?.y).toBeCloseTo(tabs[2]?.y ?? 0, 0);

  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toHaveClass(/mode-solo/);
  await expect(hero.locator(".home-mode-board")).toHaveAttribute(
    "src",
    "/hero-solo-verified-v1.svg",
  );
  await expect(page.getByRole("heading", { name: /每一局/ })).toBeVisible();

  await academy.click();
  await expect(academy).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toHaveClass(/mode-academy/);
  await expect(hero.locator(".home-mode-board")).toHaveAttribute(
    "src",
    "/hero-academy-verified-v1.svg",
  );
  await expect(page.getByRole("heading", { name: /看懂每一步/ })).toBeVisible();

  await duel.click();
  await expect(duel).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toHaveClass(/mode-duel/);
  await expect(hero.locator(".home-mode-board")).toHaveAttribute(
    "src",
    "/hero-board-h-v2.svg",
  );
  await expect(page.getByRole("heading", { name: /扫雷，终于/ })).toBeVisible();
});
