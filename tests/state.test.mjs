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

/**
 * Creates a persistent record for `options`, then replaces it with `legacy`
 * (an arbitrary old-version payload) and returns its storage key.
 */
function seedLegacyRecord(store, options, legacy) {
  new StateManager(store)
    .acquire({ ...options, lifetime: "persistent", initial: {} })
    .release();
  const { storageKey } = store.findRecord((entry) => entry.key === options.key);
  store.setItem(storageKey, JSON.stringify(legacy));
  return storageKey;
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

test("_set validates patches and only accepts a live handle it owns", () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p", initial: { page: 1 } });

  for (const patch of [null, [], { nope: 1 }, { page: -1 }, { tabs: { a: {} } }]) {
    assert.throws(() => manager._set(handle, patch), StateValidationError);
  }
  assert.deepEqual(handle.get(), { page: 1 });
  assert.ok(Object.isFrozen(handle.get()));

  const seen = [];
  handle.subscribe((state, changed) => seen.push([state.page, [...changed]]));
  manager._set(handle, { page: 2 });
  assert.equal(handle.get().page, 2);
  assert.deepEqual(seen, [[2, ["page"]]]);

  handle.release();
  assert.throws(() => manager._set(handle, { page: 3 }), StateReleasedError);
});

test("handles expose no internal entry or manager to tamper with", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const handle = manager.acquire({
    ownerId: "p",
    key: "private",
    lifetime: "persistent",
    schema: "s",
    initial: { page: 1 },
  });
  const initialRaw = store.findRecord((entry) => entry.key === "private").raw;

  assert.equal(handle.entry, undefined);
  assert.equal(handle.manager, undefined);
  assert.equal(handle.active, undefined);
  assert.equal(Object.hasOwn(handle, "entry"), false);

  // Replacing a same-named property only shadows nothing: internals stay put.
  handle.entry = {
    identity: "forged",
    state: { page: 99 },
    released: false,
  };
  handle.manager = { _set: () => ({ page: 99 }) };
  assert.deepEqual(handle.get(), { page: 1 });
  assert.equal(
    store.findRecord((entry) => entry.key === "private").raw,
    initialRaw,
    "tampering never reaches the persisted record",
  );

  handle.set({ page: 2 });
  assert.deepEqual(handle.get(), { page: 2 });
  assert.equal(
    store.findRecord((entry) => entry.key === "private").record.guiState.page,
    2,
  );
  handle.release();
});

