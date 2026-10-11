'use strict';

const assert = require('node:assert/strict');
const { createMessagePlayback } = require('../desktop/message-playback.js');
const { createScExpiry } = require('../desktop/sc-expiry.js');

function harness(options = {}) {
  let now = 100000, timerId = 0;
  const timers = new Map(), snapshots = [], states = [];
  let queue;
  queue = createMessagePlayback({
    now: () => now,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer: id => timers.delete(id),
    onChange: () => snapshots.push({ at: now, messages: queue.getMessages().map(m => ({ ...m })) }),
    onStateChange: state => states.push({ at: now, ...state }),
    ...options
  });
  function advance(ms) {
    const end = now + ms;
    for (let budget = 0; budget < 100000; budget++) {
      const next = [...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) { now=end;return; }
      timers.delete(next[0]); now=next[1].at; next[1].callback();
    }
    throw Error('Timer did not settle');
  }
  return {queue,timers,snapshots,states,advance,get now(){return now;},jump(ms){now+=ms;}};
}
const message = (id, type='chat', extra={}) => ({ id:String(id),type,text:'编号 '+id,uname:'测试',at:100000,time:'00:01:40',emotes:{},...extra });
let passed=0;
function test(name, run) { run(); console.log('PASS '+name);passed++; }

test('100 simultaneous arrivals reveal individually in order before only played history is pruned',()=>{
  const h=harness();h.queue.setActive(true);
  for(let n=1;n<=100;n++)h.queue.enqueue(message(n));
  assert.equal(h.queue.getMessages().length,1,'idle first arrival is immediately available');
  assert.equal(h.queue.getStats().pending,99);
  assert.equal(h.snapshots[0].at,h.now);
  h.advance(2200);
  const seen=new Set(),times=[];
  for(const snapshot of h.snapshots){
    const fresh=snapshot.messages.filter(m=>!seen.has(m.id));
    assert.equal(fresh.length,1,'each published ordinary scene adds exactly one card');
    times.push(snapshot.at);fresh.forEach(m=>seen.add(m.id));
    assert.ok(snapshot.messages.filter(m=>m.type!=='sc').length<=48);
  }
  assert.deepEqual([...seen],Array.from({length:100},(_,i)=>String(i+1)));
  assert.ok(times.at(-1)-times[0]<=2000,'100-item burst drains within the chosen two-second budget');
  assert.ok(times.slice(1).every((at,i)=>at-times[i]>=16),'no synchronous catch-up batch');
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),Array.from({length:48},(_,i)=>String(i+53)));
  assert.equal(h.queue.getStats().pending,0);assert.equal(h.queue.getStats().skipped,0);
  assert.equal(h.timers.size,0,'no animation/pacing/state timer while idle');
});

test('low-rate messages incur no queue delay and a new burst does not inherit old acceleration',()=>{
  const h=harness();h.queue.setActive(true);
  for(let n=1;n<=5;n++) { const at=h.now;h.queue.enqueue(message(n));assert.equal(h.snapshots.at(-1).at,at);h.advance(1000); }
  h.queue.enqueue(message(6));h.queue.enqueue(message(7));
  const before=h.snapshots.length;h.advance(15);assert.equal(h.snapshots.length,before);
  h.advance(100);assert.equal(h.queue.getStats().pending,0);
});

test('short bursts accelerate without slowing their final tail and continuous modest traffic stays current',()=>{
  const h=harness();h.queue.setActive(true);
  for(let n=1;n<=25;n++)h.queue.enqueue(message(n));h.advance(1600);
  const intervals=h.snapshots.slice(1).map((s,i)=>s.at-h.snapshots[i].at);
  assert.ok(intervals.every((d,i)=>i===0||d<=intervals[i-1]),JSON.stringify(intervals));
  for(let n=26;n<=75;n++){h.queue.enqueue(message(n));h.advance(100);assert.equal(h.queue.getStats().pending,0);}
  assert.equal(h.queue.getStats().skipped,0);assert.equal(h.timers.size,0);
});

test('SC bypasses backlog while queued gift corrections keep the original identity and position',()=>{
  const h=harness();h.queue.setActive(true);h.queue.enqueue(message(1));
  h.queue.enqueue(message(2,'gift',{kind:'guard',valueYuan:198}));h.queue.enqueue(message(3));
  assert.equal(h.queue.update('2',old=>({...old,text:'实际支付168',valueYuan:168})),true);
  const at=h.now;h.queue.enqueue(message(4,'sc',{valueYuan:50}));
  assert.equal(h.snapshots.at(-1).at,at);assert.ok(h.queue.getMessages().some(m=>m.id==='4'));
  assert.equal(h.queue.getStats().pending,2);h.advance(300);
  const gift=h.queue.getMessages().find(m=>m.id==='2');assert.equal(gift.valueYuan,168);assert.equal(gift.time,'00:01:40');
  const regularFirst=[];const known=new Set();
  for(const s of h.snapshots)for(const m of s.messages)if(m.type!=='sc'&&!known.has(m.id)){known.add(m.id);regularFirst.push(m.id);}
  assert.deepEqual(regularFirst,['1','2','3']);
  assert.equal(h.queue.dismiss('2'),false);assert.equal(h.queue.dismiss('4'),true);assert.equal(h.queue.dismiss('4'),false);
});

