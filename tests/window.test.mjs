import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Minimal @minecraft/server stand-in. `createdContainers` lets the tests prove
// that the real adapter never creates a container for a rejected open.
const mockSource = `
export const createdContainers = [];
const closeCallbacks = new Set();
const itemChangeCallbacks = new Set();
const chatSendCallbacks = new Set();
const playerLeaveCallbacks = new Set();
const entityDieCallbacks = new Set();
const shutdownCallbacks = new Set();
export const scheduledRuns = [];

export function emitShutdown() {
  for (const callback of [...shutdownCallbacks]) callback({});
}

export function emitPlayerLeave(playerId) {
  for (const callback of [...playerLeaveCallbacks]) {
    callback({ playerId, playerName: playerId });
  }
}

export function emitEntityDie(deadEntity) {
  for (const callback of [...entityDieCallbacks]) {
    callback({ deadEntity });
  }
}

export function emitVirtualContainerClose(event) {
  for (const callback of [...closeCallbacks]) callback(event);
}

export function emitVirtualContainerItemChange(event) {
  for (const callback of [...itemChangeCallbacks]) callback(event);
}

export function emitChatSend(message, sender) {
  const event = { message, sender, cancel: false };
  for (const callback of [...chatSendCallbacks]) callback(event);
  return event;
}

export const system = {
  beforeEvents: {
    shutdown: {
      subscribe(callback) {
        shutdownCallbacks.add(callback);
        return callback;
      },
      unsubscribe(callback) {
        shutdownCallbacks.delete(callback);
      },
    },
  },
  run(callback) {
    scheduledRuns.push(callback);
    return scheduledRuns.length;
  },
};

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
  beforeEvents: {
    chatSend: {
      subscribe(callback) {
        chatSendCallbacks.add(callback);
        return callback;
      },
      unsubscribe(callback) {
        chatSendCallbacks.delete(callback);
      },
    },
  },
  virtualContainerManager: {
    create(options) {
      const container = {
        size: options.size,
        title: options.title ?? "",
        items: new Array(options.size).fill(undefined),
        opened: false,
        closed: false,
        openPlayers: [],
        closedPlayers: [],
        setItem(slot, item) {
          this.items[slot] = item;
        },
        getItem(slot) {
          return this.items[slot];
        },
        open(player) {
          this.opened = true;
          this.openPlayers.push(player);
        },
        close(player) {
          this.closed = true;
          this.closedPlayers.push(player);
        },
      };
      createdContainers.push(container);
      return container;
    },
  },
  afterEvents: {
    entityDie: {
      subscribe(callback) {
        entityDieCallbacks.add(callback);
        return callback;
      },
      unsubscribe(callback) {
        entityDieCallbacks.delete(callback);
      },
    },
    playerLeave: {
      subscribe(callback) {
        playerLeaveCallbacks.add(callback);
        return callback;
      },
      unsubscribe(callback) {
        playerLeaveCallbacks.delete(callback);
      },
    },
    virtualContainerClose: {
      subscribe(callback) {
        closeCallbacks.add(callback);
        return callback;
      },
      unsubscribe(callback) {
        closeCallbacks.delete(callback);
      },
    },
    virtualContainerItemChange: {
      subscribe(callback) {
        itemChangeCallbacks.add(callback);
        return callback;
      },
      unsubscribe(callback) {
        itemChangeCallbacks.delete(callback);
      },
    },
  },
};
`;

