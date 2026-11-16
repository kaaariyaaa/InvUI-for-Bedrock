/**
 * Window lifecycle and VirtualContainer adapter.
 *
 * Screen slot changes are restored from beforeItemStack. Matching player
 * inventory, cursor, and dropped-item changes are reconciled on the next tick.
 * If the screen slot cannot be restored, the Window closes.
 */
import { world } from "@minecraft/server";
import * as server from "@minecraft/server";
import type {
  Container,
  Entity,
  EntityItemDropAfterEvent,
  ItemStack,
  Player,
  PlayerCursorItemGrabAfterEvent,
  PlayerCursorInventoryComponent,
  PlayerCursorItemReleaseAfterEvent,
  PlayerInventoryItemChangeAfterEvent,
  PlayerInventoryType,
  VirtualContainer,
  VirtualContainerCloseAfterEvent,
  VirtualContainerCloseReason,
  VirtualContainerItemChangeAfterEvent,
  VirtualContainerOptions,
} from "@minecraft/server";
import {
  WindowOpenRejectedError,
  WindowItemChangeDangerError,
  WindowStateSchemaChangedError,
  WindowOpenRenderLimitError,
} from "./window-types.js";
import type {
  WindowCloseReason,
  WindowStatus,
  WindowErrorContext,
  WindowErrorHandler,
  WindowOpenHandler,
  WindowCloseHandler,
  WindowContainerCloseEvent,
  WindowContainerItemChangeEvent,
  WindowContainerCloseHandler,
  WindowContainerItemChangeHandler,
} from "./window-types.js";
import { minecraftVirtualContainerAdapter } from "./window-adapter.js";
import type { WindowContainerAdapter } from "./window-adapter.js";
import {
  lifecycleWindows,
  shutdownInProgress,
  readId,
  ensurePlayerLeaveSubscription,
  ensureEntityDieSubscription,
  ensurePlayerDimensionChangeSubscription,
  ensurePlayerGameModeChangeSubscription,
  ensureShutdownSubscription,
} from "./window-lifecycle.js";
import { WindowItemGuard } from "./window-item-guard.js";
import {
  playerSlotOffsets,
  MAX_SCREEN_GUARD_RECORDS,
  stackType,
  stackAmount,
  gainedBy,
  lostBy,
  playerInventoryContainer,
  readContainerItem,
  sameTypeAndAmount,
  sameItemContent,
  itemGuardWindows,
  ensureItemGuardSubscriptions,
} from "./window-item-guard.js";
import type {
  ScreenItemChange,
  PlayerSlotChangeRecord,
  CursorItemChangeRecord,
  DroppedItemChangeRecord,
} from "./window-item-guard.js";
export {
  WindowOpenRejectedError,
  WindowItemChangeDangerError,
  WindowStateSchemaChangedError,
  WindowOpenRenderLimitError,
} from "./window-types.js";
export type {
  WindowCloseReason,
  WindowStatus,
  WindowErrorContext,
  WindowErrorHandler,
  WindowOpenHandler,
  WindowCloseHandler,
  WindowContainerCloseEvent,
  WindowContainerItemChangeEvent,
  WindowContainerCloseHandler,
  WindowContainerItemChangeHandler,
} from "./window-types.js";
export {
  MinecraftVirtualContainerAdapter,
  minecraftVirtualContainerAdapter,
} from "./window-adapter.js";
export type { WindowContainerAdapter } from "./window-adapter.js";
import {
  isItemElement,
  isButtonElement,
  isInventoryLinkElement,
  isProvablyStateIndependent,
  schemaOf,
  schemaNodeOf,
  PHYSICAL_COLUMNS,
  sameSlotElements,
  sameClickableLayout,
  containerSizeOf,
  physicalSlotOf,
} from "./window-layout.js";
import { defaultManager } from "./window-default-state.js";
import { WindowBuilder, MergedWindowBuilder } from "./window-builder.js";
import type { WindowConfig } from "./window-builder.js";
export { WindowBuilder, MergedWindowBuilder } from "./window-builder.js";
export type { WindowConfig } from "./window-builder.js";
import { GuiLink, ScrollGui, TabGui } from "../gui/gui.js";
import type { Gui, ResolvedGuiLayout, SlotElement } from "../gui/gui.js";
import type { InventoryLink } from "../inventory/inventory.js";
import type { Item } from "../item.js";
import { BedrockWorldStateStore } from "../state/bedrock-store.js";
import { SlotWriteCache } from "../render/render-cache.js";
import { StateManager } from "../state/state.js";
import type {
  GuiStateField,
  GuiStatePatch,
  StateHandle,
  StateLifetime,
  StateScope,
  StateSnapshot,
  StateStore,
} from "../state/state.js";

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


export const MAX_OPEN_RENDER_PASSES = 100;

/** Retry PreviousScreenClosing on later ticks while a client closes its screen. */
const PREVIOUS_SCREEN_CLOSING_RETRIES = 20;

function isPreviousScreenClosingError(error: unknown): boolean {
  try {
    return (
      (error as { reason?: unknown } | undefined)?.reason ===
      "PreviousScreenClosing"
    );
  } catch {
    return false;
  }
}

/** Resolves on the next game tick, or on a microtask without `system.run`. */
function waitOneTick(): Promise<void> {
  const gameSystem: typeof server.system | undefined = server.system;
  if (!gameSystem || typeof gameSystem.run !== "function") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    try {
      gameSystem.run(resolve);
    } catch {
      // A missing scheduler must not turn a retryable open into a failure.
      resolve();
    }
  });
}

/** True when both layouts render the same element at every logical slot. */
let nextWindowId = 1;
export class Window {
  readonly id = `window-${nextWindowId++}`;
  readonly viewer: Player;
  #title: string;
  #upperGui: Gui;
  #lowerGui: Gui | undefined;

