'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');

function harness(nativeSupported=true,initiallyLoading=false){
  const windows=[],notifications=[],trays=[];
  const app=new EventEmitter();Object.assign(app,{requestSingleInstanceLock:()=>true,whenReady:()=>({then:()=>({catch(){}})}),getVersion:()=> 'test'});
  class Window extends EventEmitter{
    constructor(options){super();windows.push(this);this.options=options;this.resizable=options.resizable;this.resizableChanges=[];this.bounds={x:options.x||0,y:options.y||0,width:options.width,height:options.height};this.visible=false;this.minimized=false;this.destroyed=false;this.focused=false;this.ignoreMouse=false;this.loading=initiallyLoading;this.restores=0;
      this.webContents=new EventEmitter();Object.assign(this.webContents,{isLoadingMainFrame:()=>this.loading,isDestroyed:()=>this.destroyed,executeJavaScript:async()=>({width:this.bounds.width,height:this.bounds.height}),setWindowOpenHandler(){},send(){}});}
    isDestroyed(){return this.destroyed} isVisible(){return this.visible} isMinimized(){return this.minimized} isMaximized(){return false}
    getBounds(){return this.bounds} setBounds(b){this.bounds={...this.bounds,...b}} setContentSize(width,height){this.bounds={...this.bounds,width,height}}
    show(){const changed=!this.visible;this.visible=true;if(changed)this.emit('show')} showInactive(){this.show()} focus(){this.focused=true} moveTop(){} restore(){this.restores++;this.minimized=false;this.visible=true;this.emit('restore')}
    finishLoading(){this.loading=false;this.emit('ready-to-show')}
    destroy(){this.destroyed=true;this.visible=false;this.emit('closed')} setMenuBarVisibility(){} setAlwaysOnTop(){} setResizable(value){this.resizable=value;this.resizableChanges.push(value)} hookWindowMessage(){} loadURL(){}
    setIgnoreMouseEvents(value){this.ignoreMouse=value}
  }
  class Notification extends EventEmitter{
    static isSupported(){return nativeSupported}
    constructor(options){super();this.options=options;this.closed=false;notifications.push(this)} show(){this.shown=true} close(){this.closed=true}
  }
  class Tray extends EventEmitter{constructor(){super();trays.push(this)}isDestroyed(){return false}setToolTip(){}setContextMenu(){}displayBalloon(options){this.balloon=options}removeBalloon(){this.balloon=null}destroy(){} }
  const handlers=new Map(),ipcMain={handle:(name,handler)=>handlers.set(name,handler),on(){}};
  const screen={getAllDisplays:()=>[{workArea:{x:0,y:0,width:1920,height:1080}}],getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}})};
  const mainPath=path.join(__dirname,'../desktop/main.js'),localRequire=createRequire(mainPath);let timer=0;
  const context={require:id=>id==='electron'?{app,BrowserWindow:Window,Notification,Tray,screen,ipcMain,Menu:{buildFromTemplate:v=>v}}:localRequire(id),__dirname:path.dirname(mainPath),process:{platform:'win32'},console,setTimeout:()=>++timer,clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(mainPath,'utf8')+`
    globalThis.testSc={
      init(){appState={settings:themes.migrateSettings({theme:'glass',previewEnabled:false}),requestedPreviewSize:{width:515,height:650},previewSize:{width:515,height:650},overlayBounds:{x:80,y:90,width:515,height:650}};clickThrough=true;roomConnectionRequested=true;initializeScAlerts();bindIpc();},
      receive:receiveLiveMessage,update:updateSceneMessage,clear:clearScene,open:openScPreview,setPreviewEnabled,
      state:()=>appState,scene:sceneSnapshot,expiry:()=>scExpiry.getState(),window:()=>overlayWindow,clickThrough:()=>clickThrough,
      lock(value){appState.settings.overlaySizeLocked=value;setOverlayResizableForSettings();},
      dispose(){scAlerts.dispose();}
    };
  `,context,{filename:mainPath});
  context.testSc.init();return{api:context.testSc,windows,notifications,trays,app,call:(name,sender,...args)=>handlers.get('desktop:'+name)({sender},...args)};
}
const sc=(text='测试 SC')=>({type:'sc',uname:'测试观众',text,valueYuan:50});
{
 const h=harness(true,true);h.api.lock(true);const message=h.api.receive(sc('通知中心延迟点击'));
 const notification=h.notifications[0];
 notification.emit('close',{reason:'timedOut'});notification.emit('close',{reason:'timedOut'});
 assert.equal(h.windows.length,0,'a hidden banner must not create a preview before the user clicks');
 notification.emit('click');
 const window=h.api.window();assert.ok(window,'notification-center activation creates the desktop output');
 assert.equal(h.windows.length,1);assert.equal(window.ignoreMouse,false);assert.equal(window.visible,false);
 window.finishLoading();assert.equal(window.visible,true);assert.equal(window.focused,true);
 assert.equal(h.api.state().settings.previewEnabled,true);assert.equal(h.api.state().settings.overlaySizeLocked,true);
 assert.ok(h.api.scene().messages.some(m=>m.id===message.id));
 notification.emit('click');assert.equal(h.windows.length,1,'activation is consumed once');
 h.api.dispose();console.log('PASS delayed notification-center click creates, reveals and focuses the desktop output after loading');
}
{
 const h=harness();h.api.receive(sc('已收进通知中心'));
 const notification=h.notifications[0];notification.emit('close',{reason:'timedOut'});
 h.api.clear();notification.emit('click');
 assert.equal(notification.closed,true);assert.equal(notification.eventNames().length,0);
 assert.equal(h.windows.length,0,'a cleared scene removes its notification-center action');
 h.api.dispose();console.log('PASS clearing a hidden banner removes its center action without recreating a desktop window');
}
{
 const h=harness();h.api.receive({type:'chat',text:'普通弹幕'});h.api.receive({type:'gift',text:'礼物'});
 assert.equal(h.notifications.length,0);assert.equal(h.windows.length,0);
 const first=h.api.receive(sc());assert.equal(h.notifications.length,1);assert.equal(h.windows.length,0,'SC receipt alone must not create a hidden preview renderer');
 assert.equal(h.notifications[0].shown,true);assert.match(h.notifications[0].options.body,/点击打开桌面窗口/);
 h.api.update(first.id,{text:'更新原SC'});assert.equal(h.notifications.length,1,'updating a scene card must not notify again');
 h.notifications[0].emit('click');
 assert.equal(h.api.state().settings.previewEnabled,true);assert.equal(h.windows.length,1);
 assert.equal(h.api.clickThrough(),false);assert.equal(h.api.window().ignoreMouse,false);assert.equal(h.api.window().visible,true);assert.equal(h.api.window().focused,true);
 assert.equal(h.api.scene().messages.some(m=>m.id===first.id),true,'opening does not remove paid content');
 h.api.receive(sc('预览已开'));assert.equal(h.notifications.length,1);
 h.api.setPreviewEnabled(false);assert.equal(h.api.window(),null);
 h.api.receive(sc('重新关闭后收到'));assert.equal(h.notifications.length,2);
 h.api.clear();assert.equal(h.notifications[1].closed,true);
 h.notifications[1].emit('click');assert.equal(h.api.window(),null,'old room notification cannot reopen a cleared preview');
 h.api.dispose();
 console.log('PASS actual main SC receipt, notification click, preview creation and mouse-unlock flow');
}
{
 const h=harness(false);h.api.receive(sc());
 assert.equal(h.windows.length,0);assert.equal(h.notifications.length,0);assert.equal(h.trays.length,1);
 assert.match(h.trays[0].balloon.title,/SC/);h.trays[0].emit('balloon-click');
 assert.equal(h.api.state().settings.previewEnabled,true);assert.equal(h.windows.length,1);assert.equal(h.api.clickThrough(),false);
 assert.equal(h.trays[0].listenerCount('balloon-click'),0);assert.equal(h.trays[0].balloon,null);
 h.api.dispose();console.log('PASS unavailable native notifications fall back to a clickable tray balloon');
}
{
 const h=harness();h.api.open();h.api.window().minimized=true;h.api.window().visible=false;h.api.window().bounds={x:4000,y:1400,width:515,height:650};
 h.api.receive(sc());assert.equal(h.notifications.length,1);h.notifications[0].emit('click');
 assert.equal(h.windows.length,1,'restoring reuses the existing preview');assert.equal(h.api.window().minimized,false);
 assert.equal(h.api.window().restores,1);assert.deepEqual(h.api.window().bounds,{x:1405,y:430,width:515,height:650},'restore precedes bounds recovery so a removed monitor cannot strand the SC window');
 h.app.isQuitting=true;assert.equal(h.api.open(),null);h.api.dispose();
 console.log('PASS minimized previews restore inside the screen without duplicate windows and shutdown rejects reopening');
}
{
 const h=harness(true,true);h.api.receive(sc('先提醒，再按需加载桌面'));
 h.notifications[0].emit('click');
 const window=h.api.window();assert.equal(h.windows.length,1);assert.equal(window.visible,false);assert.equal(window.focused,false);
 assert.equal(window.ignoreMouse,false);assert.equal(window.listenerCount('ready-to-show'),2,'normal readiness and the requested reveal each register once');
 h.api.receive(sc('窗口仍在加载时收到第二条 SC'));assert.equal(h.notifications.length,2);assert.equal(h.notifications[1].closed,false);
 window.finishLoading();
 assert.equal(window.visible,true);assert.equal(window.focused,true);assert.equal(window.listenerCount('ready-to-show'),0);
 assert.equal(h.notifications[1].closed,true,'the actual show event closes the alert issued during loading');
 assert.equal(h.notifications[1].eventNames().length,0);
 assert.equal(h.api.scene().messages.length,2,'readiness preserves both SC cards');
 h.api.receive(sc('现在窗口可见'));assert.equal(h.notifications.length,2);
 h.api.dispose();console.log('PASS notification click waits for loading and readiness reveals/focuses once while clearing interim alerts');
}
{
 const h=harness(true,true);h.api.setPreviewEnabled(true);
 assert.equal(h.api.window().visible,false);h.api.receive(sc('自动打开的窗口尚未就绪'));
 assert.equal(h.notifications.length,1);h.api.window().finishLoading();
 assert.equal(h.api.window().visible,true);assert.equal(h.notifications[0].closed,true,'automatic ready-to-show clears notifications without a notification click');
 assert.equal(h.api.window().focused,false,'automatic readiness retains the existing inactive-show behavior');
 h.api.dispose();console.log('PASS automatic preview readiness also clears alerts issued while its renderer was loading');
}
{
 const h=harness();h.api.open();const window=h.api.window();
 window.visible=false;h.api.receive(sc('窗口隐藏后收到'));assert.equal(h.notifications.length,1);
 window.show();assert.equal(h.notifications[0].closed,true,'manual show clears the pending alert');
 window.minimized=true;window.visible=false;h.api.receive(sc('窗口最小化后收到'));assert.equal(h.notifications.length,2);
 window.showInactive();assert.equal(h.notifications[1].closed,false,'a show event while still minimized must not mark the SC as visible');
 window.restore();assert.equal(h.notifications[1].closed,true,'restore clears the alert once visible and no longer minimized');
 h.api.setPreviewEnabled(false);h.api.receive(sc('旧窗口已销毁'));
 const pending=h.notifications.at(-1);window.visible=true;window.emit('show');window.emit('restore');
 assert.equal(pending.closed,false,'events from a replaced/destroyed window cannot clear a new alert');
 h.api.dispose();assert.equal(pending.closed,true);
 console.log('PASS manual show/restore clears alerts only for the current visible non-minimized preview');
}
{
 const h=harness();h.api.lock(true);h.api.open();const window=h.api.window();
 assert.equal(window.options.resizable,true,'a saved Windows size lock must not create a different native hit-test configuration');
 assert.equal(window.resizable,true);h.api.lock(false);h.api.lock(true);
 assert.deepEqual(window.resizableChanges,[true,true,true],'toggling size lock preserves the native SC/no-drag hit-test path');
 assert.equal(window.listenerCount('will-resize'),1,'lock toggles must not accumulate event handlers');
 const before={...window.bounds};let resizePrevented=false;
 window.emit('will-resize',{preventDefault(){resizePrevented=true;}},{...before,width:800},{edge:'right'});
 assert.equal(resizePrevented,true,'locked native edge dragging is vetoed before Windows applies its rectangle');
 const rejected=h.call('set-overlay-bounds',window.webContents,{...before,width:800});
 assert.equal(rejected.width,before.width);assert.deepEqual(window.bounds,before,'custom resize handles cannot bypass the size lock');
 let movePrevented=false;window.emit('will-move',{preventDefault(){movePrevented=true;}},{...before,x:200});
 assert.equal(movePrevented,false,'size lock must not veto ordinary native window movement');
 h.api.lock(false);resizePrevented=false;window.emit('will-resize',{preventDefault(){resizePrevented=true;}},{...before,width:800},{edge:'right'});
 assert.equal(resizePrevented,false,'unlocking restores manual resizing immediately');
 assert.equal(window.resizable,true);h.api.dispose();
 console.log('PASS Windows size lock keeps native hit testing stable while rejecting manual resizing and allowing movement');
}
{
 const h=harness();h.api.lock(true);const earlier=h.api.receive({type:'chat',text:'此前的弹幕'});
 const message=h.api.receive(sc('锁定尺寸仍可下架这条 SC'));
 h.notifications[0].emit('click');const window=h.api.window();
 assert.equal(h.api.state().settings.overlaySizeLocked,true,'opening an SC does not silently change the requested size lock');
 assert.equal(window.ignoreMouse,false);assert.equal(window.resizable,true);
 assert.equal(h.call('dismiss-sc',{},message.id),false,'other renderers cannot dismiss a paid card');
 assert.equal(h.api.scene().messages.some(item=>item.id===message.id),true);
 const original=h.api.scene().messages.find(item=>item.id===message.id);assert.equal(original.scPinned,true);assert.equal(h.api.expiry().size,1);
 const chat=h.api.receive({type:'chat',text:'普通弹幕'});
 assert.equal(h.call('dismiss-sc',window.webContents,chat.id),false);
 assert.equal(h.call('dismiss-sc',window.webContents,message.id),true,'the current desktop output can unpin SC while size locked');
 const archived=h.api.scene().messages.find(item=>item.id===message.id);assert.ok(archived,'manual swiping retains the paid card in ordinary history');
 assert.equal(archived.scPinned,false);
 assert.equal(h.api.expiry().size,0,'manual unpin removes the outstanding automatic expiry entry');
 for(const field of ['id','type','text','valueYuan','at','time','gapMs'])assert.equal(archived[field],original[field],field+' remains unchanged');
 assert.deepEqual(Array.from(h.api.scene().messages,item=>item.id),[earlier.id,message.id,chat.id],'the archived SC returns between the messages received before and after it');
 assert.equal(h.api.state().settings.overlaySizeLocked,true);assert.equal(h.call('dismiss-sc',window.webContents,message.id),false);
 const alertCount=h.notifications.length;h.api.update(message.id,{text:'下架后补充内容',valueYuan:100});
 assert.equal(h.api.scene().messages.find(item=>item.id===message.id).scPinned,false);
 assert.equal(h.api.expiry().size,0);assert.equal(h.notifications.length,alertCount,'updating an archived card cannot restart expiry or notify again');
 h.api.setPreviewEnabled(false);const next=h.api.receive(sc('输出关闭后收到下一条'));
 assert.equal(h.call('dismiss-sc',window.webContents,next.id),false,'a destroyed preview loses dismissal authority');
 h.api.dispose();console.log('PASS locked-size manual SC swiping unpins once into original history and enforces current-output IPC permission');
}