const mockUrl = `data:text/javascript;base64,${Buffer.from(mockSource).toString("base64")}`;
// Same double without the playerLeave signal, for the fail-closed feature test.
// Window is imported with a `?no-player-leave` suffix so this signal-less world
// is used by a fresh module instance.
const noPlayerLeaveSource = mockSource.replace(
  /    playerLeave: \{[\s\S]*?\n    \},\n/,
  "",
);
const noPlayerLeaveUrl = `data:text/javascript;base64,${Buffer.from(noPlayerLeaveSource).toString("base64")}`;
// Same double without system.beforeEvents.shutdown, for the fail-closed test.
const noShutdownSource = mockSource.replace(
  /  beforeEvents: \{\n    shutdown: \{[\s\S]*?\n    \},\n  \},\n/,
  "",
);
const noShutdownUrl = `data:text/javascript;base64,${Buffer.from(noShutdownSource).toString("base64")}`;
// The shutdown latch is permanent per Window module instance, so a shutdown
// test must emit into its own double: the shared double would latch every
// already-loaded module (including the default one) and break any test that
// ran after it. Each `?shutdown-<name>` module instance gets its own copy.
const shutdownMockUrls = new Map();
function shutdownMockUrl(tag) {
  let url = shutdownMockUrls.get(tag);
  if (!url) {
    url = `data:text/javascript;base64,${Buffer.from(`${mockSource}\n// ${tag}`).toString("base64")}`;
    shutdownMockUrls.set(tag, url);
  }
  return url;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
      const parentUrl = context.parentURL ?? "";
      const shutdownTag = /[?&](shutdown-[a-z-]+)/.exec(parentUrl)?.[1];
      return {
        url: parentUrl.includes("no-player-leave")
          ? noPlayerLeaveUrl
          : parentUrl.includes("no-shutdown")
            ? noShutdownUrl
            : shutdownTag
              ? shutdownMockUrl(shutdownTag)
              : mockUrl,
        shortCircuit: true,
      };
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
const {
  createdContainers,
  emitChatSend,
  emitEntityDie,
  emitPlayerLeave,
  emitVirtualContainerClose,
  emitVirtualContainerItemChange,
  scheduledRuns,
} = await import(mockUrl);

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
  failClose = false;
  failSubscribeClose = false;
  failSubscribeItemChange = false;
  failUnsubscribe = false;
  reentrantClose = false;
  closeOnOpen = false;
  itemChangeOnOpen = false;

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
    if (this.itemChangeOnOpen) {
      // The screen can report the change synchronously while the Window is
      // still `opening`, after the player already took the display item.
      container.items[0] = undefined;
      this.emitItemChange({ container, player: viewer, slot: 0 });
    }
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
    if (this.failClose) {
      throw new Error("close failed");
    }
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
  // `clone` keeps the object a valid Base ItemStack: a placeholder must be
  // cloneable so it can be copied instead of shared by reference.
  return { typeId, amount, clone: () => stack(typeId, amount) };
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

/** Test adapter whose containers log every physical slot the Window writes. */
function writeCountingAdapter() {
  const adapter = new InMemoryTestAdapter();
  const createContainer = adapter.createContainer.bind(adapter);
  adapter.createContainer = (options) => {
    const container = createContainer(options);
    container.writes = [];
    const setItem = container.setItem.bind(container);
    container.setItem = (slot, item) => {
      container.writes.push(slot);
      setItem(slot, item);
    };
    return container;
  };
  return adapter;
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

test("real adapter opens and closes screens through VirtualContainer.open/close", async () => {
  const adapter = new MinecraftVirtualContainerAdapter();
  assert.equal(adapter.canOpenScreens, true);
  assert.equal(minecraftVirtualContainerAdapter.canOpenScreens, true);

  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .build();

  const before = createdContainers.length;
  await window.open();
  assert.equal(window.status, "open");
  assert.equal(createdContainers.length, before + 1);
  const container = window.container;
  assert.equal(createdContainers.at(-1), container);
  assert.equal(container.opened, true);
  assert.deepEqual(container.openPlayers, [player]);

  window.close("PlayerClosed");
  assert.equal(container.closed, true);
  assert.deepEqual(container.closedPlayers, [player]);
});

test("Window.open rejects an adapter that has not opted into screens", async () => {
  const gui = Gui.normal({ structure: ["a"] });
  let created = 0;
  const adapter = {
    canOpenScreens: false,
    createContainer() {
      created += 1;
      return {};
    },
    openContainer() {},
    closeContainer() {},
  };

  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await assert.rejects(
    () => window.open(),
    (error) =>
      error instanceof WindowOpenRejectedError &&
      error.code === "INVUI_WINDOW_OPEN_UNVERIFIED",
  );
  assert.equal(window.status, "created");
  assert.equal(created, 0);
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

test("real adapter forwards virtual container events and unsubscribes", () => {
  const adapter = new MinecraftVirtualContainerAdapter();
  const closeEvents = [];
  const itemChangeEvents = [];
  const container = adapter.createContainer({ size: 9 });
  const viewer = { id: "p3", name: "EventViewer" };

  const unsubscribeClose = adapter.subscribeClose((event) => closeEvents.push(event));
  const unsubscribeItemChange = adapter.subscribeItemChange((event) =>
    itemChangeEvents.push(event),
  );

  emitVirtualContainerClose({ container, player: viewer, reason: "PlayerDied" });
  emitVirtualContainerClose({ container, player: viewer, reason: "UserBusy" });
  emitVirtualContainerItemChange({ container, player: viewer, slot: 4 });

  assert.deepEqual(closeEvents, [
    { container, player: viewer, reason: "PlayerDied" },
    { container, player: viewer, reason: "UserBusy" },
  ]);
  assert.deepEqual(itemChangeEvents, [{ container, player: viewer, slot: 4 }]);

  unsubscribeClose();
  unsubscribeItemChange();
  emitVirtualContainerClose({ container, player: viewer, reason: "ServerClosed" });
  emitVirtualContainerItemChange({ container, player: viewer, slot: 5 });
  assert.equal(closeEvents.length, 2);
  assert.equal(itemChangeEvents.length, 1);
  // Subscribing to the hooks must not change the default opt-in.
  assert.equal(adapter.canOpenScreens, true);
});

test("Window consumes the real adapter's event hooks", async () => {
  const adapter = new MinecraftVirtualContainerAdapter();
  // Keep the real event hooks; replace only the screen calls so the test never
  // needs a game. This instance stays separate from the production singleton.
  const opened = [];
  const closed = [];
  adapter.openContainer = (container, viewer) => {
    opened.push({ container, viewer });
  };
  adapter.closeContainer = (container, viewer) => {
    closed.push({ container, viewer });
  };

  const closeReasons = [];
  const errors = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  assert.equal(opened.length, 1);

  emitVirtualContainerClose({
    container: window.container,
    player: otherPlayer,
    reason: "PlayerClosed",
  });
  emitVirtualContainerClose({ container: {}, player, reason: "PlayerClosed" });
  assert.equal(window.status, "open", "events for another player or container are ignored");

  emitVirtualContainerItemChange({ container: window.container, player, slot: 0 });
  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.deepEqual(
    errors.map(({ context }) => context.operation),
    ["itemChange"],
  );
  assert.ok(errors[0].error instanceof WindowItemChangeDangerError);
  assert.equal(errors[0].context.slot, 0);
  assert.equal(closed.length, 1);
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

test("a pending provider with a placeholder renders it without delaying open", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = deferred();
  const item = Item.simple(() => pending.promise).setPlaceholder(
    stack("minecraft:loading"),
  );
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  const opening = window.open();
  await tick();
  assert.equal(window.status, "open", "open must not wait for the provider");
  await opening;
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:loading");

  pending.resolve(stack("minecraft:loaded"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:loaded");
  window.close();
});

test("a placeholder render discards an older pending provider result", async () => {
  const adapter = new InMemoryTestAdapter();
  const requests = [];
  const item = Item.simple(
    () =>
      new Promise((resolve) => {
        requests.push(resolve);
      }),
  ).setPlaceholder(stack("minecraft:loading"));
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:loading");
  assert.equal(requests.length, 1);

  // A refresh starts a newer render batch while the first request is pending.
  await window.refresh();
  assert.equal(requests.length, 2);
  assert.equal(container.items[0].typeId, "minecraft:loading");

  requests[0](stack("minecraft:stale"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:loading");

  requests[1](stack("minecraft:fresh"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:fresh");
  window.close();
});

test("a pending placeholder provider result after close is not written", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = deferred();
  const item = Item.simple(() => pending.promise).setPlaceholder(
    stack("minecraft:loading"),
  );
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:loading");

  window.close();
  pending.resolve(stack("minecraft:late"));
  await tick();

  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 1);
  assert.equal(container.items[0].typeId, "minecraft:loading");
});

test("a rejected pending placeholder provider is reported, not unhandled", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const pending = deferred();
  const item = Item.simple(() => pending.promise).setPlaceholder(
    stack("minecraft:loading"),
  );
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:loading");

  const failure = new Error("provider failed");
  pending.reject(failure);
  await tick();

  assert.equal(container.items[0].typeId, "minecraft:loading");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, failure);
  assert.equal(errors[0].context.operation, "itemProvider");
  assert.equal(errors[0].context.slot, 0);
  window.close();
});

test("a stale pending placeholder rejection is not reported to the reopened screen", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const pending = deferred();
  let calls = 0;
  const item = Item.simple(() => {
    calls += 1;
    return calls === 1 ? pending.promise : stack("minecraft:loaded");
  }).setPlaceholder(stack("minecraft:loading"));
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  window.close();
  await window.open();
  const container = adapter.containers[1];
  assert.equal(container.items[0].typeId, "minecraft:loaded");

  pending.reject(new Error("provider failed"));
  await tick();

  assert.deepEqual(errors, [], "the closed generation must not report into the new one");
  assert.equal(window.status, "open");
  assert.equal(adapter.closed.length, 1);
  window.close();
});

test("a stale awaited provider rejection is not reported to the reopened screen", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const pending = deferred();
  let calls = 0;
  const item = Item.simple(() => {
    calls += 1;
    if (calls === 1) {
      return stack("minecraft:initial");
    }
    return calls === 2 ? pending.promise : stack("minecraft:reopened");
  });
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  // No placeholder: the refresh awaits the provider while the window is closed.
  item.notifyWindows();
  await tick();
  window.close();
  await window.open();
  const container = adapter.containers[1];
  assert.equal(container.items[0].typeId, "minecraft:reopened");

  pending.reject(new Error("provider failed"));
  await tick();

  assert.deepEqual(errors, []);
  assert.equal(window.status, "open");
  window.close();
});

test("a synchronous thenable result is written after the placeholder", async () => {
  const adapter = new InMemoryTestAdapter();
  const item = Item.simple(() => stack("minecraft:ignored"));
  // A custom thenable may call its callback synchronously; the placeholder must
  // not be written over the result it delivered.
  item.resolveForDisplay = () => ({
    stack: stack("minecraft:loading"),
    placeholder: true,
    pending: {
      then(onFulfilled) {
        onFulfilled(stack("minecraft:loaded"));
        return Promise.resolve();
      },
    },
  });
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  assert.equal(adapter.containers[0].items[0].typeId, "minecraft:loaded");
  window.close();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs the callbacks Window's automatic chat bridge queued through system.run.
 * The bridge dispatch itself is async, so give the state queue a few turns.
 */
async function flushChatInput() {
  for (const callback of scheduledRuns.splice(0)) {
    callback();
  }
  await tick();
  await tick();
  await tick();
}

/**
 * Sends a chat notification naming the Window's current open session after the
 * default repeat-limit gap, so tests about routing are not rate-limited.
 */
async function sendChat(window, slot, sequence, sender = { id: window.viewer.id }) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  return emitChatSend(`!invui:${window._inputSessionId}:${slot}:${sequence}`, sender);
}

/** Window with one button at logical slot 1 (structure "ab"). */
function chatButtonWindow(viewer, clicks, options = {}) {
  const adapter = new InMemoryTestAdapter();
  const button = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(async (click) => {
      clicks.push(click.slot);
      if (options.onClick) {
        await options.onClick(click);
      }
    })
    .build();
  return Window.builder()
    .setViewer(viewer)
    .setUpperGui(Gui.normal({ structure: ["ab"], ingredients: { b: button } }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();
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

test("state notifications in the same timing share one refresh", async () => {
  const adapter = new InMemoryTestAdapter();
  const seen = [];
  let window;
  const item = Item.simple(() => {
    seen.push(window.getState().page);
    return stack("minecraft:item");
  });
  window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  seen.length = 0;

  // One timing, three notifications: only the final state is rendered (design
  // 11.2 step 3), not one render per notification.
  window.setState({ page: 1 });
  window.setState({ page: 2 });
  window.setState({ page: 3 });
  await tick();

  assert.deepEqual(seen, [3]);
  window.close();
});

test("an in-flight provider result is discarded when the state notification arrives", async () => {
  const adapter = new InMemoryTestAdapter();
  const pending = [];
  let phase = "initial";
  const item = Item.simple(() =>
    phase === "initial"
      ? stack("minecraft:initial")
      : new Promise((resolve) => pending.push(resolve)),
  );
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];

  phase = "async";
  item.notifyWindows();
  await tick();
  assert.equal(pending.length, 1);

  // The stale result is resolved before the coalesced refresh microtask runs.
  // It must already be invalid at notification time, not only once the batched
  // refresh starts.
  pending[0](stack("minecraft:stale"));
  window.setState({ page: 1 });
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:initial");
  assert.equal(pending.length, 2, "the coalesced refresh starts a fresh render");

  pending[1](stack("minecraft:fresh"));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:fresh");
  window.close();
});

test("a state change queued in the same timing as close does not render after close", async () => {
  const adapter = new InMemoryTestAdapter();
  let calls = 0;
  const item = Item.simple(() => {
    calls += 1;
    return stack("minecraft:item");
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  calls = 0;

  window.setState({ page: 1 });
  window.close();
  await tick();

  assert.equal(calls, 0, "the queued refresh belongs to the closed generation");
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

test("a same-size upper GUI swap re-renders and moves subscriptions", async () => {
  const adapter = new InMemoryTestAdapter();
  const oldItem = Item.simple(() => stack("minecraft:old"));
  const newItem = Item.simple(() => stack("minecraft:new"));
  const oldGui = Gui.normal({ structure: ["a"], ingredients: { a: oldItem } });
  const newGui = Gui.normal({ structure: ["a"], ingredients: { a: newItem } });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(oldGui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:old");

  const setItem = container.setItem.bind(container);
  let writes = 0;
  container.setItem = (slot, item) => {
    writes += 1;
    setItem(slot, item);
  };

  window.setUpperGui(newGui);
  await tick();
  assert.equal(window.upperGui, newGui);
  assert.equal(container.items[0].typeId, "minecraft:new");
  assert.equal(adapter.containers.length, 1, "the screen must be kept");

  writes = 0;
  oldItem.notifyWindows();
  await tick();
  assert.equal(writes, 0, "the old element subscription must be gone");
  newItem.notifyWindows();
  await tick();
  assert.ok(writes > 0, "the new element must be subscribed");

  writes = 0;
  oldGui.setIngredient("a", Item.simple(() => stack("minecraft:old_2")));
  await tick();
  assert.equal(writes, 0, "the old GUI subscription must be gone");
  assert.equal(container.items[0].typeId, "minecraft:new");

  newGui.setIngredient("a", Item.simple(() => stack("minecraft:new_2")));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:new_2");
  window.close();
});

test("an upper GUI swap that changes the size is refused and reported", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const oldGui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:old")) },
  });
  const bigger = Gui.normal({
    structure: ["a", "b"],
    ingredients: { b: Item.simple(() => stack("minecraft:b")) },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(oldGui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const container = adapter.containers[0];

  window.setUpperGui(bigger);
  await tick();

  assert.equal(window.status, "open");
  assert.equal(window.container, container);
  assert.equal(window.upperGui, oldGui);
  assert.equal(adapter.containers.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /layout size changed/);
  assert.equal(errors[0].context.operation, "guiChange");
  assert.equal(container.items[0].typeId, "minecraft:old");

  // The refused swap must leave the previous GUI and its subscriptions intact.
  oldGui.setIngredient("a", Item.simple(() => stack("minecraft:still_old")));
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:still_old");
  window.close();
});

test("an upper GUI swap with a different state schema fails closed", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  const oldGui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:old")) },
  });
  const paged = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [Item.simple(() => stack("minecraft:paged"))],
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(oldGui)
    .setStateManager(new StateManager())
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();

  window.setUpperGui(paged);
  await tick();

  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.equal(window.upperGui, oldGui);
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof WindowStateSchemaChangedError);
  assert.equal(errors[0].context.operation, "guiChange");
});

test("a refused upper GUI swap whose error handler reopens keeps the new generation", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  let reopened;
  let reopening = false;
  const oldGui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:old")) },
  });
  const bigger = Gui.normal({
    structure: ["a", "b"],
    ingredients: { b: Item.simple(() => stack("minecraft:b")) },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(oldGui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => {
      errors.push({ error, context });
      if (context.operation !== "guiChange" || reopening) {
        return;
      }
      reopening = true;
      window.close("PlayerClosed");
      reopened = window.open();
    })
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];

  window.setUpperGui(bigger);
  await reopened;

  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /layout size changed/);
  assert.equal(window.status, "open");
  assert.equal(window.container, adapter.containers[1]);
  assert.notEqual(window.container, firstContainer);
  assert.equal(window.upperGui, oldGui, "the rejected GUI must not win over the reopen");
  assert.equal(adapter.containers.length, 2);
  assert.equal(adapter.opened.length, 2);
  assert.equal(adapter.closed.length, 1);

  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
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

test("a close event while opening before the screen is requested still notifies once", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  const openHandlerCalls = [];
  const pending = deferred();
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => pending.promise) },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addOpenHandler(() => openHandlerCalls.push("open"))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  const opening = window.open();
  await tick();
  const container = adapter.containers[0];
  assert.ok(container, "the container exists before the screen is requested");
  assert.equal(adapter.opened.length, 0);

  // The screen was never requested, so no adapter close is sent, but the
  // reason must not be lost on the way to the close handlers.
  adapter.emitClose({ container, player, reason: "PlayerDied" });
  pending.resolve(stack("minecraft:late"));
  await opening;

  // A resolved open() only means it stopped opening; the caller must check
  // status because the Window closed during opening.
  assert.equal(window.status, "closed");
  assert.equal(window.isOpen, false);
  assert.equal(window.container, undefined);
  assert.deepEqual(openHandlerCalls, []);
  assert.deepEqual(closeReasons, ["PlayerDied"]);
  assert.equal(adapter.closed.length, 0);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );

  // Duplicate/delayed delivery after teardown must not notify again.
  adapter.emitClose({ container, player, reason: "ServerClosed" }, true);
  assert.deepEqual(closeReasons, ["PlayerDied"]);
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

test("an itemChange dispatched during openContainer halts rendering and closes", async () => {
  const adapter = new InMemoryTestAdapter();
  adapter.itemChangeOnOpen = true;
  const errors = [];
  const closeReasons = [];
  const openHandlers = [];
  let typeId = "minecraft:display";
  const item = Item.simple(() => stack(typeId));
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addOpenHandler(() => openHandlers.push("open"))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();

  // The event arrived while the Window was still `opening`; ignoring it would
  // let the next render pass put the taken item back (a duplicate).
  const container = adapter.containers[0];
  assert.equal(window.status, "closed");
  assert.equal(window.isOpen, false);
  assert.equal(window.container, undefined);
  assert.deepEqual(openHandlers, []);
  assert.equal(container.items[0], undefined);
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.closed.length, 1);
  assert.equal(adapter.closed[0].container, container);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof WindowItemChangeDangerError);
  assert.equal(errors[0].error.slot, 0);
  assert.equal(errors[0].context.operation, "itemChange");
  assert.deepEqual(
    adapter.itemChangeSubscriptions.map((record) => record.active),
    [false],
  );

  // A later refresh or item notification must not resurrect the taken item.
  typeId = "minecraft:again";
  await window.refresh();
  item.notifyWindows();
  await tick();
  await tick();
  assert.equal(container.items[0], undefined);
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.closed.length, 1);
});

test("an itemChange error handler that closes and reopens keeps the new open", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  let reopened;
  let reopening = false;
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:display")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => {
      errors.push({ error, context });
      if (context.operation !== "itemChange" || reopening) {
        return;
      }
      reopening = true;
      window.close("PlayerClosed");
      reopened = window.open();
    })
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];

  adapter.emitItemChange({ container: firstContainer, player, slot: 0 });
  await reopened;

  // The event belonged to the closed generation: the reopened screen keeps
  // running and the close handlers saw only the handler's own close.
  assert.equal(errors.length, 1);
  assert.equal(window.status, "open");
  assert.equal(window.container, adapter.containers[1]);
  assert.notEqual(window.container, firstContainer);
  assert.equal(adapter.opened.length, 2);
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);

  // The new generation still closes normally.
  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 2);
  assert.deepEqual(closeReasons, ["PlayerClosed", "PlayerClosed"]);
});

