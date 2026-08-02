import { describe, expect, it } from "vitest";
import {
  createSoloComboState,
  getSoloComboDeadlineMs,
  getSoloComboRemainingMs,
  getSoloComboTier,
  isSoloComboExpired,
  reduceSoloCombo,
} from "./solo-combo";

describe("solo safe streak", () => {
  it.each([2_999, 3_000])(
    "continues when the next safe reveal lands %dms later",
    (delayMs) => {
      const first = reduceSoloCombo(createSoloComboState(), {
        type: "ACTION",
        actor: "PLAYER",
        action: "REVEAL",
        accepted: true,
        safeCellsRevealed: 1,
        hitMine: false,
        atMs: 1_000,
      });

      const second = reduceSoloCombo(first, {
        type: "ACTION",
        actor: "PLAYER",
        action: "REVEAL",
        accepted: true,
        safeCellsRevealed: 1,
        hitMine: false,
        atMs: 1_000 + delayMs,
      });

      expect(second).toEqual({
        count: 2,
        lastIncrementAtMs: 1_000 + delayMs,
      });
    },
  );

  it("clears when a player's reveal is rejected", () => {
    const active = reduceSoloCombo(createSoloComboState(), {
      type: "ACTION",
      actor: "PLAYER",
      action: "REVEAL",
      accepted: true,
      safeCellsRevealed: 4,
      hitMine: false,
      atMs: 1_000,
    });

    const cleared = reduceSoloCombo(active, {
      type: "ACTION",
      actor: "PLAYER",
      action: "REVEAL",
      accepted: false,
      safeCellsRevealed: 0,
      hitMine: false,
      atMs: 1_200,
    });

    expect(cleared).toEqual(createSoloComboState());
  });

  it.each(["NEW_GAME", "EXIT_BOARD", "PAGE_HIDDEN"] as const)(
    "clears on %s",
    (reason) => {
      const active = { count: 7, lastIncrementAtMs: 5_000 };

      expect(
        reduceSoloCombo(active, { type: "RESET", reason }),
      ).toEqual(createSoloComboState());
    },
  );

  it("caps the visual tier at 12 without capping the streak count", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 11, 12, 99].map(getSoloComboTier)).toEqual([
      0, 0, 2, 2, 4, 4, 8, 8, 12, 12,
    ]);
  });

  it("restarts at one when the next safe action lands after 3 seconds", () => {
    const restarted = reduceSoloCombo(
      { count: 6, lastIncrementAtMs: 1_000 },
      {
        type: "ACTION",
        actor: "PLAYER",
        action: "REVEAL",
        accepted: true,
        safeCellsRevealed: 1,
        hitMine: false,
        atMs: 4_001,
      },
    );

    expect(restarted).toEqual({ count: 1, lastIncrementAtMs: 4_001 });
  });

  it("counts a flood reveal and a multi-cell chord as one action each", () => {
    const flood = reduceSoloCombo(createSoloComboState(), {
      type: "ACTION",
      actor: "PLAYER",
      action: "REVEAL",
      accepted: true,
      safeCellsRevealed: 23,
      hitMine: false,
      atMs: 1_000,
    });
    const chord = reduceSoloCombo(flood, {
      type: "ACTION",
      actor: "PLAYER",
      action: "CHORD",
      accepted: true,
      safeCellsRevealed: 5,
      hitMine: false,
      atMs: 1_100,
    });

    expect(chord).toEqual({ count: 2, lastIncrementAtMs: 1_100 });
  });

  it("does not let flag attempts clear or extend the streak", () => {
    const active = { count: 5, lastIncrementAtMs: 1_000 };
    const afterFlag = reduceSoloCombo(active, {
      type: "ACTION",
      actor: "PLAYER",
      action: "FLAG",
      accepted: true,
      safeCellsRevealed: 0,
      hitMine: false,
      atMs: 3_900,
    });
    const afterRejectedUnflag = reduceSoloCombo(afterFlag, {
      type: "ACTION",
      actor: "PLAYER",
      action: "UNFLAG",
      accepted: false,
      safeCellsRevealed: 0,
      hitMine: false,
      atMs: 3_999,
    });
    const nextReveal = reduceSoloCombo(afterRejectedUnflag, {
      type: "ACTION",
      actor: "PLAYER",
      action: "REVEAL",
      accepted: true,
      safeCellsRevealed: 1,
      hitMine: false,
      atMs: 4_001,
    });

    expect({ afterFlag, afterRejectedUnflag, nextReveal }).toEqual({
      afterFlag: active,
      afterRejectedUnflag: active,
      nextReveal: { count: 1, lastIncrementAtMs: 4_001 },
    });
  });

  it("does not let coach actions increment or extend a player streak", () => {
    const active = { count: 3, lastIncrementAtMs: 1_000 };
    const afterCoach = reduceSoloCombo(active, {
      type: "ACTION",
      actor: "COACH",
      action: "REVEAL",
      accepted: true,
      safeCellsRevealed: 7,
      hitMine: false,
      atMs: 3_000,
    });
    const nextPlayerAction = reduceSoloCombo(afterCoach, {
      type: "ACTION",
      actor: "PLAYER",
      action: "CHORD",
      accepted: true,
      safeCellsRevealed: 2,
      hitMine: false,
      atMs: 4_001,
    });

    expect({ afterCoach, nextPlayerAction }).toEqual({
      afterCoach: active,
      nextPlayerAction: { count: 1, lastIncrementAtMs: 4_001 },
    });
  });

  it.each([
    ["REVEAL", true, 0, false],
    ["CHORD", true, 0, false],
    ["CHORD", false, 0, false],
    ["REVEAL", true, 3, true],
  ] as const)(
    "clears after an invalid or mined %s action",
    (action, accepted, safeCellsRevealed, hitMine) => {
      expect(
        reduceSoloCombo(
          { count: 8, lastIncrementAtMs: 2_000 },
          {
            type: "ACTION",
            actor: "PLAYER",
            action,
            accepted,
            safeCellsRevealed,
            hitMine,
            atMs: 2_100,
          },
        ),
      ).toEqual(createSoloComboState());
    },
  );

  it("keeps the numeric streak unbounded", () => {
    expect(
      reduceSoloCombo(
        { count: 99, lastIncrementAtMs: 1_000 },
        {
          type: "ACTION",
          actor: "PLAYER",
          action: "REVEAL",
          accepted: true,
          safeCellsRevealed: 1,
          hitMine: false,
          atMs: 1_100,
        },
      ),
    ).toEqual({ count: 100, lastIncrementAtMs: 1_100 });
  });

  it("exposes an inclusive deadline for countdown rendering", () => {
    const active = { count: 4, lastIncrementAtMs: 1_000 };

    expect({
      deadline: getSoloComboDeadlineMs(active),
      remainingAtStart: getSoloComboRemainingMs(active, 1_000),
      remainingAtBoundary: getSoloComboRemainingMs(active, 4_000),
      expiredAtBoundary: isSoloComboExpired(active, 4_000),
      expiredAfterBoundary: isSoloComboExpired(active, 4_001),
    }).toEqual({
      deadline: 4_000,
      remainingAtStart: 3_000,
      remainingAtBoundary: 0,
      expiredAtBoundary: false,
      expiredAfterBoundary: true,
    });
  });

  it("only expires the streak after its inclusive deadline", () => {
    const active = { count: 4, lastIncrementAtMs: 1_000 };

    expect({
      atBoundary: reduceSoloCombo(active, { type: "EXPIRE", atMs: 4_000 }),
      afterBoundary: reduceSoloCombo(active, { type: "EXPIRE", atMs: 4_001 }),
    }).toEqual({
      atBoundary: active,
      afterBoundary: createSoloComboState(),
    });
  });
});
