/**
 * Per-recording resume positions.
 *
 * Held by the server rather than this browser. They used to live in
 * localStorage, which meant a position was tied to one browser profile and
 * vanished when site data was cleared; the same recording resumed from
 * different places depending on where you opened it.
 *
 * The URL is unaffected and still carries identity only - what is playing, not
 * where the playhead is. That was the reason positions were kept out of the
 * address bar originally, and it is unchanged.
 *
 * Reads stay synchronous. Callers use them during render (deciding where to
 * open a player), so this keeps an in-memory copy hydrated once at startup and
 * writes back in the background. A write is reflected locally at once, so the
 * UI never waits on the round trip.
 */

import { api } from "../api/tablo";

/** Don't bother resuming a few seconds in, or once effectively finished. */
const MIN_RESUME = 30;
const END_MARGIN = 60;

/** The key positions were kept under before they moved server-side. */
const LEGACY_KEY = "tablo:resume";

/** Playback saves about once a second; batching keeps that off the network. */
const FLUSH_DELAY_MS = 5000;

const cache = new Map<string, number>();
const pending = new Map<string, { position: number; duration: number }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;

export function resumeKey(kind: "live" | "recording", id: string | number): string {
  return `${kind}:${id}`;
}

function split(key: string): { kind: string; ref: string } | null {
  const [kind, ...rest] = key.split(":");
  const ref = rest.join(":");
  if (!ref || (kind !== "live" && kind !== "recording")) return null;
  return { kind, ref };
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = [...pending.entries()];
  pending.clear();
  await Promise.all(batch.map(async ([key, { position, duration }]) => {
    const parts = split(key);
    if (!parts) return;
    try {
      await api.putResume(parts.kind, parts.ref, position, duration);
    } catch {
      /* a lost position is a small annoyance, not worth surfacing or retrying */
    }
  }));
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

/**
 * Read positions from the server, handing over anything this browser still
 * holds locally.
 *
 * The import is one-shot: the server keeps whatever it already has, so a
 * replay cannot rewind someone who has since watched further. Only once it
 * succeeds is the local copy removed.
 */
export async function hydrateResume(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, { t: number } | number>;
      const entries: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const seconds = typeof value === "number" ? value : value?.t;
        if (typeof seconds === "number") entries[key] = seconds;
      }
      if (Object.keys(entries).length) {
        await api.importResume(entries);
      }
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* nothing to hand over, or it was unreadable */
  }

  try {
    const stored = await api.resumeAll();
    for (const [key, position] of Object.entries(stored)) {
      // A position saved during this session is newer than what the fetch
      // returned, so it must not be overwritten by it.
      if (!pending.has(key)) cache.set(key, position);
    }
  } catch {
    /* offline or not signed in — positions simply start empty */
  }
}

export function loadResume(key: string): number {
  return cache.get(key) ?? 0;
}

export function saveResume(key: string, seconds: number, duration: number): void {
  // Near the end counts as watched: resuming there would drop you on the credits.
  if (seconds < MIN_RESUME || (duration > 0 && seconds > duration - END_MARGIN)) {
    clearResume(key);
    return;
  }
  const position = Math.floor(seconds);
  cache.set(key, position);
  pending.set(key, { position, duration });
  scheduleFlush();
}

export function clearResume(key: string): void {
  cache.delete(key);
  // Zero is how the server is told to forget a position, rather than a separate
  // delete call that could race the pending write for the same key.
  pending.set(key, { position: 0, duration: 0 });
  scheduleFlush();
}

/** Push anything still queued. Called when the page is being hidden or closed. */
export function flushResume(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size) void flush();
}

export function __resetResumeForTests(): void {
  cache.clear();
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  hydrated = false;
}
