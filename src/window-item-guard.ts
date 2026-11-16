/** Event capture and matching helpers for screen item restoration. */
import * as server from "@minecraft/server";
import { readId } from "./window-lifecycle.js";
import type { Container, Entity, ItemStack, Player, PlayerCursorInventoryComponent, PlayerInventoryType, PlayerInventoryItemChangeAfterEvent, PlayerCursorItemGrabAfterEvent, PlayerCursorItemReleaseAfterEvent, EntityItemDropAfterEvent } from "@minecraft/server";
import type { Window } from "./window.js";
import { afterEventState, ensureAfterEventSubscription } from "./window-lifecycle.js";

/* Screen item guard
 * Restore changed screen slots immediately. On the next tick, reconcile
 * matching inventory, cursor, and drop events without scanning unrelated items.
 */

/** One item type the screen lost (`take`) or gained (`placement`). */
export interface ScreenItemChange {
  readonly kind: "take" | "placement";
  readonly typeId: string;
  /** Amount of this type still to match against player-side changes. */
  remaining: number;
}

/** One changed player inventory slot, as reported by the after-event. */
export interface PlayerSlotChangeRecord {
  readonly inventoryType: PlayerInventoryType;
  /** The event's slot; `#resolvePlayerSlot` maps it to a container index. */
  readonly slot: number;
  readonly before: ItemStack | undefined;
  /** Last state of the slot in this batch; merged by #collapsePlayerChanges. */
  after: ItemStack | undefined;
  matchedGain: boolean;
  matchedLoss: boolean;
}

/** One cursor grab/release, as reported by the after-event. */
export interface CursorItemChangeRecord {
  readonly kind: "grab" | "release";
  readonly item: ItemStack;
  matched: boolean;
}

/** One item entity the viewer dropped, as reported by `entityItemDrop`. */
export interface DroppedItemChangeRecord {
  readonly entity: Entity;
  readonly item: ItemStack;
  matched: boolean;
}

/**
 * Learned mapping from `PlayerInventoryItemChangeAfterEvent.slot` to the
 * player inventory container index, per `PlayerInventoryType`. The relation is
 * not documented, so it is only learned from a candidate that the live
 * container confirms (see `#resolvePlayerSlot`) and never guessed. The hotbar
 * and main inventory are separate sub-inventories; the main inventory may be
 * reported either absolute (container index) or relative to the 27-slot area.
 */
export const playerSlotOffsets = new Map<PlayerInventoryType, number>();

/** Above this many unpaired records the oldest are dropped (see #pruneGuardRecords). */
export const MAX_SCREEN_GUARD_RECORDS = 128;

/** Read `ItemStack.typeId` without letting a stale stack throw. */
export function stackType(item: ItemStack | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  try {
    const typeId = item.typeId;
    return typeof typeId === "string" && typeId.length > 0 ? typeId : undefined;
  } catch {
    return undefined;
  }
}

/** Read `ItemStack.amount`, defaulting to 1 for a stale stack. */
export function stackAmount(item: ItemStack | undefined): number {
  if (!item) {
    return 0;
  }
  try {
    const amount = item.amount;
    return typeof amount === "number" && Number.isFinite(amount)
      ? Math.max(0, Math.floor(amount))
      : 1;
  } catch {
    return 1;
  }
}

/** What an inventory change added, if anything (a swap both adds and removes). */
export function gainedBy(change: PlayerSlotChangeRecord): { typeId: string; amount: number } | undefined {
  const afterType = stackType(change.after);
  if (!afterType) {
    return undefined;
  }
  if (stackType(change.before) !== afterType) {
    return { typeId: afterType, amount: stackAmount(change.after) };
  }
  const delta = stackAmount(change.after) - stackAmount(change.before);
  return delta > 0 ? { typeId: afterType, amount: delta } : undefined;
}

/** What an inventory change removed, if anything (a swap both adds and removes). */
export function lostBy(change: PlayerSlotChangeRecord): { typeId: string; amount: number } | undefined {
  const beforeType = stackType(change.before);
  if (!beforeType) {
    return undefined;
  }
  if (stackType(change.after) !== beforeType) {
    return { typeId: beforeType, amount: stackAmount(change.before) };
  }
  const delta = stackAmount(change.before) - stackAmount(change.after);
  return delta > 0 ? { typeId: beforeType, amount: delta } : undefined;
}

