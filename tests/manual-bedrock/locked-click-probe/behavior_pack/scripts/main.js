/**
 * InvUI locked-click probe (design 10, disposable test world only).
 *
 * Question: does a normal screen click on a slot whose item has
 * `ItemLockMode.slot` still raise `VirtualContainerItemChangeAfterEvent`?
 *
 * If yes (and the event reports the same item before/after), a locked item is
 * a candidate click source that is automatic, slot-distinguishable and (per the
 * docs) does not move the displayed item in slot-lock mode. If the event never
 * arrives, a locked item cannot be used as a click source, and the after-restore
 * / marker routes remain the only alternatives (both rejected for design 10).
 *
 * Design 7.2: `ItemLockMode.slot` must not be used to make VirtualContainer
 * slots read-only. A positive result is only a click-source data point, never a
 * protection mechanism; display slots still need JSON UI suppression or a
 * separate `inventory`.
 *
 * This probe does not implement a click path. It only observes and logs:
 *
 * - no JSON UI, no chat payload, no button mapping
 * - no `Container.setItem` / cursor clear / restore in the itemChange or
 *   close handlers (only the pre-open fill writes)
 * - no `handleClick`; the event is not turned into an action
 * - items are `minecraft:stick` / `minecraft:paper` only
 * - nothing in the VirtualContainer is saved; closing or reloading discards it
 *
 * DANGER: `VirtualContainerItemChangeAfterEvent` is an `after` event. It cannot
 * prevent a move and cannot restore the previous stack without the duplication
 * risk this probe deliberately avoids. A stack taken out of the container may
 * keep its lock and stay stuck in the player's inventory. Use only in a
 * throwaway world.
 *
 * Install: see ../README.md. Commands:
 *
 *   !lockprobe help
 *   !lockprobe open [size] [mode] [ticks]
 *   !lockprobe close
 *   !lockprobe stop
 *   !lockprobe dump
 *
 * `size` is 1..54 (default 9), `mode` is `slot` | `inventory` | `plain`
 * (default `slot`), `ticks` is the server auto-close delay (default 1200,
 * max 2400). Chat is unavailable while the container screen is open, so the
 * auto-close is the normal way to end a run.
 */

import { ItemLockMode, ItemStack, system, world } from "@minecraft/server";

const PREFIX = "!lockprobe";
const DEFAULT_SIZE = 9;
const DEFAULT_MODE = "slot";
const DEFAULT_TICKS = 1200;
const MAX_TICKS = 2400;
// open() は UserBusy（画面が閉じ切っていない）で拒否されることがあるので再試行する。
const MAX_OPEN_ATTEMPTS = 12;
const OPEN_RETRY_TICKS = 2;
const MAX_LOG_TEXT = 96;
const ITEM_TYPES = ["minecraft:stick", "minecraft:paper"];
const MODES = new Set(["slot", "inventory", "plain"]);

/** @type {Map<string, import("@minecraft/server").VirtualContainer>} */
const containers = new Map();
/** @type {WeakMap<import("@minecraft/server").VirtualContainer, Set<string>>} */
const pendingOpen = new WeakMap();
/** @type {Map<string, number>} */
const openGenerations = new Map();
/** @type {Map<string, string>} */
const lastKeyByPlayer = new Map();
let stopReason = "";

function log(line) {
  console.warn(`[invui-lockprobe] ${line}`);
}

function reply(player, line) {
  log(line);
  try {
    player.sendMessage(`§e[lockprobe] §f${line}`);
  } catch {
    // The player may be leaving; the console line is enough.
  }
}

function describeError(error) {
  const name = error && error.name ? error.name : "Error";
  const message = error && error.message ? error.message : String(error);
  return `${name}: ${message}`;
}

function safeText(value) {
  const text = typeof value === "string" ? value : String(value);
  const clipped = text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text;
  return clipped.replace(/[\r\n\t]/g, " ");
}

function playerLabel(player) {
  try {
    return player && player.isValid ? player.name : "(invalid player)";
  } catch {
    return "(invalid player)";
  }
}

