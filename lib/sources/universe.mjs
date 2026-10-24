// lib/sources/universe.mjs — full market "universe" list adapters + fallback policy.
//
// Sources (verified 2026-10):
//   cn      Sina Market_Center.getHQNodeData?node=hs_a       (domestic, GBK JSON, paged)
//   hk      Sina Market_Center.getHKStockData?node=qbgg_hk   (domestic, GBK JSON, 60/page)
//   us      Nasdaq screener (download=true gives volume)     (proxy) -> Yahoo predefined screener
//   fx      12 pairs + XAU/XAG via batch quotes              (Tencent)
//   crypto  Binance /api/v3/ticker/24hr (all USDT pairs)     (proxy) -> CoinGecko popular list
//
// Any source failure degrades to a curated built-in list priced through the quote
// layer, then to the last successful snapshot; it never throws to the HTTP layer.
// getUniverseItems() is fed by marketdata.getUniverse() together with a quoteBatch
// callback so this module has no dependency cycle with lib/marketdata.mjs.

import { getGbkText, getJson } from '../net.mjs';
import {
  parseSymbol,
  CRYPTO_POPULAR,
  FX_PAIRS,
  FX_METALS,
  cryptoDisplayName,
} from '../symbols.mjs';
import { CN_FALLBACK_CODES, HK_FALLBACK_CODES, US_FALLBACK_CODES } from './fallback-universe.mjs';

const SINA_CN_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const SINA_HK_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHKStockData';
const NASDAQ_URL = 'https://api.nasdaq.com/api/screener/stocks';
const YAHOO_SCREENER_URL =
  'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved';
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';

const SINA_HEADERS = Object.freeze({
  Referer: 'https://finance.sina.com.cn/',
  Accept: '*/*',
});
const NASDAQ_HEADERS = Object.freeze({
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
});

const RAW_TTL_MS = 60 * 1000;
const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const US_NAME_CACHE_TTL_MS = 10 * 60 * 1000;
const US_NAME_MAX_LENGTH = 40;
const US_NAME_LOCALIZE_LIMIT = 80;

/** Stablecoin bases that should not appear in the crypto symbol picker. */
export const CRYPTO_STABLECOIN_BASES = Object.freeze(
  new Set([
    'USDC', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'PYUSD', 'USDD', 'USDE', 'USTC', 'FRAX', 'LUSD', 'GUSD',
  ]),
);

/**
 * Script-like Nasdaq rows (warrants / units / rights / preferred / depositary
 * shares) are noise in a symbol picker. Word boundaries keep names such as
 * "UnitedHealth" untouched.
 */
const US_NOISE_NAME_PATTERN = /\b(warrants?|units?|rights?|preferred|depositary shares?)\b/i;

/** symbol -> { name: string, at: number }; empty name means "Chinese name unavailable". */
const usNameCache = new Map();

/** @type {Map<string, { at: number, source: string, items: object[], note?: string, live: boolean }>} */
const rawCache = new Map();
/** @type {Map<string, { at: number, source: string, items: object[] }>} */
const lastGood = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,%\s]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPct(value) {
  return value === null ? null : Math.round(value * 1e4) / 1e4;
}

/** Yahoo/Nasdaq use `BRK-B`; Tencent uses `BRK.B` for class shares. */
function normalizeUsSymbol(raw) {
  return String(raw || '').trim().replace(/-([A-Z])$/, '.$1');
}

/**
 * Normalise one row into the public universe item shape.
 * Returns null for rows we cannot represent (bad symbol, non-positive price).
 */
function buildItem(market, symbolPart, name, price, changePct, amount) {
  if (symbolPart === null || symbolPart === undefined || symbolPart === '') return null;
  let parsed;
  try {
    parsed = parseSymbol(`${market}:${symbolPart}`);
  } catch {
    return null;
  }
  const numericPrice = toNumber(price);
  if (numericPrice === null || numericPrice <= 0) return null;
  const numericChange = toNumber(changePct);
  const numericAmount = toNumber(amount);
  return {
    symbol: parsed.symbol,
    code: parsed.displayCode,
    name: String(name ?? '').trim() || parsed.displayCode,
    currency: parsed.currency,
    price: numericPrice,
    changePct: roundPct(numericChange),
    amount: numericAmount !== null && numericAmount > 0 ? Math.round(numericAmount) : 0,
  };
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    out.push(item);
  }
  return out;
}

