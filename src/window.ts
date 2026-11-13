/**
 * Window lifecycle (design chapter 8).
 *
 * SAFETY GATE: opening a screen in the real game is intentionally disabled.
 * Item-taking protection (JSON UI / InputBridge) and VirtualContainer click
 * handling are still unverified, so a real Minecraft screen could let a player
 * remove display items. `Window.open()` therefore refuses to run until the
 * caller supplies an explicit test adapter, and `WindowContainerAdapter` for
 * Minecraft always reports `canOpenScreens === false`.
 *
 * `createContainer()` still uses the official
 * `world.virtualContainerManager.create()` so layout sizes and titles can be
 * checked against the documented 1..54 / 256-byte limits.
 */
import { world } from "@minecraft/server";
import type {
  ItemStack,
  Player,
  VirtualContainer,
  VirtualContainerOptions,
} from "@minecraft/server";
import type { Gui, ResolvedGuiLayout, SlotElement } from "./gui.js";
import type { InventoryLink } from "./inventory.js";
import type { Item } from "./item.js";
import { StateManager } from "./state.js";
import type {
  GuiStatePatch,
  StateHandle,
  StateLifetime,
  StateScope,
  StateSnapshot,
} from "./state.js";

export type WindowCloseReason =
  | "PlayerClosed"
  | "PlayerDied"
  | "PlayerLeft"
  | "PlayerSpectating"
  | "ServerClosed";

export type WindowStatus = "created" | "opening" | "open" | "closing" | "closed";

export interface WindowErrorContext {
  readonly windowId: string;
  readonly operation: string;
  readonly slot?: number;
}

export type WindowErrorHandler = (error: unknown, context: WindowErrorContext) => void;
export type WindowOpenHandler = () => void;
export type WindowCloseHandler = (reason: WindowCloseReason) => void;

export class WindowOpenRejectedError extends Error {
  readonly code = "INVUI_WINDOW_OPEN_UNVERIFIED";

  constructor(
    message = "InvUI: Window.open() is disabled because screen item protection and click handling are unverified in the real game.",
  ) {
    super(message);
    this.name = "WindowOpenRejectedError";
  }
}

/**
 * The boundary between Window and the Bedrock screen API.
 *
 * `canOpenScreens` must be true only for an isolated test adapter. It is the
 * explicit opt-in that keeps production code from opening an unverified
 * screen.
 */
export interface WindowContainerAdapter {
  readonly canOpenScreens: boolean;
  createContainer(options: VirtualContainerOptions): VirtualContainer;
  openContainer(container: VirtualContainer, viewer: Player): void;
  closeContainer(container: VirtualContainer, viewer: Player): void;
}

/**
 * Real Bedrock adapter. It can create virtual containers (official API) but
 * never shows or closes a screen: that path is blocked until the manual
 * verification in design 10 and 18.2 is complete.
 */
export class MinecraftVirtualContainerAdapter implements WindowContainerAdapter {
  readonly canOpenScreens = false;

  createContainer(options: VirtualContainerOptions): VirtualContainer {
    return world.virtualContainerManager.create(options);
  }

  openContainer(_container: VirtualContainer, _viewer: Player): void {
    throw new WindowOpenRejectedError();
  }

  closeContainer(_container: VirtualContainer, _viewer: Player): void {
    throw new WindowOpenRejectedError();
  }
}

export const minecraftVirtualContainerAdapter = new MinecraftVirtualContainerAdapter();

let defaultStateManager: StateManager | undefined;

function defaultManager(): StateManager {
  defaultStateManager ??= new StateManager();
  return defaultStateManager;
}

function isItemElement(element: SlotElement | null | undefined): element is Item {
  return typeof (element as Item | null | undefined)?.resolve === "function";
}

function isInventoryLinkElement(
  element: SlotElement | null | undefined,
): element is InventoryLink {
  return typeof (element as InventoryLink | null | undefined)?.getItem === "function";
}

/** ponytail: kind/structure fingerprint only; use a full hash if schemas collide in practice. */
function schemaOf(gui: Gui): string {
  return `invui-window:${gui.kind}:${gui._structure.rows.join("/")}`;
}

/**
 * The Bedrock chest screen always has nine columns, while a Structure may be
 * narrower. Logical slots stay row-major at `layout.width`; the physical
 * container index must use the fixed nine-column stride. Left aligned, matching
 * the documented chest layout (design 4).
 */
const PHYSICAL_COLUMNS = 9;

