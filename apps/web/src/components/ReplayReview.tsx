import { useEffect, useMemo, useState } from "react";
import {
  getNeighborIndices,
  type VisibleAnalysisStatus,
  type VisibleBoardProof,
} from "@h-minesweeper/game-core";
import { createIndexedDbSoloHistoryStore, type SoloReplayV1, type SoloRunRecordV2 } from "../lib/solo-history";
import type { ReplayWorkerResponse } from "../workers/replayWorker";
import {
  cellCoordinates,
  explainReplayStep,
  learningConceptForReview,
  type ReviewActionSuggestion,
  type ReviewStepExplanation,
  type ReviewStepVerdict,
} from "../lib/replay-explanations";
import { ReplayBoard, type ReplayBoardCellState } from "./ReplayBoard";
import "./replay-review.css";
import { useLocale, type MessageDescriptor, type MessageId } from "../i18n";

const store = createIndexedDbSoloHistoryStore();

interface ReplayReviewProps {
  readonly recordId: string;
  readonly onExit: () => void;
}

interface ReviewMoment {
  readonly index: number;
  readonly seq: number;
  readonly action: SoloReplayV1["actions"][number];
  readonly explanation: ReviewStepExplanation;
}

const VERDICT_MESSAGE_IDS: Readonly<Record<ReviewStepVerdict, MessageId>> = {
  PROVABLE_MINE_REVEALED: "replay.verdict.mineRevealed",
  PROVABLE_SAFE_FLAGGED: "replay.verdict.safeFlagged",
  CORRECT_SAFE_REVEAL: "replay.verdict.correctSafe",
  CORRECT_MINE_FLAG: "replay.verdict.correctMine",
  UNDETERMINED_TARGET_WITH_ALTERNATIVES: "replay.verdict.undeterminedWithAlternatives",
  NO_DETERMINISTIC_MOVE: "replay.verdict.noDeterministicMove",
  UNCERTAIN_LOSS: "replay.verdict.uncertainLoss",
  WRONG_FLAG_CHORD_CHAIN: "replay.verdict.wrongFlagChord",
  FIRST_CLICK_PROTECTED: "replay.verdict.firstClick",
  ANALYSIS_PARTIAL: "replay.verdict.partial",
  ANALYSIS_CONTRADICTION: "replay.verdict.contradiction",
  ACTION_NOT_APPLIED: "replay.verdict.notApplied",
  CORRECT_WRONG_FLAG_REMOVED: "replay.verdict.correctUnflag",
  PROVABLE_MINE_UNFLAGGED: "replay.verdict.mineUnflagged",
  UNDETERMINED_FLAG_REMOVED: "replay.verdict.undeterminedUnflag",
};

const ANALYSIS_STATUS_MESSAGE_IDS: Readonly<
  Record<VisibleAnalysisStatus, MessageId>
> = {
  COMPLETE: "replay.analysisStatus.complete",
  PARTIAL: "replay.analysisStatus.partial",
  CONTRADICTION: "replay.analysisStatus.contradiction",
};

const PROOF_RULE_MESSAGE_IDS: Readonly<
  Record<VisibleBoardProof["rule"], MessageId>
> = {
  SINGLE_MINE: "replay.rule.singleMine",
  SINGLE_SAFE: "replay.rule.singleSafe",
  SUBSET_MINE: "replay.rule.subsetMine",
  SUBSET_SAFE: "replay.rule.subsetSafe",
  GLOBAL_MINE: "replay.rule.globalMine",
  GLOBAL_SAFE: "replay.rule.globalSafe",
  CSP_MINE: "replay.rule.cspMine",
  CSP_SAFE: "replay.rule.cspSafe",
};

function conceptForMoment(moment: ReviewMoment): string {
  return learningConceptForReview({
    verdict: moment.explanation.verdict,
    ...(moment.explanation.targetProof ? { proof: moment.explanation.targetProof } : {}),
  });
}

