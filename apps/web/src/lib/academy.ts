export const ACADEMY_CONTENT_VERSION = 2 as const;
export const ACADEMY_STORAGE_KEY = "hms-academy-progress-v2";

export type AcademyChapterId = 0 | 1 | 2 | 3;
export type AcademyAnswer = "safe" | "mine" | "undetermined";
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
  readonly copySourceId?: string;
  readonly chapterId: AcademyChapterId;
  readonly title: string;
  readonly objective: string;
  readonly premise: string;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly AcademyCell[];
  readonly safeTargets: readonly number[];
  readonly mineTargets: readonly number[];
  readonly undeterminedTargets?: readonly number[];
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

export interface AcademyExerciseCopy {
  readonly title: string;
  readonly objective: string;
  readonly premise: string;
  readonly proof: string;
  readonly hints: AcademyExercise["hints"];
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

const EN_CHAPTERS: Readonly<Record<AcademyChapterId, Omit<AcademyChapter, "id">>> = {
  0: { title: "Read one mine", subtitle: "A clue counts mines in its eight neighbors.", description: "Learn the two fundamental forced-mine and forced-safe rules." },
  1: { title: "Subtract first", subtitle: "A clue minus confirmed mines is the current constraint.", description: "Recalculate remaining mines as confirmed information changes." },
  2: { title: "Shared and exclusive regions", subtitle: "Compare the unknown-cell sets covered by two clues.", description: "Derive subset logic instead of memorizing 1-1 and 1-2 shapes." },
  3: { title: "Patterns, counterexamples, and practice", subtitle: "Check boundaries before identifying 1-2-1 or 1-2-2-1.", description: "Transfer proven constraints into chained fronts, safe chords, and review." },
};

export function academyChapterCopy(
  chapter: AcademyChapter,
  locale: "zh-CN" | "en-US",
): AcademyChapter {
  return locale === "en-US" ? { id: chapter.id, ...EN_CHAPTERS[chapter.id] } : chapter;
}

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

const CORE_ACADEMY_EXERCISES: readonly AcademyExercise[] = [
  {
    id: "c0-all-mine",
    chapterId: 0,
    title: "未知格数等于雷数",
    objective: "标出所有能够确定为雷的格子。",
    premise: "数字 1 旁边只剩一个未开格。",
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
    proof: "数字 1 还需要一颗雷，而旁边只剩一个未开格，所以这个格子一定是雷。",
  },
  {
    id: "c0-satisfied",
    chapterId: 0,
    title: "数字已经满足",
    objective: "找出确定安全的格子。",
    premise: "数字 1 旁边已经有一颗确认的雷。",
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
    proof: "数字 1 需要的一颗雷已经找到，其他相邻未开格都安全。",
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
      "请选择“标雷”，再点唯一的盖住格。",
      "这个盖住格是雷；数字 2 扣掉已确认的雷后，还差 1 颗。",
    ),
    proof: "数字 2 减去已经确认的一颗雷，还差一颗；旁边只剩一个未开格，所以它一定是雷。",
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
    proof: "数字 2 需要的两颗雷都已经找到，所以旁边剩余的未开格安全。",
  },
  {
    id: "c2-subset-safe",
    chapterId: 2,
    title: "两个 1：多出来的格安全",
    objective: "比较两个数字覆盖的范围，找出确定安全的格子。",
    premise: "两个数字都是 1；其中一个数字覆盖的未开格，完全包含在另一个数字的范围里。",
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
      "先点亮两个数字 1，再分别看它们周围还有哪些格子盖着。",
      "其中一个数字旁边的盖住格，完全包含在另一个数字旁边的盖住格中。",
      "两个数字都只需要一颗雷。",
      "较大范围多出来的格子不能再放雷。",
      "请选择“判安全”，再点较大范围多出来的格子。",
      "进阶说法：两个约束雷数相同，因此它们的差异区域含 0 颗雷。",
    ),
    proof: "两个数字都只需要一颗雷，而较小范围已经包含这颗雷，所以较大范围多出来的格子安全。",
  },
  {
    id: "c2-subset-mine",
    chapterId: 2,
    title: "1 和 2：多出来的格是雷",
    objective: "比较两个数字覆盖的范围，找出确定是雷的格子。",
    premise: "较小范围需要一颗雷，较大范围需要两颗雷，而且较大范围只多出一个未开格。",
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
      "先点亮数字 1 和数字 2，再分别看它们周围还有哪些格子盖着。",
      "数字 2 旁边的盖住格包含了数字 1 的全部范围，并且只多一个格子。",
      "数字 2 比数字 1 多需要一颗雷。",
      "多出来的范围只有一个格子，所以那颗雷只能在那里。",
      "请选择“标雷”，再点多出来的格子。",
      "进阶说法：两个约束相减后，差异区域含 1 颗雷。",
    ),
    proof: "较大范围比小范围多需要一颗雷，又只多出一个格子，所以多出的格子一定是雷。",
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
      "左边的 1 说明左侧两格中有一颗雷；右边的 1 说明右侧两格中也有一颗雷。",
      "中间的 2 要求三格中共有两颗雷，因此中间格只能安全。",
      "给两侧盖住格标雷，把中间盖住格判为安全。",
      "最终只有一种摆法：两侧是雷、中间安全；结论来自数字关系，不是死记口诀。",
    ),
    proof:
      "两侧数字 1 各需要一颗雷，中间数字 2 需要两颗；因此两侧未开格是雷，中间未开格安全。",
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
      "先从两端的数字 1 开始观察。",
      "左端的 1 说明左侧两格中恰有一颗雷；紧邻的 2 还需要再多一颗。",
      "右端也是同样的关系：靠中间的 2 比末端的 1 多需要一颗雷。",
      "因此中间两格都必须是雷。",
      "给中间两格标雷，把两侧盖住格判为安全。",
      "最终只有一种摆法：两侧安全、中间两格是雷；前提是周围没有漏掉其他盖住格。",
    ),
    proof:
      "从两端的数字 1 逐步比较到中间两个数字 2，可以确定中间两个未开格是雷、两侧未开格安全。",
  },
] as const;

