export const ACADEMY_CONTENT_VERSION = 2 as const;
export const ACADEMY_STORAGE_KEY = "hms-academy-progress-v2";

export type AcademyChapterId = 0 | 1 | 2 | 3;
export type AcademyAnswer = "safe" | "mine";
export type AcademyTransform =
  | "IDENTITY"
  | "ROTATE_90"
  | "ROTATE_180"
  | "MIRROR_X";
export type AcademyProofRule =
  | "SINGLE_MINE"
  | "SINGLE_SAFE"
  | "SUBSET_SAFE"
  | "SUBSET_MINE"
  | "PATTERN_121"
  | "PATTERN_1221";

export type AcademyCell =
  | { readonly kind: "unknown"; readonly label: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "known-mine" }
  | { readonly kind: "open" };

export interface AcademyExercise {
  readonly id: string;
  readonly chapterId: AcademyChapterId;
  readonly title: string;
  readonly objective: string;
  readonly premise: string;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly AcademyCell[];
  readonly safeTargets: readonly number[];
  readonly mineTargets: readonly number[];
  readonly proofRule: AcademyProofRule;
  readonly variant?: AcademyTransform;
  readonly hints: readonly [string, string, string, string, string, string];
  readonly proof: string;
}

export interface AcademyChapter {
  readonly id: AcademyChapterId;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
}

export interface AcademyAttemptRecord {
  readonly correct: boolean;
  readonly hintLevel: number;
  readonly variant: AcademyTransform;
}

export type AcademyLearningState =
  | "LOCKED"
  | "LEARNING"
  | "PRACTICED"
  | "MASTERED";

export interface AcademyProgress {
  readonly version: typeof ACADEMY_CONTENT_VERSION;
  readonly completedExerciseIds: readonly string[];
  readonly attempts: number;
  readonly correctAttempts: number;
  readonly hintRequests: number;
  readonly highestHintByExercise: Readonly<Record<string, number>>;
  readonly recentAttemptsByExercise: Readonly<
    Record<string, readonly AcademyAttemptRecord[]>
  >;
  readonly updatedAt: number;
}

export interface ExerciseEvaluation {
  readonly correct: boolean;
  readonly missingTargets: readonly number[];
  readonly wrongTargets: readonly number[];
}

export interface AcademyProofAnalysis {
  readonly solutionCount: number;
  readonly safeTargets: readonly number[];
  readonly mineTargets: readonly number[];
  readonly stateHash: string;
  readonly proofHash: string;
  readonly trace: AcademyProofTrace;
}

export interface AcademyProofConstraint {
  readonly sourceIndex: number;
  readonly clue: number;
  readonly knownMines: number;
  readonly unknownIndexes: readonly number[];
  readonly remainingMines: number;
}

export interface AcademyProofTrace {
  readonly rule: AcademyProofRule;
  readonly constraints: readonly AcademyProofConstraint[];
  readonly conclusions: readonly {
    index: number;
    kind: AcademyAnswer;
  }[];
}

export const ACADEMY_CHAPTERS: readonly AcademyChapter[] = [
  {
    id: 0,
    title: "看懂一颗雷",
    subtitle: "数字不是装饰，是周围八格的雷数。",
    description: "先掌握“全部是雷”和“数字已满足，其余全安全”。",
  },
  {
    id: 1,
    title: "先做减法",
    subtitle: "数字减去已经确认的雷，才是当前约束。",
    description: "同一个数字会随着旗标变化，变成新的残余问题。",
  },
  {
    id: 2,
    title: "共有区与独享区",
    subtitle: "比较两个数字覆盖的未知格集合。",
    description: "1-1 和 1-2 只是集合包含的快捷外观。",
  },
  {
    id: 3,
    title: "经典定式与反例",
    subtitle: "先检查边界，再识别 1-2-1 与 1-2-2-1。",
    description: "定式只在未知邻域封闭、且已扣除已知雷时成立。",
  },
] as const;

function sixHints(
  h1: string,
  h2: string,
  h3: string,
  h4: string,
  h5: string,
  h6: string,
): AcademyExercise["hints"] {
  return [h1, h2, h3, h4, h5, h6];
}

