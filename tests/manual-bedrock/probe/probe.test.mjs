#!/usr/bin/env node
/*
 * tests/manual-bedrock/probe の小さな静的チェック。
 *
 * 目的:
 * - manifest.json が JSON として読め、依存と UUID が意図どおりであること
 * - scripts/main.js が Node の構文チェックを通ること
 * - 危険警告・対象 API・使い捨てアイテムの方針が残っていること
 * - `!invui open [size] [ticks]` の tick 予約が（モック上で）server close を呼ぶこと
 * - 同一 size の共有コンテナで複数画面を開かないための open ガード（閲覧者・pending・getViewers 失敗）
 * - fill は閲覧者がいなくても pending（open 後 close イベント前）なら拒否し、close 後のみ書き込む
 * - `!invui:` prefix の通知だけを cancel し、観測ログだけ出して click を実行しないこと
 * - close / itemChange の event.container が create() の戻り値と同一参照かを真偽値で記録し、
 *   別参照でも既存の close / itemChange 処理が止まらないこと
 * - Resource Pack / JSON UI を同梱していないこと
 *
 * 実機の表示・close reason・itemChange を検証するものではない。
 *
 * 実行:
 *   node tests/manual-bedrock/probe/probe.test.mjs
 *   node --test tests/manual-bedrock/probe/probe.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const packDir = path.join(here, 'behavior_pack');
const manifestPath = path.join(packDir, 'manifest.json');
const scriptPath = path.join(packDir, 'scripts', 'main.js');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * main.js を @minecraft/server 抜きで vm 上に読み込み、チャット・timer・イベントを模擬する。
 * 実機 API の再現ではなく、コマンド解釈・ガード・会計の配線だけを見る。
 *
 * options.viewers: getViewers() が返す閲覧者（既定は空）。返り値の viewers 配列を直接変更できる。
 * options.getViewersThrows: getViewers() を失敗させる（fill / open の fail-closed 確認用）。
 * 返り値の setGetViewersThrows() で途中から切り替えられる。
 */
function loadProbe(options = {}) {
  const source = fs.readFileSync(scriptPath, 'utf8').replace(/^import[^\n]*\n/m, '');
  const timers = [];
  const messages = [];
  const logs = [];
  const events = {
    beforeChatSend: [],
    chatSend: [],
    virtualContainerClose: [],
    virtualContainerItemChange: [],
  };
  const items = new Array(54).fill(undefined);
  let openCalls = 0;
  let closeCalls = 0;
  let setItemCalls = 0;
  const viewers = options.viewers ?? [];
  let getViewersThrows = options.getViewersThrows ?? false;
  const player = { name: 'Tester', isValid: true, sendMessage: (line) => messages.push(line) };
  const container = {
    open() {
      openCalls += 1;
    },
    close() {
      closeCalls += 1;
      return 1;
    },
    getViewers() {
      if (getViewersThrows) throw new Error('getViewers failed');
      return viewers.slice();
    },
    getItem(slot) {
      return items[slot];
    },
    setItem(slot, item) {
      items[slot] = item;
      setItemCalls += 1;
    },
  };
  const sandbox = {
    console: { warn: (line) => logs.push(line), log: (line) => logs.push(line) },
    ItemStack: class {
      constructor(typeId, amount) {
        this.typeId = typeId;
        this.amount = amount;
      }
    },
    world: {
      virtualContainerManager: { create: () => container },
      beforeEvents: {
        chatSend: { subscribe: (handler) => events.beforeChatSend.push(handler) },
      },
      afterEvents: {
        chatSend: { subscribe: (handler) => events.chatSend.push(handler) },
        virtualContainerClose: { subscribe: (handler) => events.virtualContainerClose.push(handler) },
        virtualContainerItemChange: { subscribe: (handler) => events.virtualContainerItemChange.push(handler) },
      },
    },
    system: {
      run: (handler) => handler(),
      runTimeout: (handler, ticks) => timers.push({ run: handler, ticks }),
    },
  };
  vm.runInNewContext(source, sandbox, { filename: scriptPath });

  return {
    /** チャットを beforeEvents → (cancel されなければ) afterEvents の順に流し、cancel されたかを返す。 */
    chat(message, sender = player) {
      let cancelled = false;
      for (const handler of events.beforeChatSend) {
        const event = { message, sender, cancel: false };
        handler(event);
        if (event.cancel) cancelled = true;
      }
      if (!cancelled) {
        for (const handler of events.chatSend) handler({ message, sender });
      }
      return cancelled;
    },
    /** 画面からのスロット変更を模擬する（before/after は typeId と amount だけ見る）。 */
    fireItemChange({ slot, before, after, who = player, eventContainer = container }) {
      for (const handler of events.virtualContainerItemChange) {
        handler({ container: eventContainer, slot, beforeItemStack: before, itemStack: after, player: who });
      }
    },
    /** close イベントを模擬する。items は現在のスロット内容のスナップショット。 */
    fireClose({ reason, who = player, omitItems = false, eventContainer = container } = {}) {
      const event = { container: eventContainer, reason, player: who };
      if (!omitItems) event.items = items.slice();
      for (const handler of events.virtualContainerClose) handler(event);
    },
    timers,
    messages,
    logs,
    items,
    viewers,
    player,
    setGetViewersThrows: (value) => {
      getViewersThrows = value;
    },
    openCalls: () => openCalls,
    closeCalls: () => closeCalls,
    setItemCalls: () => setItemCalls,
  };
}

