import {
  createBoard,
  createGameState,
  revealCell,
} from "@h-minesweeper/game-core";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  createCoachRequest,
  runCoachRequest,
  visibleBoardStateForPractice,
} from "../src/lib/practice-coach";
import {
  hashPracticeReplay,
  type PracticeHistoryExportV1,
  type PracticeReplayV1,
  type PracticeRunRecordV1,
} from "../src/lib/practice-history";

const FIXED_NOW = Date.UTC(2026, 7, 2, 4);
const FIXED_RANDOM_WORD = 0x2468_ace0;
const FIXED_SEED = `solo-v1-${FIXED_NOW.toString(36)}-${Array.from(
  { length: 3 },
  () => FIXED_RANDOM_WORD.toString(16).padStart(8, "0"),
).join("")}`;
const FIRST_INDEX = 40;
const PROOF_REVEAL_INDEX = 8;
const SAFE_STATE_CHANGE_INDEX = 22;

interface PracticeTestEnvironmentOptions {
  readonly failFirstCoachWorker?: boolean;
  readonly stallCoachWorkerNumber?: number;
}

async function useDeterministicPracticeEnvironment(
  page: Page,
  options: PracticeTestEnvironmentOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ now, randomWord, failFirstCoachWorker, stallCoachWorkerNumber }) => {
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
      localStorage.clear();

      if (!failFirstCoachWorker && stallCoachWorkerNumber === undefined) return;
      const NativeWorker = globalThis.Worker;
      const workerState = { coachStarts: 0 };
      Object.defineProperty(globalThis, "__HMS_E2E_COACH_WORKER_STATE__", {
        configurable: true,
        value: workerState,
      });

      class ErroringCoachWorker {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
        private terminated = false;

        postMessage(): void {
          queueMicrotask(() => {
            if (this.terminated) return;
            this.onerror?.(new ErrorEvent("error", {
              message: "intentional one-shot practice coach transport failure",
            }));
          });
        }

        terminate(): void {
          this.terminated = true;
        }
      }

      class StalledCoachWorker {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;

        postMessage(): void {
          // Intentionally leave this request unresolved until the UI cancels it.
        }

        terminate(): void {
          // No native resources are allocated by this deterministic test double.
        }
      }

      const ControlledCoachWorker = function (
        this: unknown,
        url: string | URL,
        workerOptions?: WorkerOptions,
      ): Worker {
        const href = String(url);
        if (href.includes("practiceCoachWorker")) {
          workerState.coachStarts += 1;
          if (failFirstCoachWorker && workerState.coachStarts === 1) {
            return new ErroringCoachWorker() as unknown as Worker;
          }
        }
        if (
          href.includes("practiceCoachWorker") &&
          workerState.coachStarts === stallCoachWorkerNumber
        ) {
          return new StalledCoachWorker() as unknown as Worker;
        }
        return new NativeWorker(url, workerOptions);
      } as unknown as typeof Worker;
      ControlledCoachWorker.prototype = NativeWorker.prototype;
      Object.setPrototypeOf(ControlledCoachWorker, NativeWorker);
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: ControlledCoachWorker,
      });
    },
    {
      now: FIXED_NOW,
      randomWord: FIXED_RANDOM_WORD,
      failFirstCoachWorker: options.failFirstCoachWorker === true,
      stallCoachWorkerNumber: options.stallCoachWorkerNumber,
    },
  );
}

async function enterClassicGuidedPractice(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "引导练习" }).click();
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
  await expect(page.getByRole("button", { name: "引导练习" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "经典模式" }).click();
  await expect(page.getByText(/经典模式可能遇到无法从当前信息确定的局面/u)).toBeVisible();
  await page.getByRole("button", { name: "开始对局" }).click();
  await expect(page.getByRole("heading", { name: "实时教练" })).toBeVisible();
}

function fixedBoard() {
  return createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: FIRST_INDEX,
    safeRadius: 1,
  });
}