/**
 * Stable player key. The API does not promise that the Player object handed to
 * an event is the same object as the one from a previous event, so identity
 * (`===`, WeakMap keys) must not be used to remember a player. `Entity.id` is
 * documented as unique and readable even when `isValid` is false.
 */
function playerId(player) {
  try {
    return player.id;
  } catch {
    return undefined;
  }
}

function keyFor(size, mode) {
  return `${size}:${mode}`;
}

function fillContainer(container, size, mode) {
  const expectedLock =
    mode === "slot" ? ItemLockMode.slot : mode === "inventory" ? ItemLockMode.inventory : undefined;
  let filled = 0;
  let locked = 0;
  for (let slot = 0; slot < size; slot += 1) {
    try {
      const stack = new ItemStack(ITEM_TYPES[slot % ITEM_TYPES.length], 1);
      if (expectedLock !== undefined) {
        stack.lockMode = expectedLock;
      }
      container.setItem(slot, stack);
      filled += 1;
      if (expectedLock !== undefined) {
        // Read back what the container actually holds. The hypothesis only means
        // something if the lock was applied; without this the run could silently
        // be a `plain` run and report a false negative.
        const stored = container.getItem(slot);
        const actual = stored ? stored.lockMode : undefined;
        if (actual === expectedLock) {
          locked += 1;
        } else {
          log(
            `FILL_LOCK_MISMATCH slot=${slot} mode=${mode} expected=${expectedLock} actual=${actual ?? "none"}`,
          );
        }
      }
    } catch (error) {
      log(`FILL_FAILED slot=${slot} mode=${mode} error=${describeError(error)}`);
    }
  }
  const lockNote = expectedLock === undefined ? "" : ` locked=${locked}/${size}`;
  log(`FILLED size=${size} mode=${mode} slots=${filled}/${size}${lockNote}`);
}

function createContainer(size, mode) {
  const container = world.virtualContainerManager.create({
    size,
    title: `Lock probe ${size} ${mode}`,
  });
  containers.set(keyFor(size, mode), container);
  return container;
}

function getOrCreateContainer(size, mode) {
  const key = keyFor(size, mode);
  const existing = containers.get(key);
  if (existing) {
    return existing;
  }
  return createContainer(size, mode);
}

function viewersOf(container) {
  try {
    const viewers = container.getViewers();
    return Array.isArray(viewers) ? viewers : [];
  } catch (error) {
    log(`GET_VIEWERS_FAILED error=${describeError(error)}`);
    return undefined;
  }
}

function canOpen(container) {
  // pending（未確認の open）を先に見る: これが残っている間は engine 側の状態が
  // 確定していないので、viewers の有無より強い拒否理由になる。
  const pending = pendingOpen.get(container);
  if (pending && pending.size > 0) {
    return { ok: false, reason: `previous open still pending (${pending.size})` };
  }
  const viewers = viewersOf(container);
  if (viewers === undefined) {
    return { ok: false, reason: "getViewers failed" };
  }
  if (viewers.length > 0) {
    return { ok: false, reason: `already viewed by ${viewers.length} player(s)` };
  }
  return { ok: true };
}

