import { describe, expect, it } from "vitest";
import {
  MESSAGE_IDS,
  formatEnglishCount,
  resolveInitialLocale,
  translate,
} from "./i18n";

describe("locale contract", () => {
  it("prefers a saved supported locale over browser languages", () => {
    expect(resolveInitialLocale("en-US", ["zh-CN"])).toBe("en-US");
    expect(resolveInitialLocale("zh-Hans", ["en-US"])).toBe("zh-CN");
  });

  it("uses the first supported browser language and otherwise falls back to zh-CN", () => {
    expect(resolveInitialLocale(null, ["fr-FR", "en-GB", "zh-CN"])).toBe("en-US");
    expect(resolveInitialLocale(null, ["fr-FR", "de-DE"])).toBe("zh-CN");
  });

  it("formats parameterized messages from both type-aligned catalogs", () => {
    expect(translate("zh-CN", "replay.coordinate", { row: 3, column: 5 })).toBe("第 3 行第 5 列");
    expect(translate("en-US", "replay.coordinate", { row: 3, column: 5 })).toBe("row 3, column 5");
  });

  it("uses natural singular and plural forms for English counts", () => {
    expect(formatEnglishCount(0, "record")).toBe("0 records");
    expect(formatEnglishCount(1, "record")).toBe("1 record");
    expect(formatEnglishCount(2, "record")).toBe("2 records");
    expect(translate("en-US", "solo.resultActions", { count: 1 })).toBe("1 action");
    expect(translate("en-US", "solo.resultActions", { count: 2 })).toBe("2 actions");
    expect(translate("en-US", "academy.reasonSelected", { count: 1 })).toContain("1 clue selected");
    expect(translate("en-US", "replay.verifiedHuman", { count: 0 })).toContain("0 steps");
    expect(translate("en-US", "replay.verifiedHuman", { count: 1 })).toContain("1 step");
    expect(translate("en-US", "replay.verifiedHuman", { count: 2 })).toContain("2 steps");
    expect(translate("en-US", "solo.generationSummary", { attempts: 0, elapsed: 1 })).toContain("0 attempts");
    expect(translate("en-US", "solo.generationSummary", { attempts: 1, elapsed: 1 })).toContain("1 attempt");
    expect(translate("en-US", "solo.generationSummary", { attempts: 2, elapsed: 1 })).toContain("2 attempts");
    expect(translate("en-US", "practice.history.exported", { count: 1 })).toContain("1 practice record");
    expect(translate("en-US", "practice.history.exported", { count: 2 })).toContain("2 practice records");
    expect(translate("en-US", "practice.coach.globalValue", { mines: 1, covered: 2 }))
      .toBe("1 mine remains among 2 covered cells.");
  });

  it("keeps representative product copy plain and consistent", () => {
    expect(translate("en-US", "home.solo.title")).toBe("Use every game to improve the next.");
    expect(translate("en-US", "solo.setup.title")).toBe("Set up a solo game");
    expect(translate("en-US", "solo.generation")).toBe("Board generation");
    expect(translate("en-US", "status.noNetwork")).toBe("NO NETWORK REQUIRED");
    expect(translate("en-US", "academy.freePractice")).toBe("Skill drills");
    expect(translate("en-US", "academy.coach")).toBe("Coach mode");
    expect(translate("en-US", "academy.coach")).not.toBe(
      translate("en-US", "practice.setup.guided"),
    );
    expect(translate("en-US", "academy.h7")).not.toMatch(/\bH7\b/u);
  });

  it("keeps guided-practice copy bilingual and honest about visible information", () => {
    expect(translate("zh-CN", "practice.setup.guided")).toBe("引导练习");
    expect(translate("en-US", "practice.setup.guided")).toBe("Guided practice");
    expect(translate("en-US", "practice.setup.classicWarning")).toContain(
      "will not use hidden mine locations",
    );
    expect(translate("en-US", "practice.coach.autoMarkHelp")).toContain(
      "directly determined by one visible clue",
    );
    expect(translate("en-US", "practice.coach.autoMarkHelp")).toContain(
      "Comparisons between clues remain hints",
    );
    expect(translate("en-US", "practice.feedback.safeUnproven")).toContain(
      "did not determine this move",
    );
    expect(translate("en-US", "practice.coach.idleCountdown", { seconds: 1 })).toContain(
      "1 second",
    );
    expect(translate("en-US", "practice.coach.idleCountdown", { seconds: 2 })).toContain(
      "2 seconds",
    );
  });

  it("uses plain Chinese on the home page", () => {
    expect(translate("zh-CN", "home.solo.enter")).toBe("开始单人游戏");
    expect(translate("zh-CN", "home.solo.description")).toBe(
      "成绩和复盘都保存在这台设备上。你可以比较相同难度下的速度、效率和失误，再开始下一局。",
    );
    expect(translate("zh-CN", "home.solo.detail1")).toBe(
      "初级 / 中级 / 高级 / 自定义",
    );
    expect(translate("zh-CN", "home.solo.detail2")).toBe("经典随机 / 无猜");
    expect(translate("zh-CN", "home.solo.detail3")).toBe("标准对局 / 引导练习");
  });

  it("does not use em dashes, en dashes, or Chinese sentence punctuation in English messages", () => {
    const values = {
      count: 2,
      total: 2,
      completed: 1,
      current: 1,
      row: 1,
      column: 2,
      sources: "row 1, column 1",
      records: 1,
      replays: 1,
    };
    for (const id of MESSAGE_IDS) {
      expect(translate("en-US", id, values), id).not.toMatch(/[\u2013\u2014，。；：！？]/u);
    }
  });
});
