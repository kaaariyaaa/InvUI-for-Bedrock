/**
 * InvUI for Bedrock - フェーズ0 使い捨てプローブ
 *
 * 目的:
 * - VirtualContainer の基本表示 (create / open / close / getViewers)
 * - virtualContainerClose の reason 観測
 * - virtualContainerItemChange の観測（画面からの操作だけで発生するか）
 * - button.send → チャット通知の受信観測（専用 prefix だけ cancel し、受信ログを残す。click は実行しない）
 *
 * 危険警告:
 * - 使い捨てワールド専用。本番ワールド・配布ワールド・共有サーバーで実行しない。
 * - JSON UI も InputBridge も含まない。クリック入力の検証はできない。
 * - 表示アイテムの保護はない。画面から取り出せる。ダイヤ等価値のあるアイテムは使わない。
 * - VirtualContainer の内容は保存されない。再読み込み・ワールド終了・パック無効化で消えるため、
 *   貴重品や実際に使うアイテムを預けない。中身は使い捨ての stick/paper だけにする。
 * - このパックは Resource Pack を含まないため通常チェストの UI は変更しないが、
 *   手動で JSON UI を併用する場合は通常チェストへの影響を必ず確認する。
 * - 画面を開いたままの setItem (fill) はクライアント表示とサーバー状態をずれさせ、複製を作り得る。
 *   そのため閲覧者 (getViewers) がいるコンテナへの fill は拒否する。加えて、open を要求した直後の
 *   未表示 (pending) でも拒否する。開いた人が close イベントで解除するまで fill はできない。
 * - 同一 size の共有コンテナを複数画面で同時に開くと、表示同期のずれから複製を作り得る。
 *   open は既存の閲覧者・表示未確認の open (pending)・getViewers 失敗を拒否する。全員が閉じること。
 * - サーバー側 close (AUTOCLOSE / stop) の前に、カーソルに持っているアイテムをスロットへ戻すこと
 *   (cursor 退避)。強制 close 時にカーソル上のアイテムは失われ得る（未検証・退避推奨）。
 * - STOP の会計はコンテナ内の typeId/amount 合計だけを見る。プレイヤーインベントリ側で増えた
 *   複製・増加は検知できない。インベントリと合計個数を目視で突き合わせること。
 * - itemChange は DANGER として記録する。画面から出した投入物は消える・複製する可能性が未検証。
 *   合計個数を突き合わせ、会計不一致を検知したら STOP して以降の open / fill を拒否する。
 * - button.send の通知文字列はプレイヤーが手入力できるため偽装可能。このプローブは受信の観測だけを
 *   行い、click action / handleClick / スロット操作は一切実行しない（設計書 10.5 の入力安全性）。
 *
 * 依存:
 * - @minecraft/server 2.13.0-beta (manifest の dependency)
 * - Minecraft Preview/Beta で Experimental/Beta API を有効にする
 */

import { ItemStack, system, world } from "@minecraft/server";

const COMMAND_PREFIX = "!invui";
/**
 * button.send → チャット通知の観測用 prefix。設計書 10.4 の `!invui:<session-id>:<slot-index>:<sequence>`。
 * コマンドは `!invui ` (空白区切り)、通知は `!invui:` (コロン) で区別する。
 */
const NOTIFY_PREFIX = "!invui:";
const MAX_LOGGED_NOTIFY_LENGTH = 160;
const DISPOSABLE_ITEM_IDS = ["minecraft:stick", "minecraft:paper"];
const MAX_AUTO_CLOSE_TICKS = 2400;

/** @type {Map<number, import("@minecraft/server").VirtualContainer>} */
const containersBySize = new Map();
/** @type {WeakMap<import("@minecraft/server").Player, number>} */
const lastSizeByPlayer = new WeakMap();

/**
 * コンテナごとの会計。fill と itemChange の差分から「コンテナ内にあるはずの個数」を維持し、
 * 実スロットの走査結果と比較する。itemChange の取りこぼし・消失・複製の検知に使う。
 * @type {Map<import("@minecraft/server").VirtualContainer, {size: number, expected: Map<string, number>, changeWarned: boolean}>}
 */
const ledgers = new Map();

