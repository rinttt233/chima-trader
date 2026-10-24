// ChimaTrader (千亦所) — HTTP server: REST API, background matching loop, static SPA.
// No third-party dependencies. Node 24+, ESM.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './lib/store.mjs';
import * as engine from './lib/engine.mjs';
import * as stats from './lib/stats.mjs';
import * as marketdata from './lib/marketdata.mjs';
import { parseSymbol } from './lib/symbols.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const CFG = CONFIG;
const DATA_DIR = path.resolve(ROOT, process.env.CHIMATRADER_DATA_DIR || process.env.PAPERTRADER_DATA_DIR || CONFIG.dataDir || 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || CONFIG.server?.port || 8787);
const HOST = process.env.HOST || CONFIG.server?.host || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const store = createStore({ dataDir: DATA_DIR });
store.load();
bootstrap(store.state, store);

const state = store.state;
const STARTED_AT = Date.now();
let healthCache = { at: 0, value: null };
let ticking = false;
let tickTimer = null;
let lastSnapshotAt = 0;

// ---------------------------------------------------------------- helpers

function bootstrap(st, stStore) {
  st.accounts = st.accounts || {};
  st.watchlist = Array.isArray(st.watchlist) && st.watchlist.length
    ? st.watchlist
    : (CONFIG.defaults?.watchlist || []).slice();
  st.alerts = st.alerts || [];
  // Normalise existing accounts (v3 settings may be missing on older state files).
  for (const account of Object.values(st.accounts)) {
    account.settings = mergeSettings(defaultAccountSettings(), account.settings || {});
    if (!account.marginMode) account.marginMode = 'isolated';
  }
  // Create the starter account only for a genuinely fresh state. The store's
  // normalizer drops unknown top-level flags, so rely on "no accounts yet".
  if (st.bootstrapped || Object.keys(st.accounts).length > 0) {
    st.bootstrapped = true;
    return;
  }
  st.bootstrapped = true;
  const id = stStore.nextId('acc');
  const account = engine.createAccount({
    id,
    name: '默认账户',
    initialCapital: Number(CONFIG.defaults?.initialCapital) || 1000000,
    baseCurrency: CONFIG.defaults?.baseCurrency || 'CNY',
  });
  account.settings = defaultAccountSettings();
  st.accounts[id] = account;
  stStore.save();
}

// ------------------------------------------------ account-level settings (v3)

const SETTINGS_META = CONFIG.accountSettings || {};
const SETTINGS_RANGES = SETTINGS_META.ranges || {};
const LEVERAGE_CEILING = { cn: 1, hk: 20, us: 20, fx: 500, crypto: 125, ...(SETTINGS_META.leverageCeiling || {}) };
const MARKETS = ['cn', 'hk', 'us', 'fx', 'crypto'];

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultAccountSettings() {
  return {
    leverageMultiplier: 1,
    fees: cloneJson(CONFIG.fees || {}),
    slippageBps: cloneJson(CONFIG.slippageBps || {}),
    margin: cloneJson(CONFIG.margin || {}),
    autoConvert: CONFIG.autoConvert !== false,
    fxConvertSpread: num(CONFIG.fxConvertSpread, 0.003),
  };
}

function mergeFees(base, patch) {
  const out = cloneJson(base || {});
  for (const [market, values] of Object.entries(patch || {})) {
    if (!values || typeof values !== 'object') continue;
    out[market] = { ...(out[market] || {}), ...values };
  }
  return out;
}

function mergeSettings(base, patch) {
  const out = cloneJson(base);
  if (!patch || typeof patch !== 'object') return out;
  if (patch.leverageMultiplier !== undefined) out.leverageMultiplier = num(patch.leverageMultiplier, out.leverageMultiplier);
  if (patch.fees) out.fees = mergeFees(out.fees, patch.fees);
  if (patch.slippageBps) out.slippageBps = { ...out.slippageBps, ...patch.slippageBps };
  if (patch.margin) {
    out.margin = out.margin || {};
    for (const key of ['mmr', 'interestAnnual', 'liquidationFeeRate']) {
      if (patch.margin[key]) out.margin[key] = { ...(out.margin[key] || {}), ...patch.margin[key] };
    }
  }
  if (patch.autoConvert !== undefined) out.autoConvert = patch.autoConvert !== false;
  if (patch.fxConvertSpread !== undefined) out.fxConvertSpread = num(patch.fxConvertSpread, out.fxConvertSpread);
  return out;
}

// Per-account leverage ceiling: base config leverage scaled by the account multiplier, clamped.
function effectiveLeverage(settings) {
  const multiplier = num(settings?.leverageMultiplier, 1);
  const out = {};
  for (const market of MARKETS) {
    if (market === 'cn') {
      out.cn = 1;
      continue;
    }
    const base = num(CONFIG.leverage?.[market], 1);
    const ceiling = num(LEVERAGE_CEILING[market], base);
    out[market] = Math.min(ceiling, Math.max(1, Math.round(base * multiplier)));
  }
  return out;
}

