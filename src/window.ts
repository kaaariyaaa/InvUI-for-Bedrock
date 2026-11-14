/**
 * Window lifecycle (design chapter 8).
 *
 * The real adapter is enabled by default: `canOpenScreens` is true and
 * `openContainer`/`closeContainer` call `VirtualContainer.open(player)` /
 * `close(player)`. This path has NOT been verified on a real device.
 *
 * Screen protection is detection only. `virtualContainerItemChange` is an
 * `after` event, so a move the player performs through the screen has already
 * happened when the handler runs: it cannot be prevented and the previous item
 * cannot be restored. A display item taken through the screen can therefore be
 * lost or duplicated (a later render can write it back). The Window reports
 * `WindowItemChangeDangerError` and closes, which is best-effort. Until the
 * manual verification in design 10 and 18.2 is complete, use a throwaway world.
 *
 * `createContainer()` uses the official
 * `world.virtualContainerManager.create()` so layout sizes and titles can be
 * checked against the documented 1..54 / 256-byte limits.
 *
 * Chat input is wired automatically: the first successful `open()` installs a
 * single `world.beforeEvents.chatSend` subscription and registers the open
 * Window for its viewer. `Window.close()` and every layout page/line/tab change
 * invalidate the bridge generation, so a queued notification can never click a
 * closed, reopened, or replaced screen. Every successful `open()` also mints a
 * new `_inputSessionId`: the chat notification must name the current open, so a
 * delayed line from an earlier open (or from before a script reload, when
 * `Window.id` restarts at `window-1`) cannot match a new screen. Nothing is
 * installed when the game API (or a test double) omits `beforeEvents.chatSend`
 * or `system.run`; the Window still works and chat input fails closed.
 *
 * The notification is a player-typed chat line. Every field except the sender
 * id is attacker controlled and can be typed by hand, so the bridge's checks
 * are consistency checks, not authentication. No code here produces the JSON UI
 * `button.send` payload either: design 10.4 does not guarantee a notification
 * is generated at all, so an Item click must still work without one. Like the
 * screen path, this is NOT verified on a real device.
 *
 * `world.afterEvents.playerLeave` closes the Window of the viewer that left
 * with `PlayerLeft`, whether it is still `opening` or already `open`. The event
 * carries only the player id, captured when the open cycle registers, and an
 * id that belongs to another player is ignored. One module-level subscription
 * serves every Window; closing releases the chat registry, state handle, GUI
 * and element subscriptions, and adapter subscriptions through the normal
 * close path (generation checks intact). An environment without the event
 * (older API, test double) is detected once and Windows keep working without
 * the automatic close.
 *
 * `world.afterEvents.entityDie` closes the Window of its viewer with
 * `PlayerDied` while it is still `opening` or already `open`. Only the dead
 * entity's id is read and matched against the id captured at open, so a
 * non-player death, another player, or an entity whose id cannot be read is
 * ignored; the game's own `PlayerDied` close event is the fallback. It reuses
 * the same close path and module-level subscription shape as `playerLeave`, and
 * the adapter is not asked to close a screen that went away with the player.
 * An environment without the event is detected separately and latches off.
 *
 * `world.afterEvents.playerDimensionChange` closes the viewer's Window with
 * `ServerClosed` (design 13.1) and `world.afterEvents.playerGameModeChange`
 * closes it with `PlayerSpectating` when the new mode is `Spectator`. Both
 * match the viewer id captured at open, ignore other players and non-spectator
 * mode changes, and are feature-detected separately, so one missing event never
 * disables the others. The player is still valid here, so these closes also ask
 * the adapter to close the screen; the game usually closes it first and the
 * duplicate request is harmless. Both are NOT verified on a real device.
 *
 * `system.beforeEvents.shutdown` closes every `opening`/`open` Window with
 * `ServerClosed` before the world goes away. No close event is raised on that
 * path, so the subscription is installed with the leave/death ones on the
 * first `open()`. The callback runs with restricted-execution privilege: it
 * does not call `VirtualContainer.close()`, adapter unsubscribers, or any event
 * `unsubscribe()`. Only local resources are released (chat routing, registry
 * entries, state handle, GUI/element subscriptions, container references); the
 * engine drops the screens and subscriptions with the session. Close handlers
 * still run exactly once, and an `open()` they attempt is suppressed for the
 * rest of the module lifetime, so a shutdown cannot be followed by a new
 * screen. A repeated shutdown event is a no-op.
 */