function isPrimaryMoment(verdict: ReviewStepVerdict): boolean {
  return [
    "PROVABLE_MINE_REVEALED",
    "PROVABLE_SAFE_FLAGGED",
    "WRONG_FLAG_CHORD_CHAIN",
    "UNCERTAIN_LOSS",
    "CORRECT_SAFE_REVEAL",
    "CORRECT_MINE_FLAG",
    "CORRECT_WRONG_FLAG_REMOVED",
    "PROVABLE_MINE_UNFLAGGED",
  ].includes(verdict);
}

export function ReplayReview({ recordId, onExit }: ReplayReviewProps) {
  const { t } = useLocale();
  const [record, setRecord] = useState<SoloRunRecordV2 | null>(null);
  const [replay, setReplay] = useState<SoloReplayV1 | null>(null);
  const [result, setResult] = useState<Extract<ReplayWorkerResponse, { type: "RESULT"; ok: true }> | null>(null);
  const [error, setError] = useState<MessageDescriptor | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<{ completed: number; total: number } | null>(null);
  const [selectedSeq, setSelectedSeq] = useState(0);
  const [showAfter, setShowAfter] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [showTerminalTruth, setShowTerminalTruth] = useState(false);
  const [focusedSuggestion, setFocusedSuggestion] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let worker: Worker | null = null;
    void Promise.all([store.read(), store.readReplay(recordId)]).then(([history, loadedReplay]) => {
      if (!active) return;
      const loaded = history.records.find((item) => item.recordId === recordId);
      if (!loaded) { setError({ id: "replay.notFound" }); return; }
      if (loaded.schemaVersion !== 2) { setError({ id: "replay.legacy" }); return; }
      setRecord(loaded);
      if (loaded.replay.status === "UNAVAILABLE" || !loadedReplay) {
        setError({ id: "replay.unavailable" }); return;
      }
      setReplay(loadedReplay);
      worker = new Worker(new URL("../workers/replayWorker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<ReplayWorkerResponse>) => {
        if (!active) return;
        if (event.data.type === "PROGRESS") {
          setAnalysisProgress({ completed: event.data.completed, total: event.data.total });
          return;
        }
        if (event.data.type === "CANCELLED") return;
        if (event.data.type === "STEP_RESULT") return;
        if (event.data.ok) {
          setResult(event.data);
          setAnalysisProgress(null);
          setSelectedSeq(Math.max(0, event.data.steps.length - 1));
        } else {
          setError({ id: "replay.verifyFailed", values: { code: event.data.errorCode } });
        }
      });
      worker.postMessage({ requestId: 1, type: "VERIFY_AND_ANALYZE", record: loaded, replay: loadedReplay });
    }).catch(() => setError({ id: "replay.readFailed" }));
    return () => {
      active = false;
      worker?.postMessage({ requestId: 1, type: "CANCEL" });
      worker?.terminate();
    };
  }, [recordId]);

  const explanations = useMemo(() => {
    if (!record || !replay || !result) return [];
    const firstAcceptedReveal = replay.actions.findIndex(
      (action) => action.actionType === "REVEAL" && action.accepted,
    );
    return result.steps.map((step, index) => {
      const action = replay.actions[index]!;
      return explainReplayStep({
        width: record.board.spec.width,
        analysis: step.before,
        action,
        accepted: step.accepted,
        hitMine: step.hitMine,
        ...(step.flagChange ? { flagged: step.flagChange.flagged } : {}),
        outcome: step.outcome,
        isFirstAcceptedReveal: index === firstAcceptedReveal,
        wrongFlagChord:
          action.actionType === "CHORD" &&
          step.outcome === "LOST" &&
          result.terminal.wrongFlags.length > 0,
        playerClaims: step.playerClaims,
      });
    });
  }, [record, replay, result]);

  const moments = useMemo(() => {
    if (!result || !replay) return [];
    const candidates = result.steps.flatMap((step, index) => {
      const action = replay.actions[index];
      const explanation = explanations[index];
      if (!action || !explanation || !isPrimaryMoment(explanation.verdict)) return [];
      return [{ index, seq: step.seq, action, explanation } satisfies ReviewMoment];
    });
    const mistakes = candidates.filter(({ explanation }) => [
      "PROVABLE_MINE_REVEALED",
      "PROVABLE_SAFE_FLAGGED",
      "WRONG_FLAG_CHORD_CHAIN",
      "UNCERTAIN_LOSS",
    ].includes(explanation.verdict));
    const representativeCorrect = candidates.filter(({ explanation }) => [
      "CORRECT_SAFE_REVEAL",
      "CORRECT_MINE_FLAG",
    ].includes(explanation.verdict)).at(-1);
    return [...new Map(
      [...mistakes.slice(0, 2), ...(representativeCorrect ? [representativeCorrect] : [])]
        .map((moment) => [moment.index, moment]),
    ).values()].slice(0, 3);
  }, [explanations, replay, result]);

  const selectedStep = result?.steps[selectedSeq];
  const selectedAction = replay?.actions[selectedSeq];
  const selectedExplanation = explanations[selectedSeq];

  const cellsBefore = useMemo(() => {
    if (!record || !replay || !result) return null;
    const cells = new Int8Array(record.board.spec.width * record.board.spec.height);
    cells.fill(-2);
    for (const index of replay.initialFlags) cells[index] = -3;
    for (let index = 0; index < selectedSeq; index += 1) {
      const step = result.steps[index];
      if (!step) continue;
      for (const revealed of step.revealed) cells[revealed.index] = revealed.value;
      if (step.flagChange) cells[step.flagChange.index] = step.flagChange.flagged ? -3 : -2;
    }
    return cells;
  }, [record, replay, result, selectedSeq]);

  const visibleSuggestions = useMemo(() => {
    if (!selectedExplanation) return [];
    const firstSafe = selectedExplanation.safeSuggestions[0];
    const firstMine = selectedExplanation.mineSuggestions[0];
    const balanced = [firstSafe, firstMine].filter(
      (suggestion): suggestion is ReviewActionSuggestion => suggestion !== undefined,
    );
    const remaining = [
      ...selectedExplanation.safeSuggestions.slice(firstSafe ? 1 : 0),
      ...selectedExplanation.mineSuggestions.slice(firstMine ? 1 : 0),
    ];
    return [...balanced, ...remaining].slice(0, 3);
  }, [selectedExplanation]);

  const boardState = useMemo<ReplayBoardCellState | null>(() => {
    if (!record || !replay || !result || !selectedExplanation || !cellsBefore) return null;
    const cells = Int8Array.from(cellsBefore);
    if (showAfter) {
      const step = result.steps[selectedSeq];
      if (step) {
        for (const revealed of step.revealed) cells[revealed.index] = revealed.value;
        if (step.flagChange) cells[step.flagChange.index] = step.flagChange.flagged ? -3 : -2;
      }
    }
    const currentTarget = focusedSuggestion ?? selectedAction?.cellIndex;
    return {
      cells,
      proofSources: new Set(selectedExplanation.targetProof?.sourceCells ?? []),
      suggestedSafe: new Set(visibleSuggestions.filter(({ action }) => action === "REVEAL" || action === "UNFLAG_THEN_REVEAL").map(({ cellIndex }) => cellIndex)),
      suggestedMines: new Set(visibleSuggestions.filter(({ action }) => action === "FLAG").map(({ cellIndex }) => cellIndex)),
      ...(currentTarget === undefined ? {} : { currentTarget }),
      numberedSuggestions: visibleSuggestions.map(({ cellIndex }) => cellIndex),
      ...(showTerminalTruth && result.terminal.detonatedMine !== undefined ? { detonatedMine: result.terminal.detonatedMine } : {}),
      otherMines: new Set(showTerminalTruth ? result.terminal.otherMines : []),
      correctFlags: new Set(showTerminalTruth ? result.terminal.correctFlags : []),
      wrongFlags: new Set(showTerminalTruth ? result.terminal.wrongFlags : []),
    };
  }, [cellsBefore, focusedSuggestion, record, replay, result, selectedAction, selectedExplanation, selectedSeq, showAfter, showTerminalTruth, visibleSuggestions]);

  const selectStep = (index: number) => {
    setSelectedSeq(Math.max(0, Math.min((result?.steps.length ?? 1) - 1, index)));
    setShowAfter(false);
    setFocusedSuggestion(null);
  };

  const coordinateText = (cellIndex: number) => {
    const width = record?.board.spec.width ?? 1;
    return t("replay.coordinate", cellCoordinates(width, cellIndex));
  };

  const actionText = (action: SoloReplayV1["actions"][number], index: number) => {
    const coordinate = coordinateText(action.cellIndex);
    if (action.actionType === "REVEAL") return t("replay.action.reveal", { coordinate });
    if (action.actionType === "CHORD") return t("replay.action.chord", { coordinate });
    const flagged = result?.steps[index]?.flagChange?.flagged;
    return t(flagged === false ? "replay.action.unflag" : "replay.action.flag", { coordinate });
  };

  const reasonText = () => {
    if (!selectedExplanation || !selectedStep || !record || !cellsBefore) return "—";
    if (selectedExplanation.verdict === "FIRST_CLICK_PROTECTED") return t("replay.reason.firstClick");
    if (selectedExplanation.verdict === "ANALYSIS_CONTRADICTION") return t("replay.reason.contradiction");
    if (selectedExplanation.verdict === "ACTION_NOT_APPLIED") return t("replay.reason.notApplied");
    if (selectedExplanation.verdict === "CORRECT_WRONG_FLAG_REMOVED") return t("replay.reason.correctUnflag");
    if (selectedExplanation.verdict === "PROVABLE_MINE_UNFLAGGED") return t("replay.reason.mineUnflagged");
    if (selectedExplanation.verdict === "UNDETERMINED_FLAG_REMOVED") return t("replay.reason.undeterminedUnflag");
    if (selectedExplanation.verdict === "ANALYSIS_PARTIAL" && !selectedExplanation.targetProof) return t("replay.reason.partial");
    if (selectedExplanation.verdict === "UNDETERMINED_TARGET_WITH_ALTERNATIVES") return t("replay.reason.unknownWithAlternatives");
    if (["NO_DETERMINISTIC_MOVE", "UNCERTAIN_LOSS"].includes(selectedExplanation.verdict)) return t("replay.reason.noDeterministicMove");
    if (selectedExplanation.verdict === "WRONG_FLAG_CHORD_CHAIN") {
      const chordTarget = selectedAction?.cellIndex;
      const adjacent = chordTarget === undefined
        ? []
        : getNeighborIndices(record.board.spec.width, record.board.spec.height, chordTarget);
      const causalWrongFlags = result?.terminal.wrongFlags.filter((index) => adjacent.includes(index)) ?? [];
      const detonated = result?.terminal.detonatedMine;
      return t("replay.reason.wrongFlagChord", {
        wrongFlag: causalWrongFlags.length === 0
          ? t("replay.unknownCell")
          : causalWrongFlags.map(coordinateText).join(t("replay.listSeparator")),
        clue: chordTarget === undefined ? t("replay.unknownCell") : coordinateText(chordTarget),
        clueValue: chordTarget === undefined ? "—" : (cellsBefore[chordTarget] ?? "—"),
        detonated: detonated === undefined ? t("replay.unknownCell") : coordinateText(detonated),
      });
    }
    const proof = selectedExplanation.targetProof;
    if (!proof) return t("replay.reason.noTargetProof");
    const clue = proof.sourceCells[0] === undefined ? undefined : cellsBefore[proof.sourceCells[0]];
    const targetCount = proof.targetCells.length;
    if (proof.rule === "SINGLE_MINE") return t("replay.reason.singleMine", { clue: clue ?? "—", count: targetCount });
    if (proof.rule === "SINGLE_SAFE") return t("replay.reason.singleSafe", { clue: clue ?? "—" });
    if (proof.rule.startsWith("SUBSET")) return t(proof.kind === "MINE" ? "replay.reason.subsetMine" : "replay.reason.subsetSafe", { sources: proof.sourceCells.map(coordinateText).join(t("replay.listSeparator")) });
    if (proof.rule.startsWith("GLOBAL")) return t(proof.kind === "MINE" ? "replay.reason.globalMine" : "replay.reason.globalSafe", { mines: record.board.spec.mines });
    return t(proof.kind === "MINE" ? "replay.reason.cspMine" : "replay.reason.cspSafe");
  };

  const truthText = () => {
    if (!selectedAction || !result) return "—";
    const target = selectedAction.cellIndex;
    if (result.terminal.wrongFlags.includes(target)) return t("replay.truth.wrongFlag");
    if (result.terminal.detonatedMine === target || result.terminal.otherMines.includes(target)) return t("replay.truth.mine");
    return t("replay.truth.safe");
  };

  const renderSuggestions = (suggestions: readonly ReviewActionSuggestion[], action: ReviewActionSuggestion["action"]) => {
    return <div className="replay-suggestion-group">
      <strong>{t(action === "FLAG" ? "replay.suggestions.mine" : "replay.suggestions.safe")}</strong>
      {suggestions.length === 0 ? <span>{t("replay.suggestions.none")}</span> : <div>
        {suggestions.map((suggestion) => <button
          type="button"
          key={`${suggestion.action}-${suggestion.cellIndex}`}
          aria-pressed={focusedSuggestion === suggestion.cellIndex}
          onClick={() => setFocusedSuggestion(suggestion.cellIndex)}
        >
          <b>{visibleSuggestions.findIndex(({ cellIndex, action: visibleAction }) => cellIndex === suggestion.cellIndex && visibleAction === suggestion.action) + 1}</b>
          {t(action === "FLAG" ? "replay.suggestion.flag" : action === "UNFLAG_THEN_REVEAL" ? "replay.suggestion.unflagReveal" : "replay.suggestion.reveal", {
            coordinate: coordinateText(suggestion.cellIndex),
          })}
        </button>)}
      </div>}
    </div>;
  };

  return <section className="replay-review-shell">
    <header>
      <div><span className="panel-kicker">{t("replay.kicker")}</span><h1>{t("replay.title")}</h1></div>
      <button className="secondary-button" type="button" onClick={onExit}>{t("common.back")}</button>
    </header>
    {record && <p>{record.config.width}×{record.config.height} / {record.config.mines} · {t(record.outcome === "WON" ? "replay.complete" : "replay.lost")}</p>}
    {!error && !result && <div className="replay-review-status" role="status">{analysisProgress
      ? t("replay.verifyingProgress", { completed: analysisProgress.completed, total: analysisProgress.total })
      : t("replay.verifying")}</div>}
    {error && <div className="replay-review-status is-error" role="alert">{t(error.id, error.values)}</div>}
    {result && <>
      <div className="replay-review-summary">{t("replay.verifiedHuman", { count: result.steps.length })}</div>
      {record?.replay.status === "TRUNCATED" && <div className="replay-review-status" role="status">{t("replay.truncated")}</div>}
      {record && boardState && selectedExplanation && selectedAction && <div className="replay-workspace">
        <div>
          <ReplayBoard width={record.board.spec.width} height={record.board.spec.height} state={boardState} />
          <div className="replay-legend" aria-label={t("replay.legendAria")}>
            {showTerminalTruth && <><span>{t("replay.legend.detonated")}</span><span>{t("replay.legend.mine")}</span><span>{t("replay.legend.correctFlag")}</span><span>{t("replay.legend.wrongFlag")}</span></>}
            <span>{t("replay.legend.source")}</span><span>{t("replay.legend.target")}</span>
          </div>
        </div>
        <aside className="replay-explanation">
          <span className="panel-kicker">{t("replay.stepProgress", { current: selectedSeq + 1, total: result.steps.length })}</span>
          <h2>{t(VERDICT_MESSAGE_IDS[selectedExplanation.verdict])}</h2>
          <dl>
            <dt>{t("replay.what")}</dt><dd>{actionText(selectedAction, selectedSeq)}</dd>
            <dt>{t("replay.why")}</dt><dd>{reasonText()}</dd>
            <dt>{t("replay.betterMoves")}</dt><dd className="replay-suggestions">
              {renderSuggestions(visibleSuggestions.filter(({ action }) => action === "REVEAL"), "REVEAL")}
              {renderSuggestions(visibleSuggestions.filter(({ action }) => action === "UNFLAG_THEN_REVEAL"), "UNFLAG_THEN_REVEAL")}
              {renderSuggestions(visibleSuggestions.filter(({ action }) => action === "FLAG"), "FLAG")}
            </dd>
            <dt>{t("replay.truthReveal")}</dt><dd>{showTerminalTruth ? truthText() : t("replay.truth.hidden")}</dd>
          </dl>
          <details className="replay-technical-details">
            <summary>{t("replay.technicalDetails")}</summary>
            <dl>
              <dt>{t("replay.technical.status")}</dt><dd>{selectedStep
                ? t(ANALYSIS_STATUS_MESSAGE_IDS[selectedStep.before.status])
                : "—"}</dd>
              <dt>{t("replay.technical.rule")}</dt><dd>{selectedExplanation.targetProof
                ? t(PROOF_RULE_MESSAGE_IDS[selectedExplanation.targetProof.rule])
                : "—"}</dd>
              <dt>{t("replay.technical.proofs")}</dt><dd>{selectedStep?.before.proofs.length ?? 0}</dd>
              <dt>{t("replay.technical.nodes")}</dt><dd>{selectedStep?.before.searchedNodes ?? 0}</dd>
              <dt>{t("replay.technical.hash")}</dt><dd><code>{selectedStep?.before.stateHash}</code></dd>
            </dl>
          </details>
        </aside>
      </div>}
      <div className="replay-controls">
        <button type="button" onClick={() => selectStep(selectedSeq - 1)} disabled={selectedSeq === 0}>{t("replay.prev")}</button>
        <button type="button" onClick={() => selectStep(selectedSeq + 1)} disabled={selectedSeq >= result.steps.length - 1}>{t("replay.next")}</button>
        <button type="button" onClick={() => selectStep((moments.filter((moment) => moment.index < selectedSeq).at(-1)?.index) ?? 0)}>{t("replay.prevKey")}</button>
        <button type="button" onClick={() => selectStep((moments.find((moment) => moment.index > selectedSeq)?.index) ?? result.steps.length - 1)}>{t("replay.nextKey")}</button>
        <button type="button" onClick={() => setShowAfter((value) => !value)}>{t(showAfter ? "replay.showBefore" : "replay.showAfter")}</button>
        <button type="button" aria-pressed={showTerminalTruth} onClick={() => setShowTerminalTruth((value) => !value)}>{t(showTerminalTruth ? "replay.hideTruth" : "replay.showTruth")}</button>
        <button type="button" onClick={() => setTimelineExpanded((value) => !value)}>{t(timelineExpanded ? "replay.collapseTimeline" : "replay.expandTimeline")}</button>
      </div>
      {timelineExpanded && <ol className="replay-timeline">{result.steps.map((step, index) => {
        const action = replay?.actions[index];
        const explanation = explanations[index];
        if (!action || !explanation) return null;
        return <li key={step.seq}><button type="button" className={index === selectedSeq ? "is-active" : ""} onClick={() => selectStep(index)}>
          {t("replay.timelineSummary", {
            step: step.seq,
            action: actionText(action, index),
            verdict: t(VERDICT_MESSAGE_IDS[explanation.verdict]),
          })}
        </button></li>;
      })}</ol>}
      <section className="replay-moments" aria-labelledby="replay-moments-title">
        <h2 id="replay-moments-title">{t("replay.momentsTitle")}</h2>
        {moments.length === 0 ? <div className="replay-review-status">{t("replay.noError")}</div> :
          <div className="replay-moment-list">{moments.map((moment) => <article key={moment.seq}>
            <span>{t("replay.stepNumber", { step: moment.seq })}</span>
            <h3>{t(VERDICT_MESSAGE_IDS[moment.explanation.verdict])}</h3>
            <p>{actionText(moment.action, moment.index)}</p>
            <div className="replay-moment-actions">
              <button type="button" onClick={() => selectStep(moment.index)}>{t("replay.reviewThisStep")}</button>
              <a href={`#/academy/practice/${conceptForMoment(moment)}?mode=${record?.config.generationMode ?? "classic"}&width=${record?.config.width ?? 9}&height=${record?.config.height ?? 9}&mines=${record?.config.mines ?? 10}&verdict=${moment.explanation.verdict}`}>{t("replay.practice")}</a>
            </div>
          </article>)}</div>}
      </section>
    </>}
  </section>;
}
