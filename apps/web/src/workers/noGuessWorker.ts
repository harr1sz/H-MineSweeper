import {
  certifyNoGuess,
  createBoard,
} from "@h-minesweeper/game-core";
import {
  createSoloBoardSpec,
  createSoloSeed,
  type NoGuessWorkerRequest,
  type NoGuessWorkerResponse,
} from "../lib/solo";

interface WorkerScope {
  onmessage:
    | ((event: MessageEvent<NoGuessWorkerRequest>) => void)
    | null;
  postMessage(message: NoGuessWorkerResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const request = event.data;
  const startedAt = performance.now();
  let attempts = 0;

  while (
    attempts < request.maxAttempts &&
    performance.now() - startedAt < request.maxDurationMs
  ) {
    attempts += 1;
    const spec = createSoloBoardSpec(
      request.config,
      request.startIndex,
      createSoloSeed(),
    );
    const certificate = certifyNoGuess(createBoard(spec));
    if (certificate) {
      workerScope.postMessage({
        requestId: request.requestId,
        ok: true,
        spec,
        attempts,
        elapsedMs: performance.now() - startedAt,
        boardHash: certificate.boardHash,
      });
      return;
    }
  }

  workerScope.postMessage({
    requestId: request.requestId,
    ok: false,
    attempts,
    elapsedMs: performance.now() - startedAt,
    reason: "GENERATION_LIMIT",
  });
};