export const ACADEMY_EXERCISES: readonly AcademyExercise[] = [
  {
    id: "c0-all-mine",
    chapterId: 0,
    title: "未知格数等于雷数",
    objective: "标出所有能够确定为雷的格子。",
    premise: "数字 1 周围只剩一个未知格。",
    width: 2,
    height: 1,
    cells: [
      { kind: "number", value: 1 },
      { kind: "unknown", label: "A" },
    ],
    safeTargets: [],
    mineTargets: [1],
    proofRule: "SINGLE_MINE",
    hints: sixHints(
      "这里存在一个不需要猜测的结论。",
      "观察数字 1 和它旁边唯一的未知格。",
      "剩余雷数是 1，剩余未知格也是 1。",
      "当剩余雷数等于未知格数时，所有未知格都是雷。",
      "请选择“标雷”，再点唯一的未知格。",
      "A 必须是雷，否则数字 1 周围将没有任何雷。",
    ),
    proof: "1 个剩余雷 ÷ 1 个未知格，因此 A 是雷。",
  },
  {
    id: "c0-satisfied",
    chapterId: 0,
    title: "数字已经满足",
    objective: "找出确定安全的格子。",
    premise: "数字 1 已经邻接一颗确认的雷。",
    width: 3,
    height: 1,
    cells: [
      { kind: "known-mine" },
      { kind: "number", value: 1 },
      { kind: "unknown", label: "A" },
    ],
    safeTargets: [2],
    mineTargets: [],
    proofRule: "SINGLE_SAFE",
    hints: sixHints(
      "先问：这个数字还差几颗雷？",
      "数字 1 左边已有一颗确认的雷。",
      "剩余雷数 = 1 − 1 = 0。",
      "剩余雷数为 0 时，其余未知邻格全部安全。",
      "请选择“判安全”，再点 A。",
      "A 安全，因为数字 1 已经被左侧雷完全满足。",
    ),
    proof: "1 − 1 个已确认雷 = 0 个剩余雷，因此 A 安全。",
  },
  {
    id: "c1-residual-mine",
    chapterId: 1,
    title: "残余 1",
    objective: "减去已确认雷后，找出剩余雷。",
    premise: "数字 2 已经邻接一颗确认的雷，并且只剩一个未知格。",
    width: 3,
    height: 1,
    cells: [
      { kind: "known-mine" },
      { kind: "number", value: 2 },
      { kind: "unknown", label: "A" },
    ],
    safeTargets: [],
    mineTargets: [2],
    proofRule: "SINGLE_MINE",
    hints: sixHints(
      "不要把 2 当作还需要两颗雷。",
      "先扣掉左侧已经确认的雷。",
      "剩余雷数 = 2 − 1 = 1。",
      "唯一未知格必须承担这颗剩余雷。",
      "请选择“标雷”，再点 A。",
      "A 是雷；当前的数字 2 实际是一个残余 1。",
    ),
    proof: "2 − 1 个已确认雷 = 1；唯一未知格 A 必须是雷。",
  },
  {
    id: "c1-residual-safe",
    chapterId: 1,
    title: "残余 0",
    objective: "数字被全部满足后，清理安全格。",
    premise: "数字 2 已邻接两颗确认雷，另一侧仍有未知格。",
    width: 2,
    height: 2,
    cells: [
      { kind: "known-mine" },
      { kind: "known-mine" },
      { kind: "number", value: 2 },
      { kind: "unknown", label: "A" },
    ],
    safeTargets: [3],
    mineTargets: [],
    proofRule: "SINGLE_SAFE",
    hints: sixHints(
      "先计算这个 2 还缺几颗雷。",
      "它已经接触两颗确认雷。",
      "剩余雷数 = 2 − 2 = 0。",
      "任何额外的雷都会让数字 2 产生矛盾。",
      "请选择“判安全”，再点 A。",
      "A 安全，因为数字 2 的雷数已经完全满足。",
    ),
    proof: "2 − 2 个已确认雷 = 0，因此其余未知邻格 A 安全。",
  },
  {
    id: "c2-subset-safe",
    chapterId: 2,
    title: "1-1 的差集",
    objective: "找出只属于较大集合的安全格。",
    premise: "下方两个 1 的未知邻域分别是 {A,B} 与 {A,B,C}。",
    width: 3,
    height: 2,
    cells: [
      { kind: "unknown", label: "A" },
      { kind: "unknown", label: "B" },
      { kind: "unknown", label: "C" },
      { kind: "number", value: 1 },
      { kind: "number", value: 1 },
      { kind: "open" },
    ],
    safeTargets: [2],
    mineTargets: [],
    proofRule: "SUBSET_SAFE",
    hints: sixHints(
      "比较两个 1 覆盖的未知格，而不是猜 A 或 B。",
      "左侧 1 覆盖 {A,B}，右侧 1 覆盖 {A,B,C}。",
      "两个集合需要的雷数相同，都是 1。",
      "较大集合多出来的 C 不可能再放雷。",
      "请选择“判安全”，再点 C。",
      "{A,B} 与 {A,B,C} 都含 1 雷，所以差集 {C} 安全。",
    ),
    proof: "相同雷数的包含集合，其差集 C 必定安全。",
  },
  {
    id: "c2-subset-mine",
    chapterId: 2,
    title: "1-2 的差集",
    objective: "找出只属于较大集合的必雷格。",
    premise: "下方 1 覆盖 {A,B}，2 覆盖 {A,B,C}。",
    width: 3,
    height: 2,
    cells: [
      { kind: "unknown", label: "A" },
      { kind: "unknown", label: "B" },
      { kind: "unknown", label: "C" },
      { kind: "number", value: 1 },
      { kind: "number", value: 2 },
      { kind: "open" },
    ],
    safeTargets: [],
    mineTargets: [2],
    proofRule: "SUBSET_MINE",
    hints: sixHints(
      "两个数字共有 A、B，只有较大集合多出 C。",
      "先比较 {A,B} 与 {A,B,C} 的剩余雷数。",
      "较大集合比小集合多需要 1 颗雷。",
      "差集只有一个格 C，因此差出的雷只能在那里。",
      "请选择“标雷”，再点 C。",
      "{A,B} 有 1 雷，而 {A,B,C} 有 2 雷，所以 C 是雷。",
    ),
    proof: "集合雷数差为 1，差集大小也为 1，因此 C 必定是雷。",
  },
  {
    id: "c3-pattern-121",
    chapterId: 3,
    title: "封闭边界 1-2-1",
    objective: "同时标出可确定的雷格与安全格。",
    premise: "未知格只在数字同一侧，且没有额外未知邻格。",
    width: 3,
    height: 2,
    cells: [
      { kind: "unknown", label: "A" },
      { kind: "unknown", label: "B" },
      { kind: "unknown", label: "C" },
      { kind: "number", value: 1 },
      { kind: "number", value: 2 },
      { kind: "number", value: 1 },
    ],
    safeTargets: [1],
    mineTargets: [0, 2],
    proofRule: "PATTERN_121",
    hints: sixHints(
      "这个定式只有在未知邻域封闭时成立。",
      "三个约束分别来自左 1、中 2、右 1。",
      "方程是 A+B=1、A+B+C=2、B+C=1。",
      "中间方程分别减去两侧方程，可确定外侧与中间。",
      "A、C 需要标雷；B 需要判安全。",
      "唯一解是 A=雷、B=安全、C=雷；“中间必是雷”是错误口诀。",
    ),
    proof:
      "A+B=1，A+B+C=2，B+C=1。由此 A=1、B=0、C=1。",
  },
  {
    id: "c3-pattern-1221",
    chapterId: 3,
    title: "封闭边界 1-2-2-1",
    objective: "解决 1-2-1 的延伸结构。",
    premise: "四个数字沿封闭边界排列，未知格只在上方。",
    width: 4,
    height: 2,
    cells: [
      { kind: "unknown", label: "A" },
      { kind: "unknown", label: "B" },
      { kind: "unknown", label: "C" },
      { kind: "unknown", label: "D" },
      { kind: "number", value: 1 },
      { kind: "number", value: 2 },
      { kind: "number", value: 2 },
      { kind: "number", value: 1 },
    ],
    safeTargets: [0, 3],
    mineTargets: [1, 2],
    proofRule: "PATTERN_1221",
    hints: sixHints(
      "从两端的 1-2 集合差开始。",
      "左侧约束为 A+B=1、A+B+C=2。",
      "右侧约束为 B+C+D=2、C+D=1。",
      "左差集证明 C 是雷，右差集证明 B 是雷。",
      "B、C 标雷；A、D 判安全。",
      "唯一解是 A/D 安全，B/C 是雷；成立前提仍是封闭未知邻域。",
    ),
    proof:
      "A+B=1，A+B+C=2 得 C=1；C+D=1 得 D=0；B+C+D=2 得 B=1，最终 A=0。",
  },
] as const;

