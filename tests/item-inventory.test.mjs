import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Minimal @minecraft/server stand-in. Real integration tests can replace this.
const mockSource = `
export class ItemStack {
  constructor(typeId, amount = 1) {
    if (typeof typeId !== "string" || typeId.length === 0) {
      throw new TypeError("typeId");
    }
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

// Fake game clock: item periodic updates call system.runInterval. Tests
// advance ticks manually through the returned runs.
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
    // Match window.test.mjs: allow src TS imports of "./periodic.js" before build.
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

const { system } = await import(mockUrl);

// Prefer built .js (ESM output) but fall back to TS so tests run before build.
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

const { Item, ItemBuilder } = await load("../src/item");
const {
  INVENTORY_SNAPSHOT_VERSION,
  InventoryLink,
  InventoryLinkMoveRejectedError,
  VirtualInventory,
} = await load("../src/inventory");

test("ItemBuilder builds fresh ItemStacks with name, lore, and amount", () => {
  const builder = new ItemBuilder("minecraft:diamond", 2)
    .setName("購入")
    .addLoreLines("クリックして購入");
  const first = builder.build();
  const second = builder.build();

  assert.equal(first.typeId, "minecraft:diamond");
  assert.equal(first.amount, 2);
  assert.equal(first.nameTag, "購入");
  assert.deepEqual(first.lore, ["クリックして購入"]);
  assert.notEqual(first, second);

  builder.setLoreLines("だけ").setAmount(3);
  assert.deepEqual(first.lore, ["クリックして購入"]);
  assert.equal(builder.build().amount, 3);
});

test("ItemBuilder rejects invalid type ids and amounts", () => {
  assert.throws(() => new ItemBuilder(""), TypeError);
  assert.throws(() => new ItemBuilder("minecraft:stone", 0), RangeError);
  assert.throws(() => new ItemBuilder("minecraft:stone").setAmount(1.5), RangeError);
});

test("Item.simple clones a fixed ItemStack on every resolve", async () => {
  const base = new ItemBuilder("minecraft:stone", 3).build();
  const item = Item.simple(base);

  const first = await item.resolve(undefined);
  first.amount = 9;
  const second = await item.resolve(undefined);

  assert.notEqual(first, base);
  assert.equal(second.amount, 3);
  assert.equal(base.amount, 3);
});

test("Item providers receive the viewer", async () => {
  const item = Item.simple((viewer) => new ItemBuilder(viewer.name).build());
  const stack = await item.resolve({ name: "Steve" });
  assert.equal(stack.typeId, "Steve");
});

test("a placeholder stands in only while an async provider is pending", async () => {
  const pending = new Promise(() => {});
  const placeholder = new ItemBuilder("minecraft:loading", 1).build();
  const item = Item.simple(() => pending).setPlaceholder(placeholder);

  const resolution = item.resolveForDisplay({ name: "Steve" });
  assert.equal(resolution.placeholder, true);
  assert.equal(resolution.stack.typeId, "minecraft:loading");
  assert.equal(resolution.pending, pending);

  const fresh = item.getPlaceholder();
  assert.notEqual(fresh, placeholder, "the placeholder is copied, not shared");
});

test("a sync provider ignores the placeholder", async () => {
  const item = Item.builder()
    .setItemProvider(() => new ItemBuilder("minecraft:done").build())
    .setPlaceholder(new ItemBuilder("minecraft:loading").build())
    .build();

  const resolution = item.resolveForDisplay(undefined);
  assert.equal(resolution.stack.typeId, "minecraft:done");
  assert.equal(resolution.pending, undefined);
  assert.equal(resolution.placeholder, false);
  assert.equal((await item.resolve(undefined)).typeId, "minecraft:done");
});

test("clearing a placeholder restores the non-placeholder pending behavior", () => {
  const item = Item.simple(() => new Promise(() => {}))
    .setPlaceholder(new ItemBuilder("minecraft:loading").build());

  assert.equal(item.resolveForDisplay(undefined).placeholder, true);
  item.setPlaceholder(undefined);
  assert.equal(item.getPlaceholder(), undefined);
  assert.equal(item.resolveForDisplay(undefined).placeholder, false);
});

test("a placeholder must be a cloneable ItemStack", () => {
  const item = Item.simple(() => undefined);
  assert.throws(() => item.setPlaceholder(null), TypeError);
  assert.throws(() => item.setPlaceholder({}), TypeError);
  assert.throws(
    () => Item.builder().setPlaceholder({ typeId: "" }).build(),
    TypeError,
  );
  // A clone-less plain object would be stored by reference and shared.
  assert.throws(
    () => item.setPlaceholder({ typeId: "minecraft:stone", amount: 1 }),
    TypeError,
  );
  assert.equal(item.getPlaceholder(), undefined);
});

test("Item.builder runs click handlers in order and updates on click", async () => {
  const calls = [];
  let notifications = 0;
  const item = Item.builder()
    .setItemProvider(new ItemBuilder("minecraft:diamond"))
    .addClickHandler(async (click) => {
      await Promise.resolve();
      calls.push(`first:${click.player.name}:${click.slot}`);
    })
    .addClickHandler((click) => {
      calls.push(`second:${click.slot}`);
    })
    .updateOnClick()
    .build();

  item.subscribe(() => notifications++);
  await item.handleClick({ player: { name: "Steve" }, slot: 3, window: { id: "w" } });

  assert.deepEqual(calls, ["first:Steve:3", "second:3"]);
  assert.equal(notifications, 1);
  assert.equal(item.getUpdateOnClick(), true);
});

test("Item mode defaults to display without handlers and button with handlers", () => {
  const display = Item.simple(new ItemBuilder("minecraft:stone"));
  const button = Item.builder()
    .setItemProvider(new ItemBuilder("minecraft:diamond"))
    .addClickHandler(() => {})
    .build();

  assert.equal(display.getMode(), "display");
  assert.equal(button.getMode(), "button");
  assert.equal(Item.EMPTY.getMode(), "display");
});

test("setMode classifies the Item and display mode does not run handlers", async () => {
  const calls = [];
  const item = Item.builder()
    .addClickHandler(() => calls.push("click"))
    .build();

  assert.equal(item.setMode("display"), item);
  assert.equal(item.getMode(), "display");
  await item.handleClick({ player: { name: "Steve" }, slot: 0, window: {} });
  assert.deepEqual(calls, [], "display Items keep their handlers but do not run them");

  item.setMode("button");
  await item.handleClick({ player: { name: "Steve" }, slot: 0, window: {} });
  assert.deepEqual(calls, ["click"], "button Items keep the pre-classification behavior");

  assert.throws(() => item.setMode("inventory"), TypeError);
  assert.throws(() => item.setMode(undefined), TypeError);
});

test("notifyWindows notifies current subscribers only", () => {
  const item = Item.simple(new ItemBuilder("minecraft:stone"));
  let count = 0;
  const unsubscribe = item.subscribe(() => count++);

  item.notifyWindows();
  unsubscribe();
  item.notifyWindows();

  assert.equal(count, 1);
});

test("updatePeriodically validates and stores the tick period", () => {
  const item = Item.builder().updatePeriodically(20).build();
  assert.equal(item.getUpdatePeriod(), 20);
  assert.throws(() => Item.builder().updatePeriodically(0), RangeError);
  assert.throws(() => item.updatePeriodically(-1), RangeError);
});

test.afterEach(() => {
  system.runs.clear();
});

function fireTick() {
  for (const run of [...system.runs.values()]) {
    run.callback();
  }
}

test("updatePeriodically ticks only while displayed", () => {
  let count = 0;
  const item = Item.builder().updatePeriodically(20).build();

  assert.equal(system.runs.size, 0, "no timer before a Window displays the Item");

  const displayed = item.subscribe(() => count++);
  assert.equal(system.runs.size, 1);
  assert.equal([...system.runs.values()][0].ticks, 20);

  fireTick();
  assert.equal(count, 1, "one notification per displayed subscriber");

  item.notifyWindows();
  assert.equal(count, 2);

  // A second Window reuses the same interval instead of scheduling another.
  const secondWindow = item.subscribe(() => count++);
  assert.equal(system.runs.size, 1);

  displayed();
  assert.equal(system.runs.size, 1, "still displayed elsewhere");

  secondWindow();
  assert.equal(system.runs.size, 0, "hidden Item stops periodic updates");
  fireTick();
  assert.equal(count, 2);
});

test("resubscribing restarts periodic updates and period changes take effect", () => {
  let count = 0;
  const item = Item.builder().updatePeriodically(10).build();
  const unsubscribe = item.subscribe(() => count++);
  assert.equal([...system.runs.values()][0].ticks, 10);

  item.updatePeriodically(40);
  assert.equal(system.runs.size, 1);
  assert.equal([...system.runs.values()][0].ticks, 40);

  unsubscribe();
  assert.equal(system.runs.size, 0);

  item.subscribe(() => count++);
  assert.equal(system.runs.size, 1);
});

test("setting a period on an already displayed Item starts periodic updates", () => {
  let count = 0;
  const item = Item.simple(new ItemBuilder("minecraft:stone"));
  const unsubscribe = item.subscribe(() => count++);
  assert.equal(system.runs.size, 0, "an Item without a period schedules nothing");

  item.updatePeriodically(20);
  assert.equal(system.runs.size, 1, "the displayed Item starts ticking");
  assert.equal([...system.runs.values()][0].ticks, 20);
  assert.equal(count, 1, "setting the period also notifies once");

  fireTick();
  assert.equal(count, 2, "the scheduled tick notifies");

  unsubscribe();
  assert.equal(system.runs.size, 0, "hiding the Item still stops the timer");
});

test("Item.EMPTY resolves to no stack", async () => {
  assert.equal(await Item.EMPTY.resolve(undefined), undefined);
});

test("VirtualInventory stores clones and reports slot changes", () => {
  const inventory = new VirtualInventory(4);
  const changes = [];
  inventory.subscribe((change) => changes.push(change));

  const input = new ItemBuilder("minecraft:apple", 5).build();
  inventory.setItem(1, input);

  const read = inventory.getItem(1);
  assert.equal(read.amount, 5);
  read.amount = 1;
  assert.equal(inventory.getItem(1).amount, 5);
  assert.equal(input.amount, 5);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].slot, 1);
  assert.equal(changes[0].current.amount, 5);
  assert.equal(changes[0].previous, undefined);

  inventory.clear();
  assert.equal(inventory.getItem(1), undefined);
  assert.equal(changes.length, 2);
});

test("VirtualInventory validates size and slot bounds", () => {
  assert.throws(() => new VirtualInventory(-1), RangeError);
  assert.throws(() => new VirtualInventory(1.5), RangeError);

  const inventory = new VirtualInventory(1);
  assert.throws(() => inventory.getItem(1), RangeError);
  assert.throws(() => inventory.setItem(-1, undefined), RangeError);
});

test("InventoryLink reads/writes the linked slot and forwards only its changes", () => {
  const inventory = new VirtualInventory(2);
  const link = new InventoryLink(inventory, 1);
  const seen = [];
  link.subscribe((item) => seen.push(item));

  inventory.setItem(0, new ItemBuilder("minecraft:stone").build());
  assert.equal(seen.length, 0);

  inventory.setItem(1, new ItemBuilder("minecraft:diamond", 2).build());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].typeId, "minecraft:diamond");

  link.setItem(new ItemBuilder("minecraft:emerald").build());
  assert.equal(link.getItem().typeId, "minecraft:emerald");

  inventory.setItem(1, undefined);
  assert.equal(seen.length, 3);
  assert.equal(seen[2], undefined);
});

const plainItemCodec = {
  encode: (item) => ({
    typeId: item.typeId,
    amount: item.amount,
    nameTag: item.nameTag ?? "",
    lore: item.lore,
  }),
  decode: (value) =>
    new ItemBuilder(value.typeId, value.amount)
      .setName(value.nameTag)
      .setLoreLines(...value.lore)
      .build(),
};

test("VirtualInventory round-trips occupied slots through JSON with a codec", () => {
  const inventory = new VirtualInventory(4);
  inventory.setItem(
    0,
    new ItemBuilder("minecraft:stone", 3).setName("Rock").addLoreLines("line").build(),
  );
  inventory.setItem(2, new ItemBuilder("minecraft:diamond").build());

  const snapshot = inventory.serialize(plainItemCodec);
  assert.equal(snapshot.version, INVENTORY_SNAPSHOT_VERSION);
  assert.equal(snapshot.size, 4);
  assert.deepEqual(snapshot.slots.map((entry) => entry.slot), [0, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);

  const restored = VirtualInventory.deserialize(
    JSON.parse(JSON.stringify(snapshot)),
    plainItemCodec,
  );
  assert.equal(restored.size, 4);
  assert.equal(restored.getItem(0).typeId, "minecraft:stone");
  assert.equal(restored.getItem(0).amount, 3);
  assert.equal(restored.getItem(0).nameTag, "Rock");
  assert.deepEqual(restored.getItem(0).lore, ["line"]);
  assert.equal(restored.getItem(1), undefined);
  assert.equal(restored.getItem(2).typeId, "minecraft:diamond");
  assert.equal(restored.getItem(3), undefined);
});

test("serialize calls encode with a clone and rejects undefined output", () => {
  const inventory = new VirtualInventory(1);
  inventory.setItem(0, new ItemBuilder("minecraft:stone", 2).setName("original").build());

  inventory.serialize({
    encode: (item) => {
      item.nameTag = "changed";
      item.amount = 9;
      return { typeId: item.typeId, amount: item.amount };
    },
    decode: (value) => new ItemBuilder(value.typeId, value.amount).build(),
  });
  assert.equal(inventory.getItem(0).amount, 2);
  assert.equal(inventory.getItem(0).nameTag, "original");

  assert.throws(
    () =>
      inventory.serialize({
        encode: () => undefined,
        decode: () => new ItemBuilder("minecraft:stone").build(),
      }),
    TypeError,
  );
});

test("serialize rejects values JSON.stringify would silently change or lose", () => {
  const inventory = new VirtualInventory(1);
  inventory.setItem(0, new ItemBuilder("minecraft:stone").build());
  const codecReturning = (value) => ({
    encode: () => value,
    decode: () => new ItemBuilder("minecraft:stone").build(),
  });
  const circular = {};
  circular.self = circular;

  // Arrays: JSON ignores symbols and extra own keys but still serializes every
  // index, and a getter index would run its accessor during cloning.
  const withSymbol = [1];
  withSymbol[Symbol("extra")] = 2;
  const withHiddenKey = [1];
  Object.defineProperty(withHiddenKey, "extra", { value: 2, enumerable: false });
  let getterCalls = 0;
  const withAccessorIndex = [1];
  Object.defineProperty(withAccessorIndex, 0, {
    get() {
      getterCalls += 1;
      return 1;
    },
  });

  const rejected = [
    { typeId: "minecraft:stone", extra: undefined }, // key dropped
    { typeId: "minecraft:stone", amount: Number.NaN }, // -> null
    { typeId: "minecraft:stone", lore: ["line", , "tail"] }, // hole -> null
    { typeId: "minecraft:stone", lore: withSymbol }, // symbol dropped
    { typeId: "minecraft:stone", lore: withHiddenKey }, // extra key dropped
    { typeId: "minecraft:stone", lore: withAccessorIndex }, // accessor runs
    { typeId: "minecraft:stone", toJSON: () => ({}) }, // invoked
    circular, // JSON.stringify throws
  ];
  for (const value of rejected) {
    assert.throws(() => inventory.serialize(codecReturning(value)), TypeError);
  }
  assert.equal(getterCalls, 0);
});

test("serialize deep-clones the encoded value", () => {
  const inventory = new VirtualInventory(1);
  inventory.setItem(0, new ItemBuilder("minecraft:stone").build());
  const shared = { typeId: "minecraft:stone", amount: 3, lore: [] };

  const snapshot = inventory.serialize({
    encode: () => shared,
    decode: (value) => new ItemBuilder(value.typeId, value.amount).build(),
  });
  shared.amount = 9;
  shared.lore.push("changed");

  assert.equal(snapshot.slots[0].item.amount, 3);
  assert.deepEqual(snapshot.slots[0].item.lore, []);
});

test("serialize clones every occupied slot before the codec can mutate the inventory", () => {
  const inventory = new VirtualInventory(3);
  inventory.setItem(0, new ItemBuilder("minecraft:apple", 1).build());
  inventory.setItem(2, new ItemBuilder("minecraft:diamond", 7).build());

  const snapshot = inventory.serialize({
    encode: (item) => {
      if (item.typeId === "minecraft:apple") {
        inventory.setItem(0, undefined);
        inventory.setItem(2, new ItemBuilder("minecraft:coal", 1).build());
      }
      return { typeId: item.typeId, amount: item.amount };
    },
    decode: (value) => new ItemBuilder(value.typeId, value.amount).build(),
  });

  assert.deepEqual(
    snapshot.slots.map((entry) => [entry.slot, entry.item.typeId, entry.item.amount]),
    [
      [0, "minecraft:apple", 1],
      [2, "minecraft:diamond", 7],
    ],
  );
});

test("deserialize rejects slot entries with a missing or non-JSON item", () => {
  const codec = {
    encode: () => ({}),
    decode: (value) => new ItemBuilder(value.typeId, value.amount).build(),
  };
  const snapshot = (slots) => ({ version: INVENTORY_SNAPSHOT_VERSION, size: 1, slots });

  assert.throws(() => VirtualInventory.deserialize(snapshot([{ slot: 0 }]), codec), /item/);

  let decodeCalls = 0;
  assert.throws(
    () =>
      VirtualInventory.deserialize(
        snapshot([{ slot: 0, item: { typeId: "minecraft:stone", amount: Number.NaN } }]),
        {
          encode: () => ({}),
          decode: () => {
            decodeCalls++;
            return new ItemBuilder("minecraft:stone").build();
          },
        },
      ),
    TypeError,
  );
  assert.equal(decodeCalls, 0);
});

test("deserialize validates the whole snapshot before decoding or writing", () => {
  let decodeCalls = 0;
  const codec = {
    encode: () => {
      throw new Error("not used");
    },
    decode: (value) => {
      decodeCalls++;
      return new ItemBuilder(value.typeId, value.amount).build();
    },
  };
  const snapshot = (overrides) => ({
    version: INVENTORY_SNAPSHOT_VERSION,
    size: 2,
    slots: [{ slot: 0, item: { typeId: "minecraft:stone", amount: 1 } }],
    ...overrides,
  });

  assert.throws(
    () => VirtualInventory.deserialize(snapshot({ version: 999 }), codec),
    /version/,
  );
  assert.throws(
    () => VirtualInventory.deserialize(snapshot({ size: -1 }), codec),
    RangeError,
  );
  assert.throws(
    () =>
      VirtualInventory.deserialize(
        snapshot({
          slots: [
            { slot: 0, item: { typeId: "minecraft:stone", amount: 1 } },
            { slot: 0, item: { typeId: "minecraft:diamond", amount: 1 } },
          ],
        }),
        codec,
      ),
    /duplicate/,
  );
  assert.throws(
    () => VirtualInventory.deserialize(snapshot({ slots: [{ slot: 2, item: {} }] }), codec),
    RangeError,
  );
  assert.equal(decodeCalls, 0);

  assert.throws(
    () =>
      VirtualInventory.deserialize(snapshot(), {
        encode: () => {
          throw new Error("not used");
        },
        decode: () => ({ typeId: 1 }),
      }),
    TypeError,
  );
});

test("InventoryLink rejects moves before touching either inventory", () => {
  const source = new VirtualInventory(2);
  const target = new VirtualInventory(2);
  source.setItem(0, new ItemBuilder("minecraft:diamond").build());
  target.setItem(0, new ItemBuilder("minecraft:gold_ingot").build());

  const link = new InventoryLink(source, 0);
  assert.equal(InventoryLink.moveSupported, false);
  assert.throws(
    () => link.moveTo(target, 0),
    (error) =>
      error instanceof InventoryLinkMoveRejectedError &&
      error.code === "INVUI_INVENTORY_LINK_MOVE_UNVERIFIED",
  );

  assert.equal(source.getItem(0).typeId, "minecraft:diamond");
  assert.equal(target.getItem(0).typeId, "minecraft:gold_ingot");
});
