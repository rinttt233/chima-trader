#!/usr/bin/env node
/**
 * Build the portable (no-install) ChimaTrader packages.
 *
 *   node tools/portable/build.mjs
 *
 * Output (all under temp/port/dist, which is git-ignored):
 *   chima-trader-<version>-win7-x64-no-node.zip
 *   chima-trader-<version>-win7-x86-no-node.zip
 *   chima-trader-<version>-linux-x64-glibc217.tar.gz
 *   chima-trader-<version>-linux-arm64-glibc217.tar.gz
 *   SHA256SUMS.txt
 *
 * What it does:
 *   1. bundles server.mjs into a single-file ESM app.mjs with esbuild
 *      (target=node12) using tools/portable/shim.mjs + fs-promises-shim.mjs
 *   2. downgrades public/app.js, charts.js, mock.js to ES2017 syntax
 *      (index.html / styles.css / vendor/ are copied verbatim)
 *   3. stages and packs the four packages, then writes SHA256SUMS.txt
 *
 * Requirements:
 *   - Node.js >= 18 to run this script (the host tool, not the bundled runtime)
 *   - esbuild + iconv-lite in tools/portable/node_modules or
 *     temp/port/build/node_modules  (npm i esbuild iconv-lite)
 *   - Python 3 (used only for archive pack/unpack, so the Linux tarball keeps
 *     POSIX modes; Windows' bsdtar would drop them)
 *   - the verified Node runtimes under temp/port/ (already extracted) or the
 *     archives under temp/port/dl/ (hashes are verified before use). Override
 *     the location with PORTABLE_RUNTIME_DIR=<dir>.
 *
 * This script never modifies tracked repository files: it only reads server.mjs,
 * lib/, public/, config.json, tools/portable/* and writes under temp/.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- constants
const VERSION = '1.3.1';
const APP_DIR_NAME = 'chima-trader';
const FRONTEND_FILES = ['app.js', 'charts.js', 'mock.js'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TEMP = path.join(ROOT, 'temp', 'port');
const WORK = path.join(TEMP, 'build-work');
const STAGE = path.join(WORK, 'stage');
const DIST = path.join(TEMP, 'dist');
const SHIM = path.join(HERE, 'shim.mjs');
const FS_PROMISES_SHIM = path.join(HERE, 'fs-promises-shim.mjs');
const ASSETS = path.join(HERE, 'assets');
const PY_HELPER = path.join(WORK, '_portable_pack.py');

const NODE12_VERSION = 'v12.22.12';
const NODE16_VERSION = 'v16.20.2';

const RUNTIME_BASE = (() => {
  const override = process.env.PORTABLE_RUNTIME_DIR;
  if (!override) return TEMP;
  return path.isAbsolute(override) ? override : path.join(ROOT, override);
})();

const WIN_TARGETS = [
  {
    id: 'win7-x64',
    label: 'Windows 7+ x64 (Node 12.22.12)',
    archive: `${APP_DIR_NAME}-${VERSION}-win7-x64-no-node.zip`,
    runtimeRel: 'node12/node-v12.22.12-win-x64',
    dlZip: 'node12-win-x64.zip',
    dlZipSha256: '09639bac66d4dc4dd52179968209413ad4b7360e917dcbe8834052a4b936a087',
    zipRoot: 'node-v12.22.12-win-x64',
    downloadUrl: 'https://npmmirror.com/mirrors/node/v12.22.12/node-v12.22.12-win-x64.zip',
  },
  {
    id: 'win7-x86',
    label: 'Windows 7+ x86 (Node 12.22.12)',
    archive: `${APP_DIR_NAME}-${VERSION}-win7-x86-no-node.zip`,
    runtimeRel: 'node12x86/node-v12.22.12-win-x86',
    dlZip: 'node12-win-x86.zip',
    dlZipSha256: '2f7fa563c9477d5e9fddc5c22451b21b8a963c9b5004c80dd0140c3a3675a4e8',
    zipRoot: 'node-v12.22.12-win-x86',
    downloadUrl: 'https://npmmirror.com/mirrors/node/v12.22.12/node-v12.22.12-win-x86.zip',
  },
];

const LINUX_TARGETS = [
  {
    id: 'linux-x64',
    label: 'Linux x64 glibc>=2.17 (Node 16.20.2)',
    archive: `${APP_DIR_NAME}-${VERSION}-linux-x64-glibc217.tar.gz`,
    tarball: 'node16-linux-x64.tar.gz',
    tarballSha256: 'c9193e6c414891694759febe846f4f023bf48410a6924a8b1520c46565859665',
    nodeSha256: '8440cffda5a21bf7cfda43d2c396f79777585a4c5e03ed2801fe226953a7aa11',
    tarRoot: 'node-v16.20.2-linux-x64',
    downloadUrl: 'https://npmmirror.com/mirrors/node/v16.20.2/node-v16.20.2-linux-x64.tar.gz',
  },
  {
    id: 'linux-arm64',
    label: 'Linux arm64 glibc>=2.17 (Node 16.20.2)',
    archive: `${APP_DIR_NAME}-${VERSION}-linux-arm64-glibc217.tar.gz`,
    tarball: 'node16-linux-arm64.tar.gz',
    tarballSha256: 'b6945fcc9ad220386bb814bfae7137189fd17297f2959a744105e1bee006035a',
    nodeSha256: 'd09c34f17626ab66c8906508a831ea91dab4e5982b20c4d7a567ceaed42121bb',
    tarRoot: 'node-v16.20.2-linux-arm64',
    downloadUrl: 'https://npmmirror.com/mirrors/node/v16.20.2/node-v16.20.2-linux-arm64.tar.gz',
  },
];

const BANNER = "import { createRequire as __portableCreateRequire } from 'module';\nconst require = __portableCreateRequire(import.meta.url);";

// Python helper: written into temp/port/build-work at build time (never shipped).
// It is used for tar/zip creation so that POSIX modes survive on Windows.
const PY_SOURCE = `import hashlib
import io
import json
import os
import sys
import tarfile
import zipfile

EXEC_MEMBERS = ("chima-trader/runtime/bin/node", "chima-trader/start.sh")


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        rel = os.path.relpath(dirpath, root).replace(os.sep, "/")
        yield rel, dirpath, filenames


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def cmd_extract(src, outdir, *members):
    os.makedirs(outdir, exist_ok=True)
    with tarfile.open(src, "r:gz") as tf:
        for member in members:
            data = tf.extractfile(member).read()
            with open(os.path.join(outdir, os.path.basename(member)), "wb") as fh:
                fh.write(data)


def cmd_unzip_member(src, dest, member):
    parent = os.path.dirname(dest)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with zipfile.ZipFile(src) as zf:
        with open(dest, "wb") as fh:
            fh.write(zf.read(member))


def cmd_zip(out, root):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, dirpath, filenames in walk(root):
            if rel != ".":
                info = zipfile.ZipInfo(rel + "/", date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = (0o40755 << 16) | 0x10
                info.compress_type = zipfile.ZIP_STORED
                zf.writestr(info, b"")
            for name in filenames:
                full = os.path.join(dirpath, name)
                arc = name if rel == "." else rel + "/" + name
                with open(full, "rb") as fh:
                    data = fh.read()
                info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = (0o100755 if arc in EXEC_MEMBERS else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, data)


def cmd_tar(out, root):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with tarfile.open(out, "w:gz", compresslevel=9) as tf:
        for rel, dirpath, filenames in walk(root):
            if rel != ".":
                info = tarfile.TarInfo(rel)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = int(os.path.getmtime(dirpath))
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                tf.addfile(info)
            for name in filenames:
                full = os.path.join(dirpath, name)
                arc = name if rel == "." else rel + "/" + name
                with open(full, "rb") as fh:
                    data = fh.read()
                info = tarfile.TarInfo(arc)
                info.size = len(data)
                info.mode = 0o755 if arc in EXEC_MEMBERS else 0o644
                info.mtime = int(os.path.getmtime(full))
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                tf.addfile(info, io.BytesIO(data))


def cmd_check(kind, archive, app_sha, node_sha):
    problems = []
    info = {}
    if kind == "zip":
        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
            info["files"] = len([n for n in names if not n.endswith("/")])
            info["dirs"] = len([n for n in names if n.endswith("/")])
            required = [
                "chima-trader/app.mjs",
                "chima-trader/config.json",
                "chima-trader/start.cmd",
                "chima-trader/README-PORTABLE.txt",
                "chima-trader/runtime/node.exe",
                "chima-trader/runtime/LICENSE",
                "chima-trader/public/index.html",
                "chima-trader/public/styles.css",
                "chima-trader/public/app.js",
                "chima-trader/public/charts.js",
                "chima-trader/public/mock.js",
                "chima-trader/data/.gitkeep",
            ]
            for name in required:
                if name not in names:
                    problems.append("zip missing " + name)
            got = sha256_bytes(zf.read("chima-trader/app.mjs"))
            info["appSha256"] = got
            if got != app_sha:
                problems.append("app.mjs sha256 mismatch in zip")
    else:
        with tarfile.open(archive, "r:gz") as tf:
            members = {m.name: m for m in tf.getmembers()}
            info["files"] = len([m for m in members.values() if m.isfile()])
            info["dirs"] = len([m for m in members.values() if m.isdir()])
            want_modes = {
                "chima-trader/runtime/bin/node": 0o755,
                "chima-trader/start.sh": 0o755,
                "chima-trader/app.mjs": 0o644,
                "chima-trader/runtime/LICENSE": 0o644,
                "chima-trader/data": 0o755,
            }
            for name, mode in want_modes.items():
                member = members.get(name)
                if member is None:
                    problems.append("tar missing " + name)
                    continue
                got_mode = member.mode & 0o777
                if got_mode != mode:
                    problems.append("tar mode {} is {:o}, expected {:o}".format(name, got_mode, mode))
            got = sha256_bytes(tf.extractfile("chima-trader/app.mjs").read())
            info["appSha256"] = got
            if got != app_sha:
                problems.append("app.mjs sha256 mismatch in tar")
            node = sha256_bytes(tf.extractfile("chima-trader/runtime/bin/node").read())
            info["nodeSha256"] = node
            if node_sha and node != node_sha:
                problems.append("runtime/bin/node sha256 mismatch")
    print(json.dumps({"ok": not problems, "problems": problems, "info": info}, ensure_ascii=False))
    return 0 if not problems else 1


COMMANDS = {
    "extract": cmd_extract,
    "unzip-member": cmd_unzip_member,
    "zip": cmd_zip,
    "tar": cmd_tar,
    "check": cmd_check,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print("usage: _portable_pack.py <extract|unzip-member|zip|tar|check> ...", file=sys.stderr)
        sys.exit(2)
    try:
        result = COMMANDS[sys.argv[1]](*sys.argv[2:])
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    if isinstance(result, int):
        sys.exit(result)
`;

// ---------------------------------------------------------------- helpers
class BuildError extends Error {}

const log = (msg) => console.log(`[portable] ${msg}`);
const indent = (msg) => console.log(`[portable]       ${msg}`);

function fail(message) {
  throw new BuildError(message);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function humanBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

function toCrlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function readAsset(name) {
  return fs.readFileSync(path.join(ASSETS, name), 'utf8').replace(/\r\n/g, '\n');
}

function renderVersion(text) {
  return text.replace(/@VERSION@/g, VERSION);
}

function copyTree(source, dest) {
  fs.cpSync(source, dest, { recursive: true });
}

function resetDirs() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(PY_HELPER, PY_SOURCE, 'utf8');
}

// ---------------------------------------------------------------- environment
function findNodeModules() {
  const candidates = [
    path.join(HERE, 'node_modules'),
    path.join(TEMP, 'build', 'node_modules'),
    path.join(ROOT, 'node_modules'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'esbuild')) && fs.existsSync(path.join(dir, 'iconv-lite'))) {
      return dir;
    }
  }
  return null;
}

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  candidates.push(['python', []], ['python3', []], ['py', ['-3']]);
  for (const [cmd, args] of candidates) {
    try {
      const out = execFileSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20000,
      });
      if (out.trim() === '3') return { cmd, args };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function prepareEnvironment() {
  if (!fs.existsSync(path.join(ROOT, 'server.mjs')) || !fs.existsSync(path.join(ROOT, 'public'))) {
    fail(`cannot find server.mjs / public/ under ${ROOT}.\n` +
      'Run the script from the repository root: node tools/portable/build.mjs');
  }
  for (const file of [SHIM, FS_PROMISES_SHIM, path.join(ASSETS, 'start.cmd'), path.join(ASSETS, 'start.sh'),
    path.join(ASSETS, 'README-PORTABLE.txt'), path.join(ASSETS, 'README-PORTABLE-linux.txt')]) {
    if (!fs.existsSync(file)) fail(`missing build asset: ${file}`);
  }
  log(`repo root:    ${ROOT}`);
  log(`runtime base: ${RUNTIME_BASE}`);

  const nmDir = findNodeModules();
  if (!nmDir) {
    fail('esbuild / iconv-lite not found.\n' +
      'Install them once (either location works):\n' +
      '  cd tools/portable && npm i esbuild iconv-lite\n' +
      '  cd temp/port/build && npm i esbuild iconv-lite');
  }
  const requireFrom = createRequire(path.join(nmDir, '__portable_build__.cjs'));
  let esbuild;
  try {
    esbuild = requireFrom('esbuild');
  } catch (err) {
    fail(`failed to load esbuild from ${nmDir}: ${err.message}`);
  }
  log(`esbuild:      ${esbuild.version} (${nmDir})`);

  const python = findPython();
  if (!python) {
    fail('Python 3 is required to pack the archives (it preserves the 0755 modes in the Linux tarball).\n' +
      'Install Python 3, or set PYTHON=<path-to-python.exe>.');
  }
  const pyVersion = execFileSync(python.cmd, [...python.args, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  log(`python:       ${pyVersion}`);

  return { esbuild, nmDir, python };
}

// ---------------------------------------------------------------- python helper
function pyRun(env, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(env.python.cmd, [...env.python.args, PY_HELPER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFailure) {
      return { stdout: String(err.stdout || ''), stderr: String(err.stderr || ''), status: err.status };
    }
    const detail = String(err.stderr || err.stdout || err.message).trim();
    fail(`python helper "${args[0]}" failed: ${detail}`);
  }
}

function pyCheck(env, kind, archivePath, expectedAppSha256, expectedNodeSha256) {
  const output = pyRun(env, ['check', kind, archivePath, expectedAppSha256, expectedNodeSha256 || ''], { allowFailure: true });
  const text = typeof output === 'string' ? output : output.stdout;
  let result;
  try {
    result = JSON.parse(text.trim());
  } catch {
    fail(`cannot parse archive verification output for ${archivePath}: ${text.trim()}`);
  }
  if (!result.ok) fail(`archive verification failed for ${path.basename(archivePath)}:\n  - ${result.problems.join('\n  - ')}`);
  return result.info;
}

// ---------------------------------------------------------------- step 1: bundle
async function buildBundle(env, bundlePath) {
  const alias = { 'node:fs/promises': FS_PROMISES_SHIM };
  for (const name of [
    'fs', 'path', 'url', 'http', 'https', 'net', 'tls', 'crypto', 'os', 'stream', 'zlib', 'util',
    'events', 'buffer', 'assert', 'child_process', 'readline', 'dns', 'querystring', 'string_decoder',
    'timers', 'tty', 'v8', 'vm', 'worker_threads',
  ]) {
    alias[`node:${name}`] = name;
  }
  await env.esbuild.build({
    entryPoints: [path.join(ROOT, 'server.mjs')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node12',
    inject: [SHIM],
    alias,
    nodePaths: [env.nmDir],
    banner: { js: BANNER },
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'warning',
  });
}

// ---------------------------------------------------------------- step 2: frontend
async function transformFrontend(env, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of FRONTEND_FILES) {
    const source = path.join(ROOT, 'public', name);
    const dest = path.join(outDir, name);
    await env.esbuild.build({
      entryPoints: [source],
      outfile: dest,
      bundle: false,
      target: 'es2017',
      charset: 'utf8',
      legalComments: 'none',
      logLevel: 'warning',
    });
    const before = fs.statSync(source).size;
    const after = fs.statSync(dest).size;
    indent(`${name}: ES2017 output ${humanBytes(after)} (source ${humanBytes(before)})`);
  }
}

// ---------------------------------------------------------------- stage helpers
function verifyNodeVersion(nodeExe, expected) {
  const out = execFileSync(nodeExe, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (out !== expected) fail(`${nodeExe} reports ${out}, expected ${expected}`);
  return out;
}

function verifyNodeParses(nodeExe, files) {
  for (const file of files) {
    try {
      execFileSync(nodeExe, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      fail(`${path.basename(file)} does not parse with ${path.basename(nodeExe)} (${NODE12_VERSION}):\n` +
        String(err.stderr || err.message).trim());
    }
  }
}

function stageCommon(pkgDir, bundlePath, frontendDir) {
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(pkgDir, 'config.json'));
  fs.copyFileSync(bundlePath, path.join(pkgDir, 'app.mjs'));
  copyTree(path.join(ROOT, 'public'), path.join(pkgDir, 'public'));
  for (const name of FRONTEND_FILES) {
    fs.copyFileSync(path.join(frontendDir, name), path.join(pkgDir, 'public', name));
  }
  fs.mkdirSync(path.join(pkgDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'data', '.gitkeep'), '');
}

function writeStartCmd(dest) {
  const text = readAsset('start.cmd');
  const nonAscii = [...text].find((ch) => ch.charCodeAt(0) > 0x7f);
  if (nonAscii) fail(`start.cmd must be ASCII-only for Windows 7 cmd.exe (found ${JSON.stringify(nonAscii)})`);
  fs.writeFileSync(dest, toCrlf(text), 'utf8');
}

function writeStartSh(dest) {
  const text = readAsset('start.sh').replace(/\r\n/g, '\n');
  fs.writeFileSync(dest, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function writeReadmeWin(dest) {
  // UTF-8 BOM + CRLF so Windows 7 Notepad shows the Chinese text correctly.
  fs.writeFileSync(dest, `\uFEFF${toCrlf(renderVersion(readAsset('README-PORTABLE.txt')))}`, 'utf8');
}

function writeReadmeLinux(dest) {
  fs.writeFileSync(dest, renderVersion(readAsset('README-PORTABLE-linux.txt')).replace(/\r\n/g, '\n'), 'utf8');
}

// ---------------------------------------------------------------- runtimes
function missingRuntimeMessage(target) {
  return [
    `missing Windows runtime for ${target.label}.`,
    'Expected (extracted):',
    `  ${path.join(RUNTIME_BASE, target.runtimeRel, 'node.exe')}`,
    'or the official zip:',
    `  ${path.join(RUNTIME_BASE, 'dl', target.dlZip)}`,
    'Download from the npmmirror mirror:',
    `  ${target.downloadUrl}`,
    `  SHA256 must be: ${target.dlZipSha256}`,
    'Extract it to the expected directory, or put the zip under temp/port/dl/',
    '(the build verifies the SHA256 before using it).',
  ].join('\n');
}

function locateWinRuntime(env, target) {
  const extractedDir = path.join(RUNTIME_BASE, target.runtimeRel);
  const extractedNode = path.join(extractedDir, 'node.exe');
  if (fs.existsSync(extractedNode)) {
    const license = path.join(extractedDir, 'LICENSE');
    if (!fs.existsSync(license)) fail(`missing ${license} (Node.js license) for ${target.label}`);
    return { nodeExe: extractedNode, license };
  }
  const zipPath = path.join(RUNTIME_BASE, 'dl', target.dlZip);
  if (fs.existsSync(zipPath)) {
    const actual = sha256File(zipPath);
    if (actual !== target.dlZipSha256) {
      fail(`SHA256 mismatch for ${zipPath}\n  expected ${target.dlZipSha256}\n  actual   ${actual}`);
    }
    const dir = path.join(WORK, 'runtimes', target.id);
    fs.mkdirSync(dir, { recursive: true });
    pyRun(env, ['unzip-member', zipPath, path.join(dir, 'node.exe'), `${target.zipRoot}/node.exe`]);
    pyRun(env, ['unzip-member', zipPath, path.join(dir, 'LICENSE'), `${target.zipRoot}/LICENSE`]);
    indent(`runtime ${target.id}: extracted ${target.dlZip} (SHA256 verified)`);
    return { nodeExe: path.join(dir, 'node.exe'), license: path.join(dir, 'LICENSE') };
  }
  fail(missingRuntimeMessage(target));
}

function locateLinuxRuntime(env, target) {
  const tarball = path.join(RUNTIME_BASE, 'dl', target.tarball);
  if (!fs.existsSync(tarball)) {
    fail([
      `missing Linux runtime archive for ${target.label}: ${tarball}`,
      'Download from the npmmirror mirror:',
      `  ${target.downloadUrl}`,
      `  SHA256 must be: ${target.tarballSha256}`,
      `Place it under ${path.join(RUNTIME_BASE, 'dl')} and re-run the build.`,
    ].join('\n'));
  }
  const actual = sha256File(tarball);
  if (actual !== target.tarballSha256) {
    fail(`SHA256 mismatch for ${tarball}\n  expected ${target.tarballSha256}\n  actual   ${actual}`);
  }
  const dir = path.join(WORK, 'runtimes', target.id);
  fs.mkdirSync(dir, { recursive: true });
  pyRun(env, ['extract', tarball, dir, `${target.tarRoot}/bin/node`, `${target.tarRoot}/LICENSE`]);
  const nodePath = path.join(dir, 'node');
  const nodeSha = sha256File(nodePath);
  if (nodeSha !== target.nodeSha256) {
    fail(`extracted node binary SHA256 mismatch for ${target.label}\n  expected ${target.nodeSha256}\n  actual   ${nodeSha}`);
  }
  indent(`runtime ${target.id}: extracted bin/node from ${target.tarball} (SHA256 ${nodeSha.slice(0, 16)}… verified)`);
  return { nodePath, license: path.join(dir, 'LICENSE') };
}

// ---------------------------------------------------------------- stages
function stageWin(env, target, bundlePath, frontendDir) {
  const runtime = locateWinRuntime(env, target);
  const pkgDir = path.join(STAGE, target.id, APP_DIR_NAME);
  stageCommon(pkgDir, bundlePath, frontendDir);
  fs.mkdirSync(path.join(pkgDir, 'runtime'), { recursive: true });
  fs.copyFileSync(runtime.nodeExe, path.join(pkgDir, 'runtime', 'node.exe'));
  fs.copyFileSync(runtime.license, path.join(pkgDir, 'runtime', 'LICENSE'));
  writeStartCmd(path.join(pkgDir, 'start.cmd'));
  writeReadmeWin(path.join(pkgDir, 'README-PORTABLE.txt'));

  const nodeExe = path.join(pkgDir, 'runtime', 'node.exe');
  const version = verifyNodeVersion(nodeExe, NODE12_VERSION);
  indent(`${target.id}: runtime node.exe -> ${version} (${humanBytes(fs.statSync(nodeExe).size)})`);
  verifyNodeParses(nodeExe, [
    path.join(pkgDir, 'app.mjs'),
    ...FRONTEND_FILES.map((name) => path.join(pkgDir, 'public', name)),
  ]);
  indent(`${target.id}: app.mjs + public/*.js pass node ${NODE12_VERSION} --check`);
  return path.join(STAGE, target.id);
}

function stageLinux(env, target, bundlePath, frontendDir) {
  const runtime = locateLinuxRuntime(env, target);
  const pkgDir = path.join(STAGE, target.id, APP_DIR_NAME);
  stageCommon(pkgDir, bundlePath, frontendDir);
  fs.mkdirSync(path.join(pkgDir, 'runtime', 'bin'), { recursive: true });
  fs.copyFileSync(runtime.nodePath, path.join(pkgDir, 'runtime', 'bin', 'node'));
  fs.copyFileSync(runtime.license, path.join(pkgDir, 'runtime', 'LICENSE'));
  writeStartSh(path.join(pkgDir, 'start.sh'));
  writeReadmeLinux(path.join(pkgDir, 'README-PORTABLE.txt'));
  indent(`${target.id}: runtime bin/node ${humanBytes(fs.statSync(path.join(pkgDir, 'runtime', 'bin', 'node')).size)} ` +
    `(sha256 ${target.nodeSha256.slice(0, 16)}… verified)`);
  return path.join(STAGE, target.id);
}

// ---------------------------------------------------------------- packing
function packWin(env, target, stageDir, bundlePath) {
  const archivePath = path.join(DIST, target.archive);
  pyRun(env, ['zip', archivePath, stageDir]);
  const info = pyCheck(env, 'zip', archivePath, sha256File(bundlePath), '');
  const size = fs.statSync(archivePath).size;
  indent(`${target.archive}  ${humanBytes(size)}  (${info.files} files / ${info.dirs} dirs)`);
  indent(`  app.mjs sha256 matches staged bundle: ${info.appSha256.slice(0, 16)}…`);
  return { name: target.archive, path: archivePath, size, sha256: sha256File(archivePath) };
}

function packLinux(env, target, stageDir, bundlePath, expectedNodeSha256) {
  const archivePath = path.join(DIST, target.archive);
  pyRun(env, ['tar', archivePath, stageDir]);
  const info = pyCheck(env, 'tar', archivePath, sha256File(bundlePath), expectedNodeSha256);
  const size = fs.statSync(archivePath).size;
  indent(`${target.archive}  ${humanBytes(size)}  (${info.files} files / ${info.dirs} dirs)`);
  indent(`  app.mjs sha256 matches staged bundle: ${info.appSha256.slice(0, 16)}…`);
  indent(`  runtime/bin/node sha256 matches verified Node ${NODE16_VERSION}: ${info.nodeSha256.slice(0, 16)}…`);
  indent('  modes verified: runtime/bin/node=0755 start.sh=0755 data=0755');
  return { name: target.archive, path: archivePath, size, sha256: sha256File(archivePath) };
}

function writeSums(archives) {
  const lines = archives.map((item) => `${item.sha256}  ${item.name}`).join('\n');
  const file = path.join(DIST, 'SHA256SUMS.txt');
  fs.writeFileSync(file, `${lines}\n`, 'utf8');
  indent(`SHA256SUMS.txt written (${archives.length} archives, LF, "<hash>  <filename>")`);
  return file;
}

// ---------------------------------------------------------------- main
async function main() {
  const env = prepareEnvironment();
  resetDirs();

  log('[1/5] bundle server.mjs -> app.mjs (esbuild, format=esm, target=node12)');
  const bundlePath = path.join(WORK, 'app.mjs');
  await buildBundle(env, bundlePath);
  const bundleSha = sha256File(bundlePath);
  indent(`app.mjs ${humanBytes(fs.statSync(bundlePath).size)}  sha256=${bundleSha}`);

  log('[2/5] downgrade frontend scripts to ES2017 (public/*.js)');
  const frontendDir = path.join(WORK, 'public');
  await transformFrontend(env, frontendDir);

  log('[3/5] stage + pack Windows packages (Node 12.22.12 runtime)');
  const archives = [];
  for (const target of WIN_TARGETS) {
    const stageDir = stageWin(env, target, bundlePath, frontendDir);
    archives.push(packWin(env, target, stageDir, bundlePath));
  }

  log('[4/5] stage + pack Linux packages (Node 16.20.2 glibc217 runtime)');
  for (const target of LINUX_TARGETS) {
    const stageDir = stageLinux(env, target, bundlePath, frontendDir);
    archives.push(packLinux(env, target, stageDir, bundlePath, target.nodeSha256));
  }

  log('[5/5] checksums');
  writeSums(archives);

  console.log('');
  log('done. artifacts:');
  for (const item of archives) {
    console.log(`  ${item.name}`);
    console.log(`    ${humanBytes(item.size)}`);
    console.log(`    sha256 ${item.sha256}`);
  }
  console.log(`  SHA256SUMS.txt`);
  console.log(`    ${path.join(DIST, 'SHA256SUMS.txt')}`);
  log(`all packages are under ${DIST}`);
}

main().catch((err) => {
  if (err instanceof BuildError) {
    console.error(`\n[portable] ERROR: ${err.message}\n`);
  } else {
    console.error('\n[portable] ERROR (unexpected):', err);
  }
  process.exitCode = 1;
});