test('no output viewers means latest history only and no stale replay when a viewer returns',()=>{
  const h=harness();for(let n=1;n<=100;n++)h.queue.enqueue(message(n));
  assert.equal(h.queue.getStats().pending,0);assert.equal(h.timers.size,0);
  assert.equal(h.queue.getMessages().length,48);assert.equal(h.queue.getMessages()[0].id,'53');
  h.queue.setActive(true);h.queue.enqueue(message(101));h.queue.enqueue(message(102));h.queue.enqueue(message(103));
  h.queue.setActive(false);assert.equal(h.queue.getStats().pending,0);assert.equal(h.timers.size,0);
  assert.equal(h.queue.getMessages().at(-1).id,'103');
  h.queue.setActive(true);const count=h.snapshots.length;h.advance(2000);assert.equal(h.snapshots.length,count);
  h.queue.enqueue(message(104));assert.equal(h.queue.getMessages().at(-1).id,'104');
});

test('clearing and disposing cancel pending work and stale timer callbacks cannot replay a new room',()=>{
  const h=harness();h.queue.setActive(true);h.queue.enqueue(message(1));h.queue.enqueue(message(2));
  const callbacks=[...h.timers.values()].map(t=>t.callback);
  h.queue.clear();assert.equal(h.queue.hasMessages(),false);assert.equal(h.queue.getStats().pending,0);
  h.queue.enqueue(message(3));h.queue.enqueue(message(4));const count=h.snapshots.length;
  callbacks.forEach(fn=>fn());assert.equal(h.snapshots.length,count,'an old callback must not drain the new queue');
  h.advance(200);assert.deepEqual(h.queue.getMessages().map(m=>m.id),['3','4']);
  h.queue.enqueue(message(5));h.queue.enqueue(message(6));h.queue.dispose();
  assert.equal(h.timers.size,0);const stopped=h.snapshots.length;h.advance(10000);assert.equal(h.snapshots.length,stopped);
});

test('disconnect cancels only pending cards and old timers cannot drain a later queue',()=>{
  const h=harness();h.queue.setActive(true);h.queue.enqueue(message(1));
  h.queue.enqueue(message(2,'sc',{valueYuan:50}));h.queue.enqueue(message(3));h.queue.enqueue(message(4,'gift'));
  const callbacks=[...h.timers.values()].map(t=>t.callback),before=h.snapshots.length;
  assert.equal(h.queue.cancelPending(),2);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['1','2']);
  assert.equal(h.queue.getStats().active,true,'an output subscriber remains connected');
  assert.equal(h.queue.getStats().pending,0);assert.equal(h.queue.getStats().pendingBytes,0);
  assert.equal(h.timers.size,0);assert.equal(h.snapshots.length,before,'retained history is not cleared or republished');
  callbacks.forEach(fn=>fn());h.advance(10000);assert.equal(h.snapshots.length,before);
  h.queue.enqueue(message(5));h.queue.enqueue(message(6));const resumed=h.snapshots.length;
  callbacks.forEach(fn=>fn());assert.equal(h.snapshots.length,resumed);
  h.advance(100);assert.deepEqual(h.queue.getMessages().map(m=>m.id),['1','2','5','6']);
  assert.equal(h.queue.cancelPending(),0);h.queue.dispose();assert.equal(h.queue.cancelPending(),0);
});

test('late callbacks reveal at most one ordinary message instead of flushing all elapsed steps',()=>{
  const h=harness();h.queue.setActive(true);for(let n=1;n<=20;n++)h.queue.enqueue(message(n));
  const next=[...h.timers].sort((a,b)=>a[1].at-b[1].at)[0];
  h.timers.delete(next[0]);h.jump(800);const count=h.snapshots.length;next[1].callback();
  assert.ok(h.snapshots.length-count<=1);assert.ok(h.queue.getStats().pending>=18);h.queue.dispose();
});