function provenMineTargetsAfterProofReveal(): readonly number[] {
  const state = createGameState(fixedBoard());
  revealCell(state, FIRST_INDEX);
  revealCell(state, PROOF_REVEAL_INDEX);
  const visibleState = visibleBoardStateForPractice(state);
  return runCoachRequest(createCoachRequest(1, visibleState)).mineActions.map(
    ({ cellIndex }) => cellIndex,
  );
}

async function clickBoardCell(
  page: Page,
  index: number,
  button: "left" | "right" = "left",
): Promise<void> {
  const board = page.locator(".mine-board");
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    button,
    position: {
      x: ((index % 9) + 0.5) * (box.width / 9),
      y: (Math.floor(index / 9) + 0.5) * (box.height / 9),
    },
  });
}

function remainingMines(page: Page) {
  return page.locator(".solo-stats > div").filter({ hasText: "剩余雷数" }).locator("strong");
}

async function expectPracticeSaved(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "触雷" })).toBeVisible();
  await expect(page.getByText("练习记录和复盘已保存。本局不计入成绩。")).toBeVisible();
}

async function readOnlyPracticeReplays(page: Page): Promise<readonly PracticeReplayV1[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const replays = await new Promise<PracticeReplayV1[]>((resolve, reject) => {
      const transaction = database.transaction("practice-replays-v1", "readonly");
      const request = transaction.objectStore("practice-replays-v1").getAll();
      request.onsuccess = () => resolve(request.result as PracticeReplayV1[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return replays;
  });
}

async function readPracticeStoreSnapshot(page: Page): Promise<{
  readonly runCount: number;
  readonly replayCount: number;
  readonly records: readonly PracticeRunRecordV1[];
}> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = <T,>(storeName: string) => new Promise<T[]>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly")
        .objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
    const records = await readAll<PracticeRunRecordV1>("practice-runs-v1");
    const replays = await readAll<PracticeReplayV1>("practice-replays-v1");
    database.close();
    return {
      runCount: records.length,
      replayCount: replays.length,
      records,
    };
  });
}

interface StandardScoreState {
  readonly standardRuns: readonly unknown[];
  readonly standardReplays: readonly unknown[];
  readonly legacyPersonalBests: readonly unknown[];
  readonly legacyBestSource: string | null;
  readonly academyProgress: string | null;
}

async function readStandardScoreState(page: Page): Promise<StandardScoreState> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (storeName: string) => new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly")
        .objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const normalize = (values: readonly unknown[]) => [...values].sort((left, right) => {
      const leftId = typeof left === "object" && left !== null && "recordId" in left
        ? String(left.recordId)
        : JSON.stringify(left);
      const rightId = typeof right === "object" && right !== null && "recordId" in right
        ? String(right.recordId)
        : JSON.stringify(right);
      return leftId.localeCompare(rightId);
    });
    const snapshot = {
      standardRuns: normalize(await readAll("solo-runs-v1")),
      standardReplays: normalize(await readAll("solo-replays-v1")),
      legacyPersonalBests: normalize(await readAll("legacy-personal-bests-v1")),
      legacyBestSource: localStorage.getItem("hms-solo-best-v1:9x9:10:classic"),
      academyProgress: localStorage.getItem("hms-academy-progress-v2"),
    };
    database.close();
    return snapshot;
  });
}

