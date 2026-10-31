'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Build from this checkout before every Windows package, rather than accepting
// an old helper left in build/. The builder waits for this hook to finish.
module.exports = async function prepareNativeScreenCapture(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== 1) throw new Error('Native screen capture packages require Windows x64');
  const desktop = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, [
    path.join(desktop, 'electron', 'build-native-screen-capture.cjs'),
    '--output', path.join(desktop, 'build', 'native-screen-capture-helper.exe'),
    '--handles-output', path.join(desktop, 'build', 'native-screen-handles.node'),
    '--self-test',
  ], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`Native screen capture build could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error('Native screen capture build or CPU self-test failed');
};