/**
 * open() を要求したが getViewers() で表示を確認できていないプレイヤー。
 * 同一 size の共有コンテナを複数画面で開くと表示同期がずれ、複製を作り得るため、
 * close イベントが来るまで解除しない。
 * ponytail: UserBusy 等で close イベントが来ない場合は再読み込みまで同一 size の open を止める。
 * 誤って複数画面を開くより安全側に倒す。
 * @type {Map<import("@minecraft/server").VirtualContainer, Set<import("@minecraft/server").Player>>}
 */
const pendingOpenPlayers = new Map();

/** 空文字なら継続中。危険検知または手動停止で理由が入り、以降の open / fill を拒否する。 */
let stopReason = "";

function log(line) {
  console.warn(`[invui-probe] ${line}`);
}

function playerLabel(player) {
  try {
    return player && player.isValid ? player.name : "(invalid player)";
  } catch {
    return "(invalid player)";
  }
}

function reply(player, line) {
  log(line);
  try {
    player.sendMessage(`§e[probe] §f${line}`);
  } catch {
    // 退出中などで送れない場合はコンソールだけに残す
  }
}

function describeError(error) {
  const name = error && error.name ? error.name : "Error";
  const message = error && error.message ? error.message : String(error);
  const reason = error && error.reason ? ` reason=${error.reason}` : "";
  return `${name}: ${message}${reason}`;
}

/** ログの行構造を壊さないよう、制御文字・引用符をエスケープし長さを制限する。 */
function safeLogText(value, maxLength) {
  const text = typeof value === "string" ? value : String(value);
  const clipped = text.length > maxLength ? `${text.slice(0, maxLength)}…(truncated)` : text;
  return JSON.stringify(clipped);
}

function requireManager(player) {
  if (!world.virtualContainerManager) {
    reply(
      player,
      "world.virtualContainerManager がありません。Beta/Experimental API と @minecraft/server 2.13.0-beta が有効か確認してください。",
    );
    return undefined;
  }
  return world.virtualContainerManager;
}

function parseSize(player, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 54) {
    reply(player, `size は 1〜54 の整数で指定してください（推奨: 9 / 27 / 54）。指定値: ${raw}`);
    return undefined;
  }
  return value;
}

function parseAutoCloseTicks(player, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUTO_CLOSE_TICKS) {
    reply(
      player,
      `ticks は 1〜${MAX_AUTO_CLOSE_TICKS} の整数で指定してください（20 ticks ≒ 1 秒）。指定値: ${raw}`,
    );
    return undefined;
  }
  return value;
}

function withContainer(player, rawSize) {
  const size = rawSize === undefined ? lastSizeByPlayer.get(player) : parseSize(player, rawSize);
  if (size === undefined) {
    reply(player, "対象コンテナがありません。先に `!invui open 27` のように開いてください。");
    return undefined;
  }
  const container = containersBySize.get(size);
  if (!container) {
    reply(player, `size=${size} のコンテナは未作成です。先に \`!invui open ${size}\` を実行してください。`);
    return undefined;
  }
  return { size, container };
}