/** The player's 36-slot inventory container, or undefined when unavailable. */
export function playerInventoryContainer(player: Player): Container | undefined {
  try {
    const component = player.getComponent("minecraft:inventory");
    return component?.container;
  } catch {
    return undefined;
  }
}

/** Safe `Container.getItem` for a candidate slot. */
export function readContainerItem(
  container: Container,
  slot: number,
): ItemStack | undefined {
  try {
    return container.getItem(slot);
  } catch {
    return undefined;
  }
}

/** True when `item` is exactly the type and amount the event reported. */
export function sameTypeAndAmount(
  item: ItemStack | undefined,
  expected: ItemStack | undefined,
): boolean {
  return (
    stackType(item) !== undefined &&
    stackType(item) === stackType(expected) &&
    stackAmount(item) === stackAmount(expected)
  );
}

/** True when two stacks describe the same item content (undefined == empty). */
export function sameItemContent(
  left: ItemStack | undefined,
  right: ItemStack | undefined,
): boolean {
  const leftType = stackType(left);
  const rightType = stackType(right);
  if (leftType === undefined || rightType === undefined) {
    return leftType === undefined && rightType === undefined;
  }
  return leftType === rightType && stackAmount(left) === stackAmount(right);
}

/** Windows whose screen can emit a move the guard must reconcile. */
export const itemGuardWindows = new Set<Window>();

export const playerInventoryChangeState = afterEventState();
export const playerCursorGrabState = afterEventState();
export const playerCursorReleaseState = afterEventState();
export const entityItemDropState = afterEventState();

/**
 * Installs the player-side after-event subscriptions the guard reconciles
 * against, once for the whole module. A missing signal is latched off like the
 * lifecycle events: Windows still open and restore container slots, only the
 * matching player-side revert is skipped.
 */
export function ensureItemGuardSubscriptions(): void {
  ensureAfterEventSubscription(
    playerInventoryChangeState,
    "playerInventoryItemChange",
    "item moves through the screen will not be reverted",
    (event) => {
      for (const window of [...itemGuardWindows]) {
        try {
          window._onViewerInventoryChange(
            event as PlayerInventoryItemChangeAfterEvent,
          );
        } catch (error) {
          console.error(
            "InvUI: reconciling a player inventory change against the screen item guard failed.",
            error,
          );
        }
      }
    },
  );
  ensureAfterEventSubscription(
    playerCursorGrabState,
    "playerCursorItemGrab",
    "items taken to the cursor through the screen will not be removed",
    (event) => {
      for (const window of [...itemGuardWindows]) {
        try {
          window._onViewerCursorGrab(event as PlayerCursorItemGrabAfterEvent);
        } catch (error) {
          console.error(
            "InvUI: reconciling a cursor grab against the screen item guard failed.",
            error,
          );
        }
      }
    },
  );
  ensureAfterEventSubscription(
    playerCursorReleaseState,
    "playerCursorItemRelease",
    "items placed from the cursor into the screen will not be returned",
    (event) => {
      for (const window of [...itemGuardWindows]) {
        try {
          window._onViewerCursorRelease(
            event as PlayerCursorItemReleaseAfterEvent,
          );
        } catch (error) {
          console.error(
            "InvUI: reconciling a cursor release against the screen item guard failed.",
            error,
          );
        }
      }
    },
  );
  ensureAfterEventSubscription(
    entityItemDropState,
    "entityItemDrop",
    "items dropped from the screen will not be removed",
    (event) => {
      for (const window of [...itemGuardWindows]) {
        try {
          window._onViewerItemDrop(event as EntityItemDropAfterEvent);
        } catch (error) {
          console.error(
            "InvUI: reconciling an item drop against the screen item guard failed.",
            error,
          );
        }
      }
    },
  );
}

export interface ReconciliationEffects {
  revertPlayerSlot(container: Container, change: PlayerSlotChangeRecord): boolean;
  clearCursorItem(cursor: PlayerCursorInventoryComponent, item: ItemStack): boolean;
  removeDroppedItem(change: DroppedItemChangeRecord): boolean;
  returnToInventory(container: Container, item: ItemStack): boolean;
}

