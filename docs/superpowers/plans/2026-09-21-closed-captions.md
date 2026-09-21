# Closed Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show broadcast closed captions during MPEG-2 live and MPEG-2 recording playback, by extracting the caption bytes already present in the stream and decoding them in the browser.

**Architecture:** The decode worker scans each MPEG-2 picture for ATSC A/53 user data, feeds the EIA-608 byte pairs to a vendored 608 state machine, and posts finished cues to the page alongside decoded video and audio. The session keeps a cue queue; a DOM overlay draws the cue covering the current time. Live and recordings both already run through this pipeline, so one integration point serves both.

**Tech Stack:** TypeScript, React, Vitest, libav.js (WASM), `hls.js`'s `cea-608-parser` vendored as source.

**Spec:** `docs/superpowers/specs/2026-09-21-closed-captions-design.md`

## Global Constraints

- **608 only.** CEA-708 (`cc_type` 2 and 3) is present in these streams and is deliberately not decoded. Extraction keeps field 2 (`cc_type` 1) because it costs nothing, but only field 1 is fed to the parser in this pass.
- **`erasableSyntaxOnly: true`** in `frontend/tsconfig.app.json`. No `enum`, no `const enum`, no parameter properties, no namespaces — including in vendored code.
- **`verbatimModuleSyntax: true`.** Type-only imports must be written `import type`.
- **`noUnusedLocals` and `noUnusedParameters`** are on. Unused imports fail the build.
- **The H.264 transcode path is untouched.** Do not modify `backend/app/transcode_cache.py` or anything under `backend/`.
- Cue times are in the decoder's **raw PTS domain**. The session's `currentTime` is `clock + ptsOffset`. Conversion happens in exactly one place — see Task 5.
- Work happens in the worktree `/Users/peet/GitHub/tablo-web/.claude/worktrees/closed-captions` on branch `worktree-closed-captions`. Run all frontend commands from `frontend/`.
- Baseline before starting: `npm test` → 53 files, 839 tests, 0 failures. One unhandled-error log in `showInfo.test.tsx` is pre-existing noise, not a failure. Do not fix it.

---

### Task 1: Extract caption bytes from an MPEG-2 picture

`extractCcData` is a pure function over the bytes of one coded picture. It is the only part of this feature that knows the MPEG-2 bitstream, and it knows nothing about captions beyond where their bytes sit.

**Files:**
- Create: `frontend/src/lib/captions/types.ts`
- Create: `frontend/src/lib/captions/extract.ts`
- Test: `frontend/src/__tests__/captionsExtract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CcPair { field: 0 | 1; a: number; b: number }`, `CaptionCue { startSeconds: number; endSeconds: number; text: string }`, and `extractCcData(bytes: Uint8Array): CcPair[]`.

- [ ] **Step 1: Write the types**

Create `frontend/src/lib/captions/types.ts`:

```ts
/**
 * The shapes the caption path passes around.
 *
 * Kept apart from both the extractor and the parser so that neither has to
 * import the other to name what it produces.
 */

/** One EIA-608 byte pair, as carried in ATSC picture user data. */
export interface CcPair {
  /**
   * Which 608 field this pair belongs to.
   *
   * 0 is field 1, which carries CC1 and CC2; 1 is field 2, which carries CC3,
   * CC4 and XDS. `cc_type` 2 and 3 are DTVCC (CEA-708) and never appear here.
   */
  field: 0 | 1;
  /** First byte, odd parity bit still set. */
  a: number;
  /** Second byte, odd parity bit still set. */
  b: number;
}

/** A line or block of caption text, and the span it is shown across. */
export interface CaptionCue {
  /**
   * When the cue appears.
   *
   * In whatever domain the producer works in: the decoder emits raw PTS, and
   * the session converts to media time when it is asked for a cue. See
   * `session.ts`.
   */
  startSeconds: number;
  endSeconds: number;
  /** Rows joined by newlines, as 608 captions are up to four rows. */
  text: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/__tests__/captionsExtract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractCcData } from "../lib/captions/extract";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin");

/**
 * One ATSC user-data block, shaped the way a broadcast encoder writes it.
 *
 * `0xc0 | count` sets process_em_data_flag and process_cc_data_flag and puts
 * the entry count in the low five bits, which is what the real fixture carries
 * (0xd4 there, for twenty entries). A marker byte is five set bits, then
 * cc_valid, then a two-bit cc_type.
 */
function userData(entries: Array<[valid: boolean, type: number, a: number, b: number]>): number[] {
  const out = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34, 0x03, 0xc0 | entries.length, 0xff];
  for (const [valid, type, a, b] of entries) {
    out.push(0xf8 | (valid ? 0x04 : 0x00) | type, a, b);
  }
  return out;
}

/** A slice start code, which is where a picture's payload begins. */
const SLICE = [0x00, 0x00, 0x01, 0x01];

describe("extractCcData", () => {
  it("returns the valid 608 pairs and skips the rest", () => {
    const bytes = new Uint8Array(userData([
      [true, 0, 0x4f, 0xc4],   // field 1
      [true, 1, 0x80, 0x80],   // field 2
      [true, 3, 0xc2, 0x22],   // DTVCC, not this pass
      [true, 2, 0x4f, 0x44],   // DTVCC, not this pass
      [false, 0, 0xfa, 0x00],  // padding
    ]));

    expect(extractCcData(bytes)).toEqual([
      { field: 0, a: 0x4f, b: 0xc4 },
      { field: 1, a: 0x80, b: 0x80 },
    ]);
  });

  it("stops at the first slice, which is where user data can no longer appear", () => {
    const bytes = new Uint8Array([
      ...SLICE,
      ...userData([[true, 0, 0x41, 0x42]]),
    ]);
    expect(extractCcData(bytes)).toEqual([]);
  });

  it("ignores user data that is not ATSC A/53 captions", () => {
    const notGa94 = [0x00, 0x00, 0x01, 0xb2, 0x44, 0x54, 0x47, 0x31, 0x03, 0xc1, 0xff, 0xfc, 0x41, 0x42];
    const wrongTypeCode = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34, 0x06, 0xc1, 0xff, 0xfc, 0x41, 0x42];
    expect(extractCcData(new Uint8Array(notGa94))).toEqual([]);
    expect(extractCcData(new Uint8Array(wrongTypeCode))).toEqual([]);
  });

  it("refuses a block that claims more entries than it carries", () => {
    // Says four entries, carries one. Trusting the count would read past the
    // end and invent captions out of whatever followed.
    const truncated = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34, 0x03, 0xc4, 0xff, 0xfc, 0x41, 0x42];
    expect(extractCcData(new Uint8Array(truncated))).toEqual([]);
  });

  it("honours a cleared process_cc_data_flag", () => {
    const body = userData([[true, 0, 0x41, 0x42]]);
    body[9] = 0x80 | 0x01;  // process_em_data set, process_cc_data clear
    expect(extractCcData(new Uint8Array(body))).toEqual([]);
  });

  it("reads real broadcast bytes out of the 1080i fixture", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    // The first user-data block in this capture. Verified by hand against the
    // file: 000001B2 "GA94" 03, twenty entries, four of them valid.
    expect(extractCcData(bytes.subarray(708))).toEqual([
      { field: 0, a: 0x4f, b: 0xc4 },
      { field: 1, a: 0x80, b: 0x80 },
    ]);
  });

  it("finds a caption block on every picture of the fixture", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const marker = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34];
    const starts: number[] = [];
    outer: for (let i = 0; i + marker.length < bytes.length; i++) {
      for (let k = 0; k < marker.length; k++) if (bytes[i + k] !== marker[k]) continue outer;
      starts.push(i);
    }
    // One second of 29.97fps broadcast, captioned on every picture.
    expect(starts.length).toBe(31);
    for (const start of starts) {
      const pairs = extractCcData(bytes.subarray(start));
      expect(pairs.some((p) => p.field === 0)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/captionsExtract.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/captions/extract"`.

