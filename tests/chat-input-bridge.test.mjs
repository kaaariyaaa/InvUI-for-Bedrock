import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// map the "./input.js" import in src/chat-input-bridge.ts onto the TS source
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:") &&
      context.parentURL.includes("/src/")
    ) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(target))) {
        return {
          url: new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href,
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createChatInputBridge, connectChatSendInput } = await import("../src/chat-input-bridge.ts");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeWindow(options = {}) {
  let open = options.open ?? true;
  const clicks = [];
  let active = 0;
  let maxActive = 0;

  const window = {
    id: options.id ?? "window-1",
    viewer: { id: options.viewerId ?? "player-1" },
    get isOpen() {
      return open;
    },
    setOpen(value) {
      open = value;
    },
    clicks,
    get maxActive() {
      return maxActive;
    },
    async handleClick(slot) {
      clicks.push(slot);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const result = options.onClick ? await options.onClick(slot, window) : true;
        return result === undefined ? true : result;
      } finally {
        active -= 1;
      }
    },
  };
  return window;
}

function makeBridge(windows, options = {}) {
  const rejections = [];
  const bridge = createChatInputBridge({
    windows: () => windows,
    now: () => 1000,
    onRejected: (rejection) => rejections.push(rejection),
    ...options,
  });
  return { bridge, rejections };
}

function makeEventSource() {
  const handlers = [];
  const scheduled = [];
  const world = {
    beforeEvents: {
      chatSend: {
        subscribe(handler) {
          handlers.push(handler);
          return handler;
        },
        unsubscribe(handler) {
          const index = handlers.indexOf(handler);
          if (index >= 0) {
            handlers.splice(index, 1);
          }
        },
      },
    },
  };
  const system = {
    run(callback) {
      scheduled.push(callback);
    },
  };
  return {
    world,
    system,
    emit(message, sender = { id: "player-1" }) {
      const event = { message, sender, cancel: false };
      for (const handler of [...handlers]) {
        handler(event);
      }
      return event;
    },
    async flush() {
      for (const callback of scheduled.splice(0)) {
        callback();
      }
      await tick();
    },
    handlerCount: () => handlers.length,
    scheduled,
  };
}

test("cancels only well-formed notifications and defers the click to system.run", async () => {
  const window = makeWindow();
  const { bridge } = makeBridge([window]);
  const source = makeEventSource();
  const disconnect = connectChatSendInput({ world: source.world, system: source.system }, bridge);

  const notification = source.emit("!invui:window-1:7:1");
  assert.equal(notification.cancel, true);
  assert.deepEqual(window.clicks, [], "the before-event must not click");
  assert.equal(source.scheduled.length, 1, "the click is scheduled for the next tick");

  await source.flush();
  assert.deepEqual(window.clicks, [7]);

  const plain = source.emit("hello");
  assert.equal(plain.cancel, false);
  const malformed = source.emit("!invui:not-a-notification");
  assert.equal(malformed.cancel, false, "reserved prefix alone is not canceled");
  assert.equal(source.scheduled.length, 0);

  disconnect();
  assert.equal(source.handlerCount(), 0);
  assert.equal(source.emit("!invui:window-1:7:2").cancel, false);
});

test("routes the click by the event sender id, not by another player's window", async () => {
  const first = makeWindow({ id: "window-1", viewerId: "player-1" });
  const second = makeWindow({ id: "window-2", viewerId: "player-2" });
  const { bridge } = makeBridge([first, second]);
  const source = makeEventSource();
  connectChatSendInput({ world: source.world, system: source.system }, bridge);

  source.emit("!invui:window-2:7:1", { id: "player-2" });
  await source.flush();

  assert.deepEqual(first.clicks, []);
  assert.deepEqual(second.clicks, [7]);

  const spoofed = await bridge.dispatch("!invui:window-1:7:2", "player-2");
  // player-2's own Window is window-2, so the captured session id is rejected;
  // player-1's Window is never reached through another player's chat.
  assert.deepEqual(spoofed, { ok: false, reason: "session-mismatch" });
  assert.deepEqual(first.clicks, []);
});