function rangeCheck(errors, field, value, range) {
  if (!Array.isArray(range) || range.length !== 2) return;
  const [min, max] = range;
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${field} 必须在 ${min} – ${max} 之间`);
  }
}

function validateSettings(settings) {
  const errors = [];
  const ranges = SETTINGS_RANGES;
  rangeCheck(errors, 'leverageMultiplier', num(settings.leverageMultiplier, NaN), ranges.leverageMultiplier);
  const leverage = effectiveLeverage(settings);
  for (const market of MARKETS) {
    const mmr = num(settings?.margin?.mmr?.[market], NaN);
    rangeCheck(errors, `margin.mmr.${market}`, mmr, ranges.margin?.mmr?.[market]);
    if (market !== 'cn' && Number.isFinite(mmr) && mmr > 0.9 / leverage[market]) {
      errors.push(`margin.mmr.${market} 不能高于 0.9 / 杠杆上限(${leverage[market]}x)`);
    }
    rangeCheck(errors, `slippageBps.${market}`, num(settings?.slippageBps?.[market], NaN), ranges.slippageBps);
    rangeCheck(errors, `margin.interestAnnual.${market}`, num(settings?.margin?.interestAnnual?.[market], NaN), ranges.margin?.interestAnnual);
    rangeCheck(errors, `margin.liquidationFeeRate.${market}`, num(settings?.margin?.liquidationFeeRate?.[market], NaN), ranges.margin?.liquidationFeeRate);
    const fees = settings?.fees?.[market] || {};
    for (const [key, range] of Object.entries(ranges.fees || {})) {
      if (fees[key] === undefined) continue;
      rangeCheck(errors, `fees.${market}.${key}`, num(fees[key], NaN), range);
    }
  }
  rangeCheck(errors, 'fxConvertSpread', num(settings.fxConvertSpread, NaN), ranges.fxConvertSpread);
  if (typeof settings.autoConvert !== 'boolean') errors.push('autoConvert 必须是布尔值');
  return errors;
}

function effectiveCfg(account) {
  const settings = mergeSettings(defaultAccountSettings(), account?.settings || {});
  return {
    ...CONFIG,
    leverage: effectiveLeverage(settings),
    fees: settings.fees,
    slippageBps: settings.slippageBps,
    margin: settings.margin,
    autoConvert: settings.autoConvert !== false,
    fxConvertSpread: num(settings.fxConvertSpread, 0.003),
  };
}

function settingsLocked(account) {
  const hasPosition = Object.values(account?.positions || {}).some((pos) => Number(pos?.qty) > 0);
  const hasOpenOrder = (account?.orders || []).some((order) => order.status === 'open');
  return hasPosition || hasOpenOrder;
}

function riskSettingsKey(settings) {
  return JSON.stringify({
    leverageMultiplier: num(settings.leverageMultiplier, 1),
    margin: settings.margin || {},
  });
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function fail(res, err) {
  const code = err?.code || 'INTERNAL';
  const status = err?.status || 500;
  const message = err?.expose || '服务器内部错误';
  if (status >= 500) console.error('[server]', err);
  sendError(res, status, code, message);
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.expose = message;
  return e;
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'BODY_TOO_LARGE', '请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw httpError(400, 'BAD_JSON', '请求体不是合法的 JSON 对象');
  }
}

function canonSymbol(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = parseSymbol(trimmed);
    return parsed?.symbol || null;
  } catch {
    return null;
  }
}

function splitSymbols(raw) {
  if (!raw) return [];
  return [...new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => canonSymbol(s) || s),
  )];
}

function getAccountOr404(id) {
  const account = store.getAccount(id);
  if (!account) throw httpError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
  return account;
}

function clampInt(value, def, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function isIndexSymbol(symbol) {
  const parsed = parseSymbol(symbol);
  if (!parsed || parsed.market !== 'cn') return false;
  return /^(sh000\d{3}|sz399\d{3}|bj899\d{3})$/.test(parsed.code);
}

function accountSymbols(account) {
  const set = new Set(Object.keys(account.positions || {}));
  for (const order of account.orders || []) {
    if (order.status === 'open') set.add(order.symbol);
  }
  return [...set];
}

// Spendable amount per currency, including the automatic CNY->X conversion the
// engine performs on buy orders (contract §6.6). `cash` itself stays untouched.
function computeBuyingPower(view, fxRates, baseCurrency = 'CNY') {
  const cash = view?.cash || {};
  const base = cash[baseCurrency] ?? 0;
  const baseRate = Number(fxRates?.[baseCurrency]) || 1;
  const spread = Number(CONFIG.fxConvertSpread) || 0;
  const out = {};
  for (const currency of ['CNY', 'HKD', 'USD', 'USDT']) {
    const own = Number(cash[currency]) || 0;
    if (currency === baseCurrency) {
      out[currency] = round2(own);
      continue;
    }
    const rate = Number(fxRates?.[currency]) || 1;
    const convertible = CONFIG.autoConvert === false ? 0 : base * (baseRate / rate) * (1 - spread);
    out[currency] = round2(own + Math.max(0, convertible));
  }
  return out;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// A quote older than this cannot be used to fill an order: the exchange is closed
// (weekend/holiday) even though the wall-clock may sit inside the session window.
const STALE_QUOTE_MS = 10 * 60 * 1000;

function isQuoteFresh(quote) {
  if (!quote) return false;
  if (quote.market === 'crypto') return true; // 24x7
  const ts = Date.parse(quote.ts);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= STALE_QUOTE_MS;
}

function freshQuotesForMatching(quotesBySymbol) {
  const out = {};
  for (const [symbol, quote] of Object.entries(quotesBySymbol || {})) {
    if (isQuoteFresh(quote)) out[symbol] = quote;
  }
  return out;
}

async function getHealth() {  const now = Date.now();
  if (healthCache.value && now - healthCache.at < 20_000) return healthCache.value;
  let sources = [];
  try {
    sources = await marketdata.health();
  } catch (err) {
    sources = [{ source: 'marketdata', ok: false, latencyMs: null, message: String(err?.message || err) }];
  }
  healthCache = { at: now, value: sources };
  return sources;
}

// ---------------------------------------------------------------- matching loop

async function runTick(reason = 'interval') {
  if (ticking) return;
  ticking = true;
  try {
    const accounts = Object.values(state.accounts || {});
    if (!accounts.length) return;

    const symbols = [...new Set(accounts.flatMap(accountSymbols))];
    let quotesBySymbol = {};
    let fxRates = { CNY: 1, USD: 7, HKD: 0.9, USDT: 7 };
    if (symbols.length) {
      const [quoteResult, rates] = await Promise.all([
        marketdata.getQuotes(symbols).catch((err) => {
          console.warn('[tick] quotes failed:', err?.message || err);
          return { quotes: [], errors: [] };
        }),
        marketdata.getFxRates().catch(() => fxRates),
      ]);
      quotesBySymbol = Object.fromEntries((quoteResult.quotes || []).map((q) => [q.symbol, q]));
      if (rates && typeof rates === 'object') fxRates = rates;
    }

    const now = nowIso();
    const snapshotDue = Date.now() - lastSnapshotAt >= (CONFIG.refresh?.equitySnapshotMs || 60_000);
    for (const account of accounts) {
      const cfg = effectiveCfg(account);
      const prevDay = account.dayKey;
      let preTickEquity = null;
      try {
        const preView = engine.portfolioView(account, quotesBySymbol, fxRates, now, cfg);
        preTickEquity = Number(preView?.equity?.total);
      } catch {
        preTickEquity = null;
      }
      try {
        engine.rollDay(account, now, Number.isFinite(preTickEquity) ? preTickEquity : undefined);
      } catch (err) {
        console.warn('[tick] rollDay failed:', err?.message || err);
      }
      try {
        if (typeof engine.accrueInterest === 'function') engine.accrueInterest(account, now);
      } catch (err) {
        console.warn('[tick] accrueInterest failed:', err?.message || err);
      }
      try {
        engine.tickAccount(account, freshQuotesForMatching(quotesBySymbol), { cfg, now, fxRates });
      } catch (err) {
        console.warn('[tick] tickAccount failed:', err?.message || err);
      }
      try {
        if (typeof engine.checkRisk === 'function') {
          const risk = engine.checkRisk(account, freshQuotesForMatching(quotesBySymbol), fxRates, { cfg, now });
          if (risk?.liquidations?.length) {
            for (const item of risk.liquidations) {
              console.log(`[risk] ${account.id} 强平 ${item.symbol} ${item.side || ''} qty=${item.qty} @${item.price}`);
            }
          }
          if (risk?.triggered?.length) {
            for (const item of risk.triggered) {
              console.log(`[risk] ${account.id} 触发 ${item.reason || 'TP/SL'} ${item.symbol} @${item.price}`);
            }
          }
          if (risk?.liquidations?.length || risk?.triggered?.length) store.save();
        }
      } catch (err) {
        console.warn('[tick] checkRisk failed:', err?.message || err);
      }
      if (account.dayKey !== prevDay) {
        console.log(`[tick] day rolled for account ${account.id}: ${prevDay} -> ${account.dayKey}`);
      }
      if (snapshotDue) {
        try {
          const view = engine.portfolioView(account, quotesBySymbol, fxRates, now, cfg);
          const equity = Number(view?.equity?.total);
          if (Number.isFinite(equity)) {
            account.equityHistory = account.equityHistory || [];
            const last = account.equityHistory[account.equityHistory.length - 1];
            if (!last || Date.parse(now) - Date.parse(last.t) >= 30_000) {
              account.equityHistory.push({ t: now, equity: Math.round(equity * 100) / 100 });
              if (account.equityHistory.length > 20000) account.equityHistory.splice(0, account.equityHistory.length - 20000);
            }
          }
        } catch (err) {
          console.warn('[tick] snapshot failed:', err?.message || err);
        }
      }
      checkAlerts(account, quotesBySymbol, now);
    }
    if (snapshotDue) lastSnapshotAt = Date.now();
    store.saveDebounced();
  } catch (err) {
    console.warn('[tick] unexpected:', err?.message || err);
  } finally {
    ticking = false;
  }
  if (reason === 'manual') console.log('[tick] manual tick done');
}

function checkAlerts(account, quotesBySymbol, now) {
  const alerts = state.alerts || [];
  for (const alert of alerts) {
    if (alert.triggeredAt) continue;
    const quote = quotesBySymbol[alert.symbol];
    if (!quote || !Number.isFinite(quote.price)) continue;
    const hit = alert.direction === 'above' ? quote.price >= alert.price : quote.price <= alert.price;
    if (hit) {
      alert.triggeredAt = now;
      alert.triggeredPrice = quote.price;
    }
  }
}

// ---------------------------------------------------------------- live quote stream (SSE)

const STREAM_CFG = CONFIG.refresh?.stream || {};
const STREAM_BASE_MS = Math.max(200, Number(STREAM_CFG.cryptoMs) || 500);
const FX_EVERY = Math.max(1, Math.round((Number(STREAM_CFG.fxMs) || 1000) / STREAM_BASE_MS));
const STOCK_EVERY = Math.max(1, Math.round((Number(STREAM_CFG.stockMs) || 2000) / STREAM_BASE_MS));
const HEARTBEAT_MS = Number(STREAM_CFG.heartbeatMs) || 15_000;

const streamClients = new Set();
const streamQuotes = new Map();
const streamErrors = new Map();
let streamTimer = null;
let streamTick = 0;
let streamLastHeartbeat = 0;
let streamRunning = false;

function streamSymbols() {
  const set = new Set(store.getWatchlist());
  for (const account of Object.values(state.accounts || {})) {
    for (const symbol of accountSymbols(account)) set.add(symbol);
  }
  for (const client of streamClients) {
    for (const symbol of client.symbols) set.add(symbol);
  }
  return [...set];
}

function quotesPayload(symbols) {
  const quotes = [];
  const errors = [];
  for (const symbol of symbols) {
    const quote = streamQuotes.get(symbol);
    if (quote) quotes.push(quote);
    else if (streamErrors.has(symbol)) errors.push({ symbol, message: streamErrors.get(symbol) });
  }
  return { quotes, errors, ts: nowIso() };
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...streamClients]) {
    try {
      client.res.write(frame);
    } catch {
      streamClients.delete(client);
    }
  }
}

async function fetchStreamGroup(markets) {
  const targets = streamSymbols().filter((symbol) => markets.includes(parseSymbol(symbol)?.market));
  if (!targets.length) return false;
  try {
    const result = await marketdata.getQuotes(targets, { maxAgeMs: 0 });
    for (const quote of result.quotes || []) {
      streamQuotes.set(quote.symbol, quote);
      streamErrors.delete(quote.symbol);
    }
    for (const error of result.errors || []) streamErrors.set(error.symbol, error.message);
    return true;
  } catch {
    return false;
  }
}

async function streamLoop() {
  if (streamRunning) return;
  streamRunning = true;
  try {
    if (!streamClients.size) return;
    streamTick += 1;
    let changed = false;
    if (await fetchStreamGroup(['crypto'])) changed = true;
    if (streamTick % FX_EVERY === 0 && (await fetchStreamGroup(['fx']))) changed = true;
    if (streamTick % STOCK_EVERY === 0 && (await fetchStreamGroup(['cn', 'hk', 'us']))) changed = true;
    if (changed) broadcast('quotes', quotesPayload(streamSymbols()));
    if (Date.now() - streamLastHeartbeat >= HEARTBEAT_MS) {
      streamLastHeartbeat = Date.now();
      broadcast('heartbeat', { ts: nowIso() });
    }
  } finally {
    streamRunning = false;
  }
}

function ensureStreamLoop() {
  if (streamTimer) return;
  streamTimer = setInterval(() => {
    streamLoop().catch((err) => console.warn('[stream]', err?.message || err));
  }, STREAM_BASE_MS);
  streamTimer.unref?.();
}

function stopStreamLoop() {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
}

// ---------------------------------------------------------------- routes

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

route('GET', /^\/api\/health$/, async (_req, res) => {
  sendJson(res, 200, {
    ok: true,
    version: 1,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    serverTime: nowIso(),
    sources: await getHealth(),
  });
});

route('GET', /^\/api\/markets$/, async (_req, res) => {
  const meta = await marketdata.getMarkets();
  const markets = (meta || []).map((m) => ({
    ...m,
    sessions: CONFIG.sessions?.[m.id] || m.sessions || [],
    maxLeverage: Number(CONFIG.leverage?.[m.id] ?? 1),
    mmr: Number(CONFIG.margin?.mmr?.[m.id] ?? 1),
    shortable: m.id !== 'cn' && Number(CONFIG.leverage?.[m.id] ?? 1) > 1,
  }));
  sendJson(res, 200, { markets });
});

route('GET', /^\/api\/stream$/, async (req, res, url) => {
  const extraSymbols = splitSymbols(url.searchParams.get('symbols'));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const client = { res, symbols: new Set(extraSymbols) };
  streamClients.add(client);
  try {
    const initial = await marketdata.getQuotes(streamSymbols(), { maxAgeMs: 0 });
    for (const quote of initial.quotes || []) {
      streamQuotes.set(quote.symbol, quote);
      streamErrors.delete(quote.symbol);
    }
    for (const error of initial.errors || []) streamErrors.set(error.symbol, error.message);
  } catch {
    /* the stream loop will retry */
  }
  try {
    res.write(`event: quotes\ndata: ${JSON.stringify(quotesPayload(streamSymbols()))}\n\n`);
  } catch {
    /* client already gone */
  }
  ensureStreamLoop();
  req.on('close', () => {
    streamClients.delete(client);
    if (!streamClients.size) stopStreamLoop();
  });
});

route('GET', /^\/api\/quotes$/, async (req, res, url) => {
  const symbols = splitSymbols(url.searchParams.get('symbols'));
  if (!symbols.length) throw httpError(400, 'SYMBOLS_REQUIRED', '缺少 symbols 参数');
  if (symbols.length > 80) throw httpError(400, 'TOO_MANY_SYMBOLS', '一次最多查询 80 个标的');
  const result = await marketdata.getQuotes(symbols);
  sendJson(res, 200, { quotes: result.quotes || [], errors: result.errors || [] });
});

route('GET', /^\/api\/kline$/, async (_req, res, url) => {
  const symbol = url.searchParams.get('symbol');
  const interval = url.searchParams.get('interval') || '1d';
  const limit = clampInt(url.searchParams.get('limit'), 300, 1, 2000);
  if (!symbol) throw httpError(400, 'SYMBOL_REQUIRED', '缺少 symbol 参数');
  const result = await marketdata.getKline(symbol, interval, limit);
  sendJson(res, 200, {
    symbol: result.symbol || symbol,
    interval: result.interval || interval,
    bars: result.bars || [],
  });
});

route('GET', /^\/api\/universe$/, async (_req, res, url) => {
  const market = String(url.searchParams.get('market') || '').toLowerCase();
  if (!['cn', 'hk', 'us', 'fx', 'crypto'].includes(market)) {
    throw httpError(400, 'MARKET_INVALID', 'market 只能是 cn/hk/us/fx/crypto');
  }
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 300);
  const sort = String(url.searchParams.get('sort') || 'amount').toLowerCase();
  if (sort !== 'amount' && sort !== 'change') {
    throw httpError(400, 'SORT_INVALID', 'sort 只能是 amount 或 change');
  }
  if (typeof marketdata.getUniverse !== 'function') {
    throw httpError(503, 'UNIVERSE_UNAVAILABLE', '标的全市场列表暂不可用');
  }
  const result = await marketdata.getUniverse(market, { limit, sort });
  sendJson(res, 200, {
    market,
    items: result?.items || [],
    source: result?.source || 'unknown',
    updatedAt: result?.updatedAt || nowIso(),
    note: result?.note,
  });
});

route('GET', /^\/api\/search$/, async (_req, res, url) => {
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 50);
  if (q.length < 1) {
    sendJson(res, 200, { results: [] });
    return;
  }
  const results = await marketdata.search(q, limit);
  sendJson(res, 200, { results: results || [] });
});

route('GET', /^\/api\/watchlist$/, async (_req, res) => {
  sendJson(res, 200, { symbols: store.getWatchlist() });
});

route('PUT', /^\/api\/watchlist$/, async (req, res) => {
  const body = await readJsonBody(req);
  const symbols = Array.isArray(body.symbols) ? body.symbols.map(String) : null;
  if (!symbols) throw httpError(400, 'SYMBOLS_REQUIRED', 'body.symbols 必须是数组');
  const cleaned = [];
  for (const raw of symbols) {
    const symbol = canonSymbol(raw);
    if (!symbol) throw httpError(400, 'SYMBOL_INVALID', `无法识别的代码：${raw}`);
    if (!cleaned.includes(symbol)) cleaned.push(symbol);
  }
  store.setWatchlist(cleaned);
  store.saveDebounced();
  sendJson(res, 200, { symbols: cleaned });
});

route('GET', /^\/api\/accounts$/, async (_req, res) => {
  sendJson(res, 200, { accounts: store.listAccounts() });
});

route('GET', /^\/api\/settings\/meta$/, async (_req, res) => {
  const metaMarkets = (await marketdata.getMarkets()) || [];
  const markets = metaMarkets.map((market) => ({
    id: market.id,
    name: market.name,
    currency: market.currency,
    baseLeverage: num(CONFIG.leverage?.[market.id], 1),
    maxLeverageCeiling: num(LEVERAGE_CEILING[market.id], num(CONFIG.leverage?.[market.id], 1)),
    shortable: market.id !== 'cn',
  }));
  sendJson(res, 200, {
    markets,
    ranges: SETTINGS_RANGES,
    presets: SETTINGS_META.presets || {},
    multiplier: {
      range: SETTINGS_RANGES.leverageMultiplier || [0.1, 2],
      default: 1,
      quick: [0.1, 0.25, 0.5, 1, 2],
    },
    defaults: {
      settings: defaultAccountSettings(),
      initialCapital: num(CONFIG.defaults?.initialCapital, 1_000_000),
      baseCurrency: CONFIG.defaults?.baseCurrency || 'CNY',
    },
  });
});

route('POST', /^\/api\/accounts$/, async (req, res) => {
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim() || `账户 ${Object.keys(state.accounts).length + 1}`;
  const initialCapital = Number(body.initialCapital);
  if (!Number.isFinite(initialCapital) || initialCapital < 1000 || initialCapital > 1_000_000_000) {
    throw httpError(400, 'CAPITAL_INVALID', '初始资金需在 1,000 – 1,000,000,000 之间');
  }
  const settings = mergeSettings(defaultAccountSettings(), body.settings || {});
  const settingsErrors = validateSettings(settings);
  if (settingsErrors.length) {
    throw httpError(400, 'SETTINGS_INVALID', settingsErrors.slice(0, 6).join('；'));
  }
  const id = store.nextId('acc');
  const account = engine.createAccount({
    id,
    name,
    initialCapital,
    baseCurrency: String(body.baseCurrency || 'CNY'),
  });
  account.settings = settings;
  if (String(body.marginMode) === 'cross') account.marginMode = 'cross';
  store.addAccount(account);
  store.save();
  sendJson(res, 201, { account, settings });
});

route('DELETE', /^\/api\/accounts\/([^/]+)$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/').pop());
  if (!store.getAccount(id)) throw httpError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
  store.removeAccount(id);
  store.save();
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/accounts\/([^/]+)\/reset$/, async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const body = await readJsonBody(req);
  const initialCapital = Number(body.initialCapital ?? account.initialCapital);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw httpError(400, 'CAPITAL_INVALID', '初始资金必须是大于 0 的数字');
  }
  const rebuilt = engine.createAccount({
    id: account.id,
    name: account.name,
    initialCapital,
    baseCurrency: account.baseCurrency,
  });
  rebuilt.marginMode = account.marginMode || 'isolated';
  rebuilt.settings = mergeSettings(defaultAccountSettings(), account.settings || {});
  store.replaceAccount(rebuilt);
  store.save();
  sendJson(res, 200, { account: rebuilt });
});

route('PATCH', /^\/api\/accounts\/([^/]+)\/settings$/, async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const body = await readJsonBody(req);
  const before = mergeSettings(defaultAccountSettings(), account.settings || {});
  const after = mergeSettings(before, body.settings || {});
  const errors = validateSettings(after);
  if (errors.length) throw httpError(400, 'SETTINGS_INVALID', errors.slice(0, 6).join('；'));
  if (settingsLocked(account) && riskSettingsKey(before) !== riskSettingsKey(after)) {
    throw httpError(409, 'SETTINGS_LOCKED', '有持仓或未成交委托时不能修改杠杆上限倍率与保证金参数');
  }
  account.settings = after;
  store.save();
  sendJson(res, 200, {
    account,
    settings: after,
    effective: {
      leverage: effectiveCfg(account).leverage,
      fees: after.fees,
      slippageBps: after.slippageBps,
      margin: after.margin,
    },
  });
});

route('GET', /^\/api\/accounts\/([^/]+)\/stats$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  sendJson(res, 200, stats.computeStats(account));
});

route('GET', /^\/api\/accounts\/([^/]+)\/equity$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const range = url.searchParams.get('range') || '1d';
  const points = stats.equitySeries(account, range, nowIso());
  sendJson(res, 200, { points, stats: stats.computeStats(account) });
});

route('GET', /^\/api\/accounts\/([^/]+)\/orders$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const status = url.searchParams.get('status') || 'all';
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000);
  let orders = [...(account.orders || [])].reverse();
  if (status === 'open') orders = orders.filter((o) => o.status === 'open');
  else if (status === 'filled') orders = orders.filter((o) => o.status === 'filled');
  else if (status === 'cancelled') orders = orders.filter((o) => o.status === 'cancelled' || o.status === 'rejected');
  else if (status !== 'all') throw httpError(400, 'STATUS_INVALID', 'status 只能是 all/open/filled/cancelled');
  sendJson(res, 200, { orders: orders.slice(0, limit) });
});

route('GET', /^\/api\/accounts\/([^/]+)\/trades$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000);
  sendJson(res, 200, { trades: [...(account.trades || [])].reverse().slice(0, limit) });
});

route('GET', /^\/api\/accounts\/([^/]+)\/export\/trades\.csv$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const header = ['时间', '代码', '名称', '市场', '方向', '数量', '价格', '手续费', '实现盈亏', '币种'];
  const rows = [...(account.trades || [])]
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .map((t) => [
      t.t,
      t.symbol,
      t.name || '',
      t.market || '',
      t.side === 'buy' ? '买入' : '卖出',
      t.qty,
      t.price,
      t.fees ?? '',
      t.realizedPnl ?? '',
      t.currency || '',
    ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const payload = `\uFEFF${csv}`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="trades-${account.id}.csv"`,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
});