const RAW_ACADEMY_EXERCISES: readonly AcademyExercise[] = [
  ...CORE_ACADEMY_EXERCISES,
  {
    id: "practice-chained-fronts",
    chapterId: 3,
    title: "先找安全格，再继续推理",
    objective: "先比较两个数字 1 找到安全格，再把这个结论用于旁边的数字 2。",
    premise: "一个数字 1 旁边盖着的格子，完全包含在另一个数字 1 的范围里；旁边还有一个数字 2。",
    width: 4,
    height: 2,
    cells: [
      { kind: "unknown", label: "A" },
      { kind: "unknown", label: "B" },
      { kind: "unknown", label: "C" },
      { kind: "unknown", label: "D" },
      { kind: "number", value: 1 },
      { kind: "number", value: 1 },
      { kind: "number", value: 2 },
      { kind: "open" },
    ],
    safeTargets: [0, 2],
    mineTargets: [1, 3],
    proofRule: "SUBSET_SAFE",
    hints: sixHints(
      "先只看两个数字 1，不要急着处理数字 2。",
      "范围较大的数字 1，比另一个数字 1 多覆盖一个盖住的格子。",
      "两个数字都只需要一颗雷，所以多出来的那个格一定安全。",
      "把这个安全结论带到数字 2：它旁边另外两个盖住格都必须是雷。",
      "最后回到范围较小的数字 1，就能确定剩下那个盖住格安全。",
      "顺序是：两个 1 先找出安全格；数字 2 再找出两颗雷；最后确定剩余安全格。",
    ),
    proof: "两个数字 1 先证明它们范围中多出来的格子安全；数字 2 接着证明另外两个盖住格是雷；最后剩余的盖住格也能确定安全。",
  },
  {
    ...CORE_ACADEMY_EXERCISES[1]!,
    id: "practice-safe-chord",
    chapterId: 3,
    title: "安全地快速展开周围格",
    objective: "使用数字快速展开周围格前，先确认相邻旗的位置确实有依据。",
    premise: "旗是玩家判断；数量相等不代表旗的位置正确。",
  },
  {
    ...CORE_ACADEMY_EXERCISES[6]!,
    id: "practice-unseen-transfer",
    chapterId: 3,
    title: "未见真实棋盘迁移",
    objective: "在干扰数字与不同几何下重新建立约束，而不是背图形。",
    premise: "先写集合关系，再判断定式的边界是否封闭。",
  },
  {
    id: "practice-review-clinic",
    chapterId: 3,
    title: "个人复盘诊所",
    objective: "识别一个当前无法确定、不能倒推责备的选择。",
    premise: "数字 1 左右各有一个盖住格，其中恰有一颗雷；现有信息不能区分是哪一格。",
    width: 3,
    height: 1,
    cells: [
      { kind: "unknown", label: "A" },
      { kind: "number", value: 1 },
      { kind: "unknown", label: "B" },
    ],
    safeTargets: [],
    mineTargets: [],
    undeterminedTargets: [0, 2],
    proofRule: "SINGLE_SAFE",
    hints: sixHints(
      "先数合法布置，不要查看终局答案。",
      "左边是雷、右边安全，符合数字 1。",
      "左边安全、右边是雷，也符合数字 1。",
      "两个合法布置都存在，所以没有确定性安全格或必雷格。",
      "请选择“当前无法确定”，并点选左右两个盖住格。",
      "完整推理：两种摆法都符合数字 1，因此左右两格现在都不能确定。",
    ),
    proof: "左右两个未开格中恰好有一颗雷；雷放左边或右边都符合数字 1，所以现在不能确定任何一格。",
  },
];

