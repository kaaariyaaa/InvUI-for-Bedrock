/**
 * Parser for the tentative chat notification in design 10.4:
 *
 * ```text
 * !invui:<session-id>:<slot-index>:<sequence>
 * ```
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
 * Design gaps: 10.4 defines the field order but not the session-id charset or
 * length, whether `slot-index` starts at 0, or the sequence type, range, and
 * ordering. The bounds below are defensive parser policy, not confirmed
 * protocol requirements; adjust them when the format is finalized. 10.5 has no
 * time-based freshness rule and 10.4 puts no timestamp in the message, so
 * "expired" can only mean "the Window is no longer open"; it also defines no
 * rate-limit parameters, no generation/page token in the message, and no
 * mapping from layout elements to the `button`/`display`/`inventory` modes.
 * See `validateInputNotification` for what that leaves unchecked.
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
const SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/;

export interface InputNotification {
  readonly sessionId: string;
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
  if (parts.length !== 3) {
    return null;
  }

  const [sessionId, slotText, sequenceText] = parts;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  if (!SLOT_INDEX_PATTERN.test(slotText)) {
    return null;
  }
  const slot = Number(slotText);
  if (slot > MAX_SLOT_INDEX) {
    return null;
  }
  if (!SEQUENCE_PATTERN.test(sequenceText)) {
    return null;
  }
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) {
    return null;
  }

  return { sessionId, slot, sequence };
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
 * - Rate limiting (10.5 requires limiting repeats but gives no count or window).
 * - Page/generation identity (the message has no generation token, so a late
 *   click from a previous page cannot be told apart if that slot is a button
 *   again on the new page; the caller's own generation check must handle it).
 * - Ownership of the chat sender vs. the player object (the caller supplies
 *   `senderId`; this module never reads a Player).
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