function subscribeContainer(container, size) {
  const ledger = ledgerFor(container, size);

  world.afterEvents.virtualContainerClose.subscribe(
    (event) => {
      if (event.container !== container) return;
      // close イベントで表示未確認の open を解除する。次に同じ size を開けるのはこの後。
      const pending = pendingOpenPlayers.get(container);
      if (pending) removePendingOpener(pending, event.player);
      const hasItems = Array.isArray(event.items);
      const items = hasItems ? event.items : [];
      const nonEmptySlots = items.filter((item) => item !== undefined).length;
      const line = `CLOSE size=${size} reason=${event.reason} player=${playerLabel(event.player)} nonEmptySlots=${nonEmptySlots}`;
      log(line);

      // close 時点の全内容を残す。空きは明示的に (empty) とし、個数は種別ごとに合計する。
      const contents = [];
      const counted = new Map();
      if (hasItems) {
        for (let slot = 0; slot < items.length; slot += 1) {
          const item = items[slot];
          if (!item) continue;
          contents.push(`${slot}=${item.typeId}x${item.amount}`);
          addCount(counted, item.typeId, item.amount);
        }
      }
      log(
        `CLOSE_CONTENTS size=${size} slots=${contents.join(", ") || "(empty)"} ` +
          `totals=${formatCounts(counted) || "(none)"}`,
      );
      if (!hasItems) {
        // items が無い版では会計を判定できない。誤って STOP せず、記録だけ残す。
        log(`CLOSE_ITEMS missing size=${size}: event.items が配列でないため会計チェックを省略する`);
      } else {
        // 同一 tick の移動イベントと close の順序に依存しないよう、会計の突き合わせは次 tick へ回す。
        system.run(() => warnIfAccountingBroken(ledger, counted, event.player));
      }

      try {
        if (event.player.isValid) event.player.sendMessage(`§e[probe] §f${line}`);
      } catch {
        // PlayerLeft では player が無効なため、コンソール記録だけにする
      }
    },
    { containers: [container] },
  );

  world.afterEvents.virtualContainerItemChange.subscribe(
    (event) => {
      if (event.container !== container) return;
      const before = describeStack(event.beforeItemStack);
      const after = describeStack(event.itemStack);
      const line = `DANGER ITEM_CHANGE size=${size} slot=${event.slot} player=${playerLabel(event.player)} ${before} -> ${after}`;
      log(line);
      log(
        "DANGER 画面からの操作を検知した。投入物は画面外へ出る・消える可能性があり、複製も未検証。" +
          "ダンプとプレイヤーインベントリの合計個数を必ず突き合わせること。",
      );

      // このスロットの差分だけ会計へ反映する。実スロットとの突き合わせは、操作が
      // 一段落する close / dump で行う（移動が複数スロットの途中経過を挟むため）。
      if (event.beforeItemStack) addCount(ledger.expected, event.beforeItemStack.typeId, -event.beforeItemStack.amount);
      if (event.itemStack) addCount(ledger.expected, event.itemStack.typeId, event.itemStack.amount);

      try {
        if (event.player.isValid) {
          event.player.sendMessage(`§c[危険] §f画面操作 slot=${event.slot} ${before} -> ${after}`);
          if (!ledger.changeWarned) {
            ledger.changeWarned = true;
            event.player.sendMessage(
              "§c[危険] §f投入したアイテムは画面外へ出る/消えることがあり、複製の可能性も未検証です。" +
                "合計個数が合わなければ `!invui stop` で中止し、ワールドを破棄してください。",
            );
          }
        }
      } catch {
        // 退出中はコンソール記録だけにする
      }
    },
    { containers: [container] },
  );
}

function ledgerFor(container, size) {
  let ledger = ledgers.get(container);
  if (!ledger) {
    ledger = { size, expected: new Map(), changeWarned: false };
    ledgers.set(container, ledger);
  }
  return ledger;
}

function describeStack(stack) {
  return stack ? `${stack.typeId} x${stack.amount}` : "(empty)";
}

function addCount(counts, typeId, delta) {
  counts.set(typeId, (counts.get(typeId) || 0) + delta);
}

function formatCounts(counts) {
  return [...counts.entries()]
    .filter(([, count]) => count !== 0)
    .map(([typeId, count]) => `${typeId}x${count}`)
    .join(", ");
}

function isStopped() {
  return stopReason !== "";
}

/** 危険検知後の停止。追加の根拠は記録だけして、理由は最初のものを使う。 */
function requestStop(reason) {
  if (isStopped()) {
    log(`STOP 追加の根拠: ${reason}`);
    return;
  }
  stopReason = reason;
  log(`!!! STOP 停止条件に該当 !!! ${reason}`);
  log("!!! 以降の open / fill を拒否する。記録を取り、ワールドを破棄またはバックアップから復元すること。");
}

/** STOP 済みなら true を返し、呼び出し元の操作を拒否する。 */
function guardStop(player) {
  if (!isStopped()) return false;
  reply(player, `§c[停止中] §fopen / fill を拒否しました。理由: ${stopReason}`);
  return true;
}

function pendingOpeners(container) {
  let pending = pendingOpenPlayers.get(container);
  if (!pending) {
    pending = new Set();
    pendingOpenPlayers.set(container, pending);
  }
  return pending;
}

/** Player オブジェクトの同一性は id で判定する（close イベントで別インスタンスが来る場合に備える）。 */
function isSamePlayer(a, b) {
  if (a === b) return true;
  try {
    return Boolean(a && b && a.id && b.id && a.id === b.id);
  } catch {
    return false;
  }
}

function hasPendingOpener(pending, player) {
  for (const other of pending) {
    if (isSamePlayer(other, player)) return true;
  }
  return false;
}

