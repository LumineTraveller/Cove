const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const base = { status: 'idle', version: '2.0.2', platform: 'win32', arch: 'x64' };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Controlled hooks exercise the real component and effects without a browser,
// Electron, network, installer, user profile, or visible window.
function createHarness(options = {}) {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const listeners = new Set();
  const calls = { checks: 0, downloads: 0, cancels: 0, launches: 0, releases: 0 };
  const api = {
    state: { ...base },
    async getState() { return options.initial ? options.initial.promise : this.state; },
    async checkNow(...args) { assert.equal(args.length, 0); calls.checks++; return options.check ? options.check.promise : this.state; },
    async downloadRepair(...args) { assert.equal(args.length, 0); calls.downloads++; return this.state; },
    async cancel(...args) { assert.equal(args.length, 0); calls.cancels++; return options.cancel ? options.cancel.promise : { ...this.state, status: 'idle' }; },
    async launchRepair(...args) { assert.equal(args.length, 0); calls.launches++; return false; },
    async openRelease(...args) { assert.equal(args.length, 0); calls.releases++; return true; },
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
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
    useEffect(fn, deps) {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) {
        const previous = hooks[index];
        hooks[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); });
      }
    },
  };
  const context = { window: options.noBridge ? {} : { coveIntegrity: api }, console };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
  const { InstallationIntegrityPanel } = load(path.resolve(__dirname, '../src/features/integrity/components/InstallationIntegrityPanel.tsx'));
  const helpers = load(path.resolve(__dirname, '../src/features/integrity/integrityView.ts'));
  return {
    api, calls, listeners, helpers,
    render() { cursor = 0; const tree = InstallationIntegrityPanel(); return { tree, html: renderToStaticMarkup(tree) }; },
    async flush() { const pending = effects; effects = []; pending.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); },
    emit(state) { api.state = { ...base, ...state }; for (const listener of listeners) listener(api.state); },
    dispose() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function findButton(tree, label) {
  if (!tree || typeof tree !== 'object') return null;
  const children = React.Children.toArray(tree.props?.children);
  if (tree.type === 'button' && children.some(child => typeof child === 'string' && child.includes(label))) return tree;
  for (const child of children) { const found = findButton(child, label); if (found) return found; }
  return null;
}

test('integrity panel renders every contract state, scope, accessible progress, and bounded relative issue details', async () => {
  const h = createHarness();
  try {
    h.render(); await h.flush();
    const states = ['idle', 'checking', 'healthy', 'damaged', 'unavailable', 'downloading', 'downloaded', 'confirming', 'launching', 'error', 'disabled'];
    for (const status of states) {
      h.emit({ status, checkedFiles: 5, totalFiles: 10, checkedAt: 1_728_000_000_000, repairAvailable: true,
        progress: { transferred: 10, total: 20, percent: 50 } });
      const view = h.render();
      assert.ok(view.html.includes(h.helpers.integrityTitle(status)), status);
      assert.match(view.html, /aria-live="polite"/);
      assert.match(view.html, /不检查账户、设置、聊天记录或语音包/);
      if (['checking', 'downloading'].includes(status)) {
        assert.match(view.html, /role="progressbar"/);
        assert.match(view.html, /aria-valuenow="50"/);
        assert.equal(findButton(view.tree, '检查中')?.props.disabled ?? findButton(view.tree, '检查安装文件').props.disabled, true);
      }
      if (status === 'unavailable') assert.doesNotMatch(view.html, /发现安装文件异常/);
      if (status === 'healthy') assert.doesNotMatch(view.html, /防病毒|所有功能完全/);
    }
    const kinds = ['missing', 'modified', 'unreadable', 'unsafe'];
    h.emit({ status: 'damaged', issueCount: 123, issues: Array.from({ length: 24 }, (_, index) => ({
      kind: kinds[index % kinds.length], path: index === 0 ? 'C:\\Users\\private\\file' : `resources/${'long/'.repeat(20)}file-${index}.bin`,
    })) });
    const view = h.render();
    for (const label of ['缺失', '内容不一致', '无法读取', '路径异常']) assert.match(view.html, new RegExp(label));
    assert.match(view.html, /异常总数为 123 项/);
    assert.equal((view.html.match(/<li>/g) ?? []).length, 20);
    assert.doesNotMatch(view.html, /Users|private|file-20/);
    assert.match(view.html, /路径不可显示/);
    assert.deepEqual(h.calls, { checks: 0, downloads: 0, cancels: 0, launches: 0, releases: 0 });
  } finally { h.dispose(); }
});

