// Electron exercises the real SoundPackPanel with native mouse input. The
// fixture only supplies deterministic account, HTTP and Socket.IO data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const build = path.resolve(process.env.COVE_UI_QA_BUILD || path.join(__dirname, '../../../../runtime/soundpack-groups-fixture'));
const artifacts = path.resolve(process.env.COVE_UI_QA_ARTIFACTS || path.join(__dirname, '../../../../runtime/soundpack-groups-ui'));
const url = process.env.COVE_UI_QA_URL || pathToFileURL(path.join(build, 'tests/ui/soundpack-groups-fixture.html')).href;
const width = Number(process.env.COVE_UI_QA_WIDTH || 1000);
const height = Number(process.env.COVE_UI_QA_HEIGHT || 800);
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
// Persistence deliberately closes the last window, then creates a fresh renderer.
app.on('window-all-closed', () => {});
const results = {
  passed: false,
  runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, width, height, url },
  checks: [], flows: {}, screenshots: [], rendererErrors: [],
  protocol: 'soundpack:reorder remains a flat {roomId, orderedIds} request with ACK and soundpack:reordered broadcast',
};
try { results.buildManifest = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json'), 'utf8')); } catch { /* Optional for dev-server runs. */ }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const wait = async (code, timeoutMs = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await js(code)) return; await delay(20); }
  throw Error('Timed out: ' + code);
};
const check = (condition, label, evidence) => {
  results.checks.push({ label, passed: Boolean(condition), ...(evidence === undefined ? {} : { evidence }) });
  if (!condition) throw Error(label);
};
const canonical = snapshot => snapshot.groups.map(({ id, soundIds }) => ({ id, soundIds }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flat = groups => groups.flatMap(group => group.soundIds);
const snapshot = id => js(`window.soundpackGroupsQa.snapshot(${JSON.stringify(id)})`);
const rect = selector => js(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`);
const cardSelector = id => `[data-soundpack-scroll] [data-soundpack-id="${id}"]`;
const cardRect = id => rect(cardSelector(id));
const center = r => ({ x: r.left + r.width * 0.35, y: r.top + r.height / 2 });
const input = (type, point, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), ...extra });
const move = async point => { input('mouseMove', point); await delay(40); };
const key = async keyCode => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(60);
};
const down = async selector => {
  const r = await rect(selector);
  if (!r) throw Error('Missing drag source ' + selector);
  const point = center(r);
  input('mouseMove', point);
  input('mouseDown', point, { button: 'left', clickCount: 1 });
  await delay(30);
  return point;
};
const lift = async (selector, target) => {
  const start = await down(selector);
  await move({ x: start.x + 8, y: start.y + 1 });
  await move(target);
  await wait('window.soundpackGroupsQa.snapshot().dragging');
};
const up = async point => {
  input('mouseUp', point, { button: 'left', clickCount: 1 });
  await wait('!window.soundpackGroupsQa.snapshot().dragging');
  await wait('!document.querySelector(".soundpack-item-overlay,.soundpack-group-drag-line,[data-soundpack-settling]")');
  await delay(40);
};
const motionState = () => js(`(()=>{
  const overlay=document.querySelector('.soundpack-item-overlay,.soundpack-group-drag-line');
  const animations=[...document.querySelectorAll('[data-soundpack-id],[data-soundpack-group],[data-soundpack-divider]')]
    .flatMap(element=>element.getAnimations().filter(animation=>animation.playState==='running').map(animation=>({duration:animation.effect.getTiming().duration,currentTime:animation.currentTime})));
  const placeholder=document.querySelector('[data-soundpack-placeholder]');
  return {overlay:overlay?{rect:overlay.getBoundingClientRect().toJSON(),transform:getComputedStyle(overlay).transform,settling:overlay.dataset.soundpackSettling==='true',animations:overlay.getAnimations().map(animation=>({duration:animation.effect.getTiming().duration,currentTime:animation.currentTime}))}:null,
    animations,target:Boolean(document.querySelector('[data-soundpack-drop-target]')),
    placeholder:placeholder?{border:getComputedStyle(placeholder).borderStyle,background:getComputedStyle(placeholder).backgroundColor}:null};
})()`);
const click = async selector => {
  const r = await rect(selector);
  if (!r) throw Error('Missing click target ' + selector);
  const point = center(r);
  input('mouseMove', point);
  input('mouseDown', point, { button: 'left', clickCount: 1 });
  input('mouseUp', point, { button: 'left', clickCount: 1 });
  await delay(80);
};
const capture = async name => {
  const image = await win.webContents.capturePage();
  check(image.getSize().width === width && image.getSize().height === height, name + ': exact viewport pixels', image.getSize());
  const file = name + '.png';
  fs.writeFileSync(path.join(artifacts, file), image.toPNG());
  results.screenshots.push(file);
};
const reset = async groups => {
  // Release a native button if a previous failing flow was interrupted.
  input('mouseUp', { x: 2, y: 2 }, { button: 'left', clickCount: 1 });
  await js(`window.soundpackGroupsQa.reset(${JSON.stringify(groups)})`);
  await wait('document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 12');
  await delay(200);
};
const test = async (name, action) => {
  try { results.flows[name] = { passed: true, ...(await action()) }; }
  catch (error) {
    results.flows[name] = { passed: false, error: String(error), state: await snapshot().catch(() => null) };
    results.checks.push({ label: name, passed: false, error: String(error) });
    console.error(name + ':', error.message || String(error));
    await capture(name + '-failed').catch(() => undefined);
  }
};
const createWindow = async () => {
  win = new BrowserWindow({ width, height, useContentSize: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'persist:soundpack-groups-qa' } });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', event => { if (event.level >= 3) results.rendererErrors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => results.rendererErrors.push(details));
  await win.loadURL(url);
  win.webContents.focus();
  await wait('Boolean(window.soundpackGroupsQa) && document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 12');
};
const timeout = setTimeout(() => {
  results.error = 'Sound-pack regression exceeded 120 seconds';
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(results, null, 2));
  app.exit(2);
}, 120_000);

app.whenReady().then(async () => {
  try {
    await createWindow();
    const allIds = await js('window.soundpackGroupsQa.allIds');
    const oneGroup = [{ id: 'default', soundIds: allIds }];

    await test('initial', async () => {
      await reset();
      const state = await snapshot();
      check(same(canonical(state), oneGroup), 'legacy ungrouped storage starts with all twelve packs in original order');
      check(state.addDisabled === false, 'add group is available when every group is populated');
      const styles = await js(`(()=>{const g=document.querySelector('[data-soundpack-group]'),s=getComputedStyle(g),c=document.querySelector('[data-soundpack-id] .soundpack-item-copy b');return {background:s.backgroundColor,border:s.borderTopWidth,shadow:s.boxShadow,name:c?.textContent,nameWidth:c?.getBoundingClientRect().width,scrollWidth:c?.scrollWidth}})()`);
      check(styles.background === 'rgba(0, 0, 0, 0)' && styles.border === '0px' && styles.shadow === 'none', 'groups add no visible outer cards', styles);
      check(styles.scrollWidth > styles.nameWidth, 'long fixture names exercise ellipsis without widening cards', styles);
      await capture('initial');
      return { state, styles };
    });

    await test('pointer-motion-and-settle', async () => {
      await reset();
      const destination = center(await cardRect('s3'));
      await lift(cardSelector('s1'), destination);
      const first = await motionState();
      check(first.animations.some(animation => animation.duration === 480), 'real pointer insertion animates displaced cards with the restored FLIP transition', first);
      check(first.target && first.placeholder?.border.includes('dashed') && first.placeholder.background !== 'rgba(0, 0, 0, 0)', 'pointed destination has a visible highlighted placeholder', first);
      const adjusted = { x: destination.x + 12, y: destination.y + 8 };
      await move(adjusted);
      const moved = await motionState();
      check(Math.abs(moved.overlay.rect.left - first.overlay.rect.left - 12) < 3 && Math.abs(moved.overlay.rect.top - first.overlay.rect.top - 8) < 3, 'drag overlay follows real mouse coordinates across compositor frames', { first, moved });
      input('mouseUp', adjusted, { button: 'left', clickCount: 1 });
      await wait('Boolean(document.querySelector("[data-soundpack-settling]"))');
      const released = await motionState();
      check(released.overlay.animations.some(animation => animation.duration === 380), 'mouseup retains a spring animation toward the drop slot', released);
      await delay(90);
      const settling = await motionState();
      check(settling.overlay && released.overlay.transform !== settling.overlay.transform, 'release transition changes the visible overlay transform before removal', { released, settling });
      await wait('!document.querySelector(".soundpack-item-overlay,[data-soundpack-settling]")');
      await capture('pointer-motion-settled');
      return { first, moved, released, settling };
    });

    await test('close-during-settle', async () => {
      await reset();
      const destination = center(await cardRect('s3'));
      await lift(cardSelector('s1'), destination);
      input('mouseUp', destination, { button: 'left', clickCount: 1 });
      await wait('Boolean(document.querySelector("[data-soundpack-settling]"))');
      const released = await motionState();
      const started = Date.now();
      await js('window.soundpackGroupsQa.setOpen(false)');
      check(!await js('Boolean(document.querySelector(".soundpack-item-overlay,.soundpack-group-drag-line,[data-soundpack-settling]"))'), 'closing the mounted management panel immediately cancels its release overlay', { released, elapsedMs: Date.now() - started });
      await delay(430);
      check(!await js('Boolean(document.querySelector(".soundpack-item-overlay,.soundpack-group-drag-line"))'), 'a cancelled settle timer cannot recreate the overlay after the panel closes');
      await js('window.soundpackGroupsQa.setOpen(true)');
      await wait('document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 12');
      return { released, reopened: await snapshot() };
    });

    const insertion = async (name, sourceId, targetId, side, expectedIndex) => {
      await reset();
      const target = await cardRect(targetId);
      const point = { x: side === 'left-edge' ? target.left + 1 : side === 'right-edge' ? target.right - 1 : target.left + target.width / 2, y: target.top + target.height / 2 };
      await lift(cardSelector(sourceId), point);
      const preview = await snapshot(sourceId);
      check(preview.placeholder?.groupId === 'default' && preview.placeholder.index === expectedIndex, name + ': placeholder occupies the pointed destination cell', preview.placeholder);
      await capture(name + '-preview');
      const expected = allIds.filter(id => id !== sourceId); expected.splice(expectedIndex, 0, sourceId);
      check(same(preview.groups[0].soundIds, expected), name + ': visible order matches expected insertion', preview.groups[0].soundIds);
      await up(point);
      const committed = await snapshot();
      check(same(canonical(preview), canonical(committed)), name + ': preview equals committed group order');
      check(!committed.placeholder && !committed.groupPreview, name + ': all drag visuals clear after pointerup');
      check(same(committed.serverOrder, expected), name + ': fixture ACK/broadcast retains the flat committed order');
      await capture(name + '-committed');
      return { point, preview, committed };
    };
    await test('same-row-right', () => insertion('same-row-right', 's1', 's2', 'left-edge', 1));
    await test('same-row-left', () => insertion('same-row-left', 's2', 's1', 'right-edge', 0));
    await test('row-wrap-edge', async () => {
      await reset();
      const first = await cardRect('s1');
      let targetId = null;
      for (const id of allIds.slice(1)) { const r = await cardRect(id); if (r.top > first.top + first.height / 2) { targetId = id; break; } }
      check(Boolean(targetId), 'grid fixture has a second row');
      return insertion('row-wrap-edge', 's1', targetId, 'left-edge', allIds.indexOf(targetId));
    });
    await test('rapid-final-pointerup', async () => {
      await reset();
      const firstTarget = center(await cardRect('s2'));
      const finalTarget = center(await cardRect('s3'));
      await lift(cardSelector('s1'), firstTarget);
      const heldPreview = await snapshot('s1');
      input('mouseMove', finalTarget);
      input('mouseUp', finalTarget, { button: 'left', clickCount: 1 });
      await wait('!window.soundpackGroupsQa.snapshot().dragging');
      await wait('!document.querySelector(".soundpack-item-overlay,[data-soundpack-settling]")');
      const committed = await snapshot();
      const expected = allIds.slice(1); expected.splice(2, 0, 's1');
      check(same(committed.groups[0].soundIds, expected), 'rapid last move and pointerup use the final pointer coordinates', committed.groups[0].soundIds);
      check(!committed.placeholder && same(committed.serverOrder, expected), 'rapid release clears preview and commits the final slot to the flat server protocol');
      await capture('rapid-final-pointerup');
      return { firstTarget, finalTarget, heldPreview, committed };
    });

    await test('empty-group-add-guard', async () => {
      const groups = [{ id: 'default', soundIds: ['s1'] }, { id: 'second', soundIds: allIds.slice(1) }];
      await reset(groups);
      const target = await cardRect('s2');
      const point = { x: target.left + 2, y: target.top + target.height / 2 };
      await lift(cardSelector('s1'), point);
      const preview = await snapshot('s1');
      check(preview.placeholder?.groupId === 'second' && preview.placeholder.index === 0, 'cross-group placeholder is placed in the destination group');
      await capture('cross-group-preview');
      await up(point);
      const empty = await snapshot();
      check(same(canonical(empty), canonical(preview)), 'cross-group preview equals committed grouping');
      check(empty.groups[0].id === 'default' && empty.groups[0].soundIds.length === 0, 'moving the final sound preserves an empty source group');
      check(empty.addDisabled === true, 'any empty group disables add-group');
      await click('[data-soundpack-add-group]');
      check((await snapshot()).groups.length === 2, 'clicking disabled add-group creates no extra empty group');
      await capture('empty-group');
      const emptyRect = await rect('[data-soundpack-group="default"]');
      const returnPoint = center(emptyRect);
      await lift(cardSelector('s1'), returnPoint);
      const returnPreview = await snapshot('s1');
      await up(returnPoint);
      const restored = await snapshot();
      check(same(canonical(restored), canonical(returnPreview)) && restored.addDisabled === false, 'filling the empty group restores add-group availability');
      await click('[data-soundpack-add-group]');
      const added = await snapshot();
      check(added.groups.length === 3 && added.groups[2].soundIds.length === 0 && added.addDisabled === true, 'add-group creates one persistent empty group and disables itself');
      await capture('new-empty-group');
      return { groups, preview, empty, returnPreview, restored, added };
    });

    await test('divider-group-swap', async () => {
      const groups = [{ id: 'default', soundIds: allIds.slice(0, 4) }, { id: 'middle', soundIds: allIds.slice(4, 8) }, { id: 'last', soundIds: allIds.slice(8) }];
      await reset(groups);
      const divider = await rect('[data-soundpack-divider="middle"]');
      const line = await rect('[data-soundpack-divider="middle"] > span');
      check(line.height <= 2 && line.width > 100, 'group move is exposed through a thin visible divider with a usable hit area', { divider, line });
      const target = center(await cardRect('s1'));
      await lift('[data-soundpack-divider="middle"]', target);
      const preview = await snapshot();
      check(Boolean(preview.groupPreview), 'dragging a divider paints the group drag preview line');
      const groupMotion = await motionState();
      check(groupMotion.animations.some(animation => animation.duration === 480) && groupMotion.target, 'whole-group swapping animates room groups and marks the pointed destination', groupMotion);
      check(same(preview.groups.map(group => group.id), ['middle', 'default', 'last']), 'divider drag previews a direct group swap');
      await capture('divider-group-preview');
      await up(target);
      const committed = await snapshot();
      check(same(canonical(preview), canonical(committed)), 'divider group preview equals committed group order');
      check(committed.groups.every(group => same(group.soundIds, groups.find(original => original.id === group.id).soundIds)), 'group swap retains every group member');
      check(same(committed.serverOrder, flat(canonical(committed))), 'group swap sends its flattened order using the existing server protocol');
      await capture('divider-group-committed');
      return { groups, preview, committed, divider };
    });

    await test('room-scope-and-stale-response', async () => {
      await reset();
      await js('window.soundpackGroupsQa.reloadWithHeldFetch()');
      await wait('window.soundpackGroupsQa.snapshot().pendingFetch');
      await js('window.soundpackGroupsQa.switchRoom()');
      await wait('document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 3');
      const before = await snapshot();
      await js(`window.soundpackGroupsQa.broadcast('soundpack:added',{id:'legacy-global',name:'Legacy global'});
        window.soundpackGroupsQa.broadcast('soundpack:deleted',{roomId:'soundpack-fixture-room',soundId:'other-s1'});
        window.soundpackGroupsQa.releaseFetch()`);
      await delay(120);
      const after = await snapshot();
      check(after.roomId === 'other-fixture-room' && same(canonical(before), canonical(after)) && flat(after.groups).every(id => id.startsWith('other-')), 'switching rooms ignores global events, other-room events and a late source-room list response', { before, after });
      check(after.requests.every(request => request.accountHeader && request.redirect === 'error'), 'all room list requests use the account header and reject redirects', after.requests);
      await capture('room-scope-isolated');
      return { before, after };
    });

    await test('initial-list-mutations-reload-snapshot', async () => {
      const evidence = {};
      for (const kind of ['added', 'deleted', 'renamed', 'normalized', 'reordered']) {
        await reset();
        await js('window.soundpackGroupsQa.reloadWithHeldFetch()');
        await wait('window.soundpackGroupsQa.snapshot().pendingFetch');
        const pending = await snapshot();
        const expected = await js(`window.soundpackGroupsQa.mutateWhileLoading(${JSON.stringify(kind)})`);
        const blocked = await snapshot();
        check(flat(blocked.groups).length === 0 && blocked.addDisabled, kind + ': pending room capability only marks the snapshot dirty without applying the event', blocked);
        await js('window.soundpackGroupsQa.releaseFetch()');
        await wait(`window.soundpackGroupsQa.snapshot().requests.length > ${pending.requests.length} && document.querySelectorAll('[data-soundpack-scroll] [data-soundpack-id]').length === ${expected.length}`);
        const loaded = await snapshot();
        check(same(flat(loaded.groups), expected) && loaded.addDisabled === false, kind + ': the stale first snapshot is discarded and the reloaded room list is visible', { pending, expected, loaded });
        if (kind === 'renamed') check(await js("document.querySelector('[data-soundpack-id=s1]')?.textContent.includes('Renamed while loading')"), 'rename during initial load is retained by the replacement snapshot');
        evidence[kind] = { pending, blocked, loaded };
      }
      return evidence;
    });

    await test('disconnect-revalidates-capability', async () => {
      await reset();
      await js('window.soundpackGroupsQa.setSuspended(true)');
      const paused = await snapshot();
      check(flat(paused.groups).length === 0 && paused.addDisabled, 'losing the room connection immediately removes old pack cards and locks management', paused);
      await js('window.soundpackGroupsQa.setSuspended(false)');
      await wait('document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 12');
      check((await snapshot()).addDisabled === false, 'reconnection validates a fresh room envelope before enabling management');
      return { paused, resumed: await snapshot() };
    });

    await test('legacy-server-capability-denied', async () => {
      await reset();
      await js('window.soundpackGroupsQa.legacyServer()');
      await wait('Boolean(document.querySelector("[role=alert]"))');
      const state = await snapshot();
      check(flat(state.groups).length === 0 && state.addDisabled && state.emissions.length === 0, 'a legacy full-server array cannot enable uploads or room management', state);
      return { state };
    });

    await test('keyboard-divider-to-first', async () => {
      const groups = [{ id: 'default', soundIds: allIds.slice(0, 4) }, { id: 'middle', soundIds: allIds.slice(4, 8) }, { id: 'last', soundIds: allIds.slice(8) }];
      await reset(groups);
      await js("document.querySelector('[data-soundpack-divider=middle]').focus()");
      await key('Space');
      await key('Up');
      const preview = await snapshot();
      check(same(preview.groups.map(group => group.id), ['middle', 'default', 'last']), 'native keyboard divider lift swaps the second group into the first position');
      check(await js("document.activeElement?.matches('[data-soundpack-divider=middle]')"), 'lifted first-position group retains its focused divider until release');
      await capture('keyboard-divider-first-preview');
      await key('Space');
      const committed = await snapshot();
      check(!committed.groupPreview && same(canonical(committed), canonical(preview)), 'Space commits the first-position group and clears the keyboard lift');
      check(await js("document.activeElement?.dataset.soundpackGroup === 'middle'"), 'keyboard release hands focus to the visible first-position group wrapper');
      check(!await js("Boolean(document.querySelector('[data-soundpack-divider=middle]'))"), 'committed first group keeps the ordinary divider-free presentation');
      await capture('keyboard-divider-first-committed');

      await reset(groups);
      await js("document.querySelector('[data-soundpack-divider=middle]').focus()");
      await key('Space');
      await key('Up');
      await key('Escape');
      const cancelled = await snapshot();
      check(!cancelled.groupPreview && same(canonical(cancelled), groups), 'Escape cancels a group keyboard lift after moving it into first position');
      check(await js("document.activeElement?.dataset.soundpackGroup === 'middle'"), 'keyboard cancellation restores focus to the original group wrapper');
      check(cancelled.emissions.length === 0, 'keyboard cancellation sends no reorder to the server');
      await capture('keyboard-divider-first-cancelled');
      return { groups, preview, committed, cancelled };
    });

    for (const cancel of ['Escape', 'pointercancel']) await test('cancel-' + cancel, async () => {
      await reset();
      const before = await snapshot();
      const target = center(await cardRect('s3'));
      await lift(cardSelector('s1'), target);
      const preview = await snapshot('s1');
      check(!same(canonical(preview), canonical(before)), cancel + ': a changed preview is active before cancellation');
      if (cancel === 'Escape') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      } else await js('window.soundpackGroupsQa.cancelPointer()');
      await wait('!window.soundpackGroupsQa.snapshot().dragging');
      await up(target);
      const after = await snapshot();
      check(same(canonical(after), canonical(before)), cancel + ': original order returns');
      check(!after.placeholder && !after.groupPreview && after.emissions.length === 0, cancel + ': cancellation clears visuals without a server commit');
      await capture('cancel-' + cancel);
      return { before, preview, after };
    });

    await test('scroll-while-dragging', async () => {
      const groups = Array.from({ length: 6 }, (_, index) => ({ id: index === 0 ? 'default' : 'scroll-' + index, soundIds: allIds.slice(index * 2, index * 2 + 2) }));
      await reset(groups);
      const before = await snapshot();
      check(before.scroll.contentHeight > before.scroll.height + 80, 'six groups make the real list scrollable', before.scroll);
      const point = { x: before.scroll.rect.left + before.scroll.rect.width / 2, y: before.scroll.rect.top + before.scroll.rect.height / 2 };
      await lift(cardSelector('s1'), point);
      input('mouseWheel', point, { deltaY: -220, deltaX: 0, canScroll: true });
      await wait('window.soundpackGroupsQa.snapshot().scroll.top > 50');
      // Native wheel scrolls over several compositor frames. Measure the target
      // after that motion finishes, while the pointer drag remains active.
      await delay(300);
      const scrolled = await snapshot('s1');
      check(scrolled.dragging, 'native wheel scrolling keeps the active drag alive');
      const visible = await js(`(()=>{const s=document.querySelector('[data-soundpack-scroll]').getBoundingClientRect();return [...document.querySelectorAll('[data-soundpack-scroll] [data-soundpack-id]')].map(e=>({id:e.dataset.soundpackId,r:e.getBoundingClientRect().toJSON()})).filter(e=>e.r.top>s.top+35&&e.r.bottom<s.bottom-35).pop()})()`);
      check(Boolean(visible), 'native scrolling exposes a different drop target');
      const target = { x: visible.r.left + 1, y: visible.r.top + visible.r.height / 2 };
      await move(target);
      const preview = await snapshot('s1');
      const destination = groups.find(group => group.soundIds.includes(visible.id));
      check(preview.placeholder?.groupId === destination.id, 'post-scroll hit testing resolves the visible destination group', preview.placeholder);
      await capture('scroll-drag-preview');
      await up(target);
      const committed = await snapshot();
      check(same(canonical(preview), canonical(committed)), 'post-scroll placeholder equals committed grouping');
      await capture('scroll-drag-committed');
      return { before, scrolled, visible, target, preview, committed };
    });

    await test('ack-failure-rollback', async () => {
      await reset([{ id: 'default', soundIds: ['s1'] }, { id: 'second', soundIds: allIds.slice(1) }]);
      const before = await snapshot();
      await js('window.soundpackGroupsQa.failNextReorder()');
      const r = await cardRect('s3');
      const target = { x: r.right - 1, y: r.top + r.height / 2 };
      await lift(cardSelector('s1'), target);
      await up(target);
      const after = await snapshot();
      check(after.alerts.includes('Fixture reorder rejected'), 'fixture exercises a server reorder rejection');
      check(same(canonical(after), canonical(before)), 'failed ACK restores the previous membership and order');
      check(after.storage === before.storage && same(after.serverOrder, before.serverOrder), 'failed ACK restores persisted grouping and server order');
      await capture('ack-failure-rollback');
      return { before, after };
    });

    await test('account-scope-with-held-fetch', async () => {
      await reset();
      const destination = [{ id: 'destination', soundIds: allIds.slice().reverse() }, { id: 'destination-empty', soundIds: [] }];
      const storage = JSON.stringify({ version: 1, groups: destination });
      const key = await js(`window.soundpackGroupsQa.switchAccount('second-fixture-account', ${JSON.stringify(destination)}, true)`);
      await wait('window.soundpackGroupsQa.snapshot().pendingFetch');
      const pending = await snapshot();
      check(pending.storage === storage && pending.addDisabled === true, 'account scope change retains destination memberships while its list fetch is pending');
      await js('window.soundpackGroupsQa.releaseFetch()');
      await wait('!window.soundpackGroupsQa.snapshot().pendingFetch && document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 12');
      await delay(100);
      const loaded = await snapshot();
      check(same(canonical(loaded), destination), 'matching account fetch loads destination grouping without pruning its saved membership');
      check(loaded.storage === storage && loaded.accountId === 'second-fixture-account', 'destination storage stays unchanged after account switch and fetch');
      await capture('account-scope-with-held-fetch');
      return { key, pending, loaded };
    });

    await test('late-ack-after-account-switch', async () => {
      await reset();
      await js('window.soundpackGroupsQa.holdNextReorder()');
      const target = center(await cardRect('s2'));
      await lift(cardSelector('s1'), target);
      await up(target);
      const source = await snapshot();
      check(source.pendingReorder, 'source account has an in-flight reorder acknowledgement');
      const sourceStorage = await js('localStorage.getItem(window.soundpackGroupsQa.groupsKey)');
      const destination = [{ id: 'destination', soundIds: allIds.slice().reverse() }];
      await js(`window.soundpackGroupsQa.switchAccount('late-ack-account', ${JSON.stringify(destination)}, true)`);
      await wait('window.soundpackGroupsQa.snapshot().pendingFetch');
      await js('window.soundpackGroupsQa.releaseReorder(false)');
      await delay(100);
      const pending = await snapshot();
      check(pending.storage === JSON.stringify({ version: 1, groups: destination }), 'late rejected ACK cannot overwrite destination saved grouping');
      check(await js('localStorage.getItem(window.soundpackGroupsQa.groupsKey)') === sourceStorage, 'late rejected ACK cannot roll back the departed account storage');
      check(pending.alerts.length === 0, 'stale rejected ACK does not show an error for the new account');
      await js('window.soundpackGroupsQa.releaseFetch()');
      await wait('!window.soundpackGroupsQa.snapshot().pendingFetch && document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 12');
      await delay(100);
      const loaded = await snapshot();
      check(same(canonical(loaded), destination) && loaded.addDisabled === false, 'destination completes loading and unlocks its own reorder controls');
      await capture('late-ack-after-account-switch');
      return { source, pending, loaded };
    });

    await test('external-delete-during-drag', async () => {
      await reset();
      const target = center(await cardRect('s3'));
      await lift(cardSelector('s1'), target);
      const preview = await snapshot('s1');
      await js("window.soundpackGroupsQa.broadcastDelete('s12')");
      await wait('!window.soundpackGroupsQa.snapshot().dragging && document.querySelectorAll("[data-soundpack-scroll] [data-soundpack-id]").length === 11');
      await up(target);
      const after = await snapshot();
      check(!after.placeholder && !after.groupPreview && after.emissions.length === 0, 'external list mutation cancels the active preview without a reorder commit');
      check(same(after.groups[0].soundIds, allIds.slice(0, 11)), 'external deletion is visible and retains the original order of surviving cards');
      check(same(JSON.parse(after.storage).groups[0].soundIds, allIds.slice(0, 11)), 'external deletion reconciles the saved membership');
      await capture('external-delete-during-drag');
      return { preview, after };
    });

    await test('restart-persistence', async () => {
      const groups = [{ id: 'default', soundIds: ['s1'] }, { id: 'second', soundIds: allIds.slice(1) }, { id: 'empty-persisted', soundIds: [] }];
      await reset(groups);
      const target = center(await cardRect('s3'));
      await lift(cardSelector('s2'), target);
      await up(target);
      const before = await snapshot();
      check(Boolean(before.storage) && before.groups.some(group => group.id === 'empty-persisted' && group.soundIds.length === 0), 'fixture stores changed ordering and an empty group before restart');
      await win.webContents.session.flushStorageData();
      win.destroy();
      await createWindow();
      const restarted = await snapshot();
      check(same(canonical(restarted), canonical(before)), 'a recreated Electron window restores grouped membership, order, and empty groups');
      check(restarted.storage === before.storage && restarted.addDisabled === true, 'restart retains server/account localStorage and the empty-group add guard');
      check(same(restarted.serverOrder, before.serverOrder), 'fixture flat server state also survives renderer restart');
      await capture('restart-persistence');
      return { before, restarted };
    });

    check(results.rendererErrors.length === 0, 'renderer reports no runtime errors', results.rendererErrors);
    results.passed = results.checks.every(item => item.passed) && Object.values(results.flows).every(flow => flow.passed);
  } catch (error) { results.error = String(error); console.error(error); }
  finally {
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(results, null, 2));
    console.log(`${results.passed ? 'PASS' : 'FAIL'} sound-pack groups: ${results.checks.filter(item => item.passed).length}/${results.checks.length} checks; ${path.join(artifacts, 'result.json')}`);
    clearTimeout(timeout);
    win?.destroy();
    app.exit(results.passed ? 0 : 1);
  }
});
