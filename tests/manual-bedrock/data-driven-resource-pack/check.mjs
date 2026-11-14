#!/usr/bin/env node
/*
 * Structure check for the data_driven_container screen probe pack.
 *
 * This only proves the JSON is well formed and internally consistent. It
 * cannot prove the pack loads or that the label shows in-game. Run:
 *   node tests/manual-bedrock/data-driven-resource-pack/check.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(root, "ui");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const MANIFEST = path.join(root, "manifest.json");
const UI_DEFS = path.join(uiDir, "_ui_defs.json");
const PROBE = path.join(uiDir, "invui_probe.json");
const MODS = path.join(uiDir, "invui_probe_data_driven.json");

for (const file of [MANIFEST, UI_DEFS, PROBE, MODS]) {
  assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)}`);
}

const manifest = readJson(MANIFEST);
assert.equal(manifest.format_version, 2);
assert.deepEqual(manifest.header.min_engine_version, [1, 26, 70]);
assert.match(manifest.header.uuid, /^[0-9a-f-]{36}$/);
assert.ok(
  manifest.modules.some((m) => m.type === "resources"),
  "manifest needs a resources module",
);

const uiDefs = readJson(UI_DEFS).ui_defs;
assert.ok(Array.isArray(uiDefs) && uiDefs.length > 0);
for (const entry of uiDefs) {
  assert.ok(fs.existsSync(path.join(root, entry)), `ui_defs entry not found: ${entry}`);
  assert.ok(!entry.includes("chest_screen"), "probe must not register chest_screen");
}

const probe = readJson(PROBE);
assert.equal(probe.namespace, "invui_probe");
for (const [name, suffix] of [
  ["desktop_marker", "desktop"],
  ["pocket_marker", "pocket"],
]) {
  const marker = probe[name];
  assert.equal(marker.type, "label", `${name} must be a label`);
  assert.match(marker.text, /InvUI probe: data_driven_container\./, `${name} text`);
  assert.ok(marker.text.endsWith(`.${suffix}`), `${name} text must name its panel`);
  assert.ok(marker.layer >= 1);
}

// The title marker reuses the screen variable that the candidate panels already
// render in their own title labels. It lets the player tie this panel to the
// opened container (the raw probe opens with a distinctive title) instead of
// only proving "some screen uses this panel". No new binding is invented.
const titleMarker = probe.title_marker;
assert.ok(titleMarker, "missing title_marker");
assert.equal(titleMarker.type, "label");
assert.equal(titleMarker.text, "$container_title", "the title marker must read the existing $container_title variable");
assert.equal(titleMarker.layer, 100);
for (const forbidden of ["bindings", "collection_name", "binding_name", "binding_name_override"]) {
  assert.ok(!(forbidden in titleMarker), `title_marker must not define ${forbidden}`);
}

const mods = readJson(MODS);
assert.equal(mods.namespace, "data_driven_container");
for (const [panel, marker, title] of [
  ["desktop_panel", "invui_probe.desktop_marker", "invui_probe.title_marker"],
  ["pocket_panel", "invui_probe.pocket_marker", "invui_probe.title_marker"],
]) {
  const mod = mods[panel];
  assert.ok(mod, `missing ${panel} modifications`);
  assert.equal(mod.modifications.length, 1);
  const [change] = mod.modifications;
  assert.equal(change.array_name, "controls");
  assert.equal(change.operation, "insert_front");
  assert.equal(change.value.length, 2, `${panel} must insert the marker and the title marker`);
  const [markerName, markerOverrides] = Object.entries(change.value[0])[0];
  assert.equal(markerName.split("@")[1], marker, `${panel} must reference ${marker}`);
  assert.deepEqual(markerOverrides, {}, `${panel} marker must not override the definition`);
  const [titleName, titleOverrides] = Object.entries(change.value[1])[0];
  assert.equal(titleName.split("@")[1], title, `${panel} must reference ${title}`);
  assert.deepEqual(titleOverrides, {}, `${panel} title marker must not override the definition`);
}

// Vanilla chest_screen is deliberately untouched: not registered and not declared.
for (const file of fs.readdirSync(uiDir)) {
  assert.ok(!file.includes("chest_screen"), `unexpected chest_screen file: ${file}`);
  const json = readJson(path.join(uiDir, file));
  assert.notEqual(json.namespace, "chest_screen", `${file} must not modify chest_screen`);
}

// The prose must explain how the title marker is read and must keep the
// in-game title binding marked as unverified.
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
for (const phrase of ["$container_title", "title_marker", "InvUI probe 27", "実機未検証"]) {
  assert.ok(readme.includes(phrase), `README must mention ${phrase}`);
}

console.log("OK: probe pack structure is valid");
