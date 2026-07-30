import {
  CELL_FLAGGED,
  createBoard,
  createGameState,
} from "@h-minesweeper/game-core";
import { describe, expect, it } from "vitest";
import {
  SOLO_PRESETS,
  copyFlags,
  countFlags,
  createSoloBoardSpec,
  getSoloConfigError,
  type SoloBoardConfig,
} from "./solo";

describe("single-player board configuration", () => {
  it("publishes the three classic difficulties", () => {
    expect(SOLO_PRESETS).toEqual({
      beginner: { width: 9, height: 9, mines: 10 },
      intermediate: { width: 16, height: 16, mines: 40 },
      expert: { width: 30, height: 16, mines: 99 },
    });
  });

  it("validates custom density and no-guess bounds", () => {
    expect(
      getSoloConfigError({
        width: 100,
        height: 100,
        mines: 4_000,
        mode: "classic",
      }),
    ).toBeUndefined();
    expect(
      getSoloConfigError({
        width: 10,
        height: 10,
        mines: 41,
        mode: "classic",
      }),
    ).toMatch(/1–40/);
    expect(
      getSoloConfigError({
        width: 51,
        height: 20,
        mines: 100,
        mode: "no_guess",
      }),
    ).toMatch(/不能超过 50/);
  });

  it.each([
    ["corner", 0],
    ["edge", 15],
    ["center", 8 * 30 + 15],
  ])("protects a %s first click and its surrounding cells", (_, startIndex) => {
    const config: SoloBoardConfig = {
      ...SOLO_PRESETS.expert,
      mode: "classic",
    };
    const board = createBoard(
      createSoloBoardSpec(
        config,
        startIndex,
        `solo-safe-opening-${startIndex}`,
      ),
    );

    const startX = startIndex % config.width;
    const startY = Math.floor(startIndex / config.width);
    for (
      let y = Math.max(0, startY - 1);
      y <= Math.min(config.height - 1, startY + 1);
      y += 1
    ) {
      for (
        let x = Math.max(0, startX - 1);
        x <= Math.min(config.width - 1, startX + 1);
        x += 1
      ) {
        expect(board.mines[y * config.width + x]).toBe(0);
      }
    }
  });

  it("recreates an identical board from config, opening, and seed", () => {
    const config: SoloBoardConfig = {
      ...SOLO_PRESETS.intermediate,
      mode: "classic",
    };
    const first = createBoard(
      createSoloBoardSpec(config, 100, "solo-deterministic"),
    );
    const second = createBoard(
      createSoloBoardSpec(config, 100, "solo-deterministic"),
    );
    expect(first.mines).toEqual(second.mines);
    expect(first.adjacent).toEqual(second.adjacent);
  });

  it("copies pre-start flags without mutating unrelated cells", () => {
    const config: SoloBoardConfig = {
      ...SOLO_PRESETS.beginner,
      mode: "classic",
    };
    const first = createGameState(
      createBoard(createSoloBoardSpec(config, 40, "solo-copy-source")),
    );
    first.visibility[0] = CELL_FLAGGED;
    const second = createGameState(
      createBoard(createSoloBoardSpec(config, 40, "solo-copy-target")),
    );

    copyFlags(first, second);
    expect(countFlags(second)).toBe(1);
    expect(second.visibility[0]).toBe(CELL_FLAGGED);
    expect(
      Array.from(second.visibility).filter(
        (visibility) => visibility !== CELL_FLAGGED,
      ),
    ).toHaveLength(second.visibility.length - 1);
  });
});