function removePendingOpener(pending, player) {
  for (const other of pending) {
    if (isSamePlayer(other, player)) pending.delete(other);
  }
}

/**
 * 同一 size の共有コンテナを複数画面で開かないための open 前ガード。
 * 表示中 (getViewers) だけでなく、open 要求済みで未確認 (pending) も安全側で拒否する。
 * @returns {boolean} true なら open を拒否した
 */
function rejectUnsafeOpen(player, container, size) {
  let viewers;
  try {
    viewers = container.getViewers();
  } catch (error) {
    log(`OPEN_REJECTED size=${size} reason=getViewers failed: ${describeError(error)}`);
    reply(
      player,
      `open を拒否しました: getViewers() を確認できないため (${describeError(error)})。安全側に倒します。`,
    );
    return true;
  }
  if (viewers.length > 0) {
    const names = viewers.map(playerLabel).join(", ");
    log(
      `!!! DANGER OPEN_REJECTED size=${size} viewers=${names}: ` +
        "同一 size の共有コンテナを複数画面で開くと表示がずれ、複製を作り得る",
    );
    reply(
      player,
      `§c[危険] §fopen を拒否しました: 既に閲覧中 (${names})。同一 size のコンテナを複数画面で開くと` +
        "表示がずれ、複製を作り得ます。全員が画面を閉じてから実行してください。",
    );
    return true;
  }

  const pending = pendingOpeners(container);
  const pendingNames = [...pending].filter((other) => !isSamePlayer(other, player)).map(playerLabel);
  if (pendingNames.length > 0) {
    log(
      `!!! DANGER OPEN_REJECTED size=${size} pending=${pendingNames.join(", ")}: ` +
        "open 要求済みで表示を確認できていない画面が残っている",
    );
    reply(
      player,
      `§c[危険] §fopen を拒否しました: 表示を確認できていない open が残っています (${pendingNames.join(", ")})。` +
        "そのプレイヤーが画面を閉じるか、表示を確認できるまで待ってください。",
    );
    return true;
  }
  if (hasPendingOpener(pending, player)) {
    log(`OPEN_REJECTED size=${size} reason=pending player=${playerLabel(player)}`);
    reply(
      player,
      "open を拒否しました: 前回の open の close イベントがまだ来ていません。" +
        "画面を閉じるか、再読み込みで pending をリセットしてください。",
    );
    return true;
  }
  return false;
}

function warnIfAccountingBroken(ledger, actual, player) {
  const diffs = [];
  const typeIds = new Set([...ledger.expected.keys(), ...actual.keys()]);
  for (const typeId of typeIds) {
    const want = ledger.expected.get(typeId) || 0;
    const got = actual.get(typeId) || 0;
    if (want !== got) diffs.push(`${typeId}: 期待 ${want} / 実際 ${got} (差 ${got - want})`);
  }
  if (diffs.length === 0) return;

  const detail =
    `会計不一致: ${diffs.join("; ")}。` +
    "itemChange の取りこぼし・投入物の消失・複製のいずれかの疑いがあり、この結果は合格にできない。";
  log(`!!! DANGER ACCOUNTING size=${ledger.size} ${detail}`);
  requestStop(detail);
  try {
    if (player && player.isValid) {
      player.sendMessage(`§c[危険] §f${detail} 合計個数を確認し、中止してください。`);
    }
  } catch {
    // 退出中はコンソール記録だけにする
  }
}

function ensureContainer(player, size) {
  const manager = requireManager(player);
  if (!manager) return undefined;

  let container = containersBySize.get(size);
  if (!container) {
    try {
      container = manager.create({ size, title: `InvUI probe ${size}` });
    } catch (error) {
      reply(player, `create() 失敗: ${describeError(error)}`);
      return undefined;
    }
    containersBySize.set(size, container);
    subscribeContainer(container, size);
    reply(player, `VirtualContainer を作成しました (size=${size}, title="InvUI probe ${size}")。`);
  }
  lastSizeByPlayer.set(player, size);
  return container;
}

