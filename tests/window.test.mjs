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

const { Gui, GuiLink, Markers } = await load("../src/gui");
const { Item } = await load("../src/item");
const { VirtualInventory, InventoryLink } = await load("../src/inventory");
const { StateConflictError, StateManager } = await load("../src/state");
const {
  MAX_OPEN_RENDER_PASSES,
  MinecraftVirtualContainerAdapter,
  Window,
  WindowItemChangeDangerError,
  WindowOpenRejectedError,
  WindowOpenRenderLimitError,
  WindowStateSchemaChangedError,
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
  events = [];
  closeSubscriptions = [];
  itemChangeSubscriptions = [];
  failOpen = false;
  failSubscribeClose = false;
  failSubscribeItemChange = false;
  failUnsubscribe = false;
  reentrantClose = false;
  closeOnOpen = false;

  createContainer(options) {
    this.events.push("create");
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
    if (this.failOpen) {
      throw new Error("open failed");
    }
    this.opened.push({ container, viewer });
    this.events.push("open");
    if (this.closeOnOpen) {
      this.emitClose(
        { container, player: viewer, reason: "ServerClosed" },
        true,
      );
    }
  }

  closeContainer(container, viewer) {
    this.closed.push({ container, viewer });
    this.events.push("close");
    if (this.reentrantClose) {
      // Model an in-flight dispatch that still runs callbacks captured before
      // the Window unsubscribed.
      this.emitClose({ container, player: viewer, reason: "ServerClosed" }, true);
    }
  }

  subscribeClose(handler) {
    this.events.push("subscribeClose");
    if (this.failSubscribeClose) {
      throw new Error("close subscribe failed");
    }
    const record = { handler, active: true };
    this.closeSubscriptions.push(record);
    return () => {
      this.events.push("unsubscribeClose");
      record.active = false;
      if (this.failUnsubscribe) {
        throw new Error("close unsubscribe failed");
      }
    };
  }

  subscribeItemChange(handler) {
    this.events.push("subscribeItemChange");
    if (this.failSubscribeItemChange) {
      throw new Error("itemChange subscribe failed");
    }
    const record = { handler, active: true };
    this.itemChangeSubscriptions.push(record);
    return () => {
      this.events.push("unsubscribeItemChange");
      record.active = false;
      if (this.failUnsubscribe) {
        throw new Error("itemChange unsubscribe failed");
      }
    };
  }

  emitClose(event, force = false) {
    for (const record of [...this.closeSubscriptions]) {
      if (record.active || force) {
        record.handler(event);
      }
    }
  }

  emitItemChange(event, force = false) {
    for (const record of [...this.itemChangeSubscriptions]) {
      if (record.active || force) {
        record.handler(event);
      }
    }
  }
}

const player = { id: "p1", name: "Steve" };
const otherPlayer = { id: "p2", name: "Alex" };

function stack(typeId, amount = 1) {
  return { typeId, amount };
}

