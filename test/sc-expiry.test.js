'use strict';
const assert=require('node:assert/strict');
const {durationMsForAmount,createScExpiry}=require('../desktop/sc-expiry.js');

function harness(options={}) {
  let at=1789120000000,timerId=0;
  const timers=new Map(),expired=[];
  const expiry=createScExpiry({now:()=>at,
    setTimer:(run,delay)=>{assert.ok(Number.isFinite(delay)&&delay>=0&&delay<=2147483647,'native timeout must be safe');const id=++timerId;timers.set(id,{run,at:at+delay,delay});return id;},
    clearTimer:id=>timers.delete(id),onExpire:ids=>expired.push({at,ids:[...ids]}),...options});
  function advance(ms){const end=at+ms;for(let i=0;i<10000;i++){
    const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next){at=end;return;}timers.delete(next[0]);at=next[1].at;next[1].run();
  }throw Error('timer loop');}
  return{expiry,timers,expired,advance,get at(){return at;}};
}
let passed=0;
function test(name,run){run();console.log('PASS '+name);passed++;}

test('all user supplied yuan tiers and intervening amounts use the intended durations',()=>{
  for(const [yuan,seconds]of [[2,5],[30,60],[50,120],[100,300],[500,1800],[1000,3600],[2000,7200]])assert.equal(durationMsForAmount(yuan),seconds*1000);
  for(const [yuan,seconds]of [[16,32.5],[40,90],[75,210],[300,1050],[750,2700],[1500,5400],[3000,10800]])assert.equal(durationMsForAmount(yuan),seconds*1000);
  assert.ok(Math.abs(durationMsForAmount(2.1)-(5000+0.1*55000/28))<=1);
  assert.equal(durationMsForAmount(1),5000);assert.equal(durationMsForAmount(0),5000);
});

test('unknown and invalid amounts retain a safe fallback instead of immediately deleting an SC',()=>{
  for(const value of [undefined,null,NaN,Infinity,-Infinity,'',{},false,true])assert.equal(durationMsForAmount(value),60000,String(value));
  assert.equal(durationMsForAmount('30'),60000);
  assert.ok(Number.isFinite(durationMsForAmount(Number.MAX_VALUE)));
});

test('default auto expiry uses one nearest deadline timer and batches same-time expiry',()=>{
  const h=harness();assert.equal(h.expiry.getState().neverExpire,false);assert.equal(h.timers.size,0);
  for(let id=1;id<=100;id++)h.expiry.track(String(id),2);
  h.expiry.track('later',30);assert.equal(h.timers.size,1);
  h.advance(4999);assert.equal(h.expired.length,0);h.advance(1);
  assert.equal(h.expired.length,1);assert.deepEqual(h.expired[0].ids,Array.from({length:100},(_,i)=>String(i+1)));
  assert.equal(h.expiry.getState().size,1);assert.equal(h.timers.size,1);
  h.advance(55000);assert.deepEqual(h.expired.at(-1).ids,['later']);assert.equal(h.timers.size,0);assert.equal(h.expiry.getState().size,0);
});

test('tracking again and content-only updates do not restart the original lifetime',()=>{
  const h=harness();h.expiry.track('a',2);h.advance(4000);h.expiry.track('a',2);h.expiry.update('a',2);
  h.advance(1000);assert.deepEqual(h.expired[0].ids,['a']);assert.equal(h.expiry.getState().size,0);
});

test('amount corrections preserve original receipt time when increasing or reducing the duration',()=>{
  const h=harness();h.expiry.track('a',2);h.advance(3000);h.expiry.update('a',30);
  h.advance(56999);assert.equal(h.expired.length,0);h.advance(1);assert.deepEqual(h.expired[0].ids,['a']);
  h.expiry.track('b',30);h.advance(6000);h.expiry.update('b',2);h.advance(0);
  assert.deepEqual(h.expired.at(-1).ids,['b']);assert.equal(h.timers.size,0);
});

test('keep forever is opt-in and disabling it recomputes remaining time without resetting age',()=>{
  const h=harness();h.expiry.track('old',2);h.expiry.track('younger',30);h.advance(2000);
  h.expiry.setNeverExpire(true);assert.equal(h.timers.size,0);h.advance(10000);assert.equal(h.expired.length,0);
  h.expiry.setNeverExpire(false);h.advance(0);assert.deepEqual(h.expired[0].ids,['old']);assert.equal(h.expiry.getState().size,1);
  h.advance(47999);assert.equal(h.expired.length,1);h.advance(1);assert.deepEqual(h.expired.at(-1).ids,['younger']);
});

test('SCs received while keep forever is enabled still retain original receipt times',()=>{
  const h=harness({neverExpire:true});h.expiry.track('a',2);h.advance(9000000);
  assert.equal(h.expired.length,0);assert.equal(h.timers.size,0);h.expiry.setNeverExpire(false);h.advance(0);
  assert.deepEqual(h.expired.at(-1).ids,['a']);assert.equal(h.timers.size,0);
});

test('manual dismissal cancels only that SC and expiry continues for the next deadline',()=>{
  const h=harness();h.expiry.track('a',2);h.expiry.track('b',30);h.expiry.remove('a');
  h.advance(5000);assert.equal(h.expired.length,0);assert.equal(h.timers.size,1);
  h.advance(55000);assert.deepEqual(h.expired[0].ids,['b']);h.expiry.remove('missing');assert.equal(h.timers.size,0);
});

test('clear, keep toggles and disposal invalidate old callbacks and release timer resources',()=>{
  const h=harness();h.expiry.track('old',2);const callbacks=[...h.timers.values()].map(t=>t.run);
  h.expiry.clear();assert.equal(h.timers.size,0);h.expiry.track('new',30);
  callbacks.forEach(run=>run());assert.equal(h.expired.length,0);assert.equal(h.expiry.getState().size,1);
  h.expiry.setNeverExpire(true);const count=h.expired.length;h.advance(100000);assert.equal(h.expired.length,count);
  h.expiry.dispose();assert.equal(h.timers.size,0);assert.equal(h.expiry.getState().size,0);h.expiry.track('ignored',2);h.advance(10000);assert.equal(h.expired.length,count);
});

test('large interpolated durations use chunked native timers rather than overflowing and firing immediately',()=>{
  const h=harness();const amount=1000000,duration=durationMsForAmount(amount);assert.ok(duration>2147483647);
  h.expiry.track('large',amount);assert.equal(h.timers.size,1);h.advance(2147483647);assert.equal(h.expired.length,0);assert.equal(h.timers.size,1);
  h.advance(duration-2147483647);assert.deepEqual(h.expired[0].ids,['large']);assert.equal(h.timers.size,0);
});

console.log('SC expiry tests passed: '+passed);
