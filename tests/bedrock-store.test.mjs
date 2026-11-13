import test from "node:test";
import assert from "node:assert/strict";

import {
  BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH,
  BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH,
  BedrockStoreError,
  BedrockWorldStateStore,
} from "../src/bedrock-store.ts";
import { STATE_STORAGE_VERSION, StateManager } from "../src/state.ts";

/**
 * Stand-in for the injected world. Mirrors the two dynamic-property calls and
 * records every interaction, and can be told to throw like the engine does on
 * a full database or an invalid identifier.
 */
class FakeWorld {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
    this.reads = [];
    this.writes = [];
    this.failWith = undefined;
  }

  #maybeThrow() {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
  }

  getDynamicProperty(identifier) {
    this.#maybeThrow();
    this.reads.push(identifier);
    return this.data.get(identifier);
  }

  setDynamicProperty(identifier, value) {
    this.#maybeThrow();
    this.writes.push([identifier, value]);
    if (value === undefined) {
      this.data.delete(identifier);
      return;
    }
    this.data.set(identifier, value);
  }
}

function expectStoreCode(error, code) {
  assert.ok(error instanceof BedrockStoreError, String(error));
  assert.equal(error.code, code);
  return true;
}

/** The previous variable-width encoding, reproduced only to plant legacy data. */
function legacyIdentifier(key) {
  return key.replace(
    /[^A-Za-z0-9_.:-]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

test("round-trips values through world dynamic properties", () => {
  const world = new FakeWorld();
  const store = new BedrockWorldStateStore(world);

  assert.equal(store.getItem("invui:gui-state:[\"player\",\"p\",\"quest\"]"), undefined);

  store.setItem("invui:gui-state:[\"player\",\"p\",\"quest\"]", '{"page":1}');
  assert.equal(
    store.getItem("invui:gui-state:[\"player\",\"p\",\"quest\"]"),
    '{"page":1}',
  );
  assert.equal(world.data.size, 1, "exactly one dynamic property is used");

  store.removeItem("invui:gui-state:[\"player\",\"p\",\"quest\"]");
  assert.equal(store.getItem("invui:gui-state:[\"player\",\"p\",\"quest\"]"), undefined);
  assert.equal(world.data.size, 0);
  assert.deepEqual(world.writes.at(-1)[1], undefined, "removal clears the value");
});

test("encoding is injective across UTF-16 code-unit boundaries", () => {
  const store = new BedrockWorldStateStore(new FakeWorld());

  // The variable-width encoder collided on all three pairs.
  const collisions = [
    ["caféA", "caf\u0E9A"],
    ["%", "\u2525"],
    ["Ø3DÞ00", "😀"],
  ];
  for (const [left, right] of collisions) {
    assert.notEqual(left, right);
    assert.notEqual(
      store.identifierFor(left),
      store.identifierFor(right),
      `${JSON.stringify(left)} / ${JSON.stringify(right)}`,
    );
  }

  // Every non-safe code unit is one fixed-width four-hex-digit escape, behind
  // the generation marker.
  assert.equal(
    store.identifierFor("invui:gui-state:[\"player\"]"),
    "%:invui:gui-state:%005B%0022player%0022%005D",
  );
  assert.equal(store.identifierFor("%"), "%:%0025");
  assert.equal(store.identifierFor("café"), "%:caf%00E9");
  assert.equal(store.identifierFor("\u0E9A"), "%:%0E9A");
  assert.equal(store.identifierFor("😀"), "%:%D83D%DE00");
  assert.equal(store.identifierFor("Ø3DÞ00"), "%:%00D8" + "3D" + "%00DE" + "00");

  // Every lone BMP code unit maps to a distinct, generation-tagged identifier.
  const identifiers = new Set();
  for (let code = 0; code <= 0xffff; code += 1) {
    identifiers.add(store.identifierFor(String.fromCharCode(code)));
  }
  assert.equal(identifiers.size, 0x10000, "no two BMP code units collide");
  for (const identifier of identifiers) {
    assert.match(identifier, /^%:(?:[A-Za-z0-9_.:-]|%[0-9A-F]{4})*$/);
  }

  // Astral characters encode as two escapes and stay distinct from BMP text.
  const astral = store.identifierFor("😀");
  assert.equal(new Set([astral, store.identifierFor("\uD83D"), store.identifierFor("\uDE00")]).size, 3);
});

test("identifiers stay namespaced and legal while remaining collision-free", () => {
  const world = new FakeWorld();
  const store = new BedrockWorldStateStore(world);

  const identifier = store.identifierFor('invui:gui-state:["player","p","default"]');
  assert.match(
    identifier,
    /^[A-Za-z0-9_.:%-]+$/,
    "only safe identifier characters (percent-escapes included)",
  );
  assert.ok(
    identifier.startsWith("%:invui:"),
    "generation marker precedes the preserved namespace",
  );
  assert.match(identifier, /%0022player%0022/, "quotes are escaped");

  const tricky = ["a:b", "a%3Ab", "a b", "a%20b", "a[b]"];
  const identifiers = tricky.map((key) => store.identifierFor(key));
  assert.equal(
    new Set(identifiers).size,
    identifiers.length,
    "distinct keys never share an identifier",
  );
  for (const id of identifiers) {
    assert.match(id, /^[A-Za-z0-9_.:%-]+$/);
  }
  assert.throws(() => store.identifierFor(""), TypeError);
});

test("rejects an identifier over 1024 characters before calling the world", () => {
  const world = new FakeWorld();
  const store = new BedrockWorldStateStore(world);
  assert.equal(BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH, 1024);

  // The generation marker counts toward the limit: 1,022 key chars + 2.
  const atLimit = "a".repeat(BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH - 2);
  const identifier = store.identifierFor(atLimit);
  assert.equal(identifier.length, 1024);
  assert.ok(identifier.startsWith("%:"));
  store.setItem(atLimit, "1");
  assert.equal(world.data.get(identifier), "1", "the limit itself is accepted");

  const overLimit = `${atLimit}a`;
  const reads = world.reads.length;
  const writes = world.writes.length;
  const calls = [
    () => store.getItem(overLimit),
    () => store.setItem(overLimit, "2"),
    () => store.removeItem(overLimit),
  ];
  for (const call of calls) {
    assert.throws(call, (error) => expectStoreCode(error, "IDENTIFIER_TOO_LONG"));
  }
  assert.throws(
    () => store.identifierFor(overLimit),
    (error) => expectStoreCode(error, "IDENTIFIER_TOO_LONG"),
  );
  assert.equal(world.reads.length, reads, "no engine read happened");
  assert.equal(world.writes.length, writes, "no engine write happened");
  assert.equal(world.data.size, 1, "stored state is unchanged");
  assert.equal(world.data.get(identifier), "1", "the existing value is unchanged");
});

test("percent-encoding counts toward the identifier limit", () => {
  const world = new FakeWorld();
  const store = new BedrockWorldStateStore(world);
  // 400 raw characters, 1,200 encoded: short key, oversized identifier.
  const key = '"'.repeat(400);
  assert.ok(key.length < BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH);
  assert.ok(store.identifierFor("a".repeat(400)).length < 1024);

  assert.throws(
    () => store.setItem(key, "1"),
    (error) => expectStoreCode(error, "IDENTIFIER_TOO_LONG"),
  );
  assert.equal(world.writes.length, 0);
  assert.equal(world.data.size, 0);

  const small = new BedrockWorldStateStore(world, { maxIdentifierLength: 10 });
  assert.equal(small.identifierFor("invui:ok").length, 10);
  assert.throws(
    () => small.setItem("invui:okay", "1"),
    (error) => expectStoreCode(error, "IDENTIFIER_TOO_LONG"),
  );
});

test("enforces the value guard in UTF-8 bytes before writing", () => {
  const world = new FakeWorld();
  const store = new BedrockWorldStateStore(world);
  const atLimit = "x".repeat(BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH);
  const limitKey = "invui:limit";
  const limitIdentifier = store.identifierFor(limitKey);

  store.setItem(limitKey, atLimit);
  assert.equal(world.data.get(limitIdentifier), atLimit, "the guard allows its limit");

  const writes = world.writes.length;
  assert.throws(
    () => store.setItem(limitKey, `${atLimit}x`),
    (error) => expectStoreCode(error, "VALUE_TOO_LARGE"),
  );
  assert.equal(world.writes.length, writes, "nothing is sent to the world");
  assert.equal(
    world.data.get(limitIdentifier).length,
    BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH,
    "the previous value survives",
  );

  const small = new BedrockWorldStateStore(world, { maxValueLength: 4 });
  small.setItem("invui:small", "abcd");
  assert.throws(
    () => small.setItem("invui:small", "abcde"),
    (error) => expectStoreCode(error, "VALUE_TOO_LARGE"),
  );

  // Bytes, not UTF-16 code units: 1-, 2-, 3- and 4-byte characters all count.
  small.setItem("invui:small", "éé"); // 2 × 2 bytes
  small.setItem("invui:small", "あa"); // 3 + 1 bytes
  small.setItem("invui:small", "😀"); // 4 bytes, 2 code units
  for (const [value, bytes] of [
    ["ééé", 6],
    ["ああ", 6],
    ["😀a", 5],
    ["😀😀", 8],
  ]) {
    assert.throws(
      () => small.setItem("invui:small", value),
      (error) => expectStoreCode(error, "VALUE_TOO_LARGE"),
      `${JSON.stringify(value)} is ${bytes} bytes`,
    );
  }

  // 32,767 ASCII characters pass; the same count in astral characters does not.
  const astralAtByteLimit = "x".repeat(BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH - 4) + "😀";
  assert.equal(astralAtByteLimit.length, BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH - 2);
  store.setItem("invui:astral", astralAtByteLimit);
  assert.throws(
    () => store.setItem("invui:astral", `${astralAtByteLimit}x`),
    (error) => expectStoreCode(error, "VALUE_TOO_LARGE"),
  );
});

test("rejects a stored non-string instead of coercing it", () => {
  const identifier = new BedrockWorldStateStore(new FakeWorld()).identifierFor(
    "invui:number",
  );
  const world = new FakeWorld({ [identifier]: 42 });
  const store = new BedrockWorldStateStore(world);

  assert.throws(
    () => store.getItem("invui:number"),
    (error) => expectStoreCode(error, "INVALID_STORED_VALUE"),
  );
  assert.equal(world.data.get(identifier), 42, "the record is left untouched");
});

test("fails closed when only a legacy-encoded property holds a value", () => {
  const key = "invui:gui-state:shop";
  const legacy = `${key}:${legacyIdentifier("café")}`;
  const world = new FakeWorld({ [legacy]: '{"page":3}' });
  const store = new BedrockWorldStateStore(world);

  assert.throws(
    () => store.getItem(`${key}:café`),
    (error) => {
      expectStoreCode(error, "LEGACY_IDENTIFIER_CONFLICT");
      assert.match(error.message, /Manual investigation is required/);
      return true;
    },
  );
  assert.deepEqual(
    [...world.data],
    [[legacy, '{"page":3}']],
    "the legacy value is never read out or rewritten",
  );
  assert.equal(world.writes.length, 0, "no property is written");
});

test("prefers the current identifier over a legacy-encoded value", () => {
  const key = "café";
  const current = new BedrockWorldStateStore(new FakeWorld()).identifierFor(key);
  const legacy = legacyIdentifier(key);
  assert.notEqual(current, legacy);
  const world = new FakeWorld({ [current]: "current", [legacy]: "legacy" });
  const store = new BedrockWorldStateStore(world);

  assert.equal(store.getItem(key), "current");
  assert.deepEqual(world.reads, [current], "the legacy property is not even read");
  assert.deepEqual([...world.data], [[current, "current"], [legacy, "legacy"]]);
});

test("does not attribute a colliding legacy value to either key", () => {
  // The old encoder mapped both keys to the same identifier.
  const left = "caféA";
  const right = "caf\u0E9A";
  const legacy = legacyIdentifier(left);
  assert.equal(legacy, legacyIdentifier(right));
  const world = new FakeWorld({ [legacy]: "ambiguous" });
  const store = new BedrockWorldStateStore(world);
  assert.notEqual(store.identifierFor(left), store.identifierFor(right));
  assert.notEqual(store.identifierFor(left), legacy);

  for (const key of [left, right]) {
    assert.throws(
      () => store.getItem(key),
      (error) => expectStoreCode(error, "LEGACY_IDENTIFIER_CONFLICT"),
    );
  }
  assert.deepEqual([...world.data], [[legacy, "ambiguous"]], "value is untouched");
  assert.equal(world.writes.length, 0);
});

test("fails closed for safe-only keys whose legacy identifier is the raw key", () => {
  const key = "invui:gui-state:player";
  // The old encoder left safe-only keys unchanged; the generation marker still
  // keeps the two generations apart, so this old record is not read as current.
  assert.equal(legacyIdentifier(key), key);
  const world = new FakeWorld({ [key]: '{"page":1}' });
  const store = new BedrockWorldStateStore(world);
  assert.notEqual(store.identifierFor(key), key);

  assert.throws(
    () => store.getItem(key),
    (error) => expectStoreCode(error, "LEGACY_IDENTIFIER_CONFLICT"),
  );
  assert.deepEqual(world.reads, [store.identifierFor(key), key]);
  assert.deepEqual([...world.data], [[key, '{"page":1}']], "old value untouched");
  assert.equal(world.writes.length, 0);
});

test("generation separation prevents new identifiers from colliding with legacy data", () => {
  // Before the generation marker, the fixed-width identifier of \uE9AB was
  // "%E9AB" — exactly what the old variable-width encoder produced for "éAB".
  // Reads preferred the current identifier and set/remove hit it directly, so
  // that old record could be read as another key's value or destroyed.
  const legacyKey = "éAB";
  const collidingKey = "\uE9AB";
  const collision = "%E9AB";
  assert.equal(legacyIdentifier(legacyKey), collision);
  assert.equal(legacyIdentifier(collidingKey), collision);

  const world = new FakeWorld({ [collision]: "legacy" });
  const store = new BedrockWorldStateStore(world);

  // Tagged identifiers are distinct from each other and from the old record,
  // while the legacy identifiers can never themselves contain the marker.
  for (const key of [legacyKey, collidingKey]) {
    assert.ok(store.identifierFor(key).startsWith("%:"));
    assert.notEqual(store.identifierFor(key), collision);
    assert.ok(!legacyIdentifier(key).includes("%:"));
  }
  assert.notEqual(store.identifierFor(legacyKey), store.identifierFor(collidingKey));

  // Reading either key fails closed instead of surfacing the old record.
  for (const key of [legacyKey, collidingKey]) {
    assert.throws(
      () => store.getItem(key),
      (error) => expectStoreCode(error, "LEGACY_IDENTIFIER_CONFLICT"),
    );
  }

  // A direct write only ever touches the tagged identifier.
  store.setItem(collidingKey, "new");
  assert.equal(world.data.get(collision), "legacy", "the old record survives");
  assert.equal(world.data.get(store.identifierFor(collidingKey)), "new");
  assert.equal(store.getItem(collidingKey), "new");

  // The new value is not leaked to the other key either.
  assert.throws(
    () => store.getItem(legacyKey),
    (error) => expectStoreCode(error, "LEGACY_IDENTIFIER_CONFLICT"),
  );

  // Removal only deletes the tagged identifier.
  store.removeItem(collidingKey);
  assert.equal(world.data.get(store.identifierFor(collidingKey)), undefined);
  assert.equal(world.data.get(collision), "legacy", "removal never deletes it");
});

test("returns undefined for a genuinely new key without legacy state", () => {
  const world = new FakeWorld();
  const store = new BedrockWorldStateStore(world);

  assert.equal(store.getItem("café"), undefined);
  assert.equal(world.data.size, 0, "nothing was created");
  assert.equal(world.writes.length, 0);
  assert.deepEqual(
    world.reads,
    [store.identifierFor("café"), legacyIdentifier("café")],
    "the legacy identifier is checked exactly once",
  );
});

test("propagates world exceptions unchanged", () => {
  const identifier = new BedrockWorldStateStore(new FakeWorld()).identifierFor(
    "invui:ok",
  );
  const world = new FakeWorld({ [identifier]: "1" });
  const store = new BedrockWorldStateStore(world);
  const boom = new Error("dynamic property database unavailable");

  world.failWith = boom;
  assert.throws(() => store.getItem("invui:ok"), (error) => error === boom);
  assert.throws(() => store.setItem("invui:ok", "2"), (error) => error === boom);
  assert.throws(() => store.removeItem("invui:ok"), (error) => error === boom);
  assert.equal(world.data.get(identifier), "1", "failed writes change nothing");
});

test("validates the injected world and options", () => {
  assert.throws(() => new BedrockWorldStateStore(), TypeError);
  assert.throws(() => new BedrockWorldStateStore(null), TypeError);
  assert.throws(
    () => new BedrockWorldStateStore({ getDynamicProperty() {} }),
    TypeError,
  );
  const world = new FakeWorld();
  for (const option of ["maxValueLength", "maxIdentifierLength"]) {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => new BedrockWorldStateStore(world, { [option]: value }),
        TypeError,
      );
    }
  }
  assert.throws(
    () => new BedrockWorldStateStore(world).setItem("invui:x", 5),
    TypeError,
  );
  assert.throws(
    () => new BedrockWorldStateStore(world).setItem("", "x"),
    TypeError,
  );
});

