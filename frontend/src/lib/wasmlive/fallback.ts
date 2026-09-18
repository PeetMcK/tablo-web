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

/**
 * There is no starvation rule, deliberately.
 *
 * There was one, and it could not detect what it was named for. It asked how
 * far the clock had outrun the newest queued field — but the session ticks the
 * presenter first, which removes every field that is due, so a decoder that had
 * genuinely fallen behind emptied the queue and read *zero*. The only way to
 * read anything large was a stale field or two trickling in after a seek, which
 * is a different bug wearing this one's clothes. Two consecutive animation
 * frames — 33ms — then ended the session.
 *
 * Neither reference does anything like it. ffplay's `AV_NOSYNC_THRESHOLD` of
 * ten seconds is the point at which it stops *correcting* drift, not a point at
 * which it quits; jsmpeg drops audio to stay live and also never quits.
 *
 * What remains is the frozen-picture watchdog in `session.ts`, which measures
 * presentations rather than timestamps: a picture that has stopped is a real
 * failure and an empty queue does cause it. A rebuffer is not a failure, and
 * the session now says so through `waiting`/`playing` instead.
 */

export type FallbackEvent =
  | { kind: "first-frame"; atMs: number }
  | { kind: "init-failed" }
  | { kind: "decode-error" }
  /**
   * Our own backend says the session no longer exists.
   *
   * The one failure here that is known rather than inferred. Sessions live in
   * memory, so a backend restart or the 120s idle reaper takes one out from
   * under a player that is still holding its playlist, and every request after
   * that answers 404 for ever. Waiting for the frozen-picture watchdog to
   * notice costs six seconds of requests that cannot succeed.
   */
  | { kind: "session-gone" }
  | { kind: "tick"; atMs: number };

export interface FallbackState {
  startedAtMs: number;
  sawFirstFrame: boolean;
  failed: string | null;
}

export function initialFallbackState(nowMs: number): FallbackState {
  return { startedAtMs: nowMs, sawFirstFrame: false, failed: null };
}

export function reduceFallback(state: FallbackState, event: FallbackEvent): FallbackState {
  if (state.failed) return state;

  switch (event.kind) {
    case "init-failed":
      return { ...state, failed: "init failed" };
    case "decode-error":
      return { ...state, failed: "decode error" };
    case "session-gone":
      return { ...state, failed: "session gone" };
    case "first-frame":
      return { ...state, sawFirstFrame: true };
    case "tick":
      if (!state.sawFirstFrame && event.atMs - state.startedAtMs > FIRST_FRAME_DEADLINE_MS) {
        return { ...state, failed: "no first frame" };
      }
      return state;
  }
}
