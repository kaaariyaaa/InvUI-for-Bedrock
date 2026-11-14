/**
 * Read-only `Inventory` view of a player's 36-slot inventory (design 3.6 and
 * 7.4). This is the "logical association" half of the lower inventory: a
 * `PlayerInventory` can be used with `InventoryLink` to show a player's own
 * slots in the upper GUI.
 *
 * Writes are deliberately rejected. Bedrock item-move safety is unverified
 * (design 7.3 / 0.2), so this adapter must not become a write path that looks
 * like a safe transfer. Do not add `setItem()`/`clear()` implementations here
 * until the manual safety tests exist.
 *
 * Bedrock has no documented change event that guarantees the same absolute
 * slot index this adapter uses for the container (`PlayerInventoryType` splits
 * hotbar and main inventory, and the index space is not specified). Automatic
 * event wiring would therefore be a guess. Instead, a caller that has verified
 * the mapping supplies {@link PlayerInventoryChangeSource}; without one,
 * `subscribe()` reports no changes (the GUI still renders on refresh).
 */

import type {
  Container,
  EntityInventoryComponent,
  ItemStack,
  Player,
} from "@minecraft/server";

import type {
  Inventory,
  InventoryChange,
  InventoryListener,
} from "./inventory.js";

/** One absolute container-slot change, already mapped by the caller. */
export interface PlayerInventoryChange {
  readonly playerId: string;
  /** Absolute slot in the player's container (same index as `getItem`). */
  readonly slot: number;
  readonly previous: ItemStack | undefined;
  readonly current: ItemStack | undefined;
}

/**
 * Caller-supplied bridge from a game event to absolute container slots.
 *
 * The caller owns the event subscription (for example
 * `world.afterEvents.playerInventoryItemChange`) and must translate the
 * event's `PlayerInventoryType`/`slot` pair to the absolute container index.
 * That translation is not documented by the API, so it is not guessed here.
 */
export interface PlayerInventoryChangeSource {
  subscribe(listener: (change: PlayerInventoryChange) => void): () => void;
}

export interface PlayerInventoryOptions {
  /**
   * Optional verified change source. When omitted, `subscribe()` still
   * returns an unsubscribe function but never fires.
   */
  readonly changes?: PlayerInventoryChangeSource;
}

/** Thrown by the read-only adapter for every write attempt. */
export class PlayerInventoryReadOnlyError extends Error {
  readonly code = "INVUI_PLAYER_INVENTORY_READ_ONLY";

  constructor(
    message = "InvUI: PlayerInventory is read-only; item movement is unverified and disabled.",
  ) {
    super(message);
    this.name = "PlayerInventoryReadOnlyError";
  }
}

function cloneItem(item: ItemStack | undefined): ItemStack | undefined {
  return item === undefined ? undefined : item.clone();
}

function assertSlot(size: number, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= size) {
    throw new RangeError(`InvUI: slot ${slot} is outside inventory size ${size}.`);
  }
}

function readPlayerId(player: Player): string {
  let playerId: unknown;
  try {
    playerId = player?.id;
  } catch {
    playerId = undefined;
  }
  if (typeof playerId !== "string" || playerId.length === 0) {
    throw new TypeError("InvUI: PlayerInventory requires a Player with an id.");
  }
  return playerId;
}

function readContainer(player: Player): Container {
  let component: EntityInventoryComponent | undefined;
  try {
    component = player.getComponent("inventory") as
      | EntityInventoryComponent
      | undefined;
  } catch (error) {
    throw new Error("InvUI: PlayerInventory could not read the inventory component.", {
      cause: error,
    });
  }
  const container = component?.container;
  if (!container || typeof container.getItem !== "function") {
    throw new Error("InvUI: PlayerInventory requires a valid inventory container.");
  }
  return container;
}

/**
 * Read-only `Inventory` over a player's container. `getItem()` returns a clone,
 * like `VirtualInventory`, so callers cannot mutate the live container through
 * the returned stack.
 */
export class PlayerInventory implements Inventory {
  /** False until the Bedrock item-move safety tests in design 7.3 pass. */
  static readonly writable = false;

  readonly size: number;
  readonly playerId: string;

  readonly #container: Container;
  readonly #changes: PlayerInventoryChangeSource | undefined;
  readonly #listeners = new Set<InventoryListener>();
  #unsubscribe: (() => void) | undefined;
  /** Guards against a synchronous source re-entering `#attachChanges`. */
  #attaching = false;

  constructor(player: Player, options: PlayerInventoryOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("InvUI: PlayerInventory options must be an object.");
    }
    if (
      options.changes !== undefined &&
      (typeof options.changes !== "object" ||
        options.changes === null ||
        typeof options.changes.subscribe !== "function")
    ) {
      throw new TypeError(
        "InvUI: PlayerInventory changes source must implement subscribe().",
      );
    }
    this.playerId = readPlayerId(player);
    this.#container = readContainer(player);
    this.size = this.#container.size;
    this.#changes = options.changes;
  }

  getItem(slot: number): ItemStack | undefined {
    assertSlot(this.size, slot);
    return cloneItem(this.#container.getItem(slot));
  }

  /** Always throws: this adapter never writes to the player's inventory. */
  setItem(_slot: number, _item: ItemStack | undefined): never {
    throw new PlayerInventoryReadOnlyError();
  }

  /** Always throws: this adapter never writes to the player's inventory. */
  clear(): never {
    throw new PlayerInventoryReadOnlyError();
  }

  subscribe(listener: InventoryListener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#attachChanges();
    }
    return () => {
      if (!this.#listeners.delete(listener)) {
        return;
      }
      if (this.#listeners.size === 0) {
        this.#detachChanges();
      }
    };
  }

  #attachChanges(): void {
    const source = this.#changes;
    if (
      source === undefined ||
      this.#unsubscribe !== undefined ||
      this.#attaching
    ) {
      return;
    }
    this.#attaching = true;
    let unsubscribe: (() => void) | undefined;
    try {
      const returned = source.subscribe((change) => this.#emit(change));
      if (typeof returned !== "function") {
        throw new TypeError(
          "InvUI: PlayerInventory changes source must return an unsubscribe function.",
        );
      }
      unsubscribe = returned;
    } catch (error) {
      // A broken event source must not make displaying the inventory fail.
      console.error("InvUI: PlayerInventory change source failed.", error);
    } finally {
      this.#attaching = false;
    }
    if (unsubscribe === undefined) {
      return;
    }
    this.#unsubscribe = unsubscribe;
    // The source may fire synchronously while subscribing, and the last
    // listener may have left during that callback. Do not keep a source
    // subscription that nothing is listening to (it would also double-deliver
    // once a later listener re-attaches).
    if (this.#listeners.size === 0) {
      this.#detachChanges();
    }
  }

  #detachChanges(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch (error) {
      console.error("InvUI: PlayerInventory change source unsubscribe failed.", error);
    }
  }

  #emit(change: PlayerInventoryChange): void {
    if (
      change === null ||
      typeof change !== "object" ||
      change.playerId !== this.playerId ||
      !Number.isInteger(change.slot) ||
      change.slot < 0 ||
      change.slot >= this.size
    ) {
      return;
    }
    const event: InventoryChange = {
      inventory: this,
      slot: change.slot,
      previous: cloneItem(change.previous),
      current: cloneItem(change.current),
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("InvUI: player inventory listener failed.", error);
      }
    }
  }
}
