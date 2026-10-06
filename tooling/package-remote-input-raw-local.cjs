// Local-only replacement candidate; keep the previous 2.0.1 installer intact.
const path=require('path'),assert=require('assert/strict'),{createRequire}=require('module');
const appDir=path.resolve(__dirname,'../apps/desktop'),localRequire=createRequire(path.join(appDir,'package.json'));
const manifest=localRequire('./package.json');assert.equal(manifest.version,'2.0.1');assert.equal(manifest.build.appId,'com.cove.app');assert.equal(manifest.build.productName,'Cove');assert.equal(manifest.coveBuildFlavor,undefined);
const {build,Platform,Arch}=localRequire('electron-builder');
const unified=process.argv.includes('--with-account-memory');
if(unified)assert.ok(manifest.scripts['test:account-auth'].includes('accountPasswordStore'));
build({projectDir:appDir,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),publish:'never',config:{
 electronDist:path.join(appDir,'node_modules/electron/dist'),directories:{output:'dist-app-remote-input-2.0.1'},
 artifactName:unified?'Cove-Setup-${version}-remote-input-account-memory.${ext}':'Cove-Setup-${version}-raw-input.${ext}'
}}).then(files=>console.log(JSON.stringify({localArtifacts:files},null,2))).catch(error=>{console.error(error);process.exitCode=1});
