import test from "node:test";
import assert from "node:assert/strict";

import {
  INPUT_NOTIFICATION_PREFIX,
  parseInputNotification,
  validateInputNotification,
} from "../src/input.ts";

test("parses the design 10.4 notification shape", () => {
  assert.equal(INPUT_NOTIFICATION_PREFIX, "!invui:");
  assert.deepEqual(parseInputNotification("!invui:window-1:0:1"), {
    sessionId: "window-1",
    slot: 0,
    sequence: 1,
  });
  assert.deepEqual(parseInputNotification("!invui:A_b-9:53:9007199254740991"), {
    sessionId: "A_b-9",
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
    "!invui:window-1:0:1:extra",
    " !invui:window-1:0:1",
    "!invui:window-1:0:1 ",
    "!INVUI:window-1:0:1",
    "say !invui:window-1:0:1",
    "!invui:win:dow:0:1",
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
    assert.equal(parseInputNotification(`!invui:${session}:0:1`), null, session);
  }
  assert.notEqual(parseInputNotification(`!invui:${"A".repeat(64)}:0:1`), null);
});

test("accepts only canonical slot indices in the 54-slot ceiling", () => {
  for (const slot of ["", "-1", "+1", "01", "00", "1.0", " 1", "1 ", "54", "100", "abc"]) {
    assert.equal(parseInputNotification(`!invui:window-1:${slot}:1`), null, slot);
  }
  assert.equal(parseInputNotification("!invui:window-1:53:1")?.slot, 53);
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
      parseInputNotification(`!invui:window-1:0:${sequence}`),
      null,
      sequence,
    );
  }
  assert.equal(
    parseInputNotification("!invui:window-1:0:9007199254740991")?.sequence,
    9007199254740991,
  );
});

test("returns null instead of throwing for non-string input", () => {
  for (const input of [undefined, null, 0, 1, true, {}, [], ["!invui:window-1:0:1"]]) {
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
    slotModes,
    ...overrides,
  };
}

test("accepts a notification consistent with the caller's window snapshot", () => {
  const result = validateInputNotification("!invui:window-1:7:12", "player-1", snapshot());
  assert.deepEqual(result, {
    ok: true,
    notification: { sessionId: "window-1", slot: 7, sequence: 12 },
  });
});

test("rejects malformed messages before looking at the window", () => {
  for (const message of [
    undefined,
    null,
    42,
    "",
    "!invui:window-1:7",
    "!invui:window-1:7:12:0",
    "!invui:window-1:54:12",
    "!invui:window-1:07:12",
    "!invui:window-1:7:012",
    "!invui::7:12",
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
    validateInputNotification("!invui:window-1:7:12", "player-1", snapshot({ open: false })),
    { ok: false, reason: "window-closed" },
  );
});

test("rejects notifications from anyone but the window owner", () => {
  assert.deepEqual(
    validateInputNotification("!invui:window-1:7:12", "player-2", snapshot()),
    { ok: false, reason: "sender-not-owner" },
  );
  assert.deepEqual(
    validateInputNotification("!invui:window-1:7:12", "", snapshot()),
    { ok: false, reason: "sender-not-owner" },
  );
});

test("rejects notifications for another session", () => {
  for (const message of ["!invui:window-2:7:12", "!invui:WINDOW-1:7:12"]) {
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
      validateInputNotification(`!invui:window-1:${slot}:12`, "player-1", modes),
      { ok: false, reason: "slot-not-button" },
      String(slot),
    );
  }
  // A shorter layout makes higher logical slots nonexistent, not buttons.
  const short = snapshot({ slotModes: ["display", "button"] });
  for (const slot of [0, 2, 53]) {
    assert.deepEqual(
      validateInputNotification(`!invui:window-1:${slot}:12`, "player-1", short),
      { ok: false, reason: "slot-not-button" },
      String(slot),
    );
  }
  assert.equal(validateInputNotification("!invui:window-1:1:12", "player-1", short).ok, true);
});

test("rejects repeated or out-of-order sequences and accepts newer ones", () => {
  const fresh = snapshot();
  assert.equal(validateInputNotification("!invui:window-1:7:0", "player-1", fresh).ok, true);
  for (const lastSequence of [0, 5, 9007199254740991]) {
    const state = snapshot({ lastSequence });
    assert.deepEqual(
      validateInputNotification(`!invui:window-1:7:${lastSequence}`, "player-1", state),
      { ok: false, reason: "stale-sequence" },
      `equal ${lastSequence}`,
    );
    assert.deepEqual(
      validateInputNotification("!invui:window-1:7:0", "player-1", state),
      { ok: false, reason: "stale-sequence" },
      `older than ${lastSequence}`,
    );
  }
  assert.equal(
    validateInputNotification("!invui:window-1:7:13", "player-1", snapshot({ lastSequence: 12 })).ok,
    true,
  );
});

test("validation is pure: frozen inputs are accepted and unchanged", () => {
  const state = snapshot({ lastSequence: 3 });
  Object.freeze(state.slotModes);
  Object.freeze(state);
  const result = validateInputNotification("!invui:window-1:7:4", "player-1", state);
  assert.deepEqual(result, {
    ok: true,
    notification: { sessionId: "window-1", slot: 7, sequence: 4 },
  });
  assert.equal(state.lastSequence, 3);
});

test("rejections carry only a reason", () => {
  const result = validateInputNotification("!invui:window-1:0:1", "player-2", snapshot());
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"]);
});
