import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  STATE_STORAGE_VERSION,
  StateConflictError,
  StateCorruptionError,
  StateManager,
  StateReleasedError,
  StateValidationError,
} from "../src/state.ts";

class MemoryStore {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
    this.setCalls = [];
    this.removeCalls = [];
  }

  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  setItem(key, value) {
    if (typeof value !== "string") {
      throw new TypeError("value must be a string");
    }
    this.data.set(key, value);
    this.setCalls.push([key, value]);
  }

  removeItem(key) {
    this.data.delete(key);
    this.removeCalls.push(key);
  }

  records() {
    return [...this.data.entries()].map(([storageKey, raw]) => ({
      storageKey,
      raw,
      record: JSON.parse(raw),
    }));
  }

  findRecord(predicate) {
    const found = this.records().find(({ record }) => predicate(record));
    assert.ok(found, "expected a matching persisted record");
    return found;
  }
}

function expectCode(error, code) {
  assert.ok(error instanceof StateConflictError, String(error));
  assert.equal(error.code, code);
  return true;
}

test("defaults: player scope, default key, window lifetime, empty state", () => {
  const manager = new StateManager(new MemoryStore());
  const handle = manager.acquire({ ownerId: "p1" });

  assert.equal(handle.scope, "player");
  assert.equal(handle.key, "default");
  assert.equal(handle.lifetime, "window");
  assert.equal(handle.schema, "default");
  assert.equal(handle.ownerId, "p1");
  assert.equal(handle.released, false);
  assert.deepEqual(handle.get(), {});
  assert.ok(Object.isFrozen(handle.get()));

  handle.release();
  assert.equal(handle.released, true);
});

test("rejects invalid acquire options before mutating anything", () => {
  const manager = new StateManager();
  const invalidOptions = [
    undefined,
    null,
    [],
    "player",
    {},
    { scope: "team", ownerId: "p" },
    { scope: "player" },
    { scope: "shared" },
    { scope: "shared", key: "" },
    { scope: "shared", key: "   ", ownerId: "p" },
    { scope: "shared", key: "k", ownerId: "p" },
    { ownerId: "p", lifetime: "forever" },
    { ownerId: "p", key: "" },
    { ownerId: "p", schema: "" },
    { ownerId: "p", unknownOption: true },
  ];

  for (const options of invalidOptions) {
    assert.throws(
      () => manager.acquire(options),
      StateValidationError,
      JSON.stringify(options),
    );
  }
});

test("rejects invalid initial state fields and non-JSON data", () => {
  const manager = new StateManager();
  const circular = {};
  circular.self = circular;

  const invalidStates = [
    null,
    [],
    "state",
    { unknown: 1 },
    { page: -1 },
    { page: 1.5 },
    { page: Number.NaN },
    { line: "0" },
    { tab: Number.POSITIVE_INFINITY },
    { selection: 7 },
    { data: undefined },
    { data: () => 1 },
    { data: 10n },
    { data: Number.NaN },
    { data: new Date() },
    { data: { nested: undefined } },
    { data: { nested: () => 1 } },
    { data: { nested: Symbol("x") } },
    { data: [1, , 3] },
    { data: circular },
    { data: new (class Widget {})() },
    { tabs: [] },
    { tabs: { a: {} } },
    { tabs: { "-1": {} } },
    { tabs: { "01": {} } },
    { tabs: { 0: { page: -1 } } },
    { children: [] },
    { children: { shop: null } },
    { children: { shop: { nope: true } } },
    { children: { shop: { tabs: { x: {} } } } },
  ];

  for (const initial of invalidStates) {
    assert.throws(
      () => manager.acquire({ ownerId: "p", initial }),
      StateValidationError,
      JSON.stringify(initial, () => "(unserializable)"),
    );
  }
});

test("rejects invalid set patches", () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });

  for (const patch of [
    null,
    [],
    "page",
    { nope: 1 },
    { page: -1 },
    { data: undefined },
    { tabs: { a: {} } },
    { children: [] },
  ]) {
    assert.throws(() => handle.set(patch), StateValidationError);
  }
  assert.deepEqual(handle.get(), {});
});

