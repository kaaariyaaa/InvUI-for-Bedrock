/** Shared lifecycle subscriptions for open Windows. */
import { world } from "@minecraft/server";
import * as server from "@minecraft/server";
import type { Window } from "./window.js";

/**
 * Windows that are `opening` or `open` and must be closed when their viewer's
 * session ends (leave, death, dimension change, spectator) or the world shuts
 * down, one set shared by the module so each game event is subscribed once for
 * every Window. A Window is added when `open()` starts and removed by
 * `#teardown()`.
 */
export const lifecycleWindows = new Set<Window>();

export interface AfterEventSubscriptionState {
  subscribed: boolean;
  /** Latches the feature-detection failure, for this optional event. */
  unavailable: boolean;
}

export type LifecycleEventName =
  | "playerLeave"
  | "entityDie"
  | "playerDimensionChange"
  | "playerGameModeChange"
  | "playerInventoryItemChange"
  | "playerCursorItemGrab"
  | "playerCursorItemRelease"
  | "entityItemDrop";

export function afterEventState(): AfterEventSubscriptionState {
  return { subscribed: false, unavailable: false };
}

export const playerLeaveState = afterEventState();
export const entityDieState = afterEventState();
export const playerDimensionChangeState = afterEventState();
export const playerGameModeChangeState = afterEventState();
export const shutdownState = afterEventState();

/**
 * Set by the first shutdown event and never cleared: the session is ending, so
 * every later `open()` is suppressed and every later close skips adapter/signal
 * calls that restricted execution forbids.
 */
export let shutdownInProgress = false;

/** Read a property of an event without letting an invalid entity throw. */
export function readProperty(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown> | undefined)?.[key];
  } catch {
    return undefined;
  }
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read `value.id`: only an id is used, so a departed entity cannot invalidate it. */
export function readId(value: unknown): string | undefined {
  return readString(readProperty(value, "id"));
}

/**
 * Run `close` for every tracked Window. The set is snapshotted because a close
 * handler may open or close other Windows while this loop runs; each Window
 * re-checks its own status, generation, and viewer id.
 */
export function forEachLifecycleWindow(
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
export function ensureAfterEventSubscription(
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
      `InvUI: ${name} subscription could not be installed; ${purpose}.`,
      error,
    );
    state.unavailable = true;
  }
}

/**
 * `playerLeave` closes the Window of the viewer that left. The event carries
 * only a player id, captured when the open cycle registers.
 */
export function ensurePlayerLeaveSubscription(): void {
  ensureAfterEventSubscription(
    playerLeaveState,
    "playerLeave",
    "Windows will not close automatically when a player leaves",
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
export function ensureEntityDieSubscription(): void {
  ensureAfterEventSubscription(
    entityDieState,
    "entityDie",
    "Windows will not close automatically when a player dies",
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
export function ensurePlayerDimensionChangeSubscription(): void {
  ensureAfterEventSubscription(
    playerDimensionChangeState,
    "playerDimensionChange",
    "Windows will not close automatically when a player changes dimension",
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
export function ensurePlayerGameModeChangeSubscription(): void {
  ensureAfterEventSubscription(
    playerGameModeChangeState,
    "playerGameModeChange",
    "Windows will not close automatically when a player starts spectating",
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
export function ensureShutdownSubscription(): void {
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