function scrollGui(direction) {
  return Gui.scroll({
    structure: ["..."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [Item.simple(() => stack("minecraft:scroll_item"))],
    direction,
  });
}

function linkedGui(key, childStructure = "x") {
  return Gui.normal({
    structure: ["a"],
    ingredients: {
      a: new GuiLink(Gui.normal({ structure: [childStructure] }), { key }),
    },
  });
}

/** A non-trivial GUI covering tabs, a scroll child, and a keyed GuiLink. */
function schemaGui() {
  return Gui.tab({
    tabs: [
      Gui.normal({
        structure: ["ab"],
        ingredients: {
          a: new GuiLink(Gui.normal({ structure: ["x"] }), { key: "child" }),
          b: Item.simple(() => stack("minecraft:b")),
        },
      }),
      scrollGui("horizontal"),
    ],
  });
}

function sharedWindow(gui, manager, adapter, key = "schema-key") {
  return Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey(key)
    .setStateLifetime("session")
    .setStateManager(manager)
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();
}

/** Map-backed StateStore so tests can inspect exactly what was persisted. */
function memoryStore() {
  const records = new Map();
  return {
    records,
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
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

test("shared state accepts equivalent GUIs and rejects incompatible schemas", async () => {
  const manager = new StateManager();
  const adapter = new InMemoryTestAdapter();
  const first = sharedWindow(schemaGui(), manager, adapter);
  const second = sharedWindow(schemaGui(), manager, adapter);

  await first.open();
  await second.open();
  first.setState({ tab: 1 });
  assert.equal(second.getState().tab, 1);
  first.close();
  second.close();

  const cases = [
    [
      "GUI kind",
      Gui.normal({ structure: ["a"] }),
      Gui.paged({ structure: ["a"] }),
    ],
    [
      "rows containing the old separator",
      Gui.normal({ structure: ["a/b/c/d"] }),
      Gui.normal({ structure: ["a/b", "c/d"] }),
    ],
    ["rows", Gui.normal({ structure: ["a"] }), Gui.normal({ structure: ["b"] })],
    ["scroll direction", scrollGui("vertical"), scrollGui("horizontal")],
    [
      "tab children",
      Gui.tab({ tabs: [Gui.normal({ structure: ["a"] })] }),
      Gui.tab({ tabs: [Gui.normal({ structure: ["b"] })] }),
    ],
    ["GuiLink key", linkedGui("one"), linkedGui("two")],
    ["GuiLink child", linkedGui("child", "x"), linkedGui("child", "y")],
  ];

  for (const [label, firstGui, secondGui] of cases) {
    const caseManager = new StateManager();
    const caseAdapter = new InMemoryTestAdapter();
    const open = sharedWindow(firstGui, caseManager, caseAdapter, "mismatch");
    await open.open();
    const rejected = sharedWindow(secondGui, caseManager, caseAdapter, "mismatch");

    await assert.rejects(
      rejected.open(),
      (error) =>
        error instanceof StateConflictError && error.code === "SCHEMA_MISMATCH",
      label,
    );
    assert.equal(rejected.status, "closed", label);
    open.close();
  }
});

test("cyclic GUI references are rejected before creating a container", async () => {
  const parent = Gui.normal({ structure: ["a"] });
  const child = Gui.normal({ structure: ["b"] });
  parent._structure.addIngredient("a", new GuiLink(child, { key: "child" }));
  child._structure.addIngredient("b", new GuiLink(parent, { key: "parent" }));

  const adapter = new InMemoryTestAdapter();
  const window = sharedWindow(parent, new StateManager(), adapter);

  await assert.rejects(() => window.open(), /Cyclic GUI reference/);
  assert.equal(window.status, "closed");
  assert.equal(adapter.containers.length, 0);
});

test("persisted records with the previous schema token are rejected", async () => {
  const records = new Map();
  const store = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  const key = "legacy-schema";
  records.set(
    `invui:gui-state:${JSON.stringify(["shared", null, key])}`,
    JSON.stringify({
      version: 1,
      scope: "shared",
      key,
      lifetime: "persistent",
      // Token emitted by the previous kind + rows.join("/") implementation.
      schema: "invui-window:normal:a",
      guiState: {},
    }),
  );

  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setStateScope("shared")
    .setStateKey(key)
    .setStateLifetime("persistent")
    .setStateManager(new StateManager(store))
    .setContainerAdapter(new InMemoryTestAdapter())
    .setErrorHandler(() => {})
    .build();

  await assert.rejects(
    () => window.open(),
    (error) =>
      error instanceof StateConflictError && error.code === "SCHEMA_MISMATCH",
  );
  assert.equal(window.status, "closed");
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

test("display items reject clicks even with handlers (design 10.5)", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const handled = [];
  const display = Item.simple(() => stack("minecraft:display"));
  const guardedDisplay = Item.builder()
    .setItemProvider(() => stack("minecraft:guarded"))
    .addClickHandler(() => handled.push("guarded"))
    .build()
    .setMode("display");
  const button = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(() => handled.push("button"))
    .build();
  const gui = Gui.normal({
    structure: ["abc"],
    ingredients: { a: display, b: guardedDisplay, c: button },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[1].typeId, "minecraft:guarded");

  assert.equal(await window.handleClick(0), false);
  assert.equal(await window.handleClick(1), false);
  assert.deepEqual(handled, []);
  assert.deepEqual(errors, []);

  // Button slots keep their existing behavior.
  assert.equal(await window.handleClick(2), true);
  assert.deepEqual(handled, ["button"]);
  window.close();
});

test("a click whose slot turns display while queued is not run", async () => {
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  const handled = [];
  let calls = 0;
  const item = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(async () => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
      }
      handled.push(calls);
    })
    .build();
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();

  await window.open();
  const running = window.handleClick(0);
  await tick();
  const queued = window.handleClick(0);
  await tick();
  assert.deepEqual(handled, []);

  item.setMode("display");
  gate.resolve();

  assert.equal(await running, true);
  assert.equal(await queued, false);
  assert.deepEqual(handled, [1]);
  assert.equal(window.status, "open");
  assert.equal(await window.handleClick(0), false);

  // Switching the Item back to button re-enables clicks; queued-mode changes
  // are not latched into the Window.
  item.setMode("button");
  assert.equal(await window.handleClick(0), true);
  assert.deepEqual(handled, [1, 2]);
  window.close();
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

test("state updates re-evaluate every slot, including unchanged elements", async () => {
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

  // The icon element did not change, but its provider may read the new state,
  // so it is re-evaluated too.
  assert.deepEqual([...writes].sort(), [0, 1]);
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

test("a slow slot does not block rendering of the other slots", async () => {
  const adapter = new InMemoryTestAdapter();
  const slow = deferred();
  const gui = Gui.normal({
    structure: ["ab"],
    ingredients: {
      a: Item.simple(() => slow.promise),
      b: Item.simple(() => stack("minecraft:fast")),
    },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  const opening = window.open();
  await tick();
  const container = adapter.containers[0];
  assert.equal(container.items[1].typeId, "minecraft:fast");

  slow.resolve(stack("minecraft:slow"));
  await opening;
  assert.equal(container.items[0].typeId, "minecraft:slow");
  window.close();
});

test("a state change while opening is applied before the screen opens", async () => {
  const adapter = new InMemoryTestAdapter();
  const firstRender = deferred();
  let calls = 0;
  let label = "before";
  const item = Item.simple(() => {
    calls += 1;
    return calls === 1 ? firstRender.promise : stack(`minecraft:${label}`);
  });
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  const opening = window.open();
  await tick();

  label = "after";
  window.setState({ selection: "after" });
  firstRender.resolve(stack("minecraft:before"));
  await opening;

  assert.equal(window.status, "open");
  assert.equal(adapter.containers[0].items[0].typeId, "minecraft:after");
  window.close();
});

test("state changes on every render pass fail the open at a bounded pass limit", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  let window;
  let passes = 0;
  // A provider that writes state while it renders makes every pass stale: the
  // retry loop must stop at a bound instead of never resolving open().
  const item = Item.simple(() => {
    passes += 1;
    window.setState({ page: passes });
    return stack("minecraft:loop");
  });
  window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  let rejection;
  try {
    await window.open();
    assert.fail("open() must not resolve while state keeps changing");
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection instanceof WindowOpenRenderLimitError);
  assert.equal(rejection.code, "INVUI_WINDOW_OPEN_RENDER_LIMIT");
  assert.equal(rejection.passes, MAX_OPEN_RENDER_PASSES);
  assert.equal(passes, MAX_OPEN_RENDER_PASSES);
  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.equal(adapter.opened.length, 0);
  assert.deepEqual(closeReasons, []);
  assert.deepEqual(
    errors.map(({ context }) => context.operation),
    ["open"],
  );
  assert.equal(errors[0].error, rejection);
});

test("a finite number of state changes while opening still opens the window", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  let window;
  let calls = 0;
  const finitePasses = 5;
  const item = Item.simple(() => {
    calls += 1;
    if (calls <= finitePasses) {
      window.setState({ page: calls });
    }
    return stack(`minecraft:pass_${calls}`);
  });
  window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();

  assert.equal(window.status, "open");
  assert.equal(calls, finitePasses + 1);
  assert.equal(window.getState().page, finitePasses);
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.containers[0].items[0].typeId, `minecraft:pass_${calls}`);
  assert.deepEqual(errors, []);
  window.close();
});

test("a state change re-evaluates a provider for an unchanged element", async () => {
  const adapter = new InMemoryTestAdapter();
  let label = "before";
  const icon = Item.simple(() => stack(`minecraft:${label}`));
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: icon } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:before");

  // Same Item instance at the same slot; only the closure's result changes.
  label = "after";
  window.setState({ selection: "after" });
  await tick();
  await tick();

  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("upper GUI content changes re-render the open window", async () => {
  const adapter = new InMemoryTestAdapter();
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [Item.simple(() => stack("minecraft:first"))],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:first");

  gui.setContent([Item.simple(() => stack("minecraft:second"))]);
  await tick();

  assert.equal(window.status, "open");
  assert.equal(container.items[0].typeId, "minecraft:second");
  window.close();
});

test("GuiLink and TabGui child changes re-render the open window", async () => {
  const adapter = new InMemoryTestAdapter();
  const child = Gui.normal({
    structure: ["x"],
    ingredients: { x: Item.simple(() => stack("minecraft:child_1")) },
  });
  const tab0 = Gui.normal({
    structure: ["a"],
    ingredients: { a: new GuiLink(child) },
  });
  const tab1 = Gui.normal({
    structure: ["b"],
    ingredients: { b: Item.simple(() => stack("minecraft:tab1_1")) },
  });
  const gui = Gui.tab({ tabs: [tab0, tab1] });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:child_1");

  child.setIngredient(
    "x",
    Item.simple(() => stack("minecraft:child_2")),
  );
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:child_2");

  window.setState({ tab: 1 });
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:tab1_1");

  tab1.setIngredient(
    "b",
    Item.simple(() => stack("minecraft:tab1_2")),
  );
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:tab1_2");
  window.close();
});

test("a GUI change while opening is applied before the screen opens", async () => {
  const adapter = new InMemoryTestAdapter();
  const firstRender = deferred();
  let calls = 0;
  const delayed = Item.simple(() => {
    calls += 1;
    return calls === 1 ? firstRender.promise : stack("minecraft:late");
  });
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: delayed },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  const opening = window.open();
  await tick();

  gui.setIngredient(
    "a",
    Item.simple(() => stack("minecraft:replacement")),
  );
  firstRender.resolve(stack("minecraft:before"));
  await opening;

  assert.equal(window.status, "open");
  assert.equal(adapter.containers[0].items[0].typeId, "minecraft:replacement");
  window.close();
});

test("a shared GuiLink child updates every open window; close detaches only that window", async () => {
  const adapter = new InMemoryTestAdapter();
  const child = Gui.normal({
    structure: ["x"],
    ingredients: { x: Item.simple(() => stack("minecraft:child_1")) },
  });
  const firstRoot = Gui.normal({
    structure: ["a"],
    ingredients: { a: new GuiLink(child) },
  });
  const secondRoot = Gui.normal({
    structure: ["a"],
    ingredients: { a: new GuiLink(child) },
  });
  const build = (viewer, gui) =>
    Window.builder()
      .setViewer(viewer)
      .setUpperGui(gui)
      .setContainerAdapter(adapter)
      .build();

  const first = build(player, firstRoot);
  const second = build(otherPlayer, secondRoot);
  await first.open();
  await second.open();

  const firstContainer = adapter.containers[0];
  const secondContainer = adapter.containers[1];

  child.setIngredient(
    "x",
    Item.simple(() => stack("minecraft:child_2")),
  );
  await tick();
  assert.equal(firstContainer.items[0].typeId, "minecraft:child_2");
  assert.equal(secondContainer.items[0].typeId, "minecraft:child_2");

  first.close();
  child.setIngredient(
    "x",
    Item.simple(() => stack("minecraft:child_3")),
  );
  await tick();
  assert.equal(firstContainer.items[0].typeId, "minecraft:child_2");
  assert.equal(secondContainer.items[0].typeId, "minecraft:child_3");

  // The closed Window must not keep listening through its root either.
  firstRoot.setIngredient(
    "a",
    Item.simple(() => stack("minecraft:first_only")),
  );
  await tick();
  assert.equal(firstContainer.items[0].typeId, "minecraft:child_2");
  assert.equal(secondContainer.items[0].typeId, "minecraft:child_3");
  second.close();
});

test("a GUI update discards an in-flight provider result", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = deferred();
  let phase = "initial";
  const icon = Item.simple(() => {
    if (phase === "initial") {
      return stack("minecraft:initial");
    }
    if (phase === "async") {
      return pending.promise;
    }
    return stack("minecraft:after");
  });
  const gui = Gui.paged({
    structure: ["a."],
    ingredients: {
      a: icon,
      ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL,
    },
    content: [Item.simple(() => stack("minecraft:page_1"))],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:initial");

  phase = "async";
  icon.notifyWindows();
  phase = "after";
  gui.setContent([Item.simple(() => stack("minecraft:page_2"))]);
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:after");
  assert.equal(container.items[1].typeId, "minecraft:page_2");

  pending.resolve(stack("minecraft:stale"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:after");
  window.close();
});

test("GUI content updates keep the session state schema compatible", async () => {
  const manager = new StateManager();
  const adapter = new InMemoryTestAdapter();
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [1, 2, 3, 4].map((n) =>
      Item.simple(() => stack(`minecraft:item_${n}`)),
    ),
  });
  const build = () =>
    Window.builder()
      .setViewer(player)
      .setUpperGui(gui)
      .setStateLifetime("session")
      .setStateManager(manager)
      .setContainerAdapter(adapter)
      .build();

  const first = build();
  await first.open();
  first.setState({ page: 1 });

  gui.setContent([
    Item.simple(() => stack("minecraft:item_5")),
    Item.simple(() => stack("minecraft:item_6")),
  ]);
  await tick();
  assert.equal(adapter.containers[0].items[0].typeId, "minecraft:item_6");
  first.close();

  const reopened = build();
  await reopened.open();
  assert.equal(reopened.getState().page, 1);
  assert.equal(adapter.containers[1].items[0].typeId, "minecraft:item_6");
  reopened.close();
});

test("a structural GUI change fails closed and never persists the old schema", async () => {
  const store = memoryStore();
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:before")) },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("schema-change")
    .setStateLifetime("persistent")
    .setStateManager(new StateManager(store))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const container = adapter.containers[0];
  window.setState({ page: 1 });
  const [storedKey] = store.records.keys();
  const persisted = store.records.get(storedKey);
  assert.equal(JSON.parse(persisted).guiState.page, 1);

  // A GuiLink ingredient belongs to the state schema, so replacing an Item
  // with one changes the shape (setContent does not).
  gui.setIngredient(
    "a",
    new GuiLink(Gui.normal({ structure: ["x"] }), { key: "child" }),
  );
  await tick();

  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(errors.length, 1);
  const [{ error, context }] = errors;
  assert.ok(error instanceof WindowStateSchemaChangedError);
  assert.equal(error.code, "INVUI_STATE_SCHEMA_CHANGED");
  assert.equal(context.operation, "guiChange");
  // The stale shape was never written: the record still holds the state the
  // old shape saved.
  assert.equal(store.records.get(storedKey), persisted);
  assert.throws(() => window.setState({ page: 2 }), /not open/);

  // Adopting the new shape needs an explicit migration instead of silently
  // loading the state that belonged to the previous shape.
  const adopted = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("schema-change")
    .setStateLifetime("persistent")
    .setStateManager(new StateManager(store))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();
  await assert.rejects(
    () => adopted.open(),
    (failure) =>
      failure instanceof StateConflictError && failure.code === "SCHEMA_MISMATCH",
  );
});

test("a state write reentering a structural GUI change is refused and reported once", async () => {
  const store = memoryStore();
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const refused = [];
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:before")) },
  });
  let window;
  // Registered before the Window subscribes, so this listener runs first in
  // the same synchronous cascade as the structural change: the write sees the
  // new shape while the state still carries the acquired schema.
  const unsubscribe = gui.subscribe(() => {
    try {
      window.setState({ page: 2 });
    } catch (failure) {
      refused.push(failure);
    }
  });
  window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("schema-race")
    .setStateLifetime("persistent")
    .setStateManager(new StateManager(store))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const [storedKey] = store.records.keys();
  const persisted = store.records.get(storedKey);

  gui.setIngredient(
    "a",
    new GuiLink(Gui.normal({ structure: ["x"] }), { key: "child" }),
  );
  unsubscribe();
  await tick();

  assert.deepEqual(
    refused.map((failure) => failure.code),
    ["INVUI_STATE_SCHEMA_CHANGED"],
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "INVUI_STATE_SCHEMA_CHANGED");
  assert.equal(errors[0].context.operation, "setState");
  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 1);
  assert.equal(store.records.get(storedKey), persisted);
  assert.equal(JSON.parse(persisted).guiState.page, undefined);
});

test("content updates keep the schema and normal state writes", async () => {
  const store = memoryStore();
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [Item.simple(() => stack("minecraft:first"))],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setStateScope("shared")
    .setStateKey("content-change")
    .setStateLifetime("persistent")
    .setStateManager(new StateManager(store))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const container = adapter.containers[0];
  const [storedKey] = store.records.keys();
  const schema = JSON.parse(store.records.get(storedKey)).schema;

  gui.setContent([Item.simple(() => stack("minecraft:second"))]);
  await tick();
  assert.equal(window.status, "open");
  assert.equal(container.items[0].typeId, "minecraft:second");

  // The content change kept the shape, so the persistent write still uses the
  // acquired schema and the Window keeps working.
  window.setState({ page: 1 });
  await tick();
  assert.equal(window.status, "open");
  assert.deepEqual(errors, []);
  const record = JSON.parse(store.records.get(storedKey));
  assert.equal(record.schema, schema);
  assert.equal(record.guiState.page, 1);
  window.close();
});

test("an Item shown in multiple slots and windows updates every display until each close", async () => {
  const adapter = new InMemoryTestAdapter();
  let typeId = "minecraft:shared_1";
  const shared = Item.simple(() => stack(typeId));
  const gui = Gui.normal({
    structure: ["ab"],
    ingredients: { a: shared, b: shared },
  });
  const build = (viewer) =>
    Window.builder()
      .setViewer(viewer)
      .setUpperGui(gui)
      .setContainerAdapter(adapter)
      .build();

  const first = build(player);
  const second = build(otherPlayer);
  await first.open();
  await second.open();
  const [firstContainer, secondContainer] = adapter.containers;
  assert.deepEqual(
    [0, 1].map((slot) => firstContainer.items[slot].typeId),
    ["minecraft:shared_1", "minecraft:shared_1"],
  );
  assert.deepEqual(
    [0, 1].map((slot) => secondContainer.items[slot].typeId),
    ["minecraft:shared_1", "minecraft:shared_1"],
  );

  typeId = "minecraft:shared_2";
  shared.notifyWindows();
  await tick();
  assert.deepEqual(
    [0, 1].map((slot) => firstContainer.items[slot].typeId),
    ["minecraft:shared_2", "minecraft:shared_2"],
  );
  assert.deepEqual(
    [0, 1].map((slot) => secondContainer.items[slot].typeId),
    ["minecraft:shared_2", "minecraft:shared_2"],
  );

  // Closing one Window must detach both of its slot subscriptions.
  first.close();
  typeId = "minecraft:shared_3";
  shared.notifyWindows();
  await tick();
  assert.deepEqual(
    [0, 1].map((slot) => firstContainer.items[slot].typeId),
    ["minecraft:shared_2", "minecraft:shared_2"],
  );
  assert.deepEqual(
    [0, 1].map((slot) => secondContainer.items[slot].typeId),
    ["minecraft:shared_3", "minecraft:shared_3"],
  );

  // After the last Window closes the Item has no listeners left to notify.
  second.close();
  typeId = "minecraft:shared_4";
  shared.notifyWindows();
  await tick();
  assert.deepEqual(
    [0, 1].map((slot) => secondContainer.items[slot].typeId),
    ["minecraft:shared_3", "minecraft:shared_3"],
  );
});

test("Window#setErrorHandler replaces the handler for later failures", async () => {
  const adapter = new InMemoryTestAdapter();
  const firstErrors = [];
  const secondErrors = [];
  let phase = "ok";
  const item = Item.simple(() => {
    if (phase === "ok") {
      return stack("minecraft:fine");
    }
    throw new Error("provider failed");
  });
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => firstErrors.push({ error, context }))
    .build();

  await window.open();
  assert.equal(
    window.setErrorHandler((error, context) => secondErrors.push({ error, context })),
    window,
  );
  assert.throws(() => window.setErrorHandler("not a function"), TypeError);

  phase = "failed";
  item.notifyWindows();
  await tick();
  await tick();

  assert.deepEqual(firstErrors, []);
  assert.equal(secondErrors.length, 1);
  const [{ error, context }] = secondErrors;
  assert.equal(error.message, "provider failed");
  assert.equal(context.windowId, window.id);
  assert.equal(context.operation, "itemProvider");
  assert.equal(context.slot, 0);
  window.close();
});

test("subscriptions are installed before open and removed on open failure", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const gui = Gui.normal({ structure: ["a"] });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  assert.ok(
    adapter.events.indexOf("subscribeClose") < adapter.events.indexOf("open"),
    "close subscription must exist before the screen is opened",
  );
  assert.ok(
    adapter.events.indexOf("subscribeItemChange") < adapter.events.indexOf("open"),
    "itemChange subscription must exist before the screen is opened",
  );
  window.close();
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.deepEqual(
    adapter.itemChangeSubscriptions.map((record) => record.active),
    [false],
  );

  // Open failure after the subscription: every hook is removed again.
  const failed = new InMemoryTestAdapter();
  failed.failOpen = true;
  const failedWindow = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(failed)
    .setErrorHandler(() => {})
    .build();
  await assert.rejects(failedWindow.open(), /open failed/);
  assert.equal(failedWindow.status, "closed");
  assert.deepEqual(
    failed.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.deepEqual(
    failed.itemChangeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.equal(failed.opened.length, 0);
});

test("a failed itemChange subscription removes the successful close subscription", async () => {
  const adapter = new InMemoryTestAdapter();
  adapter.failSubscribeItemChange = true;
  const errors = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await assert.rejects(() => window.open(), /itemChange subscribe failed/);
  assert.equal(window.status, "closed");
  assert.equal(window.isOpen, false);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.equal(adapter.itemChangeSubscriptions.length, 0);
  assert.equal(adapter.opened.length, 0);
  assert.deepEqual(
    errors.map(({ context }) => context.operation),
    ["open"],
  );
});

test("an unsubscribe failure on open failure does not mask the open error", async () => {
  const adapter = new InMemoryTestAdapter();
  adapter.failOpen = true;
  adapter.failUnsubscribe = true;
  const errors = [];
  const closeReasons = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await assert.rejects(() => window.open(), /open failed/);
  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, []);
  assert.ok(
    errors.some(
      ({ error, context }) =>
        context.operation === "unsubscribe" &&
        error.message === "close unsubscribe failed",
    ),
  );
  assert.ok(
    errors.some(
      ({ error, context }) =>
        context.operation === "open" && error.message === "open failed",
    ),
  );
});

test("a close event tears down once and ignores other players and containers", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const container = adapter.containers[0];

  adapter.emitClose({ container, player: otherPlayer, reason: "PlayerClosed" });
  adapter.emitClose({ container: {}, player, reason: "PlayerClosed" });
  assert.equal(window.status, "open");
  assert.equal(window.container, container);
  assert.deepEqual(closeReasons, []);

  adapter.emitClose({ container, player, reason: "PlayerClosed" });
  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);
  // The screen was already closed; no second close request is sent.
  assert.equal(adapter.closed.length, 0);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );

  // Duplicate/delayed delivery after teardown must not notify again.
  adapter.emitClose({ container, player, reason: "ServerClosed" }, true);
  adapter.emitClose({ container, player, reason: "ServerClosed" }, true);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);
  assert.deepEqual(errors, []);
});