test("a schema failure whose error handler reopens does not close the new generation", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  let reopened;
  let reopening = false;
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:before")) },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => {
      errors.push({ error, context });
      if (context.operation !== "guiChange" || reopening) {
        return;
      }
      reopening = true;
      window.close("PlayerClosed");
      reopened = window.open();
    })
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];

  // A GuiLink ingredient belongs to the state schema: the open fails closed.
  gui.setIngredient(
    "a",
    new GuiLink(Gui.normal({ structure: ["x"] }), { key: "child" }),
  );
  await reopened;

  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof WindowStateSchemaChangedError);
  assert.equal(errors[0].context.operation, "guiChange");
  assert.equal(window.status, "open");
  assert.equal(window.container, adapter.containers[1]);
  assert.notEqual(window.container, firstContainer);
  assert.equal(adapter.opened.length, 2);
  assert.equal(adapter.closed.length, 1);
  assert.deepEqual(closeReasons, ["PlayerClosed"]);

  // The adopted shape keeps its state: writes go through the new handle.
  window.setState({ page: 1 });
  assert.equal(window.getState().page, 1);
  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["PlayerClosed", "PlayerClosed"]);
});

test("a close handler that reopens stops the remaining handlers from closing the new generation", async () => {
  const adapter = new InMemoryTestAdapter();
  const calls = [];
  let reopen = true;
  let reopened;
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => {
      calls.push(`first:${reason}`);
      if (reopen) {
        reopen = false;
        reopened = window.open();
      }
    })
    .addCloseHandler((reason) => {
      // Belongs to the closed generation; running it would close the screen
      // the previous handler just reopened.
      calls.push(`second:${reason}`);
      window.close("ServerClosed");
    })
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];

  window.close("PlayerClosed");
  await reopened;

  assert.deepEqual(calls, ["first:PlayerClosed"]);
  assert.equal(window.status, "open");
  assert.equal(window.container, adapter.containers[1]);
  assert.notEqual(window.container, firstContainer);
  assert.equal(adapter.opened.length, 2);
  assert.equal(adapter.closed.length, 1);

  // The reopened generation still closes and notifies normally.
  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.deepEqual(calls, [
    "first:PlayerClosed",
    "first:PlayerClosed",
    "second:PlayerClosed",
  ]);
  assert.equal(adapter.closed.length, 2);
});

