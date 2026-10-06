const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') process.exit(0);
const windowsDir = process.env.WINDIR || 'C:\\Windows';
const compiler = ['Framework64', 'Framework'].map(framework =>
  path.join(windowsDir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'),
).find(fs.existsSync);
if (!compiler) throw new Error('未找到 Windows C# 编译器，无法构建应用音频枚举组件');
const outputDir = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(outputDir, { recursive: true });
const result = spawnSync(compiler, [
  '/nologo', '/target:exe', '/optimize+', '/platform:x64',
  `/out:${path.join(outputDir, 'application-audio-helper.exe')}`,
  '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll',
  path.join(__dirname, 'application-audio-helper.cs'),
], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`应用音频枚举组件构建失败（${result.status ?? 'unknown'}）`);