route('GET', /^\/api\/accounts\/([^/]+)\/orders\/([^/]+)$/, async (req, res, url) => {
  // reserved for single order lookup; DELETE handled below
  throw httpError(405, 'METHOD_NOT_ALLOWED', '不支持该请求方法');
});

route('DELETE', /^\/api\/accounts\/([^/]+)\/orders\/([^/]+)$/, async (_req, res, url) => {
  const parts = url.pathname.split('/');
  const id = decodeURIComponent(parts[3]);
  const orderId = decodeURIComponent(parts[5]);
  const account = getAccountOr404(id);
  const order = (account.orders || []).find((o) => o.id === orderId);
  if (!order) throw httpError(404, 'ORDER_NOT_FOUND', '委托不存在');
  if (order.status !== 'open') throw httpError(409, 'ORDER_NOT_OPEN', '该委托不是可撤销状态');
  order.status = 'cancelled';
  order.updatedAt = nowIso();
  order.rejectCode = 'USER_CANCELLED';
  order.rejectMessage = '用户撤单';
  store.save();
  sendJson(res, 200, { ok: true, order });
});

route('PATCH', /^\/api\/accounts\/([^/]+)\/orders\/([^/]+)$/, async (req, res, url) => {
  const parts = url.pathname.split('/');
  const id = decodeURIComponent(parts[3]);
  const orderId = decodeURIComponent(parts[5]);
  const account = getAccountOr404(id);
  const body = await readJsonBody(req);
  const limitPrice = Number(body.limitPrice);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw httpError(400, 'PRICE_INVALID', '请输入有效的新价格');
  }
  const order = (account.orders || []).find((item) => item.id === orderId);
  if (!order) throw httpError(404, 'ORDER_NOT_FOUND', '委托不存在');
  const quoteResult = await marketdata.getQuotes([order.symbol]).catch(() => ({ quotes: [] }));
  const quote = quoteResult.quotes?.[0];
  if (!quote) throw httpError(502, 'DATA_UNAVAILABLE', '无法获取该标的行情');
  const result = engine.amendOrder(account, orderId, { limitPrice }, quote, { cfg: CFG, now: nowIso() });
  if (!result?.ok) {
    sendError(res, 400, result?.code || 'AMEND_REJECTED', result?.message || '改价失败');
    return;
  }
  store.save();
  sendJson(res, 200, { ok: true, order: result.order || order });
});

