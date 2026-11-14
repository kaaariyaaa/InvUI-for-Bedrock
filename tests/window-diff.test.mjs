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
const { Item, ItemBuilder } = await load("../src/item");
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
  return { typeId, amount: 1 };
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

test("a state update re-evaluates an Item provider whose result depends on the new state", async () => {
  const adapter = new InMemoryTestAdapter();
  let label = "before";
  const icon = Item.simple(() => stack(`minecraft:${label}`));
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: icon } });
  const window = buildWindow(gui, adapter);

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:before");

  // The same Item instance keeps its slot; only the closure's result changes.
  label = "after";
  window.setState({ selection: "after" });
  await tick();
  await tick();

  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("a state update discards an in-flight async provider result for an unchanged slot", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let mode = "sync";
  let iconLabel = "initial";
  const icon = Item.simple(() => {
    if (mode === "pending") {
      const captured = iconLabel;
      return new Promise((resolve) => pending.push(() => resolve(stack(`minecraft:${captured}`))));
    }
    return stack(`minecraft:${iconLabel}`);
  });
  const gui = Gui.paged({
    structure: ["i."],
    ingredients: {
      i: icon,
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content: [
      Item.simple(() => stack("minecraft:page_1")),
      Item.simple(() => stack("minecraft:page_2")),
    ],
  });
  const window = buildWindow(gui, adapter);

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:initial");
  assert.equal(container.items[1].typeId, "minecraft:page_1");

  // Start an async provider call that reads the pre-change state. The slot
  // notification is batched, so the provider starts on the next timing.
  iconLabel = "before";
  mode = "pending";
  icon.notifyWindows();
  await tick();
  assert.equal(pending.length, 1);

  // Change state so the icon's result should become "after"; the content slot
  // changes, so the diff refresh runs, but the unchanged icon slot is skipped.
  iconLabel = "after";
  mode = "sync";
  window.setState({ page: 1 });
  await tick();
  assert.equal(container.items[1].typeId, "minecraft:page_2");

  // The pre-change async result must not land after the refresh.
  pending[0]();
  await tick();
  await tick();

  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("an Item notification during a state refresh is delivered to its new slot", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let hold = false;
  let label = "before";
  const moving = Item.simple(() => {
    if (hold) {
      const captured = label;
      return new Promise((resolve) => pending.push(() => resolve(stack(`minecraft:${captured}`))));
    }
    return stack(`minecraft:${label}`);
  });
  const filler = Item.simple(() => stack("minecraft:filler"));

  // The same Item sits at slot 0 on tab 0 and at slot 1 on tab 1.
  const tab0 = Gui.normal({ structure: ["ab"], ingredients: { a: moving, b: filler } });
  const tab1 = Gui.normal({ structure: ["ba"], ingredients: { a: moving, b: filler } });
  const gui = Gui.tab({ tabs: [tab0, tab1] });
  const window = buildWindow(gui, adapter);

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:before");

  // Tab switch moves the Item from slot 0 to slot 1. Its new render is async.
  hold = true;
  window.setState({ tab: 1 });
  await tick();

  // The old subscription still points at slot 0, which now holds the filler.
  label = "after";
  hold = false;
  moving.notifyWindows();

  pending[0]();
  await tick();
  await tick();

  assert.equal(
    container.items[1].typeId,
    "minecraft:after",
    "notification lost when the subscription moved to the new slot",
  );
  window.close();
});

test("multiple Item notifications in one timing render the slot once", async () => {
  const adapter = new InMemoryTestAdapter();
  let label = "first";
  let calls = 0;
  const icon = Item.simple(() => {
    calls += 1;
    return stack(`minecraft:${label}`);
  });
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: icon } }),
    adapter,
  );

  await window.open();
  const container = adapter.containers[0];

  // Three notifications in the same timing: the last value is rendered once
  // (design 11.2 step 3), not once per notification.
  calls = 0;
  icon.notifyWindows();
  label = "second";
  icon.notifyWindows();
  label = "third";
  icon.notifyWindows();
  assert.equal(calls, 0, "the notifications are batched");
  await tick();
  assert.equal(calls, 1);
  assert.equal(container.items[0].typeId, "minecraft:third");
  window.close();
});

test("a notification batched with a setUpperGui swap renders only the new GUI", async () => {
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
  const window = buildWindow(
    Gui.normal({ structure: ["a"], ingredients: { a: oldItem } }),
    adapter,
  );

  await window.open();
  const container = adapter.containers[0];
  oldCalls = 0;
  newCalls = 0;

  // Both happen before the batched refresh runs: the swap replaces the pending
  // notification, so the old element must not render and the new one renders once.
  oldItem.notifyWindows();
  window.setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: newItem } }));
  await tick();
  await tick();

  assert.equal(container.items[0].typeId, "minecraft:new");
  assert.equal(oldCalls, 0, "the old element must not render after the swap");
  assert.equal(newCalls, 1, "the full refresh renders the new slot once");
  window.close();
});

