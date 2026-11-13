import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Gui,
  GuiLink,
  Markers,
  PagedGui,
  ScrollGui,
  Structure,
  TabGui,
} from "../src/gui.ts";
import { InventoryLink, VirtualInventory } from "../src/inventory.ts";

const item = (id) => ({ id });
const ids = (layout) => layout.slots.map((slot) => (slot === null ? null : (slot.id ?? slot)));
const H = Markers.CONTENT_LIST_SLOT_HORIZONTAL;
const V = Markers.CONTENT_LIST_SLOT_VERTICAL;

test("Structure: one code point per slot, undefined characters are empty", () => {
  const structure = new Structure("a#", "..");
  structure.addIngredient("a", item("a"));
  structure.addIngredient("#", item("b"));
  assert.equal(structure.width, 2);
  assert.equal(structure.height, 2);

  const layout = Gui.normal({ structure }).resolve();
  assert.deepEqual(ids(layout), ["a", "b", null, null]);

  const unicode = new Structure("あい", "うえ");
  assert.equal(unicode.width, 2);
});

test("Structure: width/height bounds and uniform rows are validated", () => {
  assert.throws(() => new Structure(), /at least one row/);
  assert.throws(() => new Structure(""), /must not be empty/);
  assert.throws(() => new Structure("1234567890"), /maximum of 9/);
  assert.throws(() => new Structure("a", "b", "c", "d", "e", "f", "g"), /maximum of 6/);
  assert.throws(() => new Structure("ab", "c"), /same width/);
  assert.throws(() => new Structure("a").addIngredient("ab", item("x")), /one character/);

  const maximum = new Structure("#########", "#########", "#########", "#########", "#########", "#########");
  assert.equal(maximum.width * maximum.height, 54);
});

test("declarative options and builder produce the same normalized layout", () => {
  const background = item("bg");
  const content = [item("a"), item("b"), item("c"), item("d")];
  const options = {
    structure: ["###", "#x#", "###"],
    ingredients: { "#": background, x: H },
    content,
  };

  const fromOptions = Gui.paged(options);
  const fromBuilder = Gui
    .paged()
    .setStructure(new Structure("###", "#x#", "###"))
    .addIngredient("#", background)
    .addIngredient("x", H)
    .setContent(content)
    .build();

  assert.ok(fromOptions instanceof PagedGui);
  assert.ok(fromBuilder instanceof PagedGui);
  assert.deepEqual(fromOptions.resolve(null, { page: 1 }), fromBuilder.resolve(null, { page: 1 }));

  const normalFromOptions = Gui.normal({ structure: ["#"], ingredients: { "#": background } });
  const normalFromBuilder = Gui.builder().setStructure(["#"]).addIngredient("#", background).build();
  assert.deepEqual(normalFromOptions.resolve(), normalFromBuilder.resolve());
});

test("content list horizontal marker is row-major", () => {
  const content = ["a", "b", "c", "d", "e"].map(item);
  const gui = Gui.normal({
    structure: ["xx.", "xxx"],
    ingredients: { x: H },
    content,
  });
  const layout = gui.resolve();
  assert.deepEqual(layout.contentSlots, [0, 1, 3, 4, 5]);
  assert.deepEqual(ids(layout), ["a", "b", null, "c", "d", "e"]);
});

test("content list vertical marker is column-major", () => {
  const content = ["a", "b", "c", "d", "e"].map(item);
  const gui = Gui.normal({
    structure: ["xx.", "xxx"],
    ingredients: { x: V },
    content,
  });
  const layout = gui.resolve();
  assert.deepEqual(layout.contentSlots, [0, 3, 1, 4, 5]);
  assert.deepEqual(ids(layout), ["a", "c", null, "b", "d", "e"]);
});

test("both content markers in one Structure are rejected as ambiguous", () => {
  const gui = Gui.normal({
    structure: ["xy"],
    ingredients: { x: H, y: V },
  });
  assert.throws(() => gui.resolve(), /both horizontal and vertical/);
});

test("normal GUI ignores content beyond the declared slots", () => {
  const content = ["a", "b", "c"].map(item);
  const layout = Gui.normal({ structure: ["x"], ingredients: { x: H }, content }).resolve();
  assert.deepEqual(ids(layout), ["a"]);
  assert.equal(layout.page, 0);
  assert.equal(layout.pageCount, 1);
});

test("paged GUI: page count, clamping, and empty trailing slots", () => {
  const content = Array.from({ length: 7 }, (_, i) => item(`i${i}`));
  const gui = Gui.paged({ structure: ["xxx"], ingredients: { x: H }, content });

  const first = gui.resolve(null, { page: 0 });
  assert.equal(first.page, 0);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(ids(first), ["i0", "i1", "i2"]);

  const second = gui.resolve(null, { page: 1 });
  assert.deepEqual(ids(second), ["i3", "i4", "i5"]);

  const last = gui.resolve(null, { page: 2 });
  assert.deepEqual(ids(last), ["i6", null, null]);

  assert.equal(gui.resolve(null, { page: 99 }).page, 2);
  assert.equal(gui.resolve(null, { page: -5 }).page, 0);

  const exact = Gui.paged({ structure: ["xx"], ingredients: { x: H }, content: content.slice(0, 4) });
  assert.equal(exact.resolve().pageCount, 2);
});

