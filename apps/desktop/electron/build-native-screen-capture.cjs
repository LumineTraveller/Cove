// Explicit opt-in build only. Does not install, package or run desktop capture.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Native screen capture requires Windows x64');
}
const args = process.argv.slice(2);
let output = path.resolve(__dirname, '../../../runtime/native-screen-capture/helper.exe');
let handlesOutput;
let selfTest = false;
let acquireMode;
for (let i = 0; i < args.length; ++i) {
  if (args[i] === '--output' && args[i + 1]) output = path.resolve(args[++i]);
  else if (args[i] === '--handles-output' && args[i + 1]) handlesOutput = path.resolve(args[++i]);
  else if (args[i] === '--self-test') selfTest = true;
  else if (args[i] === '--acquire-mode' && acquireMode === undefined &&
      (args[i + 1] === 'timeout' || args[i + 1] === 'poll')) acquireMode = args[++i];
  else throw new Error('Expected --output PATH, --handles-output PATH, --self-test and/or --acquire-mode timeout|poll');
}
handlesOutput ||= path.join(path.dirname(output), 'native-screen-handles.node');
if (path.resolve(output).toLowerCase() === path.resolve(handlesOutput).toLowerCase()) {
  throw new Error('Helper and handles outputs must differ');
}
const cache = path.join(process.env.LOCALAPPDATA || '', 'node-gyp', 'Cache');
const cachedVersions = fs.existsSync(cache) ? fs.readdirSync(cache)
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
const headerCandidates = [process.env.COVE_NATIVE_CAPTURE_NODE_INCLUDE,
  path.join(cache, process.versions.node, 'include', 'node'),
  ...cachedVersions.map(version => path.join(cache, version, 'include', 'node'))].filter(Boolean);
const nodeInclude = headerCandidates.find(candidate => fs.existsSync(path.join(candidate, 'node_api.h')));
if (!nodeInclude) throw new Error('Existing Node-API headers unavailable; nothing was downloaded');
const compiler = process.env.COVE_NATIVE_CAPTURE_CXX || 'C:\\Strawberry\\c\\bin\\g++.exe';
if (!fs.existsSync(compiler)) throw new Error('Existing native compiler unavailable; nothing was installed');
const target = spawnSync(compiler, ['-dumpmachine'], { encoding: 'utf8', windowsHide: true });
if (target.error) throw new Error(`Native compiler could not start: ${target.error.code || 'unknown'}`);
if (target.status !== 0 || target.stdout.trim() !== 'x86_64-w64-mingw32') {
  throw new Error('Native screen capture requires the existing x64 MinGW compiler');
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-static',
  ...(acquireMode === undefined ? [] : [`-DCOVE_NATIVE_CAPTURE_NONBLOCKING_ACQUIRE=${acquireMode === 'poll' ? 1 : 0}`]),
  path.join(__dirname, 'native-screen-capture-helper.cpp'), '-o', output,
  '-ld3d11', '-ld3dcompiler', '-ldxgi', '-lkernel32', '-luser32', '-lgdi32',
], { stdio: 'inherit', windowsHide: true });
if (result.error) throw new Error(`Native compiler could not start: ${result.error.code || 'unknown'}`);
if (result.status !== 0) throw new Error('Native screen capture compilation failed');
fs.mkdirSync(path.dirname(handlesOutput), { recursive: true });
const handles = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-shared', '-static', '-static-libgcc', '-static-libstdc++',
  '-I', nodeInclude, path.join(__dirname, 'native-screen-handles.cpp'), '-o', handlesOutput, '-lkernel32',
], { stdio: 'inherit', windowsHide: true });
if (handles.error) throw new Error(`Native handles compiler could not start: ${handles.error.code || 'unknown'}`);
if (handles.status !== 0) throw new Error('Native screen handles compilation failed');
if (selfTest) {
  // --self-test is CPU-only: algorithms, protocol state and HLSL compilation.
  const check = spawnSync(output, ['--self-test'], { stdio: 'inherit', windowsHide: true });
  if (check.error || check.status !== 0) throw new Error('Native screen capture self-test failed');
}
console.log(JSON.stringify({ output, selectedAcquireMode: acquireMode || 'poll', defaultCompletionPolicy: 'auto',
  helperSourceSha256: crypto.createHash('sha256').update(
    fs.readFileSync(path.join(__dirname, 'native-screen-capture-helper.cpp'))).digest('hex'),
  bytes: fs.statSync(output).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
  handlesOutput, handlesBytes: fs.statSync(handlesOutput).size,
  handlesSha256: crypto.createHash('sha256').update(fs.readFileSync(handlesOutput)).digest('hex') }));