function sortUniverseItems(items, sort) {
  const field = sort === 'change' ? 'changePct' : 'amount';
  return [...items].sort((first, second) => {
    const a = Number.isFinite(first[field]) ? first[field] : -Infinity;
    const b = Number.isFinite(second[field]) ? second[field] : -Infinity;
    return b - a;
  });
}

function fallbackSource(quotes) {
  const sources = new Set((quotes || []).map((quote) => quote.source).filter(Boolean));
  if (sources.size === 0) return 'tencent';
  if (sources.size === 1) return [...sources][0];
  return 'mixed';
}

function formatClock(epochMs) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(epochMs));
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function fxUniverseCodes() {
  return [
    ...Object.keys(FX_PAIRS).map((pair) => `fx:${pair}`),
    ...Object.keys(FX_METALS).map((pair) => `fx:${pair}`),
  ];
}

function cryptoFallbackCodes() {
  return CRYPTO_POPULAR.map((symbol) => `crypto:${symbol}`);
}

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function truncateUsName(name) {
  const text = String(name || '');
  return text.length > US_NAME_MAX_LENGTH ? text.slice(0, US_NAME_MAX_LENGTH) : text;
}

/**
 * Override the top US names with Tencent's Chinese names (苹果 / 英伟达 …) using a
 * single batch quote; symbols without a Chinese name keep the (truncated) English
 * name. Results are cached 10 min so repeated sort/limit combinations stay cheap.
 */
async function localizeUsNames(items, quoteBatch) {
  if (!items || items.length === 0) return items;
  const now = Date.now();
  const lookupCount = Math.min(US_NAME_LOCALIZE_LIMIT, items.length);
  const missing = [];
  for (let index = 0; index < lookupCount; index += 1) {
    const item = items[index];
    const cached = usNameCache.get(item.symbol);
    if (cached && now - cached.at <= US_NAME_CACHE_TTL_MS) continue;
    if (hasCjk(item.name)) {
      usNameCache.set(item.symbol, { name: item.name, at: now });
      continue;
    }
    missing.push(item.symbol);
  }
  if (missing.length > 0 && typeof quoteBatch === 'function') {
    try {
      const result = await quoteBatch(missing);
      for (const quote of result?.quotes || []) {
        usNameCache.set(quote.symbol, {
          name: hasCjk(quote.name) ? String(quote.name).trim() : '',
          at: Date.now(),
        });
      }
    } catch {
      // Chinese names are a nice-to-have; keep the English ones on failure.
    }
    for (const symbol of missing) {
      if (!usNameCache.has(symbol)) usNameCache.set(symbol, { name: '', at: Date.now() });
    }
    if (usNameCache.size > 500) {
      const cutoff = Date.now() - US_NAME_CACHE_TTL_MS;
      for (const [symbol, entry] of usNameCache) {
        if (entry.at < cutoff) usNameCache.delete(symbol);
      }
    }
  }
  for (let index = 0; index < lookupCount; index += 1) {
    const item = items[index];
    const cached = usNameCache.get(item.symbol);
    if (cached?.name) item.name = cached.name;
  }
  for (const item of items) {
    if (!hasCjk(item.name)) item.name = truncateUsName(item.name);
  }
  return items;
}

// ---------------------------------------------------------------------------
// cn / hk — Sina market centre
// ---------------------------------------------------------------------------

