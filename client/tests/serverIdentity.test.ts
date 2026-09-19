import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAddressSet,
  canonicalIPv4,
  canonicalIPv6,
  resolveServerIdentity,
} from '../src/serverIdentity';

test('canonicalizes, deduplicates, and sorts IPv4 and IPv6 addresses', () => {
  assert.equal(canonicalIPv4('001.002.003.004'), '1.2.3.4');
  assert.equal(canonicalIPv4('256.2.3.4'), null);
  assert.equal(canonicalIPv6('2001:0DB8:0:0:0:0:2:1'), '2001:db8::2:1');
  assert.equal(canonicalIPv6('::'), '::');
  assert.equal(canonicalIPv6('::ffff:192.0.2.1'), '::ffff:c000:201');
  assert.deepEqual(canonicalAddressSet([
    '2001:0db8::1', '192.0.2.1', '192.000.002.001', '2001:db8:0:0:0:0:0:1', 'invalid',
  ]), ['192.0.2.1', '2001:db8::1']);
});

test('keeps the original connection URL while using the resolved IP set as the history key', async () => {
  const domain = await resolveServerIdentity('https://cove.example/', async () => ['192.0.2.1']);
  const alias = await resolveServerIdentity('http://192.0.2.1:3001', async () => []);
  assert.equal(domain.originalUrl, 'https://cove.example');
  assert.equal(alias.originalUrl, 'http://192.0.2.1:3001');
  assert.equal(domain.key, alias.key);
  assert.equal(domain.key, 'ip:192.0.2.1');
});

test('falls back to a host/port/path identity when DNS is unavailable', async () => {
  const identity = await resolveServerIdentity('https://cove.example/base/', async () => []);
  assert.equal(identity.key, 'host:cove.example:443/base');
  assert.deepEqual(identity.addresses, []);
});