test("_set validates patches reached through a handle's entry", () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p", initial: { page: 1 } });

  for (const patch of [null, [], { nope: 1 }, { page: -1 }, { tabs: { a: {} } }]) {
    assert.throws(
      () => manager._set(handle.entry, patch),
      StateValidationError,
    );
  }
  assert.deepEqual(handle.get(), { page: 1 });
  assert.ok(Object.isFrozen(handle.get()));

  const seen = [];
  handle.subscribe((state, changed) => seen.push([state.page, [...changed]]));
  manager._set(handle.entry, { page: 2 });
  assert.equal(handle.get().page, 2);
  assert.deepEqual(seen, [[2, ["page"]]]);
  handle.release();
});

test("shared scope shares one state and requires a key", () => {
  const manager = new StateManager();
  const first = manager.acquire({
    scope: "shared",
    key: "main-shop",
    schema: "shop-v1",
    initial: { page: 2 },
  });
  const second = manager.acquire({
    scope: "shared",
    key: "main-shop",
    schema: "shop-v1",
  });

  assert.equal(second.get().page, 2);
  first.set({ page: 3 });
  assert.equal(second.get().page, 3);

  const seen = [];
  second.subscribe((state, changed) => seen.push([state.page, [...changed]]));
  first.set({ tab: 1 });
  assert.deepEqual(seen, [[3, ["tab"]]]);

  first.release();
  assert.equal(second.get().page, 3, "state survives while a user remains");
  second.release();
});

test("window lifetime state is discarded when the last handle releases", () => {
  const manager = new StateManager();
  const first = manager.acquire({
    scope: "shared",
    key: "k",
    schema: "s",
    initial: { page: 4 },
  });
  const second = manager.acquire({ scope: "shared", key: "k", schema: "s" });

  first.release();
  assert.equal(second.get().page, 4);
  second.release();

  const fresh = manager.acquire({ scope: "shared", key: "k", schema: "s" });
  assert.deepEqual(fresh.get(), {});
  fresh.release();
});

test("player scope isolates owners and combines owner with key", () => {
  const manager = new StateManager();
  const alice = manager.acquire({
    ownerId: "alice",
    key: "inventory",
    initial: { page: 1 },
  });
  const bob = manager.acquire({
    ownerId: "bob",
    key: "inventory",
    initial: { page: 2 },
  });

  alice.set({ page: 10 });
  assert.equal(alice.get().page, 10);
  assert.equal(bob.get().page, 2);

  bob.release();
  assert.equal(alice.get().page, 10);
  alice.release();
});

test("session lifetime keeps state after every Window closes", () => {
  const manager = new StateManager();
  const first = manager.acquire({
    ownerId: "p",
    lifetime: "session",
    initial: { page: 4 },
  });
  first.set({ tab: 2 });
  first.release();

  const second = manager.acquire({ ownerId: "p", lifetime: "session" });
  assert.deepEqual(second.get(), { page: 4, tab: 2 });
  second.release();

  assert.throws(
    () => manager.acquire({ ownerId: "p", lifetime: "persistent" }),
    (error) => expectCode(error, "LIFETIME_MISMATCH"),
  );
});

test("persistent lifetime loads state in a new manager and saves synchronously", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const handle = manager.acquire({
    ownerId: "p",
    key: "quest",
    lifetime: "persistent",
    schema: "quest-v1",
    initial: { page: 1, data: { done: [1, 2] } },
  });

  assert.equal(store.setCalls.length, 1, "initial state is persisted");
  const { storageKey, record } = store.findRecord((entry) => entry.key === "quest");
  assert.equal(record.version, STATE_STORAGE_VERSION);
  assert.equal(record.scope, "player");
  assert.equal(record.ownerId, "p");
  assert.equal(record.lifetime, "persistent");
  assert.equal(record.schema, "quest-v1");
  assert.deepEqual(record.guiState, { page: 1, data: { done: [1, 2] } });

  handle.set({ page: 2 });
  assert.equal(store.setCalls.length, 2, "every change is saved synchronously");
  assert.equal(JSON.parse(store.getItem(storageKey)).guiState.page, 2);

  handle.set({ page: 2 });
  assert.equal(store.setCalls.length, 2, "no-op changes are not saved");
  handle.release();

  const reloaded = new StateManager(store).acquire({
    ownerId: "p",
    key: "quest",
    lifetime: "persistent",
    schema: "quest-v1",
    initial: { page: 99 },
  });
  assert.deepEqual(reloaded.get(), { page: 2, data: { done: [1, 2] } });
  reloaded.release();
});

