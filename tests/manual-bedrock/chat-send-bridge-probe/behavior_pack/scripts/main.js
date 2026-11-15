/**
 * InvUI for Bedrock: VirtualContainer + chatSend transport diagnostic.
 * This is a separately installable PROBE; it does not monkey-patch the user's library.
 * The library already handles full `!invui:<session>:<generation>:<slot>:<seq>`
 * messages in src/chat-input-bridge.ts. This harness uses the same protocol
 * so its sender/receiver behavior can be isolated from UI rendering.
 *
 * A message entered by hand proves chat interception, NOT button.send working.
 * The code cannot determine if a message came from an on-screen JSON UI button.
 */
import { world, system, ItemStack } from '@minecraft/server';

const PREFIX = '!invui:';
const sessions = new Map();
const lastSequence = new Map();
const seenAt = new Map();
let counter = 0;

function message(player, text) {
  try { player.sendMessage(`§b[InvUI Chat]§r ${text}`); } catch (e) { console.warn(e); }
}
function createSession(player) {
  const manager = world.virtualContainerManager;
  if (!manager || typeof manager.create !== 'function') {
    message(player, 'VirtualContainer API is missing. A compatible Preview/Beta is required.');
    return;
  }
  const prior = sessions.get(player.id);
  if (prior) {
    try { prior.container.close(player); } catch { /* Client may already have closed it. */ }
    sessions.delete(player.id);
  }
  const size = 27;
  const sessionId = `v${Date.now().toString(36)}x${(++counter).toString(36)}`;
  const container = manager.create({ size, title: 'InvUI Chat Probe' });
  // Every item is an expendable visual token. Never replenish on itemChange.
  for (let i = 0; i < size; i++) {
    const stack = new ItemStack(i % 2 ? 'minecraft:paper' : 'minecraft:stick', 1);
    stack.nameTag = `slot ${i}`;
    container.setItem(i, stack);
  }
  sessions.set(player.id, { container, sessionId, generation: 0, hits: 0 });
  lastSequence.set(player.id, -1);
  try {
    container.open(player);
  } catch (e) {
    sessions.delete(player.id);
    message(player, `Open failed: ${String(e)}`);
    return;
  }
  message(player, `Opened size ${size}. Current session=${sessionId}; generation=0.`);
  message(player, `Example full input: !invui:${sessionId}:0:0:0`);
}
function parseInput(raw) {
  if (!raw.startsWith(PREFIX)) return null;
  const parts=raw.slice(PREFIX.length).split(':');
  if (parts.length!==4) return null;
  const [sessionId,generationText,slotText,sequenceText]=parts;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) return null;
  if (![generationText,slotText,sequenceText].every(x=>/^(0|[1-9][0-9]*)$/.test(x))) return null;
  const [generation,slot,sequence]=[generationText,slotText,sequenceText].map(Number);
  if (![generation,slot,sequence].every(Number.isSafeInteger)) return null;
  return {sessionId,generation,slot,sequence};
}
function acceptClick(player, input) {
  const state=sessions.get(player.id);
  if (!state) return message(player,'Rejected: no open VirtualContainer session.');
  if (state.sessionId!==input.sessionId || state.generation!==input.generation)
    return message(player,'Rejected: obsolete session/layout generation.');
  if (input.slot<0 || input.slot>=state.container.size)
    return message(player,'Rejected: slot outside the current window.');
  const prev=lastSequence.get(player.id) ?? -1;
  if (input.sequence<=prev) return message(player,'Rejected: replayed sequence.');
  const now=Date.now();
  if (now-(seenAt.get(player.id) || 0)<100) return message(player,'Rejected: rate limit.');
  seenAt.set(player.id,now);
  lastSequence.set(player.id,input.sequence);
  state.hits++;
  // Deliberately do not call container.setItem(): avoids item duplication.
  message(player, `Received chat click: logical slot=${input.slot}; events=${state.hits}.`);
}
world.beforeEvents.chatSend.subscribe(event => {
  const raw=event.message;
  if (raw==='!invui test') {
    event.cancel=true;
    const sender=event.sender;
    system.run(() => createSession(sender));
    return;
  }
  if (raw==='!invui clear') {
    event.cancel=true;
    const sender=event.sender;
    system.run(() => {
      const st=sessions.get(sender.id);
      if (st) { try { st.container.close(sender); } catch {} }
      sessions.delete(sender.id);
      lastSequence.delete(sender.id);
      seenAt.delete(sender.id);
      message(sender,'Session cleared.');
    });
    return;
  }
  if (raw==='!invui info') {
    event.cancel=true;
    const sender=event.sender;
    system.run(()=>{
      const st=sessions.get(sender.id);
      if (st) message(sender,`Current sample: !invui:${st.sessionId}:${st.generation}:0:${(lastSequence.get(sender.id)??-1)+1}`);
      else message(sender,'No session. Type !invui test first.');
    });
    return;
  }
  if (raw.startsWith(PREFIX)) {
    event.cancel=true;
    const input=parseInput(raw);
    const sender=event.sender;
    system.run(()=>{
      if (!input) message(sender,'Invalid notification syntax.');
      else acceptClick(sender,input);
    });
  }
});

try {
  world.afterEvents.virtualContainerClose.subscribe(ev => {
    const s=sessions.get(ev.player.id);
    if (s && s.container===ev.container) {
      sessions.delete(ev.player.id);
      lastSequence.delete(ev.player.id);
      seenAt.delete(ev.player.id);
      message(ev.player,`VirtualContainer closed: ${ev.reason}`);
    }
  });
} catch (error) { console.warn('No virtualContainerClose support:',error); }
try {
  world.afterEvents.virtualContainerItemChange.subscribe(ev => {
    const s=sessions.get(ev.player.id);
    if (s && s.container===ev.container) {
      message(ev.player,`Container item moved at slot ${ev.slot}; closing to avoid rewriting the slot.`);
      sessions.delete(ev.player.id);
      try { s.container.close(ev.player); } catch {}
    }
  });
} catch (error) { console.warn('No virtualContainerItemChange support:',error); }
try {
  world.afterEvents.playerLeave.subscribe(ev => {
    sessions.delete(ev.playerId);
    lastSequence.delete(ev.playerId);
    seenAt.delete(ev.playerId);
  });
} catch (error) { console.warn('playerLeave unavailable:',error); }
console.warn('InvUI VirtualContainer chat diagnostic ready. Type !invui test.');
