# Fetching ahead of the decoder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give compressed segments somewhere to wait, so a slow device round
trip stops emptying the audio buffer.

**Architecture:** A `SegmentSupply` fetches ahead concurrently and holds
bytes. The transport takes from it instead of awaiting the network. Decode
pacing is untouched — this adds a packet queue beside the existing picture
queue, which is the pairing every mature player has and this one does not.

**Tech Stack:** TypeScript, Vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-segment-supply-design.md`

## Global Constraints

- Decode pacing does not change. `LOOKAHEAD_SECONDS = 2`,
  `MIN_BUFFER_SECONDS = 0.5`, `COMFORTABLE_BUFFER_SECONDS = 1.5`,
  `STARVED_LOOKAHEAD_SECONDS = 2.5`, `MAX_QUEUED_FRAMES = 200` and
  `QUEUE_HIGH_WATER` keep their values and their meanings.
- No change to the worker protocol, the backend, the presenter or the audio
  path.
- Bytes fetched before a seek must never reach the worker after it. The
  existing `mine !== epoch` guard stays; the supply gets its own generation
  counter.
- `supply.ts` takes its fetch as a dependency and touches no browser global,
  matching every other module in `wasmlive/` except `open.ts`.
- `npx tsc -b`, `npx eslint src` and `npx vitest run` pass before each commit.
  `tsc --noEmit` is **not** sufficient — it misses the test files, which is
  how a type error reached a Docker build on 2026-09-17.
- Ask before committing.

---

### Task 1: The supply itself

**Files:**
- Create: `frontend/src/lib/wasmlive/supply.ts`
- Test: `frontend/src/__tests__/wasmliveSupply.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PlannedSegment {
    sequence: number;
    url: string;
    durationSeconds: number;
  }

  export interface SegmentSupply {
    take(sequence: number, url: string): Promise<ArrayBuffer>;
    advise(upcoming: PlannedSegment[]): void;
    reset(): void;
    readonly heldSeconds: number;
    readonly heldBytes: number;
    readonly inFlight: number;
  }

  export function createSegmentSupply(deps: {
    fetchBytes(url: string): Promise<ArrayBuffer>;
    targetSeconds?: number;
    maxBytes?: number;
    concurrency?: number;
  }): SegmentSupply;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
/** A fetch that resolves when the test says so. */
function fakeFetch() {
  const waiting = new Map<string, (bytes: ArrayBuffer) => void>();
  return {
    asked: [] as string[],
    fetchBytes(url: string) {
      this.asked.push(url);
      return new Promise<ArrayBuffer>((resolve) => waiting.set(url, resolve));
    },
    settle(url: string, bytes = 1000) {
      waiting.get(url)?.(new ArrayBuffer(bytes));
      waiting.delete(url);
    },
  };
}

const plan = (n: number): PlannedSegment[] =>
  Array.from({ length: n }, (_, i) => ({
    sequence: i, url: `/s${i}.ts`, durationSeconds: 1,
  }));

it("fetches ahead up to its target, and no further", async () => {
  const net = fakeFetch();
  const supply = createSegmentSupply({
    fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
  });
  supply.advise(plan(10));
  await Promise.resolve();
  expect(net.asked).toEqual(["/s0.ts", "/s1.ts", "/s2.ts"]);
});

it("hands over bytes it already holds without asking again", async () => {
  const net = fakeFetch();
  const supply = createSegmentSupply({
    fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
  });
  supply.advise(plan(10));
  await Promise.resolve();
  net.settle("/s0.ts");
  await Promise.resolve();

  const bytes = await supply.take(0, "/s0.ts");
  expect(bytes.byteLength).toBe(1000);
  expect(net.asked.filter((u) => u === "/s0.ts")).toHaveLength(1);
});

it("waits on a fetch already in flight rather than starting a second", async () => {
  // The transport reaching a segment the supply is already fetching is the
  // ordinary case, not an edge one.
  const net = fakeFetch();
  const supply = createSegmentSupply({
    fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
  });
  supply.advise(plan(10));
  await Promise.resolve();

  const taken = supply.take(1, "/s1.ts");
  net.settle("/s1.ts", 42);
  expect((await taken).byteLength).toBe(42);
  expect(net.asked.filter((u) => u === "/s1.ts")).toHaveLength(1);
});

