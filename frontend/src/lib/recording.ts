/**
 * How much of a programme a recording actually captured.
 *
 * One definition, drawn identically by the Library card, the info sheet, the
 * live card and the guide row. Three views inventing the same arithmetic is the
 * bug this file exists to prevent.
 */

/** Everything the geometry needs, from a recording or from a guide airing. */
export interface Coverage {
  /** Scheduled start of the airing, ISO. The slot's left edge. */
  start: string;
  /** The scheduled slot, in seconds. */
  duration: number;
  /** When the tuner actually began, ISO, or null to assume it was punctual. */
  recording_started: string | null;
  /** Seconds captured so far, or in total for something finished. */
  recorded_seconds: number | null;
}

/**
 * Where the captured part sits within the strip, as percentages.
 *
 * The strip is the scheduled slot, widened to include anything captured outside
 * it. `slotEnd` marks where the booked slot finished when a recording overran
 * it by enough to be worth seeing, and is null otherwise.
 */
/** A stretch of the strip, as percentages of it. */
export interface Fill {
  left: number;
  width: number;
}

export interface Span extends Fill {
  slotEnd: number | null;
}

/**
 * An overrun smaller than this much of the strip gets no tick.
 *
 * Padding of thirty minutes on a three-hour game is the point of the mark;
 * fifty-nine seconds past a two-hour slot would put it on the last pixel, where
 * it reads as a rendering fault rather than information.
 */
const TICK_THRESHOLD = 0.02;

/**
 * The stretch of the slot that exists, positioned where it falls.
 *
 * Not flush left, deliberately. A recording that started twenty minutes late
 * drawn from the left edge is indistinguishable from one that caught the whole
 * show, and which of those you have is the thing most worth knowing before
 * pressing play. Measured on one device: of fourteen recordings, three had
 * captured four seconds, eight seconds and 3.7 minutes of an hour — and the
 * device reported no error for any of them.
 *
 * Null when the slot or the start is unknown, which leaves an empty strip.
 * Nothing honest can be drawn without both, and a full bar would be a lie.
 */
export function recordedSpan(rec: Coverage): Span | null {
  const slot = rec.duration;
  if (!slot || !rec.start) return null;

  const scheduled = new Date(rec.start).getTime();
  if (Number.isNaN(scheduled)) return null;

  const began = rec.recording_started ? new Date(rec.recording_started).getTime() : scheduled;
  if (Number.isNaN(began)) return null;

  // Seconds from the slot's start. Negative when the tuner began early, which
  // it routinely does by a few seconds.
  const from = (began - scheduled) / 1000;
  const to = from + (rec.recorded_seconds ?? 0);

  // The strip is the slot, widened to hold anything captured outside it —
  // sports pad by half an hour on purpose, and clamping would hide it.
  const lo = Math.min(0, from);
  const hi = Math.max(slot, to);
  const width = hi - lo;
  if (width <= 0) return null;

  const pct = (seconds: number) => ((seconds - lo) / width) * 100;
  const overran = (hi - slot) / width > TICK_THRESHOLD;

  return {
    left: pct(from),
    // A four-second recording is a sliver, not nothing: it has to be visible
    // to say what it is.
    width: Math.max(0.5, pct(to) - pct(from)),
    slotEnd: overran ? pct(slot) : null,
  };
}

/**
 * Close enough to the end that the viewer has watched the thing.
 *
 * Twelve seconds of credits left on an hour is a finished programme, and a bar
 * a hair short of full reads as "something is left" - which sends someone back
 * to a recording they have already seen.
 */
const FINISHED = 0.99;

/**
 * How much of what was captured has been watched, on the same strip.
 *
 * Measured against `recorded_seconds` rather than the slot, because the resume
 * position is an offset into the media and nothing else. A recording that began
 * twenty minutes late and is a quarter watched fills a quarter of the grey, not
 * a quarter of the strip - drawn against the slot it would claim the viewer is
 * further behind than they are.
 *
 * Null when nothing has been watched, so an untouched recording carries no mark
 * at all.
 */
