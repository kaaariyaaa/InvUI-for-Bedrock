import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
const SOURCE=readFileSync(new URL('../behavior_pack/scripts/main.js',import.meta.url),'utf8').replace(/^import \{ world, system, ItemStack \} from '@minecraft\/server';/m,'');
function setup() {
 let now=1700000000000, nextTimerId=1;
 const timers=new Map(),signals={};
 const subscribe=key=>({subscribe(handler){signals[key]=handler;}});
 class ItemStack {constructor(typeId,amount){this.typeId=typeId;this.amount=amount;this.nameTag='';}}
 const containers=[];
 const world={
   virtualContainerManager:{create({size,title}){
     const c={size,title,items:new Map(),viewers:[],openAttempts:0,
       open(player){this.openAttempts++;this.viewers=[player];},
       close(player){this.viewers=this.viewers.filter(p=>p.id!==player.id);},
       getViewers(){return this.viewers;},
       setItem(i,stack){this.items.set(i,stack);}};
     containers.push(c);return c;
   }},
   beforeEvents:{chatSend:subscribe('chat')},
   afterEvents:{virtualContainerClose:subscribe('close'),virtualContainerItemChange:subscribe('change'),playerLeave:subscribe('leave')}
 };
 const system={run(fn){fn();},runInterval(fn,interval){const id=nextTimerId++;timers.set(id,{fn,interval});return id;},clearRun(id){timers.delete(id);}};
 runInNewContext(SOURCE,{world,system,ItemStack,console,Date:{now:()=>now},Map,Number,Array,Set,RegExp,Error,Math,String});
 const player={id:'player-one',messages:[],sendMessage(value){this.messages.push(value);}};
 const chat=message=>{const event={message,sender:player,cancel:false};signals.chat(event);return event;};
 const tick=()=>{for(const [id,value] of [...timers])if(timers.has(id))value.fn();};
 const stack=(slot,amount)=>{const x=new ItemStack(slot%2?'minecraft:paper':'minecraft:stick',amount);x.nameTag='slot '+slot;return x;};
 const click=(slot,before,after)=>signals.change({player,slot,container:containers.at(-1),beforeItemStack:before,itemStack:after});
 return {player,chat,tick,stack,click,containers,timers,signals,setNow(n){now=n;}};
}
test('opens after the first retry tick',()=>{
 const x=setup();assert.equal(x.chat('!invui test').cancel,true);
 assert.equal(x.containers[0].openAttempts,0);x.tick();
 assert.equal(x.containers[0].openAttempts,1);
 assert.equal(x.containers[0].items.size,27);
 assert.equal(x.containers[0].items.get(0).amount,64);
 x.tick();assert.equal(x.timers.size,0);
});
test('a one-item slot drop invokes a handler without replenishing the stack',()=>{
 const x=setup();x.chat('!invui test');x.tick();x.tick();
 x.click(21,x.stack(21,64),x.stack(21,63));
 assert.match(x.player.messages.at(-1),/Received slot click: logical slot=21; events=1/);
 assert.equal(x.containers[0].items.get(21).amount,64,'handler must not refill');
 x.setNow(1700000000300);
 x.click(21,x.stack(21,63),x.stack(21,62));
 assert.match(x.player.messages.at(-1),/Received slot click: logical slot=21; events=2/);
});
test('abnormal item changes close the session without running a click',()=>{
 const x=setup();x.chat('!invui test');x.tick();x.tick();
 x.click(3,x.stack(3,64),x.stack(3,12));
 assert.match(x.player.messages.at(-1),/Unexpected item change at slot 3/);
 assert.equal(x.containers[0].viewers.length,0);
 assert.equal(x.chat('!invui info').cancel,true);
 assert.match(x.player.messages.at(-1),/No session/);
});
test('the original chat route still works',()=>{
 const x=setup();x.chat('!invui test');x.tick();x.tick();
 const msg=x.player.messages.find(s=>s.includes('Example full input:'));
 const m=msg.match(/!invui:([^:\s]+):0:0:0/);assert.ok(m);
 assert.equal(x.chat('!invui:'+m[1]+':0:0:0').cancel,true);
 assert.match(x.player.messages.at(-1),/Received chat click: logical slot=0/);
});
test('clear and leave cancel pending retries',()=>{
 const x=setup();x.chat('!invui test');assert.equal(x.timers.size,1);
 x.chat('!invui clear');assert.equal(x.timers.size,0);
 x.chat('!invui test');assert.equal(x.timers.size,1);
 x.signals.leave({playerId:x.player.id});assert.equal(x.timers.size,0);
});
