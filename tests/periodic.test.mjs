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
    this.runs.set(runId, { callback, ticks });
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

const { Gui } = await load("../src/gui");
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

function fireTick() {
  for (const run of [...system.runs.values()]) {
    run.callback();
  }
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

  fireTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(provided > rendered, "a tick re-evaluates the displayed Item");

  window.close("PlayerClosed");
  assert.equal(window.isOpen, false);
  assert.equal(system.runs.size, 0, "close stops the periodic update");

  const afterClose = provided;
  fireTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(provided, afterClose, "no work after close");
});
