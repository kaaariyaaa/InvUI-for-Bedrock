#!/usr/bin/env node
/*
 * Package boundary test.
 *
 * - `npm pack` ships the built entry points and nothing from src/tests/examples.
 * - a consumer that imports `invui-bedrock` type-checks against the packed
 *   declarations using only the public API.
 *
 * The test does not install anything: the tarball is extracted into a temp
 * node_modules and the existing @minecraft/* dev dependencies are symlinked.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const consumerSource = `
import type { Player } from "@minecraft/server";
import {
  Gui,
  InventoryLink,
  Item,
  ItemBuilder,
  Markers,
  StateManager,
  Structure,
  VirtualInventory,
  Window,
  type GuiState,
  type StateHandle,
  type WindowCloseReason,
} from "invui-bedrock";

const structure = new Structure(
  "#########",
  "#xxxxxxx#",
  "#########",
)
  .addIngredient("#", Item.simple(new ItemBuilder("minecraft:gray_stained_glass_pane")))
  .addIngredient("x", Markers.CONTENT_LIST_SLOT_HORIZONTAL);

const inventory = new VirtualInventory(9);
const linkedSlot = new InventoryLink(inventory, 0);

const buyButton = Item.builder()
  .setItemProvider(
    new ItemBuilder("minecraft:diamond")
      .setName("Buy")
      .addLoreLines("Click to buy"),
  )
  .addClickHandler(({ player, slot, window }) => {
    void player.id;
    void slot;
    void window;
  })
  .updateOnClick()
  .build();

const gui = Gui.paged({
  structure,
  ingredients: {
    "#": Item.simple(new ItemBuilder("minecraft:gray_stained_glass_pane")),
    x: Markers.CONTENT_LIST_SLOT_HORIZONTAL,
  },
  content: [buyButton, linkedSlot],
});

export const initialState: GuiState = {
  page: 0,
  data: { inventorySize: inventory.size },
};

export function openShop(player: Player, stateManager: StateManager): Window {
  const state: StateHandle = stateManager.acquire({
    scope: "player",
    ownerId: player.id,
    key: "shop",
    lifetime: "session",
    initial: initialState,
  });

  const window = Window.builder()
    .setViewer(player)
    .setTitle("Shop")
    .setUpperGui(gui)
    .setStateScope("player")
    .setStateKey("shop")
    .setStateLifetime("session")
    .setStateManager(stateManager)
    .addOpenHandler(() => {})
    .addCloseHandler((reason: WindowCloseReason) => {
      void reason;
    })
    .setErrorHandler((error, context) => {
      void error;
      void context.operation;
    })
    .build();

  state.set({ page: window.getState().page ?? 0 });
  return window;
}
`;

const consumerTsconfig = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["consumer.ts"],
};

function runOrFail(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message}`);
  return result;
}

function assertSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("packed package contents and consumer type check", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invui-package-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const packDir = path.join(tmp, "packed");
  const cacheDir = path.join(tmp, "npm-cache");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // Keep npm away from the user cache; this also avoids permission failures
  // on machines where ~/.npm is owned by another user.
  const packResult = runOrFail(
    npm,
    ["pack", "--json", "--pack-destination", packDir, "--cache", cacheDir],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        npm_config_cache: cacheDir,
        npm_config_loglevel: "error",
        npm_config_update_notifier: "false",
      },
    },
  );
  assertSucceeded(packResult, "npm pack");

  let packManifest;
  try {
    packManifest = JSON.parse(packResult.stdout);
  } catch {
    assert.fail(`npm pack did not return JSON:\n${packResult.stdout}\n${packResult.stderr}`);
  }
  assert.ok(Array.isArray(packManifest) && packManifest.length === 1, "npm pack should describe one tarball");

  const packed = packManifest[0];
  const packedPaths = packed.files.map((file) => file.path);
  const packedSet = new Set(packedPaths);

  await t.test("ships the built entry points and excludes repository-only files", () => {
    const sourceModules = fs
      .readdirSync(path.join(repoRoot, "src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -".ts".length));

    for (const moduleName of sourceModules) {
      for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
        const expected = `dist/${moduleName}${suffix}`;
        assert.ok(packedSet.has(expected), `missing packed file: ${expected}`);
      }
    }

    for (const required of ["package.json", "README.md", "bin/cli.js", "dist/index.js", "dist/index.d.ts"]) {
      assert.ok(packedSet.has(required), `missing packed file: ${required}`);
    }

    const cli = packed.files.find((file) => file.path === "bin/cli.js");
    assert.ok((cli.mode & 0o111) !== 0, "bin/cli.js must stay executable in the tarball");

    for (const forbidden of ["src/", "tests/", "examples/"]) {
      assert.ok(
        !packedPaths.some((packedPath) => packedPath.startsWith(forbidden)),
        `repository-only path was packed: ${forbidden}`,
      );
    }

    const allowedTopLevel = new Set(["package.json", "README.md"]);
    for (const packedPath of packedPaths) {
      assert.ok(
        allowedTopLevel.has(packedPath) ||
          packedPath.startsWith("dist/") ||
          packedPath.startsWith("bin/") ||
          packedPath.startsWith("resource_pack/"),
        `unexpected packed path: ${packedPath}`,
      );
    }

    for (const packedPath of packedPaths.filter((entry) => entry.startsWith("dist/"))) {
      assert.match(
        packedPath,
        /^dist\/[^/]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/,
        `unexpected dist artifact: ${packedPath}`,
      );
    }
  });

  // Extract the tarball as a consumer would receive it and type-check a
  // standalone example against the published entry points.
  const extractDir = path.join(tmp, "extract");
  const consumerDir = path.join(tmp, "consumer");
  fs.mkdirSync(extractDir, { recursive: true });
  assertSucceeded(
    runOrFail("tar", ["-xzf", path.join(packDir, packed.filename), "-C", extractDir]),
    "tar extraction",
  );

  const packageDir = path.join(extractDir, "package");
  const installedDir = path.join(consumerDir, "node_modules", "invui-bedrock");
  fs.mkdirSync(path.dirname(installedDir), { recursive: true });
  fs.renameSync(packageDir, installedDir);

  const minecraftScopeDir = path.join(consumerDir, "node_modules", "@minecraft");
  fs.mkdirSync(minecraftScopeDir, { recursive: true });
  for (const dependency of ["server", "common", "vanilla-data"]) {
    const source = path.join(repoRoot, "node_modules", "@minecraft", dependency);
    assert.ok(fs.existsSync(source), `dev dependency is missing: ${dependency}`);
    fs.symlinkSync(
      source,
      path.join(minecraftScopeDir, dependency),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  fs.writeFileSync(path.join(consumerDir, "consumer.ts"), consumerSource);
  fs.writeFileSync(path.join(consumerDir, "tsconfig.json"), `${JSON.stringify(consumerTsconfig, null, 2)}\n`);

  await t.test("packs the same manifest metadata as the repository", () => {
    const repositoryPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const packedPackage = JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8"));

    assert.equal(packedPackage.name, repositoryPackage.name);
    assert.equal(packedPackage.version, repositoryPackage.version);
    assert.equal(packedPackage.type, "module");
    assert.equal(packedPackage.main, "./dist/index.js");
    assert.equal(packedPackage.types, "./dist/index.d.ts");
    assert.deepEqual(packedPackage.exports["."], {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    assert.equal(packedPackage.bin["invui-bedrock"], "./bin/cli.js");

    // Every `files` entry that exists in the repository must actually ship.
    for (const entry of packedPackage.files) {
      const absolute = path.join(repoRoot, entry);
      if (!fs.existsSync(absolute)) continue;
      if (fs.statSync(absolute).isDirectory()) {
        const prefix = `${entry.replace(/\/$/, "")}/`;
        assert.ok(
          packedPaths.some((packedPath) => packedPath.startsWith(prefix)),
          `package files entry did not ship: ${entry}`,
        );
      } else {
        assert.ok(packedSet.has(entry), `package files entry did not ship: ${entry}`);
      }
    }
  });

  await t.test("consumer example type-checks against the packed declarations", () => {
    const tsc = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    assert.ok(fs.existsSync(tsc), "typescript dev dependency is missing");

    const result = runOrFail(tsc, ["-p", "tsconfig.json"], { cwd: consumerDir });
    assert.equal(
      result.status,
      0,
      `consumer type check failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
});
