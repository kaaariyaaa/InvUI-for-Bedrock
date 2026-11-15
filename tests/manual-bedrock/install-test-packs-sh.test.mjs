#!/usr/bin/env node
/*
 * install-test-packs.sh の静的チェックと、偽 com.mojang を使った実行チェック。
 *
 * 実際の Minecraft は起動しない。確認するのは:
 * - 実行ビットがあり、bash + 標準コマンド（cp -R）だけで動くこと
 * - 削除コマンド（rm など）を持たないこと
 * - manifest.json を持つすべての BP/RP を再帰的に列挙し、番号複数指定 / all / Enter 取消を持つこと
 * - com.mojang の既知候補検出と、引数 / MC_COMOJANG / 複数候補の番号選択
 * - 選択したパックだけを behavior_packs / resource_packs へ上書きコピーすること
 * - 取消・不正入力・ソース欠落では何も変更しないこと
 * - README が .sh を指すこと
 *
 * 実機のパック読込・表示は検証しない。
 *
 * 実行:
 *   node --test tests/manual-bedrock/install-test-packs-sh.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shPath = path.join(here, 'install-test-packs.sh');
const readmePath = path.join(here, 'README.md');
const probeReadmePath = path.join(here, 'locked-click-probe', 'README.md');


const LEGACY_DESTINATIONS = {
  'probe/behavior_pack': 'invui_probe',
  'locked-click-probe/behavior_pack': 'locked_click_probe',
  'chest-resource-pack': 'invui_chest_probe',
  'data-driven-resource-pack': 'invui_data_driven_probe',
  'button-send-resource-pack': 'invui_button_send_probe',
  'edit-box-resource-pack': 'invui_edit_box_probe',
  'protection-resource-pack': 'invui_protection_probe',
  'chat-send-bridge-probe/behavior_pack': 'invui_chat_send_bridge_probe_bp',
  'chat-send-bridge-probe/resource_pack': 'invui_chat_send_bridge_probe_rp',
};

function discoverPacks(root) {
  const result = [];
  const walk = (dir, relative) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(itemPath, relative ? relative + '/' + item.name : item.name);
        continue;
      }
      if (!item.isFile() || item.name !== 'manifest.json') continue;
      const manifest = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
      const types = (manifest.modules ?? []).map((module) => module.type);
      const kind = types.some((type) => type === 'script' || type === 'data')
        ? 'BP'
        : types.includes('resources') ? 'RP' : null;
      if (!kind) continue;
      const src = relative;
      const dst = LEGACY_DESTINATIONS[src]
        ?? 'invui_' + src.replaceAll('/', '__').replaceAll('-', '_').replace(/[^a-zA-Z0-9_]/g, '_');
      result.push({ kind, src, dst });
    }
  };
  walk(root, '');
  result.sort((a, b) => a.src < b.src ? -1 : a.src > b.src ? 1 : 0);
  return result;
}

const PACKS = discoverPacks(here);

const sh = fs.readFileSync(shPath, 'utf8');

const tmpRoots = [];
test.after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function makeHome() {
  return makeTempDir('invui-pack-sh-home-');
}

/** behavior_packs / resource_packs を持つ偽 com.mojang を作る。 */
function makeComMojang(root) {
  fs.mkdirSync(path.join(root, 'behavior_packs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resource_packs'), { recursive: true });
  return root;
}

function runScript({ home, args = [], input = '', comMojang, script = shPath }) {
  const env = { ...process.env, HOME: home };
  delete env.MC_COMOJANG;
  if (comMojang !== undefined) env.MC_COMOJANG = comMojang;
  return spawnSync(script, args, { input, env, encoding: 'utf8' });
}

function destPath(comMojang, pack) {
  const root = pack.kind === 'BP' ? 'behavior_packs' : 'resource_packs';
  return path.join(comMojang, root, pack.dst);
}

function assertPackCopied(comMojang, pack) {
  const dest = destPath(comMojang, pack);
  assert.ok(fs.existsSync(path.join(dest, 'manifest.json')), `${pack.dst} がコピーされていない`);
  assert.deepEqual(
    fs.readFileSync(path.join(dest, 'manifest.json')),
    fs.readFileSync(path.join(here, pack.src, 'manifest.json')),
    `${pack.dst} の manifest.json がコピー元と違う`,
  );
}

function assertPackAbsent(comMojang, pack) {
  assert.ok(!fs.existsSync(destPath(comMojang, pack)), `${pack.dst} が意図せずコピーされた`);
}

// --- 静的チェック ---------------------------------------------------------------