- [ ] **Step 4: Write the extractor**

Create `frontend/src/lib/captions/extract.ts`:

```ts
/**
 * Where the captions are, in the bytes the decoder is already holding.
 *
 * ATSC carries closed captions inside the MPEG-2 video rather than beside it:
 * each coded picture may carry a user-data block, identified by `GA94`, whose
 * payload is a list of EIA-608 byte pairs and CEA-708 packet fragments. The
 * device passes the broadcast through untouched, so they are present in every
 * captioned stream the app receives and cost nothing to read.
 */

import type { CcPair } from "./types";

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
export function extractCcData(bytes: Uint8Array): CcPair[] {
  const out: CcPair[] = [];

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

/** Read one user-data block, appending whatever 608 pairs it holds. */
function readUserData(bytes: Uint8Array, p: number, out: CcPair[]): void {
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

    const type = marker & 0x03;
    // 2 and 3 are DTVCC packet data — CEA-708, which this pass does not
    // decode. They are skipped here rather than filtered later so that
    // everything downstream can assume 608.
    if (type > 1) continue;

    out.push({ field: type as 0 | 1, a: bytes[q + 1], b: bytes[q + 2] });
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd frontend && npx vitest run src/__tests__/captionsExtract.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/captions/types.ts frontend/src/lib/captions/extract.ts frontend/src/__tests__/captionsExtract.test.ts
git commit -m "feat(captions): read ATSC caption bytes out of an MPEG-2 picture"
```

---

### Task 2: Vendor the EIA-608 parser

`hls.js` ships `cea-608-parser.ts` as source — 1413 lines, BSD-licensed, ported from dash.js. It is only reachable inside `node_modules`, which Vite does not transpile, so it is copied in. Its logic is not modified; only its three imports and one `const enum` are, because this repo's compiler settings forbid them.

**Files:**
- Create: `frontend/src/lib/captions/cea608.ts` (copied, then patched)
- Test: `frontend/src/__tests__/captionsParser.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: default export `Cea608Parser` with `new Cea608Parser(field: 1 | 2, out1: CueSink, out2: CueSink)`, `addData(time: number | null, byteList: number[])`, `reset()`; named exports `CaptionScreen` (has `getDisplayText(asOneRow?: boolean): string`) and `interface CueSink { newCue(startTime: number, endTime: number, screen: CaptionScreen): void; dispatchCue?(): void; reset(): void }`.

- [ ] **Step 1: Copy the file**

```bash
cd frontend
cp node_modules/hls.js/src/utils/cea-608-parser.ts src/lib/captions/cea608.ts
```

- [ ] **Step 2: Replace the three imports**

Delete the first three lines of `src/lib/captions/cea608.ts`:

```ts
import { stringify } from './safe-json-stringify';
import { logger } from '../utils/logger';
import type OutputFilter from './output-filter';
```

and put this in their place:

```ts
/**
 * EIA-608 closed captions, vendored from hls.js.
 *
 * Source: hls.js `src/utils/cea-608-parser.ts` (v1.6.x), itself a port of
 * dash.js's `externals/cea608-parser.js`. BSD licence, reproduced below.
 *
 * Copied rather than imported because hls.js publishes this only as
 * TypeScript source under `node_modules`, which Vite does not transpile. The
 * logic is unmodified. Four things changed, all forced by this repo's
 * compiler settings: the three hls.js imports became the local declarations
 * below, and `const enum VerboseLevel` became a frozen object, because
 * `erasableSyntaxOnly` forbids enums.
 *
 * 608 is a frozen standard and this file is a port of a stable one, so it is
 * not expected to need updating. Re-copy from hls.js only if a caption bug is
 * traced to the parser itself.
 */

/** What the parser hands finished screens to. Ours is in `track.ts`. */
export interface CueSink {
  newCue(startTime: number, endTime: number, screen: CaptionScreen): void;
  /**
   * Optional in the parser, which checks for it before calling. Our collector
   * has already recorded the cue by then, so it does nothing.
   */
  dispatchCue?(): void;
  reset(): void;
}

/** Stand-in for hls.js's `OutputFilter`, which is the same shape. */
type OutputFilter = CueSink;

/** Only reached from log messages, which are off. Cycles are not a concern. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
}

/**
 * The parser logs at its own verbosity, which stays at ERROR. Routed nowhere
 * rather than to the app's logger: a per-byte state machine is not something
 * the console should ever carry.
 */
const logger = { log: (_message: string): void => {} };
```

- [ ] **Step 3: Replace the `const enum`**

`erasableSyntaxOnly` forbids enums. Replace:

```ts
const enum VerboseLevel {
  ERROR = 0,
  TEXT = 1,
  WARNING = 2,
  INFO = 2,
  DEBUG = 3,
  DATA = 3,
}
```

with:

```ts
/**
 * Was a `const enum` upstream. `erasableSyntaxOnly` forbids those, and the
 * object form is exactly equivalent here — the duplicate values (WARNING and
 * INFO both 2, DEBUG and DATA both 3) are upstream's, not a mistake.
 */
const VerboseLevel = {
  ERROR: 0,
  TEXT: 1,
  WARNING: 2,
  INFO: 2,
  DEBUG: 3,
  DATA: 3,
} as const;
type VerboseLevel = (typeof VerboseLevel)[keyof typeof VerboseLevel];
```

- [ ] **Step 4: Typecheck and fix what the compiler names**

Run: `cd frontend && npx tsc -b --force`
Expected: clean. If it names an unused local in the vendored file, delete that local; if it names anything else, fix it minimally and do not restructure the parser.

- [ ] **Step 5: Write the smoke test**

Create `frontend/src/__tests__/captionsParser.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import Cea608Parser, { type CaptionScreen, type CueSink } from "../lib/captions/cea608";

/**
 * 608 bytes carry odd parity in bit 7 and the parser rejects a byte without
 * it. Confirmed against the real fixture: 'O' (0x4f) has five set bits and
 * arrives bare, 'D' (0x44) has two and arrives as 0xc4.
 */
function par(b: number): number {
  let ones = 0;
  for (let i = 0; i < 7; i++) if (b & (1 << i)) ones++;
  return ones % 2 === 0 ? b | 0x80 : b;
}

function text(s: string): number[][] {
  const bytes = [...s].map((c) => par(c.charCodeAt(0)));
  if (bytes.length % 2) bytes.push(par(0x00));
  const pairs: number[][] = [];
  for (let i = 0; i < bytes.length; i += 2) pairs.push([bytes[i], bytes[i + 1]]);
  return pairs;
}

function collector(): CueSink & { cues: Array<{ start: number; end: number; text: string }> } {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  return {
    cues,
    newCue(start: number, end: number, screen: CaptionScreen) {
      cues.push({ start, end, text: screen.getDisplayText().trim() });
    },
    reset() { cues.length = 0; },
  };
}

