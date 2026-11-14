#!/usr/bin/env node
/*
 * Structure check for the edit_box + button.send experiment pack.
 *
 * This only proves the JSON is well formed and internally consistent. It
 * cannot prove the pack loads, that the edit box accepts typed text, that the
 * button emits button.send, that the typed text is sent, or that the probe
 * behavior pack logs it. Run:
 *   node tests/manual-bedrock/edit-box-resource-pack/check.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "../../..");
const uiDir = path.join(root, "ui");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readText = (file) => fs.readFileSync(file, "utf8");

const MANIFEST = path.join(root, "manifest.json");
const UI_DEFS = path.join(uiDir, "_ui_defs.json");
const DEFS = path.join(uiDir, "invui_edit_box.json");
const CHEST_MODS = path.join(uiDir, "invui_edit_box_chest.json");
const POCKET_MODS = path.join(uiDir, "invui_edit_box_pocket.json");
const README = path.join(root, "README.md");
const PROBE_SCRIPT = path.join(repoRoot, "tests/manual-bedrock/probe/behavior_pack/scripts/main.js");

for (const file of [MANIFEST, UI_DEFS, DEFS, CHEST_MODS, POCKET_MODS, README, PROBE_SCRIPT]) {
  assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)}`);
}

// --- manifest -------------------------------------------------------------

const manifest = readJson(MANIFEST);
assert.equal(manifest.format_version, 2);
assert.deepEqual(manifest.header.min_engine_version, [1, 26, 70]);
assert.match(manifest.header.uuid, /^[0-9a-f-]{36}$/);
assert.match(manifest.header.name, /DISPOSABLE WORLD ONLY/);
assert.match(manifest.header.description, /Unverified/);
assert.match(manifest.header.description, /manually typed text field/);
assert.match(manifest.header.description, /Fixed text auto-send and script wiring are NOT provided/);
assert.match(manifest.header.description, /No interaction control/);
assert.match(manifest.header.description, /no item protection/i);
assert.match(manifest.header.description, /disposable world/i);
assert.match(manifest.header.description, /No guarantee/i);
assert.match(manifest.header.description, /chat may be affected/i);

const modules = manifest.modules || [];
assert.equal(modules.length, 1, "manifest needs exactly one module");
assert.equal(modules[0].type, "resources", "this pack must stay resource-only");
assert.match(modules[0].uuid, /^[0-9a-f-]{36}$/);
assert.notEqual(modules[0].uuid, manifest.header.uuid, "module/header UUIDs must differ");

// --- pack contents --------------------------------------------------------

assert.deepEqual(
  fs.readdirSync(uiDir).sort(),
  ["_ui_defs.json", "invui_edit_box.json", "invui_edit_box_chest.json", "invui_edit_box_pocket.json"],
  "unexpected file in ui/",
);
assert.ok(
  !fs.existsSync(path.join(uiDir, "chest_screen.json")),
  "probe must not ship or overwrite ui/chest_screen.json",
);

const uiDefs = readJson(UI_DEFS).ui_defs;
assert.ok(Array.isArray(uiDefs) && uiDefs.length === 3);
for (const entry of uiDefs) {
  assert.ok(fs.existsSync(path.join(root, entry)), `ui_defs entry not found: ${entry}`);
  assert.ok(!entry.includes("chest_screen.json"), "probe must not register a chest_screen.json file");
}

// --- definitions ----------------------------------------------------------

const defs = readJson(DEFS);
assert.equal(defs.namespace, "invui_edit_box");
assert.deepEqual(
  Object.keys(defs).filter((key) => key !== "namespace").sort(),
  [
    "desktop_positive_control",
    "message_text_box@common.text_edit_box",
    "pocket_positive_control",
    "send_button",
  ],
  "definitions must contain only the two labels, the edit box and the button",
);

for (const [name, system, layer] of [
  ["desktop_positive_control", "desktop", 100],
  ["pocket_positive_control", "pocket", 100],
]) {
  const label = defs[name];
  assert.equal(label.type, "label", `${name} must stay a plain label`);
  assert.match(label.text, /^POSITIVE CONTROL: edit_box probe /);
  assert.ok(label.text.includes(`(${system})`), `${name} text must name the ${system} system`);
  assert.equal(label.layer, layer);
  assert.equal(label.anchor_from, "top_left");
  assert.equal(label.anchor_to, "top_left");
}

// The edit box must reuse the chat-screen text box identity and nothing more:
// no initial text, no own bindings, no collection.
const editBox = defs["message_text_box@common.text_edit_box"];
assert.ok(editBox, "the edit box must inherit common.text_edit_box");
assert.equal(editBox.type, undefined, "the inherited edit box must not redefine its type");
assert.equal(editBox.$text_box_name, "#message_text_box", "must reuse the chat text box name");
assert.equal(
  editBox.$text_edit_box_content_binding_name,
  "#message_text_box_content",
  "must reuse the chat content binding",
);
assert.equal(editBox.always_listening, true, "must reuse the chat always_listening setting");
assert.equal(editBox.max_length, 64);
assert.equal(editBox.$focus_id, "invui_edit_box_probe_focus_id");
assert.deepEqual(editBox.size, [200, 20]);
assert.deepEqual(editBox.offset, [4, 22]);
assert.equal(editBox.anchor_from, "top_left");
assert.equal(editBox.anchor_to, "top_left");
assert.ok(editBox.layer > defs.desktop_positive_control.layer, "the edit box must stay above the labels");

// No fixed text / automatic send: the pack must not ship a pre-filled value or
// its own bindings on the edit box.
for (const forbidden of ["text", "bindings", "binding_name", "binding_name_override", "collection_name", "enabled"]) {
  assert.ok(!(forbidden in editBox), `edit box must not define ${forbidden} (manual typing only)`);
}
assert.ok(
  !JSON.stringify(editBox).includes("!invui:"),
  "the edit box must not pre-fill a notification string",
);

// The button must emit the vanilla chat-screen action id and nothing else.
const button = defs.send_button;
assert.equal(button.type, "button");
assert.equal(button.$pressed_button_name, "button.send");
assert.equal(button.sound_name, "random.click");
assert.deepEqual(button.size, [200, 20]);
assert.deepEqual(button.offset, [4, 46]);
assert.equal(button.anchor_from, "top_left");
assert.equal(button.anchor_to, "top_left");
assert.ok(button.layer > editBox.layer, "the button must stay above the edit box");

assert.deepEqual(
  button.button_mappings,
  [
    {
      from_button_id: "button.menu_select",
      to_button_id: "$pressed_button_name",
      mapping_type: "pressed",
    },
    {
      from_button_id: "button.menu_ok",
      to_button_id: "$pressed_button_name",
      mapping_type: "focused",
    },
  ],
  "the button must only map select/ok onto its own $pressed_button_name",
);

assert.deepEqual(
  button.controls.map((control) => Object.keys(control)[0]).sort(),
  ["default", "hover", "label", "pressed"],
  "the button must only carry state images and a label",
);
const stateChildren = Object.fromEntries(button.controls.map((control) => Object.entries(control)[0]));
for (const state of ["default", "hover", "pressed"]) {
  assert.equal(stateChildren[state].type, "image", `${state} must be an image`);
  assert.match(stateChildren[state].texture, /^textures\/ui\/button_borderless_light/);
}
assert.equal(stateChildren.label.type, "label");
assert.match(stateChildren.label.text, /unverified/i);
assert.equal(button.default_control, "default");
assert.equal(button.hover_control, "hover");
assert.equal(button.pressed_control, "pressed");

// No other input controls, bindings or collections may sneak into the pack.
const forbiddenTypes = new Set([
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
]);
const forbiddenKeys = new Set([
  "bindings",
  "binding_name",
  "binding_name_override",
  "binding_type",
  "collection_name",
  "collection_index",
  "grid_dimensions",
  "items",
  "modifications",
]);
let pressedNameCount = 0;
let mappingCount = 0;
const walk = (value, where) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.has(key), `unexpected interaction key ${key} at ${where}`);
    if (key === "$pressed_button_name") {
      pressedNameCount += 1;
      assert.equal(entry, "button.send", `unexpected $pressed_button_name at ${where}`);
    }
    if (key === "button_mappings") mappingCount += 1;
    if (key === "type") {
      assert.ok(!forbiddenTypes.has(entry), `unexpected control type ${entry} at ${where}`);
    }
    walk(entry, `${where}.${key}`);
  }
};
walk(defs, "defs");
assert.equal(pressedNameCount, 1, "exactly one control may emit a button id");
assert.equal(mappingCount, 1, "exactly one control may declare button mappings");

// --- modifications --------------------------------------------------------

function assertPanelModifications(file, namespace, labelRef, panels) {
  const mods = readJson(file);
  assert.deepEqual(
    Object.keys(mods).sort(),
    ["namespace", ...panels].sort(),
    `${file} must only modify the expected panels`,
  );
  assert.equal(mods.namespace, namespace);
  for (const panel of panels) {
    const modifications = mods[panel].modifications;
    assert.ok(Array.isArray(modifications) && modifications.length === 1, `${panel} needs one modification`);
    const [change] = modifications;
    assert.equal(change.array_name, "controls");
    assert.equal(change.operation, "insert_front");
    assert.ok(Array.isArray(change.value) && change.value.length === 3, `${panel} must insert a label, an edit box and a button`);
    const refs = change.value.map((control) => Object.keys(control)[0].split("@")[1]);
    assert.deepEqual(
      refs,
      [labelRef, "invui_edit_box.message_text_box", "invui_edit_box.send_button"],
      `${panel} must insert label, edit box, then button`,
    );
  }
}

assertPanelModifications(CHEST_MODS, "chest", "invui_edit_box.desktop_positive_control", [
  "small_chest_panel",
  "large_chest_panel",
]);
assertPanelModifications(POCKET_MODS, "pocket_containers", "invui_edit_box.pocket_positive_control", [
  "small_chest_panel",
  "large_chest_panel",
]);

// --- probe pack premise ---------------------------------------------------

// The RP is only meaningful next to the probe behavior pack. Fail if the
// probe no longer watches the prefix this pack documents.
const probeScript = readText(PROBE_SCRIPT);
assert.match(probeScript, /NOTIFY_PREFIX\s*=\s*"!invui:"/, "probe must still watch the !invui: prefix");
assert.match(probeScript, /NOTIFY_OBSERVED/, "probe must still log NOTIFY_OBSERVED");

// --- README safety / provenance -------------------------------------------

const readme = readText(README);
for (const phrase of [
  /未検証/,
  /使い捨てワールド/,
  /通常のチェスト/,
  /チャット操作/,
  /偽装/,
  /保証/,
  /操作抑制/,
  /アイテム保護/,
  /固定文字/,
  /Script 接続/,
  /陽性対照/,
  /陰性/,
  /中止/,
  /!invui:/,
  /button\.send/,
  /edit_box/,
  /#message_text_box/,
  /別試験/,
  /probe/,
]) {
  assert.match(readme, phrase, `README must mention ${phrase}`);
}
for (const url of [
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chest_screen.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_template_buttons.json",
  "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chat_screen.json",
  "https://wiki.bedrock.dev/json-ui/json-ui-documentation",
]) {
  assert.ok(readme.includes(url), `README must cite ${url}`);
}

console.log("OK: edit_box + button.send experiment structure is valid");