route('PATCH', /^\/api\/accounts\/([^/]+)$/, async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const body = await readJsonBody(req);
  const mode = String(body.marginMode || '').toLowerCase();
  if (mode !== 'isolated' && mode !== 'cross') {
    throw httpError(400, 'MARGIN_MODE_INVALID', 'marginMode 只能是 isolated 或 cross');
  }
  const result = engine.setMarginMode(account, mode);
  if (!result?.ok) {
    sendError(res, 409, result?.code || 'MARGIN_MODE_LOCKED', result?.message || '当前有持仓或挂单，无法切换保证金模式');
    return;
  }
  store.save();
  sendJson(res, 200, { account });
});

route('POST', /^\/api\/accounts\/([^/]+)\/positions\/([^/]+)\/protect$/, async (req, res, url) => {
  const parts = url.pathname.split('/');
  const id = decodeURIComponent(parts[3]);
  const symbol = canonSymbol(decodeURIComponent(parts[5]));
  if (!symbol) throw httpError(400, 'SYMBOL_INVALID', '无法识别的代码');
  const account = getAccountOr404(id);
  if (!account.positions?.[symbol]) throw httpError(404, 'POSITION_NOT_FOUND', '当前没有该标的持仓');
  const body = await readJsonBody(req);
  const takeProfit = body.takeProfit == null || body.takeProfit === '' ? null : Number(body.takeProfit);
  const stopLoss = body.stopLoss == null || body.stopLoss === '' ? null : Number(body.stopLoss);
  for (const [label, value] of [['takeProfit', takeProfit], ['stopLoss', stopLoss]]) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      throw httpError(400, 'PROTECT_PRICE_INVALID', `${label} 必须是大于 0 的价格或留空`);
    }
  }
  const quoteResult = await marketdata.getQuotes([symbol]).catch(() => ({ quotes: [] }));
  const quote = quoteResult.quotes?.[0];
  if (!quote) throw httpError(502, 'DATA_UNAVAILABLE', '无法获取该标的行情');
  const result = engine.setProtect(account, symbol, { takeProfit, stopLoss }, quote, CFG);
  if (!result?.ok) {
    sendError(res, 400, result?.code || 'PROTECT_REJECTED', result?.message || '设置止盈止损失败');
    return;
  }
  store.save();
  sendJson(res, 200, { ok: true, position: account.positions[symbol] });
});

