import type { VisibleBoardProof, VisibleBoardState } from "@h-minesweeper/game-core";

export type LearningConceptId =
  | "FOUNDATIONS_OPERATIONS"
  | "FOUNDATIONS_NEIGHBORHOOD"
  | "FOUNDATIONS_FORCED_RULES"
  | "FOUNDATIONS_FIRST_BOARD"
  | "REASONING_REMAINING_MINES"
  | "REASONING_SUBSETS"
  | "REASONING_PATTERNS"
  | "REASONING_UNCERTAINTY"
  | "PRACTICE_CHAINED_FRONTS"
  | "PRACTICE_SAFE_CHORD"
  | "PRACTICE_TRANSFER"
  | "PRACTICE_REVIEW_CLINIC";

export type LearningTier = "FOUNDATIONS" | "REASONING" | "PRACTICE";
export type TeachingScenarioStage = "DEMO" | "GUIDED" | "INDEPENDENT" | "CHECKPOINT";
export type AcademyResponseKind = "SAFE" | "MINE" | "UNDETERMINED" | "RULE" | "SOURCES";

export interface AcademyResponse {
  readonly kind: AcademyResponseKind;
  readonly targetIndexes?: readonly number[];
  readonly sourceIndexes?: readonly number[];
  readonly rule?: VisibleBoardProof["rule"];
}

export interface TeachingScenario {
  readonly id: string;
  readonly exerciseId: string;
  readonly conceptId: LearningConceptId;
  readonly tier: LearningTier;
  readonly prerequisiteConceptIds: readonly LearningConceptId[];
  readonly board: VisibleBoardState;
  readonly expectedResponse: AcademyResponse;
  readonly proof: readonly VisibleBoardProof[];
  readonly misconceptionTags: readonly string[];
  readonly copyKeys: {
    readonly title: string;
    readonly concept: string;
    readonly prompt: string;
    readonly explanation: string;
  };
  readonly unseenCheckpoint: boolean;
  readonly stage: TeachingScenarioStage;
  readonly recommendedCellSize: number;
  readonly minimumCellSize: number;
  readonly interactiveIndexes: readonly number[];
  readonly sourceIndexes: readonly number[];
  readonly reasonRuleOptions: readonly VisibleBoardProof["rule"][];
  readonly expectedActions: readonly {
    readonly action: "REVEAL" | "FLAG" | "UNDETERMINED";
    readonly cellIndex: number;
  }[];
  readonly transform: "IDENTITY" | "ROTATE_90" | "ROTATE_180" | "MIRROR_X";
  readonly distractionIndexes: readonly number[];
  readonly checkpointGroupId?: string;
  readonly curriculumVersion: number;
}

export type AcademySkillState = "LOCKED" | "LEARNING" | "PRACTICED" | "MASTERED";

export interface AcademyProgressV3 {
  readonly version: 3;
  readonly curriculumVersion: number;
  readonly skills: Readonly<Record<LearningConceptId, AcademySkillState>>;
  readonly highestHintByScenario: Readonly<Record<string, number>>;
  readonly completedScenarioIds: readonly string[];
  readonly masteredCheckpointIds: readonly string[];
  readonly totalAttempts: number;
  readonly correctAttempts: number;
  readonly hintRequests: number;
  readonly updatedAt: number;
  /** Preserved verbatim so migration can be audited or reversed. */
  readonly v2Backup?: unknown;
  readonly previousCurriculumBackup?: unknown;
}

export interface BoardReviewAnnotations {
  readonly detonatedMine?: number;
  readonly otherMines: readonly number[];
  readonly correctFlags: readonly number[];
  readonly wrongFlags: readonly number[];
  readonly proofSources: readonly number[];
  readonly suggestedSafe: readonly number[];
  readonly suggestedMines: readonly number[];
  readonly conceptId?: LearningConceptId;
}

