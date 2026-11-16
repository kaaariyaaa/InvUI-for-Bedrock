/** Event capture and matching helpers for screen item restoration. */
import * as server from "@minecraft/server";
import { readId } from "./window-lifecycle.js";
import type {
  Container,
  Entity,
  ItemStack,
  Player,
  PlayerCursorInventoryComponent,
  PlayerInventoryType,
  PlayerInventoryItemChangeAfterEvent,
  PlayerCursorItemGrabAfterEvent,
  PlayerCursorItemReleaseAfterEvent,
  EntityItemDropAfterEvent,
} from "@minecraft/server";
import type { Window } from "./window.js";
import { afterEventState, ensureAfterEventSubscription } from "./window-lifecycle.js";

/* Screen item guard
 * Restore changed screen slots immediately. On the next tick, reconcile
 * matching inventory, cursor, and drop events without scanning unrelated items.
 *
 * Unmatched container changes are retried for a few ticks (the Window stays
 * tracked while it settles): this covers a player event delivered after the
 * first pass and a cursor item the game returns to the inventory when the
 * screen closes. A reverted slot is watched briefly because the engine/client
 * can write the removed stack back, and a snapshot diff of the player inventory
 * removes a take whose player-side event never arrived.
 */

/** One item type the screen lost (`take`) or gained (`placement`). */
export interface ScreenItemChange {
  readonly kind: "take" | "placement";
  readonly typeId: string;
  /** Amount of this type still to match against player-side changes. */
  remaining: number;
  /** Physical container slot the change came from, for diagnostics. */
  readonly slot: number;
  /** Tick the change was recorded; retries stop after a few ticks. */
  readonly createdTick: number;
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

/** A slot whose leaked stack may be written back by the engine/client. */
interface RevertedSlotWatch {
  readonly slot: number;
  /** State the slot must be returned to. */
  readonly expected: ItemStack | undefined;
  /** Stacks that may be written back into the slot. */
  readonly leaked: ItemStack[];
  expiresAt: number;
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

/**
 * Ticks an unmatched container change is retried before it is given up as a
 * leak. The player-side event can be delivered after the end-of-tick `run`
 * callback, and closing the screen can return a cursor item to the inventory
 * one tick later; both would be missed by a single pass.
 */
const SCREEN_GUARD_RETRY_TICKS = 5;

/** Ticks a reverted slot is re-checked for the same stack coming back. */
const SCREEN_GUARD_WATCH_TICKS = 60;

/**
 * Ticks a removed take is remembered. If a later player-side change reports
 * the removed stack as its `beforeItemStack`, that stack was the engine/client
 * writing the taken item back, not a new item; the revert uses the remembered
 * pre-take state instead of re-adding it.
 */
const SCREEN_GUARD_RECENT_TAKE_TICKS = 200;

/** `system.currentTick`, or 0 in an environment without the scheduler. */
function currentTick(): number {
  try {
    const tick = server.system?.currentTick;
    return typeof tick === "number" ? tick : 0;
  } catch {
    return 0;
  }
}

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

/** Diagnostic rendering of one stack, for guard warnings only. */
function describeStack(item: ItemStack | undefined): string {
  const typeId = stackType(item);
  return typeId === undefined ? "empty" : `${typeId} x${stackAmount(item)}`;
}

/** Diagnostic rendering of the player's 36 inventory slots. */
function describePlayerInventory(player: Player): string {
  const container = playerInventoryContainer(player);
  if (!container) {
    return "unavailable";
  }
  const parts: string[] = [];
  for (let slot = 0; slot < container.size; slot += 1) {
    const item = readContainerItem(container, slot);
    if (stackType(item) !== undefined) {
      parts.push(`${slot}:${describeStack(item)}`);
    }
  }
  return parts.length === 0 ? "empty" : parts.join(",");
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
  /** `trackTake` watches the reverted slot for the engine writing the take back. */
  revertPlayerSlot(container: Container, change: PlayerSlotChangeRecord, trackTake: boolean): boolean;
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
        slot: change.slot,
        createdTick: change.createdTick,
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
  snapshot?: readonly (ItemStack | undefined)[],
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
  let matches = candidates.filter((slot) =>
    sameTypeAndAmount(readContainerItem(container, slot), expected),
  );
  if (matches.length > 1 && snapshot) {
    // Two candidates hold the same item now. The candidate whose last known
    // content equals the event's `beforeItemStack` is the one that changed.
    const beforeType = stackType(change.before);
    const beforeAmount = stackAmount(change.before);
    const byBefore = matches.filter((slot) => {
      const known = snapshot[slot];
      const knownType = stackType(known);
      if (knownType === undefined) {
        return beforeType === undefined;
      }
      return knownType === beforeType && stackAmount(known) === beforeAmount;
    });
    if (byBefore.length === 1) {
      matches = byBefore;
    }
  }
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
    if (!container || !effects.revertPlayerSlot(container, change, true)) {
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
    if (!container || !effects.revertPlayerSlot(container, change, false)) {
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
  slot: number,
): void {
  const createdTick = currentTick();
  const push = (kind: "take" | "placement", typeId: string, amount: number): void => {
    if (amount <= 0) {
      return;
    }
    changes.push({ kind, typeId, remaining: amount, slot, createdTick });
  };
  const beforeType = stackType(before);
  const afterType = stackType(after);
  if (beforeType !== undefined && beforeType === afterType) {
    const lost = stackAmount(before) - stackAmount(after);
    if (lost > 0) {
      push("take", beforeType, lost);
    } else if (lost < 0) {
      push("placement", afterType, -lost);
    }
    return;
  }
  if (beforeType !== undefined) {
    push("take", beforeType, stackAmount(before));
  }
  if (afterType !== undefined) {
    push("placement", afterType, stackAmount(after));
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
  /**
   * Called once the guard has nothing left to reconcile for an inactive
   * Window. The Window drops itself from {@link itemGuardWindows} here so a
   * closed Window does not stay tracked after its pending changes settle.
   */
  onSettled?(): void;
}

export class WindowItemGuard {
  readonly viewer: Player;
  readonly #isActive: () => boolean;
  readonly #samePlayer: (player: Player | undefined) => boolean;
  readonly #getViewerId: () => string | undefined;
  readonly #report: (error: unknown, operation: "itemChange", slot?: number) => void;
  readonly #onSettled: (() => void) | undefined;
  #screenChanges: ScreenItemChange[] = [];
  #playerChanges: PlayerSlotChangeRecord[] = [];
  #cursorChanges: CursorItemChangeRecord[] = [];
  #dropChanges: DroppedItemChangeRecord[] = [];
  /**
   * Recently reverted slots. The engine (or the client's predicted inventory)
   * can put the taken stack back into the slot a moment later, often when the
   * next container move is processed. Each watch re-clears the slot while it
   * still holds the exact stack that was removed.
   *
   * ponytail: a fixed 3s watch on one slot. A legitimate pickup of the same
   * stack into that slot inside the window is indistinguishable and would be
   * removed too; shorten the window or add real item identity if that is ever
   * observed.
   */
  #guardWatches: RevertedSlotWatch[] = [];
  /** Recently removed takes, used to recognise the same stack coming back. */
  #recentTakes: RevertedSlotWatch[] = [];
  /**
   * Last known player inventory contents (type and amount), used only to
   * disambiguate the undocumented event slot mapping when two candidate slots
   * hold the same item after a change, and to remove a take whose player-side
   * event never arrived. Refreshed by the Window at open and after a
   * reconciliation that matched every change.
   */
  #inventorySnapshot: Array<ItemStack | undefined> | undefined;
  #guardReconcileQueued = false;
  #guardReconcileToken = 0;
  #applyingGuard = false;

  constructor(viewer: Player, options: WindowItemGuardOptions) {
    this.viewer = viewer;
    this.#isActive = options.isActive;
    this.#samePlayer = options.samePlayer;
    this.#getViewerId = options.getViewerId;
    this.#report = options.report;
    this.#onSettled = options.onSettled;
  }

  /**
   * True while a recorded screen change has not been fully reconciled. The
   * Window stays in {@link itemGuardWindows} after a close while this is true,
   * so a player event delivered after the close is still matched.
   */
  hasPendingChanges(): boolean {
    return this.#screenChanges.length > 0;
  }

  recordScreenChange(
    before: ItemStack | undefined,
    after: ItemStack | undefined,
    slot = -1,
  ): void {
    recordScreenItemChange(this.#screenChanges, before, after, slot);
  }

  queueReconcile(): void {
    this.#queueGuardReconcile();
  }

  /** Record the player's current inventory contents (type and amount). */
  refreshInventorySnapshot(): void {
    this.#refreshInventorySnapshot();
  }

  /**
   * Drop the engine-write watches of the previous screen without discarding
   * pending screen changes (the Window keeps them after a close).
   */
  discardWatches(): void {
    this.#guardWatches = [];
    this.#recentTakes = [];
  }

  /** Forget every pending change, event record, watch, and queued pass. */
  reset(): void {
    this.#guardReconcileToken += 1;
    this.#guardReconcileQueued = false;
    this.#applyingGuard = false;
    this.#screenChanges = [];
    this.#playerChanges = [];
    this.#cursorChanges = [];
    this.#dropChanges = [];
    this.discardWatches();
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
    if (screenChanges.length === 0 && this.#guardWatches.length === 0) {
      return;
    }
    const container = playerInventoryContainer(this.viewer);
    const cursor = this.#cursorInventory();
    const netScreenChanges = collapseScreenChanges(screenChanges);
    const netPlayerChanges = collapsePlayerChanges(playerChanges);
    const netCursorChanges = collapseCursorChanges(cursorChanges);
    const effects = {
      revertPlayerSlot: (container: Container, change: PlayerSlotChangeRecord, trackTake: boolean) =>
        this.#revertPlayerSlot(container, change, trackTake),
      clearCursorItem: (cursor: PlayerCursorInventoryComponent, item: ItemStack) =>
        this.#clearCursorItem(cursor, item),
      removeDroppedItem: (change: DroppedItemChangeRecord) => this.#removeDroppedItem(change),
      returnToInventory: (container: Container, item: ItemStack) =>
        this.#returnToInventory(container, item),
    };
    this.#applyingGuard = true;
    try {
      const watchesActive = this.#verifyGuardWatches();
      if (netScreenChanges.length === 0) {
        if (watchesActive) {
          this.#queueGuardReconcile();
        }
        return;
      }
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
          // Last resort when the player-side event is missing (or arrives
          // later than every retry): diff the live inventory against the
          // snapshot taken before the screen change.
          if (screenChange.remaining > 0 && container) {
            this.#revertSnapshotGain(screenChange, container);
          }
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

      // Keep unmatched changes for a few ticks: the player-side event can
      // arrive after this pass, and closing the screen can return a cursor
      // item to the inventory on a later tick. The window stays tracked for
      // those events (see #teardown), even after it closed.
      const now = currentTick();
      const carried: ScreenItemChange[] = [];
      for (const change of netScreenChanges) {
        if (change.remaining <= 0) {
          continue;
        }
        if (now - change.createdTick <= SCREEN_GUARD_RETRY_TICKS) {
          carried.push(change);
          continue;
        }
        const detail = netPlayerChanges
          .map(
            (record) =>
              `${record.inventoryType}:${record.slot} ${describeStack(record.before)} -> ${describeStack(record.after)}`,
          )
          .join("; ");
        console.warn(
          `InvUI: could not remove ${change.typeId} x${change.remaining} taken from screen slot ${change.slot}; the item may remain with the player. playerChanges=[${detail}] inventory=[${describePlayerInventory(this.viewer)}]`,
        );
      }
      if (carried.length > 0) {
        this.#screenChanges = carried.concat(this.#screenChanges);
        this.#queueGuardReconcile();
        return;
      }
      if (!this.#isActive()) {
        // Closed and settled: stop tracking the Window for guard events.
        this.#onSettled?.();
        return;
      }
      this.#refreshInventorySnapshot();
    } finally {
      this.#applyingGuard = false;
    }
  }

  /**
   * Remember a take that was just removed from `slot`. The watch re-clears the
   * slot if the engine/client writes the stack back, and the recent-take list
   * lets a later event's `before` be recognised as that ghost instead of being
   * restored.
   */
  #watchRevertedSlot(
    slot: number,
    expected: ItemStack | undefined,
    leaked: ItemStack | undefined,
  ): void {
    if (leaked === undefined || stackType(leaked) === undefined) {
      return;
    }
    let expectedCopy: ItemStack | undefined;
    let leakedCopy: ItemStack;
    try {
      expectedCopy = expected === undefined ? undefined : expected.clone();
      leakedCopy = leaked.clone();
    } catch {
      return;
    }
    const now = currentTick();

    const index = this.#guardWatches.findIndex((watch) => watch.slot === slot);
    if (index >= 0) {
      const existing = this.#guardWatches[index];
      // Keep the first `expected` (the true pre-take state). A later take in
      // the same slot may have written a ghost `before`, which must not become
      // the value the slot is restored to.
      if (!existing.leaked.some((item) => sameItemContent(item, leakedCopy))) {
        existing.leaked.push(leakedCopy);
      }
      existing.expiresAt = Math.max(
        existing.expiresAt,
        now + SCREEN_GUARD_WATCH_TICKS,
      );
    } else {
      this.#guardWatches.push({
        slot,
        expected: expectedCopy,
        leaked: [leakedCopy],
        expiresAt: now + SCREEN_GUARD_WATCH_TICKS,
      });
    }

    this.#recentTakes = this.#recentTakes.filter((record) => now <= record.expiresAt);
    this.#recentTakes.push({
      slot,
      expected: expectedCopy === undefined ? undefined : expectedCopy.clone(),
      leaked: [leakedCopy.clone()],
      expiresAt: now + SCREEN_GUARD_RECENT_TAKE_TICKS,
    });
    this.#queueGuardReconcile();
  }