test("paged GUI does not retain state on the instance", () => {
  const gui = Gui.paged({
    structure: ["x"],
    ingredients: { x: H },
    content: [item("a"), item("b"), item("c")],
  });
  assert.equal("page" in gui, false);
  assert.equal(ids(gui.resolve(null, { page: 2 }))[0], "c");
  assert.equal(ids(gui.resolve(null, { page: 0 }))[0], "a");
  assert.equal(ids(gui.resolve(null, { page: 2 }))[0], "c");
});

test("scroll GUI vertical: line units, clamping, and width/content separation", () => {
  const content = Array.from({ length: 10 }, (_, i) => item(`i${i}`));
  const gui = Gui.scroll({
    structure: ["xxx", "xxx"],
    ingredients: { x: H },
    content,
    direction: "vertical",
    contentWidth: 3,
  });
  assert.ok(gui instanceof ScrollGui);

  const first = gui.resolve(null, { line: 0 });
  assert.equal(first.line, 0);
  assert.equal(first.maxLine, 2);
  assert.deepEqual(ids(first), ["i0", "i1", "i2", "i3", "i4", "i5"]);

  const second = gui.resolve(null, { line: 1 });
  assert.deepEqual(ids(second), ["i3", "i4", "i5", "i6", "i7", "i8"]);

  const last = gui.resolve(null, { line: 99 });
  assert.equal(last.line, 2);
  assert.deepEqual(ids(last), ["i6", "i7", "i8", "i9", null, null]);

  assert.equal(gui.resolve(null, { line: -1 }).line, 0);

  const wider = Gui.scroll({
    structure: ["xxx", "xxx"],
    ingredients: { x: H },
    content,
    contentWidth: 4,
  });
  const widerFirst = wider.resolve(null, { line: 0 });
  assert.equal(widerFirst.maxLine, 1);
  assert.deepEqual(ids(widerFirst), ["i0", "i1", "i2", "i4", "i5", "i6"]);

  const empty = Gui.scroll({ structure: ["xxx"], ingredients: { x: H }, content: [] });
  const emptyLayout = empty.resolve();
  assert.equal(emptyLayout.line, 0);
  assert.equal(emptyLayout.maxLine, 0);
  assert.deepEqual(ids(emptyLayout), [null, null, null]);
});

test("scroll GUI horizontal: column units and clamping", () => {
  const content = Array.from({ length: 10 }, (_, i) => item(`i${i}`));
  const gui = Gui.scroll({
    structure: ["xxx", "xxx"],
    ingredients: { x: V },
    content,
    direction: "horizontal",
    contentHeight: 2,
  });

  const first = gui.resolve(null, { line: 0 });
  assert.equal(first.maxLine, 2);
  assert.deepEqual(ids(first), ["i0", "i2", "i4", "i1", "i3", "i5"]);

  const last = gui.resolve(null, { line: 99 });
  assert.equal(last.line, 2);
  assert.deepEqual(ids(last), ["i4", "i6", "i8", "i5", "i7", "i9"]);

  const tall = Gui.scroll({
    structure: ["xxx", "xxx"],
    ingredients: { x: V },
    content,
    direction: "horizontal",
    contentHeight: 1,
  });
  assert.throws(() => tall.resolve(), /at least the visible marker height/);
});

test("scroll GUI requires a rectangular content viewport", () => {
  const gui = Gui.scroll({
    structure: ["x.x", ".x."],
    ingredients: { x: H },
    content: [item("a")],
  });
  assert.throws(() => gui.resolve(), /must form a rectangle/);
});

test("tab GUI: selected tab, per-tab state, and clamping", () => {
  const tab0 = Gui.paged({
    structure: ["xx"],
    ingredients: { x: H },
    content: [item("a0"), item("a1"), item("a2")],
  });
  const tab1 = Gui.normal({ structure: ["y"], ingredients: { y: item("b0") } });
  const tabs = Gui.tab({ tabs: [tab0, tab1] });
  assert.ok(tabs instanceof TabGui);

  const first = tabs.resolve(null, { tab: 0, tabs: { 0: { page: 1 } } });
  assert.equal(first.kind, "tab");
  assert.equal(first.tab, 0);
  assert.equal(first.tabCount, 2);
  assert.deepEqual(ids(first), ["a2", null]);

  const second = tabs.resolve(null, { tab: 1 });
  assert.equal(second.tab, 1);
  assert.deepEqual(ids(second), ["b0"]);

  const clamped = tabs.resolve(null, { tab: 99 });
  assert.equal(clamped.tab, 1);
  assert.deepEqual(ids(clamped), ["b0"]);

  assert.throws(() => new TabGui({ tabs: [] }), /at least one tab/);
});

