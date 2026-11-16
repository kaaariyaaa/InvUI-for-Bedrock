/** Layout identity, slot mapping, and element classification for Window. */
import { GuiLink, ScrollGui, TabGui } from "../gui/gui.js";
import type { Gui, ResolvedGuiLayout, SlotElement } from "../gui/gui.js";
import type { Item } from "../item.js";
import type { InventoryLink } from "../inventory/inventory.js";

export function isItemElement(element: SlotElement | null | undefined): element is Item {
  return typeof (element as Item | null | undefined)?.resolve === "function";
}

/**
 * Only button-mode Items accept a click (design 10.5): a display Item may still
 * carry handlers, but the Window must not run them or report a click.
 */
export function isButtonElement(element: SlotElement | null | undefined): element is Item {
  return (
    isItemElement(element) &&
    typeof element.getMode === "function" &&
    element.getMode() === "button"
  );
}

export function isInventoryLinkElement(
  element: SlotElement | null | undefined,
): element is InventoryLink {
  return typeof (element as InventoryLink | null | undefined)?.getItem === "function";
}

/**
 * True when a Window state change cannot alter what this element displays.
 *
 * An InventoryLink reads its Inventory, which state changes do not touch (the
 * Inventory notifies its own changes). An Item proves the rest through its
 * provider source: only a fixed ItemStack or an ItemBuilder is known not to
 * receive the Window or its state. Every opaque provider is re-evaluated, so a
 * provider that reads `Window.getState()` is never skipped (design 11.4).
 */
export function isProvablyStateIndependent(element: SlotElement): boolean {
  if (isInventoryLinkElement(element)) {
    return true;
  }
  // Slot elements are duck-typed at runtime (Gui accepts any object and
  // Window calls resolve on it), so an element can look like an Item
  // without being one. Only an Item that proves state independence is skipped;
  // anything else stays opaque and is re-evaluated, as before design 11.4.
  if (!isItemElement(element) || typeof element.isStateIndependent !== "function") {
    return false;
  }
  try {
    return element.isStateIndependent();
  } catch {
    // A proof that throws proves nothing: re-evaluate the slot instead of
    // aborting the pass before its remaining slots render (which would leave
    // the applied layout unpresented and input closed until something else
    // happens to refresh the Window).
    return false;
  }
}

/**
 * Stable serialization of the GUI shape that state compatibility depends on:
 * kind, rows as an array (so a "/" inside a row cannot collide), scroll
 * settings, and the recursively referenced tab/link GUIs (link state keys
 * included). Cycles are rejected instead of recursing forever.
 *
 * ponytail: the token is not persisted anywhere except inside state records, so
 * the format change intentionally makes older persistent records fail with
 * SCHEMA_MISMATCH rather than silently loading against a different GUI.
 */
export function schemaOf(gui: Gui): string {
  return `invui-window:${JSON.stringify(schemaNodeOf(gui, []))}`;
}

export function schemaNodeOf(gui: Gui, ancestors: readonly Gui[]): unknown {
  if (ancestors.includes(gui)) {
    throw new Error("InvUI: Cyclic GUI reference in Window state schema.");
  }
  const stack = [...ancestors, gui];
  const node: Record<string, unknown> = {
    kind: gui.kind,
    rows: [...gui._structure.rows],
  };

  if (gui instanceof ScrollGui) {
    node.scroll = {
      direction: gui.direction,
      contentWidth: gui.contentWidth ?? null,
      contentHeight: gui.contentHeight ?? null,
    };
  }

  if (gui instanceof TabGui) {
    node.tabs = gui.tabs.map((tab) => schemaNodeOf(tab, stack));
  }

  const links: Array<{ key: string | null; gui: unknown }> = [];
  for (const ingredient of gui._structure._ingredients.values()) {
    if (ingredient instanceof GuiLink) {
      links.push({
        key: ingredient.key ?? null,
        gui: schemaNodeOf(ingredient.gui, stack),
      });
    }
  }
  links.sort((a, b) => {
    const keyA = a.key ?? "";
    const keyB = b.key ?? "";
    if (keyA !== keyB) {
      return keyA < keyB ? -1 : 1;
    }
    const guiA = JSON.stringify(a.gui);
    const guiB = JSON.stringify(b.gui);
    return guiA < guiB ? -1 : guiA > guiB ? 1 : 0;
  });
  if (links.length > 0) {
    node.links = links;
  }

  return node;
}

/**
 * The Bedrock chest screen always has nine columns, while a Structure may be
 * narrower. Logical slots stay row-major at `layout.width`; the physical
 * container index must use the fixed nine-column stride. Left aligned, matching
 * the documented chest layout (design 4).
 */
export const PHYSICAL_COLUMNS = 9;

/** Limit opening renders to avoid loops from repeated state updates. */

export function sameSlotElements(
  left: readonly (SlotElement | null)[],
  right: readonly (SlotElement | null)[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let slot = 0; slot < left.length; slot += 1) {
    if (left[slot] !== right[slot]) {
      return false;
    }
  }
  return true;
}

/** Compare clickable slots, page, tab, and dimensions. */
export function sameClickableLayout(left: ResolvedGuiLayout, right: ResolvedGuiLayout): boolean {
  return (
    left.page === right.page &&
    left.line === right.line &&
    left.tab === right.tab &&
    left.width === right.width &&
    left.height === right.height &&
    sameSlotElements(left.slots, right.slots)
  );
}

export function containerSizeOf(layout: ResolvedGuiLayout): number {
  return layout.height * PHYSICAL_COLUMNS;
}

export function physicalSlotOf(layout: ResolvedGuiLayout, logicalSlot: number): number {
  const row = Math.floor(logicalSlot / layout.width);
  const column = logicalSlot % layout.width;
  return row * PHYSICAL_COLUMNS + column;
}