test("an itemChange reports danger, stops rendering, closes, and is never a click or restore", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  const clicks = [];
  const pending = deferred();
  let phase = "initial";
  const item = Item.builder()
    .setItemProvider(() =>
      phase === "initial" ? stack("minecraft:display") : pending.promise,
    )
    .addClickHandler((click) => clicks.push(click.slot))
    .build();
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:display");

  const writes = [];
  const originalSetItem = container.setItem.bind(container);
  container.setItem = (slot, value) => {
    writes.push({ slot, typeId: value?.typeId });
    originalSetItem(slot, value);
  };

  // The screen removed the display item. It must not be restored.
  container.items[0] = undefined;

  // Start an in-flight provider whose result arrives after the itemChange.
  phase = "async";
  item.notifyWindows();
  adapter.emitItemChange({ container, player, slot: 0 });

  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.deepEqual(clicks, []);
  assert.deepEqual(writes, []);
  assert.equal(container.items[0], undefined);
  assert.equal(adapter.closed.length, 1);
  assert.equal(adapter.closed[0].container, container);
  assert.equal(adapter.closed[0].viewer, player);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(errors.length, 1);
  const [{ error, context }] = errors;
  assert.ok(error instanceof WindowItemChangeDangerError);
  assert.equal(error.code, "INVUI_CONTAINER_ITEM_CHANGE");
  assert.equal(error.slot, 0);
  assert.equal(context.operation, "itemChange");
  assert.equal(context.slot, 0);
  assert.equal(await window.handleClick(0), false);

  pending.resolve(stack("minecraft:late"));
  await tick();
  await tick();
  assert.deepEqual(writes, []);
  assert.equal(container.items[0], undefined);

  // Neither duplicate delivery nor the close event that follows the request
  // may notify again.
  adapter.emitItemChange({ container, player, slot: 0 }, true);
  adapter.emitClose({ container, player, reason: "ServerClosed" }, true);
  assert.equal(errors.length, 1);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
});

