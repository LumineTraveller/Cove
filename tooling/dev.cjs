const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const children = [];
const env = {...process.env,
  COVE_DATA_DIR:process.env.COVE_DATA_DIR || path.join(root,'runtime','server'),
  COVE_DOWNLOAD_DIR:process.env.COVE_DOWNLOAD_DIR || path.join(root,'runtime','downloads'),
  COVE_HTTP_PORT:process.env.COVE_HTTP_PORT || '3301',
  MEDIASOUP_PORT:process.env.MEDIASOUP_PORT || '41000',MEDIASOUP_IP:process.env.MEDIASOUP_IP || '127.0.0.1',
  COVE_DESKTOP_DATA_DIR:process.env.COVE_DESKTOP_DATA_DIR || path.join(root,'runtime','desktop'),
  COVE_DEV_RENDERER_URL:process.env.COVE_DEV_RENDERER_URL || 'http://127.0.0.1:55173',
  VITE_SERVER_URL:process.env.VITE_SERVER_URL || 'http://127.0.0.1:3301',
  VITE_COVE_DEFAULT_SERVER:process.env.VITE_COVE_DEFAULT_SERVER || process.env.VITE_SERVER_URL || 'http://127.0.0.1:3301',
};
for (const key of ['COVE_DATA_DIR', 'COVE_DOWNLOAD_DIR', 'COVE_DESKTOP_DATA_DIR']) fs.mkdirSync(env[key], {recursive:true});
function run(app, command, parameters=[], {windowsHide=true}={}){
  const cwd=path.join(root,'apps',app);
  const child=spawn(command,parameters,{cwd,env,stdio:'inherit',windowsHide,detached:process.platform!=='win32'});
  children.push(child);child.on('error',error=>{console.error(error);shutdown(1);});
  child.on('exit',code=>{if(!stopping)shutdown(code ?? 1);});
  return child;
}
let stopping=false;
function shutdown(code=0){
  if(stopping)return;stopping=true;
  for(const child of children){
    if(!child.pid||child.exitCode!==null)continue;
    // Stop only descendants of the processes this launcher created. Never
    // enumerate/terminate by port or by application name.
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else{try{process.kill(-child.pid,'SIGTERM');}catch{}}
  }
  process.exitCode=code;
}
process.on('SIGINT',()=>shutdown());process.on('SIGTERM',()=>shutdown());
if(!args.has('--client'))run('server',process.execPath,[require.resolve('tsx/cli'),'watch','src/index.ts']);
if(!args.has('--server'))run('desktop',process.execPath,[path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js')]);
if(args.has('--electron')){
  const cwd=path.join(root,'apps/desktop');
  for(const script of ['electron/build-remote-input.cjs','electron/build-application-audio.cjs','electron/build-annotation-window.cjs']){
    const result=spawnSync(process.execPath,[script],{cwd,env,stdio:'inherit',windowsHide:true});
    if(result.status!==0){shutdown(result.status||1);break;}
  }
  if(!stopping){
    const result=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','electron/tsconfig.json'],{cwd,env,stdio:'inherit',windowsHide:true});
    if(result.status!==0)shutdown(result.status||1);
    // Background helpers stay hidden, but Electron is the interactive app.
    // On Windows, hiding its process also hides its BrowserWindow.
    else run('desktop',createRequire(path.join(cwd,'package.json'))('electron'),['.'],{windowsHide:false});
  }
}