test('manifest.json は新規 UUID・beta 依存・危険警告を持つ', () => {
  const manifest = readJson(manifestPath);

  assert.equal(manifest.format_version, 2);
  assert.match(manifest.header.uuid, UUID_PATTERN);
  assert.deepEqual(manifest.header.version, [0, 1, 0]);
  assert.match(manifest.header.name, /DISPOSABLE WORLD ONLY/);
  assert.match(manifest.header.description, /DISPOSABLE TEST WORLD ONLY/);
  assert.match(manifest.header.description, /JSON UI/);
  assert.match(manifest.header.description, /NOT saved/);
  assert.match(manifest.header.description, /never store valuables/);
  assert.match(manifest.header.description, /Fill is REFUSED while viewers exist/);
  assert.match(manifest.header.description, /DANGER/);

  assert.equal(manifest.modules.length, 1);
  const scriptModule = manifest.modules[0];
  assert.equal(scriptModule.type, 'script');
  assert.equal(scriptModule.language, 'javascript');
  assert.equal(scriptModule.entry, 'scripts/main.js');
  assert.match(scriptModule.uuid, UUID_PATTERN);
  assert.notEqual(scriptModule.uuid.toLowerCase(), manifest.header.uuid.toLowerCase());

  assert.ok(fs.existsSync(scriptPath), 'script entry が存在する');

  const dependency = manifest.dependencies.find((entry) => entry.module_name === '@minecraft/server');
  assert.ok(dependency, '@minecraft/server の dependency がある');
  assert.equal(dependency.version, '2.13.0-beta');
});

