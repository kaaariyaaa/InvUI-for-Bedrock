/**
 * Minimal `world.beforeEvents.chatSend` -> `Window.handleClick()` bridge for
 * the design 10.4 notification:
 *
 * ```text
 * !invui:<session-id>:<slot-index>:<sequence>
 * ```
 *
 * This is an internal module (not exported from `src/index.ts`) and is not a
 * confirmed feature. Design 10.4 does not know yet whether `button.send` works
 * on the chest screen or whether a JSON UI payload can be produced at all.
 * **This module generates no UI data and no JSON payload.** It only consumes a
 * chat string that something else already sent; nothing here guarantees the
 * JSON UI side actually emits one.
 *
 * `Window` wires this automatically (`src/window.ts`): one global subscription,
 * a registry of open Windows, and an `invalidate()` call on close and on every
 * page/line/tab change. When the game API or a test double does not provide
 * `world.beforeEvents.chatSend` (or `system.run`), Window skips the wiring
 * entirely; `connectChatSendInput()` likewise returns a no-op instead of
 * subscribing. Chat input fails closed, screen handling keeps working.
 *
 * Spoofing: the string is player-typed, so `sender` is only "the Player who
 * typed this chat line", not proof that the click came from the rendered
 * button. Every field of the notification except the sender id is attacker
 * controlled, and typing a matching line is always possible. Consistency
 * checks here are not authentication.
 *
 * `beforeEvents.chatSend` runs with restricted execution (read-only world), so
 * the handler does only two things synchronously: read `message` / `sender.id`
 * and set `cancel`. The actual lookup and `handleClick()` run in
 * `system.run()`, one notification at a time.
 *
 * Layering: parsing, snapshot validation, sequence policy, rate limit, and the
 * serialized queue live in `./input.ts` (`createInputAcceptor`). This module
 * owns only the game-event wiring, the per-sender Window lookup, and the
 * Window open-cycle generation counter.
 *
 * Defaults: the rate limit is enabled with `DEFAULT_MIN_INTERVAL_MS` and a
 * `Date.now()` clock, because a disabled limit lets one player flood clicks.
 * The session id is the Window's per-open `_inputSessionId` when present, not
 * `Window.id`: `window-N` is reused after a script reload, so a delayed
 * notification from an earlier open could otherwise match a new screen. This
 * is still consistency checking, not authentication.
 *
 * Generation gap: `Window` does not expose its private layout generation, so
 * this bridge's counter knows only open cycles it observed or was told about.
 * `Window.handleClick()` re-validates slot, page/tab/line, element identity,
 * and its own generation when the queued click actually runs, which covers
 * page changes it can see. The automatic Window wiring also calls
 * `invalidate(window)` on close and on every page/line/tab change, so the
 * bridge's own queue is dropped there too.
 */

import {
  createInputAcceptor,
  parseInputNotification,
} from "./input.js";
import type {
  InputAcceptor,
  InputAcceptorRejectionReason,
  InputAcceptorSnapshot,
  InputNotification,
  InputSlotMode,
} from "./input.js";

/**
 * Design 10.6 caps the chest screen at 54 slots and `input.ts` rejects slot
 * indexes above 53. Used only when the caller supplies no `slotModes` probe:
 * the real mode check is then `Window.handleClick()`, which re-validates the
 * slot twice (enqueue and execution).
 */
const ALL_BUTTON: readonly InputSlotMode[] = Object.freeze(
  Array.from({ length: 54 }, () => "button" as const),
);

/**
 * Default minimum gap between accepted notifications (design 10.5 only says
 * repeats must be limited). 100 ms still allows fast human clicking while
 * bounding a flood; callers can raise it or pass 0 to disable.
 *
 * ponytail: one fixed interval, no token bucket. Replace it if legitimate
 * automated input ever needs a short burst above 10 notifications per second.
 */
const DEFAULT_MIN_INTERVAL_MS = 100;

/**
 * Outcome of routing one click into a Window, reported by the Window itself.
 * `clicked` means a handler completed, `failed` means the click reached the
 * handler path but it threw, and `discarded` means the Window rejected the
 * click before any handler ran (closed, changed layout/page, stale slot, or a
 * failing re-resolve). The distinction is what keeps the sequence policy
 * correct: a discarded click may be retried, a failed one must not.
 */
export type ChatInputClickOutcome = "clicked" | "discarded" | "failed";

