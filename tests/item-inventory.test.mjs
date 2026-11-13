import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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
`;

const mockUrl = `data:text/javascript;base64,${Buffer.from(mockSource).toString("base64")}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
      return { url: mockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

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
