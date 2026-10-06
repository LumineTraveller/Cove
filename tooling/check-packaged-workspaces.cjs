// Explicit packaging gate; not part of ordinary unit tests.
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const asar=require('@electron/asar');
const root=path.resolve(__dirname,'..');
for(const app of ['desktop','server']){
  const archive=path.join(root,'apps',app,'dist-app-refactor-final/win-unpacked/resources/app.asar');
  for(const pkg of ['contracts','client-core']){
    const dir=path.join(root,'packages',pkg);
    const files=['package.json',...fs.readdirSync(path.join(dir,'dist')).filter(file=>file.endsWith('.js')).map(file=>path.join('dist',file))];
    for(const file of files){
      const packed=asar.extractFile(archive,path.join('node_modules','@cove',pkg,file));
      const original=fs.readFileSync(path.join(dir,file));
      if(file==='package.json'){
        // electron-builder 24 strips development scripts and reformats JSON.
        const actual=JSON.parse(packed),expected=JSON.parse(original);
        for(const key of ['name','version','main','types'])assert.equal(actual[key],expected[key],app+'/'+pkg+'/'+key);
      }else assert.equal(require('node:crypto').createHash('sha256').update(packed).digest('hex'),require('node:crypto').createHash('sha256').update(original).digest('hex'),app+'/'+pkg+'/'+file);
    }
  }
  if(app==='desktop')assert.ok(asar.listPackage(archive).some(file=>file.endsWith(path.join('dist','index.html'))));
  else assert.ok(fs.existsSync(path.join(path.dirname(archive),'app.asar.unpacked/node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe')));
  console.log('PASS: '+app+' packaged shared runtime contents and entry resources.');
}
