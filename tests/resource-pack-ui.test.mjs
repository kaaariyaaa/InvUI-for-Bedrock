#!/usr/bin/env node
/*
 * Structure check for the opt-in manual chat-payload probe in resource_pack/ui.
 *
 * The probe only reproduces the chat screen's evidenced text box identity and
 * `button.send`, so a player can type a fixed notification by hand. It does NOT
 * generate slot/session/sequence values: official samples and the Bedrock Wiki
 * provide no JSON UI binding that writes chat text or passes UI values to a
 * script. This test locks that boundary in place.
 *
 * It cannot prove that the pack loads, that the edit box accepts typing, that
 * `button.send` sends, or that the bridge receives a notification.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(repoRoot, "resource_pack", "ui");
const packReadmePath = path.join(repoRoot, "resource_pack", "README.md");
const rootReadmePath = path.join(repoRoot, "README.md");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readText = (file) => fs.readFileSync(file, "utf8");

const DEFS_PATH = path.join(uiDir, "invui_controls.json");
const MODS_PATH = path.join(uiDir, "invui_controls_data_driven.json");
const UI_DEFS_PATH = path.join(uiDir, "_ui_defs.json");
const STATIC_EXAMPLE = "!invui:<session-id>:<slot>:<sequence>";
const SESSION_GETTER = "Window._inputSessionId";

test("the manual payload probe stays opt-in and out of the default connection", () => {
  const uiDefs = readJson(UI_DEFS_PATH).ui_defs;
  assert.deepEqual(
    uiDefs,
    ["ui/invui.json", "ui/invui_connect.json", "ui/invui_connect_data_driven.json"],
    "the manual probe must not be registered by default: it captures keyboard/text input",
  );
  assert.ok(!uiDefs.some((entry) => entry.includes("invui_controls")), "ui_defs must not register the probe");
  assert.ok(fs.existsSync(DEFS_PATH), "missing ui/invui_controls.json");
  assert.ok(fs.existsSync(MODS_PATH), "missing ui/invui_controls_data_driven.json");
});

test("the text input reuses only the evidenced chat-screen identity", () => {
  const defs = readJson(DEFS_PATH);
  assert.equal(defs.namespace, "invui_controls_probe");

  const entries = Object.entries(defs).filter(([name]) => name !== "namespace");
  const textInputEntry = entries.find(([name]) => name.endsWith("@common.text_edit_box"));
  assert.ok(textInputEntry, "the text input must inherit common.text_edit_box");
  const textInput = textInputEntry[1];

  // These three values are copied from ui/chat_screen.json. The definition name
  // is arbitrary; the inherited type comes from common.text_edit_box.
  assert.equal(textInput.$text_box_name, "#message_text_box");
  assert.equal(textInput.$text_edit_box_content_binding_name, "#message_text_box_content");
  assert.equal(textInput.always_listening, true);
  assert.equal(textInput.max_length, 64);
  assert.equal(textInput.$focus_id, "invui_controls_probe_focus_id");
  // The notification names the per-open session id, not `window-N`. The probe
  // cannot resolve it, so the example stays a placeholder a player replaces.
  assert.equal(textInput.$place_holder_text, STATIC_EXAMPLE);

  // No invented content injection: the edit box content is supplied by the
  // chat screen's hardcoded binding, not by JSON UI.
  for (const forbidden of [
    "text",
    "bindings",
    "binding_name",
    "binding_name_override",
    "binding_type",
    "collection_name",
    "collection_index",
    "enabled",
  ]) {
    assert.ok(!(forbidden in textInput), `text input must not define ${forbidden}`);
  }

  const root = defs.invui_controls_probe_root;
  assert.ok(root, "missing invui_controls_probe_root");
  assert.equal(root.type, "panel");
  const rootText = JSON.stringify(root);
  assert.ok(rootText.includes("invui_controls_probe_text_input"), "root panel must reference the text input");
  assert.ok(
    Object.keys(root).length > 0 && JSON.stringify(root.controls).includes(STATIC_EXAMPLE),
    "root must show the placeholder payload",
  );
  assert.match(rootText, /manual typing only/i);
  assert.match(rootText, /No automatic payload/i);
  assert.match(rootText, /Unverified/i);
});

test("the send button only emits button.send and the acquisition mappings", () => {
  const defs = readJson(DEFS_PATH);
  const buttonEntry = Object.entries(defs).find(([name]) => name.includes("send_button"));
  assert.ok(buttonEntry, "missing send button definition");
  const button = buttonEntry[1];

  assert.equal(button.type, "button");
  assert.equal(button.$pressed_button_name, "button.send");
  assert.deepEqual(button.button_mappings, [
    { from_button_id: "button.menu_select", to_button_id: "$pressed_button_name", mapping_type: "pressed" },
    { from_button_id: "button.menu_ok", to_button_id: "$pressed_button_name", mapping_type: "focused" },
  ]);
  assert.deepEqual(
    button.controls.map((control) => Object.keys(control)[0]).sort(),
    ["default", "hover", "label", "pressed"],
  );
  assert.equal(button.default_control, "default");
  assert.equal(button.hover_control, "hover");
  assert.equal(button.pressed_control, "pressed");

  const json = JSON.stringify(defs);
  assert.equal(
    (json.match(/"\$pressed_button_name":/g) || []).length,
    1,
    "exactly one control may define a pressed button name",
  );
  assert.equal((json.match(/"button_mappings"/g) || []).length, 1, "exactly one control may declare mappings");
  assert.equal((json.match(/button\.send/g) || []).length, 1, "button.send must appear once");
});

test("no fabricated slot/session/sequence bindings or payload writers", () => {
  // JSON UI cannot write the chat text box content, bind script values, or pass
  // arguments through a button id. Reject the tempting fake bindings instead of
  // letting them look like a solution.
  const forbiddenBindings = [
    "#collection_index",
    "#slot_index",
    "#session_id",
    "#window_id",
    "#sequence",
    "#invui_",
    "#message_text_box_text",
  ];
  const defsText = readText(DEFS_PATH);
  const modsText = readText(MODS_PATH);
  for (const token of forbiddenBindings) {
    assert.ok(!defsText.includes(token), `invented binding ${token} must not appear in the probe`);
    assert.ok(!modsText.includes(token), `invented binding ${token} must not appear in the connection`);
  }
  assert.ok(!defsText.includes('"bindings"'), "the probe must not define bindings");
  assert.ok(!defsText.includes("collection_name"), "the probe must not use a collection");
  assert.ok(!defsText.includes('"text_box_name"'), "only the inherited $text_box_name may be used");
  assert.ok(!defsText.includes("text_edit_box_content_binding_type"), "must keep the chat default binding type");
});

test("the connection only targets the candidate data-driven panels", () => {
  const mods = readJson(MODS_PATH);
  assert.equal(mods.namespace, "data_driven_container");
  assert.deepEqual(Object.keys(mods).sort(), ["desktop_panel", "namespace", "pocket_panel"]);

  for (const panel of ["desktop_panel", "pocket_panel"]) {
    const modifications = mods[panel].modifications;
    assert.ok(Array.isArray(modifications) && modifications.length === 1, `${panel} needs one modification`);
    const [change] = modifications;
    assert.equal(change.array_name, "controls");
    assert.equal(change.operation, "insert_front");
    assert.deepEqual(change.value, [
      { "invui_controls_probe_root@invui_controls_probe.invui_controls_probe_root": {} },
    ]);
  }
});

test("README documents the static fallback, its limits, and the sample evidence", () => {
  const packReadme = readText(packReadmePath);
  for (const phrase of [
    "静的ペイロード",
    "手入力",
    STATIC_EXAMPLE,
    "button.send",
    "#message_text_box",
    "#message_text_box_content",
    "オプトイン",
    "未登録",
    "キーボード",
    "自動生成できない",
    "使い捨てワールド",
    "偽装",
    SESSION_GETTER,
    "100 ms",
    "rate-limited",
  ]) {
    assert.ok(packReadme.includes(phrase), `resource_pack/README.md must mention ${phrase}`);
  }
  for (const url of [
    "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chat_screen.json",
    "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json",
    "https://wiki.bedrock.dev/json-ui/json-ui-documentation",
  ]) {
    assert.ok(packReadme.includes(url), `resource_pack/README.md must cite ${url}`);
  }

  const rootReadme = readText(rootReadmePath);
  assert.ok(rootReadme.includes(STATIC_EXAMPLE), "README.md must show the static payload example");
  assert.ok(rootReadme.includes("オプトイン"), "README.md must state that the manual probe is opt-in");
  assert.ok(rootReadme.includes(SESSION_GETTER), "README.md must say the session id comes from the public getter");
  assert.ok(rootReadme.includes("100 ms"), "README.md must document the default 100 ms rate limit");
  assert.ok(
    rootReadme.includes("自動生成は実装していません") || rootReadme.includes("自動生成は未実装"),
    "README.md must keep the automatic payload generation marked as unimplemented",
  );
});

test("the default probe still ships no text box or automatic payload", () => {
  for (const file of ["invui.json", "invui_connect.json", "invui_connect_data_driven.json"]) {
    const text = readText(path.join(uiDir, file));
    assert.ok(!text.includes('"text_box_name"'), `${file} must not add a text box`);
    assert.ok(!text.includes(STATIC_EXAMPLE), `${file} must not pre-fill a payload`);
    assert.ok(!text.includes("#message_text_box"), `${file} must not reuse the chat text box by default`);
  }
});
