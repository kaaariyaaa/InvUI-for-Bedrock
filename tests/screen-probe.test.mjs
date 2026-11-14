#!/usr/bin/env node
/*
 * Screen-attribution checks for the manual JSON UI probe packs.
 *
 * The probes insert a static panel marker plus a `$container_title` label.
 * `$container_title` is the screen variable that the candidate panels already
 * render in their own title labels:
 *   bedrock-samples v1.26.70.23-preview
 *   resource_pack/ui/data_driven_container_screen.json (container_label)
 *   resource_pack/ui/chest_screen.json (chest_label)
 * This is not a new binding name; it lets the player see whether the marked
 * panel received the opened VirtualContainer's title (the raw probe fixes it
 * to "InvUI probe <size>"). Title propagation and pack loading are unverified
 * on a real device; these checks only validate the JSON structure.
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
  },
];

for (const probe of PROBES) {
  test(`${probe.name}: the title marker reads the evidenced $container_title only`, () => {
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

  test(`${probe.name}: the probe still declares itself unverified and disposable`, () => {
    const description = readJson(probe.manifest).header.description;
    assert.match(description, /Unverified/);
    assert.match(description, /disposable world/i);
    assert.match(description, /no item protection/i);
  });
}
