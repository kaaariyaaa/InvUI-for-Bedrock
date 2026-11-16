/** Pure resolution of GUI structures into slot layouts. */
import { GuiLink, ScrollGui, TabGui, Markers } from "./gui.js";
import type { Gui, Structure, SlotElement, ResolvedGuiLayout } from "./gui.js";
import type { GuiState, GuiStatePatch } from "../state/state.js";

/* Layout resolution                                                          */
/* -------------------------------------------------------------------------- */

interface BaseGrid {
  slots: Array<SlotElement | null>;
  occupied: boolean[];
  contentSlots: number[];
  links: Array<{ link: GuiLink; slot: number }>;
}

interface ContentPlacement {
  page: number;
  pageCount: number;
}

export function resolveGui(gui: Gui, viewer: unknown, state: GuiState, stack: readonly Gui[]): ResolvedGuiLayout {
  if (stack.includes(gui)) {
    throw new Error("Cyclic GUI reference detected");
  }
  const nextStack = [...stack, gui];
  switch (gui.kind) {
    case "scroll":
      return resolveScroll(gui as ScrollGui, viewer, state, nextStack);
    case "tab":
      return resolveTab(gui as TabGui, viewer, state, nextStack);
    case "paged":
      return resolveContentGui(gui, viewer, state, nextStack, true);
    case "normal":
      return resolveContentGui(gui, viewer, state, nextStack, false);
    default:
      throw new Error(`Unknown GUI kind: ${String(gui.kind)}`);
  }
}

function resolveContentGui(
  gui: Gui,
  viewer: unknown,
  state: GuiState,
  stack: readonly Gui[],
  paged: boolean,
): ResolvedGuiLayout {
  const base = buildBaseGrid(gui._structure);
  const placement = placeContent(gui, base.contentSlots, base.slots, state, paged);
  const linkPatch = projectLinks(gui, base, viewer, state, stack);
  const statePatch: GuiStatePatch = {};
  if (paged && state.page !== undefined && state.page !== placement.page) {
    statePatch.page = placement.page;
  }
  const merged = mergeStatePatches(statePatch, linkPatch);

  return {
    kind: paged ? "paged" : "normal",
    width: gui._structure.width,
    height: gui._structure.height,
    size: base.slots.length,
    slots: base.slots,
    page: placement.page,
    pageCount: placement.pageCount,
    line: 0,
    maxLine: 0,
    tab: -1,
    tabCount: 0,
    contentSlots: base.contentSlots,
    ...(merged === undefined ? {} : { statePatch: merged }),
  };
}

function placeContent(
  gui: Gui,
  contentSlots: number[],
  slots: Array<SlotElement | null>,
  state: GuiState,
  paged: boolean,
): ContentPlacement {
  let page = 0;
  let pageCount = 1;
  let start = 0;
  let perPage = contentSlots.length;

  if (paged) {
    perPage = contentSlots.length;
    pageCount = perPage === 0 ? 1 : Math.max(1, Math.ceil(gui._content.length / perPage));
    page = clampIndex(state.page ?? 0, pageCount);
    start = page * perPage;
  }

  const available = Math.max(0, gui._content.length - start);
  const count = Math.min(perPage, available);
  for (let i = 0; i < count; i += 1) {
    slots[contentSlots[i]] = gui._content[start + i];
  }
  return { page, pageCount };
}