test('pending count protection reports skips while preserving queued paid gifts before ordinary messages',()=>{
  const h=harness({maxPending:4});h.queue.setActive(true);h.queue.enqueue(message(1));
  h.queue.enqueue(message(2,'gift'));h.queue.enqueue(message(3));h.queue.enqueue(message(4,'welcome'));h.queue.enqueue(message(5));h.queue.enqueue(message(6));
  assert.equal(h.queue.getStats().pending,4);assert.equal(h.queue.getStats().skipped,1);
  h.advance(1000);assert.ok(h.queue.getMessages().some(m=>m.id==='2'));
  assert.equal(h.queue.getMessages().length,5);assert.equal(h.queue.getMessages().at(-1).id,'6');
  h.queue.clear();assert.equal(h.queue.getStats().skipped,0);assert.equal(h.timers.size,0);
});

test('byte protection applies to large metadata and pending updates without retaining an oversized record',()=>{
  const h=harness({maxPendingBytes:1800});h.queue.setActive(true);h.queue.enqueue(message(1));
  h.queue.enqueue(message(2));h.queue.enqueue(message(3));
  h.queue.update('2',m=>({...m,text:'大'.repeat(3000)}));
  assert.ok(h.queue.getStats().pendingBytes<=1800);assert.ok(h.queue.getStats().skipped>=1);
  h.advance(1000);assert.ok(!h.queue.getMessages().some(m=>m.id==='2'));
  assert.equal(h.queue.getStats().pendingBytes,0);assert.equal(h.queue.update('missing',m=>m),false);
});

test('all-paid overload remains bounded and never evicts pinned SC',()=>{
  const h=harness({maxPending:3});h.queue.setActive(true);h.queue.enqueue(message(1));h.queue.enqueue(message(2,'sc'));
  for(let n=3;n<=20;n++)h.queue.enqueue(message(n,'gift'));
  assert.equal(h.queue.getStats().pending,3);assert.equal(h.queue.getStats().skipped,15);
  h.advance(2000);assert.ok(h.queue.getMessages().some(m=>m.id==='2'&&m.type==='sc'));
  assert.equal(h.timers.size,0);
});

test('protection counts are observable without an IPC notification for each discarded message',()=>{
  const h=harness({maxPending:3});h.queue.setActive(true);h.queue.enqueue(message(1));
  for(let n=2;n<=1000;n++)h.queue.enqueue(message(n));
  assert.equal(h.queue.getStats().skipped,996);
  assert.ok(h.states.some(s=>s.skipped>0),'first protection event is observable immediately');
  assert.ok(h.states.length<=4,'subsequent skipped counts are coalesced instead of flooding the console');
  h.advance(1000);assert.equal(h.states.at(-1).pending,0);assert.equal(h.states.at(-1).skipped,996);
  assert.equal(h.timers.size,0);
});

test('upstream removal of several SCs publishes once and leaves regular history and pending order intact',()=>{
  const h=harness();h.queue.setActive(true);h.queue.enqueue(message(1));h.queue.enqueue(message(2));
  h.queue.enqueue(message(3,'sc'));h.queue.enqueue(message(4,'sc'));h.queue.enqueue(message(5,'sc'));
  const before=h.snapshots.length;h.queue.dismissMany(['1','2','3','4','missing']);
  assert.equal(h.snapshots.length,before+1);assert.equal(h.queue.getStats().pending,1);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['1','5']);
  h.advance(100);assert.deepEqual(h.queue.getMessages().map(m=>m.id),['1','2','5']);
  const count=h.snapshots.length;h.queue.dismissMany(['missing']);assert.equal(h.snapshots.length,count);
});

test('unpin returns an already visible SC to its receipt position without consuming or delaying pending messages',()=>{
  const h=harness();h.queue.setActive(true);
  h.queue.enqueue(message('A'));h.queue.enqueue(message('older-pending'));
  h.queue.enqueue(message('SC','sc',{kind:'sc',valueYuan:50,at:99999,time:'00:01:39',gapMs:123}));
  h.queue.enqueue(message('newer-pending'));h.queue.enqueue(message('still-pinned','sc'));
  const before={...h.queue.getMessages().find(m=>m.id==='SC')};
  const stats=h.queue.getStats(),timers=[...h.timers],snapshots=h.snapshots.length;
  assert.equal(before.scPinned,true);assert.equal(h.queue.unpinMany(['SC']),1);
  assert.equal(h.snapshots.length,snapshots+1);assert.deepEqual(h.queue.getStats(),stats);assert.deepEqual([...h.timers],timers);
  assert.deepEqual(h.queue.getMessages().find(m=>m.id==='SC'),{...before,scPinned:false});
  assert.deepEqual(h.queue.getMessages().filter(m=>m.type!=='sc'||m.scPinned===false).map(m=>m.id),['A','SC']);
  h.advance(500);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['A','older-pending','SC','newer-pending','still-pinned']);
  assert.equal(h.queue.getMessages().at(-1).scPinned,true);assert.equal(h.queue.getStats().pending,0);assert.equal(h.timers.size,0);
});

