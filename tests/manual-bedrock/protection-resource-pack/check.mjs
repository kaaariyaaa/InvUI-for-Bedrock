#!/usr/bin/env node
/*
 * Structure check for the protection probe resource pack.
 *
 * This only proves the JSON is well formed and internally consistent. It
 * cannot prove the pack loads, that the overlay renders above the slots,
 * that the overlay receives input, or that item take/place/move is blocked.
 * Run:
 *   node tests/manual-bedrock/protection-resource-pack/check.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(root, "ui");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readText = (file) => fs.readFileSync(file, "utf8");

const MANIFEST = path.join(root, "manifest.json");
const UI_DEFS = path.join(uiDir, "_ui_defs.json");
const DEFS = path.join(uiDir, "invui_protection.json");
const CHEST_MODS = path.join(uiDir, "invui_protection_chest.json");
const POCKET_MODS = path.join(uiDir, "invui_protection_pocket.json");
const README = path.join(root, "README.md");

for (const file of [MANIFEST, UI_DEFS, DEFS, CHEST_MODS, POCKET_MODS, README]) {
  assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)}`);
}

// A resources-only observation pack: no behavior pack, no scripts, no
// chest_screen.json overwrite.
assert.deepEqual(
  fs.readdirSync(root).sort(),
  ["README.md", "check.mjs", "manifest.json", "ui"],
  "unexpected file in the probe root",
);

// --- manifest -------------------------------------------------------------

const manifest = readJson(MANIFEST);
assert.equal(manifest.format_version, 2);
assert.deepEqual(manifest.header.min_engine_version, [1, 26, 70]);
assert.match(manifest.header.uuid, /^[0-9a-f-]{36}$/);
assert.match(manifest.header.name, /DISPOSABLE WORLD ONLY/);
assert.match(manifest.header.description, /Unverified/);
assert.match(manifest.header.description, /No protection guarantee/i);
assert.match(manifest.header.description, /no click bridge/i);
assert.match(manifest.header.description, /InputBridge/i);
assert.match(manifest.header.description, /all chest screens/i);
assert.match(manifest.header.description, /disposable world/i);

const modules = manifest.modules || [];
assert.equal(modules.length, 1, "manifest needs exactly one module");
assert.equal(modules[0].type, "resources", "this pack must stay resource-only");
assert.match(modules[0].uuid, /^[0-9a-f-]{36}$/);
assert.notEqual(modules[0].uuid, manifest.header.uuid, "module/header UUIDs must differ");

// --- pack contents --------------------------------------------------------

assert.deepEqual(
  fs.readdirSync(uiDir).sort(),
  [
    "_ui_defs.json",
    "invui_protection.json",
    "invui_protection_chest.json",
    "invui_protection_pocket.json",
  ],
  "unexpected file in ui/",
);
assert.ok(
  !fs.existsSync(path.join(uiDir, "chest_screen.json")),
  "probe must not ship or overwrite ui/chest_screen.json",
);

const uiDefs = readJson(UI_DEFS).ui_defs;
assert.deepEqual(uiDefs, [
  "ui/invui_protection.json",
  "ui/invui_protection_chest.json",
  "ui/invui_protection_pocket.json",
]);
for (const entry of uiDefs) {
  assert.ok(fs.existsSync(path.join(root, entry)), `ui_defs entry not found: ${entry}`);
  assert.ok(!entry.includes("chest_screen.json"), "probe must not register a chest_screen.json file");
}

// --- definitions ----------------------------------------------------------

const defs = readJson(DEFS);
assert.equal(defs.namespace, "invui_protection");
assert.deepEqual(
  Object.keys(defs).sort(),
  ["desktop_marker", "grid_blocker", "namespace", "pocket_marker"],
  "definitions must contain only the two labels and the blocker",
);

for (const [name, system] of [
  ["desktop_marker", "desktop"],
  ["pocket_marker", "pocket"],
]) {
  const label = defs[name];
  assert.equal(label.type, "label", `${name} must stay a plain label`);
  assert.match(label.text, /^PROTECTION PROBE \(/);
  assert.ok(label.text.includes(`(${system})`), `${name} text must name the ${system} system`);
  assert.equal(label.anchor_from, "top_left");
  assert.equal(label.anchor_to, "top_left");
}

// The blocker must only translate slot-style inputs into one custom no-op id.
// No container/drop/coalesce action may survive.
const blocker = defs.grid_blocker;
assert.equal(blocker.type, "button");
assert.deepEqual(blocker.size, ["100%", "100%"]);
assert.equal(blocker.layer, 10);
assert.equal(blocker.focus_enabled, true);
assert.equal(blocker.focus_wrap_enabled, false);
assert.equal(blocker.sound_name, "random.click");
assert.equal(blocker.default_control, "default");
assert.equal(blocker.hover_control, "hover");
assert.equal(blocker.pressed_control, "pressed");
assert.equal(blocker.$pressed_button_name, "button.invui_protection_blocked");
assert.ok(
  defs.desktop_marker.layer > blocker.layer && defs.pocket_marker.layer > blocker.layer,
  "labels must render above the blocker",
);

const expectedMappings = [
  ["button.menu_select", "pressed"],
  ["button.menu_ok", "focused"],
  ["button.menu_select", "double_pressed"],
  ["button.menu_ok", "double_pressed"],
  ["button.menu_secondary_select", "pressed"],
  ["button.controller_select", "pressed"],
  ["button.menu_auto_place", "pressed"],
  ["button.controller_secondary_select", "pressed"],
  ["button.menu_inventory_drop", "pressed"],
  ["button.menu_inventory_drop_all", "pressed"],
];
assert.deepEqual(
  blocker.button_mappings.map((mapping) => [mapping.from_button_id, mapping.mapping_type]),
  expectedMappings,
  "blocker must map the vanilla slot-style inputs",
);
for (const mapping of blocker.button_mappings) {
  assert.equal(mapping.to_button_id, "$pressed_button_name", "all mappings must hit the no-op id");
}

assert.deepEqual(
  blocker.controls.map((control) => Object.keys(control)[0]),
  ["default", "hover", "pressed"],
  "blocker must only carry its three state images",
);
const stateChildren = Object.fromEntries(blocker.controls.map((control) => Object.entries(control)[0]));
for (const state of ["default", "hover", "pressed"]) {
  const image = stateChildren[state];
  assert.equal(image.type, "image", `${state} must be an image`);
  assert.equal(image.texture, "textures/ui/white_background");
  assert.deepEqual(image.size, ["100%", "100%"]);
}
assert.equal(stateChildren.default.alpha, 0, "the default state must stay invisible");
for (const state of ["hover", "pressed"]) {
  assert.deepEqual(stateChildren[state].color, [1, 0, 0, 1], `${state} must tint red`);
  assert.ok(stateChildren[state].alpha > 0, `${state} must be visible`);
}
assert.ok(
  stateChildren.pressed.alpha > stateChildren.hover.alpha,
  "pressed must be stronger than hover so a touch press is visible",
);

// The pack must stay observation-only: no bindings, collections, text entry,
// item renderers, or other input controls. Crash the check if any appear.
const forbiddenTypes = new Set([
  "edit_box",
  "input_panel",
  "toggle",
  "slider",
  "slider_box",
  "grid",
  "collection_panel",
  "scroll_view",
  "selection_wheel",
  "dropdown",
  "custom",
  "screen",
  "stack_panel",
]);
const forbiddenKeys = new Set([
  "bindings",
  "binding_name",
  "binding_name_override",
  "binding_type",
  "collection_name",
  "collection_index",
  "grid_dimensions",
  "text_box_name",
  "items",
  "modifications",
  "$item_collection_name",
]);
const walk = (value, where) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.has(key), `unexpected interaction key ${key} at ${where}`);
    if (key === "type") {
      assert.ok(!forbiddenTypes.has(entry), `unexpected control type ${entry} at ${where}`);
    }
    walk(entry, `${where}.${key}`);
  }
};
walk(defs, "defs");

for (const token of ["button.container_", "button.drop_", "button.coalesce_stack", "button.shape_drawing"]) {
  assert.ok(!readText(DEFS).includes(token), `blocker must not route ${token}`);
}

// --- modifications --------------------------------------------------------

function assertPanelModifications(file, namespace, expectedPanels) {
  const mods = readJson(file);
  assert.deepEqual(
    Object.keys(mods).sort(),
    ["namespace", ...expandedPanels(expectedPanels)].sort(),
    `${path.basename(file)} must only modify the expected panels`,
  );
  assert.equal(mods.namespace, namespace);
  for (const { panel, labelRef, blockerRef, labelOffset, blockerGeometry } of expectedPanels) {
    const modifications = mods[panel].modifications;
    assert.ok(Array.isArray(modifications) && modifications.length === 1, `${panel} needs one modification`);
    const [change] = modifications;
    assert.equal(change.array_name, "controls");
    assert.equal(change.operation, "insert_back");
    assert.ok(Array.isArray(change.value) && change.value.length === 2, `${panel} must insert a label and the blocker`);
    const [, label] = Object.entries(change.value[0])[0];
    const [blockerName, blocker] = Object.entries(change.value[1])[0];
    assert.equal(Object.keys(change.value[0])[0].split("@")[1], labelRef);
    assert.equal(blockerName.split("@")[1], blockerRef);
    assert.deepEqual(label, { offset: labelOffset }, `${panel} label offset must sit outside the grid`);
    assert.deepEqual(blocker, blockerGeometry, `${panel} blocker geometry must match the vanilla grid`);
  }
}

function expandedPanels(panels) {
  return panels.map((panel) => panel.panel);
}

assertPanelModifications(CHEST_MODS, "chest", [
  {
    panel: "small_chest_panel_top_half",
    labelRef: "invui_protection.desktop_marker",
    blockerRef: "invui_protection.grid_blocker",
    labelOffset: [4, 66],
    blockerGeometry: {
      anchor_from: "top_left",
      anchor_to: "top_left",
      offset: [7, 9],
      size: [162, 54],
    },
  },
  {
    panel: "large_chest_panel_top_half",
    labelRef: "invui_protection.desktop_marker",
    blockerRef: "invui_protection.grid_blocker",
    labelOffset: [4, 120],
    blockerGeometry: {
      anchor_from: "top_left",
      anchor_to: "top_left",
      offset: [7, 10],
      size: [162, 108],
    },
  },
]);

assertPanelModifications(POCKET_MODS, "pocket_containers", [
  {
    panel: "panel",
    labelRef: "invui_protection.pocket_marker",
    blockerRef: "invui_protection.grid_blocker",
    labelOffset: [4, 4],
    blockerGeometry: {
      anchor_from: "top_middle",
      anchor_to: "top_left",
      offset: [0, 27],
      size: ["50%", "100%-27px"],
    },
  },
]);

// --- README safety / provenance -------------------------------------------

const readme = readText(README);
for (const phrase of [
  /未検証/,
  /未保証/,
  /使い捨てワールド/,
  /通常ワールド/,
  /通常のチェスト/,
  /通常のチェスト系画面にも作用/,
  /InputBridge/,
  /入力ブリッジ/,
  /クリック通知/,
  /保護を提供しない/,
  /false positive/i,
  /false negative/i,
  /陽性/,
  /陰性/,
  /中止/,
  /対象スロット/,
  /部分一致|スロット単位/,
  /button\.container_take_all_place_all/,
  /modal_window_input_blocker/,
  /common_background_blocker/,
  /container_slot_button_prototype/,
  /陽性対照/,
]) {
  assert.match(readme, phrase, `README must mention ${phrase}`);
}
for (const url of [
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chest_screen.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/pocket_containers.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/persona_popups.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/persona_cast_character_screen.json",
  "https://wiki.bedrock.dev/json-ui/json-ui-documentation",
  "../probe/README.md",
]) {
  assert.ok(readme.includes(url), `README must cite ${url}`);
}

console.log("OK: protection probe structure is valid");