test("guided practice stays fully localized through setup, coaching, result, history, and replay", async ({
  page,
}) => {
  await useDeterministicPracticeEnvironment(page);
  await page.goto("/");
  await page.getByRole("button", { name: "切换到英文" }).click();
  await page.getByRole("button", { name: "Guided practice" }).click();
  await expect(page.getByRole("heading", { name: "Set up a solo game" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Guided practice" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(".solo-setup-section")
    .filter({ hasText: "Board generation" })
    .getByRole("button", { name: "Classic" })
    .click();
  await expect(page.getByText(/will not use hidden mine locations/u)).toBeVisible();
  await page.getByRole("button", { name: "Start game" }).click();
  await expect(page.getByRole("heading", { name: "Live coach" })).toBeVisible();

  await clickBoardCell(page, FIRST_INDEX);
  await page.getByRole("button", { name: "Show hint" }).click();
  await expect(page.locator(".practice-coach-message")).not.toContainText("Analyzing");

  // Exercise the new stateful coach copy in both directions. The visible
  // board and displayed suggestion must survive without retaining old text.
  await page.getByRole("button", { name: "Switch to Chinese" }).click();
  await expect(page.getByRole("heading", { name: "实时教练" })).toBeVisible();
  await page.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByRole("heading", { name: "Live coach" })).toBeVisible();
  await expect.poll(() => page.locator("main").innerText()).not.toMatch(/[\u3400-\u9fff]/u);

  const mineIndex = fixedBoard().mines.findIndex((value) => value === 1);
  await clickBoardCell(page, mineIndex);
  await expect(page.getByRole("heading", { name: "Mine hit" })).toBeVisible();
  await expect(page.getByText(/practice record and replay were saved/u)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Practice history" })).toBeVisible();
  await page.getByRole("link", { name: "Review this game" }).click();
  await expect(page.getByRole("heading", { name: "Practice game review" })).toBeVisible();
  await expect(page.getByText(/\d+ practice events? checked/u)).toBeVisible();
  await expect.poll(() => page.locator(".practice-replay-shell").innerText())
    .not.toMatch(/[\u3400-\u9fff]/u);
});

test("guided practice stays score-isolated and saves a verified practice replay", async ({
  page,
}) => {
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
      localStorage.clear();
    },
    { now: FIXED_NOW, randomWord: FIXED_RANDOM_WORD },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "引导练习" }).click();
  await expect(page.getByRole("heading", { name: "配置单人对局" })).toBeVisible();
  await expect(page.getByRole("button", { name: "引导练习" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "经典模式" }).click();
  await expect(page.getByText(/经典模式可能遇到无法从当前信息确定的局面/u)).toBeVisible();
  await page.getByRole("button", { name: "开始对局" }).click();

  await expect(page.getByRole("heading", { name: "实时教练" })).toBeVisible();
  await expect(page.getByText("练习记录 · 不计成绩").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "立即提示" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "示范下一步" })).toBeEnabled();
  await expect(page.getByText("自动标雷", { exact: true })).toBeVisible();

  const firstIndex = 40;
  const board = createBoard({
    width: 9,
    height: 9,
    mines: 10,
    seed: FIXED_SEED,
    startIndex: firstIndex,
    safeRadius: 1,
  });
  const mineIndex = board.mines.findIndex((value) => value === 1);
  expect(mineIndex).toBeGreaterThanOrEqual(0);
  await clickBoardCell(page, firstIndex);
  await page.getByRole("button", { name: "立即提示" }).click();
  await expect(page.locator(".practice-coach-message")).not.toContainText("正在分析");
  await clickBoardCell(page, mineIndex);

  await expect(page.getByRole("heading", { name: "触雷" })).toBeVisible();
  await expect(page.getByText("练习记录和复盘已保存。本局不计入成绩。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "练习历史" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /历史|趋势/u })).toHaveCount(1);
  await expect(page.getByText(/新 PB|当前规则最佳/u)).toHaveCount(0);

  const counts = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = (storeName: string) => new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      standardRuns: await count("solo-runs-v1"),
      standardReplays: await count("solo-replays-v1"),
      practiceRuns: await count("practice-runs-v1"),
      practiceReplays: await count("practice-replays-v1"),
    };
    database.close();
    return result;
  });
  expect(counts).toEqual({
    standardRuns: 0,
    standardReplays: 0,
    practiceRuns: 1,
    practiceReplays: 1,
  });

  await page.getByRole("link", { name: "分析本局" }).click();
  await expect(page.getByRole("heading", { name: "练习局复盘" })).toBeVisible();
  await expect(page.getByText(/已验证 \d+ 个练习事件/u)).toBeVisible();
});

