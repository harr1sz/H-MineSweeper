import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SOLO_HISTORY_MAX_RECORDS,
  SOLO_HISTORY_WARNING_RECORDS,
  calculateSoloTrend,
  createIndexedDbSoloHistoryStore,
  createSoloHistoryExport,
  createSoloHistoryRecoveryExport,
  createSoloLegacyPersonalBestRecoveryExport,
  parseSoloHistoryImport,
  sameSoloConfigurationAndRules,
  type SoloHistoryStore,
  type SoloLegacyPersonalBestMigrationResult,
  type SoloRunRecordV1,
} from "../lib/solo-history";
import type { SoloBoardConfig, SoloPreset } from "../lib/solo";
import { useTelemetry } from "./TelemetryPrivacy";
import "./solo-history.css";

const HISTORY_EXPANDED_KEY = "hms-solo-history-expanded-v1";
const HISTORY_SCOPE_KEY = "hms-solo-history-scope-v1";
const indexedDbStore = createIndexedDbSoloHistoryStore();

type HistoryScope = "current" | "all";

interface SoloHistoryProps {
  readonly config: SoloBoardConfig;
  readonly preset: SoloPreset;
  readonly metricRulesVersion: number;
  readonly gameRulesVersion: number;
  readonly refreshToken: number;
  readonly store?: SoloHistoryStore;
  readonly onStorageError?: (message: string) => void;
  readonly onCurrentBestChange?: (elapsedMs: number | null) => void;
  readonly onLegacyPersonalBestChange?: (elapsedMs: number | null) => void;
}

function readHistoryUiPreferences(): {
  readonly expanded: boolean;
  readonly scope: HistoryScope;
  readonly error: string;
} {
  try {
    return {
      expanded:
        window.localStorage.getItem(HISTORY_EXPANDED_KEY) === "true",
      scope:
        window.localStorage.getItem(HISTORY_SCOPE_KEY) === "all"
          ? "all"
          : "current",
      error: "",
    };
  } catch {
    return {
      expanded: false,
      scope: "current",
      error:
        "无法读取历史面板偏好，已使用安全默认值；成绩历史本身没有被修改。",
    };
  }
}