export function padAcademyExercise(exercise: AcademyExercise): AcademyExercise {
  const [width, height] = exercise.chapterId === 0
    ? [4, 4]
    : exercise.chapterId === 1
      ? [5, 5]
      : exercise.chapterId === 2
        ? [6, 5]
        : [6, 6];
  const offsetX = Math.floor((width - exercise.width) / 2);
  const offsetY = Math.floor((height - exercise.height) / 2);
  const remap = (index: number) => {
    const x = index % exercise.width;
    const y = Math.floor(index / exercise.width);
    return (y + offsetY) * width + x + offsetX;
  };
  const cells: AcademyCell[] = Array.from(
    { length: width * height },
    () => ({ kind: "open" }),
  );
  exercise.cells.forEach((cell, index) => {
    cells[remap(index)] = cell;
  });
  return {
    ...exercise,
    width,
    height,
    cells,
    safeTargets: exercise.safeTargets.map(remap).sort((a, b) => a - b),
    mineTargets: exercise.mineTargets.map(remap).sort((a, b) => a - b),
    ...(exercise.undeterminedTargets
      ? { undeterminedTargets: exercise.undeterminedTargets.map(remap).sort((a, b) => a - b) }
      : {}),
  };
}

/**
 * Five genuinely different boards for the first logic module. These are kept
 * outside the legacy course list so existing v2 completion data is unaffected.
 */
