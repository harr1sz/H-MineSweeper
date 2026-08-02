import {
  runCoachRequest,
  type CoachSuggestion,
} from "../lib/practice-coach";

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: CoachSuggestion): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  workerScope.postMessage(runCoachRequest(event.data));
};
