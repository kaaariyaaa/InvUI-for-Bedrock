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
  VirtualContainerCloseAfterEvent,
  VirtualContainerCloseReason,
  VirtualContainerItemChangeAfterEvent,
  VirtualContainerOptions,
} from "@minecraft/server";
import { GuiLink, ScrollGui, TabGui } from "./gui.js";
import type { Gui, ResolvedGuiLayout, SlotElement } from "./gui.js";
import type { InventoryLink } from "./inventory.js";
import type { Item } from "./item.js";
import { SlotWriteCache } from "./render-cache.js";
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
  | "ServerClosed"
  | "UserBusy";

export type WindowStatus = "created" | "opening" | "open" | "closing" | "closed";

export interface WindowErrorContext {
  readonly windowId: string;
  readonly operation: string;
  readonly slot?: number;
}

export type WindowErrorHandler = (error: unknown, context: WindowErrorContext) => void;
export type WindowOpenHandler = () => void;
/**
 * Called once per close, in registration order.
 *
 * A handler may close and reopen the Window, which starts a new generation:
 * the remaining handlers then belong to the generation that is already gone and
 * are not called, and an exception thrown by such a handler is not reported
 * either (the error handler could close the reopened Window).
 */
export type WindowCloseHandler = (reason: WindowCloseReason) => void;

/**
 * Adapter-side screen events. The Window filters them again by player and
 * container identity, so an adapter may forward events for other players or
 * containers without affecting this Window.
 */
export interface WindowContainerCloseEvent {
  readonly container: VirtualContainer;
  readonly player: Player;
  readonly reason: WindowCloseReason;
}

export interface WindowContainerItemChangeEvent {
  readonly container: VirtualContainer;
  readonly player: Player;
  readonly slot: number;
}

export type WindowContainerCloseHandler = (event: WindowContainerCloseEvent) => void;
export type WindowContainerItemChangeHandler = (
  event: WindowContainerItemChangeEvent,
) => void;

function assertErrorHandler(handler: WindowErrorHandler): void {
  if (typeof handler !== "function") {
    throw new TypeError("InvUI: error handler must be a function.");
  }
}

function isSamePlayer(eventPlayer: Player | undefined, viewer: Player): boolean {
  if (!eventPlayer) {
    return false;
  }
  if (eventPlayer === viewer) {
    return true;
  }
  try {
    return eventPlayer.id === viewer.id;
  } catch {
    // A departed player can be invalid; comparing it must not throw.
    return false;
  }
}

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
 * Reported through the error handler (operation `itemChange`) when a player
 * changes the Window's container through the screen. The change is not treated
 * as a click and the previous item is not restored: the render is stopped and
 * the screen is closed instead, because moves/copies through the screen are
 * unverified.
 */
export class WindowItemChangeDangerError extends Error {
  readonly code = "INVUI_CONTAINER_ITEM_CHANGE";
  readonly slot: number;

  constructor(slot: number) {
    super(
      `InvUI: slot ${slot} of the Window container was changed through the screen. Rendering is stopped and the Window is closing.`,
    );
    this.name = "WindowItemChangeDangerError";
    this.slot = slot;
  }
}

/**
 * Reported through the error handler (operation `guiChange` for a structural
 * GUI update, `setState` for a write that raced it) when the upper GUI's shape
 * no longer matches the schema the state was acquired with. The state identity
 * still describes the old shape, so persisting it would save new state under a
 * stale schema token: the write is refused and the Window closes instead.
 */
export class WindowStateSchemaChangedError extends Error {
  readonly code = "INVUI_STATE_SCHEMA_CHANGED";

  constructor() {
    super(
      "InvUI: the GUI shape changed after the Window state was acquired. State updates are refused and the Window is closing.",
    );
    this.name = "WindowStateSchemaChangedError";
  }
}

/**
 * Reported through the error handler (operation `open`) and thrown from
 * `open()` when state or GUI changes keep arriving on every render pass. A
 * provider that writes state while it renders (or a listener that does so)
 * would otherwise keep `open()` in its retry loop forever, so the Window fails
 * closed instead of opening a stale screen.
 */
export class WindowOpenRenderLimitError extends Error {
  readonly code = "INVUI_WINDOW_OPEN_RENDER_LIMIT";
  readonly passes: number;

  constructor(passes: number) {
    super(
      `InvUI: rendering did not settle after ${passes} passes while opening; the Window is closing.`,
    );
    this.name = "WindowOpenRenderLimitError";
    this.passes = passes;
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
  /**
   * Optional event hooks. The Window subscribes before it opens the screen and
   * unsubscribes on close or on a failed open. Both return an unsubscribe
   * function; the Window removes a subscription that succeeded even when the
   * other one throws.
   */
  subscribeClose?(handler: WindowContainerCloseHandler): () => void;
  subscribeItemChange?(handler: WindowContainerItemChangeHandler): () => void;
}

/**
 * Translate Bedrock's close reason into the Window's. The pinned
 * @minecraft/server beta mirrors `WindowCloseReason` member for member, but the
 * two string enums are not assignable to each other, so map explicitly.
 * An unknown future reason is reported as `ServerClosed`: the Window still
 * closes and the close handlers get a defined reason.
 */
function toWindowCloseReason(reason: VirtualContainerCloseReason): WindowCloseReason {
  switch (reason as string) {
    case "PlayerClosed":
      return "PlayerClosed";
    case "PlayerDied":
      return "PlayerDied";
    case "PlayerLeft":
      return "PlayerLeft";
    case "PlayerSpectating":
      return "PlayerSpectating";
    case "UserBusy":
      return "UserBusy";
    case "ServerClosed":
      return "ServerClosed";
    default:
      return "ServerClosed";
  }
}

/**
 * Real Bedrock adapter. It can create virtual containers and observe the
 * official close/itemChange after events, but never shows or closes a screen:
 * that path is blocked until the manual verification in design 10 and 18.2 is
 * complete.
 *
 * The event hooks are detection, not protection. Both game events are `after`
 * events, so a close or item change has already happened when the handler runs;
 * subscribing cannot prevent it or restore the previous item.
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

  /**
   * Forwards every player's virtual container close event. The Window filters
   * by container identity and player, so this stays a single global
   * subscription per open Window.
   */
  subscribeClose(handler: WindowContainerCloseHandler): () => void {
    const signal = world.afterEvents.virtualContainerClose;
    const callback = (event: VirtualContainerCloseAfterEvent): void => {
      handler({
        container: event.container,
        player: event.player,
        reason: toWindowCloseReason(event.reason),
      });
    };
    signal.subscribe(callback);
    return () => signal.unsubscribe(callback);
  }