it("fetches on demand for a segment it never planned for", async () => {
  // A seek lands somewhere the plan did not cover, and playback must not
  // wait for the next advise.
  const net = fakeFetch();
  const supply = createSegmentSupply({ fetchBytes: (u) => net.fetchBytes(u) });
  const taken = supply.take(99, "/s99.ts");
  net.settle("/s99.ts", 7);
  expect((await taken).byteLength).toBe(7);
});

it("stops fetching at its byte ceiling, whatever the clock says", async () => {
  // Bitrate varies by an order of magnitude between SD and HD, so a target
  // in seconds bounds nothing on its own.
  const net = fakeFetch();
  const supply = createSegmentSupply({
    fetchBytes: (u) => net.fetchBytes(u),
    targetSeconds: 60, maxBytes: 2500, concurrency: 4,
  });
  supply.advise(plan(10));
  await Promise.resolve();
  for (const u of [...net.asked]) net.settle(u, 1000);
  await Promise.resolve();
  await Promise.resolve();

  expect(supply.heldBytes).toBeLessThanOrEqual(3000);
  expect(net.asked.length).toBeLessThan(10);
});

it("abandons what it holds, and what is in flight, on reset", async () => {
  // Bytes fetched for the old position are worthless after a seek, and
  // actively harmful if they arrive later and are treated as current.
  const net = fakeFetch();
  const supply = createSegmentSupply({
    fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
  });
  supply.advise(plan(10));
  await Promise.resolve();
  supply.reset();
  net.settle("/s0.ts");
  await Promise.resolve();

  expect(supply.heldBytes).toBe(0);
  expect(supply.inFlight).toBe(0);
});