function formatTime(elapsedMs: number | null): string {
  if (elapsedMs === null) return "—";
  const centiseconds = Math.floor(Math.max(0, elapsedMs) / 10);
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function formatMetric(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SoloHistory({
  config,
  preset,
  metricRulesVersion,
  gameRulesVersion,
  refreshToken,
  store = indexedDbStore,
  onStorageError,
  onCurrentBestChange,
  onLegacyPersonalBestChange,
}: SoloHistoryProps) {
  const { track } = useTelemetry();
  const initialUiPreferences = useMemo(readHistoryUiPreferences, []);
  const [records, setRecords] = useState<readonly SoloRunRecordV1[]>([]);
  const [rawRecords, setRawRecords] = useState<readonly unknown[]>([]);
  const [invalidRecordCount, setInvalidRecordCount] = useState(0);
  const [recordCount, setRecordCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(initialUiPreferences.expanded);
  const [scope, setScope] = useState<HistoryScope>(initialUiPreferences.scope);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preferenceError, setPreferenceError] = useState(
    initialUiPreferences.error,
  );
  const [legacyMigration, setLegacyMigration] =
    useState<SoloLegacyPersonalBestMigrationResult | null>(null);
  const [legacyMigrationError, setLegacyMigrationError] = useState("");

  const reportError = useCallback(
    (nextError: string) => {
      setError(nextError);
      setMessage("");
      onStorageError?.(nextError);
    },
    [onStorageError],
  );

  const load = useCallback(async () => {
    try {
      const snapshot = await store.read();
      setRecords(snapshot.records);
      setRawRecords(snapshot.rawRecords);
      setInvalidRecordCount(snapshot.invalidRecordCount);
      setRecordCount(snapshot.recordCount);
      setLoaded(true);
      setError("");
      if (!preferenceError) onStorageError?.("");
    } catch (cause) {
      setLoaded(false);
      reportError(
        errorMessage(cause, "读取本地历史失败，现有记录没有被修改。"),
      );
    }
  }, [onStorageError, preferenceError, reportError, store]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    let active = true;
    void store.migrateLegacyPersonalBests().then(
      (result) => {
        if (!active) return;
        setLegacyMigration(result);
        setLegacyMigrationError("");
      },
      (cause: unknown) => {
        if (!active) return;
        setLegacyMigrationError(
          errorMessage(
            cause,
            "旧版个人最佳元数据迁移失败；源数据没有被修改。",
          ),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [store]);

  useEffect(() => {
    if (preferenceError) onStorageError?.(preferenceError);
  }, [onStorageError, preferenceError]);

  const comparableRecords = useMemo(
    () =>
      records.filter((record) =>
        sameSoloConfigurationAndRules(
          record,
          config,
          preset,
          metricRulesVersion,
          gameRulesVersion,
        ),
      ),
    [config, gameRulesVersion, metricRulesVersion, preset, records],
  );
  const visibleRecords =
    scope === "current" ? comparableRecords : records;
  const trend = useMemo(
    () =>
      calculateSoloTrend(
        records,
        config,
        preset,
        metricRulesVersion,
        gameRulesVersion,
      ),
    [config, gameRulesVersion, metricRulesVersion, preset, records],
  );
  const legacyPersonalBestMs = useMemo(
    () =>
      legacyMigration?.metadata.find(
        (metadata) =>
          metadata.config.width === config.width &&
          metadata.config.height === config.height &&
          metadata.config.mines === config.mines &&
          metadata.config.generationMode === config.mode,
      )?.best.elapsedMs ?? null,
    [config, legacyMigration],
  );

  useEffect(() => {
    onCurrentBestChange?.(trend.bestElapsedMs);
  }, [onCurrentBestChange, trend.bestElapsedMs]);

  useEffect(() => {
    onLegacyPersonalBestChange?.(legacyPersonalBestMs);
  }, [legacyPersonalBestMs, onLegacyPersonalBestChange]);

  const chooseExpanded = (next: boolean) => {
    setExpanded(next);
    if (next) {
      track("solo_history_opened", {
        scope: scope === "current" ? "current_configuration" : "all",
        recordCount: loaded ? recordCount : 0,
      });
    }
    try {
      window.localStorage.setItem(HISTORY_EXPANDED_KEY, String(next));
      setPreferenceError("");
      if (!error) onStorageError?.("");
    } catch {
      reportError("历史面板偏好未能保存；成绩历史本身没有被修改。");
    }
  };

  const chooseScope = (next: HistoryScope) => {
    setScope(next);
    track("solo_history_filtered", {
      scope: next === "current" ? "current_configuration" : "all",
      preset,
      generationMode: config.mode,
    });
    try {
      window.localStorage.setItem(HISTORY_SCOPE_KEY, next);
      setPreferenceError("");
      if (!error) onStorageError?.("");
    } catch {
      reportError("历史筛选偏好未能保存；成绩历史本身没有被修改。");
    }
  };

  const downloadJson = (document: unknown, filename: string) => {
    const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const exportHistory = async () => {
    setBusy(true);
    try {
      const snapshot = await store.read();
      if (snapshot.invalidRecordCount > 0) {
        throw new Error(
          `检测到 ${snapshot.invalidRecordCount} 条损坏或未知记录；请先导出恢复数据，标准导出未执行。`,
        );
      }
      const document = createSoloHistoryExport(snapshot.records);
      downloadJson(
        document,
        `h-minesweeper-solo-history-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
      );
      setMessage(`已导出 ${snapshot.records.length} 条可验证本地历史。`);
      setError("");
      onStorageError?.("");
      track("solo_exported", {
        format: "json",
        recordCount: snapshot.records.length,
      });
    } catch (cause) {
      reportError(errorMessage(cause, "导出本地历史失败。"));
    } finally {
      setBusy(false);
    }
  };

  const exportRecoveryHistory = () => {
    try {
      downloadJson(
        createSoloHistoryRecoveryExport(rawRecords),
        `h-minesweeper-solo-history-recovery-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
      );
      setMessage(`已原样导出 ${rawRecords.length} 条恢复数据；没有修改本地记录。`);
      setError("");
      track("solo_exported", {
        format: "json",
        recordCount: rawRecords.length,
      });
    } catch (cause) {
      reportError(errorMessage(cause, "导出恢复数据失败。"));
    }
  };

  const exportLegacyPersonalBestRecovery = () => {
    if (!legacyMigration) return;
    try {
      downloadJson(
        createSoloLegacyPersonalBestRecoveryExport(legacyMigration),
        `h-minesweeper-solo-legacy-pb-recovery-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
      );
      setMessage(
        "已导出旧版 PB 恢复数据；原 localStorage 与元数据均未修改。",
      );
      setError("");
    } catch (cause) {
      reportError(errorMessage(cause, "导出旧版 PB 恢复数据失败。"));
    }
  };

  const importHistory = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const recordsToImport = parseSoloHistoryImport(await file.text());
      const result = await store.importRecords(recordsToImport);
      await load();
      setMessage(
        `导入完成：新增 ${result.imported} 条，幂等跳过 ${result.skippedIdentical} 条。`,
      );
      setError("");
      onStorageError?.("");
    } catch (cause) {
      reportError(
        errorMessage(cause, "导入失败；整批数据均未写入，本地旧数据未修改。"),
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteHistory = async () => {
    if (
      !window.confirm(
        "删除全部本地单人历史？此操作不可撤销，但不会删除旧版个人最佳。",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await store.clear();
      setRecords([]);
      setRawRecords([]);
      setInvalidRecordCount(0);
      setRecordCount(0);
      setMessage("本地单人历史已删除。旧版个人最佳仍单独保留。");
      setError("");
      onStorageError?.("");
    } catch (cause) {
      reportError(
        errorMessage(cause, "删除本地历史失败，原记录仍可能保留。"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="solo-history" aria-labelledby="solo-history-title">
      <div className="solo-history-heading">
        <div>
          <span className="panel-kicker">LOCAL PERFORMANCE HISTORY</span>
          <h2 id="solo-history-title">训练历史与趋势</h2>
          <p>
            当前配置仅比较相同预设、尺寸、雷数、生成模式、指标规则和游戏规则版本。
            旧版个人最佳不会被伪造成历史记录。
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          aria-expanded={expanded}
          onClick={() => chooseExpanded(!expanded)}
        >
          {expanded ? "收起历史" : `展开历史 · ${recordCount}`}
        </button>
      </div>

      {error && (
        <div className="solo-history-message is-error" role="alert">
          {error}
        </div>
      )}
      {preferenceError && (
        <div className="solo-history-message is-error" role="alert">
          {preferenceError}
        </div>
      )}
      {!error && message && (
        <div className="solo-history-message" role="status">
          {message}
        </div>
      )}
      {invalidRecordCount > 0 && (
        <div className="solo-history-message is-error" role="alert">
          检测到 {invalidRecordCount} 条损坏或未知版本记录。它们没有被删除，
          标准导出与趋势会排除这些记录；请使用“导出恢复数据”保留原始内容。
        </div>
      )}
      {legacyMigrationError && (
        <div className="solo-history-message is-error" role="alert">
          {legacyMigrationError}
        </div>
      )}
      {legacyMigration && legacyMigration.metadata.length > 0 && (
        <div className="solo-history-message" role="status">
          已保留 {legacyMigration.metadata.length} 条旧版 PB 为只读 legacy
          metadata；原 localStorage 未删除，且这些值不参与趋势。
        </div>
      )}
      {legacyMigration &&
        (legacyMigration.invalidSources.length > 0 ||
          legacyMigration.invalidMetadataCount > 0) && (
          <div className="solo-history-message is-error" role="alert">
            检测到 {legacyMigration.invalidSources.length} 条损坏的旧版 PB 源值和{" "}
            {legacyMigration.invalidMetadataCount} 条损坏的 legacy metadata。
            原值均未删除，也不会进入趋势；请导出恢复数据。
          </div>
        )}
      {recordCount >= SOLO_HISTORY_WARNING_RECORDS && (
        <div
          className={`solo-history-message${recordCount >= SOLO_HISTORY_MAX_RECORDS ? " is-error" : ""}`}
          role="status"
        >
          本地历史容量 {recordCount.toLocaleString()}/
          {SOLO_HISTORY_MAX_RECORDS.toLocaleString()}。
          {recordCount >= SOLO_HISTORY_MAX_RECORDS
            ? " 已满：新记录和超限导入会被拒绝，旧数据不会自动删除。"
            : " 已进入容量警告区，请导出并按需删除历史。"}
        </div>
      )}

      {expanded && (
        <>
          <div className="solo-history-trend" aria-label="当前配置趋势">
            <div>
              <span>可比较记录</span>
              <strong>{trend.runCount}</strong>
              <small>{trend.winCount} 次完成</small>
            </div>
            <div>
              <span>最近 / 最佳</span>
              <strong>{formatTime(trend.latestElapsedMs)}</strong>
              <small>BEST {formatTime(trend.bestElapsedMs)}</small>
            </div>
            <div>
              <span>平均完成时间</span>
              <strong>{formatTime(trend.averageElapsedMs)}</strong>
              <small>只计算完成棋盘</small>
            </div>
            <div>
              <span>最近 / 最佳 3BV/s</span>
              <strong>{formatMetric(trend.latestThreeBvPerSecond)}</strong>
              <small>BEST {formatMetric(trend.bestThreeBvPerSecond)}</small>
            </div>
            <div>
              <span>最近 / 最佳 IOE</span>
              <strong>
                {trend.latestIoe === null
                  ? "—"
                  : `${(trend.latestIoe * 100).toFixed(1)}%`}
              </strong>
              <small>
                BEST{" "}
                {trend.bestIoe === null
                  ? "—"
                  : `${(trend.bestIoe * 100).toFixed(1)}%`}
              </small>
            </div>
          </div>

          <div className="solo-history-toolbar">
            <div className="solo-history-scope" role="group" aria-label="历史筛选">
              <button
                className={scope === "current" ? "is-active" : ""}
                type="button"
                aria-pressed={scope === "current"}
                onClick={() => chooseScope("current")}
              >
                当前配置 · {comparableRecords.length}
              </button>
              <button
                className={scope === "all" ? "is-active" : ""}
                type="button"
                aria-pressed={scope === "all"}
                onClick={() => chooseScope("all")}
              >
                全部 · {records.length}
              </button>
            </div>
            <div className="solo-history-actions">
              <label className="secondary-button solo-history-import">
                导入 JSON
                <input
                  accept="application/json,.json"
                  disabled={busy}
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void importHistory(file);
                  }}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={busy || records.length === 0}
                onClick={() => void exportHistory()}
              >
                导出 JSON
              </button>
              {invalidRecordCount > 0 && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={exportRecoveryHistory}
                >
                  导出恢复数据
                </button>
              )}
              {legacyMigration &&
                (legacyMigration.invalidSources.length > 0 ||
                  legacyMigration.invalidMetadataCount > 0) && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={exportLegacyPersonalBestRecovery}
                  >
                    导出旧 PB 恢复数据
                  </button>
                )}
              <button
                className="secondary-button solo-history-delete"
                type="button"
                disabled={busy || recordCount === 0}
                onClick={() => void deleteHistory()}
              >
                删除全部历史
              </button>
            </div>
          </div>

          {visibleRecords.length === 0 ? (
            <div className="solo-history-empty">
              {scope === "current"
                ? "当前配置还没有新历史。完成或触雷后会写入第一条记录。"
                : "尚无新历史。旧版个人最佳只保留原值，不会补写为历史。"}
            </div>
          ) : (
            <div className="solo-history-list">
              {visibleRecords.slice(0, 20).map((record) => (
                <article key={record.recordId}>
                  <div>
                    <strong>
                      {record.outcome === "WON" ? "完成" : "触雷"} ·{" "}
                      {record.config.width}×{record.config.height} /{" "}
                      {record.config.mines}
                    </strong>
                    <small>
                      {new Date(record.completedAt).toLocaleString("zh-CN")} ·{" "}
                      {record.config.generationMode === "no_guess" ? "无猜" : "经典"}
                    </small>
                  </div>
                  <b>{formatTime(record.metrics.elapsedMs)}</b>
                  <span>3BV/s {formatMetric(record.metrics.threeBvPerSecond)}</span>
                  <span>
                    IOE{" "}
                    {record.metrics.ioe === null
                      ? "—"
                      : `${(record.metrics.ioe * 100).toFixed(1)}%`}
                  </span>
                  <span>动作 {record.metrics.semanticActions}</span>
                </article>
              ))}
              {visibleRecords.length > 20 && (
                <p>仅显示最近 20 条；导出文件包含全部记录。</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
