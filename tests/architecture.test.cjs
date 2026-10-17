const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname,'..');
const contracts = require('../baseline/integration-contracts.json');
const read = file => fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
// The original relocation hashes remain immutable. Only this release's five
// reviewed screen files may use a separately documented replacement hash.
const screenEncoderReleaseAllowlist = new Map([
  ['apps/mobile/android/app/src/main/java/com/oney/WebRTCModule/CoveScreenModule.java','0e7b57f5ac626d2e87fe629c8bfddc5a002596091ee636b93e97b03353d2985d'],
  ['apps/mobile/android/app/src/main/java/com/oney/WebRTCModule/CoveScreenRuntime.java','05ca55a1a9c4e19a9cc45ea2f5d66f3610dbc83834dda1497e20278e2ad97de1'],
  ['apps/mobile/android/build-logic/src/main/java/com/cove/instrumentation/ScreenSharingVisitor.java','2bc0e6ca2d91aa0afa3e8e32a83ff88efa5cdb3bf67c79c6e2d01a6ccef3959c'],
  ['apps/mobile/android/build-logic/src/main/java/com/cove/instrumentation/ScreenSharingVisitorFactory.java','db43b6bb8c5be2bc79ace0daeef96842fb5b1877168ea01b3ee2ced1f54b1817'],
  ['apps/mobile/android/build-logic/src/test/java/com/cove/instrumentation/ScreenSharingVisitorTest.java','81cf4214d2398993fc1c11a56f8de468f9be8972f87a656cf2dfec46ee3fbd05'],
]);
function screenEncoderReleaseOverrides(evidence, originalHashes) {
  assert.ok(evidence && typeof evidence === 'object','missing documented screen encoder release evidence');
  assert.equal(evidence.baseCommit,'eda5986');
  assert.equal(evidence.releaseVersion,'0.8.2');
  assert.ok(Array.isArray(evidence.modifiedOriginal),'screen encoder exceptions must be an array');
  const overrides = new Map();
  for (const entry of evidence.modifiedOriginal) {
    assert.ok(entry && typeof entry === 'object','invalid screen encoder exception');
    assert.ok(screenEncoderReleaseAllowlist.has(entry.path),'native exception is outside the screen encoder allowlist: '+entry.path);
    assert.ok(!overrides.has(entry.path),'duplicate native exception: '+entry.path);
    const original = screenEncoderReleaseAllowlist.get(entry.path);
    assert.equal(originalHashes.get(entry.path),original,'original native baseline changed: '+entry.path);
    assert.equal(entry.baseSha256,original,'native exception does not preserve its original hash: '+entry.path);
    assert.match(entry.sha256,/^[a-f0-9]{64}$/,'invalid replacement native hash: '+entry.path);
    assert.notEqual(entry.sha256,entry.baseSha256,'native exception must document an actual change: '+entry.path);
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim(),'native exception requires a reviewable reason: '+entry.path);
    overrides.set(entry.path,entry.sha256);
  }
  assert.equal(overrides.size,screenEncoderReleaseAllowlist.size,'all five screen encoder exceptions must be documented');
  return overrides;
}
const integratedCandidateAllowlist = new Map([
  ['apps/mobile/android/app/src/main/java/com/covemobile/CoveNativePackage.kt', {
    baseSha256:'a6f9d5ce72d85d9a29634b8e374d29fac405fb8fab136d878c238f381a1476d8',
    sha256:'4cd639f4f599d5cf26b8a0c405b4401143d3ceab0a9aaadfa7725ae4248910ce',
    commit:'c8307ebb6bb6d93124a693674cc11a7e1e973f19',
  }],
  ['apps/mobile/android/app/src/main/java/com/covemobile/ServerCertificateNetwork.kt', {
    baseSha256:'d75df0b106e5aed360a6f83eeba390baa9198b8cd5ab881b0d0f37a32e750cb9',
    sha256:'78f302d717994c3ec17b3325da6eaab331eda0198d1a3fd911d86169ff8e763e',
    commit:'8d8eba8d684b8b7f2458f077d553ebe067d58c02',
  }],
]);
function integratedCandidateOverrides(evidence, originalHashes) {
  assert.equal(evidence?.baseCommit,'eda598670b828b56d0b7625fb262ccb69acf15a7');
  assert.ok(Array.isArray(evidence.modifiedOriginal));
  const overrides=new Map();
  for(const entry of evidence.modifiedOriginal){
    const accepted=integratedCandidateAllowlist.get(entry.path);
    assert.ok(accepted,'candidate native exception is outside the reviewed allowlist: '+entry.path);
    assert.ok(!overrides.has(entry.path),'duplicate candidate native exception: '+entry.path);
    assert.equal(originalHashes.get(entry.path),accepted.baseSha256,'original candidate baseline changed: '+entry.path);
    for(const key of ['baseSha256','sha256','commit'])assert.equal(entry[key],accepted[key],key+': '+entry.path);
    assert.ok(typeof entry.reason==='string'&&entry.reason.trim());
    overrides.set(entry.path,entry.sha256);
  }
  assert.equal(overrides.size,integratedCandidateAllowlist.size);
  return overrides;
}
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
function inventory(text){
  const source=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
  const options={noLib:true,noResolve:true};
  const host=ts.createCompilerHost(options);
  host.getSourceFile=file=>file==='source.ts'?source:undefined;
  host.readFile=file=>file==='source.ts'?text:undefined;
  host.fileExists=file=>file==='source.ts';
  const checker=ts.createProgram(['source.ts'],options,host).getTypeChecker();
  const events=[], routes=[];
  // Room-scoped registration forwards its first parameter to socket.on. Resolve
  // only a declaration in the call's lexical scope, so unrelated helper calls
  // and strings cannot count as preserved socket registrations.
  const registrars=new Set();
  function socketOn(node){
    return ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)
      &&node.expression.name.text==='on'
      &&(node.expression.expression.getText(source)==='socket'||node.expression.expression.getText(source).endsWith('.socket'));
  }
  function discover(node){
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isArrowFunction(node.initializer)){
      const fn=node.initializer, parameter=fn.parameters[0]?.name;
      if(parameter&&ts.isIdentifier(parameter)){
        let forwards=false;
        function forwarded(child){
          if(socketOn(child)&&ts.isIdentifier(child.arguments[0])&&checker.getSymbolAtLocation(child.arguments[0])===checker.getSymbolAtLocation(parameter))forwards=true;
          if(child!==fn.body&&ts.isFunctionLike(child))return;
          ts.forEachChild(child,forwarded);
        }
        forwarded(fn.body);
        if(forwards)registrars.add(checker.getSymbolAtLocation(node.name));
      }
    }
    ts.forEachChild(node,discover);
  }
  discover(source);
  function isRegistrarCall(node){
    if(!ts.isIdentifier(node.expression))return false;
    const symbol=checker.getSymbolAtLocation(node.expression);
    return !!symbol&&registrars.has(symbol);
  }
  function visit(node){
    if(ts.isCallExpression(node)&&isRegistrarCall(node)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))events.push(node.arguments[0].text);
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
      const name=node.expression.name.text, receiver=node.expression.expression.getText(source), arg=node.arguments[0];
      if(arg&&ts.isStringLiteral(arg)){
        if(name==='on'&&(receiver==='socket'||receiver.endsWith('.socket')))events.push(arg.text);
        if(['get','post','put','patch','delete','use'].includes(name)&&arg.text.startsWith('/api/'))routes.push(name+' '+arg.text);
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);return {events:events.sort(),routes:routes.sort()};
}
test('all existing server HTTP routes and socket handlers survive migration',()=>{
  const inventories=files(path.join(root,'apps/server/src')).filter(f=>f.endsWith('.ts')).map(f=>inventory(fs.readFileSync(f,'utf8')));
  const migrated={events:inventories.flatMap(value=>value.events),routes:inventories.flatMap(value=>value.routes)};
  for(const kind of ['events','routes'])
    for(const item of contracts.serverSurface[kind])assert.ok(migrated[kind].includes(item),kind+': '+item);
});