describe("the vendored 608 parser", () => {
  it("turns a roll-up sequence into a cue", () => {
    const cc1 = collector();
    const cc2 = collector();
    const parser = new Cea608Parser(1, cc1, cc2);

    let t = 0;
    const feed = (pair: number[]) => { parser.addData(t, pair); t += 0.034; };

    feed([par(0x14), par(0x25)]);  // RU2 — roll up, two rows
    feed([par(0x14), par(0x2d)]);  // CR  — carriage return
    for (const pair of text("HELLO")) feed(pair);
    feed([par(0x14), par(0x2d)]);  // CR, which pushes the row out

    expect(cc1.cues.length).toBeGreaterThan(0);
    expect(cc1.cues.map((c) => c.text).join(" ")).toContain("HELLO");
  });

  it("forgets the screen on reset, so a seek does not resume mid-sentence", () => {
    const cc1 = collector();
    const parser = new Cea608Parser(1, cc1, collector());

    let t = 0;
    const feed = (pair: number[]) => { parser.addData(t, pair); t += 0.034; };
    feed([par(0x14), par(0x25)]);
    feed([par(0x14), par(0x2d)]);
    for (const pair of text("HELLO")) feed(pair);

    parser.reset();
    cc1.reset();

    feed([par(0x14), par(0x2d)]);
    expect(cc1.cues.every((c) => !c.text.includes("HELLO"))).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `cd frontend && npx vitest run src/__tests__/captionsParser.test.ts`
Expected: PASS, 2 tests. If the first fails with no cues at all, the parity helper is wrong — check a byte against the fixture values in Task 1 before changing anything in the parser.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/captions/cea608.ts frontend/src/__tests__/captionsParser.test.ts
git commit -m "feat(captions): vendor hls.js's EIA-608 parser"
```

---

### Task 3: A caption track that turns pairs into cues

**Files:**
- Create: `frontend/src/lib/captions/track.ts`
- Create: `frontend/src/lib/captions/index.ts`
- Test: `frontend/src/__tests__/captionsTrack.test.ts`

**Interfaces:**
- Consumes: `CcPair`, `CaptionCue` from Task 1; `Cea608Parser`, `CaptionScreen`, `CueSink` from Task 2.
- Produces: `createCaptionTrack(): CaptionTrack` where

```ts
interface CaptionTrack {
  add(seconds: number, pairs: readonly CcPair[]): void;
  drain(): CaptionCue[];
  readonly seen: boolean;
  reset(): void;
}
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/captionsTrack.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { createCaptionTrack } from "../lib/captions/track";
import type { CcPair } from "../lib/captions/types";

function par(b: number): number {
  let ones = 0;
  for (let i = 0; i < 7; i++) if (b & (1 << i)) ones++;
  return ones % 2 === 0 ? b | 0x80 : b;
}

const pair = (a: number, b: number, field: 0 | 1 = 0): CcPair => ({ field, a: par(a), b: par(b) });

function chars(s: string): CcPair[] {
  const bytes = [...s].map((c) => c.charCodeAt(0));
  if (bytes.length % 2) bytes.push(0x00);
  const out: CcPair[] = [];
  for (let i = 0; i < bytes.length; i += 2) out.push(pair(bytes[i], bytes[i + 1]));
  return out;
}

describe("createCaptionTrack", () => {
  it("knows nothing has been seen before it is fed", () => {
    expect(createCaptionTrack().seen).toBe(false);
  });

  it("reports a stream as captioned as soon as one field-1 pair arrives", () => {
    const track = createCaptionTrack();
    track.add(0, [pair(0x80, 0x80)]);
    expect(track.seen).toBe(true);
  });

  it("ignores field 2, which carries CC3 and CC4", () => {
    const track = createCaptionTrack();
    track.add(0, [pair(0x41, 0x42, 1)]);
    expect(track.seen).toBe(false);
  });

  it("collects a roll-up caption as a cue", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };

    feed([pair(0x14, 0x25)]);   // RU2
    feed([pair(0x14, 0x2d)]);   // CR
    feed(chars("HELLO"));
    feed([pair(0x14, 0x2d)]);   // CR

    const cues = track.drain();
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.map((c) => c.text).join(" ")).toContain("HELLO");
    expect(cues[0].startSeconds).toBeGreaterThanOrEqual(0);
    expect(cues[0].endSeconds).toBeGreaterThan(cues[0].startSeconds);
  });

  it("hands each cue out once", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };
    feed([pair(0x14, 0x25)]);
    feed([pair(0x14, 0x2d)]);
    feed(chars("HELLO"));
    feed([pair(0x14, 0x2d)]);

    expect(track.drain().length).toBeGreaterThan(0);
    expect(track.drain()).toEqual([]);
  });

  it("drops screen state on reset but stays a captioned stream", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };
    feed([pair(0x14, 0x25)]);
    feed([pair(0x14, 0x2d)]);
    feed(chars("HELLO"));

    track.reset();
    expect(track.drain()).toEqual([]);
    // A seek does not make the channel uncaptioned, and letting the button
    // vanish and come back would flicker on every skip.
    expect(track.seen).toBe(true);

    feed([pair(0x14, 0x2d)]);
    expect(track.drain().every((c) => !c.text.includes("HELLO"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/captionsTrack.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/captions/track"`.

- [ ] **Step 3: Write the track**

Create `frontend/src/lib/captions/track.ts`:

```ts
/**
 * Byte pairs in, cues out.
 *
 * EIA-608 is a command stream rather than a list of captions: the decoder
 * carries screen state across the whole broadcast, so what a viewer sees at
 * any moment depends on every pair that came before. That is why `reset`
 * exists and why a seek must call it — without it, captions resume mid
 * sentence from wherever playback used to be.
 */

import Cea608Parser, { type CaptionScreen, type CueSink } from "./cea608";
import type { CaptionCue, CcPair } from "./types";

/**
 * Records what the parser produces.
 *
 * The parser revises a cue in place as more of it arrives, calling `newCue`
 * repeatedly with the same start time and a longer end — so a repeat of a
 * start we are still holding replaces it rather than adding a second cue.
 * `dispatchCue` is left empty because by the time the parser calls it the cue
 * is already recorded; upstream's version exists to push into a hls.js
 * timeline controller, which we have none of.
 */
class CueCollector implements CueSink {
  readonly cues: CaptionCue[] = [];

  newCue(startSeconds: number, endSeconds: number, screen: CaptionScreen): void {
    const text = screen.getDisplayText().trim();
    // An empty screen is the parser saying a caption has been cleared, which
    // the overlay achieves by finding no cue rather than by drawing nothing.
    if (!text) return;

    const last = this.cues[this.cues.length - 1];
    if (last && last.startSeconds === startSeconds) {
      last.endSeconds = endSeconds;
      last.text = text;
      return;
    }
    this.cues.push({ startSeconds, endSeconds, text });
  }

  dispatchCue(): void {}

  reset(): void {
    this.cues.length = 0;
  }
}

export interface CaptionTrack {
  /** Feed one picture's pairs, at that picture's presentation time. */
  add(seconds: number, pairs: readonly CcPair[]): void;
  /** Cues completed since the last call. Each is handed out once. */
  drain(): CaptionCue[];
  /**
   * Whether this stream has ever carried captions.
   *
   * What the player's CC button is shown on, which is why it survives a
   * reset: a seek does not make a captioned channel uncaptioned.
   */
  readonly seen: boolean;
  /** Forget the screen. For a seek or a discontinuity. */
  reset(): void;
}

export function createCaptionTrack(): CaptionTrack {
  const cc1 = new CueCollector();
  const cc2 = new CueCollector();
  // Field 1, which carries CC1 and CC2. Field 2 is CC3, CC4 and XDS; the
  // extractor keeps its pairs because they cost nothing to read, but nothing
  // decodes them in this pass.
  const parser = new Cea608Parser(1, cc1, cc2);
  let seen = false;

  return {
    add(seconds: number, pairs: readonly CcPair[]) {
      for (const pair of pairs) {
        if (pair.field !== 0) continue;
        seen = true;
        parser.addData(seconds, [pair.a, pair.b]);
      }
    },

    // CC1 only. CC2 is a second service on the same field — usually a second
    // language — and the parser needs somewhere to put it either way.
    drain: () => cc1.cues.splice(0),

    get seen() { return seen; },

    reset() {
      parser.reset();
      cc1.reset();
      cc2.reset();
    },
  };
}
```

- [ ] **Step 4: Write the barrel**

Create `frontend/src/lib/captions/index.ts`:

```ts
export { extractCcData } from "./extract";
export { createCaptionTrack, type CaptionTrack } from "./track";
export type { CaptionCue, CcPair } from "./types";
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd frontend && npx vitest run src/__tests__/captionsTrack.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/captions/track.ts frontend/src/lib/captions/index.ts frontend/src/__tests__/captionsTrack.test.ts
git commit -m "feat(captions): turn 608 byte pairs into timed cues"
```

---

### Task 4: The decoder emits cues

**Files:**
- Modify: `frontend/src/lib/wasmlive/libavClient.ts` (`DecodeOutput` near line 99; `runPump`'s video branch near line 514; `reset` )
- Modify: `frontend/src/lib/wasmlive/workerProtocol.ts` (`FromWorker` union; `emit` in `createWorkerHandler`)
- Test: `frontend/src/__tests__/captionsWorker.test.ts`

**Interfaces:**
- Consumes: `extractCcData`, `createCaptionTrack`, `CaptionCue` from Tasks 1 and 3.
- Produces: `DecodeOutput.captions: CaptionCue[]`, and `FromWorker` member `{ type: "captions"; cues: CaptionCue[]; epoch: number }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/captionsWorker.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { createWorkerHandler } from "../lib/wasmlive/workerProtocol";
import type { FromWorker } from "../lib/wasmlive/workerProtocol";
import type { DecodeOutput, LibavDecoder } from "../lib/wasmlive/libavClient";

function harness() {
  const posted: FromWorker[] = [];
  let emit: (out: DecodeOutput) => void = () => {};

  const decoder: LibavDecoder = {
    push: async () => {},
    flush: async () => {},
    reset: async () => {},
    close: async () => {},
    stats: () => ({
      bytesFed: 0, bytesDelivered: 0, opened: true, bytesAtOpen: null, msToOpen: null,
      videoStream: true, audioStream: true, videoFrames: 0, audioChunks: 0,
      videoDropped: 0, audioDropped: 0,
    }),
  };

  const handle = createWorkerHandler(
    async (onOutput) => { emit = onOutput; return decoder; },
    (message) => { posted.push(message); },
  );

  return { posted, handle, emitOutput: (out: DecodeOutput) => emit(out) };
}

const cue = { startSeconds: 1, endSeconds: 3, text: "HELLO" };

describe("the worker's caption messages", () => {
  it("posts cues stamped with the current epoch", async () => {
    const { posted, handle, emitOutput } = harness();
    await handle({ type: "open" });
    emitOutput({ video: [], audio: [], captions: [cue] });

    expect(posted).toContainEqual({ type: "captions", cues: [cue], epoch: 0 });
  });

  it("says nothing when a read round produced no captions", async () => {
    const { posted, handle, emitOutput } = harness();
    await handle({ type: "open" });
    emitOutput({ video: [], audio: [], captions: [] });

    expect(posted.some((m) => m.type === "captions")).toBe(false);
  });

  it("stamps cues with the epoch adopted at the last reset", async () => {
    const { posted, handle, emitOutput } = harness();
    await handle({ type: "open" });
    await handle({ type: "reset", epoch: 4 });
    emitOutput({ video: [], audio: [], captions: [cue] });

    expect(posted).toContainEqual({ type: "captions", cues: [cue], epoch: 4 });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/captionsWorker.test.ts`
Expected: FAIL — `captions` is not a property of `DecodeOutput`, and no `captions` message is posted.

- [ ] **Step 3: Widen `DecodeOutput`**

In `frontend/src/lib/wasmlive/libavClient.ts`, change:

```ts
export interface DecodeOutput {
  video: DecodedVideoFrame[];
  audio: DecodedAudioChunk[];
}
```

to:

```ts
export interface DecodeOutput {
  video: DecodedVideoFrame[];
  audio: DecodedAudioChunk[];
  /**
   * Captions finished in this read round.
   *
   * Times are in the decoder's own PTS domain, the same one `ptsSeconds`
   * carries; the session converts to media time when it is asked for a cue.
   */
  captions: CaptionCue[];
}
```

Add to the imports at the top of the file:

```ts
import { createCaptionTrack, extractCcData, type CaptionCue } from "../captions";
```

- [ ] **Step 4: Extract and parse in the pump**

In `createDecoder`, alongside the other per-decoder state, add:

```ts
  /**
   * The 608 state machine, which lives as long as the decoder does.
   *
   * A seek tears the decoder down and builds a new one, which is exactly the
   * lifetime a caption parser wants: screen state from the old position must
   * not survive into the new one.
   */
  const captionTrack = createCaptionTrack();
```

In `runPump`, change `const out: DecodeOutput = { video: [], audio: [] };` to:

```ts
      const out: DecodeOutput = { video: [], audio: [], captions: [] };
```

and inside `if (videoPackets.length) {`, **before** the decode, insert:

```ts
        // Captions come off the packets rather than the frames: libav.js
        // exposes no frame side data, and the bytes are in the picture's user
        // data where the extractor can find them without any of it.
        //
        // Sorted by PTS first. MPEG-2 carries a presentation timestamp per
        // picture, so PTS order is display order, and 608 is a command stream
        // that means different things in a different order.
        const timed: Array<{ seconds: number; packet: (typeof videoPackets)[number] }> = [];
        for (const packet of videoPackets) {
          const seconds = packetSeconds(packet);
          if (seconds !== null) timed.push({ seconds, packet });
        }
        timed.sort((a, b) => a.seconds - b.seconds);
        for (const { seconds, packet } of timed) {
          const data = packet.data;
          if (!data || !data.length) continue;
          const pairs = extractCcData(data instanceof Uint8Array ? data : new Uint8Array(data));
          if (pairs.length) captionTrack.add(seconds, pairs);
        }
        out.captions = captionTrack.drain();
```

Add the helper next to `ptsSeconds` near line 248:

```ts
/** The largest PTS libav uses to mean "there isn't one". */
const NOPTS_HI = -2147483648;

/**
 * A demuxed packet's presentation time, or null when it has none.
 *
 * Packets do not always carry their own time base, so the stream's stands in.
 * A packet with no PTS cannot time a caption and is skipped rather than
 * guessed at: a caption on the wrong second is worse than one that is missing.
 */
function packetSecondsWith(
  streamTimeBaseNum: number,
  streamTimeBaseDen: number,
): (packet: { pts?: number; ptshi?: number; time_base_num?: number; time_base_den?: number }) => number | null {
  return (packet) => {
    if (packet.pts === undefined || packet.ptshi === NOPTS_HI) return null;
    const num = packet.time_base_num ?? streamTimeBaseNum;
    const den = packet.time_base_den ?? streamTimeBaseDen;
    if (!num || !den) return null;
    return ((packet.ptshi ?? 0) * 4294967296 + packet.pts) * (num / den);
  };
}
```

and bind it where `videoStream` is known (just after the `videoStream` checks around line 428):

```ts
      const packetSeconds = packetSecondsWith(
        videoStream.time_base_num, videoStream.time_base_den,
      );
```

If `packetSeconds` is not in scope at the pump, hoist the `const` to where the other decoder-lifetime values live and assign it at open; do not recompute it per round.

- [ ] **Step 5: Reset the track with the decoder**

Find the decoder's `reset()` and add `captionTrack.reset();` to it, with the comment:

```ts
      // The screen state goes with the decoder. Kept, deliberately, is the
      // track's memory that this stream carries captions at all.
      captionTrack.reset();
```

- [ ] **Step 6: Count what was seen, for `tabloDebug()`**

The spec's risk table calls for this: a channel carrying captions only in 708 would show no button and say nothing about why. Counters make the difference between "no captions" and "captions we did not decode" visible.

In `DecoderStats`, after `audioDropped`:

```ts
  /**
   * 608 pairs extracted, and cues they produced.
   *
   * A stream with pairs and no cues is one whose captions are arriving and not
   * being decoded; a stream with neither is simply uncaptioned. Without both
   * numbers those two look identical from outside, and only one is a bug.
   */
  captionPairs: number;
  captionCues: number;
```

Keep two counters beside the decoder's existing ones, increment them where the pairs are extracted and the cues drained, and report them from `stats()`. Add `captionPairs: 0, captionCues: 0` to the stub in `captionsWorker.test.ts` and to any other `DecoderStats` literal the typecheck names.

- [ ] **Step 7: Post the cues**

In `frontend/src/lib/wasmlive/workerProtocol.ts`, add to the `FromWorker` union, after the `audio` member:

```ts
  /**
   * Caption cues, stamped like the media they belong beside.
   *
   * Small enough to copy — a cue is two numbers and a line of text — so
   * nothing is transferred.
   */
  | { type: "captions"; cues: CaptionCue[]; epoch: number }
```

Add to that file's imports:

```ts
import type { CaptionCue } from "../captions";
```

and in `emit`, after the audio branch:

```ts
    if (out.captions.length) {
      post({ type: "captions", cues: out.captions, epoch }, []);
    }
```

- [ ] **Step 8: Run the test and watch it pass**

Run: `cd frontend && npx vitest run src/__tests__/captionsWorker.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Run the whole suite and fix what the widened type broke**

Run: `cd frontend && npm test`
Expected: any test that builds a `DecodeOutput` literal now fails to typecheck. Add `captions: []` to each. Do not change their behaviour.

Run: `cd frontend && npx tsc -b --force`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/wasmlive/libavClient.ts frontend/src/lib/wasmlive/workerProtocol.ts frontend/src/__tests__/captionsWorker.test.ts
git commit -m "feat(captions): decode captions in the worker and post them with the media"
```

---

### Task 5: The session holds cues, and the surface offers them

**Files:**
- Modify: `frontend/src/lib/wasmlive/session.ts` (`SessionEvent`, `LiveSession`, `onmessage` near line 409, the seek path near line 1060)
- Modify: `frontend/src/lib/wasmlive/wasmSurface.ts`
- Modify: `frontend/src/lib/playbackSurface.ts` (`PlaybackSurface`)
- Test: `frontend/src/__tests__/captionsSession.test.ts`

**Interfaces:**
- Consumes: the `captions` message from Task 4.
- Produces:

```ts
export interface CaptionSource {
  readonly available: boolean;
  at(mediaSeconds: number): CaptionCue | null;
  on(event: "change", handler: () => void): () => void;
}
```

on `PlaybackSurface` as `captions?: CaptionSource`, and on `LiveSession` as `captions: CaptionSource`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/captionsSession.test.ts`. Reuse the harness in `frontend/src/__tests__/wasmliveSession.test.ts` — it is the only file that builds `createSession` with fake deps. Copy its setup rather than inventing a second one, then add:

```ts
import { describe, it, expect } from "vitest";

// Reuse the existing session harness in this directory; it already fakes the
// worker, audio sink, presenter and fetches.

describe("the session's captions", () => {
  it("is unavailable until a cue arrives", () => {
    const { session } = harness();
    expect(session.captions.available).toBe(false);
    expect(session.captions.at(0)).toBeNull();
  });

  it("offers the cue covering the given media time", () => {
    const { session, postFromWorker, setPtsOffset } = harness();
    setPtsOffset(0);
    postFromWorker({
      type: "captions", epoch: 0,
      cues: [{ startSeconds: 10, endSeconds: 13, text: "HELLO" }],
    });

    expect(session.captions.available).toBe(true);
    expect(session.captions.at(11)?.text).toBe("HELLO");
    expect(session.captions.at(9)).toBeNull();
    expect(session.captions.at(14)).toBeNull();
  });

  it("reads cues in media time, not the decoder's", () => {
    const { session, postFromWorker, setPtsOffset } = harness();
    // The device's clock starts wherever it starts; media time is that plus
    // the offset the first audio chunk established.
    setPtsOffset(100);
    postFromWorker({
      type: "captions", epoch: 0,
      cues: [{ startSeconds: 10, endSeconds: 13, text: "HELLO" }],
    });

    expect(session.captions.at(111)?.text).toBe("HELLO");
    expect(session.captions.at(11)).toBeNull();
  });

  it("discards cues from before a seek", () => {
    const { session, postFromWorker } = harness();
    postFromWorker({
      type: "captions", epoch: 99,
      cues: [{ startSeconds: 10, endSeconds: 13, text: "STALE" }],
    });
    expect(session.captions.at(11)).toBeNull();
  });

  it("replaces a cue the parser revised rather than showing it twice", () => {
    const { session, postFromWorker, setPtsOffset } = harness();
    setPtsOffset(0);
    postFromWorker({ type: "captions", epoch: 0, cues: [{ startSeconds: 10, endSeconds: 11, text: "HEL" }] });
    postFromWorker({ type: "captions", epoch: 0, cues: [{ startSeconds: 10, endSeconds: 13, text: "HELLO" }] });

    expect(session.captions.at(12)?.text).toBe("HELLO");
  });

  it("tells a listener when cues change", () => {
    const { session, postFromWorker } = harness();
    let changes = 0;
    session.captions.on("change", () => { changes++; });
    postFromWorker({ type: "captions", epoch: 0, cues: [{ startSeconds: 1, endSeconds: 2, text: "A" }] });
    expect(changes).toBe(1);
  });
});
```

If the existing harness has no way to set `ptsOffset` or post a worker message, add those to it — they are the two things this feature needs to be testable, and both are ordinary test seams.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/captionsSession.test.ts`
Expected: FAIL — `session.captions` is undefined.

- [ ] **Step 3: Add `CaptionSource` to the surface contract**

In `frontend/src/lib/playbackSurface.ts`, add the import and the interface, and the optional member on `PlaybackSurface` after `repaint?()`:

```ts
import type { CaptionCue } from "./captions";

/**
 * Captions, where an implementation has any.
 *
 * `at` takes media seconds, which is the domain the whole player speaks;
 * converting from whatever the decoder counts in is the implementation's job.
 */
export interface CaptionSource {
  /**
   * Whether this stream has been seen to carry captions.
   *
   * What the CC button is shown on. False until the first cue, so a stream
   * with no captions never offers a control that would do nothing.
   */
  readonly available: boolean;
  /** The cue covering this media time, or null. */
  at(mediaSeconds: number): CaptionCue | null;
  on(event: "change", handler: () => void): () => void;
}
```

```ts
  /**
   * Captions, when this implementation can produce them.
   *
   * Optional, and absent on the element-backed surface: an H.264 transcode
   * carries none, so a surface with nothing to show says so by not having
   * this. That is also what keeps the player's rule for showing its CC button
   * to one clause rather than a list of cases.
   */
  captions?: CaptionSource;
```

- [ ] **Step 4: Hold the cues in the session**

In `frontend/src/lib/wasmlive/session.ts`:

Add `"captions"` to `SessionEvent`:

```ts
export type SessionEvent =
  | "ready" | "timeupdate" | "waiting" | "playing" | "ended" | "error" | "captions";
```

Add `readonly captions: CaptionSource;` to `LiveSession`, and the imports:

```ts
import type { CaptionSource } from "../playbackSurface";
import type { CaptionCue } from "../captions";
```

Inside `createSession`, beside the other state:

```ts
  /**
   * Cues waiting to be shown, oldest first, in the decoder's PTS domain.
   *
   * Held raw rather than converted on arrival because `ptsOffset` is not known
   * until the first audio chunk anchors the clock, and cues can arrive before
   * it. Converting at the point of the question keeps one conversion rather
   * than two and cannot be done too early.
   */
  let cues: CaptionCue[] = [];
  /** Whether this stream has ever carried captions. Survives a seek. */
  let captionsSeen = false;
  const captionHandlers = new Set<() => void>();
```

In `deps.worker.onmessage`, add `"captions"` to the epoch filter and a branch to handle it. The filter line becomes:

```ts
    if (
      (message.type === "video" || message.type === "audio" || message.type === "captions") &&
      message.epoch !== epoch
    ) {
      return;
    }
```

and the branch, after the `audio` branch:

```ts
    if (message.type === "captions") {
      captionsSeen = true;
      for (const cue of message.cues) {
        // The parser revises a cue as more of it arrives and re-sends it under
        // the same start, so a repeat replaces rather than stacks.
        const at = cues.findIndex((c) => c.startSeconds === cue.startSeconds);
        if (at >= 0) cues[at] = cue; else cues.push(cue);
      }
      cues.sort((a, b) => a.startSeconds - b.startSeconds);
      // A long recording would otherwise accumulate every caption of every
      // hour played. Forty is more than a screen's worth of history.
      if (cues.length > 40) cues = cues.slice(-40);
      captionHandlers.forEach((fn) => fn());
      emit("captions");
      return;
    }
```

Where the seek path clears `ptsOffset` (near line 1060), clear the queue too:

```ts
      // The cues belong to where playback was. `captionsSeen` does not: the
      // channel is still a captioned one, and a button that vanished on every
      // skip would flicker.
      cues = [];
```

Add to the returned object:

```ts
    captions: {
      get available() { return captionsSeen; },
      at(mediaSeconds: number) {
        // Media time back to the decoder's, which is what the cues carry.
        const raw = mediaSeconds - (ptsOffset ?? 0);
        for (let i = cues.length - 1; i >= 0; i--) {
          const cue = cues[i];
          if (raw >= cue.startSeconds && raw < cue.endSeconds) return cue;
        }
        return null;
      },
      on(_event: "change", handler: () => void) {
        captionHandlers.add(handler);
        return () => captionHandlers.delete(handler);
      },
    },
```

Add `captionCues: cues.length` and `captionsSeen` to the object `diagnostics()` returns, next to `ptsOffset`.

- [ ] **Step 5: Pass it through the surface**

In `frontend/src/lib/wasmlive/wasmSurface.ts`, add to the returned object, after `diagnostics`:

```ts
    /* Read straight through. The session owns the queue and the conversion to
       media time; mirroring either here is how two copies of one number start
       to drift. */
    captions: session.captions,
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/captionsSession.test.ts`
Expected: PASS, 6 tests.

Run: `cd frontend && npm test && npx tsc -b --force`
Expected: full suite green, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/wasmlive/session.ts frontend/src/lib/wasmlive/wasmSurface.ts frontend/src/lib/playbackSurface.ts frontend/src/__tests__/captionsSession.test.ts
git commit -m "feat(captions): hold cues on the session and offer them through the surface"
```

---

### Task 6: Draw the captions

**Files:**
- Create: `frontend/src/components/CaptionOverlay.tsx`
- Test: `frontend/src/__tests__/captionOverlay.test.tsx`

**Interfaces:**
- Consumes: `CaptionSource` from Task 5, `FrameSource` and `startFrameLoop` from `frontend/src/lib/playbackSurface.ts`.
- Produces: `<CaptionOverlay source={...} enabled={...} frames={...} />`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/captionOverlay.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { CaptionOverlay } from "../components/CaptionOverlay";
import type { CaptionSource } from "../lib/playbackSurface";
import type { FrameSource } from "../lib/playbackSurface";

/** A frame source a test steps by hand, so no clock is involved. */
function manualFrames() {
  let pending: FrameRequestCallback | null = null;
  const frames: FrameSource = {
    request(callback) { pending = callback; return 1; },
    cancel() { pending = null; },
  };
  return { frames, step: () => { const p = pending; pending = null; p?.(0); } };
}

function source(cues: Array<{ startSeconds: number; endSeconds: number; text: string }>) {
  let now = 0;
  const src: CaptionSource = {
    available: true,
    at: () => cues.find((c) => now >= c.startSeconds && now < c.endSeconds) ?? null,
    on: () => () => {},
  };
  return { src, seek: (t: number) => { now = t; } };
}

describe("CaptionOverlay", () => {
  it("draws the cue covering the current time", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 1, endSeconds: 3, text: "HELLO" }]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(2);
    step();

    expect(screen.getByText("HELLO")).toBeTruthy();
  });

  it("draws nothing when no cue covers the time", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 1, endSeconds: 3, text: "HELLO" }]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(5);
    step();

    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("draws nothing when captions are switched off", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 1, endSeconds: 3, text: "HELLO" }]);

    render(<CaptionOverlay source={src} enabled={false} currentTime={() => 0} frames={frames} />);
    seek(2);
    step();

    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("puts each row on its own line", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 0, endSeconds: 9, text: "FIRST\nSECOND" }]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(1);
    step();

    expect(screen.getByText("FIRST")).toBeTruthy();
    expect(screen.getByText("SECOND")).toBeTruthy();
  });

  it("is announced to a screen reader", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 0, endSeconds: 9, text: "HELLO" }]);

    const { container } = render(
      <CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/captionOverlay.test.tsx`
Expected: FAIL — cannot resolve `../components/CaptionOverlay`.

- [ ] **Step 3: Write the overlay**

Create `frontend/src/components/CaptionOverlay.tsx`:

```tsx
/**
 * Captions, over the picture.
 *
 * Drawn in the DOM rather than into the canvas: text stays crisp at any window
 * size, a screen reader can read it, and a test can assert on it without a
 * GPU. The cost is that `captureStream` does not carry it, so captions do not
 * appear in the picture-in-picture pop-out.
 *
 * It steps on animation frames rather than on the player's `timeupdate`, which
 * fires about four times a second — enough for a scrubber, visibly late for
 * roll-up captions that advance a word at a time.
 */

import { useEffect, useState } from "react";

import { startFrameLoop, DOCUMENT_FRAMES } from "../lib/playbackSurface";
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";

export function CaptionOverlay({
  source, enabled, currentTime, frames = DOCUMENT_FRAMES,
}: {
  source: CaptionSource;
  enabled: boolean;
  /** Media seconds, read fresh each frame rather than passed as a value. */
  currentTime: () => number;
  /** Injected so a test can step the loop by hand. */
  frames?: FrameSource;
}) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) { setText(null); return; }
    const loop = startFrameLoop(() => {
      const cue = source.at(currentTime());
      // Set through a setter that compares, so an unchanged caption does not
      // re-render sixty times a second.
      setText((was) => (was === (cue?.text ?? null) ? was : cue?.text ?? null));
      return true;
    }, frames);
    return () => loop.stop();
  }, [source, enabled, currentTime, frames]);

  if (!enabled || !text) return null;

  return (
    <div
      className="absolute inset-x-0 bottom-[12%] flex justify-center pointer-events-none px-4"
      aria-live="polite"
    >
      <div className="max-w-[80%] rounded px-3 py-1 bg-black/75 text-white
                      text-[clamp(0.9rem,2.6cqw,1.6rem)] font-medium leading-snug text-center">
        {text.split("\n").map((row, i) => (
          <p key={i}>{row}</p>
        ))}
      </div>
    </div>
  );
}
```

Note: the `每` in the doc comment above is a typo to fix — the line should read "read fresh each frame rather than passed as a value."

If `cqw` units need a container context, add `@container` sizing to the stage host, or fall back to `text-base sm:text-lg md:text-xl`. Do not leave a unit that resolves to zero.

Then fix the typo this plan carries into the file: the `currentTime` doc comment must read "read fresh each frame rather than passed as a value."

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd frontend && npx vitest run src/__tests__/captionOverlay.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CaptionOverlay.tsx frontend/src/__tests__/captionOverlay.test.tsx
git commit -m "feat(captions): draw cues over the picture"
```

---

### Task 7: The CC button

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx` (`PlayerView` near line 269; the view object near line 2331; `Stage`'s destructure near line 2518; the control bar beside the PiP button near line 3189; the key handler near line 2232; the stage host near line 2672)
- Test: `frontend/src/__tests__/captionButton.test.tsx`

**Interfaces:**
- Consumes: `CaptionOverlay` from Task 6, `surface.captions` from Task 5.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

First extend the shared stub. In `frontend/src/__tests__/decoderPolicySupport.tsx`, give `stubSurface` an optional caption source — it is the fixture every player test already builds its surface from:

```tsx
import type { CaptionCue } from "../lib/captions";
import type { CaptionSource, PlaybackSurface } from "../lib/playbackSurface";

/** A caption source a test drives directly. */
export function stubCaptions(cues: CaptionCue[] = []): CaptionSource & { announce(): void } {
  const handlers = new Set<() => void>();
  let seen = cues.length > 0;
  return {
    get available() { return seen; },
    at: (seconds: number) =>
      cues.find((c) => seconds >= c.startSeconds && seconds < c.endSeconds) ?? null,
    on(_event: "change", handler: () => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    /** What the session does the first time a cue arrives. */
    announce() { seen = true; handlers.forEach((fn) => fn()); },
  };
}
```

and add a second parameter to `stubSurface`, defaulting to no captions so every existing caller is unchanged:

```tsx
export function stubSurface(
  audioContext = "running",
  captions?: CaptionSource,
): PlaybackSurface {
  return {
    // ...everything already here, unchanged...
    captions,
  };
}
```

Then create `frontend/src/__tests__/captionButton.test.tsx`, following `decoderPolicy.test.tsx`'s module mocks exactly — they are what let a jsdom test take the WASM path at all:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import { CHANNEL, NEWS_HOUR, stubCaptions, stubSurface } from "./decoderPolicySupport";

const wasm = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../lib/wasmlive/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wasmlive/capability")>();
  // jsdom has no WebGL2, no OffscreenCanvas and no Chrome user agent, so the
  // real check can only say no. Which path plays is the premise here, not the
  // subject.
  return { ...actual, wasmLiveEligible: () => ({ eligible: true, reason: "" }) };
});

vi.mock("../lib/wasmlive/open", () => ({ openWasmSurface: wasm.open }));

const CUE = { startSeconds: 0, endSeconds: 600, text: "HELLO" };

function renderLive() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer
        source={{ kind: "live", channel: CHANNEL, program: NEWS_HOUR }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

const ccButton = () => screen.queryByLabelText(/closed captions/i);

describe("the CC button", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "abc", proxy_url: "/api/hls/abc/playlist.m3u8", mode: "raw",
    } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("is absent while the stream has shown no captions", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions()));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    expect(ccButton()).toBeNull();
  });

  it("is absent on a surface that cannot produce captions at all", async () => {
    // No caption source is how the H.264 transcode fallback says it has none.
    wasm.open.mockResolvedValue(stubSurface("running"));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    expect(ccButton()).toBeNull();
  });

  it("appears once a caption has been seen", async () => {
    const captions = stubCaptions([CUE]);
    wasm.open.mockResolvedValue(stubSurface("running", captions));
    renderLive();
    expect(await screen.findByLabelText(/closed captions/i)).toBeTruthy();
  });

  it("appears mid-playback, when the first cue arrives a second in", async () => {
    const captions = stubCaptions();
    captions.at = () => CUE;
    wasm.open.mockResolvedValue(stubSurface("running", captions));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    expect(ccButton()).toBeNull();

    act(() => captions.announce());
    expect(await screen.findByLabelText(/closed captions/i)).toBeTruthy();
  });

  it("toggles captions on and off", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([CUE])));
    renderLive();
    const button = await screen.findByLabelText(/closed captions/i);

    fireEvent.click(button);
    expect(await screen.findByText("HELLO")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/closed captions/i));
    await waitFor(() => expect(screen.queryByText("HELLO")).toBeNull());
  });

  it("remembers the choice", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([CUE])));
    renderLive();
    fireEvent.click(await screen.findByLabelText(/closed captions/i));
    await waitFor(() => expect(localStorage.getItem("tablo.cc")).toBe("1"));
  });

  it("toggles on C", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([CUE])));
    renderLive();
    await screen.findByLabelText(/closed captions/i);

    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByText("HELLO")).toBeTruthy();
  });
});
```

The overlay runs on real animation frames here. If a cue does not appear, drive one frame with `act()` rather than adding a timeout — and if `startStream`'s stubbed shape has drifted, copy the current one from `decoderPolicy.test.tsx` instead of guessing.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/captionButton.test.tsx`
Expected: FAIL — no element with that label.

