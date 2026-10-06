import assert from 'node:assert/strict';
import test from 'node:test';
import {compareSemanticVersions, isSupportedClientVersion} from '@cove/contracts';

test('2.0.0 gate uses semantic precedence, including prerelease and build metadata', () => {
  for (const version of ['0.7.0','1.9.9','1.10.0','2.0.0-rc.1','2.0.0-beta.10']) assert.equal(isSupportedClientVersion(version),false,version);
  for (const version of ['2.0.0','2.0.0+build.123','2.0.1','2.10.0','10.0.0']) assert.equal(isSupportedClientVersion(version),true,version);
  for (const version of [undefined,null,2,'','v2.0.0','2.0','02.0.0','2.0.0-01','2.0.0+','2.0.0\n','9007199254740992.0.0']) assert.equal(isSupportedClientVersion(version),false,String(version));
});

test('semver ordering is numeric for core and prerelease identifiers', () => {
  const order=['1.9.9','1.10.0','2.0.0-alpha','2.0.0-alpha.1','2.0.0-alpha.beta','2.0.0-beta','2.0.0-beta.2','2.0.0-beta.11','2.0.0-rc.1','2.0.0'];
  for(let index=1;index<order.length;index++) {
    assert.equal(compareSemanticVersions(order[index-1],order[index]),-1);
    assert.equal(compareSemanticVersions(order[index],order[index-1]),1);
  }
  assert.equal(compareSemanticVersions('2.0.0+build.1','2.0.0+build.2'),0);
  assert.equal(compareSemanticVersions('not-a-version','2.0.0'),null);
});
