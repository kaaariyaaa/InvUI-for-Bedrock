import test from "node:test";
import assert from "node:assert/strict";

import {
  INPUT_NOTIFICATION_PREFIX,
  checkInputRateLimit,
  parseInputNotification,
  validateInputNotification,
} from "../src/input.ts";

test("parses the design 10.4 notification shape with a layout generation", () => {
  assert.equal(INPUT_NOTIFICATION_PREFIX, "!invui:");
  assert.deepEqual(parseInputNotification("!invui:window-1:1:0:1"), {
    sessionId: "window-1",
    layoutGeneration: 1,
    slot: 0,
    sequence: 1,
  });
  assert.deepEqual(parseInputNotification("!invui:A_b-9:0:53:9007199254740991"), {
    sessionId: "A_b-9",
    layoutGeneration: 0,
    slot: 53,
    sequence: 9007199254740991,
  });
});

test("rejects messages without the exact prefix or with the wrong field count", () => {
  for (const input of [
    "",
    "!invui",
    "!invui:",
    "!invui:window-1:0",
    // The old three-field form has no generation and is not accepted.
    "!invui:window-1:0:1",
    "!invui:window-1:0:1:extra",
    " !invui:window-1:1:0:1",
    "!invui:window-1:1:0:1 ",
    "!INVUI:window-1:1:0:1",
    "say !invui:window-1:1:0:1",
    "!invui:win:dow:1:0:1",
  ]) {
    assert.equal(parseInputNotification(input), null, input);
  }
});

test("rejects malformed or oversized session ids", () => {
  for (const session of [
    "",
    " ",
    "session id",
    "session/id",
    "session.id",
    "セッション",
    "A".repeat(65),
  ]) {
    assert.equal(parseInputNotification(`!invui:${session}:1:0:1`), null, session);
  }
  assert.notEqual(parseInputNotification(`!invui:${"A".repeat(64)}:1:0:1`), null);
});

test("accepts only canonical slot indices in the 54-slot ceiling", () => {
  for (const slot of ["", "-1", "+1", "01", "00", "1.0", " 1", "1 ", "54", "100", "abc"]) {
    assert.equal(parseInputNotification(`!invui:window-1:1:${slot}:1`), null, slot);
  }
  assert.equal(parseInputNotification("!invui:window-1:1:53:1")?.slot, 53);
});

test("accepts only canonical safe-integer sequences", () => {
  for (const sequence of [
    "",
    "-1",
    "+1",
    "01",
    "00",
    "1.0",
    " 1",
    "1 ",
    "abc",
    "9007199254740992",
    "9999999999999999",
  ]) {
    assert.equal(
      parseInputNotification(`!invui:window-1:1:0:${sequence}`),
      null,
      sequence,
    );
  }
  assert.equal(
    parseInputNotification("!invui:window-1:1:0:9007199254740991")?.sequence,
    9007199254740991,
  );
});

test("returns null instead of throwing for non-string input", () => {
  for (const input of [undefined, null, 0, 1, true, {}, [], ["!invui:window-1:1:0:1"]]) {
    assert.equal(parseInputNotification(input), null);
  }
});

function snapshot(overrides = {}) {
  const slotModes = Array.from({ length: 54 }, () => "display");
  slotModes[7] = "button";
  return {
    open: true,
    ownerId: "player-1",
    sessionId: "window-1",
    layoutGeneration: 1,
    slotModes,
    ...overrides,
  };
}

test("accepts a notification consistent with the caller's window snapshot", () => {
  const result = validateInputNotification("!invui:window-1:1:7:12", "player-1", snapshot());
  assert.deepEqual(result, {
    ok: true,
    notification: { sessionId: "window-1", layoutGeneration: 1, slot: 7, sequence: 12 },
  });
});

test("rejects malformed messages before looking at the window", () => {
  for (const message of [
    undefined,
    null,
    42,
    "",
    "!invui:window-1:7",
    // Old three-field form, missing generation.
    "!invui:window-1:7:12",
    "!invui:window-1:1:54:12",
    "!invui:window-1:1:07:12",
    "!invui:window-1:1:7:012",
    "!invui::-1:7:12",
    "!invui:window-1:-1:7:12",
    "!invui:window-1:01:7:12",
    "!invui:window-1:1.0:7:12",
    "!invui::1:7:12",
  ]) {
    assert.deepEqual(
      validateInputNotification(message, "player-1", snapshot()),
      { ok: false, reason: "malformed" },
      String(message),
    );
  }
});