test('実行ビットがあり、bash + cp -R だけを使う', () => {
  assert.equal(fs.statSync(shPath).mode & 0o111, 0o111, '実行ビットが必要');
  assert.match(sh, /^#!\/usr\/bin\/env bash/);
  assert.match(sh, /cp -R /);
  assert.doesNotMatch(sh, /\b(rsync|tar|unzip|python3?|perl)\b/);
});

test('削除コマンドを持たない（rm を使わない）', () => {
  assert.doesNotMatch(sh, /\brm\b/);
  assert.doesNotMatch(sh, /\b(rmdir|unlink|shred|truncate|Remove-Item)\b/i);
  assert.doesNotMatch(sh, /\bfind\b[^\n]*-delete/);
});


test('全ての BP/RP を manifest.json から自動検出し、コピー先を決める', () => {
  assert.match(sh, /find "\\$HERE" -type f -name manifest\\.json -print0/);
  assert.ok(PACKS.length >= 9, '既存の手動テストパックも検出する');
  for (const pack of PACKS) {
    assert.ok(fs.existsSync(path.join(here, pack.src, 'manifest.json')));
    assert.ok(pack.dst.length > 0);
  }
});

test('番号複数指定・all・Enter 取消を持つ', () => {
  assert.match(sh, /read -r selection/);
  assert.match(sh, /\^\[0-9\[:space:\]\]\+\$/);
  assert.match(sh, /\[Aa\]\[Ll\]\[Ll\]\)/);
  assert.match(sh, /取消しました。何も変更していません。/);
  assert.match(sh, /範囲外の番号/);
});

test('com.mojang の既知候補と MC_COMOJANG / 引数の上書きを持つ', () => {
  assert.ok(sh.includes('${HOME:-}/.local/share/mcpelauncher/games/com.mojang'));
  assert.ok(sh.includes('${HOME:-}/.var/app/io.mrarm.mcpelauncher/data/mcpelauncher/games/com.mojang'));
  assert.match(sh, /\$\{MC_COMOJANG:-\}/);
  assert.match(sh, /"\$#" -ge 1/);
  assert.match(sh, /com\.mojang が見つかりません/);
});

test('ワールド選択・JSON 編集をしない', () => {
  assert.doesNotMatch(sh, /minecraftWorlds/i);
  assert.doesNotMatch(sh, /world_behavior_packs|world_resource_packs/i);
  assert.doesNotMatch(sh, /level\.dat|levelname/i);
  assert.match(sh, /behavior_packs/);
  assert.match(sh, /resource_packs/);
});

test('README は .sh を指し、削除済みの bat を指さない', () => {
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert.match(readme, /`install-test-packs\.sh`/);
  assert.doesNotMatch(readme, /install-test-packs\.bat|install-to-world\.bat/);

  const probeReadme = fs.readFileSync(probeReadmePath, 'utf8');
  assert.match(probeReadme, /`\.\.\/install-test-packs\.sh`/);
  assert.match(probeReadme, /実機未検証/);
  assert.doesNotMatch(probeReadme, /install-test-packs\.bat|install-to-world\.bat/);
});

// --- 実行チェック（偽 com.mojang。Minecraft は起動しない） ---------------------

test('既知候補を自動検出し、選んだパックだけをコピーする', () => {
  const home = makeHome();
  const com = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));

  const result = runScript({ home, input: '1 3\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assertPackCopied(com, PACKS[0]);
  assertPackCopied(com, PACKS[2]);
  for (const pack of PACKS.filter((_, index) => index !== 0 && index !== 2)) {
    assertPackAbsent(com, pack);
  }
  assert.match(result.stdout, /ワールド設定で有効化/);
  assert.match(result.stdout, /1つずつ/);
  assert.match(result.stdout, /実機未検証/);
});

test('bedrock-on-linux の深い com.mojang を自動検出し、無いパックフォルダを作る', () => {
  const home = makeHome();
  const deep = path.join(
    home,
    '.local/share/bedrock-on-linux/compatdata/pfx/drive_c/users/steamuser/AppData/Roaming/Minecraft Bedrock/Users/11964040473149336764/games/com.mojang',
  );
  fs.mkdirSync(path.join(deep, 'minecraftpe'), { recursive: true });

  const result = runScript({ home, input: '3\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertPackCopied(deep, PACKS[2]);
  assert.ok(fs.existsSync(path.join(deep, 'behavior_packs')), 'behavior_packs を作る');
  assert.ok(fs.existsSync(path.join(deep, 'resource_packs')), 'resource_packs を作る');
});

test('all は検出したすべてのパックをコピーする', () => {
  const home = makeHome();
  const com = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));

  const result = runScript({ home, input: 'all\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const pack of PACKS) assertPackCopied(com, pack);
  assert.match(result.stdout, /Resource Pack を複数選択/);
});

test('引数と MC_COMOJANG は既知候補より優先される', () => {
  const home = makeHome();
  const known = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));
  const envCom = makeComMojang(path.join(makeTempDir('invui-env-com-'), 'com.mojang'));
  const argCom = makeComMojang(path.join(makeTempDir('invui-arg-com-'), 'com.mojang'));

  const fromEnv = runScript({ home, input: '4\n', comMojang: envCom });
  assert.equal(fromEnv.status, 0, fromEnv.stdout + fromEnv.stderr);
  assertPackCopied(envCom, PACKS[3]);
  assertPackAbsent(known, PACKS[3]);

  const fromArg = runScript({
    home,
    input: '2\n',
    args: [argCom],
    comMojang: envCom,
  });
  assert.equal(fromArg.status, 0, fromArg.stdout + fromArg.stderr);
  assertPackCopied(argCom, PACKS[1]);
  assertPackAbsent(envCom, PACKS[1]);
});

