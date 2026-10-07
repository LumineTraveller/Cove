// Build the production sound-pack panel for offline file:// Electron QA.
// Keep this independent of Vite and Electron plugins: it needs no dev server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const sourceRoot = path.resolve(process.env.COVE_UI_QA_SOURCE || path.join(__dirname, '../..'));
const outDir = path.resolve(process.env.COVE_UI_QA_BUILD || path.join(__dirname, '../../../../runtime/soundpack-groups-fixture'));
const sourceRequire = createRequire(path.join(sourceRoot, 'package.json'));
const { build } = sourceRequire('esbuild');
const postcss = sourceRequire('postcss');
const tailwindcss = sourceRequire('tailwindcss');
const autoprefixer = sourceRequire('autoprefixer');
const fixtureName = 'soundpack-groups-fixture';
const fixturePath = `tests/ui/${fixtureName}.html`;
const entryPath = `tests/ui/${fixtureName}.tsx`;
const manifestPath = path.join(outDir, 'manifest.json');
const assetPattern = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|mp4|webm|wasm)(?:\?url)?$/i;
const portable = (value) => value.split(path.sep).join('/');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sourceHash(relativePath) {
  const contents = fs.readFileSync(path.join(sourceRoot, relativePath));
  return { sha256: sha256(contents), bytes: contents.length };
}

function packageVersion(name) {
  try {
    return sourceRequire(`${name}/package.json`).version;
  } catch {
    return null;
  }
}

function relativeAsset(htmlPath, assetPath) {
  const relative = portable(path.relative(path.dirname(htmlPath), assetPath));
  return relative.startsWith('.') ? relative : `./${relative}`;
}

