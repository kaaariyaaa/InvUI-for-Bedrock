import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Failing cases for Window's state-change diff rendering.
 *
 * Each test encodes expected behaviour, so a failure points at the specific
 * gap in src/window.ts:
 *   1. state-dependent Item providers behind an unchanged element are skipped
 *   2. an in-flight async provider from before a state change wins over the
 *      state change (the slot was skipped, so its render token was not bumped)
 *   3. notifications delivered while the element subscription is being moved
 *      to the new layout are applied to the old slot and lost for the new one
 */
const mockSource = `
export class ItemStack {
  constructor(typeId, amount = 1) {
    this.typeId = typeId;
    this.amount = amount;
    this.nameTag = "";
    this.lore = [];
  }
  clone() {
    const copy = new ItemStack(this.typeId, this.amount);
    copy.nameTag = this.nameTag;
    copy.lore = [...this.lore];
    return copy;
  }
  setLore(lines) {
    this.lore = [...lines];
  }
}

export const system = {
  runInterval() {
    return 0;
  },
  clearRun() {},
};

export const world = {
  virtualContainerManager: {
    create(options) {
      return { size: options.size, setItem() {}, getItem() {} };
    },
  },
};
`;

const mockUrl = `data:text/javascript;base64,${Buffer.from(mockSource).toString("base64")}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
      return { url: mockUrl, shortCircuit: true };
    }
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

async function load(base) {
  try {
    return await import(new URL(`${base}.js`, import.meta.url).href);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    return import(new URL(`${base}.ts`, import.meta.url).href);
  }
}

const { Gui, Markers } = await load("../src/gui");
const { Item } = await load("../src/item");
const { StateManager } = await load("../src/state");
const { Window } = await load("../src/window");

class InMemoryTestAdapter {
  canOpenScreens = true;
  containers = [];

  createContainer(options) {
    const container = {
      size: options.size,
      title: options.title ?? "",
      items: new Array(options.size).fill(undefined),
      setItem(slot, item) {
        this.items[slot] = item;
      },
      getItem(slot) {
        return this.items[slot];
      },
    };
    this.containers.push(container);
    return container;
  }

  openContainer() {}

  closeContainer() {}
}

const player = { id: "p1", name: "Steve" };

function stack(typeId) {
  return { typeId, amount: 1, clone: () => stack(typeId) };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildWindow(gui, adapter) {
  return Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("probe: notify + state change in one timing renders via one provider call", async () => {
  const adapter = new InMemoryTestAdapter();
  let calls = 0;
  let label = "a";
  const icon = Item.simple(() => {
    calls += 1;
    return stack(`minecraft:${label}`);
  });
  const window = buildWindow(
    Gui.paged({
      structure: ["a."],
      ingredients: { a: icon, ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
      content: [Item.simple(() => stack("minecraft:page_1"))],
    }),
    adapter,
  );
  await window.open();
  const container = adapter.containers[0];
  calls = 0;
  label = "b";
  icon.notifyWindows();
  window.setState({ page: 1 });
  await tick();
  await tick();
  assert.equal(calls, 1, "one provider call for the batch");
  assert.equal(container.items[0].typeId, "minecraft:b");
  window.close();
});

test("probe: notify + setUpperGui in one timing applies only the new GUI", async () => {
  const adapter = new InMemoryTestAdapter();
  let oldCalls = 0;
  let newCalls = 0;
  const oldItem = Item.simple(() => {
    oldCalls += 1;
    return stack("minecraft:old");
  });
  const newItem = Item.simple(() => {
    newCalls += 1;
    return stack("minecraft:new");
  });
  const oldGui = Gui.normal({ structure: ["a"], ingredients: { a: oldItem } });
  const newGui = Gui.normal({ structure: ["a"], ingredients: { a: newItem } });
  const window = buildWindow(oldGui, adapter);
  await window.open();
  const container = adapter.containers[0];
  oldCalls = 0;
  newCalls = 0;
  oldItem.notifyWindows();
  window.setUpperGui(newGui);
  await tick();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:new");
  assert.equal(oldCalls, 0, "old element must not be rendered after the swap");
  assert.equal(newCalls, 1, "the full refresh renders every new slot once");
  window.close();
});

test("probe: notify + close + reopen in one timing writes only the new container", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const pending = deferred();
  let mode = "sync";
  const item = Item.simple(() =>
    mode === "async" ? pending.promise : stack("minecraft:reopened"),
  );
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: item } }),
    adapter,
  );
  window.setErrorHandler((error, context) => errors.push(context));
  await window.open();
  const first = adapter.containers[0];
  mode = "async";
  item.notifyWindows();
  window.close();
  mode = "sync";
  await window.open();
  const second = adapter.containers[1];
  await tick();
  pending.resolve(stack("minecraft:stale"));
  await tick();
  await tick();
  assert.equal(first.items[0].typeId, "minecraft:reopened");
  assert.equal(second.items[0].typeId, "minecraft:reopened");
  assert.deepEqual(errors, []);
  window.close();
});

test("probe: notify while opening leaves the newer value on the opened container", async () => {
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  let mode = "initial";
  let label = "before";
  const item = Item.simple(() => {
    if (mode === "gate") {
      mode = "sync";
      return gate.promise;
    }
    return stack(`minecraft:${label}`);
  });
  const other = Item.simple(() => stack("minecraft:other"));
  const gui = Gui.normal({ structure: ["ab"], ingredients: { a: item, b: other } });
  const window = buildWindow(gui, adapter);
  mode = "gate";
  const opening = window.open();
  await tick();
  assert.equal(window.status, "opening");
  label = "after";
  item.notifyWindows();
  await tick();
  gate.resolve(stack("minecraft:fromGate"));
  await opening;
  await tick();
  assert.equal(window.status, "open");
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("probe: notify + refresh() in one timing renders once", async () => {
  const adapter = new InMemoryTestAdapter();
  let calls = 0;
  const item = Item.simple(() => {
    calls += 1;
    return stack(`minecraft:${calls}`);
  });
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: item } }),
    adapter,
  );
  await window.open();
  const container = adapter.containers[0];
  calls = 0;
  item.notifyWindows();
  await window.refresh();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:1");
  assert.equal(calls, 1, "the explicit refresh covers the queued notification");
  window.close();
});

test("probe: placeholder + notify + state change in one timing", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let label = "before";
  const item = Item.builder()
    .setPlaceholder(stack("minecraft:loading"))
    .setItemProvider(() => {
      const captured = label;
      return new Promise((resolve) => pending.push(() => resolve(stack(`minecraft:${captured}`))));
    })
    .build();
  const window = buildWindow(
    Gui.paged({
      structure: ["a."],
      ingredients: { a: item, ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
      content: [Item.simple(() => stack("minecraft:page_1"))],
    }),
    adapter,
  );
  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:loading");
  assert.equal(pending.length, 1);

  label = "after";
  item.notifyWindows();
  window.setState({ page: 1 });
  pending[0]();
  await tick();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:loading", "the placeholder stays while pending");
  assert.equal(pending.length, 2, "the coalesced refresh starts a fresh provider call");
  pending[1]();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("probe: two notifications in one timing with a placeholder render once", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let label = "first";
  const item = Item.builder()
    .setPlaceholder(stack("minecraft:loading"))
    .setItemProvider(() => {
      const captured = label;
      return new Promise((resolve) => pending.push(() => resolve(stack(`minecraft:${captured}`))));
    })
    .build();
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: item } }),
    adapter,
  );
  await window.open();
  await tick();
  const container = adapter.containers[0];
  assert.equal(pending.length, 1);
  label = "second";
  item.notifyWindows();
  label = "third";
  item.notifyWindows();
  await tick();
  assert.equal(pending.length, 2, "one batched provider call");
  pending[0]();
  pending[1]();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:third");
  window.close();
});

test("probe: notify while closing is ignored", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const writes = [];
  const item = Item.simple(() => stack("minecraft:value"));
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: item } }),
    adapter,
  );
  window.setErrorHandler((error, context) => errors.push(context));
  await window.open();
  const container = adapter.containers[0];
  container.setItem = (slot, value) => {
    writes.push(value?.typeId);
    adapter.containers[0].items[slot] = value;
  };
  item.notifyWindows();
  window.close();
  await tick();
  assert.deepEqual(errors, []);
  assert.ok(writes.length <= 1);
  window.close();
});

test("probe: a result resolved before the batched render still loses to the notification", async () => {
  const adapter = new InMemoryTestAdapter();
  let phase = "initial";
  const pending = [];
  const item = Item.simple(() =>
    phase === "initial"
      ? stack("minecraft:initial")
      : new Promise((resolve) => pending.push(resolve)),
  );
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: item } }),
    adapter,
  );
  await window.open();
  const container = adapter.containers[0];

  phase = "async";
  item.notifyWindows();
  await tick();
  assert.equal(pending.length, 1);

  // Second notification, then the first provider resolves before the flush
  // microtask runs: the token must already be invalid at notification time.
  item.notifyWindows();
  pending[0](stack("minecraft:stale"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:initial");
  assert.equal(pending.length, 2);
  pending[1](stack("minecraft:fresh"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:fresh");
  window.close();
});

test("probe: a placeholder result resolved before the batched render keeps the placeholder", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let label = "first";
  const item = Item.builder()
    .setPlaceholder(stack("minecraft:loading"))
    .setItemProvider(() => {
      const captured = label;
      return new Promise((resolve) => pending.push(() => resolve(stack(`minecraft:${captured}`))));
    })
    .build();
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: item } }),
    adapter,
  );
  await window.open();
  await tick();
  const container = adapter.containers[0];
  assert.equal(pending.length, 1);

  label = "second";
  item.notifyWindows();
  pending[0]();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:loading", "stale result must not land");
  assert.equal(pending.length, 2);
  pending[1]();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:second");
  window.close();
});
