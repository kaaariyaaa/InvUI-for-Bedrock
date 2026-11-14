/**
 * Parser for the tentative chat notification in design 10.4:
 *
 * ```text
 * !invui:<session-id>:<layout-generation>:<slot-index>:<sequence>
 * ```
 *
 * The layout generation binds the notification to the clickable layout that
 * was on screen when the button sent it. Design 10.5 requires that a
 * notification from a previous page/generation is not processed; without the
 * field, a line sent before a page change but delivered after it could name a
 * button that happens to exist at the same slot on the new page.
 *
 * This is a pure module. It does not import the Minecraft API, subscribe to
 * `world.beforeEvents.chatSend`, hold a WindowRegistry, or call
 * `Window.handleClick()`. A parsed message is **not** authenticated: the sender
 * can type the same string by hand, so `validateInputNotification()` also
 * compares it against a caller-provided snapshot of the open Window (design
 * 10.5). That snapshot is trusted input; only the chat string is untrusted.
 *
 * Design 10.4 also says the format is not final until chat sending from the
 * chest screen is verified in the real game. This module therefore has no
 * game-event integration.
 *
 * Design gaps: 10.4 defines the conceptual field order but not the session-id
 * charset or length, whether `slot-index` starts at 0, the generation or
 * sequence types/range, or their ordering. The bounds below are defensive
 * parser policy, not confirmed protocol requirements; adjust them when the
 * format is finalized. 10.5 has no time-based freshness rule and 10.4 puts no
 * timestamp in the message, so "expired" can only mean "the Window is no
 * longer open"; it also defines no rate-limit parameters and no mapping from
 * layout elements to the `button`/`display`/`inventory` modes. See
 * `validateInputNotification` for what that leaves unchecked, and
 * `checkInputRateLimit` for the caller-injected half of the 10.5 repeat limit.
 *
 * The older three-field form `!invui:<session>:<slot>:<sequence>` is not
 * accepted. It cannot name a layout generation, so accepting it would keep the
 * page-change ambiguity this field exists to close. Lines in the old form are
 * treated as malformed and are not executed.
 */

export const INPUT_NOTIFICATION_PREFIX = "!invui:";

/** Conservative opaque-token bound; design does not specify a session-id format. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Canonical decimal with no sign, whitespace, or leading zeros, so one click
 * has exactly one valid encoding. Design 10.6 caps the chest screen at 54
 * slots, and `Window.handleClick()` accepts a non-negative logical slot.
 */
const SLOT_INDEX_PATTERN = /^(?:0|[1-9][0-9]?)$/;
const MAX_SLOT_INDEX = 53;

/** Canonical decimal, limited to values JavaScript can represent exactly. */
const NON_NEGATIVE_SAFE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/;

export interface InputNotification {
  readonly sessionId: string;
  /**
   * Clickable-layout generation of the Window when the notification was
   * minted. A notification from another page/layout is rejected rather than
   * applied to whatever button now occupies the same slot.
   */
  readonly layoutGeneration: number;
  readonly slot: number;
  readonly sequence: number;
}

/**
 * Returns the parsed notification, or `null` for anything that does not match
 * the design 10.4 shape. Never throws for a malformed chat message.
 */
export function parseInputNotification(message: unknown): InputNotification | null {
  if (typeof message !== "string" || !message.startsWith(INPUT_NOTIFICATION_PREFIX)) {
    return null;
  }

  const parts = message.slice(INPUT_NOTIFICATION_PREFIX.length).split(":");
  if (parts.length !== 4) {
    return null;
  }

  const [sessionId, generationText, slotText, sequenceText] = parts;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  if (!NON_NEGATIVE_SAFE_INTEGER_PATTERN.test(generationText)) {
    return null;
  }
  const layoutGeneration = Number(generationText);
  if (!Number.isSafeInteger(layoutGeneration)) {
    return null;
  }
  if (!SLOT_INDEX_PATTERN.test(slotText)) {
    return null;
  }
  const slot = Number(slotText);
  if (slot > MAX_SLOT_INDEX) {
    return null;
  }
  if (!NON_NEGATIVE_SAFE_INTEGER_PATTERN.test(sequenceText)) {
    return null;
  }
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) {
    return null;
  }

  return { sessionId, layoutGeneration, slot, sequence };
}

/** Slot modes named by design 10.1 / 12.3. This module never derives them. */
export type InputSlotMode = "button" | "display" | "inventory";

/**
 * Caller-sampled view of the Window that should own the notification. Every
 * field is server-side state from the open Window, never from the message.
 */