test('main.js は Node の構文チェックを通る', () => {
  const result = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('main.js は対象 API と使い捨てアイテム方針を保持する', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /virtualContainerManager/);
  assert.match(source, /\.create\(\{\s*size/);
  assert.match(source, /virtualContainerClose/);
  assert.match(source, /virtualContainerItemChange/);
  assert.match(source, /使い捨てワールド専用/);
  assert.match(source, /JSON UI/);
  assert.match(source, /InputBridge/);
  assert.match(source, /minecraft:stick/);
  assert.match(source, /minecraft:paper/);
  assert.match(source, /system\.runTimeout/);
  assert.match(source, /AUTOCLOSE/);
  assert.match(source, /再読み込み\/終了で消失/);
  assert.match(source, /getViewers\(\)/);
  assert.match(source, /DANGER/);
  assert.match(source, /STOP/);
  assert.match(source, /CLOSE_CONTENTS/);
  assert.match(source, /!invui stop/);
  assert.match(source, /pendingOpenPlayers/);
  assert.match(source, /OPEN_REJECTED/);
  assert.match(source, /CONTAINER_IDENTITY/);
  assert.match(source, /containerSameRef/);
  assert.match(source, /同一参照/);
  assert.match(source, /実機未実行/);
  assert.match(source, /cursor 退避/);
  assert.match(source, /インベントリ側/);
  assert.match(source, /beforeEvents\.chatSend/);
  assert.match(source, /NOTIFY_PREFIX/);
  assert.match(source, /NOTIFY_OBSERVED/);
  assert.match(source, /観測のみ/);
  assert.match(source, /偽装可能/);
  assert.doesNotMatch(
    source,
    /minecraft:(diamond|diamond_block|emerald|emerald_block|netherite|netherite_ingot|gold_ingot|iron_ingot)\b/,
  );
});

test('README は貴重品・複数画面・cursor 退避・STOP の限界を明示する', () => {
  const readme = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  assert.match(readme, /貴重品や実際に使うアイテムを預けない/);
  assert.match(readme, /再読み込み/);
  assert.match(readme, /!invui open \[size\] \[ticks\]/);
  assert.match(readme, /画面を開いたまま/);
  assert.match(readme, /!invui stop/);
  assert.match(readme, /CLOSE_CONTENTS/);
  assert.match(readme, /複数画面/);
  assert.match(readme, /pending/);
  assert.match(readme, /cursor 退避/);
  assert.match(readme, /インベントリ側/);
  assert.match(readme, /event\.container/);
  assert.match(readme, /同一参照/);
  assert.match(readme, /実機未実行/);
});

test('open の ticks 指定は server close を予約し、指定 tick 後に close() する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27 40');

  assert.equal(probe.openCalls(), 1, 'open が 1 回呼ばれる');
  assert.equal(probe.closeCalls(), 0, '予約時点では close しない');
  assert.equal(probe.timers.length, 1);
  assert.equal(probe.timers[0].ticks, 40);
  assert.match(probe.messages.join('\n'), /AUTOCLOSE 予約/);

  probe.timers[0].run();
  assert.equal(probe.closeCalls(), 1, 'タイマーで close が 1 回呼ばれる');
  const output = probe.messages.join('\n');
  assert.match(output, /AUTOCLOSE size=27 close\(\) requested=1/);
  assert.match(output, /ServerClosed/);
});

test('手で閉じて再 open した後、古い AUTOCLOSE は新しい画面を閉じない', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27 40');
  assert.equal(probe.timers.length, 1);

  // 画面を手で閉じ、close イベント後に同じ size を開き直す。
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui open 27');
  assert.equal(probe.openCalls(), 2);

  // 予約済みの古いタイマーが発火しても、再 open した新しい画面を閉じない。
  probe.timers[0].run();
  assert.equal(probe.closeCalls(), 0, '古いタイマーは close() しない');
  assert.match(probe.logs.join('\n'), /AUTOCLOSE skip stale size=27/);
});

test('ticks 無しの open はタイマーを予約しない', () => {
  const probe = loadProbe();
  probe.chat('!invui open 9');

  assert.equal(probe.openCalls(), 1);
  assert.equal(probe.timers.length, 0);
});

test('ticks が範囲外なら open しない', () => {
  for (const ticks of ['0', '-1', '2401', 'abc', '1.5']) {
    const probe = loadProbe();
    probe.chat(`!invui open 27 ${ticks}`);
    assert.equal(probe.openCalls(), 0, `ticks=${ticks} では open しない`);
    assert.equal(probe.timers.length, 0);
    assert.match(probe.messages.join('\n'), /1〜2400/);
  }
});

test('open は既存の閲覧者がいると拒否する（同一 size の共有コンテナ）', () => {
  const viewer = { name: 'Viewer', isValid: true, sendMessage() {} };
  const probe = loadProbe({ viewers: [viewer] });
  probe.chat('!invui open 27');

  assert.equal(probe.openCalls(), 0, '閲覧者がいる間は open しない');
  assert.match(probe.logs.join('\n'), /DANGER OPEN_REJECTED size=27 viewers=Viewer/);
  assert.match(probe.messages.join('\n'), /open を拒否しました: 既に閲覧中 \(Viewer\)/);
});

test('open は getViewers() が失敗したら拒否する（fail-closed）', () => {
  const probe = loadProbe({ getViewersThrows: true });
  probe.chat('!invui open 27');

  assert.equal(probe.openCalls(), 0);
  assert.match(probe.messages.join('\n'), /open を拒否しました: getViewers\(\) を確認できないため/);
});