- [ ] **Step 3: Hold the setting**

In `VideoPlayer`, beside the other latched state near line 456:

```ts
  /**
   * Captions on or off, remembered.
   *
   * Read defensively: a browser blocking site data throws on access, and that
   * reads as off, which is the same answer everyone else starts from.
   */
  const [captionsOn, setCaptionsOn] = useState(() => {
    try { return localStorage.getItem("tablo.cc") === "1"; } catch { return false; }
  });
  const toggleCaptions = useCallback(() => {
    setCaptionsOn((was) => {
      const next = !was;
      try { localStorage.setItem("tablo.cc", next ? "1" : "0"); } catch { /* not worth failing over */ }
      return next;
    });
  }, []);
```

Track availability, which changes after playback starts:

```ts
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
```

In `attachTransport` (near line 765), subscribe:

```ts
    // A stream announces itself as captioned the first time a cue arrives,
    // roughly a second in. The button appears then and not before, so it is
    // never offered where it would do nothing.
    const captions = surface.captions;
    if (captions) {
      setCaptionsAvailable(captions.available);
      const off = captions.on("change", () => setCaptionsAvailable(captions.available));
      cleanups.push(off);
    } else {
      setCaptionsAvailable(false);
    }
```

using whatever cleanup list `attachTransport` already keeps; if it keeps none, return the unsubscribe the way its other subscriptions are returned.

