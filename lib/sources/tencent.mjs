// lib/sources/tencent.mjs — Tencent (qt.gtimg.cn) quote / K-line / minute / search adapter.
//
// Verified field layouts (2026-10, cross-checked against K-line closes):
//   A-share : 1 name, 2 code, 3 price, 4 prevClose, 5 open, 6 volume(手),
//             9..18 bid1..5 (price,size), 19..28 ask1..5, 30 yyyyMMddHHmmss,
//             31 change, 32 changePct, 33 high, 34 low, 35 price/volume/amount,
//             36 volume(手), 37 amount(万元), 38 turnoverRate, 39 pe,
//             43 amplitude, 44 float cap, 45 total cap(亿), 46 pb, 47 limitUp, 48 limitDown
//   HK      : same 3/4/5/6 and 9..28 book, 30 yyyy/MM/dd HH:mm:ss, 37 amount(HKD),
//             39 pe, 43 amplitude, 45 market cap(亿), 60 board lot, 75 currency
//   US      : same 3/4/5/6, book has only level 1 at 9/10 (bid) and 19/20 (ask),
//             30 yyyy-MM-dd HH:mm:ss (America/New_York), 35 currency, 37 amount(USD),
//             39 pe, 45 market cap(亿)
//   FX wh*  : 3 price, 5 yyyyMMddHHmmss, 6 prevClose, 7 open, 8 high, 9 low,
//             12 change, 13 changePct (note: field 6 is 昨收 and 7 is 今开)
//   Metals  : comma separated — price,pct,?,?,high,low,HH:mm:ss,open,prevClose,...,date,name
//
// The K-line endpoints are domestic and do not need the proxy.

import { getGbkText, getJson } from '../net.mjs';
import { dateToBarIso, wallTimeToShanghaiIso, getHkLotSize, parseSymbol, FX_PAIRS } from '../symbols.mjs';

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const FQKLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const MKLINE_URL = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline';
const MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const SEARCH_URL = 'https://smartbox.gtimg.cn/s3/';

const DAILY_INTERVALS = Object.freeze({ '1d': 'day', '1w': 'week', '1M': 'month' });
const MINUTE_INTERVALS = Object.freeze({ '1m': 'm1', '5m': 'm5', '15m': 'm15', '30m': 'm30', '60m': 'm60' });

/** Age (ms) after which an FX/metal quote is considered "stopped updating". */
const FX_STALE_MS = 96 * 60 * 60 * 1000;

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Tencent timestamp strings (CN/FX `yyyyMMddHHmmss`, HK `yyyy/MM/dd HH:mm:ss`, US `yyyy-MM-dd HH:mm:ss`). */
function tencentTimeToIso(value, market) {
  const text = String(value || '').trim();
  if (!text) return null;
  let match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    return wallTimeToShanghaiIso(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
      },
      'Asia/Shanghai',
    );
  }
  match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (match) {
    const zone = market === 'hk' ? 'Asia/Hong_Kong' : market === 'us' ? 'America/New_York' : 'Asia/Shanghai';
    return wallTimeToShanghaiIso(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6] || 0),
      },
      zone,
    );
  }
  return null;
}

function isStaleTimestamp(iso, maxAgeMs = FX_STALE_MS) {
  if (!iso) return true;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > maxAgeMs;
}

function baseQuote(parsed) {
  return {
    symbol: parsed.symbol,
    market: parsed.market,
    code: parsed.displayCode,
    name: null,
    currency: parsed.currency,
    price: null,
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
    ts: null,
    stale: false,
    source: 'tencent',
    extra: {
      limitUp: null,
      limitDown: null,
      lotSize: null,
      turnoverRate: null,
      pe: null,
      pb: null,
      marketCap: null,
    },
  };
}

function addBookLevels(quote, fields, levels = 5) {
  for (let i = 0; i < levels; i += 1) {
    const bidPrice = num(fields[9 + i * 2]);
    const bidSize = num(fields[10 + i * 2]);
    if (bidPrice && bidPrice > 0 && bidSize && bidSize > 0) {
      quote.bid.push({ price: bidPrice, size: bidSize });
    }
    const askPrice = num(fields[19 + i * 2]);
    const askSize = num(fields[20 + i * 2]);
    if (askPrice && askPrice > 0 && askSize && askSize > 0) {
      quote.ask.push({ price: askPrice, size: askSize });
    }
  }
}

