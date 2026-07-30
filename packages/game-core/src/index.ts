/**
 * Deterministic, dependency-free Minesweeper rules shared by browser and server.
 *
 * All cell collections use row-major indexes (`y * width + x`). Game actions
 * mutate the supplied state in place and return the exact authoritative delta.
 */

export const PROTOCOL_VERSION = 1 as const;
export const THREE_BV_RULES_VERSION = "HMS-3BV-v1" as const;
export const CLICK_COUNTING_RULES_VERSION =
  "HMS-board-action-counting-v1" as const;
export const STATISTICS_RULES_VERSION = "HMS-statistics-v1" as const;
export const METRIC_RULES_VERSION = STATISTICS_RULES_VERSION;

export const CELL_HIDDEN = 0 as const;
export const CELL_REVEALED = 1 as const;
export const CELL_FLAGGED = 2 as const;

export type CellVisibility =
  | typeof CELL_HIDDEN
  | typeof CELL_REVEALED
  | typeof CELL_FLAGGED;

export type GameOutcome = "PLAYING" | "WON" | "LOST";

export interface BoardSpec {
  readonly width: number;
  readonly height: number;
  readonly mines: number;
  readonly seed: string;
  readonly startIndex: number;
  readonly safeRadius: number;
}

/** Board metadata safe to disclose before a server-secret ranked round. */
export interface PublicBoardSpec
  extends Omit<BoardSpec, "seed"> {
  readonly seedCommitment: string;
}

export interface BoardPreset {
  readonly width: number;
  readonly height: number;
  readonly mines: number;
  readonly safeRadius: number;
}

export const PRESET_SPECS = Object.freeze({
  beginner: Object.freeze({
    width: 9,
    height: 9,
    mines: 10,
    safeRadius: 1,
  }),
  intermediate: Object.freeze({
    width: 16,
    height: 16,
    mines: 40,
    safeRadius: 1,
  }),
  expert: Object.freeze({
    width: 30,
    height: 16,
    mines: 99,
    safeRadius: 1,
  }),
}) satisfies Readonly<Record<string, BoardPreset>>;

/**
 * Stable prototype seed identifiers. The generator version is deliberately
 * encoded so a later generator can coexist without silently changing boards.
 */
export const PROTOTYPE_EXPERT_SEEDS = Object.freeze([
  "hms-phase0-ng-v1-00035",
  "hms-phase0-ng-v1-00076",
  "hms-phase0-ng-v1-00093",
  "hms-phase0-ng-v1-00102",
  "hms-phase0-ng-v1-00151",
  "hms-phase0-ng-v1-00207",
  "hms-phase0-ng-v1-00216",
  "hms-phase0-ng-v1-00275",
  "hms-phase0-ng-v1-00293",
  "hms-phase0-ng-v1-00304",
  "hms-phase0-ng-v1-00327",
  "hms-phase0-ng-v1-00339",
  "hms-phase0-ng-v1-00362",
  "hms-phase0-ng-v1-00366",
  "hms-phase0-ng-v1-00380",
  "hms-phase0-ng-v1-00383",
  "hms-phase0-ng-v1-00433",
  "hms-phase0-ng-v1-00438",
  "hms-phase0-ng-v1-00459",
  "hms-phase0-ng-v1-00498",
  "hms-phase0-ng-v1-00503",
  "hms-phase0-ng-v1-00595",
  "hms-phase0-ng-v1-00601",
  "hms-phase0-ng-v1-00637",
  "hms-phase0-ng-v1-00638",
  "hms-phase0-ng-v1-00640",
  "hms-phase0-ng-v1-00699",
  "hms-phase0-ng-v1-00736",
  "hms-phase0-ng-v1-00771",
  "hms-phase0-ng-v1-00782",
  "hms-phase0-ng-v1-00791",
  "hms-phase0-ng-v1-00820",
] as const);

export interface Board {
  readonly spec: Readonly<BoardSpec>;
  readonly mines: Uint8Array;
  readonly adjacent: Uint8Array;
}

export interface ThreeBVResult {
  readonly rulesVersion: typeof THREE_BV_RULES_VERSION;
  readonly value: number;
  readonly openings: number;
  readonly isolatedNumbers: number;
}

/**
 * Player-submitted board actions counted by the v1 statistics rules.
 *
 * READY, REMATCH, generated zero expansion and training assistance are not
 * board actions and must not be supplied here. Every submitted attempt counts
 * as one semantic action, including rejected/wasted attempts. Physical input
 * activations are tracked separately because one chord may use two buttons.
 */
export type CountedBoardActionType =
  | "REVEAL"
  | "TOGGLE_FLAG"
  | "CHORD";

export interface CountedBoardAction {
  readonly actionType: CountedBoardActionType;
  readonly accepted: boolean;
  /**
   * Counted hardware activations for desktop CPS and IOE. A two-button chord
   * can therefore contribute two physical clicks while remaining one semantic
   * action. Omit for the common one-click/one-key action.
   */
  readonly physicalClicks?: number;
  /**
   * Resulting flag state for an accepted TOGGLE_FLAG. Supplying it enables the
   * flag-placement/removal split without exposing or validating mine truth.
   */
  readonly flagged?: boolean;
}

export interface ActionCountBreakdown {
  readonly rulesVersion: typeof CLICK_COUNTING_RULES_VERSION;
  /** Compatibility name for the physical-click denominator. */
  readonly countedClicks: number;
  readonly physicalClicks: number;
  readonly semanticActions: number;
  readonly acceptedActions: number;
  readonly wastedActions: number;
  /** Compatibility name for wastedActions. */
  readonly rejectedActions: number;
  readonly reveals: number;
  readonly flagToggles: number;
  /** Accepted flag toggles whose resulting state is flagged. */
  readonly flags: number;
  /** Accepted flag toggles whose resulting state is unflagged. */
  readonly unflags: number;
  readonly chords: number;
}