test('multiple unpins publish once, ignore duplicates and join the same chronological history regardless of argument order',()=>{
  const h=harness({maxPlayed:3});
  h.queue.enqueue(message('A'));h.queue.enqueue(message('SC-1','sc'));h.queue.enqueue(message('B'));
  h.queue.enqueue(message('SC-2','sc'));h.queue.enqueue(message('C'));
  const count=h.snapshots.length;
  assert.equal(h.queue.unpinMany(['SC-2','SC-1','SC-1','A','missing']),2);
  assert.equal(h.snapshots.length,count+1);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['B','SC-2','C']);
  assert.equal(h.queue.getMessages()[1].scPinned,false);
  assert.equal(h.queue.unpinMany(['SC-2','missing']),0);assert.equal(h.snapshots.length,count+1);
  assert.equal(h.queue.unpinMany(null),0);
});

test('an old unpinned SC naturally falls outside full ordinary history rather than evicting newer messages',()=>{
  const h=harness({maxPlayed:3});h.queue.enqueue(message('SC','sc'));
  for(let id=1;id<=4;id++)h.queue.enqueue(message(id));
  assert.equal(h.queue.getMessages().length,4);assert.equal(h.queue.unpinMany(['SC']),1);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['2','3','4']);
  assert.equal(h.queue.update('SC',old=>old),false);assert.equal(h.queue.dismiss('SC'),false);
});

test('source updates cannot repin an archived SC and upstream removal still releases its ordinary-history slot',()=>{
  const h=harness({maxPlayed:3});h.queue.enqueue(message(1));h.queue.enqueue(message(2,'sc',{valueYuan:30}));h.queue.enqueue(message(3));
  h.queue.unpinMany(['2']);
  assert.equal(h.queue.update('2',old=>({...old,id:'wrong-id',type:'chat',scPinned:true,text:'updated',valueYuan:100})),true);
  const archived=h.queue.getMessages()[1];assert.equal(archived.id,'2');assert.equal(archived.type,'sc');
  assert.equal(archived.scPinned,false);assert.equal(archived.valueYuan,100);assert.equal(archived.text,'updated');
  assert.equal(h.queue.dismissMany(['2','2']),1);assert.equal(h.queue.update('2',old=>old),false);
  h.queue.enqueue(message(4));h.queue.enqueue(message(5));
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['3','4','5']);
  h.queue.clear();h.queue.enqueue(message(2,'sc'));assert.equal(h.queue.getMessages()[0].scPinned,true);
  h.queue.dispose();assert.equal(h.queue.unpinMany(['2']),0);
});

test('closing the final viewer folds old pending arrivals around an archived SC in receipt order',()=>{
  const h=harness();h.queue.setActive(true);h.queue.enqueue(message('A'));h.queue.enqueue(message('B'));
  h.queue.enqueue(message('SC','sc'));h.queue.enqueue(message('C'));h.queue.unpinMany(['SC']);
  h.queue.setActive(false);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['A','B','SC','C']);
  assert.equal(h.queue.getMessages()[2].scPinned,false);assert.equal(h.queue.getStats().pending,0);assert.equal(h.timers.size,0);
  const count=h.snapshots.length;h.queue.setActive(true);h.advance(5000);assert.equal(h.snapshots.length,count);
});

test('real expiry callbacks archive once while keep-forever prevents automatic unpin and later updates cannot restart it',()=>{
  const h=harness();let timer=0;
  const expiry=createScExpiry({now:()=>h.now,
    setTimer:(callback,delay)=>{const id='expiry-'+(++timer);h.timers.set(id,{callback,at:h.now+delay});return id;},
    clearTimer:id=>h.timers.delete(id),onExpire:ids=>h.queue.unpinMany(ids)});
  h.queue.enqueue(message('A'));h.queue.enqueue(message('SC','sc',{valueYuan:2}));h.queue.enqueue(message('B'));
  expiry.track('SC',2);expiry.setNeverExpire(true);h.advance(10000);
  assert.equal(h.queue.getMessages()[1].scPinned,true);assert.equal(h.timers.size,0);
  expiry.setNeverExpire(false);assert.equal(h.queue.getMessages()[1].scPinned,false);
  assert.deepEqual(h.queue.getMessages().map(m=>m.id),['A','SC','B']);
  assert.equal(expiry.getState().size,0);assert.equal(expiry.update('SC',2000),false);
  h.queue.update('SC',old=>({...old,scPinned:true,valueYuan:2000}));h.advance(10000);
  assert.equal(h.queue.getMessages()[1].scPinned,false);assert.equal(h.timers.size,0);
  expiry.dispose();h.queue.dispose();
});

console.log('Message playback tests passed: '+passed);
