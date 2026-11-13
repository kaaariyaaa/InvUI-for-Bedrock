import type { ItemStack } from "@minecraft/server";

export interface InventoryChange {
  readonly inventory: Inventory;
  readonly slot: number;
  readonly previous: ItemStack | undefined;
  readonly current: ItemStack | undefined;
}

export type InventoryListener = (change: InventoryChange) => void;

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
