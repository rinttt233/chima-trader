// ChimaTrader self-check. Runs every layer and exits non-zero when a mandatory
// check fails. Usage: node selfcheck.mjs [--json]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JSON_MODE = process.argv.includes('--json');

const REQUIRED_FILES = [
  'server.mjs',
  'config.json',
  'CONTRACTS.md',
  'lib/net.mjs',
  'lib/symbols.mjs',
  'lib/marketdata.mjs',
  'lib/engine.mjs',
  'lib/store.mjs',
  'lib/stats.mjs',
  'public/index.html',
  'public/styles.css',
  'public/app.js',
  'public/charts.js',
  'public/vendor/lightweight-charts.standalone.production.js',
  'test/engine.test.mjs',
  'test/marketdata.check.mjs',
  'test/http.smoke.mjs',
];

const layers = [];

function runNode(script, { timeoutMs = 180_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(err) });
    });
  });
}

function summarize(output, maxLines = 6) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const fails = lines.filter((l) => /^(FAIL|not ok|✖)/i.test(l.trim()));
  if (fails.length) return fails.slice(0, maxLines).join(' | ');
  const pass = lines.filter((l) => /^(PASS|ok |✔)/i.test(l.trim()));
  if (pass.length) return `${pass.length} passing checks`;
  return lines.slice(-maxLines).join(' | ').slice(0, 500);
}

async function main() {
  // Layer 0: required files.
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  layers.push({
    layer: 'files',
    ok: missing.length === 0,
    mandatory: true,
    detail: missing.length ? `缺少文件：${missing.join(', ')}` : `${REQUIRED_FILES.length} 个文件齐备`,
  });

  // Layer 1: engine unit tests (offline, mandatory).
  const engine = await runNode('test/engine.test.mjs');
  layers.push({
    layer: 'engine-tests',
    ok: engine.code === 0,
    mandatory: true,
    detail: summarize(engine.output),
    outputTail: engine.code === 0 ? undefined : engine.output.slice(-1500),
  });

  // Layer 2: live market-data checks (network dependent, advisory).
  const data = await runNode('test/marketdata.check.mjs', { timeoutMs: 180_000 });
  const domesticOk = /PASS[\s\S]*?(腾讯|tencent|Tencent)/i.test(data.output) || /十腾讯/.test(data.output);
  layers.push({
    layer: 'market-data',
    ok: data.code === 0,
    mandatory: false,
    warn: data.code !== 0 && domesticOk,
    detail: data.code === 0 ? summarize(data.output) : `联网检查未全通过（境外源可能因代理不可用）：${summarize(data.output)}`,
    outputTail: data.code === 0 ? undefined : data.output.slice(-1500),
  });

  // Layer 3: HTTP smoke test (boots the real server, mandatory).
  const smoke = await runNode('test/http.smoke.mjs', { timeoutMs: 240_000 });
  layers.push({
    layer: 'http-smoke',
    ok: smoke.code === 0,
    mandatory: true,
    detail: summarize(smoke.output),
    outputTail: smoke.code === 0 ? undefined : smoke.output.slice(-2500),
  });

  const failedMandatory = layers.filter((l) => l.mandatory && !l.ok);
  const warnings = layers.filter((l) => l.warn);
  const ok = failedMandatory.length === 0;

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok, layers, failed: failedMandatory.map((l) => l.layer), warnings: warnings.map((l) => l.layer) }, null, 2));
  } else {
    for (const layer of layers) {
      const flag = layer.ok ? 'PASS' : layer.warn ? 'WARN' : layer.mandatory ? 'FAIL' : 'SKIP';
      console.log(`${flag}  ${layer.layer.padEnd(14)} ${layer.detail}`);
      if (layer.outputTail && process.env.SELFCHECK_VERBOSE === '1') {
        console.log(layer.outputTail.split(/\r?\n/).map((l) => `      ${l}`).join('\n'));
      }
    }
    console.log('');
    console.log(ok
      ? `SELFCHECK OK${warnings.length ? `（${warnings.length} 项警告，不影响使用）` : ''}`
      : `SELFCHECK FAILED：${failedMandatory.map((l) => l.layer).join(', ')}`);
    if (!ok) console.log('提示：设置 SELFCHECK_VERBOSE=1 可查看失败层的详细输出。');
  }
  process.exit(ok ? 0 : 1);
}

main();
