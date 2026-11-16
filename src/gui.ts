/** GUI layout calculation, independent of Minecraft runtime APIs. */
import type { Item } from "./item.js";
import type { InventoryLink } from "./inventory.js";
import type { GuiState, GuiStatePatch } from "./state.js";

export type GuiKind = "normal" | "paged" | "scroll" | "tab";
export type ScrollDirection = "vertical" | "horizontal";

/** An element that can occupy one GUI slot. */
export type SlotElement = Item | InventoryLink;

/** Markers for the content list positions declared by a Structure. */
export const Markers = Object.freeze({
  CONTENT_LIST_SLOT_HORIZONTAL: "content_list_slot_horizontal",
  CONTENT_LIST_SLOT_VERTICAL: "content_list_slot_vertical",
} as const);

export type Marker = (typeof Markers)[keyof typeof Markers];
export type Ingredient = SlotElement | GuiLink | Marker;

export interface ResolvedGuiLayout {
  kind: GuiKind;
  width: number;
  height: number;
  size: number;
  /** Slot elements in row-major order. `null` means empty. */
  slots: Array<SlotElement | null>;
  page: number;
  pageCount: number;
  line: number;
  maxLine: number;
  tab: number;
  tabCount: number;
  /** Structure slots that make up the content list, in content order. */
  contentSlots: number[];
  /**
   * State fields the layout had to clamp because the stored page/line/tab is
   * outside the current content range (design 9.5). A Window writes this back
   * so a shrunk content list cannot leave an out-of-range value behind that
   * reappears when the content grows again.
   */
  statePatch?: GuiStatePatch;
}

export interface GuiOptions {
  structure: Structure | readonly string[];
  ingredients?: Record<string, Ingredient>;
  content?: readonly SlotElement[];
}

export interface PagedGuiOptions extends GuiOptions {}

export interface ScrollGuiOptions extends GuiOptions {
  direction?: ScrollDirection;
  /** Number of content entries per row for vertical scrolling. */
  contentWidth?: number;
  /** Number of content entries per column for horizontal scrolling. */
  contentHeight?: number;
}

export interface TabGuiOptions {
  /** Non-empty list of child GUIs, indexed by `state.tab`. */
  tabs: readonly Gui[];
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A character layout. One Unicode code point is one slot.
 *
 * Every row must have the same width. Width is limited to 9 and height to 6.
 * Characters without an ingredient are empty slots.
 */
export class Structure {
  readonly rows: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly _ingredients: Map<string, Ingredient>;

  constructor(...rows: Array<string | readonly string[]>) {
    const flat: string[] = [];
    for (const row of rows) {
      if (typeof row === "string") {
        flat.push(row);
      } else if (Array.isArray(row)) {
        for (const value of row) {
          if (typeof value !== "string") {
            throw new Error("Structure rows must be strings");
          }
          flat.push(value);
        }
      } else {
        throw new Error("Structure rows must be strings");
      }
    }

    if (flat.length === 0) {
      throw new Error("Structure requires at least one row");
    }
    if (flat.length > 6) {
      throw new Error(`Structure height ${flat.length} exceeds the maximum of 6`);
    }

    const width = [...flat[0]].length;
    if (width < 1) {
      throw new Error("Structure rows must not be empty");
    }
    if (width > 9) {
      throw new Error(`Structure width ${width} exceeds the maximum of 9`);
    }
    for (const row of flat) {
      if ([...row].length !== width) {
        throw new Error("All Structure rows must have the same width");
      }
    }

    this.rows = Object.freeze([...flat]);
    this.width = width;
    this.height = flat.length;
    this._ingredients = new Map();
  }

  addIngredient(key: string, ingredient: Ingredient): this {
    if ([...key].length !== 1) {
      throw new Error(`Ingredient key must be exactly one character: ${JSON.stringify(key)}`);
    }
    this._ingredients.set(key, ingredient);
    return this;
  }

  getIngredient(key: string): Ingredient | undefined {
    return this._ingredients.get(key);
  }

