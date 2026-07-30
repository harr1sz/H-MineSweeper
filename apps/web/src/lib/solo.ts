import {
  CELL_FLAGGED,
  createBoard,
  createGameState,
  PRESET_SPECS,
  type BoardSpec,
  type GameState,
} from "@h-minesweeper/game-core";

export type SoloPreset = "beginner" | "intermediate" | "expert" | "custom";
export type SoloGenerationMode = "classic" | "no_guess";

export interface SoloBoardConfig {
  readonly width: number;
  readonly height: number;
  readonly mines: number;
  readonly mode: SoloGenerationMode;
}

export const SOLO_PRESETS: Readonly<
  Record<Exclude<SoloPreset, "custom">, Omit<SoloBoardConfig, "mode">>
> = Object.freeze({
  beginner: Object.freeze({
    width: PRESET_SPECS.beginner.width,
    height: PRESET_SPECS.beginner.height,
    mines: PRESET_SPECS.beginner.mines,
  }),
  intermediate: Object.freeze({
    width: PRESET_SPECS.intermediate.width,
    height: PRESET_SPECS.intermediate.height,
    mines: PRESET_SPECS.intermediate.mines,
  }),
  expert: Object.freeze({
    width: PRESET_SPECS.expert.width,
    height: PRESET_SPECS.expert.height,
    mines: PRESET_SPECS.expert.mines,
  }),
});

export interface NoGuessWorkerRequest {
  readonly requestId: number;
  readonly config: SoloBoardConfig;
  readonly startIndex: number;
  readonly maxAttempts: number;
  readonly maxDurationMs: number;
}

export type NoGuessWorkerResponse =
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly spec: BoardSpec;
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly boardHash: string;
    }
  | {
      readonly requestId: number;
      readonly ok: false;
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly reason: "GENERATION_LIMIT";
    };

export function getSoloConfigError(
  config: SoloBoardConfig,
): string | undefined {
  const { width, height, mines, mode } = config;
  if (!Number.isSafeInteger(width) || width < 5 || width > 100) {
    return "宽度必须是 5–100 的整数。";
  }
  if (!Number.isSafeInteger(height) || height < 5 || height > 100) {
    return "高度必须是 5–100 的整数。";
  }
  const cells = width * height;
  if (cells > 10_000) {
    return "棋盘总格数不能超过 10,000。";
  }
  if (
    !Number.isSafeInteger(mines) ||
    mines < 1 ||
    mines > Math.floor(cells * 0.4)
  ) {
    return `雷数必须是 1–${Math.floor(cells * 0.4)} 的整数。`;
  }
  if (mode === "no_guess" && (width > 50 || height > 50)) {
    return "无猜自定义棋盘的宽高不能超过 50。";
  }
  return undefined;
}

export function createSoloSeed(): string {
  const bytes = new Uint32Array(3);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 0x1_0000_0000);
    }
  }
  return `solo-v1-${Date.now().toString(36)}-${Array.from(bytes, (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("")}`;
}

export function createSoloBoardSpec(
  config: SoloBoardConfig,
  startIndex: number,
  seed = createSoloSeed(),
): BoardSpec {
  const error = getSoloConfigError(config);
  if (error) throw new RangeError(error);
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= config.width * config.height
  ) {
    throw new RangeError("首击格索引无效。");
  }
  return {
    width: config.width,
    height: config.height,
    mines: config.mines,
    seed,
    startIndex,
    safeRadius: 1,
  };
}

export function createPendingSoloGame(
  config: SoloBoardConfig,
  seed = createSoloSeed(),
): GameState {
  const centerIndex =
    Math.floor(config.height / 2) * config.width + Math.floor(config.width / 2);
  const spec = Object.freeze(
    createSoloBoardSpec(config, centerIndex, `pending-${seed}`),
  );
  const cells = config.width * config.height;
  return createGameState({
    spec,
    mines: new Uint8Array(cells),
    adjacent: new Uint8Array(cells),
  });
}

export function createStartedSoloGame(
  config: SoloBoardConfig,
  startIndex: number,
  seed?: string,
): GameState {
  return createGameState(
    createBoard(createSoloBoardSpec(config, startIndex, seed)),
  );
}

export function copyFlags(source: GameState, target: GameState): void {
  const length = Math.min(source.visibility.length, target.visibility.length);
  for (let index = 0; index < length; index += 1) {
    if (source.visibility[index] === CELL_FLAGGED) {
      target.visibility[index] = CELL_FLAGGED;
    }
  }
}

export function countFlags(state: GameState): number {
  let flags = 0;
  for (const visibility of state.visibility) {
    if (visibility === CELL_FLAGGED) flags += 1;
  }
  return flags;
}