test("plugs into StateManager persistent lifetime across a script reload", () => {
  const world = new FakeWorld();
  const first = new StateManager(new BedrockWorldStateStore(world));
  const handle = first.acquire({
    ownerId: "player-1",
    key: "shop",
    lifetime: "persistent",
    schema: "shop-v1",
    initial: {
      page: 2,
      tabs: { 0: { page: 3 } },
      children: { detail: { line: 1 } },
    },
  });

  assert.equal(world.data.size, 1, "the initial state is persisted immediately");
  const [identifier, raw] = [...world.data.entries()][0];
  const record = JSON.parse(raw);
  assert.equal(record.version, STATE_STORAGE_VERSION);
  assert.equal(record.ownerId, "player-1");
  assert.equal(record.lifetime, "persistent");
  assert.equal(record.schema, "shop-v1");

  handle.set({ page: 5 });
  assert.equal(JSON.parse(world.data.get(identifier)).guiState.page, 5);
  handle.release();

  const reloaded = new StateManager(new BedrockWorldStateStore(world)).acquire({
    ownerId: "player-1",
    key: "shop",
    lifetime: "persistent",
    schema: "shop-v1",
    initial: { page: 99 },
  });
  assert.deepEqual(reloaded.get(), {
    page: 5,
    tabs: { 0: { page: 3 } },
    children: { detail: { line: 1 } },
  });
  reloaded.release();
});

test("an oversized state aborts the StateManager commit and keeps the stored value", () => {
  const world = new FakeWorld();
  const manager = new StateManager(new BedrockWorldStateStore(world));
  const handle = manager.acquire({
    ownerId: "p",
    key: "big",
    lifetime: "persistent",
    initial: { data: { blob: "small" } },
  });
  const [identifier, rawBefore] = [...world.data.entries()][0];

  assert.throws(
    () => handle.set({ data: { blob: "x".repeat(BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH) } }),
    (error) => expectStoreCode(error, "VALUE_TOO_LARGE"),
  );
  assert.deepEqual(handle.get(), { data: { blob: "small" } }, "state is not committed");
  assert.equal(world.data.get(identifier), rawBefore, "stored record is unchanged");
  handle.release();
});
