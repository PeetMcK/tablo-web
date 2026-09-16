import { useEffect, useRef, useCallback, useState } from "react";
import Hls from "hls.js";
import { log, segmentLabel, fmt } from "../lib/debug";

export interface PlayerOptions {
  /**
   * Seconds of already-played media hls.js keeps buffered. Bounds how far back
   * the viewer can rewind: the default of 90s discards older media even when the
   * server still holds the segments. Pass the DVR window for live, or `Infinity`
   * for a fully-cached recording.
   */
  backBufferLength?: number;
  /**
   * Where playback begins. `-1` means hls.js decides, which for a live or EVENT
   * playlist is the live edge.
   *
   * A recording still being transcoded is served as an EVENT playlist, so the
   * default drops the viewer at the encoder's frontier — minutes into the show —
   * instead of at the start. Recordings must pass `0`.
   */
  startPosition?: number;
  /**
   * Fragment load timeout in ms. A recording segment request can block while the
   * backend transcodes its window, which the 20s default is too tight for.
   */
  fragLoadingTimeOut?: number;
  /**
   * Seconds to keep buffered ahead of the playhead.
   *
   * hls.js defaults to 30s, which is tuned for streaming over a network you do
   * not control. A cached recording is served off local disk in 20-50ms per
   * segment, so holding far more costs almost nothing and makes playback
   * immune to a window that takes a moment to encode.
   */
  maxBufferLength?: number;
  /**
   * Whether to begin playing once the manifest is ready.
   *
   * False when restoring after a refresh: a reload carries no user activation,
   * so an audible autoplay would be refused and we would be forced to mute.
   * Waiting for the user to press play keeps the sound on.
   */
  autoplay?: boolean;
}

export function usePlayer(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { backBufferLength = 90, startPosition = -1, fragLoadingTimeOut = 20000,
    maxBufferLength = 30, autoplay = true }: PlayerOptions = {},
) {
  const hlsRef = useRef<Hls | null>(null);
  const nativeErrorHandler = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((url: string) => {
    const video = videoRef.current;
    if (!video) return;

    setError(null);

    // Remove any previous native HLS error listener before re-using the element
    if (nativeErrorHandler.current) {
      video.removeEventListener("error", nativeErrorHandler.current);
      nativeErrorHandler.current = null;
    }

    hlsRef.current?.destroy();
    hlsRef.current = null;

    // iOS Safari detection (including iPadOS 13+ which masquerades as Mac).
    // Chrome for iOS uses CriOS (not "chrome") in its UA, so exclude it explicitly
    // so hls.js can be used — it handles MPEG-2 TS; native HLS on iOS cannot.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isChromeIOS = /CriOS/i.test(navigator.userAgent);
    const isSafari = !isChromeIOS && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const forceNative = isIOS && isSafari;

    if (!forceNative && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        // Only meaningful for LL-HLS live edges, and it holds the buffer short
        // to chase latency - the opposite of what a recording wants.
        lowLatencyMode: maxBufferLength <= 30,
        backBufferLength,
        maxBufferLength,
        // hls.js stops at whichever of length or size it reaches first, and the
        // 60 MB default is the binding one at 1080p60 - roughly 90s of video,
        // so a generous length alone would have done nothing.
        maxBufferSize: Math.max(60, maxBufferLength * 4) * 1000 * 1000,
        // The ceiling hls.js is allowed to grow to on a healthy connection.
        maxMaxBufferLength: Math.max(600, maxBufferLength * 2),
        startPosition,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 10,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 10,
        fragLoadingTimeOut,
        fragLoadingMaxRetry: 10,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        }
      });
      
      log.hls("attach", {
        url, backBufferLength, maxBufferLength, startPosition, fragLoadingTimeOut,
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
        log.hls(`manifest parsed — ${d.levels.length} level(s)`, {
          duration: fmt(hls.media?.duration ?? NaN),
        });
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => {
        log.hls(`level loaded — ${d.details.fragments.length} fragments`, {
          totalduration: fmt(d.details.totalduration),
          live: d.details.live,
          type: d.details.type,
        });
      });

      // Fragment timing is the single most useful signal: a cold window shows up
      // as one slow fragment, a warm one is near-instant.
      const fragStart = new Map<string, number>();
      hls.on(Hls.Events.FRAG_LOADING, (_e, d) => {
        fragStart.set(d.frag.relurl ?? String(d.frag.sn), performance.now());
      });
      hls.on(Hls.Events.FRAG_LOADED, (_e, d) => {
        const key = d.frag.relurl ?? String(d.frag.sn);
        const began = fragStart.get(key);
        fragStart.delete(key);
        const ms = began ? Math.round(performance.now() - began) : -1;
        const slow = ms > 1500;
        const label = segmentLabel(d.frag.url);
        const detail = { ms, kb: Math.round((d.payload?.byteLength ?? 0) / 1024) };
        if (slow) log.warn(`frag SLOW ${label} — transcoded on demand`, detail);
        else log.hls(`frag ${label}`, detail);
      });

      hls.on(Hls.Events.BUFFER_APPENDED, () => {
        const b = video.buffered;
        if (!b.length) return;
        log.hls(`buffer → ${fmt(b.end(b.length - 1) - video.currentTime)} ahead`, {
          at: fmt(video.currentTime),
          end: fmt(b.end(b.length - 1)),
        });
      });

      hls.loadSource(url);
      hls.attachMedia(video);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Sound stays on. Playback only ever starts from a user gesture, so the
        // autoplay policy permits audio and there is nothing to fall back from.
        video.muted = false;
        if (autoplay) video.play().catch((e) => log.warn("play() rejected", e));
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        const where = data.frag ? segmentLabel(data.frag.url) : "-";
        if (data.fatal) {
          log.warn(`FATAL ${data.type} / ${data.details} @ ${where}`, data);
          setError(`HLS Fatal Error: ${data.type} - ${data.details}`);
          hls.destroy();
        } else {
          // Non-fatal means hls.js will retry. Repeated ones escalate to fatal,
          // so they are the early warning rather than noise.
          log.warn(`recoverable ${data.details} @ ${where}`, {
            type: data.type,
            at: fmt(video.currentTime),
          });
        }
      });

      hlsRef.current = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      if (startPosition >= 0) {
        // Native HLS also honors the live edge for EVENT playlists.
        video.addEventListener(
          "loadedmetadata",
          () => { video.currentTime = startPosition; },
          { once: true },
        );
      }
      const handler = () => {
        const err = video.error;
        const code = err ? `code ${err.code}` : "unknown";
        const msg = err?.message || "";
        setError(`Native HLS Error (${code}${msg ? ": " + msg : ""})`);
      };
      nativeErrorHandler.current = handler;
      video.addEventListener("error", handler);
      video.muted = false;
      if (autoplay) video.play().catch((e) => log.warn("native play() rejected", e));
    } else {
      setError("HLS not supported in this browser");
    }
  }, [videoRef, backBufferLength, startPosition, fragLoadingTimeOut, autoplay, maxBufferLength]);

  const destroy = useCallback(() => {
    const video = videoRef.current;
    if (video && nativeErrorHandler.current) {
      video.removeEventListener("error", nativeErrorHandler.current);
      nativeErrorHandler.current = null;
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (video) {
      video.src = "";
    }
  }, [videoRef]);

  useEffect(() => () => { hlsRef.current?.destroy(); }, []);

  return { load, destroy, error };
}
