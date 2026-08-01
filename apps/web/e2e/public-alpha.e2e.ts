import { expect, test, type Page, type Route } from "@playwright/test";

const PUBLIC_TELEMETRY_SESSION = {
  sessionId: "public-session-1234567890",
  expiresAt: Date.now() + 60 * 60 * 1_000,
  batchId: "public",
  cohortSegment: "unsegmented",
};
const TRAINING_SESSION_IDLE_MS = 30 * 60 * 1_000;
const TRAINING_TEST_NOW = Date.UTC(2026, 6, 30, 8);
const TEST_BUILD_SHA = "0123456789012345678901234567890123456789";

async function installMutableSoloClock(page: Page): Promise<void> {
  await page.addInitScript(
    (now) => {
      let currentNow = now;
      Object.defineProperty(globalThis, "__hmsSetTestNow", {
        configurable: true,
        value: (next: number) => {
          currentNow = next;
        },
      });
      Date.now = () => currentNow;
    },
    TRAINING_TEST_NOW,
  );
}

async function clickBoardCell(
  page: Page,
  index: number,
  width = 9,
  height = 9,
): Promise<void> {
  const board = page.getByRole("grid", {
    name: new RegExp(`^${width} 乘 ${height} 扫雷棋盘`),
  });
  const box = await board.boundingBox();
  if (!box) throw new Error("棋盘布局不可测量");
  await board.click({
    force: true,
    position: {
      x: ((index % width) + 0.5) * (box.width / width),
      y: (Math.floor(index / width) + 0.5) * (box.height / height),
    },
  });
}

async function finishSmallCustomRun(page: Page): Promise<void> {
  await clickBoardCell(page, 12, 5, 5);
  for (let index = 0; index < 25; index += 1) {
    if (await page.locator(".solo-terminal-panel").count()) break;
    await clickBoardCell(page, index, 5, 5);
  }
  await expect(page.locator(".solo-terminal-panel")).toBeVisible();
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    ...(headers ? { headers } : {}),
  });
}

async function mockPublicTelemetrySession(page: Page): Promise<{
  readonly requests: Array<{ method: string; body: string | null }>;
}> {
  const requests: Array<{ method: string; body: string | null }> = [];
  await page.route("**/api/v1/telemetry/session", async (route) => {
    requests.push({
      method: route.request().method(),
      body: route.request().postData(),
    });
    await fulfillJson(route, 201, PUBLIC_TELEMETRY_SESSION, {
      "set-cookie":
        "hms_telemetry_session=opaque; Path=/api/v1/telemetry; HttpOnly; Secure; SameSite=Lax",
    });
  });
  return { requests };
}

test("公开构建暴露不可变客户端身份与功能开关", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator('meta[name="hms-build-app-version"]'),
  ).toHaveAttribute("content", "0.2.0-alpha.1");
  await expect(page.locator('meta[name="hms-build-sha"]')).toHaveAttribute(
    "content",
    TEST_BUILD_SHA,
  );
  await expect(page.locator('meta[name="hms-build-region"]')).toHaveAttribute(
    "content",
    "test",
  );
  await expect(
    page.locator('meta[name="hms-build-telemetry-enabled"]'),
  ).toHaveAttribute("content", "true");
  await expect(
    page.locator('meta[name="hms-build-duel-experiment"]'),
  ).toHaveAttribute("content", "false");
});