route('POST', /^\/api\/accounts\/([^/]+)\/orders$/, async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const body = await readJsonBody(req);
  const symbol = canonSymbol(body.symbol);
  if (!symbol) throw httpError(400, 'SYMBOL_INVALID', `无法识别的代码：${body.symbol}`);
  if (isIndexSymbol(symbol)) throw httpError(400, 'NOT_TRADEABLE', '指数仅用于展示，不能交易');
  const side = String(body.side || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') throw httpError(400, 'SIDE_INVALID', 'side 只能是 buy 或 sell');
  const type = String(body.type || 'market').toLowerCase();
  if (type !== 'market' && type !== 'limit') throw httpError(400, 'TYPE_INVALID', 'type 只能是 market 或 limit');
  const close = body.close === true;
  const leverageRaw = body.leverage == null ? 1 : Number(body.leverage);
  if (!Number.isFinite(leverageRaw) || leverageRaw < 1) {
    throw httpError(400, 'LEVERAGE_INVALID', '杠杆必须是不小于 1 的数字');
  }
  let qty = Number(body.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    if (close) qty = undefined; // engine closes the whole position
    else throw httpError(400, 'QTY_INVALID', '数量必须是大于 0 的数字');
  }
  const limitPrice = body.limitPrice == null ? null : Number(body.limitPrice);
  if (type === 'limit' && (!Number.isFinite(limitPrice) || limitPrice <= 0)) {
    throw httpError(400, 'PRICE_INVALID', '限价单必须提供大于 0 的 limitPrice');
  }
  const takeProfit = body.takeProfit == null || body.takeProfit === '' ? null : Number(body.takeProfit);
  const stopLoss = body.stopLoss == null || body.stopLoss === '' ? null : Number(body.stopLoss);
  for (const [label, value] of [['takeProfit', takeProfit], ['stopLoss', stopLoss]]) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      throw httpError(400, 'PROTECT_PRICE_INVALID', `${label} 必须是大于 0 的价格或留空`);
    }
  }

  const [quoteResult, rates] = await Promise.all([
    marketdata.getQuotes([symbol]).catch(() => ({ quotes: [] })),
    marketdata.getFxRates().catch(() => null),
  ]);
  const quote = quoteResult.quotes?.[0];
  if (!quote) {
    const why = quoteResult.errors?.[0]?.message || '无法获取该标的行情';
    throw httpError(502, 'DATA_UNAVAILABLE', why);
  }

  const now = nowIso();
  const cfg = effectiveCfg(account);
  engine.rollDay(account, now);
  if (typeof engine.accrueInterest === 'function') engine.accrueInterest(account, now);
  // A market order must fill at a live price; stale quotes mean the exchange is
  // actually closed (holiday/weekend) even if the session clock says otherwise.
  if (type === 'market' && !isQuoteFresh(quote)) {
    throw httpError(400, 'MARKET_CLOSED', '该市场当前休市或行情已过期，市价单无法成交');
  }
  const result = engine.placeOrder(account, {
    symbol, side, type, qty, limitPrice, leverage: leverageRaw, close, takeProfit, stopLoss,
  }, quote, {
    cfg,
    now,
    fxRates: rates || undefined,
  });
  if (result?.error) {
    const code = result.error.code || 'ORDER_REJECTED';
    const message = result.error.message || '下单被拒绝';
    store.saveDebounced();
    sendError(res, 400, code, message);
    return;
  }
  // Order state (cash/position/order/trade) must survive a hard kill: persist now.
  store.save();
  sendJson(res, 201, { order: result.order, fill: result.fill || null });
});

