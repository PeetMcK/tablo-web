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
  codec?: string | null,
): Eligibility {
  // On unless explicitly switched off. Deliberately ungated for now: the point
  // of this pass is to find every way the WASM path breaks under the real
  // player, which means letting it take every channel a viewer opens rather
  // than only the ones someone thought to test.
  //
  // `tablo.wasmlive = "0"` remains the kill switch. Private mode, or a browser
  // set to block site data, throws on read; that reads as unset, which is now
  // on, so the exception path is the same as everyone else's.
  const flag = readFlag(storage);
  if (flag === "0") return { eligible: false, reason: "flag off" };

  // A guide row without a kind is a broadcast until proven otherwise, which is
  // the assumption the transcode branch already makes.
  if (channelKind === "ott") return { eligible: false, reason: "ott channel" };

  // Same statement about the same thing: this decoder plays MPEG-2 and nothing
  // else. A recording the box encoded itself is H.264, and handing that here
  // produces "Codec not found" — a dead player where the browser could have
  // decoded it natively. The device says which, so it is answerable before
  // anything opens. Null means it did not say, which takes MPEG-2's path.
  if (codec === "h264") return { eligible: false, reason: "h264 recording" };

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