test('surface inventory follows scoped socket registration and rejects unrelated literals',()=>{
  const found=inventory(`
    function register(deps) {
      const onRoomEvent=(event, handler)=>{ deps.socket.on(event, handler); };
      onRoomEvent('soundpack:delete', handler);
      {
        const onRoomEvent=(event)=>console.log(event);
        onRoomEvent('shadow:not:registered');
      }
      function parameterShadow(onRoomEvent) { onRoomEvent('parameter:not:registered',handler); }
      function constShadow() { const onRoomEvent=external; onRoomEvent('const:not:registered',handler); }
      function declarationShadow() {
        function onRoomEvent(event) { console.log(event); }
        onRoomEvent('function:not:registered',handler);
      }
    }
    function unrelated() {
      const onRoomEvent=(event)=>console.log(event);
      onRoomEvent('not:registered');
    }
    const label='also:not:registered';
  `);
  assert.deepEqual(found.events,['soundpack:delete']);
});
test('platform-independent packages cannot import apps, React, native or Node adapters',()=>{
  for(const file of files(path.join(root,'packages')).filter(f=>f.includes(path.sep+'src'+path.sep)&&f.endsWith('.ts'))){
    const text=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(text, /(?:from\s*|require\()\s*['"](?:react(?:-native|-dom)?|electron|mediasoup|node:|\.\..*apps\/)/,file);
    assert.doesNotMatch(text,/\b(?:window|document|navigator|localStorage)\./,file);
  }
});
test('applications do not reach into another application or machine-specific source paths',()=>{
  for(const app of ['desktop','server','mobile']){
    const sourceDir=path.join(root,'apps',app,'src');
    for(const file of files(sourceDir).filter(f=>/\.tsx?$/.test(f))){
      const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
      function visit(node){
        if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){
          const spec=node.moduleSpecifier?.text;
          if(spec?.startsWith('.')){
            const resolved=path.resolve(path.dirname(file),spec);
            for(const other of ['desktop','server','mobile'].filter(name=>name!==app))
              assert.ok(!resolved.startsWith(path.join(root,'apps',other)+path.sep),file+' → '+spec);
          }
          if(spec)assert.doesNotMatch(spec,/^[A-Za-z]:[\\/]/,file);
        }
        ts.forEachChild(node,visit);
      }
      visit(source);
    }
  }
});
test('accepted native capture, DSP and Android code survives relocation',()=>{
  assert.ok(contracts.native.length>40);
  const originalHashes = new Map(contracts.native.map(file=>[file.path,file.sha256]));
  assert.equal(originalHashes.size,contracts.native.length,'duplicate original native baseline entry');
  const evidence = contracts.nativeExtensionEvidence.screenEncoderRelease;
  const overrides = new Map([
    ...integratedCandidateOverrides(contracts.nativeExtensionEvidence.integratedCandidates,originalHashes),
    ...screenEncoderReleaseOverrides(evidence,originalHashes),
  ]);
  for(const file of contracts.native){
    const buffer=fs.readFileSync(path.join(root,file.path));
    const content=file.path.endsWith('.wasm')?buffer:buffer.toString('utf8').replace(/\r\n/g,'\n');
    const sha=crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(sha,overrides.get(file.path) ?? file.sha256,file.path);
  }
});
test('native release exceptions reject duplicates and files outside the reviewed allowlist',()=>{
  const evidence=contracts.nativeExtensionEvidence.screenEncoderRelease;
  const originalHashes=new Map(contracts.native.map(file=>[file.path,file.sha256]));
  assert.throws(()=>screenEncoderReleaseOverrides({...evidence,
    modifiedOriginal:[...evidence.modifiedOriginal,evidence.modifiedOriginal[0]]},originalHashes),/duplicate native exception/);
  assert.throws(()=>screenEncoderReleaseOverrides({...evidence,
    modifiedOriginal:[{...evidence.modifiedOriginal[0],path:'apps/mobile/android/app/src/main/java/com/covemobile/CoveNativeModule.kt'},...evidence.modifiedOriginal.slice(1)]},originalHashes),/outside the screen encoder allowlist/);
  const first=evidence.modifiedOriginal[0];
  assert.throws(()=>screenEncoderReleaseOverrides({...evidence,
    modifiedOriginal:[{...first,baseSha256:first.sha256},...evidence.modifiedOriginal.slice(1)]},originalHashes),/does not preserve its original hash/);
});
test('release identities match packages and both mobile feeds remain consistent',()=>{
  for(const [key,file] of [['root','package.json'],['desktop','apps/desktop/package.json'],['server','apps/server/package.json'],['mobile','apps/mobile/package.json']])
    assert.equal(require(path.join(root,file)).version,contracts.versions[key]);
  assert.equal(read('mobile/update.json'),read('apps/mobile/update.json'));
  const feed=JSON.parse(read('mobile/update.json'));
  assert.equal(feed.schemaVersion,1);assert.equal(feed.platform,'android');
  assert.equal(feed.release.packageName,'com.cove.mobile');
  const {compareSemanticVersions}=require('../packages/contracts/dist');
  const precedence=compareSemanticVersions(feed.release.versionName,contracts.versions.mobile);
  assert.ok(precedence!==null&&precedence<=0,'feed must describe a built current or previously published APK');
  assert.ok(Number.isSafeInteger(feed.release.versionCode)&&feed.release.versionCode<=Number(contracts.gradleCode.split(' ')[1]));
  const gradle=fs.readFileSync(path.join(root,'apps/mobile/android/app/build.gradle'),'utf8');
  assert.equal(gradle.match(/versionName "[^"]+"/)?.[0],contracts.gradleVersion);
  assert.equal(gradle.match(/versionCode \d+/)?.[0],contracts.gradleCode);
});
test('third-party dependencies retain the accepted snapshot versions',()=>{
  const current=require('../package-lock.json');
  for(const [key,version] of Object.entries(contracts.dependencyVersions))assert.equal(current.packages[key]?.version,version,key);
});
test('formal desktop identity and launch defaults remain Cove settings',()=>{
  const desktop=require('../apps/desktop/package.json');
  assert.equal(desktop.build.appId,'com.cove.app');
  assert.equal(desktop.build.productName,'Cove');
  assert.match(read('apps/desktop/src/app/App.tsx'),/VITE_COVE_DEFAULT_SERVER \|\| import\.meta\.env\.VITE_SERVER_URL/);
  const pkg=require('../package.json');
  assert.equal(pkg.scripts.dev,'npm run build:packages && node tooling/dev.cjs');
  assert.ok(!Object.keys(pkg.scripts).some(key=>key.startsWith('network:')||key.startsWith('dev:network')));
});
