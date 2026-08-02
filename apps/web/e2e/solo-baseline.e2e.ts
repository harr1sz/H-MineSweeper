import { expect, test, type Page } from "@playwright/test";
import { createBoard } from "@h-minesweeper/game-core";
import { scenariosForConcept } from "../src/lib/academy-scenarios";
import type { LearningConceptId } from "../src/lib/learning-contracts";

const FIXED_NOW = Date.UTC(2026, 6, 30, 8);
const FIXED_RANDOM_WORD = 0x12345678;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${Array.from(
  { length: 3 },
  () => FIXED_RANDOM_WORD.toString(16).padStart(8, "0"),
).join("")}`;

async function enterSoloSetup(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "开始单人游戏" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始单人游戏" }).click();
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
}

async function enterSolo(page: Page): Promise<void> {
  await enterSoloSetup(page);
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
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

async function answerAcademyScenario(page: Page, conceptId: LearningConceptId, stageIndex: number): Promise<void> {
  const scenario = scenariosForConcept(conceptId)[stageIndex];
  if (!scenario) throw new Error(`${conceptId} 缺少第 ${stageIndex + 1} 个场景`);
  const groups = [
    { action: "REVEAL", button: "◇ 判安全" },
    { action: "FLAG", button: "◆ 标雷" },
    { action: "UNDETERMINED", button: "? 当前无法确定" },
  ] as const;
  for (const group of groups) {
    const actions = scenario.expectedActions.filter(({ action }) => action === group.action);
    if (actions.length === 0) continue;
    await page.getByRole("button", { name: group.button }).click();
    for (const action of actions) {
      const row = Math.floor(action.cellIndex / scenario.board.width) + 1;
      const column = (action.cellIndex % scenario.board.width) + 1;
      await page.getByRole("button", { name: new RegExp(`未知格 ${row}行${column}列`) }).click();
    }
  }
  await page.getByRole("button", { name: "检查判断" }).click();
  await expect(page.getByText("推理已验证")).toBeVisible();
}

test("语言切换采用浏览器语言并保留当前模式状态", async ({ page }) => {
  await page.goto("/");
  const academy = page.locator(".home-mode-option").nth(1);
  await academy.click();
  await expect(academy).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "切换到英文" }).click();
  const academyEnglish = page.locator(".home-mode-option").nth(1);
  await expect(academyEnglish).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Choose a mode" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content"),
    openGraph: document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
    twitter: document.querySelector('meta[name="twitter:description"]')?.getAttribute("content"),
  }))).toEqual({
    title: "H‑MineSweeper · Solo Training Alpha",
    description: "H‑MineSweeper offers solo practice with local history, replay analysis, and the Minesweeper Academy.",
    openGraph: "Solo Minesweeper training with local history, verified replays, and guided practice.",
    twitter: "Solo Minesweeper training with local history, verified replays, and guided practice.",
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a mode" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Chinese" }).click();
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
  )).toBe("本地单人扫雷训练、可验证复盘与引导练习。");
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

test("学院和 1v1 开启态使用同一英文 catalog", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "切换到英文" }).click();
  await page.locator(".home-mode-option").nth(2).click();
  await expect(page.getByRole("button", { name: "Create 1v1 room" })).toBeVisible();
  await expect(page.getByText(/If the 1v1 service is unavailable, Solo and the Academy remain available/)).toBeVisible();
  await page.locator(".home-mode-option").nth(1).click();
  await page.getByRole("button", { name: "Start the first Academy lesson" }).click();
  await expect(page.getByRole("heading", { name: "Minesweeper Academy" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Learn the basic controls" })).toBeVisible();
  await expect.poll(() => page.locator(".academy-shell").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
});

test("学院使用 3×3 操作预热、单旗杆和理由优先的真实棋盘", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.locator(".home-mode-option").nth(1).click();
  await page.getByRole("button", { name: "扫雷学院 · 开始第一课" }).click();

  await expect(page.locator(".primer-grid .primer-cell")).toHaveCount(9);
  await page.locator(".primer-grid button").click();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.locator(".primer-grid .primer-cell")).toHaveCount(9);
  await expect(page.locator(".primer-grid .primer-cell.is-revealed")).toHaveCount(8);
  await expect(page.locator(".primer-grid .primer-cell.is-revealed")).toHaveText(["1", "1", "1", "1", "1", "1", "1", "1"]);
  await page.getByRole("button", { name: "练习插旗：右键、长按或按 F" }).press("f");
  await expect(page.locator(".academy-flag-pole")).toHaveCount(1);
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "可以直接揭开的安全格" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "根据数字可以确定安全的盖住格" }).click();
  await expect(page.getByText(/空白格.*安全/)).toBeVisible();
  await page.getByRole("button", { name: "根据数字可以确定是雷的盖住格" }).press("f");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", {
    name: "数字 1，点击后同时打开周围其余未标记的格",
  }).click();
  await page.getByRole("button", { name: "进入第一道逻辑题" }).click();

  await expect(page.locator(".academy-mini-board .academy-cell")).toHaveCount(16);
  await expect(page.locator(".academy-mini-board .cell-number")).toHaveText(["1"]);
  await page.getByRole("button", { name: "◆ 标雷" }).click();
  await page.getByRole("button", { name: /未知格 2行1列/ }).click();
  await page.getByRole("button", { name: "◇ 判安全" }).click();
  await page.getByRole("button", { name: /未知格 2行3列/ }).click();
  await page.getByRole("button", { name: "检查判断" }).click();
  await expect(page.getByText("推理已验证")).toBeVisible();
  await expect(page.locator(".academy-mini-board .is-explanation-source")).toHaveCount(1);
  await expect(page.locator(".academy-lesson")).not.toContainText(/PROOF|STATE|[A-D]\+/);
  await page.getByRole("button", { name: "下一题" }).click();
  await expect(page.getByRole("heading", { name: "数字与八邻域" })).toBeVisible();
  await expect(page.locator(".academy-mini-board .cell-unknown")).toHaveCount(3);
  await expectNoPageHorizontalOverflow(page);
  await page.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByRole("heading", { name: "Clues and eight neighbors" })).toBeVisible();
  await expect.poll(() => page.locator(".academy-shell").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
});

test("学院连锁推理使用真实 1-1-2 局面并让未完成答案得到可操作反馈", async ({ page }) => {
  await page.goto("/#/academy/practice/PRACTICE_CHAINED_FRONTS");
  await expect(page.getByRole("heading", { name: "一步接一步的推理" })).toBeVisible();
  await expect(page.locator(".academy-mini-board .cell-number")).toHaveText(["1", "1", "2"]);
  await expect(page.locator(".academy-mini-board .cell-open").filter({ hasText: /[12]/ }).first()).toBeVisible();
  const check = page.getByRole("button", { name: "检查判断" });
  await expect(check).toBeEnabled();
  await check.click();
  await expect(page.getByText("先选择要判断的盖住格。")).toBeVisible();
  await expect(page.locator(".academy-lesson")).not.toContainText(/和弦|多个前沿|\bproof\b/i);
});

test("第一张无猜棋盘要求连续完成同一张 5×5 棋盘", async ({ page }) => {
  await page.goto("/#/academy/practice/FOUNDATIONS_FIRST_BOARD");
  await expect(page.getByRole("heading", { name: "第一张无猜棋盘" })).toBeVisible();
  for (const [stageIndex, seedNumber] of [2, 3, 4, 6, 7].entries()) {
    const cells = page.locator(".academy-first-board button");
    await expect(cells).toHaveCount(25);
    await cells.nth(12).click();
    if (stageIndex === 0) {
      const revealedAfterFirstClick = await page.locator(".academy-first-board .cell-open").count();
      await page.getByRole("button", { name: "切换到英文" }).click();
      await expect(page.getByRole("heading", { name: "First no-guess board" })).toBeVisible();
      await expect(page.locator(".academy-first-board .cell-open")).toHaveCount(revealedAfterFirstClick);
      await page.getByRole("button", { name: "Switch to Chinese" }).click();
    }
    const generated = createBoard({ width: 5, height: 5, mines: 4, seed: `academy-first-${seedNumber}`, startIndex: 12, safeRadius: 1 });
    for (let index = 0; index < 25; index += 1) {
      if (generated.mines[index] === 1) continue;
      const label = await cells.nth(index).getAttribute("aria-label");
      if (label?.includes("未揭开")) await cells.nth(index).click();
    }
    await expect(page.getByText(/完成了整张无猜棋盘/)).toBeVisible();
    if (stageIndex < 4) await page.getByRole("button", { name: "下一题" }).click();
  }
  await expect(page.getByText("未见迁移题")).toBeVisible();
});

test("安全快速展开允许直接揭格，并解释错旗造成的触雷", async ({ page }) => {
  await page.goto("/#/academy/practice/PRACTICE_SAFE_CHORD");
  await expect(page.getByRole("heading", { name: "安全快速展开与错旗后果" })).toBeVisible();
  const cells = page.locator(".academy-first-board button");
  await expect(cells).toHaveCount(25);

  await cells.nth(1).click();
  await expect(page.getByText(/直接揭开了能确定安全的格/)).toBeVisible();

  await page.reload();
  const retryCells = page.locator(".academy-first-board button");
  await retryCells.nth(1).press("f");
  await retryCells.nth(0).click();
  await expect(page.getByText(/旗插在安全格上.*真正的雷/)).toBeVisible();
  await page.getByRole("button", { name: "重试这个局面" }).click();
  await retryCells.nth(5).press("f");
  await retryCells.nth(0).click();
  await expect(page.getByText(/点击已满足的数字，安全打开/)).toBeVisible();
  for (let stageIndex = 1; stageIndex < 5; stageIndex += 1) {
    await page.getByRole("button", { name: "下一题" }).click();
    const stageCells = page.locator(".academy-first-board button");
    const displayFor = (underlyingIndex: number) => Array.from({ length: 25 }, (_, displayIndex) => displayIndex)
      .find((displayIndex) => {
        const x = displayIndex % 5;
        const y = Math.floor(displayIndex / 5);
        const variant = stageIndex % 4;
        const mapped = variant === 1 ? y * 5 + (4 - x) : variant === 2 ? (4 - y) * 5 + (4 - x) : variant === 3 ? (4 - x) * 5 + y : displayIndex;
        return mapped === underlyingIndex;
      })!;
    await stageCells.nth(displayFor(5)).press("f");
    await stageCells.nth(displayFor(0)).click();
    await expect(page.getByText(/点击已满足的数字，安全打开/)).toBeVisible();
  }
  await expect(page.getByText("未见迁移题")).toBeVisible();
});

for (const conceptId of [
  "FOUNDATIONS_NEIGHBORHOOD",
  "FOUNDATIONS_FORCED_RULES",
  "REASONING_REMAINING_MINES",
  "REASONING_SUBSETS",
  "REASONING_PATTERNS",
  "REASONING_UNCERTAINTY",
  "PRACTICE_CHAINED_FRONTS",
  "PRACTICE_TRANSFER",
  "PRACTICE_REVIEW_CLINIC",
] satisfies readonly LearningConceptId[]) {
  test(`学院模块 ${conceptId} 可从演示完成到未见 checkpoint`, async ({ page }) => {
    await page.goto(`/#/academy/practice/${conceptId}`);
    for (let stageIndex = 0; stageIndex < 5; stageIndex += 1) {
      await answerAcademyScenario(page, conceptId, stageIndex);
      if (stageIndex < 4) await page.getByRole("button", { name: "下一题" }).click();
    }
    await expect(page.getByText("未见迁移题")).toBeVisible();
  });
}