function resolveScroll(gui: ScrollGui, viewer: unknown, state: GuiState, stack: readonly Gui[]): ResolvedGuiLayout {
  const base = buildBaseGrid(gui._structure);
  const contentSlots = base.contentSlots;
  let line = 0;
  let maxLine = 0;

  if (contentSlots.length > 0) {
    const geometry = scrollGeometry(gui, contentSlots);
    const { visibleRows, visibleCols, minRow, minCol } = geometry;
    const content = gui._content;

    if (gui.direction === "vertical") {
      const rowWidth = gui.contentWidth ?? visibleCols;
      if (rowWidth < visibleCols) {
        throw new Error("ScrollGui contentWidth must be at least the visible marker width");
      }
      const totalRows = Math.ceil(content.length / rowWidth);
      maxLine = Math.max(0, totalRows - visibleRows);
      line = clampIndex(state.line ?? 0, maxLine + 1);

      for (const slot of contentSlots) {
        const row = Math.floor(slot / gui._structure.width) - minRow;
        const col = (slot % gui._structure.width) - minCol;
        const index = (line + row) * rowWidth + col;
        if (index < content.length) {
          base.slots[slot] = content[index];
        }
      }
    } else {
      const colHeight = gui.contentHeight ?? visibleRows;
      if (colHeight < visibleRows) {
        throw new Error("ScrollGui contentHeight must be at least the visible marker height");
      }
      const totalCols = Math.ceil(content.length / colHeight);
      maxLine = Math.max(0, totalCols - visibleCols);
      line = clampIndex(state.line ?? 0, maxLine + 1);

      for (const slot of contentSlots) {
        const row = Math.floor(slot / gui._structure.width) - minRow;
        const col = (slot % gui._structure.width) - minCol;
        const index = (line + col) * colHeight + row;
        if (index < content.length) {
          base.slots[slot] = content[index];
        }
      }
    }
  }

  const linkPatch = projectLinks(gui, base, viewer, state, stack);
  const statePatch: GuiStatePatch = {};
  if (state.line !== undefined && state.line !== line) {
    statePatch.line = line;
  }
  const merged = mergeStatePatches(statePatch, linkPatch);

  return {
    kind: "scroll",
    width: gui._structure.width,
    height: gui._structure.height,
    size: base.slots.length,
    slots: base.slots,
    page: 0,
    pageCount: 1,
    line,
    maxLine,
    tab: -1,
    tabCount: 0,
    contentSlots,
    ...(merged === undefined ? {} : { statePatch: merged }),
  };
}

function scrollGeometry(gui: ScrollGui, contentSlots: number[]) {
  const width = gui._structure.width;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  const positions = new Set<number>();

  for (const slot of contentSlots) {
    const row = Math.floor(slot / width);
    const col = slot % width;
    positions.add(slot);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
  }

  const visibleRows = maxRow - minRow + 1;
  const visibleCols = maxCol - minCol + 1;
  if (positions.size !== visibleRows * visibleCols) {
    throw new Error("ScrollGui content marker slots must form a rectangle");
  }
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      if (!positions.has(row * width + col)) {
        throw new Error("ScrollGui content marker slots must form a rectangle");
      }
    }
  }
  return { visibleRows, visibleCols, minRow, minCol, maxRow, maxCol };
}

function resolveTab(gui: TabGui, viewer: unknown, state: GuiState, stack: readonly Gui[]): ResolvedGuiLayout {
  const tab = clampIndex(state.tab ?? 0, gui.tabs.length);
  const storedTab = state.tabs ? state.tabs[tab] : undefined;
  const tabState = storedTab && typeof storedTab === "object" ? storedTab : {};
  const child = resolveGui(gui.tabs[tab], viewer, tabState, stack);
  const statePatch: GuiStatePatch = {};
  if (state.tab !== undefined && state.tab !== tab) {
    statePatch.tab = tab;
  }
  if (child.statePatch !== undefined) {
    // `tabs` replaces the map instead of merging, so carry the other tabs.
    const tabs: Record<number, GuiState> = { ...(state.tabs ?? {}) };
    tabs[tab] = { ...tabState, ...child.statePatch };
    statePatch.tabs = tabs;
  }
  const merged = Object.keys(statePatch).length > 0 ? statePatch : undefined;
  return {
    ...child,
    kind: "tab",
    tab,
    tabCount: gui.tabs.length,
    ...(merged === undefined ? {} : { statePatch: merged }),
  };
}

function buildBaseGrid(structure: Structure): BaseGrid {
  const width = structure.width;
  const size = width * structure.height;
  const slots: Array<SlotElement | null> = new Array(size).fill(null);
  const occupied: boolean[] = new Array(size).fill(false);
  const links: Array<{ link: GuiLink; slot: number }> = [];
  const horizontal: number[] = [];
  const vertical: number[] = [];

  for (let row = 0; row < structure.height; row += 1) {
    const chars = [...structure.rows[row]];
    for (let col = 0; col < width; col += 1) {
      const slot = row * width + col;
      const ingredient = structure.getIngredient(chars[col]);
      if (ingredient === undefined) {
        continue;
      }
      if (ingredient instanceof GuiLink) {
        links.push({ link: ingredient, slot });
        continue;
      }
      if (ingredient === Markers.CONTENT_LIST_SLOT_HORIZONTAL) {
        horizontal.push(slot);
        occupied[slot] = true;
        continue;
      }
      if (ingredient === Markers.CONTENT_LIST_SLOT_VERTICAL) {
        vertical.push(slot);
        occupied[slot] = true;
        continue;
      }
      if (typeof ingredient === "string") {
        throw new Error(`Unknown ingredient: ${JSON.stringify(ingredient)}`);
      }
      if (!isSlotElement(ingredient)) {
        throw new Error(`Invalid ingredient at slot ${slot}`);
      }
      slots[slot] = ingredient;
      occupied[slot] = true;
    }
  }

  if (horizontal.length > 0 && vertical.length > 0) {
    throw new Error("Structure cannot use both horizontal and vertical content markers");
  }

  let contentSlots: number[] = [];
  if (horizontal.length > 0) {
    contentSlots = horizontal.sort((a, b) => a - b);
  } else if (vertical.length > 0) {
    contentSlots = vertical.sort((a, b) => {
      const colA = a % width;
      const colB = b % width;
      return colA - colB || a - b;
    });
  }

  return { slots, occupied, contentSlots, links };
}

