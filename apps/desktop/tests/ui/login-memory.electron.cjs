const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const artifacts = path.resolve(__dirname, '../../..', 'tmp/login-memory-check');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(artifacts, 'profile-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message));
  const js = code => win.webContents.executeJavaScript(`Promise.resolve().then(()=>eval(${JSON.stringify(code)})).catch(error=>{throw new Error(error.stack||String(error))})`);
  const waitFor = async predicate => { for (let i=0;i<100;i++){try{if(await predicate())return;}catch{}await delay(80);}throw new Error('Login UI timed out'); };
  const clickText = async text => {
    await js(`(() => {const buttons=[...document.querySelectorAll('button')];const b=buttons.find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!b)throw new Error('Button not found: '+${JSON.stringify(text)}+'; rendered: '+buttons.map(e=>e.textContent).join('|'));b.click();})()`);
    await delay(200);
  };
  const chooseServer = async name => {
    await js('(()=>{const button=document.querySelector("[aria-label=打开服务器历史]");if(button?.getAttribute("aria-expanded")!=="true")button.click();})()');
    await clickText(`https://${name}.test`);
  };
  // The captured working-copy baseline fills a login form from history; it
  // does not submit remembered accounts automatically. Preserve that flow.
  const select = async name => {
    await chooseServer(name);
    assert.equal(await js('document.querySelector("#login-server").value'), `https://${name}.test`);
    assert.equal(await js('document.querySelector("#login-email").value'), `${name}@test.com`);
    assert.equal(await js('document.querySelector("#login-password").value'), '');
    assert.equal(await js('Boolean(document.querySelector("#auth-server-history"))'), false);
    assert.equal(await js('localStorage.getItem("cove_account_session")'), null);
  };
  try {
    await win.loadURL('http://127.0.0.1:55173/tests/ui/login-memory.html');
    await waitFor(()=>js('!!document.querySelector("#login-password")'));
    assert.equal(await js('document.querySelector("#login-password").value'), '');
    fs.writeFileSync(path.join(artifacts,'remembered-servers.png'),(await win.webContents.capturePage()).toPNG());
    await select('a'); await select('b'); await select('a');
    await js('document.querySelector("[aria-label=打开服务器历史]").click()');
    await js(`document.querySelector('[aria-label="忘记 https://b.test"]').click()`);
    await delay(200);
    const history=await js('JSON.parse(localStorage.getItem("cove_remembered_logins"))');
    assert.equal(history.length,1);assert.equal(history[0].serverUrl,'https://a.test');assert.equal(history[0].token,'test-a');
    console.log('PASS: current history dropdown, A/B/A form selection, no password replay or implicit login, and isolated history removal.');
    clearTimeout(timeout);win.destroy();app.exit(0);
  }catch(error){console.error(error);console.error(await js('document.body.innerText'));fs.writeFileSync(path.join(artifacts,'failure.png'),(await win.webContents.capturePage()).toPNG());clearTimeout(timeout);win.destroy();app.exit(1);}
});