test("rejects a session mismatch", async () => {
  const window = makeWindow();
  const { bridge, rejections } = makeBridge([window]);

  const result = await bridge.dispatch("!invui:window-2:7:1", "player-1");
  assert.deepEqual(result, { ok: false, reason: "session-mismatch" });
  assert.equal(rejections.at(-1).reason, "session-mismatch");
  assert.deepEqual(window.clicks, []);
});

test("rejects a stale or replayed sequence", async () => {
  const window = makeWindow();
  const { bridge } = makeBridge([window]);

  const first = await bridge.dispatch("!invui:window-1:7:1", "player-1");
  assert.deepEqual(first, {
    ok: true,
    notification: { sessionId: "window-1", slot: 7, sequence: 1 },
    clicked: true,
  });
  assert.deepEqual(await bridge.dispatch("!invui:window-1:7:1", "player-1"), {
    ok: false,
    reason: "stale-sequence",
  });
  assert.equal((await bridge.dispatch("!invui:window-1:7:2", "player-1")).ok, true);
  assert.deepEqual(window.clicks, [7, 7]);
});

test("re-checks the slot mode and fails closed when the probe is unusable", async () => {
  const displaySlots = Array.from({ length: 54 }, () => "display");
  const window = makeWindow();
  const { bridge } = makeBridge([window], { slotModes: () => displaySlots });

  assert.deepEqual(await bridge.dispatch("!invui:window-1:7:1", "player-1"), {
    ok: false,
    reason: "slot-not-button",
  });
  assert.deepEqual(window.clicks, []);

  const throwing = makeBridge([window], {
    slotModes: () => {
      throw new Error("layout unavailable");
    },
  }).bridge;
  assert.deepEqual(await throwing.dispatch("!invui:window-1:7:2", "player-1"), {
    ok: false,
    reason: "slot-not-button",
  });
});

test("discards a queued click after invalidate bumps the generation", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const window = makeWindow({
    onClick: async () => {
      started();
      await gate;
      return true;
    },
  });
  const { bridge } = makeBridge([window]);

  const first = bridge.dispatch("!invui:window-1:7:1", "player-1");
  await didStart;
  const queued = bridge.dispatch("!invui:window-1:7:2", "player-1");

  bridge.invalidate(window);
  release();

  assert.equal((await first).ok, true);
  assert.deepEqual(await queued, { ok: false, reason: "stale-generation" });
  assert.deepEqual(window.clicks, [7]);
});

test("discards a queued click when the window closes before execution", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const window = makeWindow({
    onClick: async () => {
      started();
      await gate;
      return true;
    },
  });
  const { bridge } = makeBridge([window]);

  const first = bridge.dispatch("!invui:window-1:7:1", "player-1");
  await didStart;
  const queued = bridge.dispatch("!invui:window-1:7:2", "player-1");
  window.setOpen(false);
  release();

  assert.equal((await first).ok, true);
  assert.deepEqual(await queued, { ok: false, reason: "window-closed" });
  assert.deepEqual(window.clicks, [7]);
});

test("serializes execution across notifications, including a re-entrant enqueue", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  let call = 0;
  let reentrant;
  const window = makeWindow({
    onClick: async () => {
      call += 1;
      if (call === 1) {
        // Must queue behind the running click instead of awaiting it.
        reentrant = bridge.dispatch("!invui:window-1:7:2", "player-1");
        started();
        await gate;
      }
      return true;
    },
  });
  const { bridge } = makeBridge([window]);

  const first = bridge.dispatch("!invui:window-1:7:1", "player-1");
  await didStart;
  assert.equal(window.maxActive, 1);
  release();

  assert.equal((await first).ok, true);
  assert.equal((await reentrant).ok, true);
  assert.deepEqual(window.clicks, [7, 7]);
  assert.equal(window.maxActive, 1);
});

test("resets the sequence when a closed window reopens", async () => {
  const window = makeWindow();
  const { bridge } = makeBridge([window]);

  assert.equal((await bridge.dispatch("!invui:window-1:7:5", "player-1")).clicked, true);

  window.setOpen(false);
  bridge.invalidate(window);
  window.setOpen(true);

  const reopened = await bridge.dispatch("!invui:window-1:7:5", "player-1");
  assert.equal(reopened.ok, true, "a new open cycle may reuse a sequence");
  assert.equal(reopened.clicked, true);
  assert.deepEqual(window.clicks, [7, 7]);
});