test("a throwing close handler that reopened does not report its stale error to the new generation", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  let handlerRuns = 0;
  let reopened;
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => {
      errors.push({ error, context });
      // Delivering an exception from the closed generation here would tear
      // down the screen that the failing handler just reopened.
      window.close("ServerClosed");
    })
    .addCloseHandler(() => {
      handlerRuns += 1;
      if (handlerRuns === 1) {
        reopened = window.open();
        throw new Error("close handler failed");
      }
    })
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];

  window.close("PlayerClosed");
  await reopened;

  assert.deepEqual(errors, []);
  assert.equal(window.status, "open");
  assert.equal(window.container, adapter.containers[1]);
  assert.notEqual(window.container, firstContainer);
  assert.equal(adapter.opened.length, 2);
  assert.equal(adapter.closed.length, 1);

  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.equal(handlerRuns, 2);
});

test("a close failure whose error handler closes and reopens keeps the new open", async () => {
  const adapter = new InMemoryTestAdapter();
  adapter.failClose = true;
  const errors = [];
  const closeReasons = [];
  let reopened;
  let reopening = false;
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:display")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => {
      errors.push({ error, context });
      if (context.operation !== "close" || reopening) {
        return;
      }
      reopening = true;
      window.close("PlayerClosed");
      reopened = window.open();
    })
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];

  window.close("PlayerClosed");
  await reopened;

  assert.equal(errors[0].error.message, "close failed");
  assert.equal(errors[0].context.operation, "close");
  // The failed close belonged to the old generation: its teardown must not
  // destroy the screen the handler just opened.
  assert.equal(window.status, "open");
  assert.equal(window.container, adapter.containers[1]);
  assert.notEqual(window.container, firstContainer);
  assert.equal(adapter.opened.length, 2);
  assert.ok(
    adapter.closed.every(({ container }) => container === firstContainer),
    "the old teardown must not close the new generation's screen",
  );
  assert.deepEqual(closeReasons, ["PlayerClosed"]);

  // The reopened generation's state handle is still live.
  window.setState({ page: 1 });
  assert.equal(window.getState().page, 1);

  window.close("PlayerClosed");
  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["PlayerClosed", "PlayerClosed"]);
});

