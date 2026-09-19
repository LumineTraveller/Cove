import {
  canonicalAddressSet,
  canonicalIPv6,
  resolveServerIdentity,
} from '../src/serverIdentity';

test('canonicalizes IPv6 and produces a deterministic address-set key', () => {
  expect(canonicalIPv6('2001:0DB8:0:0:0:0:2:1')).toBe('2001:db8::2:1');
  expect(canonicalAddressSet(['192.0.2.4', '192.000.002.004', '::1', '0:0:0:0:0:0:0:1']))
    .toEqual(['192.0.2.4', '::1']);
});

test('merges a resolved domain with its IP alias without changing either URL', async () => {
  const domain = await resolveServerIdentity('http://cove.example:3001', async () => ['192.0.2.4']);
  const address = await resolveServerIdentity('http://192.0.2.4:3001', async () => []);
  expect(domain.originalUrl).toBe('http://cove.example:3001');
  expect(address.originalUrl).toBe('http://192.0.2.4:3001');
  expect(domain.key).toBe(address.key);
});

test('does not merge resolved servers that use different endpoints', async () => {
  const resolve = async () => ['192.0.2.4'];
  const first = await resolveServerIdentity('https://cove.example/base', resolve);
  const otherPort = await resolveServerIdentity('https://cove.example:8443/base', resolve);
  const otherPath = await resolveServerIdentity('https://cove.example/other', resolve);
  expect(first.key).not.toBe(otherPort.key);
  expect(first.key).not.toBe(otherPath.key);
});
