#!/usr/bin/env node
/*
 * bin/cli.js の小さな実行可能テスト。
 *
 * 目的:
 * - CLI がどのファイルも書き換えないこと（常に読み取り専用）
 * - 廃止した --report と、特別扱いしない check を受け付けないこと
 * - 実機未検証であることを出力に含めること
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

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '..', '..', 'bin', 'cli.js');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invui-cli-test-'));
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

function withFixture(callback) {
  const fixture = makeFixture();
  try {
    return callback(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('--help は beta と未検証の注意を表示して終了する', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /VirtualContainer/);
  assert.match(result.stdout, /未検証/);
  assert.match(result.stdout, /書き込まず/);
});

test('コマンドなし・パラメータ不足・未対応コマンドは失敗する', () => {
  const none = runCli([]);
  assert.equal(none.status, 1);
  assert.match(none.both, /コマンド/);

  const missing = runCli(['init', '--behavior-pack', 'somewhere']);
  assert.equal(missing.status, 1);
  assert.match(missing.both, /resource-pack/);

  const check = runCli(['check']);
  assert.equal(check.status, 1);
  assert.match(check.both, /不明なコマンド/);
});

test('init はパックを一切変更せず、未検証であることを表示する', () => {
  withFixture(({ behaviorPack, resourcePack }) => {
    const before = { behavior: snapshot(behaviorPack), resource: snapshot(resourcePack) };

    const result = runCli(['init', '--behavior-pack', behaviorPack, '--resource-pack', resourcePack]);

    assert.equal(result.status, 0, result.both);
    assert.match(result.stdout, /Beta/);
    assert.match(result.stdout, /VirtualContainer/);
    assert.match(result.stdout, /chest_screen\.json/);
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
