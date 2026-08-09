import { expect, test, type Locator, type Page } from "@playwright/test";
import { createBoard } from "@h-minesweeper/game-core";

const FIXED_NOW = Date.UTC(2026, 6, 30, 8);
const FIXED_RANDOM_WORD = 0x12345678;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${Array.from(
  { length: 3 },
  () => FIXED_RANDOM_WORD.toString(16).padStart(8, "0"),
).join("")}`;

async function enterSoloSetup(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "开始游戏" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByRole("heading", { name: "开始新游戏" })).toBeVisible();
}

async function enterSolo(page: Page): Promise<void> {
  await enterSoloSetup(page);
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByRole("heading", { name: "扫雷" })).toBeVisible();
}

async function expectNoPageHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function useDeterministicSoloSeed(page: Page): Promise<void> {
  await page.addInitScript(
    ({ now, randomWord }) => {
      Date.now = () => now;
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: (array: ArrayBufferView) => {
          const values = array as unknown as {
            readonly length: number;
            [index: number]: number;
          };
          for (let index = 0; index < values.length; index += 1) {
            values[index] = randomWord;
          }
          return array;
        },
      });
    },
    { now: FIXED_NOW, randomWord: FIXED_RANDOM_WORD },
  );
}

async function clickBoardCell(
  page: Page,
  index: number,
  width: number,
  height: number,
): Promise<void> {
  const board = page.getByRole("grid", {
    name: new RegExp(`^${width} 乘 ${height} 扫雷棋盘`),
  });
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    position: {
      x: ((index % width) + 0.5) * (box.width / width),
      y: (Math.floor(index / width) + 0.5) * (box.height / height),
    },
  });
}

async function clickReplayControlWithoutPageDrift(
  page: Page,
  control: Locator,
): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const box = await control.boundingBox();
  if (!box) throw new Error("复盘按钮布局不可测量");
  await page.mouse.click(
    box.x + box.width / 2,
    box.y + box.height / 2,
  );
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
}

test("语言切换采用浏览器语言并保留当前模式状态", async ({ page }) => {
  await page.goto("/");
  const duel = page.locator(".home-mode-option").nth(1);
  await duel.click();
  await expect(duel).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "切换到英文" }).click();
  const duelEnglish = page.locator(".home-mode-option").nth(1);
  await expect(duelEnglish).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Choose a mode" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content"),
    openGraph: document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
    twitter: document.querySelector('meta[name="twitter:description"]')?.getAttribute("content"),
  }))).toEqual({
    title: "H‑MineSweeper · Solo Training Alpha",
    description: "H‑MineSweeper offers solo practice with local history, replay analysis, and guided practice.",
    openGraph: "Solo Minesweeper training with local history, verified replays, and guided practice.",
    twitter: "Solo Minesweeper training with local history, verified replays, and guided practice.",
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a mode" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Chinese" }).click();
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
  )).toBe("单人扫雷、赛后复盘和针对性练习，成绩保存在你的设备上。");
});

test("320px 窄屏下语言入口保持可见且不造成横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "切换到英文" });
  await expect(toggle).toBeVisible();
  await expectNoPageHorizontalOverflow(page);
  await toggle.click();
  await expect(page.getByRole("button", { name: "Switch to Chinese" })).toBeVisible();
  await expectNoPageHorizontalOverflow(page);
});

test("进行中的棋盘切换语言不会重置局面", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await enterSolo(page);
  await clickBoardCell(page, 40, 9, 9);
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByRole("heading", { name: "Classic Minesweeper" })).toBeVisible();
  await expect(page.getByRole("grid", { name: /^9 by 9 Minesweeper board/ })).toBeVisible();
  await expect(page.getByText("In progress", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Solo history and trends" })).toBeVisible();
  await expect.poll(() => page.locator(".solo-shell").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
});


test("375x812 首页进入单人后，初级棋盘右侧列可操作且页面不横溢", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "切换到英文" })).toBeVisible();
  await enterSolo(page);

  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ });
  await expect(board).toBeVisible();
  await expectNoPageHorizontalOverflow(page);

  const boardBox = await board.boundingBox();
  const scrollBox = await page.locator(".solo-board-stage .board-scroll").boundingBox();
  expect(boardBox).not.toBeNull();
  expect(scrollBox).not.toBeNull();
  if (!boardBox || !scrollBox) throw new Error("棋盘布局不可测量");

  expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(
    scrollBox.x + scrollBox.width + 1,
  );
  const cellWidth = boardBox.width / 9;
  const cellHeight = boardBox.height / 9;
  await board.click({
    position: {
      x: boardBox.width - cellWidth / 2,
      y: cellHeight / 2,
    },
  });

  await expect(board).toHaveAttribute(
    "aria-label",
    /第 1 行，第 9 列，/,
  );
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await expectNoPageHorizontalOverflow(page);
});

test("棋盘支持键盘定位、插旗和揭格", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await enterSolo(page);

  const board = page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ });
  await board.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("f");
  await expect(board).toHaveAttribute(
    "aria-label",
    /第 1 行，第 2 列，已插旗/,
  );

  await page.keyboard.press("f");
  await page.keyboard.press("Enter");
  await expect(board).toHaveAttribute(
    "aria-label",
    /第 1 行，第 2 列，(空白|数字 \d)/,
  );
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
});

test("等效 200% 缩放的 640 CSS 像素视口保持 reflow", async ({ page }) => {
  // A 1280px-wide browser viewed at 200% exposes roughly 640 CSS px to layout.
  // Testing that effective viewport catches fixed-width overflow without relying
  // on Chromium-only DevTools zoom commands.
  await page.setViewportSize({ width: 640, height: 720 });
  await enterSolo(page);

  await expect(
    page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "游戏设置" }),
  ).toBeVisible();
  await expectNoPageHorizontalOverflow(page);
});

test("刷新后恢复本地单人偏好", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSoloSetup(page);

  const expert = page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^高级 30×16/ });
  await expert.click();
  await page
    .getByRole("group", { name: "对局数据详细程度" })
    .getByRole("button", { name: "详细" })
    .click();

  await page
    .getByRole("group", { name: "棋盘显示方案" })
    .getByRole("button", { name: "象牙战术" })
    .click();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByRole("heading", { name: "扫雷" })).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("hms-solo-preferences-v1"),
      ),
    )
    .not.toBeNull();

  await page.reload();
  await expect(page.getByRole("heading", { name: "开始新游戏" })).toBeVisible();
  await expect(expert).toHaveClass(/is-active/);
  await expect(
    page
      .getByRole("group", { name: "对局数据详细程度" })
      .getByRole("button", { name: "详细" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("group", { name: "棋盘显示方案" })
      .getByRole("button", { name: "象牙战术" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(
    page.getByRole("grid", { name: /^30 乘 16 扫雷棋盘/ }),
  ).toBeVisible();
});

test("终局历史可刷新恢复、筛选、导出并明确删除", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSolo(page);

  const spec = {
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1 as const,
  };
  const generated = createBoard(spec);
  const mineIndex = generated.mines.findIndex((value) => value === 1);
  expect(mineIndex).toBeGreaterThanOrEqual(0);

  await clickBoardCell(page, 40, 9, 9);
  await clickBoardCell(page, mineIndex, 9, 9);
  await expect(page.getByRole("heading", { name: "踩雷了" })).toBeVisible();
  await expect(
    page.getByText("最终点击速度（CPS）", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("这局没有完成，因此不计算解题速度和操作效率。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看记录 · 1" }).click();
  const lossHistoryRow = page.locator(".solo-history-list article");
  await expect(lossHistoryRow).toHaveCount(1);
  await expect(lossHistoryRow).toContainText("解题速度（3BV/s） —");
  await expect(lossHistoryRow).toContainText("操作效率（IOE） —");
  const persistedLossMetrics = await page.evaluate(async () => {
    return await new Promise<{ threeBvPerSecond: unknown; ioe: unknown }>(
      (resolve, reject) => {
        const request = indexedDB.open("h-minesweeper-solo-history-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("solo-runs-v1", "readonly");
          const read = transaction.objectStore("solo-runs-v1").getAll();
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            const record = read.result[0] as {
              metrics: { threeBvPerSecond: unknown; ioe: unknown };
            };
            resolve(record.metrics);
          };
          transaction.oncomplete = () => database.close();
        };
      },
    );
  });
  expect(persistedLossMetrics).toMatchObject({
    threeBvPerSecond: null,
    ioe: null,
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "开始新游戏" })).toBeVisible();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByRole("heading", { name: "扫雷" })).toBeVisible();
  await expect(page.locator(".solo-history-list article")).toHaveCount(1);

  await page.getByRole("button", { name: "游戏设置" }).click();
  await page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^高级 30×16/ })
    .click();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(
    page.getByRole("button", { name: "当前设置 · 0" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "全部 · 1" }).click();
  await expect(page.locator(".solo-history-list article")).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出记录" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^h-minesweeper-solo-history-\d{4}-\d{2}-\d{2}\.json$/,
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除所有记录" }).click();
  await expect(page.getByText("游戏记录已删除")).toBeVisible();
  await expect(page.locator(".solo-history-list article")).toHaveCount(0);
});

test("普通游戏结束后可以立即重玩完全相同的棋盘", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSolo(page);
  const generated = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1,
  });
  const mineIndex = generated.mines.findIndex((value) => value === 1);

  await clickBoardCell(page, 40, 9, 9);
  await clickBoardCell(page, mineIndex, 9, 9);
  await expect(page.getByRole("heading", { name: "踩雷了" })).toBeVisible();
  const firstBoardHash = await page.locator(".solo-proof code").textContent();

  await page.getByRole("button", { name: "重玩本图", exact: true }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await expect(page.getByText("已按原来的雷位重开本图，计时重新开始。")).toBeVisible();
  await expect(page.locator(".solo-proof code")).toHaveText(firstBoardHash ?? "");
  await expect(page.getByRole("heading", { name: "踩雷了" })).toHaveCount(0);

  await clickBoardCell(page, mineIndex, 9, 9);
  await expect(page.getByRole("heading", { name: "踩雷了" })).toBeVisible();
});

test("新终局可打开已验证复盘并逐步浏览", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSolo(page);
  const generated = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1,
  });
  const mineIndex = generated.mines.findIndex((value) => value === 1);
  await clickBoardCell(page, 40, 9, 9);
  await clickBoardCell(page, mineIndex, 9, 9);
  const analyze = page.getByRole("link", { name: "复盘本局" });
  await expect(analyze).toBeVisible();
  await analyze.click();
  await expect(page.getByRole("heading", { name: "本局复盘" })).toBeVisible();
  await expect(page.getByRole("img", { name: /复盘棋盘/ })).toBeVisible();
  await expect(page.getByText(/已检查 2 步/)).toBeVisible();
  const previousStep = page.getByRole("button", { name: "上一步" });
  await clickReplayControlWithoutPageDrift(page, previousStep);
  await expect(page.getByText("这是受保护的首击")).toBeVisible();
  await clickReplayControlWithoutPageDrift(
    page,
    page.getByRole("button", { name: "下一步" }),
  );
  await clickReplayControlWithoutPageDrift(
    page,
    page.getByRole("button", { name: "上一关键步" }),
  );
  await clickReplayControlWithoutPageDrift(
    page,
    page.getByRole("button", { name: "下一关键步" }),
  );
  await clickReplayControlWithoutPageDrift(
    page,
    page.getByRole("button", { name: "查看动作后" }),
  );
  await clickReplayControlWithoutPageDrift(
    page,
    page.getByRole("button", { name: "查看完整棋盘" }),
  );
  await clickReplayControlWithoutPageDrift(page, previousStep);
  await expect(page.getByText("这是受保护的首击")).toBeVisible();
  await expect(page.locator(".replay-explanation > dl")).not.toContainText(/#\d+|COMPLETE|PARTIAL|CSP_/);
  await page.locator(".replay-technical-details summary").click();
  await expect(page.locator(".replay-technical-details")).toContainText(
    "这一步已经检查完成",
  );
  await expect(page.locator(".replay-technical-details")).not.toContainText(
    /COMPLETE|PARTIAL|CONTRADICTION|SINGLE_|SUBSET_|GLOBAL_|CSP_/u,
  );
  await clickReplayControlWithoutPageDrift(
    page,
    page.getByRole("button", { name: "查看每一步" }),
  );
  await expect(page.locator(".replay-timeline li")).toHaveCount(2);
  await expect(page.locator(".replay-timeline")).toContainText("第 1 步");
  await expect(page.locator(".replay-timeline")).not.toContainText(/REVEAL|MINE|proof|证明/);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoPageHorizontalOverflow(page);
  await page.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByRole("heading", { name: "This was a protected first click" })).toBeVisible();
  await expect.poll(() => page.locator(".replay-review-shell").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
});

test("复盘中的问题可直接启动同规格专项练习", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSolo(page);
  const generated = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1,
  });
  const mineIndex = generated.mines.findIndex((value) => value === 1);
  await clickBoardCell(page, 40, 9, 9);
  await clickBoardCell(page, mineIndex, 9, 9);
  await page.getByRole("link", { name: "复盘本局" }).click();
  await expect(page.getByRole("heading", { name: "本局复盘" })).toBeVisible();

  const targetedPractice = page.getByRole("link", { name: "练习这类问题" }).first();
  await expect(targetedPractice).toBeVisible();
  await targetedPractice.click();

  await expect(page).toHaveURL(/#\/solo\/practice\?/u);
  await expect(page.getByText("引导练习", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("grid", { name: /^9 乘 9 扫雷棋盘/u })).toBeVisible();
  await expect(page.locator(".practice-launch-context")).toContainText(/上一局第 \d+ 步/);
  await expect(page.locator(".practice-launch-context")).toContainText("棋盘会换成新的");
  await expect(page.getByText("练习记录 · 不计成绩", { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("hms-guided-practice-started-v1"),
  )).toBe("1");
});

test("畸形专项练习地址不会应用无效棋盘配置", async ({ page }) => {
  await page.goto("/#/solo/practice?source=bad%20id&w=999&h=9&m=10&step=0&error=WRONG_FLAG&mode=classic");
  await expect(page.getByRole("heading", { name: "开始新游戏" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始游戏" })).toBeVisible();
  await expect(page.getByRole("grid", { name: /扫雷棋盘/u })).toHaveCount(0);
});

test("确定性棋盘可完成胜局并写入历史", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSolo(page);

  const generated = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1,
  });
  await clickBoardCell(page, 40, 9, 9);
  for (let index = 0; index < generated.mines.length; index += 1) {
    if (generated.mines[index] === 0) {
      await clickBoardCell(page, index, 9, 9);
      if (await page.getByRole("heading", { name: "完成" }).count()) {
        break;
      }
    }
  }
  await expect(page.getByRole("heading", { name: "完成" })).toBeVisible();
  await page.getByRole("button", { name: "查看记录 · 1" }).click();
  await expect(page.locator(".solo-history-list article")).toContainText("完成");
  await page.getByRole("link", { name: "复盘本局" }).click();
  await expect(page.getByRole("heading", { name: "本局复盘" })).toBeVisible();
  await expect(page.locator(".replay-review-shell")).not.toContainText("这里不该点");
  await expect(page.locator(".replay-review-shell")).not.toContainText("复盘数据存在矛盾");
  await expect(page.getByRole("link", { name: "练习这类问题" })).toHaveCount(0);
  await expect(page.getByText(/完整棋盘默认隐藏.*最后的答案/)).toBeVisible();
  await page.getByRole("button", { name: "查看完整棋盘" }).click();
  await expect(page.getByText(/最终是(雷|安全格)/)).toBeVisible();
});

test("畸形复盘地址进入错误页而不是让应用崩溃", async ({ page }) => {
  await page.goto("/#/solo/replay/%E0%A4%A");
  await expect(page.getByRole("heading", { name: "本局复盘" })).toBeVisible();
  await expect(page.getByText("找不到这局游戏的记录。")).toBeVisible();
  await expect(page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
});

test("无猜生成超过五秒后回退，不制造终局记录", async ({ page }) => {
  await page.addInitScript(() => {
    class NeverRespondingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(): void {}
      terminate(): void {}
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: NeverRespondingWorker,
    });
  });
  await enterSoloSetup(page);
  await page.getByRole("button", { name: "无猜模式" }).click();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await clickBoardCell(page, 40, 9, 9);
  await expect(page.getByText("正在准备无猜棋盘").first()).toBeVisible();
  await expect(
    page.getByText(/无猜棋盘准备时间太长/),
  ).toBeVisible({ timeout: 9_000 });
  await page.getByRole("button", { name: "查看记录 · 0" }).click();
  await expect(page.locator(".solo-history-list article")).toHaveCount(0);
});

test("旧版 PB 幂等迁移为独立元数据，坏值可恢复且不进入趋势", async ({
  page,
}) => {
  const validKey = "hms-solo-best-v1:9x9:10:classic";
  const invalidKey = "hms-solo-best-v1:16x16:40:classic";
  const validRaw = JSON.stringify({
    elapsedMs: 12_345,
    completedAt: Date.UTC(2026, 6, 29, 8),
    metricRulesVersion: "HMS-statistics-v1",
    trustStatus: "LOCAL_UNVERIFIED",
  });
  const invalidRaw = "{not-json";
  await page.goto("/og.png");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1", 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("solo-runs-v1", {
          keyPath: "recordId",
        });
        store.createIndex("completedAt", "completedAt");
        store.add({
          schemaVersion: 1,
          recordId: "pre-upgrade-run",
          trainingSessionId: "pre-upgrade-session",
          completedAt: "2026-07-28T08:00:00.000Z",
          outcome: "LOST",
          config: {
            preset: "intermediate",
            width: 16,
            height: 16,
            mines: 40,
            generationMode: "classic",
          },
          board: {
            seed: "pre-upgrade-seed",
            boardHash: "pre-upgrade-hash",
            trustStatus: "LOCAL_UNVERIFIED",
          },
          rules: { metricRulesVersion: 1, gameRulesVersion: 1 },
          metrics: {
            elapsedMs: 1_000,
            board3BV: 50,
            cps: 1,
            threeBvPerSecond: 1,
            ioe: 1,
            physicalClicks: 1,
            semanticActions: 1,
            acceptedActions: 1,
            wastedActions: 0,
            reveals: 1,
            flags: 0,
            unflags: 0,
            chords: 0,
          },
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
  });
  await page.addInitScript(
    ({ validKey, validRaw, invalidKey, invalidRaw }) => {
      localStorage.setItem(validKey, validRaw);
      localStorage.setItem(invalidKey, invalidRaw);
    },
    { validKey, validRaw, invalidKey, invalidRaw },
  );
  await enterSolo(page);

  await expect(page.getByText(/已保留 1 条旧版最佳成绩作为参考/)).toBeVisible();
  await expect(page.getByText(/发现 1 条损坏的旧版最佳成绩/)).toBeVisible();
  await page.getByRole("button", { name: "查看记录 · 1" }).click();
  await expect(page.getByText("旧版最佳成绩", { exact: true })).toBeVisible();
  await expect(
    page.getByText("可以比较的游戏").locator("..").locator("strong"),
  ).toHaveText("0");
  await expect(page.locator(".solo-history-list article")).toHaveCount(0);

  const firstSnapshot = await page.evaluate(async () => {
    return await new Promise<{
      version: number;
      stores: string[];
      metadata: Record<string, unknown>[];
      runCount: number;
    }>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(
          ["legacy-personal-bests-v1", "solo-runs-v1"],
          "readonly",
        );
        const metadataRead = transaction
          .objectStore("legacy-personal-bests-v1")
          .getAll();
        const runCountRead = transaction.objectStore("solo-runs-v1").count();
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          resolve({
            version: database.version,
            stores: Array.from(database.objectStoreNames),
            metadata: metadataRead.result,
            runCount: runCountRead.result,
          });
          database.close();
        };
      };
    });
  });
  expect(firstSnapshot).toMatchObject({
    version: 4,
    stores: [
      "legacy-personal-bests-v1",
      "practice-replays-v1",
      "practice-runs-v1",
      "solo-replays-v1",
      "solo-runs-v1",
    ],
    runCount: 1,
  });
  expect(firstSnapshot.metadata).toHaveLength(1);
  expect(firstSnapshot.metadata[0]).toMatchObject({
    schemaVersion: 1,
    kind: "LEGACY_PERSONAL_BEST",
    source: { key: validKey, rawValue: validRaw },
    best: { elapsedMs: 12_345, trustStatus: "LOCAL_UNVERIFIED" },
  });
  expect(firstSnapshot.metadata[0]).not.toHaveProperty("outcome");
  expect(
    await page.evaluate(
      ({ validKey, invalidKey }) => ({
        valid: localStorage.getItem(validKey),
        invalid: localStorage.getItem(invalidKey),
      }),
      { validKey, invalidKey },
    ),
  ).toEqual({ valid: validRaw, invalid: invalidRaw });

  const recoveryDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出旧版最佳成绩" }).click();
  const recoveryDownload = await recoveryDownloadPromise;
  expect(recoveryDownload.suggestedFilename()).toMatch(
    /^h-minesweeper-solo-legacy-pb-recovery-\d{4}-\d{2}-\d{2}\.json$/,
  );

  await page.reload();
  await expect(page.getByRole("heading", { name: "开始新游戏" })).toBeVisible();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByRole("heading", { name: "扫雷" })).toBeVisible();
  await expect(page.getByText(/已保留 1 条旧版最佳成绩作为参考/)).toBeVisible();
  const secondMetadata = await page.evaluate(async () => {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(
          "legacy-personal-bests-v1",
          "readonly",
        );
        const read = transaction
          .objectStore("legacy-personal-bests-v1")
          .getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
        transaction.oncomplete = () => database.close();
      };
    });
  });
  expect(secondMetadata).toEqual(firstSnapshot.metadata);
});

test("损坏历史保留原文并从趋势中隔离", async ({ page }) => {
  await enterSolo(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("solo-runs-v1", "readwrite");
        transaction.objectStore("solo-runs-v1").put({
          recordId: "corrupt-record",
          schemaVersion: 999,
          privateUnexpectedField: "must-stay-local",
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "开始新游戏" })).toBeVisible();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(
    page.getByText(/发现 1 条损坏或无法识别的记录/),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看记录 · 1" }).click();
  await expect(page.getByRole("button", { name: "导出恢复数据" })).toBeVisible();
  await expect(
    page.getByText("可以比较的游戏").locator("..").locator("strong"),
  ).toHaveText("0");
});

test("IndexedDB 不可用时游戏继续且明确标记本局未保存", async ({ page }) => {
  await useDeterministicSoloSeed(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
  });
  await enterSolo(page);
  const generated = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: 40,
    safeRadius: 1,
  });
  const mineIndex = generated.mines.findIndex((value) => value === 1);
  await clickBoardCell(page, 40, 9, 9);
  await clickBoardCell(page, mineIndex, 9, 9);
  await expect(page.getByRole("heading", { name: "踩雷了" })).toBeVisible();
  await expect(
    page.locator(".solo-history-save-error").getByText(
      /浏览器存储不可用.*这局成绩没有保存/,
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
});