test("forged entries and foreign-manager calls cannot corrupt state", async () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  const handle = manager.acquire({
    ownerId: "p",
    key: "safe",
    lifetime: "persistent",
    schema: "s",
    initial: { page: 1 },
  });
  const { storageKey, raw } = store.findRecord((entry) => entry.key === "safe");
  const other = new StateManager(store);

  // A hand-built entry carrying a real identity must be rejected by _set.
  const forgedEntry = {
    identity: JSON.stringify(["player", "p", "safe"]),
    scope: "player",
    key: "safe",
    ownerId: "p",
    lifetime: "persistent",
    schema: "s",
    state: { page: 99 },
    handles: new Set(),
    tail: Promise.resolve(),
    released: false,
  };
  assert.throws(
    () => manager._set(forgedEntry, { page: 99 }),
    StateValidationError,
  );

  // A forged handle (even one sharing the real prototype) is not accepted.
  const forgedHandle = Object.create(Object.getPrototypeOf(handle));
  assert.throws(
    () => manager._set(forgedHandle, { page: 99 }),
    StateValidationError,
  );
  assert.throws(() => manager.release(forgedHandle), StateValidationError);

  // A handle from another manager cannot be driven through this one.
  assert.throws(() => other._set(handle, { page: 99 }), StateValidationError);
  assert.throws(() => other.release(handle), StateValidationError);
  assert.throws(
    () => other._enqueue(handle, () => "nope"),
    StateValidationError,
  );
  assert.throws(
    () => other._update(handle, () => ({ page: 99 })),
    StateValidationError,
  );

  assert.deepEqual(handle.get(), { page: 1 });
  assert.equal(store.getItem(storageKey), raw);

  // The owning manager still works and persists validated state only.
  assert.throws(() => handle.set({ page: -1 }), StateValidationError);
  assert.equal(store.getItem(storageKey), raw);
  handle.set({ page: 3 });
  assert.equal(
    store.findRecord((entry) => entry.key === "safe").record.guiState.page,
    3,
  );
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

test("explicit migration converts an old record; acquire stays fail-closed", () => {
  const store = new MemoryStore();
  const legacy = {
    version: 0,
    scope: "player",
    key: "quest",
    ownerId: "p",
    guiState: { pageNo: 4, data: { old: true } },
  };
  const storageKey = seedLegacyRecord(
    store,
    { ownerId: "p", key: "quest", schema: "quest-v0" },
    legacy,
  );
  const raw = store.getItem(storageKey);
  const setCalls = store.setCalls.length;
  const removeCalls = store.removeCalls.length;

  const manager = new StateManager(store);
  assert.throws(
    () =>
      manager.acquire({
        ownerId: "p",
        key: "quest",
        lifetime: "persistent",
        schema: "quest-v2",
      }),
    (error) => expectCode(error, "VERSION_MISMATCH"),
  );
  assert.equal(
    store.getItem(storageKey),
    raw,
    "acquire never auto-converts or overwrites an old record",
  );
  assert.equal(store.setCalls.length, setCalls);
  assert.equal(store.removeCalls.length, removeCalls);

  const seen = [];
  manager.migrate(
    {
      ownerId: "p",
      key: "quest",
      fromVersion: 0,
      fromSchema: null,
      schema: "quest-v2",
    },
    (old) => {
      seen.push(old);
      return { page: old.guiState.pageNo, data: old.guiState.data };
    },
  );

  assert.deepEqual(seen, [legacy], "the callback receives the decoded old value");
  assert.equal(store.removeCalls.length, removeCalls, "migration never deletes");
  const migrated = store.findRecord((entry) => entry.key === "quest");
  assert.equal(migrated.storageKey, storageKey);
  assert.deepEqual(migrated.record, {
    version: STATE_STORAGE_VERSION,
    scope: "player",
    key: "quest",
    ownerId: "p",
    lifetime: "persistent",
    schema: "quest-v2",
    guiState: { page: 4, data: { old: true } },
  });

  const handle = new StateManager(store).acquire({
    ownerId: "p",
    key: "quest",
    lifetime: "persistent",
    schema: "quest-v2",
  });
  assert.deepEqual(handle.get(), { page: 4, data: { old: true } });
  handle.release();
});

test("migrating a released persistent state refreshes it; shared records omit ownerId", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  manager
    .acquire({
      scope: "shared",
      key: "global",
      lifetime: "persistent",
      schema: "v1",
      initial: { page: 1 },
    })
    .release();

  // The persistent entry is still registered with zero handles in this manager.
  manager.migrate(
    {
      scope: "shared",
      key: "global",
      fromVersion: STATE_STORAGE_VERSION,
      fromSchema: "v1",
      schema: "v2",
    },
    (old) => ({
      page: old.guiState.page + 1,
    }),
  );

  const { record } = store.findRecord((entry) => entry.key === "global");
  assert.equal("ownerId" in record, false);
  assert.equal(record.version, STATE_STORAGE_VERSION);
  assert.equal(record.lifetime, "persistent");
  assert.equal(record.schema, "v2");
  assert.equal(record.guiState.page, 2);

  const reloaded = manager.acquire({
    scope: "shared",
    key: "global",
    lifetime: "persistent",
    schema: "v2",
  });
  assert.equal(reloaded.get().page, 2);
  reloaded.release();
});