test("a click in flight across close/reopen does not consume the new cycle's sequence", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const window = makeWindow({
    onClick: async () => {
      started();
      await gate;
      return true;
    },
  });
  const { bridge } = makeBridge([window]);

  const inFlight = bridge.dispatch("!invui:window-1:7:5", "player-1");
  await didStart;

  // Close and reopen while the old click still runs.
  window.setOpen(false);
  bridge.invalidate(window);
  window.setOpen(true);

  // Accepted by the new cycle, but queued behind the old in-flight click.
  const fresh = bridge.dispatch("!invui:window-1:7:3", "player-1");
  release();

  assert.equal((await inFlight).clicked, true);
  assert.equal(
    (await fresh).ok,
    true,
    "the completed old click must not write the previous cycle's lastSequence",
  );
});

test("a page invalidation during a click stays in the same open cycle", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const window = makeWindow({
    onClick: async () => {
      started();
      await gate;
      return true;
    },
  });
  const { bridge } = makeBridge([window]);

  const inFlight = bridge.dispatch("!invui:window-1:7:5", "player-1");
  await didStart;
  // A page change invalidates the generation but not the open cycle.
  bridge.invalidate(window);
  release();

  assert.equal((await inFlight).clicked, true);
  assert.deepEqual(await bridge.dispatch("!invui:window-1:7:5", "player-1"), {
    ok: false,
    reason: "stale-sequence",
  });
});

test("applies the caller-injected repeat limit", async () => {
  let now = 1000;
  const window = makeWindow();
  const { bridge } = makeBridge([window], { now: () => now, minIntervalMs: 100 });

  assert.equal((await bridge.dispatch("!invui:window-1:7:1", "player-1")).ok, true);
  now = 1050;
  assert.deepEqual(await bridge.dispatch("!invui:window-1:7:2", "player-1"), {
    ok: false,
    reason: "rate-limited",
  });
  now = 1200;
  assert.equal((await bridge.dispatch("!invui:window-1:7:3", "player-1")).ok, true);
  assert.deepEqual(window.clicks, [7, 7]);
});

test("reports a discarded click and a thrown handler without crashing", async () => {
  const discardedWindow = makeWindow({ onClick: async () => false });
  const discarded = makeBridge([discardedWindow]).bridge;
  assert.deepEqual(await discarded.dispatch("!invui:window-1:7:1", "player-1"), {
    ok: true,
    notification: { sessionId: "window-1", slot: 7, sequence: 1 },
    clicked: false,
  });
  // A discarded click did not consume the sequence: the same notification may retry.
  assert.equal((await discarded.dispatch("!invui:window-1:7:1", "player-1")).clicked, false);

  const throwingWindow = makeWindow({
    onClick: () => {
      throw new Error("click handler failed");
    },
  });
  const { bridge, rejections } = makeBridge([throwingWindow]);
  assert.deepEqual(await bridge.dispatch("!invui:window-1:7:1", "player-1"), {
    ok: false,
    reason: "executor-failed",
  });
  assert.equal(rejections.at(-1).reason, "executor-failed");
});

test("invalidate on an unknown window and a missing sender fail closed", async () => {
  const window = makeWindow();
  const { bridge } = makeBridge([window]);
  assert.doesNotThrow(() => bridge.invalidate(window));

  assert.deepEqual(await bridge.dispatch("!invui:window-1:7:1", ""), {
    ok: false,
    reason: "snapshot-unavailable",
  });

  assert.throws(
    () => createChatInputBridge({ windows: () => [], maxQueue: 0 }),
    RangeError,
  );
  assert.throws(() => createChatInputBridge({ windows: () => [], slotModes: 1 }), TypeError);
});

test("connectChatSendInput fails closed when beforeEvents.chatSend is absent", () => {
  const bridge = createChatInputBridge({ windows: () => [] });
  const scheduled = [];
  const source = {
    // An older API or a test double without the before-event: no subscription
    // is possible, so nothing may throw and no callback may be installed.
    world: {},
    system: {
      run(callback) {
        scheduled.push(callback);
      },
    },
  };

  const disconnect = connectChatSendInput(source, bridge);
  assert.equal(typeof disconnect, "function");
  assert.doesNotThrow(() => disconnect());
  assert.deepEqual(scheduled, []);
});
