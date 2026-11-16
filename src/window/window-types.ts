/** Window lifecycle contracts and error types. */
import type { Player, VirtualContainer, ItemStack } from "@minecraft/server";

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
  /**
   * The item in the slot before the player's change, if any. The Window
   * restores this stack into `slot` during the reconciliation pass.
   */
  readonly beforeItemStack?: ItemStack;
  /** The item in the slot after the player's change, if any. */
  readonly itemStack?: ItemStack;
}

export type WindowContainerCloseHandler = (event: WindowContainerCloseEvent) => void;
export type WindowContainerItemChangeHandler = (
  event: WindowContainerItemChangeEvent,
) => void;

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
 * changed the Window's container through the screen and the change could not be
 * undone (the container write threw). Rendering is stopped and the Window
 * closes, because a later render would write the display item back over an
 * unknown slot and could duplicate it.
 *
 * A change that is undone is not reported: taking an item through the screen is
 * an expected player action, not an error.
 */
export class WindowItemChangeDangerError extends Error {
  readonly code = "INVUI_CONTAINER_ITEM_CHANGE";
  readonly slot: number;

  constructor(slot: number, options?: ErrorOptions) {
    super(
      `InvUI: slot ${slot} of the Window container was changed through the screen and could not be restored. Rendering is stopped and the Window is closing.`,
      options,
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
