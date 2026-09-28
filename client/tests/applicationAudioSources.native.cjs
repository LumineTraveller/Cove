const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') { console.log('SKIP Windows application audio integration'); process.exit(0); }
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-audio-sources-test-'));
const fixture = path.join(directory, 'fixture.exe');
try {
  const build = spawnSync(compiler, [
    '/nologo', '/target:exe', '/platform:x64', '/main:ApplicationAudioSourcesNativeTests',
    `/out:${fixture}`, '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    path.resolve(__dirname, '../electron/application-audio-helper.cs'),
    path.join(__dirname, 'applicationAudioSources.native.cs'),
  ], { stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) throw new Error('Native fixture compilation failed');
  const result = spawnSync(fixture, [], { stdio: 'inherit', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw result.error || new Error('Native audio integration failed');
} finally {
  // Delete only the exact compiler outputs created in this fresh test directory.
  for (const name of ['fixture.exe', 'fixture.pdb']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(directory);
}