export function collapseScreenChanges(changes: readonly ScreenItemChange[]): ScreenItemChange[] {
  const net: ScreenItemChange[] = [];
  for (const change of changes) {
    if (change.remaining <= 0) {
      continue;
    }
    const oppositeKind = change.kind === "take" ? "placement" : "take";
    const other = net.find(
      (candidate) =>
        candidate.kind === oppositeKind &&
        candidate.typeId === change.typeId &&
        candidate.remaining > 0,
    );
    if (!other) {
      net.push({ ...change });
      continue;
    }
    const amount = Math.min(other.remaining, change.remaining);
    other.remaining -= amount;
    const leftover = change.remaining - amount;
    if (leftover > 0) {
      net.push({
        kind: change.kind,
        typeId: change.typeId,
        remaining: leftover,
      });
    }
  }
  return net.filter((change) => change.remaining > 0);
}


export function collapsePlayerChanges(changes: readonly PlayerSlotChangeRecord[]): PlayerSlotChangeRecord[] {
  const merged: PlayerSlotChangeRecord[] = [];
  const bySlot = new Map<string, PlayerSlotChangeRecord>();
  for (const change of changes) {
    const key = `${change.inventoryType}:${change.slot}`;
    const existing = bySlot.get(key);
    if (existing) {
      existing.after = change.after;
      continue;
    }
    const record: PlayerSlotChangeRecord = {
      inventoryType: change.inventoryType,
      slot: change.slot,
      before: change.before,
      after: change.after,
      matchedGain: false,
      matchedLoss: false,
    };
    bySlot.set(key, record);
    merged.push(record);
  }
  return merged.filter((change) => !sameItemContent(change.before, change.after));
}


export function collapseCursorChanges(changes: readonly CursorItemChangeRecord[]): CursorItemChangeRecord[] {
  const net: CursorItemChangeRecord[] = [];
  for (const change of changes) {
    const oppositeKind = change.kind === "grab" ? "release" : "grab";
    const match = net.findIndex(
      (candidate) =>
        candidate.kind === oppositeKind &&
        sameItemContent(candidate.item, change.item),
    );
    if (match >= 0) {
      net.splice(match, 1);
      continue;
    }
    net.push({ kind: change.kind, item: change.item, matched: false });
  }
  return net;
}


export function resolvePlayerSlot(
  container: Container,
  change: PlayerSlotChangeRecord,
): number | undefined {
  const expected = change.after;
  if (!expected) {
    return undefined;
  }
  const learned = playerSlotOffsets.get(change.inventoryType);
  const candidates: number[] = [];
  const add = (slot: number): void => {
    if (
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot < container.size &&
      !candidates.includes(slot)
    ) {
      candidates.push(slot);
    }
  };
  if (learned !== undefined) {
    add(change.slot + learned);
  }
  add(change.slot);
  // The main inventory may be reported relative to the 27-slot area instead
  // of as an absolute container index. The hotbar is 0..8 in either
  // convention, so only the main inventory gets the second candidate.
  if (change.inventoryType !== "Hotbar") {
    add(change.slot + 9);
  }
  const matches = candidates.filter((slot) =>
    sameTypeAndAmount(readContainerItem(container, slot), expected),
  );
  if (matches.length !== 1) {
    return undefined;
  }
  playerSlotOffsets.set(change.inventoryType, matches[0] - change.slot);
  return matches[0];
}


export function revertGainedByPlayer(
  effects: ReconciliationEffects,
  screenChange: ScreenItemChange,
  container: Container | undefined,
  cursor: PlayerCursorInventoryComponent | undefined,
  playerChanges: readonly PlayerSlotChangeRecord[],
  cursorChanges: readonly CursorItemChangeRecord[],
  dropChanges: readonly DroppedItemChangeRecord[],
): void {
  for (const change of playerChanges) {
    if (screenChange.remaining <= 0) {
      return;
    }
    if (change.matchedGain) {
      continue;
    }
    const gained = gainedBy(change);
    if (
      !gained ||
      gained.typeId !== screenChange.typeId ||
      gained.amount > screenChange.remaining
    ) {
      continue;
    }
    if (!container || !effects.revertPlayerSlot(container, change)) {
      continue;
    }
    change.matchedGain = true;
    screenChange.remaining -= gained.amount;
  }
  if (screenChange.remaining <= 0) {
    return;
  }
  if (cursor) {
    for (const change of cursorChanges) {
      if (screenChange.remaining <= 0) {
        return;
      }
      if (change.kind !== "grab" || change.matched) {
        continue;
      }
      if (
        stackType(change.item) !== screenChange.typeId ||
        stackAmount(change.item) > screenChange.remaining
      ) {
        continue;
      }
      if (!effects.clearCursorItem(cursor, change.item)) {
        continue;
      }
      change.matched = true;
      screenChange.remaining -= stackAmount(change.item);
    }
  }
  if (screenChange.remaining <= 0) {
    return;
  }
  for (const change of dropChanges) {
    if (screenChange.remaining <= 0) {
      return;
    }
    if (change.matched) {
      continue;
    }
    if (stackType(change.item) !== screenChange.typeId) {
      continue;
    }
    const amount = stackAmount(change.item);
    if (amount <= 0 || amount > screenChange.remaining) {
      continue;
    }
    if (!effects.removeDroppedItem(change)) {
      continue;
    }
    change.matched = true;
    screenChange.remaining -= amount;
  }
}