test("migration rejects invalid input, missing records, and live states", () => {
  const empty = new StateManager(new MemoryStore());
  for (const options of [
    undefined,
    null,
    [],
    {},
    { scope: "shared" },
    { scope: "player" },
    { scope: "shared", key: "k", ownerId: "p" },
    { ownerId: "p", schema: "" },
    { ownerId: "p", unknown: true },
    { ownerId: "p", fromVersion: 0, fromSchema: null },
    { ownerId: "p", fromVersion: 0, schema: "v2" },
    { ownerId: "p", fromSchema: null, schema: "v2" },
    { ownerId: "p", fromVersion: -1, fromSchema: null, schema: "v2" },
    { ownerId: "p", fromVersion: 0.5, fromSchema: null, schema: "v2" },
    { ownerId: "p", fromVersion: 0, fromSchema: "", schema: "v2" },
    { ownerId: "p", fromVersion: 0, fromSchema: null, schema: "" },
    // Re-running a migration to the version/schema the record already has.
    {
      ownerId: "p",
      fromVersion: STATE_STORAGE_VERSION,
      fromSchema: "v2",
      schema: "v2",
    },
  ]) {
    assert.throws(
      () => empty.migrate(options, () => ({})),
      StateValidationError,
      JSON.stringify(options),
    );
  }
  assert.throws(
    () => empty.migrate({ ownerId: "p", fromVersion: 0, fromSchema: null, schema: "v2" }, "not a function"),
    StateValidationError,
  );
  assert.throws(
    () => new StateManager().migrate({ ownerId: "p", fromVersion: 0, fromSchema: null, schema: "v2" }, () => ({})),
    StateValidationError,
  );
  assert.throws(
    () =>
      empty.migrate(
        { ownerId: "p", key: "none", fromVersion: 0, fromSchema: null, schema: "v2" },
        () => ({}),
      ),
    (error) => expectCode(error, "MISSING_STATE"),
  );

  const store = new MemoryStore();
  const manager = new StateManager(store);
  const live = manager.acquire({
    ownerId: "p",
    key: "live",
    lifetime: "persistent",
    initial: { page: 1 },
  });
  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "p",
          key: "live",
          fromVersion: STATE_STORAGE_VERSION,
          fromSchema: "default",
          schema: "v2",
        },
        () => ({ page: 2 }),
      ),
    (error) => expectCode(error, "LIVE_STATE"),
  );
  assert.equal(live.get().page, 1);
  assert.equal(
    store.findRecord((entry) => entry.key === "live").record.guiState.page,
    1,
  );
  live.release();

  const session = manager.acquire({
    ownerId: "s",
    key: "session",
    lifetime: "session",
  });
  session.release();
  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "s",
          key: "session",
          fromVersion: STATE_STORAGE_VERSION,
          fromSchema: "default",
          schema: "v2",
        },
        () => ({}),
      ),
    (error) => expectCode(error, "LIVE_STATE"),
    "a released session entry still owns the identity",
  );
});

test("migration failures leave the old record untouched", () => {
  const store = new MemoryStore();
  const legacy = {
    version: 0,
    scope: "player",
    key: "keep",
    ownerId: "p",
    guiState: { pageNo: 3 },
  };
  const storageKey = seedLegacyRecord(
    store,
    { ownerId: "p", key: "keep" },
    legacy,
  );
  const raw = store.getItem(storageKey);
  const writes = store.setCalls.length;
  const manager = new StateManager(store);
  const options = {
    ownerId: "p",
    key: "keep",
    fromVersion: 0,
    fromSchema: null,
    schema: "keep-v2",
  };

  assert.throws(
    () =>
      manager.migrate(options, () => {
        throw new Error("migration boom");
      }),
    /migration boom/,
  );
  assert.throws(
    () => manager.migrate(options, () => ({ page: -1 })),
    StateValidationError,
  );
  assert.throws(
    () => manager.migrate(options, () => ({ data: 1n })),
    StateValidationError,
  );
  assert.equal(store.getItem(storageKey), raw);
  assert.equal(store.setCalls.length, writes);
  assert.equal(store.removeCalls.length, 0);

  store.setItem(storageKey, "{broken");
  const corruptWrites = store.setCalls.length;
  let called = false;
  assert.throws(
    () =>
      manager.migrate(options, () => {
        called = true;
        return {};
      }),
    (error) => {
      assert.ok(error instanceof StateCorruptionError);
      assert.equal(error.code, "CORRUPT_STORE");
      return true;
    },
  );
  assert.equal(called, false, "an undecodable record is never passed to the callback");
  assert.equal(store.getItem(storageKey), "{broken");
  assert.equal(store.setCalls.length, corruptWrites);
  assert.equal(store.removeCalls.length, 0);
});

