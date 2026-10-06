const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Run the real view and its effects with a controlled updater. No Electron,
// network, installer, login or user's screen is involved.
function createViewHarness() {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const listeners = new Set();
  const opened = [];
  const updater = {
    checks: 0, installs: 0, state: { status: 'idle' },
    async checkNow() { this.checks++; return this.state; },
    async getState() { return this.state; },
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async installNow() { this.installs++; return true; },
  };
  const changed = (a, b) => !a || a.length !== b.length || a.some((x, i) => x !== b[i]);
  const controlledReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) {
        const previous = hooks[index];
        hooks[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); });
      }
    },
  };
  const win = new EventTarget();
  win.coveUpdater = updater;
  win.coveShell = { async openExternal(url) { opened.push(url); return true; } };
  win.setInterval = () => 1;
  win.clearInterval = () => {};
  const context = { window: win, document: new EventTarget(), Event, URL, Date,
    setInterval: () => 1, clearInterval() {}, console };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    modules.set(filename, module);
    const compiled = ts.transpileModule(source, {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const localRequire = id => {
      if (id === 'react') return controlledReact;
      if (id.endsWith('.css')) return {};
      if (!id.startsWith('.')) return require(id);
      const resolved = path.resolve(path.dirname(filename), id);
      if (id.endsWith('.json')) return require(resolved);
      return load(fs.existsSync(`${resolved}.ts`) ? `${resolved}.ts` : `${resolved}.tsx`);
    };
    vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  const { UpdateCenter } = load(path.resolve(__dirname, '../src/features/updates/components/UpdateCenter.tsx'));
  return {
    updater, opened,
    render(props) { cursor = 0; const tree = UpdateCenter(props); return { tree, html: tree ? renderToStaticMarkup(tree) : '' }; },
    async flush() { const pending = effects; effects = []; pending.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); },
    emit(state) { updater.state = state; for (const listener of listeners) listener(state); },
    dispose() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function findButton(tree, text) {
  if (!tree || typeof tree !== 'object') return null;
  const children = React.Children.toArray(tree.props?.children);
  if (tree.type === 'button' && children.some(child => typeof child === 'string' && child.includes(text))) return tree;
  for (const child of children) { const match = findButton(child, text); if (match) return match; }
  return null;
}

const requirement = { serverURL: 'https://server.test', minimumClientVersion: '3.0.0',
  downloadUrl: 'https://updates.test/downloads/Cove-Setup.exe' };

test('the real update view starts one check, cannot dismiss a gate, and retains retry/download actions after failure', async () => {
  const h = createViewHarness();
  try {
    h.render({ requiredUpgrade: requirement }); await h.flush();
    assert.equal(h.updater.checks, 1);
    h.render({ requiredUpgrade: { ...requirement } }); await h.flush();
    assert.equal(h.updater.checks, 1, 'equivalent repeated requirements do not restart discovery');
    h.emit({ status: 'error', failedStage: 'downloading', message: '下载失败', errorDetail: 'offline' });
    const view = h.render({ requiredUpgrade: requirement, allowDetails: false }); await h.flush();
    assert.match(view.html, /服务器要求 Cove 3\.0\.0/);
    assert.match(view.html, /下载失败/);
    assert.match(view.html, /登录记录已保留/);
    assert.doesNotMatch(view.html, /aria-label="关闭更新提示"/);
    findButton(view.tree, '检查更新').props.onClick(); await h.flush();
    assert.equal(h.updater.checks, 2);
    findButton(view.tree, '正式下载入口').props.onClick(); await h.flush();
    assert.deepEqual(h.opened, [requirement.downloadUrl]);
    assert.equal(h.updater.installs, 0);
  } finally { h.dispose(); }
});

test('the real view keeps transfer and finalization distinct and installs only a sufficient downloaded release on user action', async () => {
  const h = createViewHarness();
  try {
    h.render({ requiredUpgrade: requirement }); await h.flush();
    for (const state of [
      { status: 'downloading', version: '3.0.0', percent: 40 },
      { status: 'finalizing', version: '3.0.0', percent: 100 },
      { status: 'downloaded', version: '2.5.0', percent: 100 },
    ]) {
      h.emit(state);
      const view = h.render({ requiredUpgrade: requirement }); await h.flush();
      assert.equal(findButton(view.tree, '重启并更新'), null);
    }
    h.emit({ status: 'downloaded', version: '3.0.0', percent: 100 });
    const ready = h.render({ requiredUpgrade: requirement }); await h.flush();
    assert.equal(h.updater.installs, 0, 'download completion does not force quit');
    findButton(ready.tree, '重启并更新').props.onClick(); await h.flush();
    assert.equal(h.updater.installs, 1);
  } finally { h.dispose(); }
});

test('a manual retry rechecks server policy; the first automatic download check is immediate', async () => {
  const h = createViewHarness();
  let retries = 0;
  const props = { requiredUpgrade: requirement, onRetryVersion: async () => { retries++; } };
  try {
    h.render(props); await h.flush();
    assert.equal(retries, 0);
    const view = h.render(props);
    findButton(view.tree, '检查更新').props.onClick(); await h.flush();
    assert.equal(retries, 1);
    assert.equal(h.updater.checks, 2);
  } finally { h.dispose(); }
});
