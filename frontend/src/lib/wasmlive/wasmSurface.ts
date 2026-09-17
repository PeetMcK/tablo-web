/**
 * The WASM session, wearing the interface the player already talks to.
 *
 * Nothing above this line knows whether the picture came from a `<video>`
 * element or from a canvas the worker fed.
 */

import type { PlaybackSurface, SurfaceEvent } from "../playbackSurface";
import type { LiveSession } from "./session";

export function createWasmSurface(session: LiveSession): PlaybackSurface {
  const handlers = new Map<SurfaceEvent, Set<() => void>>();
  let muted = false;

  return {
    async play() { session.resume(); },
    pause: () => session.pause(),
    seek: (seconds: number) => session.seek(seconds),

    get currentTime() { return session.currentTime; },
    get seekable() { return session.seekable; },
    /** Live has no length; the bar reads the window instead. */
    get duration() { return null; },
    get paused() { return session.paused; },
    get muted() { return muted; },
    setMuted(next: boolean) {
      muted = next;
      // Silence, not suspension. Suspending the context would stop the clock
      // and freeze the picture along with the sound.
      session.setMuted(next);
      handlers.get("volumechange")?.forEach((fn) => fn());
    },
    /* Read through to the sink rather than mirrored here: `muted` is kept
       locally because the session has no getter for it, but the level does,
       and two copies of the same number is how they drift. */
    get volume() { return session.volume; },
    setVolume(next: number) {
      session.setVolume(next);
      handlers.get("volumechange")?.forEach((fn) => fn());
    },
    get error() { return session.failure; },
    diagnostics: () => session.diagnostics(),

    on(event: SurfaceEvent, handler: () => void) {
      if (event === "volumechange") {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)?.delete(handler);
      }
      // A live stream has no "ended", and pausing is a local state change that
      // the player already knows it made.
      if (event === "paused" || event === "ended") return () => {};
      return session.on(event, handler);
    },

    destroy: () => session.destroy(),
  };
}
