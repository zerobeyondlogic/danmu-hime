'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function harness(){
  const context={console};
  vm.runInNewContext('const desktopOutputClients=new Set(),desktopOutputCleanup=new Map(),MAX_DESKTOP_OUTPUT_BUFFER=1024*1024;let desktopOutputBridge=null;\n'+
    source.slice(source.indexOf('function setDesktopOutputBridge('),source.indexOf('\nfunction loadCookies()'))+`
    globalThis.api={setBridge:setDesktopOutputBridge,publish:publishDesktopOutput,write:writeDesktopOutputPayload,
      remove:removeDesktopOutputClient,disconnect:disconnectDesktopOutputClient,
      add(client,cleanup){desktopOutputClients.add(client);if(cleanup)desktopOutputCleanup.set(client,cleanup);notifyDesktopOutputSubscribers();},
      size:()=>desktopOutputClients.size};`,context);
  return context.api;
}
const client=extra=>({writableLength:0,writes:[],destroyed:false,write(data){this.writes.push(data);return true;},destroy(){this.destroyed=true;},...extra});
{
  const api=harness(),counts=[],a=client(),b=client();let cleaned=0;
  api.setBridge({onSubscribersChanged:n=>counts.push(n)});api.add(a,()=>cleaned++);api.add(b);
  assert.deepEqual(counts,[0,1,2]);api.remove(a);assert.equal(cleaned,1);api.remove(a);assert.equal(cleaned,1);
  assert.deepEqual(counts,[0,1,2,1]);api.remove(b);assert.equal(counts.at(-1),0);
  let copied=0;api.publish('scene',()=>{copied++;return{};});assert.equal(copied,0);
  console.log('PASS actual output publisher tracks all viewers and skips snapshots with no subscribers');
}
{
  const api=harness(),a=client({write(data){this.writes.push(data);return false;}}),b=client();api.add(a);api.add(b);let copies=0;
  for(let id=1;id<=5;id++)api.publish('scene',()=>{copies++;return{revision:id,messages:[{id:String(id)}]};});
  assert.equal(copies,5);assert.equal(api.size(),2);assert.equal(a.destroyed,false);assert.deepEqual(a.writes,b.writes);
  assert.deepEqual(a.writes.map(s=>JSON.parse(s.split('data: ')[1]).revision),[1,2,3,4,5]);
  console.log('PASS normal backpressure preserves ordered single-message snapshots for both outputs');
}
{
  const api=harness(),counts=[],good=client(),slow=client({writableLength:1024*1024+1});let cleaned=0;
  api.setBridge({onSubscribersChanged:n=>counts.push(n)});api.add(slow,()=>cleaned++);api.add(good);
  api.publish('scene',{revision:1,messages:[]});
  assert.equal(slow.destroyed,true);assert.equal(slow.writes.length,0);assert.equal(cleaned,1);assert.equal(api.size(),1);
  assert.equal(good.writes.length,1);assert.equal(counts.at(-1),1);api.remove(good);assert.equal(counts.at(-1),0);
  console.log('PASS an output exceeding the byte limit disconnects without blocking another viewer');
}
{
  const api=harness(),counts=[];api.setBridge({onSubscribersChanged:n=>counts.push(n)});
  for(const candidate of [client({write(){this.writableLength=1024*1024+1;return false;}}),client({write(){throw Error('closed');}}),client({writableEnded:true})]){
    let cleaned=0;api.add(candidate,()=>cleaned++);assert.equal(api.write(candidate,'scene'),false);
    assert.equal(candidate.destroyed,true);assert.equal(cleaned,1);assert.equal(api.size(),0);assert.equal(counts.at(-1),0);
  }
  console.log('PASS write failure and post-write overflow release viewer resources and deactivate playback');
}
