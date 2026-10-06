import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function configFixture(existing?: object) {
  const writes: object[] = [];
  let current = existing;
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const sandbox: any = {
    exports: {}, __dirname: '/fixture/dist-electron', console,
    process: { platform: 'win32', env: { COVE_DATA_DIR: '/fixture/data' }, on() {} },
    require: (name: string) => {
      if (name === 'electron') return {
        app: { requestSingleInstanceLock: () => true, setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {} },
        Menu: { buildFromTemplate: (items: unknown[]) => items }, shell: { openPath() {} },
      };
      if (name === 'fs') return {
        existsSync: (file: string) => file.endsWith('server-config.json') && current !== undefined,
        readFileSync: () => JSON.stringify(current), mkdirSync() {},
        writeFileSync: (_file: string, content: string) => { current = JSON.parse(content); writes.push(current!); },
      };
      if (name === 'os') return { homedir: () => '/fixture/home' };
      if (name === 'path') return path;
      throw new Error('Unexpected fixture import: ' + name);
    },
  };
  vm.runInNewContext(compiled + '\nglobalThis.fixtureMenu = buildMenu("127.0.0.1"); globalThis.fixtureRead = readConfig;', sandbox);
  return { sandbox, writes };
}

test('packaged new configuration enables the gate without setting any credentials', () => {
  const { sandbox, writes } = configFixture();
  sandbox.fixtureMenu.find((item: any) => item.label === '编辑配置文件').click();
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['mediasoupIp', 'mediasoupPort', 'serverSecurityEnabled']);
  assert.equal((writes[0] as any).serverSecurityEnabled, true);
  sandbox.fixtureRead();
  assert.equal(sandbox.process.env.COVE_SERVER_SECURITY_ENABLED, 'true');
});

test('packaged existing explicit false remains an opt-out and is not overwritten', () => {
  const { sandbox, writes } = configFixture({ serverSecurityEnabled: false });
  sandbox.fixtureRead();
  assert.equal(sandbox.process.env.COVE_SERVER_SECURITY_ENABLED, 'false');
  sandbox.fixtureMenu.find((item: any) => item.label === '编辑配置文件').click();
  assert.equal(writes.length, 0);
});
