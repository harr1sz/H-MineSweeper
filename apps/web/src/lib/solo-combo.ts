export const SOLO_COMBO_WINDOW_MS = 3_000;

export type SoloComboTier = 0 | 2 | 4 | 8 | 12;

export type SoloComboFeedbackKey =
  | "solo.combo.start"
  | "solo.combo.rhythm"
  | "solo.combo.clean"
  | "solo.combo.flow"
  | "solo.combo.sharp"
  | "solo.combo.rolling"
  | "solo.combo.strong"
  | "solo.combo.flying"
  | "solo.combo.high.1"
  | "solo.combo.high.2"
  | "solo.combo.high.3"
  | "solo.combo.high.4"
  | "solo.combo.high.5"
  | "solo.combo.high.6"
  | "solo.combo.high.7"
  | "solo.combo.high.8";

const HIGH_STREAK_FEEDBACK: readonly SoloComboFeedbackKey[] = [
  "solo.combo.high.1",
  "solo.combo.high.2",
  "solo.combo.high.3",
  "solo.combo.high.4",
  "solo.combo.high.5",
  "solo.combo.high.6",
  "solo.combo.high.7",
  "solo.combo.high.8",
];

export interface SoloComboState {
  readonly count: number;
  readonly lastIncrementAtMs: number | null;
}

export type SoloComboActor = "PLAYER" | "COACH";
export type SoloComboActionKind = "REVEAL" | "CHORD" | "FLAG" | "UNFLAG";

export type SoloComboResetReason =
  | "NEW_GAME"
  | "EXIT_BOARD"
  | "PAGE_HIDDEN";

export type SoloComboEvent =
  | {
      readonly type: "ACTION";
      readonly actor: SoloComboActor;
      readonly action: SoloComboActionKind;
      readonly accepted: boolean;
      readonly safeCellsRevealed: number;
      readonly hitMine: boolean;
      readonly atMs: number;
    }
  | {
      readonly type: "RESET";
      readonly reason: SoloComboResetReason;
    }
  | {
      readonly type: "EXPIRE";
      readonly atMs: number;
    };

export function createSoloComboState(): SoloComboState {
  return { count: 0, lastIncrementAtMs: null };
}

export function getSoloComboTier(count: number): SoloComboTier {
  if (count >= 12) return 12;
  if (count >= 8) return 8;
  if (count >= 4) return 4;
  if (count >= 2) return 2;
  return 0;
}

export function getSoloComboFeedbackKey(count: number): SoloComboFeedbackKey {
  if (count >= 12) {
    return HIGH_STREAK_FEEDBACK[(count - 12) % HIGH_STREAK_FEEDBACK.length]!;
  }
  if (count >= 11) return "solo.combo.flying";
  if (count >= 10) return "solo.combo.strong";
  if (count >= 9) return "solo.combo.rolling";
  if (count >= 8) return "solo.combo.sharp";
  if (count >= 7) return "solo.combo.flow";
  if (count >= 6) return "solo.combo.clean";
  if (count >= 4) return "solo.combo.rhythm";
  return "solo.combo.start";
}

export function getSoloComboDeadlineMs(
  state: SoloComboState,
): number | null {
  if (state.lastIncrementAtMs === null) return null;
  return state.lastIncrementAtMs + SOLO_COMBO_WINDOW_MS;
}

export function getSoloComboRemainingMs(
  state: SoloComboState,
  atMs: number,
): number {
  const deadline = getSoloComboDeadlineMs(state);
  if (deadline === null) return 0;
  return Math.max(0, deadline - atMs);
}

export function isSoloComboExpired(
  state: SoloComboState,
  atMs: number,
): boolean {
  const deadline = getSoloComboDeadlineMs(state);
  return deadline !== null && atMs > deadline;
}

export function reduceSoloCombo(
  state: SoloComboState,
  event: SoloComboEvent,
): SoloComboState {
  if (event.type === "RESET") {
    return createSoloComboState();
  }
  if (event.type === "EXPIRE") {
    return isSoloComboExpired(state, event.atMs)
      ? createSoloComboState()
      : state;
  }

  if (
    event.actor === "COACH" ||
    event.action === "FLAG" ||
    event.action === "UNFLAG"
  ) {
    return state;
  }

  if (event.hitMine) {
    return createSoloComboState();
  }
  if (!event.accepted || event.safeCellsRevealed < 1) return state;

  const continues =
    state.lastIncrementAtMs !== null &&
    event.atMs - state.lastIncrementAtMs <= SOLO_COMBO_WINDOW_MS;

  return {
    count: continues ? state.count + 1 : 1,
    lastIncrementAtMs: event.atMs,
  };
}
