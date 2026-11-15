#!/usr/bin/env node
/*
 * install-test-packs.sh の静的チェックと、偽 com.mojang を使った実行チェック。
 *
 * 実際の Minecraft は起動しない。確認するのは:
 * - 実行ビットがあり、bash + 標準コマンド（cp -R）だけで動くこと
 * - 削除コマンド（rm など）を持たないこと
 * - 7 パック（BP 2 / RP 5）を列挙し、番号複数指定 / all / Enter 取消を持つこと
 * - com.mojang の既知候補検出と、引数 / MC_COMOJANG / 複数候補の番号選択
 * - 選択したパックだけを behavior_packs / resource_packs へ上書きコピーすること
 * - 取消・不正入力・ソース欠落では何も変更しないこと
 * - README が .bat (Windows) / .sh (Linux・macOS) を指すこと
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

const PACKS = [
  { kind: 'BP', src: 'probe/behavior_pack', dst: 'invui_probe' },
  { kind: 'BP', src: 'locked-click-probe/behavior_pack', dst: 'locked_click_probe' },
  { kind: 'RP', src: 'chest-resource-pack', dst: 'invui_chest_probe' },
  { kind: 'RP', src: 'data-driven-resource-pack', dst: 'invui_data_driven_probe' },
  { kind: 'RP', src: 'button-send-resource-pack', dst: 'invui_button_send_probe' },
  { kind: 'RP', src: 'edit-box-resource-pack', dst: 'invui_edit_box_probe' },
  { kind: 'RP', src: 'protection-resource-pack', dst: 'invui_protection_probe' },
];

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

test('全 7 パック（BP 2 / RP 5）を bat と同じコピー先で列挙する', () => {
  for (const pack of PACKS) {
    assert.ok(sh.includes(`|${pack.kind}|${pack.src}|${pack.dst}`), `${pack.src} -> ${pack.dst} が一覧にない`);
    assert.ok(
      fs.existsSync(path.join(here, pack.src, 'manifest.json')),
      `${pack.src}/manifest.json が存在する`,
    );
  }
  assert.equal(sh.match(/\|BP\|/g)?.length, 2);
  assert.equal(sh.match(/\|RP\|/g)?.length, 5);
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

test('README は .bat (Windows) / .sh (Linux・macOS) を指す', () => {
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert.match(
    readme,
    /`install-test-packs\.bat` \(Windows\) \/ `install-test-packs\.sh` \(Linux・macOS\)/,
  );
  assert.doesNotMatch(readme, /install-to-world\.bat/);

  const probeReadme = fs.readFileSync(probeReadmePath, 'utf8');
  assert.match(
    probeReadme,
    /`\.\.\/install-test-packs\.bat` \(Windows\) \/ `\.\.\/install-test-packs\.sh` \(Linux・macOS\)/,
  );
  assert.match(probeReadme, /bat[^\n]*実機未検証/);
  assert.doesNotMatch(probeReadme, /install-to-world\.bat/);
});

// --- 実行チェック（偽 com.mojang。Minecraft は起動しない） ---------------------

test('既知候補を自動検出し、選んだパックだけをコピーする', () => {
  const home = makeHome();
  const com = makeComMojang(path.join(home, '.local/share/mcpelauncher/games/com.mojang'));

  const result = runScript({ home, input: '1 3\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assertPackCopied(com, PACKS[0]);
  assertPackCopied(com, PACKS[2]);
  for (const pack of [PACKS[1], PACKS[3], PACKS[4], PACKS[5], PACKS[6]]) {
    assertPackAbsent(com, pack);
  }
  assert.match(result.stdout, /ワールド設定で有効化/);
  assert.match(result.stdout, /1つずつ/);
  assert.match(result.stdout, /実機未検証/);
});

test('all は 7 パックすべてをコピーする', () => {
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

test('ソース欠落はコピー前に検出し、何も変更しない', () => {
  const sandbox = makeTempDir('invui-pack-sh-sandbox-');
  const script = path.join(sandbox, 'install-test-packs.sh');
  fs.copyFileSync(shPath, script);
  fs.chmodSync(script, 0o755);
  fs.mkdirSync(path.join(sandbox, 'probe/behavior_pack'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'probe/behavior_pack/manifest.json'), '{}');
  // locked-click-probe は置かない（選択 2 が欠落）。

  const com = makeComMojang(path.join(makeTempDir('invui-sandbox-com-'), 'com.mojang'));
  const result = runScript({
    home: makeHome(),
    args: [com],
    input: '1 2\n',
    script,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /manifest\.json がない/);
  assertPackAbsent(com, PACKS[0]);
  assertPackAbsent(com, PACKS[1]);
});
