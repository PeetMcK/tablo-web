/**
 * DTVCC bytes in, positioned cues out.
 *
 * The shape of `CaptionTrack`, deliberately, so the session can hold either
 * and the choice between them is a latch rather than a branch through the
 * pipeline.
 *
 * The decoding is Shaka's, vendored under `shaka/`. What lives here is the
 * two things Shaka's own callers do around it — assembling `cc_type` 2 and 3
 * pairs into the byte stream the packet builder wants, and walking each
 * packet's service blocks — plus the conversion of its cue model into ours.
 */

import { DtvccPacketBuilder, DtvccPacketBuilder_DTVCC_PACKET_DATA }
  from "./shaka/dtvccPacketBuilder";
import { Cea708Service } from "./shaka/cea708Service";
import type { Cue } from "./shaka/cue";
import { createReorderBuffer, REORDER_SECONDS } from "./reorder";
import { WINDOW_COLUMNS_16_9 } from "./safeArea";
import type { CaptionAnchor, CcPair, PositionedCue } from "./types";

/** The service these broadcasts carry. See the design note. */
const SERVICE_NUMBER = 1;

/**
 * The 708 coordinate grid, for windows positioned absolutely.
 *
 * A broadcaster may anchor a window in percentages or in cells. In cells, the
 * frame is 210 columns by 75 rows for 16:9 — so a cell position becomes a
 * percentage by dividing through. Shaka reports which of the two it was
 * through `viewportAnchorUnits`.
 */
const GRID_COLUMNS = 209;
const GRID_ROWS = 74;

/** `CueRegion.units.PERCENTAGE`, which is what Shaka sets for relative anchors. */
const UNITS_PERCENTAGE = 1;

function anchorOf(x: number, y: number): CaptionAnchor {
  const horizontal = x === 0 ? "left" : x === 100 ? "right" : "center";
  const vertical = y === 0 ? "top" : y === 100 ? "bottom" : "middle";
  return `${vertical}-${horizontal}` as CaptionAnchor;
}

/**
 * Flatten Shaka's cue tree into text.
 *
 * A window becomes a top-level cue holding a run per styled stretch, with
 * synthetic line-break cues between rows — so the text is the runs in order,
 * and the rows are where the breaks are.
 */
function textOf(cue: Cue): string {
  if (!cue.nestedCues.length) return cue.payload;
  return cue.nestedCues
    .map((run) => (run.lineBreak ? "\n" : run.payload))
    .join("")
    .trim();
}

function styleOf(cue: Cue): PositionedCue["style"] {
  const run = cue.nestedCues.find((n) => !n.lineBreak) ?? cue;
  const style: NonNullable<PositionedCue["style"]> = {};
  if (run.color) style.foreground = run.color;
  if (run.backgroundColor) style.background = run.backgroundColor;
  if (run.fontStyle === "italic") style.italic = true;
  if (run.textDecoration.includes("underline")) style.underline = true;
  return Object.keys(style).length ? style : undefined;
}

function regionOf(cue: Cue): PositionedCue["region"] {
  const region = cue.region;
  if (!region) return undefined;

  const percent = region.viewportAnchorUnits === UNITS_PERCENTAGE;
  const xPercent = percent
    ? region.viewportAnchorX
    : (region.viewportAnchorX / GRID_COLUMNS) * 100;
  const yPercent = percent
    ? region.viewportAnchorY
    : (region.viewportAnchorY / GRID_ROWS) * 100;

  return {
    anchor: anchorOf(region.regionAnchorX, region.regionAnchorY),
    xPercent: Math.max(0, Math.min(100, xPercent)),
    yPercent: Math.max(0, Math.min(100, yPercent)),
    rows: region.height,
    columns: region.width,
    gridColumns: WINDOW_COLUMNS_16_9,
    align: alignOf(cue),
  };
}

/**
 * Where the text sits inside its window.
 *
 * Shaka reports FULL justification as CENTER, which is its own simplification
 * and the right one here: a browser cannot justify a caption line to a cell
 * grid, and stretching the words to both edges of the window would look
 * nothing like a television.
 */
function alignOf(cue: Cue): "left" | "center" | "right" {
  const value = String(cue.textAlign || "").toLowerCase();
  if (value.includes("left") || value === "start") return "left";
  if (value.includes("right") || value === "end") return "right";
  return "center";
}

