#!/usr/bin/env node
/*
 * bin/cli.js の小さな実行可能テスト。
 *
 * 目的:
 * - 既定の init がどのファイルも書き換えないこと（読み取り専用）
 * - --install-resource-pack 明示時だけ ui/invui.json を追加すること
 * - 既存ファイルを上書きせず、競合時は差分を出して中断すること
 * - 失敗時に部分適用を残さないこと
 * - 未検証の隔離プローブであり、置くだけではチェストへ適用されないと表示すること
 * - generate-resource-pack が init とは別に、新しい出力先へ同梱3ファイルを生成すること
 * - generate-resource-pack が既存パス・シンボリックリンクを拒否し、部分失敗時は自分が作ったものだけを戻すこと
 * - 生成 manifest の UUID が実行ごとに作り直されること
 * - 廃止した --report と、特別扱いしない check を受け付けないこと
 *
 * 実行:
 *   node tests/manual-bedrock/cli.test.mjs
 *   node --test tests/manual-bedrock/cli.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { generateResourcePack, placeFileWithoutOverwrite } from '../../bin/cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '..', '..', 'bin', 'cli.js');
const templatePath = path.resolve(here, '..', '..', 'resource_pack', 'ui', 'invui.json');
const templateReadmePath = path.resolve(here, '..', '..', 'resource_pack', 'README.md');
const bundledManifestPath = path.resolve(here, '..', '..', 'resource_pack', 'manifest.json');
const bundledUiDefsPath = path.resolve(here, '..', '..', 'resource_pack', 'ui', '_ui_defs.json');
const templateText = fs.readFileSync(templatePath, 'utf8');

function runCli(args, options = {}) {
  const result = spawnSync(options.nodePath || process.execPath, [...(options.nodeArgs || []), cliPath, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `CLI を起動できません: ${result.error && result.error.message}`);
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    both: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture() {
  // 出力先のシンボリックリンク検査が一時ディレクトリ自体のリンクに引っかからないよう実体化する。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'invui-cli-test-')));
  const behaviorPack = path.join(root, 'behavior_pack');
  const resourcePack = path.join(root, 'resource_pack');
  const outputDir = path.join(root, 'out');

  writeJson(path.join(behaviorPack, 'manifest.json'), {
    format_version: 2,
    header: {
      name: 'test behavior pack',
      uuid: '00000000-0000-0000-0000-000000000001',
      version: [1, 0, 0],
      min_engine_version: [1, 21, 0],
    },
    modules: [
      {
        type: 'script',
        language: 'javascript',
        uuid: '00000000-0000-0000-0000-000000000002',
        version: [1, 0, 0],
        entry: 'scripts/main.js',
      },
    ],
    dependencies: [{ module_name: '@minecraft/server', version: '1.0.0' }],
  });
  fs.mkdirSync(path.join(behaviorPack, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(behaviorPack, 'scripts', 'main.js'), '// test stub\n');

  writeJson(path.join(resourcePack, 'manifest.json'), {
    format_version: 2,
    header: {
      name: 'test resource pack',
      uuid: '00000000-0000-0000-0000-000000000003',
      version: [1, 0, 0],
      min_engine_version: [1, 21, 0],
    },
  });
  writeJson(path.join(resourcePack, 'ui', 'chest_screen.json'), { namespace: 'chest' });
  writeJson(path.join(resourcePack, 'ui', '_ui_defs.json'), { ui_defs: [] });
  fs.mkdirSync(outputDir, { recursive: true });

  return { root, behaviorPack, resourcePack, outputDir };
}

function snapshot(root) {
  const entries = new Map();
  const walk = (dir, relative = '') => {
    for (const name of fs.readdirSync(dir)) {
      const absolute = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, rel);
      } else {
        entries.set(rel, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'));
      }
    }
  };
  walk(root);
  return entries;
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((entry) => before.get(entry) !== after.get(entry)).sort();
}

function withFixture(callback) {
  const fixture = makeFixture();
  try {
    return callback(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('--help は beta・未検証・明示インストールの注意を表示して終了する', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /VirtualContainer/);
  assert.match(result.stdout, /未検証/);
  assert.match(result.stdout, /--install-resource-pack/);
  assert.match(result.stdout, /generate-resource-pack/);
  assert.match(result.stdout, /--output/);
  assert.match(result.stdout, /既定では.*書き込みません/);
});

test('コマンドなし・パラメータ不足・未対応コマンドは失敗する', () => {
  const none = runCli([]);
  assert.equal(none.status, 1);
  assert.match(none.both, /コマンド/);

  const missing = runCli(['init', '--behavior-pack', 'somewhere']);
  assert.equal(missing.status, 1);
  assert.match(missing.both, /resource-pack/);

  const installWithoutPack = runCli(['init', '--install-resource-pack']);
  assert.equal(installWithoutPack.status, 1);
  assert.match(installWithoutPack.both, /resource-pack/);

  const check = runCli(['check']);
  assert.equal(check.status, 1);
  assert.match(check.both, /不明なコマンド/);
});

test('init は既定ではパックを一切変更せず、未検証であることを表示する', () => {
  withFixture(({ behaviorPack, resourcePack }) => {
    const before = { behavior: snapshot(behaviorPack), resource: snapshot(resourcePack) };

    const result = runCli(['init', '--behavior-pack', behaviorPack, '--resource-pack', resourcePack]);

    assert.equal(result.status, 0, result.both);
    assert.match(result.stdout, /Beta/);
    assert.match(result.stdout, /VirtualContainer/);
    assert.match(result.stdout, /chest_screen\.json/);
    assert.match(result.stdout, /--install-resource-pack/);
    assert.match(result.stdout, /変更していません/);

    assert.deepEqual(snapshot(behaviorPack), before.behavior);
    assert.deepEqual(snapshot(resourcePack), before.resource);
  });
});

test('壊れた manifest.json は失敗し、パックは変更しない', () => {
  withFixture(({ behaviorPack, resourcePack }) => {
    const broken = path.join(resourcePack, 'manifest.json');
    fs.writeFileSync(broken, '{ this is not json');
    const before = { behavior: snapshot(behaviorPack), resource: snapshot(resourcePack) };

    const result = runCli(['init', '--behavior-pack', behaviorPack, '--resource-pack', resourcePack]);

    assert.equal(result.status, 1);
    assert.match(result.both, /manifest\.json/);
    assert.deepEqual(snapshot(behaviorPack), before.behavior);
    assert.deepEqual(snapshot(resourcePack), before.resource);
  });
});

test('--json は単体でパースできる JSON を出力する', () => {
  withFixture(({ behaviorPack, resourcePack }) => {
    const result = runCli([
      'init',
      '--behavior-pack',
      behaviorPack,
      '--resource-pack',
      resourcePack,
      '--json',
    ]);
    assert.equal(result.status, 0, result.both);

    const report = JSON.parse(result.stdout);
    assert.equal(report.tool, 'invui-bedrock');
    assert.equal(report.status, 'beta-unverified');
    assert.equal(report.resourcePackInstall.status, 'not-requested');
    assert.ok(report.notCreated.every((entry) => entry.action.startsWith('not-')));
  });
});

test('削除した --report は受け付けず、パックを変更しない', () => {
  withFixture(({ behaviorPack, resourcePack, outputDir }) => {
    const before = {
      behavior: snapshot(behaviorPack),
      resource: snapshot(resourcePack),
      output: snapshot(outputDir),
    };

    const result = runCli([
      'init',
      '--behavior-pack',
      behaviorPack,
      '--resource-pack',
      resourcePack,
      '--report',
      path.join(outputDir, 'report.json'),
    ]);

    assert.equal(result.status, 1);
    assert.match(result.both, /引数を解釈できません/);
    assert.equal(fs.existsSync(path.join(outputDir, 'report.json')), false);
    assert.deepEqual(snapshot(behaviorPack), before.behavior);
    assert.deepEqual(snapshot(resourcePack), before.resource);
    assert.deepEqual(snapshot(outputDir), before.output);
  });
});

test('テンプレートは JSON として読め、未接続の可視ラベルと button.send 部品だけを定義する', () => {
  const probe = JSON.parse(templateText);
  assert.equal(probe.namespace, 'invui_probe');
  assert.doesNotMatch(templateText, /chest_screen|chest/i);

  assert.deepEqual(
    Object.keys(probe).filter((key) => key !== 'namespace').sort(),
    ['invui_probe_panel', 'invui_probe_root', 'invui_probe_send_button'],
  );

  const root = probe.invui_probe_root;
  assert.equal(root.type, 'panel');
  assert.deepEqual(root.size, ['100%', '100%']);
  assert.deepEqual(
    root.controls.map((entry) => Object.keys(entry)[0]),
    ['probe_panel@invui_probe.invui_probe_panel'],
  );

  const panel = probe.invui_probe_panel;
  assert.equal(panel.type, 'stack_panel');
  assert.equal(panel.orientation, 'vertical');
  const panelNames = panel.controls.map((entry) => Object.keys(entry)[0]);
  assert.ok(panelNames.includes('send_button@invui_probe.invui_probe_send_button'));

  const labels = panel.controls
    .flatMap((entry) => Object.values(entry))
    .filter((control) => control.type === 'label');
  assert.ok(labels.length >= 2, '可視ラベルが 2 つ以上ある');
  assert.ok(labels.every((label) => typeof label.text === 'string' && label.text.length > 0));
  assert.ok(labels.some((label) => /unverified/i.test(label.text)));
  assert.ok(labels.some((label) => /button\.send/.test(label.text)));

  const button = probe.invui_probe_send_button;
  assert.equal(button.type, 'button');
  assert.equal(button.default_control, 'default');
  assert.deepEqual(
    button.button_mappings.map((mapping) => [
      mapping.from_button_id,
      mapping.to_button_id,
      mapping.mapping_type,
    ]),
    [
      ['button.menu_select', 'button.send', 'pressed'],
      ['button.menu_ok', 'button.send', 'focused'],
    ],
  );
  assert.ok(button.controls.some((entry) => entry.locked));

  const references = [];
  const collect = (entries) => {
    for (const entry of entries || []) {
      for (const [name, control] of Object.entries(entry)) {
        if (name.includes('@')) references.push(name);
        collect(control.controls);
      }
    }
  };
  collect(root.controls);
  collect(panel.controls);
  collect(button.controls);
  for (const reference of references) {
    assert.match(reference, /^[^@]+@invui_probe\./, `他名前空間を参照しない: ${reference}`);
  }

  const readme = fs.readFileSync(templateReadmePath, 'utf8');
  assert.match(readme, /置いただけでは/);
  assert.match(readme, /チェスト画面/);
  assert.match(readme, /未検証/);
  assert.match(readme, /上書きしません/);
  assert.match(readme, /競合/);
});

test('--install-resource-pack は ui/invui.json だけを追加し、既存ファイルを変更しない', () => {
  withFixture(({ behaviorPack, resourcePack }) => {
    const before = snapshot(resourcePack);

    const result = runCli([
      'init',
      '--behavior-pack',
      behaviorPack,
      '--resource-pack',
      resourcePack,
      '--install-resource-pack',
    ]);

    assert.equal(result.status, 0, result.both);
    assert.match(result.stdout, /導入済み/);
    assert.match(result.stdout, /ui\/invui\.json/);
    assert.match(result.stdout, /隔離プローブ/);
    assert.match(result.stdout, /置いただけではチェスト画面へ適用されません/);
    assert.match(result.stdout, /rm ".*ui\/invui\.json"/);

    const installed = path.join(resourcePack, 'ui', 'invui.json');
    assert.equal(fs.readFileSync(installed, 'utf8'), templateText);
    assert.deepEqual(changedPaths(before, snapshot(resourcePack)), ['ui/invui.json']);
    assert.deepEqual(fs.readFileSync(path.join(resourcePack, 'ui', 'chest_screen.json')), Buffer.from(
      `${JSON.stringify({ namespace: 'chest' }, null, 2)}\n`,
    ));
  });
});

test('--install-resource-pack は ui/ がなくても ui/invui.json だけを作る', () => {
  withFixture(({ resourcePack }) => {
    fs.rmSync(path.join(resourcePack, 'ui'), { recursive: true, force: true });
    const before = snapshot(resourcePack);

    const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);

    assert.equal(result.status, 0, result.both);
    assert.equal(fs.readFileSync(path.join(resourcePack, 'ui', 'invui.json'), 'utf8'), templateText);
    assert.deepEqual(changedPaths(before, snapshot(resourcePack)), ['ui/invui.json']);
    assert.match(result.stdout, /rmdir ".*\/ui"/);
  });
});

test('--install-resource-pack は Behavior Pack 指定なしでも動作する', () => {
  withFixture(({ resourcePack }) => {
    const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);
    assert.equal(result.status, 0, result.both);
    assert.equal(fs.existsSync(path.join(resourcePack, 'ui', 'invui.json')), true);
    assert.doesNotMatch(result.stdout, /Behavior Pack:/);
  });
});

test('同一内容の ui/invui.json が既にある場合は書き換えず成功する', () => {
  withFixture(({ resourcePack }) => {
    const installed = path.join(resourcePack, 'ui', 'invui.json');
    fs.writeFileSync(installed, templateText);
    const before = snapshot(resourcePack);

    const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);

    assert.equal(result.status, 0, result.both);
    assert.match(result.stdout, /同梱テンプレートと同一/);
    assert.deepEqual(snapshot(resourcePack), before);
  });
});

test('異なる ui/invui.json は上書きせず、差分を出して中断する', () => {
  withFixture(({ resourcePack }) => {
    const installed = path.join(resourcePack, 'ui', 'invui.json');
    const userContent = '{"namespace":"user_probe","note":"keep me"}\n';
    fs.writeFileSync(installed, userContent);
    const before = snapshot(resourcePack);

    const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);

    assert.equal(result.status, 1, result.both);
    assert.match(result.stdout, /競合/);
    assert.match(result.stdout, /上書きしません/);
    assert.match(result.stdout, /--- template: ui\/invui\.json/);
    assert.match(result.stdout, /\+.*user_probe/);
    assert.match(result.stdout, /-.*invui_probe/);
    assert.equal(fs.readFileSync(installed, 'utf8'), userContent);
    assert.deepEqual(snapshot(resourcePack), before);
  });
});

test('--json は導入結果と復元情報を出力する', () => {
  withFixture(({ resourcePack }) => {
    const result = runCli([
      'init',
      '--resource-pack',
      resourcePack,
      '--install-resource-pack',
      '--json',
    ]);

    assert.equal(result.status, 0, result.both);
    const report = JSON.parse(result.stdout);
    assert.equal(report.resourcePackInstall.status, 'installed');
    assert.deepEqual(
      report.resourcePackInstall.files.map((file) => [file.path, file.action]),
      [['ui/invui.json', 'created']],
    );
    assert.ok(report.resourcePackInstall.files[0].sha256);
    assert.equal(report.resourcePackInstall.files[0].sha256.length, 64);
    assert.ok(report.resourcePackInstall.restore.some((line) => line.startsWith('rm ')));
  });
});

test('--json の競合は差分つきで status=conflict を返す', () => {
  withFixture(({ resourcePack }) => {
    const installed = path.join(resourcePack, 'ui', 'invui.json');
    fs.writeFileSync(installed, '{"namespace":"user_probe"}\n');

    const result = runCli([
      'init',
      '--resource-pack',
      resourcePack,
      '--install-resource-pack',
      '--json',
    ]);

    assert.equal(result.status, 1, result.both);
    const report = JSON.parse(result.stdout);
    assert.equal(report.resourcePackInstall.status, 'conflict');
    assert.equal(report.resourcePackInstall.conflicts.length, 1);
    assert.equal(report.resourcePackInstall.conflicts[0].path, 'ui/invui.json');
    assert.match(report.resourcePackInstall.conflicts[0].diff, /user_probe/);
    assert.match(report.resourcePackInstall.conflicts[0].diff, /invui_probe/);
  });
});

test('検査エラー時は --install-resource-pack でも書き込まない', () => {
  withFixture(({ resourcePack }) => {
    fs.writeFileSync(path.join(resourcePack, 'manifest.json'), '{ broken');
    const before = snapshot(resourcePack);

    const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack', '--json']);

    assert.equal(result.status, 1, result.both);
    const report = JSON.parse(result.stdout);
    assert.equal(report.resourcePackInstall.status, 'blocked');
    assert.equal(report.resourcePackInstall.files.length, 0);
    assert.equal(fs.existsSync(path.join(resourcePack, 'ui', 'invui.json')), false);
    assert.deepEqual(snapshot(resourcePack), before);
  });
});

test(
  '書き込み失敗時は部分適用を残さない',
  { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) },
  () => {
    withFixture(({ resourcePack }) => {
      const uiDir = path.join(resourcePack, 'ui');
      const before = snapshot(resourcePack);
      fs.chmodSync(uiDir, 0o555);

      let result;
      try {
        result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);
      } finally {
        fs.chmodSync(uiDir, 0o755);
      }

      assert.equal(result.status, 1, result.both);
      assert.match(result.both, /ロールバック|失敗/);
      assert.equal(fs.existsSync(path.join(uiDir, 'invui.json')), false);
      assert.deepEqual(snapshot(resourcePack), before);
      assert.deepEqual(
        fs.readdirSync(uiDir).filter((name) => name.includes('.tmp')),
        [],
      );
    });
  },
);

test('ui がディレクトリでない場合は書き込まずに失敗する', () => {
  withFixture(({ resourcePack }) => {
    const uiPath = path.join(resourcePack, 'ui');
    fs.rmSync(uiPath, { recursive: true, force: true });
    fs.writeFileSync(uiPath, 'not a directory\n');
    const before = snapshot(resourcePack);

    const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);

    assert.equal(result.status, 1, result.both);
    assert.match(result.both, /失敗|ディレクトリ/);
    assert.equal(fs.readFileSync(uiPath, 'utf8'), 'not a directory\n');
    assert.deepEqual(snapshot(resourcePack), before);
  });
});

test(
  'ui がパック外を指すシンボリックリンクならパック外へ書き込まずに失敗する',
  { skip: process.platform === 'win32' },
  () => {
    withFixture(({ root, resourcePack }) => {
      const uiPath = path.join(resourcePack, 'ui');
      fs.rmSync(uiPath, { recursive: true, force: true });
      const outside = path.join(root, 'outside-ui');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, uiPath, 'dir');
      const before = snapshot(resourcePack);

      const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);

      assert.equal(result.status, 1, result.both);
      assert.match(result.both, /シンボリックリンク/);
      assert.equal(fs.lstatSync(uiPath).isSymbolicLink(), true);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(snapshot(resourcePack), before);
    });
  },
);

test(
  '壊れたシンボリックリンクでもパック外へ書き込まずに失敗する',
  { skip: process.platform === 'win32' },
  () => {
    withFixture(({ resourcePack }) => {
      const uiPath = path.join(resourcePack, 'ui');
      fs.rmSync(uiPath, { recursive: true, force: true });
      fs.symlinkSync(path.join(resourcePack, 'missing-target'), uiPath, 'dir');

      const result = runCli(['init', '--resource-pack', resourcePack, '--install-resource-pack']);

      assert.equal(result.status, 1, result.both);
      assert.match(result.both, /シンボリックリンク/);
      assert.equal(fs.existsSync(path.join(resourcePack, 'missing-target')), false);
      assert.equal(fs.lstatSync(uiPath).isSymbolicLink(), true);
    });
  },
);

test('ハードリンク不可でも排他作成で配置し、既存ファイルを上書きしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invui-cli-place-'));
  const originalLink = fs.linkSync;
  const tempPath = path.join(dir, 'template.tmp');
  const destination = path.join(dir, 'invui.json');
  try {
    fs.writeFileSync(tempPath, templateText);
    fs.linkSync = () => {
      const error = new Error('hard link is not supported');
      error.code = 'EPERM';
      throw error;
    };

    const identity = placeFileWithoutOverwrite(tempPath, destination);
    assert.equal(typeof identity.ino, 'number');
    assert.equal(fs.readFileSync(destination, 'utf8'), templateText);

    fs.writeFileSync(destination, 'keep me');
    assert.throws(() => placeFileWithoutOverwrite(tempPath, destination), /同時に作成/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'keep me');
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'copy fallback の書き込み失敗時、自分が作ったと確認できない宛先を削除しない',
  { skip: process.platform === 'win32' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invui-cli-place-'));
    const originalLink = fs.linkSync;
    const originalWriteFile = fs.writeFileSync;
    const originalUnlink = fs.unlinkSync;
    const tempPath = path.join(dir, 'template.tmp');
    const destination = path.join(dir, 'invui.json');
    try {
      originalWriteFile(tempPath, templateText);
      fs.linkSync = () => {
        const error = new Error('hard link is not supported');
        error.code = 'EPERM';
        throw error;
      };
      fs.writeFileSync = (target, ...args) => {
        if (typeof target === 'number') {
          // 別プロセスが宛先を置き換えた状況を再現する（inode が変わる）。
          originalUnlink(destination);
          originalWriteFile(destination, 'another process');
          const error = new Error('simulated write failure');
          error.code = 'EIO';
          throw error;
        }
        return originalWriteFile(target, ...args);
      };

      let caught;
      try {
        placeFileWithoutOverwrite(tempPath, destination);
      } catch (error) {
        caught = error;
      }

      assert.ok(caught, '書き込み失敗は呼び出し元へ伝える');
      assert.match(caught.message, /削除できません|確認できない/);
      assert.equal(fs.readFileSync(destination, 'utf8'), 'another process');
    } finally {
      fs.writeFileSync = originalWriteFile;
      fs.linkSync = originalLink;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'copy fallback の書き込み失敗時、自分が作った部分ファイルだけは戻す',
  { skip: process.platform === 'win32' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invui-cli-place-'));
    const originalLink = fs.linkSync;
    const originalWriteFile = fs.writeFileSync;
    const tempPath = path.join(dir, 'template.tmp');
    const destination = path.join(dir, 'invui.json');
    try {
      originalWriteFile(tempPath, templateText);
      fs.linkSync = () => {
        const error = new Error('hard link is not supported');
        error.code = 'EPERM';
        throw error;
      };
      fs.writeFileSync = (target, ...args) => {
        if (typeof target === 'number') {
          const error = new Error('simulated write failure');
          error.code = 'EIO';
          throw error;
        }
        return originalWriteFile(target, ...args);
      };

      assert.throws(() => placeFileWithoutOverwrite(tempPath, destination), /simulated write failure/);
      assert.equal(fs.existsSync(destination), false);
    } finally {
      fs.writeFileSync = originalWriteFile;
      fs.linkSync = originalLink;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('generate-resource-pack は --output 必須で、init 用フラグと混在させない', () => {
  const missingOutput = runCli(['generate-resource-pack']);
  assert.equal(missingOutput.status, 1);
  assert.match(missingOutput.both, /--output/);

  const mixed = runCli(['generate-resource-pack', '--output', 'unused', '--install-resource-pack']);
  assert.equal(mixed.status, 1);
  assert.match(mixed.both, /受け付けません/);

  const initWithOutput = runCli(['init', '--resource-pack', 'unused', '--output', 'unused']);
  assert.equal(initWithOutput.status, 1);
  assert.match(initWithOutput.both, /--output/);
});

test('generate-resource-pack は新しい出力先へ同梱3ファイルだけを生成する', () => {
  withFixture(({ root }) => {
    const output = path.join(root, 'generated_pack');
    const result = runCli(['generate-resource-pack', '--output', output]);

    assert.equal(result.status, 0, result.both);
    assert.match(result.stdout, /Experimental/);
    assert.match(result.stdout, /未接続/);
    assert.match(result.stdout, /実機未検証/);
    assert.match(result.stdout, /manifest\.json/);
    assert.match(result.stdout, /ui\/_ui_defs\.json/);
    assert.match(result.stdout, /ui\/invui\.json/);

    assert.deepEqual(fs.readdirSync(output).sort(), ['manifest.json', 'ui']);
    assert.deepEqual(fs.readdirSync(path.join(output, 'ui')).sort(), ['_ui_defs.json', 'invui.json']);
    assert.equal(fs.readFileSync(path.join(output, 'ui', 'invui.json'), 'utf8'), templateText);
    assert.deepEqual(
      fs.readFileSync(path.join(output, 'ui', '_ui_defs.json')),
      fs.readFileSync(bundledUiDefsPath),
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    const bundled = JSON.parse(fs.readFileSync(bundledManifestPath, 'utf8'));
    assert.notEqual(manifest.header.uuid, bundled.header.uuid);
    assert.notEqual(manifest.modules[0].uuid, bundled.modules[0].uuid);
    assert.match(manifest.header.description, /not connected/);

    // 既存の behavior_pack / resource_pack / out 以外を、fixture 直下に作っていない。
    assert.deepEqual(fs.readdirSync(root).sort(), ['behavior_pack', 'generated_pack', 'out', 'resource_pack']);
  });
});

test('generate-resource-pack は実行ごとに manifest の UUID を作り直す', () => {
  withFixture(({ root }) => {
    const first = runCli(['generate-resource-pack', '--output', path.join(root, 'pack_a'), '--json']);
    const second = runCli(['generate-resource-pack', '--output', path.join(root, 'pack_b'), '--json']);
    assert.equal(first.status, 0, first.both);
    assert.equal(second.status, 0, second.both);

    const a = JSON.parse(first.stdout);
    const b = JSON.parse(second.stdout);
    assert.equal(a.status, 'generated');
    assert.equal(b.status, 'generated');
    assert.equal(a.experimentalConnected, false);
    assert.equal(a.verifiedInGame, false);
    assert.equal(typeof a.notice, 'string');
    assert.match(a.notice, /未接続/);
    assert.deepEqual(a.files.map((file) => file.path), ['manifest.json', 'ui/_ui_defs.json', 'ui/invui.json']);
    assert.ok(a.files.every((file) => file.action === 'created' && file.sha256.length === 64));

    const uuids = [...a.uuids.map((entry) => entry.uuid), ...b.uuids.map((entry) => entry.uuid)];
    assert.equal(new Set(uuids).size, uuids.length, 'UUID は生成のたびに一意');
  });
});

test('generate-resource-pack は既存の出力先を上書きせず競合として中断する', () => {
  withFixture(({ root }) => {
    const existingDir = path.join(root, 'existing_dir');
    fs.mkdirSync(existingDir);
    fs.writeFileSync(path.join(existingDir, 'keep.txt'), 'keep me\n');
    const beforeDir = snapshot(root);

    const dirResult = runCli(['generate-resource-pack', '--output', existingDir]);
    assert.equal(dirResult.status, 1, dirResult.both);
    assert.match(dirResult.both, /上書きしません/);
    assert.deepEqual(snapshot(root), beforeDir);

    const existingFile = path.join(root, 'existing_file');
    fs.writeFileSync(existingFile, 'not a pack\n');
    const beforeFile = snapshot(root);

    const fileResult = runCli(['generate-resource-pack', '--output', existingFile]);
    assert.equal(fileResult.status, 1, fileResult.both);
    assert.match(fileResult.both, /上書きしません/);
    assert.equal(fs.readFileSync(existingFile, 'utf8'), 'not a pack\n');
    assert.deepEqual(snapshot(root), beforeFile);
  });
});

test(
  'generate-resource-pack は出力先がシンボリックリンクならリンク先へ書き込まずに失敗する',
  { skip: process.platform === 'win32' },
  () => {
    withFixture(({ root }) => {
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      const output = path.join(root, 'linked_pack');
      fs.symlinkSync(outside, output, 'dir');
      const before = snapshot(root);

      const result = runCli(['generate-resource-pack', '--output', output]);

      assert.equal(result.status, 1, result.both);
      assert.match(result.both, /シンボリックリンク/);
      assert.equal(fs.lstatSync(output).isSymbolicLink(), true);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(snapshot(root), before);
    });
  },
);

test(
  'generate-resource-pack の部分失敗時は自分が作ったファイルとディレクトリだけを削除する',
  { skip: process.platform === 'win32' },
  () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'invui-cli-generate-')));
    const output = path.join(root, 'pack');
    const originalWriteFile = fs.writeFileSync;
    try {
      fs.writeFileSync = (target, ...args) => {
        if (typeof target === 'string' && target.includes('_ui_defs.json')) {
          const error = new Error('simulated write failure');
          error.code = 'EIO';
          throw error;
        }
        return originalWriteFile(target, ...args);
      };

      let result;
      try {
        result = generateResourcePack(output);
      } finally {
        fs.writeFileSync = originalWriteFile;
      }

      assert.equal(result.status, 'failed');
      assert.match(result.error, /失敗/);
      assert.match(result.error, /この CLI が作成したものだけ/);
      assert.equal(fs.existsSync(output), false);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      fs.writeFileSync = originalWriteFile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
