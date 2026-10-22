const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LEGACY_SIGNER_SHA256, FIELD_NAMES, signingConfiguration, verifyCertificateReport, main } = require('../apps/mobile/scripts/verify-signing.cjs');

function external(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-signing-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture-not-a-key.jks');
  fs.writeFileSync(file, 'not key material: only filesystem validation');
  return {
    COVE_ANDROID_SIGNING_MODE: 'external', COVE_ANDROID_STORE_FILE: file,
    COVE_ANDROID_STORE_PASSWORD: 'fixture-password', COVE_ANDROID_KEY_ALIAS: 'fixture-alias',
    COVE_ANDROID_KEY_PASSWORD: 'fixture-password', COVE_ANDROID_EXPECTED_SIGNER_SHA256: 'a'.repeat(64),
  };
}
const report = (digest = LEGACY_SIGNER_SHA256) => `Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ${digest}\n`;

test('default signing keeps the existing published identity and ignores unused credentials', () => {
  assert.deepEqual(signingConfiguration({ COVE_ANDROID_STORE_PASSWORD: 'unused-secret' }), { mode: 'legacy', expectedSigner: LEGACY_SIGNER_SHA256 });
  assert.deepEqual(main([], {}), { mode: 'legacy', certificateVerified: false, migrationPerformed: false });
});

test('external signing is explicit and never returns password, alias or keystore path', t => {
  const env = external(t);
  const result = signingConfiguration(env);
  assert.deepEqual(result, { mode: 'external', expectedSigner: 'a'.repeat(64) });
  const output = JSON.stringify(main([], env));
  for (const field of ['STORE_PASSWORD', 'KEY_PASSWORD', 'KEY_ALIAS', 'STORE_FILE']) assert.ok(!output.includes(env[`COVE_ANDROID_${field}`]));
  assert.throws(() => signingConfiguration({ COVE_ANDROID_SIGNING_MODE: 'automatic' }), /must be legacy or external/);
});

for (const field of FIELD_NAMES) test(`external signing rejects missing ${field} without exposing values`, t => {
  const env = external(t);
  delete env[`COVE_ANDROID_${field}`];
  assert.throws(() => signingConfiguration(env), { message: `Missing COVE_ANDROID_${field} for external signing` });
});

test('external preflight rejects invalid paths and malformed expected certificates', t => {
  const env = external(t);
  assert.throws(() => signingConfiguration({ ...env, COVE_ANDROID_STORE_FILE: 'relative.jks' }), /absolute keystore/);
  assert.throws(() => signingConfiguration({ ...env, COVE_ANDROID_STORE_FILE: path.dirname(env.COVE_ANDROID_STORE_FILE) }), /absolute keystore/);
  assert.throws(() => signingConfiguration({ ...env, COVE_ANDROID_EXPECTED_SIGNER_SHA256: 'not-a-digest' }), /64 hexadecimal/);
});

test('certificate verification requires successful verification, one signer and exact SHA256', () => {
  assert.equal(verifyCertificateReport(report(), LEGACY_SIGNER_SHA256), true);
  assert.equal(verifyCertificateReport(report(LEGACY_SIGNER_SHA256.toUpperCase()), LEGACY_SIGNER_SHA256), true);
  assert.throws(() => verifyCertificateReport(report('b'.repeat(64)), LEGACY_SIGNER_SHA256), /does not match/);
  assert.throws(() => verifyCertificateReport(report().replace('Verifies', 'DOES NOT VERIFY'), LEGACY_SIGNER_SHA256), /did not succeed/);
  assert.throws(() => verifyCertificateReport(report().replace('signers: 1', 'signers: 2'), LEGACY_SIGNER_SHA256), /exactly one/);
  assert.throws(() => verifyCertificateReport(report() + report(), LEGACY_SIGNER_SHA256), /exactly one/);
});

test('Gradle and the preflight use the same explicit modes/field names; published workflow stays pinned', () => {
  const gradle = fs.readFileSync(path.join(__dirname, '../apps/mobile/android/signing-config.gradle'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../apps/mobile/android/app/build.gradle'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-mobile.yml'), 'utf8');
  for (const field of FIELD_NAMES) assert.ok(gradle.includes(`'${field}'`));
  assert.match(gradle, /System\.getenv\('COVE_ANDROID_SIGNING_MODE'\) \?: 'legacy'/);
  assert.match(app, /signingConfig\(coveSigningMode == 'external' \? signingConfigs\.external : signingConfigs\.debug\)/);
  assert.match(workflow, new RegExp(LEGACY_SIGNER_SHA256));
  assert.doesNotMatch(workflow, /COVE_ANDROID_SIGNING_MODE.*external/);
});