function openFor(player, size, mode, ticks) {
  if (stopReason) {
    reply(player, `OPEN_REJECTED stopped: ${stopReason}`);
    return;
  }
  const container = getOrCreateContainer(size, mode);
  const guard = canOpen(container);
  if (!guard.ok) {
    reply(player, `OPEN_REJECTED size=${size} mode=${mode} reason=${guard.reason}`);
    return;
  }

  // Refill on every open. A previous run may have moved or removed items
  // (plain mode, or the slot lock not being honoured), which would confound
  // the kind classification of this run. No viewers exist at this point.
  fillContainer(container, size, mode);

  // 実機では open() 直後が UserBusy（チャット画面が閉じ切っていない）で
  // 拒否されることがある。viewers が付くまで数 tick 再試行する。
  const key = keyFor(size, mode);
  let attempts = 0;

  const accept = () => {
    const generation = (openGenerations.get(key) ?? 0) + 1;
    openGenerations.set(key, generation);
    const id = playerId(player);
    if (id !== undefined) {
      lastKeyByPlayer.set(id, key);
      let pending = pendingOpen.get(container);
      if (!pending) {
        pending = new Set();
        pendingOpen.set(container, pending);
      }
      pending.add(id);
    }
    log(`OPEN_ACCEPTED size=${size} mode=${mode} attempts=${attempts} generation=${generation}`);
    reply(
      player,
      `OPEN_REQUESTED size=${size} mode=${mode} ticks=${ticks} generation=${generation} attempts=${attempts} (display is not guaranteed)`,
    );
    system.runTimeout(() => {
      if (openGenerations.get(key) !== generation) {
        log(`AUTOCLOSE skip stale size=${size} mode=${mode} generation=${generation}`);
        return;
      }
      let requested = 0;
      try {
        requested = container.close(player);
      } catch (error) {
        log(`AUTOCLOSE_FAILED size=${size} mode=${mode} error=${describeError(error)}`);
        return;
      }
      log(`AUTOCLOSE size=${size} mode=${mode} close(player) requested=${requested}`);
    }, ticks);
  };

  const acceptedNow = () => {
    const current = viewersOf(container);
    return current !== undefined && current.length > 0;
  };

  const attemptOpen = () => {
    if (stopReason) {
      log(`OPEN_ABORTED size=${size} mode=${mode} reason=stopped`);
      return;
    }
    if (acceptedNow()) {
      accept();
      return;
    }
    if (attempts >= MAX_OPEN_ATTEMPTS) {
      log(
        `OPEN_NOT_ACCEPTED size=${size} mode=${mode} attempts=${attempts} (viewers が付かない。Beta APIs と画面の有無を確認)`,
      );
      reply(player, `OPEN_FAILED size=${size} mode=${mode} reason=not-accepted`);
      return;
    }
    attempts += 1;
    try {
      container.open(player);
    } catch (error) {
      log(
        `OPEN_ATTEMPT_FAILED size=${size} mode=${mode} attempt=${attempts} error=${describeError(error)}`,
      );
      reply(player, `OPEN_FAILED size=${size} mode=${mode} error=${describeError(error)}`);
      return;
    }
    log(`OPEN_CALLED size=${size} mode=${mode} attempt=${attempts} (open() returned without throwing)`);
    if (acceptedNow()) {
      accept();
      return;
    }
    system.runTimeout(attemptOpen, OPEN_RETRY_TICKS);
  };

  attemptOpen();
}

function closePlayer(player) {
  const key = lastKeyByPlayer.get(playerId(player));
  if (!key) {
    reply(player, "CLOSE_REJECTED no previous open");
    return;
  }
  const container = containers.get(key);
  if (!container) {
    reply(player, `CLOSE_REJECTED key=${key} not found`);
    return;
  }
  let requested = 0;
  try {
    requested = container.close(player);
  } catch (error) {
    reply(player, `CLOSE_FAILED key=${key} error=${describeError(error)}`);
    return;
  }
  reply(player, `CLOSE_REQUESTED key=${key} requested=${requested}`);
}

function stopAll() {
  stopReason = "manual stop";
  for (const [key, container] of containers) {
    let requested = 0;
    try {
      requested = container.close();
    } catch (error) {
      log(`STOP_CLOSE_FAILED key=${key} error=${describeError(error)}`);
    }
    log(`STOP key=${key} close() requested=${requested}`);
  }
}

function stackKey(stack) {
  if (!stack) {
    return "none";
  }
  try {
    // lockMode is deliberately excluded: the click-source identity is the item
    // itself, and a lock dropped by the engine would otherwise hide the event.
    // The log still prints `lock=` for before/after, so a lost lock is visible.
    return JSON.stringify({
      typeId: stack.typeId,
      amount: stack.amount,
      nameTag: stack.nameTag ?? "",
    });
  } catch {
    return "unreadable";
  }
}