- [ ] **Step 4: Add the shortcut**

Beside `if (e.key === "p") togglePictureInPicture();` near line 2232:

```ts
      if (e.key === "c" && captionsAvailable) toggleCaptions();
```

- [ ] **Step 5: Add the button**

Add `captionsOn`, `toggleCaptions`, `captionsAvailable`, `captionSource` and `surfaceTime` to `PlayerView`, to the `view` object, and to `Stage`'s destructure — following exactly how `poppedOut` and `togglePictureInPicture` are threaded through all three.

In the control bar, immediately before the picture-in-picture button:

```tsx
              {captionsAvailable && (
                <button
                  type="button"
                  onClick={toggleCaptions}
                  className={`rounded-lg glass text-player-fg flex items-center justify-center hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8" : "w-9 h-9"} ${captionsOn ? "bg-fill" : ""}`}
                  /* Named with its key, the way Mute and Picture in picture
                     either side of it are. */
                  title={captionsOn ? "Hide closed captions (C)" : "Show closed captions (C)"}
                  aria-label={captionsOn ? "Hide closed captions (C)" : "Show closed captions (C)"}
                  aria-pressed={captionsOn}
                >
                  <Captions className="w-4 h-4" aria-hidden />
                </button>
              )}
```

Import `Captions` from `lucide-react` alongside the other icons. Confirm the export exists (`rg "Captions" frontend/node_modules/lucide-react/dist/lucide-react.d.ts | head`); if it does not, use `Subtitles`.

- [ ] **Step 6: Mount the overlay**

In `Stage`, inside the same relatively-positioned container that holds `videoHostRef`, after the host div:

```tsx
      {captionSource && (
        <CaptionOverlay
          source={captionSource}
          enabled={captionsOn}
          currentTime={surfaceTime}
        />
      )}
