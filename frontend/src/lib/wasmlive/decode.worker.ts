/**
 * Worker entry point: wiring only.
 *
 * The decoder runs here rather than on the page so that a 1080i stream being
 * decoded never competes with rendering. All the logic is in
 * `workerProtocol.ts` and `libavClient.ts`.
 */

import { createDecoder } from "./libavClient";
import { createWorkerHandler } from "./workerProtocol";
import type { ToWorker } from "./workerProtocol";

const handle = createWorkerHandler(
  () => createDecoder(),
  (message, transfer) => self.postMessage(message, transfer),
);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  void handle(event.data);
};
