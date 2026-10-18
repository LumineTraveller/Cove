'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMBEDDED_MANIFEST_PATH = 'resources/cove-integrity.json';
const REQUIRED_FILES = [
  'Cove.exe', 'resources/app.asar',
  'resources/annotation-window-helper.exe', 'resources/remote-input-helper.exe',
  'resources/application-audio-helper.exe', 'resources/elevate.exe',
];
// Review new Electron payload names here instead of accidentally publishing
// arbitrary files from a reused output directory (including personal data).
const ELECTRON_ROOT_FILES = new Set([
  'cove.exe', 'chrome_crashpad_handler.exe', 'chrome_100_percent.pak',
  'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'ffmpeg.dll', 'icudtl.dat', 'libegl.dll', 'libglesv2.dll', 'license',
  'license.electron.txt', 'licenses.chromium.html', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
  'vulkan-1.dll', 'resources.pak', 'version',
]);
const RESOURCE_FILES = new Set(REQUIRED_FILES.slice(1).map(value => value.slice('resources/'.length)));
RESOURCE_FILES.add('app-update.yml');
RESOURCE_FILES.add('default_app.asar');
const MUTABLE_DIRECTORIES = new Set([
  '.cove', 'userdata', 'user-data', 'appdata', 'cache', 'caches', 'code cache',
  'gpucache', 'dawngraphitecache', 'dawnwebgpucache', 'crashpad', 'logs', 'network',
  'local storage', 'session storage', 'sessions', 'blob_storage', 'databases',
  'indexeddb', 'service worker', 'accounts', 'settings', 'chats', 'chat',
  'voicepacks', 'soundpacks', 'sound-packs',
]);
const MUTABLE_FILES = /^(?:uninstall.*\.exe|.*\.lnk|.*\.(?:log|sqlite|sqlite3|db)|(?:accounts?|settings|chats?)\.json)$/i;

function assertSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`Unsafe installation path: ${value}`);
  }
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 || /[\x00-\x1f\x7f:*?"<>|]/.test(segment) ||
        /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment) ||
        segment !== segment.normalize('NFC')) {
      throw new Error(`Unsafe installation path: ${value}`);
    }
  }
  return value;
}