route('GET', /^\/api\/accounts\/([^/]+)$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const account = getAccountOr404(id);
  const symbols = accountSymbols(account);
  let quotesBySymbol = {};
  let fxRates = { CNY: 1, USD: 7, HKD: 0.9, USDT: 7 };
  if (symbols.length) {
    const [quoteResult, rates] = await Promise.all([
      marketdata.getQuotes(symbols).catch(() => ({ quotes: [] })),
      marketdata.getFxRates().catch(() => fxRates),
    ]);
    quotesBySymbol = Object.fromEntries((quoteResult.quotes || []).map((q) => [q.symbol, q]));
    if (rates && typeof rates === 'object') fxRates = rates;
  }
  const now = nowIso();
  const cfg = effectiveCfg(account);
  engine.rollDay(account, now);
  if (typeof engine.accrueInterest === 'function') engine.accrueInterest(account, now);
  const view = engine.portfolioView(account, quotesBySymbol, fxRates, now, cfg);
  sendJson(res, 200, {
    account: {
      id: account.id,
      name: account.name,
      baseCurrency: account.baseCurrency,
      initialCapital: account.initialCapital,
      createdAt: account.createdAt,
      marginMode: account.marginMode || 'isolated',
      settings: account.settings,
    },
    ...view,
    liquidations: view.liquidations || account.liquidations || [],
    totalInterest: view.totalInterest ?? account.totalInterest ?? 0,
    buyingPower: computeBuyingPower(view, fxRates, account.baseCurrency),
    autoConvert: cfg.autoConvert !== false,
    fxConvertSpread: Number(cfg.fxConvertSpread) || 0,
    settings: account.settings,
    effective: {
      leverage: cfg.leverage,
      fees: cfg.fees,
      slippageBps: cfg.slippageBps,
      margin: cfg.margin,
      autoConvert: cfg.autoConvert !== false,
      fxConvertSpread: Number(cfg.fxConvertSpread) || 0,
    },
    settingsLocked: settingsLocked(account),
    fxRates,
  });
});

