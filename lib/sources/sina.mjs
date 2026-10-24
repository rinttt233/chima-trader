// lib/sources/sina.mjs — Sina daily K-lines (domestic, direct).
//
// Tencent exposes gold/silver spot quotes (hf_XAU / hf_XAG) but no K-line at all,
// so daily history comes from Sina's public futures endpoint and the weekly /
// monthly bars are aggregated locally by marketdata.
//
// Sina's US stock daily endpoint is also the direct fallback for US daily/weekly/
// monthly K-lines when Yahoo (proxy) is unavailable.
//
// Both responses are GBK encoded and need a Referer header.

import { getGbkText } from '../net.mjs';
import { FX_METALS, dateToBarIso } from '../symbols.mjs';

const BASE = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php';
const US_DAILY_URL = 'https://stock.finance.sina.com.cn/usstock/api/json_v2.php/US_MinKService.getDailyK';
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_SYMBOL = 'NVDA';

const HEADERS = Object.freeze({
  Referer: 'https://finance.sina.com.cn',
  Accept: '*/*',
});

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Extract the JSON array from the JSONP body. */
function parseJsonp(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('新浪行情返回格式异常');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('新浪行情解析失败');
  }
}

/**
 * Full daily history for a metals symbol (fx:XAUUSD / fx:XAGUSD).
 * Returns [] for non-metal symbols. Throws when Sina is unreachable.
 */
export async function getDailyKline(parsed) {
  const metal = FX_METALS[parsed.displayCode];
  if (!metal) return [];
  const url =
    `${BASE}/var%20_${metal.sinaSymbol}/` +
    `GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${metal.sinaSymbol}`;
  const text = await getGbkText(url, { ttlMs: CACHE_TTL_MS, headers: HEADERS });
  const rows = parseJsonp(text);
  if (!Array.isArray(rows)) throw new Error('新浪行情返回格式异常');
  const bars = [];
  for (const row of rows) {
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    const date = String(row.date || '').slice(0, 10);
    if (open === null || high === null || low === null || close === null || !date) continue;
    bars.push({ t: dateToBarIso(date), o: open, h: high, l: low, c: close, v: num(row.volume) ?? 0 });
  }
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return bars;
}

/**
 * Full daily history for a US stock/ETF (us:AAPL, us:BRK.B …).
 * Rows are `{ d, o, h, l, c, v }` strings, ascending; the last row is the latest
 * trading day. Used as the direct fallback when Yahoo is unavailable.
 */
export async function getUsDailyKline(parsed) {
  const symbol = String(parsed?.displayCode || '').trim();
  if (!symbol) return [];
  const url = `${US_DAILY_URL}?symbol=${encodeURIComponent(symbol)}`;
  const text = await getGbkText(url, { ttlMs: CACHE_TTL_MS, timeoutMs: 10000, headers: HEADERS });
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    rows = parseJsonp(text);
  }
  if (!Array.isArray(rows)) throw new Error('新浪美股日线返回格式异常');
  const bars = [];
  for (const row of rows) {
    const date = String(row?.d || '').slice(0, 10);
    const open = num(row?.o);
    const high = num(row?.h);
    const low = num(row?.l);
    const close = num(row?.c);
    if (!date || open === null || high === null || low === null || close === null) continue;
    bars.push({ t: dateToBarIso(date), o: open, h: high, l: low, c: close, v: num(row?.v) ?? 0 });
  }
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return bars;
}

/** Probe used by health(). */
export async function probe() {
  const started = Date.now();
  const url =
    `${BASE}/var%20_XAU/` + 'GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU';
  const text = await getGbkText(url, { ttlMs: CACHE_TTL_MS, timeoutMs: 6000, headers: HEADERS });
  const rows = parseJsonp(text);
  const ok = Array.isArray(rows) && rows.length > 0;
  return { ok, latencyMs: Date.now() - started, message: ok ? '正常（伦敦金/银日线）' : '返回数据为空' };
}

/** Probe the US daily direct fallback (cached 5 minutes to keep health cheap). */
export async function probeUsDaily() {
  const started = Date.now();
  try {
    const url = `${US_DAILY_URL}?symbol=${PROBE_SYMBOL}`;
    const text = await getGbkText(url, { ttlMs: CACHE_TTL_MS, timeoutMs: 6000, headers: HEADERS });
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      rows = parseJsonp(text);
    }
    const ok = Array.isArray(rows) && rows.length > 0;
    return {
      ok,
      latencyMs: Date.now() - started,
      message: ok ? '美股日线直连正常' : '美股日线直连返回数据为空',
    };
  } catch (err) {
    return { ok: false, latencyMs: null, message: `美股日线直连异常：${err.message}` };
  }
}