async function main() {
  const trackedSources = [
    fixturePath,
    entryPath,
    'src/features/soundpacks/components/SoundPackPanel.tsx',
    'src/features/soundpacks/useSoundpackGroups.ts',
    'src/features/soundpacks/soundpackGroups.ts',
    'src/styles/index.css',
    'src/styles/ui-v2.css',
    'tailwind.config.js',
    'postcss.config.js',
  ];
  const before = Object.fromEntries(trackedSources.map((file) => [file, sourceHash(file)]));
  const sourceHtml = fs.readFileSync(path.join(sourceRoot, fixturePath), 'utf8');
  const entryScript = /<script\b[^>]*\bsrc=(["'])\.\/soundpack-groups-fixture\.tsx\1[^>]*>\s*<\/script>/gi;
  if ([...sourceHtml.matchAll(entryScript)].length !== 1) {
    throw new Error(`Expected one module script for ./${fixtureName}.tsx in ${fixturePath}`);
  }

  const tailwindConfig = sourceRequire(path.join(sourceRoot, 'tailwind.config.js'));
  const contentConfig = tailwindConfig.content || [];
  const contentFiles = Array.isArray(contentConfig) ? contentConfig : contentConfig.files || [];
  const absoluteContentFiles = contentFiles.map((file) => typeof file === 'string'
    ? portable(path.resolve(sourceRoot, file))
    : file);
  const content = {
    ...(Array.isArray(contentConfig) ? {} : contentConfig),
    relative: false,
    files: [...absoluteContentFiles, portable(path.join(sourceRoot, entryPath)), portable(path.join(sourceRoot, fixturePath))],
  };

  const importedAssets = new Map();
  const importedAssetSources = new Set();
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [path.join(sourceRoot, entryPath)],
    tsconfig: path.join(sourceRoot, 'tsconfig.json'),
    outdir: outDir,
    entryNames: 'assets/[name]',
    assetNames: 'assets/[name]-[hash]',
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    jsx: 'automatic',
    minify: false,
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false,"BASE_URL":"./"}',
    },
    loader: {
      '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file',
      '.webp': 'file', '.avif': 'file', '.svg': 'file', '.ico': 'file',
      '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.otf': 'file', '.eot': 'file',
      '.mp3': 'file', '.wav': 'file', '.ogg': 'file', '.m4a': 'file',
      '.mp4': 'file', '.webm': 'file', '.wasm': 'file',
    },
    plugins: [{
      name: 'offline-file-assets',
      setup(builder) {
        builder.onResolve({ filter: assetPattern }, (args) => {
          const request = args.path.replace(/\?url$/, '');
          let filePath = path.resolve(args.resolveDir, request);
          if (!fs.existsSync(filePath) && /^(?:\/?(?:\.\.\/|\.\/)*assets\/)/.test(request)) {
            const assetPath = request.replace(/^\/?(?:\.\.\/|\.\/)*assets\//, '');
            const publicPath = path.resolve(sourceRoot, 'public/assets', assetPath);
            const publicRelative = path.relative(path.join(sourceRoot, 'public/assets'), publicPath);
            if (!publicRelative.startsWith('..') && !path.isAbsolute(publicRelative)) filePath = publicPath;
          }
          if (!fs.existsSync(filePath)) return;
          // CSS URLs retain esbuild's native file loader. JS imports use
          // import.meta.url so a nested HTML document cannot shift the asset.
          return { path: filePath, ...(args.kind === 'url-token' ? {} : { namespace: 'offline-file-asset' }) };
        });
        builder.onLoad({ filter: /.*/, namespace: 'offline-file-asset' }, (args) => {
          const contents = fs.readFileSync(args.path);
          const extension = path.extname(args.path);
          const name = `${path.basename(args.path, extension)}-${sha256(contents).slice(0, 8)}${extension}`;
          importedAssets.set(path.join(outDir, 'assets', name), contents);
          importedAssetSources.add(args.path);
          return { loader: 'js', contents: `export default new URL(${JSON.stringify(`./${name}`)}, import.meta.url).href;` };
        });
      },
    }],
    logLevel: 'warning',
  });

  const generated = new Map(importedAssets);
  for (const output of result.outputFiles) {
    let contents = output.contents;
    if (output.path.endsWith('.css')) {
      // esbuild has already bundled @imports and made url() paths relative to
      // this CSS file. Processing that result preserves its offline assets.
      const processed = await postcss([
        tailwindcss({ ...tailwindConfig, content }),
        autoprefixer(),
      ]).process(output.text, { from: output.path, to: output.path, map: false });
      for (const warning of processed.warnings()) console.warn(warning.toString());
      contents = Buffer.from(processed.css);
    }
    generated.set(output.path, contents);
  }

  const htmlOutput = path.join(outDir, fixturePath);
  const jsOutput = path.join(outDir, 'assets', `${fixtureName}.js`);
  const cssOutput = path.join(outDir, 'assets', `${fixtureName}.css`);
  if (!generated.has(jsOutput) || !generated.has(cssOutput)) {
    throw new Error('The fixture must emit JavaScript and import the production CSS.');
  }
  let html = sourceHtml.replace(entryScript, `<script type="module" src="${relativeAsset(htmlOutput, jsOutput)}"></script>`);
  html = html.replace(/<\/head>/i, `    <link rel="stylesheet" href="${relativeAsset(htmlOutput, cssOutput)}" />\n  </head>`);
  if (!html.includes('rel="stylesheet"')) throw new Error(`Missing </head> in ${fixturePath}`);
  generated.set(htmlOutput, Buffer.from(html));

  const sources = { ...before };
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = path.resolve(sourceRoot, input);
    const relative = portable(path.relative(sourceRoot, absolute));
    if (!relative.startsWith('../') && !relative.split('/').includes('node_modules') && fs.existsSync(absolute)) {
      sources[relative] = sourceHash(relative);
    }
  }
  for (const absolute of importedAssetSources) {
    const relative = portable(path.relative(sourceRoot, absolute));
    if (!relative.startsWith('../')) sources[relative] = sourceHash(relative);
  }
  for (const [file, original] of Object.entries(before)) {
    if (sourceHash(file).sha256 !== original.sha256) {
      throw new Error(`Source changed during the build; rerun the fixture builder: ${file}`);
    }
  }

  const outputs = {};
  for (const [file, contents] of generated) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    outputs[portable(path.relative(outDir, file))] = { sha256: sha256(contents), bytes: contents.length };
  }
  const manifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    sourceRoot,
    outputRoot: outDir,
    fixture: fixturePath,
    builder: 'esbuild + postcss + tailwindcss + autoprefixer',
    packageVersions: Object.fromEntries(['esbuild', 'postcss', 'tailwindcss', 'autoprefixer', 'react', 'react-dom', 'lucide-react', 'electron']
      .map((name) => [name, packageVersion(name)])),
    sources,
    outputs,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('QA fixture:', htmlOutput);
  console.log('Source manifest:', manifestPath);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