test("migration verifies the stored version, schema, identity, and lifetime before writing", () => {
  const store = new MemoryStore();
  const identity = { ownerId: "p", key: "verify" };
  const legacy = {
    version: 0,
    scope: "player",
    key: "verify",
    ownerId: "p",
    guiState: { pageNo: 1 },
  };
  const storageKey = seedLegacyRecord(store, identity, legacy);
  const manager = new StateManager(store);
  const migration = {
    ...identity,
    fromVersion: 0,
    fromSchema: null,
    schema: "v2",
  };

  const mismatches = [
    [{ ...legacy, version: 7 }, "VERSION_MISMATCH"],
    [{ ...legacy, schema: "old" }, "SCHEMA_MISMATCH"],
    [{ ...legacy, scope: "shared" }, "IDENTITY_MISMATCH"],
    [{ ...legacy, key: "other" }, "IDENTITY_MISMATCH"],
    [{ ...legacy, ownerId: "q" }, "IDENTITY_MISMATCH"],
    [{ ...legacy, lifetime: "session" }, "LIFETIME_MISMATCH"],
  ];

  for (const [record, code] of mismatches) {
    const writesBeforeFixture = store.setCalls.length;
    store.setItem(storageKey, JSON.stringify(record));
    const raw = store.getItem(storageKey);
    let called = false;
    assert.throws(
      () =>
        manager.migrate(migration, () => {
          called = true;
          return {};
        }),
      (error) => expectCode(error, code),
      JSON.stringify(record),
    );
    assert.equal(called, false, "the callback never runs for a mismatched record");
    assert.equal(store.getItem(storageKey), raw, "the mismatched record is preserved");
    assert.equal(
      store.setCalls.length,
      writesBeforeFixture + 1,
      "the fixture write is the only store write",
    );
  }
});

test("migration rejects re-running against a record already at the target version and schema", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  manager
    .acquire({
      ownerId: "p",
      key: "rerun",
      lifetime: "persistent",
      schema: "v1",
      initial: { page: 1 },
    })
    .release();
  const { storageKey } = store.findRecord((entry) => entry.key === "rerun");
  const raw = store.getItem(storageKey);
  const writes = store.setCalls.length;

  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "p",
          key: "rerun",
          fromVersion: STATE_STORAGE_VERSION,
          fromSchema: "v1",
          schema: "v1",
        },
        () => ({ page: 2 }),
      ),
    StateValidationError,
    "no-op migration to the same version and schema is rejected",
  );
  assert.equal(store.getItem(storageKey), raw);
  assert.equal(store.setCalls.length, writes);

  manager.migrate(
    {
      ownerId: "p",
      key: "rerun",
      fromVersion: STATE_STORAGE_VERSION,
      fromSchema: "v1",
      schema: "v2",
    },
    () => ({ page: 2 }),
  );
  const migratedRaw = store.getItem(storageKey);
  assert.equal(JSON.parse(migratedRaw).schema, "v2");

  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "p",
          key: "rerun",
          fromVersion: STATE_STORAGE_VERSION,
          fromSchema: "v1",
          schema: "v2",
        },
        () => ({ page: 3 }),
      ),
    (error) => expectCode(error, "SCHEMA_MISMATCH"),
    "the same schema migration cannot be replayed after it was applied",
  );
  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "p",
          key: "rerun",
          fromVersion: 0,
          fromSchema: null,
          schema: "v2",
        },
        () => ({ page: 3 }),
      ),
    (error) => expectCode(error, "VERSION_MISMATCH"),
    "the original legacy declaration cannot be replayed either",
  );
  assert.equal(store.getItem(storageKey), migratedRaw);
});

test("a failed migration evicts the zero-handle entry so it cannot overwrite the record", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  manager
    .acquire({
      ownerId: "p",
      key: "stale",
      lifetime: "persistent",
      schema: "v1",
      initial: { page: 1 },
    })
    .release();
  const { storageKey } = store.findRecord((entry) => entry.key === "stale");
  const legacy = {
    version: 0,
    scope: "player",
    key: "stale",
    ownerId: "p",
    guiState: { pageNo: 9 },
  };
  const raw = JSON.stringify(legacy);
  store.setItem(storageKey, raw);

  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "p",
          key: "stale",
          fromVersion: 0,
          fromSchema: null,
          schema: "v2",
        },
        () => {
          throw new Error("migration boom");
        },
      ),
    /migration boom/,
  );
  assert.equal(store.getItem(storageKey), raw, "the old record is untouched");

  // The stale in-memory entry (schema v1, page 1) must be gone. If it were
  // still registered, this acquire would hand back the old state and a later
  // set() would write a v1 record over the un-migrated legacy record.
  assert.throws(
    () =>
      manager.acquire({
        ownerId: "p",
        key: "stale",
        lifetime: "persistent",
        schema: "v1",
      }),
    (error) => expectCode(error, "VERSION_MISMATCH"),
  );
  assert.equal(store.getItem(storageKey), raw, "the legacy record is still preserved");
});