function finishChange(quote) {
  if (quote.change === null && quote.price !== null && quote.prevClose !== null && quote.prevClose > 0) {
    quote.change = round(quote.price - quote.prevClose);
  }
  if (quote.changePct === null && quote.change !== null && quote.prevClose) {
    quote.changePct = round((quote.change / quote.prevClose) * 100, 4);
  }
}

function parseCnQuote(parsed, fields) {
  const quote = baseQuote(parsed);
  quote.name = fields[1] || null;
  quote.price = num(fields[3]);
  quote.prevClose = num(fields[4]);
  quote.open = num(fields[5]);
  quote.volume = num(fields[6]);
  addBookLevels(quote, fields);
  quote.ts = tencentTimeToIso(fields[30], 'cn');
  quote.change = num(fields[31]);
  quote.changePct = num(fields[32]);
  quote.high = num(fields[33]);
  quote.low = num(fields[34]);
  const parts = String(fields[35] || '').split('/');
  quote.amount = parts.length >= 3 ? num(parts[2]) : num(fields[37]) !== null ? num(fields[37]) * 10000 : null;
  quote.extra.turnoverRate = num(fields[38]);
  quote.extra.pe = num(fields[39]);
  quote.extra.marketCap = num(fields[45]);
  const pb = num(fields[46]);
  quote.extra.pb = pb !== null && pb > 0 ? pb : null;
  const limitUp = num(fields[47]);
  const limitDown = num(fields[48]);
  quote.extra.limitUp = limitUp !== null && limitUp > 0 ? limitUp : null;
  quote.extra.limitDown = limitDown !== null && limitDown > 0 ? limitDown : null;
  quote.extra.lotSize = parsed.isIndex ? null : 100;
  if (parsed.isIndex) quote.extra.index = true;
  finishChange(quote);
  return quote;
}

function parseHkQuote(parsed, fields) {
  const quote = baseQuote(parsed);
  quote.name = fields[1] || null;
  quote.price = num(fields[3]);
  quote.prevClose = num(fields[4]);
  quote.open = num(fields[5]);
  quote.volume = num(fields[6]);
  addBookLevels(quote, fields);
  quote.ts = tencentTimeToIso(fields[30], 'hk');
  quote.change = num(fields[31]);
  quote.changePct = num(fields[32]);
  quote.high = num(fields[33]);
  quote.low = num(fields[34]);
  quote.amount = num(fields[37]);
  quote.extra.pe = num(fields[39]);
  quote.extra.turnoverRate = num(fields[38]);
  quote.extra.marketCap = num(fields[45]);
  quote.extra.lotSize = num(fields[60]) && num(fields[60]) > 0 ? num(fields[60]) : getHkLotSize(parsed.displayCode);
  finishChange(quote);
  return quote;
}

function parseUsQuote(parsed, fields) {
  const quote = baseQuote(parsed);
  quote.name = fields[1] || null;
  quote.price = num(fields[3]);
  quote.prevClose = num(fields[4]);
  quote.open = num(fields[5]);
  quote.volume = num(fields[6]);
  addBookLevels(quote, fields, 1);
  quote.ts = tencentTimeToIso(fields[30], 'us');
  quote.change = num(fields[31]);
  quote.changePct = num(fields[32]);
  quote.high = num(fields[33]);
  quote.low = num(fields[34]);
  quote.currency = fields[35] || 'USD';
  quote.amount = num(fields[37]);
  quote.extra.turnoverRate = num(fields[38]);
  quote.extra.pe = num(fields[39]);
  quote.extra.marketCap = num(fields[45]);
  quote.extra.lotSize = 1;
  finishChange(quote);
  return quote;
}