```

where `surfaceTime` is a stable `useCallback(() => surfaceRef.current?.currentTime ?? 0, [])` on `PlayerView`. Do not pass `currentTime` as a number — the overlay reads it per frame.

Mount it in the tab's stage only. The pop-out draws from the mirror and carries no DOM of ours.

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/captionButton.test.tsx`
Expected: PASS, 6 tests.

Run: `cd frontend && npm test && npx tsc -b --force`
Expected: full suite green, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/VideoPlayer.tsx frontend/src/__tests__/captionButton.test.tsx
git commit -m "feat(captions): a CC button that appears only where there are captions"
```

---

### Task 8: Prove it end to end on real broadcast bytes

The one-second fixture is long enough to assert extraction byte for byte and too short for the parser to finish a cue — pop-on captions take roughly two seconds. This task captures a longer one.

**Files:**
- Create: `frontend/src/lib/wasmlive/__fixtures__/1080i-captions-10s.ts.bin`
- Test: `frontend/src/__tests__/captionsEndToEnd.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Capture the fixture**

Find a captioned recording's source segments under
`~/Library/Application Support/tablo-web/cache/recordings/`, or pull ten seconds of a live channel. Verify before committing:

```bash
xxd -p CANDIDATE.ts | tr -d '\n' | grep -o '000001b247413934' | wc -l
```

