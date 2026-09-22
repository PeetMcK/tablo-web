/**
 * CEA-708 DTVCC packet reassembly, vendored from Shaka Player.
 *
 * Source: shaka-player@5.2.11, `lib/cea/dtvcc_packet_builder.js`. Apache-2.0; the upstream
 * licence header is kept below.
 *
 * Copied rather than depended upon: Shaka publishes this as Closure-annotated
 * source that Vite will not transpile, and the parts of Shaka that would come
 * with it - MP4 and TS parsers, its own text pipeline - solve problems this
 * app has already solved. The conversion was mechanical: `goog.provide` and
 * `goog.require` removed, `shaka.cea.X = class` made an exported class,
 * statics and Closure enums lifted to module constants, `goog.asserts` and
 * `shaka.log` made no-ops, and `shaka.text.Cue` replaced by the local shim in
 * `cue.ts`. No logic was changed.
 *
 * Chosen over mux.js, which parses window anchors and then discards them when
 * it emits - see the design note. Placement is the whole point here.
 */
/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */



/**
 * CEA-708 DTVCC Packet Builder.
 * Builds packets based on Figure 5 CCP State Table in 5.2 of CEA-708-E.
 * Initially, there is no packet. When a DTVCC_PACKET_START payload is received,
 * a packet begins construction. The packet is considered "built" once all bytes
 * indicated in the header are read, and ignored if a new packet starts building
 * before the current packet is finished being built.
 */
export class DtvccPacketBuilder {
  constructor() {
    /**
     * An array containing built DTVCC packets that are ready to be processed.
     * @private {!Array<!DtvccPacket>}
     */
    this.builtPackets_ = [];

    /**
     * Stores the packet data for the current packet being processed, if any.
     * @private {?Array<!Cea708Service_Cea708Byte>}
     */
    this.currentPacketBeingBuilt_ = null;

    /**
     * Keeps track of the number of bytes left to add in the current packet.
     * @private {number}
     */
    this.bytesLeftToAddInCurrentPacket_ = 0;
  }

  /**
   * @param {!Cea708Service_Cea708Byte} cea708Byte
   */
  addByte(cea708Byte) {
    if (cea708Byte.type === DtvccPacketBuilder_DTVCC_PACKET_START) {
      // If there was a packet being built that finished, it would have
      // already been added to the built packets when it finished. So if
      // there's an open packet at this point, it must be unfinished. As
      // per the spec, we don't deal with unfinished packets. So we ignore them.

      // A new packet should be opened.
      const packetSize = cea708Byte.value & 0x3f;

      // As per spec, number of packet data bytes to follow is packetSize*2-1.
      this.bytesLeftToAddInCurrentPacket_ = packetSize * 2 - 1;
      this.currentPacketBeingBuilt_ = [];
      return;
    }

    if (!this.currentPacketBeingBuilt_) {
      // There is no packet open. Then an incoming byte should not
      // have come in at all. Ignore it.
      return;
    }

    if (this.bytesLeftToAddInCurrentPacket_ > 0) {
      this.currentPacketBeingBuilt_.push(cea708Byte);
      this.bytesLeftToAddInCurrentPacket_--;
    }

    if (this.bytesLeftToAddInCurrentPacket_ === 0) {
      // Current packet is complete and ready for processing.
      const packet = new DtvccPacket(this.currentPacketBeingBuilt_);
      this.builtPackets_.push(packet);
      this.currentPacketBeingBuilt_ = null;
      this.bytesLeftToAddInCurrentPacket_ = 0;
    }
  }

  /**
   * @return {!Array<!DtvccPacket>}
   */
  getBuiltPackets() {
    return this.builtPackets_;
  }

  /** Clear built packets. */
  clearBuiltPackets() {
    this.builtPackets_ = [];
  }

  /** Clear built packets and packets in progress. */
  clear() {
    this.builtPackets_ = [];
    this.currentPacketBeingBuilt_ = null;
    this.bytesLeftToAddInCurrentPacket_ = 0;
  }
}


export class DtvccPacket {
  /**
   * @param {!Array<!Cea708Service_Cea708Byte>} packetData
   */
  constructor(packetData) {
    /**
     * Keeps track of the position to read the next byte from in the packet.
     * @private {number}
     */
    this.pos_ = 0;

    /**
     * Bytes that represent the data in the DTVCC packet.
     * @private {!Array<!Cea708Service_Cea708Byte>}
     */
    this.packetData_ = packetData;
  }

  /**
   * @return {boolean}
   */
  hasMoreData() {
    return this.pos_ < this.packetData_.length;
  }

  /**
   * @return {number}
   */
  getPosition() {
    return this.pos_;
  }

  /**
   * Reads a byte from the packet.
   * @return {!Cea708Service_Cea708Byte}
   * @throws {!shaka.util.Error}
   */
  readByte() {
    if (!this.hasMoreData()) {
      throw this.outOfBoundsError_();
    }
    return this.packetData_[this.pos_++];
  }

  /**
   * Skips the provided number of blocks in the buffer.
   * @param {number} numBlocks
   * @throws {!shaka.util.Error}
   */
  skip(numBlocks) {
    if (this.pos_ + numBlocks > this.packetData_.length) {
      throw this.outOfBoundsError_();
    }
    this.pos_ += numBlocks;
  }

  /**
   * Rewinds the provided number of blocks in the buffer.
   * @param {number} numBlocks
   * @throws {!shaka.util.Error}
   */
  rewind(numBlocks) {
    if (this.pos_ - numBlocks < 0) {
      throw this.outOfBoundsError_();
    }
    this.pos_ -= numBlocks;
  }

  /**
   * Builds the error thrown when a read would go outside the packet bounds.
   * @return {!shaka.util.Error}
   * @private
   */
  outOfBoundsError_() {
    return new Error('CEA-708 decode error');
  }
}

/**
 * @const {number}
 */
export const DtvccPacketBuilder_DTVCC_PACKET_DATA = 2;

/**
 * @const {number}
 */
export const DtvccPacketBuilder_DTVCC_PACKET_START = 3;