test("rejects notifications for a window that is closing or closed", () => {
  assert.deepEqual(
    validateInputNotification("!invui:window-1:1:7:12", "player-1", snapshot({ open: false })),
    { ok: false, reason: "window-closed" },
  );
});

test("rejects notifications from anyone but the window owner", () => {
  assert.deepEqual(
    validateInputNotification("!invui:window-1:1:7:12", "player-2", snapshot()),
    { ok: false, reason: "sender-not-owner" },
  );
  assert.deepEqual(
    validateInputNotification("!invui:window-1:1:7:12", "", snapshot()),
    { ok: false, reason: "sender-not-owner" },
  );
});

test("rejects notifications for another session", () => {
  for (const message of ["!invui:window-2:1:7:12", "!invui:WINDOW-1:1:7:12"]) {
    assert.deepEqual(
      validateInputNotification(message, "player-1", snapshot()),
      { ok: false, reason: "session-mismatch" },
      message,
    );
  }
});

test("rejects slots that are not buttons in the current layout", () => {
  const modes = snapshot();
  modes.slotModes[3] = "inventory";
  for (const slot of [0, 3, 8, 53]) {
    assert.deepEqual(
      validateInputNotification(`!invui:window-1:1:${slot}:12`, "player-1", modes),
      { ok: false, reason: "slot-not-button" },
      String(slot),
    );
  }
  // A shorter layout makes higher logical slots nonexistent, not buttons.
  const short = snapshot({ slotModes: ["display", "button"] });
  for (const slot of [0, 2, 53]) {
    assert.deepEqual(
      validateInputNotification(`!invui:window-1:1:${slot}:12`, "player-1", short),
      { ok: false, reason: "slot-not-button" },
      String(slot),
    );
  }
  assert.equal(validateInputNotification("!invui:window-1:1:1:12", "player-1", short).ok, true);
});

test("rejects a notification from a previous clickable-layout generation", () => {
  const current = snapshot({ layoutGeneration: 2 });
  // The line was minted on the previous page but arrives after the change. The
  // slot is a button again on the new page; only the generation distinguishes
  // the stale click.
  assert.deepEqual(
    validateInputNotification("!invui:window-1:1:7:12", "player-1", current),
    { ok: false, reason: "stale-layout-generation" },
  );
  assert.equal(
    validateInputNotification("!invui:window-1:2:7:12", "player-1", current).ok,
    true,
  );
});

test("rejects repeated or out-of-order sequences and accepts newer ones", () => {
  const fresh = snapshot();
  assert.equal(validateInputNotification("!invui:window-1:1:7:0", "player-1", fresh).ok, true);
  for (const lastSequence of [0, 5, 9007199254740991]) {
    const state = snapshot({ lastSequence });
    assert.deepEqual(
      validateInputNotification(`!invui:window-1:1:7:${lastSequence}`, "player-1", state),
      { ok: false, reason: "stale-sequence" },
      `equal ${lastSequence}`,
    );
    assert.deepEqual(
      validateInputNotification("!invui:window-1:1:7:0", "player-1", state),
      { ok: false, reason: "stale-sequence" },
      `older than ${lastSequence}`,
    );
  }
  assert.equal(
    validateInputNotification("!invui:window-1:1:7:13", "player-1", snapshot({ lastSequence: 12 })).ok,
    true,
  );
});

test("validation is pure: frozen inputs are accepted and unchanged", () => {
  const state = snapshot({ lastSequence: 3 });
  Object.freeze(state.slotModes);
  Object.freeze(state);
  const result = validateInputNotification("!invui:window-1:1:7:4", "player-1", state);
  assert.deepEqual(result, {
    ok: true,
    notification: { sessionId: "window-1", layoutGeneration: 1, slot: 7, sequence: 4 },
  });
  assert.equal(state.lastSequence, 3);
});

test("rejections carry only a reason", () => {
  const result = validateInputNotification("!invui:window-1:1:0:1", "player-2", snapshot());
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"]);
});

