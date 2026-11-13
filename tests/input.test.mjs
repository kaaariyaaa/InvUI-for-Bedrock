import test from "node:test";
import assert from "node:assert/strict";

import {
  INPUT_NOTIFICATION_PREFIX,
  parseInputNotification,
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