/** The shape of `Window` this bridge depends on. */
export interface ChatInputWindow {
  readonly id: string;
  /**
   * Per-open input session id. `Window` mints a new one on every successful
   * `open()`, so a delayed notification from a previous open (or a previous
   * script reload) fails the session check. When absent, the bridge falls back
   * to `id` for compatibility with caller-provided windows.
   */
  readonly _inputSessionId?: string;
  readonly viewer: { readonly id: string };
  readonly isOpen: boolean;
  /**
   * Routes a click and reports whether a handler was invoked. Callers that
   * only need success/failure use the public `Window.handleClick()` instead.
   */
  _inputClick(slot: number): Promise<ChatInputClickOutcome>;
  /**
   * Optional modes of the Window's current layout. The automatic Window wiring
   * supplies this; when it is missing or returns null/throws, no slot is
   * treated as a button (fail closed).
   */
  readonly _inputSlotModes?: () => readonly InputSlotMode[] | null;
}

export interface ChatInputRejection {
  readonly senderId: string;
  readonly message: string;
  readonly reason: InputAcceptorRejectionReason;
}

export interface ChatInputBridgeOptions {
  /**
   * Live Window candidates. Each dispatch picks the last open Window whose
   * viewer id equals the chat sender id (one active Window per player in the
   * normal case). Reading this must not mutate anything.
   */
  readonly windows: () => Iterable<ChatInputWindow>;
  /**
   * Optional per-slot mode probe for the Window's *current* layout. When it
   * throws or returns a non-array, every slot is treated as non-button (fail
   * closed). When omitted, mode checking is delegated to `handleClick()`.
   */
  readonly slotModes?: (window: ChatInputWindow) => readonly InputSlotMode[];
  /** Caller clock in ms for the repeat limit; defaults to `Date.now()`. */
  readonly now?: () => number;
  /**
   * Minimum gap between accepted notifications. Defaults to
   * `DEFAULT_MIN_INTERVAL_MS` (100); 0 disables the interval but keeps the
   * clock checks.
   */
  readonly minIntervalMs?: number;
  /** Candidates waiting to start; forwarded to `createInputAcceptor`. */
  readonly maxQueue?: number;
  /** Diagnostics only; never used for control flow. */
  readonly onRejected?: (rejection: ChatInputRejection) => void;
}

export type ChatInputDispatchResult =
  | {
      readonly ok: true;
      readonly notification: InputNotification;
      /**
       * `false` means the notification passed every bridge check and was routed
       * to the Window, but no handler completed: the Window either discarded it
       * before invoking one (closed/changed slot/layout) or a handler threw. A
       * discarded click's sequence stays retryable; a failed routed click
       * consumes it so the handler cannot run twice.
       */
      readonly clicked: boolean;
    }
  | { readonly ok: false; readonly reason: InputAcceptorRejectionReason };

export interface ChatInputBridge {
  /**
   * Validates and (if still current) routes one notification. Must be called
   * outside the read-only before-event, normally from `system.run()`.
   * Serialized per Window: a second call for the same Window waits.
   * Never rejects.
   */
  dispatch(message: string, senderId: string): Promise<ChatInputDispatchResult>;
  /**
   * Marks the Window's clickable state as superseded: queued candidates are
   * rejected as `stale-generation`. Call on close (before a possible reopen)
   * and on a page/layout change when the integration can observe one. On a
   * close this also makes the next open reset `lastSequence`.
   */
  invalidate(window: ChatInputWindow): void;
}

interface WindowBridgeState {
  /**
   * Open-cycle counter: bumped when a new open cycle starts, not on page/tab
   * invalidation. A click in flight across a close/reopen must not write into
   * the new cycle's sequence state.
   */
  cycle: number;
  generation: number;
  lastSeenOpen: boolean;
  /**
   * Session id of the last snapshot. A sequence belongs to one open session,
   * so a different id is a new session even when `lastSeenOpen` was already
   * set (a layout invalidation after a reopen re-arms `lastSeenOpen` before
   * the first notification of the new open cycle is observed).
   */
  lastSessionId: string | undefined;
  lastSequence: number | undefined;
  readonly clicks: WeakMap<InputNotification, boolean>;
  readonly acceptor: InputAcceptor;
}