export const ACADEMY_NEIGHBORHOOD_EXERCISES: readonly AcademyExercise[] = ([
  {
    id: "c0-neighborhood-demo",
    chapterId: 0,
    title: "数字只统计周围八格",
    objective: "根据数字实际相邻的格子，分别找出雷和安全格。",
    premise: "棋盘里有两个盖住格：请判断哪一格是雷，哪一格可以安全揭开。",
    width: 3,
    height: 2,
    cells: [
      { kind: "unknown", label: "mine" }, { kind: "open" }, { kind: "unknown", label: "safe" },
      { kind: "number", value: 1 }, { kind: "open" }, { kind: "number", value: 0 },
    ],
    safeTargets: [2],
    mineTargets: [0],
    proofRule: "SINGLE_MINE",
    hints: sixHints(
      "先看每个数字紧挨着哪些盖住格。",
      "左下角的 1 只接触左上方那个盖住格。",
      "数字 1 需要一颗雷，所以左上方是雷。",
      "右下角是空白格，表示它周围没有雷。",
      "给左上方插旗，并把右上方判为安全。",
      "数字只统计横、竖和斜线方向紧邻的八格；更远的格子不计算。",
    ),
    proof: "左下角的数字 1 只挨着一个盖住格，所以左上方是雷；右下角的空白格周围没有雷，所以右上方安全。",
  },
  {
    id: "c0-neighborhood-zero",
    chapterId: 0,
    title: "空白格周围都安全",
    objective: "找出空白区域旁边可以直接揭开的格子。",
    premise: "已揭开的空白格表示它周围没有雷。",
    width: 3,
    height: 2,
    cells: [
      { kind: "unknown", label: "safe-1" }, { kind: "unknown", label: "safe-2" }, { kind: "unknown", label: "safe-3" },
      { kind: "number", value: 0 }, { kind: "number", value: 0 }, { kind: "number", value: 0 },
    ],
    safeTargets: [0, 1, 2],
    mineTargets: [],
    proofRule: "SINGLE_SAFE",
    hints: sixHints(
      "先看下方已经揭开的空白格。",
      "空白表示周围八格没有雷。",
      "上方三个盖住格都挨着这些空白格。",
      "因此不需要插旗。",
      "选择“判安全”，点选上方三个盖住格。",
      "三个目标格都挨着空白区域，因此只能是安全格。",
    ),
    proof: "已揭开的空白格周围不可能有雷，因此上方三个盖住格都可以安全揭开。",
  },
  {
    id: "c0-neighborhood-all-mines",
    chapterId: 0,
    title: "盖住格数量等于雷数",
    objective: "把数字 2 旁边剩余的两个盖住格都标成雷。",
    premise: "数字 2 旁边只剩两个盖住格，且还需要两颗雷。",
    width: 3,
    height: 2,
    cells: [
      { kind: "unknown", label: "mine-1" }, { kind: "unknown", label: "mine-2" }, { kind: "open" },
      { kind: "number", value: 2 }, { kind: "number", value: 2 }, { kind: "open" },
    ],
    safeTargets: [],
    mineTargets: [0, 1],
    proofRule: "SINGLE_MINE",
    hints: sixHints(
      "数一数数字 2 旁边还有几个盖住格。",
      "还需要两颗雷，也正好只剩两个盖住格。",
      "如果其中任何一格安全，数字 2 就无法满足。",
      "所以两个盖住格都必须是雷。",
      "选择“标雷”，点选上方两个盖住格。",
      "这条规则比较的是剩余雷数和剩余盖住格数量，不是看到数字 2 就随便标两格。",
    ),
    proof: "数字 2 还需要两颗雷，而旁边正好只剩两个盖住格，所以两格都是雷。",
  },
  {
    id: "c0-neighborhood-mixed",
    chapterId: 0,
    title: "一格是雷，一格安全",
    objective: "结合三个数字，区分相邻的两个盖住格。",
    premise: "左侧数字已经有一面旗；中间还剩两个盖住格需要判断。",
    width: 4,
    height: 2,
    cells: [
      { kind: "known-mine" }, { kind: "unknown", label: "mine" }, { kind: "unknown", label: "safe" }, { kind: "open" },
      { kind: "number", value: 2 }, { kind: "number", value: 2 }, { kind: "number", value: 1 }, { kind: "open" },
    ],
    safeTargets: [2],
    mineTargets: [1],
    proofRule: "SINGLE_MINE",
    hints: sixHints(
      "先从左下角的数字 2 开始。",
      "它已经有一面旗，还差一颗雷，只剩左上方盖住格可放。",
      "确定左上方是雷后，再看右侧的数字 1。",
      "数字 1 已经被这颗雷满足，所以右上方安全。",
      "给靠左的盖住格标雷，把靠右的盖住格判为安全。",
      "这次不是所有盖住格都一样：每个数字覆盖的范围不同。",
    ),
    proof: "左下数字 2 扣掉已有旗后，确定靠左盖住格是雷；右侧数字 1 随后确定另一格安全。",
  },
  {
    id: "c0-neighborhood-checkpoint",
    chapterId: 0,
    title: "别漏掉斜对角",
    objective: "在新的棋形里判断一格雷和一格安全。",
    premise: "数字也会统计斜对角相邻格；先看右上方已有的旗。",
    width: 3,
    height: 3,
    cells: [
      { kind: "unknown", label: "mine" }, { kind: "number", value: 2 }, { kind: "known-mine" },
      { kind: "open" }, { kind: "number", value: 2 }, { kind: "open" },
      { kind: "unknown", label: "safe" }, { kind: "number", value: 0 }, { kind: "open" },
    ],
    safeTargets: [6],
    mineTargets: [0],
    proofRule: "SINGLE_MINE",
    hints: sixHints(
      "先确认哪些格子与数字斜对角相邻。",
      "上方数字 2 已经接触右上角的一面旗。",
      "它还差一颗雷，只剩左上角盖住格。",
      "下方空白格说明左下角盖住格安全。",
      "给左上角插旗，把左下角判为安全。",
      "横、竖、斜线紧邻都算在八邻域中。",
    ),
    proof: "上方数字 2 扣掉已有旗后确定左上角是雷；下方空白格确定左下角安全。",
  },
] satisfies readonly AcademyExercise[]).map(padAcademyExercise);