test('表示未確認の open が残っている間は同じ size の open を拒否する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');

  const other = { name: 'Other', isValid: true, lines: [] };
  other.sendMessage = (line) => other.lines.push(line);
  probe.chat('!invui open 27', other);

  assert.equal(probe.openCalls(), 1, '表示未確認の間は 2 人目を open しない');
  assert.match(probe.logs.join('\n'), /DANGER OPEN_REJECTED size=27 pending=Tester/);
  assert.match(other.lines.join('\n'), /表示を確認できていない open/);

  // 同じプレイヤーの再 open も close イベントまで拒否する。
  probe.chat('!invui open 27');
  assert.equal(probe.openCalls(), 1);
  assert.match(probe.messages.join('\n'), /前回の open の close イベントがまだ来ていません/);
});

test('close イベントで pending が解消し、別プレイヤーが open できる', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  assert.match(probe.logs.join('\n'), /CLOSE size=27/);

  const other = { name: 'Other', isValid: true, sendMessage() {} };
  probe.chat('!invui open 27', other);
  assert.equal(probe.openCalls(), 2, 'close 後は同じ size を別プレイヤーが open できる');
});

test('close イベントの player が別インスタンスでも id が同じなら pending を解除する', () => {
  const probe = loadProbe();
  probe.player.id = 'player-1';
  probe.chat('!invui open 27');

  // 実機では close イベントの player が別インスタンスで来ることがある。
  const samePlayer = { id: 'player-1', name: 'Tester', isValid: true, sendMessage() {} };
  probe.fireClose({ reason: 'PlayerClosed', who: samePlayer });

  const other = { id: 'player-2', name: 'Other', isValid: true, sendMessage() {} };
  probe.chat('!invui open 27', other);
  assert.equal(probe.openCalls(), 2);
});

test('event.container が create() の戻り値と同一参照かを真偽値で記録する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });

  const logs = probe.logs.join('\n');
  assert.match(logs, /CONTAINER_IDENTITY kind=close size=27 sameRef=true/);
  assert.match(logs, /CLOSE size=27 .*containerSameRef=true/);

  // itemChange 未到達のうちは未観測として区別する。
  probe.chat('!invui dump');
  assert.match(probe.messages.join('\n'), /IDENTITY size=27 closeSameRef=true itemChangeSameRef=\(未観測\)/);
});

test('event.container が別参照でも false を記録し、close / itemChange の処理を止めない', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');

  // 実機でイベントごとに別インスタンス（ラッパー）が来る可能性を模擬する。
  const wrapper = { title: 'InvUI probe 27' };
  probe.fireClose({ reason: 'PlayerClosed', eventContainer: wrapper });

  const closeLogs = probe.logs.join('\n');
  assert.match(closeLogs, /CONTAINER_IDENTITY kind=close size=27 sameRef=false/);
  assert.match(closeLogs, /CLOSE size=27 .*containerSameRef=false/);

  // 早期 return で pending 解除と fill が止まっていないこと。
  probe.chat('!invui fill');
  assert.equal(probe.setItemCalls(), 4);

  const moved = probe.items[0];
  probe.items[0] = undefined;
  probe.items[20] = moved;
  probe.fireItemChange({ slot: 0, before: moved, after: undefined, eventContainer: wrapper });
  probe.fireItemChange({ slot: 20, before: undefined, after: moved, eventContainer: wrapper });

  const logs = probe.logs.join('\n');
  assert.match(logs, /CONTAINER_IDENTITY kind=itemChange size=27 sameRef=false/);
  assert.match(logs, /DANGER ITEM_CHANGE .*containerSameRef=false .*minecraft:stick x1 -> \(empty\)/);
  assert.doesNotMatch(logs, /DANGER ACCOUNTING/);
  assert.doesNotMatch(logs, /STOP/);

  probe.chat('!invui dump');
  assert.match(probe.messages.join('\n'), /IDENTITY size=27 closeSameRef=false itemChangeSameRef=false/);
});