test('getState cannot overwrite a newer event and unmount removes the listener', async () => {
  const initial = deferred();
  const h = createHarness({ initial });
  h.render(); await h.flush();
  assert.equal(h.listeners.size, 1);
  h.emit({ status: 'damaged' });
  initial.resolve({ ...base, status: 'healthy' }); await h.flush();
  assert.match(h.render().html, /发现安装文件异常/);
  h.dispose();
  assert.equal(h.listeners.size, 0);
});

test('repair launch happens only on explicit click and native cancellation preserves the ready action', async () => {
  const h = createHarness();
  try {
    h.render(); await h.flush();
    h.emit({ status: 'downloaded', repairAvailable: true });
    const ready = h.render();
    assert.equal(h.calls.launches, 0);
    assert.match(ready.html, /先保存工作/);
    assert.match(ready.html, /中断通话和屏幕共享/);
    assert.match(ready.html, /Windows 安全提示/);
    findButton(ready.tree, '退出并修复').props.onClick(); await h.flush();
    assert.equal(h.calls.launches, 1);
    assert.equal(findButton(h.render().tree, '退出并修复').props.disabled, false);
    findButton(h.render().tree, '打开官方版本页').props.onClick(); await h.flush();
    assert.equal(h.calls.releases, 1);
  } finally { h.dispose(); }
});

test('check/download are mutually exclusive before an event arrives; active work remains cancellable', async () => {
  const check = deferred();
  const cancellation = deferred();
  const h = createHarness({ check, cancel: cancellation });
  try {
    h.render(); await h.flush();
    h.emit({ status: 'damaged', repairAvailable: true });
    const view = h.render();
    findButton(view.tree, '检查安装文件').props.onClick();
    findButton(view.tree, '下载同版本').props.onClick();
    assert.equal(h.calls.checks, 1);
    assert.equal(h.calls.downloads, 0);
    h.emit({ status: 'checking', checkedFiles: 1, totalFiles: 10 });
    findButton(h.render().tree, '取消').props.onClick(); await h.flush();
    assert.equal(h.calls.cancels, 1);
    h.emit({ status: 'unavailable', message: '网络连接失败' });
    check.resolve({ ...base, status: 'healthy' }); await h.flush();
    assert.match(h.render().html, /网络连接失败/);
    assert.equal(findButton(h.render().tree, '检查安装文件').props.disabled, true, 'pending cancellation retains the action lock after a terminal event');
    findButton(h.render().tree, '检查安装文件').props.onClick();
    assert.equal(h.calls.checks, 1, 'a pending cancellation cannot race with a new check');
    cancellation.resolve({ ...base }); await h.flush();
    assert.equal(findButton(h.render().tree, '检查安装文件').props.disabled, false);
  } finally { h.dispose(); }
});

test('missing bridge disables operations and malformed relative paths are withheld', async () => {
  const h = createHarness({ noBridge: true });
  try {
    h.render(); await h.flush();
    const view = h.render();
    assert.match(view.html, /当前环境不支持检查/);
    assert.equal(findButton(view.tree, '检查安装文件').props.disabled, true);
    for (const value of ['../file', '/root/file', '\\\\server\\share', 'file:///secret', 'C:secret', ' C:\\Users\\private', 'a\nfile', 'a//file']) {
      assert.equal(h.helpers.integrityRelativePath(value), '（路径不可显示）');
    }
    assert.equal(h.helpers.integrityRelativePath('resources\\app.asar'), 'resources/app.asar');
  } finally { h.dispose(); }
});
