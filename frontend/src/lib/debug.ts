/**
 * Playback / transcode diagnostics.
 *
 * Everything is prefixed `[tablo]` so the console can be filtered to just this,
 * and grouped by channel (`player`, `cache`, `hls`, `net`) so a specific area can
 * be isolated. Silence it with `localStorage["tablo:debug"] = "0"` and reload.
 */

const STYLES: Record<string, string> = {
  player: "color:#7c5bf5;font-weight:bold",
  cache: "color:#2ea043;font-weight:bold",
  hls: "color:#5b8af5;font-weight:bold",
  net: "color:#d29922;font-weight:bold",
  warn: "color:#f85149;font-weight:bold",
};

function enabled(): boolean {
  try {
    return localStorage.getItem("tablo:debug") !== "0";
  } catch {
    return true;
  }
}

function emit(channel: keyof typeof STYLES, msg: string, data?: unknown) {
  if (!enabled()) return;
  const style = STYLES[channel] ?? STYLES.player;
  const t = new Date().toLocaleTimeString([], { hour12: false });
  if (data === undefined) console.log(`%c[tablo:${channel}]%c ${t} ${msg}`, style, "");
  else console.log(`%c[tablo:${channel}]%c ${t} ${msg}`, style, "", data);
}

export const log = {
  player: (msg: string, data?: unknown) => emit("player", msg, data),
  cache: (msg: string, data?: unknown) => emit("cache", msg, data),
  hls: (msg: string, data?: unknown) => emit("hls", msg, data),
  net: (msg: string, data?: unknown) => emit("net", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
};

/** `.../w00140/seg_03.ts` → `w140/s03`, so fragment logs say where in the recording. */
export function segmentLabel(url: string): string {
  const m = /w(\d{5})\/seg_(\d{2})\.ts/.exec(url);
  if (!m) return url.split("/").pop() ?? url;
  const w = Number(m[1]);
  return `w${w}/s${m[2]} @${fmt(w * 60)}`;
}

export function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${sign}${h > 0 ? `${h}:` : ""}${String(m).padStart(h > 0 ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** True when `t` falls inside an already-transcoded region. */
export function isCached(t: number, ranges: [number, number][]): boolean {
  return ranges.some(([a, b]) => t >= a && t < b);
}

export function rangesLabel(ranges: [number, number][]): string {
  if (!ranges.length) return "none";
  return ranges.map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", ");
}

export function timeRangesToArray(tr: TimeRanges | undefined): [number, number][] {
  if (!tr) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < tr.length; i++) out.push([tr.start(i), tr.end(i)]);
  return out;
}

/**
 * Snapshot of everything relevant at once. Installed on `window` so it can be
 * called from the console mid-problem: `tabloDebug()`.
 */
export function installSnapshot(get: () => Record<string, unknown>): () => void {
  const w = window as unknown as { tabloDebug?: () => unknown };
  w.tabloDebug = () => {
    const snap = get();
    console.table?.(
      Object.entries(snap).map(([k, v]) => ({
        field: k,
        value: typeof v === "object" ? JSON.stringify(v) : String(v),
      })),
    );
    return snap;
  };
  return () => {
    delete w.tabloDebug;
  };
}
