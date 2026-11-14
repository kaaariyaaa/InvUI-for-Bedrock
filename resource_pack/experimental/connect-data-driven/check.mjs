#!/usr/bin/env node
/*
 * Structure check for the data_driven_container screen connection.
 *
 * The connection is now enabled by default in the main pack, including a
 * transparent grid blocker. This checks that the connection files are well
 * formed, that they target the candidate panels, that they are registered in
 * the default ui/_ui_defs.json, and that the isolated copies here match the
 * copies in ui/. It cannot prove that the pack loads, that the UI appears,
 * that the blocker receives input, that items are protected, or that it only
 * affects VirtualContainer. Run:
 *   node resource_pack/experimental/connect-data-driven/check.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const experimentRoot = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(experimentRoot, "..", "..");
const baseUiDir = path.join(packRoot, "ui");
const expUiDir = path.join(experimentRoot, "ui");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const MANIFEST = path.join(packRoot, "manifest.json");
const DEFAULT_UI_DEFS = path.join(baseUiDir, "_ui_defs.json");
const BASE_PROBE = path.join(baseUiDir, "invui.json");
const OPT_IN_DEFS = path.join(experimentRoot, "_ui_defs.opt-in.json");
const CONNECT = path.join(expUiDir, "invui_connect.json");
const MODS = path.join(expUiDir, "invui_connect_data_driven.json");
const README = path.join(experimentRoot, "README.md");
const ROOT_README = path.resolve(packRoot, "..", "README.md");

for (const file of [MANIFEST, DEFAULT_UI_DEFS, BASE_PROBE, OPT_IN_DEFS, CONNECT, MODS, README, ROOT_README]) {
  assert.ok(fs.existsSync(file), `missing ${path.relative(packRoot, file)}`);
}

const manifest = readJson(MANIFEST);
assert.equal(manifest.format_version, 2);
assert.ok(
  manifest.modules.some((module) => module.type === "resources"),
  "manifest needs a resources module",
);
// The default manifest must not overstate the unverified blocker.
for (const phrase of [
  /grid blocker/i,
  /may also restrict buttons and inventory slots/i,
  /no guarantee/i,
  /player-side/i,
  /controller/i,
  /ALL screens/i,
  /not only VirtualContainer/i,
  /disposable world/i,
]) {
  assert.match(manifest.header.description, phrase, `manifest description must state ${phrase}`);
}

const CONNECT_FILES = [
  "ui/invui_connect.json",
  "ui/invui_connect_data_driven.json",
];
const OPT_IN_FILES = ["ui/invui.json", ...CONNECT_FILES];

// The connection is enabled by default in the main pack; all three files must
// be registered so the pack does not reference missing or partial UI defs.
const defaultDefs = readJson(DEFAULT_UI_DEFS).ui_defs;
assert.ok(Array.isArray(defaultDefs));
for (const entry of defaultDefs) {
  assert.ok(fs.existsSync(path.join(packRoot, entry)), `default ui_defs entry not found: ${entry}`);
}
assert.deepEqual(defaultDefs, OPT_IN_FILES, "default ui_defs must register the probe and both connection files");

for (const entry of CONNECT_FILES) {
  assert.deepEqual(
    readJson(path.join(packRoot, entry)),
    readJson(path.join(expUiDir, path.basename(entry))),
    `${entry} must match the isolated experimental copy`,
  );
}

const optInDefs = readJson(OPT_IN_DEFS).ui_defs;
assert.deepEqual(optInDefs, OPT_IN_FILES, "opt-in ui_defs must register the base probe and both opt-in files");
for (const entry of optInDefs) {
  assert.ok(fs.existsSync(path.join(packRoot, entry)), `opt-in ui_defs entry not found: ${entry}`);
}

const baseProbe = readJson(BASE_PROBE);
assert.equal(baseProbe.namespace, "invui_probe");
assert.ok(baseProbe.invui_probe_root, "base probe must define invui_probe_root");

const connect = readJson(CONNECT);
assert.equal(connect.namespace, "invui_connect_probe");
for (const [name, suffix] of [
  ["invui_connect_probe_desktop", "desktop"],
  ["invui_connect_probe_pocket", "pocket"],
]) {
  const marker = connect[name];
  assert.ok(marker, `missing ${name}`);
  assert.equal(marker.type, "panel");
  const controls = marker.controls ?? [];
  const label = controls.find((control) => control.all_screens_marker)?.all_screens_marker;
  assert.ok(label, `${name} must include an all_screens_marker label`);
  assert.equal(label.type, "label");
  assert.match(label.text, /ALL screens using this panel/);
  assert.match(label.text, /not only VirtualContainer/);
  assert.match(label.text, new RegExp(`data_driven_container\\.${suffix}`));
  assert.ok(
    controls.some((control) => Object.keys(control).some((key) => key.split("@")[1] === "invui_probe.invui_probe_root")),
    `${name} must reference the existing invui_probe.invui_probe_root`,
  );
  // The on-screen warning must repeat the limits of the blocker, not just
  // "all screens".
  const warning = controls.find((control) => control.blocker_warning_marker)?.blocker_warning_marker;
  assert.ok(warning, `${name} must include a blocker_warning_marker label`);
  assert.equal(warning.type, "label");
  assert.match(warning.text, /transparent grid blocker/i);
  assert.match(warning.text, /UNVERIFIED/);
  assert.match(warning.text, /inventory slots/i);
  assert.match(warning.text, /player-side\/controller/i);
  assert.match(warning.text, /NOT guaranteed/i);
}

// The blocker is an unverified attempt: it routes slot-style inputs to one
// custom no-op id. No container/drop/coalesce action may survive.
const blocker = connect.grid_blocker;
assert.ok(blocker, "connection definitions must include grid_blocker");
assert.equal(blocker.type, "button");
assert.deepEqual(blocker.size, ["100%", "100%"]);
assert.equal(blocker.layer, 10);
assert.equal(blocker.focus_enabled, true);
assert.equal(blocker.focus_wrap_enabled, false);
assert.equal(blocker.$pressed_button_name, "button.invui_connect_blocked");
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
const stateChildren = Object.fromEntries(
  blocker.controls.map((control) => Object.entries(control)[0]),
);
assert.deepEqual(Object.keys(stateChildren), ["default", "hover", "pressed"]);
for (const state of ["default", "hover", "pressed"]) {
  assert.equal(stateChildren[state].type, "image", `${state} must be an image`);
  assert.equal(stateChildren[state].texture, "textures/ui/white_background");
  assert.deepEqual(stateChildren[state].size, ["100%", "100%"]);
}
assert.equal(stateChildren.default.alpha, 0, "the blocker must stay invisible until touched");
for (const state of ["hover", "pressed"]) {
  assert.deepEqual(stateChildren[state].color, [1, 0, 0, 1], `${state} must tint red`);
  assert.ok(stateChildren[state].alpha > 0, `${state} must be visible`);
}
for (const token of ["button.container_", "button.drop_", "button.coalesce_stack", "button.shape_drawing"]) {
  assert.ok(!fs.readFileSync(CONNECT, "utf8").includes(token), `blocker must not route ${token}`);
}

const mods = readJson(MODS);
assert.equal(mods.namespace, "data_driven_container");

// The desktop probe label is attached to desktop_panel, but the grid blocker
// must live in panel_top_half. That panel is exactly the slot area (height
// 42..132px, item_grid at [7, 10] with 18px rows), so "100%-24px" tracks the
// grid height. Measured from desktop_panel's 166..220px root instead, the same
// string overshoots the slots.
const desktop = mods.desktop_panel;
assert.ok(desktop, "missing desktop_panel modifications");
assert.equal(desktop.modifications.length, 1, "desktop_panel must only add the probe; the blocker belongs to panel_top_half");
const [desktopProbe] = desktop.modifications;
assert.equal(desktopProbe.array_name, "controls");
assert.equal(desktopProbe.operation, "insert_front");
assert.equal(desktopProbe.value.length, 1, "desktop_panel must insert exactly one probe control");
assert.equal(
  Object.keys(desktopProbe.value[0])[0].split("@")[1],
  "invui_connect_probe.invui_connect_probe_desktop",
  "desktop_panel must reference invui_connect_probe.invui_connect_probe_desktop",
);

const topHalf = mods.panel_top_half;
assert.ok(topHalf, "missing panel_top_half modifications: the desktop blocker must cover the slot grid, not desktop_panel");
assert.equal(topHalf.modifications.length, 1, "panel_top_half must add only the blocker");
const [topHalfBlocker] = topHalf.modifications;
assert.equal(topHalfBlocker.array_name, "controls");
assert.equal(topHalfBlocker.operation, "insert_back", "desktop blocker must render above the slots");
assert.equal(topHalfBlocker.value.length, 1, "panel_top_half must insert exactly one blocker");
{
  const [blockerName, blockerOverrides] = Object.entries(topHalfBlocker.value[0])[0];
  assert.equal(blockerName.split("@")[1], "invui_connect_probe.grid_blocker", "panel_top_half must reuse grid_blocker");
  assert.deepEqual(
    blockerOverrides,
    {
      anchor_from: "top_left",
      anchor_to: "top_left",
      offset: [7, 10],
      size: [162, "100%-24px"],
    },
    "panel_top_half blocker geometry changed",
  );
}

const pocket = mods.pocket_panel;
assert.ok(pocket, "missing pocket_panel modifications");
assert.equal(pocket.modifications.length, 2, "pocket_panel must add the probe panel and the blocker");
const [pocketProbe, pocketBlocker] = pocket.modifications;
assert.equal(pocketProbe.array_name, "controls");
assert.equal(pocketProbe.operation, "insert_front");
assert.equal(pocketProbe.value.length, 1, "pocket_panel must insert exactly one probe control");
assert.equal(
  Object.keys(pocketProbe.value[0])[0].split("@")[1],
  "invui_connect_probe.invui_connect_probe_pocket",
  "pocket_panel must reference invui_connect_probe.invui_connect_probe_pocket",
);
assert.equal(pocketBlocker.array_name, "controls");
assert.equal(pocketBlocker.operation, "insert_back", "pocket blocker must render above the slots");
assert.equal(pocketBlocker.value.length, 1, "pocket_panel must insert exactly one blocker");
{
  const [blockerName, blockerOverrides] = Object.entries(pocketBlocker.value[0])[0];
  assert.equal(blockerName.split("@")[1], "invui_connect_probe.grid_blocker", "pocket_panel must reuse grid_blocker");
  assert.deepEqual(
    blockerOverrides,
    {
      anchor_from: "top_middle",
      anchor_to: "top_left",
      offset: [0, 27],
      size: ["50%", "100%-27px"],
    },
    "pocket_panel blocker geometry changed",
  );
}

// This experiment must not target chest_screen; it cannot identify
// VirtualContainer and only connects to the data_driven_container panels.
for (const file of fs.readdirSync(expUiDir)) {
  assert.ok(!file.includes("chest_screen"), `unexpected chest_screen file: ${file}`);
  const json = readJson(path.join(expUiDir, file));
  assert.notEqual(json.namespace, "chest_screen", `${file} must not modify chest_screen`);
}

const readme = fs.readFileSync(README, "utf8");
for (const phrase of [
  "使い捨てワールド",
  "既定で有効",
  "全画面",
  "VirtualContainer を特定できない",
  "panel_top_half",
]) {
  assert.ok(readme.includes(phrase), `README must state: ${phrase}`);
}
assert.ok(
  !readme.includes("ブロッカーは `desktop_panel` では"),
  "README must not measure the desktop blocker from desktop_panel",
);

// The top-level README is the first place a reader sees this default-on
// connection; it must repeat every limit rather than call the blocker
// "protection".
const rootReadme = fs.readFileSync(ROOT_README, "utf8");
for (const phrase of [
  "透明ブロッカー",
  "ボタンや inventory slot",
  "プレイヤー側",
  "controller",
  "遮断を保証しません",
  "VirtualContainer 画面を使っているかは未確定",
  "他の画面",
  "実機未検証",
  "使い捨てワールド",
]) {
  assert.ok(rootReadme.includes(phrase), `README.md must state: ${phrase}`);
}

console.log("OK: connection is structurally valid, matches the isolated copy, and is registered in the default pack (blocker included, protection unverified)");