async function fetchSinaUniverse(market, sort, needed) {
  const isCn = market === 'cn';
  const pageSize = isCn ? 100 : 60;
  const maxPages = isCn ? 3 : 5;
  const sortParam = sort === 'change' ? 'changepercent' : 'amount';
  const node = isCn ? 'hs_a' : 'qbgg_hk';
  const baseUrl = isCn ? SINA_CN_URL : SINA_HK_URL;
  const label = isCn ? '新浪 A股列表' : '新浪港股列表';
  const pages = Math.min(maxPages, Math.max(1, Math.ceil(needed / pageSize)));
  // Fetch the pages concurrently (HK needs up to 5 pages at limit=300); the
  // pre-sorted page order is preserved when merging.
  const urls = [];
  for (let page = 1; page <= pages; page += 1) {
    urls.push(`${baseUrl}?page=${page}&num=${pageSize}&sort=${sortParam}&asc=0&node=${node}`);
  }
  const pageResults = await Promise.allSettled(
    urls.map((url) => getGbkText(url, { ttlMs: 0, timeoutMs: 8000, headers: SINA_HEADERS })),
  );
  const rows = [];
  for (const pageResult of pageResults) {
    if (pageResult.status !== 'fulfilled') continue;
    let data;
    try {
      data = JSON.parse(pageResult.value);
    } catch {
      continue;
    }
    if (Array.isArray(data)) rows.push(...data);
  }
  if (rows.length === 0) throw new Error(`${label}为空`);
  const items = [];
  for (const row of rows) {
    let item = null;
    if (isCn) {
      item = buildItem('cn', row.symbol, row.name, row.trade, row.changepercent, row.amount);
    } else {
      const last = toNumber(row.lasttrade);
      const previous = toNumber(row.prevclose);
      let change = toNumber(row.changepercent);
      if (change === null && last !== null && previous !== null && previous > 0) {
        change = (last / previous - 1) * 100;
      }
      item = buildItem('hk', row.symbol, row.name, last, change, row.amount);
    }
    if (item) items.push(item);
  }
  const unique = dedupeItems(items);
  if (unique.length === 0) throw new Error(`${label}没有有效数据`);
  return { source: 'sina', items: unique, live: true };
}

// ---------------------------------------------------------------------------
// us — Nasdaq screener, Yahoo predefined screener, curated list
// ---------------------------------------------------------------------------