Expected: roughly 30 per second of content. Keep the file under about 12 MB.

```bash
cp CANDIDATE.ts frontend/src/lib/wasmlive/__fixtures__/1080i-captions-10s.ts.bin
```

- [ ] **Step 2: Write the test**

Create `frontend/src/__tests__/captionsEndToEnd.test.ts`, modelled on `wasmliveDecodeDiagnosis.test.ts` — including its `@vitest-environment node` pragma, which it needs because the libav loader resolves its wasm against the document.

```ts
/**
 * Captions, from broadcast bytes to text.
 *
 * The unit tests above pin each stage against synthetic input. This one runs
 * the real decoder over real MPEG-2 and asserts that words come out, which is
 * the only test that would have caught a correct extractor wired to a correct
 * parser in the wrong order.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDecoder } from "../lib/wasmlive/libavClient";
import type { DecodeOutput } from "../lib/wasmlive/libavClient";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/1080i-captions-10s.ts.bin");

describe("captions end to end", () => {
  it("produces caption text from real broadcast bytes", async () => {
    const collected: DecodeOutput["captions"] = [];
    const decoder = await createDecoder({
      onOutput: (out) => { collected.push(...out.captions); },
    });

    await decoder.push(new Uint8Array(readFileSync(FIXTURE)));
    await decoder.flush();
    await decoder.close();

    expect(collected.length).toBeGreaterThan(0);
    // Real captions are words, not punctuation noise.
    expect(collected.some((c) => /[A-Za-z]{3,}/.test(c.text))).toBe(true);
    // And they are timed within the ten seconds the fixture covers.
    for (const cue of collected) {
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
    }
  }, 60_000);
});
```

