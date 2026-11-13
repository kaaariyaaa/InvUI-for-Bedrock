import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Fake tick clock: the real scheduler calls system.runInterval/clearRun.
const mockSource = `
export class ItemStack {
  constructor(typeId, amount = 1) {
    this.typeId = typeId;
    this.amount = amount;
    this.nameTag = "";
    this.lore = [];
  }
  clone() {
    return new ItemStack(this.typeId, this.amount);
  }
  setLore(lines) {
    this.lore = [...lines];
  }
}

export const world = {};

export const system = {
  runs: new Map(),
  nextRunId: 1,
  runInterval(callback, ticks = 1) {
    const runId = this.nextRunId++;
    // elapsed models timer time: a new registration starts a fresh period, so
    // a timer that is cancelled and recreated never reaches its interval.
    this.runs.set(runId, { callback, ticks, elapsed: 0 });
    return runId;
  },
  clearRun(runId) {
    this.runs.delete(runId);
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
const { Window } = await load("../src/window");
const { system, ItemStack } = await import(mockUrl);

class TestAdapter {
  canOpenScreens = true;
  containers = [];

  createContainer(options) {
    const container = {
      size: options.size,
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

/** Advance the fake game clock, firing each interval once its period elapsed. */
function advanceTicks(ticks) {
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const run of [...system.runs.values()]) {
      run.elapsed += 1;
      if (run.elapsed >= run.ticks) {
        run.elapsed = 0;
        run.callback();
      }
    }
  }
}

/** One game tick, as fired by the scheduler once the period elapsed. */
function fireTick() {
  advanceTicks(1);
}

/** Let the Window's async refresh finish before the clock moves on. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test.afterEach(() => {
  system.runs.clear();
});

test("Window starts periodic updates only while open and stops them on close", async () => {
  let provided = 0;
  const item = Item.builder()
    .setItemProvider(() => {
      provided += 1;
      return new ItemStack("minecraft:clock");
    })
    .updatePeriodically(20)
    .build();
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const adapter = new TestAdapter();
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  assert.equal(system.runs.size, 0, "period does not tick before the Window opens");

  await window.open();
  assert.equal(system.runs.size, 1);
  assert.equal([...system.runs.values()][0].ticks, 20);
  const rendered = provided;

  advanceTicks(19);
  assert.equal(provided, rendered, "a tick alone does not fire a 20-tick period");
  advanceTicks(1);
  await flush();
  assert.ok(provided > rendered, "the period re-evaluates the displayed Item");

  window.close("PlayerClosed");
  assert.equal(window.isOpen, false);
  assert.equal(system.runs.size, 0, "close stops the periodic update");

  const afterClose = provided;
  fireTick();
  await flush();
  assert.equal(provided, afterClose, "no work after close");
});

test("state updates keep the same slot subscription and periodic phase", async () => {
  let provided = 0;
  const item = Item.builder()
    .setItemProvider(() => {
      provided += 1;
      return new ItemStack("minecraft:clock");
    })
    .updatePeriodically(20)
    .build();

  const subscribe = item.subscribe.bind(item);
  const subscriptions = { added: 0, removed: 0 };
  item.subscribe = (listener) => {
    subscriptions.added += 1;
    const unsubscribe = subscribe(listener);
    return () => {
      subscriptions.removed += 1;
      unsubscribe();
    };
  };

  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(new TestAdapter())
    .build();

  await window.open();
  assert.equal(subscriptions.added, 1, "opening subscribes the slot element once");
  assert.equal(subscriptions.removed, 0);
  const runId = [...system.runs.keys()][0];
  const rendered = provided;

  // Most of the period passes, then the GUI refreshes faster than it: each
  // state write re-resolves the layout with the same slot element.
  advanceTicks(19);
  assert.equal(provided, rendered, "the period has not elapsed yet");
  for (let update = 0; update < 10; update += 1) {
    window.setState({ data: { update } });
    await flush();
    advanceTicks(5);
  }

  assert.equal(subscriptions.added, 1, "the unchanged slot is not resubscribed");
  assert.equal(subscriptions.removed, 0, "the unchanged slot is not unsubscribed");
  assert.ok(system.runs.has(runId), "the original interval keeps running");
  assert.equal(system.runs.size, 1);
  assert.ok(provided > rendered, "frequent state updates must not starve the period");

  window.close("PlayerClosed");
  assert.equal(subscriptions.removed, 1, "close unsubscribes the slot element");
  assert.equal(system.runs.size, 0, "close stops the periodic update");
});

test("a layout change moves element subscriptions to the new slot elements", async () => {
  // Own viewer so the shared default StateManager does not see this GUI's
  // schema under the state identity the other tests already used.
  const pagedPlayer = { id: "p2", name: "Alex" };
  const pageItems = ["minecraft:page_1", "minecraft:page_2"].map((typeId) =>
    Item.builder()
      .setItemProvider(() => new ItemStack(typeId))
      .updatePeriodically(20)
      .build(),
  );
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: pageItems,
  });
  const window = Window.builder()
    .setViewer(pagedPlayer)
    .setUpperGui(gui)
    .setContainerAdapter(new TestAdapter())
    .build();

  await window.open();
  assert.equal(system.runs.size, 1, "only the visible page item ticks");
  const firstRunId = [...system.runs.keys()][0];

  window.setState({ page: 1 });
  await flush();
  assert.equal(system.runs.size, 1, "the new page item is subscribed");
  assert.ok(!system.runs.has(firstRunId), "the item leaving the layout is unsubscribed");

  window.close("PlayerClosed");
  assert.equal(system.runs.size, 0);
});