async function fetchNasdaqUniverse(needed, sort) {
  // download=true switches the payload to the full table (incl. numeric volume),
  // which is what lets us rank by dollar volume locally.
  const url = `${NASDAQ_URL}?tableonly=true&limit=300&offset=0&download=true`;
  const body = await getJson(url, { ttlMs: 0, timeoutMs: 15000, headers: NASDAQ_HEADERS });
  const rows = body?.data?.rows || body?.data?.table?.rows || [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Nasdaq 全市场列表为空');
  const items = [];
  for (const row of rows) {
    // Drop warrants / units / rights / preferred / depositary shares (script codes).
    if (US_NOISE_NAME_PATTERN.test(String(row.name || ''))) continue;
    const price = toNumber(row.lastsale);
    const volume = toNumber(row.volume);
    const amount = price !== null && volume !== null ? price * volume : 0;
    const item = buildItem(
      'us',
      normalizeUsSymbol(row.symbol),
      row.name,
      price,
      row.pctchange,
      amount,
    );
    if (item) items.push(item);
  }
  let unique = dedupeItems(items);
  if (unique.length === 0) throw new Error('Nasdaq 列表没有有效数据');
  // Fill up from Yahoo when aggressive filtering left fewer rows than requested.
  if (unique.length < needed) {
    try {
      const filler = await fetchYahooUniverse(sort);
      unique = dedupeItems([...unique, ...filler.items]);
    } catch {
      // Yahoo filler is best-effort only.
    }
  }
  return { source: 'nasdaq', items: unique, live: true };
}

async function fetchYahooUniverse(sort) {
  const scrId = sort === 'change' ? 'day_gainers' : 'most_actives';
  const url = `${YAHOO_SCREENER_URL}?scrIds=${scrId}&count=250`;
  const body = await getJson(url, { ttlMs: 0, timeoutMs: 10000 });
  const quotes = body?.finance?.result?.[0]?.quotes || [];
  if (!Array.isArray(quotes) || quotes.length === 0) throw new Error('Yahoo 活跃股列表为空');
  const items = [];
  for (const quote of quotes) {
    const name = quote.shortName || quote.longName;
    if (US_NOISE_NAME_PATTERN.test(String(name || ''))) continue;
    const price = toNumber(quote.regularMarketPrice);
    const volume = toNumber(quote.regularMarketVolume);
    const amount = price !== null && volume !== null ? price * volume : 0;
    const item = buildItem(
      'us',
      normalizeUsSymbol(quote.symbol),
      name,
      price,
      quote.regularMarketChangePercent,
      amount,
    );
    if (item) items.push(item);
  }
  const unique = dedupeItems(items);
  if (unique.length === 0) throw new Error('Yahoo 活跃股列表没有有效数据');
  return { source: 'yahoo', items: unique, live: true };
}

// ---------------------------------------------------------------------------
// crypto — Binance full ticker list
// ---------------------------------------------------------------------------

async function fetchBinanceUniverse() {
  const body = await getJson(BINANCE_TICKER_URL, { ttlMs: 0, timeoutMs: 10000 });
  if (!Array.isArray(body)) throw new Error('Binance 全量行情格式异常');
  const items = [];
  for (const row of body) {
    const symbol = String(row.symbol || '');
    if (!symbol.endsWith('USDT')) continue;
    if (CRYPTO_STABLECOIN_BASES.has(symbol.slice(0, -4))) continue;
    const price = toNumber(row.lastPrice);
    const amount = toNumber(row.quoteVolume);
    if (price === null || price <= 0 || amount === null || amount <= 0) continue;
    const item = buildItem(
      'crypto',
      symbol,
      cryptoDisplayName(symbol),
      price,
      row.priceChangePercent,
      amount,
    );
    if (item) items.push(item);
  }
  const unique = dedupeItems(items);
  if (unique.length === 0) throw new Error('Binance 全量列表没有有效数据');
  return { source: 'binance', items: unique, live: true };
}

// ---------------------------------------------------------------------------
// Batch-quote based lists (fx, built-in curated lists, crypto fallback)
// ---------------------------------------------------------------------------

async function fetchQuoteUniverse(codes, quoteBatch, { market, amountZero = false } = {}) {
  if (typeof quoteBatch !== 'function') throw new Error('批量报价接口不可用');
  const result = await quoteBatch(codes);
  const quotes = result?.quotes || [];
  if (quotes.length === 0) {
    const reason = result?.errors?.[0]?.message || '批量报价没有返回数据';
    throw new Error(reason);
  }
  const items = [];
  for (const quote of quotes) {
    const price = toNumber(quote.price);
    if (price === null || price <= 0) continue;
    let parsed;
    try {
      parsed = parseSymbol(quote.symbol);
    } catch {
      continue;
    }
    items.push({
      symbol: parsed.symbol,
      code: parsed.displayCode,
      name: String(quote.name || '').trim() || parsed.displayCode,
      currency: parsed.currency,
      price,
      changePct: roundPct(toNumber(quote.changePct)),
      amount: amountZero ? 0 : Math.max(0, Math.round(toNumber(quote.amount) ?? 0)),
    });
  }
  const unique = dedupeItems(items);
  if (unique.length === 0) throw new Error('批量报价没有有效数据');
  const staleCount = quotes.filter((quote) => quote.stale).length;
  const live = staleCount < quotes.length;
  return {
    source: fallbackSource(quotes),
    items: unique,
    live,
    note: live ? undefined : '实时报价不可用，展示最近缓存报价',
  };
}

// ---------------------------------------------------------------------------
// Fallback policy
// ---------------------------------------------------------------------------

function liveSources(market, sort, needed, quoteBatch) {
  switch (market) {
    case 'cn':
      return [{ label: '新浪 A股列表', fn: () => fetchSinaUniverse('cn', sort, needed) }];
    case 'hk':
      return [{ label: '新浪港股列表', fn: () => fetchSinaUniverse('hk', sort, needed) }];
    case 'us':
      return [
        { label: 'Nasdaq 全市场列表', fn: () => fetchNasdaqUniverse(needed, sort) },
        { label: `Yahoo ${sort === 'change' ? '涨幅榜' : '活跃股'}`, fn: () => fetchYahooUniverse(sort) },
      ];
    case 'fx':
      return [
        {
          label: '腾讯外汇报价',
          fn: () => fetchQuoteUniverse(fxUniverseCodes(), quoteBatch, { market: 'fx', amountZero: true }),
        },
      ];
    case 'crypto':
      return [
        { label: 'Binance 全量', fn: () => fetchBinanceUniverse() },
        {
          label: 'CoinGecko 热门币',
          fn: () => fetchQuoteUniverse(cryptoFallbackCodes(), quoteBatch, { market: 'crypto' }),
        },
      ];
    default:
      return [];
  }
}

function builtinSources(market, quoteBatch) {
  switch (market) {
    case 'cn':
      return [
        {
          label: '内置精选 A股列表',
          fn: () => fetchQuoteUniverse(CN_FALLBACK_CODES, quoteBatch, { market: 'cn' }),
        },
      ];
    case 'hk':
      return [
        {
          label: '内置精选港股列表',
          fn: () => fetchQuoteUniverse(HK_FALLBACK_CODES, quoteBatch, { market: 'hk' }),
        },
      ];
    case 'us':
      return [
        {
          label: '内置精选美股列表',
          fn: () => fetchQuoteUniverse(US_FALLBACK_CODES, quoteBatch, { market: 'us' }),
        },
      ];
    case 'crypto':
      return [
        {
          label: '内置热门币列表',
          fn: () => fetchQuoteUniverse(cryptoFallbackCodes(), quoteBatch, { market: 'crypto' }),
        },
      ];
    default:
      return [];
  }
}

async function fetchWithFallback(market, sort, needed, quoteBatch) {
  let lastError = null;
  for (const source of liveSources(market, sort, needed, quoteBatch)) {
    try {
      const result = await source.fn();
      if (result.items.length > 0) return { at: Date.now(), ...result };
      lastError = new Error(`${source.label}返回空列表`);
    } catch (err) {
      lastError = err;
    }
  }

  const builtin = builtinSources(market, quoteBatch);
  for (const source of builtin) {
    try {
      const result = await source.fn();
      if (result.items.length > 0) {
        return {
          at: Date.now(),
          source: result.source,
          items: result.items,
          live: false,
          note: `实时行情源不可用（${lastError?.message || '未知原因'}），已回退到${source.label}`,
        };
      }
      lastError = new Error(`${source.label}返回空列表`);
    } catch (err) {
      lastError = err;
    }
  }

  const cached = lastGood.get(market);
  if (cached && Date.now() - cached.at <= LAST_GOOD_MAX_AGE_MS) {
    return {
      at: cached.at,
      source: cached.source,
      items: cached.items,
      live: false,
      note: `实时行情源暂不可用（${lastError?.message || '未知原因'}），展示最近缓存（${formatClock(cached.at)}）`,
    };
  }

  return {
    at: Date.now(),
    source: 'unavailable',
    items: [],
    live: false,
    note: `行情源不可用：${lastError?.message || '未知原因'}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full universe list for one market, already sorted by `sort` and truncated to
 * `needed`. Never throws for source failures: returns curated/last-good items with
 * a Chinese `note` instead.
 *
 * @returns {Promise<{ items: object[], source: string, updatedAt: string, note?: string }>}
 */
export async function getUniverseItems(market, { needed = 100, sort = 'amount', quoteBatch } = {}) {
  const safeNeeded = Math.min(Math.max(needed, 1), 300);
  // cn/hk fetch pages pre-sorted by the requested sort, so the raw list differs
  // per sort; us/crypto/fx fetch everything and sort locally, so one cache is enough.
  const key = market === 'cn' || market === 'hk' ? `${market}|${sort}` : market;
  const cached = rawCache.get(key);
  const fresh = cached && Date.now() - cached.at <= RAW_TTL_MS;
  const covers = cached && (cached.full === true || (cached.needed || 0) >= safeNeeded);
  if (fresh && covers) {
    return finalizeUniverse(serveUniverse(cached, sort, safeNeeded), market, quoteBatch);
  }
  const pending = inflight.get(key);
  if (pending) {
    const raw = await pending;
    if (raw.full === true || (raw.needed || 0) >= safeNeeded) {
      return finalizeUniverse(serveUniverse(raw, sort, safeNeeded), market, quoteBatch);
    }
  }

  const task = (async () => {
    const raw = await fetchWithFallback(market, sort, safeNeeded, quoteBatch);
    raw.needed = safeNeeded;
    // us / crypto / fx always fetch the whole market, so any limit can be served.
    raw.full = market !== 'cn' && market !== 'hk';
    rawCache.set(key, raw);
    if (raw.live) {
      lastGood.set(market, { at: raw.at, source: raw.source, items: raw.items });
    }
    return raw;
  })();
  inflight.set(key, task);
  try {
    return finalizeUniverse(serveUniverse(await task, sort, safeNeeded), market, quoteBatch);
  } finally {
    inflight.delete(key);
  }
}

function serveUniverse(raw, sort, needed) {
  return {
    items: sortUniverseItems(raw.items, sort).slice(0, needed),
    source: raw.source,
    updatedAt: new Date(raw.at).toISOString(),
    note: raw.note,
  };
}

/** Post-processing shared by cache hits and fresh fetches (Chinese US names). */
async function finalizeUniverse(result, market, quoteBatch) {
  if (market === 'us') await localizeUsNames(result.items, quoteBatch);
  return result;
}

/** Clear caches (tests only). */
export function _resetCacheForTest() {
  rawCache.clear();
  lastGood.clear();
  inflight.clear();
  usNameCache.clear();
}