function readViewerId(window: ChatInputWindow): string | null {
  try {
    const id = window.viewer?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function readIsOpen(window: ChatInputWindow): boolean {
  try {
    return window.isOpen === true;
  } catch {
    return false;
  }
}

function readSessionId(window: ChatInputWindow): string | null {
  try {
    const sessionId = window._inputSessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return sessionId;
    }
    // Compatibility: a caller-provided window that has no per-open id yet.
    return typeof window.id === "string" ? window.id : null;
  } catch {
    return null;
  }
}

function readSlotModes(
  window: ChatInputWindow,
  probe: ChatInputBridgeOptions["slotModes"],
): readonly InputSlotMode[] {
  if (!probe) {
    return ALL_BUTTON;
  }
  try {
    const modes = probe(window);
    // Fail closed when the probe itself is unusable: no slot is a button.
    return Array.isArray(modes) ? modes : [];
  } catch {
    return [];
  }
}

/**
 * Creates the bridge. Invalid construction options throw synchronously;
 * failures to read a Window/snapshot at runtime fail closed and are reported
 * through the returned result or `onRejected`, never thrown to the caller.
 */
export function createChatInputBridge(options: ChatInputBridgeOptions): ChatInputBridge {
  if (!options || typeof options.windows !== "function") {
    throw new TypeError("InvUI: chat input bridge requires windows().");
  }
  if (options.slotModes !== undefined && typeof options.slotModes !== "function") {
    throw new TypeError("InvUI: slotModes must be a function.");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("InvUI: now must be a function.");
  }
  if (options.onRejected !== undefined && typeof options.onRejected !== "function") {
    throw new TypeError("InvUI: onRejected must be a function.");
  }
  if (
    options.maxQueue !== undefined &&
    (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 1)
  ) {
    throw new RangeError("InvUI: maxQueue must be a positive safe integer.");
  }
  if (
    options.minIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.minIntervalMs) || options.minIntervalMs < 0)
  ) {
    throw new RangeError("InvUI: minIntervalMs must be a non-negative safe integer.");
  }
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const states = new WeakMap<ChatInputWindow, WindowBridgeState>();

  function reject(senderId: string, message: string, reason: InputAcceptorRejectionReason): ChatInputDispatchResult {
    try {
      options.onRejected?.({ senderId, message, reason });
    } catch {
      // Diagnostics must not change control flow.
    }
    return { ok: false, reason };
  }

  function findWindow(senderId: string): ChatInputWindow | null {
    let found: ChatInputWindow | null = null;
    try {
      for (const window of options.windows()) {
        if (!window || readViewerId(window) !== senderId) {
          continue;
        }
        if (readIsOpen(window)) {
          found = window;
        }
      }
    } catch {
      return null;
    }
    return found;
  }

  function snapshot(window: ChatInputWindow, state: WindowBridgeState): InputAcceptorSnapshot | null {
    const ownerId = readViewerId(window);
    const sessionId = readSessionId(window);
    if (ownerId === null || sessionId === null) {
      return null;
    }

    if (!readIsOpen(window)) {
      state.lastSeenOpen = false;
      return { open: false, ownerId, sessionId, slotModes: [], generation: state.generation };
    }

    if (!state.lastSeenOpen || state.lastSessionId !== sessionId) {
      // A new open cycle is a new input session: old sequences cannot be replayed.
      state.lastSeenOpen = true;
      state.lastSessionId = sessionId;
      state.cycle += 1;
      state.generation += 1;
      state.lastSequence = undefined;
    }

    const slotModes = readSlotModes(window, options.slotModes);
    return {
      open: true,
      ownerId,
      sessionId,
      slotModes,
      generation: state.generation,
      ...(state.lastSequence === undefined ? {} : { lastSequence: state.lastSequence }),
    };
  }

  function stateOf(window: ChatInputWindow): WindowBridgeState {
    const existing = states.get(window);
    if (existing) {
      return existing;
    }

    const state = {
      cycle: 0,
      generation: 0,
      lastSeenOpen: false,
      lastSessionId: undefined as string | undefined,
      lastSequence: undefined as number | undefined,
      clicks: new WeakMap<InputNotification, boolean>(),
      acceptor: undefined as unknown as InputAcceptor,
    };

    const acceptor = createInputAcceptor({
      snapshot: () => snapshot(window, state),
      now,
      policy: { minIntervalMs },
      ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
      execute: async (notification) => {
        // Capture the open cycle: a close/reopen while this click is in flight
        // starts a new session, and this click must not overwrite its
        // sequence state when it finally completes.
        const cycle = state.cycle;
        const outcome = await window._inputClick(notification.slot);
        state.clicks.set(notification, outcome === "clicked");
        if (state.cycle !== cycle) {
          return;
        }
        // A click that reached a handler consumes the sequence even when the
        // handler failed: replaying the same notification could repeat its
        // side effects. A discarded click never ran a handler, so its sequence
        // stays retryable.
        if (outcome !== "discarded") {
          state.lastSequence = notification.sequence;
        }
      },
    });
    state.acceptor = acceptor;
    states.set(window, state);
    return state;
  }

  return {
    async dispatch(message: string, senderId: string): Promise<ChatInputDispatchResult> {
      if (typeof senderId !== "string" || senderId.length === 0) {
        return reject(senderId, message, "snapshot-unavailable");
      }
      const window = findWindow(senderId);
      if (window === null) {
        // No open Window for this sender: the design 10.5 owner check failed.
        return reject(senderId, message, "snapshot-unavailable");
      }
      const state = (() => {
        try {
          return stateOf(window);
        } catch {
          return null;
        }
      })();
      if (state === null) {
        return reject(senderId, message, "snapshot-unavailable");
      }
      let result;
      try {
        result = await state.acceptor.accept(message, senderId);
      } catch {
        return reject(senderId, message, "snapshot-unavailable");
      }
      if (!result.ok) {
        return reject(senderId, message, result.reason);
      }
      return {
        ok: true,
        notification: result.notification,
        clicked: state.clicks.get(result.notification) === true,
      };
    },

    invalidate(window: ChatInputWindow): void {
      const state = states.get(window);
      if (!state) {
        return;
      }
      state.generation += 1;
      // If this invalidation belongs to a close, let the next open cycle run
      // its sequence reset as well (without it, a close+reopen between two
      // snapshots would be invisible).
      state.lastSeenOpen = readIsOpen(window);
    },
  };
}

