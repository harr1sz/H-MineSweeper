import type { SupportedLocale } from "../i18n";
import type { SoloTimerFormatPreference } from "./solo-preferences";

export function formatSoloElapsedTime(
  elapsedMs: number,
  format: SoloTimerFormatPreference,
  locale: SupportedLocale,
): string {
  const centiseconds = Math.floor(Math.max(0, elapsedMs) / 10);
  if (format === "seconds") {
    const value = (centiseconds / 100).toFixed(2);
    return locale === "zh-CN" ? `${value} 秒` : `${value} s`;
  }
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}