export function transformAcademyExercise(
  exercise: AcademyExercise,
  transform: AcademyTransform,
): AcademyExercise {
  if (transform === "IDENTITY") {
    return { ...exercise, variant: transform };
  }
  const rotated = transform === "ROTATE_90";
  const width = rotated ? exercise.height : exercise.width;
  const height = rotated ? exercise.width : exercise.height;
  const transformIndex = (index: number): number => {
    const x = index % exercise.width;
    const y = Math.floor(index / exercise.width);
    if (transform === "ROTATE_90") {
      return x * width + (exercise.height - 1 - y);
    }
    if (transform === "ROTATE_180") {
      return (
        (exercise.height - 1 - y) * width +
        (exercise.width - 1 - x)
      );
    }
    return y * width + (exercise.width - 1 - x);
  };
  const cells: AcademyCell[] = Array.from(
    { length: exercise.cells.length },
    () => ({ kind: "open" }),
  );
  exercise.cells.forEach((cell, index) => {
    cells[transformIndex(index)] = cell;
  });
  return {
    ...exercise,
    variant: transform,
    width,
    height,
    cells,
    safeTargets: exercise.safeTargets.map(transformIndex).sort((a, b) => a - b),
    mineTargets: exercise.mineTargets.map(transformIndex).sort((a, b) => a - b),
  };
}