  clone(): Structure {
    const copy = new Structure(...this.rows);
    for (const [key, ingredient] of this._ingredients) {
      copy.addIngredient(key, ingredient);
    }
    return copy;
  }
}

/* -------------------------------------------------------------------------- */
/* GUI definitions                                                            */
/* -------------------------------------------------------------------------- */

/** Notified after a GUI's content or ingredients change. */
export type GuiUpdateListener = () => void;

/**
 * Base normal GUI. Use `Gui.normal(options)` for declarative construction,
 * `Gui.normal()` for the builder, or `new Gui(options)` directly.
 */
export class Gui {
  readonly kind: GuiKind;
  readonly _structure: Structure;
  _content: readonly SlotElement[];

  /** Listeners registered with `subscribe()`. */
  #listeners = new Set<GuiUpdateListener>();
  /** Internal forwarders that carry the cycle guard from a linked child. */
  #forwarders = new Set<(visited: Set<Gui>) => void>();
  /** Child GUI -> its subscription to us, active only while we have listeners. */
  #linked = new Map<Gui, () => void>();

  constructor(options: GuiOptions, kind: GuiKind = "normal") {
    const normalized = normalizeGuiOptions(options);
    this.kind = kind;
    this._structure = normalized.structure;
    this._content = Object.freeze([...normalized.content]);
  }

  /**
   * Register for content/ingredient changes (design 11.1). While a listener is
   * registered, changes to child GUIs reached through `GuiLink` are forwarded
   * too, so a Window subscribed to the root sees every layout-affecting change.
   */
  subscribe(listener: GuiUpdateListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("GUI update listener must be a function");
    }
    this.#listeners.add(listener);
    if (this.#interestCount() === 1) {
      this.#attachLinks();
    }
    return () => {
      if (!this.#listeners.delete(listener)) {
        return;
      }
      if (this.#interestCount() === 0) {
        this.#detachLinks();
      }
    };
  }

  /**
   * Replace the content list. The input is copied and validated before the
   * current content changes, so a rejected call leaves the GUI untouched.
   */
  setContent(content: readonly SlotElement[]): this {
    if (this.kind === "tab") {
      throw new Error("TabGui does not use content");
    }
    if (!Array.isArray(content)) {
      throw new TypeError("Gui content must be an array");
    }
    for (const element of content) {
      assertSlotElement(element);
    }
    const next = Object.freeze([...content]);
    if (sameElements(this._content, next)) {
      return this;
    }
    this._content = next;
    this._notifyChanged();
    return this;
  }

  /**
   * Set one Structure ingredient by key. Validates before mutating, rejects
   * marker mixes and GuiLink cycles, and notifies only on a real change.
   */
  setIngredient(key: string, ingredient: Ingredient): this {
    if (this.kind === "tab") {
      throw new Error("TabGui does not use a rendered Structure");
    }
    assertIngredient(ingredient);
    assertIngredientKey(key);
    assertMarkerConflict(this._structure, key, ingredient);
    assertNoCycle(this, ingredient);
    if (this._structure.getIngredient(key) === ingredient) {
      return this;
    }
    this._structure.addIngredient(key, ingredient);
    this.#syncLinks();
    this._notifyChanged();
    return this;
  }

  /** Remove an ingredient; its characters become empty slots. */
  removeIngredient(key: string): this {
    if (this.kind === "tab") {
      throw new Error("TabGui does not use a rendered Structure");
    }
    assertIngredientKey(key);
    if (!this._structure._ingredients.has(key)) {
      return this;
    }
    this._structure._ingredients.delete(key);
    this.#syncLinks();
    this._notifyChanged();
    return this;
  }

  /**
   * Child GUIs whose changes invalidate this layout. Overridden by TabGui,
   * whose rendered child is not stored as a Structure ingredient.
   */
  _linkedGuis(): readonly Gui[] {
    const guis: Gui[] = [];
    for (const ingredient of this._structure._ingredients.values()) {
      if (ingredient instanceof GuiLink) {
        guis.push(ingredient.gui);
      }
    }
    return guis;
  }