test("a page change skips a fixed ItemBuilder decoration and re-evaluates an opaque provider", async () => {
  const adapter = new InMemoryTestAdapter();
  const decoration = Item.simple(new ItemBuilder("minecraft:frame"));
  let opaqueCalls = 0;
  const opaque = Item.simple(() => {
    opaqueCalls += 1;
    return stack("minecraft:opaque");
  });
  const gui = Gui.paged({
    structure: ["fi."],
    ingredients: {
      f: decoration,
      i: opaque,
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content: [
      Item.simple(() => stack("minecraft:page_1")),
      Item.simple(() => stack("minecraft:page_2")),
    ],
  });
  const window = buildWindow(gui, adapter);

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:frame");

  const writes = [];
  const setItem = container.setItem.bind(container);
  container.setItem = (slot, item) => {
    writes.push(slot);
    setItem(slot, item);
  };
  opaqueCalls = 0;

  window.setState({ page: 1 });
  await tick();
  await tick();

  // The content slot changed and the opaque provider may read the new state, so
  // both are re-evaluated. The fixed ItemBuilder cannot observe state, so its
  // slot keeps the displayed stack without a provider call or a write.
  assert.deepEqual([...writes].sort(), [1, 2]);
  assert.equal(opaqueCalls, 1);
  assert.equal(container.items[0].typeId, "minecraft:frame");
  assert.equal(container.items[2].typeId, "minecraft:page_2");
  window.close();
});

test("a page change re-evaluates an unchanged provider that reads the new state", async () => {
  const adapter = new InMemoryTestAdapter();
  const decoration = Item.simple(new ItemBuilder("minecraft:frame"));
  let window;
  const pageLabel = Item.simple(() =>
    stack(`minecraft:page_${window.getState().page ?? 0}`),
  );
  const gui = Gui.paged({
    structure: ["fi."],
    ingredients: {
      f: decoration,
      i: pageLabel,
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content: [
      Item.simple(() => stack("minecraft:content_1")),
      Item.simple(() => stack("minecraft:content_2")),
    ],
  });
  window = buildWindow(gui, adapter);

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[1].typeId, "minecraft:page_0");

  const writes = [];
  const setItem = container.setItem.bind(container);
  container.setItem = (slot, item) => {
    writes.push(slot);
    setItem(slot, item);
  };

  window.setState({ page: 1 });
  await tick();
  await tick();

  // Same element reference at slot 1, but the provider reads Window state, so
  // treating it as unchanged would leave the stale page_0 on screen. The fixed
  // decoration at slot 0 is still skipped.
  assert.equal(container.items[1].typeId, "minecraft:page_1");
  assert.deepEqual(writes, [1, 2]);
  window.close();
});

test("an ItemBuilder whose provide was replaced is not treated as fixed", async () => {
  const adapter = new InMemoryTestAdapter();
  const builder = new ItemBuilder("minecraft:frame");
  const decoration = Item.simple(builder);
  let window;
  const gui = Gui.paged({
    structure: ["fi."],
    ingredients: {
      f: decoration,
      i: Item.simple(() => stack("minecraft:icon")),
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content: [
      Item.simple(() => stack("minecraft:content_1")),
      Item.simple(() => stack("minecraft:content_2")),
    ],
  });
  window = buildWindow(gui, adapter);

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:frame");

  // The replacement can read state, so the slot is no longer provably fixed.
  builder.provide = () => stack(`minecraft:page_${window.getState().page ?? 0}`);
  window.setState({ page: 1 });
  await tick();
  await tick();

  assert.equal(container.items[0].typeId, "minecraft:page_1");
  window.close();
});

test("a tab switch skips a fixed decoration shared by both tabs", async () => {
  const adapter = new InMemoryTestAdapter();
  const decoration = Item.simple(new ItemBuilder("minecraft:frame"));
  const filler = Item.simple(() => stack("minecraft:filler"));
  const tab0 = Gui.normal({
    structure: ["#a"],
    ingredients: { "#": decoration, a: filler },
  });
  const tab1 = Gui.normal({
    structure: ["#b"],
    ingredients: { "#": decoration, b: filler },
  });
  const window = buildWindow(Gui.tab({ tabs: [tab0, tab1] }), adapter);

  await window.open();
  const container = adapter.containers[0];

  const writes = [];
  const setItem = container.setItem.bind(container);
  container.setItem = (slot, item) => {
    writes.push(slot);
    setItem(slot, item);
  };

  window.setState({ tab: 1 });
  await tick();
  await tick();

  // The two tabs have the same width, so the shared slot maps to the same
  // physical slot and its fixed element needs no re-render.
  assert.deepEqual(writes, [1]);
  assert.equal(container.items[0].typeId, "minecraft:frame");
  assert.equal(container.items[1].typeId, "minecraft:filler");
  window.close();
});
