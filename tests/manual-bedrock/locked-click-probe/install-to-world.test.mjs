#!/usr/bin/env node
/*
 * install-to-world.bat の静的チェック。
 *
 * Windows 実機では実行しない。確認するのは:
 * - cmd.exe のコードページ差で壊れないよう ASCII のみであること
 * - minecraftWorlds 配下のワールドを列挙し、選択番号で 1 つに絞ること
 * - behavior_pack を world/behavior_packs/locked_click_probe へコピーすること
 * - world_behavior_packs.json をバックアップし、manifest の uuid/version を使い、
 *   pack_id の重複を避けること
 * - ユーザーファイルを削除するコマンドを含まないこと
 * - README が bat と「実機未検証」を明記すること
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const batPath = path.join(here, 'install-to-world.bat');
const readmePath = path.join(here, 'README.md');

test('install-to-world.bat は ASCII のみで、ワールド列挙と番号選択を行う', () => {
  const bytes = fs.readFileSync(batPath);
  assert.ok(
    bytes.every((byte) => byte < 0x80),
    'bat は cmd.exe のコードページ差を避けるため ASCII のみにする',
  );

  const bat = bytes.toString('ascii');
  assert.match(bat, /Microsoft\.MinecraftUWP_8wekyb3d8bbwe/);
  assert.match(bat, /LocalState\\games\\com\.mojang\\minecraftWorlds/);
  assert.match(bat, /for \/d %%/);
  assert.match(bat, /set \/p "SEL=/);
  assert.match(bat, /findstr \/r "\^\[0-9\]/);
});

test('install-to-world.bat は behavior_pack をコピーし、ユーザーファイルを削除しない', () => {
  const bat = fs.readFileSync(batPath, 'ascii');

  assert.match(bat, /set "PACK=%~dp0behavior_pack"/);
  assert.match(bat, /locked_click_probe/);
  assert.match(bat, /xcopy /i);
  assert.doesNotMatch(bat, /\b(del|erase|rd|rmdir|Remove-Item|Move-Item)\b/i);
});

test('install-to-world.bat は manifest の uuid/version で JSON を追記し、重複を避ける', () => {
  const bat = fs.readFileSync(batPath, 'ascii');

  assert.match(bat, /manifest\.json/);
  assert.match(bat, /header\.uuid/);
  assert.match(bat, /header\.version/);
  assert.match(bat, /world_behavior_packs\.json/);
  assert.match(bat, /\.bak-/);
  assert.match(bat, /Copy-Item/);
  assert.match(bat, /\$e\.pack_id -eq \$u/);
  assert.match(bat, /pack_id = \$u; version = \$v/);
  // UUID を bat に固定しない（manifest.json を唯一の出所にする）。
  assert.doesNotMatch(bat, /c980bbce-7652-4920-97a1-c5e3376a2428/i);
});

test('README は install-to-world.bat と実機未検証を明記する', () => {
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert.match(readme, /install-to-world\.bat/);
  assert.match(readme, /bat[^\n]*実機未検証/);
});