test("a re-render clears an occupied slot but skips clearing an already empty one", async () => {
  const adapter = writeCountingAdapter();
  let iconCalls = 0;
  let emptyCalls = 0;
  const gui = Gui.normal({
    structure: ["ab"],
    ingredients: {
      a: Item.simple(() => {
        iconCalls += 1;
        return stack("minecraft:icon");
      }),
      b: Item.simple(() => {
        emptyCalls += 1;
        return undefined;
      }),
    },
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:icon");
  assert.equal(container.items[1], undefined);
  assert.deepEqual(container.writes, [0, 1]);

  container.writes.length = 0;
  await window.refresh();

  // Both providers are still evaluated, so no display data is withheld; only
  // the write that would clear an already empty slot is skipped.
  assert.equal(iconCalls, 2);
  assert.equal(emptyCalls, 2);
  assert.deepEqual(container.writes, [0]);
  assert.equal(container.items[0].typeId, "minecraft:icon");
  assert.equal(container.items[1], undefined);
  window.close();
});

test("a failed setItem is retried instead of being recorded as cleared", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const attempts = [];
  let failNext = true;
  const createContainer = adapter.createContainer.bind(adapter);
  adapter.createContainer = (options) => {
    const container = createContainer(options);
    const setItem = container.setItem.bind(container);
    container.setItem = (slot, item) => {
      attempts.push(slot);
      if (failNext) {
        failNext = false;
        throw new Error("setItem failed");
      }
      setItem(slot, item);
    };
    return container;
  };
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  assert.deepEqual(attempts, [0]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.message, "setItem failed");
  assert.equal(errors[0].context.operation, "setItem");

  // The failed write was never recorded, so the next pass retries it.
  await window.refresh();
  assert.deepEqual(attempts, [0, 0]);

  // Only a write that returned is recorded: now the clear is skipped.
  await window.refresh();
  assert.deepEqual(attempts, [0, 0]);
  assert.equal(adapter.containers[0].items[0], undefined);
  window.close();
});

test("closing and reopening writes the new container's empty slots again", async () => {
  const adapter = writeCountingAdapter();
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const first = adapter.containers[0];
  assert.deepEqual(first.writes, [0]);

  first.writes.length = 0;
  await window.refresh();
  assert.deepEqual(first.writes, [], "an already cleared slot is skipped");

  window.close();
  await window.open();
  const reopened = adapter.containers[1];
  assert.notEqual(reopened, first);
  assert.deepEqual(reopened.writes, [0], "the cache must not outlive its container");
  window.close();
});

test("a stale async empty result does not record the slot as cleared", async () => {
  const adapter = writeCountingAdapter();
  const pending = [];
  let mode = "stack";
  const item = Item.simple(() => {
    if (mode === "pending") {
      return new Promise((resolve) => pending.push(resolve));
    }
    return mode === "empty" ? undefined : stack("minecraft:icon");
  });
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const container = adapter.containers[0];
  assert.equal(container.items[0].typeId, "minecraft:icon");

  mode = "pending";
  const stale = window.refresh();
  await tick();
  assert.equal(pending.length, 1);

  // A newer pass writes a stack while the older provider is still pending.
  mode = "stack";
  window.setState({ page: 1 });
  await tick();
  assert.equal(container.items[0].typeId, "minecraft:icon");

  // The stale result resolves empty. It belongs to an older render generation
  // and must not leave the slot recorded as cleared.
  pending[0](undefined);
  await stale;
  await tick();

  mode = "empty";
  container.writes.length = 0;
  await window.refresh();
  assert.deepEqual(container.writes, [0], "the current empty render must still write");
  assert.equal(container.items[0], undefined);
  window.close();
});

test("an itemChange from another viewer invalidates the write cache", async () => {
  const adapter = writeCountingAdapter();
  const errors = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const container = adapter.containers[0];
  container.writes.length = 0;
  await window.refresh();
  assert.deepEqual(container.writes, []);

  // This Window ignores another viewer's screen change and keeps rendering,
  // so it must stop trusting what it recorded about the slots.
  adapter.emitItemChange({ container, player: otherPlayer, slot: 0 });
  assert.equal(window.status, "open");
  assert.deepEqual(errors, []);

  await window.refresh();
  assert.deepEqual(container.writes, [0]);
  window.close();
});

test("changing the title while open regenerates the container without re-running handlers", async () => {
  const adapter = new InMemoryTestAdapter();
  let opened = 0;
  const closeReasons = [];
  const errors = [];
  const item = Item.simple(() => stack("minecraft:item"));
  const gui = Gui.normal({ structure: ["a"], ingredients: { a: item } });
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(gui)
    .setStateManager(new StateManager())
    .setStateLifetime("session")
    .setContainerAdapter(adapter)
    .addOpenHandler(() => opened++)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const first = adapter.containers[0];
  assert.equal(first.title, "Old title");
  window.setState({ selection: "kept" });

  await window.setTitle("New title");

  assert.equal(window.status, "open");
  assert.equal(window.title, "New title");
  assert.equal(adapter.containers.length, 2, "the title needs a new VirtualContainer");
  const second = adapter.containers[1];
  assert.notEqual(second, first);
  assert.equal(window.container, second);
  assert.equal(second.title, "New title");
  assert.equal(second.size, first.size);
  assert.equal(second.items[0].typeId, "minecraft:item", "the new container is rendered before it is shown");

  assert.deepEqual(
    adapter.closed.map((entry) => entry.container),
    [first],
    "the previous screen is closed exactly once",
  );
  assert.deepEqual(
    adapter.opened.map((entry) => entry.container),
    [first, second],
  );
  assert.equal(opened, 1, "an internal reopen is not a new open");
  assert.deepEqual(closeReasons, [], "an internal reopen is not a close");
  assert.deepEqual(errors, []);
  assert.equal(window.getState().selection, "kept", "state survives the internal reopen");

  window.setState({ selection: "after" });
  await tick();
  assert.equal(second.items[0].typeId, "minecraft:item");
  window.close("PlayerClosed");
  assert.deepEqual(closeReasons, ["PlayerClosed"]);
  assert.equal(adapter.closed.length, 2);
});

test("setTitle before open only applies to the next open", async () => {
  const adapter = new InMemoryTestAdapter();
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .build();

  await window.setTitle("Next title");
  assert.equal(window.title, "Next title");
  assert.equal(adapter.containers.length, 0);

  await window.open();
  assert.equal(adapter.containers[0].title, "Next title");
  window.close();
});

test("a title set without awaiting is used by the immediately following open", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  const changing = window.setTitle("New title");
  // No await: the title must already be stored when open() creates the
  // container, and the queued change must not reject against "opening".
  await window.open();
  await changing;

  assert.equal(window.status, "open");
  assert.equal(window.title, "New title");
  assert.equal(adapter.containers[0].title, "New title");
  assert.deepEqual(errors, []);
  window.close();
});

test("an older queued title does not overwrite a newer one stored while closed", async () => {
  const adapter = new InMemoryTestAdapter();
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const queued = window.setTitle("Queued");
  window.close();
  window.setTitle("Latest");

  await window.open();
  await queued;

  assert.equal(window.status, "open");
  assert.equal(window.title, "Latest");
  assert.equal(adapter.containers.at(-1).title, "Latest");
  window.close();
});

test("a failed title regeneration keeps the old container and title", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const createContainer = adapter.createContainer.bind(adapter);
  let createCalls = 0;
  adapter.createContainer = (options) => {
    createCalls += 1;
    if (createCalls > 1) {
      throw new Error("create failed");
    }
    return createContainer(options);
  };
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .build();

  await window.open();
  const first = adapter.containers[0];

  await assert.rejects(window.setTitle("New title"), /create failed/);
  assert.equal(window.status, "open");
  assert.equal(window.title, "Old title");
  assert.equal(window.container, first);
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.closed.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.operation, "titleChange");
  window.close();
});

test("setTitle while opening is rejected instead of showing a stale title", async () => {
  const adapter = new InMemoryTestAdapter();
  let resolveProvider;
  const item = Item.simple(
    () => new Promise((resolve) => { resolveProvider = resolve; }),
  );
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .build();

  const opening = window.open();
  await tick();
  assert.equal(window.status, "opening");
  await assert.rejects(window.setTitle("New title"), /while opening/);

  resolveProvider(stack("minecraft:item"));
  await opening;

  assert.equal(window.status, "open");
  assert.equal(window.title, "Old title");
  assert.equal(adapter.containers[0].title, "Old title");
  window.close();
});

test("overlapping title changes are serialized and never leak the old screen", async () => {
  const adapter = new InMemoryTestAdapter();
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old")
    .setUpperGui(Gui.normal({ structure: ["a"] }))
    .setContainerAdapter(adapter)
    .build();

  await window.open();
  const first = adapter.containers[0];

  const one = window.setTitle("One");
  const two = window.setTitle("Two");
  await Promise.all([one, two]);

  assert.equal(window.status, "open");
  assert.equal(window.title, "Two");
  assert.deepEqual(
    adapter.containers.map((container) => container.title),
    ["Old", "One", "Two"],
  );
  assert.deepEqual(
    adapter.closed.map((entry) => entry.container.title),
    ["Old", "One"],
    "each regenerated screen is closed before the next one replaces it",
  );
  assert.deepEqual(
    adapter.opened.map((entry) => entry.container.title),
    ["Old", "One", "Two"],
  );
  assert.equal(window.container, adapter.containers[2]);
  assert.notEqual(window.container, first);
  window.close();
});