test("a practice terminal leaves existing standard history, PB, trend input, and Academy mastery unchanged", async ({
  page,
}) => {
  await useDeterministicPracticeEnvironment(page);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("hms-solo-best-v1:9x9:10:classic", JSON.stringify({
      elapsedMs: 12_345,
      completedAt: Date.UTC(2026, 7, 1, 8),
      metricRulesVersion: "HMS-statistics-v1",
      trustStatus: "LOCAL_UNVERIFIED",
    }));
    localStorage.setItem("hms-academy-progress-v2", JSON.stringify({
      version: 2,
      completedExerciseIds: ["c0-all-mine", "c0-satisfied"],
      attempts: 4,
      correctAttempts: 4,
      hintRequests: 0,
      highestHintByExercise: {},
      recentAttemptsByExercise: {},
      updatedAt: Date.UTC(2026, 7, 1, 9),
    }));
  });

  await page.getByRole("button", { name: "单人游戏 · 配置开局" }).click();
  await page.locator(".solo-setup-section")
    .filter({ hasText: "生成规则" })
    .getByRole("button", { name: "经典模式" })
    .click();
  await page.getByRole("button", { name: "开始对局" }).click();
  await clickBoardCell(page, FIRST_INDEX);
  await clickBoardCell(page, fixedBoard().mines.findIndex((value) => value === 1));
  await expect(page.getByRole("heading", { name: "触雷" })).toBeVisible();
  await expect.poll(async () => (await readStandardScoreState(page)).standardRuns.length)
    .toBe(1);
  await expect.poll(async () => (await readStandardScoreState(page)).standardReplays.length)
    .toBe(1);
  await expect(page.getByText(/已将 1 条旧版 PB 保留为只读参考/u)).toBeVisible();
  const beforePractice = await readStandardScoreState(page);

  await page.getByRole("button", { name: "返回首页" }).click();
  await page.getByRole("button", { name: "引导练习" }).click();
  await page.locator(".solo-setup-section")
    .filter({ hasText: "生成规则" })
    .getByRole("button", { name: "经典模式" })
    .click();
  await page.getByRole("button", { name: "开始对局" }).click();
  await clickBoardCell(page, FIRST_INDEX);
  await clickBoardCell(page, fixedBoard().mines.findIndex((value) => value === 1));
  await expectPracticeSaved(page);

  expect(await readStandardScoreState(page)).toEqual(beforePractice);
  expect(await readPracticeStoreSnapshot(page)).toMatchObject({
    runCount: 1,
    replayCount: 1,
  });
});