export interface GameStatisticsInput {
  readonly board: Board;
  /** Authoritative active-play duration. Pauses must be removed by the caller. */
  readonly elapsedMs: number;
  readonly actions: readonly CountedBoardAction[];
}

/** Stable, persistence-safe metric fields required by result records. */
export interface GameMetricSummary {
  readonly metricRulesVersion: typeof METRIC_RULES_VERSION;
  readonly elapsedMs: number;
  readonly board3BV: number;
  readonly cps: number | null;
  readonly threeBvPerSecond: number | null;
  readonly ioe: number | null;
  readonly physicalClicks: number;
  readonly semanticActions: number;
  readonly acceptedActions: number;
  readonly wastedActions: number;
}

/**
 * Detailed metric result. The nested diagnostic fields and legacy casing are
 * retained so existing callers can migrate to GameMetricSummary incrementally.
 */
export interface GameStatistics extends GameMetricSummary {
  readonly rulesVersion: typeof STATISTICS_RULES_VERSION;
  readonly threeBV: ThreeBVResult;
  readonly actions: ActionCountBreakdown;
  readonly efficiencyPercent: number | null;
  /** Compatibility casing for threeBvPerSecond. */
  readonly threeBVPerSecond: number | null;
}

export interface GameState {
  readonly board: Board;
  readonly visibility: Uint8Array;
  revealedSafeCount: number;
  outcome: GameOutcome;
}

export interface RevealedCell {
  readonly index: number;
  /** `-1` denotes a mine; safe values are in the inclusive range 0..8. */
  readonly value: number;
}

export interface FlagDelta {
  readonly index: number;
  readonly flagged: boolean;
}

export type ActionRejectReason =
  | "INVALID_INDEX"
  | "GAME_OVER"
  | "ALREADY_REVEALED"
  | "FLAGGED"
  | "NOT_REVEALED"
  | "NOT_NUMBER"
  | "FLAG_COUNT_MISMATCH"
  | "NO_HIDDEN_NEIGHBORS";

export interface RevealDelta {
  readonly accepted: boolean;
  readonly rejectReason?: ActionRejectReason;
  readonly revealed: RevealedCell[];
  readonly flagged?: FlagDelta;
  readonly hitMine?: boolean;
  readonly completed?: boolean;
  readonly progress: number;
  readonly stateHash: string;
}

export interface RandomSource {
  nextUint32(): number;
  nextFloat(): number;
  nextInt(maxExclusive: number): number;
}

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

/**
 * Expands a UTF-16 JavaScript string into four non-zero 32-bit words.
 * This is a stable seed mixer, not a cryptographic hash.
 */
export function seedToXoshiroState(seed: string): readonly [
  number,
  number,
  number,
  number,
] {
  let h1 = 0x6a09e667;
  let h2 = 0xbb67ae85;
  let h3 = 0x3c6ef372;
  let h4 = 0xa54ff53a;

  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x85ebca6b);
    h2 = Math.imul(h2 ^ code, 0xc2b2ae35);
    h3 = Math.imul(h3 ^ code, 0x27d4eb2f);
    h4 = Math.imul(h4 ^ code, 0x165667b1);
    h1 = rotateLeft(h1, 13);
    h2 = rotateLeft(h2, 17);
    h3 = rotateLeft(h3, 19);
    h4 = rotateLeft(h4, 23);
  }

  h1 = (h1 ^ seed.length ^ (h3 >>> 1)) >>> 0;
  h2 = (h2 ^ Math.imul(seed.length, 0x9e3779b1) ^ (h4 >>> 1)) >>> 0;
  h3 = (h3 ^ h1 ^ 0x243f6a88) >>> 0;
  h4 = (h4 ^ h2 ^ 0xb7e15162) >>> 0;

  if ((h1 | h2 | h3 | h4) === 0) {
    h4 = 1;
  }

  return [h1, h2, h3, h4];
}

/** xoshiro128** 1.1 with deterministic string seeding. */
export function createXoshiro128StarStar(seed: string): RandomSource {
  const initial = seedToXoshiroState(seed);
  let s0 = initial[0];
  let s1 = initial[1];
  let s2 = initial[2];
  let s3 = initial[3];

  const nextUint32 = (): number => {
    const result = Math.imul(rotateLeft(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotateLeft(s3, 11);

    return result;
  };

  return {
    nextUint32,
    nextFloat(): number {
      return nextUint32() / 0x1_0000_0000;
    },
    nextInt(maxExclusive: number): number {
      if (
        !Number.isSafeInteger(maxExclusive) ||
        maxExclusive <= 0 ||
        maxExclusive > 0x1_0000_0000
      ) {
        throw new RangeError(
          "maxExclusive must be an integer between 1 and 2^32",
        );
      }

      const limit =
        0x1_0000_0000 -
        (0x1_0000_0000 % maxExclusive);
      let value = nextUint32();
      while (value >= limit) {
        value = nextUint32();
      }
      return value % maxExclusive;
    },
  };
}

/** In-place unbiased Fisher-Yates shuffle. */
export function fisherYatesShuffle<T>(
  values: T[],
  random: RandomSource,
): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = random.nextInt(index + 1);
    const current = values[index];
    const swap = values[swapIndex];
    if (current === undefined || swap === undefined) {
      throw new RangeError("Cannot shuffle a sparse array");
    }
    values[index] = swap;
    values[swapIndex] = current;
  }
  return values;
}

