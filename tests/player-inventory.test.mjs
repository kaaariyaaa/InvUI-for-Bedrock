import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Run from src/ before `npm run build`: map the ESM-style "./json.js" imports
// used by the TypeScript sources onto the TypeScript files.
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

const { InventoryLink, VirtualInventory } = await import("../src/inventory.ts");
const { PlayerInventory, PlayerInventoryReadOnlyError } = await import(
  "../src/player-inventory.ts"
);

class FakeStack {
  constructor(typeId, amount = 1) {
    this.typeId = typeId;
    this.amount = amount;
  }

  clone() {
    return new FakeStack(this.typeId, this.amount);
  }
}

function fakePlayer(id, items) {
  return {
    id,
    getComponent(name) {
      if (name !== "inventory") return undefined;
      return {
        container: {
          size: items.length,
          getItem(slot) {
            return items[slot];
          },
          setItem() {
            throw new Error("the adapter must not write");
          },
          clearAll() {
            throw new Error("the adapter must not write");
          },
        },
      };
    },
  };
}

class FakeChangeSource {
  #listeners = new Set();

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(change) {
    for (const listener of [...this.#listeners]) listener(change);
  }

  get size() {
    return this.#listeners.size;
  }
}

function stack(typeId) {
  return new FakeStack(typeId);
}

/** Source that fires the current state synchronously inside subscribe(). */
class SyncChangeSource {
  #listeners = new Set();
  #initial;
  subscribes = 0;

  constructor(initial) {
    this.#initial = initial;
  }

  subscribe(listener) {
    this.subscribes += 1;
    this.#listeners.add(listener);
    if (this.#initial !== undefined) listener(this.#initial);
    return () => this.#listeners.delete(listener);
  }

  emit(change) {
    for (const listener of [...this.#listeners]) listener(change);
  }

  get size() {
    return this.#listeners.size;
  }
}

function withSilencedConsoleError(fn) {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logs;
}

test("PlayerInventory reads cloned slots and reports the player container size", () => {
  const items = [stack("minecraft:apple"), undefined, stack("minecraft:stone")];
  const inventory = new PlayerInventory(fakePlayer("p1", items));

  assert.equal(inventory.size, 3);
  const apple = inventory.getItem(0);
  assert.equal(apple.typeId, "minecraft:apple");
  assert.notEqual(apple, items[0], "getItem must return a clone");
  apple.amount = 9;
  assert.equal(items[0].amount, 1, "mutating the returned clone must not touch the container");
  assert.equal(inventory.getItem(1), undefined);
});

test("PlayerInventory rejects out-of-range slots", () => {
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]));
  assert.throws(() => inventory.getItem(-1), RangeError);
  assert.throws(() => inventory.getItem(1), RangeError);
  assert.throws(() => inventory.getItem(0.5), RangeError);
});

test("PlayerInventory is read-only: setItem and clear throw before writing", () => {
  let writes = 0;
  const player = fakePlayer("p1", [undefined]);
  player.getComponent = () => ({
    container: {
      size: 1,
      getItem() {
        return undefined;
      },
      setItem() {
        writes += 1;
      },
      clearAll() {
        writes += 1;
      },
    },
  });
  const inventory = new PlayerInventory(player);

  assert.throws(() => inventory.setItem(0, stack("minecraft:diamond")), PlayerInventoryReadOnlyError);
  assert.throws(() => inventory.clear(), PlayerInventoryReadOnlyError);
  assert.equal(writes, 0);
  assert.equal(PlayerInventory.writable, false);
});

test("PlayerInventory validates the player and inventory component", () => {
  assert.throws(() => new PlayerInventory(null), TypeError);
  assert.throws(() => new PlayerInventory({ id: "" }), TypeError);
  assert.throws(
    () => new PlayerInventory({ id: "p1", getComponent: () => undefined }),
    /inventory component|valid inventory container/,
  );
});

test("PlayerInventory forwards only this player's in-range changes from the supplied source", () => {
  const source = new FakeChangeSource();
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined, undefined]), {
    changes: source,
  });
  const received = [];
  const unsubscribe = inventory.subscribe((change) => received.push(change));

  const before = stack("minecraft:apple");
  const after = stack("minecraft:bread");
  source.emit({ playerId: "p1", slot: 0, previous: before, current: after });
  source.emit({ playerId: "p2", slot: 0, previous: before, current: after });
  source.emit({ playerId: "p1", slot: 2, previous: before, current: after });

  assert.equal(received.length, 1);
  assert.equal(received[0].inventory, inventory);
  assert.equal(received[0].slot, 0);
  assert.equal(received[0].previous.typeId, "minecraft:apple");
  assert.equal(received[0].current.typeId, "minecraft:bread");
  assert.notEqual(received[0].current, after, "event items must be cloned");
  after.amount = 7;
  assert.equal(received[0].current.amount, 1);

  unsubscribe();
  assert.equal(source.size, 0, "the source subscription is released with the last listener");
});

