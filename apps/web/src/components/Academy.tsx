import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACADEMY_CHAPTERS,
  ACADEMY_EXERCISES,
  analyzeAcademyExercise,
  evaluateAcademyAnswers,
  exercisesForChapter,
  formatAcademyProofTrace,
  getChapterLearningState,
  isAcademyCourseComplete,
  isChapterComplete,
  isChapterUnlocked,
  loadAcademyProgress,
  nextAcademyExercise,
  recordAcademyAttempt,
  recordAcademyHint,
  saveAcademyProgress,
  transformAcademyExercise,
  type AcademyAnswer,
  type AcademyChapterId,
  type AcademyExercise,
  type AcademyProgress,
} from "../lib/academy";
import type { SoloGenerationMode } from "../lib/solo";
import "./academy.css";

interface AcademyProps {
  readonly reducedMotion: boolean;
  readonly onExit: () => void;
  readonly onOpenSolo: (mode: SoloGenerationMode) => void;
}

type AcademyView = "primer" | "map" | "lesson" | "growth" | "complete";
type AcademySessionMode = "course" | "practice" | "coach";
const ACADEMY_PRIMER_KEY = "hms-academy-primer-v1";

function readPrimerComplete(): boolean {
  return window.localStorage.getItem(ACADEMY_PRIMER_KEY) === "complete";
}

function progressPercent(progress: AcademyProgress): number {
  return Math.round(
    (progress.completedExerciseIds.length / ACADEMY_EXERCISES.length) * 100,
  );
}

function answerLabel(answer: AcademyAnswer): string {
  return answer === "mine" ? "雷" : "安全";
}