test("an itemChange from another player or container is ignored", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  let typeId = "minecraft:before";
  const item = Item.simple(() => stack(typeId));
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const container = adapter.containers[0];

  adapter.emitItemChange({ container, player: otherPlayer, slot: 0 });
  adapter.emitItemChange({ container: {}, player, slot: 0 });
  assert.equal(window.status, "open");
  assert.deepEqual(errors, []);

  // The ignored events must not have stopped rendering either.
  typeId = "minecraft:after";
  item.notifyWindows();
  await tick();
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:after");

  adapter.emitItemChange({ container, player, slot: 0 });
  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.operation, "itemChange");
});

test("a delayed close event from a previous open is ignored after reopening", async () => {
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .setErrorHandler(() => {})
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];
  window.close("PlayerClosed");
  assert.equal(window.status, "closed");

  await window.open();
  const secondContainer = adapter.containers[1];
  assert.notEqual(secondContainer, firstContainer);

  // A stale event for the previous container arrives while the new screen is
  // open: it must not tear the new screen down.
  adapter.emitClose(
    { container: firstContainer, player, reason: "PlayerClosed" },
    true,
  );
  assert.equal(window.status, "open");
  assert.equal(window.container, secondContainer);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);

  adapter.emitClose({ container: secondContainer, player, reason: "PlayerClosed" });
  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["PlayerClosed", "PlayerClosed"]);
});

test("a close event dispatched during openContainer resolves open as closed", async () => {
  const adapter = new InMemoryTestAdapter();
  adapter.closeOnOpen = true;
  const errors = [];
  const closeReasons = [];
  let opened = 0;
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addOpenHandler(() => opened++)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  assert.equal(window.status, "closed");
  assert.equal(opened, 0);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(adapter.closed.length, 0);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.deepEqual(errors, []);
});

test("a close event dispatched by closeContainer does not notify the close handler twice", async () => {
  const adapter = new InMemoryTestAdapter();
  adapter.reentrantClose = true;
  const closeReasons = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
});

test("adapters without event hooks keep working", async () => {
  const containers = [];
  const adapter = {
    canOpenScreens: true,
    createContainer(options) {
      const container = {
        size: options.size,
        items: new Array(options.size).fill(undefined),
        setItem(slot, value) {
          this.items[slot] = value;
        },
        getItem(slot) {
          return this.items[slot];
        },
      };
      containers.push(container);
      return container;
    },
    openContainer() {},
    closeContainer() {},
  };
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  assert.equal(window.status, "open");
  assert.equal(containers[0].items[0].typeId, "minecraft:a");
  window.close();
  assert.equal(window.status, "closed");
});
