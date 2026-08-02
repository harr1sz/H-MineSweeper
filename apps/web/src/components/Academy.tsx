import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeAcademyExercise,
  academyExerciseCopy,
  evaluateAcademyAnswers,
  formatAcademyProofTrace,
  type AcademyAnswer,
  type AcademyExercise,
} from "../lib/academy";
import type { SoloGenerationMode } from "../lib/solo";
import {
  LEARNING_MODULES,
  LEGACY_EXERCISE_CONCEPT,
  loadAcademyProgressV3,
  recordAcademyHintV3,
  recordAcademyScenarioResult,
  saveAcademyProgressV3,
  type LearningConceptId,
} from "../lib/learning-contracts";
import {
  exerciseForScenario,
  scenariosForConcept,
  visibleBoardForAcademyExercise,
} from "../lib/academy-scenarios";
import { useLocale, type MessageId } from "../i18n";
import { AcademyFirstBoard } from "./AcademyFirstBoard";
import { AcademyChordLesson } from "./AcademyChordLesson";
import "./academy.css";

interface AcademyProps {
  readonly reducedMotion: boolean;
  readonly onExit: () => void;
  readonly onOpenSolo: (mode: SoloGenerationMode, config?: { width: number; height: number; mines: number }) => void;
}

type AcademyView = "primer" | "map" | "lesson" | "growth" | "complete";
type AcademySessionMode = "course" | "practice" | "coach" | "diagnostic";
type AcademyFeedback =
  | { readonly kind: "MESSAGE"; readonly id: MessageId }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "CORRECT_PROOF" }
  | { readonly kind: "HINT"; readonly level: number }
  | { readonly kind: "H7" }
  | {
    readonly kind: "WRONG";
    readonly reason: "EXTRA" | "MISSING" | "SHOULD_MINE" | "SHOULD_SAFE" | "UNPROVEN";
    readonly cellIndex?: number;
  };
const ACADEMY_PRIMER_KEY = "hms-academy-primer-v1";

function AcademyFlagIcon() {
  return <svg className="academy-flag-icon" viewBox="0 0 40 44" aria-hidden="true">
    <path className="academy-flag-cloth" d="M13 5h22L25 13l10 8H13z" />
    <path className="academy-flag-pole" d="M10 4h5v34h15v4H5v-4h5z" />
  </svg>;
}

function primerAdjacentMineCount(index: number, mineIndex: number | undefined): number {
  if (mineIndex === undefined) return 0;
  const x = index % 3;
  const y = Math.floor(index / 3);
  const mineX = mineIndex % 3;
  const mineY = Math.floor(mineIndex / 3);
  return Math.max(Math.abs(x - mineX), Math.abs(y - mineY)) === 1 ? 1 : 0;
}

const MODULE_TITLE_IDS = Object.fromEntries(
  LEARNING_MODULES.map(({ conceptId }) => [
    conceptId,
    `academy.module.${conceptId}` as MessageId,
  ]),
) as Record<(typeof LEARNING_MODULES)[number]["conceptId"], MessageId>;

function readPrimerComplete(): boolean {
  try {
    return window.localStorage.getItem(ACADEMY_PRIMER_KEY) === "complete";
  } catch {
    return false;
  }
}