test("PlayerInventory without a change source never fires and still displays with InventoryLink", () => {
  const items = [stack("minecraft:apple")];
  const inventory = new PlayerInventory(fakePlayer("p1", items));
  let calls = 0;

  const unsubscribe = inventory.subscribe(() => {
    calls += 1;
  });
  unsubscribe();
  assert.equal(calls, 0);

  const link = new InventoryLink(inventory, 0);
  assert.equal(link.getItem().typeId, "minecraft:apple");
  assert.throws(() => link.setItem(stack("minecraft:stone")), PlayerInventoryReadOnlyError);
  assert.throws(() => link.moveTo(inventory, 0), /movement is disabled/);
});

test("PlayerInventory dedupes a listener exactly like VirtualInventory", () => {
  const source = new FakeChangeSource();
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });
  const virtual = new VirtualInventory(1);
  const calls = [];
  const virtualCalls = [];
  const listener = (change) => calls.push(change);
  const virtualListener = (change) => virtualCalls.push(change);

  const off1 = inventory.subscribe(listener);
  const off2 = inventory.subscribe(listener);
  const virtualOff1 = virtual.subscribe(virtualListener);
  const virtualOff2 = virtual.subscribe(virtualListener);
  assert.equal(source.size, 1);

  source.emit({ playerId: "p1", slot: 0, previous: undefined, current: stack("minecraft:apple") });
  virtual.setItem(0, stack("minecraft:apple"));
  assert.equal(calls.length, 1);
  assert.equal(virtualCalls.length, 1);

  const logs = withSilencedConsoleError(() => {
    off1();
    off2();
    virtualOff1();
    virtualOff2();
  });
  assert.equal(source.size, 0);
  assert.equal(logs.length, 0, "unsubscribe is idempotent and never throws");
});

test("PlayerInventory dispatches like VirtualInventory when a listener unsubscribes another", () => {
  const source = new FakeChangeSource();
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });
  const virtual = new VirtualInventory(1);
  const change = {
    playerId: "p1",
    slot: 0,
    previous: undefined,
    current: stack("minecraft:apple"),
  };

  function dispatchOrder(target, trigger) {
    const order = [];
    let offB;
    target.subscribe(() => {
      order.push("a");
      offB();
    });
    offB = target.subscribe(() => order.push("b"));
    trigger();
    trigger();
    return order;
  }

  assert.deepEqual(
    dispatchOrder(inventory, () => source.emit(change)),
    ["a", "b", "a"],
    "the in-flight event still reaches a listener removed mid-dispatch",
  );
  assert.deepEqual(
    dispatchOrder(virtual, () => virtual.setItem(0, stack("minecraft:apple"))),
    ["a", "b", "a"],
  );
});

test("PlayerInventory isolates listener exceptions like VirtualInventory", () => {
  const source = new FakeChangeSource();
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });
  const received = [];

  inventory.subscribe(() => {
    throw new Error("boom");
  });
  inventory.subscribe((event) => received.push(event.slot));

  const logs = withSilencedConsoleError(() => {
    source.emit({ playerId: "p1", slot: 0, previous: undefined, current: stack("minecraft:apple") });
  });
  assert.deepEqual(received, [0], "a throwing listener does not stop the others");
  assert.equal(logs.length, 1);
});

test("PlayerInventory unsubscribe does not throw when the source teardown throws", () => {
  let subscribes = 0;
  const source = {
    subscribe() {
      subscribes += 1;
      return () => {
        throw new Error("teardown failed");
      };
    },
  };
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });
  const off = inventory.subscribe(() => {});

  const logs = withSilencedConsoleError(() => {
    assert.doesNotThrow(() => off());
  });
  assert.equal(logs.length, 1);

  // Teardown failure must not leave a half-attached state: a new listener
  // subscribes to the source again.
  const offAgain = inventory.subscribe(() => {});
  assert.equal(subscribes, 2);
  withSilencedConsoleError(() => offAgain());
});

test("PlayerInventory attaches the source once when a listener re-subscribes during the synchronous handshake", () => {
  const initial = {
    playerId: "p1",
    slot: 0,
    previous: undefined,
    current: stack("minecraft:apple"),
  };
  const source = new SyncChangeSource(initial);
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });
  const received = [];
  const off = inventory.subscribe(function listener(change) {
    received.push(change);
    // Idempotent re-registration of the same listener while the source is
    // still handing back its unsubscribe function.
    inventory.subscribe(listener);
  });

  assert.equal(source.subscribes, 1, "the source must not be subscribed twice");
  assert.equal(source.size, 1);
  source.emit({ ...initial, slot: 0 });
  assert.equal(received.length, 2, "each source change is delivered exactly once");
  off();
  assert.equal(source.size, 0);
});

test("PlayerInventory releases a source handed back after the last listener already left", () => {
  const initial = {
    playerId: "p1",
    slot: 0,
    previous: undefined,
    current: stack("minecraft:apple"),
  };
  const source = new SyncChangeSource(initial);
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });

  let off;
  const listener = () => {
    // A stale handle for this same listener removes it during the handshake.
    off?.();
  };
  off = inventory.subscribe(listener);
  assert.equal(source.size, 1);
  off();
  assert.equal(source.size, 0);

  off = inventory.subscribe(listener);
  assert.equal(source.subscribes, 2);
  assert.equal(source.size, 0, "no listener means no live source subscription");
});
