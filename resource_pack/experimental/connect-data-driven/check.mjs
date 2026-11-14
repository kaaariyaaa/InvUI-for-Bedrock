#!/usr/bin/env node
/*
 * Structure check for the data_driven_container screen connection.
 *
 * The connection is now enabled by default in the main pack. This checks that
 * the connection files are well formed, that they target the candidate panels,
 * that they are registered in the default ui/_ui_defs.json, and that the
 * isolated copies here match the copies in ui/. It cannot prove that the pack
 * loads, that the UI appears, or that it only affects VirtualContainer. Run:
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

for (const file of [MANIFEST, DEFAULT_UI_DEFS, BASE_PROBE, OPT_IN_DEFS, CONNECT, MODS, README]) {
  assert.ok(fs.existsSync(file), `missing ${path.relative(packRoot, file)}`);
}

const manifest = readJson(MANIFEST);
assert.equal(manifest.format_version, 2);
assert.ok(
  manifest.modules.some((module) => module.type === "resources"),
  "manifest needs a resources module",
);

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
}

const mods = readJson(MODS);
assert.equal(mods.namespace, "data_driven_container");
for (const [panel, target] of [
  ["desktop_panel", "invui_connect_probe.invui_connect_probe_desktop"],
  ["pocket_panel", "invui_connect_probe.invui_connect_probe_pocket"],
]) {
  const mod = mods[panel];
  assert.ok(mod, `missing ${panel} modifications`);
  assert.equal(mod.modifications.length, 1, `${panel} must have exactly one modification`);
  const [change] = mod.modifications;
  assert.equal(change.array_name, "controls");
  assert.equal(change.operation, "insert_front");
  assert.equal(change.value.length, 1, `${panel} must insert exactly one control`);
  const [control] = change.value;
  const [controlName] = Object.keys(control);
  assert.equal(controlName.split("@")[1], target, `${panel} must reference ${target}`);
}

// This experiment must not target chest_screen; it cannot identify
// VirtualContainer and only connects to the data_driven_container panels.
for (const file of fs.readdirSync(expUiDir)) {
  assert.ok(!file.includes("chest_screen"), `unexpected chest_screen file: ${file}`);
  const json = readJson(path.join(expUiDir, file));
  assert.notEqual(json.namespace, "chest_screen", `${file} must not modify chest_screen`);
}

const readme = fs.readFileSync(README, "utf8");
for (const phrase of ["使い捨てワールド", "既定で有効", "全画面", "VirtualContainer を特定できない"]) {
  assert.ok(readme.includes(phrase), `README must state: ${phrase}`);
}

console.log("OK: connection is structurally valid, matches the isolated copy, and is registered in the default pack");