export function getBoardSpecValidationErrors(
  spec: BoardSpec,
): readonly string[] {
  const errors: string[] = [];
  const { width, height, mines, seed, startIndex, safeRadius } = spec;
  const cellCount = width * height;

  if (!Number.isSafeInteger(width) || width < 5 || width > 100) {
    errors.push("width must be an integer between 5 and 100");
  }
  if (!Number.isSafeInteger(height) || height < 5 || height > 100) {
    errors.push("height must be an integer between 5 and 100");
  }
  if (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    cellCount > 10_000
  ) {
    errors.push("board area must not exceed 10,000 cells");
  }
  if (typeof seed !== "string" || seed.length === 0 || seed.length > 256) {
    errors.push("seed must be a non-empty string of at most 256 characters");
  }
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isSafeInteger(cellCount) ||
    startIndex >= cellCount
  ) {
    errors.push("startIndex must point to a cell inside the board");
  }
  if (
    !Number.isSafeInteger(safeRadius) ||
    safeRadius < 0 ||
    safeRadius > 10
  ) {
    errors.push("safeRadius must be an integer between 0 and 10");
  }
  if (!Number.isSafeInteger(mines) || mines < 1) {
    errors.push("mines must be a positive integer");
  } else if (Number.isSafeInteger(cellCount) && mines > Math.floor(cellCount * 0.4)) {
    errors.push("mines must not exceed 40% of the board");
  }

  if (
    errors.length === 0 ||
    (Number.isSafeInteger(width) &&
      width >= 5 &&
      width <= 100 &&
      Number.isSafeInteger(height) &&
      height >= 5 &&
      height <= 100 &&
      Number.isSafeInteger(startIndex) &&
      startIndex >= 0 &&
      startIndex < cellCount &&
      Number.isSafeInteger(safeRadius) &&
      safeRadius >= 0)
  ) {
    const startX = startIndex % width;
    const startY = Math.floor(startIndex / width);
    const minX = Math.max(0, startX - safeRadius);
    const maxX = Math.min(width - 1, startX + safeRadius);
    const minY = Math.max(0, startY - safeRadius);
    const maxY = Math.min(height - 1, startY + safeRadius);
    const protectedCells = (maxX - minX + 1) * (maxY - minY + 1);
    if (Number.isSafeInteger(mines) && mines > cellCount - protectedCells) {
      errors.push("mines do not fit outside the protected start area");
    }
  }

  return errors;
}

export function validateBoardSpec(spec: BoardSpec): boolean {
  return getBoardSpecValidationErrors(spec).length === 0;
}

function assertValidBoardSpec(spec: BoardSpec): void {
  const errors = getBoardSpecValidationErrors(spec);
  if (errors.length > 0) {
    throw new RangeError(`Invalid board spec: ${errors.join("; ")}`);
  }
}

export function getNeighborIndices(
  width: number,
  height: number,
  index: number,
): number[] {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= width * height
  ) {
    return [];
  }

  const x = index % width;
  const y = Math.floor(index / width);
  const neighbors: number[] = [];

  for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1); neighborY += 1) {
    for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX += 1) {
      if (neighborX === x && neighborY === y) {
        continue;
      }
      neighbors.push(neighborY * width + neighborX);
    }
  }

  return neighbors;
}

export function createBoard(spec: BoardSpec): Board {
  assertValidBoardSpec(spec);

  const frozenSpec = Object.freeze({ ...spec });
  const cellCount = spec.width * spec.height;
  const mines = new Uint8Array(cellCount);
  const adjacent = new Uint8Array(cellCount);
  const candidates: number[] = [];
  const startX = spec.startIndex % spec.width;
  const startY = Math.floor(spec.startIndex / spec.width);

  for (let index = 0; index < cellCount; index += 1) {
    const x = index % spec.width;
    const y = Math.floor(index / spec.width);
    const protectedFromMine =
      Math.abs(x - startX) <= spec.safeRadius &&
      Math.abs(y - startY) <= spec.safeRadius;
    if (!protectedFromMine) {
      candidates.push(index);
    }
  }

  fisherYatesShuffle(candidates, createXoshiro128StarStar(spec.seed));
  for (let mineNumber = 0; mineNumber < spec.mines; mineNumber += 1) {
    const mineIndex = candidates[mineNumber];
    if (mineIndex === undefined) {
      throw new RangeError("Not enough mine candidates for board spec");
    }
    mines[mineIndex] = 1;
  }

  for (let index = 0; index < cellCount; index += 1) {
    if (mines[index] !== 1) {
      continue;
    }
    for (const neighbor of getNeighborIndices(spec.width, spec.height, index)) {
      adjacent[neighbor] = (adjacent[neighbor] ?? 0) + 1;
    }
  }

  return { spec: frozenSpec, mines, adjacent };
}

/**
 * Computes Bechtel's Board Benchmark Value using the HMS-3BV-v1 rules.
 *
 * Each eight-connected zero opening counts once. Numbered safe cells exposed
 * by any opening are covered by that opening; every remaining numbered safe
 * cell counts once. Mines never contribute.
 */
