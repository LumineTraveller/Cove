// Hidden/offscreen Electron 44, fresh test profile and fictional requests only.
// No dev server, app window, real credential store, socket, or external service.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const workspace = path.resolve(__dirname, '../../../..');
const build = path.resolve(process.env.COVE_LOGIN_QA_BUILD || path.join(workspace, 'runtime/login-email-fixture'));
const resultFile = path.join(workspace, 'runtime/login-email-result.json');
const profile = fs.mkdtempSync(path.join(workspace, 'runtime/login-email-profile-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = { passed: false, runtime: {}, flows: [], requestCount: 0, blockedNetworkCount: 0, rendererErrorCount: 0, ignoredDecorativeAssetCount: 0 };
let win;
let statusBaseline = 0;
const js = code => win.webContents.executeJavaScript(code, true);
const wait = async (code, timeout = 6000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await js(code)) return;
    await delay(20);
  }
  throw Error('Timed out waiting for offline login assertion');
};
const snapshot = () => js('window.loginEmailQa.snapshot()');
const assert = (value, message) => { if (!value) throw Error(message); };
const countStatus = state => state.calls.filter(call => call.kind === 'status').length;
const input = async (id, value) => {
  await js(`(() => {
    const field=document.getElementById(${JSON.stringify(id)});
    if(!field)throw new Error('Missing offline login input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await delay(30);
};
const select = async email => {
  await js(`(() => {
    const history=document.querySelector('.auth-history-button');
    if(history?.getAttribute('aria-expanded')!=='true')history.click();
  })()`);
  await wait('document.querySelectorAll(".auth-history-main").length===2');
  await js(`(() => {
    const row=[...document.querySelectorAll('.auth-history-main')].find(node=>node.textContent.includes(${JSON.stringify(email)}));
    if(!row)throw new Error('Missing fictional remembered account');
    row.click();
  })()`);
};
const open = async scenario => {
  win?.destroy();
  win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  win.webContents.on('console-message', (_event, level, message, _line, sourceId) => {
    const detail = typeof level === 'object' ? level : { level, message, sourceId };
    if (detail.level !== 3 && detail.level !== 'error') return;
    // This behavior fixture deliberately omits the large decorative login video.
    // Only its precise missing file error is ignored; App/runtime errors remain failures.
    if (/cove-login-loop\.mp4/.test(`${detail.sourceId ?? ''} ${detail.message ?? ''}`)
      && /ERR_FILE_NOT_FOUND/.test(detail.message ?? '')) results.ignoredDecorativeAssetCount += 1;
    else results.rendererErrorCount += 1;
  });
  win.webContents.on('render-process-gone', () => { results.rendererErrorCount += 1; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
    results.blockedNetworkCount += 1;
    callback({ cancel: true });
  });
  const url = pathToFileURL(path.join(build, 'tests/ui/login-email-fixture.html'));
  url.searchParams.set('case', scenario);
  await win.loadURL(url.href);
  await wait('window.loginEmailQa?.ready && document.querySelector("#login-email")');
};
const finishFlow = async name => {
  const state = await snapshot();
  assert(state.violations.length === 0, 'Unexpected mock request');
  results.requestCount += state.calls.length;
  results.flows.push({ name, passed: true, statusRequests: countStatus(state) });
  console.log(`PASS ${name}; status requests: ${countStatus(state)}`);
};
const withFlow = async (name, run) => {
  try { await run(); await finishFlow(name); }
  catch (error) {
    results.flows.push({ name, passed: false, error: String(error.message || error) });
    console.error(`FAIL ${name}: ${error.message || error}`);
  }
};
const timeout = setTimeout(() => { fs.writeFileSync(resultFile, JSON.stringify(results, null, 2)); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  results.runtime = { electron: process.versions.electron, chrome: process.versions.chrome };
  try {
    await withFlow('continuous-email-preserves-server-password-and-status-count', async () => {
      await open('typing');
      await wait('!!document.querySelector("#login-server-password")');
      await input('login-server-password', 'fictional-manual-server-password');
      statusBaseline = countStatus(await snapshot());
      await js('document.querySelector("#login-email").focus()');
      for (const character of 'new@qa.test') {
        win.webContents.sendInputEvent({ type: 'char', keyCode: character });
        await delay(340); // Deliberately cross the old 150/300ms debounce windows.
        const state = await snapshot();
        assert(state.serverPassword === 'fictional-manual-server-password', 'Email typing cleared the server password');
        assert(countStatus(state) === statusBaseline, 'Email typing caused another server status request');
      }
      assert((await snapshot()).email === 'new@qa.test', 'Native characters did not reach the controlled email input');
      await input('login-email', 'saved@example.test');
      await wait('document.querySelector("#login-password")?.value==="fictional-filled-account-password"');
      await wait('!!document.querySelector("#login-server-password")');
      const filled = await snapshot();
      assert(filled.serverPassword === 'fictional-manual-server-password', 'Asynchronous account password fill changed the server password');
      assert(countStatus(filled) <= statusBaseline + 1, 'Asynchronous account password fill caused repeated status requests');
    });

    await withFlow('equivalent-url-preserves-input-real-url-clears-it', async () => {
      await open('url');
      await wait('!!document.querySelector("#login-server-password")');
      await input('login-server-password', 'fictional-url-server-password');
      const before = countStatus(await snapshot());
      await input('login-server', ' HTTPS://LOGIN-A.EXAMPLE.TEST:443/ ');
      await delay(650);
      let state = await snapshot();
      assert(state.serverPassword === 'fictional-url-server-password', 'Equivalent normalized URL cleared the password');
      assert(countStatus(state) === before, 'Equivalent normalized URL caused a status request');
      await input('login-server', 'https://login-b.example.test/tenant');
      await wait('window.loginEmailQa.snapshot().calls.some(call=>call.kind==="status"&&call.server.includes("login-b")) && !!document.querySelector("#login-server-password")');
      state = await snapshot();
      assert(state.serverPassword === '', 'Changed server retained the old server password');
      assert(countStatus(state) === before + 1, 'Changed server did not perform exactly one new status request');
    });

    await withFlow('email-edit-before-initial-probe-still-reaches-ready', async () => {
      await open('early-email');
      assert(countStatus(await snapshot()) === 0, 'Initial probe ran before the early-edit scenario was established');
      await input('login-email', 'early@example.test');
      await wait('!!document.querySelector("#login-server-password")');
      const state = await snapshot();
      assert(state.email === 'early@example.test', 'Initial probe changed the edited email');
      assert(countStatus(state) === 1, 'Initial probe failed or repeated after early email edit');
    });

    await withFlow('remembered-same-server-switch-preserves-manual-server-password', async () => {
      await open('account-input');
      await wait('!!document.querySelector("#login-server-password") && document.querySelector("#login-password")?.value==="fictional-alice-account-password"');
      await input('login-server-password', 'fictional-shared-server-input');
      await select('bob@example.test');
      await wait('document.querySelector("#login-password")?.value==="fictional-bob-account-password"');
      await delay(650);
      const state = await snapshot();
      assert(state.email === 'bob@example.test' && state.serverPassword === 'fictional-shared-server-input', 'Same-server account switch cleared the manual server password');
      assert(state.token === null, 'Account switch reused an unrelated server grant');
      assert(state.calls.some(call => call.kind === 'grant-get' && call.email === 'bob@example.test'), 'Selected account grant lookup used the wrong scope');
    });

    await withFlow('remembered-account-a-b-a-restores-isolated-scopes', async () => {
      await open('accounts');
      await wait('window.loginEmailQa.snapshot().token==="fictional-grant-alice" && document.querySelector("#login-password")?.value==="fictional-alice-account-password"');
      for (const [email, name] of [['bob@example.test', 'bob'], ['alice@example.test', 'alice']]) {
        await select(email);
        await wait(`window.loginEmailQa.snapshot().token===${JSON.stringify('fictional-grant-' + name)} && document.querySelector('#login-password')?.value===${JSON.stringify('fictional-' + name + '-account-password')} && window.loginEmailQa.snapshot().calls.some(call=>call.kind==='status'&&call.token===${JSON.stringify('fictional-grant-' + name)})`);
        const state = await snapshot();
        assert(state.email === email, 'Remembered account selection changed the wrong account');
        assert(state.calls.some(call => call.kind === 'grant-get' && call.email === email), 'Selected account grant was not scoped to its email');
        assert(state.calls.some(call => call.kind === 'status' && call.token === 'fictional-grant-' + name), 'Selected account did not verify its own restored grant');
      }
      const beforeEquivalent = await snapshot();
      const passwordReads = beforeEquivalent.calls.filter(call => call.kind === 'password-get').length;
      const statusReads = countStatus(beforeEquivalent);
      await input('login-server', ' HTTPS://LOGIN-A.EXAMPLE.TEST:443/ ');
      await delay(650);
      const equivalent = await snapshot();
      assert(equivalent.accountPassword === beforeEquivalent.accountPassword, 'Equivalent URL changed the remembered account password');
      assert(equivalent.calls.filter(call => call.kind === 'password-get').length === passwordReads, 'Equivalent URL retriggered the account password read');
      assert(countStatus(equivalent) === statusReads, 'Equivalent URL indirectly retriggered a server status request');
    });

    await withFlow('late-account-password-and-grant-get-cannot-replace-new-selection', async () => {
      await open('old-get');
      await wait('window.loginEmailQa.snapshot().held.some(item=>item.kind==="grant-get") && window.loginEmailQa.snapshot().held.some(item=>item.kind==="password-get")');
      await select('bob@example.test');
      await wait('document.querySelector("#login-password")?.value==="fictional-bob-account-password"');
      await js('window.loginEmailQa.release("password-get"); window.loginEmailQa.release("grant-get")');
      await wait('window.loginEmailQa.snapshot().token==="fictional-grant-bob" && window.loginEmailQa.snapshot().calls.some(call=>call.kind==="status"&&call.token==="fictional-grant-bob")');
      await delay(200);
      const state = await snapshot();
      assert(state.email === 'bob@example.test' && state.accountPassword === 'fictional-bob-account-password', 'Late account password read overwrote the new selection');
      assert(!state.calls.some(call => call.kind === 'status' && call.token === 'fictional-grant-alice'), 'Late previous-account grant reached a status request after switching');
    });

    await withFlow('late-old-server-probe-does-not-clear-new-input', async () => {
      await open('old-probe');
      await wait('window.loginEmailQa.snapshot().held.some(item=>item.kind==="status")');
      await input('login-server', 'https://login-b.example.test/tenant');
      await wait('window.loginEmailQa.snapshot().calls.some(call=>call.kind==="status"&&call.server.includes("login-b")) && !!document.querySelector("#login-server-password")');
      await input('login-server-password', 'fictional-new-server-input');
      const before = countStatus(await snapshot());
      await js('window.loginEmailQa.release("status")');
      await delay(400);
      const state = await snapshot();
      assert(state.serverPassword === 'fictional-new-server-input', 'Late probe cleared the newer server input');
      assert(state.server.includes('login-b') && countStatus(state) === before, 'Late probe retriggered or changed the new server scope');
    });

    await withFlow('late-native-restore-cannot-overwrite-newly-authorized-grant', async () => {
      await open('old-restore');
      await wait('window.loginEmailQa.snapshot().held.some(item=>item.kind==="grant-get")');
      await js('window.loginEmailQa.installNewGrant(); window.loginEmailQa.release("grant-get")');
      await wait('window.loginEmailQa.snapshot().calls.some(call=>call.kind==="status")');
      await delay(200);
      const state = await snapshot();
      assert(state.token === 'fictional-grant-new-status', 'Late native restore overwrote a newly authorized grant');
      assert(!state.calls.some(call => call.kind === 'status' && call.token === 'fictional-grant-alice'), 'Late native restore replayed its obsolete grant');
    });

    await withFlow('late-expiry-status-body-does-not-revoke-new-grant', async () => {
      await open('expiry');
      await wait('!!document.querySelector("#login-server-password")');
      await input('login-server-password', 'fictional-new-auth-input');
      await js('window.loginEmailQa.startOldStatusBody()');
      await wait('window.loginEmailQa.snapshot().held.some(item=>item.kind==="status-body")');
      await js('window.loginEmailQa.installNewGrant(); window.loginEmailQa.release("status-body")');
      await js('window.loginEmailQa.finishOldStatus()');
      const state = await snapshot();
      assert(state.staleStatusResult === 'AbortError', 'Obsolete expiry response was accepted');
      assert(state.token === 'fictional-grant-new-status', 'Obsolete expiry response revoked the newer grant');
      assert(state.serverPassword === 'fictional-new-auth-input', 'Obsolete expiry response cleared newer form input');
    });

    results.passed = results.flows.length === 9 && results.flows.every(flow => flow.passed)
      && results.rendererErrorCount === 0 && results.blockedNetworkCount === 0;
  } catch (error) { results.error = String(error.message || error); }
  finally {
    clearTimeout(timeout);
    win?.destroy();
    fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
    console.log(`${results.passed ? 'PASS' : 'FAIL'} offline real-App login: ${results.flows.filter(flow => flow.passed).length}/${results.flows.length} flows`);
    app.exit(results.passed ? 0 : 1);
  }
});
