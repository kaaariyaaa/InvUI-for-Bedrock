import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("./install-test-packs.sh", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "invui-pack-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "manual-bedrock");
  const destination = join(root, "com.mojang");
  mkdirSync(source, { recursive: true });
  mkdirSync(destination, { recursive: true });
  const script = join(source, "install-test-packs.sh");
  copyFileSync(installer, script);
  const addPack = (relative, type) => {
    const dir = join(source, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ modules: [{ type }] }));
    writeFileSync(join(dir, "marker.txt"), relative);
  };
  const run = (selection) =>
    spawnSync("bash", [script, destination], { input: selection, encoding: "utf8", timeout: 15000 });
  return { addPack, destination, run };
}

test("finds nested BP and RP manifests and installs every discovered pack with all", (t) => {
  const { addPack, destination, run } = fixture(t);
  addPack("alpha/behavior_pack", "script");
  addPack("beta/resource_pack", "resources");
  addPack("folder with spaces/deep/behavior_pack", "data");
  addPack("ignored", "other");

  const result = run("all\n");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /\[BP\] alpha\/behavior_pack/);
  assert.match(result.stdout, /\[RP\] beta\/resource_pack/);
  assert.match(result.stdout, /\[BP\] folder with spaces\/deep\/behavior_pack/);
  assert.doesNotMatch(result.stdout, /\[BP\] ignored/);
  assert.match(result.stderr, /BP\/RP の種類を判定できない/);
  assert.ok(existsSync(join(destination, "behavior_packs", "invui_alpha__behavior_pack", "marker.txt")));
  assert.ok(existsSync(join(destination, "resource_packs", "invui_beta__resource_pack", "marker.txt")));
  assert.ok(existsSync(join(destination, "behavior_packs", "invui_folder_with_spaces__deep__behavior_pack", "marker.txt")));
});

test("selecting a listed number installs only that pack", (t) => {
  const { addPack, destination, run } = fixture(t);
  addPack("alpha/behavior_pack", "script");
  addPack("beta/resource_pack", "resources");

  const result = run("2\n");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(join(destination, "resource_packs", "invui_beta__resource_pack", "marker.txt")));
  assert.equal(existsSync(join(destination, "behavior_packs", "invui_alpha__behavior_pack", "marker.txt")), false);
});

test("the real manual-bedrock installer lists the chat bridge pack", (t) => {
  const root = mkdtempSync(join(tmpdir(), "invui-pack-list-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("bash", [installer, root], { input: "\n", encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /\[BP\] chat-send-bridge-probe\/behavior_pack/);
  assert.match(result.stdout, /\[RP\] chat-send-bridge-probe\/resource_pack/);
});
