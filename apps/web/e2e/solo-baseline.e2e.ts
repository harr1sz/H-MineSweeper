import { expect, test, type Page } from "@playwright/test";
import { createBoard } from "@h-minesweeper/game-core";

const FIXED_NOW = Date.UTC(2026, 6, 30, 8);
const FIXED_RANDOM_WORD = 0x12345678;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${Array.from(
  { length: 3 },
  () => FIXED_RANDOM_WORD.toString(16).padStart(8, "0"),
).join("")}`;

async function enterSolo(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "单人游戏 · 立即开局" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "单人游戏 · 立即开局" }).click();
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

test("375x812 首页进入单人后，初级棋盘右侧列可操作且页面不横溢", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
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
    page.getByRole("button", { name: "返回模式选择" }),
  ).toBeVisible();
  await expectNoPageHorizontalOverflow(page);
});

test("刷新后恢复本地单人偏好", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await enterSolo(page);

  const expert = page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^高级 30×16/ });
  await expert.click();
  await page
    .getByRole("group", { name: "统计数据层级" })
    .getByRole("button", { name: "分析" })
    .click();
  await page
    .getByRole("group", { name: "棋盘显示方案" })
    .getByRole("button", { name: "高对比" })
    .click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("hms-solo-preferences-v1"),
      ),
    )
    .not.toBeNull();

  await page.reload();
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
  await expect(expert).toHaveClass(/is-active/);
  await expect(
    page
      .getByRole("group", { name: "统计数据层级" })
      .getByRole("button", { name: "分析" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("group", { name: "棋盘显示方案" })
      .getByRole("button", { name: "高对比" }),
  ).toHaveAttribute("aria-pressed", "true");
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
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
  await expect(page.locator(".solo-history-list article")).toHaveCount(1);

  await page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^高级 30×16/ })
    .click();
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
  await enterSolo(page);
  await page.getByRole("button", { name: "无猜模式" }).click();
  await clickBoardCell(page, 40, 9, 9);
  await expect(page.getByText("生成无猜棋盘")).toBeVisible();
  await expect(
    page.getByText(/无猜生成超过 5 秒/),
  ).toBeVisible({ timeout: 7_000 });
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

  await expect(page.getByText(/已保留 1 条旧版 PB 为只读 legacy/)).toBeVisible();
  await expect(page.getByText(/检测到 1 条损坏的旧版 PB 源值/)).toBeVisible();
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
    version: 2,
    stores: ["legacy-personal-bests-v1", "solo-runs-v1"],
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
  await expect(page.getByRole("heading", { name: "经典扫雷" })).toBeVisible();
  await expect(page.getByText(/已保留 1 条旧版 PB 为只读 legacy/)).toBeVisible();
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
      /IndexedDB.*未保存到历史/,
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
});