  /**
   * Remove the watched stack again when the engine/client puts it back into
   * the reverted slot (often while the next container move is processed).
   * Returns true while any watch is still active so the next tick is queued.
   */
  #verifyGuardWatches(): boolean {
    if (this.#guardWatches.length === 0) {
      return false;
    }
    const container = playerInventoryContainer(this.viewer);
    if (!container) {
      this.#guardWatches = [];
      return false;
    }
    const now = currentTick();
    const keep: RevertedSlotWatch[] = [];
    for (const watch of this.#guardWatches) {
      if (now > watch.expiresAt) {
        continue;
      }
      const current = readContainerItem(container, watch.slot);
      if (watch.leaked.some((item) => sameItemContent(current, item))) {
        try {
          container.setItem(watch.slot, watch.expected);
        } catch (error) {
          this.#report(error, "itemChange", watch.slot);
          continue;
        }
        // Keep watching for a moment in case the engine writes it back again.
        watch.expiresAt = Math.max(watch.expiresAt, now + 5);
        keep.push(watch);
        continue;
      }
      if (sameItemContent(current, watch.expected)) {
        keep.push(watch);
        continue;
      }
      // The slot now holds something else (the player moved on): stop.
    }
    this.#guardWatches = keep;
    return keep.length > 0;
  }