export function revertPlacedByPlayer(
  effects: ReconciliationEffects,
  screenChange: ScreenItemChange,
  container: Container | undefined,
  cursor: PlayerCursorInventoryComponent | undefined,
  playerChanges: readonly PlayerSlotChangeRecord[],
  cursorChanges: readonly CursorItemChangeRecord[],
): void {
  for (const change of playerChanges) {
    if (screenChange.remaining <= 0) {
      return;
    }
    if (change.matchedLoss) {
      continue;
    }
    const lost = lostBy(change);
    if (
      !lost ||
      lost.typeId !== screenChange.typeId ||
      lost.amount > screenChange.remaining
    ) {
      continue;
    }
    if (!container || !effects.revertPlayerSlot(container, change)) {
      continue;
    }
    change.matchedLoss = true;
    screenChange.remaining -= lost.amount;
  }
  if (screenChange.remaining <= 0 || !cursor) {
    return;
  }
  for (const change of cursorChanges) {
    if (screenChange.remaining <= 0) {
      return;
    }
    if (change.kind !== "release" || change.matched) {
      continue;
    }
    if (
      stackType(change.item) !== screenChange.typeId ||
      stackAmount(change.item) > screenChange.remaining
    ) {
      continue;
    }
    if (!container || !effects.returnToInventory(container, change.item)) {
      continue;
    }
    change.matched = true;
    screenChange.remaining -= stackAmount(change.item);
  }
}


export function recordScreenItemChange(
  changes: ScreenItemChange[],
  before: ItemStack | undefined,
  after: ItemStack | undefined,
): void {
  const beforeType = stackType(before);
  const afterType = stackType(after);
  if (beforeType !== undefined && beforeType === afterType) {
    const lost = stackAmount(before) - stackAmount(after);
    if (lost > 0) {
      changes.push({ kind: "take", typeId: beforeType, remaining: lost });
    } else if (lost < 0) {
      changes.push({
        kind: "placement",
        typeId: afterType,
        remaining: -lost,
      });
    }
    return;
  }
  if (beforeType !== undefined) {
    changes.push({
      kind: "take",
      typeId: beforeType,
      remaining: stackAmount(before),
    });
  }
  if (afterType !== undefined) {
    changes.push({
      kind: "placement",
      typeId: afterType,
      remaining: stackAmount(after),
    });
  }
}


export function pruneGuardRecords(playerChanges: PlayerSlotChangeRecord[], cursorChanges: CursorItemChangeRecord[], dropChanges: DroppedItemChangeRecord[]): void {
  const drop = (length: number, limit: number): number =>
    length <= limit ? 0 : length - limit;
  const playerDrop = drop(playerChanges.length, MAX_SCREEN_GUARD_RECORDS);
  if (playerDrop > 0) {
    playerChanges.splice(0, playerDrop);
  }
  const cursorDrop = drop(cursorChanges.length, MAX_SCREEN_GUARD_RECORDS);
  if (cursorDrop > 0) {
    cursorChanges.splice(0, cursorDrop);
  }
  const entityDrop = drop(dropChanges.length, MAX_SCREEN_GUARD_RECORDS);
  if (entityDrop > 0) {
    dropChanges.splice(0, entityDrop);
  }
}

interface WindowItemGuardOptions {
  isActive(): boolean;
  samePlayer(player: Player | undefined): boolean;
  getViewerId(): string | undefined;
  report(error: unknown, operation: "itemChange", slot?: number): void;
}

