import { describe, expect, it } from "vitest";
import { resolveInitialLocale, translate } from "./i18n";

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
});
