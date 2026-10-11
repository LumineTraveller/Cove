const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { AccountPasswordStore } = require('../../dist-electron/account-password-store');
const { registerAccountPasswordIpc } = require('../../dist-electron/account-password-ipc');
const artifacts = path.resolve(process.env.COVE_PASSWORD_QA_ARTIFACTS || 'runtime/account-password-memory');
fs.mkdirSync(artifacts, { recursive: true });
const profile = path.join(artifacts, 'synthetic-electron-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const server = 'http://127.0.0.1:3317', alice = 'alice@example.test', bob = 'bob@example.test';
const original = 'fictional-alice-password', changed = 'fictional-alice-new-password';
const checks = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(2), 60000);
app.whenReady().then(async () => {
  const file = path.join(app.getPath('userData'), 'account-passwords.v1.json');
  const store = new AccountPasswordStore(file, safeStorage);
  const win = new BrowserWindow({ width: 1280, height: 800, frame: false, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.resolve(__dirname, '../../dist-electron/preload.js') } });
  win.webContents.on('console-message', (_event, level, message) => { if(level>=2) console.error('renderer:', message); });
  registerAccountPasswordIpc(ipcMain, store, event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  // The password bridge is the unmodified product preload; other features are irrelevant to this fixture.
  for (const channel of ['cove:window:is-maximized', 'cove:update:get-state', 'cove:update:check'])
    ipcMain.handle(channel, () => channel.includes('update') ? { status: 'idle' } : false);
  ipcMain.handle('cove:security:set-server-certificate-exception', () => undefined);
  ipcMain.handle('cove:security:resolve-server-addresses', () => []);
  const js = source => win.webContents.executeJavaScript(source, true);
  const wait = async source => { for (let i = 0; i < 200; i++) { if (await js(source).catch(error => { throw new Error(`UI expression failed: ${source}: ${error}`); })) return; await delay(25); } throw new Error('UI wait failed: ' + source); };
  const check = async (source, label) => { const passed = Boolean(await js(source)); checks.push({ label, passed }); assert.equal(passed, true, label); };
  const click = async selector => {
    const point = await js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});const r=element.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===element};})()`);
    assert.equal(point.hit, true, 'pointer target is visible and unobstructed');
    win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
    await delay(75);
  };
  const input = async (id, value) => { await js(`(()=>{const input=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`); await delay(50); };
  const select = async email => {
    await js(`if(!document.querySelector('.auth-history-dropdown'))document.querySelector('[aria-label="打开服务器历史"]').click()`);
    await wait(`!!document.querySelector('.auth-history-main')`);
    await js(`[...document.querySelectorAll('.auth-history-main')].find(b=>b.textContent.includes(${JSON.stringify(email)})).click()`);
    await wait(`document.querySelector('#login-email')?.value===${JSON.stringify(email)}`);
  };
  try {
    assert.equal(store.status().available, true, 'Windows OS encryption available');
    assert.equal(store.set(server, alice, original).ok, true);
    assert.equal(store.set(server, bob, 'fictional-bob-password').ok, true);
    assert.equal(readOwnStoreHasPlaintext(), false);
    checks.push({ label: 'real Windows safeStorage encrypts and decrypts fictional credentials without plaintext in the dedicated file', passed: true });
    await win.loadURL(process.env.COVE_PASSWORD_QA_URL || 'http://127.0.0.1:55176/tests/ui/account-password-memory-qa.html');
    await wait(`!!document.querySelector('#login-email') && !document.querySelector('[aria-label="记住账号密码"]').disabled`);
    await wait(`document.querySelector('#login-password')?.value===${JSON.stringify(original)}`);
    await wait(`!!document.querySelector('#login-server-password')`);
    await check(`document.querySelector('[aria-label="记住账号密码"]').checked && document.querySelector('#login-server-password').value===''`, 'initial remembered scope restores without opening history and leaves server password empty');
    for (const [width,height] of [[1280,800],[1100,600]]) {
      win.setSize(width,height); await delay(150);
      await check(`(()=>{const r=document.querySelector('.auth-password-memory').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && document.querySelector('.auth-page').clientHeight<=innerHeight && document.documentElement.scrollHeight<=innerHeight;})()`, `memory entry is visible and login page owns scrolling at ${width}x${height}`);
      await click('[aria-label="记住账号密码"]');
      await check(`!document.querySelector('[aria-label="记住账号密码"]').checked`, `native pointer can toggle memory at ${width}x${height}`);
      await click('[aria-label="记住账号密码"]');
      fs.writeFileSync(path.join(artifacts, `desktop-memory-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
    }
    // Pointer unchecking removed the cipher; reseed before the restoration checks.
    store.set(server, alice, original);
    win.webContents.sendInputEvent({type:'mouseWheel',x:850,y:450,deltaY:-600,deltaX:0});
    await delay(200);
    await check(`document.querySelector('.auth-page').scrollTop>0`, 'native wheel scrolls the constrained login page');
    await js(`document.querySelector('.auth-page').scrollTop=0`);
    await input('login-email', 'unsaved@example.test');
    await delay(250);
    await check(`document.querySelector('#login-password').value==='' && !document.querySelector('[aria-label="记住账号密码"]').checked && !document.querySelector('[aria-label="记住账号密码"]').disabled`, 'new account remains opt-in and has no inherited password');
    await select(alice); await wait(`document.querySelector('#login-password')?.value===${JSON.stringify(original)}`);
    await wait(`!!document.querySelector('#login-server-password')`);
    await check(`document.querySelector('#login-server-password').value==='' && document.querySelector('[aria-label="记住账号密码"]').checked`, 'history fills account password while server password stays empty');
    await input('login-server-password', 'fictional-server-password');
    await select(bob); await wait(`document.querySelector('#login-password')?.value==='fictional-bob-password'`);
    await check(`document.querySelector('#login-server-password').value===''`, 'switching accounts clears the server password');
    await select(alice); await wait(`document.querySelector('#login-password')?.value===${JSON.stringify(original)}`);
    await input('login-password', 'fictional-wrong-password'); await input('login-server-password', 'fictional-server-password');
    await js(`document.querySelector('form').requestSubmit()`); await wait(`document.querySelector('[role="alert"]')?.textContent.includes('邮箱或密码错误')`);
    assert.equal(store.get(server, alice).password, original);
    checks.push({ label: 'failed actual product login preserves the saved correct credential', passed: true });
    await input('login-password', changed); await js(`document.querySelector('form').requestSubmit()`);
    for (let i = 0; i < 200 && store.get(server, alice).password !== changed; i++) await delay(25);
    assert.equal(store.get(server, alice).password, changed);
    checks.push({ label: 'successful actual product login updates only the explicitly remembered account credential', passed: true });
    await wait(`!!document.querySelector('#login-email') && !document.querySelector('[aria-label="记住账号密码"]').disabled`);
    await check(`![...Array(localStorage.length)].some((_,i)=>localStorage.getItem(localStorage.key(i)).includes(${JSON.stringify(changed)}))`, 'product localStorage contains no account password');
    await select(alice); await wait(`document.querySelector('#login-password')?.value===${JSON.stringify(changed)}`);
    await js(`document.querySelector('[aria-label="记住账号密码"]').click()`);
    for (let i = 0; i < 200 && store.get(server, alice).password !== null; i++) await delay(25);
    assert.equal(store.get(server, alice).password, null);
    assert.equal(store.get(server, bob).password, 'fictional-bob-password');
    checks.push({ label: 'cancel deletes one remembered credential without affecting another account', passed: true });
    await select(bob); await wait(`document.querySelector('#login-password')?.value==='fictional-bob-password'`);
    await js(`document.querySelector('[aria-label="打开服务器历史"]').click()`); await wait(`!!document.querySelector('.auth-forget')`);
    await js(`[...document.querySelectorAll('.auth-forget')].find(b=>b.getAttribute('aria-label').endsWith(${JSON.stringify(bob)})).click()`);
    for (let i = 0; i < 200 && store.get(server, bob).password !== null; i++) await delay(25);
    assert.equal(store.get(server, bob).password, null);
    await check(`JSON.parse(localStorage.getItem('cove_remembered_logins')).length===1 && document.querySelector('#login-password').value===''`, 'forget deletes the selected credential/history and clears its filled password');
    store.set(server, alice, original);
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='清除已记住密码').click()`);
    for (let i = 0; i < 200 && fs.existsSync(file); i++) await delay(25);
    assert.equal(fs.existsSync(file), false);
    await check(`JSON.parse(localStorage.getItem('cove_remembered_logins')).length===1`, 'clear all deletes ciphertext while keeping account history');
    await wait(`document.querySelector('[role="status"]')?.textContent.includes('已清除记住的账号密码') && !document.querySelector('[aria-label="记住账号密码"]').checked && document.querySelector('#login-password').value===''`);
    // Delay real native results to exercise edits and account changes while IPC is in flight.
    let readDelay = 0, removeDelay = 0, reads = 0;
    for (const channel of ['cove:account-password:get', 'cove:account-password:remove', 'cove:account-password:status']) ipcMain.removeHandler(channel);
    const trusted = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
    ipcMain.handle('cove:account-password:get', async (event, url, email) => {
      assert.equal(trusted(event), true); reads += 1;
      const result = store.get(url, email), pause = readDelay;
      await delay(pause); return result;
    });
    ipcMain.handle('cove:account-password:remove', async (event, url, email) => {
      assert.equal(trusted(event), true); const pause = removeDelay;
      await delay(pause); return store.remove(url, email);
    });
    ipcMain.handle('cove:account-password:status', async event => {
      assert.equal(trusted(event), true); await delay(700); return { available: false, ok: false };
    });
    store.set(server, alice, original); store.set(server, bob, 'fictional-bob-password');
    await win.loadURL(process.env.COVE_PASSWORD_QA_URL || 'http://127.0.0.1:55176/tests/ui/account-password-memory-qa.html');
    await wait(`document.querySelector('#login-password')?.value===${JSON.stringify(original)}`);
    await delay(750);
    await check(`!document.querySelector('[aria-label="记住账号密码"]').disabled && !document.querySelector('.auth-password-memory-notice')`, 'late failed status cannot overwrite a newer successful password read');
    readDelay = 400;
    await input('login-email', 'unsaved@example.test');
    const beforeRead = reads;
    await input('login-email', alice);
    for(let i=0; i<100 && reads===beforeRead; i++) await delay(10);
    assert.ok(reads>beforeRead, 'delayed Alice read started');
    await input('login-password', 'fictional-manually-typed-password'); await delay(450);
    await check(`document.querySelector('#login-password').value==='fictional-manually-typed-password' && !document.querySelector('[aria-label="记住账号密码"]').disabled`, 'slow read preserves a manually typed password while enabling safe memory');
    await input('login-email', 'unsaved@example.test');
    await input('login-email', alice); await delay(200);
    await select(bob); await wait(`document.querySelector('#login-password')?.value==='fictional-bob-password'`); await delay(450);
    await check(`document.querySelector('#login-email').value===${JSON.stringify(bob)} && document.querySelector('#login-password').value==='fictional-bob-password'`, 'switching accounts rejects the stale Alice read');
    await select(alice); await wait(`document.querySelector('#login-password')?.value===${JSON.stringify(original)}`);
    removeDelay = 400;
    await js(`document.querySelector('.auth-history-button').click()`); await wait(`!!document.querySelector('.auth-forget')`);
    await js(`[...document.querySelectorAll('.auth-forget')].find(b=>b.getAttribute('aria-label').endsWith(${JSON.stringify(alice)})).click()`);
    await check(`document.querySelector('#login-password').value==='' && !document.querySelector('[aria-label="记住账号密码"]').checked`, 'forget immediately clears the selected password and memory before native deletion completes');
    await select(bob); await wait(`document.querySelector('#login-password')?.value==='fictional-bob-password'`); await delay(450);
    await check(`document.querySelector('#login-email').value===${JSON.stringify(bob)} && document.querySelector('#login-password').value==='fictional-bob-password' && document.querySelector('[aria-label="记住账号密码"]').checked`, 'finishing Alice deletion does not clear the newly selected Bob account');
    await input('login-email', 'unsaved@example.test');
    await input('login-email', bob); await delay(200);
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='清除已记住密码').click()`); await delay(450);
    await check(`document.querySelector('#login-password').value==='' && !document.querySelector('[aria-label="记住账号密码"]').checked`, 'clear cancels an already-issued password read');
    await js(`if(document.querySelector('.auth-history-dropdown'))document.querySelector('.auth-history-button').click()`);
    await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await delay(150);
    await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(artifacts, 'desktop-synthetic-login.png'), image.toPNG()));
    fs.writeFileSync(path.join(artifacts, 'desktop-ui.json'), JSON.stringify({ passed: true, platform: process.platform, actualProductRenderer: true, actualProductPreload: true, checks }, null, 2));
    console.log(`PASS ${checks.length} actual desktop password memory checks`); clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) {
    const messages = await js(`Array.from(document.querySelectorAll('[role="alert"],[role="status"]')).map(e=>e.textContent)`).catch(() => []);
    fs.writeFileSync(path.join(artifacts, 'desktop-ui.json'), JSON.stringify({ passed: false, checks, error: String(error), messages }, null, 2));
    console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1);
  }
  function readOwnStoreHasPlaintext() { const content = fs.readFileSync(file, 'utf8'); return content.includes(original) || content.includes(alice); }
});
