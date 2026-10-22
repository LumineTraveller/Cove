'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LEGACY_SIGNER_SHA256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
const FIELD_NAMES = ['STORE_FILE', 'STORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD', 'EXPECTED_SIGNER_SHA256'];

function signingConfiguration(env = process.env) {
  const mode = env.COVE_ANDROID_SIGNING_MODE || 'legacy';
  if (mode !== 'legacy' && mode !== 'external') throw new Error('COVE_ANDROID_SIGNING_MODE must be legacy or external');
  if (mode === 'legacy') return { mode, expectedSigner: LEGACY_SIGNER_SHA256 };
  for (const name of FIELD_NAMES) {
    if (typeof env[`COVE_ANDROID_${name}`] !== 'string' || !env[`COVE_ANDROID_${name}`].trim())
      throw new Error(`Missing COVE_ANDROID_${name} for external signing`);
  }
  const keystore = env.COVE_ANDROID_STORE_FILE;
  if (!path.isAbsolute(keystore) || !fs.existsSync(keystore) || !fs.statSync(keystore).isFile())
    throw new Error('External signing requires an existing absolute keystore file');
  const legacyStore = path.resolve(__dirname, '../android/app/debug.keystore');
  if (fs.existsSync(legacyStore) && fs.realpathSync(keystore) === fs.realpathSync(legacyStore))
    throw new Error('External signing cannot select the legacy debug keystore');
  if (!/^[a-f0-9]{64}$/i.test(env.COVE_ANDROID_EXPECTED_SIGNER_SHA256))
    throw new Error('COVE_ANDROID_EXPECTED_SIGNER_SHA256 must contain 64 hexadecimal characters');
  // Deliberately omit passwords, alias and keystore location from the result/logs.
  return { mode, expectedSigner: env.COVE_ANDROID_EXPECTED_SIGNER_SHA256.toLowerCase() };
}

function verifyCertificateReport(report, expectedSigner) {
  if (!/^Verifies\s*$/m.test(report) || /^(?:DOES NOT VERIFY|ERROR:)/m.test(report))
    throw new Error('APK signature verification did not succeed');
  const counts = [...report.matchAll(/^Number of signers:\s*(\d+)\s*$/gm)];
  const digests = [...report.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gim)];
  if (counts.length !== 1 || counts[0][1] !== '1' || digests.length !== 1)
    throw new Error('Expected exactly one APK signer in the apksigner verification report');
  if (digests[0][1].toLowerCase() !== expectedSigner.toLowerCase())
    throw new Error('APK signer does not match the explicitly expected certificate');
  return true;
}

function main(args, env = process.env) {
  const configuration = signingConfiguration(env);
  if (args.length && (args.length !== 2 || args[0] !== '--report'))
    throw new Error('Usage: node scripts/verify-signing.cjs [--report apksigner-report.txt]');
  if (args.length) verifyCertificateReport(fs.readFileSync(args[1], 'utf8'), configuration.expectedSigner);
  return { mode: configuration.mode, certificateVerified: args.length > 0, migrationPerformed: false };
}

module.exports = { LEGACY_SIGNER_SHA256, FIELD_NAMES, signingConfiguration, verifyCertificateReport, main };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