function printHelp(player) {
  reply(
    player,
    "コマンド: `!invui open [9|27|54] [ticks]` / `!invui fill` / `!invui close` / `!invui dump` / `!invui stop` / `!invui help`",
  );
  reply(player, "open は非同期です。close イベントが来る前に同じプレイヤーへ再 open すると PreviousScreenClosing になります。");
  reply(
    player,
    "open は既存の閲覧者・表示未確認の open・getViewers() 失敗を拒否します（同一 size の共有コンテナを複数画面で開くと表示がずれて複製を作り得るため）。",
  );
  reply(player, "ticks を指定すると open からその tick 数後にサーバー側で close() します（画面表示中でも ServerClosed を検証できる）。");
  reply(
    player,
    "§c[危険] §fサーバー側 close (AUTOCLOSE / stop) の前に、カーソルに持っているアイテムをスロットへ戻してください（cursor 退避）。強制 close 時にカーソル上のアイテムは失われ得ます。",
  );
  reply(player, "VirtualContainer の中身は保存されません。貴重品・実アイテムを預けないでください（再読み込み/終了で消失）。");
  reply(
    player,
    "§c[危険] §f画面を開いたまま fill すると複製を作り得るため、閲覧者または表示未確認の open (pending) が残っている間の fill は拒否します。全員が閉じて close イベントが来てから実行してください。",
  );
  reply(
    player,
    "§c[危険] §f画面からの操作 (itemChange) で投入物が消える・複製する可能性は未検証です。`!invui dump` の ACCOUNTING と合計個数を突き合わせてください。",
  );
  reply(player, "会計不一致を検知したら STOP し、以降の open / fill を拒否します。中止は `!invui stop`。");
  reply(
    player,
    "§c[危険] §fSTOP の会計はコンテナ内の typeId/amount 合計だけです。プレイヤーインベントリ側で増えた複製・増加は検知できません。合計個数を目視で突き合わせてください。",
  );
  reply(
    player,
    "`!invui:` で始まるチャットは button.send 通知の観測用です。通常チャットには出さず、`NOTIFY_OBSERVED` を記録するだけで click は実行しません（偽装可能なため）。",
  );
}

function handleOpen(player, args) {
  if (guardStop(player)) return;
  const sizeRaw = args[0];
  const ticksRaw = args[1];
  const size = sizeRaw === undefined ? 27 : parseSize(player, sizeRaw);
  if (size === undefined) return;
  const autoCloseTicks = ticksRaw === undefined ? undefined : parseAutoCloseTicks(player, ticksRaw);
  if (ticksRaw !== undefined && autoCloseTicks === undefined) return;

  const container = ensureContainer(player, size);
  if (!container) return;
  if (rejectUnsafeOpen(player, container, size)) return;

  const pending = pendingOpeners(container);
  pending.add(player);
  try {
    container.open(player);
    reply(
      player,
      `open() を要求しました (size=${size})。例外なし＝画面表示済みではありません。表示されない場合は UserBusy 等を確認してください。` +
        "表示を確認できない場合は close イベントまで同一 size の open を拒否します（再読み込みで解除）。",
    );
  } catch (error) {
    removePendingOpener(pending, player);
    reply(player, `open() 失敗: ${describeError(error)}。close イベント後に再試行してください。`);
    return;
  }

  if (autoCloseTicks !== undefined) {
    reply(
      player,
      `AUTOCLOSE 予約: open から ${autoCloseTicks} ticks (約 ${(autoCloseTicks / 20).toFixed(1)} 秒) 後に close() を要求します。` +
        "手で閉じた場合もタイマーは残るので、その場合は requested=0 になります。",
    );
    system.runTimeout(() => {
      try {
        if (!player.isValid) {
          log(`AUTOCLOSE skip size=${size}: player は既に無効`);
          return;
        }
      } catch {
        log(`AUTOCLOSE skip size=${size}: player の有効性を確認できない`);
        return;
      }
      try {
        const requested = container.close(player);
        reply(
          player,
          `AUTOCLOSE size=${size} close() requested=${requested}。close イベントの reason が ServerClosed か確認してください。`,
        );
      } catch (error) {
        reply(player, `AUTOCLOSE close() 失敗: ${describeError(error)}`);
      }
    }, autoCloseTicks);
  }

  // getViewers は表示完了を保証しない。次 tick 時点の参考値として記録する。
  system.run(() => {
    let viewers = "?";
    let confirmed = false;
    try {
      const list = container.getViewers();
      viewers = list.map(playerLabel).join(", ") || "(none)";
      confirmed = list.includes(player);
    } catch (error) {
      viewers = `(getViewers failed: ${describeError(error)})`;
    }
    reply(player, `getViewers() = ${viewers}`);
    // close イベントが同じ tick に先着した場合は pending が既に消えているため、その場合は出さない。
    if (!confirmed && hasPendingOpener(pending, player)) {
      log(
        `OPEN_PENDING size=${size} player=${playerLabel(player)}: 表示を確認できないため ` +
          "close イベントまで同一 size の再 open を拒否する",
      );
    }
  });
}

