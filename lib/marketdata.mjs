// lib/marketdata.mjs — unified market data facade for the paper trading platform.
//
// Public API (CONTRACTS.md §4):
//   getQuotes(symbols)        -> { quotes: Quote[], errors: [{ symbol, message }] }
//   getKline(symbol, interval, limit = 300) -> { symbol, interval, bars: Bar[] }
//   search(query, limit = 20) -> [{ symbol, code, name, market, currency }]
//   getFxRates()              -> { CNY: 1, USD, HKD, USDT }
//   getMarkets()              -> market metadata[]
//   getMarketMeta(market)     -> single market metadata
//   health()                  -> [{ source, ok, latencyMs, message, critical?, markets?, hint? }]
//
// Source routing:
//   cn / hk / us / fx quotes   -> Tencent (direct)
//   us K-line                  -> Yahoo (Tencent's US K-line history is broken)
//   fx pair K-line             -> Tencent (daily/weekly/monthly), Yahoo for minutes
//   fx metals K-line           -> Sina spot daily (direct) + local weekly/monthly rollup
//   crypto                     -> Binance (proxy), CoinGecko fallback
//
// All errors degrade: quotes fall back to the last good cache with stale:true, K-lines
// fall back to cache, and every failure carries a Chinese-readable message.

import * as tencent from './sources/tencent.mjs';
import * as binance from './sources/binance.mjs';
import * as coingecko from './sources/coingecko.mjs';
import * as yahoo from './sources/yahoo.mjs';
import * as sina from './sources/sina.mjs';
import * as universe from './sources/universe.mjs';
import { getGbkText, probeProxy, proxyFailureActive, markProxyUnreachable, resetProxyBreaker } from './net.mjs';
import {
  MARKET_IDS,
  MARKET_BASE_META,
  OPTIONAL_MINUTE_INTERVALS,
  FX_METALS,
  FX_PAIRS,
  CRYPTO_POPULAR,
  CRYPTO_NAMES,
  cryptoDisplayName,
  getMarketMetaBase,
  isoWeekKey,
  parseSymbol,
  toShanghaiIso,
} from './symbols.mjs';

/** Error with a machine readable code; server maps code/status to its HTTP error body. */
export class MarketDataError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    this.status = status;
    // server.mjs uses `err.expose` as the client facing Chinese message.
    this.expose = message;
  }
}