test("an itemChange on the old screen during a title regeneration fails closed", async () => {
  const adapter = new InMemoryTestAdapter();
  const errors = [];
  const closeReasons = [];
  const pending = [];
  let async = false;
  const item = Item.simple(() =>
    async ? new Promise((resolve) => pending.push(resolve)) : stack("minecraft:item"),
  );
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler((error, context) => errors.push({ error, context }))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const first = adapter.containers[0];

  // The replacement is still rendering, so the old screen is still the one the
  // player can touch; `window.container` already points at the replacement.
  async = true;
  const changing = window.setTitle("New title");
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(window.container, adapter.containers[1]);

  adapter.emitItemChange({ container: first, player, slot: 0 });

  assert.equal(window.status, "closed");
  assert.ok(errors[0].error instanceof WindowItemChangeDangerError);
  assert.equal(errors[0].context.operation, "itemChange");
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.deepEqual(
    adapter.closed.map((entry) => entry.container),
    [first],
    "the still-shown old screen is closed",
  );
  assert.deepEqual(adapter.opened.map((entry) => entry.container), [first]);

  pending[0](stack("minecraft:item"));
  await changing;
  assert.equal(window.status, "closed");
  window.close();
});

test("a close event from the old screen during a title regeneration closes the Window", async () => {
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const pending = [];
  let async = false;
  const item = Item.simple(() =>
    async ? new Promise((resolve) => pending.push(resolve)) : stack("minecraft:item"),
  );
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const first = adapter.containers[0];

  async = true;
  const changing = window.setTitle("New title");
  await tick();

  adapter.emitClose({ container: first, player, reason: "PlayerClosed" });

  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["PlayerClosed"], "the player's close is not lost");
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(
    adapter.opened.map((entry) => entry.container),
    [first],
    "the replacement screen is never shown after the player closed the old one",
  );

  pending[0](stack("minecraft:item"));
  await changing;
  assert.equal(window.status, "closed");
});

test("closing during a title regeneration closes the shown old screen", async () => {
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const pending = [];
  let async = false;
  const item = Item.simple(() =>
    async ? new Promise((resolve) => pending.push(resolve)) : stack("minecraft:item"),
  );
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Old title")
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  await window.open();
  const first = adapter.containers[0];

  async = true;
  const changing = window.setTitle("New title");
  await tick();
  assert.equal(window.container, adapter.containers[1]);

  window.close("PlayerClosed");

  assert.equal(window.status, "closed");
  assert.deepEqual(closeReasons, ["PlayerClosed"]);
  assert.deepEqual(
    adapter.closed.map((entry) => entry.container),
    [first],
    "the visible old screen is closed, not the replacement that was never shown",
  );
  assert.deepEqual(adapter.opened.map((entry) => entry.container), [first]);

  pending[0](stack("minecraft:item"));
  await changing;
  assert.equal(window.status, "closed");
});

test("an open Window auto-connects chatSend to its own button slot", async () => {
  const viewer = { id: "chat-auto", name: "Chatter" };
  const clicks = [];
  const window = chatButtonWindow(viewer, clicks);
  await window.open();

  const event = await sendChat(window, 1, 1);
  assert.equal(event.cancel, true);
  assert.deepEqual(clicks, [], "the before-event must never click");

  await flushChatInput();
  assert.deepEqual(clicks, [1]);

  // Slot 0 has no element at all: the layout probe must report it as
  // non-button instead of letting handleClick() guess.
  const notButton = await sendChat(window, 0, 2);
  assert.equal(notButton.cancel, true);
  await flushChatInput();
  assert.deepEqual(clicks, [1]);

  window.close();
  // A closed Window is out of the registry: the reserved line is still hidden
  // from chat, but nothing runs.
  const closed = await sendChat(window, 1, 3);
  assert.equal(closed.cancel, true);
  await flushChatInput();
  assert.deepEqual(clicks, [1]);
});

test("chat input never routes one viewer's line into another viewer's Window", async () => {
  const viewer = { id: "chat-owner", name: "Owner" };
  const other = { id: "chat-other", name: "Other" };
  const ownerClicks = [];
  const otherClicks = [];
  const ownerWindow = chatButtonWindow(viewer, ownerClicks);
  const otherWindow = chatButtonWindow(other, otherClicks);
  await ownerWindow.open();
  await otherWindow.open();

  // The line names the owner's Window but the sender is the other player:
  // the bridge looks up the sender's Window, so the session id mismatches.
  const spoofed = await sendChat(ownerWindow, 1, 1, { id: other.id });
  assert.equal(spoofed.cancel, true);
  await flushChatInput();
  assert.deepEqual(ownerClicks, []);
  assert.deepEqual(otherClicks, []);

  await sendChat(otherWindow, 1, 2, { id: other.id });
  await flushChatInput();
  assert.deepEqual(ownerClicks, []);
  assert.deepEqual(otherClicks, [1]);

  await sendChat(ownerWindow, 1, 3, { id: viewer.id });
  await flushChatInput();
  assert.deepEqual(ownerClicks, [1]);
  assert.deepEqual(otherClicks, [1]);

  ownerWindow.close();
  otherWindow.close();
});

test("close and reopen start a new chat input session", async () => {
  const viewer = { id: "chat-reopen", name: "Reopener" };
  const clicks = [];
  const window = chatButtonWindow(viewer, clicks);

  await window.open();
  const firstSession = window._inputSessionId;
  assert.match(firstSession, /^[A-Za-z0-9_-]{1,64}$/);
  await sendChat(window, 1, 5);
  await flushChatInput();
  assert.deepEqual(clicks, [1]);

  window.close();
  await window.open();

  // The public id stays stable; the input session is new per open, so a late
  // line naming the previous session cannot match.
  assert.match(window.id, /^window-\d+$/);
  assert.notEqual(window._inputSessionId, firstSession);

  // The same sequence is valid again only because close invalidated the bridge
  // and the reopen reset the per-session sequence.
  await sendChat(window, 1, 5);
  await flushChatInput();
  assert.deepEqual(clicks, [1, 1]);

  window.close();
});