export interface InputWindowSnapshot {
  /** False once the Window started closing (design 12.3, 13.1). */
  readonly open: boolean;
  /** Player id of the Window's viewer (design 10.5). */
  readonly ownerId: string;
  /** Session id the Window currently displays (design 10.5). */
  readonly sessionId: string;
  /**
   * Generation of the Window's current clickable layout. Must advance when the
   * page/line/tab or slot-element mapping changes (design 10.5, 12.3). It is
   * the server-side value a notification's `layoutGeneration` is compared to.
   */
  readonly layoutGeneration: number;
  /**
   * Mode of each logical slot of the *current* layout (design 10.5, 12.3).
   * The layout-to-mode mapping is the caller's responsibility.
   */
  readonly slotModes: readonly InputSlotMode[];
  /**
   * Highest sequence already accepted for this session, or `undefined` before
   * the first one. The caller stores it and resets it with the session.
   */
  readonly lastSequence?: number;
}

export type InputRejectionReason =
  | "malformed"
  | "window-closed"
  | "sender-not-owner"
  | "session-mismatch"
  | "stale-layout-generation"
  | "slot-not-button"
  | "stale-sequence";

export type InputValidationResult =
  | { readonly ok: true; readonly notification: InputNotification }
  | { readonly ok: false; readonly reason: InputRejectionReason };

/**
 * Design 10.5 / 12.3 checks that can be decided from the message and a
 * caller-provided Window snapshot. Returns the parsed notification only when
 * every check passes; never throws and never mutates its arguments.
 *
 * A passing result still does **not** authenticate the click: the sender can
 * type a matching string, and this only says the string is consistent with the
 * Window state the caller passed. The caller must re-run this when the queued
 * click actually executes, read the snapshot from the live Window, and update
 * `lastSequence` from the returned notification.
 *
 * Not checked because the design does not define them:
 * - Time-based expiry (10.4 has no timestamp; liveness is the only deadline).
 * - Rate limiting (10.5 requires limiting repeats but gives no count or window;
 *   call `checkInputRateLimit` with a caller-injected clock and interval).
 * - Ownership of the chat sender vs. the player object (the caller supplies
 *   `senderId`; this module never reads a Player).
 *
 * A notification minted before a page change but delivered after it is rejected
 * when its `layoutGeneration` differs from the snapshot's, even if the same
 * slot is a button again on the new page.
 */
export function validateInputNotification(
  message: unknown,
  senderId: string,
  snapshot: InputWindowSnapshot,
): InputValidationResult {
  const notification = parseInputNotification(message);
  if (notification === null) {
    return { ok: false, reason: "malformed" };
  }
  if (!snapshot.open) {
    return { ok: false, reason: "window-closed" };
  }
  if (senderId !== snapshot.ownerId) {
    return { ok: false, reason: "sender-not-owner" };
  }
  if (notification.sessionId !== snapshot.sessionId) {
    return { ok: false, reason: "session-mismatch" };
  }
  if (notification.layoutGeneration !== snapshot.layoutGeneration) {
    return { ok: false, reason: "stale-layout-generation" };
  }
  if (snapshot.slotModes[notification.slot] !== "button") {
    return { ok: false, reason: "slot-not-button" };
  }
  // ponytail: monotonic-sequence policy, not a confirmed protocol rule. 10.4
  // does not say how `sequence` is minted; if the message turns out to carry a
  // constant value, remove this check instead of weakening it.
  if (snapshot.lastSequence !== undefined && notification.sequence <= snapshot.lastSequence) {
    return { ok: false, reason: "stale-sequence" };
  }
  return { ok: true, notification };
}

/**
 * Caller-owned state for `checkInputRateLimit`. The caller stores the returned
 * `lastAcceptedAtMs` only for accepted notifications and resets it with the
 * session, like `lastSequence`.
 */
export interface InputRateLimitState {
  /** Caller clock reading (ms) of the last accepted notification, if any. */
  readonly lastAcceptedAtMs?: number;
}

/**
 * Caller-injected rate-limit parameters; design 10.5 only says repeats must be
 * limited, so this module invents no default. `minIntervalMs: 0` disables the
 * interval but keeps the clock checks.
 */
export interface InputRateLimitPolicy {
  /** Minimum caller-clock gap (ms) between two accepted notifications. */
  readonly minIntervalMs: number;
}

export type InputRateLimitRejectionReason =
  | "invalid-input"
  | "clock-backwards"
  | "rate-limited";

