import test from "node:test";
import assert from "node:assert/strict";

import { SlotWriteCache } from "../src/render-cache.ts";

const stack = (typeId) => ({ typeId, amount: 1 });

test("an unknown slot is always written", () => {
  const cache = new SlotWriteCache();
  assert.equal(cache.shouldWrite(0, undefined), true);
  assert.equal(cache.shouldWrite(0, stack("minecraft:stone")), true);
});

test("only a known-empty slot written empty again is skipped", () => {
  const cache = new SlotWriteCache();
  cache.markWritten(3, undefined);
  assert.equal(cache.shouldWrite(3, undefined), false);

  // A stack into the empty slot is a real change, and after it the empty
  // value is a real change again.
  assert.equal(cache.shouldWrite(3, stack("minecraft:stone")), true);
  cache.markWritten(3, stack("minecraft:stone"));
  assert.equal(cache.shouldWrite(3, undefined), true);
  cache.markWritten(3, undefined);
  assert.equal(cache.shouldWrite(3, undefined), false);
});

test("a failed write is retried because it was never marked", () => {
  const cache = new SlotWriteCache();
  // Simulates setItem() throwing: shouldWrite() stays true afterwards.
  assert.equal(cache.shouldWrite(1, undefined), true);
  assert.equal(cache.shouldWrite(1, undefined), true);
});

test("invalidate forces the next write", () => {
  const cache = new SlotWriteCache();
  cache.markWritten(2, undefined);
  cache.markWritten(4, undefined);
  cache.invalidate(2);
  assert.equal(cache.shouldWrite(2, undefined), true);
  assert.equal(cache.shouldWrite(4, undefined), false);
  cache.invalidate();
  assert.equal(cache.shouldWrite(4, undefined), true);
});
