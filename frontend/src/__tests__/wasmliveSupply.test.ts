import { describe, it, expect } from "vitest";

import { createSegmentSupply, type PlannedSegment } from "../lib/wasmlive/supply";

/** A fetch that resolves only when the test says so. */
function fakeFetch() {
  const waiting = new Map<string, (bytes: ArrayBuffer) => void>();
  const failing = new Map<string, (e: Error) => void>();
  const asked: string[] = [];
  return {
    asked,
    fetchBytes(url: string) {
      asked.push(url);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        waiting.set(url, resolve);
        failing.set(url, reject);
      });
    },
    settle(url: string, bytes = 1000) {
      waiting.get(url)?.(new ArrayBuffer(bytes));
      waiting.delete(url);
      failing.delete(url);
    },
    fail(url: string, message = "dropped") {
      failing.get(url)?.(new Error(message));
      waiting.delete(url);
      failing.delete(url);
    },
  };
}

const plan = (n: number, from = 0): PlannedSegment[] =>
  Array.from({ length: n }, (_, i) => ({
    sequence: from + i, url: `/s${from + i}.ts`, durationSeconds: 1,
  }));

/** Let every already-resolved promise in the chain run. */
const settleMicrotasks = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("createSegmentSupply", () => {
  it("fetches ahead up to its target, and no further", async () => {
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
    });
    supply.advise(plan(10));
    await settleMicrotasks();

    expect(net.asked).toEqual(["/s0.ts", "/s1.ts", "/s2.ts"]);
  });

  it("never runs more fetches at once than it was told to", async () => {
    // Enough to beat per-request latency, few enough not to bury the device —
    // and the live ring's own follower is on the other side of the same wire.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 30, concurrency: 2,
    });
    supply.advise(plan(10));
    await settleMicrotasks();

    expect(net.asked).toHaveLength(2);
    expect(supply.inFlight).toBe(2);
  });

  it("hands over bytes it already holds without asking again", async () => {
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
    });
    supply.advise(plan(10));
    await settleMicrotasks();
    net.settle("/s0.ts");
    await settleMicrotasks();

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
    await settleMicrotasks();

    const taken = supply.take(1, "/s1.ts");
    net.settle("/s1.ts", 42);

    expect((await taken).byteLength).toBe(42);
    expect(net.asked.filter((u) => u === "/s1.ts")).toHaveLength(1);
  });

  it("fetches on demand for a segment it never planned for", async () => {
    // A seek lands where the last advise did not reach, and playback must not
    // wait for the next poll to say so.
    const net = fakeFetch();
    const supply = createSegmentSupply({ fetchBytes: (u) => net.fetchBytes(u) });

    const taken = supply.take(99, "/s99.ts");
    net.settle("/s99.ts", 7);

    expect((await taken).byteLength).toBe(7);
  });

  it("stops fetching at its byte ceiling, whatever the clock says", async () => {
    // Bitrate runs fourfold between 480i and 1080i on this device, so a target
    // in seconds bounds nothing on its own.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u),
      targetSeconds: 60, maxBytes: 2500, concurrency: 4,
    });
    supply.advise(plan(10));
    await settleMicrotasks();
    for (const url of [...net.asked]) net.settle(url, 1000);
    await settleMicrotasks();

    expect(supply.heldBytes).toBeGreaterThan(0);
    expect(net.asked.length).toBeLessThan(10);
    expect(supply.heldBytes).toBeLessThanOrEqual(4000);
  });

  it("counts down what it holds as the transport takes it", async () => {
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 2, concurrency: 2,
    });
    supply.advise(plan(4));
    await settleMicrotasks();
    net.settle("/s0.ts", 500);
    net.settle("/s1.ts", 500);
    await settleMicrotasks();
    expect(supply.heldSeconds).toBe(2);

    await supply.take(0, "/s0.ts");
    expect(supply.heldSeconds).toBe(1);
    expect(supply.heldBytes).toBe(500);
  });

  it("abandons what it holds, and what is in flight, on reset", async () => {
    // Bytes fetched for the old position are worthless after a seek, and
    // harmful if they arrive later and are treated as current.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
    });
    supply.advise(plan(10));
    await settleMicrotasks();
    net.settle("/s0.ts");
    await settleMicrotasks();
    expect(supply.heldBytes).toBeGreaterThan(0);

    supply.reset();
    net.settle("/s1.ts");
    await settleMicrotasks();

    expect(supply.heldBytes).toBe(0);
    expect(supply.heldSeconds).toBe(0);
    expect(supply.inFlight).toBe(0);
  });

  it("does not hold bytes that arrive from before a reset", async () => {
    // The seek race, in the supply: a fetch outstanding when the viewer seeks
    // resolves afterwards, and must not become the next segment fed.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
    });
    supply.advise(plan(10));
    await settleMicrotasks();

    supply.reset();
    supply.advise(plan(3, 500));
    await settleMicrotasks();
    net.settle("/s0.ts");          // from the era before the seek
    await settleMicrotasks();

    expect(supply.heldBytes).toBe(0);
  });

  it("forgets what the plan has moved past", async () => {
    // The transport only ever walks forwards, so a held segment behind it is
    // memory nothing will ask for.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 2, concurrency: 2,
    });
    supply.advise(plan(2));
    await settleMicrotasks();
    net.settle("/s0.ts", 800);
    net.settle("/s1.ts", 800);
    await settleMicrotasks();
    expect(supply.heldBytes).toBe(1600);

    supply.advise(plan(2, 1));     // segment 0 is behind us now
    expect(supply.heldBytes).toBe(800);
  });

  it("keeps running after a fetch fails", async () => {
    // A dropped request is not the end of the session; the transport asks
    // again on the next poll. Latching the error would make it permanent.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 1,
    });
    supply.advise(plan(3));
    await settleMicrotasks();

    net.fail("/s0.ts");
    await settleMicrotasks();

    // Not latched: the next poll's advise picks it straight back up. It asks
    // for s0 again rather than moving on, which is right — the transport's
    // `takenThrough` has not advanced past it either, so this segment is still
    // the next thing playback needs.
    expect(net.asked).toEqual(["/s0.ts"]);
    supply.advise(plan(3));
    await settleMicrotasks();
    expect(net.asked).toEqual(["/s0.ts", "/s0.ts"]);
  });

  it("does not walk the plan when the endpoint is refusing", async () => {
    // Where the 404 storms came from. Every ceiling here is measured on media
    // *held*, and a failed fetch holds nothing — so a failure could never
    // reach the target, and pumping on one walked the whole remaining plan at
    // full concurrency as fast as the endpoint could refuse.
    //
    // Measured before the fix: one advise over a 1,260-segment plan issued
    // 1,260 requests in under 200ms. `takenThrough` only advances on success,
    // so the next poll re-planned the lot and swept again — two sweeps being
    // the 2,316 messages in the console screenshot, four the 4,716.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 3,
    });

    supply.advise(plan(1260));
    await settleMicrotasks();
    // Every one of them refuses, exactly as a dead session does.
    for (const url of [...net.asked]) net.fail(url, "404");
    await settleMicrotasks();

    // One round of concurrency, not the plan. The transport's own `take` is
    // what fetches for playback; this queue is only ever speculative.
    expect(net.asked.length).toBeLessThanOrEqual(3);
    expect(supply.inFlight).toBe(0);
  });

  it("resumes prefetching once the endpoint answers again", async () => {
    // The other half of the same promise: refusing to sweep must not mean
    // refusing to recover.
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 1,
    });

    supply.advise(plan(4));
    await settleMicrotasks();
    net.fail("/s0.ts");
    await settleMicrotasks();

    supply.advise(plan(3, 1));
    await settleMicrotasks();
    net.settle("/s1.ts");
    await settleMicrotasks();

    expect(supply.heldSeconds).toBe(1);
    expect(net.asked).toContain("/s2.ts");
  });

  it("surfaces the failure to whoever was waiting for that segment", async () => {
    const net = fakeFetch();
    const supply = createSegmentSupply({
      fetchBytes: (u) => net.fetchBytes(u), targetSeconds: 3, concurrency: 2,
    });

    const taken = supply.take(0, "/s0.ts");
    net.fail("/s0.ts", "device error");

    await expect(taken).rejects.toThrow("device error");
    expect(supply.inFlight).toBe(0);
  });
});
