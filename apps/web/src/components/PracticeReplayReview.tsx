import { useEffect, useMemo, useState } from "react";
import type { VisibleBoardProof } from "@h-minesweeper/game-core";
import { useLocale, type MessageDescriptor, type MessageId } from "../i18n";
import {
  createIndexedDbPracticeHistoryStore,
  type PracticeReplayEventV1,
  type PracticeReplayV1,
  type PracticeRunRecordV1,
} from "../lib/practice-history";
import type { PracticeReplayWorkerResponse } from "../workers/practiceReplayWorker";
import { buildPracticeReplayBoardCells } from "../lib/practice-replay-board";
import { ReplayBoard, type ReplayBoardCellState } from "./ReplayBoard";
import "./replay-review.css";
import "./practice-replay.css";

const store = createIndexedDbPracticeHistoryStore();

interface PracticeReplayReviewProps {
  readonly recordId: string;
  readonly onExit: () => void;
}

function proofForEvent(
  event: PracticeReplayEventV1 | undefined,
  fallbackProofs: readonly VisibleBoardProof[],
): VisibleBoardProof | undefined {
  if (!event) return undefined;
  if (event.eventType === "ASSISTANCE_SHOWN") return event.suggestion.proof;
  if (event.eventType === "COACH_ACTION") return event.proof;
  return fallbackProofs.find(({ targets }) => targets.includes(event.cellIndex));
}

function practiceActionMessageId(action: string): MessageId {
  if (action === "FLAG") return "practice.action.flag";
  if (action === "UNFLAG") return "practice.action.unflag";
  if (action === "QUESTION") return "practice.action.question";
  if (action === "CLEAR_QUESTION") return "practice.action.clearQuestion";
  if (action === "CHORD") return "practice.action.chord";
  return "practice.action.reveal";
}