test("shared persistent records omit ownerId", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const handle = manager.acquire({
    scope: "shared",
    key: "global",
    lifetime: "persistent",
    schema: "v1",
  });

  const { record } = store.findRecord((entry) => entry.key === "global");
  assert.equal("ownerId" in record, false);
  handle.release();
});

test("rejects live schema and lifetime mismatches for the same key", () => {
  const manager = new StateManager();
  const handle = manager.acquire({
    scope: "shared",
    key: "shop",
    schema: "v1",
    lifetime: "session",
  });

  assert.throws(
    () =>
      manager.acquire({ scope: "shared", key: "shop", schema: "v2", lifetime: "session" }),
    (error) => expectCode(error, "SCHEMA_MISMATCH"),
  );
  assert.throws(
    () =>
      manager.acquire({ scope: "shared", key: "shop", schema: "v1", lifetime: "persistent" }),
    (error) => expectCode(error, "LIFETIME_MISMATCH"),
  );

  handle.release();
});

test("rejects persisted schema and lifetime mismatches after reload", () => {
  const store = new MemoryStore();
  const first = new StateManager(store);
  first
    .acquire({
      scope: "shared",
      key: "shop",
      lifetime: "persistent",
      schema: "v1",
      initial: { page: 1 },
    })
    .release();

  const reloaded = new StateManager(store);
  assert.throws(
    () =>
      reloaded.acquire({
        scope: "shared",
        key: "shop",
        lifetime: "persistent",
        schema: "v2",
      }),
    (error) => expectCode(error, "SCHEMA_MISMATCH"),
  );
  assert.throws(
    () =>
      reloaded.acquire({
        scope: "shared",
        key: "shop",
        lifetime: "session",
        schema: "v1",
      }),
    (error) => expectCode(error, "LIFETIME_MISMATCH"),
  );
});

test("rejects persisted version and identity mismatches", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  manager
    .acquire({
      ownerId: "p",
      key: "v",
      lifetime: "persistent",
      schema: "v1",
    })
    .release();

  const { storageKey, record } = store.findRecord((entry) => entry.key === "v");
  store.setItem(storageKey, JSON.stringify({ ...record, version: 999 }));
  assert.throws(
    () =>
      new StateManager(store).acquire({
        ownerId: "p",
        key: "v",
        lifetime: "persistent",
        schema: "v1",
      }),
    (error) => expectCode(error, "VERSION_MISMATCH"),
  );

  store.setItem(storageKey, JSON.stringify({ ...record, key: "other" }));
  assert.throws(
    () =>
      new StateManager(store).acquire({
        ownerId: "p",
        key: "v",
        lifetime: "persistent",
        schema: "v1",
      }),
    (error) => expectCode(error, "IDENTITY_MISMATCH"),
  );
});

test("corrupt persisted state fails closed without deleting or overwriting it", () => {
  const store = new MemoryStore();
  const errors = [];
  const manager = new StateManager(store, { onError: (error) => errors.push(error) });
  const handle = manager.acquire({
    ownerId: "p",
    key: "corrupt",
    lifetime: "persistent",
    initial: { page: 1 },
  });
  const { storageKey, raw } = store.findRecord((entry) => entry.key === "corrupt");
  handle.release();

  store.setItem(storageKey, "{not json");
  const setCalls = store.setCalls.length;
  const removeCalls = store.removeCalls.length;
  const reloaded = new StateManager(store, { onError: (error) => errors.push(error) });

  assert.throws(
    () =>
      reloaded.acquire({
        ownerId: "p",
        key: "corrupt",
        lifetime: "persistent",
        initial: { page: 7 },
      }),
    (error) => {
      assert.ok(error instanceof StateCorruptionError);
      assert.equal(error.code, "CORRUPT_STORE");
      return true;
    },
  );
  assert.equal(store.getItem(storageKey), "{not json", "corrupt data is preserved");
  assert.equal(store.setCalls.length, setCalls, "no initial state is written over it");
  assert.equal(store.removeCalls.length, removeCalls, "nothing is deleted");
  assert.equal(errors.length, 0, "the failure is surfaced instead of swallowed");

  // Explicitly repairing the record restores the state normally.
  store.setItem(storageKey, raw);
  const repaired = new StateManager(store).acquire({
    ownerId: "p",
    key: "corrupt",
    lifetime: "persistent",
    initial: { page: 7 },
  });
  assert.deepEqual(repaired.get(), { page: 1 });
  repaired.release();
});

