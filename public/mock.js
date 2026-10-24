/* ChimaTrader mock backend.
 * Enabled with ?mock=1 (add &seed=1 for a pre-populated demo). It implements
 * the exact response shapes of CONTRACTS.md sections 3 and 7 so the UI can be
 * developed and verified without server.mjs. Only browser globals are used.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  if (params.get('mock') !== '1') {
    window.MOCK = window.MOCK || false;
    return;
  }
  window.MOCK = true;

  var SEED = params.get('seed') === '1';
  var STORAGE_KEY = 'chimatrader.mock.v2';

  var CNY_PER = { CNY: 1, USD: 7.118, HKD: 0.912, USDT: 7.112 };
  var FX_CONVERT_SPREAD = 0.003;
  var CURRENCY = { cn: 'CNY', hk: 'HKD', us: 'USD', fx: 'USD', crypto: 'USDT' };
  var SOURCE = { cn: 'tencent', hk: 'tencent', us: 'yahoo', fx: 'yahoo', crypto: 'binance' };
  var MARKET_ORDER = ['cn', 'hk', 'us', 'fx', 'crypto'];
  var SLIPPAGE_BPS = { cn: 1, hk: 1, us: 1, fx: 2, crypto: 3 };
  var MARKET_VOL = { cn: 0.012, hk: 0.016, us: 0.018, fx: 0.0025, crypto: 0.026 };
  var FEES = {
    cn: { commissionRate: 0.00025, commissionMin: 5, stampDutyRate: 0.0005, stampDutySide: 'sell', transferFeeRate: 0.00001 },
    hk: { commissionRate: 0.00025, commissionMin: 100, stampDutyRate: 0.001, stampDutySide: 'both', exchangeFeeRate: 0.0000565, settlementFeeRate: 0.00002 },
    us: { perShare: 0.005, commissionMin: 1, secFeeRate: 0.0000278, secFeeSide: 'sell' },
    fx: { spreadBps: 1.5, commissionRate: 0 },
    crypto: { commissionRate: 0.001 }
  };

  // v3 defaults: account settings deep-merge over these.
  var MARGIN = {
    mmr: { cn: 1, hk: 0.05, us: 0.05, fx: 0.0025, crypto: 0.005 },
    interestAnnual: { cn: 0, hk: 0.06, us: 0.06, fx: 0.03, crypto: 0.08 },
    liquidationFeeRate: { cn: 0, hk: 0.002, us: 0.002, fx: 0, crypto: 0.005 }
  };
  var BASE_LEVERAGE = { cn: 1, hk: 10, us: 10, fx: 200, crypto: 100 };
  var LEVERAGE_CEILING = { cn: 1, hk: 20, us: 20, fx: 500, crypto: 125 };
  var MAX_LEVERAGE = LEVERAGE_CEILING;
  var ALLOW_SHORT = { cn: false, hk: true, us: true, fx: true, crypto: true };
  var DEFAULT_SETTINGS = {
    leverageMultiplier: 1,
    fees: clone(FEES),
    slippageBps: clone(SLIPPAGE_BPS),
    margin: clone(MARGIN),
    autoConvert: true,
    fxConvertSpread: FX_CONVERT_SPREAD
  };
  var SETTINGS_RANGES = {
    initialCapital: [1000, 1000000000],
    leverageMultiplier: [0.1, 2],
    fees: {
      commissionRate: [0, 0.005], commissionMin: [0, 500],
      stampDutyRate: [0, 0.005], transferFeeRate: [0, 0.001],
      exchangeFeeRate: [0, 0.001], settlementFeeRate: [0, 0.001],
      perShare: [0, 0.1], secFeeRate: [0, 0.001], spreadBps: [0, 100]
    },
    slippageBps: [0, 200],
    margin: {
      mmr: { hk: [0.005, 0.5], us: [0.005, 0.5], fx: [0.0005, 0.1], crypto: [0.0005, 0.1] },
      interestAnnual: [0, 0.5], liquidationFeeRate: [0, 0.05]
    },
    fxConvertSpread: [0, 0.02]
  };
  var SETTINGS_PRESETS = {
    conservative: { leverageMultiplier: 0.1, margin: { mmr: { cn: 1, hk: 0.1, us: 0.1, fx: 0.005, crypto: 0.01 } } },
    recommended: { leverageMultiplier: 1, margin: { mmr: { cn: 1, hk: 0.05, us: 0.05, fx: 0.0025, crypto: 0.005 } } },
    aggressive: { leverageMultiplier: 2, margin: { mmr: { cn: 1, hk: 0.04, us: 0.04, fx: 0.002, crypto: 0.004 } } }
  };
  var SETTINGS_MARKETS = [
    { id: 'cn', name: 'A股', currency: 'CNY', baseLeverage: 1, maxLeverageCeiling: 1, shortable: false },
    { id: 'hk', name: '港股', currency: 'HKD', baseLeverage: 10, maxLeverageCeiling: 20, shortable: true },
    { id: 'us', name: '美股', currency: 'USD', baseLeverage: 10, maxLeverageCeiling: 20, shortable: true },
    { id: 'fx', name: '外汇', currency: 'USD', baseLeverage: 200, maxLeverageCeiling: 500, shortable: true },
    { id: 'crypto', name: '加密', currency: 'USDT', baseLeverage: 100, maxLeverageCeiling: 125, shortable: true }
  ];

  var MARKET_META = [
    {
      id: 'cn', name: 'A股', currency: 'CNY', tradeable: true, maxLeverage: 1, allowShort: false,
      intervals: ['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M'],
      sessions: [
        { start: '09:30', end: '11:30', tz: 'Asia/Shanghai' },
        { start: '13:00', end: '15:00', tz: 'Asia/Shanghai' }
      ]
    },
    {
      id: 'hk', name: '港股', currency: 'HKD', tradeable: true, maxLeverage: 4, allowShort: true,
      intervals: ['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M'],
      sessions: [
        { start: '09:30', end: '12:00', tz: 'Asia/Hong_Kong' },
        { start: '13:00', end: '16:00', tz: 'Asia/Hong_Kong' }
      ]
    },
    {
      id: 'us', name: '美股', currency: 'USD', tradeable: true, maxLeverage: 4, allowShort: true,
      intervals: ['1d', '1w', '1M'],
      sessions: [{ start: '09:30', end: '16:00', tz: 'America/New_York' }]
    },
    {
      id: 'fx', name: '外汇', currency: 'USD', tradeable: true, maxLeverage: 100, allowShort: true,
      intervals: ['1d', '1w', '1M'],
      sessions: [
        { start: '00:00', end: '05:00', tz: 'Asia/Shanghai' },
        { start: '06:00', end: '24:00', tz: 'Asia/Shanghai' }
      ]
    },
    {
      id: 'crypto', name: '加密', currency: 'USDT', tradeable: true, maxLeverage: 20, allowShort: true,
      intervals: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
      sessions: [{ start: '00:00', end: '24:00', tz: 'Asia/Shanghai' }]
    }
  ];
  var MARKET_MAP = {};
  MARKET_META.forEach(function (m) { MARKET_MAP[m.id] = m; });

  // symbol, code, name, market, base price, lot size (optional)
  var CATALOG_RAW = [
    ['cn:sh600519', 'sh600519', '贵州茅台', 'cn', 1335.0],
    ['cn:sz300750', 'sz300750', '宁德时代', 'cn', 256.4],
    ['cn:sh601318', 'sh601318', '中国平安', 'cn', 52.3],
    ['cn:sz000001', 'sz000001', '平安银行', 'cn', 11.24],
    ['cn:sh600036', 'sh600036', '招商银行', 'cn', 39.8],
    ['cn:sh601899', 'sh601899', '紫金矿业', 'cn', 17.62],
    ['cn:sz002594', 'sz002594', '比亚迪', 'cn', 268.5],
    ['cn:sh600030', 'sh600030', '中信证券', 'cn', 24.34],
    ['cn:sh688981', 'sh688981', '中芯国际', 'cn', 58.2],
    ['cn:sh000001', 'sh000001', '上证指数', 'cn', 3280.5],
    ['cn:sh600276', 'sh600276', '恒瑞医药', 'cn', 45.2],
    ['cn:sh600887', 'sh600887', '伊利股份', 'cn', 28.3],
    ['cn:sz000333', 'sz000333', '美的集团', 'cn', 65.4],
    ['cn:sz000858', 'sz000858', '五粮液', 'cn', 145.6],
    ['cn:sh601012', 'sh601012', '隆基绿能', 'cn', 18.9],
    ['cn:sh601166', 'sh601166', '兴业银行', 'cn', 17.2],
    ['cn:sh601398', 'sh601398', '工商银行', 'cn', 5.8],
    ['cn:sh601857', 'sh601857', '中国石油', 'cn', 8.6],
    ['cn:sh600900', 'sh600900', '长江电力', 'cn', 27.4],
    ['cn:sz002415', 'sz002415', '海康威视', 'cn', 32.1],
    ['cn:sz300124', 'sz300124', '汇川技术', 'cn', 58.7],
    ['cn:sh688111', 'sh688111', '金山办公', 'cn', 210.4],
    ['cn:sz000651', 'sz000651', '格力电器', 'cn', 40.2],
    ['cn:sh603259', 'sh603259', '药明康德', 'cn', 52.8],
    ['cn:sz300760', 'sz300760', '迈瑞医疗', 'cn', 280.5],
    ['hk:hk00700', 'hk00700', '腾讯控股', 'hk', 380.2, 100],
    ['hk:hk09988', 'hk09988', '阿里巴巴-W', 'hk', 78.45, 100],
    ['hk:hk03690', 'hk03690', '美团-W', 'hk', 120.4, 100],
    ['hk:hk01810', 'hk01810', '小米集团-W', 'hk', 18.62, 200],
    ['hk:hk00941', 'hk00941', '中国移动', 'hk', 72.35, 500],
    ['hk:hk00005', 'hk00005', '汇丰控股', 'hk', 62.4, 400],
    ['hk:hk00388', 'hk00388', '香港交易所', 'hk', 280.6, 100],
    ['hk:hk01299', 'hk01299', '友邦保险', 'hk', 58.3, 200],
    ['hk:hk00939', 'hk00939', '建设银行', 'hk', 5.6, 1000],
    ['hk:hk02318', 'hk02318', '中国平安', 'hk', 45.2, 500],
    ['hk:hk00883', 'hk00883', '中国海洋石油', 'hk', 18.7, 1000],
    ['hk:hk09618', 'hk09618', '京东集团-SW', 'hk', 120.3, 50],
    ['hk:hk09999', 'hk09999', '网易-S', 'hk', 145.8, 100],
    ['hk:hk01024', 'hk01024', '快手-W', 'hk', 52.6, 100],
    ['hk:hk02015', 'hk02015', '理想汽车-W', 'hk', 95.4, 100],
    ['hk:hk09888', 'hk09888', '百度集团-SW', 'hk', 88.7, 50],
    ['hk:hk00016', 'hk00016', '新鸿基地产', 'hk', 75.2, 500],
    ['hk:hk00027', 'hk00027', '银河娱乐', 'hk', 31.5, 1000],
    ['hk:hk00669', 'hk00669', '创科实业', 'hk', 98.4, 500],
    ['hk:hk02388', 'hk02388', '中银香港', 'hk', 24.8, 500],
    ['us:usAAPL', 'usAAPL', '苹果', 'us', 228.52],
    ['us:usNVDA', 'usNVDA', '英伟达', 'us', 128.74],
    ['us:usTSLA', 'usTSLA', '特斯拉', 'us', 242.65],
    ['us:usMSFT', 'usMSFT', '微软', 'us', 428.31],
    ['us:usAMZN', 'usAMZN', '亚马逊', 'us', 185.42],
    ['us:usSPY', 'usSPY', '标普500ETF', 'us', 573.21],
    ['us:usQQQ', 'usQQQ', '纳指100ETF', 'us', 480.15],
    ['us:usGOOGL', 'usGOOGL', '谷歌', 'us', 168.4],
    ['us:usMETA', 'usMETA', 'Meta', 'us', 512.3],
    ['us:usAMD', 'usAMD', 'AMD', 'us', 158.2],
    ['us:usNFLX', 'usNFLX', '奈飞', 'us', 698.4],
    ['us:usAVGO', 'usAVGO', '博通', 'us', 172.6],
    ['us:usJPM', 'usJPM', '摩根大通', 'us', 218.4],
    ['us:usV', 'usV', '维萨', 'us', 276.1],
    ['us:usDIS', 'usDIS', '迪士尼', 'us', 95.6],
    ['us:usBA', 'usBA', '波音', 'us', 152.3],
    ['us:usINTC', 'usINTC', '英特尔', 'us', 22.4],
    ['us:usQCOM', 'usQCOM', '高通', 'us', 168.9],
    ['us:usCOIN', 'usCOIN', 'Coinbase', 'us', 210.5],
    ['us:usMSTR', 'usMSTR', '微策略', 'us', 180.2],
    ['fx:EURUSD', 'EURUSD', '欧元/美元', 'fx', 1.08642],
    ['fx:USDJPY', 'USDJPY', '美元/日元', 'fx', 151.324],
    ['fx:XAUUSD', 'XAUUSD', '黄金/美元', 'fx', 2412.55],
    ['fx:XAGUSD', 'XAGUSD', '白银/美元', 'fx', 28.452],
    ['fx:USDCNY', 'USDCNY', '美元/人民币', 'fx', 7.1234],
    ['fx:GBPUSD', 'GBPUSD', '英镑/美元', 'fx', 1.2734],
    ['fx:AUDUSD', 'AUDUSD', '澳元/美元', 'fx', 0.6572],
    ['fx:USDCHF', 'USDCHF', '美元/瑞郎', 'fx', 0.8846],
    ['fx:USDCAD', 'USDCAD', '美元/加元', 'fx', 1.3642],
    ['fx:EURJPY', 'EURJPY', '欧元/日元', 'fx', 164.32],
    ['fx:GBPJPY', 'GBPJPY', '英镑/日元', 'fx', 196.42],
    ['fx:NZDUSD', 'NZDUSD', '纽元/美元', 'fx', 0.5984],
    ['fx:USDHKD', 'USDHKD', '美元/港币', 'fx', 7.8123],
    ['fx:XPTUSD', 'XPTUSD', '铂金/美元', 'fx', 985.4],
    ['fx:XPDUSD', 'XPDUSD', '钯金/美元', 'fx', 1024.6],
    ['crypto:BTCUSDT', 'BTCUSDT', '比特币', 'crypto', 67234.5],
    ['crypto:ETHUSDT', 'ETHUSDT', '以太坊', 'crypto', 2534.2],
    ['crypto:BNBUSDT', 'BNBUSDT', '币安币', 'crypto', 598.3],
    ['crypto:SOLUSDT', 'SOLUSDT', 'Solana', 'crypto', 168.2],
    ['crypto:XRPUSDT', 'XRPUSDT', '瑞波币', 'crypto', 0.5421],
    ['crypto:DOGEUSDT', 'DOGEUSDT', '狗狗币', 'crypto', 0.1234],
    ['crypto:ADAUSDT', 'ADAUSDT', '艾达币', 'crypto', 0.3421],
    ['crypto:AVAXUSDT', 'AVAXUSDT', '雪崩', 'crypto', 27.4],
    ['crypto:LINKUSDT', 'LINKUSDT', 'Chainlink', 'crypto', 11.24],
    ['crypto:DOTUSDT', 'DOTUSDT', '波卡', 'crypto', 4.12],
    ['crypto:LTCUSDT', 'LTCUSDT', '莱特币', 'crypto', 68.4],
    ['crypto:BCHUSDT', 'BCHUSDT', '比特币现金', 'crypto', 345.2],
    ['crypto:TRXUSDT', 'TRXUSDT', '波场', 'crypto', 0.1234],
    ['crypto:SHIBUSDT', 'SHIBUSDT', '柴犬币', 'crypto', 0.0000182],
    ['crypto:UNIUSDT', 'UNIUSDT', 'Uniswap', 'crypto', 7.42],
    ['crypto:ATOMUSDT', 'ATOMUSDT', 'Cosmos', 'crypto', 4.56],
    ['crypto:APTUSDT', 'APTUSDT', 'Aptos', 'crypto', 8.72],
    ['crypto:NEARUSDT', 'NEARUSDT', 'NEAR', 'crypto', 4.32],
    ['crypto:FILUSDT', 'FILUSDT', 'Filecoin', 'crypto', 5.12],
    ['crypto:ARBUSDT', 'ARBUSDT', 'Arbitrum', 'crypto', 0.542]
  ];

  var CATALOG = CATALOG_RAW.map(function (row) {
    return { symbol: row[0], code: row[1], name: row[2], market: row[3], base: row[4], lotSize: row[5] || null };
  });
  var CATALOG_MAP = {};
  CATALOG.forEach(function (item) { CATALOG_MAP[item.symbol] = item; });

  var DEFAULT_WATCHLIST = [
    'cn:sh600519', 'cn:sz300750', 'cn:sh601318', 'hk:hk00700', 'us:usAAPL',
    'us:usNVDA', 'fx:EURUSD', 'fx:XAUUSD', 'crypto:BTCUSDT', 'crypto:ETHUSDT'
  ];

  // ---------------------------------------------------------------- utilities

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function isoCN(epochMs) {
    var d = new Date(epochMs + 8 * 3600 * 1000);
    return d.toISOString().replace('Z', '+08:00');
  }
  function nowISO() { return isoCN(Date.now()); }
  function todayKey() { return isoCN(Date.now()).slice(0, 10); }
  function shanghaiDayKeyOf(iso) {
    var ms = Date.parse(iso);
    if (!isFinite(ms)) return null;
    return isoCN(ms).slice(0, 10);
  }
  function roundTo(value, digits) {
    var f = Math.pow(10, digits);
    return Math.round(value * f) / f;
  }
  function round2(value) { return roundTo(value, 2); }
  function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }
  function hashStr(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clone(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
  function marketOf(symbol) { return String(symbol).split(':')[0]; }

  // Canonical symbol form per CONTRACTS.md section 2:
  // cn:sh600519 / hk:hk00700 / us:usAAPL / fx:EURUSD / crypto:BTCUSDT.
  // Aliases (fx:fxEURUSD, crypto:cryptoBTCUSDT, bare BTCUSDT) are accepted.
  function normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    var raw = String(symbol).trim();
    if (CATALOG_MAP[raw]) return raw;
    var idx = raw.indexOf(':');
    var market = idx >= 0 ? raw.slice(0, idx) : '';
    var rest = idx >= 0 ? raw.slice(idx + 1) : raw;
    var candidate = null;
    if (market === 'fx') candidate = 'fx:' + rest.replace(/^fx/i, '').toUpperCase();
    else if (market === 'crypto') candidate = 'crypto:' + rest.replace(/^crypto/i, '').toUpperCase();
    else if (market) candidate = market + ':' + rest;
    else candidate = 'crypto:' + rest.toUpperCase();
    if (CATALOG_MAP[candidate]) return candidate;
    return candidate;
  }
  function priceDigits(market, price) {
    if (market === 'fx') return price >= 1000 ? 2 : price >= 100 ? 3 : 5;
    if (market === 'crypto') return price >= 100 ? 2 : price >= 1 ? 4 : 6;
    return 2;
  }
  function roundPrice(symbol, value) {
    var market = marketOf(symbol);
    var q = quotes[symbol];
    var ref = q ? q.price : value;
    return roundTo(value, priceDigits(market, ref));
  }
  function volumeDigits(market) { return (market === 'crypto' || market === 'fx') ? 4 : 0; }
  function roundVolume(market, value) { return roundTo(value, volumeDigits(market)); }

  function fail(status, code, message) {
    var err = new Error(message);
    err.status = status;
    err.code = code;
    throw err;
  }

  function parseBody(raw) {
    if (raw == null) return {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw || '{}'); } catch (e) { fail(400, 'BAD_JSON', '请求体不是合法的 JSON'); }
    }
    return raw;
  }

  // ------------------------------------------------------------ quote engine

  var quotes = {};

  function initQuotes() {
    quotes = {};
    CATALOG.forEach(function (item) {
      var rand = mulberry32(hashStr(item.symbol));
      var digits = priceDigits(item.market, item.base);
      var prevClose = roundTo(item.base * (1 - (rand() - 0.5) * 0.03), digits);
      var open = roundTo(prevClose * (1 + (rand() - 0.5) * 0.012), digits);
      var price = roundTo(item.base, digits);
      var q = {
        symbol: item.symbol, market: item.market, code: item.code, name: item.name,
        currency: CURRENCY[item.market], price: price, prevClose: prevClose,
        open: open, high: Math.max(price, open), low: Math.min(price, open),
        change: roundTo(price - prevClose, digits), changePct: 0,
        volume: roundVolume(item.market, (10000 + rand() * 90000) * (item.market === 'crypto' ? 0.01 : 1)),
        amount: 0, bid: [], ask: [], ts: nowISO(), stale: false,
        source: SOURCE[item.market], extra: {}, _bucket: -1,
        _base: item.base, _lotSize: item.lotSize, _rand: rand
      };
      q.changePct = q.prevClose ? roundTo((q.change / q.prevClose) * 100, 2) : 0;
      quotes[item.symbol] = q;
    });
  }

  function extraFor(q) {
    var item = CATALOG_MAP[q.symbol];
    var extra = { limitUp: null, limitDown: null, lotSize: null, turnoverRate: null, pe: null, pb: null, marketCap: null };
    if (q.market === 'cn') {
      var digits = priceDigits(q.market, q.prevClose);
      extra.limitUp = roundTo(q.prevClose * 1.1, digits);
      extra.limitDown = roundTo(q.prevClose * 0.9, digits);
      extra.turnoverRate = roundTo(0.2 + (hashStr(q.symbol) % 500) / 100, 2);
      extra.pe = roundTo(8 + (hashStr(q.symbol) % 4000) / 100, 2);
      extra.pb = roundTo(1 + (hashStr(q.symbol) % 900) / 100, 2);
      extra.marketCap = roundTo(500 + (hashStr(q.symbol) % 20000), 2);
    } else if (q.market === 'hk') {
      extra.lotSize = item && item.lotSize ? item.lotSize : 100;
    }
    return extra;
  }

  function tickQuote(symbol) {
    var q = quotes[symbol];
    if (!q) return null;
    if (q._frozen) return q;
    var bucket = Math.floor(Date.now() / 500);
    if (q._bucket === bucket) return q;
    q._bucket = bucket;

    var item = CATALOG_MAP[symbol];
    var rand = mulberry32(hashStr(symbol + ':' + bucket));
    var vol = MARKET_VOL[q.market] || 0.01;
    var drift = (rand() - 0.5) * vol * 0.35;
    var price = q.price * (1 + drift);
    price = clamp(price, q._base * 0.85, q._base * 1.15);
    var digits = priceDigits(q.market, q._base);
    q.price = roundTo(price, digits);
    q.high = Math.max(q.high, q.price);
    q.low = Math.min(q.low, q.price);
    q.change = roundTo(q.price - q.prevClose, digits);
    q.changePct = q.prevClose ? roundTo((q.change / q.prevClose) * 100, 2) : 0;
    q.ts = nowISO();
    q.extra = extraFor(q);

    var isIndex = item && item.code === 'sh000001';
    if (!isIndex) {
      var halfSpread = q.price * ((q.market === 'fx' ? 1.5 : q.market === 'crypto' ? 2 : 1) / 10000) / 2;
      q.bid = [{ price: roundPrice(symbol, q.price - halfSpread), size: Math.round(10 + rand() * 900) }];
      q.ask = [{ price: roundPrice(symbol, q.price + halfSpread), size: Math.round(10 + rand() * 900) }];
    }
    var unit = q.market === 'crypto' ? 0.5 : q.market === 'hk' ? 8000 : q.market === 'us' ? 30000 : q.market === 'fx' ? 0 : 120;
    q.volume = roundVolume(q.market, q.volume + rand() * unit);
    q.amount = round2(q.volume * q.price * (q.market === 'cn' ? 100 : 1));
    return q;
  }

  function quoteState(symbol) {
    var q = quotes[symbol];
    if (!q) return null;
    if (q._bucket === -1) tickQuote(symbol);
    return q;
  }

  function publicQuote(q) {
    return {
      symbol: q.symbol, market: q.market, code: q.code, name: q.name,
      currency: q.currency, price: q.price, prevClose: q.prevClose,
      open: q.open, high: q.high, low: q.low,
      change: q.change, changePct: q.changePct,
      volume: q.volume, amount: q.amount,
      bid: clone(q.bid), ask: clone(q.ask),
      ts: q.ts, stale: false, source: q.source, extra: clone(q.extra)
    };
  }

  function quoteFor(symbol) {
    if (!quotes[symbol]) return null;
    tickQuote(symbol);
    return publicQuote(quotes[symbol]);
  }

  // ------------------------------------------------------------ fee engine

  function calcFees(market, side, qty, price, cfgOverride) {
    var notional = qty * price;
    var total = 0;
    var breakdown = {};
    var cfg = cfgOverride || FEES[market] || {};
    var sideApplies = function (rule) { return !rule || rule === 'both' || rule === side; };
    if (market === 'cn') {
      var commission = Math.max(notional * cfg.commissionRate, cfg.commissionMin);
      var stamp = sideApplies(cfg.stampDutySide) ? notional * cfg.stampDutyRate : 0;
      var transfer = notional * cfg.transferFeeRate;
      breakdown = { commission: commission, stampDuty: stamp, transferFee: transfer };
      total = commission + stamp + transfer;
    } else if (market === 'hk') {
      var hkCommission = Math.max(notional * cfg.commissionRate, cfg.commissionMin);
      var hkStamp = sideApplies(cfg.stampDutySide) ? notional * cfg.stampDutyRate : 0;
      var exchange = notional * cfg.exchangeFeeRate;
      var settlement = notional * cfg.settlementFeeRate;
      breakdown = { commission: hkCommission, stampDuty: hkStamp, exchangeFee: exchange, settlementFee: settlement };
      total = hkCommission + hkStamp + exchange + settlement;
    } else if (market === 'us') {
      var perShare = Math.max(qty * cfg.perShare, cfg.commissionMin);
      var sec = sideApplies(cfg.secFeeSide) ? notional * cfg.secFeeRate : 0;
      breakdown = { commission: perShare, secFee: sec };
      total = perShare + sec;
    } else if (market === 'crypto') {
      var cryptoCommission = notional * cfg.commissionRate;
      breakdown = { commission: cryptoCommission };
      total = cryptoCommission;
    } else if (market === 'fx') {
      // FX spread is charged through the fill price; keep fee total 0 here.
      breakdown = { spreadBps: cfg.spreadBps };
      total = 0;
    } else {
      breakdown = {};
      total = 0;
    }
    return { total: round2(total), breakdown: breakdown };
  }

  function slippageBpsFor(account, market) { return effectiveSlippage(account, market); }

  function marketFillPrice(symbol, side, account) {
    var q = quoteState(symbol);
    var market = q.market;
    var digits = priceDigits(market, q.price);
    if (market === 'fx') {
      var fxCfg = account ? effectiveFeeConfig(account, 'fx') : FEES.fx;
      var half = (Number(fxCfg.spreadBps) / 2) / 10000;
      return roundTo(side === 'buy' ? q.price * (1 + half) : q.price * (1 - half), digits);
    }
    var base = side === 'buy'
      ? (q.ask[0] ? q.ask[0].price : q.price)
      : (q.bid[0] ? q.bid[0].price : q.price);
    var slip = (account ? effectiveSlippage(account, market) : (SLIPPAGE_BPS[market] || 0)) / 10000;
    return roundTo(side === 'buy' ? base * (1 + slip) : base * (1 - slip), digits);
  }

  // -------------------------------------------------------------- kline data

  var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '60m': 3600000, '1h': 3600000, '4h': 14400000,
    '1d': 86400000, '1w': 604800000, '1M': 2592000000
  };

  function barsFor(symbol, interval, limit) {
    var item = CATALOG_MAP[symbol];
    if (!item) fail(404, 'UNKNOWN_SYMBOL', '未知标的：' + symbol);
    var meta = MARKET_MAP[item.market];
    if (!meta.intervals.includes(interval)) {
      fail(400, 'KLINE_INTERVAL_UNSUPPORTED', '该市场不支持周期 ' + interval);
    }
    var q = quoteState(symbol);
    var step = INTERVAL_MS[interval] || 86400000;
    var count = clamp(parseInt(limit, 10) || 300, 10, 500);
    var rand = mulberry32(hashStr(symbol + ':' + interval));
    var vol = MARKET_VOL[item.market] || 0.01;

    var nowWall = Date.now() + 8 * 3600 * 1000;
    var endWall = step >= 86400000
      ? Math.floor(nowWall / 86400000) * 86400000
      : Math.floor(nowWall / step) * step;
    var startWall = endWall - (count - 1) * step;

    var price = q.price * (1 - (rand() - 0.5) * vol * 6);
    var bars = [];
    for (var i = 0; i < count; i++) {
      var open = price;
      var close = Math.max(0.00001, open * (1 + (rand() - 0.5) * vol));
      var high = Math.max(open, close) * (1 + rand() * vol * 0.45);
      var low = Math.min(open, close) * (1 - rand() * vol * 0.45);
      var digits = priceDigits(item.market, close);
      bars.push({
        t: isoCN(startWall + i * step - 8 * 3600 * 1000),
        o: roundTo(open, digits),
        h: roundTo(high, digits),
        l: roundTo(low, digits),
        c: roundTo(close, digits),
        v: roundVolume(item.market, (1000 + rand() * 9000) * (item.market === 'crypto' ? 0.6 : item.market === 'fx' ? 10 : 1))
      });
      price = close;
    }
    // Anchor the last bar to the live quote so chart and header agree.
    var factor = q.price / bars[bars.length - 1].c;
    var digits2 = priceDigits(item.market, q.price);
    for (var j = 0; j < bars.length; j++) {
      bars[j].o = roundTo(bars[j].o * factor, digits2);
      bars[j].h = roundTo(bars[j].h * factor, digits2);
      bars[j].l = roundTo(bars[j].l * factor, digits2);
      bars[j].c = roundTo(bars[j].c * factor, digits2);
    }
    var last = bars[bars.length - 1];
    last.c = roundTo(q.price, digits2);
    last.h = Math.max(last.h, last.c);
    last.l = Math.min(last.l, last.c);
    return bars;
  }

  // -------------------------------------------------------------- mock state

  var state = null;
  var seq = 1;

  function newAccount(options) {
    var id = options.id || ('acc_' + bumpSeq());
    var capital = Number(options.initialCapital) || 1000000;
    var currency = options.baseCurrency || 'CNY';
    var cash = { CNY: 0, HKD: 0, USD: 0, USDT: 0 };
    cash[currency] = capital;
    return {
      id: id,
      name: options.name || ('账户 ' + id),
      baseCurrency: currency,
      initialCapital: capital,
      marginMode: options.marginMode === 'cross' ? 'cross' : 'isolated',
      settings: deepMerge(DEFAULT_SETTINGS, options.settings || {}),
      createdAt: nowISO(),
      cash: cash,
      positions: {},
      orders: [],
      trades: [],
      equityHistory: [{ t: nowISO(), equity: capital }],
      dayStartEquity: capital,
      dayKey: todayKey(),
      realizedPnl: 0,
      totalFees: 0,
      totalInterest: 0,
      liquidations: []
    };
  }

  function addSeedPosition(account, symbol, qty, avgCost, side, leverage) {
    var item = CATALOG_MAP[symbol];
    var lev = Number(leverage) || 1;
    var currency = CURRENCY[item.market];
    var notional = qty * avgCost;
    account.positions[symbol] = {
      symbol: symbol, market: item.market, name: item.name, currency: currency,
      side: side === 'short' ? 'short' : 'long',
      qty: qty, avgCost: avgCost, leverage: lev,
      margin: round2(notional / lev),
      debt: round2(notional * (1 - 1 / lev)),
      accruedInterest: 0, lastInterestAt: nowISO(),
      takeProfit: null, stopLoss: null,
      todayBuyQty: 0, todayBuyDate: '', openedAt: nowISO()
    };
  }

  function seedDemo() {
    var demo = newAccount({ id: 'acc_demo', name: '演示账户', initialCapital: 1000000 });
    demo.dayStartEquity = 1000000;
    demo.cash = { CNY: 320000, HKD: 12340, USD: 3200, USDT: 1500 };
    addSeedPosition(demo, 'cn:sh600519', 100, 1280.5);
    addSeedPosition(demo, 'cn:sz300750', 500, 238.2);
    addSeedPosition(demo, 'hk:hk00700', 200, 360.4);
    addSeedPosition(demo, 'us:usAAPL', 50, 215.8);
    addSeedPosition(demo, 'fx:EURUSD', 20000, 1.0720);
    addSeedPosition(demo, 'crypto:BTCUSDT', 0.15, 62500);
    // Demo positions represent overnight holdings: today P&L uses prevClose.
    var seedOpenedAt = isoCN(Date.now() - 26 * 3600 * 1000);
    Object.keys(demo.positions).forEach(function (symbol) {
      demo.positions[symbol].openedAt = seedOpenedAt;
    });

    var old = Date.now() - 26 * 3600 * 1000;
    demo.trades = [
      { id: 'trd_seed1', orderId: 'ord_seed1', symbol: 'cn:sz300750', market: 'cn', name: '宁德时代', side: 'sell', qty: 200, price: 248.6, fees: 12.43, realizedPnl: 2067.57, t: isoCN(old) },
      { id: 'trd_seed2', orderId: 'ord_seed2', symbol: 'cn:sh601318', market: 'cn', name: '中国平安', side: 'sell', qty: 500, price: 50.2, fees: 15.13, realizedPnl: -512.63, t: isoCN(old - 3 * 3600 * 1000) },
      { id: 'trd_seed3', orderId: 'ord_seed3', symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', side: 'buy', qty: 100, price: 1280.5, fees: 32.14, realizedPnl: 0, t: isoCN(old - 8 * 3600 * 1000) },
      { id: 'trd_seed4', orderId: 'ord_seed4', symbol: 'us:usNVDA', market: 'us', name: '英伟达', side: 'sell', qty: 30, price: 130.2, fees: 1.15, realizedPnl: 1340.35, t: isoCN(old - 26 * 3600 * 1000) }
    ];
    demo.totalFees = round2(demo.trades.reduce(function (sum, t) { return sum + t.fees; }, 0));
    demo.orders = [
      { id: 'ord_seed5', symbol: 'us:usNVDA', market: 'us', name: '英伟达', side: 'buy', type: 'market', qty: 30, limitPrice: null, leverage: 1, close: false, takeProfit: null, stopLoss: null, status: 'filled', filledQty: 30, avgFillPrice: 126.42, fees: 1.15, createdAt: isoCN(old - 26 * 3600 * 1000), updatedAt: isoCN(old - 26 * 3600 * 1000), rejectCode: null, rejectMessage: null, fills: [] },
      { id: 'ord_seed6', symbol: 'hk:hk09988', market: 'hk', name: '阿里巴巴-W', side: 'buy', type: 'limit', qty: 100, limitPrice: 70, leverage: 1, close: false, takeProfit: null, stopLoss: null, status: 'cancelled', filledQty: 0, avgFillPrice: null, fees: 0, createdAt: isoCN(old - 40 * 3600 * 1000), updatedAt: isoCN(old - 39 * 3600 * 1000), rejectCode: null, rejectMessage: null, fills: [] },
      { id: 'ord_seed7', symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', side: 'buy', type: 'limit', qty: 100, limitPrice: 1290, leverage: 1, close: false, takeProfit: null, stopLoss: null, status: 'open', filledQty: 0, avgFillPrice: null, fees: 0, createdAt: isoCN(Date.now() - 20 * 60 * 1000), updatedAt: isoCN(Date.now() - 20 * 60 * 1000), rejectCode: null, rejectMessage: null, fills: [] },
      { id: 'ord_seed8', symbol: 'crypto:ETHUSDT', market: 'crypto', name: '以太坊', side: 'sell', type: 'limit', qty: 0.5, limitPrice: 2700, leverage: 1, close: false, takeProfit: null, stopLoss: null, status: 'open', filledQty: 0, avgFillPrice: null, fees: 0, createdAt: isoCN(Date.now() - 12 * 60 * 1000), updatedAt: isoCN(Date.now() - 12 * 60 * 1000), rejectCode: null, rejectMessage: null, fills: [] }
    ];

    var small = newAccount({ id: 'acc_small', name: '小账户', initialCapital: 100000 });
    return { demo: demo, small: small };
  }

  function initState() {
    var stored = null;
    try { stored = sessionStorage.getItem(STORAGE_KEY); } catch (e) { stored = null; }
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        if (parsed && parsed.version === 1 && parsed.accounts) {
          state = parsed;
          state.watchlist = (Array.isArray(state.watchlist) && state.watchlist.length
            ? state.watchlist
            : DEFAULT_WATCHLIST.slice())
            .map(normalizeSymbol)
            .filter(function (s) { return CATALOG_MAP[s]; });
          seq = Math.max(1, Number(state.seq) || 1);
          Object.keys(state.accounts).forEach(function (id) {
            var acc = state.accounts[id];
            if (!acc.marginMode) acc.marginMode = 'isolated';
            acc.settings = deepMerge(DEFAULT_SETTINGS, acc.settings || {});
            if (!Array.isArray(acc.liquidations)) acc.liquidations = [];
            if (acc.totalInterest == null) acc.totalInterest = 0;
            Object.keys(acc.positions || {}).forEach(function (symbol) {
              var pos = acc.positions[symbol];
              if (!pos.side) pos.side = 'long';
              if (!pos.leverage) pos.leverage = 1;
              if (pos.margin == null) pos.margin = round2(pos.qty * pos.avgCost / pos.leverage);
              if (pos.debt == null) pos.debt = round2(pos.qty * pos.avgCost * (1 - 1 / pos.leverage));
              if (pos.accruedInterest == null) pos.accruedInterest = 0;
              if (!pos.lastInterestAt) pos.lastInterestAt = nowISO();
              if (pos.takeProfit == null) pos.takeProfit = null;
              if (pos.stopLoss == null) pos.stopLoss = null;
            });
            (acc.orders || []).forEach(function (order) {
              if (order.leverage == null) order.leverage = 1;
              if (order.close == null) order.close = false;
            });
          });
          return;
        }
      } catch (e) { /* fall through to fresh state */ }
    }
    state = { version: 1, accounts: {}, watchlist: DEFAULT_WATCHLIST.slice(), seq: 1 };
    if (SEED) {
      var seeds = seedDemo();
      state.accounts[seeds.demo.id] = seeds.demo;
      state.accounts[seeds.small.id] = seeds.small;
      state.seq = seq = 3;
      saveState();
    }
  }

  function bumpSeq() {
    seq += 1;
    if (state) state.seq = seq;
    return seq;
  }

  function saveState() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage full is not fatal */ }
  }

  function getAccount(id) {
    var account = state.accounts[id];
    if (!account) fail(404, 'ACCOUNT_NOT_FOUND', '账户不存在：' + id);
    return account;
  }

  // ------------------------------------------------------- v3 account params

  function deepMerge(base, patch) {
    var out = clone(base || {});
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach(function (key) {
      var value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = deepMerge(out[key] || {}, value);
      } else {
        out[key] = clone(value);
      }
    });
    return out;
  }

  function accountSettings(account) {
    return deepMerge(DEFAULT_SETTINGS, account.settings || {});
  }

  function accountEffective(account) {
    var settings = accountSettings(account);
    var multiplier = Number(settings.leverageMultiplier);
    if (!isFinite(multiplier)) multiplier = 1;
    var leverage = {};
    MARKET_ORDER.forEach(function (market) {
      leverage[market] = market === 'cn' ? 1
        : Math.min(LEVERAGE_CEILING[market], Math.max(1, Math.round(BASE_LEVERAGE[market] * multiplier)));
    });
    return {
      leverage: leverage,
      fees: settings.fees,
      slippageBps: settings.slippageBps,
      margin: settings.margin,
      autoConvert: settings.autoConvert !== false,
      fxConvertSpread: Number(settings.fxConvertSpread)
    };
  }

  function effectiveFeeConfig(account, market) {
    var eff = accountEffective(account);
    return (eff.fees && eff.fees[market]) || FEES[market] || {};
  }

  function effectiveSlippage(account, market) {
    var eff = accountEffective(account);
    var value = eff.slippageBps ? Number(eff.slippageBps[market]) : NaN;
    return isFinite(value) ? value : (SLIPPAGE_BPS[market] || 0);
  }

  function effectiveMmr(account, market) {
    var eff = accountEffective(account);
    var value = eff.margin && eff.margin.mmr ? Number(eff.margin.mmr[market]) : NaN;
    if (!isFinite(value)) value = MARGIN.mmr[market] != null ? MARGIN.mmr[market] : 0.1;
    return value;
  }

  function effectiveInterest(account, market) {
    var eff = accountEffective(account);
    var value = eff.margin && eff.margin.interestAnnual ? Number(eff.margin.interestAnnual[market]) : NaN;
    return isFinite(value) ? value : (MARGIN.interestAnnual[market] || 0);
  }

  function effectiveLiqFee(account, market) {
    var eff = accountEffective(account);
    var value = eff.margin && eff.margin.liquidationFeeRate ? Number(eff.margin.liquidationFeeRate[market]) : NaN;
    return isFinite(value) ? value : (MARGIN.liquidationFeeRate[market] || 0);
  }

  function hasOpenRisk(account) {
    var hasPositions = Object.keys(account.positions || {}).some(function (key) {
      return account.positions[key] && account.positions[key].qty > 1e-9;
    });
    var hasOrders = (account.orders || []).some(function (order) { return order.status === 'open'; });
    return hasPositions || hasOrders;
  }

  function checkSettingRange(value, range, label) {
    if (!isFinite(value)) fail(400, 'SETTINGS_INVALID', label + ' 不是有效数字');
    if (range && (value < range[0] - 1e-12 || value > range[1] + 1e-12)) {
      fail(400, 'SETTINGS_INVALID', label + ' 超出范围 [' + range[0] + ', ' + range[1] + ']');
    }
  }

  function validateAccountSettings(input) {
    var settings = deepMerge(DEFAULT_SETTINGS, input || {});
    checkSettingRange(Number(settings.leverageMultiplier), SETTINGS_RANGES.leverageMultiplier, '杠杆上限倍率');
    Object.keys(SETTINGS_RANGES.fees).forEach(function (key) {
      var feeKeys = {
        commissionRate: ['cn', 'hk', 'crypto'], commissionMin: ['cn', 'hk', 'us'],
        stampDutyRate: ['cn', 'hk'], transferFeeRate: ['cn'], exchangeFeeRate: ['hk'],
        settlementFeeRate: ['hk'], perShare: ['us'], secFeeRate: ['us'], spreadBps: ['fx']
      }[key] || [];
      feeKeys.forEach(function (market) {
        if (settings.fees && settings.fees[market] && settings.fees[market][key] != null) {
          checkSettingRange(Number(settings.fees[market][key]), SETTINGS_RANGES.fees[key], market + ' ' + key);
        }
      });
    });
    MARKET_ORDER.forEach(function (market) {
      if (settings.slippageBps && settings.slippageBps[market] != null) {
        checkSettingRange(Number(settings.slippageBps[market]), SETTINGS_RANGES.slippageBps, market + ' 滑点');
      }
    });
    ['hk', 'us', 'fx', 'crypto'].forEach(function (market) {
      var mmr = settings.margin && settings.margin.mmr ? Number(settings.margin.mmr[market]) : NaN;
      checkSettingRange(mmr, SETTINGS_RANGES.margin.mmr[market], market + ' mmr');
      var lev = Math.min(LEVERAGE_CEILING[market], Math.max(1, Math.round(BASE_LEVERAGE[market] * Number(settings.leverageMultiplier))));
      if (mmr > 0.9 / lev + 1e-12) fail(400, 'SETTINGS_INVALID', market + ' mmr 需 ≤ 0.9 / ' + lev + 'x');
      checkSettingRange(Number(settings.margin.interestAnnual[market]), SETTINGS_RANGES.margin.interestAnnual, market + ' 利率');
      checkSettingRange(Number(settings.margin.liquidationFeeRate[market]), SETTINGS_RANGES.margin.liquidationFeeRate, market + ' 强平费');
    });
    checkSettingRange(Number(settings.fxConvertSpread), SETTINGS_RANGES.fxConvertSpread, '换汇成本');
    return settings;
  }

  function settingsMetaPayload() {
    return {
      markets: clone(SETTINGS_MARKETS),
      ranges: clone(SETTINGS_RANGES),
      presets: clone(SETTINGS_PRESETS),
      multiplier: { range: [0.1, 2], default: 1, quick: [0.1, 0.25, 0.5, 1, 2] },
      defaults: {
        settings: clone(DEFAULT_SETTINGS),
        initialCapital: 1000000,
        baseCurrency: 'CNY'
      }
    };
  }

  // Buying power per currency: native cash plus base-currency CNY converted at
  // the live rate minus the 0.3% conversion cost.
  function buyingPowerFor(account, currency) {
    var native = Number(account.cash[currency]) || 0;
    if (currency === 'CNY') return round2(native);
    var eff = accountEffective(account);
    if (eff.autoConvert === false) return round2(native);
    var rate = CNY_PER[currency] || 1;
    var spread = isFinite(eff.fxConvertSpread) ? eff.fxConvertSpread : FX_CONVERT_SPREAD;
    var converted = (Number(account.cash.CNY) || 0) * (1 - spread) / rate;
    return round2(native + Math.max(0, converted));
  }

  function buyingPowerAll(account) {
    var out = {};
    ['CNY', 'HKD', 'USD', 'USDT'].forEach(function (currency) {
      out[currency] = buyingPowerFor(account, currency);
    });
    return out;
  }

  function availableQty(account, pos) {
    if (!pos) return 0;
    if (pos.market === 'cn' && pos.todayBuyDate === todayKey()) {
      return Math.max(0, roundTo(pos.qty - (pos.todayBuyQty || 0), 8));
    }
    return pos.qty;
  }

  function sortSymbols(a, b) {
    return MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market) || a.symbol.localeCompare(b.symbol);
  }

  // ------------------------------------------------------------ v2 margin math

  function unrealizedOf(pos, price) {
    if (!pos) return 0;
    return (pos.side === 'short' ? pos.avgCost - price : price - pos.avgCost) * pos.qty;
  }

  function maintenanceOf(pos, price, account) {
    if (!pos || (Number(pos.leverage) || 1) <= 1 || pos.market === 'cn') return 0;
    var mmr = account ? effectiveMmr(account, pos.market) : (MARGIN.mmr[pos.market] != null ? MARGIN.mmr[pos.market] : 0.1);
    return price * pos.qty * mmr;
  }

  function liqPriceOf(pos, mode, account) {
    if (!pos || (Number(pos.leverage) || 1) <= 1 || pos.market === 'cn') return null;
    if (mode === 'cross') return null;
    var mmr = account ? effectiveMmr(account, pos.market) : (MARGIN.mmr[pos.market] != null ? MARGIN.mmr[pos.market] : 0.1);
    var margin = Number(pos.margin) || 0;
    if (pos.side === 'short') {
      return roundPrice(pos.symbol, (pos.avgCost * pos.qty + margin) / (pos.qty * (1 + mmr)));
    }
    return roundPrice(pos.symbol, (pos.avgCost * pos.qty - margin) / (pos.qty * (1 - mmr)));
  }

  function accrueInterest(account) {
    var now = Date.now();
    Object.keys(account.positions || {}).forEach(function (symbol) {
      var pos = account.positions[symbol];
      if (!pos || (Number(pos.leverage) || 1) <= 1) return;
      var annual = effectiveInterest(account, pos.market);
      if (!annual || !pos.debt) return;
      var last = Date.parse(pos.lastInterestAt) || now;
      var hours = Math.max(0, now - last) / 3600000;
      if (hours <= 0) return;
      var delta = pos.debt * annual / 8760 * hours;
      if (delta <= 0) return;
      pos.accruedInterest = round2((pos.accruedInterest || 0) + delta);
      account.totalInterest = round2((account.totalInterest || 0) + delta);
      pos.lastInterestAt = nowISO();
      account._dirty = true;
    });
  }

  function equityCny(account, fxRates) {
    var cashCny = 0;
    Object.keys(account.cash).forEach(function (currency) {
      cashCny += (Number(account.cash[currency]) || 0) * (fxRates[currency] || 1);
    });
    var total = cashCny;
    Object.keys(account.positions || {}).forEach(function (symbol) {
      var pos = account.positions[symbol];
      if (!pos || pos.qty <= 1e-9) return;
      var q = quoteState(symbol) || { price: pos.avgCost };
      var contrib = (Number(pos.margin) || 0) + unrealizedOf(pos, q.price) - (Number(pos.accruedInterest) || 0);
      total += contrib * (fxRates[pos.currency] || 1);
    });
    return total;
  }

  function sumMarginCny(account, fxRates, cross) {
    var total = 0;
    Object.keys(account.positions || {}).forEach(function (symbol) {
      var pos = account.positions[symbol];
      if (!pos || pos.qty <= 1e-9) return;
      var q = quoteState(symbol) || { price: pos.avgCost };
      var value = cross ? maintenanceOf(pos, q.price, account) : (Number(pos.margin) || 0);
      total += value * (fxRates[pos.currency] || 1);
    });
    return total;
  }

  function sumInterestCny(account, fxRates) {
    var total = 0;
    Object.keys(account.positions || {}).forEach(function (symbol) {
      var pos = account.positions[symbol];
      if (!pos) return;
      total += (Number(pos.accruedInterest) || 0) * (fxRates[pos.currency] || 1);
    });
    return total;
  }

  function marginAvailableCny(account, fxRates) {
    var equity = equityCny(account, fxRates);
    var used = sumMarginCny(account, fxRates, account.marginMode === 'cross');
    var interest = sumInterestCny(account, fxRates);
    return round2(equity - used - interest);
  }

  function debitCash(account, currency, amount) {
    if (!(amount > 0)) return true;
    var eff = accountEffective(account);
    var native = Number(account.cash[currency]) || 0;
    if (native + 1e-9 >= amount) {
      account.cash[currency] = round2(native - amount);
      return true;
    }
    if (currency === 'CNY' || eff.autoConvert === false) return false;
    var shortfall = amount - native;
    var convertAmount = Math.ceil(shortfall * 100) / 100 + 0.01;
    var spread = isFinite(eff.fxConvertSpread) ? eff.fxConvertSpread : FX_CONVERT_SPREAD;
    var needCny = convertAmount * (CNY_PER[currency] || 1) / (1 - spread);
    if ((Number(account.cash.CNY) || 0) + 1e-9 < needCny) return false;
    account.cash.CNY = round2(account.cash.CNY - needCny);
    account.cash[currency] = round2(native + convertAmount - amount);
    return true;
  }

  function creditCash(account, currency, amount) {
    account.cash[currency] = round2((Number(account.cash[currency]) || 0) + amount);
  }

  function recordLiquidation(account, pos, price, reason, pnl, fees) {
    var entry = {
      t: nowISO(), symbol: pos.symbol, name: pos.name,
      side: pos.side, qty: pos.qty, price: price,
      pnl: round2(pnl), fees: round2(fees), reason: reason
    };
    account.liquidations.push(entry);
    if (account.liquidations.length > 100) account.liquidations.splice(0, account.liquidations.length - 100);
    account._dirty = true;
  }

  function forceClosePosition(account, symbol, price, reason) {
    var pos = account.positions[symbol];
    if (!pos) return;
    var closingSide = pos.side === 'long' ? 'sell' : 'buy';
    var fees = calcFees(pos.market, closingSide, pos.qty, price, effectiveFeeConfig(account, pos.market)).total;
    var liqFee = reason === 'LIQUIDATION'
      ? effectiveLiqFee(account, pos.market) * price * pos.qty
      : 0;
    var interest = Number(pos.accruedInterest) || 0;
    var gross = unrealizedOf(pos, price);
    var realized = round2(gross - fees - liqFee - interest);
    creditCash(account, pos.currency, (Number(pos.margin) || 0) + realized);
    account.realizedPnl = round2((account.realizedPnl || 0) + realized);
    account.totalFees = round2((account.totalFees || 0) + fees + liqFee);
    account.trades.push({
      id: 'trd_' + bumpSeq(), orderId: null, symbol: symbol, market: pos.market, name: pos.name,
      side: closingSide, qty: pos.qty, price: price, fees: round2(fees + liqFee),
      realizedPnl: realized, t: nowISO()
    });
    recordLiquidation(account, pos, price, reason, realized, fees + liqFee);
    delete account.positions[symbol];
    account._dirty = true;
  }

  function checkRisk(account) {
    var fxRates = CNY_PER;
    var mode = account.marginMode === 'cross' ? 'cross' : 'isolated';
    // Take-profit / stop-loss first.
    Object.keys(account.positions).forEach(function (symbol) {
      var pos = account.positions[symbol];
      if (!pos || pos.qty <= 0 || pos._freezeRisk) return;
      var q = quoteState(symbol);
      if (!q) return;
      var reason = null;
      if (pos.takeProfit != null) {
        if (pos.side === 'short' ? q.price <= pos.takeProfit : q.price >= pos.takeProfit) reason = 'TAKE_PROFIT';
      }
      if (!reason && pos.stopLoss != null) {
        if (pos.side === 'short' ? q.price >= pos.stopLoss : q.price <= pos.stopLoss) reason = 'STOP_LOSS';
      }
      if (reason) forceClosePosition(account, symbol, q.price, reason);
    });
    if (mode === 'isolated') {
      Object.keys(account.positions).forEach(function (symbol) {
        var pos = account.positions[symbol];
        if (!pos || pos._freezeRisk) return;
        var q = quoteState(symbol);
        if (!q) return;
        var posEquity = (Number(pos.margin) || 0) + unrealizedOf(pos, q.price) - (Number(pos.accruedInterest) || 0);
        if (posEquity <= maintenanceOf(pos, q.price, account)) forceClosePosition(account, symbol, q.price, 'LIQUIDATION');
      });
    } else {
      var guard = 0;
      while (guard < 10) {
        guard += 1;
        var equity = equityCny(account, fxRates);
        var maintenanceTotal = 0;
        Object.keys(account.positions).forEach(function (symbol) {
          var pos = account.positions[symbol];
          if (!pos) return;
          var q = quoteState(symbol);
          maintenanceTotal += maintenanceOf(pos, q ? q.price : pos.avgCost, account) * (fxRates[pos.currency] || 1);
        });
        if (equity > maintenanceTotal + 1e-9) break;
        var worstSymbol = null;
        var worstPnl = Infinity;
        Object.keys(account.positions).forEach(function (symbol) {
          var pos = account.positions[symbol];
          var q = quoteState(symbol);
          if (!pos || !q) return;
          var pnl = unrealizedOf(pos, q.price);
          if (pnl < worstPnl) { worstPnl = pnl; worstSymbol = symbol; }
        });
        if (!worstSymbol) break;
        var worstQuote = quoteState(worstSymbol);
        forceClosePosition(account, worstSymbol, worstQuote.price, 'LIQUIDATION');
      }
    }
  }

  // --------------------------------------------------------------- order flow

  function validateOrder(account, req) {
    var item = CATALOG_MAP[req.symbol];
    if (!item) fail(400, 'UNKNOWN_SYMBOL', '未知标的：' + req.symbol);
    if (item.code === 'sh000001') fail(400, 'NOT_TRADEABLE', '指数仅用于展示，不可交易');
    var market = item.market;
    var eff = accountEffective(account);
    var maxLev = eff.leverage[market] || 1;
    var close = !!req.close;
    var leverage = Number(req.leverage);
    if (!Number.isFinite(leverage) || leverage <= 0) leverage = 1;
    if (market === 'cn' && leverage > 1) fail(400, 'LEVERAGE_NOT_ALLOWED', 'A股不支持杠杆（恒 1x）');
    if (leverage > maxLev + 1e-9) fail(400, 'LEVERAGE_NOT_ALLOWED', '超过当前账户杠杆上限 ' + maxLev + 'x');
    var side = req.side === 'sell' ? 'sell' : 'buy';
    var pos = account.positions[req.symbol];

    var qty = Number(req.qty);
    if (close && (!Number.isFinite(qty) || qty <= 0) && pos) qty = pos.qty;
    if (!Number.isFinite(qty) || qty <= 0) fail(400, 'QTY_INVALID', '数量必须大于 0');
    var lot = market === 'cn' ? 100 : market === 'hk' ? (item.lotSize || 100) : market === 'fx' ? 0.01 : market === 'crypto' ? 0.0001 : 1;
    var rounded = roundTo(qty, 8);
    if (market === 'cn' && Math.round(qty) % 100 !== 0) fail(400, 'LOT_SIZE', 'A股数量必须为 100 股的整数倍');
    if (market === 'hk' && Math.round(qty) % lot !== 0) fail(400, 'LOT_SIZE', '港股数量必须为每手 ' + lot + ' 股的整数倍');
    if (market === 'us' && !Number.isInteger(qty)) fail(400, 'LOT_SIZE', '美股数量必须为整数股');
    if (market === 'fx' && Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) fail(400, 'LOT_SIZE', '外汇数量最多支持 2 位小数');
    if (market === 'crypto' && Math.abs(qty * 10000 - Math.round(qty * 10000)) > 1e-6) fail(400, 'LOT_SIZE', '加密数量最多支持 4 位小数');
    if (rounded < lot) fail(400, 'QTY_INVALID', '数量低于最小交易单位');

    var type = req.type === 'limit' ? 'limit' : 'market';
    var limitPrice = null;
    if (type === 'limit') {
      limitPrice = Number(req.limitPrice);
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) fail(400, 'PRICE_INVALID', '限价单必须填写有效的限价');
    }

    if (close) {
      if (!pos) fail(400, 'INSUFFICIENT_POSITION', '当前没有可平仓的持仓');
      if ((pos.side === 'long' && side !== 'sell') || (pos.side === 'short' && side !== 'buy')) {
        fail(400, 'POSITION_CONFLICT', '平仓方向与持仓方向相反');
      }
      if (rounded > pos.qty + 1e-9) fail(400, 'QTY_INVALID', '平仓数量不能超过持仓量');
    } else if (pos) {
      var sameSide = (pos.side === 'long' && side === 'buy') || (pos.side === 'short' && side === 'sell');
      if (!sameSide) fail(400, 'POSITION_CONFLICT', '已有反向持仓，请先平仓或反手');
      if (Math.abs(leverage - (Number(pos.leverage) || 1)) > 1e-9) {
        fail(400, 'LEVERAGE_MISMATCH', '加仓杠杆需与现有持仓一致（当前 ' + (pos.leverage || 1) + 'x）');
      }
    } else if (side === 'sell') {
      if (!ALLOW_SHORT[market]) fail(400, 'SHORT_NOT_ALLOWED', '该市场不支持做空');
      if (leverage <= 1) fail(400, 'INSUFFICIENT_POSITION', '没有持仓时只能通过杠杆做空');
    }

    var q = quoteState(req.symbol);
    var estimatePrice = type === 'limit' ? limitPrice : marketFillPrice(req.symbol, side, account);
    var extra = extraFor(q);
    if (market === 'cn' && extra.limitUp != null) {
      var checkPrice = type === 'limit' ? limitPrice : estimatePrice;
      if (checkPrice > extra.limitUp + 1e-9 || checkPrice < extra.limitDown - 1e-9) {
        fail(400, 'PRICE_LIMIT', '委托价超出涨跌停范围 [' + extra.limitDown + ', ' + extra.limitUp + ']');
      }
      if (type === 'limit' && side === 'buy' && limitPrice >= extra.limitUp) fail(400, 'NO_LIQUIDITY', '涨停价没有可成交卖盘');
      if (type === 'limit' && side === 'sell' && limitPrice <= extra.limitDown) fail(400, 'NO_LIQUIDITY', '跌停价没有可成交买盘');
    }

    if (!close) {
      var tp = req.takeProfit != null ? Number(req.takeProfit) : null;
      var sl = req.stopLoss != null ? Number(req.stopLoss) : null;
      var wantSide = pos ? pos.side : (side === 'buy' ? 'long' : 'short');
      if (tp != null && isFinite(tp)) {
        if (wantSide === 'long' ? tp <= estimatePrice : tp >= estimatePrice) fail(400, 'PROTECT_PRICE_INVALID', '止盈价方向不合理');
      }
      if (sl != null && isFinite(sl)) {
        if (wantSide === 'long' ? sl >= estimatePrice : sl <= estimatePrice) fail(400, 'PROTECT_PRICE_INVALID', '止损价方向不合理');
      }
    }

    if (!close && type === 'market') {
      var fees = calcFees(market, side, qty, estimatePrice, effectiveFeeConfig(account, market)).total;
      var margin = (qty * estimatePrice) / leverage;
      var currency = CURRENCY[market];
      if (leverage > 1) {
        var needCny = (margin + fees) * (CNY_PER[currency] || 1);
        if (needCny > marginAvailableCny(account, CNY_PER) + 1e-6) {
          fail(400, 'INSUFFICIENT_MARGIN', '可用保证金不足，需要约 CNY ' + needCny.toFixed(2));
        }
      } else {
        var need = qty * estimatePrice + fees;
        if (buyingPowerFor(account, currency) + 1e-9 < need) {
          fail(400, 'INSUFFICIENT_CASH', '可用 ' + currency + ' 资金不足（含自动换汇）');
        }
      }
    }

    return {
      item: item, qty: rounded, type: type, limitPrice: limitPrice,
      side: side, estimatePrice: estimatePrice, quote: q,
      leverage: leverage, close: close,
      takeProfit: req.takeProfit != null && isFinite(Number(req.takeProfit)) ? Number(req.takeProfit) : null,
      stopLoss: req.stopLoss != null && isFinite(Number(req.stopLoss)) ? Number(req.stopLoss) : null
    };
  }

  function newOrderId() { return 'ord_' + bumpSeq(); }

  function executeFill(account, order, fillPrice) {
    var market = order.market;
    var currency = CURRENCY[market];
    var pos = account.positions[order.symbol];
    var trade;
    if (order.close) {
      if (!pos) return { error: 'INSUFFICIENT_POSITION' };
      if (order.qty > pos.qty + 1e-9) return { error: 'INSUFFICIENT_POSITION' };
      var fees = calcFees(market, order.side, order.qty, fillPrice, effectiveFeeConfig(account, market)).total;
      var ratio = order.qty / pos.qty;
      var marginShare = (Number(pos.margin) || 0) * ratio;
      var interestShare = (Number(pos.accruedInterest) || 0) * ratio;
      var gross = unrealizedOf(pos, fillPrice) * ratio;
      var realized = round2(gross - fees - interestShare);
      creditCash(account, currency, marginShare + realized);
      account.realizedPnl = round2((account.realizedPnl || 0) + realized);
      pos.qty = roundTo(pos.qty - order.qty, 8);
      pos.margin = round2((Number(pos.margin) || 0) - marginShare);
      pos.accruedInterest = round2((Number(pos.accruedInterest) || 0) - interestShare);
      pos.debt = round2(pos.qty * pos.avgCost * (1 - 1 / (Number(pos.leverage) || 1)));
      if (pos.qty <= 1e-9) delete account.positions[order.symbol];
      trade = {
        id: 'trd_' + bumpSeq(), orderId: order.id, symbol: order.symbol, market: market,
        name: order.name, side: order.side, qty: order.qty, price: fillPrice,
        fees: fees, realizedPnl: realized, t: nowISO()
      };
      account.totalFees = round2((account.totalFees || 0) + fees);
    } else {
      var lev = Number(order.leverage) || 1;
      var notional = order.qty * fillPrice;
      var feeAmount = calcFees(market, order.side, order.qty, fillPrice, effectiveFeeConfig(account, market)).total;
      var marginAmount = notional / lev;
      var targetSide = pos ? pos.side : (order.side === 'buy' ? 'long' : 'short');
      if (lev > 1) {
        if (!debitCash(account, currency, marginAmount + feeAmount)) return { error: 'INSUFFICIENT_MARGIN' };
      } else {
        if (!debitCash(account, currency, notional + feeAmount)) return { error: 'INSUFFICIENT_CASH' };
      }
      if (!pos) {
        pos = {
          symbol: order.symbol, market: market, name: order.name, currency: currency,
          side: targetSide, qty: 0, avgCost: 0, leverage: lev,
          margin: 0, debt: 0, accruedInterest: 0, lastInterestAt: nowISO(),
          takeProfit: order.takeProfit != null ? order.takeProfit : null,
          stopLoss: order.stopLoss != null ? order.stopLoss : null,
          todayBuyQty: 0, todayBuyDate: '', openedAt: nowISO()
        };
        account.positions[order.symbol] = pos;
      }
      var newQty = roundTo(pos.qty + order.qty, 8);
      pos.avgCost = roundTo((pos.avgCost * pos.qty + fillPrice * order.qty) / newQty, 8);
      pos.qty = newQty;
      pos.leverage = lev;
      pos.margin = round2((Number(pos.margin) || 0) + marginAmount);
      pos.debt = round2((Number(pos.debt) || 0) + notional * (1 - 1 / lev));
      if (order.takeProfit != null) pos.takeProfit = order.takeProfit;
      if (order.stopLoss != null) pos.stopLoss = order.stopLoss;
      if (market === 'cn' && targetSide === 'long') {
        var today = todayKey();
        var carried = pos.todayBuyDate === today ? (Number(pos.todayBuyQty) || 0) : 0;
        pos.todayBuyQty = roundTo(carried + order.qty, 8);
        pos.todayBuyDate = today;
      }
      trade = {
        id: 'trd_' + bumpSeq(), orderId: order.id, symbol: order.symbol, market: market,
        name: order.name, side: order.side, qty: order.qty, price: fillPrice,
        fees: feeAmount, realizedPnl: 0, t: nowISO()
      };
      account.totalFees = round2((account.totalFees || 0) + feeAmount);
    }
    order.status = 'filled';
    order.filledQty = order.qty;
    order.avgFillPrice = fillPrice;
    order.fees = order.close ? round2(trade.fees) : round2(trade.fees);
    order.updatedAt = nowISO();
    order.fills = order.fills || [];
    order.fills.push({ t: nowISO(), qty: order.qty, price: fillPrice, fees: order.fees });
    account.trades.push(trade);
    return { trade: trade };
  }

  function placeOrder(account, req) {
    var validated = validateOrder(account, req);
    var order = {
      id: newOrderId(), symbol: req.symbol, market: validated.item.market, name: validated.item.name,
      side: validated.side, type: validated.type, qty: validated.qty,
      limitPrice: validated.limitPrice, leverage: validated.leverage, close: validated.close,
      takeProfit: validated.takeProfit, stopLoss: validated.stopLoss,
      status: 'open', filledQty: 0,
      avgFillPrice: null, fees: 0, createdAt: nowISO(), updatedAt: nowISO(),
      rejectCode: null, rejectMessage: null, fills: []
    };
    var fillPrice = null;
    if (order.type === 'market') {
      fillPrice = marketFillPrice(order.symbol, order.side, account);
    } else {
      var q = quoteState(order.symbol);
      var marketable = order.side === 'buy' ? q.price <= order.limitPrice : q.price >= order.limitPrice;
      if (marketable) {
        fillPrice = order.side === 'buy'
          ? Math.min(order.limitPrice, q.price)
          : Math.max(order.limitPrice, q.price);
      }
    }
    if (fillPrice != null) {
      var result = executeFill(account, order, fillPrice);
      if (result.error) {
        var message = result.error === 'INSUFFICIENT_MARGIN' ? '可用保证金不足'
          : result.error === 'INSUFFICIENT_CASH' ? '可用现金不足'
            : result.error === 'INSUFFICIENT_POSITION' ? '持仓不足' : '下单失败';
        fail(400, result.error, message);
      }
      account.orders.push(order);
      account._dirty = true;
      saveState();
      return { order: clone(order), fill: clone(result.trade) };
    }
    account.orders.push(order);
    account._dirty = true;
    saveState();
    return { order: clone(order), fill: null };
  }

  function tickAccount(account) {
    accrueInterest(account);
    var changed = false;
    account.orders.forEach(function (order) {
      if (order.status !== 'open') return;
      var q = quoteState(order.symbol);
      if (!q) return;
      var marketable = order.side === 'buy' ? q.price <= order.limitPrice : q.price >= order.limitPrice;
      if (!marketable) return;
      var fillPrice = order.side === 'buy'
        ? Math.min(order.limitPrice, q.price)
        : Math.max(order.limitPrice, q.price);
      if (order.close) {
        var pos = account.positions[order.symbol];
        if (!pos || order.qty > pos.qty + 1e-9) {
          order.status = 'cancelled';
          order.rejectCode = 'INSUFFICIENT_POSITION';
          order.rejectMessage = '持仓不足，挂单已撤销';
          order.updatedAt = nowISO();
          changed = true;
          return;
        }
      }
      var result = executeFill(account, order, fillPrice);
      if (result.error) {
        order.status = 'cancelled';
        order.rejectCode = result.error;
        order.rejectMessage = result.error === 'INSUFFICIENT_MARGIN' ? '保证金不足，挂单已撤销'
          : result.error === 'INSUFFICIENT_CASH' ? '现金不足，挂单已撤销'
            : '持仓不足，挂单已撤销';
        order.updatedAt = nowISO();
        changed = true;
        return;
      }
      changed = true;
    });
    checkRisk(account);
    if (changed || account._dirty) {
      delete account._dirty;
      saveState();
    }
  }

  function snapshot(account) {
    var fxRates = clone(CNY_PER);
    tickAccount(account);

    var cash = clone(account.cash);
    var cashCny = 0;
    Object.keys(cash).forEach(function (currency) { cashCny += cash[currency] * (fxRates[currency] || 1); });
    var byMarket = { cn: 0, hk: 0, us: 0, fx: 0, crypto: 0 };
    var positions = [];
    var positionsEquityCny = 0;
    var maintenanceCny = 0;
    Object.keys(account.positions).forEach(function (symbol) {
      var pos = account.positions[symbol];
      if (!pos || pos.qty <= 1e-9) return;
      var q = quoteState(symbol) || { price: pos.avgCost, prevClose: pos.avgCost };
      var lastPrice = q.price;
      var side = pos.side === 'short' ? 'short' : 'long';
      var leverage = Number(pos.leverage) || 1;
      var margin = Number(pos.margin) || 0;
      var accrued = Number(pos.accruedInterest) || 0;
      var notional = round2(pos.qty * lastPrice);
      var marketValue = notional;
      var unrealizedPnl = round2(unrealizedOf(pos, lastPrice));
      var maintenance = round2(maintenanceOf(pos, lastPrice, account));
      var posEquity = margin + unrealizedPnl - accrued;
      var riskRatio = posEquity > 1e-9 ? round2(maintenance / posEquity * 10000) / 10000 : 1;
      var equityContrib = posEquity * (fxRates[pos.currency] || 1);
      positionsEquityCny += equityContrib;
      maintenanceCny += maintenance * (fxRates[pos.currency] || 1);
      byMarket[pos.market] = round2((byMarket[pos.market] || 0) + notional * (fxRates[pos.currency] || 1));
      var todayBase = pos.openedAt && shanghaiDayKeyOf(pos.openedAt) === todayKey()
        ? pos.avgCost
        : (q.prevClose != null ? q.prevClose : lastPrice);
      var todayPnl = round2((side === 'short' ? todayBase - lastPrice : lastPrice - todayBase) * pos.qty);
      positions.push({
        symbol: symbol, market: pos.market, name: pos.name, currency: pos.currency,
        side: side, qty: roundTo(pos.qty, 8), availableQty: availableQty(account, pos),
        avgCost: roundTo(pos.avgCost, 8), lastPrice: lastPrice,
        leverage: leverage, margin: round2(margin),
        marketValue: marketValue, marketValueCny: round2(marketValue * (fxRates[pos.currency] || 1)),
        maintenanceMargin: maintenance,
        unrealizedPnl: unrealizedPnl,
        unrealizedPnlPct: pos.avgCost ? round2((unrealizedPnl / (pos.avgCost * pos.qty)) * 100) : 0,
        todayPnl: todayPnl,
        liqPrice: liqPriceOf(pos, account.marginMode, account),
        riskRatio: riskRatio,
        accruedInterest: round2(accrued),
        debt: round2(Number(pos.debt) || 0),
        takeProfit: pos.takeProfit != null ? pos.takeProfit : null,
        stopLoss: pos.stopLoss != null ? pos.stopLoss : null,
        openedAt: pos.openedAt
      });
    });
    positions.sort(sortSymbols);

    var equityTotal = round2(cashCny + positionsEquityCny);
    var dayStartEquity = account.dayStartEquity || account.initialCapital;
    var todayPnlTotal = round2(equityTotal - dayStartEquity);
    var totalPnl = round2(equityTotal - account.initialCapital);
    var mode = account.marginMode === 'cross' ? 'cross' : 'isolated';
    var marginUsedCny = sumMarginCny(account, fxRates, mode === 'cross');
    var interestCny = sumInterestCny(account, fxRates);
    var marginAvailable = round2(equityTotal - marginUsedCny - interestCny);
    var isolatedEquityCny = 0;
    positions.forEach(function (pos) {
      var posEquity = (Number(pos.margin) || 0) + unrealizedOf(pos, pos.lastPrice) - (Number(pos.accruedInterest) || 0);
      isolatedEquityCny += posEquity * (fxRates[pos.currency] || 1);
    });
    var accountRisk = positions.length
      ? (mode === 'cross'
        ? (equityTotal > 1e-9 ? maintenanceCny / equityTotal : 1)
        : (isolatedEquityCny > 1e-9 ? maintenanceCny / isolatedEquityCny : 1))
      : 0;

    var lastPoint = account.equityHistory[account.equityHistory.length - 1];
    var lastMs = lastPoint ? Date.parse(lastPoint.t) : 0;
    if (!lastMs || Date.now() - lastMs > 60000) {
      account.equityHistory.push({ t: nowISO(), equity: equityTotal });
      if (account.equityHistory.length > 2000) account.equityHistory.splice(0, account.equityHistory.length - 2000);
      saveState();
    }

    var openOrders = account.orders.filter(function (o) { return o.status === 'open'; })
      .sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); })
      .map(clone);

    return {
      account: {
        id: account.id, name: account.name, baseCurrency: account.baseCurrency,
        initialCapital: account.initialCapital, createdAt: account.createdAt,
        marginMode: mode,
        cash: clone(account.cash), dayStartEquity: dayStartEquity,
        dayKey: account.dayKey, realizedPnl: round2(account.realizedPnl),
        totalFees: round2(account.totalFees), totalInterest: round2(account.totalInterest || 0)
      },
      cash: cash,
      equity: { total: equityTotal, byMarket: byMarket },
      positions: positions,
      openOrders: openOrders,
      dayStartEquity: dayStartEquity,
      todayPnl: todayPnlTotal,
      totalPnl: totalPnl,
      totalPnlPct: account.initialCapital ? round2((totalPnl / account.initialCapital) * 100) : 0,
      fxRates: fxRates,
      buyingPower: buyingPowerAll(account),
      autoConvert: accountEffective(account).autoConvert,
      fxConvertSpread: accountEffective(account).fxConvertSpread,
      settings: accountSettings(account),
      effective: accountEffective(account),
      settingsLocked: hasOpenRisk(account),
      marginMode: mode,
      marginUsed: round2(marginUsedCny),
      marginAvailable: marginAvailable,
      maintenanceMargin: round2(maintenanceCny),
      riskRatio: round2(Math.max(0, accountRisk) * 10000) / 10000,
      totalInterest: round2(account.totalInterest || 0),
      liquidations: clone(account.liquidations || [])
    };
  }

  // ---------------------------------------------------------------- statistics

  function maxDrawdownOf(points) {
    var peak = 0;
    var maxDd = 0;
    points.forEach(function (p) {
      if (p.equity > peak) peak = p.equity;
      if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak * 100);
    });
    return round2(maxDd);
  }

  function sharpeOf(points) {
    if (points.length < 3) return 0;
    var rets = [];
    for (var i = 1; i < points.length; i++) {
      if (points[i - 1].equity > 0) rets.push(points[i].equity / points[i - 1].equity - 1);
    }
    if (!rets.length) return 0;
    var mean = rets.reduce(function (s, r) { return s + r; }, 0) / rets.length;
    var variance = rets.reduce(function (s, r) { return s + (r - mean) * (r - mean); }, 0) / rets.length;
    var sd = Math.sqrt(variance);
    if (sd === 0) return 0;
    return round2((mean / sd) * Math.sqrt(252));
  }

  function synthEquity(account, range) {
    var cfg = {
      '1d': { n: 79, step: 5 * 60 * 1000, noise: 0.0012 },
      '1w': { n: 7 * 24, step: 60 * 60 * 1000, noise: 0.0022 },
      '1m': { n: 120, step: 6 * 60 * 60 * 1000, noise: 0.0028 },
      'all': { n: 90, step: 24 * 60 * 60 * 1000, noise: 0.009 }
    }[range] || { n: 120, step: 6 * 60 * 60 * 1000, noise: 0.0028 };
    var snap = snapshot(account);
    var current = snap.equity.total;
    var start = account.initialCapital;
    var rand = mulberry32(hashStr(account.id + ':' + range + ':' + todayKey()));
    var nowWall = Date.now() + 8 * 3600 * 1000;
    var startWall = nowWall - (cfg.n - 1) * cfg.step;
    var points = [];
    var noise = 0;
    for (var i = 0; i < cfg.n; i++) {
      var ratio = i / (cfg.n - 1);
      var base = start + (current - start) * ratio;
      noise = noise * 0.92 + (rand() - 0.5) * current * cfg.noise;
      var equity = i === cfg.n - 1 ? current : round2(base + noise);
      points.push({ t: isoCN(startWall + i * cfg.step - 8 * 3600 * 1000), equity: equity });
    }
    return {
      points: points,
      stats: {
        startEquity: points[0].equity,
        endEquity: current,
        returnPct: account.initialCapital ? round2((current / account.initialCapital - 1) * 100) : 0,
        maxDrawdown: maxDrawdownOf(points),
        sharpe: sharpeOf(points)
      }
    };
  }

  function computeStats(account) {
    var trades = account.trades.slice();
    var sells = trades.filter(function (t) { return t.side === 'sell'; });
    var wins = sells.filter(function (t) { return (t.realizedPnl || 0) > 0; });
    var losses = sells.filter(function (t) { return (t.realizedPnl || 0) < 0; });
    var grossProfit = wins.reduce(function (s, t) { return s + t.realizedPnl; }, 0);
    var grossLoss = Math.abs(losses.reduce(function (s, t) { return s + t.realizedPnl; }, 0));
    var totalFees = trades.reduce(function (s, t) { return s + (t.fees || 0); }, 0);
    var series = synthEquity(account, 'all');
    var byMarket = {};
    var bySymbolMap = {};
    trades.forEach(function (t) {
      var entry = byMarket[t.market] || (byMarket[t.market] = { market: t.market, tradeCount: 0, realizedPnl: 0, fees: 0, wins: 0, sells: 0 });
      entry.tradeCount += 1;
      entry.fees = round2(entry.fees + (t.fees || 0));
      if (t.side === 'sell') {
        entry.sells += 1;
        entry.realizedPnl = round2(entry.realizedPnl + (t.realizedPnl || 0));
        if ((t.realizedPnl || 0) > 0) entry.wins += 1;
      }
      var sym = bySymbolMap[t.symbol] || (bySymbolMap[t.symbol] = { symbol: t.symbol, name: t.name, market: t.market, tradeCount: 0, realizedPnl: 0, fees: 0 });
      sym.tradeCount += 1;
      sym.fees = round2(sym.fees + (t.fees || 0));
      sym.realizedPnl = round2(sym.realizedPnl + (t.realizedPnl || 0));
    });
    Object.keys(byMarket).forEach(function (key) {
      var entry = byMarket[key];
      entry.winRate = entry.sells ? round2(entry.wins / entry.sells) : 0;
      delete entry.wins;
      delete entry.sells;
    });
    var bySymbol = Object.keys(bySymbolMap).map(function (key) { return bySymbolMap[key]; })
      .sort(function (a, b) { return Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl); })
      .slice(0, 20);

    return {
      tradeCount: trades.length,
      winRate: (wins.length + losses.length) ? round2(wins.length / (wins.length + losses.length)) : 0,
      profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? round2(grossProfit / 1) : 0),
      avgWin: wins.length ? round2(grossProfit / wins.length) : 0,
      avgLoss: losses.length ? round2(grossLoss / losses.length) : 0,
      maxDrawdown: series.stats.maxDrawdown,
      sharpe: series.stats.sharpe,
      totalFees: round2(totalFees),
      byMarket: byMarket,
      bySymbol: bySymbol
    };
  }

  // ------------------------------------------------------------------- router

  function accountSummary(account) {
    return {
      id: account.id, name: account.name, baseCurrency: account.baseCurrency,
      initialCapital: account.initialCapital, createdAt: account.createdAt,
      marginMode: account.marginMode || 'isolated'
    };
  }

  function route(path, opts) {
    var url = new URL(path, 'http://mock.local');
    var pathname = url.pathname;
    var method = String(opts.method || 'GET').toUpperCase();
    var body = parseBody(opts.body);
    var q = url.searchParams;
    var match;

    if (pathname === '/api/health') {
      return {
        ok: true, version: 'mock-1.0.0', uptimeSec: Math.round(performance.now() / 1000),
        serverTime: nowISO(),
        sources: [
          { source: 'tencent', ok: true, latencyMs: 38, message: '' },
          { source: 'binance', ok: true, latencyMs: 126, message: '' },
          { source: 'yahoo', ok: true, latencyMs: 245, message: '' }
        ]
      };
    }

    if (pathname === '/api/settings/meta') return settingsMetaPayload();

    if (pathname === '/api/backup/status') {
      var mockSize = 0;
      try { mockSize = JSON.stringify(state).length; } catch (e) { mockSize = 0; }
      return {
        dataFile: {
          path: '浏览器内存（sessionStorage）',
          exists: true,
          size: mockSize,
          mtime: nowISO()
        },
        backupDir: '浏览器内存',
        snapshots: [],
        accountCount: Object.keys(state.accounts).length,
        autoMinutes: 0,
        keep: 0
      };
    }

    if (pathname === '/api/markets') {
      return {
        markets: MARKET_META.map(function (meta) {
          var copy = clone(meta);
          copy.maxLeverage = LEVERAGE_CEILING[meta.id] || 1;
          copy.baseLeverage = BASE_LEVERAGE[meta.id] || 1;
          copy.mmr = MARGIN.mmr[meta.id] != null ? MARGIN.mmr[meta.id] : 0;
          copy.shortable = !!ALLOW_SHORT[meta.id];
          return copy;
        })
      };
    }

    if (pathname === '/api/quotes') {
      var symbols = String(q.get('symbols') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var out = { quotes: [], errors: [] };
      symbols.forEach(function (requested) {
        var quote = quoteFor(normalizeSymbol(requested));
        if (quote) {
          quote.extra = extraFor(quote);
          out.quotes.push(quote);
        } else {
          // errors[].symbol echoes the request string, per CONTRACTS.md section 2.
          out.errors.push({ symbol: requested, message: '未知标的' });
        }
      });
      return out;
    }

    if (pathname === '/api/kline') {
      var symbol = normalizeSymbol(q.get('symbol'));
      var interval = q.get('interval') || '1d';
      return { symbol: symbol, interval: interval, bars: barsFor(symbol, interval, q.get('limit')) };
    }

    if (pathname === '/api/universe') {
      var uniMarket = String(q.get('market') || '').toLowerCase();
      if (!MARKET_MAP[uniMarket]) fail(400, 'BAD_MARKET', '未知市场：' + uniMarket);
      var uniLimit = clamp(parseInt(q.get('limit'), 10) || 100, 1, 200);
      var uniSort = q.get('sort') === 'change' ? 'change' : 'amount';
      var uniItems = CATALOG.filter(function (item) { return item.market === uniMarket; }).map(function (item) {
        var quote = quoteFor(item.symbol);
        return {
          symbol: item.symbol, code: item.code, name: item.name,
          currency: CURRENCY[item.market], price: quote ? quote.price : item.base,
          changePct: quote ? quote.changePct : 0, amount: quote ? quote.amount : 0
        };
      }).sort(function (a, b) {
        return uniSort === 'change' ? b.changePct - a.changePct : b.amount - a.amount;
      }).slice(0, uniLimit);
      return {
        market: uniMarket, items: uniItems, source: 'mock',
        updatedAt: nowISO(), note: uniMarket === 'fx' ? '外汇列表为模拟精选，成交额显示已省略' : null
      };
    }

    if (pathname === '/api/search') {
      var query = String(q.get('q') || '').trim().toLowerCase();
      var limit = clamp(parseInt(q.get('limit'), 10) || 20, 1, 50);
      var results = CATALOG.filter(function (item) {
        if (!query) return true;
        return item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query) ||
          item.symbol.toLowerCase().includes(query);
      }).slice(0, limit).map(function (item) {
        return { symbol: item.symbol, code: item.code, name: item.name, market: item.market, currency: CURRENCY[item.market] };
      });
      return { results: results };
    }

    if (pathname === '/api/watchlist') {
      if (method === 'PUT') {
        if (!Array.isArray(body.symbols)) fail(400, 'BAD_REQUEST', 'symbols 必须是数组');
        var cleaned = body.symbols
          .filter(function (s) { return typeof s === 'string'; })
          .map(normalizeSymbol)
          .filter(function (s) { return CATALOG_MAP[s]; });
        state.watchlist = Array.from(new Set(cleaned));
        saveState();
      }
      return { symbols: clone(state.watchlist) };
    }

    if (pathname === '/api/accounts' && method === 'GET') {
      var accounts = Object.keys(state.accounts).map(function (id) { return accountSummary(state.accounts[id]); });
      return { accounts: accounts };
    }

    if (pathname === '/api/accounts' && method === 'POST') {
      var name = String(body.name || '').trim() || ('账户 ' + (Object.keys(state.accounts).length + 1));
      var capital = Number(body.initialCapital);
      if (!Number.isFinite(capital) || capital < 1000 || capital > 1000000000) {
        fail(400, 'INVALID_CAPITAL', '初始资金需在 1000 – 1,000,000,000 之间');
      }
      var createSettings = validateAccountSettings(body.settings || {});
      var account = newAccount({
        name: name, initialCapital: capital,
        baseCurrency: body.baseCurrency || 'CNY',
        marginMode: body.marginMode,
        settings: createSettings
      });
      state.accounts[account.id] = account;
      saveState();
      return { account: accountSummary(account) };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/settings$/);
    if (match && method === 'PATCH') {
      var accSettings = getAccount(decodeURIComponent(match[1]));
      var patch = (body && body.settings) || {};
      var locked = hasOpenRisk(accSettings);
      var touchesRisk = patch.leverageMultiplier != null ||
        (patch.margin && patch.margin.mmr);
      if (locked && touchesRisk) {
        fail(409, 'SETTINGS_LOCKED', '有持仓或挂单时不能修改杠杆倍率与保证金参数');
      }
      var merged = deepMerge(accountSettings(accSettings), patch);
      var validated = validateAccountSettings(merged);
      accSettings.settings = validated;
      saveState();
      return { account: accountSummary(accSettings) };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/positions\/([^/]+)\/protect$/);
    if (match && method === 'POST') {
      var accProtect = getAccount(decodeURIComponent(match[1]));
      var protectSymbol = normalizeSymbol(decodeURIComponent(match[2]));
      var protectPos = accProtect.positions[protectSymbol];
      if (!protectPos) fail(404, 'POSITION_NOT_FOUND', '当前标的没有持仓');
      var protectQuote = quoteState(protectSymbol);
      var protectPrice = protectQuote ? protectQuote.price : protectPos.avgCost;
      var nextTp = Object.prototype.hasOwnProperty.call(body, 'takeProfit')
        ? (body.takeProfit == null ? null : Number(body.takeProfit)) : protectPos.takeProfit;
      var nextSl = Object.prototype.hasOwnProperty.call(body, 'stopLoss')
        ? (body.stopLoss == null ? null : Number(body.stopLoss)) : protectPos.stopLoss;
      if (nextTp != null && (!isFinite(nextTp) || nextTp <= 0)) fail(400, 'PROTECT_PRICE_INVALID', '止盈价无效');
      if (nextSl != null && (!isFinite(nextSl) || nextSl <= 0)) fail(400, 'PROTECT_PRICE_INVALID', '止损价无效');
      var longPos = protectPos.side !== 'short';
      if (nextTp != null && (longPos ? nextTp <= protectPrice : nextTp >= protectPrice)) {
        fail(400, 'PROTECT_PRICE_INVALID', '止盈价方向不合理');
      }
      if (nextSl != null && (longPos ? nextSl >= protectPrice : nextSl <= protectPrice)) {
        fail(400, 'PROTECT_PRICE_INVALID', '止损价方向不合理');
      }
      protectPos.takeProfit = nextTp;
      protectPos.stopLoss = nextSl;
      saveState();
      return { ok: true, position: clone(protectPos) };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/orders\/([^/]+)$/);
    if (match && method === 'DELETE') {
      var accForCancel = getAccount(decodeURIComponent(match[1]));
      var orderId = decodeURIComponent(match[2]);
      var target = accForCancel.orders.find(function (o) { return o.id === orderId; });
      if (!target) fail(404, 'ORDER_NOT_FOUND', '委托不存在');
      if (target.status !== 'open') fail(400, 'ORDER_NOT_CANCELLABLE', '该委托当前状态不可撤销');
      target.status = 'cancelled';
      target.updatedAt = nowISO();
      saveState();
      return { ok: true };
    }
    if (match && method === 'PATCH') {
      var accForEdit = getAccount(decodeURIComponent(match[1]));
      var editId = decodeURIComponent(match[2]);
      var editOrder = accForEdit.orders.find(function (o) { return o.id === editId; });
      if (!editOrder) fail(404, 'ORDER_NOT_FOUND', '委托不存在');
      if (editOrder.status !== 'open' || editOrder.type !== 'limit') {
        fail(400, 'ORDER_NOT_AMENDABLE', '仅未成交的限价单可以改价');
      }
      var newPrice = Number(body.limitPrice);
      if (!isFinite(newPrice) || newPrice <= 0) fail(400, 'PRICE_INVALID', '委托价格无效');
      var editItem = CATALOG_MAP[editOrder.symbol];
      if (editItem && editItem.market === 'cn') {
        var editExtra = extraFor(quoteState(editOrder.symbol));
        if (editExtra.limitUp != null && (newPrice > editExtra.limitUp + 1e-9 || newPrice < editExtra.limitDown - 1e-9)) {
          fail(400, 'PRICE_LIMIT', '委托价超出涨跌停范围');
        }
      }
      editOrder.limitPrice = newPrice;
      editOrder.updatedAt = nowISO();
      saveState();
      return { ok: true, order: clone(editOrder) };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/orders$/);
    if (match) {
      var accOrders = getAccount(decodeURIComponent(match[1]));
      if (method === 'POST') {
        body.symbol = normalizeSymbol(body.symbol);
        var placed = placeOrder(accOrders, body);
        return placed;
      }
      var status = q.get('status') || 'all';
      var orderLimit = clamp(parseInt(q.get('limit'), 10) || 200, 1, 1000);
      var orders = accOrders.orders.filter(function (o) {
        return status === 'all' ? true : o.status === status;
      }).sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); }).slice(0, orderLimit).map(clone);
      return { orders: orders };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/trades$/);
    if (match) {
      var accTrades = getAccount(decodeURIComponent(match[1]));
      var tradeLimit = clamp(parseInt(q.get('limit'), 10) || 200, 1, 1000);
      var trades = accTrades.trades.slice()
        .sort(function (a, b) { return Date.parse(b.t) - Date.parse(a.t); })
        .slice(0, tradeLimit)
        .map(clone);
      return { trades: trades };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/stats$/);
    if (match) return computeStats(getAccount(decodeURIComponent(match[1])));

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/equity$/);
    if (match) {
      var accEquity = getAccount(decodeURIComponent(match[1]));
      return synthEquity(accEquity, q.get('range') || '1m');
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)\/reset$/);
    if (match && method === 'POST') {
      var accReset = getAccount(decodeURIComponent(match[1]));
      var resetCapital = Number(body.initialCapital);
      if (!Number.isFinite(resetCapital) || resetCapital <= 0) fail(400, 'INVALID_CAPITAL', '初始资金必须大于 0');
      var fresh = newAccount({
        id: accReset.id, name: accReset.name, initialCapital: resetCapital,
        baseCurrency: accReset.baseCurrency, marginMode: accReset.marginMode,
        settings: accReset.settings
      });
      state.accounts[accReset.id] = fresh;
      saveState();
      return { account: accountSummary(fresh) };
    }

    match = pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (match) {
      var accountId = decodeURIComponent(match[1]);
      if (method === 'DELETE') {
        if (!state.accounts[accountId]) fail(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
        delete state.accounts[accountId];
        saveState();
        return { ok: true };
      }
      if (method === 'PATCH') {
        var accMode = getAccount(accountId);
        var changed = false;
        if (body.name !== undefined) {
          var nextName = String(body.name || '').trim();
          if (nextName.length < 1 || nextName.length > 20) fail(400, 'NAME_INVALID', '账户名称需为 1–20 个字符');
          accMode.name = nextName;
          changed = true;
        }
        if (body.marginMode !== undefined) {
          var nextMode = body.marginMode === 'cross' ? 'cross' : body.marginMode === 'isolated' ? 'isolated' : null;
          if (!nextMode) fail(400, 'INVALID_MARGIN_MODE', '保证金模式只能是 isolated 或 cross');
          var hasPositions = Object.keys(accMode.positions || {}).some(function (key) { return accMode.positions[key].qty > 1e-9; });
          var hasOpenOrders = (accMode.orders || []).some(function (order) { return order.status === 'open'; });
          if (hasPositions || hasOpenOrders) {
            fail(409, 'MARGIN_MODE_LOCKED', '有持仓或未成交委托时不能切换保证金模式');
          }
          accMode.marginMode = nextMode;
          changed = true;
        }
        if (!changed) fail(400, 'BAD_REQUEST', '没有可更新的字段');
        saveState();
        return { account: accountSummary(accMode) };
      }
      return snapshot(getAccount(accountId));
    }

    if (pathname === '/api/dev/tick') return { ok: true };

    // Mock-only helper for verifying risk warnings / liquidations quickly.
    if (pathname === '/api/dev/shock' && method === 'POST') {
      var shockSymbol = normalizeSymbol(body.symbol);
      var shockPct = Number(body.pct);
      if (!CATALOG_MAP[shockSymbol] || !isFinite(shockPct)) fail(400, 'BAD_REQUEST', '参数无效');
      var shockQuote = quotes[shockSymbol];
      if (shockQuote) {
        var digits = priceDigits(shockQuote.market, shockQuote.price);
        shockQuote.price = roundTo(Math.max(0.000001, shockQuote.price * (1 + shockPct / 100)), digits);
        shockQuote.change = roundTo(shockQuote.price - shockQuote.prevClose, digits);
        shockQuote.changePct = shockQuote.prevClose ? roundTo((shockQuote.change / shockQuote.prevClose) * 100, 2) : 0;
        shockQuote.high = Math.max(shockQuote.high, shockQuote.price);
        shockQuote.low = Math.min(shockQuote.low, shockQuote.price);
        shockQuote.ts = nowISO();
      }
      return { ok: true, price: shockQuote ? shockQuote.price : null };
    }

    if (pathname === '/api/dev/set-risk' && method === 'POST') {
      var riskAccount = getAccount(String(body.accountId || ''));
      var riskSymbol = normalizeSymbol(body.symbol);
      var riskPos = riskAccount.positions[riskSymbol];
      if (!riskPos) fail(404, 'POSITION_NOT_FOUND', '没有该持仓');
      var ratio = Number(body.ratio);
      if (!isFinite(ratio) || ratio <= 0) fail(400, 'BAD_REQUEST', 'ratio 无效');
      var riskQuote = quoteState(riskSymbol) || { price: riskPos.avgCost };
      var maintenance = maintenanceOf(riskPos, riskQuote.price, riskAccount);
      var desiredEquity = maintenance / ratio;
      var newMargin = desiredEquity + (Number(riskPos.accruedInterest) || 0) - unrealizedOf(riskPos, riskQuote.price);
      if (newMargin <= 0) fail(400, 'BAD_REQUEST', '无法调整到目标风险率');
      riskPos.margin = round2(newMargin);
      if (body.freeze === true) {
        riskPos._freezeRisk = true;
        if (riskQuote) riskQuote._frozen = true;
      } else {
        delete riskPos._freezeRisk;
        if (riskQuote) delete riskQuote._frozen;
      }
      saveState();
      return { ok: true, margin: riskPos.margin, price: riskQuote.price };
    }

    if (pathname === '/api/dev/position-opened-at' && method === 'POST') {
      var openedAccount = getAccount(String(body.accountId || ''));
      var openedSymbol = normalizeSymbol(body.symbol);
      var openedPos = openedAccount.positions[openedSymbol];
      if (!openedPos) fail(404, 'POSITION_NOT_FOUND', '没有该持仓');
      var openedAt = String(body.openedAt || '');
      if (!isFinite(Date.parse(openedAt))) fail(400, 'BAD_REQUEST', 'openedAt 无效');
      openedPos.openedAt = openedAt;
      saveState();
      return { ok: true, openedAt: openedPos.openedAt };
    }

    fail(404, 'NOT_FOUND', '接口不存在：' + pathname);
  }

  initQuotes();
  initState();

  window.MOCK_API = function (path, opts) {
    var options = opts || {};
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          resolve(clone(route(path, options)));
        } catch (err) {
          reject(err);
        }
      }, 20 + Math.random() * 35);
    });
  };

  // Mock push stream: drives the same quote-update path as the real SSE
  // endpoint, one frame per second (crypto/fx are faster on the server).
  window.MOCK_STREAM_OPEN = function (getSymbols, onFrame) {
    var timer = null;
    var stream = {
      closed: false,
      close: function () {
        stream.closed = true;
        if (timer) clearInterval(timer);
      }
    };
    var emit = function () {
      if (stream.closed) return;
      var symbols = Array.from(new Set((getSymbols() || []).map(normalizeSymbol)));
      var quotes = [];
      var errors = [];
      symbols.forEach(function (symbol) {
        var quote = quoteFor(symbol);
        if (quote) {
          quote.extra = extraFor(quote);
          quotes.push(quote);
        } else {
          errors.push({ symbol: symbol, message: '未知标的' });
        }
      });
      onFrame({ quotes: quotes, errors: errors, ts: nowISO() });
    };
    timer = setInterval(emit, 1000);
    setTimeout(emit, 120);
    return stream;
  };
})();
