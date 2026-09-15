import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/tablo";
import type { Recording } from "../api/tablo";
import { VideoPlayer } from "./VideoPlayer";
import { Play } from "lucide-react";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}H ${m}M` : `${m} MIN`;
}

export function LibraryView() {
  const [playing, setPlaying] = useState<Recording | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["recordings"],
    queryFn: () => api.recordings(),
    staleTime: 5 * 60_000,
  });

  const recordings = data?.recordings ?? [];
  const truncated = data ? data.total > data.returned : false;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-4">
        <div className="w-12 h-12 rounded-full border-4 border-accent border-t-transparent animate-spin" />
        <p className="text-white/40 text-sm font-medium uppercase tracking-widest">Accessing Library...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-6 text-center">
        <p className="text-red-400 font-bold">Failed to load recordings</p>
        <button onClick={() => refetch()} className="px-6 py-2 rounded-xl glass text-sm hover:bg-white/5 transition">
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {playing && (
        <VideoPlayer
          key={playing.object_id}
          source={{ kind: "recording", recording: playing }}
          onClose={() => setPlaying(null)}
        />
      )}

      {truncated && (
        <p className="text-[11px] text-white/30 uppercase tracking-widest mb-2">
          Showing {data!.returned} of {data!.total} recordings
        </p>
      )}

      <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {recordings.length === 0 ? (
          <div className="col-span-full py-48 text-center bg-white/5 rounded-3xl border border-white/5">
            <p className="text-white/20 font-black tracking-widest uppercase">No Recordings Found</p>
          </div>
        ) : (
          recordings.map((rec) => {
            // A recording still being written has no complete source to transcode.
            const playable = rec.state !== "recording" && !rec.error;
            return (
              <div
                key={rec.object_id}
                className="group flex flex-col bg-surface-raised border border-surface-border rounded-2xl overflow-hidden hover:border-accent/40 transition shadow-lg"
              >
                <button
                  onClick={() => playable && setPlaying(rec)}
                  disabled={!playable}
                  className="aspect-video bg-black/40 relative block w-full disabled:cursor-not-allowed"
                  aria-label={`Play ${rec.title ?? "recording"}`}
                >
                  {rec.thumbnail ? (
                    <img src={rec.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/10 uppercase font-black text-xl italic">
                      Tablo
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition">
                    <div className="w-14 h-14 rounded-full bg-accent/90 flex items-center justify-center">
                      <Play className="w-6 h-6 text-white ml-0.5" fill="currentColor" aria-hidden />
                    </div>
                  </div>
                  {rec.cache_state === "complete" && (
                    <div className="absolute top-3 left-3 px-2 py-1 rounded bg-accent/80 text-[10px] font-bold text-white uppercase tracking-wider">
                      Ready
                    </div>
                  )}
                  <div className="absolute bottom-3 right-3 px-2 py-1 rounded bg-black/80 text-[10px] font-bold text-white tabular-nums">
                    {formatDuration(rec.duration)}
                  </div>
                </button>

                <div className="p-5 flex flex-col gap-1">
                  <h3 className="font-bold text-white truncate leading-tight">{rec.title || "Untitled Recording"}</h3>
                  {rec.subtitle && (
                    <p className="text-xs font-medium text-accent/70 truncate">{rec.subtitle}</p>
                  )}
                  <p className="text-xs text-white/40 line-clamp-2 leading-relaxed min-h-[2.5rem]">
                    {rec.description || "No description available"}
                  </p>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-[10px] font-black text-white/20 uppercase tracking-widest">
                      {new Date(rec.start).toLocaleDateString()}
                    </span>
                    <button
                      onClick={() => playable && setPlaying(rec)}
                      disabled={!playable}
                      className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center hover:bg-accent hover:text-white transition text-white/40 disabled:opacity-30 disabled:hover:bg-white/5"
                      aria-label={`Play ${rec.title ?? "recording"}`}
                    >
                      <Play className="w-4 h-4" fill="currentColor" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