test('Preview と Stable の両方があるときは先に p/s を選ぶ', () => {
  const home = makeHome();
  const stable = makeComMojang(
    path.join(home, '.local/share/bedrock-on-linux/compatdata/pfx/drive_c/users/umi/AppData/Roaming/Minecraft Bedrock/Users/1/games/com.mojang'),
  );
  const preview = makeComMojang(
    path.join(home, '.local/share/bedrock-on-linux/compatdata/pfx/drive_c/users/umi/AppData/Roaming/Minecraft Bedrock Preview/Users/1/games/com.mojang'),
  );

  const toPreview = runScript({ home, input: 'p\n4\n' });
  assert.equal(toPreview.status, 0, toPreview.stdout + toPreview.stderr);
  assert.match(toPreview.stdout, /Preview と Stable の両方/);
  assertPackCopied(preview, PACKS[3]);
  assertPackAbsent(stable, PACKS[3]);

  const toStable = runScript({ home, input: 's\n4\n' });
  assert.equal(toStable.status, 0, toStable.stdout + toStable.stderr);
  assertPackCopied(stable, PACKS[3]);
});

test('複数の既知候補は番号で選ぶ', () => {
  const home = makeHome();
  const first = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));
  const second = makeComMojang(
    path.join(home, '.var/app/io.mrarm.mcpelauncher/data/mcpelauncher/games/com.mojang'),
  );

  const result = runScript({ home, input: '2\n1\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /com\.mojang が複数見つかりました/);
  assertPackCopied(second, PACKS[0]);
  assertPackAbsent(first, PACKS[0]);
});

test('既存フォルダは上書きし、削除はしない', () => {
  const home = makeHome();
  const com = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));
  const dest = destPath(com, PACKS[0]);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'manifest.json'), 'stale');
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'keep');

  const result = runScript({ home, input: '1\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertPackCopied(com, PACKS[0]);
  assert.equal(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'keep', '削除してはいけない');
  assert.match(result.stdout, /\[INFO\] 更新/);
});

test('空 Enter は取消として何も変更しない', () => {
  const home = makeHome();
  const com = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));

  const result = runScript({ home, input: '\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /取消しました/);
  for (const pack of PACKS) assertPackAbsent(com, pack);
});

test('不正な選択は exit 1 で何も変更しない', () => {
  const home = makeHome();
  const com = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));

  for (const input of ['8\n', '0\n', 'abc\n', '1 x\n']) {
    const result = runScript({ home, input });
    assert.equal(result.status, 1, `${JSON.stringify(input)} は失敗する: ${result.stdout}`);
    assert.match(result.stderr, /\[ERROR\]/);
    for (const pack of PACKS) assertPackAbsent(com, pack);
  }
});

test('com.mojang が無ければ候補を列挙して exit 1', () => {
  const home = makeHome();
  const result = runScript({ home, input: '1\n' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /com\.mojang が見つかりません/);
  assert.ok(result.stderr.includes(path.join(home, '.local/share/mcpelauncher/games/com.mojang')));
  assert.match(result.stderr, /MC_COMOJANG/);
  assert.doesNotMatch(result.stdout, /利用可能なパック/);
});


test('BP/RP を判定できない manifest は対象外にする', () => {
  const sandbox = makeTempDir('invui-pack-sh-sandbox-');
  const script = path.join(sandbox, 'install-test-packs.sh');
  fs.copyFileSync(shPath, script);
  fs.chmodSync(script, 0o755);
  fs.mkdirSync(path.join(sandbox, 'probe/behavior_pack'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'probe/behavior_pack/manifest.json'), '{}');

  const com = makeComMojang(path.join(makeTempDir('invui-sandbox-com-'), 'com.mojang'));
  const result = runScript({
    home: makeHome(),
    args: [com],
    input: '1\\n',
    script,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /種類を判定できない/);
  assert.match(result.stderr, /インストール対象のパックが見つかりません/);
  assertPackAbsent(com, PACKS[0]);
});
