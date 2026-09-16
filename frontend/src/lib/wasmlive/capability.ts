/**
 * Who gets the WASM path, and what to ask the backend for.
 *
 * Desktop Chrome/Edge with the flag on, on anything not known to be OTT.
 * Everything else takes the transcode, which is what it takes today, so
 * refusing here costs a viewer nothing.
 */

export const WASMLIVE_FLAG = "tablo.wasmlive";

export type LiveMode = "transcode" | "raw" | "ring";

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Constructors that must exist. WebGL2 is checked again at session start by
 * actually asking for a context: a machine with acceleration disabled has the
 * class and no context behind it.
 */
const REQUIRED = [
  "OffscreenCanvas",
  "AudioWorkletNode",
  "WebAssembly",
  "WebGL2RenderingContext",
] as const;

function readFlag(storage: Pick<Storage, "getItem">): string | null {
  try {
    return storage.getItem(WASMLIVE_FLAG);
  } catch {
    return null;
  }
}

export function wasmLiveEligible(
  win: { navigator: { userAgent: string } },
  storage: Pick<Storage, "getItem">,
  channelKind: string | null | undefined,
): Eligibility {
  // Private mode, or a browser set to block site data, throws on read. Treat
  // that as off rather than letting a storage exception take the player down.
  const flag = readFlag(storage);
  if (!flag || flag === "0") return { eligible: false, reason: "flag off" };

  // A guide row without a kind is a broadcast until proven otherwise, which is
  // the assumption the transcode branch already makes.
  if (channelKind === "ott") return { eligible: false, reason: "ott channel" };

  const ua = win.navigator.userAgent;
  const isChromeFamily = /Chrome\/|Edg\//.test(ua) && !/CriOS|Android/.test(ua);
  if (!isChromeFamily) return { eligible: false, reason: "unsupported browser" };

  for (const api of REQUIRED) {
    if (!(api in (win as object))) return { eligible: false, reason: `no ${api}` };
  }
  return { eligible: true, reason: "" };
}

/** Which backend mode to ask for, and whether we intend to decode it ourselves. */
export function chooseLivePath(
  eligibility: Eligibility,
  channelKind: string | null | undefined,
): { mode: LiveMode; wasm: boolean } {
  if (eligibility.eligible) return { mode: "ring", wasm: true };
  // OTT is already H.264 and plays through the proxy untouched. Everything
  // else is a broadcast, and a broadcast without WASM needs the transcode —
  // raw MPEG-2 in a <video> is a black frame and silence.
  return channelKind === "ott"
    ? { mode: "raw", wasm: false }
    : { mode: "transcode", wasm: false };
}
