const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ServerCertificatePolicy,
  normalizeHttpsOrigin,
} = require('../dist-electron/server-certificate-policy.js');

test('normalizes only HTTPS origins', () => {
  assert.equal(normalizeHttpsOrigin('https://Example.com:51758/api/rooms'), 'https://example.com:51758');
  assert.equal(normalizeHttpsOrigin('http://example.com:51758'), null);
  assert.equal(normalizeHttpsOrigin('not a url'), null);
});

test('allows only the configured HTTPS host and port', () => {
  const policy = new ServerCertificatePolicy();
  assert.equal(policy.configure('https://frp.example.com:51758/path', true), 'https://frp.example.com:51758');
  assert.equal(policy.allows('https://frp.example.com:51758/api/rooms'), true);
  assert.equal(policy.allows('https://frp.example.com:51759/api/rooms'), false);
  assert.equal(policy.allows('https://other.example.com:51758/api/rooms'), false);
  assert.equal(policy.allows('http://frp.example.com:51758/api/rooms'), false);
});

test('disabling the policy clears the exception', () => {
  const policy = new ServerCertificatePolicy();
  policy.configure('https://frp.example.com:51758', true);
  policy.configure('https://frp.example.com:51758', false);
  assert.equal(policy.allows('https://frp.example.com:51758/api/rooms'), false);
});
