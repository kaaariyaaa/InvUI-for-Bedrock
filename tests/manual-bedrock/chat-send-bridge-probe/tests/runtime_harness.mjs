/** Mocked Script API protocol tests. These do not validate Bedrock JSON UI behavior. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code=readFileSync(new URL('../behavior_pack/scripts/main.js',import.meta.url),'utf8')
  .replace(/^import \{ world, system, ItemStack \} from '@minecraft\/server';/m,'');
const handlers={};
const signal=n=>({subscribe:fn=>(handlers[n]=fn)});
const world={
 virtualContainerManager: {create({size,title}){assert.equal(size,27);assert.equal(title,'InvUI Chat Probe');return {
  size,title,items:new Map(),setItem(i,item){this.items.set(i,item);},open(player){player.hasScreen=true;player.container=this;},close(player){player.hasScreen=false;}
 };}},
 beforeEvents:{chatSend:signal('chat')},
 afterEvents:{virtualContainerClose:signal('close'),virtualContainerItemChange:signal('change'),playerLeave:signal('leave')}
};
const system={run(fn){fn();}};
class ItemStack {constructor(typeId,amount){this.typeId=typeId;this.amount=amount;}}
let time=1700000000000;
const FakeDate={now:()=>time};
const ctx=vm.createContext({world,system,ItemStack,console,Date:FakeDate,Map,Number,RegExp,Error});
new vm.Script(code).runInContext(ctx);
const player={id:'p',messages:[],sendMessage(text){this.messages.push(text);}};
function chat(message){const ev={message,sender:player,cancel:false};handlers.chat(ev);return ev;}
let ev=chat('!invui test');
assert.equal(ev.cancel,true);
assert.equal(player.hasScreen,true);
assert.equal(player.container.items.size,27);
const msg=player.messages.find(x=>x.includes('Example full input:'));
assert.ok(msg);
const example=msg.match(/!invui:([^:\s]+):0:0:0/);
assert.ok(example);
const token=example[1];
assert.ok(chat(`!invui:${token}:0:4:0`).cancel);
assert.ok(player.messages.at(-1).includes('logical slot=4; events=1'));
chat(`!invui:${token}:0:4:0`);
assert.ok(player.messages.at(-1).includes('replayed'));
time+=200;
chat(`!invui:${token}:1:5:1`);
assert.ok(player.messages.at(-1).includes('obsolete'));
time+=200;
chat(`!invui:${token}:0:27:1`);
assert.ok(player.messages.at(-1).includes('outside'));
time+=200;
chat(`!invui:${token}:0:5:1`);
assert.ok(player.messages.at(-1).includes('logical slot=5; events=2'));
chat(`!invui:${token}:0:6:2`);
assert.ok(player.messages.at(-1).includes('rate limit'));
handlers.close({player,container:player.container,reason:'PlayerClosed'});
assert.ok(player.messages.at(-1).includes('VirtualContainer closed'));
time+=200;
chat(`!invui:${token}:0:6:2`);
assert.ok(player.messages.at(-1).includes('no open'));
assert.equal(chat('regular chat').cancel,false);
console.log('Mocked VirtualContainer chat protocol: OK (open, dispatch, replay, stale, range, throttle, close).');