  /**
   * Last resort when the player-side event is missing (or arrives later than
   * every retry): compare the live player inventory with the snapshot taken
   * before the screen change and revert a slot whose gain matches the item the
   * screen lost. The slot is only touched when its item type matches and the
   * gain is no larger than what is still unaccounted for.
   */
  #revertSnapshotGain(screenChange: ScreenItemChange, container: Container): void {
    const snapshot = this.#inventorySnapshot;
    if (snapshot === undefined) {
      return;
    }
    const size = Math.min(container.size, snapshot.length);
    for (let slot = 0; slot < size && screenChange.remaining > 0; slot += 1) {
      const current = readContainerItem(container, slot);
      if (stackType(current) !== screenChange.typeId) {
        continue;
      }
      const known = snapshot[slot];
      const knownAmount =
        stackType(known) === screenChange.typeId ? stackAmount(known) : 0;
      const gained = stackAmount(current) - knownAmount;
      if (gained <= 0 || gained > screenChange.remaining) {
        continue;
      }
      let restore: ItemStack | undefined;
      try {
        restore = known === undefined ? undefined : known.clone();
      } catch {
        restore = known;
      }
      try {
        container.setItem(slot, restore);
      } catch (error) {
        this.#report(error, "itemChange", slot);
        continue;
      }
      snapshot[slot] = restore;
      this.#watchRevertedSlot(slot, restore, current);
      screenChange.remaining -= gained;
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


  /**
   * Restore one changed player inventory slot to its `beforeItemStack`.
   *
   * The event's `slot` is not documented to be the container index, so the
   * write is made only to a candidate the live container confirms still holds
   * the event's `itemStack`. When two candidates match, or none does, nothing
   * is written: refusing to guess is safer than deleting a player's own stack.
   */
  #revertPlayerSlot(
    container: Container,
    change: PlayerSlotChangeRecord,
    trackTake: boolean,
  ): boolean {
    const expected = change.after;
    if (!expected) {
      return false;
    }
    const slot = resolvePlayerSlot(container, change, this.#inventorySnapshot);
    if (slot === undefined) {
      return false;
    }
    // If the `before` stack is one this guard recently removed from the same
    // slot, the engine/client has put the ghost back. Revert to the state from
    // before the take instead of writing the ghost stack back in.
    const ghost = this.#findRecentTake(slot, change.before);
    const target = ghost === undefined ? change.before : ghost.expected;
    try {
      container.setItem(slot, target);
      const snapshot = this.#inventorySnapshot;
      if (snapshot && slot < snapshot.length) {
        snapshot[slot] = target === undefined ? undefined : target.clone();
      }
      if (trackTake) {
        this.#watchRevertedSlot(slot, target, change.after);
      }
      return true;
    } catch (error) {
      // The duplicate stays, but the screen content is consistent; closing
      // would not remove it, so report and keep the Window usable.
      this.#report(error, "itemChange", slot);
      return false;
    }
  }

  /** A recent take whose removed stack equals `before` in the same slot. */
  #findRecentTake(
    slot: number,
    before: ItemStack | undefined,
  ): RevertedSlotWatch | undefined {
    if (before === undefined) {
      return undefined;
    }
    const now = currentTick();
    this.#recentTakes = this.#recentTakes.filter((record) => now <= record.expiresAt);
    for (const record of this.#recentTakes) {
      if (record.slot !== slot) {
        continue;
      }
      if (record.leaked.some((item) => sameItemContent(item, before))) {
        return record;
      }
    }
    return undefined;
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

  /** Record the player's current inventory contents (type and amount). */
  #refreshInventorySnapshot(): void {
    const container = playerInventoryContainer(this.viewer);
    if (!container) {
      this.#inventorySnapshot = undefined;
      return;
    }
    const snapshot: Array<ItemStack | undefined> = [];
    for (let slot = 0; slot < container.size; slot += 1) {
      const item = readContainerItem(container, slot);
      let copy: ItemStack | undefined;
      try {
        copy = item === undefined ? undefined : item.clone();
      } catch {
        copy = item;
      }
      snapshot.push(copy);
    }
    this.#inventorySnapshot = snapshot;
  }