export function calculate3BV(board: Board): ThreeBVResult {
  const { width, height } = board.spec;
  const cellCount = width * height;
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    board.mines.length !== cellCount ||
    board.adjacent.length !== cellCount
  ) {
    throw new RangeError("Invalid board shape for 3BV calculation");
  }

  const visitedZeros = new Uint8Array(cellCount);
  const coveredByOpening = new Uint8Array(cellCount);
  let openings = 0;

  for (let index = 0; index < cellCount; index += 1) {
    if (
      board.mines[index] === 1 ||
      board.adjacent[index] !== 0 ||
      visitedZeros[index] === 1
    ) {
      continue;
    }

    openings += 1;
    const queue: number[] = [index];
    let head = 0;
    visitedZeros[index] = 1;

    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      if (current === undefined) {
        continue;
      }
      coveredByOpening[current] = 1;

      for (const neighbor of getNeighborIndices(width, height, current)) {
        if (board.mines[neighbor] === 1) {
          continue;
        }
        coveredByOpening[neighbor] = 1;
        if (
          board.adjacent[neighbor] === 0 &&
          visitedZeros[neighbor] === 0
        ) {
          visitedZeros[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
  }

  let isolatedNumbers = 0;
  for (let index = 0; index < cellCount; index += 1) {
    if (
      board.mines[index] !== 1 &&
      board.adjacent[index] !== 0 &&
      coveredByOpening[index] === 0
    ) {
      isolatedNumbers += 1;
    }
  }

  return {
    rulesVersion: THREE_BV_RULES_VERSION,
    value: openings + isolatedNumbers,
    openings,
    isolatedNumbers,
  };
}

export function countBoardActions(
  actions: readonly CountedBoardAction[],
): ActionCountBreakdown {
  let physicalClicks = 0;
  let acceptedActions = 0;
  let rejectedActions = 0;
  let reveals = 0;
  let flagToggles = 0;
  let flags = 0;
  let unflags = 0;
  let chords = 0;

  for (const action of actions) {
    if (
      action === null ||
      typeof action !== "object" ||
      typeof action.accepted !== "boolean"
    ) {
      throw new TypeError("Each counted action must have a boolean accepted");
    }

    const actionPhysicalClicks = action.physicalClicks ?? 1;
    if (
      !Number.isSafeInteger(actionPhysicalClicks) ||
      actionPhysicalClicks <= 0
    ) {
      throw new RangeError(
        "physicalClicks must be a positive safe integer",
      );
    }
    physicalClicks += actionPhysicalClicks;
    if (!Number.isSafeInteger(physicalClicks)) {
      throw new RangeError("physicalClicks total exceeds safe integer range");
    }

    if (action.accepted === true) {
      acceptedActions += 1;
    } else {
      rejectedActions += 1;
    }

    switch (action.actionType) {
      case "REVEAL":
        reveals += 1;
        break;
      case "TOGGLE_FLAG":
        flagToggles += 1;
        if (
          action.flagged !== undefined &&
          typeof action.flagged !== "boolean"
        ) {
          throw new TypeError("flagged must be a boolean when supplied");
        }
        if (action.accepted && action.flagged === true) {
          flags += 1;
        } else if (action.accepted && action.flagged === false) {
          unflags += 1;
        }
        break;
      case "CHORD":
        chords += 1;
        break;
      default:
        throw new RangeError(
          `Unsupported counted action type: ${String(action.actionType)}`,
        );
    }
  }

  return {
    rulesVersion: CLICK_COUNTING_RULES_VERSION,
    countedClicks: physicalClicks,
    physicalClicks,
    semanticActions: actions.length,
    acceptedActions,
    wastedActions: rejectedActions,
    rejectedActions,
    reveals,
    flagToggles,
    flags,
    unflags,
    chords,
  };
}

function assertNonNegativeIntegerMetric(
  value: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertNonNegativeDuration(elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("elapsedMs must be a non-negative finite number");
  }
}

export function calculateCPS(
  countedClicks: number,
  elapsedMs: number,
): number | null {
  assertNonNegativeIntegerMetric(countedClicks, "countedClicks");
  assertNonNegativeDuration(elapsedMs);
  return elapsedMs === 0
    ? null
    : countedClicks / (elapsedMs / 1_000);
}

export function calculateIOE(
  threeBV: number,
  countedClicks: number,
): number | null {
  assertNonNegativeIntegerMetric(threeBV, "threeBV");
  assertNonNegativeIntegerMetric(countedClicks, "countedClicks");
  return countedClicks === 0 ? null : threeBV / countedClicks;
}

export function calculate3BVPerSecond(
  threeBV: number,
  elapsedMs: number,
): number | null {
  assertNonNegativeIntegerMetric(threeBV, "threeBV");
  assertNonNegativeDuration(elapsedMs);
  return elapsedMs === 0
    ? null
    : threeBV / (elapsedMs / 1_000);
}

export function calculateGameStatistics(
  input: GameStatisticsInput,
): GameStatistics {
  assertNonNegativeDuration(input.elapsedMs);
  const threeBV = calculate3BV(input.board);
  const actions = countBoardActions(input.actions);
  const ioe = calculateIOE(threeBV.value, actions.countedClicks);
  const threeBvPerSecond = calculate3BVPerSecond(
    threeBV.value,
    input.elapsedMs,
  );

  return {
    metricRulesVersion: METRIC_RULES_VERSION,
    rulesVersion: STATISTICS_RULES_VERSION,
    threeBV,
    elapsedMs: input.elapsedMs,
    board3BV: threeBV.value,
    actions,
    cps: calculateCPS(actions.countedClicks, input.elapsedMs),
    ioe,
    efficiencyPercent: ioe === null ? null : ioe * 100,
    threeBvPerSecond,
    threeBVPerSecond: threeBvPerSecond,
    physicalClicks: actions.physicalClicks,
    semanticActions: actions.semanticActions,
    acceptedActions: actions.acceptedActions,
    wastedActions: actions.wastedActions,
  };
}

export function calculateGameMetrics(
  input: GameStatisticsInput,
): GameMetricSummary {
  const statistics = calculateGameStatistics(input);
  return {
    metricRulesVersion: statistics.metricRulesVersion,
    elapsedMs: statistics.elapsedMs,
    board3BV: statistics.board3BV,
    cps: statistics.cps,
    threeBvPerSecond: statistics.threeBvPerSecond,
    ioe: statistics.ioe,
    physicalClicks: statistics.physicalClicks,
    semanticActions: statistics.semanticActions,
    acceptedActions: statistics.acceptedActions,
    wastedActions: statistics.wastedActions,
  };
}

export function createGameState(board: Board): GameState {
  return {
    board,
    visibility: new Uint8Array(board.spec.width * board.spec.height),
    revealedSafeCount: 0,
    outcome: "PLAYING",
  };
}

function isValidCellIndex(state: GameState, index: number): boolean {
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < state.visibility.length
  );
}

export function getProgress(state: GameState): number {
  const safeCellCount =
    state.board.spec.width * state.board.spec.height - state.board.spec.mines;
  return safeCellCount === 0
    ? 1
    : Math.min(1, state.revealedSafeCount / safeCellCount);
}

interface MutableHash {
  first: number;
  second: number;
}

function hashByte(hash: MutableHash, value: number): void {
  const byte = value & 0xff;
  hash.first = Math.imul(hash.first ^ byte, 0x01000193) >>> 0;
  hash.second = Math.imul(hash.second ^ byte, 0x85ebca6b) >>> 0;
  hash.second = rotateLeft(hash.second, 13);
}

function hashUint32(hash: MutableHash, value: number): void {
  const normalized = value >>> 0;
  hashByte(hash, normalized);
  hashByte(hash, normalized >>> 8);
  hashByte(hash, normalized >>> 16);
  hashByte(hash, normalized >>> 24);
}

function hashString(hash: MutableHash, value: string): void {
  hashUint32(hash, value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hashByte(hash, code);
    hashByte(hash, code >>> 8);
  }
}

function createHash(): MutableHash {
  return { first: 0x811c9dc5, second: 0x9e3779b9 };
}

function finishHash(hash: MutableHash): string {
  const first = hash.first.toString(16).padStart(8, "0");
  const second = hash.second.toString(16).padStart(8, "0");
  return `${first}${second}`;
}

export function hashBoard(board: Board): string {
  const hash = createHash();
  const { spec } = board;
  hashString(hash, "HMSP-BOARD-v1");
  hashUint32(hash, spec.width);
  hashUint32(hash, spec.height);
  hashUint32(hash, spec.mines);
  hashString(hash, spec.seed);
  hashUint32(hash, spec.startIndex);
  hashUint32(hash, spec.safeRadius);
  for (const value of board.mines) {
    hashByte(hash, value);
  }
  for (const value of board.adjacent) {
    hashByte(hash, value);
  }
  return finishHash(hash);
}

export function hashGameState(state: GameState): string {
  const hash = createHash();
  hashString(hash, "HMSP-STATE-v1");
  hashString(hash, hashBoard(state.board));
  for (const value of state.visibility) {
    hashByte(hash, value);
  }
  hashUint32(hash, state.revealedSafeCount);
  hashByte(
    hash,
    state.outcome === "PLAYING" ? 0 : state.outcome === "WON" ? 1 : 2,
  );
  return finishHash(hash);
}

function rejectedDelta(
  state: GameState,
  rejectReason: ActionRejectReason,
): RevealDelta {
  return {
    accepted: false,
    rejectReason,
    revealed: [],
    progress: getProgress(state),
    stateHash: hashGameState(state),
  };
}

function revealSafeRegion(
  state: GameState,
  startIndex: number,
  revealed: RevealedCell[],
): void {
  const { board, visibility } = state;
  const queue: number[] = [startIndex];
  let head = 0;

  visibility[startIndex] = CELL_REVEALED;
  state.revealedSafeCount += 1;
  revealed.push({
    index: startIndex,
    value: board.adjacent[startIndex] ?? 0,
  });

  while (head < queue.length) {
    const index = queue[head];
    head += 1;
    if (index === undefined || board.adjacent[index] !== 0) {
      continue;
    }

    for (const neighbor of getNeighborIndices(
      board.spec.width,
      board.spec.height,
      index,
    )) {
      if (
        visibility[neighbor] !== CELL_HIDDEN ||
        board.mines[neighbor] === 1
      ) {
        continue;
      }

      visibility[neighbor] = CELL_REVEALED;
      state.revealedSafeCount += 1;
      const value = board.adjacent[neighbor] ?? 0;
      revealed.push({ index: neighbor, value });
      if (value === 0) {
        queue.push(neighbor);
      }
    }
  }
}

function completedSafeBoard(state: GameState): boolean {
  return (
    state.revealedSafeCount ===
    state.visibility.length - state.board.spec.mines
  );
}

export function revealCell(state: GameState, index: number): RevealDelta {
  if (!isValidCellIndex(state, index)) {
    return rejectedDelta(state, "INVALID_INDEX");
  }
  if (state.outcome !== "PLAYING") {
    return rejectedDelta(state, "GAME_OVER");
  }
  if (state.visibility[index] === CELL_REVEALED) {
    return rejectedDelta(state, "ALREADY_REVEALED");
  }
  if (state.visibility[index] === CELL_FLAGGED) {
    return rejectedDelta(state, "FLAGGED");
  }

  const revealed: RevealedCell[] = [];
  if (state.board.mines[index] === 1) {
    state.visibility[index] = CELL_REVEALED;
    state.outcome = "LOST";
    revealed.push({ index, value: -1 });
    return {
      accepted: true,
      revealed,
      hitMine: true,
      progress: getProgress(state),
      stateHash: hashGameState(state),
    };
  }

  revealSafeRegion(state, index, revealed);
  const completed = completedSafeBoard(state);
  if (completed) {
    state.outcome = "WON";
  }

  return {
    accepted: true,
    revealed,
    ...(completed ? { completed: true } : {}),
    progress: getProgress(state),
    stateHash: hashGameState(state),
  };
}

export function toggleFlag(state: GameState, index: number): RevealDelta {
  if (!isValidCellIndex(state, index)) {
    return rejectedDelta(state, "INVALID_INDEX");
  }
  if (state.outcome !== "PLAYING") {
    return rejectedDelta(state, "GAME_OVER");
  }
  if (state.visibility[index] === CELL_REVEALED) {
    return rejectedDelta(state, "ALREADY_REVEALED");
  }

  const flagged = state.visibility[index] !== CELL_FLAGGED;
  state.visibility[index] = flagged ? CELL_FLAGGED : CELL_HIDDEN;
  return {
    accepted: true,
    revealed: [],
    flagged: { index, flagged },
    progress: getProgress(state),
    stateHash: hashGameState(state),
  };
}

export function chordCell(state: GameState, index: number): RevealDelta {
  if (!isValidCellIndex(state, index)) {
    return rejectedDelta(state, "INVALID_INDEX");
  }
  if (state.outcome !== "PLAYING") {
    return rejectedDelta(state, "GAME_OVER");
  }
  if (state.visibility[index] !== CELL_REVEALED) {
    return rejectedDelta(state, "NOT_REVEALED");
  }

  const requiredFlags = state.board.adjacent[index] ?? 0;
  if (requiredFlags === 0) {
    return rejectedDelta(state, "NOT_NUMBER");
  }

  const neighbors = getNeighborIndices(
    state.board.spec.width,
    state.board.spec.height,
    index,
  );
  let flagCount = 0;
  const hiddenNeighbors: number[] = [];

  for (const neighbor of neighbors) {
    if (state.visibility[neighbor] === CELL_FLAGGED) {
      flagCount += 1;
    } else if (state.visibility[neighbor] === CELL_HIDDEN) {
      hiddenNeighbors.push(neighbor);
    }
  }

  if (flagCount !== requiredFlags) {
    return rejectedDelta(state, "FLAG_COUNT_MISMATCH");
  }
  if (hiddenNeighbors.length === 0) {
    return rejectedDelta(state, "NO_HIDDEN_NEIGHBORS");
  }

  const revealed: RevealedCell[] = [];
  let hitMine = false;
  for (const neighbor of hiddenNeighbors) {
    if (state.visibility[neighbor] !== CELL_HIDDEN) {
      continue;
    }
    if (state.board.mines[neighbor] === 1) {
      state.visibility[neighbor] = CELL_REVEALED;
      state.outcome = "LOST";
      revealed.push({ index: neighbor, value: -1 });
      hitMine = true;
      break;
    }
    revealSafeRegion(state, neighbor, revealed);
  }

  const completed = !hitMine && completedSafeBoard(state);
  if (completed) {
    state.outcome = "WON";
  }

  return {
    accepted: true,
    revealed,
    ...(hitMine ? { hitMine: true } : {}),
    ...(completed ? { completed: true } : {}),
    progress: getProgress(state),
    stateHash: hashGameState(state),
  };
}

export type SolverRule =
  | "INITIAL_SAFE"
  | "SINGLE_SAFE"
  | "SINGLE_MINE"
  | "SUBSET_SAFE"
  | "SUBSET_MINE";

export interface SolverProofStep {
  readonly sequence: number;
  readonly rule: SolverRule;
  /** Revealed clue cells whose constraints justify this step. */
  readonly sources: readonly number[];
  /** Cells directly deduced safe or mined by the rule. */
  readonly targets: readonly number[];
  /** All cells actually exposed, including deterministic zero expansion. */
  readonly revealed: readonly RevealedCell[];
  /** Cells flagged as mines by this step. */
  readonly flagged: readonly number[];
}

export interface NoGuessSolveResult {
  readonly solved: boolean;
  readonly proof: readonly SolverProofStep[];
  readonly revealedSafeCount: number;
  readonly flaggedMineCount: number;
  readonly unresolved: readonly number[];
  readonly finalStateHash: string;
}

export interface NoGuessCertificate extends NoGuessSolveResult {
  readonly solved: true;
  readonly boardHash: string;
  readonly ruleset: "NG-Competitive-v1";
}

interface Constraint {
  readonly source: number;
  readonly cells: readonly number[];
  readonly remainingMines: number;
}

interface Deduction {
  readonly rule: Exclude<SolverRule, "INITIAL_SAFE">;
  readonly sources: readonly number[];
  readonly targets: readonly number[];
  readonly kind: "SAFE" | "MINE";
}

export interface SolverDeduction {
  readonly rule: Exclude<SolverRule, "INITIAL_SAFE">;
  readonly sources: readonly number[];
  readonly targets: readonly number[];
  readonly kind: "SAFE" | "MINE";
  /** Invalidates the deduction as soon as the visible board state changes. */
  readonly stateHash: string;
}

function collectConstraints(state: GameState): Constraint[] {
  const constraints: Constraint[] = [];
  const { board, visibility } = state;

  for (let index = 0; index < visibility.length; index += 1) {
    if (visibility[index] !== CELL_REVEALED) {
      continue;
    }
    const clue = board.adjacent[index] ?? 0;
    if (clue === 0) {
      continue;
    }

    const cells: number[] = [];
    let flagged = 0;
    for (const neighbor of getNeighborIndices(
      board.spec.width,
      board.spec.height,
      index,
    )) {
      if (visibility[neighbor] === CELL_HIDDEN) {
        cells.push(neighbor);
      } else if (visibility[neighbor] === CELL_FLAGGED) {
        flagged += 1;
      }
    }

    const remainingMines = clue - flagged;
    if (
      cells.length > 0 &&
      remainingMines >= 0 &&
      remainingMines <= cells.length
    ) {
      constraints.push({ source: index, cells, remainingMines });
    }
  }

  return constraints;
}

function isSubset(
  possibleSubset: readonly number[],
  possibleSuperset: readonly number[],
): boolean {
  if (possibleSubset.length >= possibleSuperset.length) {
    return false;
  }
  let subsetIndex = 0;
  let supersetIndex = 0;
  while (
    subsetIndex < possibleSubset.length &&
    supersetIndex < possibleSuperset.length
  ) {
    const subsetValue = possibleSubset[subsetIndex];
    const supersetValue = possibleSuperset[supersetIndex];
    if (subsetValue === undefined || supersetValue === undefined) {
      return false;
    }
    if (subsetValue === supersetValue) {
      subsetIndex += 1;
      supersetIndex += 1;
    } else if (supersetValue < subsetValue) {
      supersetIndex += 1;
    } else {
      return false;
    }
  }
  return subsetIndex === possibleSubset.length;
}

function subtractSorted(
  superset: readonly number[],
  subset: readonly number[],
): number[] {
  const subsetSet = new Set(subset);
  return superset.filter((cell) => !subsetSet.has(cell));
}

function collectDeductions(
  constraints: readonly Constraint[],
): Deduction[] {
  const deductions: Deduction[] = [];
  for (const constraint of constraints) {
    if (constraint.remainingMines === 0) {
      deductions.push({
        rule: "SINGLE_SAFE",
        sources: [constraint.source],
        targets: constraint.cells,
        kind: "SAFE",
      });
    }
    if (constraint.remainingMines === constraint.cells.length) {
      deductions.push({
        rule: "SINGLE_MINE",
        sources: [constraint.source],
        targets: constraint.cells,
        kind: "MINE",
      });
    }
  }

  for (let subsetIndex = 0; subsetIndex < constraints.length; subsetIndex += 1) {
    const subset = constraints[subsetIndex];
    if (subset === undefined) {
      continue;
    }
    for (let supersetIndex = 0; supersetIndex < constraints.length; supersetIndex += 1) {
      if (subsetIndex === supersetIndex) {
        continue;
      }
      const superset = constraints[supersetIndex];
      if (superset === undefined || !isSubset(subset.cells, superset.cells)) {
        continue;
      }

      const difference = subtractSorted(superset.cells, subset.cells);
      const remainingDifference =
        superset.remainingMines - subset.remainingMines;
      if (remainingDifference === 0) {
        deductions.push({
          rule: "SUBSET_SAFE",
          sources: [subset.source, superset.source],
          targets: difference,
          kind: "SAFE",
        });
      }
      if (remainingDifference === difference.length) {
        deductions.push({
          rule: "SUBSET_MINE",
          sources: [subset.source, superset.source],
          targets: difference,
          kind: "MINE",
        });
      }
    }
  }

  return deductions;
}

function findDeduction(constraints: readonly Constraint[]): Deduction | null {
  return collectDeductions(constraints)[0] ?? null;
}

/**
 * Returns every deterministic single-count or strict-subset deduction for the
 * current visible state. It never reads hidden mine truth; callers must discard
 * the result when `stateHash` no longer matches.
 */
export function getDeterministicDeductions(
  state: GameState,
): readonly SolverDeduction[] {
  if (state.outcome !== "PLAYING") return [];
  const stateHash = hashGameState(state);
  return collectDeductions(collectConstraints(state)).map((deduction) => ({
    ...deduction,
    stateHash,
  }));
}

export function isProvablySafeCell(
  state: GameState,
  index: number,
): boolean {
  if (
    state.outcome !== "PLAYING" ||
    !isValidCellIndex(state, index) ||
    state.visibility[index] !== CELL_HIDDEN
  ) {
    return false;
  }

  const constraints = collectConstraints(state);
  for (const superset of constraints) {
    if (!superset.cells.includes(index)) continue;
    if (superset.remainingMines === 0) return true;

    for (const subset of constraints) {
      if (
        subset === superset ||
        subset.cells.includes(index) ||
        !isSubset(subset.cells, superset.cells)
      ) {
        continue;
      }
      if (
        superset.remainingMines - subset.remainingMines === 0
      ) {
        return true;
      }
    }
  }
  return false;
}

export function solveNoGuess(board: Board): NoGuessSolveResult {
  const state = createGameState(board);
  const proof: SolverProofStep[] = [];
  const initial = revealCell(state, board.spec.startIndex);
  if (!initial.accepted || initial.hitMine === true) {
    return {
      solved: false,
      proof,
      revealedSafeCount: state.revealedSafeCount,
      flaggedMineCount: 0,
      unresolved: Array.from(
        { length: state.visibility.length },
        (_, index) => index,
      ),
      finalStateHash: hashGameState(state),
    };
  }

  proof.push({
    sequence: 0,
    rule: "INITIAL_SAFE",
    sources: [board.spec.startIndex],
    targets: [board.spec.startIndex],
    revealed: initial.revealed,
    flagged: [],
  });

  while (state.outcome === "PLAYING") {
    const deduction = findDeduction(collectConstraints(state));
    if (deduction === null) {
      break;
    }

    const revealed: RevealedCell[] = [];
    const flagged: number[] = [];
    if (deduction.kind === "MINE") {
      for (const target of deduction.targets) {
        if (state.visibility[target] !== CELL_HIDDEN) {
          continue;
        }
        const delta = toggleFlag(state, target);
        if (delta.accepted) {
          flagged.push(target);
        }
      }
    } else {
      for (const target of deduction.targets) {
        if (state.visibility[target] !== CELL_HIDDEN) {
          continue;
        }
        const delta = revealCell(state, target);
        if (!delta.accepted) {
          continue;
        }
        revealed.push(...delta.revealed);
        if (delta.hitMine === true) {
          break;
        }
      }
    }

    if (revealed.length === 0 && flagged.length === 0) {
      break;
    }
    proof.push({
      sequence: proof.length,
      rule: deduction.rule,
      sources: deduction.sources,
      targets: deduction.targets,
      revealed,
      flagged,
    });
  }

  const unresolved: number[] = [];
  let flaggedMineCount = 0;
  for (let index = 0; index < state.visibility.length; index += 1) {
    if (state.visibility[index] === CELL_HIDDEN) {
      unresolved.push(index);
    } else if (
      state.visibility[index] === CELL_FLAGGED &&
      board.mines[index] === 1
    ) {
      flaggedMineCount += 1;
    }
  }

  return {
    solved: state.outcome === "WON",
    proof,
    revealedSafeCount: state.revealedSafeCount,
    flaggedMineCount,
    unresolved,
    finalStateHash: hashGameState(state),
  };
}

export function certifyNoGuess(board: Board): NoGuessCertificate | null {
  const result = solveNoGuess(board);
  if (!result.solved) {
    return null;
  }
  return {
    ...result,
    solved: true,
    boardHash: hashBoard(board),
    ruleset: "NG-Competitive-v1",
  };
}

export type MatchPhase =
  | "LOBBY"
  | "COUNTDOWN"
  | "ACTIVE"
  | "ROUND_RESULT"
  | "MATCH_RESULT"
  | "REMATCH"
  | "CLOSED";

export type ClientActionType =
  | "READY"
  | "REVEAL"
  | "TOGGLE_FLAG"
  | "CHORD"
  | "REMATCH";

export interface HelloClientMessage {
  readonly type: "HELLO";
  readonly v: typeof PROTOCOL_VERSION;
  readonly ticket: string;
}

export interface ClientActionEnvelope {
  readonly v: typeof PROTOCOL_VERSION;
  readonly matchId: string;
  readonly connectionEpoch: number;
  readonly clientActionId: string;
  readonly lastServerSeq: number;
  readonly actionType: ClientActionType;
  readonly cellIndex?: number;
  readonly clientMonoTelemetry: number;
}

export interface ActionClientMessage {
  readonly type: "ACTION";
  readonly envelope: ClientActionEnvelope;
}

export interface PingClientMessage {
  readonly type: "PING";
  readonly at: number;
}

export type ClientMessage =
  | HelloClientMessage
  | ActionClientMessage
  | PingClientMessage;

export interface RoomPlayer {
  readonly playerId: string;
  readonly guestId: string;
  readonly displayName: string;
  readonly seat: number;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly rematch: boolean;
  readonly wins: number;
  readonly progress: number;
  readonly score: number;
  readonly spectator: boolean;
  readonly input: "DESKTOP" | "TOUCH";
}

export interface PublicProgress {
  readonly playerId: string;
  readonly progress: number;
  readonly progressPercent: number;
  readonly connected: boolean;
  readonly outcome: GameOutcome | "DNF";
}

interface SequencedServerMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly serverSeq: number;
}