test("a page change invalidates a notification queued for the previous page", async () => {
  const viewer = { id: "chat-paged", name: "Pager" };
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  const started = deferred();
  const clicked = [];
  const pageZero = Item.builder()
    .setItemProvider(() => stack("minecraft:page_0"))
    .addClickHandler(async () => {
      clicked.push("page0");
      started.resolve();
      await gate.promise;
    })
    .build();
  const pageOne = Item.builder()
    .setItemProvider(() => stack("minecraft:page_1"))
    .addClickHandler(() => clicked.push("page1"))
    .build();
  const window = Window.builder()
    .setViewer(viewer)
    .setUpperGui(
      Gui.paged({
        structure: ["."],
        ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
        content: [pageZero, pageOne],
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();

  await window.open();

  await sendChat(window, 0, 1);
  for (const callback of scheduledRuns.splice(0)) {
    callback();
  }
  await started.promise;
  assert.deepEqual(clicked, ["page0"]);

  // Queued behind the running click, still against page 0.
  await sendChat(window, 0, 2);
  for (const callback of scheduledRuns.splice(0)) {
    callback();
  }
  await tick();

  window.setState({ page: 1 });
  await tick();

  gate.resolve();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(clicked, ["page0"], "the queued page-0 click is discarded");

  await sendChat(window, 0, 3);
  await flushChatInput();
  assert.deepEqual(clicked, ["page0", "page1"]);

  window.close();
});

test("a slot element swap on the same page invalidates a notification queued for the old element", async () => {
  const viewer = { id: "chat-swap", name: "Swapper" };
  const adapter = new InMemoryTestAdapter();
  const gate = deferred();
  const started = deferred();
  const clicked = [];
  const first = Item.builder()
    .setItemProvider(() => stack("minecraft:first"))
    .addClickHandler(async () => {
      clicked.push("first");
      started.resolve();
      await gate.promise;
    })
    .build();
  const second = Item.builder()
    .setItemProvider(() => stack("minecraft:second"))
    .addClickHandler(() => clicked.push("second"))
    .build();
  const gui = Gui.paged({
    structure: ["."],
    ingredients: { ".": Markers.CONTENT_LIST_SLOT_HORIZONTAL },
    content: [first],
  });
  const window = Window.builder()
    .setViewer(viewer)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();

  await window.open();

  await sendChat(window, 0, 1);
  for (const callback of scheduledRuns.splice(0)) {
    callback();
  }
  await started.promise;
  assert.deepEqual(clicked, ["first"]);

  // Queued behind the running click, still against the first element.
  await sendChat(window, 0, 2);
  for (const callback of scheduledRuns.splice(0)) {
    callback();
  }
  await tick();

  // Same page/line/tab, but slot 0 now renders a different Item.
  gui.setContent([second]);
  await tick();

  gate.resolve();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(clicked, ["first"], "the queued click must not hit the new element");

  await sendChat(window, 0, 3);
  await flushChatInput();
  assert.deepEqual(clicked, ["first", "second"]);

  window.close();
});

test("playerLeave closes only the leaving viewer's open Window and releases it", async () => {
  const adapter = new InMemoryTestAdapter();
  const otherAdapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const otherCloseReasons = [];
  const clicks = [];
  const button = Item.builder()
    .setItemProvider(() => stack("minecraft:button"))
    .addClickHandler(() => clicks.push(1))
    .build();
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["ab"], ingredients: { b: button } }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();
  const otherWindow = Window.builder()
    .setViewer(otherPlayer)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(otherAdapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => otherCloseReasons.push(reason))
    .build();

  await window.open();
  await otherWindow.open();
  assert.equal(window.status, "open");
  assert.equal(otherWindow.status, "open");

  // Prove the Window is in the chat registry before the leave.
  await sendChat(window, 1, 1);
  await flushChatInput();
  assert.deepEqual(clicks, [1]);

  emitPlayerLeave(player.id);

  assert.equal(window.status, "closed");
  assert.equal(window.isOpen, false);
  assert.equal(window.container, undefined);
  assert.deepEqual(closeReasons, ["PlayerLeft"]);
  // The screen disappeared with the player: no adapter close was requested.
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.deepEqual(
    adapter.itemChangeSubscriptions.map((record) => record.active),
    [false],
  );
  // State handle and layout were released by the normal close path.
  assert.throws(() => window.getState(), /not open/);
  assert.throws(() => window.setState({ page: 0 }), /not open/);

  // The chat registry no longer routes a delayed line into it.
  const delayed = await sendChat(window, 1, 2);
  assert.equal(delayed.cancel, true);
  await flushChatInput();
  assert.deepEqual(clicks, [1]);

  // Another viewer's Window and state are untouched.
  assert.equal(otherWindow.status, "open");
  assert.deepEqual(otherCloseReasons, []);
  otherWindow.setState({ page: 0 });
  assert.equal(otherWindow.getState().page, 0);

  // A repeated or unrelated leave is a no-op.
  emitPlayerLeave(player.id);
  emitPlayerLeave("not-a-tracked-player");
  assert.deepEqual(closeReasons, ["PlayerLeft"]);
  assert.equal(otherWindow.status, "open");

  otherWindow.close();
});

test("playerLeave while a Window is opening closes it before a screen is shown", async () => {
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const openHandlers = [];
  let resolveProvider;
  const item = Item.simple(
    () =>
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
  );
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addOpenHandler(() => openHandlers.push("open"))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  const opening = window.open();
  await Promise.resolve();
  assert.equal(window.status, "opening");
  const container = adapter.containers[0];
  assert.ok(container, "container exists while providers are unresolved");

  emitPlayerLeave(player.id);
  assert.equal(window.status, "closed");

  resolveProvider(stack("minecraft:late"));
  await opening;

  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.equal(adapter.opened.length, 0, "the screen must never be requested");
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(openHandlers, []);
  assert.deepEqual(closeReasons, ["PlayerLeft"]);
  assert.equal(container.items[0], undefined, "a late provider must not write");
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.throws(() => window.getState(), /not open/);
});

test("a playerLeave close handler may reopen without the stale close tearing it down", async () => {
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  let reopened;
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => {
      closeReasons.push(reason);
      if (closeReasons.length === 1) {
        reopened = window.open();
      }
    })
    .build();

  await window.open();
  const firstContainer = adapter.containers[0];
  assert.equal(window.status, "open");

  emitPlayerLeave(player.id);
  await reopened;

  // The close notification ends at the handler that started the new
  // generation; the reopened Window stays open.
  assert.equal(window.status, "open");
  assert.deepEqual(closeReasons, ["PlayerLeft"]);
  assert.equal(adapter.opened.length, 2);
  assert.notEqual(window.container, firstContainer);
  assert.equal(adapter.closed.length, 0, "the leave itself requests no close");

  window.close("PlayerClosed");
  assert.deepEqual(closeReasons, ["PlayerLeft", "PlayerClosed"]);
  assert.equal(adapter.closed.length, 1);
});

test("Windows keep working when world.afterEvents.playerLeave is absent", async () => {
  // A separate Window module instance resolves @minecraft/server to a double
  // without the playerLeave signal: feature detection must latch off instead
  // of breaking open/close.
  const { Window: WindowWithoutPlayerLeave } = await import(
    new URL("../src/window.ts?no-player-leave", import.meta.url).href
  );
  const adapter = new InMemoryTestAdapter();
  const window = WindowWithoutPlayerLeave.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();

  await window.open();
  assert.equal(window.status, "open");
  assert.equal(adapter.opened.length, 1);
  window.close();
  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 1);
});

test("entityDie closes only the dead viewer's Window with PlayerDied and releases it", async () => {
  const adapter = new InMemoryTestAdapter();
  const otherAdapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const otherCloseReasons = [];
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();
  const otherWindow = Window.builder()
    .setViewer(otherPlayer)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(otherAdapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => otherCloseReasons.push(reason))
    .build();

  await window.open();
  await otherWindow.open();
  assert.equal(window.status, "open");

  // A non-player, an untracked id, a missing entity, and an entity whose id
  // cannot be read must not close anything.
  emitEntityDie({ id: "minecraft:cow" });
  emitEntityDie({ id: "p3" });
  emitEntityDie(undefined);
  emitEntityDie({
    get id() {
      throw new Error("invalid entity");
    },
  });
  assert.equal(window.status, "open");
  assert.deepEqual(closeReasons, []);
  assert.equal(otherWindow.status, "open");

  emitEntityDie({ id: player.id });

  assert.equal(window.status, "closed");
  assert.equal(window.isOpen, false);
  assert.equal(window.container, undefined);
  assert.deepEqual(closeReasons, ["PlayerDied"]);
  // The screen goes away with the player: no adapter close is requested.
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [false],
  );
  assert.deepEqual(
    adapter.itemChangeSubscriptions.map((record) => record.active),
    [false],
  );
  // The normal close path released state and stopped chat routing.
  assert.throws(() => window.getState(), /not open/);
  const delayed = await sendChat(window, 0, 1);
  assert.equal(delayed.cancel, true);

  // A repeated death is a no-op; the other viewer is untouched.
  emitEntityDie({ id: player.id });
  assert.deepEqual(closeReasons, ["PlayerDied"]);
  assert.equal(otherWindow.status, "open");
  assert.deepEqual(otherCloseReasons, []);

  otherWindow.close();
});