test("rate limit accepts the first notification and anything at or past the interval", () => {
  const policy = { minIntervalMs: 250 };
  assert.deepEqual(checkInputRateLimit({}, 1000, policy), {
    ok: true,
    lastAcceptedAtMs: 1000,
  });
  assert.deepEqual(checkInputRateLimit({ lastAcceptedAtMs: 1000 }, 1250, policy), {
    ok: true,
    lastAcceptedAtMs: 1250,
  });
  assert.deepEqual(checkInputRateLimit({ lastAcceptedAtMs: 1000 }, 9000, policy), {
    ok: true,
    lastAcceptedAtMs: 9000,
  });
});

test("rate limit rejects repeats inside the injected interval", () => {
  const policy = { minIntervalMs: 250 };
  for (const nowMs of [1000, 1001, 1249]) {
    assert.deepEqual(
      checkInputRateLimit({ lastAcceptedAtMs: 1000 }, nowMs, policy),
      { ok: false, reason: "rate-limited" },
      String(nowMs),
    );
  }
});

test("rate limit fails closed when the caller's clock goes backwards", () => {
  const policy = { minIntervalMs: 250 };
  for (const nowMs of [999, 0]) {
    assert.deepEqual(
      checkInputRateLimit({ lastAcceptedAtMs: 1000 }, nowMs, policy),
      { ok: false, reason: "clock-backwards" },
      String(nowMs),
    );
  }
  // A rejected backwards reading does not advance the stored timestamp.
  const state = { lastAcceptedAtMs: 1000 };
  checkInputRateLimit(state, 500, policy);
  assert.equal(state.lastAcceptedAtMs, 1000);
  assert.equal(checkInputRateLimit(state, 1250, policy).ok, true);
});

test("rate limit fails closed on invalid times or limits instead of clamping", () => {
  const badNumbers = [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 53, "1000", null];
  for (const nowMs of [...badNumbers, undefined]) {
    assert.deepEqual(
      checkInputRateLimit({}, nowMs, { minIntervalMs: 250 }),
      { ok: false, reason: "invalid-input" },
      `nowMs ${String(nowMs)}`,
    );
  }
  for (const lastAcceptedAtMs of badNumbers) {
    assert.deepEqual(
      checkInputRateLimit({ lastAcceptedAtMs }, 1000, { minIntervalMs: 250 }),
      { ok: false, reason: "invalid-input" },
      `lastAcceptedAtMs ${String(lastAcceptedAtMs)}`,
    );
  }
  for (const minIntervalMs of [...badNumbers, undefined]) {
    assert.deepEqual(
      checkInputRateLimit({ lastAcceptedAtMs: 1000 }, 2000, { minIntervalMs }),
      { ok: false, reason: "invalid-input" },
      `minIntervalMs ${String(minIntervalMs)}`,
    );
  }
  // `undefined` lastAcceptedAtMs means "no notification accepted yet", not a bad number.
  assert.deepEqual(checkInputRateLimit({ lastAcceptedAtMs: undefined }, 1000, { minIntervalMs: 250 }), {
    ok: true,
    lastAcceptedAtMs: 1000,
  });
  assert.equal(checkInputRateLimit({}, 1000, { minIntervalMs: 0 }).ok, true);
});

test("rate limit with a zero interval disables only the interval, not the clock check", () => {
  const policy = { minIntervalMs: 0 };
  assert.equal(
    checkInputRateLimit({ lastAcceptedAtMs: 1000 }, 1000, policy).lastAcceptedAtMs,
    1000,
  );
  assert.deepEqual(
    checkInputRateLimit({ lastAcceptedAtMs: 1000 }, 999, policy),
    { ok: false, reason: "clock-backwards" },
  );
});

test("rate limit is pure: frozen state is accepted and unchanged", () => {
  const state = Object.freeze({ lastAcceptedAtMs: 1000 });
  const policy = Object.freeze({ minIntervalMs: 250 });
  assert.deepEqual(checkInputRateLimit(state, 1250, policy), {
    ok: true,
    lastAcceptedAtMs: 1250,
  });
  assert.deepEqual(checkInputRateLimit(state, 1100, policy), {
    ok: false,
    reason: "rate-limited",
  });
  assert.equal(state.lastAcceptedAtMs, 1000);
});
