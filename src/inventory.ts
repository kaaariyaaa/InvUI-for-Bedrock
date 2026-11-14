import type { ItemStack } from "@minecraft/server";

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

function cloneItem(item: ItemStack | undefined): ItemStack | undefined {
  return item === undefined ? undefined : item.clone();
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

function isCloneableItemStack(value: unknown): value is ItemStack {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ItemStack).typeId === "string" &&
    typeof (value as ItemStack).clone === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const MAX_JSON_DEPTH = 64;

/**
 * Validates and deep-clones a JSON value. This mirrors `state.ts` and rejects
 * what `JSON.stringify` silently rewrites: nested `undefined` (key dropped),
 * non-finite numbers and array holes (turned into `null`), `toJSON`
 * (invoked), accessors, and circular references (throw on stringify). The
 * result shares no objects or arrays with the input.
 */
function cloneJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new TypeError(`InvUI: ${path} is nested too deeply.`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`InvUI: ${path} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`InvUI: ${path} contains a non-JSON value (${typeof value}).`);
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new TypeError(`InvUI: ${path} contains a circular reference.`);
  }
  ancestors.add(object);

  let cloned: unknown;
  if (Array.isArray(object)) {
    // JSON only sees index 0..length-1 and never a symbol or extra own key, so
    // accepting those would drop data; reading `object[index]` would also run
    // accessors. Require exactly the dense indices plus the intrinsic length.
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new TypeError(`InvUI: ${path} contains symbol keys.`);
    }
    if (Object.getOwnPropertyNames(object).length !== object.length + 1) {
      throw new TypeError(`InvUI: ${path} contains non-index array keys.`);
    }
    const array: unknown[] = [];
    for (let index = 0; index < object.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
      if (descriptor === undefined) {
        throw new TypeError(`InvUI: ${path} contains a sparse array.`);
      }
      if (!("value" in descriptor)) {
        throw new TypeError(`InvUI: ${path}[${index}] must be a data property.`);
      }
      array.push(
        cloneJson(descriptor.value, `${path}[${index}]`, ancestors, depth + 1),
      );
    }
    cloned = array;
  } else {
    if (!isPlainObject(object)) {
      throw new TypeError(
        `InvUI: ${path} must contain only plain objects and arrays.`,
      );
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new TypeError(`InvUI: ${path} contains symbol keys.`);
    }
    if (Object.getOwnPropertyNames(object).length !== Object.keys(object).length) {
      throw new TypeError(`InvUI: ${path} contains a non-enumerable property.`);
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`InvUI: ${path}.${key} must be a data property.`);
      }
      Object.defineProperty(record, key, {
        value: cloneJson(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
          depth + 1,
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    cloned = record;
  }

  ancestors.delete(object);
  return cloned;
}

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
    const previous = this.items[slot];
    const next = cloneItem(item);
    this.items[slot] = next;
    this.emit(slot, previous, next);
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
        occupied.push({ slot, item: item.clone() });
      }
    }
    const slots = occupied.map(({ slot, item }) => ({
      slot,
      item: cloneJson(
        codec.encode(item),
        `encoded item for slot ${slot}`,
        new Set(),
        0,
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
    const data = cloneJson(snapshot, "inventory snapshot", new Set(), 0);
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
      restored.push({ slot, item });
    }

    const inventory = new VirtualInventory(size);
    for (const { slot, item } of restored) {
      inventory.setItem(slot, item);
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
    const change: InventoryChange = {
      inventory: this,
      slot,
      previous: cloneItem(previous),
      current: cloneItem(current),
    };
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
