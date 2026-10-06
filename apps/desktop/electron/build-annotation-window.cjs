const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') process.exit(0);
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const output = path.join(__dirname, '../build/annotation-window-helper.exe');
fs.mkdirSync(path.dirname(output), {recursive:true});
const result = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64', `/out:${output}`,
  path.join(__dirname, 'annotation-window-helper.cs')], {stdio:'inherit', windowsHide:true});
if (result.status !== 0) throw new Error('窗口批注定位组件构建失败');
