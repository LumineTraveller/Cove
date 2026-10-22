'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const serverRoot = path.resolve(__dirname, '..');

function pinnedVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error('The Electron target must be an exact stable version');
  return value;
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPrivateModuleDirectory(repositoryRoot, moduleDirectory, realpath = fs.realpathSync) {
  const realRoot = realpath(repositoryRoot);
  const realModule = realpath(moduleDirectory);
  if (!isWithin(realRoot, realModule))
    throw new Error('Refusing to rebuild a linked native dependency outside this checkout. Use a real, isolated dependency copy.');
  return realModule;
}

function assertCandidateModuleDirectory(repositoryRoot, moduleDirectory, realpath = fs.realpathSync) {
  const realRoot = realpath(repositoryRoot);
  const realModule = assertPrivateModuleDirectory(repositoryRoot, moduleDirectory, realpath);
  const runtime = path.join(realRoot, 'runtime');
  const realRuntime = realpath(runtime);
  if (path.relative(runtime, realRuntime) !== '' || !isWithin(realRuntime, realModule))
    throw new Error('Candidate native rebuilds must target a real isolated copy under runtime/, not linked application dependencies.');
  return realModule;
}

function createPlan({ candidate = false, moduleDirectory, platform = process.platform, arch = process.arch } = {}) {
  const manifest = require('../package.json');
  const candidateManifest = require('../electron/runtime-candidate.json');
  const electron = pinnedVersion(candidate ? candidateManifest.electron : manifest.devDependencies.electron);
  if (candidate && require('../../desktop/package.json').devDependencies.electron !== electron)
    throw new Error('The candidate no longer matches the reviewed desktop runtime');
  const modulePath = moduleDirectory ? path.resolve(moduleDirectory) : path.dirname(require.resolve('better-sqlite3/package.json', { paths: [serverRoot] }));
  const nativeManifest = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json'), 'utf8'));
  if (nativeManifest.name !== 'better-sqlite3') throw new Error('The native module directory must contain better-sqlite3');
  const installer = require.resolve('prebuild-install/bin.js', { paths: [modulePath, root] });
  return {
    candidate,
    electron,
    moduleDirectory: modulePath,
    command: process.execPath,
    args: [installer, '-r', 'electron', '-t', electron, '--arch', arch, '--platform', platform],
  };
}

function parseArguments(args) {
  const result = { command: args[0] ?? 'plan' };
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--candidate') result.candidate = true;
    else if (args[index] === '--module-dir' || args[index] === '--electron') {
      const key = args[index] === '--module-dir' ? 'moduleDirectory' : 'executable';
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${args[index]}`);
      result[key] = args[++index];
    } else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return result;
}

function run(args, spawn = spawnSync) {
  const options = parseArguments(args);
  const plan = createPlan(options);
  if (options.command === 'plan') {
    // Paths and versions only; no native writes, downloads or package installation.
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  if (options.command === 'rebuild') {
    if (plan.candidate) assertCandidateModuleDirectory(root, plan.moduleDirectory);
    else assertPrivateModuleDirectory(root, plan.moduleDirectory);
    const result = spawn(plan.command, plan.args, { cwd: plan.moduleDirectory, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  if (options.command !== 'check') throw new Error('Expected plan, check or rebuild');
  const executable = options.executable ?? require(options.candidate ? '../../desktop/node_modules/electron' : 'electron');
  const result = spawn(executable, [path.join(__dirname, 'runtime-probe.cjs'), plan.electron, plan.moduleDirectory], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', shell: false, timeout: 15_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = String(result.stdout ?? '').trim().split(/\r?\n/).findLast(line => line.startsWith('{'));
  if (!output) throw new Error('Runtime probe did not return a result');
  const probe = JSON.parse(output);
  const destination = path.join(root, 'runtime', 'server-runtime', `${plan.electron}-${process.platform}-${process.arch}.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(probe, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
  return probe.ok && result.status === 0 ? 0 : 2;
}

module.exports = { pinnedVersion, isWithin, assertPrivateModuleDirectory, assertCandidateModuleDirectory, createPlan, parseArguments, run };
if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