test("entityDie while a Window is opening closes it before a screen is shown", async () => {
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const openHandlers = [];
  let resolveProvider;
  const item = Item.simple(
    () =>
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
  );
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addOpenHandler(() => openHandlers.push("open"))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  const opening = window.open();
  await Promise.resolve();
  assert.equal(window.status, "opening");
  const container = adapter.containers[0];
  assert.ok(container, "container exists while providers are unresolved");

  emitEntityDie({ id: player.id });
  assert.equal(window.status, "closed");

  // A provider that resolves after the death must not write into the container
  // or open the screen.
  resolveProvider(stack("minecraft:late"));
  await opening;

  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.equal(adapter.opened.length, 0, "the screen must never be requested");
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(openHandlers, []);
  assert.deepEqual(closeReasons, ["PlayerDied"]);
  assert.equal(container.items[0], undefined, "a late provider must not write");
  assert.throws(() => window.getState(), /not open/);
});

test("shutdown closes every open Window without restricted-execution cleanup calls", async () => {
  // A fresh module instance with its own double: the shutdown latch is
  // permanent for a module, so it must not leak into the shared double.
  const { Window: ShutdownWindow } = await import(
    new URL("../src/window.ts?shutdown-close", import.meta.url).href
  );
  const { emitShutdown } = await import(shutdownMockUrl("shutdown-close"));
  const adapter = new InMemoryTestAdapter();
  const otherAdapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const otherCloseReasons = [];
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:a")) },
  });
  const window = ShutdownWindow.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();
  const otherWindow = ShutdownWindow.builder()
    .setViewer(otherPlayer)
    .setUpperGui(gui)
    .setContainerAdapter(otherAdapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => otherCloseReasons.push(reason))
    .build();

  await window.open();
  await otherWindow.open();
  assert.equal(adapter.opened.length, 1);

  emitShutdown();

  assert.equal(window.status, "closed");
  assert.equal(otherWindow.status, "closed");
  assert.equal(window.container, undefined);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.deepEqual(otherCloseReasons, ["ServerClosed"]);
  // The callback runs with restricted-execution privilege: neither
  // VirtualContainer.close() nor an event unsubscribe() may be called.
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(otherAdapter.closed, []);
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [true],
  );
  assert.deepEqual(
    adapter.itemChangeSubscriptions.map((record) => record.active),
    [true],
  );
  // Local resources are released: state and chat routing.
  assert.throws(() => window.getState(), /not open/);
  const delayed = await sendChat(window, 0, 1);
  assert.equal(delayed.cancel, true);

  // A repeated shutdown must not notify again, and a later open is a no-op.
  emitShutdown();
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  await window.open();
  assert.equal(window.status, "closed");
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.containers.length, 1);
});

test("shutdown close handlers cannot reopen and reentrant opens are closed", async () => {
  const { Window: ShutdownWindow } = await import(
    new URL("../src/window.ts?shutdown-reentry", import.meta.url).href
  );
  const { emitShutdown } = await import(shutdownMockUrl("shutdown-reentry"));
  const adapter = new InMemoryTestAdapter();
  const otherAdapter = new InMemoryTestAdapter();
  const order = [];
  const gui = Gui.normal({
    structure: ["a"],
    ingredients: { a: Item.simple(() => stack("minecraft:a")) },
  });
  let reopened;
  let otherWindow;
  const window = ShutdownWindow.builder()
    .setViewer(player)
    .setUpperGui(gui)
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => {
      order.push(`window:${reason}`);
      // Both calls run while the shutdown callback is still on the stack.
      reopened = window.open();
      order.push(`window-after-open:${window.status}`);
      void otherWindow.open();
      order.push(`other-after-open:${otherWindow.status}`);
    })
    .addCloseHandler((reason) => order.push(`window:${reason}:second`))
    .build();
  otherWindow = ShutdownWindow.builder()
    .setViewer(otherPlayer)
    .setUpperGui(gui)
    .setContainerAdapter(otherAdapter)
    .setErrorHandler(() => {})
    .addCloseHandler((reason) => order.push(`other:${reason}`))
    .build();

  await window.open();
  await otherWindow.open();

  emitShutdown();
  await reopened;

  assert.deepEqual(order, [
    "window:ServerClosed",
    "window-after-open:closed",
    "other:ServerClosed",
    "other-after-open:closed",
    "window:ServerClosed:second",
  ]);
  assert.equal(window.status, "closed");
  assert.equal(otherWindow.status, "closed");
  // No re-open created a container or screen, and the first Window's close
  // handlers all ran once (the no-op open did not bump the generation).
  assert.equal(adapter.containers.length, 1);
  assert.equal(otherAdapter.containers.length, 1);
  assert.equal(adapter.opened.length, 1);
  assert.equal(otherAdapter.opened.length, 1);
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(otherAdapter.closed, []);
});

test("shutdown while a Window is opening releases it without restricted cleanup", async () => {
  const { Window: ShutdownWindow } = await import(
    new URL("../src/window.ts?shutdown-opening", import.meta.url).href
  );
  const { emitShutdown } = await import(shutdownMockUrl("shutdown-opening"));
  const adapter = new InMemoryTestAdapter();
  const closeReasons = [];
  const openHandlers = [];
  let resolveProvider;
  const item = Item.simple(
    () =>
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
  );
  const window = ShutdownWindow.builder()
    .setViewer(player)
    .setUpperGui(Gui.normal({ structure: ["a"], ingredients: { a: item } }))
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .addOpenHandler(() => openHandlers.push("open"))
    .addCloseHandler((reason) => closeReasons.push(reason))
    .build();

  const opening = window.open();
  await Promise.resolve();
  assert.equal(window.status, "opening");
  const container = adapter.containers[0];
  assert.ok(container, "container exists while providers are unresolved");

  emitShutdown();
  assert.equal(window.status, "closed");

  resolveProvider(stack("minecraft:late"));
  await opening;

  assert.equal(window.status, "closed");
  assert.equal(window.container, undefined);
  assert.equal(adapter.opened.length, 0, "the screen must never be requested");
  assert.deepEqual(adapter.closed, []);
  assert.deepEqual(openHandlers, []);
  assert.deepEqual(closeReasons, ["ServerClosed"]);
  assert.equal(container.items[0], undefined, "a late provider must not write");
  assert.deepEqual(
    adapter.closeSubscriptions.map((record) => record.active),
    [true],
  );
  assert.throws(() => window.getState(), /not open/);
});

test("Windows keep working when system.beforeEvents.shutdown is absent", async () => {
  const { Window: WindowWithoutShutdown } = await import(
    new URL("../src/window.ts?no-shutdown", import.meta.url).href
  );
  const adapter = new InMemoryTestAdapter();
  const window = WindowWithoutShutdown.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();

  await window.open();
  assert.equal(window.status, "open");
  assert.equal(adapter.opened.length, 1);
  window.close();
  assert.equal(window.status, "closed");
  assert.equal(adapter.closed.length, 1);
});

test("a Window opened after the shutdown tests still opens", async () => {
  // The latch is permanent per Window module instance. The shutdown tests emit
  // into their own doubles, so the shared double used by this default module
  // was never told the world shut down; opening must still work.
  const adapter = new InMemoryTestAdapter();
  const window = Window.builder()
    .setViewer(player)
    .setUpperGui(
      Gui.normal({
        structure: ["a"],
        ingredients: { a: Item.simple(() => stack("minecraft:a")) },
      }),
    )
    .setContainerAdapter(adapter)
    .setErrorHandler(() => {})
    .build();

  await window.open();
  assert.equal(window.status, "open");
  assert.equal(adapter.opened.length, 1);
  window.close();
  assert.equal(adapter.closed.length, 1);
});