export interface WelcomeServerMessage extends SequencedServerMessage {
  readonly type: "WELCOME";
  readonly sessionId: string;
  readonly playerId: string;
  readonly roomId: string;
  readonly roomCode: string;
  readonly matchId: string;
  readonly connectionEpoch: number;
  readonly serverTime: number;
}

export interface RoomStateServerMessage extends SequencedServerMessage {
  readonly type: "ROOM_STATE";
  readonly roomId: string;
  readonly roomCode: string;
  readonly matchId?: string;
  readonly hostPlayerId: string;
  readonly players: readonly RoomPlayer[];
  readonly phase: MatchPhase;
  readonly scores: Readonly<Record<string, number>>;
  readonly round: number;
  readonly deadline?: number;
  readonly stateHash: string;
}

export type ClientSeedBoardSpec = BoardSpec & {
  readonly seedCommitment: string;
};

export interface CountdownServerMessage extends SequencedServerMessage {
  readonly type: "COUNTDOWN";
  readonly matchId: string;
  readonly boardVisibility: "client_seed" | "server_secret";
  readonly boardSpec: ClientSeedBoardSpec | PublicBoardSpec;
  readonly deadline: number;
  readonly round: number;
}

export interface RoundActiveServerMessage extends SequencedServerMessage {
  readonly type: "ROUND_ACTIVE";
  readonly matchId: string;
  readonly initialDelta: RevealDelta;
  readonly stateHash: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly round: number;
}