export function createEmptyAcademyProgress(): AcademyProgress {
  return {
    version: ACADEMY_CONTENT_VERSION,
    completedExerciseIds: [],
    attempts: 0,
    correctAttempts: 0,
    hintRequests: 0,
    highestHintByExercise: {},
    recentAttemptsByExercise: {},
    updatedAt: Date.now(),
  };
}

export function loadAcademyProgress(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): AcademyProgress {
  try {
    const raw = storage.getItem(ACADEMY_STORAGE_KEY);
    if (!raw) return createEmptyAcademyProgress();
    const parsed = JSON.parse(raw) as Partial<AcademyProgress>;
    if (
      parsed.version !== ACADEMY_CONTENT_VERSION ||
      !Array.isArray(parsed.completedExerciseIds) ||
      typeof parsed.attempts !== "number" ||
      typeof parsed.correctAttempts !== "number" ||
      typeof parsed.hintRequests !== "number" ||
      !parsed.highestHintByExercise ||
      typeof parsed.highestHintByExercise !== "object" ||
      !parsed.recentAttemptsByExercise ||
      typeof parsed.recentAttemptsByExercise !== "object"
    ) {
      return createEmptyAcademyProgress();
    }
    const knownIds = new Set(ACADEMY_EXERCISES.map((exercise) => exercise.id));
    return {
      version: ACADEMY_CONTENT_VERSION,
      completedExerciseIds: [
        ...new Set(
          parsed.completedExerciseIds.filter(
            (id): id is string => typeof id === "string" && knownIds.has(id),
          ),
        ),
      ],
      attempts: Math.max(0, parsed.attempts),
      correctAttempts: Math.max(0, parsed.correctAttempts),
      hintRequests: Math.max(0, parsed.hintRequests),
      highestHintByExercise: Object.fromEntries(
        Object.entries(parsed.highestHintByExercise).filter(
          ([id, level]) =>
            knownIds.has(id) &&
            typeof level === "number" &&
            level >= 0 &&
            level <= 7,
        ),
      ),
      recentAttemptsByExercise: Object.fromEntries(
        Object.entries(parsed.recentAttemptsByExercise).flatMap(
          ([id, attempts]) => {
            if (!knownIds.has(id) || !Array.isArray(attempts)) return [];
            const validAttempts = attempts
              .filter(
                (attempt): attempt is AcademyAttemptRecord =>
                  attempt !== null &&
                  typeof attempt === "object" &&
                  typeof (attempt as Partial<AcademyAttemptRecord>).correct ===
                    "boolean" &&
                  typeof (attempt as Partial<AcademyAttemptRecord>).hintLevel ===
                    "number" &&
                  [
                    "IDENTITY",
                    "ROTATE_90",
                    "ROTATE_180",
                    "MIRROR_X",
                  ].includes(
                    (attempt as Partial<AcademyAttemptRecord>)
                      .variant as AcademyTransform,
                  ),
              )
              .map((attempt) => ({
                correct: attempt.correct,
                hintLevel: Math.max(0, Math.min(7, attempt.hintLevel)),
                variant: attempt.variant,
              }))
              .slice(-10);
            return [[id, validAttempts] as const];
          },
        ),
      ),
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return createEmptyAcademyProgress();
  }
}

export function saveAcademyProgress(
  progress: AcademyProgress,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(ACADEMY_STORAGE_KEY, JSON.stringify(progress));
}

export function exercisesForChapter(
  chapterId: AcademyChapterId,
): readonly AcademyExercise[] {
  return ACADEMY_EXERCISES.filter(
    (exercise) => exercise.chapterId === chapterId,
  );
}

export function isChapterComplete(
  chapterId: AcademyChapterId,
  progress: AcademyProgress,
): boolean {
  const completed = new Set(progress.completedExerciseIds);
  return exercisesForChapter(chapterId).every((exercise) =>
    completed.has(exercise.id),
  );
}

export function isAcademyCourseComplete(
  progress: AcademyProgress,
): boolean {
  const completed = new Set(progress.completedExerciseIds);
  return ACADEMY_EXERCISES.every((exercise) =>
    completed.has(exercise.id),
  );
}

export function isExercisePracticed(
  exerciseId: string,
  progress: AcademyProgress,
): boolean {
  const attempts = progress.recentAttemptsByExercise[exerciseId] ?? [];
  if (attempts.length < 10) return false;
  const correct = attempts.filter((attempt) => attempt.correct).length;
  const withoutAdvancedHint = attempts.filter(
    (attempt) => attempt.hintLevel < 3,
  ).length;
  const variants = new Set(attempts.map((attempt) => attempt.variant));
  const coversOrientation =
    variants.has("ROTATE_90") &&
    variants.has("MIRROR_X") &&
    (variants.has("IDENTITY") || variants.has("ROTATE_180"));
  return correct >= 9 && withoutAdvancedHint >= 8 && coversOrientation;
}

export function isExerciseMastered(
  exerciseId: string,
  progress: AcademyProgress,
): boolean {
  const attempts = progress.recentAttemptsByExercise[exerciseId] ?? [];
  if (attempts.length < 10 || !isExercisePracticed(exerciseId, progress)) {
    return false;
  }
  const variants = new Set(attempts.map((attempt) => attempt.variant));
  return (
    attempts.every(
      (attempt) => attempt.correct && attempt.hintLevel === 0,
    ) &&
    variants.has("IDENTITY") &&
    variants.has("ROTATE_90") &&
    variants.has("ROTATE_180") &&
    variants.has("MIRROR_X")
  );
}

export function getChapterLearningState(
  chapterId: AcademyChapterId,
  progress: AcademyProgress,
): AcademyLearningState {
  if (!isChapterUnlocked(chapterId, progress)) return "LOCKED";
  const exercises = exercisesForChapter(chapterId);
  if (
    exercises.every((exercise) =>
      isExerciseMastered(exercise.id, progress),
    )
  ) {
    return "MASTERED";
  }
  if (
    exercises.every((exercise) =>
      isExercisePracticed(exercise.id, progress),
    )
  ) {
    return "PRACTICED";
  }
  return "LEARNING";
}

export function isChapterUnlocked(
  chapterId: AcademyChapterId,
  progress: AcademyProgress,
): boolean {
  return chapterId === 0 || isChapterComplete((chapterId - 1) as AcademyChapterId, progress);
}

export function nextAcademyExercise(
  progress: AcademyProgress,
): AcademyExercise {
  const completed = new Set(progress.completedExerciseIds);
  const nextIncomplete = ACADEMY_EXERCISES.find(
    (exercise) =>
      isChapterUnlocked(exercise.chapterId, progress) &&
      !completed.has(exercise.id),
  );
  if (nextIncomplete) return nextIncomplete;
  return ACADEMY_EXERCISES[ACADEMY_EXERCISES.length - 1]!;
}

function exerciseNeighborIndexes(
  width: number,
  height: number,
  index: number,
): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nextX = x + dx;
      const nextY = y + dy;
      if (
        nextX >= 0 &&
        nextX < width &&
        nextY >= 0 &&
        nextY < height
      ) {
        neighbors.push(nextY * width + nextX);
      }
    }
  }
  return neighbors;
}