test("practice history clears and imports both stores atomically without hiding older records", async ({
  page,
}) => {
  await useDeterministicPracticeEnvironment(page);
  await enterClassicGuidedPractice(page);
  await clickBoardCell(page, FIRST_INDEX);
  await clickBoardCell(page, fixedBoard().mines.findIndex((value) => value === 1));
  await expectPracticeSaved(page);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出练习 JSON" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("练习导出文件不可读取");
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as PracticeHistoryExportV1;
  expect(exported.records).toHaveLength(1);
  expect(exported.replays).toHaveLength(1);

  await page.getByRole("button", { name: "删除练习历史" }).click();
  await page.getByRole("button", { name: "再次点击确认删除" }).click();
  await expect(page.getByText("练习历史已删除。标准对局历史未修改。")).toBeVisible();
  await expect(readPracticeStoreSnapshot(page)).resolves.toMatchObject({
    runCount: 0,
    replayCount: 0,
  });

  const baseRecord = exported.records[0]!;
  const baseReplay = exported.replays[0]!;
  const records: PracticeRunRecordV1[] = [];
  const replays: PracticeReplayV1[] = [];
  for (let index = 0; index < 21; index += 1) {
    const recordId = `${baseRecord.recordId}-import-${index}`;
    const replay: PracticeReplayV1 = {
      ...structuredClone(baseReplay),
      recordId,
    };
    const record: PracticeRunRecordV1 = {
      ...structuredClone(baseRecord),
      recordId,
      completedAt: new Date(Date.parse(baseRecord.completedAt) - index * 1_000).toISOString(),
      replay: {
        ...baseRecord.replay,
        eventLogHash: hashPracticeReplay(replay),
      },
    };
    records.push(record);
    replays.push(replay);
  }
  const bulkDocument: PracticeHistoryExportV1 = {
    ...exported,
    recordCount: records.length,
    records,
    replays,
  };
  const importInput = page.locator(".practice-history-import input");
  await importInput.setInputFiles({
    name: "practice-21.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bulkDocument)),
  });
  await expect(page.getByText(/导入完成：新增 21 条/u)).toBeVisible();
  await expect(readPracticeStoreSnapshot(page)).resolves.toMatchObject({
    runCount: 21,
    replayCount: 21,
  });
  await expect(page.locator(".practice-history-list article")).toHaveCount(20);
  await page.getByRole("button", { name: "显示更多" }).click();
  await expect(page.locator(".practice-history-list article")).toHaveCount(21);

  const conflictDocument: PracticeHistoryExportV1 = {
    ...bulkDocument,
    recordCount: 1,
    records: [{
      ...records[0]!,
      completedAt: "2026-08-02T12:34:56.000Z",
    }],
    replays: [replays[0]!],
  };
  await importInput.setInputFiles({
    name: "practice-conflict.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(conflictDocument)),
  });
  await expect(page.getByText("导入失败，整批数据均未写入。")).toBeVisible();
  const afterConflict = await readPracticeStoreSnapshot(page);
  expect(afterConflict).toMatchObject({ runCount: 21, replayCount: 21 });
  expect(afterConflict.records.find(({ recordId }) => recordId === records[0]!.recordId)?.completedAt)
    .toBe(records[0]!.completedAt);

  const overCapacityDocument = {
    format: "h-minesweeper-practice-history",
    schemaVersion: 1,
    exportedAt: exported.exportedAt,
    recordCount: 10_001,
    records: Array.from({ length: 10_001 }, () => ({})),
    replays: [],
  };
  await importInput.setInputFiles({
    name: "practice-over-capacity.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(overCapacityDocument)),
  });
  await expect(page.getByText("导入失败，整批数据均未写入。")).toBeVisible();
  await expect(readPracticeStoreSnapshot(page)).resolves.toMatchObject({
    runCount: 21,
    replayCount: 21,
  });
});

test("8 秒自动提示在同一可见状态只展示并记录一次", async ({ page }) => {
  test.setTimeout(40_000);
  await useDeterministicPracticeEnvironment(page);
  await enterClassicGuidedPractice(page);

  await clickBoardCell(page, FIRST_INDEX);
  const coachMessage = page.locator(".practice-coach-message");
  await expect(coachMessage).toContainText("如果棋盘保持不变");
  await expect(coachMessage).toHaveText(
    "根据当前可见信息，没有能够确定的下一步。",
    { timeout: 11_000 },
  );

  // Leave the same board state active for several more coach ticks. A missing
  // state-hash guard would append the same idle hint every 250 ms here.
  await page.waitForTimeout(1_250);
  await clickBoardCell(page, fixedBoard().mines.findIndex((value) => value === 1));
  await expectPracticeSaved(page);

  const replays = await readOnlyPracticeReplays(page);
  expect(replays).toHaveLength(1);
  const idleHints = replays[0]!.events.filter(
    (event) => event.eventType === "ASSISTANCE_SHOWN" && event.trigger === "IDLE",
  );
  expect(idleHints).toHaveLength(1);
  expect(idleHints[0]!.elapsedMs).toBeGreaterThanOrEqual(7_900);
  expect(new Set(idleHints.map(({ visibleStateHash }) => visibleStateHash)).size).toBe(1);
});