test("corrupt nested guiState fails closed", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  manager
    .acquire({
      ownerId: "p",
      key: "nested-corrupt",
      lifetime: "persistent",
      initial: { tabs: { 0: { page: 1 } } },
    })
    .release();

  const { storageKey, record } = store.findRecord(
    (entry) => entry.key === "nested-corrupt",
  );
  store.setItem(
    storageKey,
    JSON.stringify({ ...record, guiState: { tabs: { 0: { page: -1 } } } }),
  );
  const raw = store.getItem(storageKey);

  assert.throws(
    () =>
      new StateManager(store).acquire({
        ownerId: "p",
        key: "nested-corrupt",
        lifetime: "persistent",
      }),
    (error) => {
      assert.ok(error instanceof StateCorruptionError);
      assert.match(error.message, /guiState is invalid/);
      return true;
    },
  );
  assert.equal(store.getItem(storageKey), raw);
});

test("tabs and children round-trip through StateManager and persist", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const initial = {
    tab: 1,
    tabs: {
      0: { page: 2 },
      1: { page: 3, data: { filter: ["a"] } },
    },
    children: {
      shop: { page: 7, children: { nested: { line: 4 } } },
    },
  };
  const handle = manager.acquire({
    ownerId: "p",
    key: "nested",
    lifetime: "persistent",
    schema: "gui-v1",
    initial,
  });

  assert.deepEqual(handle.get(), initial);
  const snapshot = handle.get();
  assert.ok(Object.isFrozen(snapshot.tabs));
  assert.ok(Object.isFrozen(snapshot.tabs[1]));
  assert.ok(Object.isFrozen(snapshot.children.shop.children.nested));

  const seen = [];
  handle.subscribe((state, changed) => seen.push([state.tabs[0].page, [...changed]]));
  handle.set({ tab: 0, tabs: { 0: { page: 9 } } });
  assert.deepEqual(seen, [[9, ["tab", "tabs"]]]);
  assert.deepEqual(handle.get().tabs, { 0: { page: 9 } });
  handle.release();

  const reloaded = new StateManager(store).acquire({
    ownerId: "p",
    key: "nested",
    lifetime: "persistent",
    schema: "gui-v1",
  });
  assert.deepEqual(reloaded.get(), {
    tab: 0,
    tabs: { 0: { page: 9 } },
    children: { shop: { page: 7, children: { nested: { line: 4 } } } },
  });
  assert.ok(Object.isFrozen(reloaded.get().tabs[0]));
  reloaded.release();
});

test("store write failure aborts the change", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const handle = manager.acquire({
    ownerId: "p",
    lifetime: "persistent",
    initial: { page: 1 },
  });

  store.setItem = () => {
    throw new Error("disk full");
  };
  assert.throws(() => handle.set({ page: 2 }), /disk full/);
  assert.equal(handle.get().page, 1, "state is unchanged when persistence fails");
  handle.release();
});

test("persistent lifetime requires a store; other lifetimes do not", () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p", lifetime: "session" });
  handle.release();

  const withoutStore = new StateManager();
  assert.throws(
    () => withoutStore.acquire({ ownerId: "p", lifetime: "persistent" }),
    StateValidationError,
  );
});

test("validates store and manager options", () => {
  assert.throws(() => new StateManager({ getItem() {} }), StateValidationError);
  assert.throws(() => new StateManager(null, { onError: 1 }), StateValidationError);
  assert.throws(
    () => new StateManager(null, { nope: true }),
    StateValidationError,
  );
});

