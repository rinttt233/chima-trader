// lib/sources/sina.mjs — Sina spot precious metals daily K-line (domestic, direct).
//
// Tencent exposes gold/silver spot quotes (hf_XAU / hf_XAG) but no K-line at all,
// so daily history comes from Sina's public futures JSONP endpoint and the weekly /
// monthly bars are aggregated locally by marketdata.
//
// The response is GBK encoded JSONP and needs a Referer header.

import { getGbkText } from '../net.mjs';
import { FX_METALS, dateToBarIso } from '../symbols.mjs';

const BASE = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php';
const CACHE_TTL_MS = 5 * 60 * 1000;

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

/** Probe used by health(). */
export async function probe() {
  const started = Date.now();
  const url =
    `${BASE}/var%20_XAU/` + 'GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU';
  const text = await getGbkText(url, { ttlMs: 0, timeoutMs: 5000, headers: HEADERS });
  const rows = parseJsonp(text);
  const ok = Array.isArray(rows) && rows.length > 0;
  return { ok, latencyMs: Date.now() - started, message: ok ? '正常' : '返回数据为空' };
}