function handleFill(player) {
  if (guardStop(player)) return;
  const target = withContainer(player);
  if (!target) return;
  const { size, container } = target;

  // 確認済みの危険: 画面を開いたまま setItem すると、クライアントの表示内容とサーバー側の
  // スロット状態がずれ、その後の移動でアイテムが複製し得る。閲覧者がいる間は書き込まない。
  let viewers;
  try {
    viewers = container.getViewers();
  } catch (error) {
    log(`FILL_REJECTED size=${size} reason=getViewers failed: ${describeError(error)}`);
    reply(
      player,
      `fill を拒否しました: getViewers() を確認できないため (${describeError(error)})。安全側に倒します。`,
    );
    return;
  }
  if (viewers.length > 0) {
    const names = viewers.map(playerLabel).join(", ");
    log(`!!! DANGER FILL_REJECTED size=${size} viewers=${names}: 画面を開いたままの setItem は複製を作り得る`);
    reply(
      player,
      `§c[危険] §ffill を拒否しました: 閲覧中 (${names})。画面を開いたまま書き込むと表示とサーバー状態がずれ、` +
        "複製を作り得ます。全員が画面を閉じてから実行してください。",
    );
    return;
  }

  // 盲点の封鎖: open() 直後は getViewers() に反映されていないことがあり、viewers ガードだけでは
  // 表示直前に setItem できてしまう。open を要求したが close イベントがまだ来ていない players が
  // いる間は、自分自身であっても書き込まず fail-closed する。
  const pending = pendingOpenPlayers.get(container);
  const pendingNames = pending && pending.size > 0 ? [...pending].map(playerLabel) : [];
  if (pendingNames.length > 0) {
    log(
      `!!! DANGER FILL_REJECTED size=${size} pending=${pendingNames.join(", ")}: ` +
        "open 要求済みで表示を確認できていない画面が残っているため setItem しない",
    );
    reply(
      player,
      `§c[危険] §ffill を拒否しました: 表示を確認できていない open が残っています (${pendingNames.join(", ")})。` +
        "close イベントが来るまで書き込めません。画面を閉じるか、再読み込みで pending を解除してください。",
    );
    return;
  }

  const slots = [0, 1, 10, size - 1].filter((slot, index, all) => {
    return slot >= 0 && slot < size && all.indexOf(slot) === index;
  });

  const ledger = ledgerFor(container, size);
  let written = 0;
  try {
    for (const slot of slots) {
      const itemId = DISPOSABLE_ITEM_IDS[slot % DISPOSABLE_ITEM_IDS.length];
      const previous = container.getItem(slot);
      container.setItem(slot, new ItemStack(itemId, 1));
      written += 1;
      // 上書き前の内容を会計から外し、新しい内容を加える。
      if (previous) addCount(ledger.expected, previous.typeId, -previous.amount);
      addCount(ledger.expected, itemId, 1);
    }
  } catch (error) {
    reply(player, `setItem() 失敗 (${written} スロット書き込み後): ${describeError(error)}`);
    return;
  }

  reply(
    player,
    `setItem() で使い捨てアイテム (stick/paper) を ${slots.length} スロットへ書き込みました。` +
      "スクリプト変更では ITEM_CHANGE が出ないことを確認してください（出たら仕様と不一致）。" +
      "画面から動かすと複製・消失の可能性があるため、ダンプと合計個数を突き合わせてください。",
  );
}

function handleStop(player) {
  requestStop(`手動停止 (${playerLabel(player)})`);
  let requested = 0;
  for (const container of containersBySize.values()) {
    try {
      requested += container.close();
    } catch (error) {
      log(`STOP close() 失敗: ${describeError(error)}`);
    }
  }
  reply(
    player,
    `STOP しました。以降の open / fill は拒否します (close() requested=${requested})。` +
      "記録を取り、ワールドを破棄するかバックアップから復元してください。",
  );
}

