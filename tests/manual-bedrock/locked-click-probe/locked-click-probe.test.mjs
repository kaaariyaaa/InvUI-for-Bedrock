#!/usr/bin/env node
/*
 * tests/manual-bedrock/locked-click-probe の静的・モックチェック。
 *
 * 実機のクリックや itemChange を検証するものではない。確認するのは:
 * - manifest の UUID・beta 依存・警告
 * - 導入用 `.mcpack` が behavior_pack と同一内容であること
 * - main.js の構文
 * - ロック済みアイテムを fill し、ロックの適用を読み戻して記録すること
 * - close 時点の内容（空でないスロット数・合計）を記録すること
 * - 観測のみで復元・クリック実行をしないこと
 * - `SAME_ITEM_CANDIDATE` / `REMOVED` の分類
 * - 自動 close の tick 予約
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const packDir = path.join(here, 'behavior_pack');
const manifestPath = path.join(packDir, 'manifest.json');
const scriptPath = path.join(packDir, 'scripts', 'main.js');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 導入用 .mcpack（ZIP）を、依存を増やさずに読む。 */
function readZipEntries(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'ZIP の End of Central Directory が見つからない');

  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let offset = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory の署名が違う');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `${name}: local header の署名が違う`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.set(name, Buffer.from(data));
    } else {
      assert.equal(method, 8, `${name}: 未対応の圧縮方式 ${method}`);
      entries.set(name, zlib.inflateRawSync(data));
    }
  }
  return entries;
}

