// lib/sources/binance.mjs — Binance spot adapter (quotes, klines, symbol filters).
//
// Binance is only reachable through the local proxy configured in config.json;
// lib/net.mjs handles that transparently.

import { getJson } from '../net.mjs';
import { toShanghaiIso, cryptoDisplayName } from '../symbols.mjs';

const BASE = 'https://api.binance.com/api/v3';

const INTERVAL_MAP = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '60m': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
});

/** Filters cache (full exchangeInfo is ~2 MB, refreshed hourly in the background). */
const filtersState = {
  at: 0,
  bySymbol: new Map(),
  usdtSymbols: [],
  pending: null,
};

const FILTERS_TTL_MS = 60 * 60 * 1000;

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 8) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildQuote(symbol, ticker) {
  const price = num(ticker.lastPrice);
  const prevClose = num(ticker.prevClosePrice) ?? (num(ticker.openPrice) ?? null);
  const change = price !== null && prevClose !== null ? round(price - prevClose) : num(ticker.priceChange);
  const changePct = prevClose ? round(((price - prevClose) / prevClose) * 100, 4) : num(ticker.priceChangePercent);
  const filters = filtersState.bySymbol.get(symbol) || null;
  const ts = ticker.closeTime ? toShanghaiIso(Number(ticker.closeTime)) : null;
  const quote = {
    symbol: `crypto:${symbol}`,
    market: 'crypto',
    code: symbol,
    name: cryptoDisplayName(symbol),
    currency: 'USDT',
    price,
    prevClose,
    open: num(ticker.openPrice),
    high: num(ticker.highPrice),
    low: num(ticker.lowPrice),
    change,
    changePct,
    volume: num(ticker.volume),
    amount: num(ticker.quoteVolume),
    bid: [],
    ask: [],
    ts,
    stale: false,
    source: 'binance',
    extra: {
      limitUp: null,
      limitDown: null,
      lotSize: filters?.stepSize ?? 0.0001,
      stepSize: filters?.stepSize ?? null,
      tickSize: filters?.tickSize ?? null,
      turnoverRate: null,
      pe: null,
      pb: null,
      marketCap: null,
    },
  };
  const bidPrice = num(ticker.bidPrice);
  const bidQty = num(ticker.bidQty);
  if (bidPrice && bidQty) quote.bid.push({ price: bidPrice, size: bidQty });
  const askPrice = num(ticker.askPrice);
  const askQty = num(ticker.askQty);
  if (askPrice && askQty) quote.ask.push({ price: askPrice, size: askQty });
  return quote;
}

/**
 * Batch 24h ticker quotes. Returns Map<canonicalSymbol, Quote>.
 * Throws when the endpoint is unreachable.
 */
export async function getQuotes(parsedList) {
  const list = parsedList.filter((parsed) => parsed.market === 'crypto');
  if (list.length === 0) return new Map();
  const symbols = [...new Set(list.map((parsed) => parsed.binanceSymbol))];
  const url = `${BASE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
  const body = await getJson(url, { ttlMs: 0 });
  if (!Array.isArray(body)) throw new Error('Binance 行情返回格式异常');
  const bySymbol = new Map(body.map((ticker) => [ticker.symbol, ticker]));
  const quotes = new Map();
  for (const parsed of list) {
    const ticker = bySymbol.get(parsed.binanceSymbol);
    if (!ticker) continue;
    const quote = buildQuote(parsed.binanceSymbol, ticker);
    quotes.set(parsed.symbol, quote);
  }
  return quotes;
}

/** K-line bars for a crypto symbol. */
export async function getKline(parsed, interval, limit) {
  const binanceInterval = INTERVAL_MAP[interval];
  if (!binanceInterval) throw new Error(`Binance 不支持周期 ${interval}`);
  const symbol = parsed.binanceSymbol;
  const url = `${BASE}/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${Math.min(Math.max(limit, 1), 1000)}`;
  const rows = await getJson(url, { ttlMs: 0 });
  if (!Array.isArray(rows)) throw new Error('Binance K 线返回格式异常');
  return rows
    .map((row) => ({
      t: toShanghaiIso(Number(row[0])),
      o: num(row[1]),
      h: num(row[2]),
      l: num(row[3]),
      c: num(row[4]),
      v: num(row[5]) ?? 0,
    }))
    .filter((bar) => bar.o !== null && bar.h !== null && bar.l !== null && bar.c !== null);
}

/** Fetch full exchangeInfo once (background, cached an hour) and index filters. */
export function ensureFilters() {
  if (filtersState.pending) return filtersState.pending;
  if (Date.now() - filtersState.at < FILTERS_TTL_MS) return Promise.resolve(filtersState.bySymbol);
  filtersState.pending = (async () => {
    try {
      const info = await getJson(`${BASE}/exchangeInfo`, { ttlMs: 0, timeoutMs: 8000 });
      const bySymbol = new Map();
      const usdtSymbols = [];
      for (const item of info?.symbols || []) {
        if (item.status !== 'TRADING') continue;
        const lotSize = (item.filters || []).find((f) => f.filterType === 'LOT_SIZE');
        const priceFilter = (item.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
        bySymbol.set(item.symbol, {
          stepSize: lotSize ? num(lotSize.stepSize) : null,
          tickSize: priceFilter ? num(priceFilter.tickSize) : null,
          baseAsset: item.baseAsset,
          quoteAsset: item.quoteAsset,
        });
        if (item.quoteAsset === 'USDT') usdtSymbols.push(item.symbol);
      }
      filtersState.bySymbol = bySymbol;
      filtersState.usdtSymbols = usdtSymbols;
      filtersState.at = Date.now();
      return bySymbol;
    } catch {
      // keep any previous cache; quotes must not fail because of filters
      return filtersState.bySymbol;
    } finally {
      filtersState.pending = null;
    }
  })();
  return filtersState.pending;
}

/** All TRADING USDT symbols from the last exchangeInfo refresh (may be empty). */
export function listUsdtSymbols() {
  return [...filtersState.usdtSymbols];
}

/** Sync filter lookup (stepSize/tickSize); null until the background refresh finishes. */
export function getFilter(symbol) {
  return filtersState.bySymbol.get(symbol) || null;
}

/** Probe used by health(): ping + server time. */
export async function probe() {
  const started = Date.now();
  await getJson(`${BASE}/ping`, { ttlMs: 0, timeoutMs: 5000 });
  return Date.now() - started;
}
