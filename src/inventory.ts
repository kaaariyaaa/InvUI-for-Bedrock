import type { ItemStack } from "@minecraft/server";

import { createJsonCloner, hasOwn, isPlainObject } from "./json.js";

export interface InventoryChange {
  readonly inventory: Inventory;
  readonly slot: number;
  readonly previous: ItemStack | undefined;
  readonly current: ItemStack | undefined;
}

export type InventoryListener = (change: InventoryChange) => void;

/**
 * Explicit `ItemStack` <-> JSON value conversion for inventory persistence
 * (design 4.3 / 9.6).
 *
 * Bedrock's `ItemStack` cannot be exhaustively serialized: components, dynamic
 * properties, tags, and future fields are not one enumerable comparable value.
 * A codec is required instead of a built-in default so the caller decides what
 * to keep. Returning data that silently drops state is the caller's explicit
 * choice, not a library default. `encode()` receives a clone, so it cannot
 * mutate the inventory, and must return a JSON value (plain objects, arrays,
 * strings, finite numbers, booleans, or null); `serialize()` rejects and
 * deep-clones anything else. `decode()` must return a cloneable stack.
 */
export interface InventoryItemCodec<T = unknown> {
  encode(item: ItemStack): T;
  decode(value: T): ItemStack;
}

/** Current snapshot format version. Bump only for a breaking format change. */
export const INVENTORY_SNAPSHOT_VERSION = 1;

/** JSON-serializable form of a {@link VirtualInventory}. */
export interface SerializedVirtualInventory<T = unknown> {
  readonly version: typeof INVENTORY_SNAPSHOT_VERSION;
  readonly size: number;
  /** Only occupied slots; every other slot is empty. */
  readonly slots: ReadonlyArray<{ readonly slot: number; readonly item: T }>;
}

/** Logical storage. ItemStack values crossing this boundary are clones. */
export interface Inventory {
  readonly size: number;
  getItem(slot: number): ItemStack | undefined;
  setItem(slot: number, item: ItemStack | undefined): void;
  clear(): void;
  subscribe(listener: InventoryListener): () => void;
}

function isCloneableItemStack(value: unknown): value is ItemStack {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ItemStack).typeId === "string" &&
    typeof (value as ItemStack).clone === "function"
  );
}

/**
 * The single `ItemStack.clone()` boundary. A clone must be an independent,
 * usable stack: `clone()` returning `undefined`, a non-stack, or the original
 * object would silently empty a slot, make reads throw later, or alias the
 * caller's stack into the inventory. Reject it before the caller can write.
 *
 * Every inventory that hands stacks across its boundary (including
 * `PlayerInventory`, which reads a live container) must clone through here, so
 * a broken container stack can never look like an empty slot.
 */
export function cloneItem(item: ItemStack): ItemStack;
export function cloneItem(item: undefined): undefined;
export function cloneItem(item: ItemStack | undefined): ItemStack | undefined;
export function cloneItem(item: ItemStack | undefined): ItemStack | undefined {
  if (item === undefined) {
    return undefined;
  }
  if (!isCloneableItemStack(item)) {
    throw new TypeError("InvUI: value is not an ItemStack.");
  }
  const clone = item.clone();
  if (clone === item) {
    throw new TypeError(
      "InvUI: ItemStack.clone() must return an independent copy, not the original stack.",
    );
  }
  if (!isCloneableItemStack(clone)) {
    throw new TypeError("InvUI: ItemStack.clone() did not return a valid ItemStack.");
  }
  return clone;
}

function assertSlot(size: number, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= size) {
    throw new RangeError(`InvUI: slot ${slot} is outside inventory size ${size}.`);
  }
}

function assertCodec<T>(codec: InventoryItemCodec<T>): void {
  if (
    !codec ||
    typeof codec.encode !== "function" ||
    typeof codec.decode !== "function"
  ) {
    throw new TypeError("InvUI: inventory codec must implement encode() and decode().");
  }
}

/**
 * Strict JSON clone for encoded item values and snapshots: rejects what
 * `JSON.stringify` silently rewrites or drops (nested `undefined`, non-finite
 * numbers, sparse arrays, `toJSON`, accessors, symbol/non-index keys,
 * non-enumerable properties, circular references). See `json.ts` for the
 * shared walk.
 */
