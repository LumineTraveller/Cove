const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const artifacts = path.resolve(__dirname, '../../../runtime/issue6/rendered');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-data'));
app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const watchdog = setTimeout(() => { console.error('Annotation regression timeout'); app.exit(2); }, 30_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 960, height: 640, useContentSize: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'annotation-issue6-regression' } });
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = async (predicate, label) => {
    for (let attempt = 0; attempt < 160; attempt++) { if (await js(predicate)) return; await delay(25); }
    throw Error('Timed out: ' + label);
  };
  const state = () => js('annotationProbe.state()');
  const pixel = (x, y) => js(`(()=>{const c=document.querySelector('.annotation-canvas');return [...c.getContext('2d').getImageData(Math.round(c.width*${x}),Math.round(c.height*${y}),1,1).data]})()`);
  const check = (passed, label) => { assert.ok(passed, label); checks.push(label); };
  const stroke = (tool, color, points, id, final = false) => js(`annotationProbe.stroke(${JSON.stringify(tool)},${JSON.stringify(color)},.06,${JSON.stringify(points)},${JSON.stringify(id)},${final})`);
  const peer = (tool, color, y) => js(`annotationProbe.peer(${JSON.stringify(tool)},${JSON.stringify(color)},[{x:.25,y:${y}},{x:.75,y:${y}}],.08)`);
  try {
    await win.loadURL(process.env.COVE_ANNOTATION_QA_URL || 'http://127.0.0.1:55379/tests/ui/annotation-regression-qa.html');
    await wait('window.annotationProbe?.state().ready && document.querySelector(".annotation-canvas")?.width > 0', 'ready');
    await js('annotationProbe.start()');
    await wait('annotationProbe.state().canDraw', 'drawing');
    await js(`(()=>{
      annotationProbe.stroke('pen','#ff0000',.06,[{x:.1,y:.1}],'order-seed',true);
      annotationProbe.stroke('pen','#ff0000',.06,[{x:.5,y:.5}],'queued-own-pen',true);
      const end=performance.now()+45;while(performance.now()<end){}
      annotationProbe.stroke('eraser','#ff0000',.08,[{x:.5,y:.5}],'own-eraser',true);
    })()`);
    await delay(240);
    check((await state()).state.strokes.map(stroke => stroke.id).join(',') === 'order-seed,queued-own-pen,own-eraser',
      'own eraser cannot overtake an older queued pen during a busy UI task');
    check((await pixel(.5,.5))[3] === 0, 'own ink remains erased after every delayed chunk is confirmed');
    await js('annotationProbe.clear()'); await delay(45);
    await peer('pen', '#ff0000', .5);
    await stroke('eraser', '#ff0000', [{ x: .4, y: .5 }], 'old-eraser');
    await delay(45);
    await js('annotationProbe.hold(true)');
    await stroke('eraser', '#ff0000', [{ x: .6, y: .5 }], 'old-eraser', true);
    await wait('annotationProbe.state().held === 1', 'held eraser');
    await peer('pen', '#0000ff', .5);
    await delay(60);
    let rgba = await pixel(.5, .5);
    check(rgba[2] > 200 && rgba[3] === 255, 'new ink remains visible across an unconfirmed older eraser');
    await js('annotationProbe.release()'); await delay(60);
    check((await state()).optimistic.length === 0, 'confirmed eraser retires its optimistic extension');
    rgba = await pixel(.5, .5);
    check(rgba[2] > 200 && rgba[3] === 255, 'eraser confirmation preserves the new ink');

    await js('annotationProbe.clear()'); await delay(45);
    await stroke('pen', '#ff0000', [{ x: .3, y: .6 }], 'old-pen'); await delay(45);
    await js('annotationProbe.hold(true)');
    await stroke('pen', '#ff0000', [{ x: .7, y: .6 }], 'old-pen', true);
    await wait('annotationProbe.state().held === 1', 'held pen');
    await peer('eraser', '#ff0000', .6); await delay(60);
    check((await pixel(.5, .6))[3] === 0, 'eraser removes a previous pen even while its tail is pending');
    await js('annotationProbe.release()'); await delay(60);
    check((await pixel(.5, .6))[3] === 0, 'late pen confirmation cannot redraw erased ink');

    await js('annotationProbe.clear()'); await delay(45);
    await stroke('eraser', '#ff0000', [{ x: .2, y: .5 }], 'cleared-eraser'); await delay(45);
    await js('annotationProbe.hold(true)');
    await stroke('eraser', '#ff0000', Array.from({ length: 128 }, (_, i) => ({ x: .2 + i / 256, y: .5 })), 'cleared-eraser', true);
    await wait('annotationProbe.state().held >= 1', 'queued erase chunks');
    const drawCount = (await state()).drawCount;
    await js('annotationProbe.clear()'); await delay(90);
    check((await state()).drawCount === drawCount, 'clear cancels unsent erase chunks');
    await js('annotationProbe.release()'); await delay(40);
    check((await state()).error === null && (await state()).optimistic.length === 0, 'late pre-clear callbacks cannot restore an eraser');
    check(await stroke('eraser', '#ff0000', [{ x: .8, y: .5 }], 'cleared-eraser') === null, 'clear ends the previous pointer stroke');
    await stroke('pen', '#ff0000', [{ x: .3, y: .5 }, { x: .7, y: .5 }], 'fresh-pen', true); await delay(60);
    rgba = await pixel(.5, .5);
    check(rgba[0] > 200 && rgba[3] === 255, 'a fresh pen draws over the entire cleared area');

    await js('annotationProbe.clear()'); await delay(45);
    const loop = [{ x: .2, y: .5 }, { x: .4, y: .5 }, { x: .2, y: .5 }, { x: .4, y: .5 }];
    for (const point of loop) { await stroke('eraser', '#ff0000', [point], 'loop'); await delay(45); }
    await js('annotationProbe.finish("loop")'); await delay(40);
    check((await state()).state.strokes[0].points.length === loop.length && (await state()).optimistic.length === 0,
      'repeated coordinates confirm fully without leaving an active eraser');

    // Paint directly beneath the diagnostics controls while drawing is active.
    await js(`(()=>{const button=document.querySelector('[aria-label="导出媒体诊断"]'),b=button.getBoundingClientRect(),r=document.querySelector('.annotation-content-layer').getBoundingClientRect();
      annotationProbe.peer('pen','#ff0000',[{x:0,y:Math.max(0,(b.top+b.height/2-r.top)/r.height)},{x:1,y:Math.max(0,(b.top+b.height/2-r.top)/r.height)}],.08);})()`);
    await delay(80);
    check(await js(`(()=>{const tools=document.querySelector('.annotation-toolbar')||document.querySelector('.annotation-tool-ball'),t=tools.getBoundingClientRect(),d=document.querySelector('.debug-overlay').getBoundingClientRect();return t.right<=d.left||t.left>=d.right||t.bottom<=d.top||t.top>=d.bottom})()`),
      'floating annotation tools avoid the diagnostics panel');
    check(await js(`(()=>{const b=document.querySelector('[aria-label="导出媒体诊断"]'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),
      'diagnostics stay above annotation ink and input');
    const rect = await js(`(()=>{const r=document.querySelector('[aria-label="导出媒体诊断"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', ...rect });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect });
    await delay(80);
    check((await state()).diagnosticClicks === 1, 'diagnostics buttons remain clickable during annotation');
    await delay(120);
    fs.writeFileSync(path.join(artifacts, 'annotation-layers.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ electron: process.versions.electron, checks }, null, 2));
    console.log(JSON.stringify({ electron: process.versions.electron, passed: checks.length, checks }));
    win.destroy(); clearTimeout(watchdog); app.quit();
  } catch (error) { console.error(error); win.destroy(); clearTimeout(watchdog); app.exit(1); }
});
