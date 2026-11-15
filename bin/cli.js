#!/usr/bin/env node
/*
 * invui-bedrock setup helper (static inspection)
 *
 * 重要な前提:
 * - VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計。
 * - クリック / アイテム保護 / JSON UI / InventoryLink は実機未検証であり、
 *   この時点で「安全に利用できる機能」として扱わない。
 * - この CLI は Behavior Pack を静的に検査して手動作業を表示するだけで、ファイルを変更しない。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TOOL_NAME = 'invui-bedrock';
const FALLBACK_VERSION = '0.1.0-beta.1';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BETA_NOTICE =
  'VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計です。' +
  'クリック、アイテム保護、JSON UI、InventoryLink は実機未検証であり、安全に利用できる状態ではありません。';

const USAGE = `invui-bedrock — setup helper (static inspection)

使い方:
  invui-bedrock init --behavior-pack <dir> [--json]
  invui-bedrock --help
  invui-bedrock --version

コマンド:
  init    Behavior Pack を静的に検査し、手動で必要な作業を表示する
          パック内のファイルは変更しない

オプション:
  --behavior-pack <dir>             Behavior Pack のルート（必須）
  --json                            結果を JSON として標準出力へ出す
  -h, --help                        この説明を表示
  -v, --version                     バージョンを表示

注意:
  - VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計です。
  - クリック、アイテム保護、JSON UI、InventoryLink は実機未検証であり、安全に利用できません。
  - この CLI は検査だけで、Behavior Pack へは書き込みません。
`;

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function err(line = '') {
  process.stderr.write(`${line}\n`);
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
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

  // JSON としては読めてもルートがオブジェクトでない manifest は無効。
  // null のままプロパティを読むと TypeError で CLI が落ちるため、ここで止める。
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    addCheck(
      checks,
      area,
      'manifest.root',
      'error',
      'manifest.json のルートがオブジェクトではありません。manifest の形式を確認してください',
    );
    return checks;
  }

  const header = manifest.header;
  if (!header || typeof header !== 'object') {
    addCheck(checks, area, 'manifest.header', 'error', 'manifest.header がありません');
  } else {
    // min_engine_version は配列（format_version 2 まで）と SemVer 文字列（format_version 3 では必須）の
    // どちらも有効。ただしここで見るのは型と、文字列が空でないことだけで、SemVer の形式は検証しない。
    // 配列だけを有効扱いすると、正しい v3 manifest に「配列でありません」と誤案内し、
    // 利用者が文字列を配列へ書き換えて逆に壊しかねない。
    const minEngineVersion = header.min_engine_version;
    let minEngineText = null;
    if (Array.isArray(minEngineVersion)) {
      minEngineText = minEngineVersion.join('.');
    } else if (typeof minEngineVersion === 'string' && minEngineVersion.trim() !== '') {
      minEngineText = minEngineVersion.trim();
    }
    if (minEngineText !== null) {
      addCheck(
        checks,
        area,
        'manifest.min_engine_version',
        'ok',
        `min_engine_version: ${minEngineText}（値の形式は検証していません。対応ゲーム版は実機で記録する）`,
      );
    } else if (minEngineVersion === undefined) {
      addCheck(checks, area, 'manifest.min_engine_version', 'warn', 'header.min_engine_version がありません');
    } else {
      addCheck(
        checks,
        area,
        'manifest.min_engine_version',
        'warn',
        'header.min_engine_version が配列（例: [1, 21, 0]）でも空でない文字列（例: "1.26.40"）でもありません',
      );
    }
  }

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

  return checks;
}

function buildReport(version, behaviorPack) {
  return {
    tool: TOOL_NAME,
    toolVersion: version,
    generatedAt: new Date().toISOString(),
    status: 'beta-unverified',
    notice: BETA_NOTICE,
    inputs: { behaviorPack },
    checks: inspectPack(behaviorPack, 'behavior-pack'),
    manualSteps: [
      '対象の Minecraft が Preview/Beta で、設計書が前提とする Experimental API を利用できる状態か確認する。',
      'ゲーム版と @minecraft/server の版を実機検証の記録に残す。',
      'クリック・アイテム保護・JSON UI 連携は実機未検証。合格を記録するまで有効な機能として扱わない。',
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
  out(`${TOOL_NAME} ${report.toolVersion} — setup helper (static inspection)`);
  out('');
  out('[注意] Beta / 実機未検証');
  out(`  ${report.notice}`);
  out('');
  printChecks(report.checks, 'behavior-pack', `Behavior Pack: ${report.inputs.behaviorPack}`);
  out('');
  out('次に必要な手動確認');
  report.manualSteps.forEach((step, index) => {
    out(`  ${index + 1}. ${step}`);
  });
  out('');
  out('この CLI は検査だけで、パック内のファイルは変更していません。');
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
  if (!rawBehaviorPack) {
    err('[FAIL] init には --behavior-pack が必要です。');
    err('');
    err(USAGE);
    return 1;
  }

  const report = buildReport(version, path.resolve(rawBehaviorPack));
  const hasErrors = report.checks.some((check) => check.level === 'error');

  if (parsed.values.json) {
    out(JSON.stringify(report, null, 2));
    return hasErrors ? 1 : 0;
  }

  printHuman(report);
  return hasErrors ? 1 : 0;
}

// 直接実行されたときだけ動かす。import 時の副作用を避ける。
// npm の bin はシンボリックリンク経由で起動され、Node はメインモジュールの
// リンクを解決するため import.meta.url は実体パスになる。一方 process.argv[1]
// はリンクのパスのまま残るので、両方を実体パスに直してから比較する。
function realPathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

const scriptPath = process.argv[1] ? realPathOrNull(process.argv[1]) : null;
if (scriptPath && scriptPath === realPathOrNull(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}

export { inspectPack, main };
