import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Minimal @minecraft/server stand-in. `createdContainers` lets the tests prove
// that the real adapter never creates a container for a rejected open.
const mockSource = `
export const createdContainers = [];

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

export const world = {
  virtualContainerManager: {
    create(options) {
      const container = {
        size: options.size,
        title: options.title ?? "",
        items: new Array(options.size).fill(undefined),
        opened: false,
        closed: false,
        setItem(slot, item) {
          this.items[slot] = item;
        },
        getItem(slot) {
          return this.items[slot];
        },
        open() {
          this.opened = true;
        },
        close() {
          this.closed = true;
        },
      };
      createdContainers.push(container);
      return container;
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
    // Let tests run from src/ before `npm run build`: map the ESM-style
    // "./state.js" imports used by window.ts onto the TypeScript sources.
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
const { VirtualInventory, InventoryLink } = await load("../src/inventory");
const { StateManager } = await load("../src/state");
const {
  MinecraftVirtualContainerAdapter,
  Window,
  WindowOpenRejectedError,
  minecraftVirtualContainerAdapter,
} = await load("../src/window");
const { createdContainers } = await import(mockUrl);

/**
 * Test-only adapter. Clearly separate from Minecraft: it records calls and
 * never touches a game screen. `canOpenScreens: true` is the explicit opt-in.
 */
class InMemoryTestAdapter {
  canOpenScreens = true;
  containers = [];
  opened = [];
  closed = [];

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

  openContainer(container, viewer) {
    this.opened.push({ container, viewer });
  }

  closeContainer(container, viewer) {
    this.closed.push({ container, viewer });
  }
}

const player = { id: "p1", name: "Steve" };
const otherPlayer = { id: "p2", name: "Alex" };

function stack(typeId, amount = 1) {
  return { typeId, amount };
}

test("Window.builder validates viewer, upper GUI, and shared state key", () => {
  assert.throws(() => Window.builder().build(), /setViewer/);
  assert.throws(
    () => Window.builder().setViewer(player).build(),
    /setUpperGui/,
  );

  const gui = Gui.normal({ structure: ["a"] });
  assert.throws(
    () =>
      Window.builder()
        .setViewer(player)
        .setUpperGui(gui)
        .setStateScope("shared")
        .build(),
    /setStateKey/,
  );

  assert.throws(() => Window.builder().setStateScope("world"), TypeError);
  assert.throws(() => Window.builder().setStateLifetime("forever"), TypeError);
  assert.throws(() => Window.builder().setStateKey(""), TypeError);
});

test("real adapter never creates or opens a screen; Window.open rejects", async () => {
  const gui = Gui.normal({ structure: ["a"] });
  const adapter = new MinecraftVirtualContainerAdapter();
  assert.equal(adapter.canOpenScreens, false);
  assert.equal(minecraftVirtualContainerAdapter.canOpenScreens, false);

  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  const before = createdContainers.length;
  await assert.rejects(
    () => window.open(),
    (error) =>
      error instanceof WindowOpenRejectedError &&
      error.code === "INVUI_WINDOW_OPEN_UNVERIFIED",
  );
  assert.equal(window.status, "created");
  assert.equal(createdContainers.length, before);

  assert.throws(
    () => adapter.openContainer({}, player),
    WindowOpenRejectedError,
  );
});

test("real adapter creates containers through VirtualContainerManager.create", () => {
  const adapter = new MinecraftVirtualContainerAdapter();
  const container = adapter.createContainer({ size: 9 });

  assert.equal(container.size, 9);
  assert.equal(container.title, "");
  assert.equal(createdContainers.at(-1), container);

  const titled = adapter.createContainer({ size: 54, title: "ショップ" });
  assert.equal(titled.size, 54);
  assert.equal(titled.title, "ショップ");
});

test("test adapter opens, renders GUI slots, and closes once", async () => {
  const adapter = new InMemoryTestAdapter();
  const diamond = Item.simple(() => stack("minecraft:diamond", 2));
  const gui = Gui.normal({
    structure: ["abc"],
    ingredients: {
      a: diamond,
      b: new InventoryLink(new VirtualInventory(1), 0),
    },
  });
  const closeReasons = [];
  let opened = 0;

  const window = Window.builder()
    .setViewer(player)
    .setTitle("Shop")
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .addOpenHandler(() => opened++)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();

  assert.equal(window.status, "open");
  assert.equal(opened, 1);
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.opened[0].viewer, player);

  const container = adapter.containers[0];
  assert.equal(container.size, 9);
  assert.equal(container.title, "Shop");
  assert.equal(container.items[0].typeId, "minecraft:diamond");
  assert.equal(container.items[0].amount, 2);
  assert.equal(container.items[1], undefined);
  assert.equal(container.items[2], undefined);

  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);

  window.close("PlayerClosed");
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);
});

test("window state is discarded on close; session state survives", async () => {
  const manager = new StateManager();
  const adapter = new InMemoryTestAdapter();
  const gui = Gui.normal({ structure: ["a"] });

  const windowLifetime = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();
  await windowLifetime.open();
  windowLifetime.setState({ page: 2 });
  assert.equal(windowLifetime.getState().page, 2);
  windowLifetime.close();

  const reopened = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();
  await reopened.open();
  assert.equal(reopened.getState().page, undefined);
  reopened.close();

  const sessionA = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateLifetime("session")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();
  await sessionA.open();
  sessionA.setState({ page: 3 });
  sessionA.close();

  const sessionB = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateLifetime("session")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();
  await sessionB.open();
  assert.equal(sessionB.getState().page, 3);
  sessionB.close();
});

test("shared state is visible to other viewers with the same key", async () => {
  const manager = new StateManager();
  const adapter = new InMemoryTestAdapter();
  const gui = Gui.normal({ structure: ["a"] });

  const first = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("shop")
    .setStateLifetime("session")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();
  const second = Window.builder()
    .setViewer(otherPlayer)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("shop")
    .setStateLifetime("session")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();

  await first.open();
  await second.open();
  first.setState({ tab: 1 });
  assert.equal(second.getState().tab, 1);

  first.close();
  second.close();
});

test("clicks route to the Item at the slot only while open", async () => {
  const adapter = new InMemoryTestAdapter();
  const clicks = [];
  const item = Item.builder()
    .setItemProvider(() => stack("minecraft:stone"))
    .addClickHandler((click) => {
      clicks.push({ slot: click.slot, name: click.player.name });
    })
    .build();
  const gui = Gui.normal({ structure: ["abc"], ingredients: { b: item } });

  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();
  await window.open();

  assert.equal(await window.handleClick(1), true);
  assert.deepEqual(clicks, [{ slot: 1, name: "Steve" }]);
  assert.equal(await window.handleClick(0), false);
  assert.equal(await window.handleClick(9), false);

  window.close();
  assert.equal(await window.handleClick(1), false);
  assert.deepEqual(clicks, [{ slot: 1, name: "Steve" }]);
});

test("setState re-renders page content", async () => {
  const adapter = new InMemoryTestAdapter();
  const content = [1, 2, 3, 4].map((n) =>
    Item.simple(() => stack(`minecraft:item_${n}`)),
  );
  const gui = Gui.paged({
    structure: ["..."],
    ingredients: {
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content,
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:item_1");

  window.setState({ page: 1 });
  await window.refresh();
  assert.equal(container.items[0].typeId, "minecraft:item_4");
  window.close();
});

test("closing during an async provider prevents a stale slot write", async () => {
  const adapter = new InMemoryTestAdapter();
  let resolveProvider;
  const item = Item.simple(
    () =>
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
  );
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  const opening = window.open();
  await Promise.resolve();
  const container = adapter.containers[0];
  assert.ok(container, "container should be created before rendering waits");

  window.close();
  resolveProvider(stack("minecraft:late"));
  await opening;

  assert.equal(window.status, "closed");
  assert.equal(adapter.opened.length, 0);
  assert.equal(container.items[0], undefined);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("non-9-wide structures map logical slots to nine physical columns and size", async () => {
  const adapter = new InMemoryTestAdapter();
  const clicked = [];
  const gui = Gui.normal({
    structure: ["abc", "def"],
    ingredients: {
      a: Item.builder()
        .setItemProvider(() => stack("minecraft:a"))
        .addClickHandler((click) => clicked.push(click.slot))
        .build(),
      b: Item.simple(() => stack("minecraft:b")),
      c: Item.simple(() => stack("minecraft:c")),
      d: Item.simple(() => stack("minecraft:d")),
      e: Item.simple(() => stack("minecraft:e")),
      f: Item.simple(() => stack("minecraft:f")),
    },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.size, 18);
  assert.deepEqual(
    [0, 1, 2, 9, 10, 11].map((slot) => container.items[slot]?.typeId),
    [
      "minecraft:a",
      "minecraft:b",
      "minecraft:c",
      "minecraft:d",
      "minecraft:e",
      "minecraft:f",
    ],
  );
  assert.deepEqual(
    [3, 4, 5, 6, 7, 8, 12].map((slot) => container.items[slot]),
    [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
  );

  assert.equal(await window.handleClick(0), true);
  assert.deepEqual(clicked, [0]);
  window.close();
});

test("an older async provider result for the same slot is discarded", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let phase = "initial";
  const item = Item.simple(() => {
    if (phase === "initial") {
      return stack("minecraft:initial");
    }
    return new Promise((resolve) => pending.push(resolve));
  });
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:initial");

  phase = "async";
  item.notifyWindows();
  item.notifyWindows();
  assert.equal(pending.length, 2);

  pending[1](stack("minecraft:new"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:new");

  pending[0](stack("minecraft:stale"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:new");
  window.close();
});

test("shared-state clicks are serialized through the state handle queue", async () => {
  const manager = new StateManager();
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  const events = [];
  let started = 0;
  const item = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(async () => {
      started += 1;
      const current = started;
      events.push(`start:${current}`);
      if (current === 1) {
        await gate.promise;
      }
      events.push(`end:${current}`);
    })
    .build();
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });

  function build(viewer) {
    return Window.builder()
      .setViewer(viewer)
      .setUpperGui(gui)
      .setStateScope("shared")
      .setStateKey("queue")
      .setStateLifetime("session")
      .setStateManager(manager)
      .setContainerAdapter(adapter)
      .build();
  }

  const first = build(player);
  const second = build(otherPlayer);
  await first.open();
  await second.open();

  const firstClick = first.handleClick(0);
  await tick();
  const secondClick = second.handleClick(0);
  await tick();
  assert.deepEqual(events, ["start:1"]);

  gate.resolve();
  assert.equal(await firstClick, true);
  assert.equal(await secondClick, true);
  assert.deepEqual(events, ["start:1", "end:1", "start:2", "end:2"]);

  first.close();
  second.close();
});

test("a queued click is discarded when the layout changes", async () => {
  const manager = new StateManager();
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  let handled = 0;
  const firstItem = Item.builder()
    .setItemProvider(() => stack("minecraft:first"))
    .addClickHandler(async () => {
      handled += 1;
      await gate.promise;
    })
    .build();
  const secondItem = Item.simple(() => stack("minecraft:second"));
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [firstItem, secondItem],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("layout-change")
    .setStateLifetime("session")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:first");

  const running = window.handleClick(0);
  await tick();
  const queued = window.handleClick(0);
  await tick();
  window.setState({ page: 1 });
  gate.resolve();

  assert.equal(await running, true);
  assert.equal(await queued, false);
  assert.equal(handled, 1);
  assert.equal(adapter.containers[0].items[0].typeId, "minecraft:second");
  window.close();
});

test("closing the window discards a queued click without reporting it", async () => {
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  let handled = 0;
  const errors = [];
  const item = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(async () => {
      handled += 1;
      await gate.promise;
    })
    .build();
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const running = window.handleClick(0);
  await tick();
  const queued = window.handleClick(0);
  await tick();
  window.close();
  gate.resolve();

  assert.equal(await running, true);
  assert.equal(await queued, false);
  assert.equal(handled, 1);
  assert.deepEqual(errors, []);
});

test("a state-update error inside a click is reported and does not block the queue", async () => {
  let writes = 0;
  const store = {
    getItem() {
      return null;
    },
    setItem() {
      writes += 1;
      if (writes > 1) {
        throw new Error("store unavailable");
      }
    },
    removeItem() {},
  };
  const manager = new StateManager(store);
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  let handled = 0;
  const item = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler((click) => {
      handled += 1;
      click.window.setState({ page: handled });
    })
    .build();
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateLifetime("persistent")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  assert.equal(await window.handleClick(0), false);
  assert.equal(await window.handleClick(0), false);
  assert.equal(handled, 2);
  assert.deepEqual(
    errors.map(({ context }) => context.operation),
    ["click", "click"],
  );
  window.close();
});

test("errors while refreshing from a state update are reported, not unhandled", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const broken = {
    resolve: () => stack("minecraft:broken"),
    subscribe() {
      throw new Error("subscribe failed");
    },
  };
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: broken } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  window.setState({ selection: "changed" });
  await tick();
  await tick();

  assert.equal(window.status, "open");
  assert.ok(
    errors.some(
      ({ error, context }) =>
        context.operation === "subscribe" &&
        error.message === "subscribe failed",
    ),
  );
  window.close();
});

test("a queued click survives a state update that does not move the slot", async () => {
  const adapter = new InMemoryTestAdapter();
  let handled = 0;
  const item = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(() => {
      handled += 1;
    })
    .build();
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const click = window.handleClick(0);
  window.setState({ selection: "changed" });

  assert.equal(await click, true);
  assert.equal(handled, 1);
  window.close();
});

test("state updates re-render only slots whose element changed", async () => {
  const adapter = new InMemoryTestAdapter();
  const icon = Item.simple(() => stack("minecraft:icon"));
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
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:icon");
  assert.equal(container.items[1].typeId, "minecraft:page_1");

  const writes = [];
  const originalSetItem = container.setItem.bind(container);
  container.setItem = (slot, item) => {
    writes.push(slot);
    originalSetItem(slot, item);
  };

  window.setState({ page: 1 });
  await tick();

  assert.deepEqual(writes, [1]);
  assert.equal(container.items[1].typeId, "minecraft:page_2");
  assert.equal(container.items[0].typeId, "minecraft:icon");
  window.close();
});

test("explicit refresh re-evaluates slots whose element did not change", async () => {
  const adapter = new InMemoryTestAdapter();
  let typeId = "minecraft:before";
  const item = Item.simple(() => stack(typeId));
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:before");

  // No item notification: only the explicit refresh should re-evaluate.
  typeId = "minecraft:after";
  await window.refresh();
  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("an in-flight render survives a state update that keeps its element in place", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = deferred();
  let phase = "initial";
  const item = Item.simple(() =>
    phase === "initial" ? stack("minecraft:initial") : pending.promise,
  );
  const gui = Gui.paged({
    structure: ["a."],
    ingredients: {
      a: item,
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content: [
      Item.simple(() => stack("minecraft:page_1")),
      Item.simple(() => stack("minecraft:page_2")),
    ],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:initial");

  phase = "async";
  item.notifyWindows();
  window.setState({ page: 1 });
  await tick();

  pending.resolve(stack("minecraft:late"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:late");
  assert.equal(container.items[1].typeId, "minecraft:page_2");
  window.close();
});

test("a state-changed slot discards an older async provider result", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = deferred();
  let phase = "initial";
  const first = Item.simple(() =>
    phase === "initial" ? stack("minecraft:first") : pending.promise,
  );
  const second = Item.simple(() => stack("minecraft:second"));
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [first, second],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:first");

  phase = "async";
  first.notifyWindows();
  window.setState({ page: 1 });
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:second");

  pending.resolve(stack("minecraft:stale"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:second");
  window.close();
});