  /**
   * Fan out a change to listeners and linked parents. `visited` carries across
   * the propagation so a GuiLink cycle cannot recurse forever.
   */
  _notifyChanged(visited: Set<Gui> = new Set()): void {
    if (visited.has(this)) {
      return;
    }
    visited.add(this);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        // One broken subscriber must not prevent the remaining updates.
        console.error("InvUI: GUI update listener failed.", error);
      }
    }
    for (const forward of [...this.#forwarders]) {
      try {
        forward(visited);
      } catch (error) {
        console.error("InvUI: GUI update listener failed.", error);
      }
    }
  }

  /** Internal: forward a linked child's change without losing the cycle guard. */
  _subscribeLinked(forwarder: (visited: Set<Gui>) => void): () => void {
    this.#forwarders.add(forwarder);
    if (this.#interestCount() === 1) {
      this.#attachLinks();
    }
    return () => {
      if (!this.#forwarders.delete(forwarder)) {
        return;
      }
      if (this.#interestCount() === 0) {
        this.#detachLinks();
      }
    };
  }

  #interestCount(): number {
    return this.#listeners.size + this.#forwarders.size;
  }

  #syncLinks(): void {
    if (this.#interestCount() === 0) {
      return;
    }
    this.#detachLinks();
    this.#attachLinks();
  }

  #attachLinks(): void {
    for (const child of this._linkedGuis()) {
      if (this.#linked.has(child)) {
        continue;
      }
      this.#linked.set(
        child,
        child._subscribeLinked((visited) => this._notifyChanged(visited)),
      );
    }
  }

  #detachLinks(): void {
    const unsubscribes = [...this.#linked.values()];
    this.#linked.clear();
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  }

  /**
   * Calculate the final slot array. `viewer` is forwarded to nested GUIs for
   * future per-viewer providers; this layout layer does not inspect it.
   * `state` is supplied by the caller (normally a Window) on every call.
   */
  resolve(viewer: unknown = null, state: GuiState = {}): ResolvedGuiLayout {
    return resolveGui(this, viewer, state, []);
  }

  static builder(): GuiBuilder {
    return new GuiBuilder();
  }

  static normal(): GuiBuilder;
  static normal(options: GuiOptions): Gui;
  static normal(options?: GuiOptions): Gui | GuiBuilder {
    return options === undefined ? new GuiBuilder() : new Gui(options);
  }

  static paged(): PagedGuiBuilder;
  static paged(options: PagedGuiOptions): PagedGui;
  static paged(options?: PagedGuiOptions): PagedGui | PagedGuiBuilder {
    return options === undefined ? new PagedGuiBuilder() : new PagedGui(options);
  }

  static scroll(): ScrollGuiBuilder;
  static scroll(options: ScrollGuiOptions): ScrollGui;
  static scroll(options?: ScrollGuiOptions): ScrollGui | ScrollGuiBuilder {
    return options === undefined ? new ScrollGuiBuilder() : new ScrollGui(options);
  }

  static tab(): TabGuiBuilder;
  static tab(options: TabGuiOptions): TabGui;
  static tab(options?: TabGuiOptions): TabGui | TabGuiBuilder {
    return options === undefined ? new TabGuiBuilder() : new TabGui(options);
  }
}

export interface GuiLinkMapping {
  /** child slot -> parent slot */
  [childSlot: number]: number;
}

export interface GuiLinkOptions {
  /** Key used to look up `state.children[key]` when resolving the child GUI. */
  key?: string;
  /** Explicit child state. Takes precedence over `key`. */
  state?: GuiState;
  /** Explicit child-slot to parent-slot projection. Defaults to top-left offset. */
  mapping?: GuiLinkMapping;
}

/**
 * Projects another GUI into the parent layout. Nesting is allowed; cycles are
 * rejected when the layout is resolved.
 */
export class GuiLink {
  readonly gui: Gui;
  readonly key: string | undefined;
  readonly state: GuiState | undefined;
  readonly mapping: GuiLinkMapping | undefined;

