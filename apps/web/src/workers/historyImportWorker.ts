import {
  SOLO_HISTORY_IMPORT_MAX_BYTES,
  parseSoloHistoryImportDocument,
  type SoloHistoryExportV2,
} from "../lib/solo-history";

export type HistoryImportWorkerRequest = {
  readonly requestId: number;
  readonly type: "PARSE_AND_VERIFY_IMPORT";
  readonly file: File;
};

export type HistoryImportWorkerResponse =
  | {
      readonly requestId: number;
      readonly type: "RESULT";
      readonly ok: true;
      readonly document: SoloHistoryExportV2;
    }
  | {
      readonly requestId: number;
      readonly type: "RESULT";
      readonly ok: false;
      readonly errorCode: "IMPORT_TOO_LARGE" | "IMPORT_READ_FAILED" | "IMPORT_INVALID";
    };

self.addEventListener("message", async (event: MessageEvent<HistoryImportWorkerRequest>) => {
  const { file, requestId } = event.data;
  if (file.size > SOLO_HISTORY_IMPORT_MAX_BYTES) {
    self.postMessage({ requestId, type: "RESULT", ok: false, errorCode: "IMPORT_TOO_LARGE" } satisfies HistoryImportWorkerResponse);
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    self.postMessage({ requestId, type: "RESULT", ok: false, errorCode: "IMPORT_READ_FAILED" } satisfies HistoryImportWorkerResponse);
    return;
  }
  try {
    const document = parseSoloHistoryImportDocument(text);
    self.postMessage({ requestId, type: "RESULT", ok: true, document } satisfies HistoryImportWorkerResponse);
  } catch {
    self.postMessage({ requestId, type: "RESULT", ok: false, errorCode: "IMPORT_INVALID" } satisfies HistoryImportWorkerResponse);
  }
});
