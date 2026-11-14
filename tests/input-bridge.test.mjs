import test from "node:test";
import assert from "node:assert/strict";

import { createInputAcceptor } from "../src/input.ts";

function snapshot(generation = 1, overrides = {}) {
  const slotModes = Array.from({ length: 54 }, () => "display");
  slotModes[7] = "button";
  return {
    open: true,
    ownerId: "player-1",
    sessionId: "window-1",
    layoutGeneration: 1,
    slotModes,
    generation,
    ...overrides,
  };
}

function accepted(sequence, slot = 7) {
  return {
    ok: true,
    notification: { sessionId: "window-1", layoutGeneration: 1, slot, sequence },
  };
}

test("serializes async execution and accepts a re-entrant enqueue", async () => {
  let now = 1000;
  let active = 0;
  let maxActive = 0;
  const executed = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  let secondResult;
  let acceptor;

  acceptor = createInputAcceptor({
    snapshot: () => snapshot(),
    now: () => now++,
    policy: { minIntervalMs: 0 },
    execute: async (notification) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      executed.push(notification.sequence);
      try {
        if (notification.sequence === 1) {
          // Re-entrant accept: queued behind the running execution, not awaited.
          secondResult = acceptor.accept("!invui:window-1:1:7:2", "player-1");
          started();
          await firstGate;
        }
      } finally {
        active -= 1;
      }
    },
  });

  const firstResult = acceptor.accept("!invui:window-1:1:7:1", "player-1");
  await didStart;

  assert.deepEqual(executed, [1]);
  assert.equal(maxActive, 1);

  releaseFirst();
  assert.deepEqual(await firstResult, accepted(1));
  assert.deepEqual(await secondResult, accepted(2));
  assert.deepEqual(executed, [1, 2]);
  assert.equal(maxActive, 1);
});

test("re-checks the latest snapshot immediately before execution", async () => {
  let current = snapshot();
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const executed = [];

  const acceptor = createInputAcceptor({
    snapshot: () => current,
    now: () => 1000,
    policy: { minIntervalMs: 0 },
    execute: async (notification) => {
      executed.push(notification.sequence);
      if (notification.sequence === 1) {
        started();
        await gate;
      }
    },
  });

  const first = acceptor.accept("!invui:window-1:1:7:1", "player-1");
  await didStart;
  const queued = acceptor.accept("!invui:window-1:1:7:2", "player-1");

  // The page changed while the first click was executing: slot 7 is no longer
  // a button, so the queued candidate must not run.
  const next = snapshot();
  next.slotModes[7] = "display";
  current = next;

  release();
  assert.deepEqual(await first, accepted(1));
  assert.deepEqual(await queued, { ok: false, reason: "slot-not-button" });
  assert.deepEqual(executed, [1]);
});

test("discards queued candidates from a superseded generation", async () => {
  let current = snapshot(1);
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const executed = [];

  const acceptor = createInputAcceptor({
    snapshot: () => current,
    now: () => 1000,
    policy: { minIntervalMs: 0 },
    execute: async (notification) => {
      executed.push(notification.sequence);
      if (notification.sequence === 1) {
        started();
        await gate;
      }
    },
  });

  const first = acceptor.accept("!invui:window-1:1:7:1", "player-1");
  await didStart;
  const stale = acceptor.accept("!invui:window-1:1:7:2", "player-1");
  current = snapshot(2);

  release();
  assert.deepEqual(await first, accepted(1));
  assert.deepEqual(await stale, { ok: false, reason: "stale-generation" });
  assert.deepEqual(executed, [1]);
});