export class WindowItemGuard {
  readonly viewer: Player;
  readonly #isActive: () => boolean;
  readonly #samePlayer: (player: Player | undefined) => boolean;
  readonly #getViewerId: () => string | undefined;
  readonly #report: (error: unknown, operation: "itemChange", slot?: number) => void;
  #screenChanges: ScreenItemChange[] = [];
  #playerChanges: PlayerSlotChangeRecord[] = [];
  #cursorChanges: CursorItemChangeRecord[] = [];
  #dropChanges: DroppedItemChangeRecord[] = [];
  #guardReconcileQueued = false;
  #guardReconcileToken = 0;
  #applyingGuard = false;

  constructor(viewer: Player, options: WindowItemGuardOptions) {
    this.viewer = viewer;
    this.#isActive = options.isActive;
    this.#samePlayer = options.samePlayer;
    this.#getViewerId = options.getViewerId;
    this.#report = options.report;
  }

  recordScreenChange(before: ItemStack | undefined, after: ItemStack | undefined): void {
    recordScreenItemChange(this.#screenChanges, before, after);
  }

  queueReconcile(): void {
    this.#queueGuardReconcile();
  }

  reset(): void {
    this.#guardReconcileToken += 1;
    this.#guardReconcileQueued = false;
    this.#applyingGuard = false;
    this.#screenChanges = [];
    this.#playerChanges = [];
    this.#cursorChanges = [];
    this.#dropChanges = [];
  }

  #queueGuardReconcile(): void {
    if (this.#guardReconcileQueued) {
      return;
    }
    this.#guardReconcileQueued = true;
    const token = ++this.#guardReconcileToken;
    const run = (): void => {
      if (token !== this.#guardReconcileToken || !this.#guardReconcileQueued) {
        return;
      }
      this.#guardReconcileQueued = false;
      this.#reconcileScreenChanges();
    };
    const gameSystem: typeof server.system | undefined = server.system;
    if (gameSystem && typeof gameSystem.run === "function") {
      try {
        gameSystem.run(run);
        return;
      } catch {
        // A broken scheduler must not leave the guard pending forever.
      }
    }
    run();
  }


