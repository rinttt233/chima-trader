// End-to-end HTTP smoke test: boots server.mjs on a temporary port/data dir,
// exercises the public REST API and prints PASS/FAIL lines.
// Exit code 0 only when every mandatory check passes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNTIME_DIR = path.join(os.tmpdir(), `chimatrader-smoke-${process.pid}`);
const DATA_DIR = path.join(RUNTIME_DIR, 'data');
const LOG_FILE = path.join(RUNTIME_DIR, 'server.log');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function waitForServer(timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function cleanupDataDir() {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function main() {
  cleanupDataDir();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const logStream = fs.createWriteStream(LOG_FILE);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      CHIMATRADER_DATA_DIR: DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));

  let exitCode = 0;
  try {
    const up = await waitForServer();
    check('server boots and /api/health responds', up, up ? '' : 'timeout');
    if (!up) {
      throw new Error(`server did not start, see ${LOG_FILE}`);
    }

    const health = await api('/api/health');
    check('GET /api/health -> 200 {ok,sources}', health.status === 200 && health.body?.ok === true,
      `status=${health.status}`);

    const markets = await api('/api/markets');
    const marketIds = (markets.body?.markets || []).map((m) => m.id);
    check('GET /api/markets covers 5 markets',
      ['cn', 'hk', 'us', 'fx', 'crypto'].every((m) => marketIds.includes(m)),
      marketIds.join(','));

    const watch = await api('/api/watchlist');
    const watchSymbols = watch.body?.symbols || [];
    check('GET /api/watchlist non-empty', Array.isArray(watchSymbols) && watchSymbols.length > 0,
      `${watchSymbols.length} symbols`);

    const quoteSymbols = watchSymbols.length ? watchSymbols : ['cn:sh600519', 'crypto:cryptoBTCUSDT'];
    const quotes = await api(`/api/quotes?symbols=${encodeURIComponent(quoteSymbols.join(','))}`);
    const quoteList = quotes.body?.quotes || [];
    const withPrice = quoteList.filter((q) => Number.isFinite(q.price) && q.price > 0);
    check('GET /api/quotes returns priced quotes', withPrice.length >= 1,
      `${withPrice.length}/${quoteSymbols.length} priced`);

    const kline = await api('/api/kline?symbol=cn:sh600519&interval=1d&limit=30');
    check('GET /api/kline returns daily bars', (kline.body?.bars || []).length > 5,
      `${(kline.body?.bars || []).length} bars`);

    // SSE live stream: first frame must carry priced quotes.
    let sseOk = false;
    let sseDetail = '';
    try {
      const controller = new AbortController();
      const streamRes = await fetch(`${BASE}/api/stream`, { signal: controller.signal });
      const isEventStream = String(streamRes.headers.get('content-type') || '').includes('text/event-stream');
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event: quotes') && buffer.includes('\n\n')) break;
      }
      const match = buffer.match(/event: quotes\ndata: (.*)\n/);
      if (isEventStream && match) {
        const payload = JSON.parse(match[1]);
        sseOk = Array.isArray(payload.quotes) && payload.quotes.some((q) => q.price > 0);
        sseDetail = `${payload.quotes?.length || 0} quotes`;
      } else {
        sseDetail = `content-type=${streamRes.headers.get('content-type')}`;
      }
      controller.abort();
      try { await reader.cancel(); } catch { /* already aborted */ }
    } catch (err) {
      sseDetail = err.message;
    }
    check('GET /api/stream pushes quote frames (SSE)', sseOk, sseDetail);

    const search = await api('/api/search?q=%E8%8C%85%E5%8F%B0');
    check('GET /api/search finds 贵州茅台',
      (search.body?.results || []).some((r) => String(r.name || '').includes('茅台')),
      `${(search.body?.results || []).length} results`);

    const universe = await api('/api/universe?market=cn&limit=20&sort=amount');
    const universeItems = universe.body?.items || [];
    check('GET /api/universe returns full-market candidates',
      universe.status === 200 && universeItems.length > 0
        && universeItems.every((item) => String(item.symbol || '').startsWith('cn:')),
      `${universeItems.length} items, source=${universe.body?.source}`);

    const accounts = await api('/api/accounts');
    check('GET /api/accounts returns a default account',
      (accounts.body?.accounts || []).length >= 1,
      `${(accounts.body?.accounts || []).length} accounts`);

    const created = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: '冒烟测试账户', initialCapital: 500000 }),
    });
    check('POST /api/accounts creates account', created.status === 201 && !!created.body?.account?.id,
      `status=${created.status}`);
    const accountId = created.body?.account?.id;
    if (!accountId) throw new Error('no account id returned');

    const snapshot = await api(`/api/accounts/${accountId}`);
    check('GET /api/accounts/:id snapshot has cash/equity',
      snapshot.status === 200 && snapshot.body?.cash && snapshot.body?.equity,
      `status=${snapshot.status}`);
    check('initial equity equals initial capital',
      Math.abs(Number(snapshot.body?.equity?.total) - 500000) < 0.01,
      `equity=${snapshot.body?.equity?.total}`);

    // Offline-safe order path: crypto trades 24/7, but its data source needs the
    // local proxy. When unavailable, record a WARN instead of failing the suite.
    const cryptoQuote = (quotes.body?.quotes || []).find((q) => q.symbol.startsWith('crypto:'))
      || (await api(`/api/quotes?symbols=${encodeURIComponent('crypto:cryptoBTCUSDT')}`)).body?.quotes?.[0];
    if (cryptoQuote && cryptoQuote.price > 0) {
      const orderRes = await api(`/api/accounts/${accountId}/orders`, {
        method: 'POST',
        body: JSON.stringify({ symbol: cryptoQuote.symbol, side: 'buy', type: 'market', qty: 0.001 }),
      });
      const okOrder = orderRes.status === 201 && !!orderRes.body?.fill;
      check('POST market buy fills (crypto)', okOrder,
        okOrder ? `price=${orderRes.body.fill.price}` : JSON.stringify(orderRes.body?.error || orderRes.body));
      if (okOrder) {
        const after = await api(`/api/accounts/${accountId}`);
        const posQty = (after.body?.positions || []).reduce((sum, p) => sum + Number(p.qty || 0), 0);
        check('position reflects filled order', posQty > 0, `qty=${posQty}`);
        const trades = await api(`/api/accounts/${accountId}/trades`);
        check('GET trades records the fill', (trades.body?.trades || []).length >= 1,
          `${(trades.body?.trades || []).length} trades`);
      }
    } else {
      console.log('WARN  加密行情不可用（代理未开启？），跳过真实下单冒烟');
    }

    // Limit order on A-shares: a bid far below the market parks instead of filling.
    // Price stays inside the daily limit band so the engine accepts the order.
    const quoteForLimit = (kline.body?.bars || []).slice(-1)[0]?.c;
    const limitRes = await api(`/api/accounts/${accountId}/orders`, {
      method: 'POST',
      body: JSON.stringify({
        symbol: 'cn:sh600519',
        side: 'buy',
        type: 'limit',
        qty: 100,
        limitPrice: Math.max(1, Math.round(Number(quoteForLimit) * 0.95)),
      }),
    });
    const pendingOrder = limitRes.body?.order;
    check('POST limit order accepted as pending or filled',
      limitRes.status === 201, `status=${limitRes.status} ${JSON.stringify(limitRes.body?.error || '')}`);
    if (limitRes.status === 201 && pendingOrder) {
      if (pendingOrder.status === 'open') {
        const cancel = await api(`/api/accounts/${accountId}/orders/${pendingOrder.id}`, { method: 'DELETE' });
        check('DELETE pending order cancels it', cancel.status === 200 && cancel.body?.ok === true,
          `status=${cancel.status}`);
      }
      const orders = await api(`/api/accounts/${accountId}/orders?status=all`);
      check('GET orders lists lifecycle', (orders.body?.orders || []).length >= 1,
        `${(orders.body?.orders || []).length} orders`);
    }

    const stats = await api(`/api/accounts/${accountId}/stats`);
    check('GET /api/accounts/:id/stats returns metrics', stats.status === 200 && 'tradeCount' in (stats.body || {}),
      `tradeCount=${stats.body?.tradeCount}`);

    // ---- v2 margin / leverage flow on a dedicated account -------------------
    const levAccount = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: '杠杆冒烟账户', initialCapital: 1000000 }),
    });
    const levId = levAccount.body?.account?.id;
    const eth = (await api('/api/quotes?symbols=' + encodeURIComponent('crypto:ETHUSDT'))).body?.quotes?.[0];
    if (levId && eth && eth.price > 0) {
      const open = await api(`/api/accounts/${levId}/orders`, {
        method: 'POST',
        body: JSON.stringify({
          symbol: 'crypto:ETHUSDT', side: 'buy', type: 'market', qty: 0.5, leverage: 5,
          takeProfit: eth.price * 1.5, stopLoss: eth.price * 0.8,
        }),
      });
      const levSnap = (await api(`/api/accounts/${levId}`)).body;
      const levPos = (levSnap.positions || []).find((p) => p.symbol === 'crypto:ETHUSDT');
      check('5x leveraged order opens a margin position',
        open.status === 201 && levPos && Number(levPos.leverage) === 5
          && Number(levPos.margin) > 0 && Number(levPos.liqPrice) > 0,
        `lev=${levPos?.leverage} margin=${levPos?.margin} liq=${levPos?.liqPrice}`);
      check('account snapshot exposes margin metrics',
        Number.isFinite(Number(levSnap.marginUsed)) && Number.isFinite(Number(levSnap.riskRatio)),
        `used=${levSnap.marginUsed} risk=${levSnap.riskRatio} mode=${levSnap.account?.marginMode}`);

      const protect = await api(`/api/accounts/${levId}/positions/crypto:ETHUSDT/protect`, {
        method: 'POST',
        body: JSON.stringify({ takeProfit: eth.price * 1.6, stopLoss: eth.price * 0.75 }),
      });
      check('position protect (TP/SL) can be updated', protect.status === 200 && protect.body?.position,
        `status=${protect.status}`);

      const levLimit = await api(`/api/accounts/${levId}/orders`, {
        method: 'POST',
        body: JSON.stringify({
          symbol: 'crypto:ETHUSDT', side: 'buy', type: 'limit', qty: 0.1,
          limitPrice: Math.round(eth.price * 0.9 * 100) / 100, leverage: 5,
        }),
      });
      const levOrderId = levLimit.body?.order?.id;
      if (levLimit.status === 201 && levOrderId) {
        const newPrice = Math.round(eth.price * 0.85 * 100) / 100;
        const amend = await api(`/api/accounts/${levId}/orders/${levOrderId}`, {
          method: 'PATCH',
          body: JSON.stringify({ limitPrice: newPrice }),
        });
        check('open limit order price can be amended',
          amend.status === 200 && Number(amend.body?.order?.limitPrice) === newPrice,
          `status=${amend.status} price=${amend.body?.order?.limitPrice}`);
        await api(`/api/accounts/${levId}/orders/${levOrderId}`, { method: 'DELETE' });
      }

      const lockMode = await api(`/api/accounts/${levId}`, {
        method: 'PATCH',
        body: JSON.stringify({ marginMode: 'cross' }),
      });
      check('margin mode switch is locked while positions exist', lockMode.status === 409,
        `status=${lockMode.status} code=${lockMode.body?.error?.code}`);

      const close = await api(`/api/accounts/${levId}/orders`, {
        method: 'POST',
        body: JSON.stringify({ symbol: 'crypto:ETHUSDT', side: 'sell', type: 'market', close: true }),
      });
      const afterClose = (await api(`/api/accounts/${levId}`)).body;
      check('close order flattens the margin position',
        close.status === 201 && !(afterClose.positions || []).some((p) => p.symbol === 'crypto:ETHUSDT'),
        `status=${close.status} positions=${(afterClose.positions || []).length}`);

      const switchMode = await api(`/api/accounts/${levId}`, {
        method: 'PATCH',
        body: JSON.stringify({ marginMode: 'cross' }),
      });
      check('margin mode switch allowed on a flat account', switchMode.status === 200
        && switchMode.body?.account?.marginMode === 'cross', `status=${switchMode.status}`);
    } else {
      console.log('WARN  加密行情不可用，跳过杠杆/保证金冒烟');
    }

    const equity = await api(`/api/accounts/${accountId}/equity?range=all`);
    check('GET equity series returns points', Array.isArray(equity.body?.points),
      `${(equity.body?.points || []).length} points`);

    const csvRes = await fetch(`${BASE}/api/accounts/${accountId}/export/trades.csv`);
    const csvText = await csvRes.text();
    check('GET trades.csv exports CSV with header', csvRes.status === 200 && csvText.includes('时间'),
      `${csvText.length} bytes`);

    const tick = await api('/api/dev/tick', { method: 'POST' });
    check('POST /api/dev/tick works', tick.status === 200 && tick.body?.ok === true, `status=${tick.status}`);

    const missing = await api('/api/accounts/nope');
    check('unknown account -> 404 JSON error',
      missing.status === 404 && missing.body?.error?.code === 'ACCOUNT_NOT_FOUND',
      `status=${missing.status}`);

    const staticRes = await fetch(`${BASE}/`);
    const html = await staticRes.text();
    check('GET / serves the SPA shell', staticRes.status === 200 && html.includes('<html'),
      `${html.length} bytes`);

    // Wait one matching-loop cycle to make sure the timer path does not crash.
    await new Promise((r) => setTimeout(r, 2600));
  } catch (err) {
    check(`smoke test aborted: ${err.message}`, false);
  } finally {
    child.kill();
    await new Promise((r) => {
      child.once('exit', r);
      setTimeout(r, 3000);
    });
    logStream.end();
    cleanupDataDir();
    try {
      fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed.length})`}  ${results.length} checks`);
  if (failed.length) {
    exitCode = 1;
    console.log('失败项：' + failed.map((r) => r.name).join(' | '));
  }
  process.exit(exitCode);
}

main();