function hashAcademyState(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Exhaustively checks the tiny teaching topology. This is intentionally
 * independent from the authored answer so a mistaken diagram cannot silently
 * teach a false conclusion.
 */
export function analyzeAcademyExercise(
  exercise: AcademyExercise,
): AcademyProofAnalysis {
  const unknownIndexes = exercise.cells.flatMap((cell, index) =>
    cell.kind === "unknown" ? [index] : [],
  );
  if (unknownIndexes.length > 16) {
    throw new RangeError("Academy proof exercises support at most 16 unknowns");
  }
  const bitByIndex = new Map(
    unknownIndexes.map((index, bit) => [index, bit] as const),
  );
  const solutions: number[] = [];
  const assignmentCount = 2 ** unknownIndexes.length;

  for (let mask = 0; mask < assignmentCount; mask += 1) {
    const valid = exercise.cells.every((cell, index) => {
      if (cell.kind !== "number") return true;
      const adjacentMines = exerciseNeighborIndexes(
        exercise.width,
        exercise.height,
        index,
      ).reduce((count, neighbor) => {
        const neighborCell = exercise.cells[neighbor];
        if (neighborCell?.kind === "known-mine") return count + 1;
        const bit = bitByIndex.get(neighbor);
        return bit === undefined ? count : count + ((mask >> bit) & 1);
      }, 0);
      return adjacentMines === cell.value;
    });
    if (valid) solutions.push(mask);
  }

  const safeTargets: number[] = [];
  const mineTargets: number[] = [];
  if (solutions.length > 0) {
    for (const index of unknownIndexes) {
      const bit = bitByIndex.get(index);
      if (bit === undefined) continue;
      const alwaysMine = solutions.every((mask) => ((mask >> bit) & 1) === 1);
      const alwaysSafe = solutions.every((mask) => ((mask >> bit) & 1) === 0);
      if (alwaysMine) mineTargets.push(index);
      if (alwaysSafe) safeTargets.push(index);
    }
  }

  const stateHash = hashAcademyState(
    JSON.stringify({
      version: ACADEMY_CONTENT_VERSION,
      width: exercise.width,
      height: exercise.height,
      cells: exercise.cells,
    }),
  );
  const constraints = exercise.cells.flatMap((cell, index) => {
    if (cell.kind !== "number") return [];
    const neighbors = exerciseNeighborIndexes(
      exercise.width,
      exercise.height,
      index,
    );
    const knownMines = neighbors.filter(
      (neighbor) => exercise.cells[neighbor]?.kind === "known-mine",
    ).length;
    const adjacentUnknowns = neighbors.filter(
      (neighbor) => exercise.cells[neighbor]?.kind === "unknown",
    );
    return [{
      sourceIndex: index,
      clue: cell.value,
      knownMines,
      unknownIndexes: adjacentUnknowns,
      remainingMines: cell.value - knownMines,
    }];
  });
  const trace: AcademyProofTrace = {
    rule: exercise.proofRule,
    constraints,
    conclusions: [
      ...safeTargets.map((index) => ({ index, kind: "safe" as const })),
      ...mineTargets.map((index) => ({ index, kind: "mine" as const })),
    ],
  };
  return {
    solutionCount: solutions.length,
    safeTargets,
    mineTargets,
    stateHash,
    proofHash: hashAcademyState(JSON.stringify(trace)),
    trace,
  };
}

export function formatAcademyProofTrace(
  exercise: AcademyExercise,
  analysis: AcademyProofAnalysis,
): string {
  const constraintText = analysis.trace.constraints
    .map((constraint) => {
      const row = Math.floor(constraint.sourceIndex / exercise.width) + 1;
      const column = (constraint.sourceIndex % exercise.width) + 1;
      return `第 ${row} 行第 ${column} 列数字 ${constraint.clue}：扣除 ${constraint.knownMines} 个已知雷后，${constraint.unknownIndexes.length} 个未知格中还需 ${constraint.remainingMines} 个雷`;
    })
    .join("；");
  const conclusionText = analysis.trace.conclusions
    .map((conclusion) => {
      const cell = exercise.cells[conclusion.index];
      const label =
        cell?.kind === "unknown" ? cell.label : `格 ${conclusion.index}`;
      return `${label} 在全部合法布置中均为${conclusion.kind === "mine" ? "雷" : "安全格"}`;
    })
    .join("，");
  return `${constraintText}。这些可见约束共有 ${analysis.solutionCount} 个合法布置；${conclusionText}。`;
}

export function evaluateAcademyAnswers(
  exercise: AcademyExercise,
  answers: Readonly<Record<number, AcademyAnswer>>,
): ExerciseEvaluation {
  const analysis = analyzeAcademyExercise(exercise);
  const expected = new Map<number, AcademyAnswer>([
    ...analysis.safeTargets.map((index) => [index, "safe"] as const),
    ...analysis.mineTargets.map((index) => [index, "mine"] as const),
  ]);
  const missingTargets = [...expected].flatMap(([index, answer]) =>
    answers[index] === answer ? [] : [index],
  );
  const wrongTargets = Object.entries(answers).flatMap(([rawIndex, answer]) => {
    const index = Number(rawIndex);
    return expected.get(index) === answer ? [] : [index];
  });
  return {
    correct: missingTargets.length === 0 && wrongTargets.length === 0,
    missingTargets,
    wrongTargets,
  };
}

export function recordAcademyAttempt(
  progress: AcademyProgress,
  exercise: AcademyExercise,
  correct: boolean,
  highestHintLevel: number,
): AcademyProgress {
  const completed = new Set(progress.completedExerciseIds);
  if (correct) completed.add(exercise.id);
  const recentAttempts = [
    ...(progress.recentAttemptsByExercise[exercise.id] ?? []),
    {
      correct,
      hintLevel: Math.max(0, Math.min(7, highestHintLevel)),
      variant: exercise.variant ?? "IDENTITY",
    },
  ].slice(-10);
  return {
    ...progress,
    completedExerciseIds: [...completed],
    attempts: progress.attempts + 1,
    correctAttempts: progress.correctAttempts + (correct ? 1 : 0),
    highestHintByExercise: {
      ...progress.highestHintByExercise,
      [exercise.id]: Math.max(
        progress.highestHintByExercise[exercise.id] ?? 0,
        highestHintLevel,
      ),
    },
    recentAttemptsByExercise: {
      ...progress.recentAttemptsByExercise,
      [exercise.id]: recentAttempts,
    },
    updatedAt: Date.now(),
  };
}

export function recordAcademyHint(
  progress: AcademyProgress,
  exercise: AcademyExercise,
  hintLevel: number,
): AcademyProgress {
  return {
    ...progress,
    hintRequests: progress.hintRequests + 1,
    highestHintByExercise: {
      ...progress.highestHintByExercise,
      [exercise.id]: Math.max(
        progress.highestHintByExercise[exercise.id] ?? 0,
        hintLevel,
      ),
    },
    updatedAt: Date.now(),
  };
}