  constructor(gui: Gui, options: GuiLinkOptions = {}) {
    if (!(gui instanceof Gui)) {
      throw new Error("GuiLink requires a Gui");
    }
    this.gui = gui;
    this.key = options.key;
    this.state = options.state;
    this.mapping = options.mapping;
  }
}

export class PagedGui extends Gui {
  constructor(options: PagedGuiOptions) {
    super(options, "paged");
  }

  /** Java-InvUI-compatible alias for `Gui.paged()`. */
  static itemsBuilder(): PagedGuiBuilder {
    return new PagedGuiBuilder();
  }
}

export class ScrollGui extends Gui {
  readonly direction: ScrollDirection;
  readonly contentWidth: number | undefined;
  readonly contentHeight: number | undefined;

  constructor(options: ScrollGuiOptions) {
    super(options, "scroll");
    const direction = options.direction ?? "vertical";
    if (direction !== "vertical" && direction !== "horizontal") {
      throw new Error(`Invalid scroll direction: ${String(direction)}`);
    }
    if (options.contentWidth !== undefined && (!Number.isInteger(options.contentWidth) || options.contentWidth < 1)) {
      throw new Error("ScrollGui contentWidth must be a positive integer");
    }
    if (options.contentHeight !== undefined && (!Number.isInteger(options.contentHeight) || options.contentHeight < 1)) {
      throw new Error("ScrollGui contentHeight must be a positive integer");
    }
    this.direction = direction;
    this.contentWidth = options.contentWidth;
    this.contentHeight = options.contentHeight;
  }
}

export class TabGui extends Gui {
  readonly tabs: readonly Gui[];

  constructor(options: TabGuiOptions) {
    // TabGui delegates the whole layout to the selected child; the 1x1
    // structure only satisfies the base class contract and is never rendered.
    super({ structure: [" "] }, "tab");
    if (!options || !Array.isArray(options.tabs) || options.tabs.length === 0) {
      throw new Error("TabGui requires at least one tab");
    }
    for (const tab of options.tabs) {
      if (!(tab instanceof Gui)) {
        throw new Error("TabGui tabs must be Gui instances");
      }
    }
    this.tabs = Object.freeze([...options.tabs]);
  }

  /** TabGui's rendered child is selected at resolve time, not stored as a link. */
  override _linkedGuis(): readonly Gui[] {
    return this.tabs;
  }
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

export class GuiBuilder {
  _structureSource: Structure | readonly string[] | undefined;
  _ingredients: Record<string, Ingredient> = {};
  _content: readonly SlotElement[] = [];

  setStructure(structure: Structure | readonly string[]): this {
    this._structureSource = structure;
    return this;
  }

  addIngredient(key: string, ingredient: Ingredient): this {
    if ([...key].length !== 1) {
      throw new Error(`Ingredient key must be exactly one character: ${JSON.stringify(key)}`);
    }
    this._ingredients[key] = ingredient;
    return this;
  }

  setContent(content: readonly SlotElement[]): this {
    this._content = [...content];
    return this;
  }

  _options(): GuiOptions {
    if (this._structureSource === undefined) {
      throw new Error("Structure is required before build()");
    }
    return {
      structure: this._structureSource,
      ingredients: { ...this._ingredients },
      content: this._content,
    };
  }

  build(): Gui {
    return new Gui(this._options());
  }
}

export class PagedGuiBuilder extends GuiBuilder {
  build(): PagedGui {
    return new PagedGui(this._options());
  }
}

export class ScrollGuiBuilder extends GuiBuilder {
  _direction: ScrollDirection = "vertical";
  _contentWidth: number | undefined;
  _contentHeight: number | undefined;

  setDirection(direction: ScrollDirection): this {
    this._direction = direction;
    return this;
  }

  setContentWidth(width: number): this {
    this._contentWidth = width;
    return this;
  }

  setContentHeight(height: number): this {
    this._contentHeight = height;
    return this;
  }

