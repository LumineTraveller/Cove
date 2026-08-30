const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') process.exit(0);

const projectDir = path.resolve(__dirname, '..');
const windowsDir = process.env.WINDIR || 'C:\\Windows';
const candidates = [
  path.join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windowsDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const compiler = candidates.find(fs.existsSync);
if (!compiler) throw new Error('未找到 Windows C# 编译器，无法构建远程输入辅助程序');

const source = path.join(__dirname, 'remote-input-helper.cs');
const outputDir = path.join(projectDir, 'build');
const output = path.join(outputDir, 'remote-input-helper.exe');
fs.mkdirSync(outputDir, { recursive: true });
const result = spawnSync(compiler, [
  '/nologo', '/target:exe', '/optimize+', '/platform:x64',
  `/out:${output}`,
  '/reference:System.Web.Extensions.dll',
  '/reference:System.Windows.Forms.dll',
  source,
], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`远程输入辅助程序构建失败（${result.status ?? 'unknown'}）`);
