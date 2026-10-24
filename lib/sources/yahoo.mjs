// lib/sources/yahoo.mjs — Yahoo Finance chart fallback.
//
// Used for:
//   * all US K-lines (Tencent's US daily/weekly/monthly history is broken)
//   * US / FX minute K-lines (Tencent has no minute data for them)
//   * metals fallback when Sina is unreachable
// Only reachable through the local proxy; failures are reported, never thrown at
// the HTTP layer (marketdata catches them and degrades).

import { getJson } from '../net.mjs';
import { toYahooSymbol, toShanghaiIso, dateInZone, dateToBarIso } from '../symbols.mjs';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** interval -> { yahoo interval, yahoo range, daily-ish } */
const INTERVAL_MAP = Object.freeze({
  '1m': { interval: '1m', range: '5d', intraday: true },
  '5m': { interval: '5m', range: '5d', intraday: true },
  '15m': { interval: '15m', range: '1mo', intraday: true },
  '30m': { interval: '30m', range: '1mo', intraday: true },
  '60m': { interval: '60m', range: '3mo', intraday: true },
  '1h': { interval: '60m', range: '3mo', intraday: true },
  '1d': { interval: '1d', range: '2y', intraday: false },
  '1w': { interval: '1wk', range: '5y', intraday: false },
  '1M': { interval: '1mo', range: '10y', intraday: false },
});

const DEFAULT_ZONE = Object.freeze({
  us: 'America/New_York',
  hk: 'Asia/Hong_Kong',
  cn: 'Asia/Shanghai',
  fx: 'UTC',
});

const availability = { checkedAt: 0, ok: false, message: '尚未检测' };
const AVAILABILITY_TTL_MS = 60 * 1000;

function num(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Yahoo returns float noise (e.g. 347.7300109863281); keep prices readable. */
function roundPrice(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  const abs = Math.abs(parsed);
  if (abs >= 100) return Math.round(parsed * 100) / 100;
  if (abs >= 1) return Math.round(parsed * 1e6) / 1e6;
  return Math.round(parsed * 1e8) / 1e8;
}

/** True when the requested interval can be served for the market. */
export function supportsInterval(market, interval) {
  const mapping = INTERVAL_MAP[interval];
  if (!mapping) return false;
  if (!mapping.intraday) return true;
  return market === 'us' || market === 'fx';
}

async function fetchChart(parsed, interval) {
  const mapping = INTERVAL_MAP[interval];
  if (!mapping) throw new Error(`Yahoo 不支持周期 ${interval}`);
  const symbol = toYahooSymbol(parsed);
  if (!symbol) throw new Error(`Yahoo 无该标的映射（${parsed.symbol}）`);
  const url =
    `${BASE}/${encodeURIComponent(symbol)}?range=${mapping.range}` +
    `&interval=${mapping.interval}&includePrePost=false`;
  const json = await getJson(url, { ttlMs: 0, timeoutMs: 6000 });
  const chart = json?.chart;
  if (chart?.error) {
    throw new Error(`Yahoo 返回错误：${chart.error.description || chart.error.code || '未知'}`);
  }
  const result = chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error('Yahoo 未返回该标的的行情数据');
  return { result, mapping };
}

/** K-line bars from Yahoo. Throws when unavailable. */
export async function getKline(parsed, interval, limit) {
  const { result, mapping } = await fetchChart(parsed, interval);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const zone = result.meta?.exchangeTimezoneName || DEFAULT_ZONE[parsed.market] || 'UTC';
  const bars = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = num(quote.close?.[i]);
    const open = num(quote.open?.[i]);
    const high = num(quote.high?.[i]);
    const low = num(quote.low?.[i]);
    if (close === null || open === null || high === null || low === null) continue;
    const epochMs = Number(timestamps[i]) * 1000;
    bars.push({
      t: mapping.intraday ? toShanghaiIso(epochMs) : dateToBarIso(dateInZone(epochMs, zone)),
      o: roundPrice(open),
      h: roundPrice(high),
      l: roundPrice(low),
      c: roundPrice(close),
      v: num(quote.volume?.[i]) ?? 0,
    });
  }
  if (bars.length === 0) throw new Error('Yahoo 返回的 K 线为空');
  return bars.slice(-limit);
}

/**
 * Availability probe (cached 60s). Never throws.
 * @returns {Promise<{ ok: boolean, latencyMs: number|null, message: string }>}
 */
export async function probe() {
  const started = Date.now();
  try {
    const url = `${BASE}/${encodeURIComponent('EURUSD=X')}?range=1d&interval=1h`;
    const json = await getJson(url, { ttlMs: 0, timeoutMs: 5000 });
    const ok = Boolean(json?.chart?.result?.[0]?.timestamp?.length);
    availability.checkedAt = Date.now();
    availability.ok = ok;
    availability.message = ok ? '正常' : '返回数据为空';
    return { ok, latencyMs: Date.now() - started, message: availability.message };
  } catch (err) {
    availability.checkedAt = Date.now();
    availability.ok = false;
    availability.message = err.message;
    return { ok: false, latencyMs: null, message: err.message };
  }
}

/** Cached availability verdict; performs a probe when stale. Never throws. */
export async function isAvailable() {
  if (Date.now() - availability.checkedAt > AVAILABILITY_TTL_MS) {
    return probe();
  }
  return { ok: availability.ok, latencyMs: null, message: availability.message };
}

/** Sync view of the last probe result (used by getMarketMeta). */
export function lastKnownAvailability() {
  return { ...availability };
}

/**
 * Mark Yahoo as unavailable without a network round trip (e.g. when the local proxy
 * is known to be down). Keeps getMarkets/getMarketMeta coherent with health().
 */
export function markUnavailable(message) {
  availability.checkedAt = Date.now();
  availability.ok = false;
  availability.message = message || 'Yahoo 行情源不可用';
}