route('GET', /^\/api\/alerts$/, async (_req, res) => {
  sendJson(res, 200, { alerts: store.listAlerts() });
});

route('POST', /^\/api\/alerts$/, async (req, res) => {
  const body = await readJsonBody(req);
  const symbol = canonSymbol(body.symbol);
  if (!symbol) throw httpError(400, 'SYMBOL_INVALID', `无法识别的代码：${body.symbol}`);
  const direction = String(body.direction || 'above');
  if (direction !== 'above' && direction !== 'below') {
    throw httpError(400, 'DIRECTION_INVALID', 'direction 只能是 above 或 below');
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw httpError(400, 'PRICE_INVALID', '价格必须大于 0');
  const alert = {
    id: store.nextId('alert'),
    symbol,
    direction,
    price,
    createdAt: nowIso(),
    triggeredAt: null,
  };
  store.addAlert(alert);
  store.saveDebounced();
  sendJson(res, 201, { alert });
});

route('DELETE', /^\/api\/alerts\/([^/]+)$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[3]);
  const removed = store.removeAlert(id);
  if (!removed) throw httpError(404, 'ALERT_NOT_FOUND', '提醒不存在');
  store.saveDebounced();
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/dev\/tick$/, async (_req, res) => {
  await runTick('manual');
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- static files

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw httpError(400, 'BAD_PATH', '非法的路径');
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!target.startsWith(PUBLIC_DIR)) throw httpError(403, 'FORBIDDEN', '禁止访问');
  const ext = path.extname(target).toLowerCase();
  if (!MIME[ext]) throw httpError(404, 'NOT_FOUND', '文件不存在');
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=5',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, 'NOT_FOUND', '文件不存在');
    throw err;
  }
}

