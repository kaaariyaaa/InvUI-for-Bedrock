#!/usr/bin/env node
/*
 * Structure checks for the opt-in probes in resource_pack/ui.
 *
 * 1. The manual chat-payload probe only reproduces the chat screen's evidenced
 *    text box identity and `button.send`, so a player can type a fixed
 *    notification by hand. It does NOT generate slot/session/sequence values:
 *    official samples and the Bedrock Wiki provide no JSON UI binding that
 *    writes chat text or passes UI values to a script.
 * 2. The automatic container-change probe remaps a normal click to the
 *    evidenced `button.drop_one` / `button.container_slot_hovered` container
 *    actions, so a slot change can raise VirtualContainerItemChangeAfterEvent
 *    without any chat text. Server-side click routing is NOT implemented.
 *
 * Neither test can prove that the pack loads, that the UI appears, that a
 * click drops an item, that the event fires, or that any click handler runs.
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
const GRID_DEFS_PATH = path.join(uiDir, "invui_grid_input.json");
const GRID_MODS_PATH = path.join(uiDir, "invui_grid_input_data_driven.json");
const UI_DEFS_PATH = path.join(uiDir, "_ui_defs.json");
const STATIC_EXAMPLE = "!invui:<session-id>:<layout-generation>:<slot>:<sequence>";
const SESSION_GETTER = "Window._inputSessionId";
const GENERATION_GETTER = "Window._inputLayoutGeneration";
const OLD_EXAMPLE = "!invui:<session>:<slot>:<sequence>";

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
    OLD_EXAMPLE,
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
    GENERATION_GETTER,
    "stale-layout-generation",
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
  assert.ok(
    rootReadme.includes(GENERATION_GETTER),
    "README.md must say the layout generation comes from the public getter",
  );
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

test("the automatic container-change probe stays opt-in and unregistered", () => {
  const uiDefs = readJson(UI_DEFS_PATH).ui_defs;
  assert.deepEqual(
    uiDefs,
    ["ui/invui.json", "ui/invui_connect.json", "ui/invui_connect_data_driven.json"],
    "the automatic probe must not be registered by default: it drops items and changes the grid",
  );
  assert.ok(
    !uiDefs.some((entry) => entry.includes("invui_grid_input")),
    "ui_defs must not register the automatic grid probe",
  );
  assert.ok(fs.existsSync(GRID_DEFS_PATH), "missing ui/invui_grid_input.json");
  assert.ok(fs.existsSync(GRID_MODS_PATH), "missing ui/invui_grid_input_data_driven.json");
});

test("the grid probe aligns with the evidenced desktop item grid", () => {
  const defs = readJson(GRID_DEFS_PATH);
  assert.equal(defs.namespace, "invui_grid_input_probe");

  const root = defs.invui_grid_input_root;
  assert.ok(root, "missing invui_grid_input_root");
  assert.equal(root.type, "grid");
  assert.deepEqual(root.size, [162, "default"]);
  assert.equal(root.collection_name, "container_items");
  assert.equal(root.maximum_grid_items, "$container_size");
  assert.ok(
    root.grid_item_template.endsWith("invui_grid_input_slot"),
    "the grid must use the probe's slot template",
  );

  const mods = readJson(GRID_MODS_PATH);
  assert.equal(mods.namespace, "data_driven_container");
  assert.deepEqual(Object.keys(mods).sort(), ["desktop_panel", "namespace", "panel_top_half"]);

  const desktop = mods.desktop_panel.modifications;
  assert.equal(desktop.length, 1);
  assert.equal(desktop[0].array_name, "controls");
  assert.equal(desktop[0].operation, "insert_front");
  const labels = desktop[0].value[0];
  assert.ok(
    labels["invui_grid_input_warning@invui_grid_input_probe.invui_grid_input_warning"],
    "missing warning label",
  );
  assert.ok(
    labels["invui_grid_input_note@invui_grid_input_probe.invui_grid_input_note"],
    "missing note label",
  );

  const topHalf = mods.panel_top_half.modifications;
  assert.equal(topHalf.length, 1);
  assert.equal(topHalf[0].array_name, "controls");
  assert.equal(topHalf[0].operation, "insert_back", "the transparent grid must render above the item grid");
  const [entryName, overrides] = Object.entries(topHalf[0].value[0])[0];
  assert.equal(entryName.split("@")[1], "invui_grid_input_probe.invui_grid_input_root");
  assert.deepEqual(overrides, {
    anchor_from: "top_left",
    anchor_to: "top_left",
    offset: [7, 10],
  });
});

test("the grid slot maps click to evidenced container actions only", () => {
  const defs = readJson(GRID_DEFS_PATH);
  const slotEntry = Object.entries(defs).find(([name]) => name.startsWith("invui_grid_input_slot@"));
  assert.ok(slotEntry, "missing invui_grid_input_slot");
  const [slotName, slot] = slotEntry;
  assert.equal(
    slotName,
    "invui_grid_input_slot@common.container_slot_button_prototype",
    "the slot must reuse the vanilla container slot button, not re-implement its collection bindings",
  );
  assert.equal(slot.$item_collection_name, "container_items");
  assert.equal(slot.$highlight_control, "invui_grid_input_probe.invui_grid_input_highlight");
  assert.deepEqual(slot.size, [18, 18]);
  assert.equal(slot.layer, 50);
  assert.ok(!("bindings" in slot), "collection/focus bindings must come from the vanilla prototype, not be re-invented");
  assert.ok(!("controls" in slot), "the slot must reuse the vanilla prototype's hover control");
  assert.ok(defs.invui_grid_input_highlight, "missing the custom hover highlight");
  assert.equal(defs.invui_grid_input_highlight.type, "image");
  assert.deepEqual(defs.invui_grid_input_highlight.size, ["100%", "100%"]);
  assert.deepEqual(slot.button_mappings, [
    { from_button_id: "button.menu_select", to_button_id: "button.drop_one", mapping_type: "pressed" },
    { from_button_id: "button.menu_ok", to_button_id: "button.drop_one", mapping_type: "pressed" },
    {
      from_button_id: "button.menu_secondary_select",
      to_button_id: "button.drop_one",
      mapping_type: "pressed",
    },
    {
      from_button_id: "button.controller_select",
      to_button_id: "button.drop_one",
      mapping_type: "pressed",
    },
    {
      from_button_id: "button.controller_secondary_select",
      to_button_id: "button.drop_one",
      mapping_type: "pressed",
    },
    { to_button_id: "button.container_slot_hovered", mapping_type: "pressed" },
  ]);
  assert.ok(!("$pressed_button_name" in slot), "the probe must not invent a custom pressed-button id");

  const json = JSON.stringify(defs);
  // `button.drop_one` and `button.container_slot_hovered` are evidenced vanilla
  // hardcoded ids; no chat, text-box, collection-index, or session binding.
  for (const forbidden of [
    "button.send",
    "text_box_name",
    "#message_text_box",
    "#collection_index",
    "#slot_index",
    "#session_id",
    "#window_id",
    "#sequence",
    "#invui_",
    "button.invui_",
  ]) {
    assert.ok(!json.includes(forbidden), `the grid probe must not use ${forbidden}`);
  }
});

test("the grid probe documents evidence, limits, and impact on other screens", () => {
  const readme = readText(packReadmePath);
  for (const phrase of [
    "自動コンテナ変更プローブ",
    "button.drop_one",
    "button.container_slot_hovered",
    "VirtualContainerItemChangeAfterEvent",
    "オプトイン",
    "既定未登録",
    "1 個ドロップ",
    "サーバー側のクリック処理は未実装",
    "WindowItemChangeDangerError",
    "全画面",
    "pocket 画面は対象外",
    "未検証",
    "使い捨て",
  ]) {
    assert.ok(readme.includes(phrase), `resource_pack/README.md must mention ${phrase}`);
  }
  for (const url of [
    "https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json",
    "https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerItemChangeAfterEvent.md",
  ]) {
    assert.ok(readme.includes(url), `resource_pack/README.md must cite ${url}`);
  }
});

test("the default connection files do not reference the grid probe", () => {
  for (const file of ["invui.json", "invui_connect.json", "invui_connect_data_driven.json"]) {
    const text = readText(path.join(uiDir, file));
    assert.ok(!text.includes("invui_grid_input"), `${file} must not reference the opt-in grid probe`);
    assert.ok(!text.includes("button.drop_one"), `${file} must not remap clicks to drop_one by default`);
  }
});

test("the default desktop blocker is anchored to the sample slot area, not the whole panel", () => {
  // Pinned sample: Mojang/bedrock-samples v1.26.70.23-preview
  // (commit 430142679bb7daf3160671f06ab32ea433be1e1d),
  // resource_pack/ui/data_driven_container_screen.json:
  // - item_grid: size [162, "default"]; the instance inside panel_top_half sets
  //   offset [7, 10]; rows are 18px.
  // - panel_top_half heights for $container_rows_1..6: 42, 60, 78, 96, 114, 132.
  // - pocket_half_screen: offset [0, 27], size ["50%", "100%-27px"]; the
  //   container instance on pocket_panel sets anchor_from top_middle.
  const SAMPLE_ITEM_GRID_OFFSET = [7, 10];
  const SAMPLE_ITEM_GRID_WIDTH = 162;
  const SAMPLE_ROW_HEIGHT = 18;
  const SAMPLE_PANEL_TOP_HALF_HEIGHTS = [42, 60, 78, 96, 114, 132];
  const SAMPLE_PANEL_TOP_HALF_PADDING = 24;

  const mods = readJson(path.join(uiDir, "invui_connect_data_driven.json"));

  const desktop = mods.desktop_panel.modifications;
  assert.equal(desktop.length, 1, "desktop_panel must only add the probe; the blocker belongs to panel_top_half");
  assert.ok(
    !Object.keys(desktop[0].value[0])[0].includes("grid_blocker"),
    "the blocker must not be inserted into desktop_panel, whose root is 130..220px tall",
  );

  const topHalf = mods.panel_top_half.modifications;
  assert.equal(topHalf.length, 1, "the desktop blocker must live in panel_top_half");
  const [blockerName, blocker] = Object.entries(topHalf[0].value[0])[0];
  assert.equal(blockerName.split("@")[1], "invui_connect_probe.grid_blocker");
  assert.deepEqual(blocker.offset, SAMPLE_ITEM_GRID_OFFSET, "the blocker must share the item grid origin");
  assert.equal(blocker.size[0], SAMPLE_ITEM_GRID_WIDTH, "the blocker must share the item grid width");
  assert.equal(blocker.size[1], "100%-24px", "the blocker height must subtract the sample padding");

  for (let rows = 1; rows <= SAMPLE_PANEL_TOP_HALF_HEIGHTS.length; rows += 1) {
    const panelHeight = SAMPLE_PANEL_TOP_HALF_PADDING + rows * SAMPLE_ROW_HEIGHT;
    assert.equal(
      SAMPLE_PANEL_TOP_HALF_HEIGHTS[rows - 1],
      panelHeight,
      `sample panel_top_half height for ${rows} row(s) changed`,
    );
    // "100%-24px" measured from panel_top_half is exactly rows * 18px, so the
    // blocker covers the slots and stops before the panel's bottom padding.
    assert.equal(panelHeight - SAMPLE_PANEL_TOP_HALF_PADDING, rows * SAMPLE_ROW_HEIGHT);
  }

  const pocketBlocker = mods.pocket_panel.modifications
    .flatMap((modification) => modification.value)
    .map((value) => Object.entries(value)[0])
    .find(([name]) => name.includes("grid_blocker"));
  assert.ok(pocketBlocker, "missing the pocket blocker");
  assert.deepEqual(
    pocketBlocker[1],
    {
      anchor_from: "top_middle",
      anchor_to: "top_left",
      offset: [0, 27],
      size: ["50%", "100%-27px"],
    },
    "the pocket blocker must match pocket_half_screen",
  );

  // The prose must name the panel the JSON actually modifies.
  const readme = readText(packReadmePath);
  assert.ok(readme.includes("panel_top_half"), "README must name the desktop blocker's parent panel");
  assert.ok(
    !readme.includes("ブロッカーは `desktop_panel` では"),
    "README must not measure the blocker geometry from desktop_panel",
  );
});
