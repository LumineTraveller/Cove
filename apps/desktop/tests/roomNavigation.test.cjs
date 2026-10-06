const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const postcss = require('postcss');

// Exercise the actual view without starting the application's socket singleton.
// Its only service dependency formats avatar URLs; the runtime UI fixture tests
// the real service and browser layout separately.
const filename = path.resolve(__dirname, '../src/features/rooms/components/NavigationRailV2.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const viewModule = { exports: {} };
const icons = Object.fromEntries(['ArrowRight', 'CaretLeft', 'DoorOpen', 'GearSix', 'Plus'].map((name) => [
  name, () => React.createElement('svg', { 'data-icon': name }),
]));
vm.runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename })(
  (id) => {
    if (id === '../appearance') return { resolveRoomAvatarUrl: (url) => url };
    if (id === '@phosphor-icons/react') return icons;
    return require(id);
  },
  viewModule,
  viewModule.exports,
);
const { NavigationRailV2 } = viewModule.exports;
const rooms = [
  { id: 'owner', name: '自己的频道', count: 2, ownerName: '我', isOwner: true },
  { id: 'peer', name: '另一个频道', count: 0, ownerName: '同事', isOwner: false },
];
const render = (expanded, overrides = {}) => renderToStaticMarkup(React.createElement(NavigationRailV2, {
  rooms, activeRoom: 'owner', profileName: '我', expanded,
  onRoom() {}, setExpanded() {}, onSettings() {}, onRoomSettings() {}, onCreate() {},
  ...overrides,
}));
const button = (html, label) => {
  const match = [...html.matchAll(/<button\b[^>]*>/g)].find(([tag]) => tag.includes(`aria-label="${label}"`));
  assert.ok(match, `Expected button ${label}`);
  return match[0];
};
const tree = (html) => [...html.matchAll(/<\/?([a-z][\w-]*)\b/g)].map(([tag]) => tag);

test('narrow and expanded rails retain the same content tree through repeated toggles', () => {
  const expected = tree(render(false));
  for (const expanded of [true, false, true, false, true]) {
    const html = render(expanded);
    assert.deepEqual(tree(html), expected, 'expansion must not mount or remove brand, labels or owner actions');
    assert.match(html, /class="brand-name"[^>]*>Cove<\/span>/);
    assert.equal((html.match(/class="room-nav-copy"/g) || []).length, rooms.length);
  }
});

test('collapsed rail retains accessible primary actions and excludes invisible secondary controls', () => {
  const narrow = render(false);
  assert.match(button(narrow, '展开频道栏'), /aria-expanded="false"/);
  assert.match(button(narrow, '展开频道栏'), /aria-controls="[^"]+"/);
  for (const label of ['收回频道栏', '自己的频道 设置']) {
    const tag = button(narrow, label);
    assert.match(tag, /aria-hidden="true"/);
    assert.match(tag, /tabindex="-1"/);
    assert.match(tag, /disabled=""/);
  }
  for (const label of ['进入频道 自己的频道', '进入频道 另一个频道', '新建频道', '设置']) {
    const tag = button(narrow, label);
    assert.doesNotMatch(tag, /disabled|tabindex="-1"|aria-hidden="true"/);
  }
});

test('expanded owner actions are keyboard accessible and never granted to another room', () => {
  const expanded = render(true);
  for (const label of ['收回频道栏', '自己的频道 设置']) {
    const tag = button(expanded, label);
    assert.match(tag, /aria-hidden="false"/);
    assert.match(tag, /tabindex="0"/);
    assert.doesNotMatch(tag, /disabled/);
  }
  assert.doesNotMatch(expanded, /aria-label="另一个频道 设置"/);
  assert.doesNotMatch(render(true, { showCollapse: false }), /aria-label="收回频道栏"/);
});

test('rapid room changes keep current room and ownership controlled by the latest props', () => {
  for (const [activeRoom, expanded] of [['peer', true], ['owner', false], ['peer', false], ['owner', true]]) {
    const html = render(expanded, { activeRoom });
    const activeName = rooms.find((room) => room.id === activeRoom).name;
    assert.match(html, new RegExp(`class="room-nav-item active[^\"]*"[^>]*data-room-name="${activeName}"`));
    assert.equal((html.match(/class="room-nav-item active/g) || []).length, 1);
  }
  const changed = render(true, { rooms: rooms.map((room) => ({ ...room, isOwner: false })) });
  assert.doesNotMatch(changed, /room-settings-toggle/);
});

const css = postcss.parse(fs.readFileSync(path.resolve(__dirname, '../src/styles/ui-v2.css'), 'utf8'));
const declaration = (selector, property) => {
  let value;
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) rule.walkDecls(property, (decl) => { value = decl.value; });
  });
  return value;
};

test('rail text clips inside its own viewport and keeps the original action alignment', () => {
  const rail = '.cove-shell > .navigation-rail';
  assert.equal(declaration(`${rail} .room-nav-copy-clip`, 'overflow'), 'hidden');
  assert.notEqual(declaration(`${rail} .room-switch`, 'overflow'), 'hidden', 'avatar count badge must remain unclipped');
  assert.equal(declaration(`${rail} .room-nav-copy`, 'position'), 'absolute');
  assert.match(declaration(`${rail} .room-nav-copy`, 'width'), /^\d+px$/, 'fixed text geometry during width transition');
  assert.equal(declaration(`${rail} .nav-action-label`, 'text-align'), 'left');
});

test('reduced motion removes rail transitions including label reveal delays', () => {
  let matched = false;
  css.walkAtRules('media', (rule) => {
    if (rule.params !== '(prefers-reduced-motion: reduce)') return;
    rule.walkRules((child) => {
      if (!child.selectors.includes('.cove-shell > .navigation-rail *')) return;
      child.walkDecls('transition', (decl) => {
        matched = decl.value === 'none' && decl.important === true;
      });
    });
  });
  assert.equal(matched, true);
});

test('bottom settings icon moves with rail padding and switches atomically at share boundaries', () => {
  const icon = '.cove-shell > .navigation-rail .global-settings-button .nav-action-icon';
  assert.equal(declaration(icon, 'transition'), 'left 320ms var(--ease-layout)');
  assert.equal(declaration('.navigation-rail.narrow .global-settings-button .nav-action-icon', 'left'), '15px');
  assert.equal(declaration('.navigation-rail.expanded .nav-action-icon', 'left'), '13px');
  assert.equal(declaration('.cove-shell:not(.layout-controls-animated) > .navigation-rail .global-settings-button .nav-action-icon', 'transition'), 'none');
});
