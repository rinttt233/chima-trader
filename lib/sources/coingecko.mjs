// lib/sources/coingecko.mjs — CoinGecko fallback for crypto spot prices.
// Used only when Binance is unreachable; it can provide a last price but no
// order book, so most Quote fields stay null.

import { getJson } from '../net.mjs';
import { toShanghaiIso, cryptoDisplayName } from '../symbols.mjs';

const BASE = 'https://api.coingecko.com/api/v3';

/** CoinGecko's public endpoint rate-limits aggressively; probe at most once a minute. */
const PROBE_CACHE_TTL_MS = 60 * 1000;
let probeCache = { at: 0, result: null };

/** Binance USDT pair -> CoinGecko coin id (only the commonly traded ones). */
const COIN_IDS = Object.freeze({
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  BNBUSDT: 'binancecoin',
  SOLUSDT: 'solana',
  XRPUSDT: 'ripple',
  DOGEUSDT: 'dogecoin',
  ADAUSDT: 'cardano',
  TONUSDT: 'the-open-network',
  AVAXUSDT: 'avalanche-2',
  LINKUSDT: 'chainlink',
  DOTUSDT: 'polkadot',
  LTCUSDT: 'litecoin',
  BCHUSDT: 'bitcoin-cash',
  TRXUSDT: 'tron',
  SHIBUSDT: 'shiba-inu',
  SUIUSDT: 'sui',
  NEARUSDT: 'near',
  APTUSDT: 'aptos',
  ARBUSDT: 'arbitrum',
  OPUSDT: 'optimism',
  UNIUSDT: 'uniswap',
  ATOMUSDT: 'cosmos',
  FILUSDT: 'filecoin',
  ETCUSDT: 'ethereum-classic',
  XLMUSDT: 'stellar',
  ALGOUSDT: 'algorand',
  VETUSDT: 'vechain',
  ICPUSDT: 'internet-computer',
  PEPEUSDT: 'pepe',
  INJUSDT: 'injective-protocol',
  RENDERUSDT: 'render-token',
});

function num(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function supports(symbol) {
  return Boolean(COIN_IDS[symbol]);
}

/**
 * Fallback quotes (price only). Returns Map<canonicalSymbol, Quote>.
 * Unknown coins are simply omitted.
 */
export async function getQuotes(parsedList) {
  const list = parsedList.filter((parsed) => parsed.market === 'crypto' && supports(parsed.displayCode));
  if (list.length === 0) return new Map();
  const ids = [...new Set(list.map((parsed) => COIN_IDS[parsed.displayCode]))];
  const url = `${BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const body = await getJson(url, { ttlMs: 0 });
  const now = toShanghaiIso(Date.now());
  const quotes = new Map();
  for (const parsed of list) {
    const price = num(body?.[COIN_IDS[parsed.displayCode]]?.usd);
    if (price === null) continue;
    quotes.set(parsed.symbol, {
      symbol: parsed.symbol,
      market: 'crypto',
      code: parsed.displayCode,
      name: cryptoDisplayName(parsed.displayCode),
      currency: 'USDT',
      price,
      prevClose: null,
      open: null,
      high: null,
      low: null,
      change: null,
      changePct: null,
      volume: null,
      amount: null,
      bid: [],
      ask: [],
      ts: now,
      stale: false,
      source: 'coingecko',
      extra: {
        limitUp: null,
        limitDown: null,
        lotSize: 0.0001,
        stepSize: null,
        tickSize: null,
        turnoverRate: null,
        pe: null,
        pb: null,
        marketCap: null,
        fallback: true,
      },
    });
  }
  return quotes;
}

/** Probe used by health(); cached for a minute because the public API rate-limits. */
export async function probe() {
  if (probeCache.result && Date.now() - probeCache.at < PROBE_CACHE_TTL_MS) {
    return { ...probeCache.result };
  }
  const started = Date.now();
  try {
    await getJson(`${BASE}/ping`, { ttlMs: 0, timeoutMs: 5000 });
    probeCache = { at: Date.now(), result: { ok: true, latencyMs: Date.now() - started, message: '正常' } };
  } catch (err) {
    probeCache = { at: Date.now(), result: { ok: false, latencyMs: null, message: err.message } };
  }
  return { ...probeCache.result };
}
