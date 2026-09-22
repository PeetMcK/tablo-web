/**
 * Where the captions are, in the bytes the decoder is already holding.
 *
 * ATSC carries closed captions inside the MPEG-2 video rather than beside it:
 * each coded picture may carry a user-data block, identified by `GA94`, whose
 * payload is a list of EIA-608 byte pairs and CEA-708 packet fragments. The
 * device passes the broadcast through untouched, so they are present in every
 * captioned stream the app receives and cost nothing to read.
 */

import type { CcData, CcPair } from "./types";

/** `GA94`, the ATSC identifier that marks an A/53 user-data block. */
const ATSC_IDENTIFIER = 0x47413934;

/** A/53 Part 4 closed captions, as opposed to bar data or AFD. */
const USER_DATA_TYPE_CC = 0x03;

/**
 * The 608 pairs carried by one coded picture.
 *
 * `bytes` is an assembled packet — one picture — so a user-data block is
 * contiguous within it and no reassembly is needed.
 */
export function extractCcData(bytes: Uint8Array): CcData {
  const out: CcData = { cea608: [], dtvcc: [] };

  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0x00 || bytes[i + 1] !== 0x00 || bytes[i + 2] !== 0x01) continue;
    const code = bytes[i + 3];

    // Slices are the picture itself and never carry user data, so the first
    // one ends the search. This is what keeps the scan to a few hundred bytes
    // per picture rather than the whole packet — at 1080i, the difference
    // between kilobytes and megabytes a second.
    if (code >= 0x01 && code <= 0xaf) break;

    if (code === 0xb2) readUserData(bytes, i + 4, out);
    i += 3;
  }

  return out;
}

/** Read one user-data block, appending whatever caption pairs it holds. */
function readUserData(bytes: Uint8Array, p: number, out: CcData): void {
  // identifier(4) + user_data_type_code(1) + flags(1) + em_data(1)
  if (p + 7 > bytes.length) return;

  const identifier =
    ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  if (identifier !== ATSC_IDENTIFIER) return;
  if (bytes[p + 4] !== USER_DATA_TYPE_CC) return;

  const flags = bytes[p + 5];
  // Bit 6 clear means the encoder wrote the entries and is telling us not to
  // read them. Rare, and cheaper to honour than to discover the hard way.
  if ((flags & 0x40) === 0) return;

  const ccCount = flags & 0x1f;
  // bytes[p + 6] is em_data, which is not caption text.
  let q = p + 7;

  // A block that claims more entries than it carries is damage. Reading to the
  // claimed count would walk past the end and invent captions out of whatever
  // followed, so none of it is trusted.
  if (q + ccCount * 3 > bytes.length) return;

  for (let k = 0; k < ccCount; k++, q += 3) {
    const marker = bytes[q];
    if ((marker & 0x04) === 0) continue;   // cc_valid clear: a padding entry

    const type = (marker & 0x03) as 0 | 1 | 2 | 3;
    const pair: CcPair = { field: type, a: bytes[q + 1], b: bytes[q + 2] };
    // Order within each list is the order the encoder wrote them, which is
    // what both decoders need - DTVCC especially, where a packet is assembled
    // from consecutive entries.
    if (type <= 1) out.cea608.push(pair);
    else out.dtvcc.push(pair);
  }
}
