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
const {
  createPlayerInventoryChangeSource,
  PlayerInventory,
  PlayerInventoryReadOnlyError,
} = await import("../src/player-inventory.ts");

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

test("PlayerInventory.getItem rejects a container stack whose clone is empty or aliased", () => {
  const aliased = {
    typeId: "minecraft:apple",
    clone() {
      return this;
    },
  };
  const emptied = {
    typeId: "minecraft:stone",
    clone() {
      return undefined;
    },
  };
  const inventory = new PlayerInventory(fakePlayer("p1", [aliased, emptied]));

  // A slot that is occupied must never read as empty, and the live container
  // stack must never escape to the caller.
  assert.throws(() => inventory.getItem(0), /independent copy, not the original stack/);
  assert.throws(() => inventory.getItem(1), /did not return a valid ItemStack/);
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

test("PlayerInventory drops an unsafe raw stack instead of handing it to listeners", () => {
  const source = new FakeChangeSource();
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: source,
  });
  const received = [];
  inventory.subscribe((change) => received.push(change));

  const aliased = {
    typeId: "minecraft:apple",
    clone() {
      return this;
    },
  };
  const logs = withSilencedConsoleError(() => {
    source.emit({ playerId: "p1", slot: 0, previous: undefined, current: aliased });
  });
  assert.equal(received.length, 0, "a live container stack must not reach a listener");
  assert.equal(logs.length, 1);

  // One unsafe change must not break the source subscription for later changes.
  const valid = stack("minecraft:bread");
  source.emit({ playerId: "p1", slot: 0, previous: undefined, current: valid });
  assert.equal(received.length, 1);
  assert.notEqual(received[0].current, valid);
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

/** Mirrors the beta signal: subscribe returns the callback, not a teardown. */
class FakeItemChangeSignal {
  #listeners = new Set();
  unsubscribes = 0;

  subscribe(listener) {
    this.#listeners.add(listener);
    return listener;
  }

  unsubscribe(listener) {
    this.unsubscribes += 1;
    this.#listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.#listeners]) listener(event);
  }

  get size() {
    return this.#listeners.size;
  }
}

function changeEvent(playerId, inventoryType, slot, before, after) {
  return {
    player: { id: playerId },
    inventoryType,
    slot,
    beforeItemStack: before,
    itemStack: after,
  };
}

test("createPlayerInventoryChangeSource validates its arguments", () => {
  const signal = new FakeItemChangeSignal();
  assert.throws(() => createPlayerInventoryChangeSource(undefined, () => 0), TypeError);
  assert.throws(() => createPlayerInventoryChangeSource({}, () => 0), TypeError);
  assert.throws(() => createPlayerInventoryChangeSource(signal, undefined), TypeError);
  assert.throws(() => createPlayerInventoryChangeSource(signal, () => 0).subscribe(1), TypeError);
});

test("createPlayerInventoryChangeSource maps slots and clones event stacks", () => {
  const signal = new FakeItemChangeSignal();
  const source = createPlayerInventoryChangeSource(
    signal,
    (inventoryType, slot) => (inventoryType === "Hotbar" ? slot : slot + 9),
  );
  const received = [];
  const unsubscribe = source.subscribe((change) => received.push(change));

  const before = stack("minecraft:apple");
  const after = stack("minecraft:bread");
  signal.emit(changeEvent("p1", "Hotbar", 2, before, after));
  signal.emit(changeEvent("p1", "Inventory", 4, undefined, after));

  assert.equal(received.length, 2);
  assert.equal(received[0].playerId, "p1");
  assert.equal(received[0].slot, 2);
  assert.equal(received[0].previous.typeId, "minecraft:apple");
  assert.equal(received[0].current.typeId, "minecraft:bread");
  assert.notEqual(received[0].current, after, "event stacks must be cloned");
  after.amount = 9;
  assert.equal(received[0].current.amount, 1);
  assert.equal(received[1].slot, 13);
  assert.equal(received[1].previous, undefined);

  unsubscribe();
  assert.equal(signal.size, 0);
});

test("createPlayerInventoryChangeSource drops event stacks that cannot be cloned safely", () => {
  const signal = new FakeItemChangeSignal();
  const source = createPlayerInventoryChangeSource(signal, (_type, slot) => slot);
  const received = [];
  source.subscribe((change) => received.push(change));

  const aliased = {
    typeId: "minecraft:apple",
    clone() {
      return this;
    },
  };
  const emptied = {
    typeId: "minecraft:stone",
    clone() {
      return undefined;
    },
  };
  assert.doesNotThrow(() => {
    signal.emit(changeEvent("p1", "Hotbar", 0, undefined, aliased));
    signal.emit(changeEvent("p1", "Hotbar", 0, emptied, undefined));
    signal.emit(changeEvent("p1", "Hotbar", 0, aliased, stack("minecraft:bread")));
  });
  assert.equal(received.length, 0, "an unsafe event stack must not reach a listener");
});

test("createPlayerInventoryChangeSource unsubscribes via the signal, not its return value", () => {
  const signal = new FakeItemChangeSignal();
  const source = createPlayerInventoryChangeSource(signal, (_type, slot) => slot);
  const received = [];
  const unsubscribe = source.subscribe((change) => received.push(change));

  signal.emit(changeEvent("p1", "Hotbar", 0, undefined, stack("minecraft:stone")));
  assert.equal(received.length, 1);

  unsubscribe();
  assert.equal(signal.size, 0);

  // The old bug called subscribe()'s return value as a fake event: the
  // listener stayed subscribed and received a second notification.
  signal.emit(changeEvent("p1", "Hotbar", 0, undefined, stack("minecraft:stone")));
  assert.equal(received.length, 1, "unsubscribed callbacks must not run");
});

test("createPlayerInventoryChangeSource unsubscribe is idempotent", () => {
  const signal = new FakeItemChangeSignal();
  const source = createPlayerInventoryChangeSource(signal, (_type, slot) => slot);
  const unsubscribe = source.subscribe(() => {});

  unsubscribe();
  unsubscribe();
  assert.equal(signal.size, 0);
  assert.equal(signal.unsubscribes, 1, "the signal is asked to unsubscribe once");
});

test("createPlayerInventoryChangeSource rejects a signal without unsubscribe", () => {
  const source = createPlayerInventoryChangeSource({ subscribe: () => undefined }, () => 0);
  assert.throws(() => source.subscribe(() => {}), TypeError);
});

test("createPlayerInventoryChangeSource drops unreadable players and bad mapper results", () => {
  const signal = new FakeItemChangeSignal();
  const source = createPlayerInventoryChangeSource(signal, (_type, slot) => {
    if (slot === 1) return -1;
    if (slot === 2) return 1.5;
    if (slot === 3) return undefined;
    if (slot === 4) throw new Error("bad mapping");
    return slot;
  });
  const received = [];
  source.subscribe((change) => received.push(change));

  const logs = withSilencedConsoleError(() => {
    signal.emit(changeEvent("p1", "Hotbar", 0, undefined, stack("minecraft:stone")));
    signal.emit(changeEvent("", "Hotbar", 0, undefined, stack("minecraft:stone")));
    signal.emit(changeEvent("p1", "Hotbar", 1, undefined, stack("minecraft:stone")));
    signal.emit(changeEvent("p1", "Hotbar", 2, undefined, stack("minecraft:stone")));
    signal.emit(changeEvent("p1", "Hotbar", 3, undefined, stack("minecraft:stone")));
    signal.emit(changeEvent("p1", "Hotbar", 4, undefined, stack("minecraft:stone")));
    const unreadable = {
      ...changeEvent("p1", "Hotbar", 0, undefined, stack("minecraft:stone")),
      get player() {
        throw new Error("entity is gone");
      },
    };
    signal.emit(unreadable);
  });

  assert.deepEqual(received.map((change) => change.slot), [0]);
  assert.equal(logs.length, 1);
});

test("createPlayerInventoryChangeSource forwards through PlayerInventory without writing", () => {
  const items = new Array(27).fill(undefined);
  const player = fakePlayer("p1", items);
  const signal = new FakeItemChangeSignal();
  const inventory = new PlayerInventory(player, {
    changes: createPlayerInventoryChangeSource(
      signal,
      (inventoryType, slot) => (inventoryType === "Hotbar" ? slot : slot + 9),
    ),
  });
  const received = [];
  const off = inventory.subscribe((change) => received.push(change));

  const before = stack("minecraft:apple");
  const after = stack("minecraft:diamond");
  signal.emit(changeEvent("p1", "Inventory", 3, before, after));
  signal.emit(changeEvent("p2", "Inventory", 3, before, after));

  assert.equal(received.length, 1);
  assert.equal(received[0].inventory, inventory);
  assert.equal(received[0].slot, 12);
  assert.equal(received[0].previous.typeId, "minecraft:apple");
  assert.equal(received[0].current.typeId, "minecraft:diamond");
  assert.equal(items[12], undefined, "the adapter must not write the container");

  off();
  assert.equal(signal.size, 0, "the last listener detaches the signal");
  signal.emit(changeEvent("p1", "Inventory", 3, before, after));
  assert.equal(received.length, 1);
});

test("PlayerInventory keeps displaying when the event signal is malformed", () => {
  let subscribes = 0;
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: createPlayerInventoryChangeSource(
      {
        subscribe: () => {
          subscribes += 1;
          return undefined;
        },
      },
      () => 0,
    ),
  });
  const logs = withSilencedConsoleError(() => {
    const off = inventory.subscribe(() => {});
    off();
  });
  assert.equal(logs.length, 1);
  assert.equal(subscribes, 0, "a signal without unsubscribe must not be subscribed");
});

test("PlayerInventory keeps displaying when subscribing to the signal throws", () => {
  const signal = new FakeItemChangeSignal();
  signal.subscribe = () => {
    throw new Error("restricted execution");
  };
  const inventory = new PlayerInventory(fakePlayer("p1", [undefined]), {
    changes: createPlayerInventoryChangeSource(signal, () => 0),
  });
  const logs = withSilencedConsoleError(() => {
    const off = inventory.subscribe(() => {});
    off();
  });
  assert.equal(logs.length, 1);
  assert.equal(inventory.getItem(0), undefined);
});
