/**
 * That the conversion of Shaka's 708 decoder left something that loads and
 * runs.
 *
 * Deliberately narrow. The decoder's behaviour is upstream's, exercised by
 * every Shaka user, and the way to prove it survived vendoring is to run real
 * broadcast bytes through it — which `cea708Track.test.ts` does against the
 * committed fixture. What these two pin is the conversion itself: that the
 * modules resolve each other, that the statics reached through the class
 * still exist, and that the Closure typedef line which would have thrown at
 * load is gone.
 *
 * Synthetic command sequences were tried here and abandoned. Getting the
 * decoder to emit requires driving window state through several commands in
 * the right order, and a test that encodes my guess at that proves my guess,
 * not the decoder.
 */

import { describe, it, expect } from "vitest";

import { DtvccPacketBuilder } from "../lib/captions/shaka/dtvccPacketBuilder";
import { Cea708Service } from "../lib/captions/shaka/cea708Service";
import type { Cea708Byte } from "../lib/captions/shaka/cea708Service";

/**
 * The DTVCC bytes for one packet carrying a single service block.
 *
 * A packet is a header byte giving its size in pairs, then the blocks. Each
 * block opens with its service number and length.
 */
function packetBytes(serviceNumber: number, blockData: number[]): Cea708Byte[] {
  const body = [(serviceNumber << 5) | blockData.length, ...blockData];
  const sizeCode = Math.ceil((body.length + 1) / 2);
  const payload = [sizeCode & 0x3f, ...body];
  while (payload.length < sizeCode * 2) payload.push(0);

  const out: Cea708Byte[] = [{ pts: 0, type: 3, value: payload[0], order: 0 }];
  for (let i = 1; i < payload.length; i++) {
    out.push({ pts: 0, type: 2, value: payload[i], order: i });
  }
  return out;
}

describe("the vendored CEA-708 decoder", () => {
  it("reassembles a packet from its start and data bytes", () => {
    const builder = new DtvccPacketBuilder();
    for (const b of packetBytes(1, [0x41, 0x42])) builder.addByte(b);

    const packets = builder.getBuiltPackets();
    expect(packets.length).toBe(1);
    expect(packets[0].hasMoreData()).toBe(true);
  });

  it("discards a packet that never finished, as the standard requires", () => {
    const builder = new DtvccPacketBuilder();
    // Open a packet, feed one byte, then open another before it completes.
    builder.addByte({ pts: 0, type: 3, value: 0x08, order: 0 });
    builder.addByte({ pts: 0, type: 2, value: 0x41, order: 1 });
    for (const b of packetBytes(1, [0x42, 0x43])) builder.addByte(b);

    // Only the complete one survives.
    expect(builder.getBuiltPackets().length).toBe(1);
  });

  it("walks a packet's control codes without throwing", () => {
    // The conversion's failure modes are load-time and lookup-time: a missing
    // import, a static that became an undefined module constant. Running the
    // service over a packet exercises both.
    const builder = new DtvccPacketBuilder();
    const service = new Cea708Service(1);
    for (const b of packetBytes(1, [0x98, 0x38, 0x00, 0x00, 0x00, 0x03, 0x1f])) {
      builder.addByte(b);
    }

    for (const packet of builder.getBuiltPackets()) {
      while (packet.hasMoreData()) {
        expect(() => service.handleCea708ControlCode(packet)).not.toThrow();
      }
    }
    expect(() => service.clear()).not.toThrow();
  });
});