export function watchedSpan(rec: Coverage, position: number): Fill | null {
  const captured = rec.recorded_seconds ?? 0;
  if (!(position > 0) || captured <= 0) return null;

  const span = recordedSpan(rec);
  if (!span) return null;

  // Clamped: a position saved while the programme was still recording outlives
  // the finished file when the capture is cut short, and an unclamped fraction
  // would hang the bar off the end of what exists.
  const through = Math.min(1, position / captured);

  return {
    left: span.left,
    width: span.width * (through >= FINISHED ? 1 : through),
  };
}

/**
 * Captured so little of its slot that the recording is broken, not short.
 *
 * The device is no help here — `error` is null and `warnings` empty even on a
 * four-second capture — so it is inferred. A tenth of the slot separates the
 * three genuinely broken recordings measured on one device (0.1%, 0.2%, 6.2%)
 * from a deliberately stopped one (58.5%) and one that merely started late
 * (74.6%).
 */
export function isIncomplete(rec: Coverage): boolean {
  if (!rec.duration || !rec.recorded_seconds) return false;
  return rec.recorded_seconds / rec.duration < 0.1;
}

/** Everything the card's picture is chosen from. */
export interface Art {
  object_id: number;
  /** The show's own artwork, as the schedule resolves it. */
  image_url: string | null;
  /**
   * A frame from the recording, or null where the device offered no snapshot.
   *
   * Null says nothing about whether a *chosen* frame can be served: that comes
   * from the preview pack by way of the same route, which is why a cover falls
   * back to the route's own address rather than to this.
   */
  thumbnail: string | null;
  /** Seconds into the recording of a frame the viewer chose, or null. */
  cover_frame: number | null;
}

/**
 * The picture a card leads with.
 *
 * `thumbnail` first when the viewer has chosen a frame, because that route
 * serves their choice and a choice outranks the artwork. Otherwise the show's
 * own artwork, and a frame from the recording only as the floor: the snapshot
 * is a grab from the middle of a capture, which on plenty of programmes is a
 * caption card or somebody's back.
 */
export function cardArt(rec: Art): string | null {
  if (rec.cover_frame !== null) {
    // Built from the id rather than taken from `thumbnail`, which is null
    // whenever the device offered no snapshot of its own. The route serves a
    // chosen frame from the preview pack either way, so leaning on the
    // snapshot's existence dropped the card to its empty placeholder — with an
    // undo button floating over it, offering to remove a picture never shown.
    const base = rec.thumbnail ?? `/api/recordings/${rec.object_id}/thumbnail`;
    // The frame goes in the address, because a different picture has to be a
    // different URL. Without it every choice arrived at the same place, the
    // browser served whatever it had cached there — for a recording with no
    // artwork, a day-old snapshot — and picking a frame appeared to do nothing
    // at all from the second time onwards.
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}frame=${Math.round(rec.cover_frame * 1000)}`;
  }
  return rec.image_url ?? rec.thumbnail;
}

/** How long a recording runs, however far along it is. */
export interface Runtime {
  recorded_seconds: number | null;
  duration: number;
}

/**
 * Where in the recording a point on the coverage strip falls, in seconds.
 *
 * The strip is not a timeline. It spans the scheduled slot widened to hold any
 * padding, so the recording's first frame sits at `span.left` rather than at
 * the left edge — on a programme whose tuner started twenty minutes late, the
 * first third of the strip is slot with no video in it at all.
 *
 * Null outside the captured part, which is the signal to do nothing: seeking
 * there would land at zero and read as a bug. Not an edge case — measured on
 * one device, three recordings had captured four seconds, eight seconds and
 * 3.7 minutes of an hour, and on those nearly the whole strip is nothing.
 */
export function strippedTime(
  rec: Runtime,
  span: Fill,
  fraction: number,
): number | null {
  const pct = fraction * 100;
  if (span.width <= 0) return null;
  if (pct < span.left || pct > span.left + span.width) return null;
  const recorded = rec.recorded_seconds ?? rec.duration;
  if (!(recorded > 0)) return null;
  return ((pct - span.left) / span.width) * recorded;
}
