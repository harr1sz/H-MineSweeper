import { expect, test } from "@playwright/test";
import { translate } from "../src/i18n";

test("home modes stay aligned with their copy, background, and selector", async ({
  page,
}) => {
  await page.goto("/");

  const modeSwitch = page.getByRole("group", { name: "游戏模式" });
  const solo = modeSwitch.getByRole("button", { name: /单人游戏/ });
  const duel = modeSwitch.getByRole("button", { name: /1v1 对战/ });
  const hero = page.getByTestId("home-hero-visual");
  const title = page.locator(".hero-mode-copy h1");

  await expect(modeSwitch).toHaveCSS(
    "grid-template-columns",
    /^\d+(\.\d+)?px \d+(\.\d+)?px$/,
  );

  const tabs = await Promise.all(
    [solo, duel].map((tab) => tab.boundingBox()),
  );
  expect(tabs.every((tab) => tab !== null)).toBe(true);
  expect(tabs[0]?.y).toBeCloseTo(tabs[1]?.y ?? 0, 0);

  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toHaveClass(/mode-solo/);
  await expect(hero.locator(".home-mode-board")).toHaveAttribute(
    "src",
    "/hero-solo-verified-v1.svg",
  );
  await expect(title).toHaveText(translate("zh-CN", "home.solo.title"));

  await duel.click();
  await expect(duel).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toHaveClass(/mode-duel/);
  await expect(hero.locator(".home-mode-board")).toHaveAttribute(
    "src",
    "/hero-board-h-v2.svg",
  );
  await expect(title).toHaveText(translate("zh-CN", "home.duel.title"));
});

test("Academy is no longer exposed from the home page or its former route", async ({ page }) => {
  await page.goto("/#/academy");
  await expect(page.getByRole("heading", { name: "选择玩法" })).toBeVisible();
  await expect(page.getByRole("button", { name: /扫雷学院/ })).toHaveCount(0);
  await expect(page.locator(".home-mode-option")).toHaveCount(2);
  await expect(page.locator(".academy-shell")).toHaveCount(0);
});

test("retired Academy progress is deleted without touching Solo preferences", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("hms-academy-progress-v2", "legacy");
    localStorage.setItem("hms-academy-progress-v3", "legacy");
    localStorage.setItem("hms-academy-progress-v4", "legacy");
    localStorage.setItem("hms-academy-primer-v1", "legacy");
    localStorage.setItem("hms-display-name", "keep-me");
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => ({
    academyKeys: Object.keys(localStorage).filter((key) => key.startsWith("hms-academy-")),
    displayName: localStorage.getItem("hms-display-name"),
  }))).toEqual({ academyKeys: [], displayName: "keep-me" });
});