test("首次遥测说明可延后或按 Escape 关闭，且不创建遥测会话", async ({
  page,
}) => {
  let telemetryRequests = 0;
  await page.route("**/api/v1/telemetry/**", async (route) => {
    telemetryRequests += 1;
    await fulfillJson(route, 500, { error: "SHOULD_NOT_BE_CALLED" });
  });

  await page.goto("/");
  const dialogHeading = page.getByRole("heading", {
    name: "选择是否分享假名化使用数据",
  });
  await expect(dialogHeading).toBeVisible();
  const privacyDialog = page.getByRole("dialog", { name: "选择是否分享假名化使用数据" });
  await privacyDialog.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByRole("heading", { name: "Choose whether to share pseudonymous usage data" })).toBeVisible();
  await page.getByRole("dialog", { name: "Choose whether to share pseudonymous usage data" }).getByRole("button", { name: "Switch to Chinese" }).click();
  await expect(
    page.getByRole("button", { name: "稍后决定，继续游戏" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogHeading).toBeHidden();
  await expect(
    page.getByRole("button", { name: "单人游戏 · 配置开局" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "切换到英文" }).click();
  await page.locator(".home-mode-option").nth(2).click();
  await expect(page.getByRole("button", { name: "1v1 temporarily paused" })).toBeVisible();
  await expect(page.getByText("Solo remains unaffected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Chinese" }).click();

  await page.getByRole("button", { name: "数据与隐私" }).click();
  await page.getByRole("button", { name: "稍后决定，继续游戏" }).click();
  expect(telemetryRequests).toBe(0);
  expect(
    await page.evaluate(() => ({
      consent: window.localStorage.getItem("hms-telemetry-consent-v1"),
      identity: window.localStorage.getItem("hms-telemetry-identity-v1"),
      queue: window.localStorage.getItem("hms-telemetry-queue-v1"),
    })),
  ).toEqual({ consent: null, identity: null, queue: null });
});

test("公开 Alpha 无邀请码门槛，退出遥测不阻塞单人入口", async ({ page }) => {
  const telemetrySession = await mockPublicTelemetrySession(page);
  const preferenceBodies: unknown[] = [];
  await page.route("**/api/v1/telemetry/preference", async (route) => {
    preferenceBodies.push(route.request().postDataJSON());
    await fulfillJson(route, 202, { accepted: true, applied: true });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /每一局.*都成为下一局的依据/ }),
  ).toBeVisible();
  await expect(page.getByLabel("邀请码")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "进入 Alpha" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "选择是否分享假名化使用数据" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "继续并开启（默认）" }),
  ).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("hms-telemetry-identity-v1"),
    ),
  ).toBeNull();

  await page.getByRole("button", { name: "退出遥测并继续" }).click();
  await expect.poll(() => preferenceBodies).toEqual([
    {
      enabled: false,
      consentVersion: "alpha-telemetry-v1",
      appVersion: "0.2.0-alpha.1",
      preferenceChangedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    },
  ]);
  expect(telemetrySession.requests).toEqual([
    { method: "POST", body: null },
  ]);
  await expect(
    page.getByRole("button", { name: "单人游戏 · 配置开局" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("hms-telemetry-queue-v1"),
    ),
  ).toBeNull();
});

test("浏览器存储被阻止时公开单人入口仍可使用", async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException("Storage is blocked", "SecurityError");
    };
    Object.defineProperty(Storage.prototype, "getItem", {
      configurable: true,
      value: blocked,
    });
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value: blocked,
    });
    Object.defineProperty(Storage.prototype, "removeItem", {
      configurable: true,
      value: blocked,
    });
  });

  await page.goto("/");
  const soloEntry = page.getByRole("button", {
    name: "单人游戏 · 配置开局",
  });
  await expect(soloEntry).toBeVisible();
  await soloEntry.click();
  await page.getByRole("button", { name: "确认配置 · 进入棋盘" }).click();
  await expect(
    page.getByRole("heading", { name: "经典扫雷", exact: true }),
  ).toBeVisible();
});

test("公开遥测会话容量不足时，游戏保持可用且明确标记证据缺失", async ({
  page,
}) => {
  let preferenceRequests = 0;
  await page.route("**/api/v1/telemetry/session", (route) =>
    fulfillJson(route, 503, {
      error: "TELEMETRY_SESSION_CAPACITY_REACHED",
    }),
  );
  await page.route("**/api/v1/telemetry/preference", async (route) => {
    preferenceRequests += 1;
    await fulfillJson(route, 202, { accepted: true, applied: true });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "退出遥测并继续" }).click();
  await expect(
    page.getByText(/服务端未能记录本次开关状态/),
  ).toBeVisible();
  expect(preferenceRequests).toBe(0);
  await expect(
    page.getByRole("button", { name: "单人游戏 · 配置开局" }),
  ).toBeVisible();
});