function assertRegularPath(filePath, root, expectDirectory) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are forbidden: ${filePath}`);
  if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Unexpected installation file type: ${filePath}`);
  }
  if (!expectDirectory && stat.nlink !== 1) throw new Error(`Hard links are forbidden: ${filePath}`);
  const relative = path.relative(root, fs.realpathSync.native(filePath));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Installation path escapes the payload: ${filePath}`);
  }
  return stat;
}

function excluded(relative, directory) {
  const segments = relative.toLowerCase().split('/');
  if (relative.toLowerCase() === EMBEDDED_MANIFEST_PATH) return true;
  // User data must never be part of the version inventory. Application code in
  // app.asar.unpacked/node_modules is retained even if a dependency is named cache.
  if (segments.includes('.cove') || segments.includes('userdata') || segments.includes('user-data')) return true;
  const topLevel = segments.length === 1 || (segments[0] === 'resources' && segments.length === 2);
  return topLevel && (directory ? MUTABLE_DIRECTORIES.has(segments.at(-1)) : MUTABLE_FILES.test(segments.at(-1)));
}

function assertPayloadLocation(relative, directory) {
  const segments = relative.split('/');
  const first = segments[0].toLowerCase();
  if (segments.length === 1) {
    if (directory ? !['locales', 'resources'].includes(first) : !ELECTRON_ROOT_FILES.has(first)) {
      throw new Error(`Unexpected root payload entry (possible user data): ${relative}`);
    }
  } else if (first === 'resources' && segments.length === 2) {
    const name = segments[1];
    if (directory ? name !== 'app.asar.unpacked' : !RESOURCE_FILES.has(name)) {
      throw new Error(`Unexpected resource payload entry (possible user data): ${relative}`);
    }
  }
}

function assertX64Executable(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('Cove.exe is not a Windows PE executable');
    }
    const peOffset = header.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (peOffset < 64 || fs.readSync(fd, pe, 0, pe.length, peOffset) !== pe.length ||
        pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error('Installation integrity supports only the Windows x64 Cove.exe payload');
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function hashFile(filePath, expectedStat) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino ||
        stat.size !== expectedStat.size || stat.mtimeMs !== expectedStat.mtimeMs) {
      throw new Error(`Installation payload changed while reading: ${filePath}`);
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const after = await handle.stat();
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error(`Installation payload changed while hashing: ${filePath}`);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function assertWritableManifest(filePath, root) {
  assertRegularPath(path.dirname(filePath), root, true);
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assertRegularPath(filePath, root, false);
}

function validateRoots(appOutDir, outputDir) {
  const root = path.resolve(appOutDir);
  const output = path.resolve(outputDir);
  assertRegularPath(root, root, true);
  const outputRelative = path.relative(root, output);
  if (!outputRelative || (!path.isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith(`..${path.sep}`))) {
    throw new Error('Release manifest output must be outside the installation payload');
  }
  assertRegularPath(output, output, true);
  return { root, output };
}

async function generateInstallationIntegrity({ appOutDir, outputDir, version, platform, arch }) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Installation integrity supports only win32/x64, received ${platform}/${arch}`);
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Installation integrity requires an exact official release version');
  }
  const { root, output } = validateRoots(appOutDir, outputDir);

  const entries = [];
  const seen = new Set();
  function walk(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = assertSafeRelativePath(prefix ? `${prefix}/${name}` : name);
      const folded = relative.toLowerCase();
      if (seen.has(folded)) throw new Error(`Duplicate case-insensitive installation path: ${relative}`);
      seen.add(folded);
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are forbidden: ${relative}`);
      const directoryEntry = stat.isDirectory();
      assertRegularPath(absolute, root, directoryEntry);
      if (excluded(relative, directoryEntry)) continue;
      assertPayloadLocation(relative, directoryEntry);
      if (directoryEntry) walk(absolute, relative);
      else entries.push({ relative, absolute, stat });
    }
  }
  walk(root);
  for (const required of REQUIRED_FILES) {
    if (!entries.some(entry => entry.relative === required)) throw new Error(`Missing required version payload: ${required}`);
  }
  assertX64Executable(path.join(root, 'Cove.exe'));
  const files = [];
  for (const entry of entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)) {
    files.push({ path: entry.relative, ...await hashFile(entry.absolute, entry.stat) });
  }
  const manifest = { schemaVersion: 1, version, platform, arch, files };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const embeddedPath = path.join(root, ...EMBEDDED_MANIFEST_PATH.split('/'));
  const assetPath = path.join(output, `Cove-Integrity-${version}-win32-x64.json`);
  assertWritableManifest(embeddedPath, root);
  assertWritableManifest(assetPath, output);
  fs.writeFileSync(embeddedPath, serialized, 'utf8');
  fs.writeFileSync(assetPath, serialized, 'utf8');
  return { manifest, embeddedPath, assetPath };
}

// electron-builder 26.15.3 normally adds/signs elevate.exe only in packArch,
// after afterSign. Await the SAME memoized helper now, before inventorying the
// final payload. packArch's later copy is then a no-op. Keep the original helper
// and its signing behavior; do not disable NSIS elevation to simplify hashing.
// A changed builder contract fails this hook instead of publishing stale hashes.
async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== 1 && context.arch !== 'x64') {
    throw new Error(`Installation integrity supports only win32/x64, received win32/${context.arch}`);
  }
  const targets = context.targets.filter(target => target.name === 'nsis');
  if (targets.length !== 1 || typeof targets[0].packageHelper?.elevateHelper?.copy !== 'function') {
    throw new Error('Installation integrity requires the supported electron-builder NSIS elevate helper');
  }
  // CopyElevateHelper writes before generation begins: validate its destination
  // first so an existing resources/elevate link cannot redirect that write.
  const { root } = validateRoots(context.appOutDir, context.outDir);
  assertWritableManifest(path.join(root, 'resources', 'elevate.exe'), root);
  await targets[0].packageHelper.elevateHelper.copy(context.appOutDir, targets[0]);
  const arch = context.arch === 1 || context.arch === 'x64' ? 'x64' : String(context.arch);
  const result = await generateInstallationIntegrity({
    appOutDir: context.appOutDir,
    outputDir: context.outDir,
    version: context.packager.appInfo.version,
    platform: context.electronPlatformName,
    arch,
  });
  console.log(`Generated installation integrity manifest: ${path.basename(result.assetPath)} (${result.manifest.files.length} files)`);
}

module.exports = afterSign;
module.exports.generateInstallationIntegrity = generateInstallationIntegrity;
module.exports.assertSafeRelativePath = assertSafeRelativePath;
module.exports.EMBEDDED_MANIFEST_PATH = EMBEDDED_MANIFEST_PATH;