import { world } from "@minecraft/server";
import * as server from "@minecraft/server";
import type {
  ItemStack,
  Player,
  VirtualContainer,
  VirtualContainerCloseAfterEvent,
  VirtualContainerCloseReason,
  VirtualContainerItemChangeAfterEvent,
  VirtualContainerOptions,
} from "@minecraft/server";
import { connectChatSendInput, createChatInputBridge } from "./chat-input-bridge.js";
import type { ChatInputBridge, ChatInputClickOutcome } from "./chat-input-bridge.js";
import { GuiLink, ScrollGui, TabGui } from "./gui.js";
import type { Gui, ResolvedGuiLayout, SlotElement } from "./gui.js";
import type { InputSlotMode } from "./input.js";
import type { InventoryLink } from "./inventory.js";
import type { Item } from "./item.js";
import { SlotWriteCache } from "./render-cache.js";
import { StateManager } from "./state.js";
import type {
  GuiStateField,
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
 * either (the error handler could close the reopened Window). During a world
 * shutdown a reopen is suppressed: `open()` resolves without opening.
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

/**
 * Thrown from `open()` when the adapter has not opted into showing screens
 * (`canOpenScreens === false`). The default Minecraft adapter reports true;
 * this guard only refuses adapters that leave the flag off.
 */
export class WindowOpenRejectedError extends Error {
  readonly code = "INVUI_WINDOW_OPEN_UNVERIFIED";

  constructor(
    message = "InvUI: Window.open() is disabled because the container adapter does not allow opening screens (canOpenScreens is false).",
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
 * `canOpenScreens` is the adapter's explicit opt-in: true means
 * `openContainer`/`closeContainer` are implemented against a real screen.
 * `Window.open()` refuses to run when it is false.
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
 * Real Bedrock adapter, enabled by default. `openContainer` and
 * `closeContainer` forward to `VirtualContainer.open(player)` and
 * `close(player)`.
 *
 * NOT VERIFIED ON A REAL DEVICE. The event hooks are detection, not
 * protection: both game events are `after` events, so a close or item change
 * has already happened when the handler runs; subscribing cannot prevent it or
 * restore the previous item. A player can take a display item through the
 * screen and a later render can write it back, duplicating it; an item the
 * player removed can also be lost. The Window only reports
 * `WindowItemChangeDangerError` and closes.
 */
export class MinecraftVirtualContainerAdapter implements WindowContainerAdapter {
  readonly canOpenScreens = true;

  createContainer(options: VirtualContainerOptions): VirtualContainer {
    return world.virtualContainerManager.create(options);
  }

  /**
   * Shows `container` to `viewer`. Not throwing only means the request was
   * sent; the client can still decline it (the screen then closes with
   * `UserBusy`).
   */
  openContainer(container: VirtualContainer, viewer: Player): void {
    container.open(viewer);
  }

  /**
   * Requests the close of `viewer`'s screen. The close event may arrive on a
   * later tick.
   */
  closeContainer(container: VirtualContainer, viewer: Player): void {
    container.close(viewer);
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

/**
 * Open Windows tracked for chat input, one set shared by the whole module so
 * the before-event is subscribed exactly once. The bridge filters by viewer id,
 * so a message from another player never reaches a Window it does not own.
 */
const chatInputWindows = new Set<Window>();
let chatInputBridge: ChatInputBridge | undefined;
/** Latches the feature-detection failure: never retried, never thrown at open(). */
let chatInputUnavailable = false;

/**
 * Installs the chat input bridge on first use, or returns undefined when the
 * game API is absent (older `@minecraft/server`, test doubles, or a world with
 * the event disabled). The failure is latched so opening Windows stays cheap
 * and chat input fails closed instead of breaking screen handling.
 */
function ensureChatInputBridge(): ChatInputBridge | undefined {
  if (chatInputBridge) {
    return chatInputBridge;
  }
  if (chatInputUnavailable) {
    return undefined;
  }
  const gameSystem: typeof server.system | undefined = server.system;
  let chatSend: typeof world.beforeEvents.chatSend | undefined;
  try {
    chatSend = world.beforeEvents?.chatSend;
  } catch {
    chatSend = undefined;
  }
  if (
    !gameSystem ||
    typeof gameSystem.run !== "function" ||
    !chatSend ||
    typeof chatSend.subscribe !== "function"
  ) {
    chatInputUnavailable = true;
    return undefined;
  }
  try {
    const bridge = createChatInputBridge({
      windows: () => chatInputWindows,
      // The Window exposes the modes of its current layout; a missing or
      // throwing probe becomes [] in the bridge and rejects every slot.
      slotModes: (window) => window._inputSlotModes?.() ?? [],
    });
    connectChatSendInput({ world, system: gameSystem }, bridge, (error) => {
      console.error("InvUI: chat input dispatch failed.", error);
    });
    chatInputBridge = bridge;
    return bridge;
  } catch (error) {
    // A broken event signal must not make open() fail: disable chat input.
    console.error(
      "InvUI: chat input bridge could not be installed; chat input is disabled.",
      error,
    );
    chatInputUnavailable = true;
    return undefined;
  }
}

function registerChatInputWindow(window: Window): void {
  ensureChatInputBridge();
  chatInputWindows.add(window);
}

/** Close path: stop routing chat to the Window before handlers can reopen it. */
function forgetChatInputWindow(window: Window): void {
  if (!chatInputWindows.delete(window)) {
    return;
  }
  try {
    chatInputBridge?.invalidate(window);
  } catch {
    // Invalidation is best effort; the Window is already out of the registry.
  }
}

/** Page/line/tab change: old notifications must not click the new layout. */
function invalidateChatInputWindow(window: Window): void {
  if (!chatInputWindows.has(window)) {
    return;
  }
  try {
    chatInputBridge?.invalidate(window);
  } catch {
    // Best effort: handleClick() still re-validates the slot and layout.
  }
}

/**
 * Windows that are `opening` or `open` and must be closed when their viewer's
 * session ends (leave, death, dimension change, spectator) or the world shuts
 * down, one set shared by the module so each game event is subscribed once for
 * every Window. A Window is added when `open()` starts and removed by
 * `#teardown()`.
 */
const lifecycleWindows = new Set<Window>();

interface AfterEventSubscriptionState {
  subscribed: boolean;
  /** Latches the feature-detection failure, like the chat input bridge. */
  unavailable: boolean;
}

type LifecycleEventName =
  | "playerLeave"
  | "entityDie"
  | "playerDimensionChange"
  | "playerGameModeChange";

function afterEventState(): AfterEventSubscriptionState {
  return { subscribed: false, unavailable: false };
}

const playerLeaveState = afterEventState();
const entityDieState = afterEventState();
const playerDimensionChangeState = afterEventState();
const playerGameModeChangeState = afterEventState();
const shutdownState = afterEventState();

/**
 * Set by the first shutdown event and never cleared: the session is ending, so
 * every later `open()` is suppressed and every later close skips adapter/signal
 * calls that restricted execution forbids.
 */
let shutdownInProgress = false;

/** Read a property of an event without letting an invalid entity throw. */
function readProperty(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown> | undefined)?.[key];
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read `value.id`: only an id is used, so a departed entity cannot invalidate it. */
function readId(value: unknown): string | undefined {
  return readString(readProperty(value, "id"));
}

/**
 * Run `close` for every tracked Window. The set is snapshotted because a close
 * handler may open or close other Windows while this loop runs; each Window
 * re-checks its own status, generation, and viewer id.
 */
function forEachLifecycleWindow(
  close: (window: Window) => void,
  action: string,
): void {
  for (const window of [...lifecycleWindows]) {
    try {
      close(window);
    } catch (error) {
      // One Window's close handler must not keep the other Windows open.
      console.error(`InvUI: closing a Window after ${action} failed.`, error);
    }
  }
}

/**
 * Installs one `world.afterEvents` subscription on first use, or latches it off
 * when the game API is absent (older `@minecraft/server`, test doubles, or a
 * world with the event disabled). A Window still opens and closes normally
 * then: only the automatic close for that signal is skipped, and neither
 * `open()` nor `close()` fails because of it.
 *
 * Every signal has its own state: one missing event (or one throwing
 * `subscribe`) must not disable the others, and failures are never retried.
 */
function ensureAfterEventSubscription(
  state: AfterEventSubscriptionState,
  name: LifecycleEventName,
  purpose: string,
  dispatch: (event: unknown) => void,
): void {
  if (state.subscribed || state.unavailable) {
    return;
  }
  const signal = readProperty(world.afterEvents, name) as
    | { subscribe?: (callback: (event: unknown) => void) => unknown }
    | undefined;
  if (!signal || typeof signal.subscribe !== "function") {
    state.unavailable = true;
    return;
  }
  try {
    signal.subscribe(dispatch);
    state.subscribed = true;
  } catch (error) {
    console.error(
      `InvUI: ${name} subscription could not be installed; Windows will not close automatically ${purpose}.`,
      error,
    );
    state.unavailable = true;
  }
}

/**
 * `playerLeave` closes the Window of the viewer that left. The event carries
 * only a player id, captured when the open cycle registers.
 */
function ensurePlayerLeaveSubscription(): void {
  ensureAfterEventSubscription(
    playerLeaveState,
    "playerLeave",
    "when a player leaves",
    (event) => {
      const playerId = readString(readProperty(event, "playerId"));
      if (!playerId) {
        return;
      }
      forEachLifecycleWindow(
        (window) => window._onViewerLeft(playerId),
        "its viewer left",
      );
    },
  );
}

/**
 * `entityDie` closes the Window of its viewer. Only the dead entity's id is
 * read, so a non-player death, another player, or an entity whose id cannot be
 * read is ignored; the game's own `PlayerDied` close event is the fallback.
 */
function ensureEntityDieSubscription(): void {
  ensureAfterEventSubscription(
    entityDieState,
    "entityDie",
    "when a player dies",
    (event) => {
      const entityId = readId(readProperty(event, "deadEntity"));
      if (!entityId) {
        return;
      }
      forEachLifecycleWindow(
        (window) => window._onViewerDied(entityId),
        "its viewer died",
      );
    },
  );
}

/**
 * `playerDimensionChange` closes the Window of the viewer that changed
 * dimension (design 13.1). Bedrock reports the matching container close as
 * `ServerClosed`; this explicit signal gives the Window the same cleanup even
 * when that close event is delayed or the adapter hook is absent.
 */
function ensurePlayerDimensionChangeSubscription(): void {
  ensureAfterEventSubscription(
    playerDimensionChangeState,
    "playerDimensionChange",
    "when a player changes dimension",
    (event) => {
      const playerId = readId(readProperty(event, "player"));
      if (!playerId) {
        return;
      }
      forEachLifecycleWindow(
        (window) => window._onViewerChangedDimension(playerId),
        "its viewer changed dimension",
      );
    },
  );
}

/** Spectator mode closes the screen (design 13.1). */
function ensurePlayerGameModeChangeSubscription(): void {
  ensureAfterEventSubscription(
    playerGameModeChangeState,
    "playerGameModeChange",
    "when a player starts spectating",
    (event) => {
      // Only spectator mode closes a Window; Creative/Survival switches do not.
      if (readString(readProperty(event, "toGameMode")) !== "Spectator") {
        return;
      }
      const playerId = readId(readProperty(event, "player"));
      if (!playerId) {
        return;
      }
      forEachLifecycleWindow(
        (window) => window._onViewerStartedSpectating(playerId),
        "its viewer started spectating",
      );
    },
  );
}

/**
 * Installs the `system.beforeEvents.shutdown` subscription on first use, or
 * latches it off when the API is absent. The callback runs with
 * restricted-execution privilege, so it must not close containers or call
 * event unsubscribers; it only tears down local state through the normal close
 * path (flagged by `shutdownInProgress`) and notifies close handlers once.
 */
function ensureShutdownSubscription(): void {
  if (shutdownState.subscribed || shutdownState.unavailable) {
    return;
  }
  let shutdown: typeof server.system.beforeEvents.shutdown | undefined;
  try {
    shutdown = server.system?.beforeEvents?.shutdown;
  } catch {
    shutdown = undefined;
  }
  if (!shutdown || typeof shutdown.subscribe !== "function") {
    shutdownState.unavailable = true;
    return;
  }
  try {
    shutdown.subscribe(() => {
      // A repeated delivery must not notify close handlers again.
      if (shutdownInProgress) {
        return;
      }
      shutdownInProgress = true;
      // Snapshot: a close handler may close other Windows or try to reopen.
      // Each Window re-checks its status and the shutdown flag.
      for (const window of [...lifecycleWindows]) {
        try {
          window._onWorldShutdown();
        } catch (error) {
          // One Window's close handler must not keep the other Windows open.
          console.error("InvUI: closing a Window during world shutdown failed.", error);
        }
      }
    });
    shutdownState.subscribed = true;
  } catch (error) {
    console.error(
      "InvUI: system.beforeEvents.shutdown subscription could not be installed; Windows will not be torn down at world shutdown.",
      error,
    );
    shutdownState.unavailable = true;
  }
}

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
 * True when a Window state change cannot alter what this element displays.
 *
 * An InventoryLink reads its Inventory, which state changes do not touch (the
 * Inventory notifies its own changes). An Item proves the rest through its
 * provider source: only a fixed ItemStack or an ItemBuilder is known not to
 * receive the Window or its state. Every opaque provider is re-evaluated, so a
 * provider that reads `Window.getState()` is never skipped (design 11.4).
 */
function isProvablyStateIndependent(element: SlotElement): boolean {
  if (isInventoryLinkElement(element)) {
    return true;
  }
  // Slot elements are duck-typed at runtime (Gui accepts any object and
  // Window calls resolve on it), so an element can look like an Item
  // without being one. Only an Item that proves state independence is skipped;
  // anything else stays opaque and is re-evaluated, as before design 11.4.
  return (
    isItemElement(element) &&
    typeof element.isStateIndependent === "function" &&
    element.isStateIndependent()
  );
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

/** True when both layouts render the same element at every logical slot. */
function sameSlotElements(
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
   * Replace the adapter that creates, shows, and closes the container. The
   * default adapter shows real screens; `canOpenScreens` is its opt-in, and an
   * adapter returning false makes `open()` throw WindowOpenRejectedError.
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

/**
 * Builder for a merged Window (design 4.4, Java `Window.mergedBuilder()`).
 *
 * Java's merged window paints one GUI over both the upper inventory and the
 * player's own inventory. Bedrock does not expose the player inventory as a
 * `VirtualContainer` we may paint, so the single GUI fills the container only
 * and the player area keeps the standard screen (design 7.4). `setGui()` is the
 * merged spelling of `setUpperGui()`.
 *
 * ponytail: API parity with an explicit limit, not a merged renderer. Add the
 * real merge only if Bedrock exposes writable player-inventory slots.
 */
export class MergedWindowBuilder extends WindowBuilder {
  setGui(gui: Gui): this {
    return this.setUpperGui(gui);
  }
}

let nextWindowId = 1;
let nextInputSessionId = 1;

/**
 * Mints the input session id of one open cycle. `Window.id` cannot be used:
 * after a script reload it starts at `window-1` again, so a delayed
 * notification from the previous run could match. The wall clock, a
 * process-local counter, and a random tail keep the id unique per open; the
 * format fits the notification grammar and is not a secret or authentication.
 */
function createInputSessionId(): string {
  const time = Date.now().toString(36);
  const counter = (nextInputSessionId++).toString(36);
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `session-${time}-${counter}-${random}`;
}

export class Window {
  readonly id = `window-${nextWindowId++}`;
  readonly viewer: Player;
  #title: string;
  #upperGui: Gui;
  #lowerGui: Gui | undefined;

  #status: WindowStatus = "created";
  /** Per-open chat input session id; see `_inputSessionId`. */
  #inputSessionId: string | undefined;
  /**
   * Viewer id captured at registration: playerLeave and entityDie are matched
   * against it rather than against a possibly invalid player object.
   */
  #viewerId: string | undefined;
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
  /**
   * Structure width the current container's physical slots were last laid out
   * with. A narrower layout in the same container (same height) leaves the
   * columns beyond its width stale, so `#renderAll` clears them when the width
   * shrinks. Undefined means no layout has been rendered into this container.
   */
  #renderedWidth: number | undefined;
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
  /**
   * Set by a GUI content change or a tab selection: the next resolve writes
   * back clamped page/line/tab values (design 9.5). A plain `setState()` does
   * not set it, so an explicitly written value stays stored until content
   * actually changes or a different tab's stored ranges become visible.
   */
  #revalidateStateRanges = false;
  /**
   * Serializes async container regenerations (title change, layout size change)
   * so two of them cannot close a container the other is still using.
   */
  #regenerationQueue: Promise<void> = Promise.resolve();
  /**
   * Bumped for every `setTitle` request. A queued change that can only store
   * the title (the Window closed or reopened while it waited) is dropped when a
   * later request already stored a newer title, so the stale one cannot
   * overwrite it after the fact.
   */
  #titleVersion = 0;
  /**
   * Bumped for every `setUpperGui` request. A queued size-changing swap applies
   * only while it is still the newest request, so a later same-size swap cannot
   * be overwritten by an older candidate when its turn arrives.
   */
  #guiChangeVersion = 0;
  /** A state/GUI notification is waiting for the batched refresh microtask. */
  #fullRefreshQueued = false;
  /**
   * A state notification is waiting for the batched slot-diff refresh (design
   * 11.4). Unlike #fullRefreshQueued it re-evaluates only slots that may have
   * changed: the element mapping changed, or the element is not provably
   * independent of the Window state.
   */
  #slotRefreshQueued = false;
  /**
   * Slots whose Item/Inventory notification waits for the batched render
   * (design 11.2 step 3). The slot's render token is already bumped when it is
   * queued, so a provider result started before the notification is discarded
   * even though the render itself runs in the shared microtask.
   */
  #pendingSlotRenders = new Set<number>();
  /** One microtask serves every notification delivered in the same timing. */
  #flushQueued = false;
  #generation = 0;

  constructor(config: WindowConfig) {
    this.viewer = config.viewer;
    this.#title = config.title;
    this.#upperGui = config.upperGui;
    this.#lowerGui = config.lowerGui;
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

  /**
   * Builder for a merged Window (design 4.4). Bedrock limits the merged form to
   * one GUI in the container; see {@link MergedWindowBuilder}.
   */
  static mergedBuilder(): MergedWindowBuilder {
    return new MergedWindowBuilder();
  }

  get status(): WindowStatus {
    return this.#status;
  }

  get isOpen(): boolean {
    return this.#status === "open";
  }

  /**
   * Internal: mode of every logical slot of the current layout, used by the
   * automatic chat input bridge. Returns null when there is no layout, which
   * the bridge treats as "no slot is a button" (fail closed).
   */
  _inputSlotModes(): readonly InputSlotMode[] | null {
    const layout = this.#layout;
    if (!layout) {
      return null;
    }
    return layout.slots.map((element) => {
      if (isButtonElement(element)) {
        return "button";
      }
      if (isInventoryLinkElement(element)) {
        return "inventory";
      }
      return "display";
    });
  }

  /**
   * Internal: identifies the current open cycle to the chat input bridge.
   * Changes on every successful `open()`. `Window.id` stays the public,
   * stable `window-N` identity and is deliberately not used for this: it is
   * reused across script reloads, where a delayed notification could match.
   * Not part of the exported API; no UI payload is generated yet.
   */
  get _inputSessionId(): string | undefined {
    return this.#inputSessionId;
  }

  /**
   * Internal: close this Window because its viewer left the world.
   *
   * `playerLeave` carries a player id, not a Player, so it is matched against
   * the id captured when this open cycle registered; another player's id is
   * ignored. `#performClose` keeps its own generation and reentrancy checks, so
   * a close handler that reopens the Window keeps the new generation. The
   * adapter is not asked to close: the screen went away with the player, and
   * `close(viewer)` on a departed player can only fail.
   */
  _onViewerLeft(playerId: string): void {
    if (this.#viewerId !== playerId) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    this.#performClose("PlayerLeft", false);
  }

  /**
   * Internal: close this Window because its viewer died.
   *
   * `entityDie` carries the dead entity but only its id is read, matched against
   * the id captured when this open cycle registered, so a non-player death or
   * another player's death is ignored. The adapter is not asked to close: the
   * game removes the screen with the player, and an `opening` Window never
   * requested one. Both statuses go through the normal close path, so
   * subscriptions, state handle, and layout are released and in-flight renders
   * are discarded by the existing generation checks.
   */
  _onViewerDied(playerId: string): void {
    if (this.#viewerId !== playerId) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    this.#performClose("PlayerDied", false);
  }

  /**
   * Internal: close this Window because its viewer changed dimension (design
   * 13.1). Bedrock closes the screen as `ServerClosed`, so the reason recorded
   * here is the same; the adapter is asked to close as well because the player
   * is still valid, which cleans up if the automatic close was missed.
   */
  _onViewerChangedDimension(playerId: string): void {
    if (this.#viewerId !== playerId) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    this.#performClose("ServerClosed", true);
  }

  /**
   * Internal: close this Window because its viewer switched to spectator mode
   * (design 13.1). The game closes the screen with `PlayerSpectating`; asking
   * the adapter too is safe because the player is valid.
   */
  _onViewerStartedSpectating(playerId: string): void {
    if (this.#viewerId !== playerId) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    this.#performClose("PlayerSpectating", true);
  }

  /**
   * Internal: close this Window because the world is shutting down.
   *
   * The shutdown callback runs with restricted-execution privilege, so the
   * adapter must not be asked to close a screen and neither adapter nor event
   * unsubscribers may be called. `#performClose` reads the module-level latch
   * and releases only local resources; screens and subscriptions are dropped
   * by the engine with the session. Close handlers still run exactly once so
   * the end is observable (they run under the same privilege).
   */
  _onWorldShutdown(): void {
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    this.#performClose("ServerClosed", false);
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
   * The GUI logically associated with the lower area (design 7.4). It is never
   * resolved or rendered; see {@link setLowerGui}.
   */
  get lowerGui(): Gui | undefined {
    return this.#lowerGui;
  }

  /**
   * Opens the Window. Throws WindowOpenRejectedError before any container is
   * created when the adapter's `canOpenScreens` is false.
   *
   * A resolved promise does not guarantee `status === "open"`: a close event or
   * an explicit `close()` during opening (after the container exists but before
   * the screen is shown) tears the Window down and `open()` resolves instead of
   * rejecting. Check `status` (or `isOpen`) after awaiting `open()` before using
   * the Window, its state, or its container.
   */
  async open(): Promise<void> {
    if (shutdownInProgress) {
      // The session is ending. A close handler may still call open(); close
      // the Window through the restricted path instead of creating a screen,
      // and resolve so an un-awaited reopen cannot become an unhandled
      // rejection. A created Window is left closed and cannot be opened later.
      this._onWorldShutdown();
      if (this.#status === "created") {
        this.#status = "closed";
      }
      return;
    }
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
      // Register before the screen can be shown so a leave, death, dimension
      // change, or spectator switch during `opening` closes this Window too. A
      // synchronous event delivered by a subscription closes it here; open()
      // then resolves as closed.
      this.#registerForLifecycleClose();
      if (this.#status !== "opening" || generation !== this.#generation) {
        return;
      }
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
      this.#stateSubscription = handle.subscribe((_state, changed) =>
        this.#onStateChanged(changed),
      );
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
        this.#renderedWidth = undefined;
        return container;
      };

      // Opening only resolves the state that is there: writing a clamped
      // value back here would let a window with a smaller content range rewind
      // the page/line another viewer of the same shared state is using.
      // Revalidation is tied to an observed content change instead.
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
        layout = this.#resolveCurrentState(handle, this.#revalidateStateRanges);
        this.#revalidateStateRanges = false;
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
      // A new open cycle is a new input session: a notification naming the
      // previous session (or a previous script reload's `window-N`) must fail.
      this.#inputSessionId = createInputSessionId();
      // Register before open handlers run: a handler may immediately render a
      // button the player can click. Registration also installs the single
      // chatSend subscription on the first successful open.
      registerChatInputWindow(this);
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
    this.#slotRefreshQueued = false;
    this.#pendingSlotRenders.clear();
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
   * A created or closed Window stores the title synchronously, so an `open()`
   * called without awaiting `setTitle()` already uses it. An open Window
   * regenerates asynchronously. Changing the title while `open()` is still
   * running is rejected: the container may already exist with the previous
   * title. Failures are reported through the error handler
   * (`operation: "titleChange"`); if the old screen had to be closed already,
   * the Window fails closed instead of leaving an unknown screen.
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
    const version = ++this.#titleVersion;
    if (this.#status === "created" || this.#status === "closed") {
      // No container exists, so storing now cannot disagree with a shown
      // screen; a following open() must already see it.
      this.#title = title;
      return;
    }
    const generation = this.#generation;
    // Two overlapping regenerations would each close a container the other is
    // still using, so run them in call order. Equality is checked when the turn
    // arrives, after any earlier change, so "B" then "A" settles on "A".
    const run = this.#regenerationQueue.then(() =>
      this.#applyTitle(title, version, generation),
    );
    this.#regenerationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async #applyTitle(
    title: string,
    version: number,
    generation: number,
  ): Promise<void> {
    if (title === this.#title) {
      return;
    }
    if (
      generation !== this.#generation ||
      this.#status !== "open" ||
      this.#renderingHalted ||
      !this.#container ||
      !this.#layout ||
      !this.#stateHandle
    ) {
      // No regeneration is possible (closed, reopening, or a newer
      // generation): only store the title for the next open(). A later request
      // may already have stored a newer title synchronously; the newest wins.
      if (version === this.#titleVersion) {
        this.#title = title;
      }
      return;
    }
    await this.#regenerateContainer(title, this.#layout, "titleChange");
  }

  /**
   * Regenerate the container while the Window stays logically open (design
   * 8.4 / 11.4). The caller has checked status, layout, and state handle.
   *
   * `title` and `layout` are what the new container must show; `operation` is
   * the error-operation name used by the caller (`titleChange`, `resize`). The
   * new container is created and fully rendered before the old screen is
   * closed, so a render failure leaves the old screen showing. Only after that
   * is the old screen closed and the new one opened. Open and close handlers do
   * not run again for this internal reopen.
   */
  async #regenerateContainer(
    title: string,
    layout: ResolvedGuiLayout,
    operation: string,
  ): Promise<void> {
    const generation = this.#generation;
    const previousTitle = this.#title;
    const previousContainer = this.#container as VirtualContainer;
    const previousLayout = this.#layout as ResolvedGuiLayout;
    const previousCache = this.#writeCache;
    const size = containerSizeOf(layout);
    const options: VirtualContainerOptions =
      title.length === 0 ? { size } : { size, title };

    let nextContainer: VirtualContainer;
    try {
      nextContainer = this.#adapter.createContainer(options);
    } catch (error) {
      this.#report(error, operation);
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
    this.#renderedWidth = undefined;
    this.#title = title;

    try {
      this.#applyLayout(layout);
      await this.#renderAll(generation);
    } catch (error) {
      // #renderAll normally reports per-slot failures instead of throwing. If
      // it does throw, the old screen is still showing: restore it and report
      // the change as not applied. A close or reopen during the render owns
      // the Window now; restoring then would resurrect a torn-down screen.
      this.#report(error, operation);
      if (
        generation === this.#generation &&
        this.#status === "open" &&
        this.#container === nextContainer
      ) {
        this.#container = previousContainer;
        this.#retiringContainer = undefined;
        this.#writeCache = previousCache;
        this.#renderedWidth = previousLayout.width;
        this.#title = previousTitle;
        this.#applyLayout(previousLayout);
        this.#scheduleRefresh();
      }
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
      // closed. The requested change stays for the next open().
      this.#report(error, operation);
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
      this.#report(error, operation);
      if (generation === this.#generation && this.#status === "open") {
        this.#performClose("ServerClosed", false);
      }
      throw error;
    }
  }

  /**
   * Replace the upper GUI of an open Window (design 8.4).
   *
   * A layout with the same container size is applied in place: the slot layout
   * is re-evaluated and written again, so the container and the screen are
   * kept.
   *
   * A different size cannot be applied to an existing container, so it is
   * queued on the regeneration queue used by `setTitle()` and a state-driven
   * resize: the replacement container is created and rendered, then the old
   * screen is closed and the new one shown. The candidate is re-resolved when
   * its turn arrives, and dropped when a newer `setUpperGui()` request already
   * superseded it.
   *
   * The state schema contains the Structure rows, so a size change always
   * describes a different GUI shape. Before the replacement is shown, the
   * Window re-registers its state for the new schema. The StateManager's
   * existing rules decide whether that is allowed: a shared identity still in
   * use by another registration, an idle `session` registration, and a
   * `persistent` registration keep their schema and reject the
   * re-registration. (A declared migration only runs for an acquire with no
   * live registration, so it cannot rescue a live Window here.) On a rejection
   * the previous GUI, screen, and state registration stay as they were, and
   * the conflict is reported (`guiChange`) without writing anything under the
   * new schema, so shared and persisted data cannot be mixed or damaged. A
   * registration that does change schema starts from the previous values as its
   * initial state, so a size change does not discard the user's page, tab,
   * selection, or data; the new layout clamps out-of-range values. This means
   * the swap applies in full only while the identity is not pinned by another
   * registration, which is the default `window` lifetime with no other live
   * user of the same state identity.
   *
   * A same-size swap that also changes the schema fails closed through the
   * structural-change path below, as before.
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
    const version = ++this.#guiChangeVersion;
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
      if (this.#status === "open" && this.#container) {
        this.#queueGuiSizeSwap(gui, version, generation);
        return;
      }
      this.#report(
        new Error("InvUI: layout size changed; reopen the Window to apply it."),
        "guiChange",
      );
      return;
    }
    this.#applySameSizeUpperGui(gui, layout, generation);
  }

  /**
   * Apply an upper GUI whose resolved layout fits the current container
   * (design 8.4). The state registration is not touched: the caller has
   * checked that its schema still describes the new GUI.
   */
  #applySameSizeUpperGui(
    gui: Gui,
    layout: ResolvedGuiLayout,
    generation: number,
  ): void {
    if (!this.#schemaMatchesGui(gui)) {
      this.#failStateSchema("guiChange");
      return;
    }
    this.#attachGuiSubscription(gui, generation);
    if (generation !== this.#generation) {
      return;
    }
    const previousLayout = this.#layout;
    this.#upperGui = gui;
    this.#applyLayout(layout);
    // A failed element subscription inside #applyLayout is reported, and the
    // handler may have closed and reopened: do not refresh the new generation.
    if (generation !== this.#generation) {
      return;
    }
    // A different GUI may have a smaller content range. Write back the clamped
    // page/line/tab through the normal refresh path (design 8.4 / 9.5) instead
    // of the in-place slot diff, because that refresh re-resolves and renders
    // the corrected state.
    if (layout.statePatch !== undefined) {
      this.#revalidateStateRanges = true;
      this.#scheduleRefresh();
      return;
    }
    // The screen and container are kept, so only the slots whose element
    // changed are new. Rendering every slot would re-run providers for
    // unchanged items, which design 8.4 does not ask for.
    if (this.#status === "opening" || previousLayout === undefined) {
      this.#scheduleRefresh();
      return;
    }
    this.#queueChangedSlots(previousLayout, layout);
  }

  /**
   * Detach the current GUI subscription and attach `gui`. A failure to
   * unsubscribe is reported and the swap continues, matching the previous
   * in-place path; a failure to subscribe is reported and only push updates
   * from the new GUI are missing.
   */
  #attachGuiSubscription(gui: Gui, generation: number): void {
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
      // The swap stays safe: the new layout is applied by the caller, only
      // push updates from the new GUI are missing.
      this.#report(error, "subscribe");
    }
  }

  /**
   * Queue a size-changing upper GUI swap on the regeneration queue. The
   * candidate re-resolves when its turn arrives because an earlier queued
   * state or title regeneration may already have created a container it fits.
   */
  #queueGuiSizeSwap(gui: Gui, version: number, generation: number): void {
    const run = this.#regenerationQueue.then(() =>
      this.#applyGuiSizeSwap(gui, version, generation),
    );
    this.#regenerationQueue = run.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Apply a queued size-changing upper GUI swap (design 8.4).
   *
   * The new schema is registered before the replacement container is created,
   * because the final layout (and therefore the container size) depends on the
   * state the new registration holds. A registration that is refused leaves
   * everything as it was. If the container cannot be created afterwards, the
   * GUI and the previous registration are restored; the Window only fails
   * closed when the previous registration cannot be recovered, because then
   * no acquired state describes the screen still on display.
   */
  async #applyGuiSizeSwap(
    gui: Gui,
    version: number,
    generation: number,
  ): Promise<void> {
    if (version !== this.#guiChangeVersion || gui === this.#upperGui) {
      return;
    }
    if (
      generation !== this.#generation ||
      this.#status !== "open" ||
      this.#renderingHalted
    ) {
      return;
    }
    const container = this.#container;
    const handle = this.#stateHandle;
    if (!container || !handle) {
      return;
    }

    const previousGui = this.#upperGui;
    const previousState = handle.get();
    // Re-register the state under the new shape. A refusal restores the
    // previous registration and reports nothing here; the caller reports it
    // after the restore, so an error handler that closes and reopens the
    // Window cannot be re-entered from the state swap.
    let nextHandle: StateHandle | undefined;
    try {
      nextHandle = this.#reacquireStateForGui(gui, generation);
    } catch (error) {
      const current = generation === this.#generation && this.#status === "open";
      if (current) {
        this.#report(error, "guiChange");
      }
      return;
    }
    if (
      nextHandle === undefined ||
      generation !== this.#generation ||
      this.#status !== "open" ||
      this.#container !== container
    ) {
      return;
    }
    this.#attachGuiSubscription(gui, generation);
    if (generation !== this.#generation) {
      return;
    }
    this.#upperGui = gui;

    // The new registration may clamp page/line/tab differently from the
    // previous one, and the container size follows the resolved layout, so
    // resolve after the swap instead of reusing the caller's candidate.
    let next: ResolvedGuiLayout;
    try {
      this.#revalidateStateRanges = false;
      next = this.#resolveCurrentState(nextHandle, true);
    } catch (error) {
      this.#report(error, "guiChange");
      if (generation === this.#generation && this.#status === "open") {
        this.#rollbackGuiSizeSwap(previousGui, previousState);
      }
      return;
    }
    if (generation !== this.#generation || this.#status !== "open") {
      return;
    }
    if (containerSizeOf(next) === container.size) {
      // A queued regeneration already created a container this GUI fits, or
      // the re-registered state settled back to the current size. The
      // replacement is unnecessary; render every slot because a different
      // Structure width maps logical slots to different physical ones.
      this.#applyLayout(next);
      this.#scheduleRefresh();
      return;
    }
    try {
      await this.#regenerateContainer(this.title, next, "guiChange");
    } catch {
      // #regenerateContainer reported the failure and restored the previous
      // container and layout. Restore the GUI and registration so the screen
      // still shown is described by the acquired state; a failure while doing
      // so fails closed instead of leaving the two out of step.
      if (generation === this.#generation && this.#status === "open") {
        this.#rollbackGuiSizeSwap(previousGui, previousState);
      }
    }
  }

  /**
   * Set the GUI logically associated with the lower area (design 7.4 / 8.4).
   *
   * Bedrock does not let the library paint the player's inventory area of the
   * standard screen, so this is a logical association only: the reference is
   * replaced (also while open), but the GUI is never resolved, rendered, or
   * subscribed to, no slot is written, and the container, screen, and state
   * schema stay as they are.
   */
  setLowerGui(gui: Gui): void {
    if (!gui || typeof gui.resolve !== "function" || typeof gui.subscribe !== "function") {
      throw new TypeError("InvUI: Window lower GUI must be a Gui.");
    }
    this.#lowerGui = gui;
  }

  /**
   * Re-register the Window's state for `gui` (design 8.4 size change).
   *
   * Returns the current handle when the schema already describes `gui`: a size
   * difference caused only by the selected tab does not reset the state. A
   * different schema is a new registration under the same identity, which the
   * StateManager accepts or rejects by its schema/lifetime rules. The previous
   * values seed an accepted registration so the swap keeps the user's state.
   * On rejection the previous registration is restored before the conflict is
   * rethrown, and no state write reached the new schema. Returns `undefined`
   * when a state callback closed or reopened the Window while the registration
   * was being acquired: the new generation owns its own registration then.
   */
  #reacquireStateForGui(
    gui: Gui,
    generation: number,
  ): StateHandle | undefined {
    const previous = this.#stateHandle;
    if (!previous) {
      throw new Error(`InvUI: Window ${this.id} is not open.`);
    }
    const previousSchema = this.#stateSchema;
    // A GUI whose schema cannot be described cannot be matched to any state.
    const nextSchema = schemaOf(gui);
    if (nextSchema === previousSchema) {
      return previous;
    }
    // Carry the user's state into the new shape. A `window`-lifetime entry
    // dropped by the release would otherwise restart from the initial state;
    // `initial` is ignored when another registration still holds the identity,
    // so shared state is not overwritten here.
    const previousState = previous.get();

    // Detach before the release: the old registration's listener must not run
    // against the new GUI while the replacement is being prepared.
    const previousUnsubscribe = this.#stateSubscription;
    this.#stateSubscription = undefined;
    previousUnsubscribe?.();
    previous.release();
    this.#stateHandle = undefined;
    let next: StateHandle;
    try {
      next = this.#acquireState(gui, previousState);
    } catch (error) {
      if (generation === this.#generation && this.#status === "open") {
        this.#restoreStateRegistration(previousState, generation);
      }
      throw error;
    }
    if (generation !== this.#generation) {
      // A state callback closed and reopened the Window during the acquire.
      // The new generation already registered its own state and must keep it.
      next.release();
      return undefined;
    }
    this.#installState(next);
    return next;
  }

  /** Subscribe this Window to `handle` and make it the acquired registration. */
  #installState(handle: StateHandle): void {
    this.#stateHandle = handle;
    this.#stateSchema = handle.schema;
    this.#stateSubscription = handle.subscribe((_state, changed) =>
      this.#onStateChanged(changed),
    );
  }

  /**
   * Restore the state registration for the GUI that is still displayed after a
   * refused or failed swap. The re-registration attempt fails before any write
   * for schema/lifetime conflicts, so the stored record and any other
   * registration are untouched; re-acquiring the previous schema returns the
   * state that survived the release. A Window-lifetime entry that only this
   * Window held was dropped by the release, so `previousState` seeds the new
   * registration instead of resetting the values; an existing registration
   * ignores `initial`, so shared state is not overwritten with a stale
   * snapshot. If even that re-acquire fails, the Window has no state describing
   * the screen and fails closed — but only for the generation that owned the
   * failed swap: a close handler or error handler that closed and reopened the
   * Window during that report owns a new generation, which never saw the failed
   * swap and must not be torn down here.
   */
  #restoreStateRegistration(
    previousState?: StateSnapshot,
    generation: number = this.#generation,
  ): void {
    try {
      const handle = this.#acquireState(undefined, previousState);
      this.#installState(handle);
    } catch (error) {
      this.#report(error, "guiChange");
      if (
        generation === this.#generation &&
        (this.#status === "opening" || this.#status === "open")
      ) {
        this.#performClose("ServerClosed", true);
      }
    }
  }

  /**
   * Undo a size-swap preparation that could not be shown: release the new
   * registration, restore the GUI the screen still shows, and re-acquire the
   * previous schema (the reported container failure left the old screen up).
   */
  #rollbackGuiSizeSwap(previousGui: Gui, previousState: StateSnapshot): void {
    const generation = this.#generation;
    const handle = this.#stateHandle;
    if (handle) {
      const unsubscribe = this.#stateSubscription;
      this.#stateSubscription = undefined;
      unsubscribe?.();
      handle.release();
      this.#stateHandle = undefined;
    }
    this.#attachGuiSubscription(previousGui, generation);
    // A reported unsubscribe failure may have closed and reopened the Window;
    // the rollback belongs to the generation that owned the failed swap.
    if (generation !== this.#generation) {
      return;
    }
    this.#upperGui = previousGui;
    // The previous registration was dropped by the successful re-registration,
    // so its values seed the restored one; an existing shared registration
    // ignores them.
    this.#restoreStateRegistration(previousState, generation);
    if (
      generation !== this.#generation ||
      (this.#status !== "opening" && this.#status !== "open")
    ) {
      return;
    }
    this.#revalidateStateRanges = true;
    this.#scheduleRefresh();
  }

  /**
   * Queue the slots whose element differs between two layouts of the same
   * container (design 8.4). Unchanged slots keep their displayed stack and any
   * in-flight provider result stays valid; #queueSlotRender bumps the per-slot
   * token for changed slots so an older result cannot overwrite them. The
   * slots join the normal refresh flush, so a notification or state change in
   * the same timing still renders each slot once.
   *
   * Skipping an unchanged slot is only safe because the caller accepts the
   * same state schema: the schema contains the Structure rows, so both layouts
   * have the same width/height and a logical slot maps to the same physical
   * slot in both. The Window's state is also unchanged on this path; a clamped
   * page/line/tab forces a full refresh instead (see setUpperGui).
   */
  #queueChangedSlots(previous: ResolvedGuiLayout, next: ResolvedGuiLayout): void {
    const cache = this.#writeCache;
    for (let slot = 0; slot < next.slots.length; slot += 1) {
      const physicalSlot = physicalSlotOf(next, slot);
      if (previous.slots[slot] !== next.slots[slot]) {
        this.#queueSlotRender(slot);
        continue;
      }
      // An unchanged slot that is not known to be clear may still need one
      // attempt: a previous write or clear may have failed (the cache records
      // both failures). The cache is the same proof the full refresh uses.
      if (next.slots[slot] === null) {
        if (cache === undefined || cache.shouldWrite(physicalSlot, undefined)) {
          this.#queueSlotRender(slot);
        }
      } else if (cache !== undefined && cache.needsRetry(physicalSlot)) {
        this.#queueSlotRender(slot);
      }
    }
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

  /**
   * Resolve the current state and, when asked, write back any page/line/tab
   * value the layout clamped (design 9.5). Without the write-back the managed
   * state keeps an out-of-range value after content shrinks, and growing the
   * content again would restore that old page/line/tab instead of the one on
   * screen. Revalidation runs after a content change and when another tab's
   * stored state becomes visible; `open()` only resolves, and a direct
   * `setState()` is stored as written.
   */
  #resolveCurrentState(handle: StateHandle, revalidateRanges: boolean): ResolvedGuiLayout {
    const layout = this.upperGui.resolve(this.viewer, handle.get());
    if (revalidateRanges && layout.statePatch !== undefined) {
      handle.set(layout.statePatch);
    }
    return layout;
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
    const revalidateRanges = this.#revalidateStateRanges;
    let layout: ResolvedGuiLayout;
    try {
      layout = this.#resolveCurrentState(this.#stateHandle, revalidateRanges);
    } catch (error) {
      this.#report(error, "resolve");
      return;
    }
    if (revalidateRanges) {
      this.#revalidateStateRanges = false;
    }
    if (generation !== this.#generation || this.#status !== "open") {
      return;
    }
    const current = this.#layout;
    if (
      current &&
      containerSizeOf(layout) !== this.#container.size
    ) {
      // The container size cannot change in place, so the Window regenerates
      // it (design 8.4 / 11.4). A width-only change (same container size) is
      // applied to the existing container below.
      await this.#resizeTo();
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

  /**
   * Apply a state-change refresh as a slot diff (design 11.4): resolve the new
   * layout, move subscriptions, then render only the slots whose element changed
   * or whose element cannot be proven independent of the new state. Slots that
   * were notified by an Item/Inventory in the same timing are rendered too,
   * because this path replaces the notification-only flush.
   *
   * Falls back to a full render when the layout's shape changed (a different
   * width remaps physical slots and may leave stale columns) or the container
   * must be regenerated.
   */
  async #refreshSlots(notified: ReadonlySet<number>): Promise<void> {
    if (
      this.#renderingHalted ||
      this.#status !== "open" ||
      !this.#container ||
      !this.#stateHandle
    ) {
      return;
    }
    const generation = this.#generation;
    const revalidateRanges = this.#revalidateStateRanges;
    let layout: ResolvedGuiLayout;
    try {
      layout = this.#resolveCurrentState(this.#stateHandle, revalidateRanges);
    } catch (error) {
      this.#report(error, "resolve");
      return;
    }
    if (revalidateRanges) {
      this.#revalidateStateRanges = false;
    }
    if (generation !== this.#generation || this.#status !== "open") {
      return;
    }
    const current = this.#layout;
    if (current && containerSizeOf(layout) !== this.#container.size) {
      await this.#resizeTo();
      return;
    }
    this.#applyLayout(layout);
    // A state write-back while resolving may have closed or reopened the Window.
    if (generation !== this.#generation || this.#status !== "open") {
      return;
    }
    if (
      !current ||
      current.width !== layout.width ||
      current.height !== layout.height
    ) {
      try {
        await this.#renderAll(generation);
      } catch (error) {
        if (generation === this.#generation) {
          this.#report(error, "refresh");
        }
      }
      return;
    }
    try {
      await this.#renderLayoutDiff(current, layout, notified);
    } catch (error) {
      if (generation === this.#generation) {
        this.#report(error, "refresh");
      }
    }
  }

  /**
   * Render the slots that differ between the rendered layout and `next`.
   *
   * A slot is skipped only when all of these hold: its element reference is
   * unchanged, no Item/Inventory notification queued it, its last write did not
   * fail, and the element is provably independent of the Window state. A
   * skipped element therefore has the same viewer and the same provider source,
   * so its display cannot differ. Empty slots keep the write-cache proof used by
   * the full render.
   */
  async #renderLayoutDiff(
    previous: ResolvedGuiLayout,
    next: ResolvedGuiLayout,
    notified: ReadonlySet<number>,
  ): Promise<void> {
    const cache = this.#writeCache;
    const renders: Array<Promise<void>> = [];
    for (let slot = 0; slot < next.slots.length; slot += 1) {
      const element = next.slots[slot];
      if (notified.has(slot) || previous.slots[slot] !== element) {
        renders.push(this.#renderSlot(slot));
        continue;
      }
      const physicalSlot = physicalSlotOf(next, slot);
      if (element === null) {
        if (cache === undefined || cache.shouldWrite(physicalSlot, undefined)) {
          renders.push(this.#renderSlot(slot));
        }
        continue;
      }
      if (cache !== undefined && cache.needsRetry(physicalSlot)) {
        renders.push(this.#renderSlot(slot));
        continue;
      }
      if (isProvablyStateIndependent(element)) {
        continue;
      }
      renders.push(this.#renderSlot(slot));
    }
    await Promise.all(renders);
  }

  /**
   * Regenerate the container for a layout whose size no longer matches the
   * open one (design 8.4 / 11.4). Runs on the regeneration queue so it cannot
   * race a title change, and re-resolves the current state when its turn
   * arrives: an earlier queued change may already have settled the size.
   *
   * Failures keep the current screen: the error is reported with operation
   * `resize` and the previous container stays in place.
   */
  async #resizeTo(): Promise<void> {
    const generation = this.#generation;
    const run = this.#regenerationQueue.then(async () => {
      try {
        if (
          generation !== this.#generation ||
          this.#status !== "open" ||
          this.#renderingHalted
        ) {
          return;
        }
        const container = this.#container;
        const handle = this.#stateHandle;
        if (!container || !handle) {
          return;
        }
        let next: ResolvedGuiLayout;
        try {
          next = this.#resolveCurrentState(handle, this.#revalidateStateRanges);
        } catch (error) {
          this.#report(error, "resize");
          return;
        }
        this.#revalidateStateRanges = false;
        if (
          generation !== this.#generation ||
          this.#status !== "open" ||
          this.#container !== container
        ) {
          return;
        }
        if (containerSizeOf(next) === container.size) {
          // The state settled back to the current size: no regeneration needed.
          this.#applyLayout(next);
          try {
            await this.#renderAll(generation);
          } catch (error) {
            if (generation === this.#generation) {
              this.#report(error, "refresh");
            }
          }
          return;
        }
        try {
          await this.#regenerateContainer(this.title, next, "resize");
        } catch {
          // #regenerateContainer already reported the failure and restored
          // the previous container; a later refresh may try again.
        }
      } catch (error) {
        // The queue must never produce an unhandled rejection from a refresh
        // microtask; the Window stays usable with the current screen.
        this.#report(error, "resize");
      }
    });
    this.#regenerationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
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
    return (await this._inputClick(slot)) === "clicked";
  }

  /**
   * Internal: routes one click and reports whether a handler was invoked, for
   * the automatic chat input bridge. `handleClick()` keeps the public boolean
   * form; the boolean alone cannot tell a discarded click (safe to retry) from
   * a handler that ran and threw (replaying it would repeat its side effects).
   */
  async _inputClick(slot: number): Promise<ChatInputClickOutcome> {
    if (this.#status !== "open" || !this.#layout || !this.#stateHandle) {
      return "discarded";
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.#layout.slots.length) {
      return "discarded";
    }
    const layout = this.#layout;
    const element = layout.slots[slot];
    if (!isButtonElement(element)) {
      return "discarded";
    }
    const generation = this.#generation;
    const handle = this.#stateHandle;
    let handlerInvoked = false;
    try {
      const clicked = await handle.enqueue(async () => {
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
        handlerInvoked = true;
        await element.handleClick({ player: this.viewer, slot, window: this });
        return true;
      });
      return clicked ? "clicked" : "discarded";
    } catch (error) {
      // A closed/reopened window discards queued clicks silently; a handler or
      // state-update failure while the window is live goes to the error channel.
      if (this.#status === "open" && generation === this.#generation) {
        this.#report(error, "click", slot);
      }
      // A rejection after the handler was invoked (or after the item's own
      // click path started) may already have applied side effects.
      return handlerInvoked ? "failed" : "discarded";
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
    // The shutdown callback runs with restricted-execution privilege, where
    // VirtualContainer.close() and every event unsubscribe() throw. Skipping
    // both keeps the teardown to local resources; the engine drops the screen
    // and subscriptions with the session. The latch is permanent, so a later
    // close() during the same shutdown takes the same path.
    const restricted = shutdownInProgress;
    this.#status = "closing";
    const generation = ++this.#generation;
    this.#stopRendering();

    // Detach before touching the adapter: closeContainer may dispatch the
    // close event synchronously and must not run this path twice.
    if (restricted) {
      // Drop the local handles without calling them; see above.
      this.#eventUnsubscribers = [];
    } else {
      this.#unsubscribeFromContainerEvents();
      // An unsubscribe failure is reported, and the error handler may have
      // closed and reopened the Window: the rest of this close belongs to a
      // generation that is gone, and its teardown must not destroy the
      // reopened screen.
      if (generation !== this.#generation) {
        return;
      }
    }

    if (requestAdapterClose && wasVisible && !restricted) {
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

    this.#teardown(restricted);
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
   * Track this Window for automatic close when its viewer's session ends
   * (leave, death, dimension change, spectator) and for the shutdown teardown.
   * The viewer id is read here, before the player can go invalid; if it cannot
   * be read, session matching simply ignores the Window, but it is still
   * tracked so shutdown can release it.
   */
  #registerForLifecycleClose(): void {
    lifecycleWindows.add(this);
    ensurePlayerLeaveSubscription();
    ensureEntityDieSubscription();
    ensurePlayerDimensionChangeSubscription();
    ensurePlayerGameModeChangeSubscription();
    ensureShutdownSubscription();

    try {
      this.#viewerId = this.viewer.id;
    } catch {
      this.#viewerId = undefined;
    }
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
    this.#revalidateStateRanges = false;
    this.#fullRefreshQueued = false;
    this.#slotRefreshQueued = false;
    this.#pendingSlotRenders.clear();
    this.#slotRenderTokens.clear();
  }

  #acquireState(
    gui: Gui = this.upperGui,
    initial?: StateSnapshot,
  ): StateHandle {
    const common = {
      scope: this.#stateScope,
      lifetime: this.#stateLifetime,
      schema: schemaOf(gui),
      ...(initial === undefined ? {} : { initial }),
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

  /**
   * State changed: invalidate in-flight renders and re-evaluate the GUI. The
   * refresh diffs the resolved layout against the rendered one (design 11.4):
   * a slot is skipped only when its element is provably independent of the
   * Window state (see `isProvablyStateIndependent`). Anything else — including
   * an opaque Item provider that can read `Window.getState()` — is re-evaluated.
   */
  #onStateChanged(changed: readonly GuiStateField[]): void {
    // Content changes are only resolved for the active tab, so a branch that
    // was hidden while its content shrank still stores an out-of-range page or
    // line. Selecting that tab is the first time the clamped value is shown:
    // revalidate it on the refresh that shows it, so shrinking and growing
    // content cannot resurrect a value the player already saw clamped.
    if (changed.includes("tab")) {
      this.#revalidateStateRanges = true;
    }
    this.#scheduleSlotRefresh();
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
    this.#revalidateStateRanges = true;
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

  /**
   * Queue a state-change refresh that resolves the new layout and renders only
   * the slots it cannot prove unchanged (design 11.4). `open()` still performs
   * a full pass; a GUI change queues the full refresh above.
   */
  #scheduleSlotRefresh(): void {
    if (this.#renderingHalted) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    // A provider call started before the state change may have read the old
    // state, so its result must not land in any slot.
    this.#renderEpoch += 1;
    if (this.#status === "opening") {
      this.#refreshPending = true;
      return;
    }
    this.#slotRefreshQueued = true;
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
   * Queue one slot for re-evaluation after an Item/Inventory notification.
   *
   * The token is bumped now, not when the batched render starts: a result that
   * the previous provider of this slot resolves before the microtask would
   * otherwise land and stay on screen until the new result arrives.
   */
  #queueSlotRender(slot: number): void {
    if (this.#renderingHalted) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    this.#slotRenderTokens.set(slot, (this.#slotRenderTokens.get(slot) ?? 0) + 1);
    this.#pendingSlotRenders.add(slot);
    this.#queueRefreshFlush();
  }

  /**
   * Run the state/GUI refresh and the per-slot notifications collected since
   * the last flush. Multiple notifications in one timing are evaluated once
   * (design 11.2 step 3 / 11.5). A full refresh covers every queued slot; a
   * state diff also renders the notified slots. A close or reopen before the
   * microtask drops the work: the new generation either renders in `open()` or
   * has already prepared its own notifications.
   */
  #runRefreshFlush(): void {
    const slots = this.#pendingSlotRenders;
    this.#pendingSlotRenders = new Set();
    const fullRefresh = this.#fullRefreshQueued;
    this.#fullRefreshQueued = false;
    const slotRefresh = this.#slotRefreshQueued;
    this.#slotRefreshQueued = false;
    if (this.#renderingHalted) {
      return;
    }
    if (fullRefresh) {
      if (this.#status !== "open") {
        return;
      }
      void this.#refresh();
      return;
    }
    if (slotRefresh) {
      if (this.#status !== "open") {
        return;
      }
      void this.#refreshSlots(slots);
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    const layout = this.#layout;
    if (!layout) {
      return;
    }
    for (const slot of slots) {
      if (slot < layout.slots.length) {
        void this.#renderSlot(slot);
      }
    }
  }

  #applyLayout(layout: ResolvedGuiLayout): void {
    const previous = this.#layout;
    this.#layout = layout;
    // A page/line/tab change or a different slot element mapping is a new
    // clickable layout: notifications accepted against the previous one must
    // not run against this one. Content-only re-renders that keep every slot
    // element stay valid.
    if (
      previous &&
      (previous.page !== layout.page ||
        previous.line !== layout.line ||
        previous.tab !== layout.tab ||
        !sameSlotElements(previous.slots, layout.slots))
    ) {
      invalidateChatInputWindow(this);
    }
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
    // A narrower Structure reuses the same container: the columns beyond its
    // width are no longer addressed, so slots a wider layout wrote there must
    // be cleared instead of left visible.
    if (this.#renderedWidth !== undefined && this.#renderedWidth > layout.width) {
      this.#clearUnmappedColumns(layout);
    }
    this.#renderedWidth = layout.width;
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

  /**
   * Clear the physical columns a wider Structure previously wrote but the
   * current layout no longer addresses. `container.size` covers `height` full
   * nine-column rows, so only the tail of each row can be stale (a height
   * change creates a new container instead).
   */
  #clearUnmappedColumns(layout: ResolvedGuiLayout): void {
    const container = this.#container;
    const cache = this.#writeCache;
    if (!container || !cache) {
      return;
    }
    for (let row = 0; row < layout.height; row += 1) {
      for (let column = layout.width; column < PHYSICAL_COLUMNS; column += 1) {
        const physicalSlot = row * PHYSICAL_COLUMNS + column;
        if (physicalSlot >= container.size || !cache.shouldWrite(physicalSlot, undefined)) {
          continue;
        }
        try {
          // The layout has no logical slot for this index, so the reported
          // slot is the physical one.
          container.setItem(physicalSlot, undefined);
        } catch (error) {
          this.#report(error, "setItem", physicalSlot);
          continue;
        }
        cache.markWritten(physicalSlot, undefined);
      }
    }
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
      } else if (isInventoryLinkElement(element)) {
        // Resolve synchronously: a state diff may skip this slot because the
        // link cannot observe Window state, so its write must land before the
        // diff yields. An async read could be invalidated by a following state
        // change, and the next diff would then see the slot as already
        // rendered and never write the link (design 11.4).
        stack = element.getItem();
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
      // A synchronous InventoryLink read never suspends, but a reentrant
      // notification it caused can still have replaced this slot, so it is
      // reported only while the slot is current (the old async read path).
      const canBeStale = awaited || isInventoryLinkElement(element);
      if (!canBeStale || this.#isCurrentSlot(generation, epoch, slot, element, token)) {
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
      // Remember the failure so a slot-skipping diff still re-renders this
      // slot; otherwise the failed write's stale display would persist.
      cache.markFailed(physicalSlot);
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
              this.#queueSlotRender(slot);
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

  /**
   * `restricted` is the shutdown path: adapter unsubscribers are dropped, not
   * called, because they run `unsubscribe()` on game signals, which restricted
   * execution forbids. Everything else is local and released either way.
   */
  #teardown(restricted = false): void {
    // Drop the Window from chat routing and lifecycle handling first: a close
    // handler may reopen it, and the reopened generation must be registered
    // afresh (with its own viewer id) instead of inheriting this teardown.
    forgetChatInputWindow(this);
    lifecycleWindows.delete(this);
    if (restricted) {
      this.#eventUnsubscribers = [];
    } else {
      this.#unsubscribeFromContainerEvents();
    }
    this.#stateSubscription?.();
    this.#stateSubscription = undefined;
    this.#guiSubscription?.();
    this.#guiSubscription = undefined;
    this.#unsubscribeElements();
    this.#stateHandle?.release();
    this.#stateHandle = undefined;
    this.#stateSchema = undefined;
    this.#viewerId = undefined;
    this.#container = undefined;
    this.#retiringContainer = undefined;
    this.#expectedCloseContainer = undefined;
    this.#layout = undefined;
    this.#writeCache = undefined;
    this.#renderedWidth = undefined;
    this.#screenRequested = false;
    this.#refreshPending = false;
    this.#fullRefreshQueued = false;
    this.#slotRefreshQueued = false;
    this.#pendingSlotRenders.clear();
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