  build(): ScrollGui {
    const width = this._contentWidth;
    const height = this._contentHeight;
    return new ScrollGui({
      ...this._options(),
      direction: this._direction,
      ...(width === undefined ? {} : { contentWidth: width }),
      ...(height === undefined ? {} : { contentHeight: height }),
    });
  }
}

export class TabGuiBuilder {
  _tabs: Gui[] = [];

  setTabs(tabs: readonly Gui[]): this {
    this._tabs = [...tabs];
    return this;
  }

  addTab(tab: Gui): this {
    this._tabs.push(tab);
    return this;
  }

  build(): TabGui {
    return new TabGui({ tabs: this._tabs });
  }
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

function normalizeGuiOptions(options: GuiOptions): { structure: Structure; content: readonly SlotElement[] } {
  if (!options || !options.structure) {
    throw new Error("Gui options require a structure");
  }
  const structure =
    options.structure instanceof Structure ? options.structure.clone() : new Structure(options.structure);
  if (options.ingredients) {
    for (const [key, ingredient] of Object.entries(options.ingredients)) {
      structure.addIngredient(key, ingredient);
    }
  }
  return {
    structure,
    content: options.content ? [...options.content] : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Mutation validation                                                        */
/* -------------------------------------------------------------------------- */

function assertSlotElement(value: unknown): asserts value is SlotElement {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof GuiLink) {
    throw new TypeError("Gui content must contain only Item or InventoryLink elements");
  }
}

function assertIngredientKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || [...key].length !== 1) {
    throw new TypeError(`Ingredient key must be exactly one character: ${JSON.stringify(key)}`);
  }
}

function assertIngredient(ingredient: unknown): asserts ingredient is Ingredient {
  if (typeof ingredient === "string") {
    if (
      ingredient !== Markers.CONTENT_LIST_SLOT_HORIZONTAL &&
      ingredient !== Markers.CONTENT_LIST_SLOT_VERTICAL
    ) {
      throw new TypeError(`Unknown ingredient: ${JSON.stringify(ingredient)}`);
    }
    return;
  }
  if (typeof ingredient !== "object" || ingredient === null || Array.isArray(ingredient)) {
    throw new TypeError("Ingredient must be an Item, InventoryLink, GuiLink, or content marker");
  }
}

function markerKindOf(ingredient: Ingredient): "horizontal" | "vertical" | undefined {
  if (ingredient === Markers.CONTENT_LIST_SLOT_HORIZONTAL) {
    return "horizontal";
  }
  if (ingredient === Markers.CONTENT_LIST_SLOT_VERTICAL) {
    return "vertical";
  }
  return undefined;
}

/** Reject mixing markers up front instead of failing on the next resolve. */
function assertMarkerConflict(structure: Structure, key: string, ingredient: Ingredient): void {
  const kind = markerKindOf(ingredient);
  if (kind === undefined) {
    return;
  }
  for (const [otherKey, other] of structure._ingredients) {
    if (otherKey === key) {
      continue;
    }
    const otherKind = markerKindOf(other);
    if (otherKind !== undefined && otherKind !== kind) {
      throw new Error("Structure cannot use both horizontal and vertical content markers");
    }
  }
}

/** GuiLink cycles would make resolve fail, so ingredient changes reject them early. */
function assertNoCycle(parent: Gui, ingredient: Ingredient): void {
  if (!(ingredient instanceof GuiLink)) {
    return;
  }
  const pending: Gui[] = [ingredient.gui];
  const seen = new Set<Gui>();
  while (pending.length > 0) {
    const gui = pending.pop() as Gui;
    if (gui === parent) {
      throw new Error("Cyclic GUI reference detected");
    }
    if (seen.has(gui)) {
      continue;
    }
    seen.add(gui);
    pending.push(...gui._linkedGuis());
  }
}

function sameElements(a: readonly SlotElement[], b: readonly SlotElement[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
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

function resolveGui(gui: Gui, viewer: unknown, state: GuiState, stack: readonly Gui[]): ResolvedGuiLayout {
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
