import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SOLO_HISTORY_MAX_RECORDS,
  SOLO_HISTORY_WARNING_RECORDS,
  calculateSoloTrend,
  createIndexedDbSoloHistoryStore,
  SOLO_HISTORY_IMPORT_MAX_BYTES,
  createSoloHistoryRecoveryExport,
  createSoloLegacyPersonalBestRecoveryExport,
  sameSoloConfigurationAndRules,
  type SoloHistoryStore,
  type SoloHistoryExportV2,
  type SoloLegacyPersonalBestMigrationResult,
  type SoloRunRecord,
} from "../lib/solo-history";
import type { SoloBoardConfig, SoloPreset } from "../lib/solo";
import { metricValuesForHistoryRecord } from "../lib/solo-metrics";
import { useTelemetry } from "./TelemetryPrivacy";
import { useLocale, type MessageDescriptor } from "../i18n";
import type { HistoryImportWorkerResponse } from "../workers/historyImportWorker";
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
  readonly preferenceReadFailed: boolean;
} {
  try {
    return {
      expanded:
        window.localStorage.getItem(HISTORY_EXPANDED_KEY) === "true",
      scope:
        window.localStorage.getItem(HISTORY_SCOPE_KEY) === "all"
          ? "all"
          : "current",
      preferenceReadFailed: false,
    };
  } catch {
    return {
      expanded: false,
      scope: "current",
      preferenceReadFailed: true,
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
  const { t, formatDateTime } = useLocale();
  const initialUiPreferences = useMemo(readHistoryUiPreferences, []);
  const [records, setRecords] = useState<readonly SoloRunRecord[]>([]);
  const [rawRecords, setRawRecords] = useState<readonly unknown[]>([]);
  const [invalidRecordCount, setInvalidRecordCount] = useState(0);
  const [replayIssueCount, setReplayIssueCount] = useState(0);
  const [availableReplayIds, setAvailableReplayIds] = useState<ReadonlySet<string>>(new Set());
  const [recordCount, setRecordCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(initialUiPreferences.expanded);
  const [scope, setScope] = useState<HistoryScope>(initialUiPreferences.scope);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageDescriptor | null>(null);
  const [error, setError] = useState<MessageDescriptor | null>(null);
  const [preferenceError, setPreferenceError] = useState<MessageDescriptor | null>(
    initialUiPreferences.preferenceReadFailed ? { id: "history.readPreferenceFailed" } : null,
  );
  const [legacyMigration, setLegacyMigration] =
    useState<SoloLegacyPersonalBestMigrationResult | null>(null);
  const [legacyMigrationError, setLegacyMigrationError] = useState<MessageDescriptor | null>(null);

  const reportError = useCallback(
    (nextError: MessageDescriptor) => {
      setError(nextError);
      setMessage(null);
      onStorageError?.(t(nextError.id, nextError.values));
    },
    [onStorageError, t],
  );

  const load = useCallback(async () => {
    try {
      const snapshot = await store.read();
      setRecords(snapshot.records);
      setRawRecords(snapshot.rawRecords);
      setInvalidRecordCount(snapshot.invalidRecordCount);
      setReplayIssueCount(snapshot.replayIssueCount);
      setAvailableReplayIds(new Set(snapshot.availableReplayRecordIds));
      setRecordCount(snapshot.recordCount);
      setLoaded(true);
      setError(null);
      if (!preferenceError) onStorageError?.("");
    } catch (cause) {
      setLoaded(false);
      reportError(
        { id: "history.readFailed" },
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
        setLegacyMigrationError(null);
      },
      (cause: unknown) => {
        if (!active) return;
        setLegacyMigrationError({ id: "history.legacyMigrationFailed" });
      },
    );
    return () => {
      active = false;
    };
  }, [store]);

  useEffect(() => {
    if (preferenceError) onStorageError?.(t(preferenceError.id, preferenceError.values));
  }, [onStorageError, preferenceError, t]);

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
      setPreferenceError(null);
      if (!error) onStorageError?.("");
    } catch {
      reportError({ id: "history.savePanelPreferenceFailed" });
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
      setPreferenceError(null);
      if (!error) onStorageError?.("");
    } catch {
      reportError({ id: "history.saveFilterPreferenceFailed" });
    }
  };

  const downloadJsonParts = (parts: BlobPart[], filename: string) => {
    const blob = new Blob(parts, {
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

  const downloadJson = (document: unknown, filename: string) => {
    downloadJsonParts([`${JSON.stringify(document, null, 2)}\n`], filename);
  };

  const exportHistory = async () => {
    setBusy(true);
    try {
      const snapshot = await store.read();
      if (snapshot.invalidRecordCount > 0) {
        reportError({ id: "history.invalidExportBlocked", values: { count: snapshot.invalidRecordCount } });
        return;
      }
      if (snapshot.replayIssueCount > 0) {
        reportError({ id: "history.replayExportBlocked", values: { count: snapshot.replayIssueCount } });
        return;
      }
      const parts: BlobPart[] = [
        `{"format":"h-minesweeper-solo-history","schemaVersion":2,"exportedAt":${JSON.stringify(new Date().toISOString())},"recordCount":${snapshot.records.length},"records":${JSON.stringify(snapshot.records)},"replays":[`,
      ];
      let replayCount = 0;
      for (const record of snapshot.records) {
        const replay = await store.readReplay(record.recordId);
        if (!replay) continue;
        if (replayCount > 0) parts.push(",");
        parts.push(JSON.stringify(replay));
        replayCount += 1;
      }
      parts.push("]}\n");
      downloadJsonParts(
        parts,
        `h-minesweeper-solo-history-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
      );
      setMessage({ id: "history.exported", values: { count: snapshot.records.length } });
      setError(null);
      onStorageError?.("");
      track("solo_exported", {
        format: "json",
        recordCount: snapshot.records.length,
      });
    } catch (cause) {
      reportError({ id: "history.exportFailed" });
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
      setMessage({ id: "history.recoveryExported", values: { count: rawRecords.length } });
      setError(null);
      track("solo_exported", {
        format: "json",
        recordCount: rawRecords.length,
      });
    } catch (cause) {
      reportError({ id: "history.recoveryExportFailed" });
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
      setMessage({ id: "history.legacyExported" });
      setError(null);
    } catch (cause) {
      reportError({ id: "history.legacyExportFailed" });
    }
  };

  const importHistory = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > SOLO_HISTORY_IMPORT_MAX_BYTES) {
      reportError({ id: "history.importTooLarge", values: { max: 64 } });
      return;
    }
    setBusy(true);
    try {
      const document = await new Promise<SoloHistoryExportV2>((resolve, reject) => {
        const worker = new Worker(new URL("../workers/historyImportWorker.ts", import.meta.url), { type: "module" });
        worker.addEventListener("message", (event: MessageEvent<HistoryImportWorkerResponse>) => {
          worker.terminate();
          if (event.data.ok) resolve(event.data.document);
          else reject(new Error(event.data.errorCode));
        }, { once: true });
        worker.addEventListener("error", () => {
          worker.terminate();
          reject(new Error("IMPORT_WORKER_FAILED"));
        }, { once: true });
        worker.postMessage({ requestId: 1, type: "PARSE_AND_VERIFY_IMPORT", file });
      });
      const result = await store.importDocument(document);
      await load();
      setMessage({ id: "history.imported", values: { imported: result.imported, skipped: result.skippedIdentical } });
      setError(null);
      onStorageError?.("");
    } catch (cause) {
      reportError({ id: "history.importFailed" });
    } finally {
      setBusy(false);
    }
  };

  const deleteHistory = async () => {
    if (
      !window.confirm(t("history.deleteConfirm"))
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
      setMessage({ id: "history.deleted" });
      setError(null);
      onStorageError?.("");
    } catch (cause) {
      reportError({ id: "history.deleteFailed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="solo-history" aria-labelledby="solo-history-title">
      <div className="solo-history-heading">
        <div>
          <span className="panel-kicker">{t("history.kicker")}</span>
          <h2 id="solo-history-title">{t("history.title")}</h2>
          <p>{t("history.description")}</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          aria-expanded={expanded}
          onClick={() => chooseExpanded(!expanded)}
        >
          {expanded ? t("history.collapse") : t("history.expand", { count: recordCount })}
        </button>
      </div>

      {error && (
        <div className="solo-history-message is-error" role="alert">
          {t(error.id, error.values)}
        </div>
      )}
      {preferenceError && (
        <div className="solo-history-message is-error" role="alert">
          {t(preferenceError.id, preferenceError.values)}
        </div>
      )}
      {!error && message && (
        <div className="solo-history-message" role="status">
          {t(message.id, message.values)}
        </div>
      )}
      {invalidRecordCount > 0 && (
        <div className="solo-history-message is-error" role="alert">
          {t("history.invalidRecords", { count: invalidRecordCount })}
        </div>
      )}
      {replayIssueCount > 0 && (
        <div className="solo-history-message is-error" role="alert">
          {t("history.replayIssues", { count: replayIssueCount })}
        </div>
      )}
      {legacyMigrationError && (
        <div className="solo-history-message is-error" role="alert">
          {t(legacyMigrationError.id, legacyMigrationError.values)}
        </div>
      )}
      {legacyMigration && legacyMigration.metadata.length > 0 && (
        <div className="solo-history-message" role="status">
          {t("history.legacyPreserved", { count: legacyMigration.metadata.length })}
        </div>
      )}
      {legacyMigration &&
        (legacyMigration.invalidSources.length > 0 ||
          legacyMigration.invalidMetadataCount > 0) && (
          <div className="solo-history-message is-error" role="alert">
            {t("history.legacyInvalid", { sources: legacyMigration.invalidSources.length, metadata: legacyMigration.invalidMetadataCount })}
          </div>
        )}
      {recordCount >= SOLO_HISTORY_WARNING_RECORDS && (
        <div
          className={`solo-history-message${recordCount >= SOLO_HISTORY_MAX_RECORDS ? " is-error" : ""}`}
          role="status"
        >
          {t("history.capacity", { count: recordCount.toLocaleString(), max: SOLO_HISTORY_MAX_RECORDS.toLocaleString() })}
          {recordCount >= SOLO_HISTORY_MAX_RECORDS
            ? ` ${t("history.capacityFull")}`
            : ` ${t("history.capacityWarning")}`}
        </div>
      )}

      {expanded && (
        <>
          <div className="solo-history-trend" aria-label={t("history.trend")}>
            <div>
              <span>{t("history.comparable")}</span>
              <strong>{trend.runCount}</strong>
              <small>{t("history.completedCount", { count: trend.winCount })}</small>
            </div>
            <div>
              <span>{t("history.latestBest")}</span>
              <strong>{formatTime(trend.latestElapsedMs)}</strong>
              <small>{t("history.best")} {formatTime(trend.bestElapsedMs)}</small>
            </div>
            <div>
              <span>{t("history.average")}</span>
              <strong>{formatTime(trend.averageElapsedMs)}</strong>
              <small>{t("history.completedOnly")}</small>
            </div>
            <div>
              <span>{t("history.recentBest3bv")}</span>
              <strong>{formatMetric(trend.latestThreeBvPerSecond)}</strong>
              <small>{t("history.best")} {formatMetric(trend.bestThreeBvPerSecond)}</small>
            </div>
            <div>
              <span>{t("history.recentBestIoe")}</span>
              <strong>
                {trend.latestIoe === null
                  ? "—"
                  : `${(trend.latestIoe * 100).toFixed(1)}%`}
              </strong>
              <small>
                {t("history.best")}{" "}
                {trend.bestIoe === null
                  ? "—"
                  : `${(trend.bestIoe * 100).toFixed(1)}%`}
              </small>
            </div>
          </div>

          <div className="solo-history-toolbar">
            <div className="solo-history-scope" role="group" aria-label={t("history.filter")}>
              <button
                className={scope === "current" ? "is-active" : ""}
                type="button"
                aria-pressed={scope === "current"}
                onClick={() => chooseScope("current")}
              >
                {t("history.current", { count: comparableRecords.length })}
              </button>
              <button
                className={scope === "all" ? "is-active" : ""}
                type="button"
                aria-pressed={scope === "all"}
                onClick={() => chooseScope("all")}
              >
                {t("history.all", { count: records.length })}
              </button>
            </div>
            <div className="solo-history-actions">
              <label className="secondary-button solo-history-import">
                {t("history.import")}
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
              {records.length > 0 && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void exportHistory()}
                >
                  {t("history.export")}
                </button>
              )}
              {invalidRecordCount > 0 && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={exportRecoveryHistory}
                >
                  {t("history.exportRecovery")}
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
                    {t("history.exportLegacyRecovery")}
                  </button>
                )}
              {recordCount > 0 && (
                <button
                  className="secondary-button solo-history-delete"
                  type="button"
                  disabled={busy}
                  onClick={() => void deleteHistory()}
                >
                  {t("history.delete")}
                </button>
              )}
            </div>
          </div>

          {visibleRecords.length === 0 ? (
            <div className="solo-history-empty">
              {scope === "current"
                ? t("history.emptyCurrent")
                : t("history.emptyAll")}
            </div>
          ) : (
            <div className="solo-history-list">
              {visibleRecords.slice(0, 20).map((record) => {
                const completionMetrics = metricValuesForHistoryRecord(
                  record.outcome,
                  record.metrics,
                );
                return (
                <article key={record.recordId}>
                  <div>
                    <strong>
                      {t(record.outcome === "WON" ? "replay.complete" : "replay.lost")} ·{" "}
                      {record.config.width}×{record.config.height} /{" "}
                      {record.config.mines}
                    </strong>
                    <small>
                      {formatDateTime(record.completedAt)} ·{" "}
                      {t(record.config.generationMode === "no_guess" ? "solo.noGuess" : "solo.classic")}
                    </small>
                  </div>
                  <b>{formatTime(record.metrics.elapsedMs)}</b>
                  <span>3BV/s {formatMetric(completionMetrics.threeBvPerSecond)}</span>
                  <span>
                    IOE{" "}
                    {completionMetrics.ioe === null
                      ? "—"
                      : `${(completionMetrics.ioe * 100).toFixed(1)}%`}
                  </span>
                  <span>{t("history.actions", { count: record.metrics.semanticActions })}</span>
                  {record.schemaVersion === 1 ? (
                    <span>{t("history.legacyOnly")}</span>
                  ) : record.replay.status === "UNAVAILABLE" ? (
                    <span>{t("history.unsavedReplay")}</span>
                  ) : !availableReplayIds.has(record.recordId) ? (
                    <span>{t("history.corruptReplay")}</span>
                  ) : (
                    <a href={`#/solo/replay/${encodeURIComponent(record.recordId)}`}>
                      {t("history.openReplay")}
                    </a>
                  )}
                </article>
              );})}
              {visibleRecords.length > 20 && (
                <p>{t("history.latestTwenty")}</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