/** Ambiguous boards with genuinely different mine counts and candidate sets. */
export const ACADEMY_UNCERTAINTY_EXERCISES: readonly AcademyExercise[] = ([
  {
    ...RAW_ACADEMY_EXERCISES.find(({ id }) => id === "practice-review-clinic")!,
    id: "uncertainty-one-of-two",
    title: "两格中有一颗雷",
  },
  {
    id: "uncertainty-one-of-three", chapterId: 3,
    title: "三格中有一颗雷", objective: "判断现有数字能否区分三个盖住格。",
    premise: "数字 1 接触三个盖住格，三种雷位都符合数字。",
    width: 3, height: 2,
    cells: [
      { kind: "unknown", label: "A" }, { kind: "unknown", label: "B" }, { kind: "unknown", label: "C" },
      { kind: "open" }, { kind: "number", value: 1 }, { kind: "open" },
    ],
    safeTargets: [], mineTargets: [], undeterminedTargets: [0, 1, 2], proofRule: "SINGLE_SAFE",
    hints: sixHints("先列出雷可能放在哪里。", "数字 1 只要求三格中有一颗雷。", "雷放左边符合。", "雷放中间或右边也符合。", "三格都选“当前无法确定”。", "有三种合法摆法，任何一格都不是必雷或必安全。"),
    proof: "三颗盖住格中只知道恰有一颗雷；雷可以在任意一格，所以目前三格都不能确定。",
  },
  {
    id: "uncertainty-two-of-three", chapterId: 3,
    title: "三格中有两颗雷", objective: "区分“雷很多”和“某格一定是雷”。",
    premise: "数字 2 接触三个盖住格，任意一格都可能是唯一的安全格。",
    width: 3, height: 2,
    cells: [
      { kind: "unknown", label: "A" }, { kind: "unknown", label: "B" }, { kind: "unknown", label: "C" },
      { kind: "open" }, { kind: "number", value: 2 }, { kind: "open" },
    ],
    safeTargets: [], mineTargets: [], undeterminedTargets: [0, 1, 2], proofRule: "SINGLE_MINE",
    hints: sixHints("不要因为雷很多就任选一格标雷。", "数字 2 只说明三格里有两颗雷。", "左格可以是唯一安全格。", "中格或右格也可以是唯一安全格。", "三格都选“当前无法确定”。", "三种合法摆法分别把安全格放在左、中、右。"),
    proof: "三格中有两颗雷，但任意一格都可能是那一格安全格，因此没有单独一格能被确定。",
  },
  {
    id: "uncertainty-two-of-four", chapterId: 3,
    title: "四个角中有两颗雷", objective: "面对更多候选格时识别信息不足。",
    premise: "中心数字 2 接触四个盖住的角，合法摆法不止一种。",
    width: 3, height: 3,
    cells: [
      { kind: "unknown", label: "A" }, { kind: "open" }, { kind: "unknown", label: "B" },
      { kind: "open" }, { kind: "number", value: 2 }, { kind: "open" },
      { kind: "unknown", label: "C" }, { kind: "open" }, { kind: "unknown", label: "D" },
    ],
    safeTargets: [], mineTargets: [], undeterminedTargets: [0, 2, 6, 8], proofRule: "SINGLE_MINE",
    hints: sixHints("中心数字只给出总数。", "四个角中需要两颗雷。", "上面两个角可以是雷。", "对角两个角也可以是雷。", "四个角都选“当前无法确定”。", "六种两雷组合都符合中心数字 2，所以没有单格结论。"),
    proof: "中心数字 2 只限定四个角中共有两颗雷；多种组合都成立，因此每个角目前都不能确定。",
  },
  {
    id: "uncertainty-one-of-four", chapterId: 3,
    title: "四格中只有一颗雷", objective: "确认全局数量仍不足以定位单格。",
    premise: "中心数字 1 接触四个盖住的角。",
    width: 3, height: 3,
    cells: [
      { kind: "unknown", label: "A" }, { kind: "open" }, { kind: "unknown", label: "B" },
      { kind: "open" }, { kind: "number", value: 1 }, { kind: "open" },
      { kind: "unknown", label: "C" }, { kind: "open" }, { kind: "unknown", label: "D" },
    ],
    safeTargets: [], mineTargets: [], undeterminedTargets: [0, 2, 6, 8], proofRule: "SINGLE_SAFE",
    hints: sixHints("先区分“总共有一颗”和“知道它在哪”。", "四个角都接触中心数字 1。", "任意一个角放雷都符合。", "其他三个角随布局改变而安全。", "四个角都选“当前无法确定”。", "四种合法摆法仍然存在，所以不能点名某一格。"),
    proof: "只知道四个角中有一颗雷，但不知道是哪一个角，所以当前不能确定任何单格。",
  },
] satisfies readonly AcademyExercise[]).map(padAcademyExercise);

export const ACADEMY_EXERCISES: readonly AcademyExercise[] =
  RAW_ACADEMY_EXERCISES.map(padAcademyExercise);