function containerSizeOf(layout: ResolvedGuiLayout): number {
  return layout.height * PHYSICAL_COLUMNS;
}

function physicalSlotOf(layout: ResolvedGuiLayout, logicalSlot: number): number {
  const row = Math.floor(logicalSlot / layout.width);
  const column = logicalSlot % layout.width;
  return row * PHYSICAL_COLUMNS + column;
}

export interface WindowConfig {
  readonly viewer: Player;
  readonly title: string;
  readonly upperGui: Gui;
  readonly lowerGui: Gui | undefined;
  readonly stateScope: StateScope;
  readonly stateKey: string | undefined;
  readonly stateLifetime: StateLifetime;
  readonly stateManager: StateManager | undefined;
  readonly adapter: WindowContainerAdapter;
  readonly openHandlers: readonly WindowOpenHandler[];
  readonly closeHandlers: readonly WindowCloseHandler[];
  readonly errorHandler: WindowErrorHandler | undefined;
}

export class WindowBuilder {
  #viewer: Player | undefined;
  #title = "";
  #upperGui: Gui | undefined;
  #lowerGui: Gui | undefined;
  #stateScope: StateScope = "player";
  #stateKey: string | undefined;
  #stateLifetime: StateLifetime = "window";
  #stateManager: StateManager | undefined;
  #adapter: WindowContainerAdapter = minecraftVirtualContainerAdapter;
  #openHandlers: WindowOpenHandler[] = [];
  #closeHandlers: WindowCloseHandler[] = [];
  #errorHandler: WindowErrorHandler | undefined;

  setViewer(viewer: Player): this {
    if (!viewer || typeof viewer !== "object") {
      throw new TypeError("InvUI: Window viewer must be a Player.");
    }
    this.#viewer = viewer;
    return this;
  }

  setTitle(title: string): this {
    if (typeof title !== "string") {
      throw new TypeError("InvUI: Window title must be a string.");
    }
    this.#title = title;
    return this;
  }

  setUpperGui(gui: Gui): this {
    this.#upperGui = gui;
    return this;
  }

  /** Accepted for API parity; Bedrock does not let us render into the lower area. */
  setLowerGui(gui: Gui): this {
    this.#lowerGui = gui;
    return this;
  }

  setStateScope(scope: StateScope): this {
    if (scope !== "player" && scope !== "shared") {
      throw new TypeError('InvUI: state scope must be "player" or "shared".');
    }
    this.#stateScope = scope;
    return this;
  }