const cloneJson = createJsonCloner({
  fail: (message) => new TypeError(`InvUI: ${message}.`),
  strict: true,
});

/** In-memory Inventory. Not to be confused with Script API VirtualContainer. */
export class VirtualInventory implements Inventory {
  readonly size: number;

  private readonly items: Array<ItemStack | undefined>;
  private readonly listeners = new Set<InventoryListener>();

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError(`InvUI: inventory size must be a non-negative integer (got ${size}).`);
    }
    this.size = size;
    this.items = new Array<ItemStack | undefined>(size);
  }

  getItem(slot: number): ItemStack | undefined {
    assertSlot(this.size, slot);
    return cloneItem(this.items[slot]);
  }

  setItem(slot: number, item: ItemStack | undefined): void {
    assertSlot(this.size, slot);
    // Clone everything the change event needs before writing. A clone that
    // fails after the write would report failure for a slot that did change
    // and notify no listener, so the write is the last thing that can fail.
    const previous = cloneItem(this.items[slot]);
    const stored = cloneItem(item);
    // Keep the event value separate from the stored stack so a listener cannot
    // mutate inventory contents through the change object.
    const current = cloneItem(stored);
    this.items[slot] = stored;
    this.emit(slot, previous, current);
  }

  clear(): void {
    for (let slot = 0; slot < this.size; slot++) {
      if (this.items[slot] !== undefined) {
        this.setItem(slot, undefined);
      }
    }
  }

  getContents(): Array<ItemStack | undefined> {
    return this.items.map((item) => cloneItem(item));
  }

  /**
   * Convert occupied slots to a JSON-serializable snapshot (design 4.3).
   * Empty slots are omitted.
   *
   * Every occupied slot is cloned before the first `encode()` call, so a codec
   * that mutates the inventory while saving cannot produce a snapshot that
   * mixes two points in time. The encoded value is validated and deep-cloned
   * as JSON; otherwise nested `undefined`, `NaN`, sparse arrays, `toJSON`, or
   * circular references would read back as different data after
   * `JSON.stringify`.
   */
  serialize<T>(codec: InventoryItemCodec<T>): SerializedVirtualInventory<T> {
    assertCodec(codec);
    const occupied: Array<{ slot: number; item: ItemStack }> = [];
    for (let slot = 0; slot < this.size; slot++) {
      const item = this.items[slot];
      if (item !== undefined) {
        occupied.push({ slot, item: cloneItem(item) });
      }
    }
    const slots = occupied.map(({ slot, item }) => ({
      slot,
      item: cloneJson(
        codec.encode(item),
        `encoded item for slot ${slot}`,
      ) as T,
    }));
    return { version: INVENTORY_SNAPSHOT_VERSION, size: this.size, slots };
  }

  /**
   * Rebuild a fresh inventory from `serialize()` output. The whole snapshot is
   * validated as JSON and deep-cloned before anything is decoded or written,
   * so malformed data never produces a partially restored inventory and
   * `decode()` cannot mutate the caller's snapshot. A slot entry without an
   * `item` is rejected instead of decoding as an empty slot.
   */
  static deserialize<T>(
    snapshot: SerializedVirtualInventory<T>,
    codec: InventoryItemCodec<T>,
  ): VirtualInventory {
    assertCodec(codec);
    const data = cloneJson(snapshot, "inventory snapshot");
    if (!isPlainObject(data)) {
      throw new TypeError("InvUI: inventory snapshot must be an object.");
    }
    if (data.version !== INVENTORY_SNAPSHOT_VERSION) {
      throw new Error(
        `InvUI: unsupported inventory snapshot version ${String(data.version)}.`,
      );
    }
    const size = data.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      throw new RangeError(`InvUI: inventory snapshot size is invalid (got ${String(size)}).`);
    }
    if (!Array.isArray(data.slots)) {
      throw new TypeError("InvUI: inventory snapshot slots must be an array.");
    }

    const entries: Array<{ slot: number; item: T }> = [];
    const seen = new Set<number>();
    for (const entry of data.slots) {
      if (!isPlainObject(entry)) {
        throw new TypeError("InvUI: inventory snapshot slot entries must be objects.");
      }
      if (!hasOwn(entry, "slot") || !hasOwn(entry, "item")) {
        throw new TypeError("InvUI: inventory snapshot slot entry must have a slot and an item.");
      }
      const slot = entry.slot;
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= size) {
        throw new RangeError(`InvUI: snapshot slot ${String(slot)} is outside size ${size}.`);
      }
      if (seen.has(slot)) {
        throw new Error(`InvUI: inventory snapshot contains duplicate slot ${slot}.`);
      }
      seen.add(slot);
      entries.push({ slot, item: entry.item as T });
    }

    const restored: Array<{ slot: number; item: ItemStack }> = [];
    for (const { slot, item: encoded } of entries) {
      const item = codec.decode(encoded);
      if (!isCloneableItemStack(item)) {
        throw new TypeError(`InvUI: item codec returned an invalid ItemStack for slot ${slot}.`);
      }
      // Validate the clone that will actually be stored and read back. A
      // decoded stack whose clone() returns an empty slot, something else, or
      // the original object would otherwise be stored as an unreadable or
      // aliased slot, silently dropping the snapshot entry. Clone every entry
      // before writing so a failure at any slot cannot leave a partially
      // restored inventory.
      const clone = item.clone();
      if (!isCloneableItemStack(clone) || clone === item) {
        throw new TypeError(
          `InvUI: item codec returned an ItemStack that cannot be cloned for slot ${slot}.`,
        );
      }
      restored.push({ slot, item: clone });
    }

    const inventory = new VirtualInventory(size);
    // The entries are already validated clones; assign them directly so a
    // second clone cannot fail after earlier slots were written.
    for (const { slot, item } of restored) {
      inventory.items[slot] = item;
    }
    return inventory;
  }

  subscribe(listener: InventoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(slot: number, previous: ItemStack | undefined, current: ItemStack | undefined): void {
    const change: InventoryChange = { inventory: this, slot, previous, current };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error("InvUI: inventory listener failed.", error);
      }
    }
  }
}

