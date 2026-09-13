// Runtime capability test. Synthetic capture by default. --real-capture opens
// the real mic briefly for settings only: no recording, playback, or network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const realCapture = process.argv.includes('--real-capture');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cove-echo-test-')));
if (!realCapture) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const watchdog = setTimeout(() => { console.error('AEC test timed out'); app.exit(1); }, 35_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => done(wc === win.webContents && permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === win.webContents && permission === 'media');
  async function inject(name, file) {
    const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    await win.webContents.executeJavaScript(`(() => {
      const exports = {}, require = () => window.devices;
      ${compiled}
      window[${JSON.stringify(name)}] = exports;
    })()`);
  }
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/audio-host.html'));
    await inject('devices', 'audioDevices.ts');
    await inject('echo', 'microphoneEcho.ts');
    const result = await win.webContents.executeJavaScript(`(async () => {
      const checks = [];
      for (const noiseMode of ['system', 'rnnoise']) {
        const raw = await window.echo.requestEchoCancelledMicrophone('default', noiseMode);
        try {
          const track = raw.getAudioTracks()[0];
          const settings = track.getSettings();
          if (settings.echoCancellation !== 'all') throw Error('Full-system AEC was not selected: ' + settings.echoCancellation);
          if (noiseMode === 'rnnoise' && settings.noiseSuppression !== false) throw Error('Double noise suppression');
          checks.push({ noiseMode, echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl,
            sampleRate: settings.sampleRate, warning: window.echo.microphoneEchoWarning(raw) });
        } finally { raw.getTracks().forEach((track) => track.stop()); }
      }
      return checks;
    })()`);
    console.log('AEC capability: PASS', JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, realCapture, checks: result }, null, 2));
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error('AEC capability: FAIL', error);
    clearTimeout(watchdog);
    app.exit(1);
  }
});
