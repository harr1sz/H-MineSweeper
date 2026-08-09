import { expect, test } from "@playwright/test";

test("IndexedDB v3 data survives the v4 practice-store upgrade", async ({ page }) => {
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/");

  const legacySnapshot = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1", 3);
      request.onupgradeneeded = () => {
        const runs = request.result.createObjectStore("solo-runs-v1", {
          keyPath: "recordId",
        });
        runs.createIndex("completedAt", "completedAt");
        request.result.createObjectStore("solo-replays-v1", {
          keyPath: "recordId",
        });
        const legacy = request.result.createObjectStore("legacy-personal-bests-v1", {
          keyPath: "id",
        });
        legacy.createIndex("sourceKey", "source.key", { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = {
      run: { recordId: "legacy-run", completedAt: "2026-08-01T00:00:00.000Z", marker: "run-v3" },
      replay: { recordId: "legacy-run", marker: "replay-v3" },
      personalBest: { id: "legacy-pb", source: { key: "beginner" }, marker: "pb-v3" },
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        ["solo-runs-v1", "solo-replays-v1", "legacy-personal-bests-v1"],
        "readwrite",
      );
      transaction.objectStore("solo-runs-v1").put(values.run);
      transaction.objectStore("solo-replays-v1").put(values.replay);
      transaction.objectStore("legacy-personal-bests-v1").put(values.personalBest);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    return values;
  });

  await page.unroute("**/src/main.tsx");
  await page.reload();
  await expect(page.getByRole("heading", { name: "选择玩法" })).toBeVisible();
  await expect(page.getByRole("button", { name: "引导练习" })).toHaveCount(0);
  await page.getByRole("button", { name: "开始单人游戏" }).click();
  await page.getByRole("button", { name: "引导练习" }).click();
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByRole("heading", { name: "练习记录" })).toBeVisible();

  const upgraded = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (storeName: string, key: string) => new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      version: database.version,
      stores: Array.from(database.objectStoreNames),
      run: await read("solo-runs-v1", "legacy-run"),
      replay: await read("solo-replays-v1", "legacy-run"),
      personalBest: await read("legacy-personal-bests-v1", "legacy-pb"),
      practiceRunCount: await new Promise<number>((resolve, reject) => {
        const request = database.transaction("practice-runs-v1", "readonly")
          .objectStore("practice-runs-v1").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      practiceReplayCount: await new Promise<number>((resolve, reject) => {
        const request = database.transaction("practice-replays-v1", "readonly")
          .objectStore("practice-replays-v1").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
    };
    database.close();
    return result;
  });

  expect(upgraded.version).toBe(4);
  expect(upgraded.stores).toEqual(expect.arrayContaining([
    "solo-runs-v1",
    "solo-replays-v1",
    "legacy-personal-bests-v1",
    "practice-runs-v1",
    "practice-replays-v1",
  ]));
  expect(upgraded.run).toEqual(legacySnapshot.run);
  expect(upgraded.replay).toEqual(legacySnapshot.replay);
  expect(upgraded.personalBest).toEqual(legacySnapshot.personalBest);
  expect(upgraded.practiceRunCount).toBe(0);
  expect(upgraded.practiceReplayCount).toBe(0);
});
