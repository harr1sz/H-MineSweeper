import { getSoloConfigErrorCode, type SoloGenerationMode } from "./solo";

export type PracticeErrorCategory =
  | "WRONG_FLAG"
  | "MISSED_SAFE_MOVE"
  | "DANGEROUS_CHORD"
  | "UNPROVEN_GUESS";

export type PracticeTriggerVerdict =
  | "PROVABLE_MINE_REVEALED"
  | "PROVABLE_SAFE_FLAGGED"
  | "WRONG_FLAG_CHORD_CHAIN"
  | "UNCERTAIN_LOSS";

export interface PracticeLaunchContext {
  readonly sourceRecordId: string;
  readonly board: {
    readonly width: number;
    readonly height: number;
    readonly mines: number;
  };
  readonly originalGenerationMode: SoloGenerationMode;
  readonly errorCategory: PracticeErrorCategory;
  readonly replayStep: number;
}

const PRACTICE_ERRORS = new Set<PracticeErrorCategory>([
  "WRONG_FLAG",
  "MISSED_SAFE_MOVE",
  "DANGEROUS_CHORD",
  "UNPROVEN_GUESS",
]);

export function practiceErrorCategoryForVerdict(
  verdict: PracticeTriggerVerdict,
): PracticeErrorCategory {
  if (verdict === "WRONG_FLAG_CHORD_CHAIN") return "DANGEROUS_CHORD";
  if (verdict === "PROVABLE_SAFE_FLAGGED") return "WRONG_FLAG";
  return "UNPROVEN_GUESS";
}

export function buildPracticeLaunchHash(context: PracticeLaunchContext): string {
  const params = new URLSearchParams({
    source: context.sourceRecordId,
    w: String(context.board.width),
    h: String(context.board.height),
    m: String(context.board.mines),
    mode: context.originalGenerationMode,
    error: context.errorCategory,
    step: String(context.replayStep),
  });
  return `#/solo/practice?${params.toString()}`;
}

export function parsePracticeLaunchContext(hash: string): PracticeLaunchContext | null {
  const marker = "#/solo/practice?";
  if (!hash.startsWith(marker)) return null;
  const params = new URLSearchParams(hash.slice(marker.length));
  const sourceRecordId = params.get("source") ?? "";
  const width = Number(params.get("w"));
  const height = Number(params.get("h"));
  const mines = Number(params.get("m"));
  const replayStep = Number(params.get("step"));
  const originalGenerationMode = params.get("mode");
  const errorCategory = params.get("error") as PracticeErrorCategory | null;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sourceRecordId)) return null;
  if (originalGenerationMode !== "classic" && originalGenerationMode !== "no_guess") return null;
  if (!errorCategory || !PRACTICE_ERRORS.has(errorCategory)) return null;
  if (!Number.isSafeInteger(replayStep) || replayStep < 1) return null;
  if (getSoloConfigErrorCode({ width, height, mines, mode: "no_guess" })) return null;
  return {
    sourceRecordId,
    board: { width, height, mines },
    originalGenerationMode,
    errorCategory,
    replayStep,
  };
}