export function Academy({
  reducedMotion,
  onExit,
  onOpenSolo,
}: AcademyProps) {
  const [progress, setProgress] = useState(loadAcademyProgress);
  const [primerComplete, setPrimerComplete] =
    useState(readPrimerComplete);
  const [view, setView] = useState<AcademyView>(() =>
    progress.attempts === 0
      ? readPrimerComplete()
        ? "lesson"
        : "primer"
      : "map",
  );
  const [exercise, setExercise] = useState<AcademyExercise>(() =>
    nextAcademyExercise(progress),
  );
  const [sessionMode, setSessionMode] =
    useState<AcademySessionMode>("course");
  const [answerMode, setAnswerMode] = useState<AcademyAnswer>("safe");
  const [answers, setAnswers] = useState<Record<number, AcademyAnswer>>({});
  const [hintLevel, setHintLevel] = useState(0);
  const [feedback, setFeedback] = useState(
    "选择“判安全”或“标雷”，再点所有能够确定的未知格。",
  );
  const [solved, setSolved] = useState(false);
  const [logicStreak, setLogicStreak] = useState(0);
  const [primerStep, setPrimerStep] = useState(0);
  const [primerSolved, setPrimerSolved] = useState(false);
  const [primerFeedback, setPrimerFeedback] = useState(
    "先点击未知格，看看揭格会发生什么。",
  );
  const primerLongPressRef = useRef<number | null>(null);

  const completed = useMemo(
    () => new Set(progress.completedExerciseIds),
    [progress.completedExerciseIds],
  );
  const proofAnalysis = useMemo(
    () => analyzeAcademyExercise(exercise),
    [exercise],
  );
  const chapterExercises = exercisesForChapter(exercise.chapterId);
  const isChapterEnd =
    chapterExercises[chapterExercises.length - 1]?.id === exercise.id;
  const isFinalExercise =
    ACADEMY_EXERCISES[ACADEMY_EXERCISES.length - 1]?.id === exercise.id;
  const isCourseComplete = isAcademyCourseComplete(progress);
  const canShowCourseSummary =
    sessionMode === "course" && isFinalExercise && isCourseComplete;

  useEffect(
    () => () => {
      if (primerLongPressRef.current !== null) {
        window.clearTimeout(primerLongPressRef.current);
      }
    },
    [],
  );

  const persist = (next: AcademyProgress) => {
    setProgress(next);
    saveAcademyProgress(next);
  };

  const openExercise = (
    next: AcademyExercise,
    nextMode: AcademySessionMode = "course",
  ) => {
    setExercise(next);
    setSessionMode(nextMode);
    setAnswers({});
    setHintLevel(0);
    setSolved(false);
    setFeedback("选择判断类型，再点所有能够确定的未知格。");
    setView("lesson");
  };

  const openContinue = () => {
    if (!primerComplete) {
      setView("primer");
      return;
    }
    openExercise(nextAcademyExercise(progress));
  };

  const solvePrimerStep = (message: string) => {
    setPrimerSolved(true);
    setPrimerFeedback(message);
  };

  const continuePrimer = () => {
    if (!primerSolved) return;
    if (primerStep < 2) {
      const nextStep = primerStep + 1;
      setPrimerStep(nextStep);
      setPrimerSolved(false);
      setPrimerFeedback(
        nextStep === 1
          ? "现在给确定是雷的格子插旗：右键、长按 350ms，或按 F。"
          : "旗数满足数字后，点击已揭数字执行和弦，一次展开周围安全格。",
      );
      return;
    }
    window.localStorage.setItem(ACADEMY_PRIMER_KEY, "complete");
    setPrimerComplete(true);
    setFeedback("选择“判安全”或“标雷”，再点所有能够确定的未知格。");
    setView("lesson");
  };

  const clearPrimerLongPress = () => {
    if (primerLongPressRef.current !== null) {
      window.clearTimeout(primerLongPressRef.current);
      primerLongPressRef.current = null;
    }
  };

  const openPractice = () => {
    const unlocked = ACADEMY_EXERCISES.filter((candidate) =>
      isChapterUnlocked(candidate.chapterId, progress),
    );
    const selected =
      unlocked[progress.attempts % Math.max(1, unlocked.length)] ??
      nextAcademyExercise(progress);
    const transforms = [
      "IDENTITY",
      "MIRROR_X",
      "ROTATE_90",
      "ROTATE_180",
    ] as const;
    openExercise(
      transformAcademyExercise(
        selected,
        transforms[progress.attempts % transforms.length] ?? "IDENTITY",
      ),
      "practice",
    );
    setFeedback("自由练习不会主动给答案；需要时仍可逐级请求提示。");
  };

  const openCoach = () => {
    openExercise(nextAcademyExercise(progress), "coach");
    setFeedback("教练陪练已就位：先描述数字还差几颗雷，再提交判断。");
  };

  const toggleAnswer = (index: number) => {
    if (solved) return;
    setAnswers((current) => {
      if (current[index] === answerMode) {
        const next = { ...current };
        delete next[index];
        return next;
      }
      return { ...current, [index]: answerMode };
    });
    setFeedback("");
  };

  const checkAnswer = () => {
    const evaluation = evaluateAcademyAnswers(exercise, answers);
    const next = recordAcademyAttempt(
      progress,
      exercise,
      evaluation.correct,
      hintLevel,
    );
    persist(next);
    if (evaluation.correct) {
      setLogicStreak((current) => (hintLevel === 0 ? current + 1 : 0));
      setSolved(true);
      setFeedback(
        `判断正确。${exercise.proof} · PROOF ${proofAnalysis.stateHash}`,
      );
      return;
    }
    setLogicStreak(0);
    setFeedback(
      evaluation.wrongTargets.length > 0
        ? "有选择超出了当前逻辑能证明的范围。先检查数字覆盖的邻域。"
        : "还有能够确定的格子没有标出。可以逐级请求提示。",
    );
  };

  const requestHint = () => {
    const nextLevel = Math.min(6, hintLevel + 1);
    if (nextLevel === hintLevel) return;
    setLogicStreak(0);
    setHintLevel(nextLevel);
    persist(recordAcademyHint(progress, exercise, nextLevel));
    const hint = exercise.hints[nextLevel - 1] ?? exercise.proof;
    setFeedback(
      nextLevel === 6
        ? `${formatAcademyProofTrace(exercise, proofAnalysis)} · PROOF ${proofAnalysis.proofHash}`
        : hint,
    );
  };

  const revealAnswer = () => {
    const demonstrated: Record<number, AcademyAnswer> = {};
    for (const index of proofAnalysis.safeTargets) demonstrated[index] = "safe";
    for (const index of proofAnalysis.mineTargets) demonstrated[index] = "mine";
    setAnswers(demonstrated);
    setHintLevel(7);
    setLogicStreak(0);
    persist(recordAcademyHint(progress, exercise, 7));
    setFeedback(
      `H7 演示已标注，但仍需你检查并提交。${exercise.proof} · PROOF ${proofAnalysis.stateHash}`,
    );
  };

  const openNext = () => {
    if (canShowCourseSummary) {
      setView("complete");
      return;
    }
    if (sessionMode === "practice") {
      openPractice();
      return;
    }
    if (sessionMode === "coach") {
      openCoach();
      return;
    }
    const currentIndex = ACADEMY_EXERCISES.findIndex(
      (entry) => entry.id === exercise.id,
    );
    const next =
      ACADEMY_EXERCISES.slice(currentIndex + 1).find((candidate) =>
        isChapterUnlocked(candidate.chapterId, progress),
      ) ?? nextAcademyExercise(progress);
    openExercise(next, sessionMode);
  };

  return (
    <section
      className={`academy-shell${reducedMotion ? " reduced-motion" : ""}`}
    >
      <header className="academy-header">
        <div>
          <span className="panel-kicker">H-MINESWEEPER / ACADEMY</span>
          <h1>扫雷学院</h1>
          <p>先学会为什么，再练习有多快。所有答案都来自当前棋形的逻辑约束。</p>
        </div>
        <button className="secondary-button" type="button" onClick={onExit}>
          返回模式选择
        </button>
      </header>

      <nav className="academy-nav" aria-label="学院导航">
        <button
          type="button"
          aria-pressed={view === "map"}
          onClick={() => setView("map")}
        >
          课程地图
        </button>
        <button type="button" onClick={openContinue}>
          继续学习
        </button>
        <button type="button" onClick={openPractice}>
          自由练习
        </button>
        <button type="button" onClick={openCoach}>
          教练陪练
        </button>
        <button
          type="button"
          aria-pressed={view === "growth"}
          onClick={() => setView("growth")}
        >
          我的成长
        </button>
        <span>{progressPercent(progress)}% COMPLETE</span>
      </nav>

      {view === "primer" && (
        <div className="academy-primer">
          <div className="academy-primer-copy">
            <span className="panel-kicker">CHAPTER 00 / 操作预热</span>
            <h2>先把三种动作做一遍</h2>
            <p>
              真实扫雷只需要揭格、插旗和和弦。这里使用与正式棋盘相同的桌面和触屏手势。
            </p>
            <ol>
              <li className={primerStep === 0 ? "is-current" : ""}>01 揭开未知格</li>
              <li className={primerStep === 1 ? "is-current" : ""}>02 标记确定雷</li>
              <li className={primerStep === 2 ? "is-current" : ""}>03 点击数字和弦</li>
            </ol>
          </div>
          <div className="academy-primer-stage">
            <span className="meta-label">MICRO BOARD · {primerStep + 1}/3</span>
            {primerStep === 0 && (
              <button
                className={`primer-cell${primerSolved ? " is-revealed" : ""}`}
                type="button"
                onClick={() =>
                  solvePrimerStep("揭格成功。数字 1 表示它周围八格里共有一颗雷。")
                }
              >
                {primerSolved ? "1" : "?"}
              </button>
            )}
            {primerStep === 1 && (
              <button
                className={`primer-cell${primerSolved ? " is-flagged" : ""}`}
                type="button"
                aria-label="练习插旗：右键、长按或按 F"
                onClick={() => {
                  if (!primerSolved) {
                    setPrimerFeedback("左键用于揭格；这里请试试右键、长按或 F。");
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  solvePrimerStep("插旗成功。旗是你的判断标记，不会替你验证雷图。");
                }}
                onKeyDown={(event) => {
                  if (event.key.toLowerCase() !== "f") return;
                  event.preventDefault();
                  solvePrimerStep("插旗成功。键盘玩家可用 F 快速切换旗标。");
                }}
                onPointerCancel={clearPrimerLongPress}
                onPointerDown={(event) => {
                  if (event.pointerType !== "touch") return;
                  clearPrimerLongPress();
                  primerLongPressRef.current = window.setTimeout(() => {
                    primerLongPressRef.current = null;
                    solvePrimerStep("长按插旗成功。移动端长按阈值为 350ms。");
                  }, 350);
                }}
                onPointerUp={clearPrimerLongPress}
              >
                {primerSolved ? (
                  <span className="academy-flag-icon" aria-hidden="true" />
                ) : (
                  "?"
                )}
              </button>
            )}
            {primerStep === 2 && (
              <div className="primer-chord-board">
                <span className="primer-cell is-flagged" aria-label="已标记的雷">
                  <span className="academy-flag-icon" aria-hidden="true" />
                </span>
                <button
                  className="primer-cell is-revealed"
                  type="button"
                  aria-label="数字 1，点击执行和弦"
                  onClick={() =>
                    solvePrimerStep("和弦成功。只有相邻旗数等于数字时，周围未知格才会展开。")
                  }
                >
                  1
                </button>
                <span className={`primer-cell${primerSolved ? " is-open" : ""}`}>
                  {primerSolved ? "·" : "?"}
                </span>
              </div>
            )}
            <div className="academy-primer-feedback" aria-live="polite">
              {primerFeedback}
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!primerSolved}
              onClick={continuePrimer}
            >
              {primerStep === 2 ? "进入第一道逻辑题" : "下一步"}
            </button>
          </div>
        </div>
      )}

      {view === "map" && (
        <div className="academy-map">
          <div className="academy-map-intro">
            <span className="panel-kicker">COURSE 00–03</span>
            <h2>从单点计数，到集合推理</h2>
            <p>
              章节按顺序解锁。每个定式都配有成立条件和反例，不背脱离棋盘的口诀。
            </p>
            <button className="primary-button" type="button" onClick={openContinue}>
              {progress.completedExerciseIds.length === 0
                ? "开始第一课"
                : "继续上次进度"}
            </button>
          </div>
          <div className="academy-chapter-list">
            {ACADEMY_CHAPTERS.map((chapter) => {
              const unlocked = isChapterUnlocked(chapter.id, progress);
              const chapterComplete = isChapterComplete(chapter.id, progress);
              const learningState = getChapterLearningState(
                chapter.id,
                progress,
              );
              const chapterExercises = exercisesForChapter(chapter.id);
              return (
                <article
                  className={`academy-chapter${chapterComplete ? " is-complete" : ""}${unlocked ? "" : " is-locked"}`}
                  key={chapter.id}
                >
                  <span className="academy-chapter-number">
                    {String(chapter.id).padStart(2, "0")}
                  </span>
                  <div>
                    <small>
                      {learningState}
                    </small>
                    <h3>{chapter.title}</h3>
                    <p>{chapter.description}</p>
                    <div className="academy-exercise-links">
                      {chapterExercises.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          disabled={!unlocked}
                          onClick={() => openExercise(item)}
                        >
                          <i>{completed.has(item.id) ? "✓" : "·"}</i>
                          {item.title}
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {view === "complete" && (
        <div className="academy-course-complete">
          <span className="panel-kicker">COURSE 00–03 / COMPLETE</span>
          <h2>基础逻辑课程完成</h2>
          <p>
            你已经走过单点计数、剩余雷数、集合包含与经典定式。下一步不是重背口诀，而是在未见棋盘上把 proof 练成稳定判断。
          </p>
          <div className="academy-course-complete-actions">
            <button className="primary-button" type="button" onClick={openPractice}>
              继续自由练习
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onOpenSolo("no_guess")}
            >
              用刚学规则完成无猜图
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onOpenSolo("classic")}
            >
              返回单人游戏
            </button>
          </div>
        </div>
      )}

      {view === "growth" && (
        <div className="academy-growth">
          <span className="panel-kicker">LEARNING TELEMETRY</span>
          <h2>我的成长</h2>
          <div className="academy-growth-grid">
            <div>
              <span>完成练习</span>
              <strong>
                {progress.completedExerciseIds.length}/{ACADEMY_EXERCISES.length}
              </strong>
            </div>
            <div>
              <span>首次与重复作答</span>
              <strong>{progress.attempts}</strong>
            </div>
            <div>
              <span>正确率</span>
              <strong>
                {progress.attempts === 0
                  ? "—"
                  : `${Math.round((progress.correctAttempts / progress.attempts) * 100)}%`}
              </strong>
            </div>
            <div>
              <span>提示请求</span>
              <strong>{progress.hintRequests}</strong>
            </div>
          </div>
          <p className="academy-growth-note">
            学院成绩仅用于学习进度，永远不会进入公开排行榜。
          </p>
          <button className="primary-button" type="button" onClick={openContinue}>
            继续学习
          </button>
        </div>
      )}

      {view === "lesson" && (
        <div className="academy-lesson">
          <aside className="academy-lesson-context">
            <button
              className="academy-back"
              type="button"
              onClick={() => setView("map")}
            >
              ← 课程地图
            </button>
            <span className="panel-kicker">
              {sessionMode === "course"
                ? "COURSE"
                : sessionMode === "practice"
                  ? "FREE PRACTICE"
                  : "COACH"}{" "}
              / CHAPTER {String(exercise.chapterId).padStart(2, "0")}
            </span>
            <h2>{exercise.title}</h2>
            <p>{exercise.objective}</p>
            <div className="academy-premise">
              <span>成立条件</span>
              <strong>{exercise.premise}</strong>
              <code>STATE {proofAnalysis.stateHash}</code>
            </div>
            <div
              className={`logic-streak${logicStreak >= 3 ? " is-active" : ""}`}
              aria-live="polite"
            >
              <span>LOGIC STREAK</span>
              <strong>×{logicStreak}</strong>
              <small>
                {logicStreak >= 3
                  ? "连续无提示正确推断"
                  : "连续 3 次无提示判断可点亮"}
              </small>
            </div>
            <div className="academy-answer-modes" role="group" aria-label="判断类型">
              <button
                type="button"
                aria-pressed={answerMode === "safe"}
                onClick={() => setAnswerMode("safe")}
              >
                ◇ 判安全
              </button>
              <button
                type="button"
                aria-pressed={answerMode === "mine"}
                onClick={() => setAnswerMode("mine")}
              >
                ◆ 标雷
              </button>
            </div>
            <div className="academy-lesson-actions">
              <button
                className="primary-button"
                type="button"
                disabled={Object.keys(answers).length === 0 || solved}
                onClick={checkAnswer}
              >
                检查判断
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={hintLevel >= 6 || solved}
                onClick={requestHint}
              >
                提示 H{Math.min(6, hintLevel + 1)}
              </button>
              {hintLevel >= 6 && !solved && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={revealAnswer}
                >
                  H7 · 演示答案
                </button>
              )}
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setAnswers({});
                  setSolved(false);
                  setFeedback("已重置本题。");
                }}
              >
                重置
              </button>
            </div>
          </aside>

          <div className="academy-workbench">
            <div
              className="academy-mini-board"
              style={{
                gridTemplateColumns: `repeat(${exercise.width}, minmax(58px, 82px))`,
              }}
              aria-label={`${exercise.title} 练习棋盘`}
            >
              {exercise.cells.map((cell, index) => {
                if (cell.kind === "unknown") {
                  const answer = answers[index];
                  return (
                    <button
                      className={`academy-cell cell-unknown${answer ? ` answer-${answer}` : ""}`}
                      type="button"
                      key={`${exercise.id}-${index}`}
                      aria-label={`未知格 ${cell.label}${answer ? `，当前判断为${answerLabel(answer)}` : ""}`}
                      onClick={() => toggleAnswer(index)}
                    >
                      <span>{cell.label}</span>
                      {answer && <small>{answerLabel(answer)}</small>}
                    </button>
                  );
                }
                if (cell.kind === "number") {
                  return (
                    <div
                      className={`academy-cell cell-number number-${cell.value}`}
                      key={`${exercise.id}-${index}`}
                    >
                      {cell.value}
                    </div>
                  );
                }
                if (cell.kind === "known-mine") {
                  return (
                    <div
                      className="academy-cell cell-known-mine"
                      key={`${exercise.id}-${index}`}
                      aria-label="已确认的雷"
                    >
                      <span className="academy-mine-icon" aria-hidden="true">
                        ✹
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    className="academy-cell cell-open"
                    key={`${exercise.id}-${index}`}
                    aria-hidden="true"
                  />
                );
              })}
            </div>

            <div
              className={`academy-feedback${solved ? " is-success" : ""}`}
              aria-live="polite"
            >
              <span>
                {solved ? "PROOF VERIFIED" : `HINT LEVEL ${hintLevel}/7`}
              </span>
              <p>{feedback || "完成判断后点击“检查判断”。"}</p>
            </div>

            {solved && (
              <div className="academy-completion-actions">
                <button className="primary-button academy-next" type="button" onClick={openNext}>
                  {canShowCourseSummary
                    ? "查看课程总结"
                    : isFinalExercise
                      ? "继续未完成课程"
                    : isChapterEnd
                      ? "继续下一课"
                      : "下一题"}
                </button>
                {isChapterEnd && (
                  <>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onOpenSolo("no_guess")}
                    >
                      用刚学规则完成无猜图
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onOpenSolo("classic")}
                    >
                      返回单人游戏
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