test("a migration store write failure also evicts the zero-handle entry", () => {
  const store = new MemoryStore();
  const manager = new StateManager(store);
  manager
    .acquire({
      ownerId: "p",
      key: "write",
      lifetime: "persistent",
      schema: "v0",
      initial: { page: 1 },
    })
    .release();
  const { storageKey } = store.findRecord((entry) => entry.key === "write");
  const legacy = {
    version: 0,
    scope: "player",
    key: "write",
    ownerId: "p",
    guiState: { pageNo: 9 },
  };
  const raw = JSON.stringify(legacy);
  store.setItem(storageKey, raw);

  const setItem = store.setItem.bind(store);
  store.setItem = () => {
    throw new Error("disk full");
  };
  assert.throws(
    () =>
      manager.migrate(
        {
          ownerId: "p",
          key: "write",
          fromVersion: 0,
          fromSchema: null,
          schema: "v2",
        },
        () => ({ page: 2 }),
      ),
    /disk full/,
  );
  store.setItem = setItem;
  assert.equal(store.getItem(storageKey), raw, "the failed write leaves the old record");

  assert.throws(
    () =>
      manager.acquire({
        ownerId: "p",
        key: "write",
        lifetime: "persistent",
        schema: "v0",
      }),
    (error) => expectCode(error, "VERSION_MISMATCH"),
    "the stale entry must be evicted rather than reused",
  );
  assert.equal(store.getItem(storageKey), raw);
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

test("a reentrant set never leaves a subscriber on a stale snapshot", () => {
  const manager = new StateManager();
  const first = manager.acquire({ ownerId: "p" });
  const second = manager.acquire({ ownerId: "p" });
  const seenByFirst = [];
  const seenBySecond = [];

  first.subscribe((state) => {
    if (state.page === 1) {
      first.set({ page: 2 });
    }
  });
  first.subscribe((state) => seenByFirst.push(state.page));
  second.subscribe((state) => seenBySecond.push(state.page));

  first.set({ page: 1 });

  assert.equal(first.get().page, 2);
  assert.deepEqual(
    seenByFirst,
    [2],
    "remaining listeners of the committing handle see only the newer commit",
  );
  assert.deepEqual(
    seenBySecond,
    [2],
    "another handle's listener sees only the newer commit",
  );
});

test("a reentrant set delivers the union of changed fields to remaining subscribers", () => {
  const manager = new StateManager();
  const handle = manager.acquire({ ownerId: "p" });
  const reentrant = [];
  const remaining = [];

  // Subscribed first: gets the outer commit, then supersedes it with a set.
  handle.subscribe((state, changed) => {
    reentrant.push([state.page, [...changed]]);
    if (state.page === 1) {
      handle.set({ line: 2 });
    }
  });
  handle.subscribe((state, changed) => {
    remaining.push([[state.page, state.line], [...changed]]);
  });

  handle.set({ page: 1, selection: "s" });

  assert.deepEqual(reentrant, [[1, ["page", "selection"]], [1, ["line"]]]);
  assert.deepEqual(
    remaining,
    [[[1, 2], ["page", "selection", "line"]]],
    "a subscriber that missed the superseded commit still learns every changed field",
  );
  handle.release();
});

test("a reentrant set on another handle delivers the union to remaining subscribers", () => {
  const manager = new StateManager();
  const writer = manager.acquire({ ownerId: "p" });
  const reader = manager.acquire({ ownerId: "p" });
  const seen = [];

  writer.subscribe((state) => {
    if (state.page === 1) {
      reader.set({ tab: 3 });
    }
  });
  reader.subscribe((state, changed) => {
    seen.push([[state.page, state.tab], [...changed]]);
  });

  writer.set({ page: 1, selection: "s" });
  assert.deepEqual(seen, [[[1, 3], ["page", "selection", "tab"]]]);
  writer.release();
  reader.release();
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
