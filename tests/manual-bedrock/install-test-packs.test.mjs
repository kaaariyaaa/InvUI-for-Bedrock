#!/usr/bin/env node
/*
 * install-test-packs.bat の静的チェック。
 *
 * Windows 実機では実行しない。確認するのは:
 * - cmd.exe のコードページ差で壊れないよう ASCII のみであること
 * - Minecraft 本体のグローバル behavior_packs / resource_packs へコピーすること
 * - ワールド選択や JSON 編集をしないこと（コピーだけで、有効化はゲーム側）
 * - 全 7 パックを列挙し、番号複数指定 / all / Enter 取消を持つこと
 * - 削除コマンドを含まず、xcopy /E /Y の上書きだけであること
 * - manifest UUID をハードコードしないこと
 * - README が bat と「実機未検証」を明記すること
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const batPath = path.join(here, 'install-test-packs.bat');
const readmePath = path.join(here, 'README.md');
const probeReadmePath = path.join(here, 'locked-click-probe', 'README.md');

const BATS = [
  { kind: 'BP', src: 'probe', dst: 'invui_probe', dir: 'probe/behavior_pack' },
  { kind: 'BP', src: 'locked-click-probe', dst: 'locked_click_probe', dir: 'locked-click-probe/behavior_pack' },
  { kind: 'RP', src: 'chest-resource-pack', dst: 'invui_chest_probe', dir: 'chest-resource-pack' },
  { kind: 'RP', src: 'data-driven-resource-pack', dst: 'invui_data_driven_probe', dir: 'data-driven-resource-pack' },
  { kind: 'RP', src: 'button-send-resource-pack', dst: 'invui_button_send_probe', dir: 'button-send-resource-pack' },
  { kind: 'RP', src: 'edit-box-resource-pack', dst: 'invui_edit_box_probe', dir: 'edit-box-resource-pack' },
  { kind: 'RP', src: 'protection-resource-pack', dst: 'invui_protection_probe', dir: 'protection-resource-pack' },
];

const bat = fs.readFileSync(batPath, 'ascii');

test('install-test-packs.bat は ASCII のみ', () => {
  const bytes = fs.readFileSync(batPath);
  assert.ok(
    bytes.every((byte) => byte < 0x80),
    'bat は cmd.exe のコードページ差を避けるため ASCII のみにする',
  );
});

test('グローバル behavior_packs / resource_packs へコピーし、ワールド選択と JSON 編集をしない', () => {
  assert.match(bat, /Microsoft\.MinecraftUWP_8wekyb3d8bbwe/);
  assert.match(bat, /LocalState\\games\\com\.mojang/);
  assert.match(bat, /\\behavior_packs"/);
  assert.match(bat, /\\resource_packs"/);
  assert.match(bat, /xcopy .*\/E \/Y/);

  assert.doesNotMatch(bat, /minecraftWorlds/i, 'ワールドは選択しない');
  assert.doesNotMatch(bat, /world_behavior_packs|world_resource_packs/i, 'JSON は編集しない');
  assert.doesNotMatch(bat, /level\.dat|levelname/i);
  assert.doesNotMatch(bat, /ConvertFrom-Json|ConvertTo-Json|pack_id/i);
});

test('削除コマンドを持たず、存在しないフォルダは ERROR で中断する', () => {
  assert.doesNotMatch(bat, /\b(del|erase|rd|rmdir|Remove-Item|Move-Item)\b/i);
  assert.doesNotMatch(bat, /\bmkdir\b/i, 'フォルダは作らず、無ければ ERROR にする');
  assert.match(bat, /if not exist "!SRC!\\manifest\.json"/);
  assert.match(bat, /\[ERROR\]/);
  assert.match(bat, /Launch Minecraft once/);
});

test('全 7 パック（BP 2 / RP 5）を列挙する', () => {
  for (const pack of BATS) {
    assert.match(bat, new RegExp(`:${pack.kind}:${pack.src.replace(/-/g, '\\-')}:`), `${pack.src} が一覧にない`);
    assert.match(bat, new RegExp(`:${pack.dst}(?=\\s|"|$)`), `${pack.dst} が一覧にない`);
    assert.ok(
      fs.existsSync(path.join(here, pack.dir, 'manifest.json')),
      `${pack.dir}/manifest.json が存在する`,
    );
  }
  assert.equal(bat.match(/:BP:/g)?.length, 2);
  assert.equal(bat.match(/:RP:/g)?.length, 5);
});

test('番号複数指定・all・Enter 取消と、インストール済み表示を持つ', () => {
  assert.match(bat, /set \/p "SEL=/);
  assert.match(bat, /for \/f "delims=0123456789 " %%A in \("!SEL!"\)/);
  assert.match(bat, /GTR 7/);
  assert.match(bat, /LSS 1/);
  assert.match(bat, /if \/i "!SEL!"=="all"/);
  assert.match(bat, /Nothing was changed/);
  assert.match(bat, /if exist "!DEST!" set "TAG= \(installed\)"/);
  assert.match(bat, /Multiple resource packs selected/);
});

test('manifest UUID をハードコードしない', () => {
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.doesNotMatch(bat, uuidPattern);
  for (const pack of BATS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(here, pack.dir, 'manifest.json'), 'utf8'));
    assert.ok(!bat.toLowerCase().includes(manifest.header.uuid.toLowerCase()));
    for (const module of manifest.modules ?? []) {
      assert.ok(!bat.toLowerCase().includes(module.uuid.toLowerCase()));
    }
  }
});

test('pause は最後だけ（--no-pause で抑止）', () => {
  assert.equal(bat.match(/ pause\s*$/gm)?.length, 1);
  assert.match(bat, /if \/i not "%~1"=="--no-pause" pause/);
});

test('README は install-test-packs.bat と実機未検証を明記する', () => {
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert.match(readme, /install-test-packs\.bat/);
  assert.doesNotMatch(readme, /install-to-world\.bat/);

  const probeReadme = fs.readFileSync(probeReadmePath, 'utf8');
  assert.match(probeReadme, /install-test-packs\.bat/);
  assert.match(probeReadme, /bat[^\n]*実機未検証/);
  assert.doesNotMatch(probeReadme, /install-to-world\.bat/);
});