function describeStack(stack) {
  if (!stack) {
    return "none";
  }
  try {
    return `${stack.typeId} x${stack.amount} lock=${stack.lockMode ?? "?"} name=${
      stack.nameTag ? safeText(stack.nameTag) : "-"
    }`;
  } catch (error) {
    return `unreadable(${describeError(error)})`;
  }
}

/**
 * Close イベントの `items` から、空でないスロット数と typeId ごとの合計をまとめる。
 * 「クリックでアイテムが動かなかった」ことを後から提出できるようにするための記録で、
 * 会計や STOP 判定はしない（このプローブは観測のみ）。
 */
function summarizeCloseItems(items) {
  if (!Array.isArray(items)) {
    return undefined;
  }
  const totals = new Map();
  let nonEmpty = 0;
  // Index loop: the engine's array may not be iterable in this host even when
  // Array.isArray() is true (observed on device as "value is not iterable").
  for (let index = 0; index < items.length; index += 1) {
    const stack = items[index];
    if (!stack) {
      continue;
    }
    nonEmpty += 1;
    try {
      totals.set(stack.typeId, (totals.get(stack.typeId) ?? 0) + stack.amount);
    } catch {
      totals.set("unreadable", (totals.get("unreadable") ?? 0) + 1);
    }
  }
  return {
    nonEmpty,
    totals:
      [...totals.entries()]
        .map(([typeId, amount]) => `${typeId}x${amount}`)
        .join(", ") || "(none)",
  };
}

function readCursorStack(player) {
  try {
    const component = player.getComponent("cursor_inventory");
    return component ? component.item : undefined;
  } catch {
    return undefined;
  }
}

function containerSize(container) {
  try {
    return container.size;
  } catch {
    return "?";
  }
}

function containerTitle(container) {
  try {
    return container.title;
  } catch {
    return undefined;
  }
}

/**
 * Resolves an event container to the container this script created.
 *
 * A VirtualContainer exposes no id, and beta does not promise that
 * `event.container` is the object returned by `create()`, so object identity
 * (`===`, WeakMap keys) is neither relied on nor asserted here. `title` is set
 * once at creation, is readonly, and is unique per key here
 * ("Lock probe <size> <mode>").
 *
 * Observation only, not a guarantee:
 * - another pack can create a container with the same title, and this lookup
 *   cannot tell it apart from ours (same-title collision);
 * - an unmatched container must not clear anything: another pack's screen
 *   closing says nothing about our pending opens.
 */
function knownContainer(eventContainer) {
  const title = containerTitle(eventContainer);
  if (title === undefined) {
    return undefined;
  }
  for (const container of containers.values()) {
    if (containerTitle(container) === title) {
      return container;
    }
  }
  return undefined;
}

function classifyItemChange(event) {
  const before = event.beforeItemStack;
  const after = event.itemStack;
  if (before && after) {
    return stackKey(before) === stackKey(after) ? "SAME_ITEM_CANDIDATE" : "CHANGED";
  }
  if (before && !after) {
    return "REMOVED";
  }
  if (!before && after) {
    return "INSERTED";
  }
  return "UNKNOWN";
}

function subscribe(name, getSignal, handler) {
  try {
    const signal = getSignal();
    if (!signal || typeof signal.subscribe !== "function") {
      log(`SUBSCRIBE_UNAVAILABLE ${name}`);
      return;
    }
    signal.subscribe(handler);
    log(`SUBSCRIBE ${name}`);
  } catch (error) {
    log(`SUBSCRIBE_FAILED ${name} error=${describeError(error)}`);
  }
}