function parseFxQuote(parsed, fields) {
  const quote = baseQuote(parsed);
  quote.name = FX_PAIRS[parsed.displayCode]?.name || fields[1] || null;
  quote.price = num(fields[3]);
  // Verified: field 6 is prevClose, field 7 is open (change == price - field 6).
  quote.prevClose = num(fields[6]);
  quote.open = num(fields[7]);
  quote.high = num(fields[8]);
  quote.low = num(fields[9]);
  quote.change = num(fields[12]);
  quote.changePct = num(fields[13]);
  quote.volume = 0;
  quote.amount = 0;
  quote.ts = tencentTimeToIso(fields[5], 'fx');
  quote.currency = 'USD';
  quote.extra.lotSize = 0.01;
  quote.extra.quoteStale = isStaleTimestamp(quote.ts);
  finishChange(quote);
  return quote;
}

function parseMetalQuote(parsed, payload) {
  const fields = String(payload || '').split(',');
  const quote = baseQuote(parsed);
  quote.price = num(fields[0]);
  quote.high = num(fields[4]);
  quote.low = num(fields[5]);
  quote.open = num(fields[7]);
  quote.prevClose = num(fields[8]);
  quote.name = fields[13] || null;
  quote.volume = 0;
  quote.amount = 0;
  quote.currency = 'USD';
  quote.extra.lotSize = 0.01;
  const date = String(fields[12] || '').trim();
  const time = String(fields[6] || '').trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (dateMatch && timeMatch) {
    quote.ts = wallTimeToShanghaiIso(
      {
        year: Number(dateMatch[1]),
        month: Number(dateMatch[2]),
        day: Number(dateMatch[3]),
        hour: Number(timeMatch[1]),
        minute: Number(timeMatch[2]),
        second: Number(timeMatch[3] || 0),
      },
      'Asia/Shanghai',
    );
  }
  quote.extra.quoteStale = isStaleTimestamp(quote.ts);
  finishChange(quote);
  return quote;
}

/**
 * Batch quote fetch. Returns Map<canonicalSymbol, Quote>.
 * Throws when the Tencent endpoint itself is unreachable.
 */
export async function getQuotes(parsedList) {
  const list = parsedList.filter((parsed) => parsed.market !== 'crypto');
  if (list.length === 0) return new Map();
  const codes = [...new Set(list.map((parsed) => parsed.tencentCode).filter(Boolean))];
  if (codes.length === 0) return new Map();
  const text = await getGbkText(`${QUOTE_URL}${codes.join(',')}`, { ttlMs: 0 });
  const payloadByCode = new Map();
  const pattern = /v_([A-Za-z0-9_.]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    payloadByCode.set(match[1], match[2]);
  }
  const quotes = new Map();
  for (const parsed of list) {
    const payload = payloadByCode.get(parsed.tencentCode);
    if (!payload) continue;
    let quote;
    if (parsed.market === 'fx') {
      quote = parsed.tencentCode.startsWith('hf_')
        ? parseMetalQuote(parsed, payload)
        : parseFxQuote(parsed, payload.split('~'));
    } else if (parsed.market === 'hk') {
      quote = parseHkQuote(parsed, payload.split('~'));
    } else if (parsed.market === 'us') {
      quote = parseUsQuote(parsed, payload.split('~'));
    } else {
      quote = parseCnQuote(parsed, payload.split('~'));
    }
    if (quote && quote.price !== null) quotes.set(parsed.symbol, quote);
  }
  return quotes;
}

/** Daily / weekly / monthly K-line (cn, hk, fx-pairs). */
export async function getDailyKline(parsed, interval, limit) {
  const period = DAILY_INTERVALS[interval];
  if (!period) throw new Error(`腾讯源不支持周期 ${interval}`);
  const code = parsed.tencentCode;
  const url = `${FQKLINE_URL}?param=${code},${period},,,${Math.min(Math.max(limit, 1), 1000)},qfq`;
  const json = await getJson(url, { ttlMs: 0 });
  const node = json?.data?.[code];
  if (!node) return [];
  let rows = null;
  for (const key of [`qfq${period}`, period]) {
    if (Array.isArray(node[key]) && node[key].length > 0) {
      rows = node[key];
      break;
    }
  }
  if (!rows) return [];
  return rows
    .map((row) => ({
      t: dateToBarIso(row[0]),
      o: num(row[1]),
      h: num(row[3]),
      l: num(row[4]),
      c: num(row[2]),
      v: num(row[5]) ?? 0,
    }))
    .filter((bar) => bar.o !== null && bar.h !== null && bar.l !== null && bar.c !== null)
    .slice(-limit);
}

