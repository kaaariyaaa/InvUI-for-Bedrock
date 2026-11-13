#!/usr/bin/env node
/*
 * invui-bedrock setup helper (inspection only)
 *
 * 重要な前提:
 * - VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計。
 * - クリック / アイテム保護 / JSON UI / InventoryLink は実機未検証であり、
 *   この時点で「安全に利用できる機能」として扱わない。
 * - この CLI は Behavior Pack / Resource Pack を書き換えない。JSON UI も生成しない。
 * - どのファイルにも書き込まない（検査結果は標準出力へ出すだけ）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const TOOL_NAME = 'invui-bedrock';
const FALLBACK_VERSION = '0.1.0-beta.1';

const BETA_LINES = [
  'VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計です。',
  'クリック、アイテム保護、JSON UI、InventoryLink は実機未検証であり、安全に利用できません。',
  'この CLI は Behavior Pack / Resource Pack へ書き込まず、JSON UI も生成しません。',
];

const BETA_NOTICE =
  'VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計です。' +
  'クリック、アイテム保護、JSON UI、InventoryLink は実機未検証であり、安全に利用できる状態ではありません。';

const USAGE = `invui-bedrock — setup helper (inspection only)

使い方:
  invui-bedrock init --behavior-pack <dir> --resource-pack <dir> [--json]
  invui-bedrock --help
  invui-bedrock --version

コマンド:
  init    Behavior Pack / Resource Pack を静的に検査し、手動で必要な作業を表示する
          （パック内のファイルは変更しません）

オプション:
  --behavior-pack <dir>   Behavior Pack のルート
  --resource-pack <dir>   Resource Pack のルート
  --json                  結果を JSON として標準出力へ出す
  -h, --help              この説明を表示
  -v, --version           バージョンを表示

注意:
  - ${BETA_LINES[0]}
  - ${BETA_LINES[1]}
  - ${BETA_LINES[2]}
  - init は検査と手順表示だけを行う。Resource Pack の導入手順は自動化しない。
`;

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function err(line = '') {
  process.stderr.write(`${line}\n`);
}

function readVersion() {
  try {
    const cliDir = path.dirname(path.resolve(process.argv[1] || '.'));
    const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function addCheck(checks, area, id, level, message) {
  checks.push({ area, id, level, message });
}

function inspectPack(root, area) {
  const checks = [];
  const label = area === 'behavior-pack' ? 'Behavior Pack' : 'Resource Pack';

  if (!fs.existsSync(root)) {
    addCheck(checks, area, 'root.exists', 'error', `${label} のパスが存在しません: ${root}`);
    return checks;
  }
  if (!isDirectory(root)) {
    addCheck(checks, area, 'root.directory', 'error', `${label} のパスがディレクトリではありません: ${root}`);
    return checks;
  }
  addCheck(checks, area, 'root.directory', 'ok', `${label} のディレクトリを確認しました`);

  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    addCheck(checks, area, 'manifest.exists', 'error', 'manifest.json がありません');
    return checks;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    addCheck(checks, area, 'manifest.json', 'error', `manifest.json を JSON として読めません: ${error.message}`);
    return checks;
  }
  addCheck(checks, area, 'manifest.exists', 'ok', 'manifest.json を読み込みました');

  const header = manifest && typeof manifest === 'object' ? manifest.header : undefined;
  if (!header || typeof header !== 'object') {
    addCheck(checks, area, 'manifest.header', 'error', 'manifest.header がありません');
  } else if (Array.isArray(header.min_engine_version)) {
    addCheck(
      checks,
      area,
      'manifest.min_engine_version',
      'ok',
      `min_engine_version: ${header.min_engine_version.join('.')}（対応ゲーム版は実機で記録する）`,
    );
  } else {
    addCheck(checks, area, 'manifest.min_engine_version', 'warn', 'header.min_engine_version が配列でありません');
  }

  if (area === 'behavior-pack') {
    const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
    const scriptModule = modules.find((module) => module && module.type === 'script');
    if (!scriptModule) {
      addCheck(checks, area, 'bp.script-module', 'warn', 'script モジュールが manifest.modules にありません');
    } else {
      addCheck(checks, area, 'bp.script-module', 'ok', 'script モジュールがあります');
      if (typeof scriptModule.entry === 'string') {
        const entryPath = path.join(root, scriptModule.entry);
        if (fs.existsSync(entryPath)) {
          addCheck(checks, area, 'bp.entry', 'ok', `script entry が存在します: ${scriptModule.entry}`);
        } else {
          addCheck(
            checks,
            area,
            'bp.entry',
            'warn',
            `script entry が見つかりません（ビルド前なら想定内）: ${scriptModule.entry}`,
          );
        }
      } else {
        addCheck(checks, area, 'bp.entry', 'warn', 'script モジュールの entry が文字列ではありません');
      }
    }

    const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
    const hasServer = dependencies.some(
      (dependency) => dependency && dependency.module_name === '@minecraft/server',
    );
    if (hasServer) {
      addCheck(checks, area, 'bp.dependency', 'ok', '@minecraft/server への dependency があります');
    } else {
      addCheck(
        checks,
        area,
        'bp.dependency',
        'warn',
        '@minecraft/server への dependency がありません。Experimental モジュールの指定を確認してください',
      );
    }

    addCheck(
      checks,
      area,
      'bp.experimental',
      'info',
      'Experimental API の有効化と @minecraft/server の版は manifest だけでは確定できません。ゲーム内で確認し、記録してください',
    );
  } else {
    const uiDir = path.join(root, 'ui');
    if (isDirectory(uiDir)) {
      addCheck(checks, area, 'rp.ui', 'ok', 'ui/ ディレクトリがあります');
    } else {
      addCheck(checks, area, 'rp.ui', 'warn', 'ui/ ディレクトリがありません');
    }

    const chestScreen = path.join(uiDir, 'chest_screen.json');
    if (fs.existsSync(chestScreen)) {
      addCheck(
        checks,
        area,
        'rp.chest-screen',
        'warn',
        '既存の ui/chest_screen.json を検出しました。この CLI は変更しません。手動マージとバックアップが必要です',
      );
    }

    const invuiJson = path.join(uiDir, 'invui.json');
    if (fs.existsSync(invuiJson)) {
      addCheck(
        checks,
        area,
        'rp.invui-json',
        'warn',
        'ui/invui.json が既にあります。上書きしません。内容が対象ゲーム版に合うか手動で確認してください',
      );
    }

    if (fs.existsSync(path.join(uiDir, '_ui_defs.json'))) {
      addCheck(
        checks,
        area,
        'rp.ui-defs',
        'info',
        'ui/_ui_defs.json があります。参照追加は自動変更しません。手動で差分を確認してください',
      );
    }

    addCheck(
      checks,
      area,
      'rp.json-ui-unverified',
      'warn',
      'JSON UI とチェスト画面への適用方法は実機未検証です。このバージョンは JSON UI テンプレートを同梱していません',
    );
  }

  return checks;
}

function buildReport(version, behaviorPack, resourcePack) {
  const checks = [
    ...inspectPack(behaviorPack, 'behavior-pack'),
    ...inspectPack(resourcePack, 'resource-pack'),
  ];

  return {
    tool: TOOL_NAME,
    toolVersion: version,
    generatedAt: new Date().toISOString(),
    status: 'beta-unverified',
    notice: BETA_NOTICE,
    inputs: {
      behaviorPack,
      resourcePack,
    },
    checks,
    notCreated: [
      {
        path: path.join(resourcePack, 'ui', 'invui.json'),
        action: 'not-created',
        reason:
          'JSON UI の適用方式とクリック通知が実機未検証のため、危険な UI ファイルを自動生成しません。' +
          '検証が完了するまでクリック機能は安全に利用できません。',
      },
      {
        path: path.join(resourcePack, 'ui', '_ui_defs.json'),
        action: 'not-modified',
        reason: '既存ファイルとの競合を避けるため、参照追加は自動変更しません。',
      },
      {
        path: path.join(resourcePack, 'ui', 'chest_screen.json'),
        action: 'not-modified',
        reason: '標準チェスト画面の既存定義を上書きしません。必要な場合は手動でマージしてください。',
      },
    ],
    manualSteps: [
      '対象の Minecraft が Preview/Beta で、設計書が前提とする Experimental API を利用できる状態か確認する。',
      'ゲーム版と @minecraft/server の版を実機テスト記録に残す。',
      'tests/manual-bedrock/CHECKLIST.md の検証が終わるまで、クリック・アイテム保護・JSON UI 連携を有効な機能として扱わない。',
      'Resource Pack の UI 変更が必要な場合は、既存ファイルのバックアップを取り、手動で差分をマージする。この CLI は変更しない。',
      'InventoryLink を実機の安全試験に合格するまで有効化しない。',
    ],
  };
}

function printChecks(checks, area, heading) {
  const filtered = checks.filter((check) => check.area === area);
  out(heading);
  if (filtered.length === 0) {
    out('  （検査項目なし）');
    return;
  }
  const symbols = { ok: '[ OK ]', warn: '[WARN]', error: '[FAIL]', info: '[INFO]' };
  for (const check of filtered) {
    out(`  ${symbols[check.level] || '[????]'} ${check.message}`);
  }
}

function printHuman(report) {
  out(`${TOOL_NAME} ${report.toolVersion} — setup helper (inspection only)`);
  out('');
  out('[注意] Beta / 実機未検証');
  for (const line of BETA_LINES) {
    out(`  ${line}`);
  }
  out('');

  printChecks(report.checks, 'behavior-pack', `Behavior Pack: ${report.inputs.behaviorPack}`);
  out('');
  printChecks(report.checks, 'resource-pack', `Resource Pack: ${report.inputs.resourcePack}`);
  out('');

  out('自動で作成・変更しないファイル（未検証のため）');
  for (const entry of report.notCreated) {
    out(`  - ${entry.path}`);
    out(`    ${entry.action}: ${entry.reason}`);
  }
  out('');

  out('次に必要な手動確認');
  report.manualSteps.forEach((step, index) => {
    out(`  ${index + 1}. ${step}`);
  });
  out('');

  out('この CLI は Behavior Pack / Resource Pack のファイルを変更していません。');
}

function main(argv) {
  const version = readVersion();

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'behavior-pack': { type: 'string' },
        'resource-pack': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    err(`[FAIL] 引数を解釈できません: ${error.message}`);
    err('');
    err(USAGE);
    return 1;
  }

  if (parsed.values.help) {
    out(USAGE);
    return 0;
  }

  if (parsed.values.version) {
    out(`${TOOL_NAME} ${version}`);
    return 0;
  }

  const command = parsed.positionals[0];
  if (!command) {
    err('[FAIL] コマンドを指定してください。');
    err('');
    err(USAGE);
    return 1;
  }

  if (command !== 'init') {
    err(`[FAIL] 不明なコマンドです: ${command}`);
    err('');
    err(USAGE);
    return 1;
  }

  const rawBehaviorPack = parsed.values['behavior-pack'];
  const rawResourcePack = parsed.values['resource-pack'];
  if (!rawBehaviorPack || !rawResourcePack) {
    err('[FAIL] init には --behavior-pack と --resource-pack の両方が必要です。');
    err('');
    err(USAGE);
    return 1;
  }

  const behaviorPack = path.resolve(rawBehaviorPack);
  const resourcePack = path.resolve(rawResourcePack);

  const report = buildReport(version, behaviorPack, resourcePack);
  const hasErrors = report.checks.some((check) => check.level === 'error');

  if (parsed.values.json) {
    out(JSON.stringify(report, null, 2));
    return hasErrors ? 1 : 0;
  }

  printHuman(report);
  return hasErrors ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