function loadProbe(options = {}) {
  const source = fs.readFileSync(scriptPath, 'utf8').replace(/^import[^\n]*\n/m, '');
  const timers = [];
  const messages = [];
  const logs = [];
  const events = {
    beforeChatSend: [],
    virtualContainerItemChange: [],
    virtualContainerClose: [],
    playerCursorItemGrab: [],
    playerCursorItemRelease: [],
    playerInventoryItemChange: [],
    playerHotbarSelectedSlotChange: [],
    playerInputModeChange: [],
    playerButtonInput: [],
    messageReceive: [],
  };
  const items = new Array(54).fill(undefined);
  const cursor = { item: undefined };
  let openCalls = 0;
  let closeCalls = 0;
  const created = [];

  const makePlayer = (id) => ({
    id,
    name: id,
    isValid: true,
    sendMessage: (line) => messages.push(line),
    getComponent: (componentId) => (componentId === 'cursor_inventory' ? cursor : undefined),
  });
  const player = makePlayer('tester-id');

  // 実機の VirtualContainer は id を持たず、イベントの container 参照も
  // create() の戻り値と同一とは限らない。title だけが作成時の安定した識別子。
  const makeContainer = ({ size, title }) => {
    const calls = { opened: 0, closed: 0 };
    const container = {
      size,
      title,
      calls,
      open() {
        openCalls += 1;
        calls.opened += 1;
      },
      close() {
        closeCalls += 1;
        calls.closed += 1;
        return 1;
      },
      getViewers() {
        return [];
      },
      getItem(slot) {
        return items[slot];
      },
      setItem(slot, item) {
        // options.dropLock は、実機でロックが保存されなかった場合の模擬。
        if (options.dropLock && item) {
          item.lockMode = 'none';
        }
        items[slot] = item;
      },
    };
    created.push(container);
    return container;
  };
  // fireItemChange / fireClose の既定値は「最初に作られた container」。
  // 実際の create() は main.js が open 時に呼ぶので、ここでは作らない。
  const makeSignal = (bucket) => ({
    subscribe: (handler) => bucket.push(handler),
  });
  const sandbox = {
    console: { warn: (line) => logs.push(line), log: (line) => logs.push(line) },
    ItemLockMode: { none: 'none', inventory: 'inventory', slot: 'slot' },
    ItemStack: class {
      constructor(typeId, amount) {
        this.typeId = typeId;
        this.amount = amount;
        this.lockMode = 'none';
        this.nameTag = undefined;
      }
    },
    world: {
      virtualContainerManager: { create: (options) => makeContainer(options) },
      beforeEvents: {
        chatSend: makeSignal(events.beforeChatSend),
      },
      afterEvents: {
        virtualContainerItemChange: makeSignal(events.virtualContainerItemChange),
        virtualContainerClose: makeSignal(events.virtualContainerClose),
        playerCursorItemGrab: makeSignal(events.playerCursorItemGrab),
        playerCursorItemRelease: makeSignal(events.playerCursorItemRelease),
        playerInventoryItemChange: makeSignal(events.playerInventoryItemChange),
        playerHotbarSelectedSlotChange: makeSignal(events.playerHotbarSelectedSlotChange),
        playerInputModeChange: makeSignal(events.playerInputModeChange),
        playerButtonInput: makeSignal(events.playerButtonInput),
        messageReceive: makeSignal(events.messageReceive),
      },
    },
    system: {
      run: (handler) => handler(),
      runTimeout: (handler, ticks) => timers.push({ run: handler, ticks }),
    },
  };
  vm.runInNewContext(source, sandbox, { filename: scriptPath });

  return {
    chat(message, sender = player) {
      let cancelled = false;
      for (const handler of events.beforeChatSend) {
        const event = { message, sender, cancel: false };
        handler(event);
        if (event.cancel) cancelled = true;
      }
      return cancelled;
    },
    fireItemChange({ slot, before, after, who = player, container = created[0] }) {
      for (const handler of events.virtualContainerItemChange) {
        handler({ container, slot, beforeItemStack: before, itemStack: after, player: who });
      }
    },
    fireClose({ who = player, reason = 'ServerClosed', contents, container: closedContainer = created[0] } = {}) {
      // 実機の event.items は container.size と同じ長さ。items は 54 固定の
      // モック配列なので、size を超える分を close 内容に混ぜない。
      const closeContents =
        contents ??
        (closedContainer && typeof closedContainer.size === 'number'
          ? items.slice(0, closedContainer.size)
          : items);
      for (const handler of events.virtualContainerClose) {
        handler({ container: closedContainer, player: who, reason, items: closeContents });
      }
    },
    timers,
    messages,
    logs,
    items,
    cursor,
    player,
    created,
    /** 別イベントで渡され得る、同じプレイヤーの別オブジェクト。 */
    samePlayer() {
      return makePlayer(player.id);
    },
    /** 同時に画面を持つ別プレイヤー。 */
    playerWith(id) {
      return makePlayer(id);
    },
    openCalls: () => openCalls,
    closeCalls: () => closeCalls,
  };
}

test('manifest.json は新規 UUID・beta 依存・危険警告を持つ', () => {
  const manifest = readJson(manifestPath);

  assert.equal(manifest.format_version, 2);
  assert.match(manifest.header.uuid, UUID_PATTERN);
  assert.deepEqual(manifest.header.version, [0, 1, 0]);
  assert.match(manifest.header.name, /DISPOSABLE TEST WORLD ONLY/);
  assert.match(manifest.header.description, /DISPOSABLE TEST WORLD ONLY/);
  assert.match(manifest.header.description, /ItemLockMode\.slot/);
  assert.match(manifest.header.description, /no restore/);
  assert.match(manifest.header.description, /NOT saved/);
  assert.match(manifest.header.description, /never store valuables/);
  assert.match(manifest.header.description, /stay locked in your inventory/);

  assert.equal(manifest.modules.length, 1);
  const scriptModule = manifest.modules[0];
  assert.equal(scriptModule.type, 'script');
  assert.equal(scriptModule.language, 'javascript');
  assert.equal(scriptModule.entry, 'scripts/main.js');
  assert.match(scriptModule.uuid, UUID_PATTERN);
  assert.notEqual(scriptModule.uuid.toLowerCase(), manifest.header.uuid.toLowerCase());

  const dependency = manifest.dependencies.find((entry) => entry.module_name === '@minecraft/server');
  assert.ok(dependency, '@minecraft/server の dependency がある');
  assert.equal(dependency.version, '2.13.0-beta');
});

