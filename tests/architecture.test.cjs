const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname,'..');
const contracts = require('../baseline/integration-contracts.json');
const read = file => fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
function inventory(text){
  const source=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
  const events=[], routes=[];
  function visit(node){
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
  const migrated=inventory(files(path.join(root,'apps/server/src')).filter(f=>f.endsWith('.ts')).map(f=>fs.readFileSync(f,'utf8')).join('\n'));
  for(const kind of ['events','routes'])
    for(const item of contracts.serverSurface[kind])assert.ok(migrated[kind].includes(item),kind+': '+item);
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
  for(const file of contracts.native){
    const buffer=fs.readFileSync(path.join(root,file.path));
    const content=file.path.endsWith('.wasm')?buffer:buffer.toString('utf8').replace(/\r\n/g,'\n');
    const sha=crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(sha,file.sha256,file.path);
  }
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