  setStateKey(key: string): this {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("InvUI: state key must be a non-empty string.");
    }
    this.#stateKey = key;
    return this;
  }

  setStateLifetime(lifetime: StateLifetime): this {
    if (lifetime !== "window" && lifetime !== "session" && lifetime !== "persistent") {
      throw new TypeError('InvUI: state lifetime must be "window", "session", or "persistent".');
    }
    this.#stateLifetime = lifetime;
    return this;
  }

  /** Share one StateManager between Windows. Defaults to a module-level manager. */
  setStateManager(manager: StateManager): this {
    if (!manager || typeof manager.acquire !== "function") {
      throw new TypeError("InvUI: state manager must be a StateManager.");
    }
    this.#stateManager = manager;
    return this;
  }

  /**
   * Test-only injection point. Production code should leave the real adapter,
   * whose `open()` always throws WindowOpenRejectedError.
   */
  setContainerAdapter(adapter: WindowContainerAdapter): this {
    if (!adapter || typeof adapter.createContainer !== "function") {
      throw new TypeError("InvUI: container adapter must implement createContainer().");
    }
    this.#adapter = adapter;
    return this;
  }

  addOpenHandler(handler: WindowOpenHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: open handler must be a function.");
    }
    this.#openHandlers.push(handler);
    return this;
  }

  addCloseHandler(handler: WindowCloseHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: close handler must be a function.");
    }
    this.#closeHandlers.push(handler);
    return this;
  }

  setErrorHandler(handler: WindowErrorHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: error handler must be a function.");
    }
    this.#errorHandler = handler;
    return this;
  }

  build(): Window {
    if (!this.#viewer) {
      throw new Error("InvUI: Window requires setViewer(player).");
    }
    if (!this.#upperGui) {
      throw new Error("InvUI: Window requires setUpperGui(gui).");
    }
    if (this.#stateScope === "shared" && this.#stateKey === undefined) {
      throw new Error("InvUI: shared state scope requires setStateKey(key).");
    }
    return new Window({
      viewer: this.#viewer,
      title: this.#title,
      upperGui: this.#upperGui,
      lowerGui: this.#lowerGui,
      stateScope: this.#stateScope,
      stateKey: this.#stateKey,
      stateLifetime: this.#stateLifetime,
      stateManager: this.#stateManager,
      adapter: this.#adapter,
      openHandlers: [...this.#openHandlers],
      closeHandlers: [...this.#closeHandlers],
      errorHandler: this.#errorHandler,
    });
  }
}

let nextWindowId = 1;

export class Window {
  readonly id = `window-${nextWindowId++}`;
  readonly viewer: Player;
  readonly title: string;
  readonly upperGui: Gui;
  readonly lowerGui: Gui | undefined;

  #status: WindowStatus = "created";
  #stateScope: StateScope;
  #stateKey: string | undefined;
  #stateLifetime: StateLifetime;
  #stateManager: StateManager;
  #adapter: WindowContainerAdapter;
  #openHandlers: readonly WindowOpenHandler[];
  #closeHandlers: readonly WindowCloseHandler[];
  #errorHandler: WindowErrorHandler | undefined;

  #container: VirtualContainer | undefined;
  #layout: ResolvedGuiLayout | undefined;
  #stateHandle: StateHandle | undefined;
  #stateSubscription: (() => void) | undefined;
  #elementSubscriptions: Array<() => void> = [];
  /** Per-slot render tokens so an older async provider cannot overwrite a newer result. */
  #slotRenderTokens = new Map<number, number>();
  #generation = 0;

  constructor(config: WindowConfig) {
    this.viewer = config.viewer;
    this.title = config.title;
    this.upperGui = config.upperGui;
    this.lowerGui = config.lowerGui;
    this.#stateScope = config.stateScope;
    this.#stateKey = config.stateKey;
    this.#stateLifetime = config.stateLifetime;
    this.#stateManager = config.stateManager ?? defaultManager();
    this.#adapter = config.adapter;
    this.#openHandlers = config.openHandlers;
    this.#closeHandlers = config.closeHandlers;
    this.#errorHandler = config.errorHandler;
  }

  static builder(): WindowBuilder {
    return new WindowBuilder();
  }

  get status(): WindowStatus {
    return this.#status;
  }

  get isOpen(): boolean {
    return this.#status === "open";
  }

  get container(): VirtualContainer | undefined {
    return this.#container;
  }

  /**
   * Opens the Window. With the real adapter this always throws
   * WindowOpenRejectedError before any Container is created or shown.
   */
  async open(): Promise<void> {
    if (this.#status !== "created" && this.#status !== "closed") {
      throw new Error(`InvUI: Window ${this.id} is already ${this.#status}.`);
    }
    if (!this.#adapter.canOpenScreens) {
      throw new WindowOpenRejectedError();
    }

    this.#status = "opening";
    const generation = ++this.#generation;

    try {
      const handle = this.#acquireState();
      this.#stateHandle = handle;

      const layout = this.upperGui.resolve(this.viewer, handle.get());
      const size = containerSizeOf(layout);
      if (size < 1 || size > 54) {
        throw new RangeError(`InvUI: Window size ${size} is outside the supported 1..54.`);
      }
      const options: VirtualContainerOptions =
        this.title.length === 0
          ? { size }
          : { size, title: this.title };
      const container = this.#adapter.createContainer(options);
      this.#container = container;
      this.#layout = layout;

      await this.#renderAll(generation);
      if (generation !== this.#generation || this.#status !== "opening") {
        return;
      }

      this.#adapter.openContainer(container, this.viewer);
      this.#status = "open";
      this.#subscribeToUpdates();
      this.#stateSubscription = handle.subscribe(() => {
        void this.#refresh(false);
      });
      this.#runOpenHandlers();
    } catch (error) {
      this.#teardown();
      this.#status = "closed";
      this.#report(error, "open");
      throw error;
    }
  }

  /**
   * Re-evaluate the GUI state and re-render the same container.
   *
   * Explicit refreshes re-evaluate every slot because item providers may have
   * changed without changing the slot's element reference.
   */
  async refresh(): Promise<void> {
    await this.#refresh(true);
  }

  /**
   * `reRenderUnchanged` is false for state-update refreshes: only slots whose
   * element reference changed are re-rendered (design 11.4). Item notifications
   * still re-render their slot directly, and `refresh()` re-renders everything.
   */
  async #refresh(reRenderUnchanged: boolean): Promise<void> {
    if (this.#status !== "open" || !this.#container || !this.#stateHandle) {
      return;
    }
    const generation = this.#generation;
    let layout: ResolvedGuiLayout;
    try {
      layout = this.upperGui.resolve(this.viewer, this.#stateHandle.get());
    } catch (error) {
      this.#report(error, "resolve");
      return;
    }
    const current = this.#layout;
    if (
      !current ||
      layout.width !== current.width ||
      layout.height !== current.height ||
      containerSizeOf(layout) !== this.#container.size
    ) {
      // Recreating the screen is required for a size change (design 8.4), and
      // that path depends on the unverified close/reopen behavior.
      this.#report(
        new Error("InvUI: layout size changed; reopen the Window to apply it."),
        "refresh",
      );
      return;
    }
    this.#layout = layout;
    try {
      if (reRenderUnchanged) {
        await this.#renderAll(generation);
      } else {
        await this.#renderChanged(current, layout, generation);
      }
      if (generation === this.#generation) {
        this.#subscribeToUpdates();
      }
    } catch (error) {
      // State updates must never surface as an unhandled rejection: report the
      // failure through the Window's error channel and keep the window usable.
      if (generation === this.#generation) {
        this.#report(error, "refresh");
      }
    }
  }

  /** Patch the Window's state. Subscribers (including this Window) refresh. */
  setState(patch: GuiStatePatch): StateSnapshot {
    if (!this.#stateHandle) {
      throw new Error(`InvUI: Window ${this.id} is not open.`);
    }
    return this.#stateHandle.set(patch);
  }

  getState(): StateSnapshot {
    if (!this.#stateHandle) {
      throw new Error(`InvUI: Window ${this.id} is not open.`);
    }
    return this.#stateHandle.get();
  }

  /**
   * Routes a click to the Item currently rendered at the logical `slot`.
   *
   * Clicks run on the state handle's queue, so shared-state windows process
   * them in order (design 12.1). The slot and display generation are checked
   * again when the queued task actually runs: a click that waited behind a
   * close, reopen, or page/tab change is discarded instead of invoking a stale
   * handler.
   */
  async handleClick(slot: number): Promise<boolean> {
    if (this.#status !== "open" || !this.#layout || !this.#stateHandle) {
      return false;
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.#layout.slots.length) {
      return false;
    }
    const layout = this.#layout;
    const element = layout.slots[slot];
    if (!isItemElement(element)) {
      return false;
    }
    const generation = this.#generation;
    const handle = this.#stateHandle;
    try {
      return await handle.enqueue(async () => {
        if (
          this.#status !== "open" ||
          this.#stateHandle !== handle ||
          generation !== this.#generation
        ) {
          return false;
        }
        let currentLayout: ResolvedGuiLayout;
        try {
          currentLayout = this.upperGui.resolve(this.viewer, handle.get());
        } catch (error) {
          this.#report(error, "click", slot);
          return false;
        }
        if (
          slot < 0 ||
          slot >= currentLayout.slots.length ||
          layout.page !== currentLayout.page ||
          layout.line !== currentLayout.line ||
          layout.tab !== currentLayout.tab ||
          layout.width !== currentLayout.width ||
          layout.height !== currentLayout.height ||
          currentLayout.slots[slot] !== element
        ) {
          return false;
        }
        await element.handleClick({ player: this.viewer, slot, window: this });
        return true;
      });
    } catch (error) {
      // A closed/reopened window discards queued clicks silently; a handler or
      // state-update failure while the window is live goes to the error channel.
      if (this.#status === "open" && generation === this.#generation) {
        this.#report(error, "click", slot);
      }
      return false;
    }
  }

  close(reason: WindowCloseReason = "ServerClosed"): void {
    if (this.#status === "closed") {
      return;
    }
    if (this.#status === "created") {
      this.#status = "closed";
      return;
    }

    const wasOpen = this.#status === "open";
    this.#status = "closing";
    this.#generation++;

    if (wasOpen && this.#container) {
      try {
        this.#adapter.closeContainer(this.#container, this.viewer);
      } catch (error) {
        this.#report(error, "close");
      }
    }

    this.#teardown();
    this.#status = "closed";

    if (wasOpen) {
      for (const handler of [...this.#closeHandlers]) {
        try {
          handler(reason);
        } catch (error) {
          this.#report(error, "closeHandler");
        }
      }
    }
  }

  #acquireState(): StateHandle {
    const common = {
      scope: this.#stateScope,
      lifetime: this.#stateLifetime,
      schema: schemaOf(this.upperGui),
    } as const;
    if (this.#stateScope === "shared") {
      return this.#stateManager.acquire({
        ...common,
        key: this.#stateKey as string,
      });
    }
    return this.#stateManager.acquire({
      ...common,
      ownerId: this.viewer.id,
      ...(this.#stateKey === undefined ? {} : { key: this.#stateKey }),
    });
  }

  async #renderAll(generation: number): Promise<void> {
    const layout = this.#layout;
    if (!layout) {
      return;
    }
    for (let slot = 0; slot < layout.slots.length; slot += 1) {
      if (generation !== this.#generation || !this.#container) {
        return;
      }
      await this.#renderSlot(slot);
    }
  }

  /** Re-render only slots whose element reference differs between layouts. */
  async #renderChanged(
    previous: ResolvedGuiLayout,
    next: ResolvedGuiLayout,
    generation: number,
  ): Promise<void> {
    for (let slot = 0; slot < next.slots.length; slot += 1) {
      if (generation !== this.#generation || !this.#container) {
        return;
      }
      if (previous.slots[slot] === next.slots[slot]) {
        continue;
      }
      await this.#renderSlot(slot);
    }
  }

  async #renderSlot(slot: number): Promise<void> {
    const layout = this.#layout;
    if (!layout || !this.#container) {
      return;
    }
    const generation = this.#generation;
    // A newer render for the same logical slot wins, regardless of which async
    // provider resolves first.
    const token = (this.#slotRenderTokens.get(slot) ?? 0) + 1;
    this.#slotRenderTokens.set(slot, token);
    const element = layout.slots[slot];

    let stack: ItemStack | undefined;
    try {
      stack = await this.#resolveElement(element);
    } catch (error) {
      // Keep the previous display item for provider failures (design 14.2).
      this.#report(error, "itemProvider", slot);
      return;
    }

    // Compare the element still occupying the slot rather than the layout
    // object: a state update replaces the layout, and an in-flight render for an
    // element that did not move must still apply. A moved/changed element means
    // this result is stale (design 11.4).
    const current = this.#layout;
    if (
      generation !== this.#generation ||
      !this.#container ||
      !current ||
      current.slots[slot] !== element ||
      this.#slotRenderTokens.get(slot) !== token
    ) {
      return;
    }
    try {
      this.#container.setItem(physicalSlotOf(current, slot), stack);
    } catch (error) {
      this.#report(error, "setItem", slot);
    }
  }

  async #resolveElement(element: SlotElement | null | undefined): Promise<ItemStack | undefined> {
    if (isItemElement(element)) {
      return element.resolve(this.viewer);
    }
    if (isInventoryLinkElement(element)) {
      return element.getItem();
    }
    return undefined;
  }

  #subscribeToUpdates(): void {
    this.#unsubscribeElements();
    const layout = this.#layout;
    if (!layout) {
      return;
    }
    for (let slot = 0; slot < layout.slots.length; slot += 1) {
      const element = layout.slots[slot];
      if (isItemElement(element) || isInventoryLinkElement(element)) {
        try {
          this.#elementSubscriptions.push(
            element.subscribe(() => {
              void this.#renderSlot(slot);
            }),
          );
        } catch (error) {
          // A broken element subscription must not abort the state-update path.
          this.#report(error, "subscribe", slot);
        }
      }
    }
  }

  #unsubscribeElements(): void {
    for (const unsubscribe of this.#elementSubscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        this.#report(error, "unsubscribe");
      }
    }
    this.#elementSubscriptions = [];
  }

  #teardown(): void {
    this.#stateSubscription?.();
    this.#stateSubscription = undefined;
    this.#unsubscribeElements();
    this.#stateHandle?.release();
    this.#stateHandle = undefined;
    this.#container = undefined;
    this.#layout = undefined;
    this.#slotRenderTokens.clear();
  }

  #runOpenHandlers(): void {
    for (const handler of [...this.#openHandlers]) {
      try {
        handler();
      } catch (error) {
        this.#report(error, "openHandler");
      }
    }
  }

  #report(error: unknown, operation: string, slot?: number): void {
    const context: WindowErrorContext = {
      windowId: this.id,
      operation,
      ...(slot === undefined ? {} : { slot }),
    };
    if (this.#errorHandler) {
      try {
        this.#errorHandler(error, context);
      } catch (handlerError) {
        console.error("InvUI: Window error handler failed.", handlerError);
      }
      return;
    }
    console.error(`InvUI: Window ${this.id} ${operation} failed.`, error);
  }
}