test('mcpack は behavior_pack と同一内容で、実機に取り込める ZIP になっている', () => {
  const mcpackPath = path.join(here, 'locked-click-probe.mcpack');
  const entries = readZipEntries(fs.readFileSync(mcpackPath));
  const files = [...entries.keys()].filter((name) => !name.endsWith('/')).sort();

  assert.deepEqual(files, ['manifest.json', 'scripts/main.js']);
  assert.equal(entries.get('manifest.json').toString('utf8'), fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(entries.get('scripts/main.js').toString('utf8'), fs.readFileSync(scriptPath, 'utf8'));
});

test('main.js は Node の構文チェックを通る', () => {
  const result = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('main.js は観測のみで、復元・クリック実行・JSON UI を含まない', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /ItemLockMode\.slot/);
  assert.match(source, /ItemLockMode\.inventory/);
  assert.match(source, /virtualContainerItemChange/);
  assert.match(source, /SAME_ITEM_CANDIDATE/);
  assert.match(source, /CANDIDATE_SAME_ITEM/);
  assert.match(source, /playerHotbarSelectedSlotChange/);
  assert.match(source, /playerCursorItemGrab/);
  assert.match(source, /playerInventoryItemChange/);
  assert.match(source, /messageReceive/);
  assert.match(source, /使い捨てワールド専用/);
  assert.match(source, /観測のみ/);
  assert.match(source, /復元/);
  assert.match(source, /JSON UI/);
  assert.match(source, /minecraft:stick/);
  assert.match(source, /minecraft:paper/);
  assert.match(source, /system\.runTimeout/);
  assert.match(source, /AUTOCLOSE/);
  assert.match(source, /CLOSE_CONTENTS/);
  assert.match(source, /FILL_LOCK_MISMATCH/);
  assert.match(source, /stay stuck in the player's inventory/);
  assert.doesNotMatch(source, /\bhandleClick\s*\(/);
  assert.doesNotMatch(source, /button\.send|button\.drop_one/);
  assert.doesNotMatch(
    source,
    /minecraft:(diamond|diamond_block|emerald|emerald_block|netherite|netherite_ingot|gold_ingot|iron_ingot)\b/,
  );
});

test('README と main.js は title 識別・重複 close・event.container 同一性を観測の限界として書く', () => {
  const readme = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(readme, /同名他パックとの衝突/);
  assert.match(readme, /二重 close/);
  assert.match(readme, /同一性は断定せず/);
  assert.match(readme, /挙動の保証ではありません/);
  assert.match(source, /same-title collision/);
  assert.match(source, /duplicate or delayed delivery/);
  assert.match(source, /neither relied on nor asserted/);
});

test('README は陽性/陰性の解釈と限界を明示する', () => {
  const readme = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  assert.match(readme, /使い捨てワールド専用/);
  assert.match(readme, /SAME_ITEM_CANDIDATE/);
  assert.match(readme, /陽性/);
  assert.match(readme, /陰性/);
  assert.match(readme, /復元[\s\S]*一切行いません/);
  assert.match(readme, /Shift クリック/);
  assert.match(readme, /実機未検証/);
  assert.match(readme, /インベントリに残る可能性/);
  assert.match(readme, /持ち出せてしまったら/);
  assert.match(readme, /lockMode` は意図的に除外/);
});

test('README は設計7.2の制約を明記する', () => {
  const readme = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(readme, /設計7\.2/);
  assert.match(readme, /読み取り専用化に使ってはいけません/);
  assert.match(source, /Design 7\.2/);
  assert.match(source, /must not be used to make VirtualContainer/);
});

test('open は size 分をロックして fill し、ticks 後に close する', () => {
  const probe = loadProbe();
  assert.equal(probe.chat('!lockprobe open 9 slot 40'), true);

  assert.equal(probe.openCalls(), 1);
  assert.equal(probe.items.length, 54);
  for (let slot = 0; slot < 9; slot += 1) {
    assert.ok(probe.items[slot], `slot ${slot} が埋まる`);
    assert.equal(probe.items[slot].lockMode, 'slot');
  }
  assert.equal(probe.timers.length, 1);
  assert.equal(probe.timers[0].ticks, 40);
  assert.match(probe.messages.join('\n'), /OPEN_REQUESTED size=9 mode=slot/);
  assert.match(probe.logs.join('\n'), /FILLED size=9 mode=slot slots=9\/9 locked=9\/9/);

  probe.timers[0].run();
  assert.equal(probe.closeCalls(), 1);
  assert.match(probe.logs.join('\n'), /AUTOCLOSE size=9 mode=slot/);
});

test('same-item の itemChange を候補として分類し、復元しない', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  const stack = probe.items[0];
  probe.fireItemChange({ slot: 0, before: stack, after: stack });

  const output = probe.logs.join('\n');
  assert.match(
    output,
    /ITEM_CHANGE size=9 slot=0 title="Lock probe 9 slot" kind=SAME_ITEM_CANDIDATE sameItem=true/,
  );
  assert.match(output, /CANDIDATE_SAME_ITEM size=9 slot=0 title="Lock probe 9 slot"/);
});

test('ロックが読み戻せない場合は FILL_LOCK_MISMATCH を記録する', () => {
  const probe = loadProbe({ dropLock: true });
  probe.chat('!lockprobe open 9 slot 40');

  const output = probe.logs.join('\n');
  assert.match(output, /FILL_LOCK_MISMATCH slot=0 mode=slot expected=slot actual=none/);
  assert.match(output, /FILLED size=9 mode=slot slots=9\/9 locked=0\/9/);
});

test('plain はロックを要求せず、locked= を出さない', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 plain 40');

  const output = probe.logs.join('\n');
  assert.match(output, /FILLED size=9 mode=plain slots=9\/9/);
  assert.doesNotMatch(output, /locked=/);
});

test('close は内容の合計と空でないスロット数を記録する', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  probe.fireClose();

  const output = probe.logs.join('\n');
  assert.match(output, /CLOSE size=9 title="Lock probe 9 slot" reason=ServerClosed/);
  assert.match(
    output,
    /CLOSE_CONTENTS size=9 title="Lock probe 9 slot" nonEmptySlots=9\/9 totals=minecraft:stickx5, minecraft:paperx4/,
  );
});

test('itemChange は title で size と mode を記録する', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 plain 40');
  const stack = probe.items[0];
  probe.fireItemChange({ slot: 0, before: stack, after: stack });

  assert.match(
    probe.logs.join('\n'),
    /ITEM_CHANGE size=9 slot=0 title="Lock probe 9 plain" kind=SAME_ITEM_CANDIDATE/,
  );
});

test('removed / changed は候補にしない', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  const before = { typeId: 'minecraft:stick', amount: 1, lockMode: 'slot' };
  probe.fireItemChange({ slot: 0, before, after: undefined });
  const changed = { typeId: 'minecraft:paper', amount: 1, lockMode: 'slot' };
  probe.fireItemChange({ slot: 1, before, after: changed });

  const output = probe.logs.join('\n');
  assert.match(output, /kind=REMOVED/);
  assert.match(output, /kind=CHANGED/);
  assert.doesNotMatch(output, /CANDIDATE_SAME_ITEM/);
});

test('lock が外れても同一内容なら候補にし、lock= はログに残す', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  const before = { typeId: 'minecraft:stick', amount: 1, lockMode: 'slot' };
  const after = { typeId: 'minecraft:stick', amount: 1, lockMode: 'none' };
  probe.fireItemChange({ slot: 0, before, after });

  const output = probe.logs.join('\n');
  assert.match(output, /kind=SAME_ITEM_CANDIDATE/);
  assert.match(output, /before="minecraft:stick x1 lock=slot/);
  assert.match(output, /after="minecraft:stick x1 lock=none/);
});

test('再 open は前回の内容を引き継がず、開く直前に fill し直す', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  probe.items[0] = undefined;
  probe.fireClose();
  probe.chat('!lockprobe open 9 slot 40');

  assert.equal(probe.openCalls(), 2);
  assert.ok(probe.items[0], '再 open で slot 0 が戻る');
  assert.equal(probe.items[0].lockMode, 'slot');
});

test('close イベントの参照が別でも pending を解除して再 open できる', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  // Player はイベントごとに別オブジェクトで渡され得る。id で同一人物と判定する。
  // イベントの container 参照も create() の戻り値と同一とは限らないため、
  // VirtualContainer が持つ安定した識別子 title で自分の container を引く。
  probe.fireClose({ who: probe.samePlayer(), container: { size: 9, title: 'Lock probe 9 slot' } });
  probe.chat('!lockprobe open 9 slot 40');

  assert.equal(probe.openCalls(), 2);
  assert.doesNotMatch(probe.messages.join('\n'), /previous open still pending/);
});

test('pending が残っている間は同じ container を再 open できない', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  probe.chat('!lockprobe open 9 slot 40');

  assert.equal(probe.created[0].calls.opened, 1);
  assert.match(probe.messages.join('\n'), /previous open still pending \(1\)/);
});

test('別コンテナの close は他コンテナの pending を消さない', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  probe.chat('!lockprobe open 9 plain 40');
  // 同じプレイヤーが slot と plain の両方で open 中。plain の close で
  // slot の pending まで消すと、未確認の open があるまま再 open できてしまう。
  probe.fireClose({ container: { size: 9, title: 'Lock probe 9 plain' } });

  probe.chat('!lockprobe open 9 slot 40');
  probe.chat('!lockprobe open 9 plain 40');

  assert.equal(probe.created[0].calls.opened, 1, 'slot は pending のまま');
  assert.equal(probe.created[1].calls.opened, 2, 'plain は解除済みで再 open できる');
  assert.match(probe.messages.join('\n'), /OPEN_REJECTED size=9 mode=slot reason=previous open still pending/);
});

test('自作していない container の close は pending を消さない', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  probe.fireClose({ container: { size: 9, title: 'Someone else pack' } });
  probe.chat('!lockprobe open 9 slot 40');

  assert.equal(probe.created[0].calls.opened, 1);
  assert.match(probe.logs.join('\n'), /unmatchedTitle="Someone else pack"/);
});

test('複数プレイヤーの pending は互いに独立している', () => {
  const probe = loadProbe();
  const other = probe.playerWith('other-id');
  probe.chat('!lockprobe open 9 slot 40');
  probe.chat('!lockprobe open 9 plain 40', other);

  probe.fireClose({ container: { size: 9, title: 'Lock probe 9 slot' } });
  probe.chat('!lockprobe open 9 slot 40');
  probe.chat('!lockprobe open 9 plain 40', other);

  assert.equal(probe.created[0].calls.opened, 2, 'slot 側の close で slot は再 open できる');
  assert.equal(probe.created[1].calls.opened, 1, 'plain 側の pending は残る');
  assert.match(probe.messages.join('\n'), /OPEN_REJECTED size=9 mode=plain reason=previous open still pending/);
});

test('close コマンドは Player オブジェクトが変わっても最後に開いた key を閉じる', () => {
  const probe = loadProbe();
  probe.chat('!lockprobe open 9 slot 40');
  probe.chat('!lockprobe close', probe.samePlayer());

  assert.equal(probe.closeCalls(), 1);
  assert.match(probe.messages.join('\n'), /CLOSE_REQUESTED key=9:slot/);
});