test('専用 prefix の通知だけ cancel し、観測ログだけ出して click を実行しない', () => {
  const probe = loadProbe();
  const notify = '!invui:sess-1:0:12:3';

  assert.equal(probe.chat(notify), true, '通知は通常チャットから cancel される');
  const logs = probe.logs.join('\n');
  assert.match(logs, /NOTIFY_OBSERVED sender=Tester/);
  assert.ok(logs.includes(JSON.stringify(notify)), '通知内容を安全な形で記録する');
  assert.match(logs, /観測のみ/);
  assert.match(logs, /偽装可能/);
  assert.match(logs, /click action は実行しない/);

  // 観測だけであり、click action / open / fill / チャット返信を起こさない。
  assert.equal(probe.openCalls(), 0);
  assert.equal(probe.closeCalls(), 0);
  assert.equal(probe.setItemCalls(), 0);
  assert.equal(probe.messages.join('\n'), '');
});

test('通知 prefix 以外のチャットは cancel せず、コマンドは従来どおり動く', () => {
  const probe = loadProbe();

  assert.equal(probe.chat('hello'), false);
  assert.equal(probe.chat('say !invui:fake:0:1:1'), false, '先頭以外の prefix は cancel しない');
  assert.equal(probe.chat('!invui open 27'), false, '!invui コマンドは cancel しない');
  assert.equal(probe.openCalls(), 1);
  assert.doesNotMatch(probe.logs.join('\n'), /NOTIFY_OBSERVED/);
});

test('通知の生文字列は制御文字をエスケープし、長さを制限してログする', () => {
  const probe = loadProbe();
  const evil = `!invui:a:0:1:1\n${'x'.repeat(300)}`;

  assert.equal(probe.chat(evil), true);
  const line = probe.logs.find((entry) => entry.includes('NOTIFY_OBSERVED'));
  assert.ok(line, '観測ログがある');
  assert.doesNotMatch(line, /\n/, '1 行に収める');
  assert.match(line, /truncated/);
});

test('閲覧者がいるコンテナへの fill は拒否し、setItem しない', () => {
  const viewer = { name: 'Viewer', isValid: true, sendMessage() {} };
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.viewers.push(viewer);
  probe.chat('!invui fill');

  assert.equal(probe.setItemCalls(), 0, '閲覧中は書き込まない');
  assert.match(probe.logs.join('\n'), /DANGER FILL_REJECTED size=27 viewers=Viewer/);
  assert.match(probe.messages.join('\n'), /fill を拒否しました: 閲覧中/);
});

test('getViewers() が失敗したら fill を拒否する（safe side）', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.setGetViewersThrows(true);
  probe.chat('!invui fill');

  assert.equal(probe.setItemCalls(), 0);
  assert.match(probe.messages.join('\n'), /fill を拒否しました: getViewers\(\) を確認できないため/);
});

test('open 直後（viewer 反映前）の fill を pending で拒否し、close 後のみ書き込む', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.chat('!invui fill');

  assert.equal(probe.setItemCalls(), 0, 'viewers に出る前でも pending なら setItem しない');
  assert.match(probe.logs.join('\n'), /DANGER FILL_REJECTED size=27 pending=Tester/);
  assert.match(probe.messages.join('\n'), /表示を確認できていない open が残っています/);

  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');
  assert.equal(probe.setItemCalls(), 4, 'close イベントで pending が解消した後だけ fill できる');
  assert.equal(probe.items[0].typeId, 'minecraft:stick');
});

test('閲覧者がいなければ fill し、close で全内容を記録する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');

  assert.equal(probe.setItemCalls(), 4, 'size=27 では 4 スロットに書く');
  assert.equal(probe.items[0].typeId, 'minecraft:stick');
  assert.equal(probe.items[1].typeId, 'minecraft:paper');

  probe.fireClose({ reason: 'PlayerClosed' });
  const logs = probe.logs.join('\n');
  assert.match(logs, /CLOSE_CONTENTS size=27 slots=.*0=minecraft:stickx1/);
  assert.match(logs, /totals=minecraft:stickx3, minecraft:paperx1/);
  assert.doesNotMatch(logs, /STOP/);
});

