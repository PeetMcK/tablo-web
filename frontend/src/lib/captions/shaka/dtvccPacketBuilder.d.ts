/**
 * What the vendored DTVCC packet builder offers us. See `cea708Service.d.ts`
 * for why the implementation stays JavaScript.
 */

import type { Cea708Byte, DtvccPacket } from "./cea708Service";

/** `cc_type` 3: this byte opens a packet. */
export declare const DtvccPacketBuilder_DTVCC_PACKET_START: number;
/** `cc_type` 2: this byte continues the open packet. */
export declare const DtvccPacketBuilder_DTVCC_PACKET_DATA: number;

export declare class DtvccPacketBuilder {
  /**
   * Feed one byte. A packet that completes becomes available from
   * `getBuiltPackets`; one that never completes is discarded when the next
   * packet opens, as the standard requires.
   */
  addByte(byte: Cea708Byte): void;
  getBuiltPackets(): DtvccPacket[];
  clearBuiltPackets(): void;
  clear(): void;
}