export interface ActionResultServerMessage extends SequencedServerMessage {
  readonly type: "ACTION_RESULT";
  readonly matchId: string;
  readonly ackClientActionId: string;
  readonly accepted: boolean;
  readonly rejectReason?: string;
  readonly delta?: RevealDelta;
  readonly duplicate: boolean;
  readonly stateHash: string;
}

export interface ProgressServerMessage extends SequencedServerMessage {
  readonly type: "PROGRESS";
  readonly matchId: string;
  readonly round: number;
  readonly progress: readonly PublicProgress[];
}

export interface RoundResultServerMessage extends SequencedServerMessage {
  readonly type: "ROUND_RESULT";
  readonly matchId: string;
  readonly round: number;
  readonly winnerGuestId?: string;
  readonly reason: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly stateHash: string;
}

export interface MatchResultServerMessage extends SequencedServerMessage {
  readonly type: "MATCH_RESULT";
  readonly matchId: string;
  readonly replayId: string;
  readonly outcome: "WIN" | "NO_CONTEST";
  readonly winnerGuestId?: string;
  readonly reason: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly stateHash: string;
}

export interface RematchStartedServerMessage extends SequencedServerMessage {
  readonly type: "REMATCH_STARTED";
  readonly roomId: string;
  readonly matchId: string;
}

