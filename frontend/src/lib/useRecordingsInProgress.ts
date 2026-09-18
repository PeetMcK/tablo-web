/**
 * What is recording right now, shared by Live and the Guide.
 *
 * One definition because the two views must agree: a programme marked as
 * recording in one and not the other is worse than neither marking it.
 */

import { useEffect, useMemo, useState } from "react";
import { api, type InProgressRecording } from "../api/tablo";

/**
 * What is recording right now, keyed the way the guide addresses airings.
 *
 * Its own small request rather than fields on the guide: the guide is large,
 * cached hard and refreshed every five minutes, while this changes every few
 * seconds and is almost always empty. Fifteen seconds matches the Library.
 */
export function useRecordingsInProgress(enabled: boolean): Map<string, InProgressRecording> {
  const [rows, setRows] = useState<InProgressRecording[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;

    const read = async () => {
      try {
        const { recordings } = await api.inProgressRecordings();
        if (live) setRows(recordings);
      } catch {
        // Nothing marked is the right failure: the guide is still the guide.
      }
    };

    void read();
    const interval = setInterval(() => void read(), 15_000);
    return () => { live = false; clearInterval(interval); };
  }, [enabled]);

  return useMemo(() => {
    const byAiring = new Map<string, InProgressRecording>();
    for (const r of rows) {
      if (!r.channel_identifier) continue;
      // Both spellings. The device writes `17:30Z` on a recording and the
      // guide may carry `17:30:00.000Z` for the same instant, and a Map is
      // exact - so the normalised form is stored beside the literal one
      // rather than hoping the two agree.
      byAiring.set(`${r.channel_identifier}|${r.start}`, r);
      const iso = new Date(r.start).toISOString();
      if (!Number.isNaN(Date.parse(r.start))) {
        byAiring.set(`${r.channel_identifier}|${iso}`, r);
      }
    }
    return byAiring;
  }, [rows]);
}

/**
 * The recording capturing this programme, if one is.
 *
 * Matched on the airing rather than the channel: a channel can be recording
 * something that is not what is on air now - the tuner may still be finishing
 * the previous programme's padding.
 */
export function recordingFor(
  inProgress: Map<string, InProgressRecording>,
  channel: string,
  start: string | null | undefined,
): InProgressRecording | null {
  if (!start) return null;
  const exact = inProgress.get(`${channel}|${start}`);
  if (exact) return exact;
  if (Number.isNaN(Date.parse(start))) return null;
  return inProgress.get(`${channel}|${new Date(start).toISOString()}`) ?? null;
}

/**
 * A recording of this series, whichever episode it is.
 *
 * Not the same question as `recordingFor`: turning a series off stops whatever
 * it has on a tuner right now, and that is routinely a different episode on a
 * different channel from the one being looked at.
 *
 * The map holds each recording under two keys, so the values are deduplicated
 * by `object_id` before the first match is taken.
 */
export function recordingForSeries(
  inProgress: Map<string, InProgressRecording>,
  seriesPath: string | null | undefined,
): InProgressRecording | null {
  if (!seriesPath) return null;
  const seen = new Set<number>();
  for (const recording of inProgress.values()) {
    if (seen.has(recording.object_id)) continue;
    seen.add(recording.object_id);
    if (recording.series_path === seriesPath) return recording;
  }
  return null;
}