const EN_EXERCISE_COPY: Readonly<Record<string, AcademyExerciseCopy>> = {
  "c0-neighborhood-demo": { title: "Numbers count eight neighbors", objective: "Use the visible board to find one mine and one safe cell.", premise: "Two cells are covered. Decide which one is a mine and which one is safe to reveal.", proof: "The lower-left 1 has only one covered neighbor, so it is a mine. The revealed blank on the right proves its covered neighbor safe.", hints: sixHints("Start with the two covered cells.", "The lower-left 1 touches only the upper-left covered cell.", "Clue 1 needs one mine, so that cell is a mine.", "The revealed blank on the right has no neighboring mines.", "Flag the upper-left cell and mark the upper-right cell safe.", "A clue counts only the eight cells directly beside it, including diagonals.") },
  "c0-neighborhood-zero": { title: "Cells beside a blank are safe", objective: "Find the cells that can be opened beside a revealed blank area.", premise: "A revealed blank means none of its neighbors is a mine.", proof: "No mine can touch the revealed blank area, so all three covered cells are safe.", hints: sixHints("Start with the revealed blank area.", "A blank means none of its eight neighbors contains a mine.", "All three covered cells touch that blank area.", "No flag is needed.", "Choose Safe and select all three covered cells.", "All three targets can be revealed safely.") },
  "c0-neighborhood-all-mines": { title: "Covered cells equal mines needed", objective: "Flag both covered cells beside clue 2.", premise: "Clue 2 still needs two mines and has exactly two covered neighbors.", proof: "Clue 2 needs two mines and only two covered cells remain, so both are mines.", hints: sixHints("Count the covered neighbors of clue 2.", "It needs two mines and exactly two cells remain.", "If either cell were safe, clue 2 could not be satisfied.", "Therefore both covered cells are mines.", "Choose Mine and select both upper covered cells.", "Compare mines still needed with covered cells still available.") },
  "c0-neighborhood-mixed": { title: "One mine and one safe cell", objective: "Combine three clues to distinguish two adjacent covered cells.", premise: "The clue on the left already touches a flag; two covered cells remain to judge.", proof: "The lower-left 2 forces the left covered cell to be a mine. The clue 1 on the right then proves the other cell safe.", hints: sixHints("Start with the lower-left clue 2.", "It already has one flag and needs one more mine.", "After finding that mine, inspect clue 1 on the right.", "That clue is now satisfied, so its other covered neighbor is safe.", "Flag the left covered cell and mark the right one safe.", "The covered cells differ because the clues touch different areas.") },
  "c0-neighborhood-checkpoint": { title: "Do not miss diagonals", objective: "Find one mine and one safe cell in a new shape.", premise: "Clues count diagonal neighbors too; start from the flag in the upper-right corner.", proof: "After the existing flag is counted, clue 2 forces the upper-left cell to be a mine. The revealed blank proves the lower-left cell safe.", hints: sixHints("Check which cells touch each clue diagonally.", "The upper clue 2 already touches the flag in the corner.", "It needs one more mine, leaving only the upper-left covered cell.", "The revealed blank below proves the lower-left covered cell safe.", "Flag the upper-left cell and mark the lower-left cell safe.", "Horizontal, vertical, and diagonal contact all belong to the eight-neighbor area.") },
  "c0-all-mine": { title: "One covered cell left", objective: "Mark the cell that is certainly a mine.", premise: "Clue 1 has only one covered neighbor.", proof: "Clue 1 still needs one mine and has only one covered neighbor, so that cell must be the mine.", hints: sixHints("A certain conclusion exists.", "Inspect clue 1 and its only covered neighbor.", "One mine remains and one covered cell remains.", "When those counts match, the covered cell is a mine.", "Choose Mine, then select the only covered cell.", "Without that mine, clue 1 could not be satisfied.") },
  "c0-satisfied": { title: "The clue is already satisfied", objective: "Find the certainly safe cell.", premise: "Clue 1 already touches one confirmed mine.", proof: "Clue 1 already has the mine it needs, so every other covered neighbor is safe.", hints: sixHints("Ask how many mines the clue still needs.", "Clue 1 already touches a confirmed mine.", "Remaining mines: 1 - 1 = 0.", "With zero remaining mines, every other covered neighbor is safe.", "Choose Safe, then select the remaining covered cell.", "No additional mine can touch this clue.") },
  "c1-residual-mine": { title: "Residual one", objective: "Subtract confirmed mines and find the remaining mine.", premise: "Clue 2 touches one confirmed mine and one unknown.", proof: "2 minus one confirmed mine leaves one; A must be a mine.", hints: sixHints("Do not treat 2 as needing two more mines.", "Subtract the confirmed mine first.", "Remaining mines: 2 - 1 = 1.", "The only unknown must contain it.", "Choose Mine, then select A.", "A is the residual mine.") },
  "c1-residual-safe": { title: "Residual zero", objective: "Clear safe cells after a clue is satisfied.", premise: "Clue 2 already touches two confirmed mines.", proof: "2 minus two confirmed mines leaves zero; the other unknown is safe.", hints: sixHints("Recalculate the clue after confirmed mines.", "Both required mines are already known.", "Remaining mines: 2 - 2 = 0.", "Every other unknown neighbor is safe.", "Choose Safe and select the remaining unknown.", "No additional mine can touch clue 2.") },
  "c2-subset-safe": { title: "Two 1s: the extra cell is safe", objective: "Compare the areas covered by two clues and find the certainly safe cell.", premise: "Both clues need one mine, and one covered area fully contains the other.", proof: "Both clues need the same single mine. The smaller area already contains it, so the cell that appears only in the larger area is safe.", hints: sixHints("Compare which covered cells touch each 1.", "One clue covers every cell covered by the other, plus one more.", "Both clues still need one mine.", "The extra cell cannot add another mine.", "Choose Safe, then select the extra cell.", "Subset subtraction is the technical name for this comparison.") },
  "c2-subset-mine": { title: "1 and 2: the extra cell is a mine", objective: "Compare the areas covered by two clues and find the certain mine.", premise: "The larger area needs one more mine and contains exactly one extra covered cell.", proof: "The larger area needs one additional mine and has only one extra cell, so that cell must be the mine.", hints: sixHints("Compare the covered cells around 1 and 2.", "The clue 2 area contains the clue 1 area plus one cell.", "The larger area needs one additional mine.", "Only the extra cell can supply it.", "Choose Mine, then select the extra cell.", "Subset subtraction is the technical name for this comparison.") },
  "c3-pattern-121": { title: "1-2-1 with conditions", objective: "Derive the pattern from overlapping sets and reject invalid geometry.", premise: "The unknown frontier is closed and confirmed mines have been subtracted.", proof: "The outer cells are mines and the middle cell is safe under the closed 1-2-1 constraints.", hints: sixHints("Check the frontier boundary before naming a pattern.", "Write each clue as a set equation.", "Compare the left and middle equations.", "Repeat on the right.", "Mark the outer targets Mine and the center Safe.", "The conclusion follows from the equations, not the visual label.") },
  "c3-pattern-1221": { title: "1-2-2-1 with conditions", objective: "Solve the four-cell frontier from overlapping constraints.", premise: "All relevant unknown neighbors are shown and prior mines are subtracted.", proof: "The two middle cells are mines and the two outer cells are safe.", hints: sixHints("Start from both end constraints.", "Write the left pair of equations.", "Write the right pair of equations.", "Subtract to isolate both middle cells.", "Mark the middle cells Mine and the outer cells Safe.", "The unique solution is safe, mine, mine, safe.") },
  "practice-chained-fronts": { title: "Find a safe cell, then keep reasoning", objective: "Compare the two clues marked 1, then carry the safe result into the nearby clue 2.", premise: "One clue 1 covers every covered cell seen by the other clue 1, plus one extra covered cell.", proof: "The two clues marked 1 first prove that their extra covered cell is safe. Clue 2 then identifies two mines, and the remaining covered cell becomes safe.", hints: sixHints("Start with only the two clues marked 1.", "One of them covers one more cell than the other.", "Both need one mine, so that extra covered cell is safe.", "Carry that safe result into clue 2; its other two covered neighbors must be mines.", "Return to the clue 1 with the smaller covered area to identify the last safe cell.", "Order: find one safe cell from the two 1s, identify two mines from clue 2, then identify the final safe cell.") },
  "practice-safe-chord": { title: "Safely open several neighbors", objective: "Before double-clicking a clue, verify that every adjacent flag has a reason.", premise: "A matching flag count does not prove that the flags are correctly placed.", proof: "The clue is satisfied by a confirmed mine, so the remaining cell is safe.", hints: sixHints("Separate flag count from flag correctness.", "Verify every flag against visible clues.", "Recalculate the remaining mine count.", "Double-click the clue only after the flags are justified.", "Mark the remaining cell Safe.", "A flag in the wrong place can make a matching count reveal a mine.") },
  "practice-unseen-transfer": { title: "Transfer to an unseen board", objective: "Rebuild constraints under new geometry and distracting clues.", premise: "Check the closed frontier before applying a familiar pattern.", proof: "The transformed geometry preserves the same set equations and conclusions.", hints: sixHints("Ignore orientation.", "List the unknown set for each clue.", "Check for extra unseen neighbors.", "Compare the resulting equations.", "Apply only the conclusion supported by the sets.", "Rotation changes coordinates, not logic.") },
  "practice-review-clinic": { title: "Personal review clinic", objective: "Recognize a choice that cannot be judged yet and avoid hindsight blame.", premise: "Exactly one of the two covered cells is a mine, but the visible clue cannot distinguish them.", proof: "Putting the mine on the left or on the right both satisfies clue 1, so neither cell is currently determined.", hints: sixHints("List valid layouts without looking at final truth.", "Mine on the left and safe on the right works.", "Safe on the left and mine on the right also works.", "Both layouts remain possible.", "Choose Currently undetermined for both cells.", "Technically, the constraint has two solutions and no forced variable.") },
  "uncertainty-one-of-two": { title: "One mine in two cells", objective: "Recognize that neither covered cell is determined.", premise: "Either side can contain the one mine.", proof: "Both placements satisfy clue 1, so neither cell is forced.", hints: sixHints("List possible placements.", "The left cell can contain the mine.", "The right cell can contain the mine.", "Both layouts work.", "Mark both Currently undetermined.", "No single cell has the same result in every valid layout.") },
  "uncertainty-one-of-three": { title: "One mine in three cells", objective: "Decide whether the clue distinguishes the three covered cells.", premise: "Clue 1 touches three covered cells.", proof: "The mine can occupy any of the three cells, so all remain undetermined.", hints: sixHints("List possible mine positions.", "Only the total is known.", "The left placement works.", "The middle and right placements work too.", "Mark all three Currently undetermined.", "Three valid layouts remain.") },
  "uncertainty-two-of-three": { title: "Two mines in three cells", objective: "Separate a high mine count from a forced single cell.", premise: "Any cell can be the only safe one.", proof: "Each cell is safe in one valid layout and a mine in others, so none is determined.", hints: sixHints("Do not flag an arbitrary cell.", "Only the total of two mines is known.", "The left cell can be safe.", "The middle or right cell can be safe too.", "Mark all three Currently undetermined.", "Three valid layouts remain.") },
  "uncertainty-two-of-four": { title: "Two mines in four corners", objective: "Recognize insufficient information with more candidates.", premise: "The center 2 touches four covered corners.", proof: "Several pairs of corners satisfy clue 2, so no corner is forced.", hints: sixHints("The clue gives only a total.", "Two of four corners are mines.", "The top pair works.", "A diagonal pair works too.", "Mark all four Currently undetermined.", "Six valid pairs remain.") },
  "uncertainty-one-of-four": { title: "One mine in four cells", objective: "See that a global count may still not locate a cell.", premise: "The center 1 touches four covered corners.", proof: "Any corner can hold the mine, so no individual corner is determined.", hints: sixHints("Separate knowing the total from knowing the location.", "All four corners touch clue 1.", "Any one corner can be the mine.", "The other cells change with the layout.", "Mark all four Currently undetermined.", "Four valid layouts remain.") },
};

