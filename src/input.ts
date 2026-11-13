/**
 * Parser for the tentative chat notification in design 10.4:
 *
 * ```text
 * !invui:<session-id>:<slot-index>:<sequence>
 * ```
 *
 * This is a pure string parser. It does not import the Minecraft API, subscribe
 * to `world.beforeEvents.chatSend`, hold a WindowRegistry, or call
 * `Window.handleClick()`. A parsed message is **not** authenticated: the sender
 * can type the same string by hand, so the caller must still apply design 10.5
 * (open Window belongs to the sender, session matches that Window, slot is a
 * button in the current generation, stale generations and repeated
 * notifications are rejected) before treating it as a click.
 *
 * Design 10.4 also says the format is not final until chat sending from the
 * chest screen is verified in the real game. This module therefore validates
 * syntax only and deliberately has no game-event integration.
 *
 * Design gaps: 10.4 defines the field order but not the session-id charset or
 * length, whether `slot-index` starts at 0, or the sequence type, range, and
 * ordering. The bounds below are defensive parser policy, not confirmed
 * protocol requirements; adjust them when the format is finalized.
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
