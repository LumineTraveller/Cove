const test=require('node:test'), assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'), Module=require('node:module');
const displays=[{id:1,bounds:{x:0,y:0,width:1707,height:1067}},
  {id:2,bounds:{x:-1280,y:-100,width:1280,height:800}}];
const screen=Object.assign(new EventEmitter(),{getAllDisplays:()=>displays});
const shortcuts=new Map();
const globalShortcut={register:(key,callback)=>{if(shortcuts.has(key))return false;shortcuts.set(key,callback);return true;},unregister:key=>shortcuts.delete(key)};
class Window extends EventEmitter {
  constructor(){super();this.webContents=Object.assign(new EventEmitter(),{send:()=>{},setWindowOpenHandler:()=>{}});this.destroyed=false;}
  isDestroyed(){return this.destroyed;}setContentProtection(value){this.protected=value;}
  setIgnoreMouseEvents(value){this.transparent=value;}setAlwaysOnTop(){}setFocusable(value){this.focusable=value;}
  setBounds(value){this.bounds=value;}show(){this.visible=true;}showInactive(){this.visible=true;}hide(){this.visible=false;}
  isFocused(){return Boolean(this.focused);}focus(){this.focused=true;}
  loadFile(){queueMicrotask(()=>this.webContents.emit('did-finish-load'));return Promise.resolve();}
  destroy(){this.destroyed=true;this.emit('closed');}
}
const electron={BrowserWindow:Window,screen,globalShortcut,app:{isPackaged:false}};
const original=Module._load;
Module._load=function(name,...args){return name==='electron'?electron:original.call(this,name,...args);};
const {AnnotationOverlayController}=require('../dist-electron/annotation-overlay');
Module._load=original;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const frame={strokes:[{id:'s',authorSocketId:'owner',tool:'pen',color:'#ffffff',width:.01,points:[{x:.2,y:.2}]}],lasers:[]};
function bound(failure,input){const c=new AnnotationOverlayController(failure,input);c.setCaptureSource({id:'screen:2:0',display_id:'2'});const b=c.bind('p');assert.ok(b.token,b.error);return [c,b.token];}
test('selected secondary display uses DIP bounds and stale input cannot affect replacement',async()=>{
  const received=[];const [c,token]=bound(undefined,(token,input)=>received.push({token,input}));
  assert.equal(c.update(token,frame),true);await flush();assert.deepEqual(c.win.bounds,displays[1].bounds);
  assert.equal(c.win.transparent,true);assert.equal(c.setInputActive(token,true),true);
  assert.equal(c.win.transparent,false);assert.equal(c.win.focusable,true);
  assert.equal(c.handleInput({},token,{type:'clear'}),false);
  assert.equal(c.handleInput(c.win.webContents,'old',{type:'clear'}),false);
  assert.equal(c.handleInput(c.win.webContents,token,{type:'clear'}),true);assert.equal(received.length,1);
  const old=c.win;const next=c.bind('q').token;assert.equal(old.destroyed,true);assert.equal(shortcuts.size,0);
  assert.equal(c.setInputActive(token,true),false);c.close(token);assert.equal(c.update(next,frame),true);c.close();
});
test('emergency callback, blur, renderer crash and display loss restore pass-through',async()=>{
  const failures=[];const inputs=[];const [c,token]=bound((_token,reason)=>failures.push(reason),(_token,input)=>inputs.push(input));
  c.update(token,frame);await flush();const win=c.win;
  c.setInputActive(token,true);shortcuts.get('Control+Alt+Shift+A')();
  assert.equal(win.transparent,true);assert.equal(win.focusable,false);assert.equal(shortcuts.size,0);assert.equal(inputs.at(-1).type,'exit');
  c.setInputActive(token,true);win.emit('blur');assert.equal(win.transparent,true);assert.equal(shortcuts.size,0);
  c.setInputActive(token,true);win.webContents.emit('render-process-gone');assert.equal(win.destroyed,true);assert.equal(shortcuts.size,0);
  assert.equal(c.setInputActive(token,true),false);assert.equal(failures.length,1);c.close();
  const [second,key]=bound((_token,reason)=>failures.push(reason));second.update(key,frame);await flush();second.setInputActive(key,true);
  const removed=displays.pop();screen.emit('display-removed');assert.equal(second.win,null);assert.equal(shortcuts.size,0);displays.push(removed);second.close();
});
test('shortcut collision refuses input and does not unregister another owner shortcut',()=>{
  const errors=[];shortcuts.set('Control+Alt+Shift+A',()=>{});const [c,key]=bound((_token,reason)=>errors.push(reason));
  assert.equal(c.setInputActive(key,true),false);assert.equal(c.win,null);assert.equal(c.inputActive,false);assert.equal(errors.length,1);
  c.close();assert.equal(shortcuts.has('Control+Alt+Shift+A'),true);shortcuts.clear();
});
