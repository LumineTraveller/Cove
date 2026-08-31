const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const artifacts = path.resolve(__dirname, '../../..', 'tmp/login-memory-check');
fs.mkdirSync(artifacts, { recursive: true });
app.commandLine.appendSwitch('user-data-dir', path.join(artifacts, 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async predicate => { for (let i=0;i<100;i++){try{if(await predicate())return;}catch{}await delay(80);}throw new Error('Login UI timed out'); };
  const clickText = async text => {
    await js(`(() => {const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!b)throw new Error('Button not found');b.click();})()`);
    await delay(200);
  };
  const switchServer = async () => { await js('document.querySelector("[aria-label=打开个人名片]").click()');await clickText('切换服务器（保留登录）');await waitFor(()=>js('!!document.querySelector("#login-password")')); };
  const connect = async name => {
    await clickText(`https://${name}.test`);
    await waitFor(()=>js(`!document.querySelector('#login-password') && document.querySelector('[aria-label=打开个人名片]')?.textContent.includes('${name==='a'?'Alice':'Bob'}')`));
    assert.equal(await js('localStorage.getItem("cove_server_url")'), `https://${name}.test`);
    assert.equal(await js('JSON.parse(localStorage.getItem("cove_account_session")).token'), `test-${name}`);
  };
  try {
    await win.loadURL('http://127.0.0.1:5180/tests/ui/login-memory.html');
    await waitFor(()=>js('!!document.querySelector("#login-password")'));
    assert.equal(await js('document.querySelector("#login-password").value'), '');
    fs.writeFileSync(path.join(artifacts,'remembered-servers.png'),(await win.webContents.capturePage()).toPNG());
    await connect('a'); await switchServer(); await connect('b'); await switchServer(); await connect('a');
    await js('document.querySelector("[aria-label=打开个人名片]").click()'); await clickText('退出账号');
    await waitFor(()=>js('!!document.querySelector("#login-password")'));
    assert.equal(await js('document.querySelector("#login-email").value'),'a@test.com');
    assert.equal(await js('JSON.parse(localStorage.getItem("cove_remembered_logins")).find(e=>e.serverUrl==="https://a.test").token'),undefined);
    await js('sessionStorage.setItem("expired-server","https://b.test")'); await clickText('https://b.test');
    await waitFor(()=>js('!!document.querySelector("#login-password") && !JSON.parse(localStorage.getItem("cove_remembered_logins")).find(e=>e.serverUrl==="https://b.test").token'));
    assert.equal(await js('document.querySelector("#login-email").value'),'b@test.com');
    console.log('PASS: A/B/A one-click session restore, remembered server/account fields, no password replay, explicit logout and expired-token cleanup.');
    clearTimeout(timeout);win.destroy();app.exit(0);
  }catch(error){console.error(error);clearTimeout(timeout);win.destroy();app.exit(1);}
});