export interface Cea708Track {
  /** Offer one picture's DTVCC pairs, at that picture's presentation time. */
  add(seconds: number, pairs: readonly CcPair[]): void;
  /** Cues completed since the last call. Each is handed out once. */
  drain(): PositionedCue[];
  /** Feed everything held, then drain. For end of stream. */
  flush(): PositionedCue[];
  /**
   * Whether this stream has been seen to carry 708 captions.
   *
   * What the session latches on. Set when a cue is produced rather than when
   * bytes arrive: DTVCC padding is present on channels that carry no captions
   * at all, so bytes alone would claim a service that never speaks.
   */
  readonly seen: boolean;
  reset(): void;
}

export function createCea708Track(): Cea708Track {
  const pending = createReorderBuffer<CcPair>();
  let builder = new DtvccPacketBuilder();
  let service = new Cea708Service(SERVICE_NUMBER);
  let cues: PositionedCue[] = [];
  let seen = false;
  /** Ties between bytes sharing a timestamp, which the builder sorts on. */
  let order = 0;
  const collect = (caption: { cue: Cue }) => {
    const text = textOf(caption.cue);
    if (!text) return;
    seen = true;
    cues.push({
      startSeconds: caption.cue.startTime,
      endSeconds: caption.cue.endTime,
      text,
      region: regionOf(caption.cue),
      style: styleOf(caption.cue),
    });
  };

  /**
   * Feed settled pairs, then decode whatever packets completed.
   *
   * Each pair contributes two bytes. Only the first carries the pair's type -
   * a packet start's header is in that byte alone, and its partner is always
   * ordinary packet data.
   */
  const consume = (held: Array<{ seconds: number; item: CcPair }>) => {
    for (const { seconds, item } of held) {
      builder.addByte({ pts: seconds, type: item.field, value: item.a, order: order++ });
      builder.addByte({
        pts: seconds,
        type: DtvccPacketBuilder_DTVCC_PACKET_DATA,
        value: item.b,
        order: order++,
      });
    }

    for (const packet of builder.getBuiltPackets()) {
      // A packet is a sequence of service blocks. Only ours is decoded; the
      // rest are skipped by their declared length.
      while (packet.hasMoreData()) {
        const header = packet.readByte().value;
        let serviceNumber = (header & 0xe0) >> 5;
        const blockSize = header & 0x1f;

        // 7 with a non-empty block means the real number is in a second byte.
        if (serviceNumber === 0x07 && blockSize !== 0) {
          serviceNumber = packet.readByte().value & 0x3f;
        }
        // Service 0 is invalid, and a zero-length block is padding to the end.
        if (serviceNumber === 0 || blockSize === 0) break;

        const start = packet.getPosition();
        if (serviceNumber === SERVICE_NUMBER) {
          while (packet.getPosition() - start < blockSize) {
            for (const caption of service.handleCea708ControlCode(packet)) {
              collect(caption);
            }
          }
        } else {
          packet.skip(blockSize);
        }
      }
    }
    builder.clearBuiltPackets();
  };

  /**
   * Add what is on screen to what has just left it.
   *
   * Upstream emits a caption only as it is taken down, which is after the
   * playhead has already reached it - see `snapshotVisibleWindows`. The
   * snapshot goes last so that within one round a window's take-down cue is
   * followed by nothing for that window, and a window still up ends its cue
   * at the time decoded through rather than in the past.
   */
  const takeCues = (through: number | null) => {
    if (through !== null) {
      for (const caption of service.snapshotVisibleWindows(through)) collect(caption);
    }
    const out = cues;
    cues = [];
    return out;
  };

  return {
    add(seconds: number, pairs: readonly CcPair[]) {
      // Every picture, carrying bytes or not: its time is what settles the
      // bytes already held and what the windows are asked about. DTVCC pairs
      // arrive in bursts, so a track told only about the pictures that carry
      // them sees time stand still between bursts.
      pending.advance(seconds);
      for (const pair of pairs) {
        // 2 and 3 only: 0 and 1 are the 608 fields and have their own track.
        if (pair.field < 2) continue;
        pending.add(seconds, pair);
      }
    },

    drain() {
      consume(pending.take());
      return takeCues(pending.settledThrough);
    },

    flush() {
      const through = pending.settledThrough;
      consume(pending.takeAll());
      // Everything held has gone in, so the windows can be asked about the
      // last picture rather than about the settled boundary behind it.
      return takeCues(through === null ? null : through + REORDER_SECONDS);
    },

    get seen() { return seen; },

    reset() {
      pending.reset();
      // Rebuilt rather than cleared: a half-assembled packet from before a
      // seek would take the next real one for its continuation.
      builder = new DtvccPacketBuilder();
      service = new Cea708Service(SERVICE_NUMBER);
      cues = [];
      order = 0;
      // `seen` survives, as it does for 608: a channel does not stop carrying
      // 708 because the viewer skipped back.
    },
  };
}