function academyStorageAvailable(): boolean {
  try {
    const key = "hms-academy-storage-probe";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function progressPercent(progress: ReturnType<typeof loadAcademyProgressV3>): number {
  return Math.round((progress.completedScenarioIds.length / 60) * 100);
}

export function Academy({
  reducedMotion,
  onExit,
  onOpenSolo,
}: AcademyProps) {
  const { locale, t } = useLocale();
  const [progressV3, setProgressV3] = useState(loadAcademyProgressV3);
  const [storageAvailable, setStorageAvailable] = useState(academyStorageAvailable);
  const [primerComplete, setPrimerComplete] =
    useState(readPrimerComplete);
  const [view, setView] = useState<AcademyView>(() =>
    progressV3.completedScenarioIds.length === 0
      ? readPrimerComplete()
        ? "lesson"
        : "primer"
      : "map",
  );
  const [exercise, setExercise] = useState<AcademyExercise>(() =>
    exerciseForScenario(scenariosForConcept("FOUNDATIONS_NEIGHBORHOOD")[0]!),
  );
  const [sessionMode, setSessionMode] =
    useState<AcademySessionMode>("course");
  const [answerMode, setAnswerMode] = useState<AcademyAnswer>("safe");
  const [answers, setAnswers] = useState<Record<number, AcademyAnswer>>({});
  const [showExplanationSources, setShowExplanationSources] = useState(false);
  const [hintLevel, setHintLevel] = useState(0);
  const [feedback, setFeedback] = useState<AcademyFeedback>({
    kind: "MESSAGE",
    id: "academy.instructionDetailed",
  });
  const [solved, setSolved] = useState(false);
  const [logicStreak, setLogicStreak] = useState(0);
  const [primerStep, setPrimerStep] = useState(0);
  const [primerSolved, setPrimerSolved] = useState(false);
  const [primerFeedbackId, setPrimerFeedbackId] = useState<MessageId>(
    "academy.primer.start",
  );
  const [returnSoloMode, setReturnSoloMode] = useState<SoloGenerationMode>("classic");
  const [reviewContext, setReviewContext] = useState<{ width: number; height: number; mines: number; verdict: string } | null>(null);
  const [activeConceptId, setActiveConceptId] = useState<LearningConceptId | null>(null);
  const [moduleStageIndex, setModuleStageIndex] = useState(0);
  const [checkpointFailed, setCheckpointFailed] = useState(false);
  const primerLongPressRef = useRef<number | null>(null);
  const activeScenario = activeConceptId
    ? scenariosForConcept(activeConceptId)[moduleStageIndex]
    : undefined;

  const proofAnalysis = useMemo(
    () => analyzeAcademyExercise(exercise),
    [exercise],
  );
  const expectedSources = useMemo(
    () => {
      const target = Object.keys(answers).map(Number).sort((a, b) => a - b)[0];
      const relevant = target === undefined
        ? undefined
        : activeScenario?.proof
          .filter(({ targets }) => targets.includes(target))
          .sort((left, right) => left.sources.length - right.sources.length)[0];
      return [...new Set(relevant?.sources ?? activeScenario?.sourceIndexes ?? proofAnalysis.trace.constraints.map(({ sourceIndex }) => sourceIndex))];
    },
    [activeScenario, answers, proofAnalysis.trace.constraints],
  );
  const exerciseCopy = useMemo(
    () => academyExerciseCopy(exercise, locale),
    [exercise, locale],
  );
  const feedbackText = useMemo(() => {
    if (feedback.kind === "EMPTY") return "";
    if (feedback.kind === "MESSAGE") return t(feedback.id);
    if (feedback.kind === "CORRECT_PROOF") {
      return `${t("academy.correct")} ${exerciseCopy.proof}`;
    }
    if (feedback.kind === "H7") {
      return `${t("academy.h7")} ${exerciseCopy.proof}`;
    }
    if (feedback.kind === "HINT") {
      return feedback.level === 6
        ? formatAcademyProofTrace(exercise, proofAnalysis, locale)
        : exerciseCopy.hints[feedback.level - 1] ?? exerciseCopy.proof;
    }
    if (feedback.reason === "EXTRA") return t("academy.wrongExtra");
    if (feedback.reason === "MISSING") return t("academy.wrongMissing");
    const cellIndex = feedback.cellIndex;
    if (cellIndex === undefined) return t("academy.wrongExtra");
    const coordinate = t("academy.cellCoordinate", {
      row: Math.floor(cellIndex / exercise.width) + 1,
      column: (cellIndex % exercise.width) + 1,
    });
    if (feedback.reason === "SHOULD_MINE") {
      return t("academy.wrongShouldMine", { coordinate, reason: exerciseCopy.proof });
    }
    if (feedback.reason === "SHOULD_SAFE") {
      return t("academy.wrongShouldSafe", { coordinate, reason: exerciseCopy.proof });
    }
    return t("academy.wrongUnproven", { coordinate });
  }, [exercise, exerciseCopy, feedback, locale, proofAnalysis, t]);
  const isCourseComplete = LEARNING_MODULES.every(({ conceptId }) => progressV3.skills[conceptId] === "MASTERED");
  const canShowCourseSummary = isCourseComplete && activeConceptId === LEARNING_MODULES.at(-1)?.conceptId && moduleStageIndex === 4;
  const isModuleEnd = activeScenario?.stage === "CHECKPOINT";
  const visibleTeachingBoard = useMemo(
    () => activeScenario?.board ?? visibleBoardForAcademyExercise(exercise),
    [activeScenario, exercise],
  );
  const isFirstBoardLesson = activeConceptId === "FOUNDATIONS_FIRST_BOARD";
  const isChordLesson = activeConceptId === "PRACTICE_SAFE_CHORD";
  const isInteractiveBoardLesson = isFirstBoardLesson || isChordLesson;

  useEffect(
    () => () => {
      if (primerLongPressRef.current !== null) {
        window.clearTimeout(primerLongPressRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const prefix = "#/academy/practice/";
    if (!window.location.hash.startsWith(prefix)) return;
    const route = window.location.hash.slice(prefix.length);
    const [rawConceptId, rawQuery = ""] = route.split("?");
    const conceptId = decodeURIComponent(rawConceptId ?? "");
    const requestedMode = new URLSearchParams(rawQuery).get("mode");
    const query = new URLSearchParams(rawQuery);
    if (requestedMode === "classic" || requestedMode === "no_guess") {
      setReturnSoloMode(requestedMode);
    }
    const width = Number(query.get("width"));
    const height = Number(query.get("height"));
    const mines = Number(query.get("mines"));
    const verdict = query.get("verdict") ?? "";
    if ([width, height, mines].every(Number.isSafeInteger) && width > 0 && height > 0 && mines > 0 && verdict.length <= 64) {
      setReviewContext({ width, height, mines, verdict });
    }
    const matchedConcept = LEARNING_MODULES.some((module) => module.conceptId === conceptId)
      ? conceptId as LearningConceptId
      : null;
    const firstScenario = matchedConcept ? scenariosForConcept(matchedConcept)[0] : undefined;
    if (matchedConcept && firstScenario) {
      setActiveConceptId(matchedConcept);
      setModuleStageIndex(0);
      openExercise(exerciseForScenario(firstScenario), "practice");
    }
    // The deep link is evaluated once when the Academy route opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistV3 = (next: typeof progressV3) => {
    setProgressV3(next);
    try { saveAcademyProgressV3(next); } catch { setStorageAvailable(false); }
  };

  const openExercise = (
    next: AcademyExercise,
    nextMode: AcademySessionMode = "course",
  ) => {
    setExercise(next);
    setSessionMode(nextMode);
    setAnswers({});
    setShowExplanationSources(false);
    setCheckpointFailed(false);
    setHintLevel(0);
    setSolved(false);
    setFeedback({ kind: "MESSAGE", id: "academy.instruction" });
    setView("lesson");
  };

  const openContinue = () => {
    if (!primerComplete) {
      setView("primer");
      return;
    }
    const module = LEARNING_MODULES.find(({ conceptId }) => progressV3.skills[conceptId] !== "MASTERED") ?? LEARNING_MODULES.at(-1);
    if (!module) return;
    const scenarios = scenariosForConcept(module.conceptId);
    const completed = new Set(progressV3.completedScenarioIds);
    const nextIndex = Math.max(0, scenarios.findIndex(({ id }) => !completed.has(id)));
    const scenario = scenarios[nextIndex] ?? scenarios[0];
    if (!scenario) return;
    setActiveConceptId(module.conceptId);
    setModuleStageIndex(nextIndex);
    openExercise(exerciseForScenario(scenario), "course");
  };

  const solvePrimerStep = (messageId: MessageId) => {
    setPrimerSolved(true);
    setPrimerFeedbackId(messageId);
  };

  const continuePrimer = () => {
    if (!primerSolved) return;
    const operationScenario = scenariosForConcept("FOUNDATIONS_OPERATIONS")[primerStep];
    if (operationScenario) {
      const nextV3 = recordAcademyScenarioResult(progressV3, operationScenario, true, 0);
      persistV3(nextV3);
    }
    if (primerStep < 4) {
      const nextStep = primerStep + 1;
      setPrimerStep(nextStep);
      setPrimerSolved(false);
      setPrimerFeedbackId(
        nextStep === 1
          ? "academy.primer.flagInstruction"
          : nextStep === 2
            ? "academy.primer.chordInstruction"
            : nextStep === 3
              ? "academy.primer.independentInstruction"
              : "academy.primer.checkpointInstruction",
      );
      return;
    }
    try { window.localStorage.setItem(ACADEMY_PRIMER_KEY, "complete"); } catch { setStorageAvailable(false); }
    setPrimerComplete(true);
    if (activeConceptId === "FOUNDATIONS_OPERATIONS") {
      setView("map");
      return;
    }
    const firstLogicScenario = scenariosForConcept("FOUNDATIONS_NEIGHBORHOOD")[0];
    if (firstLogicScenario) {
      setActiveConceptId("FOUNDATIONS_NEIGHBORHOOD");
      setModuleStageIndex(0);
      openExercise(exerciseForScenario(firstLogicScenario), "course");
    }
  };

  const clearPrimerLongPress = () => {
    if (primerLongPressRef.current !== null) {
      window.clearTimeout(primerLongPressRef.current);
      primerLongPressRef.current = null;
    }
  };

  const openPractice = () => {
    const unlocked = LEARNING_MODULES.filter(({ conceptId }) => progressV3.skills[conceptId] !== "LOCKED");
    const module = unlocked[progressV3.totalAttempts % Math.max(1, unlocked.length)] ?? LEARNING_MODULES[0];
    if (!module) return;
    const scenarios = scenariosForConcept(module.conceptId);
    const index = progressV3.totalAttempts % Math.max(1, scenarios.length);
    const scenario = scenarios[index];
    if (!scenario) return;
    setActiveConceptId(module.conceptId);
    setModuleStageIndex(index);
    openExercise(exerciseForScenario(scenario), "practice");
    setFeedback({ kind: "MESSAGE", id: "academy.practiceIntro" });
  };

  const openCoach = () => {
    openContinue();
    setFeedback({ kind: "MESSAGE", id: "academy.coachIntro" });
  };

  const openDiagnostic = () => {
    const unlocked = LEARNING_MODULES.filter(({ conceptId }) => progressV3.skills[conceptId] !== "LOCKED");
    const module = unlocked[progressV3.totalAttempts % Math.max(1, unlocked.length)] ?? LEARNING_MODULES[0];
    const scenario = module ? scenariosForConcept(module.conceptId).find(({ stage }) => stage === "CHECKPOINT") : undefined;
    if (!module || !scenario) return;
    setActiveConceptId(module.conceptId);
    setModuleStageIndex(4);
    openExercise(exerciseForScenario(scenario), "diagnostic");
    setFeedback({ kind: "MESSAGE", id: "academy.diagnosticIntro" });
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
    setFeedback({ kind: "EMPTY" });
  };

  const checkAnswer = () => {
    if (Object.keys(answers).length === 0) {
      setFeedback({ kind: "MESSAGE", id: "academy.needTarget" });
      return;
    }
    const evaluation = evaluateAcademyAnswers(exercise, answers);
    const answerCorrect = evaluation.correct;
    setShowExplanationSources(true);
    const conceptId = activeConceptId ?? LEGACY_EXERCISE_CONCEPT[exercise.id];
    if (conceptId) {
      const scenario = activeScenario;
      const nextV3 = recordAcademyScenarioResult(
        progressV3,
        {
          id: scenario?.id ?? `${exercise.id}:${exercise.variant ?? "IDENTITY"}`,
          conceptId,
          unseenCheckpoint: scenario?.unseenCheckpoint ?? (
            (sessionMode === "practice" || sessionMode === "diagnostic") &&
            (exercise.variant ?? "IDENTITY") !== "IDENTITY"
          ),
        },
        answerCorrect,
        hintLevel,
      );
      persistV3(nextV3);
    }
    if (answerCorrect) {
      setCheckpointFailed(false);
      setLogicStreak((current) => (hintLevel === 0 ? current + 1 : 0));
      setSolved(true);
      setFeedback({ kind: "CORRECT_PROOF" });
      return;
    }
    setCheckpointFailed(activeScenario?.stage === "CHECKPOINT");
    setLogicStreak(0);
    const firstWrongTarget = evaluation.wrongTargets[0];
    setFeedback(evaluation.wrongTargets.length === 0
      ? { kind: "WRONG", reason: "MISSING" }
      : firstWrongTarget === undefined
        ? { kind: "WRONG", reason: "EXTRA" }
        : proofAnalysis.mineTargets.includes(firstWrongTarget)
          ? { kind: "WRONG", reason: "SHOULD_MINE", cellIndex: firstWrongTarget }
          : proofAnalysis.safeTargets.includes(firstWrongTarget)
            ? { kind: "WRONG", reason: "SHOULD_SAFE", cellIndex: firstWrongTarget }
            : { kind: "WRONG", reason: "UNPROVEN", cellIndex: firstWrongTarget });
  };

  const completeFirstBoard = () => {
    if (!activeScenario || solved) return;
    persistV3(recordAcademyScenarioResult(progressV3, activeScenario, true, hintLevel));
    setSolved(true);
    setFeedback({ kind: "MESSAGE", id: "academy.correct" });
  };

  const requestHint = () => {
    const nextLevel = Math.min(6, hintLevel + 1);
    if (nextLevel === hintLevel) return;
    setLogicStreak(0);
    setHintLevel(nextLevel);
    if (nextLevel >= 4) setShowExplanationSources(true);
    if (activeScenario) persistV3(recordAcademyHintV3(progressV3, activeScenario.id, nextLevel));
    setFeedback({ kind: "HINT", level: nextLevel });
  };

  const revealAnswer = () => {
    const demonstrated: Record<number, AcademyAnswer> = {};
    for (const index of proofAnalysis.safeTargets) demonstrated[index] = "safe";
    for (const index of proofAnalysis.mineTargets) demonstrated[index] = "mine";
    for (const index of exercise.undeterminedTargets ?? []) demonstrated[index] = "undetermined";
    setAnswers(demonstrated);
    setHintLevel(7);
    setShowExplanationSources(true);
    setLogicStreak(0);
    if (activeScenario) persistV3(recordAcademyHintV3(progressV3, activeScenario.id, 7));
    setFeedback({ kind: "H7" });
  };

  const openNext = () => {
    if (canShowCourseSummary) {
      setView("complete");
      return;
    }
    if (activeConceptId) {
      const scenarios = scenariosForConcept(activeConceptId);
      const nextStageIndex = Math.min(moduleStageIndex + 1, scenarios.length - 1);
      const nextScenario = scenarios[nextStageIndex];
      if (nextScenario && nextStageIndex !== moduleStageIndex) {
        setModuleStageIndex(nextStageIndex);
        openExercise(exerciseForScenario(nextScenario), "practice");
        return;
      }
      setView("map");
      return;
    }
    setView("map");
  };

  return (
    <section
      className={`academy-shell${reducedMotion ? " reduced-motion" : ""}`}
    >
      <header className="academy-header">
        <div>
          <span className="panel-kicker">{t("academy.kicker")}</span>
          <h1>{t("academy.title")}</h1>
          <p>{t("academy.description")}</p>
        </div>
        <button className="secondary-button" type="button" onClick={onExit}>
          {t("academy.backModes")}
        </button>
      </header>

      <nav className="academy-nav" aria-label={t("academy.nav")}>
        <button
          type="button"
          aria-pressed={view === "map"}
          onClick={() => setView("map")}
        >
          {t("academy.map")}
        </button>
        <button type="button" onClick={openContinue}>
          {t("academy.continue")}
        </button>
        <button type="button" onClick={openPractice}>
          {t("academy.freePractice")}
        </button>
        <button type="button" onClick={openCoach}>
          {t("academy.coach")}
        </button>
        <button type="button" onClick={openDiagnostic}>
          {t("academy.diagnostic")}
        </button>
        <button
          type="button"
          aria-pressed={view === "growth"}
          onClick={() => setView("growth")}
        >
          {t("academy.growth")}
        </button>
        <span>{t("academy.progressPercent", { percent: progressPercent(progressV3) })}</span>
      </nav>
      {!storageAvailable && <div className="academy-storage-warning" role="status">{t("academy.storageUnavailable")}</div>}
      {reviewContext && <div className="academy-review-context" role="status">{t("academy.reviewContext", {
        width: reviewContext.width,
        height: reviewContext.height,
        mines: reviewContext.mines,
      })}</div>}

      {view === "primer" && (
        <div className="academy-primer">
          <div className="academy-primer-copy">
            <span className="panel-kicker">{t("academy.primer.kicker")}</span>
            <h2>{t("academy.primer.title")}</h2>
            <p>{t("academy.primer.description")}</p>
            <ol>
              <li className={primerStep === 0 ? "is-current" : ""}>{t("academy.primer.reveal")}</li>
              <li className={primerStep === 1 ? "is-current" : ""}>{t("academy.primer.flag")}</li>
              <li className={primerStep === 2 ? "is-current" : ""}>{t("academy.primer.chord")}</li>
              <li className={primerStep === 3 ? "is-current" : ""}>{t("academy.primer.independent")}</li>
              <li className={primerStep === 4 ? "is-current" : ""}>{t("academy.primer.checkpoint")}</li>
            </ol>
          </div>
          <div className="academy-primer-stage">
            <span className="meta-label">{t("academy.primer.boardProgress", { current: primerStep + 1 })}</span>
            {primerStep === 0 && (
              <div className="primer-grid" aria-label={t("academy.primer.revealBoardAria")}>
                {Array.from({ length: 9 }, (_, index) => index === 4 ? (
                  <button
                    className={`primer-cell${primerSolved ? " is-revealed is-empty" : ""}`}
                    type="button"
                    key={index}
                    onClick={() => solvePrimerStep("academy.primer.revealSuccess")}
                  >{primerSolved ? "" : "?"}</button>
                ) : <span className="primer-cell is-revealed is-empty" aria-label={t("academy.primer.openBlankAria")} key={index} />)}
              </div>
            )}
            {primerStep === 1 && (
              <div className="primer-grid" aria-label={t("academy.primer.flagBoardAria")}>
                {Array.from({ length: 9 }, (_, index) => {
                  if (index === 4) return <button
                    className={`primer-cell${primerSolved ? " is-flagged" : ""}`}
                    type="button"
                    key={index}
                    aria-label={t("academy.primer.flagAria")}
                    onClick={() => { if (!primerSolved) setPrimerFeedbackId("academy.primer.leftClick"); }}
                    onContextMenu={(event) => { event.preventDefault(); solvePrimerStep("academy.primer.flagSuccess"); }}
                    onKeyDown={(event) => { if (event.key.toLowerCase() !== "f") return; event.preventDefault(); solvePrimerStep("academy.primer.keyboardSuccess"); }}
                    onPointerCancel={clearPrimerLongPress}
                    onPointerDown={(event) => {
                      if (event.pointerType !== "touch") return;
                      clearPrimerLongPress();
                      primerLongPressRef.current = window.setTimeout(() => {
                        primerLongPressRef.current = null;
                        solvePrimerStep("academy.primer.touchSuccess");
                      }, 350);
                    }}
                    onPointerUp={clearPrimerLongPress}
                  >{primerSolved ? <AcademyFlagIcon /> : "?"}</button>;
                  const value = primerAdjacentMineCount(index, 4);
                  return <span
                    className={`primer-cell is-revealed${value === 0 ? " is-empty" : ` number-${value}`}`}
                    aria-label={t(value === 0 ? "academy.primer.openBlankAria" : "academy.primer.openNumberAria", { value })}
                    key={index}
                  >{value || ""}</span>;
                })}
              </div>
            )}
            {primerStep === 3 && (
              <div className="primer-grid" aria-label={t("academy.primer.independentBoardAria")}>
                {Array.from({ length: 9 }, (_, index) => {
                  const mineIndex = 0;
                  const safeIndex = 2;
                  if (index === mineIndex) return <button
                    className={`primer-cell${primerSolved ? " is-flagged" : ""}`}
                    type="button"
                    key={index}
                    aria-label={t("academy.primer.independentMineAria")}
                    onClick={() => { if (!primerSolved) setPrimerFeedbackId("academy.primer.leftClick"); }}
                    onContextMenu={(event) => { event.preventDefault(); solvePrimerStep("academy.primer.independentSuccess"); }}
                    onKeyDown={(event) => { if (event.key.toLowerCase() !== "f") return; event.preventDefault(); solvePrimerStep("academy.primer.independentSuccess"); }}
                    onPointerCancel={clearPrimerLongPress}
                    onPointerDown={(event) => {
                      if (event.pointerType !== "touch") return;
                      clearPrimerLongPress();
                      primerLongPressRef.current = window.setTimeout(() => {
                        primerLongPressRef.current = null;
                        solvePrimerStep("academy.primer.independentSuccess");
                      }, 350);
                    }}
                    onPointerUp={clearPrimerLongPress}
                  >{primerSolved ? <AcademyFlagIcon /> : "?"}</button>;
                  const value = primerAdjacentMineCount(index, mineIndex);
                  if (index === safeIndex && !primerSolved) return <button
                    className="primer-cell"
                    type="button"
                    key={index}
                    aria-label={t("academy.primer.independentSafeAria")}
                    onClick={() => setPrimerFeedbackId("academy.primer.independentWrong")}
                    onContextMenu={(event) => { event.preventDefault(); setPrimerFeedbackId("academy.primer.independentWrong"); }}
                  >?</button>;
                  return <span
                    className={`primer-cell is-revealed${value === 0 ? " is-empty" : ` number-${value}`}`}
                    aria-label={t(value === 0 ? "academy.primer.openBlankAria" : "academy.primer.openNumberAria", { value })}
                    key={index}
                  >{value || ""}</span>;
                })}
              </div>
            )}
            {(primerStep === 2 || primerStep === 4) && (
              <div className="primer-grid" aria-label={t("academy.primer.chordBoardAria")}>
                {Array.from({ length: 9 }, (_, index) => {
                  const flagIndex = primerStep === 4 ? 5 : 3;
                  const safeIndex = primerStep === 4 ? 3 : 5;
                  if (index === flagIndex) return <span className="primer-cell is-flagged" key={index} aria-label={t("academy.primer.flaggedMine")}><AcademyFlagIcon /></span>;
                  if (index === 4) return <button className="primer-cell is-revealed number-1" type="button" key={index} aria-label={t("academy.primer.expandClueAria")} onClick={() => solvePrimerStep("academy.primer.expandSuccess")}>1</button>;
                  const value = primerAdjacentMineCount(index, flagIndex);
                  if (index === safeIndex) return <button
                    className={`primer-cell${primerSolved ? ` is-revealed${value === 0 ? " is-empty" : ` number-${value}`}` : ""}`}
                    type="button"
                    key={index}
                    aria-label={t("academy.primer.revealSafeAria")}
                    onClick={() => solvePrimerStep("academy.primer.revealSafeSuccess")}
                  >{primerSolved ? (value || "") : "?"}</button>;
                  return <span
                    className={`primer-cell is-revealed${value === 0 ? " is-empty" : ` number-${value}`}`}
                    aria-label={t(value === 0 ? "academy.primer.openBlankAria" : "academy.primer.openNumberAria", { value })}
                    key={index}
                  >{value || ""}</span>;
                })}
              </div>
            )}
            <div className="academy-primer-feedback" aria-live="polite">
              {t(primerFeedbackId)}
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!primerSolved}
              onClick={continuePrimer}
            >
              {t(primerStep === 4 ? "academy.primer.enter" : "academy.primer.next")}
            </button>
          </div>
        </div>
      )}

      {view === "map" && (
        <div className="academy-map">
          <div className="academy-map-intro">
            <span className="panel-kicker">{t("academy.courseKicker")}</span>
            <h2>{t("academy.mapTitle")}</h2>
            <p>
              {t("academy.mapDescription")}
            </p>
            <button className="primary-button" type="button" onClick={openContinue}>
              {progressV3.completedScenarioIds.length === 0
                ? t("academy.start")
                : t("academy.resume")}
            </button>
          </div>
          <div className="academy-tier-list">
            {(["FOUNDATIONS", "REASONING", "PRACTICE"] as const).map((tier) => (
              <section key={tier} className="academy-tier">
                <span className="panel-kicker">{t(`academy.tierKicker.${tier}` as MessageId)}</span>
                <h3>{t(tier === "FOUNDATIONS" ? "academy.tier.foundations" : tier === "REASONING" ? "academy.tier.reasoning" : "academy.tier.practice")}</h3>
                <div>
                  {LEARNING_MODULES.filter((module) => module.tier === tier).map((module) => (
                    <button
                      type="button"
                      key={module.conceptId}
                      disabled={progressV3.skills[module.conceptId] === "LOCKED"}
                      onClick={() => {
                        if (module.conceptId === "FOUNDATIONS_OPERATIONS") {
                          setActiveConceptId(module.conceptId);
                          setModuleStageIndex(0);
                          setPrimerStep(0);
                          setPrimerSolved(false);
                          setPrimerFeedbackId("academy.primer.start");
                          setView("primer");
                        } else {
                          const firstScenario = scenariosForConcept(module.conceptId)[0];
                          if (firstScenario) {
                            setActiveConceptId(module.conceptId);
                            setModuleStageIndex(0);
                            openExercise(exerciseForScenario(firstScenario), "practice");
                          }
                        }
                      }}
                    >
                      <small>{t(`academy.skill.${progressV3.skills[module.conceptId]}` as MessageId)}</small>
                      <strong>{t(MODULE_TITLE_IDS[module.conceptId])}</strong>
                      <span>{t("academy.moduleStages", { count: scenariosForConcept(module.conceptId).length })}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {view === "complete" && (
        <div className="academy-course-complete">
          <span className="panel-kicker">{t("academy.completeKicker")}</span>
          <h2>{t("academy.completeTitle")}</h2>
          <p>{t("academy.completeDescription")}</p>
          <div className="academy-course-complete-actions">
            <button className="primary-button" type="button" onClick={openPractice}>
              {t("academy.continuePractice")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onOpenSolo("no_guess")}
            >
              {t("academy.openNoGuess")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onOpenSolo("classic")}
            >
              {t("academy.openSolo")}
            </button>
          </div>
        </div>
      )}

      {view === "growth" && (
        <div className="academy-growth">
          <span className="panel-kicker">{t("academy.growthKicker")}</span>
          <h2>{t("academy.growth")}</h2>
          <div className="academy-growth-grid">
            <div>
              <span>{t("academy.completedExercises")}</span>
              <strong>
                {progressV3.completedScenarioIds.length}/60
              </strong>
            </div>
            <div>
              <span>{t("academy.attempts")}</span>
              <strong>{progressV3.totalAttempts}</strong>
            </div>
            <div>
              <span>{t("academy.accuracy")}</span>
              <strong>
                {progressV3.totalAttempts === 0
                  ? "—"
                  : `${Math.round((progressV3.correctAttempts / progressV3.totalAttempts) * 100)}%`}
              </strong>
            </div>
            <div>
              <span>{t("academy.hintRequests")}</span>
              <strong>{progressV3.hintRequests}</strong>
            </div>
          </div>
          <p className="academy-growth-note">
            {t("academy.localProgress")}
          </p>
          <button className="primary-button" type="button" onClick={openContinue}>
            {t("academy.continue")}
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
              ← {t("academy.courseMap")}
            </button>
            <span className="panel-kicker">
              {t("academy.lessonKicker", {
                mode: t(`academy.session.${sessionMode}` as MessageId),
                chapter: String(exercise.chapterId).padStart(2, "0"),
              })}
            </span>
            {activeScenario && <div className="academy-stage-progress">
              <span>{t("academy.stageProgress", { current: moduleStageIndex + 1, total: scenariosForConcept(activeScenario.conceptId).length })}</span>
              <strong>{t(`academy.stage.${activeScenario.stage}` as MessageId)}</strong>
            </div>}
            <h2>{activeScenario ? t(MODULE_TITLE_IDS[activeScenario.conceptId]) : exerciseCopy.title}</h2>
            <p>{exerciseCopy.objective}</p>
            <div className="academy-premise">
              <span>{t("academy.premise")}</span>
              <strong>{exerciseCopy.premise}</strong>
            </div>
            <div className="academy-reason-step">
              <span>{t("academy.reasonStep")}</span>
              <strong>{showExplanationSources
                ? t("academy.reasonRevealed")
                : t("academy.reasonPrompt")}</strong>
            </div>
            <div
              className={`logic-streak${logicStreak >= 3 ? " is-active" : ""}`}
              aria-live="polite"
            >
              <span>{t("academy.logicStreak")}</span>
              <strong>×{logicStreak}</strong>
              <small>
                {logicStreak >= 3
                  ? t("academy.streakActive")
                  : t("academy.streakGoal")}
              </small>
            </div>
            {!isInteractiveBoardLesson && <div className="academy-answer-modes" role="group" aria-label={t("academy.answerModes")}>
              <button
                type="button"
                aria-pressed={answerMode === "safe"}
                onClick={() => setAnswerMode("safe")}
              >
                {t("academy.safe")}
              </button>
              <button
                type="button"
                aria-pressed={answerMode === "mine"}
                onClick={() => setAnswerMode("mine")}
              >
                {t("academy.mine")}
              </button>
              <button
                type="button"
                aria-pressed={answerMode === "undetermined"}
                onClick={() => setAnswerMode("undetermined")}
              >
                {t("academy.undetermined")}
              </button>
            </div>}
            {!isInteractiveBoardLesson && <div className="academy-lesson-actions">
              <button
                className="primary-button"
                type="button"
                disabled={solved}
                onClick={checkAnswer}
              >
                {t("academy.check")}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={hintLevel >= 6 || solved}
                onClick={requestHint}
              >
                {t("academy.hint", { level: Math.min(6, hintLevel + 1) })}
              </button>
              {hintLevel >= 6 && !solved && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={revealAnswer}
                >
                  {t("academy.showAnswer")}
                </button>
              )}
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setAnswers({});
                  setShowExplanationSources(false);
                  setSolved(false);
                  setFeedback({ kind: "MESSAGE", id: "academy.resetDone" });
                }}
              >
                {t("academy.reset")}
              </button>
            </div>}
          </aside>

          <div className="academy-workbench">
            {!isInteractiveBoardLesson && <div className="academy-board-key" aria-label={t("academy.boardKeyAria")}>
              <span><i className="is-covered">?</i>{t("academy.boardKeyCovered")}</span>
              <span><i className="is-revealed">1</i>{t("academy.boardKeyRevealed")}</span>
              <span><i className="is-flag"><AcademyFlagIcon /></i>{t("academy.boardKeyFlag")}</span>
            </div>}
            {isFirstBoardLesson
              ? <AcademyFirstBoard stageIndex={moduleStageIndex} onComplete={completeFirstBoard} />
              : isChordLesson
                ? <AcademyChordLesson stageIndex={moduleStageIndex} onComplete={completeFirstBoard} />
                : <><div
              className="academy-mini-board"
              style={{
                gridTemplateColumns: `repeat(${exercise.width}, clamp(44px, 6vw, 64px))`,
              }}
              aria-label={t("academy.practiceBoard", { title: exerciseCopy.title })}
            >
              {exercise.cells.map((cell, index) => {
                if (cell.kind === "unknown") {
                  const answer = answers[index];
                  const row = Math.floor(index / exercise.width) + 1;
                  const column = (index % exercise.width) + 1;
                  return (
                    <button
                      className={`academy-cell cell-unknown${answer ? ` answer-${answer}` : ""}`}
                      type="button"
                      key={`${exercise.id}-${index}`}
                      aria-label={t("academy.unknownCell", { label: t("academy.cellCoordinate", { row, column }), answer: answer ? t(answer === "mine" ? "academy.answer.mineLabel" : answer === "safe" ? "academy.answer.safeLabel" : "academy.answer.undeterminedLabel") : "" })}
                      onClick={() => toggleAnswer(index)}
                    >
                      <span className="academy-covered-mark">{answer
                        ? t(answer === "mine" ? "academy.answer.mineLabel" : answer === "safe" ? "academy.answer.safeLabel" : "academy.answer.undeterminedLabel")
                        : "?"}</span>
                      <small className="academy-cell-coordinate">{t("academy.cellCoordinate", { row, column })}</small>
                    </button>
                  );
                }
                if (cell.kind === "number") {
                  if (cell.value === 0) {
                    return (
                      <div
                        aria-label={t("academy.openBlankCell")}
                        className={`academy-cell cell-open is-empty${showExplanationSources && expectedSources.includes(index) ? " is-explanation-source" : ""}`}
                        key={`${exercise.id}-${index}`}
                      />
                    );
                  }
                  return (
                    <div
                      aria-label={t("academy.openNumberCell", { value: cell.value })}
                      className={`academy-cell cell-number number-${cell.value}${showExplanationSources && expectedSources.includes(index) ? " is-explanation-source" : ""}`}
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
                      aria-label={t("academy.knownMine")}
                    >
                      <AcademyFlagIcon />
                    </div>
                  );
                }
                const visibleClue = visibleTeachingBoard.clues[index] ?? -1;
                if (visibleClue < 0) {
                  return <div className="academy-cell cell-void" key={`${exercise.id}-${index}`} aria-hidden="true" />;
                }
                return (
                  <div
                    className={`academy-cell cell-open${visibleClue === 0 ? " is-empty" : ` number-${visibleClue}`}${showExplanationSources && expectedSources.includes(index) ? " is-explanation-source" : ""}`}
                    key={`${exercise.id}-${index}`}
                    aria-label={t(visibleClue === 0 ? "academy.openBlankCell" : "academy.openNumberCell", { value: visibleClue })}
                  >{visibleClue === 0 ? "" : visibleClue}</div>
                );
              })}
            </div>

            <div
              className={`academy-feedback${solved ? " is-success" : ""}`}
              aria-live="polite"
            >
              <span>
                {solved ? t("academy.reasonVerified") : t("academy.hintProgress", { level: hintLevel })}
              </span>
              <p>{feedbackText || t("academy.submitPrompt")}</p>
            </div></>}

            {(solved || hintLevel >= 6) && (exercise.undeterminedTargets?.length ?? 0) >= 2 && (
              <div className="academy-possibility-comparison">
                <strong>{t("academy.possibilities.title")}</strong>
                <div><span>{t("academy.possibilities.leftMine")}</span><span>{t("academy.possibilities.rightMine")}</span></div>
                <p>{t("academy.possibilities.conclusion")}</p>
              </div>
            )}

            {checkpointFailed && activeConceptId && (
              <button
                className="secondary-button academy-checkpoint-return"
                type="button"
                onClick={() => {
                  const scenarios = scenariosForConcept(activeConceptId);
                  const practiceIndex = Math.max(0, scenarios.map(({ stage }) => stage).lastIndexOf("INDEPENDENT"));
                  const practiceScenario = scenarios[practiceIndex];
                  if (!practiceScenario) return;
                  setModuleStageIndex(practiceIndex);
                  openExercise(exerciseForScenario(practiceScenario), "practice");
                }}
              >{t("academy.checkpointReturn")}</button>
            )}

            {solved && (
              <div className="academy-completion-actions">
                <button className="primary-button academy-next" type="button" onClick={openNext}>
                  {canShowCourseSummary
                    ? t("academy.summary")
                    : isModuleEnd
                      ? t("academy.nextLesson")
                      : t("academy.nextExercise")}
                </button>
                {isModuleEnd && (
                  <>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onOpenSolo("no_guess")}
                    >
                      {t("academy.openNoGuess")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onOpenSolo("classic")}
                    >
                      {t("academy.openSolo")}
                    </button>
                  </>
                )}
                {sessionMode === "practice" && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenSolo(returnSoloMode, reviewContext ?? undefined)}
                  >
                    {t("academy.returnSame")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