- [ ] **Step 3: Run it**

Run: `cd frontend && npx vitest run src/__tests__/captionsEndToEnd.test.ts`
Expected: PASS. If cues come out empty, print the first twenty pairs the extractor found and check them against the hand-decoded values in the spec before touching the parser.

- [ ] **Step 4: Measure the scan cost**

Add a temporary `performance.now()` around the extraction loop, run the test, and record microseconds per picture. Report the number. If it exceeds roughly 50µs per picture, say so rather than optimising on spec. Remove the instrumentation before committing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/__fixtures__/1080i-captions-10s.ts.bin frontend/src/__tests__/captionsEndToEnd.test.ts
git commit -m "test(captions): decode real broadcast captions end to end"
```

---

### Task 9: Verify in the running app, then ship

**Files:** none.

- [ ] **Step 1: Full suite and typecheck**

Run: `cd frontend && npm test && npx tsc -b --force && npm run build`
Expected: 0 failures, clean typecheck, successful build. Baseline was 839 tests; the count should now be higher and nothing previously passing may fail.

- [ ] **Step 2: Run the app**

Use the `tablo-stack` skill. Do not run a bare `docker compose up` — it serves the app from the wrong backend and nothing in the UI says so.

- [ ] **Step 3: Watch a captioned live channel**

At `127.0.0.1:7070`, open a live OTA channel known to be captioned. Confirm: the CC button appears a second or two in; clicking it shows captions; they track speech rather than leading or lagging it; `C` toggles; the setting survives a reload.

- [ ] **Step 4: Watch a recording**

Open a recording that plays through the WASM path. Confirm captions appear, and that seeking backwards and forwards leaves them correct rather than stuck on an old line.

- [ ] **Step 5: Confirm the button stays honest**

Set `tablo.wasmlive = "0"` in localStorage and reload. Playback falls back to the H.264 transcode; the CC button must not appear at all. Restore the flag afterwards.

- [ ] **Step 6: Report before merging**

State what was seen on each of steps 3 to 5, with the test counts from step 1. Do not describe this as working on the basis of the test suite alone.

- [ ] **Step 7: Merge, push, deploy**

Use the `superpowers:finishing-a-development-branch` skill to merge `worktree-closed-captions` into `main` and push. Then rebuild and restart via `tablo-stack`, and confirm the running app at `127.0.0.1:7070` still shows captions from the deployed build.
