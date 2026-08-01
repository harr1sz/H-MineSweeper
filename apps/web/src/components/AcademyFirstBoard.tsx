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
import { useLocale } from "../i18n";
import { academySpecialMessage, type AcademySpecialMessageId } from "./academy-special-messages";

const FIRST_BOARD_SEEDS = [2, 3, 4, 6, 7] as const;

function createLessonState(stageIndex: number): GameState {
  return createGameState(createBoard({
    width: 5,
    height: 5,
    mines: 4,
    seed: `academy-first-${FIRST_BOARD_SEEDS[stageIndex] ?? FIRST_BOARD_SEEDS[0]}`,
    startIndex: 12,
    safeRadius: 1,
  }));
}

export function AcademyFirstBoard({
  stageIndex,
  onComplete,
}: {
  readonly stageIndex: number;
  readonly onComplete: () => void;
}) {
  const { locale, t } = useLocale();
  const gameRef = useRef(createLessonState(stageIndex));
  const completedRef = useRef(false);
  const [revision, setRevision] = useState(0);
  const [feedbackId, setFeedbackId] = useState<AcademySpecialMessageId>("firstBoard.start");

  const reset = () => {
    gameRef.current = createLessonState(stageIndex);
    completedRef.current = false;
    setFeedbackId("firstBoard.start");
    setRevision((value) => value + 1);
  };

  useEffect(reset, [stageIndex]);

  const applyResult = (accepted: boolean, hitMine: boolean) => {
    const game = gameRef.current;
    if (!accepted) {
      setFeedbackId("firstBoard.unavailable");
    } else if (hitMine) {
      setFeedbackId("firstBoard.hitMine");
    } else if (game.outcome === "WON") {
      setFeedbackId("firstBoard.complete");
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete();
      }
    } else {
      setFeedbackId("firstBoard.keepGoing");
    }
    setRevision((value) => value + 1);
  };

  const activate = (index: number) => {
    const game = gameRef.current;
    if (game.outcome !== "PLAYING") return;
    const visibility = game.visibility[index];
    const result = visibility === CELL_REVEALED
      ? chordCell(game, index)
      : revealCell(game, index);
    applyResult(result.accepted, result.hitMine === true);
  };

  const flag = (index: number) => {
    const game = gameRef.current;
    if (game.outcome !== "PLAYING" || game.visibility[index] === CELL_REVEALED) return;
    const result = toggleFlag(game, index);
    applyResult(result.accepted, false);
  };

  const game = gameRef.current;
  void revision;
  return <div className="academy-first-board-wrap">
    <p>{academySpecialMessage(locale, "firstBoard.instructions")}</p>
    <div className="academy-first-board" role="grid" aria-label={academySpecialMessage(locale, "firstBoard.aria")}>
      {Array.from(game.visibility, (visibility, index) => {
        const row = Math.floor(index / 5) + 1;
        const column = (index % 5) + 1;
        const clue = game.board.adjacent[index] ?? 0;
        const label = visibility === CELL_REVEALED
          ? t(clue === 0 ? "academy.openBlankCell" : "academy.openNumberCell", { value: clue })
          : visibility === CELL_FLAGGED
            ? academySpecialMessage(locale, "firstBoard.flagged", { row, column })
            : academySpecialMessage(locale, "firstBoard.hidden", { row, column });
        return <button
          type="button"
          role="gridcell"
          key={index}
          aria-label={label}
          className={`academy-cell${visibility === CELL_REVEALED ? ` cell-open${clue === 0 ? " is-empty" : ` number-${clue}`}` : visibility === CELL_FLAGGED ? " cell-known-mine" : " cell-unknown"}`}
          onClick={() => activate(index)}
          onContextMenu={(event) => { event.preventDefault(); flag(index); }}
          onKeyDown={(event) => { if (event.key.toLowerCase() === "f") { event.preventDefault(); flag(index); } }}
        >{visibility === CELL_REVEALED ? (clue || "") : visibility === CELL_FLAGGED ? "⚑" : "?"}</button>;
      })}
    </div>
    <div className={`academy-feedback${game.outcome === "WON" ? " is-success" : ""}`} aria-live="polite">
      <p>{academySpecialMessage(locale, feedbackId)}</p>
    </div>
    {game.outcome === "LOST" && <button className="secondary-button" type="button" onClick={reset}>{academySpecialMessage(locale, "firstBoard.retry")}</button>}
  </div>;
}