subscribe("virtualContainerItemChange", () => world.afterEvents.virtualContainerItemChange, (event) => {
  const kind = classifyItemChange(event);
  const title = containerTitle(event.container);
  const titleText = safeText(title ?? "?");
  const cursor = readCursorStack(event.player);
  // `size` alone cannot tell the three modes apart (9:slot and 9:plain are both
  // size=9), and the run matrix repeats each size in every mode. Log the
  // creation-fixed title ("Lock probe <size> <mode>") so a captured line stays
  // attributable after the console is pasted into a report.
  log(
    `ITEM_CHANGE size=${containerSize(event.container)} slot=${event.slot} title="${titleText}" kind=${kind} ` +
      `sameItem=${kind === "SAME_ITEM_CANDIDATE"} player=${playerLabel(event.player)} ` +
      `before="${describeStack(event.beforeItemStack)}" after="${describeStack(event.itemStack)}" ` +
      `cursor="${describeStack(cursor)}"`,
  );
  if (kind === "SAME_ITEM_CANDIDATE") {
    log(
      `CANDIDATE_SAME_ITEM size=${containerSize(event.container)} slot=${event.slot} title="${titleText}" ` +
        `player=${playerLabel(event.player)} (no restore, no click action)`,
    );
  }
});

subscribe("virtualContainerClose", () => world.afterEvents.virtualContainerClose, (event) => {
  // Clear the pending open of the container the event names, and only that
  // one: a pending entry is per container, and (with two players, or with one
  // player opening a second screen while the first is unconfirmed) another
  // container's close says nothing about it.
  //
  // Observation only, not a guarantee: duplicate or delayed delivery of a
  // close event is not specified. This clears the pending entry once per
  // matching close and does not claim to tell a duplicate close from a stale
  // one. A same-title container from another pack still matches, so it can
  // clear our entry, and that case is not distinguishable from ours in the log.
  const closedContainer = knownContainer(event.container);
  const closedPlayerId = playerId(event.player);
  const pending = closedContainer ? pendingOpen.get(closedContainer) : undefined;
  if (pending && closedPlayerId !== undefined) {
    pending.delete(closedPlayerId);
  }
  const title = containerTitle(event.container);
  const titleText = safeText(title ?? "?");
  const items = Array.isArray(event.items) ? event.items : undefined;
  const summary = summarizeCloseItems(items);
  // Logged so a manual run can tell "our screen closed" from "another
  // container's screen closed, pending untouched".
  const matchNote = closedContainer ? "" : ` unmatchedTitle="${titleText}"`;
  log(
    `CLOSE size=${containerSize(event.container)} title="${titleText}" reason=${event.reason} ` +
      `player=${playerLabel(event.player)} items=${items ? "array" : "missing"}` +
      matchNote,
  );
  if (summary) {
    // Contents at close. This is the evidence that a click did not move or
    // consume the items, which the decision rule asks the tester to record.
    log(
      `CLOSE_CONTENTS size=${containerSize(event.container)} title="${titleText}" ` +
        `nonEmptySlots=${summary.nonEmpty}/${items.length} totals=${summary.totals}`,
    );
  }
});

subscribe("playerCursorItemGrab", () => world.afterEvents.playerCursorItemGrab, (event) => {
  log(`CURSOR_GRAB player=${playerLabel(event.player)} item="${describeStack(event.item)}"`);
});

subscribe("playerCursorItemRelease", () => world.afterEvents.playerCursorItemRelease, (event) => {
  log(`CURSOR_RELEASE player=${playerLabel(event.player)} item="${describeStack(event.item)}"`);
});

subscribe("playerInventoryItemChange", () => world.afterEvents.playerInventoryItemChange, (event) => {
  log(
    `INVENTORY_CHANGE player=${playerLabel(event.player)} type=${event.inventoryType} slot=${event.slot} ` +
      `before="${describeStack(event.beforeItemStack)}" after="${describeStack(event.itemStack)}"`,
  );
});

subscribe("playerHotbarSelectedSlotChange", () => world.afterEvents.playerHotbarSelectedSlotChange, (event) => {
  log(
    `HOTBAR_SELECT player=${playerLabel(event.player)} previous=${event.previousSlotSelected} ` +
      `new=${event.newSlotSelected} item="${describeStack(event.itemStack)}"`,
  );
});