function projectLinks(
  gui: Gui,
  base: BaseGrid,
  viewer: unknown,
  state: GuiState,
  stack: readonly Gui[],
): GuiStatePatch | undefined {
  const parentWidth = gui._structure.width;
  const parentHeight = gui._structure.height;
  let children: Record<string, GuiState> | undefined;

  for (const { link, slot: placementSlot } of base.links) {
    const storedChild = link.key !== undefined && state.children ? state.children[link.key] : undefined;
    const childState = link.state ?? (storedChild && typeof storedChild === "object" ? storedChild : {});
    const child = resolveGui(link.gui, viewer, childState, stack);
    if (
      link.state === undefined &&
      link.key !== undefined &&
      storedChild !== undefined &&
      child.statePatch !== undefined
    ) {
      // `children` replaces the map instead of merging, so carry the others.
      children ??= { ...(state.children ?? {}) };
      children[link.key] = { ...storedChild, ...child.statePatch };
    }

    if (link.mapping) {
      for (const key of Object.keys(link.mapping)) {
        const childSlot = Number(key);
        if (!Number.isInteger(childSlot) || childSlot < 0 || childSlot >= child.size) {
          throw new Error(`GuiLink mapping child slot out of range: ${key}`);
        }
        const parentSlot = link.mapping[childSlot];
        assertWritable(base, parentSlot, "GuiLink mapping");
        const element = child.slots[childSlot];
        if (element !== null) {
          base.slots[parentSlot] = element;
        }
      }
      continue;
    }

    // Validate and claim the whole projected rectangle, not only the slots the
    // child currently fills: an empty child slot still means the link owns that
    // parent slot, so out-of-range/overlap must fail regardless of page state.
    const placementRow = Math.floor(placementSlot / parentWidth);
    const placementCol = placementSlot % parentWidth;
    for (let childSlot = 0; childSlot < child.size; childSlot += 1) {
      const row = placementRow + Math.floor(childSlot / child.width);
      const col = placementCol + (childSlot % child.width);
      if (row < 0 || row >= parentHeight || col < 0 || col >= parentWidth) {
        throw new Error(`GuiLink projection out of range at child slot ${childSlot}`);
      }
      const parentSlot = row * parentWidth + col;
      assertWritable(base, parentSlot, "GuiLink projection");
      const element = child.slots[childSlot];
      if (element !== null) {
        base.slots[parentSlot] = element;
      }
    }
  }
  return children === undefined ? undefined : { children };
}

function mergeStatePatches(
  own: GuiStatePatch,
  nested: GuiStatePatch | undefined,
): GuiStatePatch | undefined {
  if (nested === undefined) {
    return Object.keys(own).length > 0 ? own : undefined;
  }
  return { ...own, ...nested };
}

function assertWritable(base: BaseGrid, slot: number, source: string): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= base.slots.length) {
    throw new Error(`${source} slot out of range: ${slot}`);
  }
  if (base.occupied[slot]) {
    throw new Error(`Overlapping GUI elements at slot ${slot}`);
  }
  base.occupied[slot] = true;
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const index = Math.trunc(value);
  if (index < 0) {
    return 0;
  }
  if (index >= length) {
    return Math.max(0, length - 1);
  }
  return index;
}

/**
 * Item and InventoryLink are intentionally opaque here: any non-null object
 * that is not a marker/GuiLink is a slot element. This keeps the layout layer
 * independent of their implementation details.
 */
function isSlotElement(value: unknown): value is SlotElement {
  return typeof value === "object" && value !== null;
}
