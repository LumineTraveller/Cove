'use strict';

// Keep local and CI gates identical. No install, packaging, release or deployment
// commands belong here; dependency installation is an explicit workflow step.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const suites = ['server', 'desktop', 'mobile'];
const testFiles = (directory, suffix) => {
  const files = fs.readdirSync(path.join(root, directory))
    .filter(name => name.endsWith(suffix)).sort();
  if (!files.length) throw new Error(`No ${suffix} tests found in ${directory}`);
  return files.map(name => path.posix.join('tests', name));
};
const tsc = (cwd, project, emit = false) => ({
  name: `${cwd}/${project}${emit ? ' build' : ' typecheck'}`,
  cwd,
  args: [require.resolve('typescript/bin/tsc', { paths: [path.join(root, cwd)] }),
    ...(emit ? [] : ['--noEmit']), '-p', project],
});

function buildPlan(suite) {
  if (!suites.includes(suite)) throw new Error(`Expected one suite: ${suites.join(', ')}`);
  const steps = ['contracts', 'client-core', 'media-core', 'diagnostics']
    .map(name => tsc(`packages/${name}`, 'tsconfig.json', true));
  if (suite === 'server') {
    steps.push(
      { name: 'shared core tests', cwd: 'packages/client-core', args: ['--import', 'tsx', '--test', '--test-concurrency=1',
        ...testFiles('packages/client-core/tests', '.test.ts')] },
      { name: 'architecture and CI contracts', cwd: '.', args: ['--test',
        ...testFiles('tests', '.test.cjs')] },
      tsc('apps/server', 'tsconfig.build.json', true),
      tsc('apps/server', 'electron/tsconfig.json'),
      { name: 'server tests (loopback/synthetic integration included)', cwd: 'apps/server', args: ['--import', 'tsx', '--test', '--test-concurrency=1',
        ...testFiles('apps/server/tests', '.test.ts')] },
      { name: 'server native runtime contracts', cwd: 'apps/server', args: ['--test', '--test-concurrency=1',
        ...testFiles('apps/server/tests', '.test.cjs')] },
      { name: 'real SQLite/SFU runtime smoke', cwd: '.', args: ['tooling/runtime-smoke.cjs'] },
    );
  } else if (suite === 'desktop') {
    steps.push(
      tsc('apps/desktop', 'tsconfig.json'),
      // CJS adapter tests import dist-electron. Compile TS without rebuilding
      // better-sqlite3 for Electron, which would invalidate Node's runtime tests.
      tsc('apps/desktop', 'electron/tsconfig.json', true),
      { name: 'desktop TS tests (isolated processes, desktop JSX config)', cwd: 'apps/desktop', args: ['--import', 'tsx', '--test', '--test-concurrency=1',
        ...testFiles('apps/desktop/tests', '.test.ts')] },
      { name: 'desktop CJS adapter tests', cwd: 'apps/desktop', args: ['--test', '--test-concurrency=1',
        ...testFiles('apps/desktop/tests', '.test.cjs')] },
    );
  } else {
    steps.push(
      tsc('apps/mobile', 'tsconfig.json'),
      { name: 'mobile Jest tests (native boundaries mocked)', cwd: 'apps/mobile',
        args: ['node_modules/jest/bin/jest.js', '--runInBand', '--no-cache'] },
    );
  }
  return steps;
}

function runPlan(steps, spawn = spawnSync) {
  for (const step of steps) {
    console.log(`\n[regression] ${step.name}`);
    const result = spawn(process.execPath, step.args, {
      cwd: path.join(root, step.cwd), stdio: 'inherit', shell: false,
      windowsHide: true, timeout: 10 * 60_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${step.name} failed: ${result.error?.message ?? `exit ${result.status ?? result.signal ?? 'unknown'}`}`);
    }
  }
}

if (require.main === module) {
  try {
    const [suite, flag, ...extra] = process.argv.slice(2);
    if (extra.length || (flag && flag !== '--plan')) throw new Error('Usage: node tooling/ci-regression.cjs <server|desktop|mobile> [--plan]');
    const plan = buildPlan(suite);
    if (flag === '--plan') console.log(JSON.stringify(plan, null, 2));
    else runPlan(plan);
  } catch (error) {
    console.error(`[regression] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildPlan, runPlan };
