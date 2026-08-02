import { useEffect, useRef, useState } from "react";
import {
  CELL_FLAGGED,
  CELL_HIDDEN,
  CELL_REVEALED,
  chordCell,
  createBoard,
  createGameState,
  revealCell,
  toggleFlag,
  type GameState,
} from "@h-minesweeper/game-core";
import { useLocale, type MessageId } from "../i18n";

function createChordState(): GameState {
  const state = createGameState(createBoard({
    width: 5,
    height: 5,
    mines: 3,
    seed: "academy-chord-0",
    startIndex: 12,
    safeRadius: 1,
  }));
  // Language-neutral teaching fixture. Mine 5 remains for the learner to
  // infer; the two unrelated mines are already flagged. Safe cell 1 remains
  // covered so the player may reveal it directly or open it via clue 0.
  for (let index = 0; index < state.visibility.length; index += 1) {
    if (index === 1 || index === 5) continue;
    if (state.board.mines[index] === 1) state.visibility[index] = CELL_FLAGGED;
    else {
      state.visibility[index] = CELL_REVEALED;
      state.revealedSafeCount += 1;
    }
  }
  return state;
}

function transformedIndex(displayIndex: number, stageIndex: number): number {
  const x = displayIndex % 5;
  const y = Math.floor(displayIndex / 5);
  const variant = stageIndex % 4;
  if (variant === 1) return y * 5 + (4 - x);
  if (variant === 2) return (4 - y) * 5 + (4 - x);
  if (variant === 3) return (4 - x) * 5 + y;
  return displayIndex;
}

export function AcademyChordLesson({
  stageIndex,
  onComplete,
}: {
  readonly stageIndex: number;
  readonly onComplete: () => void;
}) {
  const { t } = useLocale();
  const stateRef = useRef(createChordState());
  const completedRef = useRef(false);
  const [revision, setRevision] = useState(0);
  const [feedbackId, setFeedbackId] = useState<MessageId>("academy.chord.start");

  const reset = () => {
    stateRef.current = createChordState();
    completedRef.current = false;
    setFeedbackId("academy.chord.start");
    setRevision((value) => value + 1);
  };
  useEffect(reset, [stageIndex]);

  const apply = (accepted: boolean, hitMine: boolean, action: "REVEAL" | "FLAG" | "CHORD") => {
    const state = stateRef.current;
    if (!accepted) setFeedbackId("academy.chord.unavailable");
    else if (hitMine) setFeedbackId("academy.chord.wrongFlagLoss");
    else if (state.outcome === "WON") {
      setFeedbackId(action === "CHORD" ? "academy.chord.completeExpand" : "academy.chord.completeDirect");
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete();
      }
    } else if (action === "FLAG") setFeedbackId("academy.chord.flagPlaced");
    else setFeedbackId("academy.chord.keepGoing");
    setRevision((value) => value + 1);
  };

  const activate = (index: number) => {
    const state = stateRef.current;
    if (state.outcome !== "PLAYING") return;
    if (state.visibility[index] === CELL_REVEALED) {
      const result = chordCell(state, index);
      apply(result.accepted, result.hitMine === true, "CHORD");
    } else {
      const result = revealCell(state, index);
      apply(result.accepted, result.hitMine === true, "REVEAL");
    }
  };

  const flag = (index: number) => {
    const state = stateRef.current;
    if (state.outcome !== "PLAYING" || state.visibility[index] === CELL_REVEALED) return;
    const result = toggleFlag(state, index);
    apply(result.accepted, false, "FLAG");
  };

  const state = stateRef.current;
  void revision;
  return <div className="academy-first-board-wrap">
    <p>{t("academy.chord.instructions")}</p>
    <div className="academy-first-board" role="grid" aria-label={t("academy.chord.aria")}>
      {Array.from({ length: 25 }, (_, displayIndex) => {
        const index = transformedIndex(displayIndex, stageIndex);
        const visibility = state.visibility[index];
        const clue = state.board.adjacent[index] ?? 0;
        const row = Math.floor(displayIndex / 5) + 1;
        const column = (displayIndex % 5) + 1;
        return <button
          type="button"
          role="gridcell"
          key={displayIndex}
          aria-label={visibility === CELL_REVEALED
            ? t(clue === 0 ? "academy.openBlankCell" : "academy.openNumberCell", { value: clue })
            : visibility === CELL_FLAGGED
              ? t("academy.firstBoard.flagged", { row, column })
              : t("academy.firstBoard.hidden", { row, column })}
          className={`academy-cell${visibility === CELL_REVEALED ? ` cell-open${clue === 0 ? " is-empty" : ` number-${clue}`}` : visibility === CELL_FLAGGED ? " cell-known-mine" : " cell-unknown"}`}
          onClick={() => activate(index)}
          onContextMenu={(event) => { event.preventDefault(); flag(index); }}
          onKeyDown={(event) => { if (event.key.toLowerCase() === "f") { event.preventDefault(); flag(index); } }}
        >{visibility === CELL_REVEALED ? (clue || "") : visibility === CELL_FLAGGED ? "⚑" : "?"}</button>;
      })}
    </div>
    <div className={`academy-feedback${state.outcome === "WON" ? " is-success" : ""}`} aria-live="polite"><p>{t(feedbackId)}</p></div>
    {state.outcome === "LOST" && <button className="secondary-button" type="button" onClick={reset}>{t("academy.chord.retry")}</button>}
  </div>;
}
