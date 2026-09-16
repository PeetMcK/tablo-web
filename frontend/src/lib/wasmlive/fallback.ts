/**
 * When to stop trying and hand the channel back to FFmpeg.
 *
 * One way only. A path that flapped between decoders would be worse than
 * either of them, so once this machine has failed it stays failed for the life
 * of the session.
 */

/**
 * How long the decoder gets to produce a picture once it has been fed.
 *
 * Generous on purpose: giving up costs a rebuffer and a tuner change, so it
 * should only happen when the WASM path is genuinely broken rather than merely
 * slow. The clock starts at the first segment handed to the decoder, not at
 * the open — a cold ring is empty for a few seconds and that is the device's
 * latency, not the decoder's.
 */
export const FIRST_FRAME_DEADLINE_MS = 8000;
export const STARVATION_WINDOW_MS = 30000;
export const STARVATION_LIMIT = 2;

export type FallbackEvent =
  | { kind: "first-frame"; atMs: number }
  | { kind: "init-failed" }
  | { kind: "decode-error" }
  | { kind: "starved"; atMs: number }
  | { kind: "tick"; atMs: number };

export interface FallbackState {
  startedAtMs: number;
  sawFirstFrame: boolean;
  starvations: number[];
  failed: string | null;
}

export function initialFallbackState(nowMs: number): FallbackState {
  return { startedAtMs: nowMs, sawFirstFrame: false, starvations: [], failed: null };
}

export function reduceFallback(state: FallbackState, event: FallbackEvent): FallbackState {
  if (state.failed) return state;

  switch (event.kind) {
    case "init-failed":
      return { ...state, failed: "init failed" };
    case "decode-error":
      return { ...state, failed: "decode error" };
    case "first-frame":
      return { ...state, sawFirstFrame: true };
    case "tick":
      if (!state.sawFirstFrame && event.atMs - state.startedAtMs > FIRST_FRAME_DEADLINE_MS) {
        return { ...state, failed: "no first frame" };
      }
      return state;
    case "starved": {
      const recent = [...state.starvations, event.atMs]
        .filter((at) => event.atMs - at < STARVATION_WINDOW_MS);
      return recent.length >= STARVATION_LIMIT
        ? { ...state, starvations: recent, failed: "repeated starvation" }
        : { ...state, starvations: recent };
    }
  }
}
