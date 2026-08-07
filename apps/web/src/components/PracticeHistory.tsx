import { useCallback, useEffect, useState } from "react";
import { useLocale, type MessageDescriptor } from "../i18n";
import {
  PRACTICE_HISTORY_IMPORT_MAX_BYTES,
  PracticeHistoryCapacityError,
  createPracticeHistoryExport,
  parsePracticeHistoryImport,
  type PracticeHistoryReadResult,
  type PracticeHistoryStore,
} from "../lib/practice-history";
import "./practice-history.css";

const PRACTICE_HISTORY_PAGE_SIZE = 20;

interface PracticeHistoryProps {
  readonly store: PracticeHistoryStore;
  readonly refreshToken: number;
}

function formatPracticeTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.floor((Math.max(0, elapsedMs) % 1_000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function downloadJson(document: unknown, filename: string): void {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function PracticeHistory({ store, refreshToken }: PracticeHistoryProps) {
  const { locale, t } = useLocale();
  const [snapshot, setSnapshot] = useState<PracticeHistoryReadResult | null>(null);
  const [message, setMessage] = useState<MessageDescriptor | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [visibleRecordLimit, setVisibleRecordLimit] = useState(
    PRACTICE_HISTORY_PAGE_SIZE,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await store.read());
      setVisibleRecordLimit(PRACTICE_HISTORY_PAGE_SIZE);
      setMessage(null);
    } catch {
      setMessage({ id: "practice.history.readFailed" });
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const exportHistory = async () => {
    if (!snapshot) return;
    try {
      const replays = await Promise.all(
        snapshot.records.map((record) => store.readReplay(record.recordId)),
      );
      const document = createPracticeHistoryExport(
        snapshot.records,
        replays.filter((replay) => replay !== null),
      );
      downloadJson(
        document,
        `h-minesweeper-practice-${new Date().toISOString().slice(0, 10)}.json`,
      );
      setMessage({ id: "practice.history.exported", values: { count: document.recordCount } });
    } catch {
      setMessage({ id: "practice.history.exportFailed" });
    }
  };

  const importHistory = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > PRACTICE_HISTORY_IMPORT_MAX_BYTES) {
      setMessage({ id: "practice.history.importTooLarge" });
      return;
    }
    try {
      const document = parsePracticeHistoryImport(await file.text());
      const result = await store.importDocument(document);
      await refresh();
      setMessage({
        id: "practice.history.imported",
        values: {
          imported: result.imported,
          skipped: result.skippedIdentical,
        },
      });
    } catch (error) {
      setMessage({
        id: error instanceof PracticeHistoryCapacityError
          ? "practice.history.full"
          : "practice.history.importFailed",
      });
    }
  };

  const clearHistory = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      setMessage({ id: "practice.history.clearConfirm" });
      return;
    }
    try {
      await store.clear();
      setConfirmingClear(false);
      await refresh();
      setMessage({ id: "practice.history.cleared" });
    } catch {
      setMessage({ id: "practice.history.clearFailed" });
    }
  };

  return (
    <section id="practice-history" className="practice-history" aria-labelledby="practice-history-title">
      <div className="practice-history-heading">
        <div>
          <span className="panel-kicker">{t("practice.history.kicker")}</span>
          <h2 id="practice-history-title">{t("practice.history.title")}</h2>
          <p>{t("practice.history.description")}</p>
        </div>
        <span className="practice-not-scored">{t("practice.notScored")}</span>
      </div>

      <div className="practice-history-actions">
        <label className="secondary-button practice-history-import">
          {t("practice.history.import")}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void importHistory(file);
            }}
          />
        </label>
        {snapshot && snapshot.recordCount > 0 && (
          <>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void exportHistory()}
            >
              {t("practice.history.export")}
            </button>
            <button
              className="secondary-button practice-history-delete"
              type="button"
              onClick={() => void clearHistory()}
              onBlur={() => setConfirmingClear(false)}
            >
              {t(confirmingClear ? "practice.history.clearConfirmButton" : "practice.history.clear")}
            </button>
          </>
        )}
      </div>

      {message && (
        <div className="practice-history-message" role="status">
          {t(message.id, message.values)}
        </div>
      )}
      {snapshot && (snapshot.invalidRecordCount > 0 || snapshot.invalidReplayCount > 0) && (
        <div className="practice-history-message is-error" role="alert">
          {t("practice.history.invalid", {
            records: snapshot.invalidRecordCount,
            replays: snapshot.invalidReplayCount,
          })}
        </div>
      )}
      {snapshot?.full && (
        <div className="practice-history-message is-error" role="alert">
          {t("practice.history.full")}
        </div>
      )}

      {loading ? (
        <div className="practice-history-empty" role="status">{t("common.loading")}</div>
      ) : !snapshot || snapshot.records.length === 0 ? (
        <div className="practice-history-empty">{t("practice.history.empty")}</div>
      ) : (
        <div className="practice-history-list">
          {snapshot.records.slice(0, visibleRecordLimit).map((record) => {
            const hasReplay = snapshot.availableReplayRecordIds.includes(record.recordId);
            return (
              <article key={record.recordId}>
                <div>
                  <strong>
                    {record.config.width}×{record.config.height} / {record.config.mines}
                  </strong>
                  <span>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(record.completedAt))}
                  </span>
                </div>
                <b>{t(record.outcome === "WON" ? "practice.history.won" : "practice.history.lost")}</b>
                <div>
                  <span>{t("practice.history.time")}</span>
                  <strong>{formatPracticeTime(record.summary.elapsedMs)}</strong>
                </div>
                <div>
                  <span>{t("practice.history.playerActions")}</span>
                  <strong>{record.summary.playerActions}</strong>
                </div>
                <div>
                  <span>{t("practice.history.assists")}</span>
                  <strong>{record.summary.hintsShown + record.summary.autoFlags + record.summary.demonstratedActions}</strong>
                </div>
                {hasReplay ? (
                  <a className="secondary-button" href={`#/solo/practice/replay/${encodeURIComponent(record.recordId)}`}>
                    {t("practice.history.review")}
                  </a>
                ) : (
                  <span>{t("practice.history.replayUnavailable")}</span>
                )}
              </article>
            );
          })}
          {snapshot.records.length > visibleRecordLimit && (
            <div className="practice-history-more">
              <span>{t("practice.history.showing", {
                visible: Math.min(visibleRecordLimit, snapshot.records.length),
                total: snapshot.records.length,
              })}</span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setVisibleRecordLimit((current) =>
                  Math.min(current + PRACTICE_HISTORY_PAGE_SIZE, snapshot.records.length)
                )}
              >
                {t("practice.history.showMore")}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