test("fails closed instead of throwing on unusable snapshots, clocks, and executors", async () => {
  let current = snapshot();
  let now = 1000;
  const notAWindow = () => ({ ...snapshot(), generation: "1" });
  const withSnapshot = (source, execute = () => {}) =>
    createInputAcceptor({ snapshot: source, now: () => now, policy: { minIntervalMs: 0 }, execute });

  assert.deepEqual(await withSnapshot(() => null).accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "snapshot-unavailable",
  });
  assert.deepEqual(await withSnapshot(notAWindow).accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "snapshot-unavailable",
  });

  const disappearing = withSnapshot(() => current);
  current = null;
  assert.deepEqual(await disappearing.accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "snapshot-unavailable",
  });

  current = snapshot();
  const badClock = createInputAcceptor({
    snapshot: () => current,
    now: () => NaN,
    policy: { minIntervalMs: 0 },
    execute: () => {},
  });
  assert.deepEqual(await badClock.accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "invalid-input",
  });

  const throwing = withSnapshot(
    () => current,
    () => {
      throw new Error("click handler failed");
    },
  );
  assert.deepEqual(await throwing.accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "executor-failed",
  });
});

test("rejects unusable construction options synchronously", () => {
  const snapshotSource = () => snapshot();
  const options = (overrides = {}) => ({
    snapshot: snapshotSource,
    now: () => 1000,
    policy: { minIntervalMs: 0 },
    execute: () => {},
    ...overrides,
  });

  assert.throws(() => createInputAcceptor(null), TypeError);
  assert.throws(() => createInputAcceptor(options({ policy: undefined })), RangeError);
  assert.throws(() => createInputAcceptor(options({ policy: null })), RangeError);
  assert.throws(() => createInputAcceptor(options({ policy: { minIntervalMs: -1 } })), RangeError);
  assert.throws(() => createInputAcceptor(options({ policy: { minIntervalMs: NaN } })), RangeError);
  assert.throws(
    () =>
      createInputAcceptor(
        options({
          policy: {
            get minIntervalMs() {
              throw new Error("policy getter failed");
            },
          },
        }),
      ),
    RangeError,
  );
});

test("resolves the candidate and keeps draining when the snapshot getter throws mid-queue", async () => {
  let reads = 0;
  const executed = [];
  const acceptor = createInputAcceptor({
    snapshot: () => {
      reads += 1;
      if (reads === 2) {
        throw new Error("snapshot getter failed");
      }
      return snapshot();
    },
    now: () => 1000,
    policy: { minIntervalMs: 0 },
    execute: (notification) => {
      executed.push(notification.sequence);
    },
  });

  assert.deepEqual(await acceptor.accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "snapshot-unavailable",
  });
  assert.deepEqual(await acceptor.accept("!invui:window-1:1:7:2", "player-1"), accepted(2));
  assert.deepEqual(executed, [2]);
});

test("resolves the candidate and keeps draining when the rate policy throws mid-queue", async () => {
  let policyReads = 0;
  const executed = [];
  const acceptor = createInputAcceptor({
    snapshot: () => snapshot(),
    now: () => 1000,
    policy: {
      get minIntervalMs() {
        policyReads += 1;
        if (policyReads > 1) {
          throw new Error("rate policy getter failed");
        }
        return 0;
      },
    },
    execute: (notification) => {
      executed.push(notification.sequence);
    },
  });

  const first = acceptor.accept("!invui:window-1:1:7:1", "player-1");
  const second = acceptor.accept("!invui:window-1:1:7:2", "player-1");
  assert.deepEqual(await first, { ok: false, reason: "invalid-input" });
  assert.deepEqual(await second, { ok: false, reason: "invalid-input" });
  assert.deepEqual(executed, []);
});

test("never leaves a candidate unresolved when settle throws unexpectedly", async () => {
  let generationReads = 0;
  const live = snapshot();
  const exploding = {
    ...live,
    get generation() {
      generationReads += 1;
      if (generationReads >= 4) {
        throw new Error("generation getter failed");
      }
      return 1;
    },
  };
  const acceptor = createInputAcceptor({
    snapshot: () => exploding,
    now: () => 1000,
    policy: { minIntervalMs: 0 },
    execute: () => {},
  });

  assert.deepEqual(await acceptor.accept("!invui:window-1:1:7:1", "player-1"), {
    ok: false,
    reason: "invalid-input",
  });
  // The queue keeps draining after the unexpected throw.
  assert.deepEqual(await acceptor.accept("!invui:window-1:1:7:2", "player-1"), {
    ok: false,
    reason: "snapshot-unavailable",
  });
});
