#!/usr/bin/env node
/*
 * Screen-attribution checks for the manual JSON UI probe packs.
 *
 * The probes insert a static panel marker plus a `$container_title` label.
 * `$container_title` is never defined in bedrock-samples v1.26.70.23-preview
 * (all resource_pack/ui files plus _global_variables.json), so the game supplies
 * it as a screen variable. The title labels that read it already live below the
 * insertion points, and an ancestor inherits whatever its descendants see:
 *   data_driven_container_screen.json: container_label, pocket container_header
 *   chest_screen.json: chest_label
 *   pocket_containers.json: container_header
 * The insertion points (desktop_panel, pocket_panel, small/large_chest_panel)
 * are those labels' ancestors, so the sample is consistent with the marker
 * seeing the same variable. That is a sample-level inference; receiving the
 * variable on a device, and the value being the opened VirtualContainer's title,
 * are unverified. The raw probe fixes the title to "InvUI probe <size>".
 * Title propagation and pack loading remain unverified; these checks only
 * validate the JSON structure and the documented limits.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const PROBES = [
  {
    name: "data_driven_container probe",
    defs: "tests/manual-bedrock/data-driven-resource-pack/ui/invui_probe.json",
    modifications: [
      {
        file: "tests/manual-bedrock/data-driven-resource-pack/ui/invui_probe_data_driven.json",
        panels: ["desktop_panel", "pocket_panel"],
      },
    ],
    manifest: "tests/manual-bedrock/data-driven-resource-pack/manifest.json",
    readme: "tests/manual-bedrock/data-driven-resource-pack/README.md",
  },
  {
    name: "chest probe",
    defs: "tests/manual-bedrock/chest-resource-pack/ui/invui_probe.json",
    modifications: [
      {
        file: "tests/manual-bedrock/chest-resource-pack/ui/invui_probe_chest.json",
        panels: ["small_chest_panel", "large_chest_panel"],
      },
      {
        file: "tests/manual-bedrock/chest-resource-pack/ui/invui_probe_pocket.json",
        panels: ["small_chest_panel", "large_chest_panel"],
      },
    ],
    manifest: "tests/manual-bedrock/chest-resource-pack/manifest.json",
    readme: "tests/manual-bedrock/chest-resource-pack/README.md",
  },
];

for (const probe of PROBES) {
  test(`${probe.name}: the title marker only reads $container_title, not a binding`, () => {
    const defs = readJson(probe.defs);
    const titleMarker = defs.title_marker;
    assert.ok(titleMarker, "missing title_marker");
    assert.equal(titleMarker.type, "label");
    assert.equal(titleMarker.text, "$container_title");
    for (const forbidden of [
      "bindings",
      "binding_name",
      "binding_name_override",
      "collection_name",
      "collection_index",
    ]) {
      assert.ok(!(forbidden in titleMarker), `title_marker must not define ${forbidden}`);
    }
    // The marker must stay observation-only.
    const json = JSON.stringify(defs);
    assert.ok(!json.includes('"#'), "the probe must not use a hardcoded #binding");
    assert.ok(!json.includes("button_mappings"), "the probe must not define button mappings");
  });

  test(`${probe.name}: the title marker stays visible and stacked below the static marker`, () => {
    const defs = readJson(probe.defs);
    const title = defs.title_marker;
    assert.equal(title.layer, 100);
    assert.deepEqual(title.offset, [4, 18], "the documented title offset must not drift");
    assert.ok(!("localize" in title), "the title marker must show the raw value");
    assert.ok(!("ignored" in title), "the title marker must stay ungated so pack loading stays visible");
    for (const name of ["desktop_marker", "pocket_marker"]) {
      assert.ok(defs[name].offset[1] < title.offset[1], `${name} must not cover the title marker`);
    }
  });

  test(`${probe.name}: every candidate panel gets the marker and the title marker`, () => {
    for (const { file, panels } of probe.modifications) {
      const mods = readJson(file);
      for (const panel of panels) {
        const entry = mods[panel];
        assert.ok(entry, `${file}: missing ${panel}`);
        assert.equal(entry.modifications.length, 1);
        const [change] = entry.modifications;
        assert.equal(change.array_name, "controls");
        assert.equal(change.operation, "insert_front");
        assert.equal(change.value.length, 2, `${file}: ${panel} must insert the marker and the title marker`);
        const references = change.value.map((value) => Object.keys(value)[0].split("@")[1]);
        assert.ok(
          references.includes("invui_probe.title_marker"),
          `${file}: ${panel} must reference invui_probe.title_marker, got ${references.join(", ")}`,
        );
        assert.ok(
          references.some((reference) => /\.(desktop|pocket)_marker$/.test(reference)),
          `${file}: ${panel} must keep the static panel marker`,
        );
      }
    }
  });

  test(`${probe.name}: the README records the scope evidence, its limits, and the empty-title case`, () => {
    const readme = fs.readFileSync(path.join(repoRoot, probe.readme), "utf8");
    for (const phrase of [
      "定義がなく",
      "祖先",
      "仮説",
      "実機で挿入した control がこの変数を受け取ることは未検証",
      "MCPE-175115",
      "静的マーカーが見えていれば",
      "空/未解決",
    ]) {
      assert.ok(readme.includes(phrase), `README must mention ${phrase}`);
    }
  });

  test(`${probe.name}: the probe still declares itself unverified and disposable`, () => {
    const description = readJson(probe.manifest).header.description;
    assert.match(description, /Unverified/);
    assert.match(description, /disposable world/i);
    assert.match(description, /no item protection/i);
  });
}