  /**
   * Internal: one `playerInventoryItemChange` of any player; the viewer filter
   * and the "screen is open" check happen here. Only recorded, never acted on:
   * the reconciliation pass decides whether a screen change explains it.
   */
  _onViewerInventoryChange(event: PlayerInventoryItemChangeAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    // Keep recording after a close while a screen change is still pending:
    // closing with an item on the cursor returns it to the inventory then.
    if (!this.#isActive() && !this.hasPendingChanges()) {
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
    if (this.#screenChanges.length > 0) {
      this.#queueGuardReconcile();
    }
  }


  _onViewerCursorGrab(event: PlayerCursorItemGrabAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive() && !this.hasPendingChanges()) {
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
    if (this.#screenChanges.length > 0) {
      this.#queueGuardReconcile();
    }
  }


  _onViewerCursorRelease(event: PlayerCursorItemReleaseAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive() && !this.hasPendingChanges()) {
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
    if (this.#screenChanges.length > 0) {
      this.#queueGuardReconcile();
    }
  }


  _onViewerItemDrop(event: EntityItemDropAfterEvent): void {
    if (this.#applyingGuard) {
      return;
    }
    if (!this.#isActive() && !this.hasPendingChanges()) {
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
    if (this.#screenChanges.length > 0) {
      this.#queueGuardReconcile();
    }
  }

}