export interface SnapshotMatchResult {
  readonly outcome: "WIN" | "NO_CONTEST";
  readonly winnerGuestId?: string;
  readonly reason: string;
  readonly scores: Readonly<Record<string, number>>;
}

export interface SnapshotServerMessage extends SequencedServerMessage {
  readonly type: "SNAPSHOT";
  readonly snapshot: {
    readonly roomId: string;
    readonly roomCode: string;
    readonly matchId: string;
    readonly phase: MatchPhase;
    readonly round: number;
    readonly deadline?: number;
    readonly scores: Readonly<Record<string, number>>;
    readonly players: readonly RoomPlayer[];
    readonly boardVisibility: "client_seed" | "server_secret";
    readonly board?: ClientSeedBoardSpec | PublicBoardSpec;
    readonly stateHash: string;
    readonly ownGame?: {
      readonly visibility: readonly number[];
      readonly revealed: readonly RevealedCell[];
      readonly progress: number;
      readonly outcome: GameOutcome;
      readonly stateHash: string;
    };
    readonly matchResult?: SnapshotMatchResult;
  };
}

export interface ErrorServerMessage {
  readonly type: "ERROR";
  readonly v: typeof PROTOCOL_VERSION;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly serverSeq?: number;
}

export interface PongServerMessage {
  readonly type: "PONG";
  readonly v: typeof PROTOCOL_VERSION;
  readonly at: number;
  readonly serverTime: number;
}

export type ServerMessage =
  | WelcomeServerMessage
  | RoomStateServerMessage
  | CountdownServerMessage
  | RoundActiveServerMessage
  | ActionResultServerMessage
  | ProgressServerMessage
  | RoundResultServerMessage
  | MatchResultServerMessage
  | RematchStartedServerMessage
  | SnapshotServerMessage
  | ErrorServerMessage
  | PongServerMessage;
