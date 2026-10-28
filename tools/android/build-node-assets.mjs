#!/usr/bin/env node
// Prepares the Node side of the Android app:
//
//   repo root ──esbuild──> android/app/src/main/assets/nodejs-project/app.mjs
//   public/            ──> android/app/src/main/assets/nodejs-project/public/
//   config.json        ──> android/app/src/main/assets/nodejs-project/config.json
//   tools/android/node-main.js ──> android/app/src/main/assets/nodejs-project/main.js
//
// The embedded runtime is nodejs-mobile 18.20.4 (libnode.so), which is built
// with `--with-intl=none`: the two shims in this folder restore the GBK decoder
// and the time-zone aware Intl.DateTimeFormat that the server depends on.
//
// Usage: node tools/android/build-node-assets.mjs   (from tools/android: node build-node-assets.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const assetsRoot = path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets');
const projectDir = path.join(assetsRoot, 'nodejs-project');
const shimIntl = path.join(scriptDir, 'shim-intl.mjs');
const shimEncoding = path.join(scriptDir, 'shim-encoding.mjs');
const mainTemplate = path.join(scriptDir, 'node-main.cjs');

const APP_VERSION = '1.4.1';

function log(...args) {
  console.log('[node-assets]', ...args);
}

function fail(message) {
  console.error(`[node-assets] ERROR: ${message}`);
  process.exit(1);
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) fail(`${label} is missing: ${file}`);
  return file;
}

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch (err) {
    fail(
      `esbuild is not installed. Run "npm install --no-save esbuild iconv-lite" inside tools/android.\n${err && err.message}`,
    );
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
    else fail(`unsupported entry (not a file or directory): ${source}`);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function writeAndroidConfig() {
  const source = requireFile(path.join(repoRoot, 'config.json'), 'config.json');
  const config = JSON.parse(fs.readFileSync(source, 'utf8'));
  // The phone has no local proxy: never prefer the CONNECT proxy path, the
  // server then goes straight to the public quote endpoints.
  config.proxy = { ...(config.proxy || {}), enabled: false };
  config.server = { ...(config.server || {}), host: '127.0.0.1', port: 8787 };
  config.dataDir = 'data';
  fs.writeFileSync(path.join(projectDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  log('config.json: proxy disabled, host 127.0.0.1:8787');
}

function writeRuntimeFiles() {
  const main = requireFile(mainTemplate, 'node-main.js template');
  fs.copyFileSync(main, path.join(projectDir, 'main.js'));
  const pkg = {
    name: 'chima-trader-android-node',
    version: APP_VERSION,
    private: true,
    description: 'Node server embedded in the ChimaTrader Android APK',
  };
  fs.writeFileSync(path.join(projectDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  log('main.js + package.json written');
}

function sanityCheck(entryBytes) {
  const appPath = path.join(projectDir, 'app.mjs');
  const code = fs.readFileSync(appPath, 'utf8');
  const checks = [
    ['ESM import/export syntax', /^\s*(import|export)\s/m.test(code)],
    ['GBK shim inlined', code.includes('iconv')],
    ['Intl shim inlined', code.includes('zoneOffsetMinutes') || code.includes('DateTimeFormat')],
    ['createRequire banner', code.includes('createRequire')],
    ['no leftover relative imports', !/^\s*import[^;]*from\s+['"]\.\.?\//m.test(code)],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
    if (!pass) ok = false;
  }
  const required = [
    'main.js',
    'app.mjs',
    'package.json',
    'config.json',
    'public/index.html',
    'public/app.js',
    'public/styles.css',
  ];
  for (const rel of required) {
    const full = path.join(projectDir, rel);
    if (!fs.existsSync(full)) {
      log(`  FAIL missing ${rel}`);
      ok = false;
    }
  }
  if (!ok) fail('asset sanity checks failed');
  log(`  app.mjs ${human(entryBytes)}, nodejs-project total ${human(dirSize(projectDir))}`);
}

async function main() {
  const esbuild = await loadEsbuild();
  const entry = requireFile(path.join(repoRoot, 'server.mjs'), 'server.mjs');
  requireFile(shimIntl, 'shim-intl.mjs');
  requireFile(shimEncoding, 'shim-encoding.mjs');
  requireFile(path.join(repoRoot, 'public', 'index.html'), 'public/index.html');

  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });

  log(`bundling ${path.relative(repoRoot, entry)} -> app.mjs (esm, node18)`);
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(projectDir, 'app.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // `createRequire` lets any CJS dependency that still calls require() at
    // runtime (iconv-lite does for a few optional paths) work inside the ESM
    // bundle. It must be declared before the bundle body.
    banner: {
      js: "import { createRequire as __chimaCreateRequire } from 'node:module';\nconst require = __chimaCreateRequire(import.meta.url);\n",
    },
    inject: [shimIntl, shimEncoding],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });

  const entryBytes = fs.statSync(path.join(projectDir, 'app.mjs')).size;
  log(`app.mjs written (${human(entryBytes)})`);

  copyDir(path.join(repoRoot, 'public'), path.join(projectDir, 'public'));
  log('public/ copied');

  writeAndroidConfig();
  writeRuntimeFiles();

  const outputs = Object.keys(result.metafile.outputs || {});
  log(`esbuild outputs: ${outputs.length}, inputs: ${Object.keys(result.metafile.inputs || {}).length}`);
  sanityCheck(entryBytes);
  log(`done -> ${path.relative(repoRoot, projectDir)}`);
}

main().catch((err) => fail((err && err.stack) || String(err)));