test("学院基础逻辑明确解释错误判断并进入不同的下一题", async ({ page }) => {
  await page.goto("/#/academy/practice/FOUNDATIONS_NEIGHBORHOOD");
  await expect(page.getByRole("heading", { name: "数字与八邻域" })).toBeVisible();
  await page.getByRole("button", { name: /未知格 2行1列/ }).click();
  await page.getByRole("button", { name: "检查判断" }).click();
  await expect(page.getByText(/2行1列不能判为安全.*左上方是雷/)).toBeVisible();
  await expect(page.locator(".academy-mini-board .is-explanation-source")).toHaveCount(1);

  await page.getByRole("button", { name: "◆ 标雷" }).click();
  await page.getByRole("button", { name: /未知格 2行1列/ }).click();
  await page.getByRole("button", { name: "◇ 判安全" }).click();
  await page.getByRole("button", { name: /未知格 2行3列/ }).click();
  await page.getByRole("button", { name: "检查判断" }).click();
  await page.getByRole("button", { name: "下一题" }).click();
  await expect(page.getByRole("heading", { name: "数字与八邻域" })).toBeVisible();
  await expect(page.locator(".academy-mini-board .cell-unknown")).toHaveCount(3);
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
    page.getByRole("button", { name: "更改配置" }),
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
    .getByRole("group", { name: "统计数据层级" })
    .getByRole("button", { name: "详细数据" })
    .click();

  await page
    .getByRole("group", { name: "棋盘显示方案" })
    .getByRole("button", { name: "高对比" })
    .click();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("hms-solo-preferences-v1"),
      ),
    )
    .not.toBeNull();

  await page.reload();
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
  await expect(expert).toHaveClass(/is-active/);
  await expect(
    page
      .getByRole("group", { name: "统计数据层级" })
      .getByRole("button", { name: "详细数据" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("group", { name: "棋盘显示方案" })
      .getByRole("button", { name: "高对比" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "开始对局" }).click();
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
  await expect(page.getByRole("heading", { name: "触雷" })).toBeVisible();
  await page.getByRole("button", { name: "展开历史 · 1" }).click();
  await expect(page.locator(".solo-history-list article")).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
  await expect(page.locator(".solo-history-list article")).toHaveCount(1);

  await page.getByRole("button", { name: "更改配置" }).click();
  await page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^高级 30×16/ })
    .click();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(
    page.getByRole("button", { name: "当前配置 · 0" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "全部 · 1" }).click();
  await expect(page.locator(".solo-history-list article")).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^h-minesweeper-solo-history-\d{4}-\d{2}-\d{2}\.json$/,
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除全部历史" }).click();
  await expect(page.getByText("本地单人历史已删除。")).toBeVisible();
  await expect(page.locator(".solo-history-list article")).toHaveCount(0);
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
  const analyze = page.getByRole("link", { name: "分析本局" });
  await expect(analyze).toBeVisible();
  await analyze.click();
  await expect(page.getByRole("heading", { name: "终局复盘" })).toBeVisible();
  await expect(page.getByRole("img", { name: /复盘棋盘/ })).toBeVisible();
  await expect(page.getByText(/已核对 2 步/)).toBeVisible();
  await page.getByRole("button", { name: "上一步" }).click();
  await expect(page.getByText("这是受保护的首击")).toBeVisible();
  await expect(page.locator(".replay-explanation > dl")).not.toContainText(/#\d+|COMPLETE|PARTIAL|CSP_/);
  await page.locator(".replay-technical-details summary").click();
  await expect(page.locator(".replay-technical-details")).toContainText("当前可见局面分析完成");
  await expect(page.locator(".replay-technical-details")).not.toContainText(
    /COMPLETE|PARTIAL|CONTRADICTION|SINGLE_|SUBSET_|GLOBAL_|CSP_/u,
  );
  await page.getByRole("button", { name: "展开完整时间线" }).click();
  await expect(page.locator(".replay-timeline li")).toHaveCount(2);
  await expect(page.locator(".replay-timeline")).toContainText("第 1 步");
  await expect(page.locator(".replay-timeline")).not.toContainText(/REVEAL|MINE|proof|证明/);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoPageHorizontalOverflow(page);
  await page.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByRole("heading", { name: "This was a protected first click" })).toBeVisible();
  await expect.poll(() => page.locator(".replay-review-shell").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
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
      if (await page.getByRole("heading", { name: "棋盘完成" }).count()) {
        break;
      }
    }
  }
  await expect(page.getByRole("heading", { name: "棋盘完成" })).toBeVisible();
  await page.getByRole("button", { name: "展开历史 · 1" }).click();
  await expect(page.locator(".solo-history-list article")).toContainText("完成");
  await page.getByRole("link", { name: "分析本局" }).click();
  await expect(page.getByRole("heading", { name: "终局复盘" })).toBeVisible();
  await expect(page.locator(".replay-review-shell")).not.toContainText("这里不该点");
  await expect(page.locator(".replay-review-shell")).not.toContainText("复盘数据存在矛盾");
  await expect(page.getByText(/默认隐藏.*终局答案/)).toBeVisible();
  await page.getByRole("button", { name: "查看终局揭晓" }).click();
  await expect(page.getByText(/最终是(雷|安全格)/)).toBeVisible();
});