  #reconcileScreenChanges(): void {
    const screenChanges = this.#screenChanges;
    const playerChanges = this.#playerChanges;
    const cursorChanges = this.#cursorChanges;
    const dropChanges = this.#dropChanges;
    this.#screenChanges = [];
    this.#playerChanges = [];
    this.#cursorChanges = [];
    this.#dropChanges = [];
    if (screenChanges.length === 0) {
      return;
    }
    if (!this.#isActive()) {
      return;
    }
    const container = playerInventoryContainer(this.viewer);
    const cursor = this.#cursorInventory();
    if (!container && !cursor) {
      return;
    }
    const netScreenChanges = collapseScreenChanges(screenChanges);
    const netPlayerChanges = collapsePlayerChanges(playerChanges);
    const netCursorChanges = collapseCursorChanges(cursorChanges);
    const effects = {
      revertPlayerSlot: (container: Container, change: PlayerSlotChangeRecord) =>
        this.#revertPlayerSlot(container, change),
      clearCursorItem: (cursor: PlayerCursorInventoryComponent, item: ItemStack) =>
        this.#clearCursorItem(cursor, item),
      removeDroppedItem: (change: DroppedItemChangeRecord) => this.#removeDroppedItem(change),
      returnToInventory: (container: Container, item: ItemStack) =>
        this.#returnToInventory(container, item),
    };
    this.#applyingGuard = true;
    try {
      for (const screenChange of netScreenChanges) {
        if (screenChange.kind === "take") {
          revertGainedByPlayer(
            effects,
            screenChange,
            container,
            cursor,
            netPlayerChanges,
            netCursorChanges,
            dropChanges,
          );
        } else {
          revertPlacedByPlayer(
            effects,
            screenChange,
            container,
            cursor,
            netPlayerChanges,
            netCursorChanges,
          );
        }
      }
    } finally {
      this.#applyingGuard = false;
    }
  }


  #removeDroppedItem(change: DroppedItemChangeRecord): boolean {
    try {
      if (!change.entity.isValid) {
        return false;
      }
      const component = change.entity.getComponent("minecraft:item");
      if (!component || !sameItemContent(component.itemStack, change.item)) {
        return false;
      }
      change.entity.remove();
      return true;
    } catch (error) {
      this.#report(error, "itemChange");
      return false;
    }
  }


  #cursorInventory(): PlayerCursorInventoryComponent | undefined {
    try {
      return this.viewer.getComponent("minecraft:cursor_inventory");
    } catch {
      return undefined;
    }
  }


  #revertPlayerSlot(container: Container, change: PlayerSlotChangeRecord): boolean {
    const expected = change.after;
    if (!expected) {
      return false;
    }
    const slot = resolvePlayerSlot(container, change);
    if (slot === undefined) {
      return false;
    }
    try {
      container.setItem(slot, change.before);
      return true;
    } catch (error) {
      // The duplicate stays, but the screen content is consistent; closing
      // would not remove it, so report and keep the Window usable.
      this.#report(error, "itemChange", slot);
      return false;
    }
  }


  #clearCursorItem(
    cursor: PlayerCursorInventoryComponent,
    expected: ItemStack,
  ): boolean {
    let current: ItemStack | undefined;
    try {
      current = cursor.item;
    } catch {
      return false;
    }
    if (!sameTypeAndAmount(current, expected)) {
      return false;
    }
    try {
      cursor.clear();
      return true;
    } catch (error) {
      this.#report(error, "itemChange");
      return false;
    }
  }


  #returnToInventory(container: Container, item: ItemStack): boolean {
    try {
      const leftover = container.addItem(item);
      if (leftover !== undefined) {
        // The inventory is full: the item cannot be returned, but it must not
        // stay behind a screen slot that was already restored.
        this.#report(
          new Error("InvUI: cannot return the item placed into the screen; the inventory is full."),
          "itemChange",
        );
        return false;
      }
      return true;
    } catch (error) {
      this.#report(error, "itemChange");
      return false;
    }
  }


  _onViewerInventoryChange(event: PlayerInventoryItemChangeAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive()) {
      return;
    }
    if (!this.#samePlayer(event.player)) {
      return;
    }
    let inventoryType: PlayerInventoryType;
    let slot: number;
    let before: ItemStack | undefined;
    let after: ItemStack | undefined;
    try {
      inventoryType = event.inventoryType;
      slot = event.slot;
      before = event.beforeItemStack;
      after = event.itemStack;
    } catch {
      // The event may expose an invalid player/stack.
      return;
    }
    if (!Number.isInteger(slot) || slot < 0) {
      return;
    }
    if (stackType(before) === undefined && stackType(after) === undefined) {
      return;
    }
    this.#playerChanges.push({
      inventoryType,
      slot,
      before,
      after,
      matchedGain: false,
      matchedLoss: false,
    });
    pruneGuardRecords(this.#playerChanges, this.#cursorChanges, this.#dropChanges);
  }


  _onViewerCursorGrab(event: PlayerCursorItemGrabAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive()) {
      return;
    }
    if (!this.#samePlayer(event.player)) {
      return;
    }
    let item: ItemStack;
    try {
      item = event.item;
    } catch {
      return;
    }
    if (stackType(item) === undefined) {
      return;
    }
    this.#cursorChanges.push({ kind: "grab", item, matched: false });
    pruneGuardRecords(this.#playerChanges, this.#cursorChanges, this.#dropChanges);
  }


  _onViewerCursorRelease(event: PlayerCursorItemReleaseAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive()) {
      return;
    }
    if (!this.#samePlayer(event.player)) {
      return;
    }
    let item: ItemStack;
    try {
      item = event.item;
    } catch {
      return;
    }
    if (stackType(item) === undefined) {
      return;
    }
    this.#cursorChanges.push({ kind: "release", item, matched: false });
    pruneGuardRecords(this.#playerChanges, this.#cursorChanges, this.#dropChanges);
  }


  _onViewerItemDrop(event: EntityItemDropAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive()) {
      return;
    }
    const viewerId = this.#getViewerId() ?? readId(this.viewer);
    if (!viewerId) {
      return;
    }
    let droppedBy: string | undefined;
    let items: Entity[];
    try {
      droppedBy = event.entity?.id;
      items = event.items;
    } catch {
      return;
    }
    if (droppedBy !== viewerId || !Array.isArray(items)) {
      return;
    }
    for (const itemEntity of items) {
      let item: ItemStack | undefined;
      try {
        item = itemEntity.getComponent("minecraft:item")?.itemStack;
      } catch {
        item = undefined;
      }
      if (!item || stackType(item) === undefined) {
        continue;
      }
      this.#dropChanges.push({ entity: itemEntity, item, matched: false });
    }
    pruneGuardRecords(this.#playerChanges, this.#cursorChanges, this.#dropChanges);
  }

}
