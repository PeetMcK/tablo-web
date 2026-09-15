import { useEffect, useRef, useCallback, useState } from "react";
import Hls from "hls.js";

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
}

export function usePlayer(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { backBufferLength = 90, startPosition = -1 }: PlayerOptions = {},
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
        lowLatencyMode: true,
        backBufferLength,
        startPosition,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 10,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 10,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 10,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        }
      });
      
      hls.loadSource(url);
      hls.attachMedia(video);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((e) => {
          console.error("Autoplay failed:", e);
          // Don't set error here as it might just need a user click
        });
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError(`HLS Fatal Error: ${data.type} - ${data.details}`);
          hls.destroy();
        } else {
          console.warn("HLS Non-fatal error:", data.details);
        }
      });

      hlsRef.current = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      if (startPosition >= 0) {
        // Native HLS also honours the live edge for EVENT playlists.
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
      video.play().catch((e) => console.error("Native autoplay failed:", e));
    } else {
      setError("HLS not supported in this browser");
    }
  }, [videoRef, backBufferLength, startPosition]);

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