function handleClose(player) {
  const target = withContainer(player);
  if (!target) return;
  try {
    const requested = target.container.close(player);
    reply(
      player,
      `close() を要求しました (size=${target.size}, requested=${requested})。close イベントは別 tick になることがあります。`,
    );
  } catch (error) {
    reply(player, `close() 失敗: ${describeError(error)}`);
  }
}

function handleDump(player) {
  const target = withContainer(player);
  if (!target) return;
  const { size, container } = target;

  let viewers = "?";
  try {
    viewers = container.getViewers().map(playerLabel).join(", ") || "(none)";
  } catch (error) {
    viewers = `(getViewers failed: ${describeError(error)})`;
  }

  const items = [];
  const counted = new Map();
  for (let slot = 0; slot < size; slot += 1) {
    let item;
    try {
      item = container.getItem(slot);
    } catch (error) {
      items.push(`${slot}:ERROR(${describeError(error)})`);
      continue;
    }
    if (item) {
      items.push(`${slot}:${item.typeId} x${item.amount}`);
      addCount(counted, item.typeId, item.amount);
    }
  }

  reply(player, `DUMP size=${size} viewers=${viewers} items=${items.join(", ") || "(empty)"}`);
  const ledger = ledgerFor(container, size);
  reply(
    player,
    `ACCOUNTING size=${size} expected=${formatCounts(ledger.expected) || "(none)"} ` +
      `actual=${formatCounts(counted) || "(none)"}`,
  );
  warnIfAccountingBroken(ledger, counted, player);
}

function handleCommand(player, args) {
  const sub = (args[0] || "help").toLowerCase();
  switch (sub) {
    case "open":
      handleOpen(player, args.slice(1));
      return;
    case "fill":
      handleFill(player);
      return;
    case "close":
      handleClose(player);
      return;
    case "dump":
      handleDump(player);
      return;
    case "stop":
      handleStop(player);
      return;
    case "help":
      printHelp(player);
      return;
    default:
      reply(player, `不明なサブコマンド: ${sub}`);
      printHelp(player);
  }
}

/**
 * button.send → チャット通知の「受信観測」だけを行う。
 *
 * - beforeEvents.chatSend で専用 prefix のメッセージだけを cancel し、通常チャットに表示しない。
 * - beforeEvents 内では世界を変更できないため、記録は system.run で次 tick に回す。
 * - 通知文字列はプレイヤーが手入力でき偽装可能。設計書 10.5 のとおり信用できないため、
 *   click action / handleClick / スロット操作は一切実行しない。受信の有無と内容の記録だけ。
 * - 実機では JSON UI の button.send がこの prefix を送るか（そもそもチェスト画面で成立するか）を
 *   手動で確認する。このパックは JSON UI を含まないため、手入力でも同じ観測経路を試せる。
 */
world.beforeEvents.chatSend.subscribe((event) => {
  const raw = typeof event.message === "string" ? event.message : "";
  // 専用 prefix だけを cancel する。通常チャットと `!invui ` コマンドは通す。
  if (!raw.startsWith(NOTIFY_PREFIX)) return;
  event.cancel = true;

  let sender = "(unknown sender)";
  try {
    sender = playerLabel(event.sender);
  } catch {
    // sender が読めなくても観測ログは残す
  }

  system.run(() => {
    log(
      `NOTIFY_OBSERVED sender=${sender} message=${safeLogText(raw, MAX_LOGGED_NOTIFY_LENGTH)} ` +
        "action=NONE（観測のみ。通知は偽装可能なため click action は実行しない）",
    );
  });
});

world.afterEvents.chatSend.subscribe((event) => {
  const message = event.message.trim();
  if (!message.toLowerCase().startsWith(COMMAND_PREFIX)) return;
  const args = message
    .slice(COMMAND_PREFIX.length)
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0);
  try {
    handleCommand(event.sender, args);
  } catch (error) {
    reply(event.sender, `コマンド処理で例外: ${describeError(error)}`);
  }
});

if (!world.virtualContainerManager) {
  log(
    "world.virtualContainerManager が見つかりません。Beta/Experimental API と @minecraft/server 2.13.0-beta を確認してください。",
  );
} else {
  log("読み込み完了。使い捨てワールドで `!invui help` を実行してください。");
}
