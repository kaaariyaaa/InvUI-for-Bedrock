/** Slot rendering utilities shared by Window render passes. */
import type { ItemStack, Player, VirtualContainer } from "@minecraft/server";
import type { ResolvedGuiLayout, SlotElement } from "../gui/gui.js";
import type { SlotWriteCache } from "../render/render-cache.js";
import {
  PHYSICAL_COLUMNS,
  physicalSlotOf,
  isItemElement,
  isInventoryLinkElement,
} from "./window-layout.js";

export type SlotWriteResult =
  | { readonly status: "written" | "skipped" }
  | { readonly status: "failed"; readonly error: unknown };

/** Clear columns abandoned when a narrower layout reuses a container. */
export function clearUnmappedColumns(
  layout: ResolvedGuiLayout,
  container: VirtualContainer | undefined,
  cache: SlotWriteCache | undefined,
  onError: (error: unknown, physicalSlot: number) => void,
): boolean {
  if (!container || !cache) {
    return true;
  }
  let cleared = true;
  for (let row = 0; row < layout.height; row += 1) {
    for (let column = layout.width; column < PHYSICAL_COLUMNS; column += 1) {
      const physicalSlot = row * PHYSICAL_COLUMNS + column;
      if (physicalSlot >= container.size || !cache.shouldWrite(physicalSlot, undefined)) {
        continue;
      }
      try {
        container.setItem(physicalSlot, undefined);
      } catch (error) {
        onError(error, physicalSlot);
        cleared = false;
        continue;
      }
      cache.markWritten(physicalSlot, undefined);
    }
  }
  return cleared;
}

/** Write a resolved slot while preserving the empty-write cache and failures. */
export function writeRenderedSlot(
  layout: ResolvedGuiLayout,
  container: VirtualContainer,
  cache: SlotWriteCache,
  slot: number,
  stack: ItemStack | undefined,
): SlotWriteResult {
  const physicalSlot = physicalSlotOf(layout, slot);
  if (!cache.shouldWrite(physicalSlot, stack)) {
    return { status: "skipped" };
  }
  try {
    container.setItem(physicalSlot, stack);
  } catch (error) {
    cache.markFailed(physicalSlot);
    return { status: "failed", error };
  }
  cache.markWritten(physicalSlot, stack);
  return { status: "written" };
}

export async function resolveSlotElement(
  viewer: Player,
  element: SlotElement | null | undefined,
): Promise<ItemStack | undefined> {
  if (isItemElement(element)) {
    return element.resolve(viewer);
  }
  if (isInventoryLinkElement(element)) {
    return element.getItem();
  }
  return undefined;
}

/** Track an asynchronous provider without delaying initial placeholder drawing. */
export function watchPendingSlot(
  pending: Promise<ItemStack | undefined>,
  callbacks: {
    apply(stack: ItemStack | undefined): void;
    isCurrent(): boolean;
    onError(error: unknown): void;
  },
): void {
  void pending
    .then(
      (stack) => callbacks.apply(stack),
      (error) => {
        if (callbacks.isCurrent()) {
          callbacks.onError(error);
        }
      },
    )
    .catch((error) => {
      console.error("InvUI: pending item provider result failed.", error);
    });
}
