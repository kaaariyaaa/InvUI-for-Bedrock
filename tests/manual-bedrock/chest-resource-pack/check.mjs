#!/usr/bin/env node
/*
 * Structure check for the chest screen marker probe pack.
 *
 * This only proves the JSON is well formed and internally consistent. It
 * cannot prove the pack loads, that a label is visible, or that
 * VirtualContainer uses the chest screen. Run:
 *   node tests/manual-bedrock/chest-resource-pack/check.mjs
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
const PROBE = path.join(uiDir, "invui_probe.json");
const CHEST_MODS = path.join(uiDir, "invui_probe_chest.json");
const POCKET_MODS = path.join(uiDir, "invui_probe_pocket.json");
const README = path.join(root, "README.md");

for (const file of [MANIFEST, UI_DEFS, PROBE, CHEST_MODS, POCKET_MODS, README]) {
  assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)}`);
}

// --- manifest -------------------------------------------------------------

const manifest = readJson(MANIFEST);
assert.equal(manifest.format_version, 2);
assert.deepEqual(manifest.header.min_engine_version, [1, 26, 70]);
assert.match(manifest.header.uuid, /^[0-9a-f-]{36}$/);
assert.match(manifest.header.name, /DISPOSABLE WORLD ONLY/);
assert.match(manifest.header.description, /Unverified/);
assert.match(manifest.header.description, /No interaction control/);
assert.match(manifest.header.description, /no item protection/i);
assert.match(manifest.header.description, /disposable world/i);

const resourcesModules = (manifest.modules || []).filter((m) => m.type === "resources");
assert.equal(resourcesModules.length, 1, "manifest needs exactly one resources module");
assert.match(resourcesModules[0].uuid, /^[0-9a-f-]{36}$/);
assert.notEqual(resourcesModules[0].uuid, manifest.header.uuid, "module/header UUIDs must differ");

// --- pack contents --------------------------------------------------------

const uiFiles = fs.readdirSync(uiDir).sort();
assert.deepEqual(
  uiFiles,
  ["_ui_defs.json", "invui_probe.json", "invui_probe_chest.json", "invui_probe_pocket.json"],
  "unexpected file in ui/",
);
assert.ok(
  !fs.existsSync(path.join(uiDir, "chest_screen.json")),
  "probe must not ship or overwrite ui/chest_screen.json",
);

// --- ui/_ui_defs.json -----------------------------------------------------

const uiDefs = readJson(UI_DEFS).ui_defs;
assert.ok(Array.isArray(uiDefs) && uiDefs.length === 3);
for (const entry of uiDefs) {
  assert.ok(fs.existsSync(path.join(root, entry)), `ui_defs entry not found: ${entry}`);
  assert.ok(!entry.includes("chest_screen.json"), "probe must not register a chest_screen.json file");
}

// --- marker definitions ---------------------------------------------------

const probe = readJson(PROBE);
assert.equal(probe.namespace, "invui_probe");
for (const name of ["desktop_marker", "pocket_marker"]) {
  const marker = probe[name];
  assert.ok(marker, `missing ${name}`);
  assert.equal(marker.type, "label", `${name} must stay a plain label`);
  assert.match(marker.text, /^InvUI probe: chest UI \(/, `${name} text must name the chest UI`);
  assert.ok(marker.layer >= 1);
  assert.equal(marker.anchor_from, "top_left");
  assert.equal(marker.anchor_to, "top_left");
}

// The title marker reuses the screen variable that the chest panels already
// render in their own title labels. It lets the player tie this panel to the
// opened container (the raw probe opens with a distinctive title) instead of
// only proving "a chest panel is in use". No new binding is invented.
const titleMarker = probe.title_marker;
assert.ok(titleMarker, "missing title_marker");
assert.equal(titleMarker.type, "label");
assert.equal(titleMarker.text, "$container_title", "the title marker must read the existing $container_title variable");
assert.equal(titleMarker.layer, 100);
for (const forbidden of ["bindings", "collection_name", "binding_name", "binding_name_override"]) {
  assert.ok(!(forbidden in titleMarker), `title_marker must not define ${forbidden}`);
}

// The probe is deliberately observation-only: no button, input, binding, or
// item manipulation controls. Crash the check if any appear.
const forbiddenTypes = new Set(["button", "input", "toggle", "slider_box", "edit_box"]);
const forbiddenKeys = new Set(["button_mappings", "bindings", "$pressed_button_name", "collection_name"]);
const walk = (value, where) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.has(key), `unexpected interaction key ${key} at ${where}`);
    if (key === "type") {
      assert.ok(!forbiddenTypes.has(entry), `unexpected interaction control type ${entry} at ${where}`);
    }
    walk(entry, `${where}.${key}`);
  }
};
walk(probe, "probe");

// --- modifications --------------------------------------------------------

function assertPanelModifications(file, namespace, markerRef, panels) {
  const mods = readJson(file);
  const topLevel = Object.keys(mods).sort();
  assert.deepEqual(topLevel, ["namespace", ...panels].sort(), `${file} must only modify the expected panels`);
  assert.equal(mods.namespace, namespace);
  for (const panel of panels) {
    const modifications = mods[panel].modifications;
    assert.ok(Array.isArray(modifications) && modifications.length === 1, `${panel} needs one modification`);
    const [change] = modifications;
    assert.equal(change.array_name, "controls");
    assert.equal(change.operation, "insert_front");
    assert.ok(Array.isArray(change.value) && change.value.length === 2, `${panel} must insert the marker and the title marker`);
    const [markerName, markerOverrides] = Object.entries(change.value[0])[0];
    assert.equal(markerName.split("@")[1], markerRef, `${panel} must reference ${markerRef}`);
    assert.deepEqual(markerOverrides, {}, `${panel} marker must not override the definition`);
    const [titleName, titleOverrides] = Object.entries(change.value[1])[0];
    assert.equal(titleName.split("@")[1], "invui_probe.title_marker", `${panel} must reference invui_probe.title_marker`);
    assert.deepEqual(titleOverrides, {}, `${panel} title marker must not override the definition`);
  }
}

assertPanelModifications(CHEST_MODS, "chest", "invui_probe.desktop_marker", [
  "small_chest_panel",
  "large_chest_panel",
]);
assertPanelModifications(POCKET_MODS, "pocket_containers", "invui_probe.pocket_marker", [
  "small_chest_panel",
  "large_chest_panel",
]);

// --- README safety / provenance -------------------------------------------

const readme = readText(README);
for (const phrase of [
  /未検証/,
  /使い捨てワールド/,
  /通常のチェスト/,
  /保護/,
  /入力/,
  /断定/,
  /陰性/,
  /別試験/,
  /data-driven-resource-pack/,
  /\$container_title/,
  /title_marker/,
  /InvUI probe 27/,
]) {
  assert.match(readme, phrase, `README must mention ${phrase}`);
}
assert.match(
  readme,
  /https:\/\/github\.com\/Mojang\/bedrock-samples\/blob\/v1\.26\.70\.23-preview\/resource_pack\/ui\/chest_screen\.json/,
  "README must cite the official chest_screen.json source",
);
assert.match(
  readme,
  /https:\/\/github\.com\/Mojang\/bedrock-samples\/blob\/v1\.26\.70\.23-preview\/resource_pack\/ui\/pocket_containers\.json/,
  "README must cite the official pocket_containers.json source",
);

console.log("OK: chest screen marker probe structure is valid");