test("GuiLink projects child slots at the top-left offset by default", () => {
  const child = Gui.normal({
    structure: ["ab", "cd"],
    ingredients: { a: item("a"), b: item("b"), c: item("c"), d: item("d") },
  });
  const parent = Gui.normal({
    structure: ["@........", ".........", "........."],
    ingredients: { "@": new GuiLink(child) },
  });

  const layout = parent.resolve();
  assert.equal(layout.slots[0].id, "a");
  assert.equal(layout.slots[1].id, "b");
  assert.equal(layout.slots[9].id, "c");
  assert.equal(layout.slots[10].id, "d");
  assert.equal(layout.slots[2], null);
});

test("GuiLink supports explicit mapping and validates the parent range", () => {
  const child = Gui.normal({
    structure: ["ab"],
    ingredients: { a: item("a"), b: item("b") },
  });
  const parent = Gui.normal({
    structure: ["@........", ".........", "........."],
    ingredients: { "@": new GuiLink(child, { mapping: { 0: 5, 1: 20 } }) },
  });
  const layout = parent.resolve();
  assert.equal(layout.slots[5].id, "a");
  assert.equal(layout.slots[20].id, "b");

  const tooNarrow = Gui.normal({
    structure: ["@.......@"],
    ingredients: { "@": new GuiLink(child) },
  });
  assert.throws(() => tooNarrow.resolve(), /out of range/);

  const badMapping = Gui.normal({
    structure: ["@"],
    ingredients: { "@": new GuiLink(child, { mapping: { 0: 99 } }) },
  });
  assert.throws(() => badMapping.resolve(), /out of range/);
});

test("GuiLink rejects cyclic nesting", () => {
  const a = Gui.normal({ structure: ["@"] });
  const b = Gui.normal({ structure: ["@"] });
  a._structure.addIngredient("@", new GuiLink(b));
  b._structure.addIngredient("@", new GuiLink(a));
  assert.throws(() => a.resolve(), /Cyclic GUI reference/);
});

test("GuiLink rejects overlapping projections", () => {
  const child = Gui.normal({
    structure: ["ab"],
    ingredients: { a: item("a"), b: item("b") },
  });
  const parent = Gui.normal({
    structure: ["@#"],
    ingredients: { "@": new GuiLink(child), "#": item("static") },
  });
  assert.throws(() => parent.resolve(), /Overlapping GUI elements/);
});

test("GuiLink validates out-of-range and overlap even when projected slots are empty", () => {
  // The protruding child slot is empty, but the geometry is still invalid and
  // must fail on every resolve, not only once content lands there.
  const protruding = Gui.normal({ structure: ["a.", ".."], ingredients: { a: item("a") } });
  const outOfRange = Gui.normal({
    structure: [".@", ".."],
    ingredients: { "@": new GuiLink(protruding) },
  });
  assert.throws(() => outOfRange.resolve(), /out of range/);

  // Two links that claim overlapping rectangles are ambiguous while empty too.
  const blank = Gui.normal({ structure: [".."] });
  const overlapping = Gui.normal({
    structure: ["@#"],
    ingredients: { "@": new GuiLink(blank), "#": new GuiLink(blank) },
  });
  assert.throws(() => overlapping.resolve(), /Overlapping GUI elements/);

  // An explicit mapping validates the parent slot before skipping an empty child slot.
  const emptyChild = Gui.normal({ structure: ["."] });
  const badMapping = Gui.normal({
    structure: ["@"],
    ingredients: { "@": new GuiLink(emptyChild, { mapping: { 0: 99 } }) },
  });
  assert.throws(() => badMapping.resolve(), /out of range/);
});

test("GuiLink can receive child state through state.children", () => {
  const child = Gui.paged({
    structure: ["x"],
    ingredients: { x: H },
    content: [item("p0"), item("p1"), item("p2")],
  });
  const parent = Gui.normal({
    structure: ["@"],
    ingredients: { "@": new GuiLink(child, { key: "shop" }) },
  });

  assert.equal(ids(parent.resolve(null, { children: { shop: { page: 1 } } }))[0], "p1");
  assert.equal(ids(parent.resolve(null, { children: { shop: { page: 2 } } }))[0], "p2");
  assert.equal(ids(parent.resolve(null, {}))[0], "p0");
});

test("InventoryLink ingredients are preserved as slot elements", () => {
  const link = new InventoryLink(new VirtualInventory(9), 3);
  const gui = Gui.normal({
    structure: ["@x"],
    ingredients: { "@": link, x: H },
    content: [item("content")],
  });
  const layout = gui.resolve();
  assert.equal(layout.slots[0], link);
  assert.equal(layout.slots[1].id, "content");
});

test("spaces are ordinary characters; unmapped spaces are empty slots", () => {
  const structure = new Structure("a b");
  assert.equal(structure.width, 3);
  assert.deepEqual(ids(Gui.normal({ structure }).resolve()), [null, null, null]);

  const mapped = Gui.normal({
    structure,
    ingredients: { a: item("a"), " ": item("space"), b: item("b") },
  });
  assert.deepEqual(ids(mapped.resolve()), ["a", "space", "b"]);
});

test("unknown string ingredients are rejected", () => {
  const gui = Gui.normal({ structure: ["x"], ingredients: { x: "not-a-marker" } });
  assert.throws(() => gui.resolve(), /Unknown ingredient/);
});