test("示范下一步只执行一个有证明的教练动作", async ({ page }) => {
  await useDeterministicPracticeEnvironment(page);
  await enterClassicGuidedPractice(page);

  const expectedState = createGameState(fixedBoard());
  revealCell(expectedState, FIRST_INDEX);
  revealCell(expectedState, PROOF_REVEAL_INDEX);
  const expectedSuggestion = runCoachRequest(createCoachRequest(
    1,
    visibleBoardStateForPractice(expectedState),
  ));
  expect(expectedSuggestion.action).toBeDefined();
  expect(expectedSuggestion.cellIndex).toBeDefined();

  await clickBoardCell(page, FIRST_INDEX);
  await clickBoardCell(page, PROOF_REVEAL_INDEX);
  await expect(page.locator(".practice-coach-message")).toContainText(
    "如果棋盘保持不变",
  );
  await page.getByRole("button", { name: "示范下一步" }).click();
  await expect(remainingMines(page)).toHaveText("9");

  const terminalMine = fixedBoard().mines.findIndex((value) => value === 1);
  await clickBoardCell(page, terminalMine);
  await expectPracticeSaved(page);

  const replays = await readOnlyPracticeReplays(page);
  expect(replays).toHaveLength(1);
  const coachActions = replays[0]!.events.filter(
    (event) => event.eventType === "COACH_ACTION",
  );
  expect(coachActions).toHaveLength(1);
  expect(coachActions[0]).toMatchObject({
    eventType: "COACH_ACTION",
    trigger: "DEMONSTRATE",
    action: expectedSuggestion.action,
    cellIndex: expectedSuggestion.cellIndex,
    physicalClicks: 0,
  });
});

test("玩家快于当前 Worker 时，教练仍按操作前可见局面回填证明反馈", async ({ page }) => {
  await useDeterministicPracticeEnvironment(page, { stallCoachWorkerNumber: 2 });
  await enterClassicGuidedPractice(page);

  await clickBoardCell(page, FIRST_INDEX);
  await expect(page.locator(".practice-coach-message")).toContainText(
    "如果棋盘保持不变",
  );
  const provenMine = provenMineTargetsAfterProofReveal()[0]!;
  await clickBoardCell(page, PROOF_REVEAL_INDEX);
  await clickBoardCell(page, provenMine, "right");

  await expect(page.getByText("这一步可以由当时可见的数字确定推出。", { exact: true }))
    .toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __HMS_E2E_COACH_WORKER_STATE__?: { readonly coachStarts: number };
    }
  ).__HMS_E2E_COACH_WORKER_STATE__?.coachStarts ?? 0)).toBeGreaterThanOrEqual(3);
});