const QUOTE_CACHE_TTL_MS = 800;
const QUOTE_STALE_MAX_AGE_MS = 60 * 60 * 1000;
const KLINE_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FX_RATES_TTL_MS = 30 * 1000;
const FX_RATES_STALE_MAX_AGE_MS = 60 * 60 * 1000;
const HEALTH_TTL_MS = 20 * 1000;
const SEARCH_TTL_MS = 60 * 1000;
const UNIVERSE_TTL_MS = 60 * 1000;
const MINUTE_INTERVAL_MS = Object.freeze({ '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 });
const MINUTE_INTERVALS = Object.freeze(['1m', '5m', '15m', '30m', '60m']);
const KLINE_TTL_MS = Object.freeze({
  '1m': 5 * 1000,
  '5m': 10 * 1000,
  '15m': 20 * 1000,
  '30m': 30 * 1000,
  '60m': 60 * 1000,
  '1h': 60 * 1000,
  '4h': 120 * 1000,
  '1d': 120 * 1000,
  '1w': 300 * 1000,
  '1M': 300 * 1000,
});

/** Last good quotes per canonical symbol. */
const quoteCache = new Map();
/** Last good K-line per symbol+interval+limit. */
const klineCache = new Map();
/** Search results per query. */
const searchCache = new Map();
/** Full market universe responses per (market|limit|sort). */
const universeCache = new Map();
const fxRateCache = { rates: null, at: 0 };
let healthCache = { entries: null, at: 0 };
let fxRateStatus = { ok: false, message: '尚未获取汇率' };
let yahooMinutesAvailable = true; // optimistic until the first probe says otherwise
let yahooStatus = { ok: true, message: '尚未检测' };
/** Last US daily K-line fallback attempt: { ok: boolean|null, at: number, message: string }. */
let usDailyFallbackStatus = { ok: null, at: 0, message: '尚未使用' };
/** Last Sina US daily probe performed by health(): { ok: boolean|null, at: number, message: string }. */
let sinaUsStatus = { ok: null, at: 0, message: '尚未检测' };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function pruneMap(map, maxEntries = 400) {
  if (map.size <= maxEntries) return;
  const overflow = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function supportedIntervals(market) {
  const base = MARKET_BASE_META[market] ? [...MARKET_BASE_META[market].intervals] : [];
  if ((market === 'us' || market === 'fx') && yahooMinutesAvailable) {
    return [...OPTIONAL_MINUTE_INTERVALS, ...base];
  }
  return base;
}

function isMinuteInterval(interval) {
  return MINUTE_INTERVALS.includes(interval);
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

async function fetchTencentQuotes(list, fetched, sourceErrors) {
  try {
    const quotes = await tencent.getQuotes(list);
    for (const parsed of list) {
      const quote = quotes.get(parsed.symbol);
      if (quote) fetched.set(parsed.symbol, quote);
      else sourceErrors.set(parsed.symbol, '腾讯行情未返回该代码的数据');
    }
  } catch (err) {
    for (const parsed of list) {
      sourceErrors.set(parsed.symbol, `腾讯行情源不可用：${err.message}`);
    }
  }
}

function enrichCryptoFilterExtras() {
  for (const entry of quoteCache.values()) {
    const quote = entry.quote;
    if (!quote || quote.market !== 'crypto') continue;
    const filter = binance.getFilter(quote.code);
    if (!filter) continue;
    if (filter.stepSize) {
      quote.extra.stepSize = filter.stepSize;
      quote.extra.lotSize = filter.stepSize;
    }
    if (filter.tickSize) quote.extra.tickSize = filter.tickSize;
  }
}

async function fetchCryptoQuotes(list, fetched, sourceErrors) {
  let binanceError = null;
  try {
    const quotes = await binance.getQuotes(list);
    for (const parsed of list) {
      const quote = quotes.get(parsed.symbol);
      if (quote) fetched.set(parsed.symbol, quote);
      else sourceErrors.set(parsed.symbol, 'Binance 未返回该交易对');
    }
  } catch (err) {
    binanceError = err;
  }

  const missing = list.filter((parsed) => !fetched.has(parsed.symbol));
  if (missing.length === 0) return;
  try {
    const fallback = await coingecko.getQuotes(missing);
    for (const parsed of missing) {
      const quote = fallback.get(parsed.symbol);
      if (quote) {
        fetched.set(parsed.symbol, quote);
        continue;
      }
      sourceErrors.set(
        parsed.symbol,
        binanceError
          ? `Binance 不可用（${binanceError.message}），CoinGecko 也没有该币种报价`
          : '暂无该交易对的加密行情',
      );
    }
  } catch (fallbackError) {
    for (const parsed of missing) {
      sourceErrors.set(
        parsed.symbol,
        `加密行情源不可用（Binance：${binanceError?.message || '未知错误'}；CoinGecko：${fallbackError.message}）`,
      );
    }
  }
}

/**
 * Batch quotes for a list of symbols.
 * Never throws: failures end up in `errors`, and previously cached quotes are
 * returned with `stale: true` instead of a fake null-priced quote.
 * `options.maxAgeMs` overrides the default 800 ms cache TTL (0 = always refetch),
 * which lets the SSE stream use a 500 ms cadence.
 */
export async function getQuotes(symbols = [], options = {}) {
  const requested = Array.isArray(symbols) ? symbols : String(symbols ?? '').split(',');
  const cleaned = [...new Set(requested.map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (cleaned.length === 0) return { quotes: [], errors: [] };
  const maxAgeMs = Number.isFinite(Number(options?.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : QUOTE_CACHE_TTL_MS;

  const parsedList = [];
  const errors = [];
  for (const raw of cleaned) {
    try {
      parsedList.push(parseSymbol(raw));
    } catch (err) {
      errors.push({ symbol: raw, message: err.message });
    }
  }
  if (parsedList.length === 0) return { quotes: [], errors };

  // Serve from cache when every symbol was fetched very recently.
  const now = Date.now();
  const fullyCached = parsedList.every((parsed) => {
    const entry = quoteCache.get(parsed.symbol);
    return entry && now - entry.at <= maxAgeMs;
  });
  if (fullyCached) {
    const quotes = parsedList.map((parsed) => ({
      ...quoteCache.get(parsed.symbol).quote,
      symbol: parsed.symbol,
      stale: false,
    }));
    return { quotes, errors };
  }

  const tencentList = parsedList.filter((parsed) => parsed.market !== 'crypto');
  const cryptoList = parsedList.filter((parsed) => parsed.market === 'crypto');
  const fetched = new Map();
  const sourceErrors = new Map();
  const tasks = [];
  if (tencentList.length > 0) tasks.push(fetchTencentQuotes(tencentList, fetched, sourceErrors));
  if (cryptoList.length > 0) tasks.push(fetchCryptoQuotes(cryptoList, fetched, sourceErrors));
  await Promise.all(tasks);

  const quotes = [];
  const seen = new Set();
  for (const parsed of parsedList) {
    if (seen.has(parsed.symbol)) continue;
    seen.add(parsed.symbol);
    const fresh = fetched.get(parsed.symbol);
    if (fresh) {
      quoteCache.set(parsed.symbol, { quote: fresh, at: Date.now() });
      quotes.push({ ...fresh, symbol: parsed.symbol, stale: false });
      continue;
    }
    const cached = quoteCache.get(parsed.symbol);
    if (cached && Date.now() - cached.at <= QUOTE_STALE_MAX_AGE_MS) {
      quotes.push({ ...cached.quote, symbol: parsed.symbol, stale: true });
      continue;
    }
    errors.push({
      symbol: parsed.input,
      message: sourceErrors.get(parsed.symbol) || '该标的暂无行情数据',
    });
  }
  pruneMap(quoteCache);
  return { quotes, errors };
}

// ---------------------------------------------------------------------------
// K-lines
// ---------------------------------------------------------------------------

function aggregateMinuteBars(bars, interval, limit) {
  const minutes = MINUTE_INTERVAL_MS[interval];
  if (!minutes) throw new Error(`不支持的分钟周期 ${interval}`);
  if (minutes === 1) return bars.slice(-limit);
  const bucketMs = minutes * 60 * 1000;
  const groups = new Map();
  for (const bar of bars) {
    const epoch = Date.parse(bar.t);
    if (!Number.isFinite(epoch)) continue;
    const bucket = Math.floor(epoch / bucketMs) * bucketMs;
    const group = groups.get(bucket);
    if (!group) {
      groups.set(bucket, { t: toShanghaiIso(bucket), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    } else {
      group.h = Math.max(group.h, bar.h);
      group.l = Math.min(group.l, bar.l);
      group.c = bar.c;
      group.v += bar.v;
    }
  }
  return [...groups.values()].slice(-limit);
}

function aggregateDailyBars(bars, interval, limit) {
  const groups = new Map();
  for (const bar of bars) {
    const date = bar.t.slice(0, 10);
    const key = interval === '1w' ? isoWeekKey(date) : date.slice(0, 7);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { ...bar });
    } else {
      group.h = Math.max(group.h, bar.h);
      group.l = Math.min(group.l, bar.l);
      group.c = bar.c;
      group.v += bar.v;
      group.t = bar.t;
    }
  }
  return [...groups.values()].slice(-limit);
}

async function getMetalDailyKline(parsed, interval, limit) {
  let daily = [];
  try {
    daily = await sina.getDailyKline(parsed);
  } catch {
    daily = [];
  }
  if (daily.length === 0) return yahoo.getKline(parsed, interval, limit);
  if (interval === '1d') return daily.slice(-limit);
  return aggregateDailyBars(daily, interval, limit);
}

async function fetchKline(parsed, interval, limit) {
  switch (parsed.market) {
    case 'cn':
      return isMinuteInterval(interval)
        ? tencent.getMinuteKline(parsed, interval, limit)
        : tencent.getDailyKline(parsed, interval, limit);
    case 'hk':
      if (isMinuteInterval(interval)) {
        const minuteBars = await tencent.getIntradayBars(parsed);
        return aggregateMinuteBars(minuteBars, interval, limit);
      }
      return tencent.getDailyKline(parsed, interval, limit);
    case 'us': {
      if (isMinuteInterval(interval)) return yahoo.getKline(parsed, interval, limit);
      try {
        return await yahoo.getKline(parsed, interval, limit);
      } catch (err) {
        // Yahoo (needs proxy) failed: fall back to Sina's direct US daily history,
        // rolling weekly/monthly bars up locally.
        try {
          const daily = await sina.getUsDailyKline(parsed);
          if (!Array.isArray(daily) || daily.length === 0) throw new Error('新浪美股日线返回空数据');
          usDailyFallbackStatus = { ok: true, at: Date.now(), message: '已使用新浪美股日线直连' };
          if (interval === '1d') return daily.slice(-limit);
          return aggregateDailyBars(daily, interval, limit);
        } catch (fallbackError) {
          usDailyFallbackStatus = {
            ok: false,
            at: Date.now(),
            message: `新浪美股日线兜底失败：${fallbackError.message}`,
          };
          throw new Error(
            `Yahoo 不可用（${err.message}），新浪美股日线兜底也失败（${fallbackError.message}）`,
          );
        }
      }
    }
    case 'fx': {
      const metal = Boolean(FX_METALS[parsed.displayCode]);
      if (isMinuteInterval(interval)) return yahoo.getKline(parsed, interval, limit);
      if (metal) return getMetalDailyKline(parsed, interval, limit);
      try {
        return await tencent.getDailyKline(parsed, interval, limit);
      } catch (err) {
        return yahoo.getKline(parsed, interval, limit);
      }
    }
    case 'crypto':
      return binance.getKline(parsed, interval, limit);
    default:
      throw new Error(`未知市场：${parsed.market}`);
  }
}

/**
 * Bars for one symbol/interval. Throws MarketDataError (code/status) on failure so
 * the server can answer 400/503 with a Chinese message.
 */
export async function getKline(symbolInput, interval, limit = 300) {
  let parsed;
  try {
    parsed = parseSymbol(symbolInput);
  } catch (err) {
    throw new MarketDataError('SYMBOL_INVALID', err.message, 400);
  }
  const intervalKey = String(interval ?? '').trim();
  const allowed = supportedIntervals(parsed.market);
  if (!intervalKey || !allowed.includes(intervalKey)) {
    const hint =
      (parsed.market === 'us' || parsed.market === 'fx') && isMinuteInterval(intervalKey) && !yahooMinutesAvailable
        ? `（分钟线依赖 Yahoo 行情源，当前不可用：${yahooStatus.message}）`
        : '';
    throw new MarketDataError(
      'KLINE_INTERVAL_UNSUPPORTED',
      `市场 ${parsed.market} 不支持周期 ${intervalKey || '(空)'}${hint}，可用周期：${allowed.join(' / ')}`,
      400,
    );
  }
  const safeLimit = clamp(limit, 1, 1000);
  const cacheKey = `${parsed.symbol}|${intervalKey}|${safeLimit}`;
  const ttl = KLINE_TTL_MS[intervalKey] ?? 30 * 1000;
  const cached = klineCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= ttl) {
    return { symbol: parsed.symbol, interval: intervalKey, bars: cached.bars };
  }
  try {
    const bars = await fetchKline(parsed, intervalKey, safeLimit);
    if (!Array.isArray(bars) || bars.length === 0) throw new Error('行情源返回空 K 线');
    const trimmed = bars.slice(-safeLimit);
    klineCache.set(cacheKey, { bars: trimmed, at: Date.now() });
    pruneMap(klineCache);
    return { symbol: parsed.symbol, interval: intervalKey, bars: trimmed };
  } catch (err) {
    if (cached && Date.now() - cached.at <= KLINE_STALE_MAX_AGE_MS) {
      return { symbol: parsed.symbol, interval: intervalKey, bars: cached.bars };
    }
    const minuteOnOptionalSource =
      (parsed.market === 'us' || parsed.market === 'fx') && isMinuteInterval(intervalKey);
    if (minuteOnOptionalSource) {
      // Minute bars for us/fx come from Yahoo only; report an unsupported interval
      // (400) so the frontend hides the button, and remember the source is down.
      yahooMinutesAvailable = false;
      yahooStatus = { ok: false, message: err.message };
      yahoo.markUnavailable(err.message);
      throw new MarketDataError(
        'KLINE_INTERVAL_UNSUPPORTED',
        `市场 ${parsed.market} 的 ${intervalKey} 分钟线依赖 Yahoo 行情源，当前不可用：${err.message}`,
        400,
      );
    }
    throw new MarketDataError(
      'KLINE_UNAVAILABLE',
      `获取 ${parsed.symbol} 的 ${intervalKey} K 线失败：${err.message}`,
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchLocal(query, limit) {
  const needle = query.trim();
  if (!needle) return [];
  const upper = needle.toUpperCase();
  const lower = needle.toLowerCase();
  const results = [];

  for (const [pair, info] of Object.entries(FX_PAIRS)) {
    const haystack = `${pair} ${info.name} ${info.tencentCode}`.toLowerCase();
    if (haystack.includes(lower)) {
      results.push({
        symbol: `fx:${pair}`,
        code: pair,
        name: info.name,
        market: 'fx',
        currency: 'USD',
      });
    }
  }
  for (const [pair, info] of Object.entries(FX_METALS)) {
    const haystack = `${pair} ${info.name} ${info.tencentCode}`.toLowerCase();
    if (haystack.includes(lower)) {
      results.push({
        symbol: `fx:${pair}`,
        code: pair,
        name: info.name,
        market: 'fx',
        currency: 'USD',
      });
    }
  }

  const dynamic = binance.listUsdtSymbols();
  const cryptoCandidates = [...new Set([...CRYPTO_POPULAR, ...dynamic])];
  let cryptoMatches = 0;
  for (const code of cryptoCandidates) {
    if (cryptoMatches >= limit) break;
    // Only strong matches: exact USDT pair (BTC -> BTCUSDT) or a Chinese name hit.
    const display = cryptoDisplayName(code);
    const base = code.replace(/USDT$/, '');
    const exactPair = code === upper || code === `${upper}USDT`;
    const nameMatch = (CRYPTO_NAMES[base] || '').includes(needle);
    if (!exactPair && !nameMatch) continue;
    results.push({
      symbol: `crypto:${code}`,
      code,
      name: display,
      market: 'crypto',
      currency: 'USDT',
    });
    cryptoMatches += 1;
  }
  return results;
}

function dedupeResults(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.symbol || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    out.push(item);
  }
  return out;
}

/** Global symbol search (cn/hk/us via Tencent smartbox + local fx/crypto tables). */
export async function search(query, limit = 20) {
  const text = String(query ?? '').trim();
  if (!text) return [];
  const max = clamp(limit, 1, 50);
  const cacheKey = `${text}|${max}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= SEARCH_TTL_MS) {
    return cached.results.map((item) => ({ ...item }));
  }
  let remote = [];
  try {
    remote = await tencent.search(text, max);
  } catch {
    remote = [];
  }
  const local = searchLocal(text, max);
  // Direct crypto/fx code matches are more relevant than e.g. a US ETF named "比特币".
  const looksLikePair = /^[A-Za-z]{2,12}$/.test(text);
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  let ordered;
  if (looksLikePair) {
    ordered = [...local, ...remote];
  } else if (hasCjk && local.length > 0) {
    // e.g. 黄金 -> fx:XAUUSD should be visible next to the gold ETFs.
    ordered = [...local, ...remote];
  } else {
    ordered = [...remote, ...local];
  }
  const merged = dedupeResults(ordered).slice(0, max);
  searchCache.set(cacheKey, { results: merged, at: Date.now() });
  pruneMap(searchCache, 200);
  return merged.map((item) => ({ ...item }));
}

// ---------------------------------------------------------------------------
// Full market universe (标的全市场列表)
// ---------------------------------------------------------------------------

function cloneUniversePayload(payload) {
  return {
    ...payload,
    items: payload.items.map((item) => ({ ...item })),
  };
}

/**
 * Full market list for the symbol picker ("标的库").
 * Cached 60 s per (market, limit, sort). Source failures degrade to a curated
 * list or the last good snapshot with a Chinese `note`; never throws an HTTP 500.
 *
 * @param {'cn'|'hk'|'us'|'fx'|'crypto'} market
 * @param {{ limit?: number, sort?: 'amount'|'change' }} [options]
 */
export async function getUniverse(marketInput, options = {}) {
  const market = String(marketInput ?? '').trim().toLowerCase();
  if (!MARKET_IDS.includes(market)) {
    throw new MarketDataError('MARKET_INVALID', 'market 只能是 cn/hk/us/fx/crypto', 400);
  }
  const limit = clamp(options?.limit ?? 100, 1, 300);
  const sort = String(options?.sort ?? 'amount').trim().toLowerCase();
  if (sort !== 'amount' && sort !== 'change') {
    throw new MarketDataError('SORT_INVALID', 'sort 只能是 amount 或 change', 400);
  }
  const cacheKey = `${market}|${limit}|${sort}`;
  const cached = universeCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= UNIVERSE_TTL_MS) {
    return cloneUniversePayload(cached.payload);
  }
  try {
    const result = await universe.getUniverseItems(market, {
      needed: limit,
      sort,
      quoteBatch: getQuotes,
    });
    const payload = {
      items: (Array.isArray(result.items) ? result.items : []).slice(0, limit),
      source: result.source || 'unknown',
      updatedAt: result.updatedAt || new Date().toISOString(),
    };
    if (result.note) payload.note = result.note;
    universeCache.set(cacheKey, { at: Date.now(), payload });
    pruneMap(universeCache, 100);
    return cloneUniversePayload(payload);
  } catch (err) {
    // Never surface a 500: report the reason in `note` with an empty list.
    return {
      items: [],
      source: 'unavailable',
      updatedAt: new Date().toISOString(),
      note: `全市场列表暂不可用：${err?.message || '未知错误'}`,
    };
  }
}

// ---------------------------------------------------------------------------
// FX rates
// ---------------------------------------------------------------------------

/**
 * FX rates against CNY: `{ CNY: 1, USD, HKD, USDT }`.
 * USD/HKD come from Tencent whUSDCNY / whHKDCNY; USDT is approximated with USD.
 * Falls back to the last good rates, then to constants, and reports the failure
 * through health().
 */
export async function getFxRates() {
  const now = Date.now();
  if (fxRateCache.rates && now - fxRateCache.at <= FX_RATES_TTL_MS) {
    return { ...fxRateCache.rates };
  }
  try {
    const usdParsed = parseSymbol('fx:USDCNY');
    const hkdParsed = parseSymbol('fx:HKDCNY');
    const quotes = await tencent.getQuotes([usdParsed, hkdParsed]);
    const usd = quotes.get(usdParsed.symbol)?.price;
    const hkd = quotes.get(hkdParsed.symbol)?.price;
    if (!(usd > 0) || !(hkd > 0)) throw new Error('未取到 USD/CNY 或 HKD/CNY 汇率');
    const rates = { CNY: 1, USD: round(usd, 4), HKD: round(hkd, 4), USDT: round(usd, 4) };
    fxRateCache.rates = rates;
    fxRateCache.at = Date.now();
    fxRateStatus = { ok: true, message: '正常' };
    return { ...rates };
  } catch (err) {
    fxRateStatus = { ok: false, message: err.message };
    if (fxRateCache.rates && Date.now() - fxRateCache.at <= FX_RATES_STALE_MAX_AGE_MS) {
      return { ...fxRateCache.rates };
    }
    // Reasonable long term fallbacks so the portfolio can still be valued.
    return { CNY: 1, USD: 7.1, HKD: 0.91, USDT: 7.1 };
  }
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/** Single market metadata (sync). Returns null for an unknown market id. */
export function getMarketMeta(market) {
  const meta = getMarketMetaBase(market);
  if (!meta) return null;
  meta.intervals = supportedIntervals(market);
  return meta;
}

/** All markets with the intervals that are currently available. */
export async function getMarkets() {
  try {
    const proxy = await probeProxy(1200).catch(() => ({ ok: false, message: '代理状态检测失败' }));
    if (!proxy.ok) {
      markProxyUnreachable();
      const message = `本地代理不可用（${proxy.message}），Yahoo 行情源不可用`;
      yahoo.markUnavailable(message);
      yahooMinutesAvailable = false;
      yahooStatus = { ok: false, message };
    } else {
      resetProxyBreaker();
      // Re-probe after a proxy restart instead of trusting the cached "down" verdict.
      const probe = yahooStatus.ok === false ? await yahoo.probe() : await yahoo.isAvailable();
      yahooStatus = { ok: probe.ok, message: probe.message };
      yahooMinutesAvailable = probe.ok;
    }
  } catch (err) {
    yahooStatus = { ok: false, message: err.message };
    yahooMinutesAvailable = false;
  }
  return MARKET_IDS.map((market) => getMarketMeta(market));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function fxTimestampAge(tsText) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(tsText || ''));
  if (!match) return null;
  const epoch = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 8, // Beijing -> UTC
    Number(match[5]),
    Number(match[6]),
  );
  return Date.now() - epoch;
}

async function probeTencentFx() {
  const text = await getGbkText('https://qt.gtimg.cn/q=whEURUSD,whUSDCNY,whEURJPY,whGBPJPY', {
    ttlMs: 10000,
    timeoutMs: 4000,
    retries: 1,
  });
  const pattern = /v_(wh[A-Z]+)="([^"]*)"/g;
  const stale = [];
  let match;
  let count = 0;
  while ((match = pattern.exec(text)) !== null) {
    count += 1;
    const fields = match[2].split('~');
    const age = fxTimestampAge(fields[5]);
    if (age !== null && age > 96 * 60 * 60 * 1000) {
      const pair = match[1].replace(/^wh/, '');
      const stamp = String(fields[5]);
      const pretty = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}`;
      stale.push(`${pair}（最新 ${pretty}）`);
    }
  }
  if (count === 0) throw new Error('腾讯外汇接口未返回数据');
  if (stale.length > 0) {
    return `外汇报价正常；以下货币对报价停更：${stale.join('、')}`;
  }
  return '正常';
}

function timedProbe(source, task) {
  const started = Date.now();
  return (async () => {
    try {
      const message = await task();
      return { source, ok: true, latencyMs: Date.now() - started, message: message || '正常' };
    } catch (err) {
      return { source, ok: false, latencyMs: null, message: err.message || '未知错误' };
    }
  })();
}

function fixedFailure(source, message) {
  return { source, ok: false, latencyMs: null, message };
}

/** Static health metadata used by the frontend (banner / status panel). */
const HEALTH_META = Object.freeze({
  tencent: { critical: true, markets: ['cn', 'hk', 'us', 'fx'] },
  'tencent-fx': { critical: true, markets: ['fx'] },
  binance: { critical: true, markets: ['crypto'] },
  coingecko: { critical: false, markets: ['crypto'] },
  yahoo: { critical: false, markets: ['us', 'fx'] },
  sina: { critical: true, markets: ['fx', 'us'] },
});
const HEALTH_SOURCES = Object.freeze(['tencent', 'tencent-fx', 'binance', 'coingecko', 'yahoo', 'sina']);

function buildHealthHint(entry, context) {
  const { sinaUsOk } = context;
  switch (entry.source) {
    case 'tencent':
      return entry.ok ? '无需处理' : '腾讯行情直连失败，请检查网络/DNS 或稍后重试';
    case 'tencent-fx':
      if (!entry.ok) return '腾讯外汇接口不可用，外汇报价与汇率可能缺失；网络恢复后自动恢复';
      if (String(entry.message).includes('停更')) return '部分货币对源站已停更，报价可能不更新；可改用其他货币对';
      return '无需处理';
    case 'binance':
      if (entry.ok && String(entry.message).includes('vision')) {
        return '主站需要本机代理；当前已用 data-api.binance.vision 直连，启动代理后会自动切回主站';
      }
      if (entry.ok) return '无需处理';
      return '加密行情不可用：启动本机代理（config.json 的 127.0.0.1:65532）或检查网络后自动恢复';
    case 'coingecko':
      return entry.ok ? '备用源正常，无需处理' : '备用源需要本机代理，仅 Binance 不可用时才会用到，可忽略';
    case 'yahoo':
      if (entry.ok) return '无需处理';
      return sinaUsOk
        ? '分钟线依赖 Yahoo（当前不可用）；日/周/月线已用新浪直连，启动本机代理后分钟线会自动恢复'
        : '启动本机代理后美股/外汇分钟线恢复；当前新浪日线兜底也不可用';
    case 'sina':
      if (entry.ok) return '无需处理';
      return '新浪直连异常：金银日线与美股日线兜底可能缺失，检查网络后重试';
    default:
      return entry.ok ? '无需处理' : '检查网络或稍后重试';
  }
}

function decorateHealth(entries, context) {
  for (const entry of entries) {
    const meta = HEALTH_META[entry.source] || { critical: false, markets: [] };
    entry.critical = meta.critical;
    entry.markets = [...meta.markets];
    entry.hint = buildHealthHint(entry, context);
  }
  return entries;
}

async function collectHealth() {
  const proxy = await probeProxy(1200).catch(() => ({ ok: false, message: '代理状态检测失败' }));
  // Update the circuit breaker before the probe tasks start (they kick off
  // immediately when created), so Binance's main station fails fast and the
  // direct mirror is tried right away instead of after a 5 s timeout.
  if (!proxy.ok) markProxyUnreachable();
  else resetProxyBreaker();
  const tasks = [
    timedProbe('tencent', async () => {
      const text = await getGbkText('https://qt.gtimg.cn/q=sh000001', {
        ttlMs: 15000,
        timeoutMs: 4000,
        retries: 1,
      });
      if (!/v_sh000001="/.test(text)) throw new Error('腾讯行情接口返回内容异常');
      return '正常';
    }),
    timedProbe('tencent-fx', probeTencentFx),
    timedProbe('binance', async () => {
      // Always probe Binance: data-api.binance.vision works over a direct connection,
      // so crypto stays available even without the local proxy.
      const result = await binance.probe();
      binance.ensureFilters().then(enrichCryptoFilterExtras, () => {});
      if (!result.ok) throw new Error(result.message);
      return result.message;
    }),
  ];
  if (proxy.ok) {
    tasks.push(
      timedProbe('coingecko', async () => {
        const result = await coingecko.probe();
        if (!result.ok) throw new Error(result.message);
        return '正常';
      }),
      timedProbe('yahoo', async () => {
        const result = await yahoo.probe();
        yahooStatus = { ok: result.ok, message: result.message };
        yahooMinutesAvailable = result.ok;
        if (!result.ok) throw new Error(result.message);
        return '正常';
      }),
    );
  } else {
    // Proxy unreachable: CoinGecko/Yahoo have no direct fallback, but keep Yahoo's
    // availability cache coherent so /api/markets drops us/fx minute intervals.
    yahoo.markUnavailable(proxy.message);
    yahooMinutesAvailable = false;
    yahooStatus = { ok: false, message: proxy.message };
    tasks.push(
      fixedFailure('coingecko', `本机代理不可用（${proxy.message}），CoinGecko 备用源不可用`),
      fixedFailure('yahoo', `本机代理不可用（${proxy.message}），Yahoo 行情源不可用`),
    );
  }
  // Sina is domestic: metals daily K-lines plus the US daily K-line direct fallback.
  tasks.push(
    timedProbe('sina', async () => {
      const [metalsResult, usResult] = await Promise.allSettled([sina.probe(), sina.probeUsDaily()]);
      const metals =
        metalsResult.status === 'fulfilled'
          ? metalsResult.value
          : { ok: false, message: metalsResult.reason?.message || '伦敦金/银日线异常' };
      const us =
        usResult.status === 'fulfilled'
          ? usResult.value
          : { ok: false, message: usResult.reason?.message || '美股日线异常' };
      sinaUsStatus = { ok: us.ok === true, at: Date.now(), message: us.message };
      if (!metals.ok) throw new Error(`${metals.message}；${us.message}`);
      return us.ok ? `${metals.message}；${us.message}` : `${metals.message}；注意：${us.message}`;
    }),
  );
  const entries = await Promise.all(tasks);
  const sinaUsOk = sinaUsStatus.ok === true;

  // Surfaces fx-rate failures through the tencent-fx entry (rates value the portfolio).
  try {
    await getFxRates();
  } catch {
    // getFxRates degrades internally; nothing to do here.
  }
  const fxRatesEntry = entries.find((entry) => entry.source === 'tencent-fx');
  if (fxRatesEntry?.ok && !fxRateStatus.ok) {
    fxRatesEntry.message = `${fxRatesEntry.message}；汇率获取异常：${fxRateStatus.message}`;
  }
  // Yahoo down: state explicitly what still works (US daily via Sina direct).
  const yahooEntry = entries.find((entry) => entry.source === 'yahoo');
  if (yahooEntry) {
    if (!yahooEntry.ok) {
      yahooEntry.message = sinaUsOk
        ? '分钟线依赖 Yahoo（当前不可用）；日/周/月线已用新浪直连'
        : '分钟线依赖 Yahoo（当前不可用）；日/周/月线的新浪直连兜底也不可用';
    } else {
      yahooEntry.message = '正常';
    }
  }
  const sinaEntry = entries.find((entry) => entry.source === 'sina');
  if (sinaEntry && !sinaEntry.ok) {
    sinaEntry.message = `新浪直连异常（${sinaEntry.message}）：金银日线与美股日线兜底可能缺失`;
  }
  return decorateHealth(entries, { proxyOk: proxy.ok, sinaUsOk });
}

/**
 * Data source health. Never throws and never returns undefined — the server
 * forwards this array to the frontend every 20 seconds.
 */
export async function health() {
  const now = Date.now();
  const cloneEntries = (entries) =>
    entries.map((entry) => ({ ...entry, markets: Array.isArray(entry.markets) ? [...entry.markets] : [] }));
  if (healthCache.entries && now - healthCache.at <= HEALTH_TTL_MS) {
    return cloneEntries(healthCache.entries);
  }
  try {
    const entries = await collectHealth();
    healthCache = { entries, at: Date.now() };
    return cloneEntries(entries);
  } catch (err) {
    const message = `健康检查异常：${err?.message || '未知错误'}`;
    return HEALTH_SOURCES.map((source) => ({
      ...fixedFailure(source, message),
      critical: HEALTH_META[source]?.critical ?? false,
      markets: [...(HEALTH_META[source]?.markets || [])],
      hint: '健康检查异常：请检查网络后重试',
    }));
  }
}

/** Clear every cache (tests only). */
export function _resetCacheForTest() {
  quoteCache.clear();
  klineCache.clear();
  searchCache.clear();
  universeCache.clear();
  universe._resetCacheForTest();
  fxRateCache.rates = null;
  fxRateCache.at = 0;
  healthCache = { entries: null, at: 0 };
  yahooMinutesAvailable = true;
  yahooStatus = { ok: true, message: '尚未检测' };
  fxRateStatus = { ok: false, message: '尚未获取汇率' };
  usDailyFallbackStatus = { ok: null, at: 0, message: '尚未使用' };
  sinaUsStatus = { ok: null, at: 0, message: '尚未检测' };
}
