/**
 * Worker entry point: wiring only.
 *
 * The decoder runs here rather than on the page so that a 1080i stream being
 * decoded never competes with rendering. All the logic is in
 * `workerProtocol.ts` and `libavClient.ts`.
 */

/// <reference lib="webworker" />

import { createDecoder } from "./libavClient";
import { createWorkerHandler } from "./workerProtocol";
import type { ToWorker } from "./workerProtocol";

const worker = self as unknown as DedicatedWorkerGlobalScope;

const handle = createWorkerHandler(
  () => createDecoder(),
  (message, transfer) => worker.postMessage(message, transfer),
);

worker.onmessage = (event: MessageEvent<ToWorker>) => {
  void handle(event.data);
};
