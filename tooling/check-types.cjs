const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
let failed = false;
for (const app of process.argv.slice(2).length ? process.argv.slice(2) : ['desktop', 'server', 'mobile']) {
  const dir = path.join(root, 'apps', app);
  const cfg = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir, {}, path.join(dir, 'tsconfig.json'));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const unused = diagnostics.filter(d => [6133, 6192, 6196, 6198].includes(d.code));
  console.log(`${app}: ${diagnostics.length} errors, ${unused.length} unused declarations.`);
  const host = {getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n'};
  console.log(ts.formatDiagnostics(diagnostics.filter(d => !unused.includes(d)), host));
  if (unused.length) console.log(ts.formatDiagnostics(unused.slice(0, 20), host));
  failed ||= diagnostics.length > 0;
}
process.exitCode = failed ? 1 : 0;