export const LEARNING_MODULES: ReadonlyArray<{
  readonly tier: LearningTier;
  readonly conceptId: LearningConceptId;
  readonly titleKey: string;
}> = [
  { tier: "FOUNDATIONS", conceptId: "FOUNDATIONS_OPERATIONS", titleKey: "academy.module.operations" },
  { tier: "FOUNDATIONS", conceptId: "FOUNDATIONS_NEIGHBORHOOD", titleKey: "academy.module.neighborhood" },
  { tier: "FOUNDATIONS", conceptId: "FOUNDATIONS_FORCED_RULES", titleKey: "academy.module.forcedRules" },
  { tier: "FOUNDATIONS", conceptId: "FOUNDATIONS_FIRST_BOARD", titleKey: "academy.module.firstBoard" },
  { tier: "REASONING", conceptId: "REASONING_REMAINING_MINES", titleKey: "academy.module.remainingMines" },
  { tier: "REASONING", conceptId: "REASONING_SUBSETS", titleKey: "academy.module.subsets" },
  { tier: "REASONING", conceptId: "REASONING_PATTERNS", titleKey: "academy.module.patterns" },
  { tier: "REASONING", conceptId: "REASONING_UNCERTAINTY", titleKey: "academy.module.uncertainty" },
  { tier: "PRACTICE", conceptId: "PRACTICE_CHAINED_FRONTS", titleKey: "academy.module.chainedFronts" },
  { tier: "PRACTICE", conceptId: "PRACTICE_SAFE_CHORD", titleKey: "academy.module.safeChord" },
  { tier: "PRACTICE", conceptId: "PRACTICE_TRANSFER", titleKey: "academy.module.transfer" },
  { tier: "PRACTICE", conceptId: "PRACTICE_REVIEW_CLINIC", titleKey: "academy.module.reviewClinic" },
];

export const ACADEMY_PROGRESS_V3_STORAGE_KEY = "hms-academy-progress-v3";
export const ACADEMY_PROGRESS_V2_BACKUP_KEY = "hms-academy-progress-v2-backup";
export const ACADEMY_CURRICULUM_VERSION = 1 as const;

const ALL_CONCEPTS = LEARNING_MODULES.map(({ conceptId }) => conceptId);

export function createEmptyAcademyProgressV3(now = Date.now()): AcademyProgressV3 {
  return {
    version: 3,
    curriculumVersion: ACADEMY_CURRICULUM_VERSION,
    skills: Object.fromEntries(
      ALL_CONCEPTS.map((conceptId, index) => [conceptId, index === 0 ? "LEARNING" : "LOCKED"]),
    ) as Record<LearningConceptId, AcademySkillState>,
    highestHintByScenario: {},
    completedScenarioIds: [],
    masteredCheckpointIds: [],
    totalAttempts: 0,
    correctAttempts: 0,
    hintRequests: 0,
    updatedAt: now,
  };
}

export const LEGACY_EXERCISE_CONCEPT: Readonly<Record<string, LearningConceptId>> = {
  "c0-all-mine": "FOUNDATIONS_FORCED_RULES",
  "c0-satisfied": "FOUNDATIONS_FORCED_RULES",
  "c1-residual-mine": "REASONING_REMAINING_MINES",
  "c1-residual-safe": "REASONING_REMAINING_MINES",
  "c2-subset-safe": "REASONING_SUBSETS",
  "c2-subset-mine": "REASONING_SUBSETS",
  "c3-pattern-121": "REASONING_PATTERNS",
  "c3-pattern-1221": "REASONING_PATTERNS",
  "practice-chained-fronts": "PRACTICE_CHAINED_FRONTS",
  "practice-safe-chord": "PRACTICE_SAFE_CHORD",
  "practice-unseen-transfer": "PRACTICE_TRANSFER",
  "practice-review-clinic": "PRACTICE_REVIEW_CLINIC",
};

export function migrateAcademyProgressV2(raw: unknown, now = Date.now()): AcademyProgressV3 {
  const next = createEmptyAcademyProgressV3(now);
  if (!raw || typeof raw !== "object") return next;
  const legacy = raw as { readonly completedExerciseIds?: unknown };
  if (!Array.isArray(legacy.completedExerciseIds)) return next;
  const practiced = new Set<LearningConceptId>();
  for (const exerciseId of legacy.completedExerciseIds) {
    if (typeof exerciseId !== "string") continue;
    const conceptId = LEGACY_EXERCISE_CONCEPT[exerciseId];
    if (conceptId) practiced.add(conceptId);
  }
  return {
    ...next,
    skills: {
      ...next.skills,
      FOUNDATIONS_OPERATIONS: "LEARNING",
      FOUNDATIONS_NEIGHBORHOOD: "LEARNING",
      ...Object.fromEntries([...practiced].map((conceptId) => [conceptId, "PRACTICED"])),
    },
    v2Backup: structuredClone(raw),
  };
}