export type InputRateLimitResult =
  | { readonly ok: true; readonly lastAcceptedAtMs: number }
  | { readonly ok: false; readonly reason: InputRateLimitRejectionReason };

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Design 10.5's "limit consecutive notification processing", reduced to the
 * smallest policy the design actually supports: at most one accepted
 * notification per caller-injected interval.
 *
 * Pure, and no game clock: `nowMs` and `policy` are explicit inputs so tests
 * and the eventual chat handler can supply the game's own tick/time source.
 * Fails closed rather than clamping: a non-integer, negative, or non-finite
 * `nowMs`/`lastAcceptedAtMs`/`minIntervalMs` rejects, and a `nowMs` earlier
 * than `lastAcceptedAtMs` (clock reset or rollback) rejects even when the
 * interval would otherwise pass. Rejected calls do not advance the state.
 *
 * This is a repeat limit, not authentication and not the design 10.5
 * generation/page check: a passing result says nothing about who sent the
 * message or which screen generation it belongs to. Callers still run
 * `validateInputNotification` and their own generation check, and should
 * update `lastAcceptedAtMs` from a passing result only after the click is
 * actually processed.
 */
export function checkInputRateLimit(
  state: InputRateLimitState,
  nowMs: number,
  policy: InputRateLimitPolicy,
): InputRateLimitResult {
  if (!isNonNegativeSafeInteger(nowMs) || !isNonNegativeSafeInteger(policy.minIntervalMs)) {
    return { ok: false, reason: "invalid-input" };
  }
  const last = state.lastAcceptedAtMs;
  if (last !== undefined && !isNonNegativeSafeInteger(last)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (last !== undefined && nowMs < last) {
    return { ok: false, reason: "clock-backwards" };
  }
  if (last !== undefined && nowMs - last < policy.minIntervalMs) {
    return { ok: false, reason: "rate-limited" };
  }
  return { ok: true, lastAcceptedAtMs: nowMs };
}

/**
 * Test-only input acceptor. It is a pure module object that the caller drives
 * explicitly: it never subscribes to `world.beforeEvents.chatSend`, never reads
 * a Player, and never opens/closes a Window. It is intentionally not exported
 * from `src/index.ts`; the public entry stays free of this bridge until chat
 * sending from the chest screen is verified in the real game (design 10.4).
 *
 * `accept()` queues a candidate click and resolves once that candidate is
 * either executed or rejected. Execution is serialized: `execute` runs at most
 * once at a time even when it is asynchronous, and a candidate is re-checked
 * against a *fresh* snapshot immediately before `execute`, not against the
 * snapshot observed when it was accepted.
 *
 * A passing result is still not authentication: every field except the
 * acceptor's generation is attacker-controlled or caller-asserted, so a
 * crafted matching chat line can pass. Treat it as consistency checking only.
 *
 * Design gaps left to the caller:
 * - The acceptor only knows the generation its caller's snapshot reports. The
 *   caller must bump it whenever the layout/page changes, and must advance
 *   `lastSequence` when the click is accepted (in `execute` or before it) so
 *   later candidates see the new sequence. The notification also carries its
 *   own `layoutGeneration`, which `validateInputNotification` compares to the
 *   fresh snapshot at execution time.
 * - No timestamp exists in the message, so the only expiry is the snapshot:
 *   `open: false` or a missing snapshot rejects.
 * - The rate-limit policy and the clock are caller-injected; see
 *   `checkInputRateLimit`.
 * - `execute` must not await a new `accept()` for the same acceptor. The queue
 *   is FIFO, so doing that deadlocks, the same rule as the state queue.
 */
export interface InputAcceptorSnapshot extends InputWindowSnapshot {
  /**
   * Caller-owned queue epoch. Must be a non-negative safe integer and must
   * increase when the Window's clickable layout is replaced or the caller
   * otherwise wants queued candidates dropped.
   */
  readonly generation: number;
}

export type InputAcceptorRejectionReason =
  | InputRejectionReason
  | InputRateLimitRejectionReason
  | "snapshot-unavailable"
  | "stale-generation"
  | "queue-full"
  | "executor-failed";

export type InputAcceptorResult =
  | { readonly ok: true; readonly notification: InputNotification }
  | { readonly ok: false; readonly reason: InputAcceptorRejectionReason };

export interface InputAcceptorOptions {
  /** Latest live snapshot, or `null` when no Window exists. Read at accept and again at execution. */
  readonly snapshot: () => InputAcceptorSnapshot | null;
  /** Caller clock in ms, sampled only when a candidate reaches execution. */
  readonly now: () => number;
  readonly policy: InputRateLimitPolicy;
  /** Called only after every execution-time check passes. */
  readonly execute: (notification: InputNotification) => void | Promise<void>;
  /**
   * Maximum number of candidates waiting to start. The running candidate is
   * not counted. Defaults to 32; a candidate beyond the bound is rejected.
   */
  readonly maxQueue?: number;
}

export interface InputAcceptor {
  /**
   * Queues one candidate. Never rejects; failures resolve with a reason.
   * Reading the snapshot here records the candidate's generation; if no valid
   * snapshot is available the call fails closed immediately.
   */
  accept(message: unknown, senderId: string): Promise<InputAcceptorResult>;
}

interface QueuedInput {
  readonly message: unknown;
  readonly senderId: string;
  readonly generation: number;
  readonly resolve: (result: InputAcceptorResult) => void;
}

/** Guards the caller-supplied snapshot so `validateInputNotification` cannot throw. */
function readAcceptorSnapshot(source: () => InputAcceptorSnapshot | null): InputAcceptorSnapshot | null {
  try {
    const value = source();
    if (value === null || typeof value !== "object") {
      return null;
    }
    if (
      typeof value.open !== "boolean" ||
      typeof value.ownerId !== "string" ||
      typeof value.sessionId !== "string" ||
      !Array.isArray(value.slotModes) ||
      !isNonNegativeSafeInteger(value.layoutGeneration) ||
      !isNonNegativeSafeInteger(value.generation) ||
      (value.lastSequence !== undefined && !isNonNegativeSafeInteger(value.lastSequence))
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function readAcceptorNow(source: () => number): number | null {
  try {
    const value = source();
    return isNonNegativeSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** Reads the caller-supplied policy once, at construction; invalid policy throws. */
function readAcceptorPolicy(source: () => unknown): InputRateLimitPolicy {
  try {
    const value = source();
    if (
      value !== null &&
      typeof value === "object" &&
      isNonNegativeSafeInteger((value as InputRateLimitPolicy).minIntervalMs)
    ) {
      return value as InputRateLimitPolicy;
    }
  } catch {
    // fall through: a throwing getter is an invalid policy
  }
  throw new RangeError("policy.minIntervalMs must be a non-negative safe integer");
}

/**
 * Creates the explicitly-driven, test-only acceptor described on
 * {@link InputAcceptorSnapshot}. Invalid construction options throw
 * synchronously; runtime failure to read the caller's snapshot/clock or to run
 * `execute` resolves as a rejection instead of throwing.
 */
export function createInputAcceptor(options: InputAcceptorOptions): InputAcceptor {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  const maxQueue = options.maxQueue ?? 32;
  if (!isNonNegativeSafeInteger(maxQueue) || maxQueue < 1) {
    throw new RangeError("maxQueue must be a positive safe integer");
  }
  const policy = readAcceptorPolicy(() => options.policy);

  let queue: QueuedInput[] = [];
  let running = false;
  let rateState: InputRateLimitState = {};

  async function settle(item: QueuedInput): Promise<InputAcceptorResult> {
    const latest = readAcceptorSnapshot(options.snapshot);
    if (latest === null) {
      return { ok: false, reason: "snapshot-unavailable" };
    }
    if (latest.generation !== item.generation) {
      return { ok: false, reason: "stale-generation" };
    }

    let validation: InputValidationResult;
    try {
      validation = validateInputNotification(item.message, item.senderId, latest);
    } catch {
      return { ok: false, reason: "snapshot-unavailable" };
    }
    if (!validation.ok) {
      return validation;
    }

    const nowMs = readAcceptorNow(options.now);
    if (nowMs === null) {
      return { ok: false, reason: "invalid-input" };
    }
    let rate: InputRateLimitResult;
    try {
      rate = checkInputRateLimit(rateState, nowMs, policy);
    } catch {
      // A caller-supplied policy getter that throws after construction.
      return { ok: false, reason: "invalid-input" };
    }
    if (!rate.ok) {
      return rate;
    }

    try {
      await options.execute(validation.notification);
    } catch {
      return { ok: false, reason: "executor-failed" };
    }
    rateState = { lastAcceptedAtMs: rate.lastAcceptedAtMs };
    return { ok: true, notification: validation.notification };
  }

  async function drain(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        let result: InputAcceptorResult;
        try {
          result = await settle(item);
        } catch {
          // A caller-supplied getter that throws on a later read must not leave
          // this candidate (or the rest of the queue) unresolved.
          result = { ok: false, reason: "invalid-input" };
        }
        item.resolve(result);
      }
    } finally {
      running = false;
    }
  }

  return {
    accept(message: unknown, senderId: string): Promise<InputAcceptorResult> {
      if (queue.length >= maxQueue) {
        return Promise.resolve({ ok: false, reason: "queue-full" });
      }
      const latest = readAcceptorSnapshot(options.snapshot);
      if (latest === null) {
        return Promise.resolve({ ok: false, reason: "snapshot-unavailable" });
      }
      return new Promise<InputAcceptorResult>((resolve) => {
        queue.push({ message, senderId, generation: latest.generation, resolve });
        void drain();
      });
    },
  };
}
