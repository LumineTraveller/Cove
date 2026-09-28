import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../electron/application-audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const player = { id: 'process:42:639262120640121021', name: '网易云音乐', processId: 42, processName: 'cloudmusic' };

function harness({ platform = 'win32', packaged = false, result = JSON.stringify([player]), failure = null as Error | null } = {}) {
  const calls: { executable: string; args: string[]; options: any }[] = [];
  const module = { exports: {} as typeof import('../electron/application-audio') };
  vm.runInNewContext(compiled, {
    exports: module.exports, __dirname: '/app/dist-electron',
    require: (id: string) => {
      if (id === 'electron') return { app: { isPackaged: packaged } }; // No desktopCapturer.
      if (id === 'node:path') return path.posix;
      if (id === 'util') return { promisify: (fn: unknown) => fn };
      if (id === 'child_process') return { execFile: async (executable: string, args: string[], options: any) => {
        calls.push({ executable, args: Array.from(args), options });
        if (failure) throw failure;
        return { stdout: result, stderr: '' };
      } };
      throw new Error(`Unexpected dependency ${id}`);
    },
    process: { platform, pid: 99, resourcesPath: '/resources' }, console,
  });
  return { api: module.exports, calls };
}

test('background/minimized player discovery does not require an Electron window', async () => {
  const h = harness();
  const sources = await h.api.listApplicationAudioSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, player.id);
  assert.equal(sources[0].name, '网易云音乐');
  assert.equal(h.calls[0].executable, '/app/build/application-audio-helper.exe');
  assert.deepEqual(h.calls[0].args, ['list', '99']);
  assert.equal(h.calls[0].options.windowsHide, true);
});

test('capture revalidates process identity, not a fresh window/audio-session list', async () => {
  const h = harness({ result: JSON.stringify(player) });
  assert.equal((await h.api.resolveApplicationAudioSource(player.id))?.processId, 42);
  assert.deepEqual(h.calls.map(call => call.args), [['resolve', '99', player.id]]);
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf('"cove:application-audio:start"'), main.indexOf('"cove:application-audio:stop"'));
  assert.match(handler, /resolveApplicationAudioSource\(sourceId\)/);
  assert.doesNotMatch(handler, /listApplicationAudioSources/);
});

test('closed processes and reused PIDs cannot start another application', async () => {
  assert.equal(await harness({ result: 'null' }).api.resolveApplicationAudioSource(player.id), null);
  const replaced = { ...player, id: 'process:42:639262120640121099' };
  assert.equal(await harness({ result: JSON.stringify(replaced) }).api.resolveApplicationAudioSource(player.id), null);
});

test('invalid IDs are rejected without executing the helper', async () => {
  const h = harness();
  for (const id of ['window:123:0', 'process:0:123', 'process:42:0', 'process:42:123;evil', '']) {
    assert.equal(await h.api.resolveApplicationAudioSource(id), null);
  }
  assert.equal(h.calls.length, 0);
});

test('deduplicate processes, exclude Cove, and ignore malformed helper records', async () => {
  const h = harness({ result: JSON.stringify([
    player, player, { ...player, id: 'process:99:123', processId: 99 },
    { ...player, processId: 43 }, { ...player, id: 'window:42:0' }, null,
  ]) });
  assert.equal((await h.api.listApplicationAudioSources()).length, 1);
  assert.equal(await harness({ result: JSON.stringify({ ...player, id: 'process:99:123', processId: 99 }) })
    .api.resolveApplicationAudioSource('process:99:123'), null);
});

test('packaged app uses the bundled native helper and keeps UTF-8 names and icons', async () => {
  const h = harness({ packaged: true, result: '\uFEFF' + JSON.stringify([{ ...player, iconDataUrl: 'data:image/png;base64,YQ==' }]) });
  assert.equal((await h.api.listApplicationAudioSources())[0].iconDataUrl, 'data:image/png;base64,YQ==');
  assert.equal(h.calls[0].executable, '/resources/application-audio-helper.exe');
  const config = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(config.build.win.extraResources.some((resource: any) => resource.to === 'application-audio-helper.exe'));
  assert.match(config.scripts['electron:compile'], /application-audio:build/);
});

test('helper failures are surfaced instead of masquerading as an empty application list', async () => {
  await assert.rejects(harness({ failure: new Error('helper failed') }).api.listApplicationAudioSources(), /helper failed/);
  await assert.rejects(harness({ result: '{}' }).api.listApplicationAudioSources(), /响应无效/);
});

test('unsupported platforms do not launch a Windows helper', async () => {
  const h = harness({ platform: 'linux' });
  assert.equal((await h.api.listApplicationAudioSources()).length, 0);
  assert.equal(await h.api.resolveApplicationAudioSource(player.id), null);
  assert.equal(h.calls.length, 0);
});
