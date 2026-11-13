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
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/*
 * Stand-in for @minecraft/server. The package only imports ItemStack, world,
 * and system at runtime; every one of them is provided here so the packed ESM
 * can be evaluated outside Minecraft.
 */
const minecraftServerMockSource = `
export class ItemStack {
  constructor(typeId, amount = 1) {
    if (typeof typeId !== "string" || typeId.length === 0) {
      throw new TypeError("ItemStack requires a non-empty type id");
    }
    this.typeId = typeId;
    this.amount = amount;
    this.nameTag = "";
    this.lore = [];
  }
  clone() {
    const copy = new ItemStack(this.typeId, this.amount);
    copy.nameTag = this.nameTag;
    copy.lore = [...this.lore];
    return copy;
  }
  setLore(lines) {
    this.lore = [...lines];
  }
}

export const world = {
  containers: [],
  virtualContainerManager: {
    create(options) {
      if (!options || !Number.isInteger(options.size)) {
        throw new TypeError("VirtualContainerOptions.size is required");
      }
      const container = {
        size: options.size,
        title: options.title,
        items: new Map(),
        setItem(slot, item) {
          if (!Number.isInteger(slot) || slot < 0 || slot >= this.size) {
            throw new RangeError("slot out of range");
          }
          if (item === undefined) {
            this.items.delete(slot);
          } else {
            this.items.set(slot, item.clone());
          }
        },
        getItem(slot) {
          const item = this.items.get(slot);
          return item === undefined ? undefined : item.clone();
        },
      };
      world.containers.push(container);
      return container;
    },
  },
};

export const system = {
  runs: new Map(),
  nextRunId: 1,
  runInterval(callback, ticks = 1) {
    const runId = this.nextRunId++;
    this.runs.set(runId, { callback, ticks });
    return runId;
  },
  clearRun(runId) {
    this.runs.delete(runId);
  },
};
`;

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

    // The packed CLI resolves --install-resource-pack from its own package root,
    // so these template files must be part of the tarball, not just the repo.
    for (const required of [
      "resource_pack/manifest.json",
      "resource_pack/ui/_ui_defs.json",
      "resource_pack/ui/invui.json",
    ]) {
      assert.ok(packedSet.has(required), `missing packed resource pack file: ${required}`);
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

  await t.test("tarball carries the resource pack files byte-for-byte", () => {
    for (const relativePath of [
      "resource_pack/manifest.json",
      "resource_pack/ui/_ui_defs.json",
      "resource_pack/ui/invui.json",
    ]) {
      const extracted = path.join(installedDir, relativePath);
      assert.ok(fs.existsSync(extracted), `tarball is missing ${relativePath}`);
      assert.deepEqual(
        fs.readFileSync(extracted),
        fs.readFileSync(path.join(repoRoot, relativePath)),
        `tarball content differs from repository for ${relativePath}`,
      );
    }
  });

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

  await t.test("packed ESM imports and runs against a fake @minecraft/server", async () => {
    const mockUrl = `data:text/javascript;base64,${Buffer.from(minecraftServerMockSource).toString("base64")}`;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@minecraft/server") {
          return { url: mockUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });

    const minecraft = await import(mockUrl);
    const packageUrl = pathToFileURL(path.join(installedDir, "dist", "index.js")).href;
    const {
      Gui,
      Item,
      ItemBuilder,
      Markers,
      StateManager,
      Window,
      WindowOpenRejectedError,
    } = await import(packageUrl);

    const clicks = [];
    const button = Item.builder()
      .setItemProvider(
        new ItemBuilder("minecraft:diamond").setName("Buy").addLoreLines("Click to buy"),
      )
      .addClickHandler((click) => {
        clicks.push(`${click.player.id}:${click.slot}`);
      })
      .build();
    const ticking = Item.builder()
      .setItemProvider(new ItemBuilder("minecraft:clock"))
      .updatePeriodically(20)
      .build();

    const gui = Gui.paged({
      structure: ["xx"],
      ingredients: { x: Markers.CONTENT_LIST_SLOT_HORIZONTAL },
      content: [button, ticking],
    });
    const viewer = { id: "player-1", name: "Steve" };
    const opened = [];
    const closed = [];
    const adapter = {
      canOpenScreens: true,
      createContainer: (options) => minecraft.world.virtualContainerManager.create(options),
      openContainer: (container) => opened.push(container),
      closeContainer: (container) => closed.push(container),
    };

    const window = Window.builder()
      .setViewer(viewer)
      .setTitle("Shop")
      .setUpperGui(gui)
      .setStateManager(new StateManager())
      .setContainerAdapter(adapter)
      .build();

    await window.open();
    assert.equal(window.status, "open");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].size, 9);
    assert.equal(opened[0].title, "Shop");

    const display = opened[0].getItem(0);
    assert.ok(display instanceof minecraft.ItemStack, "content slot must use the fake ItemStack");
    assert.equal(display.typeId, "minecraft:diamond");
    assert.equal(display.nameTag, "Buy");
    assert.deepEqual(display.lore, ["Click to buy"]);

    assert.equal(minecraft.system.runs.size, 1, "periodic item must schedule through fake system");
    const [periodicRun] = [...minecraft.system.runs.values()];
    assert.equal(periodicRun.ticks, 20);

    assert.equal(await window.handleClick(0), true);
    assert.deepEqual(clicks, ["player-1:0"]);

    window.setState({ page: 1 });
    assert.equal(window.getState().page, 1);

    window.close("PlayerClosed");
    assert.equal(window.status, "closed");
    assert.equal(closed.length, 1);
    assert.equal(minecraft.system.runs.size, 0, "closing must cancel periodic updates");

    // The production adapter must reject before creating any container.
    const guarded = Window.builder().setViewer(viewer).setUpperGui(gui).build();
    await assert.rejects(guarded.open(), WindowOpenRejectedError);
    assert.equal(guarded.status, "created", "rejected open must not leave the window half-open");
    assert.equal(minecraft.world.containers.length, 1, "real adapter must not create a container");
  });

  await t.test("packed bin CLI runs", () => {
    const cli = path.join(installedDir, "bin", "cli.js");
    const packedPackage = JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8"));

    const version = runOrFail(process.execPath, [cli, "--version"], { cwd: tmp });
    assertSucceeded(version, "cli --version");
    assert.equal(version.stdout.trim(), `invui-bedrock ${packedPackage.version}`);

    const help = runOrFail(process.execPath, [cli, "--help"], { cwd: tmp });
    assertSucceeded(help, "cli --help");
    assert.match(help.stdout, /invui-bedrock — setup helper/);
    assert.match(help.stdout, /\binit\b/);

    const behaviorPack = path.join(tmp, "behavior_pack");
    const resourcePack = path.join(tmp, "resource_pack");
    fs.mkdirSync(path.join(behaviorPack, "scripts"), { recursive: true });
    fs.mkdirSync(resourcePack, { recursive: true });
    fs.writeFileSync(
      path.join(behaviorPack, "manifest.json"),
      JSON.stringify(
        {
          format_version: 2,
          header: {
            name: "Test BP",
            description: "",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: [1, 0, 0],
            min_engine_version: [1, 21, 0],
          },
          modules: [
            {
              type: "script",
              language: "javascript",
              uuid: "00000000-0000-0000-0000-000000000002",
              version: [1, 0, 0],
              entry: "scripts/main.js",
            },
          ],
          dependencies: [{ module_name: "@minecraft/server", version: "1.0.0" }],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(behaviorPack, "scripts", "main.js"), "// test entry\n");
    fs.writeFileSync(
      path.join(resourcePack, "manifest.json"),
      JSON.stringify(
        {
          format_version: 2,
          header: {
            name: "Test RP",
            description: "",
            uuid: "00000000-0000-0000-0000-000000000003",
            version: [1, 0, 0],
            min_engine_version: [1, 21, 0],
          },
          modules: [
            {
              type: "resources",
              uuid: "00000000-0000-0000-0000-000000000004",
              version: [1, 0, 0],
            },
          ],
        },
        null,
        2,
      ),
    );

    const init = runOrFail(
      process.execPath,
      [cli, "init", "--behavior-pack", behaviorPack, "--resource-pack", resourcePack, "--json"],
      { cwd: tmp },
    );
    assertSucceeded(init, "cli init --json");

    const report = JSON.parse(init.stdout);
    assert.equal(report.tool, "invui-bedrock");
    assert.equal(report.toolVersion, packedPackage.version);
    assert.equal(report.status, "beta-unverified");
    assert.equal(report.inputs.behaviorPack, behaviorPack);
    assert.equal(report.inputs.resourcePack, resourcePack);
    assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(
      report.checks.some(
        (check) => check.area === "behavior-pack" && check.id === "bp.script-module" && check.level === "ok",
      ),
      "behavior pack script module should be detected",
    );
    assert.ok(
      report.checks.some(
        (check) => check.area === "resource-pack" && check.id === "manifest.exists" && check.level === "ok",
      ),
      "resource pack manifest should be detected",
    );
    assert.equal(fs.existsSync(path.join(resourcePack, "ui")), false, "CLI must not create UI files");

    const missingArgs = runOrFail(process.execPath, [cli, "init"], { cwd: tmp });
    assert.equal(missingArgs.status, 1);
    assert.match(missingArgs.stderr, /--behavior-pack/);

    // The opt-in probe must come from the packed resource_pack template and
    // land in a valid Resource Pack without touching existing files.
    const packedTemplate = path.join(installedDir, "resource_pack", "ui", "invui.json");
    assert.ok(fs.existsSync(packedTemplate), "packed resource pack template is missing");
    const manifestBefore = fs.readFileSync(path.join(resourcePack, "manifest.json"), "utf8");

    const install = runOrFail(
      process.execPath,
      [
        cli,
        "init",
        "--behavior-pack",
        behaviorPack,
        "--resource-pack",
        resourcePack,
        "--install-resource-pack",
        "--json",
      ],
      { cwd: tmp },
    );
    assertSucceeded(install, "cli init --install-resource-pack --json");

    const installReport = JSON.parse(install.stdout);
    assert.equal(installReport.resourcePackInstall.status, "installed");
    assert.deepEqual(
      installReport.resourcePackInstall.files.map((file) => [file.path, file.action]),
      [["ui/invui.json", "created"]],
    );

    const installedProbe = path.join(resourcePack, "ui", "invui.json");
    assert.ok(fs.existsSync(installedProbe), "packed CLI did not install ui/invui.json");
    assert.deepEqual(
      fs.readFileSync(installedProbe),
      fs.readFileSync(packedTemplate),
      "installed probe must match the packed template",
    );
    assert.deepEqual(
      fs.readFileSync(installedProbe),
      fs.readFileSync(path.join(repoRoot, "resource_pack", "ui", "invui.json")),
      "installed probe must match the repository template",
    );
    assert.equal(
      fs.readFileSync(path.join(resourcePack, "manifest.json"), "utf8"),
      manifestBefore,
      "install must not rewrite the Resource Pack manifest",
    );
  });
});