// ---------------------------------------------------------------- dispatch

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    sendError(res, 400, 'BAD_URL', '非法请求');
    return;
  }
  try {
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        if (!r.pattern.test(url.pathname)) continue;
        await r.handler(req, res, url);
        return;
      }
      sendError(res, 404, 'NOT_FOUND', `接口不存在：${req.method} ${url.pathname}`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '不支持该请求方法');
      return;
    }
    await serveStatic(req, res, url);
  } catch (err) {
    fail(res, err);
  } finally {
    if (process.env.CHIMATRADER_ACCESS_LOG === '1' || process.env.PAPERTRADER_ACCESS_LOG === '1') {
      console.log(`[http] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 已被占用，请修改 config.json 的 server.port 或用 PORT 环境变量指定。`);
    process.exitCode = 1;
  } else {
    console.error('[server] HTTP 服务错误：', err);
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[server] 千亦所 ChimaTrader 已启动： http://${HOST}:${PORT}`);
  console.log(`[server] 数据目录： ${DATA_DIR}`);
  lastSnapshotAt = 0;
  tickTimer = setInterval(() => {
    runTick('interval').catch((err) => console.warn('[tick]', err?.message || err));
  }, CONFIG.refresh?.tickMs || 2000);
  tickTimer.unref?.();
  runTick('startup').catch(() => {});
});

function shutdown(signal) {
  console.log(`[server] 收到 ${signal}，正在保存并退出…`);
  if (tickTimer) clearInterval(tickTimer);
  stopStreamLoop();
  for (const client of streamClients) {
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
  }
  streamClients.clear();
  try {
    store.save();
  } catch (err) {
    console.error('[server] 保存失败：', err?.message || err);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, runTick };