  #status: WindowStatus = "created";
  /** Invalidate queued clicks when the layout changes. */
  #clickLayoutGeneration = 0;
  /** Layout pending rendering; it cannot receive clicks yet. */
  #pendingClickLayout: ResolvedGuiLayout | undefined;
  /**
   * Logical slots of `#layout` whose last render attempt failed or whose write
   * threw. They still show whatever the container had before (the previous
   * layout's item after a mapping change), so `handleClick()`
   * treat them as non-buttons until a later write succeeds. Without this the
   * gate would open for a layout where a failed slot was never drawn, and a
   * click could run the new page's handler while the player sees the old item.
   */
  #unrenderedSlots = new Set<number>();
  /**
   * Full-layout render passes still running per applied layout. A layout does
   * not settle while any pass for it is in flight, so a queued click flush that
   * wrote a single slot cannot present a layout whose remaining slots are still
   * being rendered.
   */
  #layoutRenders = new Map<ResolvedGuiLayout, number>();
  /**
   * True once the pass(es) that applied `#layout` settled. `#applyLayout`
   * clears it; only `#settleLayout` sets it, and only when no in-flight pass for
   * that layout is left. A newer state change keeps it clear until that state's
   * own layout settled.
   */
  #layoutSettled = false;
  /**
   * True once the layout in `#layout` has been written to the container that is
   * on screen and every in-flight pass for it settled (`#layoutSettled`). A
   * container regeneration keeps it clear from the swap until the replacement is
   * opened. Input fails closed in between: a slot of the applied layout (or of
   * the layout the screen still shows) is not on screen yet.
   */
  #layoutPresented = false;
  /**
   * True while `#regenerateContainer` has replaced `#container` but has not
   * shown the replacement yet. The old screen is still visible, so a render
   * into the replacement must not mark its layout as presented.
   */
  #containerSwapPending = false;
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
  /**
   * True when the adapter limits every event subscription to one container
   * (see `WindowContainerAdapter.filtersContainerEvents`). The Window then
   * subscribes per container and attributes the event to that container
   * instead of trusting `event.container` to be the same reference.
   */
  #filtersContainerEvents: boolean;
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
  /** Skip empty-to-empty writes per container; retry previously failed writes. */
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
  /**
   * Per-container adapter unsubscribers for a filter-capable adapter, keyed by
   * the container whose events they receive. A container the Window no longer
   * owns is released immediately (see #releaseContainerEventSubscriptions): its
   * filter would otherwise keep the container and its engine subscription
   * alive for the rest of the Window's life.
   */
  #containerEventUnsubscribers = new Map<VirtualContainer, Array<() => void>>();
  /** Set once `openContainer` has been called, before the screen may emit events. */
  #screenRequested = false;
  readonly #itemGuard: WindowItemGuard;
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
    this.#filtersContainerEvents = config.adapter.filtersContainerEvents === true;
    this.#openHandlers = config.openHandlers;
    this.#closeHandlers = config.closeHandlers;
    this.#errorHandler = config.errorHandler;
    this.#itemGuard = new WindowItemGuard(this.viewer, {
      isActive: () => this.#status === "opening" || this.#status === "open",
      samePlayer: (player) => isSamePlayer(player, this.viewer),
      getViewerId: () => this.#viewerId,
      report: (error, operation, slot) => this.#report(error, operation, slot),
    });
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

  /** Only the fully displayed layout can receive clicks. */
  #clickableLayout(): ResolvedGuiLayout | undefined {
    return this.#pendingClickLayout === undefined && this.#layoutPresented
      ? this.#layout
      : undefined;
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
    // Presentation state belongs to the generation that is gone.
    this.#layoutPresented = false;
    this.#layoutSettled = false;
    this.#layoutRenders.clear();
    this.#unrenderedSlots.clear();
    this.#containerSwapPending = false;
    this.#pendingClickLayout = undefined;
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
      // opening (for example UserBusy) must still tear the Window down. A
      // filter-capable adapter is subscribed per container once the first one
      // exists, because the beta filter needs the container itself.
      if (
        !this.#filtersContainerEvents &&
        !this.#subscribeToContainerEvents(generation)
      ) {
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
      if (!this.#subscribeFilteredContainer(container, generation)) {
        return;
      }

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
          const replaced = container;
          container = createContainer(size);
          this.#container = container;
          if (!this.#subscribeFilteredContainer(container, generation)) {
            return;
          }
          // The replaced container was never shown and will never be shown, so
          // its subscription can never act: do not keep it (or the container it
          // filters on) alive for the rest of the open.
          this.#releaseContainerEventSubscriptions(replaced);
          // A failed release is reported, and that handler may close and
          // reopen the Window. The rest of this pass belongs to the generation
          // that is gone: re-applying its layout and starting its render batch
          // would invalidate the reopened generation's in-flight renders and
          // leave its freshly opened screen blank.
          if (generation !== this.#generation || this.#status !== "opening") {
            return;
          }
        }
        this.#applyLayout(layout);
        // Moving the element subscriptions reports a failed subscribe or
        // unsubscribe, and that handler may close and reopen the Window. The
        // rest of this pass belongs to the generation that is gone: starting
        // its render batch would bump the render epoch and discard the
        // reopened generation's in-flight provider results, leaving its screen
        // blank (the same hazard #refresh guards against).
        if (generation !== this.#generation || this.#status !== "opening") {
          return;
        }
        await this.#renderAll(generation);
        if (generation !== this.#generation || this.#status !== "opening") {
          return;
        }
        if (!this.#refreshPending) {
          break;
        }
      }

      this.#screenRequested = true;
      await this.#openContainer(container, generation);
      // A close event may have been dispatched synchronously from
      // openContainer; it already tore the Window down.
      if (generation !== this.#generation || this.#status !== "opening") {
        return;
      }
      this.#status = "open";
      // The render loop above had already finished when the open started
      // retrying, so a state or GUI change during the retry only set
      // `#refreshPending` and nothing consumes it any more. Without this pass
      // the Window would resolve `open()` with the screen showing the state
      // from before the change until some later notification happens to
      // refresh it. The normal refresh also regenerates the container when the
      // change altered its size; it retries PreviousScreenClosing itself.
      if (this.#refreshPending) {
        this.#refreshPending = false;
        // The screen shows the layout from before that change until the
        // scheduled refresh applies and renders the new one.
        this.#layoutPresented = false;
        this.#scheduleRefresh();
      }
      this.#clickLayoutGeneration = 0;
      this.#pendingClickLayout = undefined;
      this.#runOpenHandlers();
    } catch (error) {
      // The failing operation may have reported an error (for example a
      // subscription cleanup) whose handler closed and reopened the Window, and
      // that close already tore the old resources down. The failed open then
      // belongs to the generation that is gone: tearing down again would
      // release the reopened generation's own state handle and subscriptions.
      if (generation !== this.#generation) {
        throw error;
      }
      // The teardown may itself report an unsubscribe failure, and that handler
      // can close and reopen the Window. The failed open then belongs to the
      // generation that is gone: it must not mark the reopened Window closed or
      // deliver its error to the new generation's handler.
      this.#teardown();
      if (generation !== this.#generation) {
        throw error;
      }
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

  /** Recreate an open container to change its title, keeping state and handlers. */
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

  /** Render the new container before closing the old one; restore state on error. */
  async #regenerateContainer(
    title: string,
    layout: ResolvedGuiLayout,
    operation: string,
    reportBeforeCloseFailure = true,
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
      if (reportBeforeCloseFailure) {
        this.#report(error, operation);
      }
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
    // The old screen is still the one the player sees until the replacement
    // renders and is opened. Input fails closed in between, and a render into
    // the replacement must not present it (see #presentLayout).
    this.#containerSwapPending = true;
    this.#layoutPresented = false;

    try {
      // The replacement is not shown yet, but its close/item events must be
      // attributable before it is opened, without trusting object identity.
      if (!this.#subscribeFilteredContainer(nextContainer, generation)) {
        return;
      }
      this.#applyLayout(layout);
      // A subscription report may have closed and reopened the Window. This
      // regeneration belongs to the generation that is gone; rendering its
      // batch now would bump the render epoch and discard the reopened
      // generation's in-flight provider results, leaving its screen blank.
      if (generation !== this.#generation || this.#status !== "open") {
        return;
      }
      await this.#renderAll(generation);
    } catch (error) {
      // #renderAll normally reports per-slot failures instead of throwing. If
      // it does throw, the old screen is still showing: restore it, then report
      // the change as not applied. A close or reopen during the render owns the
      // Window now; restoring then would resurrect a torn-down screen.
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
        // The old screen is current again; the scheduled refresh presents it
        // once the restored layout has been rendered.
        this.#containerSwapPending = false;
        this.#applyLayout(previousLayout);
        // The replacement was never shown and the old container is current
        // again: its subscription must not outlive the failed swap.
        this.#releaseContainerEventSubscriptions(nextContainer);
        this.#scheduleRefresh();
      }
      if (reportBeforeCloseFailure) {
        this.#report(error, operation);
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
      if (generation === this.#generation && this.#status === "open") {
        // Give the visible screen back to this Window before reporting: an
        // error handler that closes or reopens must target the screen the
        // player still sees, not the replacement that was never shown.
        this.#retiringContainer = previousContainer;
      }
      this.#report(error, operation);
      if (generation === this.#generation && this.#status === "open") {
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
      await this.#openContainer(nextContainer, generation);
      if (
        generation !== this.#generation ||
        this.#status !== "open" ||
        this.#container !== nextContainer
      ) {
        return;
      }
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

    // The replacement is on screen now, so input may target its layout again.
    // A refresh that ran during the open may already have applied a newer one;
    // present whatever settled. If that layout's pass is still rendering, its
    // own settlement opens the gate later instead.
    this.#containerSwapPending = false;
    this.#presentLayout();

    // The regeneration completed: the old screen was closed and its
    // `#retiringContainer` ownership cleared before it was replaced, so its
    // subscription can no longer act on this Window. Release it now instead of
    // keeping one engine subscription (and container reference) per replaced
    // screen for the rest of the Window's life. Released after the open so an
    // unsubscribe failure reported from here cannot race the screen swap.
    this.#releaseContainerEventSubscriptions(previousContainer);
  }

  /**
   * Update changed slots in place for same-size GUIs.
   * Size changes recreate the container and require a compatible state schema.
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
    // the corrected state. While `open()` is still resolving, only render the
    // clamp (see #onGuiChanged): a write here would rewind another viewer of
    // the same shared state.
    if (layout.statePatch !== undefined) {
      if (this.#status !== "opening") {
        this.#revalidateStateRanges = true;
      }
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
    const queued = this.#queueChangedSlots(previousLayout, layout);
    if (queued === 0) {
      // Every slot is already on screen: the applied layout settled.
      this.#settleLayout(generation, layout, this.#container);
    }
  }

  /**
   * Detach the current GUI subscription and attach `gui`. A failure to
   * unsubscribe is reported and the swap continues, matching the previous
   * in-place path; a failure to subscribe is reported and only push updates
   * from the new GUI are missing.
   */
  #attachGuiSubscription(gui: Gui, generation: number): void {
    // Detach the old GUI before attaching the new one so a queued click from
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
   * Register compatible state, render the new container, and swap.
   * Restore previous state and GUI if the replacement fails.
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
      this.#failGuiSizeSwap(error, previousGui, previousState, generation);
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
      // The old container is restored by #regenerateContainer when the failure
      // leaves the old screen showing; this caller restores the GUI and state
      // registration before reporting, so the error handler sees the Window the
      // player still sees. A failure after the old screen was closed is
      // reported (and failed closed) there instead.
      await this.#regenerateContainer(this.title, next, "guiChange", false);
    } catch (error) {
      this.#failGuiSizeSwap(error, previousGui, previousState, generation);
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

  /** Restore the old state registration after a failed GUI swap. */
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

  /** Restore the previous GUI and state before reporting the error. */
  #failGuiSizeSwap(
    error: unknown,
    previousGui: Gui,
    previousState: StateSnapshot,
    generation: number,
  ): void {
    if (generation !== this.#generation || this.#status !== "open") {
      return;
    }
    this.#rollbackGuiSizeSwap(previousGui, previousState);
    // `closed` means the rollback failed to restore and failed closed.
    if (generation === this.#generation || this.status === "closed") {
      this.#report(error, "guiChange");
    }
  }

  /** Render changed slots only when a replacement GUI keeps the same size. */
  #queueChangedSlots(previous: ResolvedGuiLayout, next: ResolvedGuiLayout): number {
    const cache = this.#writeCache;
    let queued = 0;
    for (let slot = 0; slot < next.slots.length; slot += 1) {
      const physicalSlot = physicalSlotOf(next, slot);
      if (previous.slots[slot] !== next.slots[slot]) {
        this.#queueSlotRender(slot);
        queued += 1;
        continue;
      }
      // An unchanged slot that is not known to be clear may still need one
      // attempt: a previous write or clear may have failed (the cache records
      // both failures). The cache is the same proof the full refresh uses.
      if (next.slots[slot] === null) {
        if (cache === undefined || cache.shouldWrite(physicalSlot, undefined)) {
          this.#queueSlotRender(slot);
          queued += 1;
        }
      } else if (cache !== undefined && cache.needsRetry(physicalSlot)) {
        this.#queueSlotRender(slot);
        queued += 1;
      }
    }
    return queued;
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
    // Moving the element subscriptions reports a failed subscribe/unsubscribe,
    // and that handler may close and reopen the Window. The rest of this pass
    // belongs to the generation that is gone: starting its render batch would
    // bump the render epoch and discard the reopened generation's in-flight
    // provider results, leaving its screen blank.
    if (generation !== this.#generation || this.#status !== "open") {
      return;
    }
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
   * Render only changed and potentially state-dependent slots.
   * Use a full render when the layout shape changes.
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
      current.height !== layout.height ||
      // A clear of a column beyond the current width failed on an earlier pass
      // and left the wider width recorded: only the full render retries it.
      (this.#renderedWidth !== undefined && this.#renderedWidth > layout.width)
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
    const container = this.#container;
    const generation = this.#generation;
    this.#beginLayoutRender(next);
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
    try {
      await Promise.all(renders);
    } finally {
      // A rejected pass still settles the update: keep the window usable
      // instead of leaving input closed until some later pass happens.
      this.#endLayoutRender(next);
      this.#settleLayout(generation, next, container);
    }
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
          // A subscription report may have closed and reopened the Window; do
          // not start this pass's render batch for the generation that is gone
          // (it would discard the reopened generation's in-flight results).
          if (generation !== this.#generation || this.#status !== "open") {
            return;
          }
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
   * Dispatch a click to a displayed button Item. Queued clicks are checked
   * against the current layout and mode before running their handlers.
   */
  async handleClick(slot: number): Promise<boolean> {
    const layout = this.#status === "open" ? this.#clickableLayout() : undefined;
    if (!layout || !this.#stateHandle) {
      return false;
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= layout.slots.length) {
      return false;
    }
    const element = layout.slots[slot];
    if (this.#unrenderedSlots.has(slot)) {
      // The slot never showed this layout's item: its button is not clickable.
      return false;
    }
    if (!isButtonElement(element)) {
      return false;
    }
    const generation = this.#generation;
    const layoutGeneration = this.#clickLayoutGeneration;
    const handle = this.#stateHandle;
    try {
      const clicked = await handle.enqueue(async () => {
        if (
          this.#status !== "open" ||
          this.#stateHandle !== handle ||
          generation !== this.#generation ||
          layoutGeneration !== this.#clickLayoutGeneration
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
          // Compare the whole mapping, not only this slot: a change that
          // swapped another slot is a new clickable layout (the logical layout
          // generation advances for it too), and a handler may read the rest
          // of the layout. A queued click started before that change must not
          // run its handler after it (design 10.5, 12.3).
          !sameSlotElements(layout.slots, currentLayout.slots)
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
      return clicked;
    } catch (error) {
      // A closed/reopened window discards queued clicks silently; a handler or
      // state-update failure while the window is live goes to the error channel.
      if (this.#status === "open" && generation === this.#generation) {
        this.#report(error, "click", slot);
      }
      // A rejection after the handler was invoked (or after the item's own
      // click path started) may already have applied side effects.
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

  /** Close once, even during opening; skip old handlers if reopened. */
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
      this.#containerEventUnsubscribers.clear();
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
    // The teardown may report an unsubscribe failure, and that handler can
    // close and reopen the Window: the rest of this close belongs to the
    // generation that is gone and must not mark the reopened one closed.
    if (generation !== this.#generation) {
      return;
    }
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

  /**
   * `container` is the subscription's container when the adapter guaranteed
   * the beta `containers` filter, and the event's own reference otherwise.
   */
  #onContainerClose(
    generation: number,
    event: WindowContainerCloseEvent,
    container: VirtualContainer = event.container,
  ): void {
    if (generation !== this.#generation) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    // The Window asked for this close itself (title regeneration); it must not
    // be treated as the player closing the Window.
    if (container === this.#expectedCloseContainer) {
      return;
    }
    if (!this.#ownsContainer(container)) {
      return;
    }
    if (!isSamePlayer(event.player, this.viewer)) {
      return;
    }
    this.#performClose(event.reason, false);
  }

  /** Restore the screen slot and reconcile matching player-side changes next tick. */
  #onContainerItemChange(
    generation: number,
    event: WindowContainerItemChangeEvent,
    container: VirtualContainer = event.container,
  ): void {
    if (generation !== this.#generation) {
      return;
    }
    if (this.#status !== "opening" && this.#status !== "open") {
      return;
    }
    if (!this.#ownsContainer(container)) {
      return;
    }
    if (!isSamePlayer(event.player, this.viewer)) {
      // Another viewer changed this container through its screen. The Window
      // does not close for that, so it keeps rendering: the write cache no
      // longer describes the slots and must not skip an empty clear.
      this.#writeCache?.invalidate();
      return;
    }
    if (!("beforeItemStack" in event)) {
      // An adapter that cannot describe the previous item leaves nothing to
      // restore with; fall back to failing closed instead of clearing a slot
      // that may have shown an item.
      this.#report(new WindowItemChangeDangerError(event.slot), "itemChange", event.slot);
      if (generation !== this.#generation) {
        return;
      }
      this.#stopRendering();
      this.#performClose("ServerClosed", true);
      return;
    }
    this.#itemGuard.recordScreenChange(event.beforeItemStack, event.itemStack);
    if (!this.#restoreScreenSlot(generation, container, event.slot, event.beforeItemStack)) {
      return;
    }
    this.#itemGuard.queueReconcile();
  }


  /**
   * Write the slot's previous stack back through the screen change. Script
   * writes do not raise `virtualContainerItemChange`, so this cannot re-enter
   * the handler. Returns false when the Window failed closed on a throwing
   * write; the caller then stops.
   */
  #restoreScreenSlot(
    generation: number,
    container: VirtualContainer,
    physicalSlot: number,
    before: ItemStack | undefined,
  ): boolean {
    // The slot no longer matches what the cache believes; a later render must
    // not skip it.
    this.#writeCache?.invalidate(physicalSlot);
    try {
      container.setItem(physicalSlot, before);
      return true;
    } catch (error) {
      // The error handler may have closed and reopened the Window; this event
      // still belongs to the previous generation and must not close the new one.
      if (generation !== this.#generation) {
        this.#report(error, "itemChange", physicalSlot);
        return false;
      }
      if (this.#status !== "opening" && this.#status !== "open") {
        this.#report(error, "itemChange", physicalSlot);
        return false;
      }
      this.#report(
        new WindowItemChangeDangerError(physicalSlot, { cause: error }),
        "itemChange",
        physicalSlot,
      );
      if (generation === this.#generation) {
        this.#stopRendering();
        this.#performClose("ServerClosed", true);
      }
      return false;
    }
  }



















  _onViewerInventoryChange(event: PlayerInventoryItemChangeAfterEvent): void {
    this.#itemGuard._onViewerInventoryChange(event);
  }

  _onViewerCursorGrab(event: PlayerCursorItemGrabAfterEvent): void {
    this.#itemGuard._onViewerCursorGrab(event);
  }

  _onViewerCursorRelease(event: PlayerCursorItemReleaseAfterEvent): void {
    this.#itemGuard._onViewerCursorRelease(event);
  }

  _onViewerItemDrop(event: EntityItemDropAfterEvent): void {
    this.#itemGuard._onViewerItemDrop(event);
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
    itemGuardWindows.add(this);
    ensurePlayerLeaveSubscription();
    ensureEntityDieSubscription();
    ensurePlayerDimensionChangeSubscription();
    ensurePlayerGameModeChangeSubscription();
    ensureShutdownSubscription();
    ensureItemGuardSubscriptions();

    try {
      this.#viewerId = this.viewer.id;
    } catch {
      this.#viewerId = undefined;
    }
  }

  /**
   * Subscribes a filtered adapter to one container, or does nothing for an
   * adapter that cannot filter (the old global hook is installed by
   * {@link #subscribeToContainerEvents} instead).
   */
  #subscribeFilteredContainer(
    container: VirtualContainer,
    generation: number,
  ): boolean {
    if (!this.#filtersContainerEvents) {
      return true;
    }
    return this.#subscribeContainerEvents(container, generation);
  }

  /**
   * Subscribes close/itemChange for exactly one container through the beta
   * `{ containers: [container] }` filter. The handler remembers `container`, so
   * a delivered event belongs to it even when `event.container` is a different
   * wrapper object. Returns false when an event delivered during subscription
   * already closed the Window; partial subscriptions are always removed.
   */
  #subscribeContainerEvents(
    container: VirtualContainer,
    generation: number,
  ): boolean {
    const unsubscribers: Array<() => void> = [];
    const track = (unsubscribe: unknown, kind: string): void => {
      if (typeof unsubscribe !== "function") {
        throw new TypeError(
          `InvUI: adapter ${kind} subscription must return an unsubscribe function.`,
        );
      }
      unsubscribers.push(unsubscribe as () => void);
    };
    // A title/size regeneration subscribes while already `open`, not only
    // while `opening`.
    const active = (): boolean =>
      generation === this.#generation &&
      (this.#status === "opening" || this.#status === "open");

    try {
      if (this.#adapter.subscribeClose) {
        track(
          this.#adapter.subscribeClose(
            (event) => this.#onContainerClose(generation, event, container),
            container,
          ),
          "close",
        );
      }
      // A handler may have closed the Window while the first subscription was
      // being installed; do not install the second one then.
      if (!active()) {
        this.#disposeEventSubscriptions(unsubscribers);
        return false;
      }
      if (this.#adapter.subscribeItemChange) {
        track(
          this.#adapter.subscribeItemChange(
            (event) => this.#onContainerItemChange(generation, event, container),
            container,
          ),
          "itemChange",
        );
      }
    } catch (error) {
      this.#disposeEventSubscriptions(unsubscribers);
      throw error;
    }

    if (!active()) {
      this.#disposeEventSubscriptions(unsubscribers);
      return false;
    }
    // Group by container so a container the Window stops owning can release
    // exactly its own subscriptions (see #releaseContainerEventSubscriptions).
    const existing = this.#containerEventUnsubscribers.get(container);
    if (existing) {
      existing.push(...unsubscribers);
    } else {
      this.#containerEventUnsubscribers.set(container, unsubscribers);
    }
    return true;
  }

  /**
   * Subscribes to the adapter's optional close/itemChange hooks before opening.
   * Returns false when an event delivered during subscription already closed
   * the Window. Subscriptions made before a failure are always removed.
   *
   * Used only for adapters without `filtersContainerEvents`: the global hooks
   * cannot be limited to a container, so the handlers fall back to comparing
   * the event's `container` reference.
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

  /**
   * Show `container`, retrying only `PreviousScreenClosing` on later ticks.
   * `VirtualContainer.close()` returns before the client has finished closing
   * its screen, so an immediate regeneration or reopen can hit that documented
   * error even though nothing is wrong with the request. Any other open error
   * is real and propagates. Returns without opening when a close or reopen
   * takes the Window over while waiting.
   */
  async #openContainer(
    container: VirtualContainer,
    generation: number,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.#adapter.openContainer(container, this.viewer);
        return;
      } catch (error) {
        if (!isPreviousScreenClosingError(error)) {
          throw error;
        }
        if (
          generation !== this.#generation ||
          (this.#status !== "opening" && this.#status !== "open")
        ) {
          // A close or reopen owns the Window now. The error belongs to the
          // generation that is gone; throwing it would let `open()`'s failure
          // path tear down the screen the new generation is opening.
          return;
        }
        if (attempt >= PREVIOUS_SCREEN_CLOSING_RETRIES) {
          throw error;
        }
      }
      await waitOneTick();
      if (
        generation !== this.#generation ||
        (this.#status !== "opening" && this.#status !== "open")
      ) {
        return;
      }
    }
  }

  #unsubscribeFromContainerEvents(): void {
    const unsubscribers = this.#eventUnsubscribers;
    this.#eventUnsubscribers = [];
    const containerUnsubscribers = [
      ...this.#containerEventUnsubscribers.values(),
    ];
    this.#containerEventUnsubscribers.clear();
    this.#disposeEventSubscriptions(unsubscribers);
    for (const perContainer of containerUnsubscribers) {
      this.#disposeEventSubscriptions(perContainer);
    }
  }

  /**
   * Remove the close/itemChange subscriptions of one container the Window no
   * longer owns: a replacement discarded before it was shown, or the previous
   * screen of a finished regeneration. The handler ignores such a container's
   * events anyway (see #ownsContainer), so keeping the subscription would only
   * pin the container and its engine filter until the Window closes.
   *
   * A container that is still shown or still retiring is left alone: its
   * events still belong to this Window.
   */
  #releaseContainerEventSubscriptions(container: VirtualContainer): void {
    if (container === this.#container || container === this.#retiringContainer) {
      return;
    }
    const unsubscribers = this.#containerEventUnsubscribers.get(container);
    if (!unsubscribers) {
      return;
    }
    this.#containerEventUnsubscribers.delete(container);
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
    this.#pendingClickLayout = undefined;
    this.#layoutPresented = false;
    this.#layoutSettled = false;
    this.#layoutRenders.clear();
    this.#unrenderedSlots.clear();
    this.#containerSwapPending = false;
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
    // A tab nested in a GuiLink or another tab stores its selection under
    // `children`/`tabs` instead of `tab`, so those fields select a nested tab
    // too and must revalidate the branch they reveal.
    //
    // Opening only resolves: a tab change delivered while `open()` is still
    // running (for example another viewer of the same shared state switching
    // tabs) must not make this Window write its own smaller range back. That
    // would rewind the other viewer, exactly what `open()` promises not to do.
    // The state is revalidated again when a tab is selected while open.
    if (
      this.#status !== "opening" &&
      (changed.includes("tab") ||
        changed.includes("tabs") ||
        changed.includes("children"))
    ) {
      this.#revalidateStateRanges = true;
    }
    if (this.#status === "open") {
      this.#noteClickLayoutChange();
    }
    this.#scheduleSlotRefresh();
  }

  /**
   * Invalidate queued clicks as soon as the logical layout changes.
   * Clicks remain disabled until the replacement is rendered.
   */
  #noteClickLayoutChange(): void {
    const handle = this.#stateHandle;
    if (!handle || this.#renderingHalted) {
      return;
    }
    let layout: ResolvedGuiLayout;
    try {
      layout = this.upperGui.resolve(this.viewer, handle.get());
    } catch {
      // The scheduled refresh reports a resolve failure through the normal
      // error channel; a state notification must not throw from here.
      return;
    }
    const baseline = this.#pendingClickLayout ?? this.#layout;
    if (baseline === undefined || sameClickableLayout(baseline, layout)) {
      return;
    }
    this.#clickLayoutGeneration += 1;
    this.#pendingClickLayout =
      this.#layout !== undefined && sameClickableLayout(this.#layout, layout)
        ? undefined
        : layout;
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
    // Opening only resolves, exactly like a tab change (#onStateChanged): a
    // content change delivered while open() is still resolving must not make
    // this Window write its own smaller page/line clamp into the shared state
    // and rewind another viewer. A change seen while the Window is open is
    // still revalidated here and by the refresh it schedules.
    if (this.#status !== "opening") {
      this.#revalidateStateRanges = true;
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
    const container = this.#container;
    const generation = this.#generation;
    const renders: Array<Promise<void>> = [];
    for (const slot of slots) {
      if (slot < layout.slots.length) {
        renders.push(this.#renderSlot(slot));
      }
    }
    if (renders.length > 0) {
      // A GUI swap can apply a layout and queue only its changed slots; the
      // applied layout settles when those writes finish, unless a full pass for
      // it is still rendering and settles it later.
      const settle = (): void => this.#settleLayout(generation, layout, container);
      void Promise.all(renders).then(settle, settle);
    }
  }

  #applyLayout(layout: ResolvedGuiLayout): void {
    const previous = this.#layout;
    const pending = this.#pendingClickLayout;
    this.#pendingClickLayout = undefined;
    this.#layout = layout;
    this.#layoutSettled = false;
    // Keep #unrenderedSlots: applying a layout does not re-write a slot the diff
    // may skip (an unchanged state-independent element), so clearing its marker
    // here would offer the stale display as this layout's button. A successful
    // write clears the slot in #applySlotStack.
    // The applied layout is not on screen until the pass that follows writes
    // it; see #settleLayout. Input fails closed in the gap.
    this.#layoutPresented = false;
    // A page/line/tab change or a different slot element mapping is a new
    // clickable layout: queued clicks targeting the previous one must
    // not run against this one. Content-only re-renders that keep every slot
    // element stay valid.
    //
    // A synchronous state-change listener may already have advanced the
    // generation for exactly this layout (`pending`); advancing again would
    // make a queued click started after this render stale for no layout change.
    // A pending layout that is *not* the one being applied is superseded, so it
    // must still invalidate its generation. Clearing `pending` here is what
    // makes the new layout clickable (see `#inputLayout`).
    if (
      pending !== undefined
        ? !sameClickableLayout(pending, layout)
        : previous !== undefined && !sameClickableLayout(previous, layout)
    ) {
      // Advance the click generation before invalidating the queue: a line
      // minted for the previous layout must fail even if it is delivered only
      // after this change (the click's layout check cannot catch that).
      this.#clickLayoutGeneration += 1;
    }
    // Move element subscriptions as soon as the new layout exists. Waiting for
    // async renders would let a queued click hit the previous slot mapping and
    // be lost for the slot's new position (design 11.4).
    this.#subscribeToUpdates();
  }

  /** Record one running full-layout pass for `layout` (see `#layoutRenders`). */
  #beginLayoutRender(layout: ResolvedGuiLayout): void {
    this.#layoutRenders.set(layout, (this.#layoutRenders.get(layout) ?? 0) + 1);
  }

  #endLayoutRender(layout: ResolvedGuiLayout): void {
    const remaining = (this.#layoutRenders.get(layout) ?? 0) - 1;
    if (remaining > 0) {
      this.#layoutRenders.set(layout, remaining);
    } else {
      this.#layoutRenders.delete(layout);
    }
  }

  /**
   * The applied layout is fully on screen: every pass that renders it settled
   * (or the changed-slot batch that applied it finished), it is still the
   * applied layout on the current container and generation, and no newer state
   * change is waiting for its own render.
   *
   * A pass that lost its generation, container, or layout to a newer one, or
   * that rendered while a regeneration still swaps the screen, must not open
   * the input gate for a screen that is not shown. A notification flush that
   * wrote one slot cannot settle the layout while a full pass is still
   * rendering the rest; that pass settles it. `#presentLayout` then opens the
   * gate once the screen is the shown one.
   *
   * A slot whose provider fails keeps its previous display (design 14.2) but
   * still settles: a provider that never settles keeps the gate closed until it
   * does, which is the fail-closed side of design 11.4 rather than a timeout.
   */
  #settleLayout(
    generation: number,
    layout: ResolvedGuiLayout | undefined,
    container: VirtualContainer | undefined,
  ): void {
    if (
      layout === undefined ||
      container === undefined ||
      generation !== this.#generation ||
      this.#renderingHalted ||
      (this.#status !== "opening" && this.#status !== "open") ||
      this.#container !== container ||
      this.#layout !== layout ||
      this.#pendingClickLayout !== undefined ||
      this.#layoutRenders.has(layout)
    ) {
      return;
    }
    this.#layoutSettled = true;
    this.#presentLayout();
  }

  /**
   * Open the input gate when the settled layout is on screen. A container
   * regeneration keeps it closed from the swap until the replacement is opened,
   * so the old screen fails closed even after its render settled.
   */
  #presentLayout(): void {
    if (
      !this.#layoutSettled ||
      this.#layoutPresented ||
      this.#containerSwapPending ||
      this.#renderingHalted ||
      (this.#status !== "opening" && this.#status !== "open") ||
      this.#pendingClickLayout !== undefined
    ) {
      return;
    }
    this.#layoutPresented = true;
  }

  async #renderAll(generation: number): Promise<void> {
    const layout = this.#layout;
    const container = this.#container;
    if (!layout || !container || this.#renderingHalted) {
      return;
    }
    // A narrower Structure reuses the same container: the columns beyond its
    // width are no longer addressed, so slots a wider layout wrote there must
    // be cleared instead of left visible. A failed clear leaves the old width
    // recorded, so the next full pass (or the diff that sees it) retries the
    // columns instead of declaring them clean.
    if (
      this.#renderedWidth === undefined ||
      this.#renderedWidth <= layout.width ||
      this.#clearUnmappedColumns(layout)
    ) {
      this.#renderedWidth = layout.width;
    }
    // A new batch invalidates every result started before it.
    const epoch = ++this.#renderEpoch;
    this.#beginLayoutRender(layout);
    const renders: Array<Promise<void>> = [];
    // #renderSlot starts its provider synchronously, so every provider is
    // invoked before the first await: one slow slot must not delay the others.
    for (let slot = 0; slot < layout.slots.length; slot += 1) {
      if (generation !== this.#generation || !this.#container) {
        break;
      }
      renders.push(this.#renderSlot(slot, epoch));
    }
    try {
      await Promise.all(renders);
    } finally {
      // A rejected pass still settles the update: keep the window usable
      // instead of leaving input closed until some later pass happens.
      this.#endLayoutRender(layout);
      this.#settleLayout(generation, layout, container);
    }
  }

  /**
   * Clear the physical columns a wider Structure previously wrote but the
   * current layout no longer addresses. `container.size` covers `height` full
   * nine-column rows, so only the tail of each row can be stale (a height
   * change creates a new container instead). Returns false when a clear threw,
   * so `#renderAll` keeps the wider width recorded and a later pass retries;
   * slots that were cleared are marked empty, so a retry skips them.
   */
  #clearUnmappedColumns(layout: ResolvedGuiLayout): boolean {
    const container = this.#container;
    const cache = this.#writeCache;
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
          // The layout has no logical slot for this index, so the reported
          // slot is the physical one.
          container.setItem(physicalSlot, undefined);
        } catch (error) {
          this.#report(error, "setItem", physicalSlot);
          cleared = false;
          continue;
        }
        cache.markWritten(physicalSlot, undefined);
      }
    }
    return cleared;
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
        // rendered and never write the link (design 11.4). A state change the
        // read itself triggers does not invalidate the snapshot either: see
        // #applySlotStack.
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
      // reported only while the slot is current (the old async read path). A
      // state change it caused does not replace the slot and the newer pass
      // skips state-independent links, so the failure would otherwise be
      // swallowed with no pass left to report it (design 14.1).
      const canBeStale = awaited || isInventoryLinkElement(element);
      const isCurrent =
        this.#isCurrentSlot(generation, epoch, slot, element, token) ||
        (isInventoryLinkElement(element) &&
          this.#isCurrentSlotIgnoringEpoch(generation, slot, element, token));
      if (!canBeStale || isCurrent) {
        // The slot keeps its previous display instead of this layout's item, so
        // input must not target it until a later write succeeds. Only a failure
        // that still owns the slot leaves that stale display: one that lost it
        // to a newer pass is superseded by that pass, and marking it here would
        // disable the slot the newer render already wrote.
        if (isCurrent) {
          this.#unrenderedSlots.add(slot);
        }
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
    return (
      epoch === this.#renderEpoch &&
      this.#isCurrentSlotIgnoringEpoch(generation, slot, element, token)
    );
  }

  /**
   * #isCurrentSlot without the render epoch. An InventoryLink snapshot is
   * independent of Window state, so a state change during its synchronous read
   * does not make the result stale; only a close/reopen, a layout or element
   * change, a newer render for the slot, or a render halt does.
   */
  #isCurrentSlotIgnoringEpoch(
    generation: number,
    slot: number,
    element: SlotElement | null | undefined,
    token: number,
  ): boolean {
    const layout = this.#layout;
    return (
      !this.#renderingHalted &&
      generation === this.#generation &&
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
    if (
      !this.#isCurrentSlot(generation, epoch, slot, element, token) &&
      !(
        isInventoryLinkElement(element) &&
        this.#isCurrentSlotIgnoringEpoch(generation, slot, element, token)
      )
    ) {
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
      // The container is already proven empty here, which is what the layout
      // asks for: the slot is displayed.
      this.#unrenderedSlots.delete(slot);
      return;
    }
    try {
      container.setItem(physicalSlot, stack);
    } catch (error) {
      // Remember the failure so a slot-skipping diff still re-renders this
      // slot; otherwise the failed write's stale display would persist. The
      // slot still shows the previous item, so input must not target it.
      cache.markFailed(physicalSlot);
      this.#unrenderedSlots.add(slot);
      this.#report(error, "setItem", slot);
      return;
    }
    // Record only after the write returned: a throwing setItem stays
    // unrecorded, so the next pass retries it instead of skipping it.
    cache.markWritten(physicalSlot, stack);
    this.#unrenderedSlots.delete(slot);
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
    const generation = this.#generation;
    const layout = this.#layout;
    const previous = this.#elementSubscriptions;
    const next = new Map<number, { element: SlotElement; unsubscribe: () => void }>();
    // A report from this pass may run a handler that closes and reopens: the
    // subscriptions made for the old layout belong to the generation that is
    // gone. Release them instead of replacing the reopened generation's own
    // subscriptions with a stale map.
    const abandon = (): void => {
      for (const { unsubscribe } of next.values()) {
        try {
          unsubscribe();
        } catch {
          // The generation is gone; its failure is not the reopen's to report.
        }
      }
    };
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
        if (generation !== this.#generation) {
          abandon();
          return;
        }
      }
    }
    // Whatever remains refers to an element that is no longer in that slot.
    for (const { unsubscribe } of previous.values()) {
      try {
        unsubscribe();
      } catch (error) {
        this.#report(error, "unsubscribe");
        if (generation !== this.#generation) {
          abandon();
          return;
        }
      }
    }
    if (generation !== this.#generation) {
      abandon();
      return;
    }
    this.#elementSubscriptions = next;
  }

  /**
   * `restricted` is the shutdown path: adapter unsubscribers are dropped, not
   * called, because they run `unsubscribe()` on game signals, which restricted
   * execution forbids. Everything else is local and released either way.
   */
  #teardown(restricted = false): void {
    // Drop the Window from lifecycle handling first: a close
    // handler may reopen it, and the reopened generation must be registered
    // afresh (with its own viewer id) instead of inheriting this teardown.
    lifecycleWindows.delete(this);
    itemGuardWindows.delete(this);
    this.#itemGuard.reset();

    // Detach every handle before calling it. An adapter or element unsubscribe
    // may throw, and its error handler can close and reopen the Window: the
    // reopened generation then installs its own state/GUI/element subscriptions
    // while this teardown is still releasing the old ones. Clearing the fields
    // first keeps the reentrant generation out of this teardown entirely.
    const eventUnsubscribers = restricted ? [] : this.#eventUnsubscribers;
    this.#eventUnsubscribers = [];
    const containerEventUnsubscribers = restricted
      ? []
      : [...this.#containerEventUnsubscribers.values()];
    this.#containerEventUnsubscribers.clear();
    const stateSubscription = this.#stateSubscription;
    this.#stateSubscription = undefined;
    const guiSubscription = this.#guiSubscription;
    this.#guiSubscription = undefined;
    const elementSubscriptions = [...this.#elementSubscriptions.values()];
    this.#elementSubscriptions = new Map();
    const stateHandle = this.#stateHandle;
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

    this.#disposeEventSubscriptions(eventUnsubscribers);
    for (const perContainer of containerEventUnsubscribers) {
      this.#disposeEventSubscriptions(perContainer);
    }
    stateSubscription?.();
    guiSubscription?.();
    for (const { unsubscribe } of elementSubscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        // A broken unsubscribe must not keep the Window open; see the report
        // hazard above: the fields are already detached, so a reopen survives.
        this.#report(error, "unsubscribe");
      }
    }
    stateHandle?.release();
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
        // Keep the original error too: the handler failed before handling it.
        console.error("InvUI: Window error handler failed.", handlerError, error);
      }
      return;
    }
    console.error(`InvUI: Window ${this.id} ${operation} failed.`, error);
  }
}