test("畸形复盘地址进入错误页而不是让应用崩溃", async ({ page }) => {
  await page.goto("/#/solo/replay/%E0%A4%A");
  await expect(page.getByRole("heading", { name: "终局复盘" })).toBeVisible();
  await expect(page.getByText("找不到这条本地记录。")).toBeVisible();
  await expect(page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
});

test("学院在 localStorage 被禁用时仍可完成操作预热", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value: () => { throw new DOMException("blocked", "SecurityError"); },
      });
    }
  });
  await page.goto("/#/academy");
  await expect(page.getByText(/本次仍可继续学习/)).toBeVisible();
  await page.locator(".primer-grid button").click();
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
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
  await page.getByRole("button", { name: "开始对局" }).click();
  await clickBoardCell(page, 40, 9, 9);
  await expect(page.getByText("生成无猜棋盘")).toBeVisible();
  await expect(
    page.getByText(/无猜生成超过 5 秒/),
  ).toBeVisible({ timeout: 9_000 });
  await page.getByRole("button", { name: "展开历史 · 0" }).click();
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

  await expect(page.getByText(/已将 1 条旧版 PB 保留为只读参考/)).toBeVisible();
  await expect(page.getByText(/检测到 1 条损坏的旧版 PB 数据/)).toBeVisible();
  await page.getByRole("button", { name: "展开历史 · 1" }).click();
  await expect(page.getByText("旧版 PB 参考")).toBeVisible();
  await expect(
    page.getByText("可比较记录").locator("..").locator("strong"),
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
  await page.getByRole("button", { name: "导出旧 PB 恢复数据" }).click();
  const recoveryDownload = await recoveryDownloadPromise;
  expect(recoveryDownload.suggestedFilename()).toMatch(
    /^h-minesweeper-solo-legacy-pb-recovery-\d{4}-\d{2}-\d{2}\.json$/,
  );

  await page.reload();
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
  await expect(page.getByText(/已将 1 条旧版 PB 保留为只读参考/)).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(
    page.getByText(/检测到 1 条损坏或未知版本记录/),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开历史 · 1" }).click();
  await expect(page.getByRole("button", { name: "导出恢复数据" })).toBeVisible();
  await expect(
    page.getByText("可比较记录").locator("..").locator("strong"),
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
  await expect(page.getByRole("heading", { name: "触雷" })).toBeVisible();
  await expect(
    page.locator(".solo-history-save-error").getByText(
      /浏览器存储.*未保存到历史/,
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
});