export function loadAcademyProgressV3(
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): AcademyProgressV3 {
  try {
    const current = storage.getItem(ACADEMY_PROGRESS_V3_STORAGE_KEY);
    if (current) {
      const parsed = JSON.parse(current) as Partial<AcademyProgressV3>;
      if (parsed.version === 3 && parsed.skills && typeof parsed.skills === "object") {
        const empty = createEmptyAcademyProgressV3();
        const normalized: AcademyProgressV3 = {
          ...empty,
          ...parsed,
          version: 3,
          curriculumVersion: ACADEMY_CURRICULUM_VERSION,
          skills: { ...empty.skills, ...parsed.skills },
          highestHintByScenario: parsed.highestHintByScenario ?? {},
          completedScenarioIds: Array.isArray(parsed.completedScenarioIds) ? parsed.completedScenarioIds.filter((id): id is string => typeof id === "string") : [],
          masteredCheckpointIds: Array.isArray(parsed.masteredCheckpointIds) ? parsed.masteredCheckpointIds.filter((id): id is string => typeof id === "string") : [],
          totalAttempts: Number.isSafeInteger(parsed.totalAttempts) ? Math.max(0, Number(parsed.totalAttempts)) : 0,
          correctAttempts: Number.isSafeInteger(parsed.correctAttempts) ? Math.max(0, Number(parsed.correctAttempts)) : 0,
          hintRequests: Number.isSafeInteger(parsed.hintRequests) ? Math.max(0, Number(parsed.hintRequests)) : 0,
        };
        if (parsed.curriculumVersion !== ACADEMY_CURRICULUM_VERSION) {
          const migrated: AcademyProgressV3 = {
            ...normalized,
            skills: Object.fromEntries(Object.entries(normalized.skills).map(([conceptId, state]) => [
              conceptId,
              state === "MASTERED" ? "PRACTICED" : state,
            ])) as Record<LearningConceptId, AcademySkillState>,
            masteredCheckpointIds: [],
            previousCurriculumBackup: structuredClone(parsed),
            updatedAt: Date.now(),
          };
          storage.setItem(ACADEMY_PROGRESS_V3_STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
        return normalized;
      }
    }
    const legacyRaw = storage.getItem("hms-academy-progress-v2");
    const legacy = legacyRaw ? JSON.parse(legacyRaw) : null;
    const migrated = migrateAcademyProgressV2(legacy);
    if (legacyRaw) storage.setItem(ACADEMY_PROGRESS_V2_BACKUP_KEY, legacyRaw);
    storage.setItem(ACADEMY_PROGRESS_V3_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return createEmptyAcademyProgressV3();
  }
}

export function recordAcademyScenarioResult(
  progress: AcademyProgressV3,
  scenario: Pick<TeachingScenario, "id" | "conceptId" | "unseenCheckpoint">,
  correct: boolean,
  highestHintLevel: number,
): AcademyProgressV3 {
  const completed = new Set(progress.completedScenarioIds);
  const mastered = new Set(progress.masteredCheckpointIds);
  if (correct) completed.add(scenario.id);
  const mayMaster = correct && scenario.unseenCheckpoint && highestHintLevel < 6;
  if (mayMaster) mastered.add(scenario.id);
  const previousState = progress.skills[scenario.conceptId];
  const nextState: AcademySkillState = mayMaster
    ? "MASTERED"
    : correct
      ? previousState === "MASTERED" ? "MASTERED" : "PRACTICED"
      : previousState === "LOCKED" ? "LEARNING" : previousState;
  const conceptIndex = LEARNING_MODULES.findIndex(({ conceptId }) => conceptId === scenario.conceptId);
  const nextConcept = LEARNING_MODULES[conceptIndex + 1]?.conceptId;
  const skills = { ...progress.skills, [scenario.conceptId]: nextState };
  if (correct && scenario.unseenCheckpoint && nextConcept && skills[nextConcept] === "LOCKED") {
    skills[nextConcept] = "LEARNING";
  }
  return {
    ...progress,
    skills,
    highestHintByScenario: {
      ...progress.highestHintByScenario,
      [scenario.id]: Math.max(progress.highestHintByScenario[scenario.id] ?? 0, highestHintLevel),
    },
    completedScenarioIds: [...completed],
    masteredCheckpointIds: [...mastered],
    totalAttempts: progress.totalAttempts + 1,
    correctAttempts: progress.correctAttempts + (correct ? 1 : 0),
    updatedAt: Date.now(),
  };
}

export function recordAcademyHintV3(
  progress: AcademyProgressV3,
  scenarioId: string,
  hintLevel: number,
): AcademyProgressV3 {
  return {
    ...progress,
    highestHintByScenario: {
      ...progress.highestHintByScenario,
      [scenarioId]: Math.max(progress.highestHintByScenario[scenarioId] ?? 0, hintLevel),
    },
    hintRequests: progress.hintRequests + 1,
    updatedAt: Date.now(),
  };
}

export function saveAcademyProgressV3(
  progress: AcademyProgressV3,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(ACADEMY_PROGRESS_V3_STORAGE_KEY, JSON.stringify(progress));
}