test("默认开启只上传白名单事件，并可单独删除服务端原始遥测", async ({
  page,
}) => {
  const telemetrySession = await mockPublicTelemetrySession(page);
  const preferenceBodies: unknown[] = [];
  let telemetryBatch: {
    deletionToken?: string;
    events?: Array<Record<string, unknown>>;
  } | null = null;
  let deletionBody: unknown;
  await page.route("**/api/v1/telemetry/preference", async (route) => {
    preferenceBodies.push(route.request().postDataJSON());
    await fulfillJson(route, 202, { accepted: true, applied: true });
  });
  await page.route("**/api/v1/telemetry/batch", async (route) => {
    telemetryBatch = route.request().postDataJSON();
    await fulfillJson(route, 202, { accepted: 1, duplicates: 0 });
  });
  await page.route("**/api/v1/telemetry/delete", async (route) => {
    deletionBody = route.request().postDataJSON();
    await fulfillJson(route, 200, {
      accepted: true,
      deletionEpoch: 1,
      deletedBefore: new Date().toISOString(),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "继续并开启（默认）" }).click();
  await expect.poll(() => telemetryBatch).not.toBeNull();
  expect(telemetrySession.requests).toHaveLength(1);
  expect(preferenceBodies.length).toBeGreaterThanOrEqual(1);
  expect(preferenceBodies).toEqual(
    expect.arrayContaining([
      {
        enabled: true,
        consentVersion: "alpha-telemetry-v1",
        appVersion: "0.2.0-alpha.1",
        preferenceChangedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ]),
  );
  expect(telemetryBatch?.events).toHaveLength(1);
  expect(telemetryBatch?.events?.[0]).toMatchObject({
    schemaVersion: 1,
    eventName: "app_ready",
    consentVersion: "alpha-telemetry-v1",
    appVersion: "0.2.0-alpha.1",
  });
  const serialized = JSON.stringify(telemetryBatch);
  expect(serialized).not.toMatch(
    /nickname|inviteCode|roomCode|mineMap|boardSeed|latitude|longitude/i,
  );

  await page.getByRole("button", { name: "数据与隐私" }).click();
  await page.getByRole("button", { name: "删除服务端原始遥测" }).click();
  await expect(page.getByText(/服务端已接受删除请求/)).toBeVisible();
  expect(deletionBody).toMatchObject({
    pseudonymousInstallId: expect.stringMatching(/^[a-f0-9]{32}$/),
    deletionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await expect(
    page.getByRole("button", { name: "删除全部历史" }),
  ).toHaveCount(0);
});

test("组件不卸载时空闲 30 分钟会轮换训练会话，并保持单局 ID 一致", async ({
  page,
}) => {
  await installMutableSoloClock(page);
  await mockPublicTelemetrySession(page);
  await page.route("**/api/v1/telemetry/preference", (route) =>
    fulfillJson(route, 202, { accepted: true, applied: true }),
  );
  const trackedEvents: Array<{
    eventName: string;
    properties: Record<string, unknown>;
  }> = [];
  await page.route("**/api/v1/telemetry/batch", async (route) => {
    const body = route.request().postDataJSON() as {
      events?: Array<{
        eventName?: string;
        properties?: Record<string, unknown>;
      }>;
    };
    for (const event of body.events ?? []) {
      if (event.eventName && event.properties) {
        trackedEvents.push({
          eventName: event.eventName,
          properties: event.properties,
        });
      }
    }
    await fulfillJson(route, 202, {
      accepted: body.events?.length ?? 0,
      duplicates: 0,
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "继续并开启（默认）" }).click();
  await expect
    .poll(
      () =>
        trackedEvents.filter((event) => event.eventName === "app_ready")
          .length,
    )
    .toBe(1);
  await page.getByRole("button", { name: "单人游戏 · 配置开局" }).click();
  await page
    .locator(".solo-tabs")
    .getByRole("button", { name: /^自定义 5–100/ })
    .click();
  await page.getByLabel("自定义宽度").fill("5");
  await page.getByLabel("自定义高度").fill("5");
  await page.getByLabel("自定义雷数").fill("10");
  await page.getByRole("button", { name: "确认配置 · 进入棋盘" }).click();
  await finishSmallCustomRun(page);
  await expect
    .poll(
      () =>
        trackedEvents.filter(
          (event) => event.eventName === "solo_run_terminal",
        ).length,
    )
    .toBe(1);

  const secondRunNow = TRAINING_TEST_NOW + TRAINING_SESSION_IDLE_MS;
  await page.evaluate((nextNow) => {
    (
      globalThis as typeof globalThis & {
        __hmsSetTestNow: (value: number) => void;
      }
    ).__hmsSetTestNow(nextNow);
  }, secondRunNow);
  await page.getByRole("button", { name: "新棋盘" }).click();
  await finishSmallCustomRun(page);
  await expect
    .poll(
      () =>
        trackedEvents.filter(
          (event) => event.eventName === "solo_run_terminal",
        ).length,
    )
    .toBe(2);

  const starts = trackedEvents.filter(
    (event) => event.eventName === "solo_run_started",
  );
  const terminals = trackedEvents.filter(
    (event) => event.eventName === "solo_run_terminal",
  );
  expect(starts).toHaveLength(2);
  expect(terminals).toHaveLength(2);
  const firstTrainingSessionId = starts[0]?.properties.trainingSessionId;
  const secondTrainingSessionId = starts[1]?.properties.trainingSessionId;
  expect(firstTrainingSessionId).toEqual(
    terminals[0]?.properties.trainingSessionId,
  );
  expect(secondTrainingSessionId).toEqual(
    terminals[1]?.properties.trainingSessionId,
  );
  expect(secondTrainingSessionId).not.toEqual(firstTrainingSessionId);

  const historyTrainingSessionIds = await page.evaluate(async () => {
    return await new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open("h-minesweeper-solo-history-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("solo-runs-v1", "readonly");
        const read = transaction.objectStore("solo-runs-v1").getAll();
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          resolve(
            read.result.map(
              (record: { trainingSessionId: string }) =>
                record.trainingSessionId,
            ),
          );
        };
        transaction.oncomplete = () => database.close();
      };
    });
  });
  expect(new Set(historyTrainingSessionIds)).toEqual(
    new Set([firstTrainingSessionId, secondTrainingSessionId]),
  );
});