test("snapshots are deeply frozen and isolated from caller mutation", () => {
  const manager = new StateManager();
  const handle = manager.acquire({
    ownerId: "p",
    initial: { page: 1, data: { nested: { n: 1 }, list: [1, 2] } },
  });
  const snapshot = handle.get();

  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.data));
  assert.ok(Object.isFrozen(snapshot.data.nested));
  assert.ok(Object.isFrozen(snapshot.data.list));

  assert.throws(() => {
    snapshot.data.nested.n = 2;
  }, TypeError);
  assert.equal(handle.get().data.nested.n, 1);
  handle.release();
});

test("data supports JSON prototype-named keys without prototype pollution", () => {
  const manager = new StateManager();
  const input = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"safe","list":[1,null,{"a":true}]}',
  );
  const handle = manager.acquire({ ownerId: "p", initial: { data: input } });
  const snapshot = handle.get();

  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot.data, "__proto__"),
    true,
  );
  assert.equal(
    JSON.stringify(snapshot.data),
    JSON.stringify(input),
    "data round-trips through JSON unchanged",
  );
  handle.release();
});

test("notifies subscribers after changes and isolates listener errors", () => {
  const errors = [];
  const manager = new StateManager(new MemoryStore(), {
    onError: (error) => errors.push(error),
  });
  const handle = manager.acquire({ ownerId: "p" });
  const seen = [];
  const unsubscribe = handle.subscribe((state, changed) => {
    seen.push([state.page, [...changed]]);
  });
  handle.subscribe(() => {
    throw new Error("listener boom");
  });

  handle.set({ page: 1 });
  assert.deepEqual(seen, [[1, ["page"]]]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /listener boom/);

  unsubscribe();
  handle.set({ page: 2 });
  assert.equal(seen.length, 1, "unsubscribed listener is not called");
  handle.release();
});

test("a listener that releases its handle does not skip other listeners", () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });
  const seen = [];
  handle.subscribe(() => {
    handle.release();
  });
  handle.subscribe((state, changed) => seen.push([state.page, [...changed]]));

  assert.equal(handle.set({ page: 1 }).page, 1);
  assert.deepEqual(seen, [[1, ["page"]]], "committed change still reaches every subscribed listener");
  assert.equal(handle.released, true);
});

test("same-value and empty patches are no-ops", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const handle = manager.acquire({
    ownerId: "p",
    lifetime: "persistent",
    initial: { page: 1 },
  });
  const before = handle.get();
  const writes = store.setCalls.length;
  const seen = [];
  handle.subscribe(() => seen.push(1));

  assert.equal(handle.set({}), before);
  assert.equal(handle.set({ page: 1 }), before);
  assert.equal(store.setCalls.length, writes);
  assert.equal(seen.length, 0);
  handle.release();
});

test("same-key async work is strictly sequential", async () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });
  const order = [];

  const first = handle.enqueue(async () => {
    await delay(20);
    order.push("first");
  });
  const second = handle.enqueue(async () => {
    order.push("second");
  });
  const third = handle.enqueue(() => {
    order.push("third");
  });

  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["first", "second", "third"]);
  handle.release();
});

test("same key across shared handles uses one queue; other keys do not queue", async () => {
  const manager = new StateManager();
  const sharedA = manager.acquire({ scope: "shared", key: "q", schema: "s" });
  const sharedB = manager.acquire({ scope: "shared", key: "q", schema: "s" });
  const other = manager.acquire({ ownerId: "p", key: "other" });
  const order = [];

  await Promise.all([
    sharedA.enqueue(async () => {
      await delay(10);
      order.push("a");
    }),
    sharedB.enqueue(() => {
      order.push("b");
    }),
  ]);
  assert.deepEqual(order, ["a", "b"]);

  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const concurrent = [];
  const blocked = sharedA.enqueue(async () => {
    concurrent.push("blocked-start");
    await gate;
    concurrent.push("blocked-end");
  });
  const independent = other.enqueue(() => {
    concurrent.push("independent");
  });

  await independent;
  assert.deepEqual(concurrent, ["blocked-start", "independent"]);
  openGate();
  await blocked;
  assert.deepEqual(concurrent, [
    "blocked-start",
    "independent",
    "blocked-end",
  ]);

  sharedA.release();
  sharedB.release();
  other.release();
});

