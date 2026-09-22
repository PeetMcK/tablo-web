/**
 * What the vendored CEA-708 service offers us.
 *
 * The implementation stays JavaScript: it is Shaka's, converted only in module
 * syntax, and annotating eighteen hundred lines of someone else's decoder
 * would be inventing types rather than recording them — and would bury any
 * real conversion mistake in the noise. Declared here instead is the surface
 * this app actually calls, which is small. The same arrangement the libav
 * vendor uses in `lib/wasmlive/vendor`.
 */

import type { Cue } from "./cue";

/**
 * One byte of a DTVCC packet, as the packet builder consumes them.
 *
 * `type` is the `cc_type` it arrived under: 3 opens a packet, 2 continues it.
 * `order` breaks ties when bytes share a timestamp, which is why the builder
 * can be fed from a sort.
 */
export interface Cea708Byte {
  pts: number;
  type: number;
  value: number;
  order: number;
}

/** A finished caption: Shaka's cue, and which service produced it. */
export interface ClosedCaption {
  cue: Cue;
  stream: string;
}

export declare class Cea708Service {
  constructor(serviceNumber: number);
  /**
   * Consume one control code from the packet, returning any caption it
   * completed. Called repeatedly while the packet has data left.
   */
  handleCea708ControlCode(packet: DtvccPacket): ClosedCaption[];
  /**
   * What every visible window is showing at `pts`, without disturbing it.
   *
   * Ours, not Shaka's: upstream only ever emits a caption as it leaves the
   * screen, which is too late for a player decoding barely ahead of its own
   * playhead. See the note on the implementation.
   */
  snapshotVisibleWindows(pts: number): ClosedCaption[];
  /** Drop all window state. For a seek or a discontinuity. */
  clear(): void;
}

export declare class DtvccPacket {
  constructor(packetData: Cea708Byte[]);
  hasMoreData(): boolean;
  getPosition(): number;
  readByte(): Cea708Byte;
  skip(numBlocks: number): void;
  rewind(numBlocks: number): void;
}