export function academyExerciseCopy(
  exercise: AcademyExercise,
  locale: "zh-CN" | "en-US",
): AcademyExerciseCopy {
  if (locale === "en-US") return EN_EXERCISE_COPY[exercise.copySourceId ?? exercise.id] ?? {
    title: exercise.title,
    objective: exercise.objective,
    premise: exercise.premise,
    proof: exercise.proof,
    hints: exercise.hints,
  };
  return exercise;
}

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
    ...(exercise.undeterminedTargets
      ? { undeterminedTargets: exercise.undeterminedTargets.map(transformIndex).sort((a, b) => a - b) }
      : {}),
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
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  const constraintText = analysis.trace.constraints
    .map((constraint) => {
      const row = Math.floor(constraint.sourceIndex / exercise.width) + 1;
      const column = (constraint.sourceIndex % exercise.width) + 1;
      return locale === "en-US"
        ? `Clue ${constraint.clue} at row ${row}, column ${column}: after subtracting ${constraint.knownMines} confirmed mines, ${constraint.remainingMines} mines remain across ${constraint.unknownIndexes.length} unknown cells`
        : `第 ${row} 行第 ${column} 列数字 ${constraint.clue}：扣除 ${constraint.knownMines} 个已知雷后，${constraint.unknownIndexes.length} 个未知格中还需 ${constraint.remainingMines} 个雷`;
    })
    .join("；");
  const conclusionText = analysis.trace.conclusions
    .map((conclusion) => {
      const row = Math.floor(conclusion.index / exercise.width) + 1;
      const column = (conclusion.index % exercise.width) + 1;
      const label = locale === "en-US"
        ? `row ${row}, column ${column}`
        : `第 ${row} 行第 ${column} 列`;
      return locale === "en-US"
        ? `${label} is ${conclusion.kind === "mine" ? "a mine" : "safe"} in every valid layout`
        : `${label} 在全部合法布置中均为${conclusion.kind === "mine" ? "雷" : "安全格"}`;
    })
    .join("，");
  return locale === "en-US"
    ? `${constraintText}. These visible constraints admit ${analysis.solutionCount} valid layouts; ${conclusionText}.`
    : `${constraintText}。这些可见约束共有 ${analysis.solutionCount} 个合法布置；${conclusionText}。`;
}

export function evaluateAcademyAnswers(
  exercise: AcademyExercise,
  answers: Readonly<Record<number, AcademyAnswer>>,
): ExerciseEvaluation {
  const analysis = analyzeAcademyExercise(exercise);
  const expected = new Map<number, AcademyAnswer>([
    ...analysis.safeTargets.map((index) => [index, "safe"] as const),
    ...analysis.mineTargets.map((index) => [index, "mine"] as const),
    ...(exercise.undeterminedTargets ?? []).map((index) => [index, "undetermined"] as const),
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