test("自动标雷标出全部可证明雷且尊重玩家取消直到出现新数字", async ({ page }) => {
  await useDeterministicPracticeEnvironment(page);
  await enterClassicGuidedPractice(page);

  const expectedMineTargets = provenMineTargetsAfterProofReveal();
  expect(expectedMineTargets).toEqual([44, 24, 6, 21]);
  const suppressedTarget = expectedMineTargets[0]!;

  await clickBoardCell(page, FIRST_INDEX);
  await clickBoardCell(page, PROOF_REVEAL_INDEX);
  await expect(page.locator(".practice-coach-message")).toContainText(
    "如果棋盘保持不变",
  );
  await page.getByRole("checkbox", { name: /自动标雷/u }).check();
  await expect(remainingMines(page)).toHaveText("6");

  await clickBoardCell(page, suppressedTarget, "right");
  await expect(remainingMines(page)).toHaveText("7");
  await page.waitForTimeout(1_500);
  await expect(remainingMines(page)).toHaveText("7");

  await clickBoardCell(page, SAFE_STATE_CHANGE_INDEX);
  await expect(remainingMines(page)).toHaveText("6");

  const terminalMine = fixedBoard().mines.findIndex((value) => value === 1);
  await clickBoardCell(page, terminalMine);
  await expectPracticeSaved(page);

  const replays = await readOnlyPracticeReplays(page);
  expect(replays).toHaveLength(1);
  const events = replays[0]!.events;
  const proofRevealPosition = events.findIndex(
    (event) => event.eventType === "PLAYER_ACTION" &&
      event.actionType === "REVEAL" && event.cellIndex === PROOF_REVEAL_INDEX,
  );
  const unflagPosition = events.findIndex(
    (event, index) => index > proofRevealPosition &&
      event.eventType === "PLAYER_ACTION" &&
      event.actionType === "TOGGLE_FLAG" && event.cellIndex === suppressedTarget,
  );
  const stateChangePosition = events.findIndex(
    (event, index) => index > unflagPosition &&
      event.eventType === "PLAYER_ACTION" &&
      event.actionType === "REVEAL" && event.cellIndex === SAFE_STATE_CHANGE_INDEX,
  );
  const terminalPosition = events.findIndex(
    (event, index) => index > stateChangePosition &&
      event.eventType === "PLAYER_ACTION" && event.cellIndex === terminalMine,
  );
  expect(proofRevealPosition).toBeGreaterThanOrEqual(0);
  expect(unflagPosition).toBeGreaterThan(proofRevealPosition);
  expect(stateChangePosition).toBeGreaterThan(unflagPosition);
  expect(terminalPosition).toBeGreaterThan(stateChangePosition);

  const initialAutoFlags = events
    .slice(proofRevealPosition + 1, unflagPosition)
    .filter((event) => event.eventType === "COACH_ACTION" && event.trigger === "AUTO_MARK");
  expect(initialAutoFlags.map(({ cellIndex }) => cellIndex)).toEqual(expectedMineTargets);
  expect(initialAutoFlags.every(
    (event) => event.action === "FLAG" && event.physicalClicks === 0,
  )).toBe(true);

  expect(events.slice(unflagPosition + 1, stateChangePosition).some(
    (event) => event.eventType === "COACH_ACTION" &&
      event.trigger === "AUTO_MARK" && event.cellIndex === suppressedTarget,
  )).toBe(false);
  expect(events.slice(stateChangePosition + 1, terminalPosition).some(
    (event) => event.eventType === "COACH_ACTION" &&
      event.trigger === "AUTO_MARK" && event.action === "FLAG" &&
      event.cellIndex === suppressedTarget,
  )).toBe(true);
  expect(events.some(
    (event) => event.eventType === "COACH_ACTION" &&
      event.trigger === "AUTO_MARK" && event.action !== "FLAG",
  )).toBe(false);
});

test("教练 Worker 传输错误可立即重试且终局仍能保存", async ({ page }) => {
  await useDeterministicPracticeEnvironment(page, { failFirstCoachWorker: true });
  await enterClassicGuidedPractice(page);

  await clickBoardCell(page, FIRST_INDEX);
  const coachMessage = page.locator(".practice-coach-message");
  await expect(coachMessage).toHaveText("教练暂时不可用。你仍可以继续本局。");
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __HMS_E2E_COACH_WORKER_STATE__?: { readonly coachStarts: number };
    }
  ).__HMS_E2E_COACH_WORKER_STATE__?.coachStarts ?? 0)).toBe(1);

  await page.getByRole("button", { name: "立即提示" }).click();
  await expect(coachMessage).toHaveText(
    "根据当前可见信息，没有能够确定的下一步。",
  );
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __HMS_E2E_COACH_WORKER_STATE__?: { readonly coachStarts: number };
    }
  ).__HMS_E2E_COACH_WORKER_STATE__?.coachStarts ?? 0)).toBe(2);

  const terminalMine = fixedBoard().mines.findIndex((value) => value === 1);
  await clickBoardCell(page, terminalMine);
  await expectPracticeSaved(page);

  const replays = await readOnlyPracticeReplays(page);
  expect(replays).toHaveLength(1);
  const requestedHints = replays[0]!.events.filter(
    (event) => event.eventType === "ASSISTANCE_SHOWN" && event.trigger === "REQUEST",
  );
  expect(requestedHints).toHaveLength(1);
  expect(requestedHints[0]?.suggestion.status).not.toBe("ERROR");
});