/** Structural subset of `world.beforeEvents.chatSend` used here. */
export interface ChatSendBeforeEventLike {
  readonly message: string;
  readonly sender: { readonly id: string };
  cancel: boolean;
}

export interface BeforeChatSendSignalLike {
  subscribe(callback: (event: ChatSendBeforeEventLike) => void): unknown;
  unsubscribe?(callback: (event: ChatSendBeforeEventLike) => void): void;
}

export interface ChatInputEventSource {
  readonly world: {
    readonly beforeEvents: { readonly chatSend: BeforeChatSendSignalLike };
  };
  /** `system.run`; the only place where a click may be executed. */
  readonly system: { run(callback: () => void): unknown };
}

/**
 * Subscribes the bridge to the real before-event.
 *
 * Feature-detects the signal: when `beforeEvents.chatSend` is absent (an older
 * `@minecraft/server`, a test double, or a world where the event is disabled),
 * this returns a no-op unsubscribe and never subscribes. That is the fail-closed
 * path: screen handling keeps working and no chat line is touched.
 *
 * Only a *well-formed* `!invui:<session>:<slot>:<sequence>` line is cancelled;
 * ordinary chat and malformed reserved-prefix lines pass through. The sender
 * id, message, and parseable status are read synchronously (restricted
 * execution), then the click is scheduled through `system.run()`. No Window is
 * touched and no click executes inside the before-event.
 *
 * Returns an unsubscribe function. `onError` receives failures to schedule
 * (a failure inside `dispatch` is already reported as a rejection result).
 */
export function connectChatSendInput(
  source: ChatInputEventSource,
  bridge: ChatInputBridge,
  onError?: (error: unknown) => void,
): () => void {
  if (!source || !source.world || !source.system || typeof source.system.run !== "function") {
    throw new TypeError("InvUI: chat input bridge requires world and system.run.");
  }
  let signal: BeforeChatSendSignalLike | undefined;
  try {
    signal = source.world.beforeEvents?.chatSend;
  } catch {
    signal = undefined;
  }
  if (!signal || typeof signal.subscribe !== "function") {
    // Fail closed: without the before-event there is no safe way to cancel or
    // observe notifications, so install nothing.
    return () => {};
  }

  const handler = (event: ChatSendBeforeEventLike): void => {
    let message: unknown;
    let senderId: unknown;
    try {
      message = event.message;
      senderId = event.sender?.id;
    } catch {
      return;
    }
    if (typeof message !== "string" || parseInputNotification(message) === null) {
      return;
    }
    // The notification format is reserved: hide even spoofed/unknown senders
    // from normal chat. The prefix is documented, so this is not a secret.
    try {
      event.cancel = true;
    } catch {
      // Keep going: failing to hide the line must not execute anything early.
    }
    if (typeof senderId !== "string" || senderId.length === 0) {
      return;
    }
    const scheduledMessage = message;
    const scheduledSenderId = senderId;
    try {
      source.system.run(() => {
        void bridge.dispatch(scheduledMessage, scheduledSenderId).catch((error) => {
          onError?.(error);
        });
      });
    } catch (error) {
      onError?.(error);
    }
  };

  const returned: unknown = signal.subscribe(handler);
  return () => {
    try {
      if (typeof signal.unsubscribe === "function") {
        signal.unsubscribe(handler);
      } else if (typeof returned === "function") {
        returned();
      }
    } catch {
      // Unsubscribing is best effort; a closed world needs no cleanup.
    }
  };
}