test("a failing queued task does not block the queue", async () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });

  const failed = handle.enqueue(async () => {
    throw new Error("task boom");
  });
  const next = handle.enqueue(() => "ok");

  await assert.rejects(failed, /task boom/);
  assert.equal(await next, "ok");
  handle.release();
});

test("release discards queued tasks but lets the running task finish", async () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });
  const started = [];

  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const running = handle.enqueue(async () => {
    started.push("running");
    await gate;
    return "finished";
  });
  const pending = handle.enqueue(() => {
    started.push("pending");
    return "should not run";
  });

  await Promise.resolve();
  handle.release();
  openGate();

  assert.equal(await running, "finished");
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof StateReleasedError);
    assert.equal(error.code, "RELEASED");
    return true;
  });
  assert.deepEqual(started, ["running"]);
});

test("update is an atomic read-modify-write on the identity queue", async () => {
  const manager = new StateManager();
  const handle = manager.acquire({
    ownerId: "p",
    lifetime: "session",
    initial: { data: { n: 0 } },
  });

  await Promise.all([
    handle.update(async (state) => {
      await delay(5);
      return { data: { n: state.data.n + 1 } };
    }),
    handle.update((state) => ({ data: { n: state.data.n + 1 } })),
    handle.update((state) => ({ data: { n: state.data.n + 1 } })),
  ]);

  assert.deepEqual(handle.get().data, { n: 3 });
  handle.release();
});

test("update does not write a stale result or write after release", async () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "stale" });

  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const update = handle.update(async (state) => {
    await gate;
    return { page: (state.page ?? 0) + 1 };
  });

  await Promise.resolve();
  handle.set({ page: 10 });
  openGate();

  await assert.rejects(update, (error) => expectCode(error, "STALE_STATE"));
  assert.equal(handle.get().page, 10);

  let releaseGate;
  const secondGate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const releasedUpdate = handle.update(async () => {
    await secondGate;
    return { page: 11 };
  });
  await Promise.resolve();
  handle.release();
  releaseGate();
  await assert.rejects(releasedUpdate, (error) => {
    assert.ok(error instanceof StateReleasedError);
    return true;
  });
});

test("release is idempotent and makes the handle unusable", async () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });
  handle.release();
  handle.release();

  assert.equal(handle.released, true);
  assert.throws(() => handle.get(), StateReleasedError);
  assert.throws(() => handle.set({ page: 1 }), StateReleasedError);
  assert.throws(() => handle.subscribe(() => {}), StateReleasedError);
  assert.throws(() => handle.enqueue(() => 1), StateReleasedError);
  assert.throws(() => handle.update(() => ({})), StateReleasedError);
});

test("manager.release rejects handles from another manager", () => {
  const first = new StateManager();
  const second = new StateManager();
  const handle = first.acquire({ ownerId: "p" });

  assert.throws(() => second.release(handle), StateValidationError);
  first.release(handle);
  assert.equal(handle.released, true);
});

test("player persistent states are isolated per owner", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const alice = manager.acquire({
    ownerId: "alice",
    key: "progress",
    lifetime: "persistent",
    schema: "v1",
    initial: { page: 1 },
  });
  const bob = manager.acquire({
    ownerId: "bob",
    key: "progress",
    lifetime: "persistent",
    schema: "v1",
    initial: { page: 2 },
  });

  alice.set({ page: 5 });
  assert.equal(alice.get().page, 5);
  assert.equal(bob.get().page, 2);

  alice.release();
  bob.release();

  const reloaded = new StateManager(store);
  const aliceAgain = reloaded.acquire({
    ownerId: "alice",
    key: "progress",
    lifetime: "persistent",
    schema: "v1",
  });
  const bobAgain = reloaded.acquire({
    ownerId: "bob",
    key: "progress",
    lifetime: "persistent",
    schema: "v1",
  });
  assert.equal(aliceAgain.get().page, 5);
  assert.equal(bobAgain.get().page, 2);
  aliceAgain.release();
  bobAgain.release();
});