export type InventoryLinkListener = (item: ItemStack | undefined) => void;

/**
 * Thrown for every InventoryLink move attempt. Bedrock item-move safety is
 * still unverified (design section 7.3), so moves are rejected before any
 * read/write happens. Do not replace this with a partial move implementation.
 */
export class InventoryLinkMoveRejectedError extends Error {
  readonly code = "INVUI_INVENTORY_LINK_MOVE_UNVERIFIED";

  constructor(
    message = "InvUI: InventoryLink movement is disabled until Bedrock item-move safety verification is complete.",
  ) {
    super(message);
    this.name = "InventoryLinkMoveRejectedError";
  }
}

/**
 * Binds a GUI slot to one slot of an Inventory. Rendering reads getItem();
 * Inventory changes are forwarded through subscribe(). Movement is denied.
 */
export class InventoryLink {
  /** Gate for UI: this stays false until the Bedrock safety tests pass. */
  static readonly moveSupported = false;

  readonly inventory: Inventory;
  readonly slot: number;

  constructor(inventory: Inventory, slot: number) {
    if (!inventory) {
      throw new TypeError("InvUI: InventoryLink requires an Inventory.");
    }
    assertSlot(inventory.size, slot);
    this.inventory = inventory;
    this.slot = slot;
  }

  getItem(): ItemStack | undefined {
    return this.inventory.getItem(this.slot);
  }

  /** Direct write into the linked source slot (not a cross-inventory move). */
  setItem(item: ItemStack | undefined): void {
    this.inventory.setItem(this.slot, item);
  }

  /** Fires only for changes to the linked slot. */
  subscribe(listener: InventoryLinkListener): () => void {
    return this.inventory.subscribe((change) => {
      if (change.slot === this.slot) {
        listener(change.current);
      }
    });
  }

  /** Always throws; exist so callers can fail explicitly instead of silently. */
  moveTo(_target: Inventory, _targetSlot: number): never {
    throw new InventoryLinkMoveRejectedError();
  }
}
