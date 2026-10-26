// lib/symbols.mjs — symbol parsing & normalisation, market metadata, currencies,
// Hong Kong lot sizes, source-code mapping and timezone helpers.
//
// Canonical symbol format: `<market>:<code>`
//   cn      cn:sh600519 / cn:sz000001 / cn:sh000001 (index, display only)
//   hk      hk:hk00700
//   us      us:usAAPL
//   fx      fx:EURUSD / fx:XAUUSD          (source codes whEURUSD / hf_XAU)
//   crypto  crypto:BTCUSDT                 (source code BTCUSDT on Binance)
//
// parseSymbol() also accepts bare source style codes (sh600519, hk00700, usAAPL,
// whEURUSD, BTCUSDT, ...) and infers the market.

import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../config.json', import.meta.url);
let config = {};
try {
  config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
} catch {
  config = {};
}

export const MARKET_IDS = Object.freeze(['cn', 'hk', 'us', 'fx', 'crypto']);

/** Intervals that can be served per market (minutes for us/fx are added dynamically). */
export const MARKET_BASE_META = Object.freeze({
  cn: Object.freeze({
    id: 'cn',
    name: 'A股',
    currency: 'CNY',
    tradeable: true,
    timezone: 'Asia/Shanghai',
    priceLimit: true,
    intervals: Object.freeze(['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M']),
  }),
  hk: Object.freeze({
    id: 'hk',
    name: '港股',
    currency: 'HKD',
    tradeable: true,
    timezone: 'Asia/Hong_Kong',
    priceLimit: false,
    intervals: Object.freeze(['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M']),
  }),
  us: Object.freeze({
    id: 'us',
    name: '美股',
    currency: 'USD',
    tradeable: true,
    timezone: 'America/New_York',
    priceLimit: false,
    intervals: Object.freeze(['1d', '1w', '1M']),
  }),
  fx: Object.freeze({
    id: 'fx',
    name: '外汇',
    currency: 'USD',
    tradeable: true,
    timezone: 'Asia/Shanghai',
    priceLimit: false,
    intervals: Object.freeze(['1d', '1w', '1M']),
    note: '周一至周六，每日 05:00–06:00 维护',
  }),
  crypto: Object.freeze({
    id: 'crypto',
    name: '加密货币',
    currency: 'USDT',
    tradeable: true,
    timezone: 'UTC',
    priceLimit: false,
    intervals: Object.freeze(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']),
    note: '7×24',
  }),
});

/** Minute intervals that us/fx can optionally serve through Yahoo. */
export const OPTIONAL_MINUTE_INTERVALS = Object.freeze(['1m', '5m', '15m', '30m', '60m']);

/** Per-market currency. */
export const MARKET_CURRENCIES = Object.freeze({
  cn: 'CNY',
  hk: 'HKD',
  us: 'USD',
  fx: 'USD',
  crypto: 'USDT',
});

/** Trading sessions. cn/hk/us come from config.json; fx/crypto are fixed here. */
export function getSessions(market) {
  const configured = config?.sessions?.[market];
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((session) => ({
      start: session.start,
      end: session.end,
      tz: session.tz,
    }));
  }
  if (market === 'fx') {
    // Monday–Saturday; 05:00–06:00 Asia/Shanghai is daily maintenance.
    return [
      { start: '00:00', end: '05:00', tz: 'Asia/Shanghai' },
      { start: '06:00', end: '24:00', tz: 'Asia/Shanghai' },
    ];
  }
  if (market === 'crypto') {
    return [{ start: '00:00', end: '24:00', tz: 'Asia/Shanghai' }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Hong Kong board lot sizes (verified against Tencent quote field #60).
// Missing codes fall back to 100 shares (the HKEX default for many issues).
// ---------------------------------------------------------------------------

export const HK_LOT_SIZES = Object.freeze({
  '00001': 500, // 长和
  '00005': 400, // 汇丰控股
  '00016': 500, // 新鸿基地产
  '00027': 1000, // 银河娱乐
  '00066': 500, // 港铁公司
  '00175': 500, // 吉利汽车
  '00267': 1000, // 中信股份
  '00291': 1000, // 华润啤酒
  '00386': 2000, // 中国石油化工股份
  '00388': 100, // 香港交易所
  '00700': 100, // 腾讯控股
  '00728': 2000, // 中国电信
  '00762': 2000, // 中国联通
  '00857': 2000, // 中国石油股份
  '00883': 1000, // 中国海洋石油
  '00939': 1000, // 建设银行
  '00941': 500, // 中国移动
  '00981': 500, // 中芯国际
  '00992': 2000, // 联想集团
  '01024': 100, // 快手-W
  '01088': 500, // 中国神华
  '01113': 500, // 长实集团
  '01299': 200, // 友邦保险
  '01398': 1000, // 工商银行
  '01810': 200, // 小米集团-W
  '02020': 200, // 安踏体育
  '02318': 500, // 中国平安
  '02331': 500, // 李宁
  '02388': 500, // 中银香港
  '02628': 1000, // 中国人寿
  '03690': 100, // 美团-W
  '03888': 200, // 金山软件
  '03988': 1000, // 中国银行
  '06060': 100, // 众安在线
  '06618': 50, // 京东健康
  '09618': 50, // 京东集团-SW
  '09988': 100, // 阿里巴巴-W
  '09992': 200, // 泡泡玛特
  '09999': 100, // 网易
});

/** Board lot for an HK code; accepts `00700`, `hk00700` or a parsed symbol. */
export function getHkLotSize(code, fallback = 100) {
  let key = String(code ?? '');
  if (key.includes(':')) key = key.split(':').pop();
  key = key.replace(/^hk/i, '');
  if (!/^\d+$/.test(key)) return fallback;
  key = key.padStart(5, '0');
  const lot = Number(HK_LOT_SIZES[key]);
  return Number.isFinite(lot) && lot > 0 ? lot : fallback;
}

// ---------------------------------------------------------------------------
// FX / precious metals
// ---------------------------------------------------------------------------

/** Supported FX currency pool (ISO 4217) with Chinese display names. */
export const FX_CURRENCIES = Object.freeze({
  USD: '美元',
  EUR: '欧元',
  GBP: '英镑',
  JPY: '日元',
  AUD: '澳元',
  CAD: '加元',
  CHF: '瑞郎',
  NZD: '纽元',
  CNY: '人民币',
  HKD: '港币',
});

export const FX_CURRENCY_CODES = Object.freeze(Object.keys(FX_CURRENCIES));

/** Pairs covered directly by Tencent's quote feed (kept as primary source). */
export const FX_PAIRS = Object.freeze({
  EURUSD: { name: '欧元/美元', tencentCode: 'whEURUSD' },
  GBPUSD: { name: '英镑/美元', tencentCode: 'whGBPUSD' },
  USDJPY: { name: '美元/日元', tencentCode: 'whUSDJPY' },
  AUDUSD: { name: '澳元/美元', tencentCode: 'whAUDUSD' },
  USDCAD: { name: '美元/加元', tencentCode: 'whUSDCAD' },
  USDCHF: { name: '美元/瑞郎', tencentCode: 'whUSDCHF' },
  NZDUSD: { name: '纽元/美元', tencentCode: 'whNZDUSD' },
  EURJPY: { name: '欧元/日元', tencentCode: 'whEURJPY' },
  GBPJPY: { name: '英镑/日元', tencentCode: 'whGBPJPY' },
  EURGBP: { name: '欧元/英镑', tencentCode: 'whEURGBP' },
  USDCNY: { name: '美元/人民币', tencentCode: 'whUSDCNY' },
  HKDCNY: { name: '港币/人民币', tencentCode: 'whHKDCNY' },
});

/** USD-priced precious metals; Tencent quotes them in a different (comma) format. */
export const FX_METALS = Object.freeze({
  XAUUSD: {
    name: '伦敦金（现货黄金）',
    tencentCode: 'hf_XAU',
    sinaSymbol: 'XAU',
    yahooSymbol: 'GC=F',
    unit: 'USD/oz',
  },
  XAGUSD: {
    name: '伦敦银（现货白银）',
    tencentCode: 'hf_XAG',
    sinaSymbol: 'XAG',
    yahooSymbol: 'SI=F',
    unit: 'USD/oz',
  },
});

/** Tencent metals source code (upper case) -> canonical pair code. */
const METAL_SOURCE_TO_CODE = Object.freeze(
  Object.fromEntries(Object.entries(FX_METALS).map(([code, meta]) => [meta.tencentCode.toUpperCase(), code])),
);

/** Tencent metals/symbol codes whose first 3 letters are not currencies. */
const FX_METAL_BASES = new Set(Object.keys(FX_METALS).map((code) => code.slice(0, 3)));

/**
 * Describe an FX pair code (`EURJPY`, `fx:eurjpy`, `whEURUSD`, `XAUUSD` …).
 * Returns null for anything that is not a supported/metal pair.
 *
 * @returns {{ code: string, baseCurrency: string, quoteCurrency: string,
 *   currency: string, name: string, tencentCode: string|null,
 *   cross: boolean, metal: boolean } | null}
 */
export function fxPairInfo(input) {
  const raw = String(input ?? '').trim().toUpperCase().replace(/^FX:?/, '');
  const byTencent = METAL_SOURCE_TO_CODE[raw];
  if (byTencent) {
    const base = byTencent.slice(0, 3);
    const meta = FX_METALS[byTencent];
    return {
      code: byTencent,
      baseCurrency: base,
      quoteCurrency: 'USD',
      currency: 'USD',
      name: meta.name,
      tencentCode: meta.tencentCode,
      cross: false,
      metal: true,
    };
  }
  let cleaned = raw.replace(/^WH/, '');
  if (FX_METALS[cleaned]) {
    const base = cleaned.slice(0, 3);
    const meta = FX_METALS[cleaned];
    return {
      code: cleaned,
      baseCurrency: base,
      quoteCurrency: 'USD',
      currency: 'USD',
      name: meta.name,
      tencentCode: meta.tencentCode,
      cross: false,
      metal: true,
    };
  }
  cleaned = cleaned.replace(/[^A-Z]/g, '');
  if (!/^[A-Z]{6}$/.test(cleaned)) return null;
  const baseCurrency = cleaned.slice(0, 3);
  const quoteCurrency = cleaned.slice(3);
  if (FX_METAL_BASES.has(baseCurrency)) return null;
  if (!FX_CURRENCIES[baseCurrency] || !FX_CURRENCIES[quoteCurrency]) return null;
  if (baseCurrency === quoteCurrency) return null;
  const known = FX_PAIRS[cleaned];
  return {
    code: cleaned,
    baseCurrency,
    quoteCurrency,
    currency: quoteCurrency,
    name: `${FX_CURRENCIES[baseCurrency]}/${FX_CURRENCIES[quoteCurrency]}`,
    tencentCode: known?.tencentCode || null,
    cross: !known,
    metal: false,
  };
}

/** Human readable pair name, e.g. 欧元/日元 (falls back to the raw code). */
export function fxPairName(input) {
  return fxPairInfo(input)?.name || String(input ?? '').toUpperCase();
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export const CRYPTO_NAMES = Object.freeze({
  BTC: '比特币',
  ETH: '以太坊',
  BNB: '币安币',
  SOL: 'Solana',
  XRP: '瑞波币',
  DOGE: '狗狗币',
  ADA: '艾达币',
  TON: 'Toncoin',
  AVAX: '雪崩协议',
  LINK: 'Chainlink',
  DOT: '波卡',
  LTC: '莱特币',
  BCH: '比特币现金',
  TRX: '波场',
  SHIB: '柴犬币',
  SUI: 'Sui',
  NEAR: 'NEAR',
  APT: 'Aptos',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  UNI: 'Uniswap',
  ATOM: 'Cosmos',
  FIL: 'Filecoin',
  ETC: '以太坊经典',
  XLM: '恒星币',
  ALGO: 'Algorand',
  VET: '唯链',
  ICP: 'Internet Computer',
  PEPE: 'Pepe',
  INJ: 'Injective',
  RENDER: 'Render',
});

/** Frequently traded USDT pairs (used for search and as health probe fallback). */
export const CRYPTO_POPULAR = Object.freeze([
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'TONUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
  'LTCUSDT',
  'BCHUSDT',
  'TRXUSDT',
  'SHIBUSDT',
  'SUIUSDT',
  'NEARUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'UNIUSDT',
  'ATOMUSDT',
  'FILUSDT',
  'ETCUSDT',
  'PEPEUSDT',
]);

/** Human readable crypto name, e.g. "比特币 BTC/USDT". */
export function cryptoDisplayName(symbol) {
  const code = String(symbol || '').toUpperCase().replace(/^CRYPTO/, '');
  const base = code.replace(/USDT$/, '');
  const cnName = CRYPTO_NAMES[base];
  return cnName ? `${cnName} ${base}/USDT` : `${base}/USDT`;
}

// ---------------------------------------------------------------------------
// Symbol parsing
// ---------------------------------------------------------------------------

const US_EXCHANGE_SUFFIXES = new Set([
  'OQ', 'N', 'PS', 'AM', 'NYQ', 'NQ', 'NZ', 'PK', 'OB', 'TS', 'TO', 'V', 'L', 'DE', 'F', 'SG',
  'MI', 'PA', 'AS', 'AX', 'SI', 'KS', 'TW', 'SA', 'MX', 'ST', 'HE', 'CO', 'OL', 'IR', 'LS',
  'MC', 'SW', 'VI', 'BR', 'DUS', 'MU', 'BE', 'DU', 'HM', 'HA', 'BSE', 'NS', 'BO',
]);

function inferMarket(raw) {
  if (/^hf_/i.test(raw) || /^wh/i.test(raw) || /^fx/i.test(raw)) return 'fx';
  if (/^(sh|sz|bj)\d/i.test(raw)) return 'cn';
  if (/^\d{6}$/.test(raw)) return 'cn';
  if (/^hk\d/i.test(raw)) return 'hk';
  if (/^us[A-Za-z]/i.test(raw)) return 'us';
  if (/^crypto/i.test(raw)) return 'crypto';
  if (/^[A-Z]{2,10}USDT$/i.test(raw)) return 'crypto';
  if (/^[A-Z]{6}$/i.test(raw)) return 'fx';
  // Bare pair with a separator, e.g. "EUR/JPY" or "EUR JPY".
  if (/^[A-Za-z]{3}[\/\-\s][A-Za-z]{3}$/.test(raw)) return 'fx';
  throw new Error(`无法识别的代码“${raw}”，请使用 market:code 格式（如 cn:sh600519）`);
}

function normalizeCn(raw) {
  const cleaned = raw.trim().replace(/^cn:/i, '');
  let match = /^(sh|sz|bj)(\d{6})$/i.exec(cleaned);
  if (!match && /^\d{6}$/.test(cleaned)) {
    const first = cleaned[0];
    const exchange =
      first === '6'
        ? 'sh'
        : first === '0' || first === '3'
          ? 'sz'
          : first === '4' || first === '8'
            ? 'bj'
            : 'sh';
    match = [null, exchange, cleaned];
  }
  if (!match) throw new Error(`无效的 A股代码“${raw}”（应形如 sh600519）`);
  const sourceCode = `${match[1].toLowerCase()}${match[2]}`;
  return { sourceCode, displayCode: match[2], codePart: sourceCode };
}

function normalizeHk(raw) {
  const cleaned = raw.trim().replace(/^hk:/i, '').replace(/^hk/i, '');
  if (!/^\d{1,5}$/.test(cleaned)) throw new Error(`无效的港股代码“${raw}”（应形如 hk00700）`);
  const padded = cleaned.padStart(5, '0');
  const sourceCode = `hk${padded}`;
  return { sourceCode, displayCode: padded, codePart: sourceCode };
}

function normalizeUs(raw) {
  let cleaned = raw.trim().replace(/^us:/i, '');
  if (/^us[A-Za-z]/.test(cleaned)) cleaned = cleaned.slice(2);
  cleaned = cleaned.toUpperCase();
  // Strip trailing exchange suffix such as .OQ / .N while keeping dotted tickers (BRK.B).
  const suffix = /^(.*)\.([A-Z]{1,4})$/.exec(cleaned);
  if (suffix && US_EXCHANGE_SUFFIXES.has(suffix[2]) && suffix[1]) cleaned = suffix[1];
  if (!/^[A-Z0-9.\-]{1,12}$/.test(cleaned)) throw new Error(`无效的美股代码“${raw}”（应形如 usAAPL）`);
  const sourceCode = `us${cleaned}`;
  return { sourceCode, displayCode: cleaned, codePart: `us${cleaned}` };
}

function normalizeFx(raw) {
  // Metals first: Tencent uses hf_XAU / hf_XAG source codes.
  const upper = raw.trim().toUpperCase().replace(/^FX:?/, '');
  const metalByTencent = METAL_SOURCE_TO_CODE[upper];
  if (metalByTencent) {
    const info = fxPairInfo(metalByTencent);
    return {
      sourceCode: info.tencentCode,
      tencentCode: info.tencentCode,
      displayCode: info.code,
      codePart: info.code,
      baseCurrency: info.baseCurrency,
      quoteCurrency: info.quoteCurrency,
      currency: info.currency,
      fxName: info.name,
      cross: false,
    };
  }
  const cleaned = upper.replace(/^WH/, '').replace(/[^A-Z]/g, '');
  if (FX_METALS[cleaned]) {
    const info = fxPairInfo(cleaned);
    return {
      sourceCode: info.tencentCode,
      tencentCode: info.tencentCode,
      displayCode: info.code,
      codePart: info.code,
      baseCurrency: info.baseCurrency,
      quoteCurrency: info.quoteCurrency,
      currency: info.currency,
      fxName: info.name,
      cross: false,
    };
  }
  if (!/^[A-Z]{6}$/.test(cleaned)) {
    throw new Error(`无效的外汇代码“${raw}”（应形如 fx:EURUSD 或 fx:EURJPY）`);
  }
  const baseCurrency = cleaned.slice(0, 3);
  const quoteCurrency = cleaned.slice(3);
  if (!FX_CURRENCIES[baseCurrency] || !FX_CURRENCIES[quoteCurrency]) {
    const bad = !FX_CURRENCIES[baseCurrency] ? baseCurrency : quoteCurrency;
    throw new Error(
      `不支持的币种“${bad}”，可用币种：${FX_CURRENCY_CODES.join('/')}`,
    );
  }
  if (baseCurrency === quoteCurrency) {
    throw new Error(`货币对的两个币种不能相同（${cleaned}）`);
  }
  const info = fxPairInfo(cleaned);
  if (!info) throw new Error(`无效的外汇代码“${raw}”（应形如 fx:EURUSD 或 fx:EURJPY）`);
  return {
    sourceCode: info.tencentCode,
    tencentCode: info.tencentCode,
    displayCode: info.code,
    codePart: info.code,
    baseCurrency: info.baseCurrency,
    quoteCurrency: info.quoteCurrency,
    currency: info.currency,
    fxName: info.name,
    cross: info.cross,
  };
}

function normalizeCrypto(raw) {
  let cleaned = raw.trim().toUpperCase().replace(/^CRYPTO:?/, '');
  if (!/^[A-Z0-9]{2,20}$/.test(cleaned)) throw new Error(`无效的加密货币代码“${raw}”（应形如 crypto:BTCUSDT）`);
  if (!cleaned.endsWith('USDT') && CRYPTO_NAMES[cleaned]) cleaned = `${cleaned}USDT`;
  if (!cleaned.endsWith('USDT')) throw new Error(`加密货币“${raw}”仅支持 USDT 交易对（应形如 crypto:BTCUSDT）`);
  // Canonical form is single-prefixed: crypto:BTCUSDT (source code BTCUSDT).
  return { sourceCode: cleaned, displayCode: cleaned, codePart: cleaned };
}

const NORMALIZERS = {
  cn: normalizeCn,
  hk: normalizeHk,
  us: normalizeUs,
  fx: normalizeFx,
  crypto: normalizeCrypto,
};

/**
 * Parse a symbol in any accepted spelling.
 * @returns {{ input: string, market: string, code: string, displayCode: string,
 *   symbol: string, name: string|null, sourceCode: string|null, tencentCode: string|null,
 *   binanceSymbol: string|null, currency: string, baseCurrency: string|null,
 *   quoteCurrency: string|null, cross: boolean, isIndex: boolean, tradeable: boolean }}
 */
export function parseSymbol(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('代码不能为空');
  }
  const raw = input.trim();
  let market;
  let body;
  const colon = raw.indexOf(':');
  if (colon > 0) {
    market = raw.slice(0, colon).trim().toLowerCase();
    body = raw.slice(colon + 1).trim();
    if (!MARKET_IDS.includes(market)) {
      throw new Error(`不支持的市场“${market}”，可用市场：${MARKET_IDS.join('/')}`);
    }
  } else {
    market = inferMarket(raw);
    body = raw;
  }
  const normalized = NORMALIZERS[market](body);
  const isIndex = market === 'cn' && /^(sh000|sz399)/.test(normalized.sourceCode || '');
  const symbol = `${market}:${normalized.codePart}`;
  const baseCurrency = normalized.baseCurrency ?? null;
  const quoteCurrency = normalized.quoteCurrency ?? null;
  const currency =
    normalized.currency ?? (market === 'fx' ? quoteCurrency || 'USD' : MARKET_CURRENCIES[market]);
  const tencentCode =
    normalized.tencentCode !== undefined
      ? normalized.tencentCode
      : market === 'crypto'
        ? null
        : normalized.sourceCode;
  return {
    input: raw,
    market,
    code: normalized.codePart,
    displayCode: normalized.displayCode,
    symbol,
    name: normalized.fxName ?? null,
    sourceCode: normalized.sourceCode ?? null,
    tencentCode,
    binanceSymbol: market === 'crypto' ? normalized.sourceCode : null,
    currency,
    baseCurrency,
    quoteCurrency,
    cross: normalized.cross === true,
    isIndex,
    tradeable: !isIndex,
  };
}

/** Convenience wrapper returning the canonical `market:code` string. */
export function normalizeSymbol(input) {
  return parseSymbol(input).symbol;
}

/** Currency for a market code or a symbol. */
export function currencyOf(marketOrSymbol) {
  if (typeof marketOrSymbol === 'string' && marketOrSymbol.includes(':')) {
    return parseSymbol(marketOrSymbol).currency;
  }
  return MARKET_CURRENCIES[marketOrSymbol] || null;
}

/** Market metadata without dynamic (availability dependent) intervals. */
export function getMarketMetaBase(market) {
  const base = MARKET_BASE_META[market];
  if (!base) return null;
  const meta = {
    id: base.id,
    name: base.name,
    currency: base.currency,
    tradeable: base.tradeable,
    timezone: base.timezone,
    priceLimit: base.priceLimit,
    intervals: [...base.intervals],
    sessions: getSessions(market),
  };
  if (base.note) meta.note = base.note;
  return meta;
}

// ---------------------------------------------------------------------------
// Yahoo Finance symbol mapping (fallback source)
// ---------------------------------------------------------------------------

export function toYahooSymbol(input) {
  const parsed = typeof input === 'string' ? parseSymbol(input) : input;
  switch (parsed.market) {
    case 'us':
      return parsed.displayCode.replace(/\./g, '-');
    case 'hk': {
      const digits = String(Number(parsed.displayCode)).padStart(4, '0');
      return `${digits}.HK`;
    }
    case 'cn': {
      if (parsed.sourceCode.startsWith('bj')) return null;
      const suffix = parsed.sourceCode.startsWith('sh') ? '.SS' : '.SZ';
      return `${parsed.displayCode}${suffix}`;
    }
    case 'fx': {
      const metal = FX_METALS[parsed.displayCode];
      if (metal) return metal.yahooSymbol;
      return `${parsed.displayCode}=X`;
    }
    case 'crypto': {
      const base = parsed.displayCode.replace(/USDT$/, '');
      return `${base}-USD`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Time helpers — every timestamp we expose is an ISO 8601 string with offset.
// Market data is displayed in Asia/Shanghai, so bar/quote times are normalised
// to +08:00.
// ---------------------------------------------------------------------------

const SHANGHAI_OFFSET = '+08:00';

function pad2(value) {
  return String(value).padStart(2, '0');
}

const zoneFormatters = new Map();

function zoneFormatter(timeZone) {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function zoneParts(epochMs, timeZone) {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs));
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/** Format an epoch timestamp as an ISO string in Asia/Shanghai (+08:00). */
export function toShanghaiIso(epochMs) {
  const parts = zoneParts(epochMs, 'Asia/Shanghai');
  return `${parts.year}-${parts.month}-${parts.day}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}${SHANGHAI_OFFSET}`;
}

/**
 * Convert a wall-clock time (e.g. Tencent's "2026-10-23 16:00:01" in New York)
 * into a Shanghai ISO timestamp.
 */
export function wallTimeToShanghaiIso({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!timeZone || timeZone === 'Asia/Shanghai') {
    return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${SHANGHAI_OFFSET}`;
  }
  let instant = wallAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const parts = zoneParts(instant, timeZone);
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const offset = asUtc - instant;
    const next = wallAsUtc - offset;
    if (next === instant) break;
    instant = next;
  }
  return toShanghaiIso(instant);
}

/** '2026-10-23' or '20261023' -> bar timestamp at 00:00 Asia/Shanghai. */
export function dateToBarIso(date) {
  const text = String(date);
  const normalized = /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : text.slice(0, 10);
  return `${normalized}T00:00:00${SHANGHAI_OFFSET}`;
}

/** Calendar date (YYYY-MM-DD) of an epoch timestamp in the given IANA zone. */
export function dateInZone(epochMs, timeZone) {
  const parts = zoneParts(epochMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** ISO week key (Monday date) for a YYYY-MM-DD string; used to aggregate weekly bars. */
export function isoWeekKey(date) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - weekday);
  return d.toISOString().slice(0, 10);
}

/** Format an epoch timestamp as `HH:mm:ss` in Asia/Shanghai. */
export function timeInShanghai(epochMs) {
  const parts = zoneParts(epochMs, 'Asia/Shanghai');
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}