/** A-share minute K-line via mkline (true OHLC). */
export async function getMinuteKline(parsed, interval, limit) {
  const code = parsed.tencentCode;
  const iv = MINUTE_INTERVALS[interval];
  if (!iv) throw new Error(`腾讯源不支持周期 ${interval}`);
  const url = `${MKLINE_URL}?param=${code},${iv},,${Math.min(Math.max(limit, 1), 1000)}`;
  const json = await getJson(url, { ttlMs: 0 });
  const node = json?.data?.[code];
  const rows = node?.[iv];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(row[0]));
      if (!match) return null;
      return {
        t: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`,
        o: num(row[1]),
        c: num(row[2]),
        h: num(row[3]),
        l: num(row[4]),
        v: num(row[5]) ?? 0,
      };
    })
    .filter(Boolean);
}

/**
 * Intraday 1-minute price series from the minute/query endpoint
 * (currently the only source of HK minute data; also works for A-shares).
 */
export async function getIntradayBars(parsed) {
  const code = parsed.tencentCode;
  const json = await getJson(`${MINUTE_URL}?code=${code}`, { ttlMs: 5000 });
  const node = json?.data?.[code];
  const date = String(node?.data?.date || '');
  const points = node?.data?.data;
  if (!/^\d{8}$/.test(date) || !Array.isArray(points) || points.length === 0) return [];
  const bars = [];
  let previousCumulative = 0;
  for (const point of points) {
    const parts = String(point || '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    const hhmm = parts[0];
    if (!/^\d{4}$/.test(hhmm)) continue;
    const price = num(parts[1]);
    if (price === null) continue;
    const cumulative = num(parts[2]) ?? previousCumulative;
    const volume = Math.max(0, cumulative - previousCumulative);
    previousCumulative = cumulative;
    bars.push({
      t: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00+08:00`,
      o: price,
      h: price,
      l: price,
      c: price,
      v: volume,
    });
  }
  return bars;
}

/**
 * Tencent smartbox search (cn/hk/us). Returns entries in
 * `{ symbol, code, name, market, currency }` shape (already normalised).
 */
export async function search(query, limit = 20) {
  const url = `${SEARCH_URL}?v=2&q=${encodeURIComponent(query)}&t=all`;
  const text = await getGbkText(url, { ttlMs: 60000 });
  const match = /v_hint="([^"]*)"/.exec(text);
  if (!match) return [];
  let payload = match[1];
  try {
    payload = JSON.parse(`"${payload}"`);
  } catch {
    // keep raw payload when it is not a JSON string literal
  }
  const results = [];
  const seen = new Set();
  for (const record of payload.split('^')) {
    if (!record) continue;
    const parts = record.split('~');
    if (parts.length < 4) continue;
    const [prefix, rawCode, name, , type = ''] = parts;
    if (!prefix || !rawCode) continue;
    if (/^QZ/i.test(String(type))) continue; // skip warrants
    let market;
    let symbolInput;
    if (prefix === 'sh' || prefix === 'sz' || prefix === 'bj') {
      market = 'cn';
      symbolInput = `cn:${prefix}${rawCode}`;
    } else if (prefix === 'hk') {
      market = 'hk';
      symbolInput = `hk:${rawCode}`;
    } else if (prefix === 'us') {
      market = 'us';
      symbolInput = `us:${rawCode}`;
    } else {
      continue;
    }
    try {
      const parsed = parseSymbol(symbolInput);
      if (seen.has(parsed.symbol)) continue;
      seen.add(parsed.symbol);
      results.push({
        symbol: parsed.symbol,
        code: parsed.displayCode,
        name: name || parsed.displayCode,
        market,
        currency: parsed.currency,
      });
    } catch {
      // ignore entries we cannot normalise
    }
    if (results.length >= limit) break;
  }
  return results;
}
