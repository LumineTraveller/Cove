// Build the real login App for isolated file:// Electron regression checks.
// Authentication modules stay real; the fixture lists unrelated UI stubs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const sourceRoot = path.resolve(__dirname, '../..');
const outputRoot = path.resolve(process.env.COVE_LOGIN_QA_BUILD || path.join(sourceRoot, '../../runtime/login-email-fixture'));
const sourceRequire = createRequire(path.join(sourceRoot, 'package.json'));
const { build } = sourceRequire('esbuild');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const portable = (name) => name.split(path.sep).join('/');
const sourceInfo = (name) => {
  const data = fs.readFileSync(path.join(sourceRoot, name));
  return { sha256: hash(data), bytes: data.length };
};

async function main() {
  const configFile = path.join(__dirname, 'login-email-stubs.cjs');
  const stubs = fs.existsSync(configFile) ? require(configFile) : {};
  const stubPaths = new Map(Object.entries(stubs).map(([name, contents]) => [path.resolve(sourceRoot, name), contents]));
  for (const name of Object.keys(stubs)) {
    if (!/^(?:src\/features\/(?:rooms|updates)\/|src\/features\/connection\/socket\.ts$)/.test(name)) {
      throw new Error(`Only unrelated UI and transport may be stubbed: ${name}`);
    }
  }
  const entry = 'tests/ui/login-email-fixture.tsx';
  const htmlEntry = 'tests/ui/login-email-fixture.html';
  const before = Object.fromEntries([
    entry, htmlEntry, 'src/app/App.tsx',
    'src/features/accounts/accountPasswordMemory.ts',
    'src/features/connection/serverSecurity.ts',
    ...(fs.existsSync(configFile) ? ['tests/ui/login-email-stubs.cjs'] : []),
  ].map((name) => [name, sourceInfo(name)]));
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [path.join(sourceRoot, entry)],
    tsconfig: path.join(sourceRoot, 'tsconfig.json'),
    outdir: outputRoot,
    entryNames: 'assets/[name]',
    assetNames: 'assets/[name]-[hash]',
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{"MODE":"test","PROD":false,"DEV":false,"BASE_URL":"./"}',
    },
    loader: { '.png': 'file', '.svg': 'file', '.webp': 'file', '.mp4': 'file', '.woff2': 'file' },
    plugins: [{
      name: 'login-unrelated-modules',
      setup(builder) {
        builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
          const contents = stubPaths.get(args.path);
          return contents === undefined ? undefined : { contents, loader: 'js', resolveDir: path.dirname(args.path) };
        });
        // Styling is irrelevant to input/effect behavior and would pull media
        // into this narrow regression. Production markup and hooks stay real.
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
      },
    }],
    logLevel: 'warning',
  });
  const sources = { ...before };
  for (const input of Object.keys(result.metafile.inputs)) {
    const relative = portable(path.relative(sourceRoot, path.resolve(sourceRoot, input)));
    if (!relative.startsWith('../') && !relative.split('/').includes('node_modules') && fs.existsSync(path.join(sourceRoot, relative))) {
      sources[relative] = sourceInfo(relative);
    }
  }
  for (const [name, info] of Object.entries(before)) {
    if (sourceInfo(name).sha256 !== info.sha256) throw new Error(`Source changed during fixture build: ${name}`);
  }
  const outputs = {};
  for (const output of result.outputFiles) {
    fs.mkdirSync(path.dirname(output.path), { recursive: true });
    fs.writeFileSync(output.path, output.contents);
    outputs[portable(path.relative(outputRoot, output.path))] = { sha256: hash(output.contents), bytes: output.contents.length };
  }
  const html = fs.readFileSync(path.join(sourceRoot, htmlEntry), 'utf8').replace(
    /<script\b[^>]*\bsrc=(["'])\.\/login-email-fixture\.tsx\1[^>]*>\s*<\/script>/i,
    '<script type="module" src="../../assets/login-email-fixture.js"></script>',
  );
  if (html.includes('./login-email-fixture.tsx')) throw new Error('Fixture entry script was not replaced');
  const htmlOutput = path.join(outputRoot, htmlEntry);
  fs.mkdirSync(path.dirname(htmlOutput), { recursive: true });
  fs.writeFileSync(htmlOutput, html);
  outputs[htmlEntry] = { sha256: hash(html), bytes: Buffer.byteLength(html) };
  const iconSource = 'public/assets/cove-icon.png';
  const icon = fs.readFileSync(path.join(sourceRoot, iconSource));
  const iconOutput = 'tests/ui/assets/cove-icon.png';
  fs.mkdirSync(path.join(outputRoot, 'tests/ui/assets'), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, iconOutput), icon);
  sources[iconSource] = sourceInfo(iconSource);
  outputs[iconOutput] = { sha256: hash(icon), bytes: icon.length };
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, builtAt: new Date().toISOString(), sourceRoot, outputRoot,
    fixture: htmlEntry, stubbedModules: Object.keys(stubs), sources, outputs,
  }, null, 2));
  console.log(`Login fixture: ${htmlOutput}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