  /**
   * Forwards every player's virtual container item-change event. This is an
   * `after` event: the slot was already changed through the screen, so this is
   * detection only and cannot prevent the move.
   */
  subscribeItemChange(handler: WindowContainerItemChangeHandler): () => void {
    const signal = world.afterEvents.virtualContainerItemChange;
    const callback = (event: VirtualContainerItemChangeAfterEvent): void => {
      handler({
        container: event.container,
        player: event.player,
        slot: event.slot,
      });
    };
    signal.subscribe(callback);
    return () => signal.unsubscribe(callback);
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

/**
 * Only button-mode Items accept a click (design 10.5): a display Item may still
 * carry handlers, but the Window must not run them or report a click.
 */
function isButtonElement(element: SlotElement | null | undefined): element is Item {
  return (
    isItemElement(element) &&
    typeof element.getMode === "function" &&
    element.getMode() === "button"
  );
}

function isInventoryLinkElement(
  element: SlotElement | null | undefined,
): element is InventoryLink {
  return typeof (element as InventoryLink | null | undefined)?.getItem === "function";
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
function schemaOf(gui: Gui): string {
  return `invui-window:${JSON.stringify(schemaNodeOf(gui, []))}`;
}

function schemaNodeOf(gui: Gui, ancestors: readonly Gui[]): unknown {
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
const PHYSICAL_COLUMNS = 9;

/**
 * Maximum render passes `open()` performs before it refuses to keep chasing
 * changes. A normal open settles in one pass; the extra headroom covers a
 * provider or listener that changes state a finite number of times while the
 * screen is being prepared.
 *
 * ponytail: a fixed pass count is a blunt ceiling: a legitimately slow but
 * finite caller (for example one deferred state write per tick) that needs more
 * than this many passes fails instead of opening. Raise the constant, or
 * replace the count with a time budget or a state-version comparison, if such
 * an opening flow ever becomes real.
 */
export const MAX_OPEN_RENDER_PASSES = 100;

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
    assertErrorHandler(handler);
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
  #title: string;
  #upperGui: Gui;
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
  /**
   * Previous container of an in-progress title regeneration. Its screen is
   * still shown while the replacement is rendered, so close/itemChange events
   * for it still belong to this Window: filtering them out by identity would
   * both miss the player's action and leave the old screen open when the
   * regeneration is interrupted.
   */
  #retiringContainer: VirtualContainer | undefined;
  /** Container the Window itself asked the adapter to close (title regeneration). */
  #expectedCloseContainer: VirtualContainer | undefined;
  #layout: ResolvedGuiLayout | undefined;
  /**
   * Skips only clearing a physical slot this container last cleared (design
   * 11.2). It describes one container's slots, so it is created together with
   * the container and dropped with it in `#teardown()`: a reopened Window or a
   * container replaced during open starts with an empty cache.
   *
   * It is only consulted after the render guards in `#isCurrentSlot()`, so a
   * stale provider result, a layout change, or a closed generation never reads
   * or writes it. `markWritten()` runs only after `setItem()` returned, so a
   * failed write is retried on the next pass.
   */
  #writeCache: SlotWriteCache | undefined;
  #stateHandle: StateHandle | undefined;
  /** Schema token the current state handle was acquired with. */
  #stateSchema: string | undefined;
  /** Latches the stale-schema fail-closed path against reentrant notifications. */
  #schemaFault = false;
  #stateSubscription: (() => void) | undefined;
  /** Subscription to `upperGui`; covers GuiLink and TabGui children. */
  #guiSubscription: (() => void) | undefined;
  /**
   * Per-slot element subscription, tagged with the element it was made for.
   * Re-subscribing an unchanged slot would stop and restart the Item's
   * periodic timer on every refresh, resetting its phase (see
   * #subscribeToUpdates).
   */
  #elementSubscriptions = new Map<
    number,
    { element: SlotElement; unsubscribe: () => void }
  >();
  /** Adapter close/itemChange unsubscribe functions, removed on close or failure. */
  #eventUnsubscribers: Array<() => void> = [];
  /** Set once `openContainer` has been called, before the screen may emit events. */
  #screenRequested = false;
  /** Set when an item change through the screen must not be rendered over. */
  #renderingHalted = false;
  /** Per-slot render tokens so an older async provider cannot overwrite a newer result. */
  #slotRenderTokens = new Map<number, number>();
  /**
   * Invalidates every in-flight render. Bumped for each render batch and for
   * each state change: a provider call started before either may have read
   * stale state even when the slot's element reference is unchanged.
   */
  #renderEpoch = 0;
  /** Set when state or GUI changes while `open()` is still resolving providers. */
  #refreshPending = false;
  /** Serializes async title changes so two regenerations cannot overlap. */
  #titleQueue: Promise<void> = Promise.resolve();
  /** A state/GUI notification is waiting for the batched refresh microtask. */
  #fullRefreshQueued = false;
  /** One microtask serves every notification delivered in the same timing. */
  #flushQueued = false;
  #generation = 0;

  constructor(config: WindowConfig) {
    this.viewer = config.viewer;
    this.#title = config.title;
    this.#upperGui = config.upperGui;
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

  /** Title applied to the container; changed by {@link setTitle}. */
  get title(): string {
    return this.#title;
  }

  /** The GUI currently shown in the upper area; replaced by {@link setUpperGui}. */
  get upperGui(): Gui {
    return this.#upperGui;
  }

  /**
   * Opens the Window. With the real adapter this always throws
   * WindowOpenRejectedError before any Container is created or shown.
   *
   * A resolved promise does not guarantee `status === "open"`: a close event or
   * an explicit `close()` during opening (after the container exists but before
   * the screen is shown) tears the Window down and `open()` resolves instead of
   * rejecting. Check `status` (or `isOpen`) after awaiting `open()` before using
   * the Window, its state, or its container.
   */
  async open(): Promise<void> {
    if (this.#status !== "created" && this.#status !== "closed") {
      throw new Error(`InvUI: Window ${this.id} is already ${this.#status}.`);
    }
    if (!this.#adapter.canOpenScreens) {
      throw new WindowOpenRejectedError();
    }

    this.#status = "opening";
    this.#renderingHalted = false;
    this.#screenRequested = false;
    this.#schemaFault = false;
    const generation = ++this.#generation;

    try {
      // Subscribe before the screen can emit anything. A close event during
      // opening (for example UserBusy) must still tear the Window down.
      if (!this.#subscribeToContainerEvents(generation)) {
        return;
      }
      const handle = this.#acquireState();
      this.#stateHandle = handle;
      // Remember the shape the state belongs to. A later structural GUI change
      // must not write state under this token (see #onGuiChanged).
      this.#stateSchema = handle.schema;
      // Subscribe before the first provider runs: state may change while async
      // providers are still resolving, and the screen must show the new state.
      this.#stateSubscription = handle.subscribe(() => this.#onStateChanged());
      // Same for GUI changes: content/ingredient edits, including GuiLink and
      // TabGui children, must be visible on the first rendered pass.
      this.#guiSubscription = this.upperGui.subscribe(() => this.#onGuiChanged());

      const createContainer = (size: number): VirtualContainer => {
        const options: VirtualContainerOptions =
          this.title.length === 0
            ? { size }
            : { size, title: this.title };
        const container = this.#adapter.createContainer(options);
        // The cache is bound to one container: a replacement (size change
        // while opening) starts empty, so nothing is skipped against slots the
        // previous container owned.
        this.#writeCache = new SlotWriteCache();
        return container;
      };

      let layout = this.upperGui.resolve(this.viewer, handle.get());
      let size = containerSizeOf(layout);
      if (size < 1 || size > 54) {
        throw new RangeError(`InvUI: Window size ${size} is outside the supported 1..54.`);
      }
      let container = createContainer(size);
      this.#container = container;

      let passes = 0;
      while (true) {
        // A state or GUI change on every pass must not retry forever: bound the
        // loop and fail closed through the normal open error path below.
        if (passes >= MAX_OPEN_RENDER_PASSES) {
          throw new WindowOpenRenderLimitError(passes);
        }
        passes += 1;
        // Any state or GUI change after this point makes the pass stale;
        // re-resolve and render again until the rendered inputs are current.
        this.#refreshPending = false;
        layout = this.upperGui.resolve(this.viewer, handle.get());
        size = containerSizeOf(layout);
        if (size < 1 || size > 54) {
          throw new RangeError(`InvUI: Window size ${size} is outside the supported 1..54.`);
        }
        if (size !== container.size) {
          // The screen is not shown yet, so the container can be replaced
          // instead of requiring a close/reopen cycle (design 8.4).
          container = createContainer(size);
          this.#container = container;
        }
        this.#applyLayout(layout);
        await this.#renderAll(generation);
        if (generation !== this.#generation || this.#status !== "opening") {
          return;
        }
        if (!this.#refreshPending) {
          break;
        }
      }

      this.#screenRequested = true;
      this.#adapter.openContainer(container, this.viewer);
      // A close event may have been dispatched synchronously from
      // openContainer; it already tore the Window down.
      if (generation !== this.#generation || this.#status !== "opening") {
        return;
      }
      this.#status = "open";
      this.#runOpenHandlers();
    } catch (error) {
      this.#teardown();
      this.#status = "closed";
      this.#report(error, "open");
      throw error;
    }
  }

  /**
   * Re-resolve the GUI state and re-render every slot.
   *
   * A state change can change what an Item provider returns without changing
   * the slot's element reference, so no provider is skipped by element
   * identity. Resolved ItemStacks are not compared either: Bedrock stacks may
   * carry components or lore that cannot be compared exhaustively, and
   * treating two stacks as equal would leave stale display data. The one write
   * that is skipped is clearing a slot this container already has empty
   * (`#writeCache`).
   */
  async refresh(): Promise<void> {
    // This pass re-evaluates every slot from the current state, so it already
    // covers notifications that arrived before the call. Dropping their queued
    // counterpart keeps it from invalidating this pass's in-flight results.
    this.#fullRefreshQueued = false;
    await this.#refresh();
  }

  /**
   * Change the title of the Window (design 8.4 / 20).
   *
   * `VirtualContainer.title` cannot change after creation, so an open Window is
   * regenerated: the new container is created and rendered first, then the old
   * screen is closed and the new one is shown. The state handle, GUI and
   * element subscriptions are kept, and neither the open nor the close handlers
   * run again for this internal reopen.
   *
   * A closed Window only stores the title for the next `open()`. Changing it
   * while `open()` is still running is rejected: the container may already
   * exist with the previous title. Failures are reported through the error
   * handler (`operation: "titleChange"`); if the old screen had to be closed
   * already, the Window fails closed instead of leaving an unknown screen.
   */
  async setTitle(title: string): Promise<void> {
    if (typeof title !== "string") {
      throw new TypeError("InvUI: Window title must be a string.");
    }
    if (this.#status === "opening") {
      throw new Error(
        `InvUI: Window ${this.id} cannot change its title while opening; await open() first.`,
      );
    }
    // Two overlapping regenerations would each close a container the other is
    // still using, so run them in call order. Equality is checked when the turn
    // arrives, after any earlier change, so "B" then "A" settles on "A".
    const run = this.#titleQueue.then(() => this.#applyTitle(title));
    this.#titleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async #applyTitle(title: string): Promise<void> {
    if (title === this.#title) {
      return;
    }
    if (this.#status === "opening") {
      throw new Error(
        `InvUI: Window ${this.id} cannot change its title while opening; await open() first.`,
      );
    }
    if (
      this.#status !== "open" ||
      this.#renderingHalted ||
      !this.#container ||
      !this.#layout ||
      !this.#stateHandle
    ) {
      this.#title = title;
      return;
    }
    await this.#reopenWithTitle(title);
  }

  /**
   * Regenerate the container with a new title while the Window stays logically
   * open. The caller (`setTitle`) has checked status, layout, and state handle.
   */
  async #reopenWithTitle(title: string): Promise<void> {
    const generation = this.#generation;
    const previousTitle = this.#title;
    const previousContainer = this.#container as VirtualContainer;
    const previousCache = this.#writeCache;
    const size = previousContainer.size;
    const options: VirtualContainerOptions =
      title.length === 0 ? { size } : { size, title };

    let nextContainer: VirtualContainer;
    try {
      nextContainer = this.#adapter.createContainer(options);
    } catch (error) {
      this.#report(error, "titleChange");
      throw error;
    }

    // Invalidate renders that were started against the previous container
    // before swapping. The new cache starts empty: no slot of this container
    // has been written yet.
    this.#renderEpoch += 1;
    this.#container = nextContainer;
    // The old screen stays visible until it is closed below. Its events are
    // handled as this Window's events until then (see #onContainerClose).
    this.#retiringContainer = previousContainer;
    this.#writeCache = new SlotWriteCache();
    this.#title = title;

    try {
      await this.#renderAll(generation);
    } catch (error) {
      // #renderAll normally reports per-slot failures instead of throwing. If
      // it does throw, the old screen is still showing: restore it and report
      // the title change as not applied.
      this.#container = previousContainer;
      this.#retiringContainer = undefined;
      this.#writeCache = previousCache;
      this.#title = previousTitle;
      this.#report(error, "titleChange");
      this.#scheduleRefresh();
      throw error;
    }

    // A close or reopen during the render owns the Window now.
    if (
      generation !== this.#generation ||
      this.#status !== "open" ||
      this.#container !== nextContainer
    ) {
      return;
    }

    // The regeneration owns the old screen until here. Mark the close as our
    // own so its after-event is not mistaken for the player closing it.
    this.#retiringContainer = undefined;
    this.#expectedCloseContainer = previousContainer;
    try {
      this.#adapter.closeContainer(previousContainer, this.viewer);
    } catch (error) {
      // The old screen may or may not have closed. Do not open a second screen
      // on an unknown state: report, retry closing the old screen, and fail
      // closed. The requested title stays for the next open().
      this.#report(error, "titleChange");
      if (generation === this.#generation && this.#status === "open") {
        this.#retiringContainer = previousContainer;
        this.#performClose("ServerClosed", true);
      }
      return;
    } finally {
      this.#expectedCloseContainer = undefined;
    }

    if (
      generation !== this.#generation ||
      this.#status !== "open" ||
      this.#container !== nextContainer
    ) {
      return;
    }

    try {
      this.#adapter.openContainer(nextContainer, this.viewer);
    } catch (error) {
      // The old screen is already closed, so the Window cannot stay open with
      // an unknown container. `openContainer` may also have dispatched a close
      // event synchronously; #performClose is idempotent.
      this.#report(error, "titleChange");
      if (generation === this.#generation && this.#status === "open") {
        this.#performClose("ServerClosed", false);
      }
      throw error;
    }
  }

  /**
   * Replace the upper GUI of an open Window (design 8.4).
   *
   * The slot layout is re-evaluated and written again, so the container and the
   * screen are kept. Only the same container size can be applied in place: a
   * different size needs a new VirtualContainer, so it is reported and the
   * current GUI stays in place. A different state schema would leave the
   * acquired state describing the previous shape, so it fails closed through
   * the same path as a structural GUI change.
   */
  setUpperGui(gui: Gui): void {
    if (!gui || typeof gui.resolve !== "function" || typeof gui.subscribe !== "function") {
      throw new TypeError("InvUI: Window upper GUI must be a Gui.");
    }
    if (gui === this.#upperGui) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      this.#upperGui = gui;
      return;
    }
    const handle = this.#stateHandle;
    if (!handle) {
      return;
    }
    const generation = this.#generation;
    let layout: ResolvedGuiLayout;
    try {
      layout = gui.resolve(this.viewer, handle.get());
    } catch (error) {
      this.#report(error, "guiChange");
      return;
    }
    // #report runs the caller's error handler, which may close and reopen the
    // Window: the rest of this swap belongs to the generation that is gone.
    if (generation !== this.#generation) {
      return;
    }
    if (!this.#container || containerSizeOf(layout) !== this.#container.size) {
      this.#report(
        new Error("InvUI: layout size changed; reopen the Window to apply it."),
        "guiChange",
      );
      return;
    }
    if (!this.#schemaMatchesGui(gui)) {
      this.#failStateSchema("guiChange");
      return;
    }

    // Detach the old GUI before attaching the new one so a notification from
    // either cannot refresh against the other GUI's layout.
    const previousUnsubscribe = this.#guiSubscription;
    this.#guiSubscription = undefined;
    if (previousUnsubscribe) {
      try {
        previousUnsubscribe();
      } catch (error) {
        this.#report(error, "unsubscribe");
        // The error handler may have closed and reopened the Window.
        if (generation !== this.#generation) {
          return;
        }
      }
    }
    try {
      this.#guiSubscription = gui.subscribe(() => this.#onGuiChanged());
    } catch (error) {
      // The swap stays safe: the new layout is applied below, only push updates
      // from the new GUI are missing.
      this.#report(error, "subscribe");
      if (generation !== this.#generation) {
        return;
      }
    }
    this.#upperGui = gui;
    this.#applyLayout(layout);
    // A failed element subscription inside #applyLayout is reported, and the
    // handler may have closed and reopened: do not refresh the new generation.
    if (generation !== this.#generation) {
      return;
    }
    this.#scheduleRefresh();
  }

  /**
   * Replace the error handler for subsequent failures (design 14.3); errors
   * already reported are not replayed.
   */
  setErrorHandler(handler: WindowErrorHandler): this {
    assertErrorHandler(handler);
    this.#errorHandler = handler;
    return this;
  }

  async #refresh(): Promise<void> {
    if (
      this.#renderingHalted ||
      this.#status !== "open" ||
      !this.#container ||
      !this.#stateHandle
    ) {
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
    this.#applyLayout(layout);
    try {
      await this.#renderAll(generation);
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
    const handle = this.#stateHandle;
    if (!handle) {
      throw new Error(`InvUI: Window ${this.id} is not open.`);
    }
    // Another GUI listener can run before this Window's own listener in the
    // same synchronous notification cascade, so a write must re-check the
    // shape itself. Persisting after a structural change would store the new
    // state under the schema the old shape was acquired with.
    if (!this.#stateSchemaMatches()) {
      const error = new WindowStateSchemaChangedError();
      this.#failStateSchema("setState", error);
      throw error;
    }
    return handle.set(patch);
  }

  getState(): StateSnapshot {
    if (!this.#stateHandle) {
      throw new Error(`InvUI: Window ${this.id} is not open.`);
    }
    return this.#stateHandle.get();
  }

  /**
   * Routes a click to the button Item currently rendered at the logical `slot`.
   *
   * Only `button`-mode Items accept input (design 10.5); a display Item, even
   * one that carries handlers, returns false without enqueueing anything.
   *
   * Clicks run on the state handle's queue, so shared-state windows process
   * them in order (design 12.1). The slot, display generation, and mode are
   * checked again when the queued task actually runs: a click that waited
   * behind a close, reopen, page/tab change, or a slot that turned display
   * while waiting is discarded instead of invoking a stale handler.
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
    if (!isButtonElement(element)) {
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
        // The same Item may have been switched to display while this click
        // waited, so the mode is re-validated at execution time too.
        if (!isButtonElement(element)) {
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

  /**
   * Closes the Window and notifies the close handlers once.
   *
   * A handler that closes and reopens the Window starts a new generation; the
   * notification for the closed generation stops there, so a later handler
   * cannot tear the reopened screen down and a stale handler exception is not
   * reported to it (see `WindowCloseHandler`).
   */
  close(reason: WindowCloseReason = "ServerClosed"): void {
    this.#performClose(reason, true);
  }

  /**
   * The single close path for explicit close calls and adapter close events.
   * `requestAdapterClose` is false for a close event: the screen is already
   * closing, and asking again is neither needed nor safe.
   *
   * `opening` is notified too, even though no screen was requested and no
   * adapter close is sent: a close during opening still reports its reason
   * once, and `open()` resolves with the Window already `closed`.
   *
   * Close handlers run in registration order. One of them may close and reopen
   * the Window, starting a new generation: the notification then belongs to the
   * generation that is gone, so the remaining handlers are skipped and a
   * throwing handler's error is not reported (see `WindowCloseHandler`).
   */
  #performClose(reason: WindowCloseReason, requestAdapterClose: boolean): void {
    if (this.#status === "closed") {
      return;
    }
    if (this.#status === "created") {
      this.#status = "closed";
      return;
    }

    const wasVisible = this.#status === "open" || this.#screenRequested;
    // An `opening` Window has a container but has not shown a screen yet, so
    // there is nothing to ask the adapter to close. The reason still has to
    // reach the close handlers exactly once: `open()` then resolves as closed,
    // and dropping the reason here would make the close look like a no-op.
    const notifyCloseHandlers = wasVisible || this.#status === "opening";
    this.#status = "closing";
    const generation = ++this.#generation;
    this.#stopRendering();

    // Detach before touching the adapter: closeContainer may dispatch the
    // close event synchronously and must not run this path twice.
    this.#unsubscribeFromContainerEvents();
    // An unsubscribe failure is reported, and the error handler may have closed
    // and reopened the Window: the rest of this close belongs to a generation
    // that is gone, and its teardown must not destroy the reopened screen.
    if (generation !== this.#generation) {
      return;
    }

    if (requestAdapterClose && wasVisible) {
      // During a title regeneration the old screen is the visible one; the
      // replacement exists but was never shown. Closing it keeps an interrupted
      // regeneration from leaving the old screen on the player's display.
      const visibleContainer = this.#retiringContainer ?? this.#container;
      if (visibleContainer) {
        try {
          this.#adapter.closeContainer(visibleContainer, this.viewer);
        } catch (error) {
          this.#report(error, "close");
          // Same hazard as above: a failed closeContainer is reported, and a
          // handler that closes and reopens must keep the new generation.
          if (generation !== this.#generation) {
            return;
          }
        }
      }
    }

    this.#teardown();
    this.#status = "closed";

    // Exactly once: a duplicate or delayed close event sees status `closed`.
    if (notifyCloseHandlers) {
      for (const handler of [...this.#closeHandlers]) {
        // A handler may close and reopen the Window, starting a new generation.
        // The rest of this notification belongs to the generation that is gone:
        // calling a later handler would close the reopened screen.
        if (generation !== this.#generation) {
          return;
        }
        try {
          handler(reason);
        } catch (error) {
          // Same generation check before reporting: the throwing handler may
          // have reopened the Window, and the error handler could close that new
          // generation if the old exception were delivered to it.
          if (generation !== this.#generation) {
            return;
          }
          this.#report(error, "closeHandler");
        }
      }
    }
  }

  /**
   * True for the container currently shown/replacing and for the previous one
   * whose screen is still visible during a title regeneration.
   */
  #ownsContainer(container: VirtualContainer): boolean {
    return container === this.#container || container === this.#retiringContainer;
  }

  #onContainerClose(generation: number, event: WindowContainerCloseEvent): void {
    if (generation !== this.#generation) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    // The Window asked for this close itself (title regeneration); it must not
    // be treated as the player closing the Window.
    if (event.container === this.#expectedCloseContainer) {
      return;
    }
    if (!this.#ownsContainer(event.container)) {
      return;
    }
    if (!isSamePlayer(event.player, this.viewer)) {
      return;
    }
    this.#performClose(event.reason, false);
  }

  /**
   * A player changed the container through the screen. This is not a click and
   * the previous item is not restored: report the danger, stop rendering (so a
   * late provider cannot write over the changed slot), and request close.
   *
   * The `opening` status is covered too: `openContainer` may dispatch the event
   * synchronously, before `open()` sets `open`. Dropping that event would let
   * the following render pass put the item the player already took back into
   * the container (a duplicate), so it fails closed like an open one.
   */
  #onContainerItemChange(
    generation: number,
    event: WindowContainerItemChangeEvent,
  ): void {
    if (generation !== this.#generation) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    if (!this.#ownsContainer(event.container)) {
      return;
    }
    if (!isSamePlayer(event.player, this.viewer)) {
      // Another viewer changed this container through its screen. The Window
      // does not close for that, so it keeps rendering: the write cache no
      // longer describes the slots and must not skip an empty clear.
      this.#writeCache?.invalidate();
      return;
    }
    this.#report(new WindowItemChangeDangerError(event.slot), "itemChange", event.slot);
    // The error handler may have closed and reopened the Window; this event
    // still belongs to the previous generation and must not close the new one.
    if (generation !== this.#generation) {
      return;
    }
    this.#performClose("ServerClosed", true);
  }

  /**
   * Subscribes to the adapter's optional close/itemChange hooks before opening.
   * Returns false when an event delivered during subscription already closed
   * the Window. Subscriptions made before a failure are always removed.
   */
  #subscribeToContainerEvents(generation: number): boolean {
    const unsubscribers: Array<() => void> = [];
    const track = (unsubscribe: unknown, kind: string): void => {
      if (typeof unsubscribe !== "function") {
        throw new TypeError(
          `InvUI: adapter ${kind} subscription must return an unsubscribe function.`,
        );
      }
      unsubscribers.push(unsubscribe as () => void);
    };

    try {
      if (this.#adapter.subscribeClose) {
        track(
          this.#adapter.subscribeClose((event) =>
            this.#onContainerClose(generation, event),
          ),
          "close",
        );
      }
      // A handler may have closed the Window while the first subscription was
      // being installed; do not install the second one then.
      if (generation !== this.#generation || this.#status !== "opening") {
        this.#disposeEventSubscriptions(unsubscribers);
        return false;
      }
      if (this.#adapter.subscribeItemChange) {
        track(
          this.#adapter.subscribeItemChange((event) =>
            this.#onContainerItemChange(generation, event),
          ),
          "itemChange",
        );
      }
    } catch (error) {
      this.#disposeEventSubscriptions(unsubscribers);
      throw error;
    }

    if (generation !== this.#generation || this.#status !== "opening") {
      this.#disposeEventSubscriptions(unsubscribers);
      return false;
    }
    this.#eventUnsubscribers = unsubscribers;
    return true;
  }

  #unsubscribeFromContainerEvents(): void {
    const unsubscribers = this.#eventUnsubscribers;
    this.#eventUnsubscribers = [];
    this.#disposeEventSubscriptions(unsubscribers);
  }

  #disposeEventSubscriptions(unsubscribers: Array<() => void>): void {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        // A broken unsubscribe must not keep the Window open or mask the
        // original open/close failure.
        this.#report(error, "unsubscribe");
      }
    }
  }

  #stopRendering(): void {
    this.#renderingHalted = true;
    this.#renderEpoch += 1;
    this.#refreshPending = false;
    this.#fullRefreshQueued = false;
    this.#slotRenderTokens.clear();
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

  /** State changed: invalidate in-flight renders and re-evaluate the GUI. */
  #onStateChanged(): void {
    this.#scheduleRefresh();
  }

  /**
   * GUI content/ingredients changed. Gui forwards GuiLink and TabGui child
   * changes, so this also covers children of the upper GUI.
   *
   * A content change (setContent) keeps the shape, so the open state stays
   * valid and only the render refreshes. A structural change makes the schema
   * token stale: the state handle would persist new state under the schema of
   * the previous shape, so the Window fails closed instead.
   */
  #onGuiChanged(): void {
    if (this.#schemaFault || this.#renderingHalted) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    if (!this.#stateSchemaMatches()) {
      this.#failStateSchema("guiChange");
      return;
    }
    this.#scheduleRefresh();
  }

  /** True while the acquired state still describes the current upper GUI. */
  #stateSchemaMatches(): boolean {
    return this.#schemaMatchesGui(this.#upperGui);
  }

  /** True while the acquired state still describes `gui`. */
  #schemaMatchesGui(gui: Gui): boolean {
    const acquired = this.#stateSchema;
    if (acquired === undefined) {
      return true;
    }
    try {
      return schemaOf(gui) === acquired;
    } catch {
      // A shape that cannot be described cannot be matched to the state.
      return false;
    }
  }

  /**
   * Refuse further work on a state whose schema no longer describes the GUI:
   * report once, then close (which stops rendering and releases the handle).
   * The latch makes reentrant notifications from a GUI listener, the error
   * handler, or the close handlers harmless.
   */
  #failStateSchema(
    operation: string,
    error = new WindowStateSchemaChangedError(),
  ): void {
    if (this.#schemaFault) {
      return;
    }
    const generation = this.#generation;
    this.#schemaFault = true;
    this.#report(error, operation);
    // A handler that closed and reopened the Window leaves this failure behind:
    // closing here would tear down a generation that never saw the stale shape.
    if (generation !== this.#generation) {
      return;
    }
    if (this.#status === "opening" || this.#status === "open") {
      this.#performClose("ServerClosed", true);
    }
  }

  #scheduleRefresh(): void {
    if (this.#renderingHalted) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    // Every provider call started before this point may have read the previous
    // state or GUI, even when its slot's element reference did not change.
    this.#renderEpoch += 1;
    if (this.#status === "opening") {
      this.#refreshPending = true;
      return;
    }
    this.#fullRefreshQueued = true;
    this.#queueRefreshFlush();
  }

  #queueRefreshFlush(): void {
    if (this.#flushQueued) {
      return;
    }
    this.#flushQueued = true;
    // Promise.then is used instead of queueMicrotask because the Bedrock
    // script runtime is not guaranteed to expose the latter.
    void Promise.resolve().then(() => {
      this.#flushQueued = false;
      this.#runRefreshFlush();
    });
  }

  /**
   * Run the state/GUI refresh collected since the last flush. A close or a
   * reopen before the microtask drops the work: the new generation either
   * renders in `open()` or has already prepared its own notifications.
   */
  #runRefreshFlush(): void {
    if (!this.#fullRefreshQueued) {
      return;
    }
    this.#fullRefreshQueued = false;
    if (this.#renderingHalted || this.#status !== "open") {
      return;
    }
    void this.#refresh();
  }

  #applyLayout(layout: ResolvedGuiLayout): void {
    this.#layout = layout;
    // Move element subscriptions as soon as the new layout exists. Waiting for
    // async renders would let a notification hit the previous slot mapping and
    // be lost for the slot's new position (design 11.4).
    this.#subscribeToUpdates();
  }

  async #renderAll(generation: number): Promise<void> {
    const layout = this.#layout;
    if (!layout || this.#renderingHalted) {
      return;
    }
    // A new batch invalidates every result started before it.
    const epoch = ++this.#renderEpoch;
    const renders: Array<Promise<void>> = [];
    // #renderSlot starts its provider synchronously, so every provider is
    // invoked before the first await: one slow slot must not delay the others.
    for (let slot = 0; slot < layout.slots.length; slot += 1) {
      if (generation !== this.#generation || !this.#container) {
        break;
      }
      renders.push(this.#renderSlot(slot, epoch));
    }
    await Promise.all(renders);
  }

  async #renderSlot(slot: number, epoch: number = this.#renderEpoch): Promise<void> {
    const layout = this.#layout;
    if (!layout || !this.#container || this.#renderingHalted) {
      return;
    }
    const generation = this.#generation;
    // A newer render for the same logical slot wins, regardless of which async
    // provider resolves first.
    const token = (this.#slotRenderTokens.get(slot) ?? 0) + 1;
    this.#slotRenderTokens.set(slot, token);
    const element = layout.slots[slot];

    let stack: ItemStack | undefined;
    let pending: Promise<ItemStack | undefined> | undefined;
    // Only a provider we suspended on can go stale while we wait; a synchronous
    // throw is still reported even if the provider invalidated its own pass.
    let awaited = false;
    try {
      if (isItemElement(element) && typeof element.resolveForDisplay === "function") {
        const resolution = element.resolveForDisplay(this.viewer);
        if (resolution.pending !== undefined && !resolution.placeholder) {
          // Without a placeholder, an asynchronous provider keeps the previous
          // behavior: open() and refresh() wait for it.
          awaited = true;
          stack = await resolution.pending;
        } else {
          stack = resolution.stack;
          if (resolution.placeholder) {
            pending = resolution.pending;
          }
        }
      } else {
        awaited = true;
        stack = await this.#resolveElement(element);
      }
    } catch (error) {
      // Keep the previous display item for provider failures (design 14.2).
      // A failure that arrives after a close/reopen, a newer render batch, or a
      // slot/layout change is stale: reporting it would hand the previous
      // screen's error to the handler of the new generation, which may close the
      // new screen.
      if (!awaited || this.#isCurrentSlot(generation, epoch, slot, element, token)) {
        this.#report(error, "itemProvider", slot);
      }
      return;
    }

    // The final result of a pending provider goes through the same guard as a
    // synchronous result: a close, a newer render batch, a newer call for this
    // slot, a layout change, or a render halt discards it.
    if (pending !== undefined) {
      // Draw the placeholder before watching: a thenable whose `then` runs
      // synchronously would otherwise deliver the final result first, and the
      // placeholder written after it would overwrite that result. Handlers are
      // still attached in the same tick as the provider call, so a rejection
      // cannot become unhandled.
      this.#applySlotStack(generation, epoch, slot, element, token, stack);
      this.#watchPendingSlot(pending, slot, element, generation, epoch, token);
      return;
    }
    this.#applySlotStack(generation, epoch, slot, element, token, stack);
  }

  /**
   * True when a render result still belongs to the current generation, render
   * batch, layout, slot element, and slot token, and rendering is not halted.
   */
  #isCurrentSlot(
    generation: number,
    epoch: number,
    slot: number,
    element: SlotElement | null | undefined,
    token: number,
  ): boolean {
    const layout = this.#layout;
    return (
      !this.#renderingHalted &&
      generation === this.#generation &&
      epoch === this.#renderEpoch &&
      this.#container !== undefined &&
      layout !== undefined &&
      layout.slots[slot] === element &&
      this.#slotRenderTokens.get(slot) === token
    );
  }

  /** Write a slot result only if its render is still current, then report setItem failures. */
  #applySlotStack(
    generation: number,
    epoch: number,
    slot: number,
    element: SlotElement | null | undefined,
    token: number,
    stack: ItemStack | undefined,
  ): void {
    if (!this.#isCurrentSlot(generation, epoch, slot, element, token)) {
      return;
    }
    const layout = this.#layout;
    const container = this.#container;
    const cache = this.#writeCache;
    if (!layout || !container || !cache) {
      return;
    }
    const physicalSlot = physicalSlotOf(layout, slot);
    // The one provable skip: this container's slot was last cleared by this
    // Window and is cleared again. It cannot delete data and it never skips a
    // stack, so display content is never withheld. Skipping anything else
    // would require an ItemStack equality that Bedrock does not provide.
    if (!cache.shouldWrite(physicalSlot, stack)) {
      return;
    }
    try {
      container.setItem(physicalSlot, stack);
    } catch (error) {
      this.#report(error, "setItem", slot);
      return;
    }
    // Record only after the write returned: a throwing setItem stays
    // unrecorded, so the next pass retries it instead of skipping it.
    cache.markWritten(physicalSlot, stack);
  }

  /**
   * Attach the final result of an asynchronous provider that is currently
   * represented by a placeholder. The caller does not await this promise, so
   * open() is not delayed; the result still passes the slot guards when it
   * arrives. A rejection is reported through the Window error channel instead
   * of becoming an unhandled rejection.
   */
  #watchPendingSlot(
    pending: Promise<ItemStack | undefined>,
    slot: number,
    element: SlotElement | null | undefined,
    generation: number,
    epoch: number,
    token: number,
  ): void {
    void pending
      .then(
        (stack) => this.#applySlotStack(generation, epoch, slot, element, token, stack),
        (error) => {
          // Keep the previous display item, including the placeholder, and
          // report the failure like the awaited provider path does. A rejection
          // for a stale slot is dropped for the same reason as a stale result:
          // the error handler could close the screen that is now showing.
          if (!this.#isCurrentSlot(generation, epoch, slot, element, token)) {
            return;
          }
          this.#report(error, "itemProvider", slot);
        },
      )
      .catch((error) => {
        // The callbacks above already handle provider failures; this only
        // guards the error channel itself from producing an unhandled rejection.
        console.error("InvUI: pending item provider result failed.", error);
      });
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

  /**
   * Move element subscriptions to the current layout. A slot that still shows
   * the same element keeps its subscription: dropping and re-adding it stops
   * and restarts the Item's periodic timer, so a GUI that refreshes faster than
   * the period would never tick.
   */
  #subscribeToUpdates(): void {
    const layout = this.#layout;
    const previous = this.#elementSubscriptions;
    const next = new Map<number, { element: SlotElement; unsubscribe: () => void }>();
    if (layout) {
      for (let slot = 0; slot < layout.slots.length; slot += 1) {
        const element = layout.slots[slot];
        if (!isItemElement(element) && !isInventoryLinkElement(element)) {
          continue;
        }
        const kept = previous.get(slot);
        if (kept && kept.element === element) {
          previous.delete(slot);
          next.set(slot, kept);
          continue;
        }
        try {
          next.set(slot, {
            element,
            unsubscribe: element.subscribe(() => {
              void this.#renderSlot(slot);
            }),
          });
        } catch (error) {
          // A broken element subscription must not abort the state-update path.
          this.#report(error, "subscribe", slot);
        }
      }
    }
    // Whatever remains refers to an element that is no longer in that slot.
    for (const { unsubscribe } of previous.values()) {
      try {
        unsubscribe();
      } catch (error) {
        this.#report(error, "unsubscribe");
      }
    }
    this.#elementSubscriptions = next;
  }

  #unsubscribeElements(): void {
    const subscriptions = [...this.#elementSubscriptions.values()];
    this.#elementSubscriptions = new Map();
    for (const { unsubscribe } of subscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        this.#report(error, "unsubscribe");
      }
    }
  }

  #teardown(): void {
    this.#unsubscribeFromContainerEvents();
    this.#stateSubscription?.();
    this.#stateSubscription = undefined;
    this.#guiSubscription?.();
    this.#guiSubscription = undefined;
    this.#unsubscribeElements();
    this.#stateHandle?.release();
    this.#stateHandle = undefined;
    this.#stateSchema = undefined;
    this.#container = undefined;
    this.#retiringContainer = undefined;
    this.#expectedCloseContainer = undefined;
    this.#layout = undefined;
    this.#writeCache = undefined;
    this.#screenRequested = false;
    this.#refreshPending = false;
    this.#fullRefreshQueued = false;
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
