import test from 'node:test';
import assert from 'node:assert/strict';
import {clientUpgradePolicy, clientUpgradeError, requestClientIdentity, requireClientVersion, isClientIdentitySupported} from '../src/features/security/clientVersion';

test('desktop and mobile floors require protocol 3 and recognized platform, independently of password mode', () => {
  for (const version of [undefined,'1.5.4','1.10.0','2.0.0-rc.1','invalid']) {
    const policy=clientUpgradePolicy(version,'desktop',3);
    assert.equal(policy.upgradeRequired,true);
    assert.equal(policy.minimumClientVersion,'2.0.0');
    assert.match(policy.downloadUrl,/\/v2\.0\.0$/);
  }
  for (const version of [undefined,'0.7.0','0.8.0-rc.1','invalid']) {
    const policy=clientUpgradePolicy(version,'mobile',3);
    assert.equal(policy.upgradeRequired,true);
    assert.equal(policy.minimumClientVersion,'0.8.0');
    assert.equal(policy.releaseVersion,'0.8.0');
    assert.match(policy.downloadUrl,/\/mobile-v0\.8\.0$/);
    const error=clientUpgradeError(version,'mobile',3);
    assert.equal(error.code,'CLIENT_VERSION_TOO_OLD');
    assert.ok(error.error.includes(policy.downloadUrl));
  }
  assert.equal(clientUpgradePolicy('2.0.0+build.1','desktop',3).upgradeRequired,false);
  assert.equal(clientUpgradePolicy('0.8.0','mobile','3').upgradeRequired,false);
  for (const [version,platform,protocol] of [
    ['2.0.0','desktop',2],['0.8.0','mobile',2],['1.5.4','mobile',2],
    ['2.0.0',undefined,3],['2.0.0','unknown',3],['2.0.0','desktop',undefined],
    ['0.8.0','desktop',3],['0.7.0','mobile',3],
  ]) assert.equal(isClientIdentitySupported(version,platform,protocol),false);
});

test('HTTP identity prefers headers; query identity is opt-in for media URLs', () => {
  const req={get:(key:string)=>key==='x-cove-client-version'?'2.0.0':undefined,query:{client_version:'1.5.4',client_platform:'mobile',client_protocol:'2'}} as never;
  assert.deepEqual(requestClientIdentity(req),{version:'2.0.0',platform:undefined,protocol:undefined});
  assert.deepEqual(requestClientIdentity(req,true),{version:'2.0.0',platform:'mobile',protocol:'2'});
});

test('middleware rejects missing/old identities with a usable download URL, and accepts both current clients', () => {
  for(const version of [undefined,'1.5.4','2.0.0-rc.1']) {
    let continued=false,code=0,body:any,cache='';
    const req={get:(key:string)=>({'x-cove-client-version':version,'x-cove-client-platform':'desktop','x-cove-client-protocol':'3'} as Record<string,unknown>)[key]};
    const res={setHeader:(_key:string,value:string)=>{cache=value;},status:(value:number)=>{code=value;return res;},json:(value:unknown)=>{body=value;}};
    requireClientVersion(req as never,res as never,()=>{continued=true;});
    assert.equal(continued,false);assert.equal(code,426);assert.equal(cache,'no-store');
    assert.equal(body.code,'CLIENT_VERSION_TOO_OLD');assert.equal(body.upgradeRequired,true);
    assert.equal(body.requiredClientProtocol,3);
    assert.match(body.error,/https:\/\/github\.com\/LumineTraveller\/Cove\/releases\/tag\/v2\.0\.0/);
  }
  for (const [platform,version] of [['desktop','2.0.0'],['mobile','0.8.0']]) {
    let continued=false;
    const values:Record<string,string>={'x-cove-client-version':version,'x-cove-client-platform':platform,'x-cove-client-protocol':'3'};
    requireClientVersion({get:(key:string)=>values[key]} as never,{} as never,()=>{continued=true;});
    assert.equal(continued,true);
  }
});