it("keeps running after a fetch fails", async () => {
  // A dropped request is not the end of the session; the transport will ask
  // again, and a supply that had latched an error would make it fatal.
  const supply = createSegmentSupply({
    fetchBytes: () => Promise.reject(new Error("dropped")),
    targetSeconds: 3,
  });
  supply.advise(plan(3));
  await Promise.resolve();
  await expect(supply.take(0, "/s0.ts")).rejects.toThrow("dropped");
  expect(supply.inFlight).toBe(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

`npx vitest run src/__tests__/wasmliveSupply.test.ts`
Expected: the module does not exist.

- [ ] **Step 3: Write `supply.ts`**

Constants, with their reasoning in the file:

```ts
/**
 * Seconds of compressed media to keep ahead of the decoder.
 *
 * Twelve is about four times the worst gap measured, and costs 15-20MB at
 * this device's 1080i rate. It is a packet queue, not a picture queue: the
 * equivalent depth in decoded fields would be two gigabytes.
 */
const TARGET_SECONDS = 12;

/**
 * And a ceiling in bytes, because seconds bound nothing on their own.
 *
 * Bitrate runs from about 4 Mbit/s for 480i to 17 Mbit/s for 1080i on this
 * device, so a time target alone varies fourfold in memory.
 */
const MAX_BYTES = 24 * 1024 * 1024;

/**
 * Fetches in flight at once.
 *
 * Measured against the device on 2026-09-17: four concurrent segment fetches
 * took 478ms where four serial ones took 1267ms, a 2.65x speedup, with
 * per-request time rising only from ~310ms to ~440ms. Three keeps most of
 * that and leaves the device a lane for the live ring's own follower.
 */
const CONCURRENCY = 3;
```

The implementation holds three things: `held` (sequence to bytes and
duration), `pending` (sequence to the promise in flight), and the latest
plan. A generation counter rises on `reset()`, and a fetch that resolves into
a stale generation is dropped rather than held.

`pump()` starts fetches while all of these are true: something planned is
neither held nor pending; `inFlight < concurrency`; `heldSeconds` plus what
is in flight is under `targetSeconds`; and `heldBytes` is under `maxBytes`.
It is called from `advise`, from `take`, and when any fetch settles.

`take(sequence, url)` returns held bytes if it has them, joins the pending
fetch if there is one, and otherwise fetches directly — then pumps.

- [ ] **Step 4: Run the tests**

`npx vitest run src/__tests__/wasmliveSupply.test.ts` — all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/supply.ts frontend/src/__tests__/wasmliveSupply.test.ts
git commit -m "feat: a place for compressed segments to wait"
```

---

### Task 2: The transport takes from the supply

**Files:**
- Modify: `frontend/src/lib/wasmlive/session.ts`
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

**Interfaces:**
- Consumes: `createSegmentSupply` from Task 1.
- Produces: no change to `SessionDeps` or the session's public shape.

- [ ] **Step 1: Write the failing test**

```ts
it("feeds from bytes fetched ahead rather than waiting on the network", async () => {
  // The whole point: the transport should not be the thing discovering that
  // the device is slow.
  const { session, net } = sessionWithSlowFetch();   // existing harness style
  await session.start();
  await session.tick();

  // More segments have been asked for than have been fed.
  expect(net.asked.length).toBeGreaterThan(fedSegments(session));
});

it("drops what it fetched ahead when the viewer seeks", async () => {
  const { session, net } = sessionWithSlowFetch();
  await session.start();
  session.seek(600);
  await session.tick();

  // Nothing from before the seek reaches the worker.
  expect(postedSegments()).not.toContain(beforeSeekBytes);
});
```

Follow the harness already in `wasmliveSession.test.ts` rather than inventing
a second idiom — that file is 1097 lines and already fakes the worker, the
audio sink and the playlist.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Wire it in**

In `createSession`:

```ts
const supply = createSegmentSupply({ fetchBytes: deps.fetchBytes });
```

In `poll()`, before the feed loop, tell it what is coming — everything after
`takenThrough`, in playlist order:

```ts
supply.advise(
  playlist.segments.flatMap((segment, index) => {
    const sequence = playlist.mediaSequence + index;
    return sequence > takenThrough
      ? [{ sequence, url: segmentUrl(segment.uri), durationSeconds: segment.duration }]
      : [];
  }),
);
```

And in the loop, take instead of fetch:

```ts
const bytes = await supply.take(sequence, segmentUrl(playlist.segments[index].uri));
```

Reset it where the epoch turns over — beside the existing seek handling, so
a seek drops the old position's bytes:

```ts
seekTarget = null;
supply.reset();
```

- [ ] **Step 4: Run the wasmlive tests, then the suite**

`npx vitest run src/__tests__/wasmlive` then `npx vitest run`.
The existing session tests must pass untouched: they are the regression
surface for pacing, and pacing is not supposed to change.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/session.ts frontend/src/__tests__/wasmliveSession.test.ts
git commit -m "feat: feed the decoder from bytes already in hand"
```

---

### Task 3: Say what the supply is holding

**Files:**
- Modify: `frontend/src/lib/wasmlive/session.ts` (`diagnostics`)
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

This investigation needed a temporary instrumented build to answer "is the
transport waiting on the network, or on its own pacing?". It should not need
one again.

- [ ] **Step 1: Add to the diagnostics block**

```ts
supplyHeldSeconds: supply.heldSeconds,
supplyHeldBytes: supply.heldBytes,
supplyInFlight: supply.inFlight,
```

- [ ] **Step 2: Pin it with a test**

One assertion that `tabloDebug()`-shaped output carries the three keys after
a poll. Shallow on purpose — the values are covered in Task 1.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat: report what the segment supply is holding"
```

---

### Task 4: Deploy and listen

**Files:** none, unless this finds something.

- [ ] **Step 1: Build and deploy**

Use the `tablo-stack` skill. After `up -d --force-recreate`, confirm the
served bundle matches the built image — on 2026-09-17 the container served a
stale bundle through a passing `check-stack.sh`:

```bash
curl -s http://127.0.0.1:7070/ | grep -oE 'index-[A-Za-z0-9_-]*\.js'
docker run --rm --entrypoint sh tablo-web-frontend:local \
  -c 'ls /usr/share/nginx/html/assets | grep -o "index-[A-Za-z0-9_-]*\.js"'
```

- [ ] **Step 2: Watch the buffer**

Play recording 86137 (480i) and 86141 (1080i). In the console, the `fed
segment` lines carry `buffered`. Before this change it dipped to 0.0–0.06
several times a minute.

Expected after: `buffered` stays off zero, and `supplyHeldSeconds` in
`tabloDebug()` sits near 12.

- [ ] **Step 3: Listen**

The measurement is the buffer; the verdict is the ear. Stutters and audio
drops should be gone, not merely rarer.

- [ ] **Step 4: Report honestly**

Say which recordings were played, for how long, and what the buffer did.
Anything not heard is not verified.

---

## Notes for whoever runs this

- The numbers in the spec were measured on 2026-09-17 with a temporary build
  in a scratch worktree, now removed. The method: wrap `ff_decode_multi` and
  `ff_read_frame_multi` in `performance.now()` and log per 50 frames.
- `main` moves under you; several sessions work in this repo. Rebase rather
  than assuming a fast-forward, and prefer `git -C <path>` over `cd`.