test('itemChange は危険ログを出し、移動だけなら会計は一致する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');

  const moved = probe.items[0];
  probe.items[0] = undefined;
  probe.items[20] = moved;
  probe.fireItemChange({ slot: 0, before: moved, after: undefined });
  probe.fireItemChange({ slot: 20, before: undefined, after: moved });

  const logs = probe.logs.join('\n');
  assert.match(logs, /DANGER ITEM_CHANGE size=27 slot=0 .*minecraft:stick x1 -> \(empty\)/);
  assert.match(logs, /投入物は画面外へ出る・消える/);
  assert.doesNotMatch(logs, /DANGER ACCOUNTING/);
  assert.doesNotMatch(logs, /STOP/);
  assert.match(probe.messages.join('\n'), /投入したアイテムは画面外へ出る\/消える/);
});

test('itemChange で説明のつかない増加を close が検知したら STOP し open / fill を拒否する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');

  // slot 5 の増加は報告されるが、slot 6 の増加は報告されない = 会計より実物が多い。
  const stacked = { typeId: 'minecraft:stick', amount: 1 };
  probe.items[5] = stacked;
  probe.items[6] = { typeId: 'minecraft:stick', amount: 1 };
  probe.fireItemChange({ slot: 5, before: undefined, after: stacked });
  probe.fireClose({ reason: 'PlayerClosed' });

  const logs = probe.logs.join('\n');
  assert.match(logs, /DANGER ACCOUNTING .*minecraft:stick: 期待 4 \/ 実際 5/);
  assert.match(logs, /!!! STOP 停止条件に該当 !!!/);
  assert.match(probe.messages.join('\n'), /\[危険\].*合計個数を確認し、中止してください/);

  const openBefore = probe.openCalls();
  probe.chat('!invui open 27');
  assert.equal(probe.openCalls(), openBefore, 'STOP 後は open しない');
  probe.chat('!invui fill');
  assert.equal(probe.setItemCalls(), 4, 'STOP 後は fill しない');
  assert.match(probe.messages.join('\n'), /\[停止中\]/);
});

test('close の items が無い場合は会計チェックを省略し、誤って STOP しない', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');
  probe.fireClose({ reason: 'UserBusy', omitItems: true });

  const logs = probe.logs.join('\n');
  assert.match(logs, /CLOSE_ITEMS missing size=27/);
  assert.doesNotMatch(logs, /DANGER ACCOUNTING/);
  assert.doesNotMatch(logs, /STOP/);
});

test('投入物が消えた close は会計不一致として STOP する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');

  // itemChange が届かないまま 1 個消えた想定。
  probe.items[0] = undefined;
  probe.fireClose({ reason: 'PlayerClosed' });

  const logs = probe.logs.join('\n');
  assert.match(logs, /DANGER ACCOUNTING .*minecraft:stick: 期待 3 \/ 実際 2/);
  assert.match(logs, /消失・複製のいずれかの疑い/);
  assert.match(logs, /!!! STOP 停止条件に該当 !!!/);
  assert.match(probe.messages.join('\n'), /\[危険\].*中止/);
});

test('!invui stop は画面を閉じ、以降の open / fill を拒否する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.chat('!invui stop');

  assert.ok(probe.closeCalls() >= 1, 'stop は close() を要求する');
  assert.match(probe.logs.join('\n'), /!!! STOP 停止条件に該当 !!! 手動停止/);
  assert.match(probe.messages.join('\n'), /STOP しました/);

  probe.chat('!invui open 27');
  assert.equal(probe.openCalls(), 1, 'STOP 後は open しない');
  probe.chat('!invui fill');
  assert.equal(probe.setItemCalls(), 0, 'STOP 後は fill しない');
  assert.match(probe.messages.join('\n'), /\[停止中\]/);
});

test('dump は ACCOUNTING を表示する', () => {
  const probe = loadProbe();
  probe.chat('!invui open 27');
  probe.fireClose({ reason: 'PlayerClosed' });
  probe.chat('!invui fill');
  probe.chat('!invui dump');

  const output = probe.messages.join('\n');
  assert.match(output, /DUMP size=27/);
  assert.match(output, /ACCOUNTING size=27 expected=minecraft:stickx3, minecraft:paperx1 actual=minecraft:stickx3, minecraft:paperx1/);
});

test('Resource Pack / JSON UI を同梱していない', () => {
  assert.equal(fs.existsSync(path.join(packDir, 'ui')), false);
  assert.equal(fs.existsSync(path.join(here, 'resource_pack')), false);
  assert.equal(fs.existsSync(path.join(here, 'resource_packs')), false);
});