export function PracticeReplayReview({ recordId, onExit }: PracticeReplayReviewProps) {
  const { t } = useLocale();
  const [record, setRecord] = useState<PracticeRunRecordV1 | null>(null);
  const [replay, setReplay] = useState<PracticeReplayV1 | null>(null);
  const [result, setResult] = useState<Extract<PracticeReplayWorkerResponse, { ok: true }> | null>(null);
  const [error, setError] = useState<MessageDescriptor | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAfter, setShowAfter] = useState(false);
  const [showTerminalTruth, setShowTerminalTruth] = useState(false);

  useEffect(() => {
    let active = true;
    let worker: Worker | null = null;
    let workerTimeout: number | null = null;
    void Promise.all([store.read(), store.readReplay(recordId)]).then(([history, loadedReplay]) => {
      if (!active) return;
      const loadedRecord = history.records.find((entry) => entry.recordId === recordId);
      if (!loadedRecord || !loadedReplay) {
        setError({ id: "practice.replay.notFound" });
        return;
      }
      setRecord(loadedRecord);
      setReplay(loadedReplay);
      try {
        worker = new Worker(new URL("../workers/practiceReplayWorker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        setError({ id: "practice.replay.workerUnavailable" });
        return;
      }
      worker.addEventListener("message", (event: MessageEvent<PracticeReplayWorkerResponse>) => {
        if (!active || !event.data || event.data.requestId !== 1) return;
        if (workerTimeout !== null) {
          window.clearTimeout(workerTimeout);
          workerTimeout = null;
        }
        if (!event.data.ok) {
          setError({ id: "practice.replay.verifyFailed" });
          return;
        }
        setResult(event.data);
      });
      const failWorker = () => {
        if (!active) return;
        if (workerTimeout !== null) {
          window.clearTimeout(workerTimeout);
          workerTimeout = null;
        }
        worker?.terminate();
        setError({ id: "practice.replay.verifyFailed" });
      };
      worker.addEventListener("error", failWorker, { once: true });
      worker.addEventListener("messageerror", failWorker, { once: true });
      workerTimeout = window.setTimeout(failWorker, 10_000);
      worker.postMessage({ requestId: 1, record: loadedRecord, replay: loadedReplay });
    }).catch(() => setError({ id: "practice.replay.readFailed" }));
    return () => {
      active = false;
      if (workerTimeout !== null) window.clearTimeout(workerTimeout);
      worker?.terminate();
    };
  }, [recordId]);

  const selectedEvent = replay?.events[selectedIndex];
  const selectedStep = result?.steps[selectedIndex];
  const selectedProof = proofForEvent(selectedEvent, selectedStep?.before.proofs ?? []);

  const replayCells = useMemo(() => {
    if (!record || !replay || !result) return null;
    return buildPracticeReplayBoardCells({
      cellCount: record.board.spec.width * record.board.spec.height,
      initialFlags: replay.initialFlags,
      initialQuestions: replay.initialQuestions ?? [],
      steps: result.steps,
      selectedIndex,
      showAfter,
      showTerminalTruth,
      terminalCells: result.terminal.cells,
    });
  }, [record, replay, result, selectedIndex, showAfter, showTerminalTruth]);

  const boardState = useMemo<ReplayBoardCellState | null>(() => {
    if (!record || !result || !replayCells || !selectedEvent) return null;
    const target = selectedEvent.eventType === "ASSISTANCE_SHOWN"
      ? selectedEvent.suggestion.cellIndex
      : selectedEvent.cellIndex;
    const suggestionAction = selectedEvent.eventType === "ASSISTANCE_SHOWN"
      ? selectedEvent.suggestion.action
      : selectedEvent.eventType === "COACH_ACTION"
        ? selectedEvent.action
        : undefined;
    return {
      cells: replayCells,
      proofSources: new Set(selectedProof?.sources ?? []),
      suggestedSafe: new Set(
        target !== undefined && (suggestionAction === "REVEAL" || suggestionAction === "UNFLAG")
          ? [target]
          : [],
      ),
      suggestedMines: new Set(target !== undefined && suggestionAction === "FLAG" ? [target] : []),
      ...(target === undefined ? {} : { currentTarget: target }),
      numberedSuggestions: target === undefined ? [] : [target],
      ...(showTerminalTruth && result.terminal.detonatedMine !== undefined
        ? { detonatedMine: result.terminal.detonatedMine }
        : {}),
      otherMines: new Set(showTerminalTruth ? result.terminal.otherMines : []),
      correctFlags: new Set(showTerminalTruth ? result.terminal.correctFlags : []),
      wrongFlags: new Set(showTerminalTruth ? result.terminal.wrongFlags : []),
    };
  }, [record, replayCells, result, selectedEvent, selectedProof, showTerminalTruth]);

  const coordinate = (cellIndex: number) => {
    const width = record?.board.spec.width ?? 1;
    return t("practice.coordinate", {
      row: Math.floor(cellIndex / width) + 1,
      column: (cellIndex % width) + 1,
    });
  };

  const eventTitle = () => {
    if (!selectedEvent) return "";
    if (selectedEvent.eventType === "ASSISTANCE_SHOWN") {
      return t(selectedEvent.trigger === "IDLE" ? "practice.replay.idleHint" : "practice.replay.requestedHint");
    }
    if (selectedEvent.eventType === "COACH_ACTION") {
      return t(selectedEvent.trigger === "AUTO_MARK" ? "practice.replay.autoAction" : "practice.replay.demonstratedAction");
    }
    return t("practice.replay.playerAction");
  };

  const eventDescription = () => {
    if (!selectedEvent) return "";
    if (selectedEvent.eventType === "ASSISTANCE_SHOWN") {
      const suggestion = selectedEvent.suggestion;
      if (suggestion.status === "CONTRADICTION") return t("practice.coach.contradiction");
      if (suggestion.status === "PARTIAL" && suggestion.action === undefined) return t("practice.coach.partial");
      if (suggestion.status === "NO_FORCED_MOVE") return t("practice.coach.noMove");
      if (suggestion.cellIndex === undefined || suggestion.action === undefined) return t("practice.coach.unavailable");
      return t(practiceActionMessageId(suggestion.action), {
        coordinate: coordinate(suggestion.cellIndex),
      });
    }
    const action = selectedEvent.eventType === "COACH_ACTION"
      ? selectedEvent.action
      : selectedEvent.actionType === "TOGGLE_FLAG"
        ? selectedStep?.questionChange?.questioned === true
          ? "QUESTION"
          : selectedStep?.questionChange?.questioned === false
            ? "CLEAR_QUESTION"
            : selectedStep?.flagChange?.flagged === false ? "UNFLAG" : "FLAG"
        : selectedEvent.actionType;
    return t(practiceActionMessageId(action), {
      coordinate: coordinate(selectedEvent.cellIndex),
    });
  };

  const proofDescription = () => {
    if (!selectedProof) return t("practice.replay.noProof");
    const sources = selectedProof.sources.map(coordinate).join(t("replay.listSeparator"));
    if (selectedProof.rule === "SINGLE_MINE") return t("practice.reason.singleMine", { sources });
    if (selectedProof.rule === "SINGLE_SAFE") return t("practice.reason.singleSafe", { sources });
    if (selectedProof.rule.startsWith("SUBSET")) return t("practice.reason.subset", { sources });
    if (selectedProof.rule.startsWith("GLOBAL")) return t("practice.reason.global");
    return t("practice.reason.csp", { sources });
  };

  const selectStep = (next: number) => {
    setSelectedIndex(Math.max(0, Math.min((replay?.events.length ?? 1) - 1, next)));
    setShowAfter(false);
  };

  return (
    <section className="replay-review-shell practice-replay-shell">
      <header>
        <div>
          <span className="panel-kicker">{t("practice.replay.kicker")}</span>
          <h1>{t("practice.replay.title")}</h1>
        </div>
        <button className="secondary-button" type="button" onClick={onExit}>{t("common.back")}</button>
      </header>
      <div className="practice-replay-not-scored">{t("practice.notScored")}</div>
      {record && (
        <p>
          {record.config.width}×{record.config.height} / {record.config.mines} · {t(record.outcome === "WON" ? "practice.history.won" : "practice.history.lost")}
        </p>
      )}
      {!error && !result && <div className="replay-review-status" role="status">{t("practice.replay.verifying")}</div>}
      {error && <div className="replay-review-status is-error" role="alert">{t(error.id, error.values)}</div>}
      {record && replay && result && selectedEvent && selectedStep && boardState && (
        <>
          <div className="replay-review-summary">
            {t("practice.replay.verified", { count: replay.events.length })}
          </div>
          <div className="replay-workspace">
            <div>
              <ReplayBoard width={record.board.spec.width} height={record.board.spec.height} state={boardState} />
              <div className="replay-legend" aria-label={t("replay.legendAria")}>
                <span>{t("replay.legend.source")}</span>
                <span>{t("replay.legend.target")}</span>
              </div>
            </div>
            <aside className="replay-explanation">
              <span className="panel-kicker">
                {t("replay.stepProgress", { current: selectedIndex + 1, total: replay.events.length })}
              </span>
              <h2>{eventTitle()}</h2>
              <dl>
                <dt>{t("replay.what")}</dt>
                <dd>{eventDescription()}</dd>
                <dt>{t("replay.why")}</dt>
                <dd>{proofDescription()}</dd>
                <dt>{t("practice.replay.actor")}</dt>
                <dd>{t(selectedEvent.eventType === "PLAYER_ACTION" ? "practice.replay.actor.player" : "practice.replay.actor.coach")}</dd>
              </dl>
            </aside>
          </div>
          <div className="replay-controls">
            <button type="button" onClick={() => selectStep(selectedIndex - 1)} disabled={selectedIndex === 0}>{t("replay.prev")}</button>
            <button type="button" onClick={() => selectStep(selectedIndex + 1)} disabled={selectedIndex >= replay.events.length - 1}>{t("replay.next")}</button>
            <button type="button" onClick={() => setShowAfter((value) => !value)}>{t(showAfter ? "replay.showBefore" : "replay.showAfter")}</button>
            <button type="button" aria-pressed={showTerminalTruth} onClick={() => setShowTerminalTruth((value) => !value)}>{t(showTerminalTruth ? "replay.hideTruth" : "replay.showTruth")}</button>
          </div>
        </>
      )}
    </section>
  );
}
