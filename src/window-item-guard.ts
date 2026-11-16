/** Event capture and matching helpers for screen item restoration. */
import type { Container, Entity, ItemStack, Player, PlayerInventoryType, PlayerInventoryItemChangeAfterEvent, PlayerCursorItemGrabAfterEvent, PlayerCursorItemReleaseAfterEvent, EntityItemDropAfterEvent } from "@minecraft/server";
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
