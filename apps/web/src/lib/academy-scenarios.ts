import {
  analyzeVisibleBoard,
  getNeighborIndices,
  type VisibleBoardProof,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import {
  ACADEMY_EXERCISES,
  ACADEMY_NEIGHBORHOOD_EXERCISES,
  ACADEMY_UNCERTAINTY_EXERCISES,
  analyzeAcademyExercise,
  transformAcademyExercise,
  type AcademyExercise,
  type AcademyTransform,
} from "./academy";
import {
  ACADEMY_CURRICULUM_VERSION,
  LEARNING_MODULES,
  type TeachingScenario,
  type TeachingScenarioStage,
  type LearningConceptId,
} from "./learning-contracts";

const EXERCISES_BY_ID = new Map(
  [...ACADEMY_EXERCISES, ...ACADEMY_NEIGHBORHOOD_EXERCISES, ...ACADEMY_UNCERTAINTY_EXERCISES]
    .map((exercise) => [exercise.id, exercise] as const),
);

const ids = (...exerciseIds: readonly string[]): readonly AcademyExercise[] => exerciseIds.map((id) => {
  const exercise = EXERCISES_BY_ID.get(id);
  if (!exercise) throw new RangeError(`Unknown Academy exercise ${id}`);
  return exercise;
});

function paddedVariant(
  exercise: AcademyExercise,
  suffix: number,
): AcademyExercise {
  const padding = [
    { top: 0, right: 0, bottom: 0, left: 0 },
    { top: 1, right: 0, bottom: 0, left: 0 },
    { top: 0, right: 1, bottom: 0, left: 0 },
    { top: 0, right: 0, bottom: 1, left: 0 },
    { top: 0, right: 0, bottom: 0, left: 1 },
  ][suffix]!;
  const width = exercise.width + padding.left + padding.right;
  const height = exercise.height + padding.top + padding.bottom;
  const indexFor = (index: number) => {
    const x = index % exercise.width;
    const y = Math.floor(index / exercise.width);
    return (y + padding.top) * width + x + padding.left;
  };
  const cells: AcademyExercise["cells"] = Array.from(
    { length: width * height },
    () => ({ kind: "open" as const }),
  );
  const mutable = [...cells];
  exercise.cells.forEach((cell, index) => { mutable[indexFor(index)] = cell; });
  return {
    ...exercise,
    id: `${exercise.id}:v${suffix + 1}`,
    copySourceId: exercise.copySourceId ?? exercise.id,
    width,
    height,
    cells: mutable,
    safeTargets: exercise.safeTargets.map(indexFor),
    mineTargets: exercise.mineTargets.map(indexFor),
    ...(exercise.undeterminedTargets ? { undeterminedTargets: exercise.undeterminedTargets.map(indexFor) } : {}),
  };
}

function conceptVariants(...exerciseIds: readonly string[]): readonly AcademyExercise[] {
  const bases = ids(...exerciseIds);
  return Array.from({ length: 5 }, (_, index) => paddedVariant(bases[index % bases.length]!, index));
}

/**
 * Every module now has five authored situations. Stage progression changes
 * clue counts, candidate sets, and conclusions; it no longer rotates one
 * answer five times and calls that practice.
 */
export const MODULE_EXERCISES_BY_CONCEPT: Readonly<Record<LearningConceptId, readonly AcademyExercise[]>> = {
  FOUNDATIONS_OPERATIONS: conceptVariants("c0-neighborhood-demo", "c0-all-mine", "practice-safe-chord"),
  FOUNDATIONS_NEIGHBORHOOD: ACADEMY_NEIGHBORHOOD_EXERCISES,
  FOUNDATIONS_FORCED_RULES: conceptVariants("c0-all-mine", "c0-satisfied", "c1-residual-mine", "c1-residual-safe"),
  FOUNDATIONS_FIRST_BOARD: conceptVariants("c0-neighborhood-mixed", "practice-chained-fronts"),
  REASONING_REMAINING_MINES: conceptVariants("c1-residual-mine", "c1-residual-safe"),
  REASONING_SUBSETS: conceptVariants("c2-subset-safe", "c2-subset-mine"),
  REASONING_PATTERNS: conceptVariants("c3-pattern-121", "c3-pattern-1221"),
  REASONING_UNCERTAINTY: ACADEMY_UNCERTAINTY_EXERCISES,
  PRACTICE_CHAINED_FRONTS: conceptVariants("practice-chained-fronts"),
  PRACTICE_SAFE_CHORD: conceptVariants("practice-safe-chord"),
  PRACTICE_TRANSFER: conceptVariants("practice-unseen-transfer", "c2-subset-mine", "c3-pattern-1221"),
  PRACTICE_REVIEW_CLINIC: conceptVariants("practice-review-clinic", "uncertainty-one-of-three", "uncertainty-two-of-three"),
};

const STAGES: readonly {
  readonly stage: TeachingScenarioStage;
  readonly transform: AcademyTransform;
  readonly unseenCheckpoint: boolean;
}[] = [
  { stage: "DEMO", transform: "IDENTITY", unseenCheckpoint: false },
  { stage: "GUIDED", transform: "MIRROR_X", unseenCheckpoint: false },
  { stage: "INDEPENDENT", transform: "ROTATE_90", unseenCheckpoint: false },
  { stage: "INDEPENDENT", transform: "ROTATE_180", unseenCheckpoint: false },
  { stage: "CHECKPOINT", transform: "MIRROR_X", unseenCheckpoint: true },
];

export function visibleBoardForAcademyExercise(exercise: AcademyExercise): VisibleBoardState {
  const unknownIndexes = exercise.cells.flatMap((cell, index) => cell.kind === "unknown" ? [index] : []);
  const bitByIndex = new Map(unknownIndexes.map((index, bit) => [index, bit] as const));
  const knownMines = new Set(exercise.cells.flatMap((cell, index) => cell.kind === "known-mine" ? [index] : []));
  const layouts: Set<number>[] = [];
  for (let mask = 0; mask < 2 ** unknownIndexes.length; mask += 1) {
    const mines = new Set(knownMines);
    unknownIndexes.forEach((index, bit) => { if (((mask >> bit) & 1) === 1) mines.add(index); });
    const valid = exercise.cells.every((cell, index) => cell.kind !== "number" ||
      getNeighborIndices(exercise.width, exercise.height, index).filter((neighbor) => mines.has(neighbor)).length === cell.value);
    if (valid) layouts.push(mines);
  }
  if (layouts.length === 0) throw new RangeError(`Academy scenario ${exercise.id} has no valid layout`);
  const mineCounts = new Set(layouts.map((layout) => layout.size));
  if (mineCounts.size !== 1) throw new RangeError(`Academy scenario ${exercise.id} does not have a stable total mine count`);
  const clues = exercise.cells.map((cell, index) => {
    if (cell.kind === "number") return cell.value;
    if (cell.kind !== "open") return -1;
    const counts = layouts.map((layout) =>
      getNeighborIndices(exercise.width, exercise.height, index).filter((neighbor) => layout.has(neighbor)).length,
    );
    return counts.every((count) => count === counts[0]) ? (counts[0] ?? 0) : -1;
  });
  return {
    width: exercise.width,
    height: exercise.height,
    totalMines: layouts[0]!.size,
    clues,
    playerClaims: [...knownMines].sort((a, b) => a - b),
  };
}

function scenarioFromExercise(
  base: AcademyExercise,
  moduleIndex: number,
  stageIndex: number,
): TeachingScenario {
  const module = LEARNING_MODULES[moduleIndex]!;
  const stage = STAGES[stageIndex]!;
  const exercise = transformAcademyExercise(base, stage.transform);
  const teachingAnalysis = analyzeAcademyExercise(exercise);
  const unknownIndexes = exercise.cells.flatMap((cell, index) => cell.kind === "unknown" ? [index] : []);
  const interactiveSet = new Set(unknownIndexes);
  const board = visibleBoardForAcademyExercise(exercise);
  const solverAnalysis = analyzeVisibleBoard(board, 100_000);
  if (solverAnalysis.status !== "COMPLETE") {
    throw new RangeError(`Academy scenario ${exercise.id} is not completely analyzable`);
  }
  const proofs: VisibleBoardProof[] = solverAnalysis.proofs.flatMap((proof) => {
    const targets = proof.targets.filter((target) => interactiveSet.has(target));
    return targets.length === 0 ? [] : [{ ...proof, targets }];
  });
  const sources = [...new Set(
    proofs.length > 0
      ? proofs.flatMap(({ sources: proofSources }) => proofSources)
      : teachingAnalysis.trace.constraints.map(({ sourceIndex }) => sourceIndex),
  )];
  const distractionIndexes = exercise.cells.flatMap((cell, index) => cell.kind === "open" ? [index] : []);
  const safeTargets = [...new Set(proofs.filter(({ kind }) => kind === "SAFE").flatMap(({ targets }) => targets))].sort((a, b) => a - b);
  const mineTargets = [...new Set(proofs.filter(({ kind }) => kind === "MINE").flatMap(({ targets }) => targets))].sort((a, b) => a - b);
  const expectedActions = [
    ...safeTargets.map((cellIndex) => ({ action: "REVEAL" as const, cellIndex })),
    ...mineTargets.map((cellIndex) => ({ action: "FLAG" as const, cellIndex })),
    ...(exercise.undeterminedTargets ?? []).map((cellIndex) => ({ action: "UNDETERMINED" as const, cellIndex })),
  ];
  const primaryProof = proofs[0];
  return {
    id: `${module.conceptId.toLowerCase()}:${stage.stage.toLowerCase()}:${stageIndex + 1}`,
    exerciseId: exercise.id,
    conceptId: module.conceptId,
    tier: module.tier,
    prerequisiteConceptIds: moduleIndex === 0 ? [] : [LEARNING_MODULES[moduleIndex - 1]!.conceptId],
    board,
    expectedResponse: primaryProof ? {
      kind: primaryProof.kind,
      targetIndexes: primaryProof.targets,
      sourceIndexes: sources,
      rule: primaryProof.rule,
    } : {
      kind: "UNDETERMINED",
      targetIndexes: exercise.undeterminedTargets ?? [],
      sourceIndexes: sources,
    },
    proof: proofs,
    misconceptionTags: stage.stage === "CHECKPOINT" ? ["hindsight", "shape-memorization"] : ["remaining-count"],
    copyKeys: {
      title: `academy.module.${module.conceptId}`,
      concept: `academy.scenario.${module.conceptId}.concept`,
      prompt: `academy.scenario.${stage.stage}.prompt`,
      explanation: `academy.scenario.${module.conceptId}.explanation`,
    },
    unseenCheckpoint: stage.unseenCheckpoint,
    stage: stage.stage,
    recommendedCellSize: module.tier === "PRACTICE" ? 56 : 64,
    minimumCellSize: 44,
    interactiveIndexes: unknownIndexes,
    sourceIndexes: sources,
    reasonRuleOptions: [...new Set(proofs.map(({ rule }) => rule))],
    expectedActions,
    transform: stage.transform,
    distractionIndexes,
    ...(stage.unseenCheckpoint ? { checkpointGroupId: `${module.conceptId}:transfer` } : {}),
    curriculumVersion: ACADEMY_CURRICULUM_VERSION,
  };
}

const SCENARIO_EXERCISES = new Map<string, AcademyExercise>();

/** Five verified stages for each of the twelve Academy modules. */
export const ACADEMY_TEACHING_SCENARIOS: readonly TeachingScenario[] =
  LEARNING_MODULES.flatMap((module, moduleIndex) => STAGES.map((stage, stageIndex) => {
    const authored = MODULE_EXERCISES_BY_CONCEPT[module.conceptId][stageIndex];
    if (!authored) throw new RangeError(`Academy module ${module.conceptId} has no exercise`);
    const scenario = scenarioFromExercise(authored, moduleIndex, stageIndex);
    SCENARIO_EXERCISES.set(scenario.id, transformAcademyExercise(authored, stage.transform));
    return scenario;
  }));

export function exerciseForScenario(scenario: TeachingScenario): AcademyExercise {
  const exercise = SCENARIO_EXERCISES.get(scenario.id);
  if (!exercise) throw new RangeError(`Academy scenario ${scenario.id} has no exercise`);
  return exercise;
}

export function scenariosForConcept(conceptId: TeachingScenario["conceptId"]): readonly TeachingScenario[] {
  return ACADEMY_TEACHING_SCENARIOS.filter((scenario) => scenario.conceptId === conceptId);
}