subscribe("playerInputModeChange", () => world.afterEvents.playerInputModeChange, (event) => {
  log(
    `INPUT_MODE player=${playerLabel(event.player)} previous=${event.previousInputModeUsed} ` +
      `new=${event.newInputModeUsed}`,
  );
});

subscribe("playerButtonInput", () => world.afterEvents.playerButtonInput, (event) => {
  log(
    `BUTTON_INPUT player=${playerLabel(event.player)} button=${event.button} ` +
      `state=${event.newButtonState}`,
  );
});

// Internal API: documented as "otherwise not currently functional". Logged only
// so a future build can show whether a client-to-server channel appears here.
subscribe("messageReceive", () => world.afterEvents.messageReceive, (event) => {
  log(
    `MESSAGE_RECEIVE player=${playerLabel(event.player)} id=${safeText(event.id)} ` +
      `message=${safeText(event.message)}`,
  );
});

function parseInteger(text, fallback, min, max) {
  if (text === undefined) {
    return fallback;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function handleCommand(player, args) {
  const [command, sizeText, modeText, ticksText] = args;
  if (command === undefined || command === "help") {
    reply(
      player,
      "commands: !lockprobe open [size 1-54] [mode slot|inventory|plain] [ticks 20-2400] | close | stop | dump",
    );
    return;
  }
  if (command === "open") {
    const size = parseInteger(sizeText, DEFAULT_SIZE, 1, 54);
    if (size === undefined) {
      reply(player, `OPEN_REJECTED invalid size "${safeText(sizeText)}"`);
      return;
    }
    const mode = modeText ?? DEFAULT_MODE;
    if (!MODES.has(mode)) {
      reply(player, `OPEN_REJECTED invalid mode "${safeText(mode)}"`);
      return;
    }
    const ticks = parseInteger(ticksText, DEFAULT_TICKS, 20, MAX_TICKS);
    if (ticks === undefined) {
      reply(player, `OPEN_REJECTED invalid ticks "${safeText(ticksText)}"`);
      return;
    }
    openFor(player, size, mode, ticks);
    return;
  }
  if (command === "close") {
    closePlayer(player);
    return;
  }
  if (command === "stop") {
    stopAll();
    reply(player, "STOP: future opens rejected; close requested for every viewer");
    return;
  }
  if (command === "dump") {
    for (const [key, container] of containers) {
      const viewers = viewersOf(container);
      log(
        `DUMP key=${key} size=${containerSize(container)} viewers=${
          viewers === undefined ? "unavailable" : viewers.map(playerLabel).join(",") || "none"
        }`,
      );
      for (let slot = 0; slot < containerSize(container); slot += 1) {
        try {
          const stack = container.getItem(slot);
          if (stack) {
            log(`DUMP_SLOT key=${key} slot=${slot} item="${describeStack(stack)}"`);
          }
        } catch (error) {
          log(`DUMP_SLOT_FAILED key=${key} slot=${slot} error=${describeError(error)}`);
        }
      }
    }
    return;
  }
  reply(player, `unknown command "${safeText(command)}"`);
}

try {
  world.beforeEvents.chatSend.subscribe((event) => {
    let message;
    let sender;
    try {
      message = event.message;
      sender = event.sender;
    } catch {
      return;
    }
    if (typeof message !== "string" || !message.startsWith(`${PREFIX} `)) {
      return;
    }
    try {
      event.cancel = true;
    } catch {
      // Keep going: the command still runs, it just may also appear in chat.
    }
    const args = message.slice(PREFIX.length).trim().split(/\s+/);
    try {
      system.run(() => handleCommand(sender, args));
    } catch (error) {
      log(`COMMAND_SCHEDULE_FAILED error=${describeError(error)}`);
    }
  });
  log(
    "読み込み完了。使い捨てワールド専用。観測のみ（復元・click action・JSON UI なし）。" +
      " !lockprobe help",
  );
} catch (error) {
  log(`INIT_FAILED error=${describeError(error)}`);
}
