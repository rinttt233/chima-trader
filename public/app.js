/* ChimaTrader (千亦所) frontend controller.
 * Vanilla ES2022, no build step. Talks to the REST API described in
 * CONTRACTS.md section 7, or to window.MOCK_API when ?mock=1.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- constants

  var MOCK = window.MOCK === true;
  var REFRESH_MS = 2000;
  var HEALTH_MS = 15000;
  var SOURCE_BANNER_MUTE_KEY = 'chimatrader.sourceBannerMutedUntil';
  var AUX_REFRESH_MS = 12000;
  var CURRENCY_SYMBOL = { CNY: '¥', HKD: 'HK$', USD: '$', USDT: '₮' };
  var MARKET_LABEL = { cn: 'A股', hk: '港股', us: '美股', fx: '外汇', crypto: '加密' };
  var SLIPPAGE_BPS = { cn: 1, hk: 1, us: 1, fx: 2, crypto: 3 };
  var STATUS_LABEL = { open: '未成交', filled: '已成交', cancelled: '已撤销', rejected: '已拒绝' };
  var SIDE_LABEL = { buy: '买入', sell: '卖出' };
  var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '60m': 3600000, '1h': 3600000, '4h': 14400000,
    '1d': 86400000, '1w': 604800000, '1M': 2592000000
  };

  // Mirrors config.json defaults; the server remains the source of truth.
  var FEE_CONFIG = {
    cn: { commissionRate: 0.00025, commissionMin: 5, stampDutyRate: 0.0005, transferFeeRate: 0.00001 },
    hk: { commissionRate: 0.00025, commissionMin: 100, stampDutyRate: 0.001, exchangeFeeRate: 0.0000565, settlementFeeRate: 0.00002 },
    us: { perShare: 0.005, commissionMin: 1, secFeeRate: 0.0000278 },
    fx: { spreadBps: 1.5 },
    crypto: { commissionRate: 0.001 }
  };

  var PREFS_KEY = 'chimatrader.prefs.v1';
  var LEGACY_PREFS_KEY = 'papertrader.prefs.v1';
  var DEFAULT_PREFS = {
    version: 1,
    intervals: {},
    chartMode: 'candles',
    selectedSymbol: null,
    accountId: null,
    activeTab: 'positions',
    newbieHints: true,
    onboardingSeen: false,
    recent: [],
    leverageByMarket: {}
  };
  var VALID_TABS = ['positions', 'orders', 'history', 'trades', 'stats', 'equity'];
  var STREAM_HEALTH_WINDOW_MS = 5000;
  var UNIVERSE_MARKETS = ['cn', 'hk', 'us', 'fx', 'crypto'];
  var MIN_UNIT = { cn: 100, hk: 100, us: 1, fx: 0.01, crypto: 0.0001 };
  var MAX_RECENT = 12;
  // Mirrors config.json margin settings; previews only, server is authoritative.
  var MARGIN_CONFIG = {
    mmr: { cn: 1, hk: 0.125, us: 0.125, fx: 0.005, crypto: 0.005 },
    interestAnnual: { cn: 0, hk: 0.06, us: 0.06, fx: 0.03, crypto: 0.08 },
    liquidationFeeRate: { cn: 0, hk: 0.002, us: 0.002, fx: 0, crypto: 0.005 }
  };
  var MAX_LEVERAGE_FALLBACK = { cn: 1, hk: 20, us: 20, fx: 500, crypto: 125 };
  var ALLOW_SHORT_FALLBACK = { cn: false, hk: true, us: true, fx: true, crypto: true };
  var BASE_LEVERAGE_FALLBACK = { cn: 1, hk: 10, us: 10, fx: 200, crypto: 100 };
  var LEVERAGE_CEILING_FALLBACK = { cn: 1, hk: 20, us: 20, fx: 500, crypto: 125 };
  var SETTINGS_RANGES_FALLBACK = {
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
  var SETTINGS_PRESETS_FALLBACK = {
    conservative: { leverageMultiplier: 0.1, margin: { mmr: { cn: 1, hk: 0.1, us: 0.1, fx: 0.005, crypto: 0.01 } } },
    recommended: { leverageMultiplier: 1, margin: { mmr: { cn: 1, hk: 0.05, us: 0.05, fx: 0.0025, crypto: 0.005 } } },
    aggressive: { leverageMultiplier: 2, margin: { mmr: { cn: 1, hk: 0.04, us: 0.04, fx: 0.002, crypto: 0.004 } } }
  };
  var ONBOARDING_STEPS = [
    {
      target: '.watchlist-panel',
      title: '这是模拟盘',
      text: '你有 100 万虚拟资金，随便亏，不涉及真钱。先从左侧「自选列表」挑一个标的，也可以在上方搜索框搜代码或名称。',
      hint: '点击左侧第一个标的开始'
    },
    {
      target: '.chart-panel',
      title: '中间看 K 线',
      text: '中间显示 K 线和成交量，上方按钮可以切换周期或「分时」。鼠标移到图上，可以查看每根 K 线的开、高、低、收和成交量。',
      hint: ''
    },
    {
      target: '.order-panel',
      title: '右边下单',
      text: '开多 = 看涨，开空 = 看跌，平仓 = 关掉已有仓位。市价立刻成交，限价到价才成交；杠杆会放大盈亏，亏到保证金不足会被强平，新手建议先用 1x 或 2x。',
      hint: ''
    },
    {
      target: '.bottom-panel',
      title: '下面看结果',
      text: '下方标签页查看持仓 / 当前委托 / 历史委托 / 成交 / 统计 / 净值；右上角「帮助」随时重看教程。',
      hint: '点击左侧第一个标的开始练习'
    }
  ];

  // ------------------------------------------------------------------ state

  var state = {
    mock: MOCK,
    ready: false,
    prefs: null,
    markets: {},
    marketList: [],
    settingsMeta: null,
    settingsMode: 'create',
    settingsLocked: false,
    settingsFormDirty: false,
    settingsPreset: null,
    watchlist: [],
    quotes: {},
    quoteErrors: [],
    quoteErrorMap: {},
    lastQuoteAt: null,
    lastQuoteError: null,
    accounts: [],
    accountId: null,
    view: null,
    accountEpoch: 0,
    selected: null,
    interval: null,
    chartMode: 'candles',
    chartBars: [],
    chartToken: 0,
    chart: null,
    chartLastPrice: null,
    chartReloading: false,
    equityChart: null,
    equity: null,
    equityRange: '1m',
    orderSide: 'buy',
    orderAction: 'long',        // long | short | close
    leverage: 1,
    showTpSl: false,
    orderType: 'market',
    orderBusy: false,
    orderHint: null,
    orderHintUntil: 0,
    orderHintTimer: null,
    editingOrderId: null,
    editingPrice: '',
    liquidationBaselineDone: false,
    seenLiquidations: {},
    accountModalRequired: false,
    activeTab: 'positions',
    historyFilter: 'all',
    historyOrders: [],
    trades: [],
    stats: null,
    loadingTab: null,
    auxLoadedAt: 0,
    health: null,
    healthCounter: 0,
    sourceBannerMutedUntil: 0,
    chartQuoteError: false,
    accountTickBusy: false,
    accountTimer: null,
    quotePollTimer: null,
    stream: {
      mode: 'connecting', // connecting | stream | poll | offline
      es: null,
      mockClose: null,
      lastQuotesFrameAt: 0,
      lastActivityAt: 0,
      reconnectTimer: null,
      watchdogTimer: null,
      fallbackReason: null
    },
    selectedPollTimer: null,
    flashPrev: {},
    watchRefs: {},
    positionRefs: {},
    marketStatus: null,
    universe: {
      open: false,
      activeMarket: 'cn',
      sort: 'amount',
      items: [],
      loading: false,
      note: null,
      error: null,
      source: null,
      updatedAt: null,
      query: '',
      searchResults: [],
      searchLoading: false,
      searchTimer: null,
      searchToken: 0,
      loadToken: 0,
      cache: {},
      fallback: false
    },
    chips: {
      tradable: [],
      loading: false,
      loadedAt: 0
    },
    onboardingActive: false,
    onboardingStep: 0,
    searchTimer: null,
    searchToken: 0,
    searchResults: [],
    searchIndex: -1,
    limitPriceSymbol: null,
    confirmResolve: null,
    lastErrorBanner: null,
    data: {
      status: null,
      loading: false,
      loadToken: 0,
      importData: null,
      importName: null,
      importBusy: false
    }
  };
  window.__APP_STATE = state;
  window.__APP_ERRORS = [];

  // -------------------------------------------------------------- dom utils

  function $(selector) { return document.querySelector(selector); }
  function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function on(el, type, handler) { if (el) el.addEventListener(type, handler); }
  function setText(selector, text) { var el = $(selector); if (el) el.textContent = text; }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // --------------------------------------------------------------- preferences

  function loadPrefs() {
    var stored = null;
    try {
      var raw = localStorage.getItem(PREFS_KEY) || localStorage.getItem(LEGACY_PREFS_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (e) { stored = null; }
    var prefs = {
      version: 1,
      intervals: {},
      chartMode: 'candles',
      selectedSymbol: null,
      accountId: null,
      activeTab: 'positions',
      newbieHints: true,
      onboardingSeen: false,
      recent: [],
      leverageByMarket: {}
    };
    if (stored && typeof stored === 'object') {
      if (stored.intervals && typeof stored.intervals === 'object') {
        Object.keys(stored.intervals).forEach(function (market) {
          var value = stored.intervals[market];
          if (typeof value === 'string' && value) prefs.intervals[market] = value;
        });
      }
      if (stored.chartMode === 'line' || stored.chartMode === 'candles') prefs.chartMode = stored.chartMode;
      if (typeof stored.selectedSymbol === 'string' && stored.selectedSymbol) prefs.selectedSymbol = stored.selectedSymbol;
      if (typeof stored.accountId === 'string' && stored.accountId) prefs.accountId = stored.accountId;
      if (VALID_TABS.indexOf(stored.activeTab) >= 0) prefs.activeTab = stored.activeTab;
      if (typeof stored.newbieHints === 'boolean') prefs.newbieHints = stored.newbieHints;
      if (typeof stored.onboardingSeen === 'boolean') prefs.onboardingSeen = stored.onboardingSeen;
      if (Array.isArray(stored.recent)) {
        prefs.recent = stored.recent
          .filter(function (symbol) { return typeof symbol === 'string' && symbol; })
          .map(normalizeSymbol)
          .filter(function (symbol, index, list) { return list.indexOf(symbol) === index; })
          .slice(0, MAX_RECENT);
      }
      if (stored.leverageByMarket && typeof stored.leverageByMarket === 'object') {
        Object.keys(stored.leverageByMarket).forEach(function (market) {
          var lev = Number(stored.leverageByMarket[market]);
          if (isFinite(lev) && lev >= 1) prefs.leverageByMarket[market] = lev;
        });
      }
    }
    return prefs;
  }

  function savePrefs() {
    if (!state.prefs) return;
    try {
      state.prefs.version = 1;
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch (e) { /* private mode or quota: ignore */ }
  }

  function patchPrefs(patch) {
    if (!state.prefs) state.prefs = loadPrefs();
    Object.keys(patch).forEach(function (key) { state.prefs[key] = patch[key]; });
    savePrefs();
  }

  function marketIntervalsFor(market) {
    var meta = state.markets[market];
    if (meta && Array.isArray(meta.intervals) && meta.intervals.length) return meta.intervals;
    if (state.marketList.length) return state.marketList[0].intervals || ['1d'];
    return ['1d'];
  }

  function defaultIntervalFor(market) {
    var list = marketIntervalsFor(market);
    if (list.indexOf('5m') >= 0) return '5m';
    if (list.indexOf('1d') >= 0) return '1d';
    return list[0];
  }

  function preferredIntervalFor(market) {
    var list = marketIntervalsFor(market);
    var pref = state.prefs && state.prefs.intervals ? state.prefs.intervals[market] : null;
    if (pref && list.indexOf(pref) >= 0) return pref;
    return defaultIntervalFor(market);
  }

  function rememberInterval(market, interval) {
    if (!state.prefs || !market || !interval) return;
    if (!state.prefs.intervals) state.prefs.intervals = {};
    state.prefs.intervals[market] = interval;
    savePrefs();
  }

  function rememberRecent(symbol) {
    if (!state.prefs || !symbol) return;
    symbol = normalizeSymbol(symbol);
    var list = Array.isArray(state.prefs.recent) ? state.prefs.recent.slice() : [];
    list = list.filter(function (item) { return item !== symbol; });
    list.unshift(symbol);
    state.prefs.recent = list.slice(0, MAX_RECENT);
    savePrefs();
  }

  // ------------------------------------------------------- leverage helpers

  function cloneDeep(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function settingsMeta() {
    return state.settingsMeta || fallbackSettingsMeta();
  }

  function fallbackSettingsMeta() {
    var fees = cloneDeep(FEE_CONFIG);
    if (!fees.fx.commissionRate) fees.fx.commissionRate = 0;
    var defaults = {
      leverageMultiplier: 1,
      fees: fees,
      slippageBps: cloneDeep(SLIPPAGE_BPS),
      margin: {
        mmr: { cn: 1, hk: 0.05, us: 0.05, fx: 0.0025, crypto: 0.005 },
        interestAnnual: cloneDeep(MARGIN_CONFIG.interestAnnual),
        liquidationFeeRate: cloneDeep(MARGIN_CONFIG.liquidationFeeRate)
      },
      autoConvert: true,
      fxConvertSpread: 0.003
    };
    return {
      markets: ['cn', 'hk', 'us', 'fx', 'crypto'].map(function (id) {
        return {
          id: id, name: MARKET_LABEL[id], currency: { cn: 'CNY', hk: 'HKD', us: 'USD', fx: 'USD', crypto: 'USDT' }[id],
          baseLeverage: BASE_LEVERAGE_FALLBACK[id], maxLeverageCeiling: LEVERAGE_CEILING_FALLBACK[id],
          shortable: ALLOW_SHORT_FALLBACK[id]
        };
      }),
      ranges: cloneDeep(SETTINGS_RANGES_FALLBACK),
      presets: cloneDeep(SETTINGS_PRESETS_FALLBACK),
      multiplier: { range: [0.1, 2], default: 1, quick: [0.1, 0.25, 0.5, 1, 2] },
      defaults: { settings: defaults, initialCapital: 1000000, baseCurrency: 'CNY' }
    };
  }

  function settingsMarketMeta(market) {
    var list = settingsMeta().markets || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === market) return list[i];
    }
    return null;
  }

  function settingsMultiplier() {
    var meta = settingsMeta();
    var fallback = meta.multiplier && meta.multiplier.default != null ? meta.multiplier.default : 1;
    if (state.view && state.view.settings && state.view.settings.leverageMultiplier != null) {
      return Number(state.view.settings.leverageMultiplier);
    }
    return fallback;
  }

  function multiplierLeverage(market, multiplier) {
    var info = settingsMarketMeta(market);
    var base = info && info.baseLeverage != null ? Number(info.baseLeverage) : (BASE_LEVERAGE_FALLBACK[market] || 1);
    var ceiling = info && info.maxLeverageCeiling != null ? Number(info.maxLeverageCeiling) : (LEVERAGE_CEILING_FALLBACK[market] || 1);
    var mult = Number(multiplier);
    if (!isFinite(mult)) mult = 1;
    if (market === 'cn') return 1;
    return Math.min(ceiling, Math.max(1, Math.round(base * mult)));
  }

  function accountEffective() {
    return state.view && state.view.effective ? state.view.effective : null;
  }

  function maxLeverageFor(market) {
    var eff = accountEffective();
    if (eff && eff.leverage && eff.leverage[market] != null) {
      return Math.max(1, Math.floor(Number(eff.leverage[market]) || 1));
    }
    if (state.view && state.view.settings) {
      return multiplierLeverage(market, settingsMultiplier());
    }
    if (!state.view) {
      var defMult = settingsMeta().multiplier && settingsMeta().multiplier.default != null ? settingsMeta().multiplier.default : 1;
      return multiplierLeverage(market, defMult);
    }
    var meta = state.markets[market];
    var value = meta && (meta.maxLeverage != null ? meta.maxLeverage
      : (meta.leverage && typeof meta.leverage === 'object' ? meta.leverage.max : null));
    var lev = Number(value);
    if (!isFinite(lev) || lev < 1) lev = MAX_LEVERAGE_FALLBACK[market] || 1;
    return Math.max(1, Math.floor(lev));
  }

  function allowShortFor(market) {
    var meta = state.markets[market];
    if (meta && typeof meta.shortable === 'boolean') return meta.shortable;
    if (meta && typeof meta.allowShort === 'boolean') return meta.allowShort;
    return ALLOW_SHORT_FALLBACK[market] !== false;
  }

  function mmrFor(market) {
    var eff = accountEffective();
    if (eff && eff.margin && eff.margin.mmr && eff.margin.mmr[market] != null) {
      return Number(eff.margin.mmr[market]);
    }
    var meta = state.markets[market];
    var value = meta && meta.mmr != null ? Number(meta.mmr) : null;
    if (!isFinite(value) || value == null || value < 0) {
      value = MARGIN_CONFIG.mmr[market] != null ? MARGIN_CONFIG.mmr[market] : 0.1;
    }
    if (value > 1) value = value / 100;
    return value;
  }

  function feeConfigFor(market) {
    var base = FEE_CONFIG[market] || {};
    var eff = accountEffective();
    var configured = eff && eff.fees ? eff.fees[market] : null;
    if (!configured) return base;
    var merged = {};
    Object.keys(base).forEach(function (key) { merged[key] = base[key]; });
    Object.keys(configured).forEach(function (key) {
      if (configured[key] != null && isFinite(Number(configured[key]))) merged[key] = Number(configured[key]);
    });
    return merged;
  }

  function slippageBpsFor(market) {
    var eff = accountEffective();
    if (eff && eff.slippageBps && eff.slippageBps[market] != null && isFinite(eff.slippageBps[market])) {
      return Number(eff.slippageBps[market]);
    }
    return SLIPPAGE_BPS[market] || 0;
  }

  function interestAnnualFor(market) {
    var eff = accountEffective();
    if (eff && eff.margin && eff.margin.interestAnnual && eff.margin.interestAnnual[market] != null) {
      return Number(eff.margin.interestAnnual[market]);
    }
    return MARGIN_CONFIG.interestAnnual[market] || 0;
  }

  function formatMultiplier(value) {
    var num = Number(value);
    return isFinite(num) ? fmtNumber(num, 2, 0) : '1';
  }

  function leverageCapsText(multiplier) {
    var mult = multiplier == null ? settingsMultiplier() : multiplier;
    var crypto = multiplierLeverage('crypto', mult);
    var fx = multiplierLeverage('fx', mult);
    var hk = multiplierLeverage('hk', mult);
    var us = multiplierLeverage('us', mult);
    return '加密 ' + crypto + 'x · 外汇 ' + fx + 'x · ' +
      (hk === us ? '港美 ' + hk + 'x' : '港股 ' + hk + 'x · 美股 ' + us + 'x');
  }

  function accountLeverageCapsText() {
    var eff = accountEffective();
    if (eff && eff.leverage) {
      var crypto = eff.leverage.crypto != null ? eff.leverage.crypto : multiplierLeverage('crypto', settingsMultiplier());
      var fx = eff.leverage.fx != null ? eff.leverage.fx : multiplierLeverage('fx', settingsMultiplier());
      var hk = eff.leverage.hk != null ? eff.leverage.hk : multiplierLeverage('hk', settingsMultiplier());
      var us = eff.leverage.us != null ? eff.leverage.us : multiplierLeverage('us', settingsMultiplier());
      return '加密 ' + crypto + 'x · 外汇 ' + fx + 'x · ' + (hk === us ? '港美 ' + hk + 'x' : '港股 ' + hk + 'x · 美股 ' + us + 'x');
    }
    return leverageCapsText(settingsMultiplier());
  }

  function clampLeverage(market, value) {
    var max = maxLeverageFor(market);
    if (market === 'cn') return 1;
    var lev = Number(value);
    if (!isFinite(lev)) lev = 1;
    lev = Math.round(lev);
    return Math.min(max, Math.max(1, lev));
  }

  function positionSide(pos) {
    return pos && pos.side === 'short' ? 'short' : 'long';
  }

  function currentPosition() {
    return state.selected ? findPosition(state.selected) : null;
  }

  function effectiveOrderSide() {
    if (state.orderAction === 'close') {
      var pos = currentPosition();
      return pos && positionSide(pos) === 'short' ? 'buy' : 'sell';
    }
    return state.orderAction === 'short' ? 'sell' : 'buy';
  }

  function isCloseOrder() {
    return state.orderAction === 'close';
  }

  function accountMarginAvailable() {
    var view = state.view;
    if (!view) return 0;
    if (view.marginAvailable != null && isFinite(view.marginAvailable)) return Number(view.marginAvailable);
    return buyingPowerOf('CNY');
  }

  function leverageForCurrent() {
    var pos = currentPosition();
    if (pos && pos.leverage != null) return Number(pos.leverage) || 1;
    return clampLeverage(marketOf(state.selected), state.leverage || 1);
  }

  function setLeverage(value) {
    var market = marketOf(state.selected);
    var lev = clampLeverage(market, value);
    state.leverage = lev;
    if (state.prefs) {
      if (!state.prefs.leverageByMarket) state.prefs.leverageByMarket = {};
      state.prefs.leverageByMarket[market] = lev;
      savePrefs();
    }
    renderOrderInfo();
    renderOrderHint();
  }

  function riskClass(ratio) {
    var value = Number(ratio);
    if (!isFinite(value)) return '';
    if (value >= 0.9) return 'is-critical';
    if (value >= 0.8) return 'is-high';
    return '';
  }

  function fmtRisk(ratio) {
    var value = Number(ratio);
    if (!isFinite(value)) return '--';
    return fmtNumber(value * 100, 1, 1) + '%';
  }

  // -------------------------------------------------------------- misc helpers

  function directionOf(prev, next) {
    if (prev == null || next == null) return null;
    if (!isFinite(prev) || !isFinite(next) || prev === next) return null;
    return next > prev ? 'up' : 'down';
  }

  function flashValue(el, dir) {
    if (!el || !dir) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
    if (el._flashTimer) clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(function () {
      el.classList.remove('flash-up', 'flash-down');
      el._flashTimer = null;
    }, 260);
  }

  var tzFormatterCache = {};
  function tzNowParts(tz) {
    var zone = tz || 'Asia/Shanghai';
    var fmt = tzFormatterCache[zone];
    if (fmt === undefined) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
        });
      } catch (e) {
        fmt = null;
      }
      tzFormatterCache[zone] = fmt;
    }
    if (!fmt) {
      var local = new Date();
      return { weekday: local.getDay(), minutes: local.getHours() * 60 + local.getMinutes(), tz: zone };
    }
    var parts = fmt.formatToParts(new Date());
    var weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    var weekday = 0;
    var hour = 0;
    var minute = 0;
    parts.forEach(function (part) {
      if (part.type === 'weekday') weekday = weekdayMap[part.value] != null ? weekdayMap[part.value] : 0;
      else if (part.type === 'hour') hour = parseInt(part.value, 10) || 0;
      else if (part.type === 'minute') minute = parseInt(part.value, 10) || 0;
    });
    if (hour === 24) hour = 0;
    return { weekday: weekday, minutes: hour * 60 + minute, tz: zone };
  }

  function parseSessionTime(text) {
    if (text === '24:00') return 1440;
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!match) return null;
    return (parseInt(match[1], 10) % 24) * 60 + (parseInt(match[2], 10) || 0);
  }

  function sessionSummary(market) {
    var meta = state.markets[market];
    var sessions = meta && Array.isArray(meta.sessions) ? meta.sessions : [];
    if (!sessions.length) return '';
    return sessions.map(function (session) {
      return session.start + '-' + session.end + (session.tz ? ' ' + session.tz : '');
    }).join(' / ');
  }

  // Pure session phase derived from /api/markets sessions (no quote freshness).
  function marketSessionPhase(market) {
    var meta = state.markets[market];
    if (!meta) return { phase: 'unknown' };
    var sessions = Array.isArray(meta.sessions) ? meta.sessions : [];
    if (!sessions.length) return { phase: 'open' };
    var tz = sessions[0].tz || 'Asia/Shanghai';
    var now = tzNowParts(tz);
    var intervals = sessions.map(function (session) {
      return {
        start: parseSessionTime(session.start),
        end: parseSessionTime(session.end),
        tz: session.tz || tz
      };
    }).filter(function (session) {
      return session.start != null && session.end != null;
    });
    if (!intervals.length) return { phase: 'unknown' };
    var spansWeekend = intervals.some(function (session) {
      return session.start <= 0 && session.end >= 1440;
    });
    var isWeekend = now.weekday === 0 || now.weekday === 6;
    if (!spansWeekend && isWeekend) {
      return { phase: 'weekend', label: '周末休市', hint: '周末休市，可提前挂限价单，开盘后自动撮合' };
    }
    // FX runs Mon 05:00 – Sat 05:00 Asia/Shanghai (CONTRACTS §6.1).
    if (market === 'fx' && (now.weekday === 0 || (now.weekday === 6 && now.minutes >= 300))) {
      return { phase: 'weekend', label: '周末休市', hint: '周末休市，可提前挂限价单，下周一开盘后自动撮合' };
    }
    var inSession = intervals.some(function (session) {
      return now.minutes >= session.start && now.minutes < session.end;
    });
    if (inSession) return { phase: 'open', label: '交易中', hint: '' };
    var starts = intervals.map(function (session) { return session.start; });
    var ends = intervals.map(function (session) { return session.end; });
    var firstStart = Math.min.apply(null, starts);
    var lastEnd = Math.max.apply(null, ends);
    if (now.minutes < firstStart) {
      return { phase: 'preopen', label: '未开盘', hint: '未到交易时段，可提前挂限价单，开盘后自动撮合' };
    }
    if (now.minutes >= lastEnd) {
      return { phase: 'closed', label: '已收盘', hint: '已收盘，可提前挂限价单，下一交易时段自动撮合' };
    }
    return { phase: 'break', label: '午间休市', hint: '午间休市，可提前挂限价单，下午开盘后自动撮合' };
  }

  function marketIsOpen(market) {
    return marketSessionPhase(market).phase === 'open';
  }

  // Market status = session phase + quote freshness (CONTRACTS §8).
  function computeMarketStatus(symbol, quote) {
    var market = marketOf(symbol);
    var session = marketSessionPhase(market);
    if (session.phase === 'unknown') {
      return { state: 'unknown', label: '行情同步中', hint: '', canMarketOrder: false, detail: '' };
    }
    if (session.phase !== 'open') {
      return {
        state: session.phase, label: session.label, hint: session.hint,
        canMarketOrder: false, detail: ''
      };
    }
    if (!quote) {
      return { state: 'stale', label: '数据源异常', hint: '行情暂不可用，请稍后重试；仍可提前挂限价单', canMarketOrder: false, detail: '' };
    }
    var quoteAge = quote.ts ? Date.now() - Date.parse(quote.ts) : Infinity;
    if (quote.stale) {
      return { state: 'stale', label: '数据源异常', hint: '当前显示缓存行情，市价单暂不可用，可尝试挂限价单', canMarketOrder: false, detail: '缓存行情' };
    }
    if (quoteAge > 180000) {
      return { state: 'stale', label: '数据源异常', hint: '行情超过 3 分钟未更新，市价单暂不可用，请稍后重试', canMarketOrder: false, detail: '行情陈旧' };
    }
    return { state: 'open', label: '交易中', hint: '', canMarketOrder: true, detail: '' };
  }

  function marketRulesHTML(market, quote) {
    var rules = [];
    if (market === 'cn') {
      rules.push('A股每手 100 股，数量需为 100 的整数倍');
      rules.push('今日买入 T+1，下一交易日才能卖出');
      rules.push('有涨跌停限制，超出范围的委托会被拒绝');
    } else if (market === 'hk') {
      var lot = (quote && quote.extra && quote.extra.lotSize) || 100;
      rules.push('每手 ' + lot + ' 股，数量需为每手整数倍');
      rules.push('T+0 当日买入可当日卖出');
    } else if (market === 'us') {
      rules.push('最小 1 股，T+0 可日内交易');
      rules.push('无涨跌停限制');
    } else if (market === 'fx') {
      rules.push('最小 0.01 单位，最多 2 位小数');
      rules.push('周一至周六交易，点差即交易成本');
    } else if (market === 'crypto') {
      rules.push('最小 0.0001，最多 4 位小数');
      rules.push('7×24 交易，手续费 0.1%');
    }
    if (autoConvertEnabled()) {
      rules.push('外币现金不足时，从 CNY 自动换汇（成本 ' + fmtNumber(fxConvertSpread() * 100, 2, 2) + '%）');
    }
    return rules.map(function (rule) {
      return '<div class="rule-row">' + escapeHtml(rule) + '</div>';
    }).join('');
  }

  function emptyStateHTML(kind) {
    var meta = {
      positions: {
        title: '还没有持仓',
        tip: '可以先试 100 股 A 股，或 0.001 个 BTC，感受一下下单流程。',
        action: true
      },
      orders: {
        title: '没有未成交委托',
        tip: '市价单会立即成交；限价单会挂在这里等待成交，也可以随时撤销。',
        action: true
      },
      trades: {
        title: '还没有成交记录',
        tip: '下单成交后会在这里留下记录，包含手续费和实现盈亏。',
        action: true
      },
      history: {
        title: '暂无历史委托',
        tip: '成交或撤销后的委托会归档到这里。',
        action: true
      }
    }[kind] || { title: '暂无数据', tip: '', action: false };
    return '<div class="empty-title">' + escapeHtml(meta.title) + '</div>' +
      (meta.tip ? '<p class="empty-tip">' + escapeHtml(meta.tip) + '</p>' : '') +
      (meta.action ? '<button type="button" class="btn" data-action="goto-watchlist">去自选挑一只标的</button>' : '');
  }

  function focusWatchlist() {
    var panel = $('.watchlist-panel');
    var search = $('#search-input');
    if (!panel) return;
    panel.classList.remove('is-attention');
    void panel.offsetWidth;
    panel.classList.add('is-attention');
    setTimeout(function () { panel.classList.remove('is-attention'); }, 1900);
    if (panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var row = panel.querySelector('.watch-row');
    if (row && row.focus) row.focus({ preventScroll: true });
    else if (search) search.focus();
    if (row) showToast('已定位到自选列表，点击标的即可开始', 'info');
    else showToast('自选列表为空，先在上方搜索一个标的', 'warn');
  }

  // ------------------------------------------------------ smart chips / universe

  function chipsData(includeTradable) {
    var groups = [];
    var seen = {};
    var view = state.view;
    var fxRates = (view && view.fxRates) || {};
    var held = [];
    if (view && Array.isArray(view.positions)) {
      held = view.positions.slice().sort(function (a, b) {
        var av = Number(a.marketValue || 0) * (Number(fxRates[a.currency]) || 1);
        var bv = Number(b.marketValue || 0) * (Number(fxRates[b.currency]) || 1);
        return bv - av;
      });
    }
    function chipInfo(symbol) {
      var quote = quoteOf(symbol);
      return {
        symbol: symbol,
        name: quote && quote.name ? quote.name : displayCode(symbol, quote),
        code: displayCode(symbol, quote),
        changePct: quote && quote.changePct != null ? quote.changePct : null
      };
    }
    function pushGroup(label, symbols) {
      var chips = [];
      symbols.forEach(function (symbol) {
        symbol = normalizeSymbol(symbol);
        if (!symbol || seen[symbol]) return;
        seen[symbol] = true;
        chips.push(chipInfo(symbol));
      });
      if (chips.length) groups.push({ label: label, chips: chips });
    }
    pushGroup('持有', held.map(function (pos) { return pos.symbol; }));
    pushGroup('自选', state.watchlist.slice());
    pushGroup('最近', (state.prefs && Array.isArray(state.prefs.recent)) ? state.prefs.recent : []);
    if (includeTradable) {
      pushGroup('可交易', state.chips.tradable.map(function (item) { return item.symbol; }));
    }
    // Base allocation guarantees every group is represented when available:
    // 持有 4 + 自选 4 + 最近 2 + 可交易 2 = 12 chips max.
    var baseCaps = { '持有': 4, '自选': 4, '最近': 2, '可交易': 2 };
    var used = {};
    var selected = [];
    groups.forEach(function (group) {
      var cap = baseCaps[group.label] || 2;
      group.chips.slice(0, cap).forEach(function (chip) {
        used[chip.symbol] = true;
        selected.push({ chip: chip, label: group.label });
      });
    });
    var fillOrder = ['可交易', '持有', '自选', '最近'];
    while (selected.length < 12) {
      var added = false;
      for (var f = 0; f < fillOrder.length && selected.length < 12; f++) {
        var labelWanted = fillOrder[f];
        for (var g = 0; g < groups.length; g++) {
          if (groups[g].label !== labelWanted) continue;
          for (var c = 0; c < groups[g].chips.length; c++) {
            var candidate = groups[g].chips[c];
            if (used[candidate.symbol]) continue;
            used[candidate.symbol] = true;
            selected.push({ chip: candidate, label: labelWanted });
            added = true;
            break;
          }
          break;
        }
      }
      if (!added) break;
    }
    var groupOrder = {};
    groups.forEach(function (group, index) { groupOrder[group.label] = index; });
    selected.sort(function (a, b) { return groupOrder[a.label] - groupOrder[b.label]; });
    var result = [];
    groups.forEach(function (group) {
      var chips = selected.filter(function (entry) { return entry.label === group.label; })
        .map(function (entry) { return entry.chip; });
      if (chips.length) result.push({ label: group.label, chips: chips });
    });
    return result;
  }

  function smartChipClass(label) {
    if (label === '持有') return 'is-held';
    if (label === '自选') return 'is-watch';
    if (label === '最近') return 'is-recent';
    return 'is-tradable';
  }

  function renderSmartChips(containerId, includeTradable) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var groups = chipsData(includeTradable);
    if (!groups.length) {
      el.innerHTML = '<span class="chips-empty">' + (state.accountId
        ? '还没有持仓，从下面列表挑一个开始'
        : '先在左侧自选或标的库里挑一个开始') + '</span>';
      return;
    }
    var html = '';
    groups.forEach(function (group) {
      html += '<span class="chip-group-label">' + escapeHtml(group.label) + '</span>';
      group.chips.forEach(function (chip) {
        html += '<button type="button" class="smart-chip ' + smartChipClass(group.label) +
          '" data-chip-symbol="' + escapeHtml(chip.symbol) + '" title="' +
          escapeHtml(chip.code + ' · ' + chip.symbol) + '">' +
          '<span>' + escapeHtml(chip.name) + '</span>' +
          '<span class="chip-pct ' + pnlClass(chip.changePct) + '">' +
          (chip.changePct != null ? fmtPct(chip.changePct) : '') + '</span>' +
          '</button>';
      });
    });
    el.innerHTML = html;
  }

  function renderChipsAll() {
    renderSmartChips('watch-chips', true);
    if (state.universe.open) renderSmartChips('universe-chips', true);
  }

  async function loadTradableCandidates() {
    if (!state.accountId || !state.view || state.chips.loading) return;
    var markets = UNIVERSE_MARKETS.filter(marketIsOpen);
    if (!markets.length) {
      state.chips.tradable = [];
      state.chips.loadedAt = Date.now();
      renderChipsAll();
      return;
    }
    state.chips.loading = true;
    try {
      var results = await Promise.allSettled(markets.map(function (market) {
        return api('/api/universe?market=' + encodeURIComponent(market) + '&limit=100&sort=amount');
      }));
      var candidates = [];
      var debugCounts = [];
      results.forEach(function (result) {
        var fulfilled = result.status === 'fulfilled';
        debugCounts.push({
          ok: fulfilled,
          items: fulfilled && result.value && Array.isArray(result.value.items) ? result.value.items.length : 0,
          error: fulfilled ? null : errorText(result.reason)
        });
        if (!fulfilled || !result.value || !Array.isArray(result.value.items)) return;
        result.value.items.forEach(function (item) {
          var market = marketOf(item.symbol);
          var cost = Number(item.price) * (MIN_UNIT[market] || 1);
          var power = buyingPowerOf(item.currency || 'CNY');
          if (isFinite(cost) && cost > 0 && power + 1e-9 >= cost) candidates.push(item);
        });
      });
      candidates.sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); });
      state.chips.tradable = candidates.slice(0, 8);
      state.chips.debug = { markets: markets, counts: debugCounts, candidates: candidates.length };
      state.chips.loadedAt = Date.now();
    } catch (err) {
      state.chips.tradable = [];
    } finally {
      state.chips.loading = false;
      renderChipsAll();
    }
  }

  function universeFallbackItems(market) {
    return collectSymbols().filter(function (symbol) {
      return marketOf(symbol) === market;
    }).map(function (symbol) {
      var quote = quoteOf(symbol);
      return {
        symbol: symbol,
        code: quote && quote.code ? quote.code : displayCode(symbol, quote),
        name: quote && quote.name ? quote.name : symbol,
        market: market,
        currency: (quote && quote.currency) || 'CNY',
        price: quote ? quote.price : null,
        changePct: quote ? quote.changePct : null,
        amount: quote ? quote.amount : null
      };
    });
  }

  function enrichUniverseItem(item) {
    var quote = quoteOf(item.symbol);
    return {
      symbol: normalizeSymbol(item.symbol),
      code: item.code || (quote && quote.code) || displayCode(item.symbol, quote),
      name: (quote && quote.name) || item.name || item.symbol,
      market: item.market || marketOf(item.symbol),
      currency: item.currency || (quote && quote.currency) || 'CNY',
      price: quote && quote.price != null ? quote.price : (item.price != null ? item.price : null),
      changePct: quote && quote.changePct != null ? quote.changePct : (item.changePct != null ? item.changePct : null),
      amount: quote && quote.amount != null ? quote.amount : (item.amount != null ? item.amount : null)
    };
  }

  function universeRowHTML(item, heldMap, watchMap) {
    var symbol = item.symbol;
    var isHeld = !!heldMap[symbol];
    var isWatch = !!watchMap[symbol];
    var market = item.market || marketOf(symbol);
    var amountText = (market === 'fx' || market === 'crypto' || item.amount == null) ? '—' : fmtCompact(item.amount);
    var badges = (isHeld ? '<span class="badge badge-held">持仓</span>' : '') +
      (isWatch ? '<span class="badge badge-watch">自选</span>' : '');
    var watchButton = isWatch
      ? ''
      : '<button type="button" class="u-watch" data-action="watch" data-symbol="' + escapeHtml(symbol) + '">+ 自选</button>';
    return '<div class="universe-row' + (isHeld ? ' is-held' : '') + '" data-symbol="' + escapeHtml(symbol) +
      '" role="button" tabindex="0">' +
      '<div class="u-main"><span class="u-name">' + escapeHtml(item.name || symbol) + '</span>' +
      '<span class="u-code">' + escapeHtml(item.code || '') + '</span></div>' +
      '<span class="u-price num">' + (item.price != null ? fmtPrice(item.price, symbol) : '--') + '</span>' +
      '<span class="u-change num ' + pnlClass(item.changePct) + '">' +
      (item.changePct != null ? fmtPct(item.changePct) : '--') + '</span>' +
      '<span class="u-amount num">' + amountText + '</span>' +
      '<span class="u-actions">' + badges + watchButton + '</span>' +
      '</div>';
  }

  function renderUniverse() {
    var listEl = $('#universe-list');
    if (!listEl) return;
    var emptyEl = $('#universe-empty');
    var noteEl = $('#universe-note');
    var countEl = $('#universe-count');
    var statusEl = $('#universe-status');
    var uni = state.universe;
    $$('#universe-tabs .universe-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-market') === uni.activeMarket);
      btn.setAttribute('aria-selected', btn.getAttribute('data-market') === uni.activeMarket ? 'true' : 'false');
    });
    $$('#universe-sort [data-sort]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-sort') === uni.sort);
    });
    var noteText = uni.error || uni.note || '';
    if (noteEl) {
      if (noteText) {
        noteEl.hidden = false;
        noteEl.className = 'note-bar' + (uni.error ? ' is-error' : '');
        noteEl.textContent = noteText;
      } else {
        noteEl.hidden = true;
      }
    }
    var query = (uni.query || '').trim();
    var rawItems = query ? uni.searchResults : uni.items;
    var heldMap = {};
    var watchMap = {};
    if (state.view && Array.isArray(state.view.positions)) {
      state.view.positions.forEach(function (pos) { heldMap[pos.symbol] = true; });
    }
    state.watchlist.forEach(function (symbol) { watchMap[symbol] = true; });
    var items = rawItems.slice().sort(function (a, b) {
      return (heldMap[b.symbol] ? 1 : 0) - (heldMap[a.symbol] ? 1 : 0);
    });
    if (!items.length) {
      listEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = query
          ? '<div class="empty-title">没有匹配的标的</div><p class="empty-tip">换个关键词试试，或清空搜索浏览该市场全部标的。</p>'
          : '<div class="empty-title">该市场暂无数据</div><p class="empty-tip">可以切换其他市场，或用上方搜索查找标的。</p>' +
            '<button type="button" class="btn" data-action="goto-watchlist">去自选挑一只标的</button>';
      }
    } else {
      if (emptyEl) emptyEl.hidden = true;
      listEl.innerHTML = items.map(function (item) {
        return universeRowHTML(item, heldMap, watchMap);
      }).join('');
    }
    if (countEl) countEl.textContent = items.length + ' 个标的';
    if (statusEl) {
      if (query) statusEl.textContent = '搜索结果 · ' + items.length + ' 个';
      else if (uni.loading) statusEl.textContent = '加载中…';
      else statusEl.textContent = marketLabel(uni.activeMarket) + ' · ' + (uni.source || '行情源');
    }
  }

  function setUniverseLoading(loading) {
    var skeleton = $('#universe-skeleton');
    if (skeleton) skeleton.hidden = !(loading && !state.universe.items.length);
    var listEl = $('#universe-list');
    if (listEl && loading && !state.universe.items.length) listEl.innerHTML = '';
    var emptyEl = $('#universe-empty');
    if (emptyEl && loading) emptyEl.hidden = true;
  }

  function openUniverse() {
    var modal = $('#modal-universe');
    if (!modal) return;
    modal.hidden = false;
    state.universe.open = true;
    state.universe.activeMarket = marketOf(state.selected) || 'cn';
    state.universe.query = '';
    state.universe.searchResults = [];
    var search = $('#universe-search');
    if (search) search.value = '';
    var hint = $('#universe-search-hint');
    if (hint) hint.hidden = true;
    renderUniverse();
    renderSmartChips('universe-chips', true);
    loadUniverseMarket(state.universe.activeMarket);
    setTimeout(function () { if (search) search.focus(); }, 60);
  }

  function closeUniverse() {
    var modal = $('#modal-universe');
    if (modal) modal.hidden = true;
    state.universe.open = false;
    state.universe.searchToken += 1;
    state.universe.loadToken += 1;
  }

  async function loadUniverseMarket(market) {
    var token = ++state.universe.loadToken;
    var sort = state.universe.sort;
    state.universe.loading = true;
    state.universe.error = null;
    setUniverseLoading(true);
    renderUniverse();
    try {
      var data = await api('/api/universe?market=' + encodeURIComponent(market) +
        '&limit=100&sort=' + encodeURIComponent(sort));
      if (token !== state.universe.loadToken || !state.universe.open) return;
      var items = (data && Array.isArray(data.items)) ? data.items.map(enrichUniverseItem) : [];
      state.universe.items = items;
      state.universe.source = data && data.source;
      state.universe.updatedAt = data && data.updatedAt;
      state.universe.note = data && data.note;
      state.universe.fallback = false;
      state.universe.cache[market + ':' + sort] = items.slice();
    } catch (err) {
      if (token !== state.universe.loadToken || !state.universe.open) return;
      var cached = state.universe.cache[market + ':' + sort];
      state.universe.error = '标的库加载失败：' + errorText(err) + '。可直接用上方搜索查找标的。';
      if (cached && cached.length) {
        state.universe.items = cached.slice();
        state.universe.note = null;
      } else {
        state.universe.items = universeFallbackItems(market).map(enrichUniverseItem);
        state.universe.note = state.universe.items.length
          ? '当前显示自选/持仓兜底列表' : null;
      }
      state.universe.fallback = true;
    } finally {
      if (token === state.universe.loadToken) {
        state.universe.loading = false;
        setUniverseLoading(false);
        renderUniverse();
      }
    }
  }

  function onUniverseSearchInput() {
    var input = $('#universe-search');
    var query = (input && input.value ? input.value : '').trim();
    state.universe.query = query;
    if (state.universe.searchTimer) clearTimeout(state.universe.searchTimer);
    if (!query) {
      state.universe.searchResults = [];
      state.universe.searchLoading = false;
      var hint = $('#universe-search-hint');
      if (hint) hint.hidden = true;
      renderUniverse();
      return;
    }
    state.universe.searchLoading = true;
    var searchHint = $('#universe-search-hint');
    if (searchHint) {
      searchHint.hidden = false;
      searchHint.textContent = '搜索中…';
    }
    state.universe.searchTimer = setTimeout(function () { runUniverseSearch(query); }, 220);
  }

  async function runUniverseSearch(query) {
    var token = ++state.universe.searchToken;
    try {
      var res = await api('/api/search?q=' + encodeURIComponent(query) + '&limit=30');
      if (token !== state.universe.searchToken || !state.universe.open) return;
      state.universe.searchResults = ((res && res.results) || []).map(enrichUniverseItem);
      state.universe.error = null;
    } catch (err) {
      if (token !== state.universe.searchToken) return;
      state.universe.searchResults = [];
      state.universe.error = '搜索失败：' + errorText(err);
    } finally {
      if (token === state.universe.searchToken) {
        state.universe.searchLoading = false;
        var hint = $('#universe-search-hint');
        if (hint) hint.hidden = true;
        renderUniverse();
      }
    }
  }

  function viewUniverseSymbol(symbol) {
    if (!symbol) return;
    closeUniverse();
    selectSymbol(symbol);
  }

  function onUniverseWatch(symbol) {
    if (!symbol) return;
    if (state.watchlist.indexOf(normalizeSymbol(symbol)) >= 0) return;
    addToWatchlist(symbol).then(function () {
      renderUniverse();
      renderChipsAll();
    });
  }

  function api(path, opts) {
    var options = opts || {};
    if (MOCK && window.MOCK_API) return window.MOCK_API(path, options);
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
    var init = {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    if (controller) init.signal = controller.signal;
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        if (!res.ok) {
          var message = data && data.error && data.error.message ? data.error.message : ('请求失败（HTTP ' + res.status + '）');
          var err = new Error(message);
          err.code = data && data.error ? data.error.code : ('HTTP_' + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function settle(promise) {
    return promise.then(function (value) { return { ok: true, value: value }; },
      function (error) { return { ok: false, error: error }; });
  }

  // ------------------------------------------------------------- formatting

  function marketOf(symbol) { return String(symbol || '').split(':')[0]; }

  // Canonical symbol form per CONTRACTS.md section 2:
  // cn:sh600519 / hk:hk00700 / us:usAAPL / fx:EURUSD / crypto:BTCUSDT.
  // Old aliases (fx:fxEURUSD, crypto:cryptoBTCUSDT) are normalized defensively.
  function normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    var raw = String(symbol).trim();
    var idx = raw.indexOf(':');
    var market = idx >= 0 ? raw.slice(0, idx) : '';
    var rest = idx >= 0 ? raw.slice(idx + 1) : raw;
    if (market === 'fx') return 'fx:' + rest.replace(/^fx/i, '').toUpperCase();
    if (market === 'crypto') return 'crypto:' + rest.replace(/^crypto/i, '').toUpperCase();
    if (market) return market + ':' + rest;
    return raw;
  }

  function precisionFor(symbol, price) {
    var market = marketOf(symbol);
    var p = Math.abs(Number(price) || 0);
    if (market === 'fx') return p >= 1000 ? 2 : p >= 100 ? 3 : 5;
    if (market === 'crypto') return p >= 100 ? 2 : p >= 1 ? 4 : 6;
    return 2;
  }

  function fmtNumber(value, maxDigits, minDigits) {
    if (value == null || !isFinite(value)) return '--';
    var max = maxDigits == null ? 2 : maxDigits;
    var min = minDigits == null ? 0 : minDigits;
    return Number(value).toLocaleString('zh-CN', {
      minimumFractionDigits: min,
      maximumFractionDigits: max
    });
  }

  function fmtPrice(value, symbol) {
    if (value == null || !isFinite(value)) return '--';
    var digits = precisionFor(symbol, value);
    return fmtNumber(value, digits, digits);
  }

  function fmtMoney(value, currency, digits) {
    if (value == null || !isFinite(value)) return '--';
    var d = digits == null ? 2 : digits;
    var abs = roundTo(Math.abs(value), d);
    var sign = abs < 1e-9 ? '' : (value < 0 ? '-' : '');
    return sign + (CURRENCY_SYMBOL[currency] || '') + fmtNumber(abs, d, d);
  }

  function fmtSignedMoney(value, currency, digits, withPlus) {
    if (value == null || !isFinite(value)) return '--';
    var d = digits == null ? 2 : digits;
    var abs = roundTo(Math.abs(value), d);
    var sign = abs < 1e-9 ? '' : (value > 0 ? (withPlus === false ? '' : '+') : '-');
    return sign + (CURRENCY_SYMBOL[currency] || '') + fmtNumber(abs, d, d);
  }

  function fmtPct(value, withPlus) {
    if (value == null || !isFinite(value)) return '--';
    var abs = roundTo(Math.abs(Number(value)), 2);
    var sign = abs < 0.005 ? '' : (value > 0 ? (withPlus === false ? '' : '+') : '-');
    return sign + fmtNumber(abs, 2, 2) + '%';
  }

  function fmtCompact(value) {
    if (value == null || !isFinite(value)) return '--';
    var abs = Math.abs(value);
    if (abs >= 1e8) return fmtNumber(value / 1e8, 2, 2) + '亿';
    if (abs >= 1e4) return fmtNumber(value / 1e4, 2, 2) + '万';
    return fmtNumber(value, 2);
  }

  function qtyDigits(market) {
    if (market === 'fx') return 2;
    if (market === 'crypto') return 4;
    return 0;
  }
  function fmtQty(value, market) {
    if (value == null || !isFinite(value)) return '--';
    var digits = qtyDigits(market);
    return fmtNumber(value, digits, digits === 0 ? 0 : 2);
  }
  function qtyUnit(market) {
    if (market === 'fx') return '单位';
    if (market === 'crypto') return '币';
    return '股';
  }
  function marketLot(market, quote) {
    if (market === 'cn') return 100;
    if (market === 'hk') return (quote && quote.extra && quote.extra.lotSize) || 100;
    if (market === 'us') return 1;
    if (market === 'fx') return 0.01;
    return 0.0001;
  }
  function marketLabel(market) {
    var meta = state.markets[market];
    return meta && meta.name ? meta.name : (MARKET_LABEL[market] || market || '--');
  }

  function beijingDate(iso) {
    var ms = Date.parse(iso);
    if (!isFinite(ms)) return null;
    return new Date(ms + 8 * 3600 * 1000);
  }
  function fmtDateTime(iso, withSeconds) {
    var d = beijingDate(iso);
    if (!d) return '--';
    var out = pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    return withSeconds === false ? out : out + ':' + pad2(d.getUTCSeconds());
  }
  function fmtClock(ms) {
    if (!ms) return '--';
    var d = new Date(ms + 8 * 3600 * 1000);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  function displayCode(symbol, quote) {
    var code = quote && quote.code ? quote.code : String(symbol || '').split(':')[1] || '';
    var market = quote && quote.market ? quote.market : marketOf(symbol);
    if (market === 'cn') return code.replace(/^(sh|sz|bj)/i, '');
    if (market === 'hk') return code.replace(/^hk/i, '');
    if (market === 'us') return code.replace(/^us/i, '');
    if (market === 'fx') {
      var fx = code.replace(/^fx/i, '');
      return fx.length === 6 ? fx.slice(0, 3) + '/' + fx.slice(3) : fx;
    }
    if (market === 'crypto') {
      var c = code.replace(/^crypto/i, '');
      return c.replace(/(USDT|USDC|BTC|ETH)$/, '/$1');
    }
    return code;
  }

  function pnlClass(value) {
    var rounded = Math.round(Number(value) * 100) / 100;
    if (value == null || !isFinite(rounded) || rounded === 0) return 'flat';
    return rounded > 0 ? 'up' : 'down';
  }

  // Shared P&L math so the full render and the live (SSE/poll) patch always
  // agree, including for short positions. Price priority: live quote > snapshot.
  function shanghaiDayKey(value) {
    var d;
    if (typeof value === 'number') d = new Date(value + 8 * 3600 * 1000);
    else d = beijingDate(value);
    if (!d || !isFinite(d.getTime())) return null;
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function positionOpenedToday(pos) {
    if (!pos || !pos.openedAt) return false;
    var openedKey = shanghaiDayKey(pos.openedAt);
    return openedKey != null && openedKey === shanghaiDayKey(Date.now());
  }

  function positionMetrics(pos, quote) {
    var q = quote || quoteOf(pos && pos.symbol);
    var last = q && q.price != null && isFinite(q.price)
      ? Number(q.price)
      : (Number(pos && pos.lastPrice) || 0);
    var avg = Number(pos && pos.avgCost) || 0;
    var qty = Number(pos && pos.qty) || 0;
    var side = positionSide(pos);
    var prevClose = q && q.prevClose != null && isFinite(q.prevClose) ? Number(q.prevClose) : last;
    var unrealized = side === 'short' ? (avg - last) * qty : (last - avg) * qty;
    var unrealizedPct = avg ? (side === 'short' ? (avg - last) / avg : (last / avg - 1)) * 100 : 0;
    // CONTRACTS 6.5: positions opened today measure from their entry price;
    // overnight positions measure from the previous close.
    var todayBase = positionOpenedToday(pos) && avg > 0 ? avg : prevClose;
    var today = (side === 'short' ? todayBase - last : last - todayBase) * qty;
    return {
      last: last,
      avg: avg,
      qty: qty,
      side: side,
      prevClose: prevClose,
      todayBase: todayBase,
      marketValue: qty * last,
      unrealized: unrealized,
      unrealizedPct: unrealizedPct,
      today: today
    };
  }

  function roundTo(value, digits) {
    var f = Math.pow(10, digits);
    return Math.round(value * f) / f;
  }

  // Estimated fee breakdown; the server remains authoritative for actual fees.
  function estimateFeeBreakdown(market, side, qty, price, options) {
    var opts = options || {};
    var notional = (qty || 0) * (price || 0);
    var cfg = feeConfigFor(market);
    var lines = [];
    var total = 0;
    if (!cfg || !notional) return { total: 0, lines: lines };
    var push = function (label, value) {
      var rounded = roundTo(value, 2);
      if (rounded > 0) {
        lines.push({ label: label, value: rounded, currency: opts.currency || 'CNY' });
        total += rounded;
      }
    };
    var sideApplies = function (rule) {
      return !rule || rule === 'both' || rule === side;
    };
    if (market === 'cn') {
      push('佣金', Math.max(notional * cfg.commissionRate, cfg.commissionMin));
      if (sideApplies(cfg.stampDutySide)) push('印花税', notional * cfg.stampDutyRate);
      push('过户费', notional * cfg.transferFeeRate);
    } else if (market === 'hk') {
      push('佣金', Math.max(notional * cfg.commissionRate, cfg.commissionMin));
      if (sideApplies(cfg.stampDutySide)) push('印花税', notional * cfg.stampDutyRate);
      push('交易费', notional * cfg.exchangeFeeRate);
      push('结算费', notional * cfg.settlementFeeRate);
    } else if (market === 'us') {
      push('佣金', Math.max(qty * cfg.perShare, cfg.commissionMin));
      if (sideApplies(cfg.secFeeSide)) push('SEC 费', notional * cfg.secFeeRate);
    } else if (market === 'crypto') {
      push('佣金', notional * cfg.commissionRate);
    } else if (market === 'fx') {
      push('点差成本', notional * (cfg.spreadBps / 2) / 10000);
    }
    if (side === 'buy' && opts.autoConvert && opts.currency && opts.currency !== 'CNY') {
      var nativeCash = Number(opts.nativeCash) || 0;
      var shortfall = Math.max(0, notional + total - nativeCash);
      if (shortfall > 0) {
        var rate = Number(opts.rate) || 1;
        var spread = Number(opts.spread);
        if (!isFinite(spread)) spread = 0.003;
        var conversionCost = shortfall * rate * spread / (1 - spread);
        if (conversionCost > 0.005) {
          lines.push({ label: '换汇成本（' + fmtNumber(spread * 100, 2, 2) + '%）', value: roundTo(conversionCost, 2), currency: 'CNY' });
        }
      }
    }
    return { total: roundTo(total, 2), lines: lines };
  }

  function estimateFees(market, side, qty, price, options) {
    return estimateFeeBreakdown(market, side, qty, price, options).total;
  }

  // Friendly Chinese hints for the order error codes listed in CONTRACTS.md.
  var ORDER_ERROR_HINTS = {
    LOT_SIZE: '数量不符合最小交易单位（A股需为 100 股整数倍）',
    INSUFFICIENT_CASH: '可用现金不足',
    INSUFFICIENT_POSITION: '可卖数量不足（A股当日买入需 T+1 次日才能卖出）',
    INSUFFICIENT_MARGIN: '可用保证金不足',
    PRICE_LIMIT: '委托价超出涨跌停范围',
    NO_LIQUIDITY: '涨跌停板缺少对手盘，暂时无法成交',
    MARKET_CLOSED: '该市场当前休市，市价单无法成交',
    PRICE_INVALID: '委托价格无效',
    QTY_INVALID: '委托数量无效',
    NOT_TRADEABLE: '指数仅用于展示，不能交易',
    DATA_UNAVAILABLE: '行情数据暂不可用，请稍后重试',
    LEVERAGE_NOT_ALLOWED: '该市场不支持杠杆（A股恒为 1x）',
    LEVERAGE_INVALID: '杠杆倍数无效或超出该市场上限',
    SHORT_NOT_ALLOWED: '该市场不支持做空',
    LEVERAGE_MISMATCH: '加仓杠杆需与现有持仓一致',
    POSITION_CONFLICT: '已有反向持仓，请先平仓或使用反手',
    MARGIN_MODE_LOCKED: '有持仓或挂单时不能切换保证金模式',
    PROTECT_PRICE_INVALID: '止盈止损方向不合理：多仓 止盈>现价>止损，空仓相反',
    POSITION_NOT_FOUND: '当前标的没有持仓，无法设置保护',
    ORDER_NOT_AMENDABLE: '该委托当前不可改价（仅未成交限价单可改）',
    ORDER_NOT_FOUND: '委托不存在或已成交/撤销',
    SETTINGS_LOCKED: '有持仓或挂单时不能修改杠杆倍率 / 维持保证金率',
    SETTINGS_INVALID: '账户参数不合法，请检查数值范围',
    NAME_INVALID: '账户名称需为 1–20 个字符',
    ACCOUNT_NOT_FOUND: '账户不存在'
  };

  function orderErrorMessage(err, market) {
    if (!err) return '下单失败，请稍后重试';
    if (err.code === 'LEVERAGE_NOT_ALLOWED' && market && market !== 'cn') {
      return '超过当前账户杠杆上限 ' + maxLeverageFor(market) + 'x，可在账户设置里调高倍率';
    }
    if (err.code === 'SETTINGS_LOCKED') {
      return '有持仓或挂单时不能修改杠杆倍率 / 维持保证金率，请先平仓并撤单';
    }
    var hint = err.code ? ORDER_ERROR_HINTS[err.code] : null;
    var message = errorText(err);
    if (hint) return hint + (message && message !== hint ? '（' + message + '）' : '');
    return message || '下单失败，请稍后重试';
  }

  // ------------------------------------------------------------ quote access

  function currentQuote() { return quoteOf(state.selected); }

  function quoteOf(symbol) {
    if (!symbol) return null;
    if (state.quotes[symbol]) return state.quotes[symbol];
    var canonical = normalizeSymbol(symbol);
    return state.quotes[canonical] || null;
  }

  function cashOf(currency) {
    var view = state.view;
    if (!view) return 0;
    var cash = view.cash || (view.account && view.account.cash) || {};
    return Number(cash[currency]) || 0;
  }

  // Buying power includes the base-currency (CNY) auto-conversion the server
  // performs for foreign-currency symbols (CONTRACTS.md section 6.6). The
  // server pre-computes it; mock.js mirrors the same behaviour.
  function buyingPowerOf(currency) {
    var view = state.view;
    if (!view) return 0;
    if (view.buyingPower && view.buyingPower[currency] != null && isFinite(view.buyingPower[currency])) {
      return Number(view.buyingPower[currency]);
    }
    return cashOf(currency);
  }

  function autoConvertEnabled() {
    var eff = accountEffective();
    if (eff && typeof eff.autoConvert === 'boolean') return eff.autoConvert;
    return !!(state.view && state.view.autoConvert);
  }

  function fxConvertSpread() {
    var eff = accountEffective();
    var spread = eff && eff.fxConvertSpread != null ? eff.fxConvertSpread
      : (state.view && state.view.fxConvertSpread);
    return isFinite(spread) ? Number(spread) : 0.003;
  }

  function fxRateOf(currency) {
    var view = state.view;
    if (!view || !view.fxRates) return 1;
    return Number(view.fxRates[currency]) || 1;
  }

  function findPosition(symbol) {
    var view = state.view;
    if (!view || !Array.isArray(view.positions)) return null;
    for (var i = 0; i < view.positions.length; i++) {
      if (view.positions[i].symbol === symbol) return view.positions[i];
    }
    return null;
  }

  function availableQty(symbol) {
    var pos = findPosition(symbol);
    if (!pos) return 0;
    return Number(pos.availableQty != null ? pos.availableQty : pos.qty) || 0;
  }

  function collectSymbols() {
    var seen = {};
    var out = [];
    function add(symbol) {
      symbol = normalizeSymbol(symbol);
      if (!symbol || seen[symbol]) return;
      seen[symbol] = true;
      out.push(symbol);
    }
    add(state.selected);
    state.watchlist.forEach(add);
    var view = state.view;
    if (view && Array.isArray(view.positions)) view.positions.forEach(function (p) { add(p.symbol); });
    return out;
  }

  // ------------------------------------------------------------------- boot

  function init() {
    state.prefs = loadPrefs();
    if (state.prefs.chartMode === 'line') state.chartMode = 'line';
    if (VALID_TABS.indexOf(state.prefs.activeTab) >= 0) state.activeTab = state.prefs.activeTab;
    on(window, 'error', function (event) {
      reportError(event.error || event.message || '未知脚本错误');
    });
    on(window, 'unhandledrejection', function (event) {
      reportError(event.reason || '未处理的异步错误');
    });
    bindEvents();
    applyTabUI();
    if (MOCK) {
      var chip = $('#mode-chip');
      if (chip) chip.hidden = false;
    }
    if (!window.Charts) showBanner('图表库加载失败，请检查 public/vendor/lightweight-charts.standalone.production.js');
    boot();
  }

  async function boot() {
    try {
      var results = await Promise.all([
        settle(api('/api/markets')),
        settle(api('/api/watchlist')),
        settle(api('/api/health')),
        settle(api('/api/settings/meta'))
      ]);
      var marketsRes = results[0];
      var watchRes = results[1];
      var healthRes = results[2];
      var settingsRes = results[3];

      if (settingsRes && settingsRes.ok && settingsRes.value && Array.isArray(settingsRes.value.markets)) {
        state.settingsMeta = settingsRes.value;
      } else {
        state.settingsMeta = fallbackSettingsMeta();
      }

      if (marketsRes.ok) {
        state.marketList = (marketsRes.value && marketsRes.value.markets) || [];
        state.markets = {};
        state.marketList.forEach(function (meta) { state.markets[meta.id] = meta; });
      } else {
        showBanner('行情元数据加载失败：' + errorText(marketsRes.error));
      }
      if (watchRes.ok) {
        state.watchlist = ((watchRes.value && watchRes.value.symbols) || []).map(normalizeSymbol);
      }
      if (healthRes.ok) state.health = healthRes.value;
      else showBanner('数据源健康检查失败：' + errorText(healthRes.error));

      if (state.prefs.accountId) state.accountId = state.prefs.accountId;
      renderAll();
      renderSourceBanner();
      await refreshAccounts();
      var initialSymbol = null;
      if (state.prefs.selectedSymbol && state.watchlist.indexOf(state.prefs.selectedSymbol) >= 0) {
        initialSymbol = state.prefs.selectedSymbol;
      }
      if (!initialSymbol && state.watchlist.length) initialSymbol = state.watchlist[0];
      if (initialSymbol) {
        await selectSymbol(initialSymbol);
      } else {
        renderAll();
      }
      await refreshQuotes();
      renderAll();
      await loadActiveTabData();
    } catch (err) {
      reportError(err);
    } finally {
      renderConnection();
      markReady();
      loadActiveTabData();
      startAccountTimer();
      startSelectedPolling();
      initRealtime();
      loadTradableCandidates();
      if (!state.prefs.onboardingSeen && !state.accountModalRequired) {
        setTimeout(function () {
          if (!state.onboardingActive && !state.accountModalRequired) openOnboarding();
        }, 550);
      }
    }
  }

  function markReady() {
    state.ready = true;
    document.body.dataset.appReady = '1';
    if (MOCK) document.body.dataset.mock = '1';
    window.__APP_READY = true;
    // Debug hooks used by the headless verification scripts.
    window.__APP_DEBUG = {
      state: state,
      api: api,
      marketIsOpen: marketIsOpen,
      computeMarketStatus: computeMarketStatus,
      loadTradableCandidates: loadTradableCandidates,
      renderChipsAll: renderChipsAll,
      chipsData: chipsData,
      openUniverse: openUniverse,
      closeUniverse: closeUniverse
    };
  }

  function reportError(err) {
    var message = errorText(err);
    window.__APP_ERRORS.push(message);
    try { document.body.dataset.appError = '1'; } catch (e) { /* noop */ }
    showBanner('前端错误：' + message);
    if (window.console && console.error) console.error('[app]', err);
  }

  function errorText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  // ------------------------------------------------------- realtime transport

  function startAccountTimer() {
    stopAccountTimer();
    state.accountTimer = setInterval(accountTick, REFRESH_MS);
  }
  function stopAccountTimer() {
    if (state.accountTimer) { clearInterval(state.accountTimer); state.accountTimer = null; }
  }

  async function accountTick() {
    if (state.accountTickBusy) return;
    state.accountTickBusy = true;
    try {
      var tasks = [];
      if (state.accountId) tasks.push(loadAccountView(state.accountEpoch));
      if (state.stream.mode !== 'stream') tasks.push(refreshQuotes());
      await Promise.allSettled(tasks);
      state.healthCounter += REFRESH_MS;
      if (state.healthCounter >= HEALTH_MS) {
        state.healthCounter = 0;
        refreshHealth();
      }
      renderAll();
      if (Date.now() - state.chips.loadedAt > 20000) loadTradableCandidates();
      if (state.accountId && Date.now() - state.auxLoadedAt > AUX_REFRESH_MS &&
        state.activeTab !== 'positions' && state.activeTab !== 'orders') {
        state.auxLoadedAt = Date.now();
        loadActiveTabData();
      }
    } catch (err) {
      reportError(err);
    } finally {
      state.accountTickBusy = false;
    }
  }

  async function pollNow() {
    await refreshQuotes();
    if (state.accountId) await loadAccountView(state.accountEpoch);
    renderAll();
  }

  var SOURCE_MARKET_FALLBACK = {
    tencent: ['cn', 'hk'],
    'tencent-fx': ['fx'],
    binance: ['crypto'],
    coingecko: ['crypto'],
    yahoo: ['us', 'fx'],
    sina: ['cn', 'us']
  };
  var CRITICAL_SOURCE_FALLBACK = { tencent: true, 'tencent-fx': true, binance: true, yahoo: true };

  function quoteErrorFor(symbol) {
    var key = normalizeSymbol(symbol || '');
    return state.quoteErrorMap[key] || null;
  }

  function sourceNameOf(source) {
    return (source && (source.source || source.name)) || 'unknown';
  }

  function sourceMarketsOf(source) {
    if (source && Array.isArray(source.markets) && source.markets.length) return source.markets.slice();
    if (source && typeof source.markets === 'string' && source.markets) return source.markets.split(',');
    return SOURCE_MARKET_FALLBACK[sourceNameOf(source)] || [];
  }

  function sourceCriticalOf(source) {
    if (source && typeof source.critical === 'boolean') return source.critical;
    return !!CRITICAL_SOURCE_FALLBACK[sourceNameOf(source)];
  }

  function sourceMarketsLabel(source) {
    var markets = sourceMarketsOf(source);
    return markets.map(function (market) { return marketLabel(market); }).join('/');
  }

  function sourceShortMessage(source) {
    if (!source) return '';
    return String(source.hint || source.message || '').trim();
  }

  function sourceBannerMutedUntil() {
    try {
      var value = Number(localStorage.getItem(SOURCE_BANNER_MUTE_KEY));
      return isFinite(value) ? value : 0;
    } catch (e) { return state.sourceBannerMutedUntil || 0; }
  }

  function muteSourceBanner() {
    state.sourceBannerMutedUntil = Date.now() + 10 * 60 * 1000;
    try { localStorage.setItem(SOURCE_BANNER_MUTE_KEY, String(state.sourceBannerMutedUntil)); } catch (e) { /* ignore */ }
    var banner = $('#source-banner');
    if (banner) banner.hidden = true;
  }

  function renderSourceBanner() {
    var banner = $('#source-banner');
    if (!banner) return;
    var health = state.health;
    if (!health || !Array.isArray(health.sources)) {
      banner.hidden = true;
      return;
    }
    var failures = health.sources.filter(function (source) {
      return source && source.ok === false && sourceCriticalOf(source);
    });
    if (!failures.length) {
      banner.hidden = true;
      return;
    }
    if (Date.now() < sourceBannerMutedUntil()) {
      banner.hidden = true;
      return;
    }
    var parts = failures.map(function (source) {
      var markets = sourceMarketsLabel(source);
      var message = sourceShortMessage(source);
      return (markets ? markets + '行情' : '数据源') + (message ? '（' + message + '）' : '');
    });
    var text = '部分数据源不可用：' + (health.hint || parts.join('；'));
    setText('#source-banner-text', text);
    banner.hidden = false;
  }

  function sourceRowHTML(source) {
    var ok = source && source.ok !== false;
    var name = sourceNameOf(source);
    var markets = sourceMarketsLabel(source);
    var message = String((source && source.message) || '');
    var hint = String((source && source.hint) || '');
    var latency = source && source.latencyMs != null && isFinite(source.latencyMs) ? Math.round(source.latencyMs) + 'ms' : '--';
    var critical = sourceCriticalOf(source);
    return '<div class="source-row ' + (ok ? 'is-ok' : 'is-fail') + '">' +
      '<span class="source-dot" data-state="' + (ok ? 'ok' : 'fail') + '"></span>' +
      '<div class="source-main"><div class="source-line"><b>' + escapeHtml(name) + '</b>' +
      '<span class="source-badge' + (critical ? '' : ' is-backup') + '">' + (critical ? '核心' : '备用') + '</span>' +
      (markets ? '<span class="source-markets">影响：' + escapeHtml(markets) + '</span>' : '') +
      '</div><div class="source-msg">' + escapeHtml(ok ? (message || '正常') : (message || '连接失败')) + '</div>' +
      (hint ? '<div class="source-hint-line">' + escapeHtml(hint) + '</div>' : '') +
      '</div><span class="source-lat ' + (ok ? 'is-ok' : 'is-fail') + '">' + escapeHtml(latency) + '</span></div>';
  }

  function sourceProxyRelated(failures) {
    if (!failures.length) return false;
    return failures.some(function (source) {
      var name = sourceNameOf(source);
      if (['binance', 'coingecko', 'yahoo'].indexOf(name) >= 0) return true;
      var text = [source.message, source.hint, state.health && state.health.hint].join(' ');
      return /代理|proxy/i.test(text);
    });
  }

  function renderSourcesModal() {
    var list = $('#source-list');
    if (!list) return;
    var health = state.health;
    var errorEl = $('#source-error');
    if (!health || !Array.isArray(health.sources)) {
      list.innerHTML = '<div class="source-row is-fail"><span class="source-dot" data-state="fail"></span><div class="source-main"><div class="source-line"><b>数据源状态</b></div><div class="source-msg">' +
        escapeHtml(state.lastHealthError || '暂时无法获取数据源状态，请稍后刷新') + '</div></div></div>';
      setText('#source-summary', '数据源状态获取失败');
      setText('#source-hint', '');
      var proxyNote = $('#source-proxy-note');
      if (proxyNote) proxyNote.hidden = true;
      return;
    }
    var sources = health.sources || [];
    var okCount = sources.filter(function (source) { return source.ok !== false; }).length;
    var criticalFailures = sources.filter(function (source) { return source.ok === false && sourceCriticalOf(source); });
    var summary = '共 ' + sources.length + ' 个来源，正常 ' + okCount + ' 个';
    if (criticalFailures.length) summary += '，核心源异常 ' + criticalFailures.length + ' 个';
    else if (sources.length > okCount) summary += '，部分备用源异常';
    setText('#source-summary', summary + (health.serverTime ? ' · ' + fmtClock(Date.parse(health.serverTime)) : ''));
    list.innerHTML = sources.map(sourceRowHTML).join('') || '<div class="source-msg">暂无数据源信息</div>';
    setText('#source-hint', health.hint || '核心源异常时会影响对应市场的实时行情；可启动/修复本机代理后刷新。');
    var proxyNote = $('#source-proxy-note');
    if (proxyNote) proxyNote.hidden = !(sourceProxyRelated(criticalFailures) ||
      sourceProxyRelated(sources.filter(function (source) { return source.ok === false; })));
    if (errorEl) errorEl.hidden = true;
  }

  function openSourcesModal() {
    openModal('modal-sources');
    renderSourcesModal();
    refreshHealth();
  }

  async function refreshHealth() {
    var btn = $('#btn-source-refresh');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '刷新中…';
    }
    try {
      state.health = await api('/api/health');
      state.lastHealthError = null;
    } catch (err) {
      state.health = null;
      state.lastHealthError = errorText(err);
    }
    renderConnection();
    renderSourceBanner();
    if ($('#modal-sources') && !$('#modal-sources').hidden) renderSourcesModal();
    if (btn) {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  }

  function startQuotePolling() {
    if (state.quotePollTimer) return;
    state.quotePollTimer = setInterval(function () { refreshQuotes(); }, REFRESH_MS);
    refreshQuotes();
  }
  function stopQuotePolling() {
    if (state.quotePollTimer) {
      clearInterval(state.quotePollTimer);
      state.quotePollTimer = null;
    }
  }

  function initRealtime() {
    state.stream.mode = 'connecting';
    renderConnection();
    if (MOCK) {
      startMockStream();
      startStreamWatchdog();
      return;
    }
    if (typeof EventSource === 'undefined') {
      fallbackToPolling('浏览器不支持实时推送，已切换轮询');
      return;
    }
    connectStream();
    startStreamWatchdog();
  }

  function startMockStream() {
    if (!window.MOCK_STREAM_OPEN) {
      fallbackToPolling('模拟推送不可用，已切换轮询');
      return;
    }
    if (state.stream.mockClose) state.stream.mockClose();
    state.stream.mode = 'stream';
    state.stream.lastQuotesFrameAt = Date.now();
    state.stream.mockClose = window.MOCK_STREAM_OPEN(
      function () { return collectSymbols(); },
      function (frame) {
        applyQuotesFrame(frame.quotes || [], frame.errors || []);
      }
    );
    renderConnection();
  }

  function connectStream() {
    if (MOCK) return;
    if (state.stream.es) {
      try { state.stream.es.close(); } catch (e) { /* noop */ }
      state.stream.es = null;
    }
    if (state.stream.reconnectTimer) {
      clearTimeout(state.stream.reconnectTimer);
      state.stream.reconnectTimer = null;
    }
    var es;
    try {
      es = new EventSource('/api/stream');
    } catch (err) {
      fallbackToPolling('实时推送连接失败，已切换轮询');
      scheduleStreamReconnect();
      return;
    }
    state.stream.es = es;
    es.addEventListener('quotes', function (event) { handleStreamEvent('quotes', event); });
    es.addEventListener('heartbeat', function (event) { handleStreamEvent('heartbeat', event); });
    es.onerror = function () {
      try { es.close(); } catch (e) { /* noop */ }
      if (state.stream.es === es) state.stream.es = null;
      fallbackToPolling('实时推送断开，已切换轮询');
      scheduleStreamReconnect();
    };
  }

  function handleStreamEvent(kind, event) {
    state.stream.lastActivityAt = Date.now();
    if (kind === 'heartbeat') {
      renderConnection();
      return;
    }
    var data = null;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (!data) return;
    state.stream.lastQuotesFrameAt = Date.now();
    if (state.stream.mode !== 'stream') {
      state.stream.mode = 'stream';
      state.stream.fallbackReason = null;
      stopQuotePolling();
      renderConnection();
    }
    applyQuotesFrame(data.quotes || [], data.errors || []);
  }

  function fallbackToPolling(reason) {
    if (state.stream.mode === 'poll') return;
    var wasStream = state.stream.mode === 'stream';
    state.stream.mode = 'poll';
    state.stream.fallbackReason = reason || null;
    // The 2s account timer already refreshes quotes when not in stream mode;
    // trigger one immediate refresh so the UI does not sit stale.
    refreshQuotes();
    renderConnection();
    if (wasStream) showToast(reason || '实时推送不可用，已切换为轮询', 'warn');
  }

  function scheduleStreamReconnect() {
    if (MOCK || state.stream.reconnectTimer) return;
    state.stream.reconnectTimer = setTimeout(function () {
      state.stream.reconnectTimer = null;
      if (state.stream.mode === 'stream') return;
      connectStream();
    }, 5000);
  }

  function startStreamWatchdog() {
    if (state.stream.watchdogTimer) clearInterval(state.stream.watchdogTimer);
    state.stream.watchdogTimer = setInterval(function () {
      if (MOCK) return;
      if (state.stream.mode === 'stream' &&
        state.stream.lastQuotesFrameAt &&
        Date.now() - state.stream.lastQuotesFrameAt > STREAM_HEALTH_WINDOW_MS) {
        fallbackToPolling('实时推送超过 5 秒无数据，已切换轮询');
        if (state.stream.es) {
          try { state.stream.es.close(); } catch (e) { /* noop */ }
          state.stream.es = null;
        }
        scheduleStreamReconnect();
      } else if (state.stream.mode === 'poll') {
        renderConnection();
      }
    }, 1000);
  }

  function startSelectedPolling() {
    if (state.selectedPollTimer) return;
    state.selectedPollTimer = setInterval(function () {
      // Only the SSE transport needs this fallback: the active symbol might be
      // outside the server push set (searched but not in watchlist/holdings).
      if (state.stream.mode === 'stream' && state.selected && !isSymbolCovered(state.selected)) {
        pollSelectedSymbol();
      }
    }, REFRESH_MS);
  }

  async function pollSelectedSymbol() {
    if (!state.selected) return;
    try {
      var res = await api('/api/quotes?symbols=' + encodeURIComponent(state.selected));
      applyQuotesFrame(res.quotes || [], res.errors || []);
    } catch (err) { /* fallback polling will retry */ }
  }

  function isSymbolCovered(symbol) {
    if (!symbol) return false;
    if (state.watchlist.indexOf(symbol) >= 0) return true;
    if (!state.view) return false;
    var inPositions = (state.view.positions || []).some(function (p) { return p.symbol === symbol; });
    if (inPositions) return true;
    return (state.view.openOrders || []).some(function (o) { return o.symbol === symbol; });
  }

  async function refreshQuotes() {
    var symbols = collectSymbols();
    if (!symbols.length) {
      state.lastQuoteAt = Date.now();
      renderConnection();
      return;
    }
    try {
      var res = await api('/api/quotes?symbols=' + symbols.map(encodeURIComponent).join(','));
      state.lastQuoteError = null;
      applyQuotesFrame(res.quotes || [], res.errors || []);
    } catch (err) {
      state.lastQuoteError = errorText(err);
      renderConnection();
    }
  }

  function applyQuotesFrame(quotes, errors) {
    var dirs = {};
    var previousErrorKeys = Object.keys(state.quoteErrorMap).sort().join(',');
    (quotes || []).forEach(function (quote) {
      if (!quote || !quote.symbol) return;
      var prev = state.quotes[quote.symbol];
      var oldPrice = prev && isFinite(prev.price) ? prev.price : state.flashPrev[quote.symbol];
      var dir = directionOf(oldPrice, quote.price);
      if (dir) dirs[quote.symbol] = dir;
      if (quote.price != null && isFinite(quote.price)) state.flashPrev[quote.symbol] = quote.price;
      state.quotes[quote.symbol] = quote;
    });
    state.quoteErrors = errors || [];
    state.quoteErrorMap = {};
    state.quoteErrors.forEach(function (error) {
      if (!error) return;
      var key = normalizeSymbol(error.symbol || '');
      if (!key) return;
      state.quoteErrorMap[key] = { message: error.message || '数据源不可用' };
      delete state.quotes[key];
    });
    state.lastQuoteAt = Date.now();
    state.stream.lastQuotesFrameAt = Date.now();
    var selectedError = quoteErrorFor(state.selected);
    if (selectedError) {
      state.chartQuoteError = true;
      setChartPlaceholder(sourceUnavailableText(selectedError.message), true);
    } else if (state.chartQuoteError) {
      state.chartQuoteError = false;
      loadChart();
    }
    if (previousErrorKeys !== Object.keys(state.quoteErrorMap).sort().join(',')) renderWatchlist();
    updateLiveUI(dirs);
    renderConnection();
  }

  // --------------------------------------------------------------- accounts

  async function refreshAccounts(preferId) {
    var res = await settle(api('/api/accounts'));
    if (!res.ok) {
      showBanner('账户列表加载失败：' + errorText(res.error));
      renderAll();
      return;
    }
    state.accounts = (res.value && res.value.accounts) || [];
    syncAccountSelect();
    var id = preferId;
    if (!id && state.accountId) {
      var keep = state.accounts.some(function (a) { return a.id === state.accountId; });
      if (keep) id = state.accountId;
    }
    if (!id && state.accounts.length) id = state.accounts[0].id;

    if (!id) {
      state.accountId = null;
      state.view = null;
      state.accounts = [];
      renderAll();
      if (!state.accountModalRequired) openCreateAccount(true);
      return;
    }
    await selectAccount(id);
  }

  async function selectAccount(id) {
    if (!id) return;
    state.accountId = id;
    patchPrefs({ accountId: id });
    var epoch = ++state.accountEpoch;
    state.view = null;
    state.orderHint = null;
    state.orderHintUntil = 0;
    state.orderAction = 'long';
    state.showTpSl = false;
    clearTpslInputs();
    state.editingOrderId = null;
    state.editingPrice = '';
    state.liquidationBaselineDone = false;
    state.seenLiquidations = {};
    state.historyOrders = [];
    state.trades = [];
    state.stats = null;
    state.equity = null;
    state.auxLoadedAt = 0;
    if (state.equityChart) {
      state.equityChart.destroy();
      state.equityChart = null;
    }
    syncAccountSelect();
    renderAll();
    await loadAccountView(epoch);
    if (epoch !== state.accountEpoch) return;
    await refreshQuotes();
    renderAll();
    state.auxLoadedAt = Date.now();
    loadTradableCandidates();
    loadActiveTabData();
  }

  async function loadAccountView(epoch) {
    if (!state.accountId) return;
    try {
      var view = await api('/api/accounts/' + encodeURIComponent(state.accountId));
      if (epoch !== state.accountEpoch) return;
      if (!view || !view.account) return;
      state.view = view;
      if (view.account.cash && !view.cash) view.cash = view.account.cash;
      processLiquidations(view.liquidations);
      if (state.orderAction === 'close' && !currentPosition()) state.orderAction = 'long';
      if (state.editingOrderId) {
        var stillOpen = (view.openOrders || []).some(function (order) { return order.id === state.editingOrderId; });
        if (!stillOpen) {
          state.editingOrderId = null;
          state.editingPrice = '';
        }
      }
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      showBanner('账户数据加载失败：' + errorText(err));
    }
  }

  function syncAccountSelect() {
    var select = $('#account-select');
    if (!select) return;
    if (!state.accounts.length) {
      select.innerHTML = '<option value="">暂无账户</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = state.accounts.map(function (account) {
      return '<option value="' + escapeHtml(account.id) + '">' + escapeHtml(account.name) + '</option>';
    }).join('');
    if (state.accountId) select.value = state.accountId;
  }

  // ------------------------------------------------------- account settings

  function mergeDeep(base, patch) {
    var out = cloneDeep(base || {});
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach(function (key) {
      var value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = mergeDeep(out[key] || {}, value);
      } else {
        out[key] = cloneDeep(value);
      }
    });
    return out;
  }

  function getPath(obj, path) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }

  function defaultSettingsDeep() {
    var fallback = fallbackSettingsMeta().defaults.settings;
    var defaults = (settingsMeta().defaults && settingsMeta().defaults.settings) || {};
    return mergeDeep(fallback, defaults);
  }

  function formatRatePercent(value) {
    var abs = Math.abs(Number(value));
    if (!isFinite(abs)) return '0%';
    var digits = abs >= 1 ? 2 : abs >= 0.1 ? 3 : 4;
    var text = Number(value).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
    return (text === '-0' ? '0' : text) + '%';
  }

  function formatSettingsValue(field, value) {
    if (value == null || !isFinite(Number(value))) return '--';
    var num = Number(value);
    if (field.kind === 'pct') return formatRatePercent(num * 100);
    if (field.kind === 'bps') return fmtNumber(num, 2, 0) + ' bp';
    if (field.unit === '¥') return '¥' + fmtNumber(num, 4, 2);
    if (field.unit === 'HK$') return 'HK$' + fmtNumber(num, 4, 2);
    if (field.unit === '$') return '$' + fmtNumber(num, 4, 2);
    if (field.unit === '$/股') return '$' + fmtNumber(num, 4, 2) + '/股';
    return fmtNumber(num, 4, 2) + (field.unit ? ' ' + field.unit : '');
  }

  function settingsFieldRange(field) {
    var ranges = settingsMeta().ranges || {};
    if (field.rangeKey && field.rangeKey.indexOf('fees.') === 0) {
      var key = field.rangeKey.slice(5);
      return (ranges.fees && ranges.fees[key]) || [0, 1];
    }
    if (field.rangeKey === 'slippageBps') return ranges.slippageBps || [0, 200];
    if (field.rangeKey === 'margin.mmr') return (ranges.margin && ranges.margin.mmr && ranges.margin.mmr[field.market]) || [0.0005, 0.1];
    if (field.rangeKey === 'margin.interestAnnual') return (ranges.margin && ranges.margin.interestAnnual) || [0, 0.5];
    if (field.rangeKey === 'margin.liquidationFeeRate') return (ranges.margin && ranges.margin.liquidationFeeRate) || [0, 0.05];
    if (field.rangeKey === 'fxConvertSpread') return ranges.fxConvertSpread || [0, 0.02];
    return null;
  }

  function settingsFieldDefinitions() {
    function field(path, label, kind, unit, rangeKey, market, risk) {
      return { path: path, label: label, kind: kind, unit: unit || '', rangeKey: rangeKey || '', market: market || '', risk: !!risk };
    }
    return [
      {
        title: '手续费',
        groups: [
          { sub: 'A股', fields: [
            field('fees.cn.commissionRate', '佣金率', 'pct', '%', 'fees.commissionRate'),
            field('fees.cn.commissionMin', '最低佣金', 'num', '¥', 'fees.commissionMin'),
            field('fees.cn.stampDutyRate', '印花税率', 'pct', '%', 'fees.stampDutyRate'),
            field('fees.cn.transferFeeRate', '过户费率', 'pct', '%', 'fees.transferFeeRate')
          ] },
          { sub: '港股', fields: [
            field('fees.hk.commissionRate', '佣金率', 'pct', '%', 'fees.commissionRate'),
            field('fees.hk.commissionMin', '最低佣金', 'num', 'HK$', 'fees.commissionMin'),
            field('fees.hk.stampDutyRate', '印花税率', 'pct', '%', 'fees.stampDutyRate'),
            field('fees.hk.exchangeFeeRate', '交易费率', 'pct', '%', 'fees.exchangeFeeRate'),
            field('fees.hk.settlementFeeRate', '结算费率', 'pct', '%', 'fees.settlementFeeRate')
          ] },
          { sub: '美股', fields: [
            field('fees.us.perShare', '每股佣金', 'num', '$/股', 'fees.perShare'),
            field('fees.us.commissionMin', '最低佣金', 'num', '$', 'fees.commissionMin'),
            field('fees.us.secFeeRate', 'SEC 费率', 'pct', '%', 'fees.secFeeRate')
          ] },
          { sub: '外汇 / 加密', fields: [
            field('fees.fx.spreadBps', '外汇点差', 'bps', 'bp', 'fees.spreadBps'),
            field('fees.crypto.commissionRate', '加密佣金率', 'pct', '%', 'fees.commissionRate')
          ] }
        ]
      },
      {
        title: '滑点与换汇',
        groups: [
          { fields: [
            field('slippageBps.cn', 'A股滑点', 'bps', 'bp', 'slippageBps'),
            field('slippageBps.hk', '港股滑点', 'bps', 'bp', 'slippageBps'),
            field('slippageBps.us', '美股滑点', 'bps', 'bp', 'slippageBps'),
            field('slippageBps.fx', '外汇滑点', 'bps', 'bp', 'slippageBps'),
            field('slippageBps.crypto', '加密滑点', 'bps', 'bp', 'slippageBps'),
            field('fxConvertSpread', '自动换汇成本', 'pct', '%', 'fxConvertSpread')
          ] }
        ]
      },
      {
        title: '保证金与利息',
        note: 'A股固定：维持保证金率 100%、借币利率 0、强平费 0（无杠杆）。',
        groups: [
          { sub: '维持保证金率', fields: [
            field('margin.mmr.hk', '港股 mmr', 'pct', '%', 'margin.mmr', 'hk', true),
            field('margin.mmr.us', '美股 mmr', 'pct', '%', 'margin.mmr', 'us', true),
            field('margin.mmr.fx', '外汇 mmr', 'pct', '%', 'margin.mmr', 'fx', true),
            field('margin.mmr.crypto', '加密 mmr', 'pct', '%', 'margin.mmr', 'crypto', true)
          ] },
          { sub: '借币年化利率', fields: [
            field('margin.interestAnnual.hk', '港股利率', 'pct', '%', 'margin.interestAnnual', 'hk', true),
            field('margin.interestAnnual.us', '美股利率', 'pct', '%', 'margin.interestAnnual', 'us', true),
            field('margin.interestAnnual.fx', '外汇利率', 'pct', '%', 'margin.interestAnnual', 'fx', true),
            field('margin.interestAnnual.crypto', '加密利率', 'pct', '%', 'margin.interestAnnual', 'crypto', true)
          ] },
          { sub: '强平费率', fields: [
            field('margin.liquidationFeeRate.hk', '港股强平费', 'pct', '%', 'margin.liquidationFeeRate', 'hk', true),
            field('margin.liquidationFeeRate.us', '美股强平费', 'pct', '%', 'margin.liquidationFeeRate', 'us', true),
            field('margin.liquidationFeeRate.fx', '外汇强平费', 'pct', '%', 'margin.liquidationFeeRate', 'fx', true),
            field('margin.liquidationFeeRate.crypto', '加密强平费', 'pct', '%', 'margin.liquidationFeeRate', 'crypto', true)
          ] }
        ]
      }
    ];
  }

  function settingsFieldsFlat() {
    var out = [];
    settingsFieldDefinitions().forEach(function (section) {
      section.groups.forEach(function (group) {
        group.fields.forEach(function (field) { out.push(field); });
      });
    });
    return out;
  }

  function settingsFieldByPath(path) {
    var list = settingsFieldsFlat();
    for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i];
    return null;
  }

  function settingDisplayInputValue(field, value) {
    if (field.kind === 'bool') return !!value;
    var num = Number(value);
    if (!isFinite(num)) num = 0;
    if (field.kind === 'pct') num = roundTo(num * 100, 6);
    return String(num);
  }

  function settingInputToValue(field, raw) {
    var num = Number(raw);
    if (!isFinite(num)) return NaN;
    if (field.kind === 'pct') return num / 100;
    return num;
  }

  function currentSettingsMultiplier() {
    var range = $('#settings-mult-range');
    var value = range ? Number(range.value) : 1;
    return isFinite(value) ? value : 1;
  }

  function mmrCapFor(market, multiplier) {
    if (market === 'cn') return 1;
    var lev = multiplierLeverage(market, multiplier);
    return lev > 0 ? 0.9 / lev : 1;
  }

  function settingsMmrCapsText(multiplier) {
    var hk = mmrCapFor('hk', multiplier);
    var us = mmrCapFor('us', multiplier);
    var fx = mmrCapFor('fx', multiplier);
    var crypto = mmrCapFor('crypto', multiplier);
    var hkUs = hk === us
      ? '港股/美股 ' + formatRatePercent(hk * 100)
      : '港股 ' + formatRatePercent(hk * 100) + '、美股 ' + formatRatePercent(us * 100);
    return hkUs + '、外汇 ' + formatRatePercent(fx * 100) + '、加密 ' + formatRatePercent(crypto * 100);
  }

  function validateSettingsField(input) {
    if (!input || input.disabled) return null;
    var path = input.getAttribute('data-setting-path');
    var field = settingsFieldByPath(path);
    if (!field || field.kind === 'bool') return null;
    var raw = Number(input.value);
    var value = field.kind === 'pct' ? raw / 100 : raw;
    var error = '';
    if (!isFinite(raw)) {
      error = '请输入有效数字';
    } else {
      var range = settingsFieldRange(field);
      if (range && (value < range[0] - 1e-12 || value > range[1] + 1e-12)) {
        error = '需在 ' + formatSettingsValue(field, range[0]) + ' – ' + formatSettingsValue(field, range[1]) + ' 之间';
      }
      if (!error && field.path.indexOf('margin.mmr.') === 0 && field.market) {
        var mult = currentSettingsMultiplier();
        var cap = mmrCapFor(field.market, mult);
        if (value > cap + 1e-12) {
          error = '当前倍率下最高 ' + formatRatePercent(cap * 100) +
            '（0.9 ÷ ' + multiplierLeverage(field.market, mult) + 'x）';
        }
      }
    }
    input.classList.toggle('is-invalid', !!error);
    var errorEl = document.querySelector('#account-settings-fields [data-setting-error="' + path + '"]');
    if (errorEl) {
      errorEl.hidden = !error;
      errorEl.textContent = error;
    }
    return error;
  }

  function validateAllSettingsFields() {
    var errors = [];
    $$('#account-settings-fields [data-setting-path]').forEach(function (input) {
      var field = settingsFieldByPath(input.getAttribute('data-setting-path'));
      var error = validateSettingsField(input);
      if (error && field) errors.push(field.label + '：' + error);
    });
    return errors;
  }

  function clampMmrToMultiplier(multiplier) {
    var adjusted = [];
    ['hk', 'us', 'fx', 'crypto'].forEach(function (market) {
      var path = 'margin.mmr.' + market;
      var input = document.querySelector('#account-settings-fields [data-setting-path="' + path + '"]');
      if (!input || input.disabled) return;
      var field = settingsFieldByPath(path);
      if (!field) return;
      var cap = mmrCapFor(market, multiplier);
      var value = settingInputToValue(field, input.value);
      if (isFinite(value) && value > cap + 1e-12) {
        input.value = settingDisplayInputValue(field, cap);
        adjusted.push(market);
      }
      validateSettingsField(input);
    });
    return adjusted;
  }

  function refreshMmrClampNote(multiplier, adjusted) {
    var note = $('#settings-mmr-clamp-note');
    if (!note) return;
    var caps = settingsMmrCapsText(multiplier);
    if (adjusted && adjusted.length) {
      var names = adjusted.map(function (market) {
        return market === 'hk' ? '港股' : market === 'us' ? '美股' : market === 'fx' ? '外汇' : '加密';
      });
      note.textContent = '已按倍率把维持保证金率上限调整为 ' + caps + '（自动夹紧：' + names.join('、') + '）';
    } else {
      note.textContent = '当前倍率下维持保证金率上限：' + caps;
    }
    note.hidden = false;
  }

  function onSettingsMultiplierChanged() {
    state.settingsPreset = null;
    state.settingsFormDirty = true;
    var multiplier = currentSettingsMultiplier();
    var adjusted = clampMmrToMultiplier(multiplier);
    updateSettingsMultiplierUI();
    refreshMmrClampNote(multiplier, adjusted);
  }

  function renderSettingsFields(settings) {
    var host = $('#account-settings-fields');
    if (!host) return;
    var defaults = defaultSettingsDeep();
    var locked = state.settingsLocked;
    var html = settingsFieldDefinitions().map(function (section) {
      var body = section.groups.map(function (group) {
        var rows = group.fields.map(function (field) {
          var value = getPath(settings, field.path);
          if (value == null) value = getPath(defaults, field.path);
          var range = settingsFieldRange(field);
          var displayMin = field.kind === 'pct' && range ? roundTo(range[0] * 100, 6) : range ? range[0] : null;
          var displayMax = field.kind === 'pct' && range ? roundTo(range[1] * 100, 6) : range ? range[1] : null;
          var recValue = getPath(defaults, field.path);
          var disabled = locked && field.risk;
          var recText = field.kind === 'bool' ? '' : '推荐 ' + formatSettingsValue(field, recValue);
          return '<label class="settings-field' + (disabled ? ' is-locked' : '') + '" data-path="' + escapeHtml(field.path) + '">' +
            '<span class="sf-label">' + escapeHtml(field.label) +
            (recText ? '<em class="sf-rec">' + escapeHtml(recText) + '</em>' : '') + '</span>' +
            '<div class="cf-input">' +
            '<input type="number" data-setting-path="' + escapeHtml(field.path) + '" data-kind="' + field.kind + '"' +
            ' value="' + escapeHtml(settingDisplayInputValue(field, value)) + '"' +
            (displayMin != null ? ' min="' + displayMin + '"' : '') +
            (displayMax != null ? ' max="' + displayMax + '"' : '') +
            ' step="any"' + (disabled ? ' disabled' : '') + '>' +
            (field.unit ? '<span class="sf-unit">' + escapeHtml(field.unit) + '</span>' : '') +
            '<button type="button" class="field-reset" data-setting-reset="' + escapeHtml(field.path) + '" title="恢复推荐值"' + (disabled ? ' disabled' : '') + '>↺</button>' +
            '</div><em class="sf-error" data-setting-error="' + escapeHtml(field.path) + '" hidden></em></label>';
        }).join('');
        return (group.sub ? '<div class="settings-subhead">' + escapeHtml(group.sub) + '</div>' : '') +
          '<div class="settings-grid">' + rows + '</div>';
      }).join('');
      return '<div class="settings-section"><div class="settings-head"><h3 class="settings-title">' +
        escapeHtml(section.title) + '</h3></div>' +
        (section.note ? '<p class="settings-note">' + escapeHtml(section.note) + '</p>' : '') + body + '</div>';
    }).join('');

    var auto = getPath(settings, 'autoConvert');
    var autoChecked = auto == null ? true : !!auto;
    html += '<div class="settings-section"><div class="settings-head"><h3 class="settings-title">自动换汇</h3></div>' +
      '<label class="settings-check"><input type="checkbox" data-setting-path="autoConvert" data-kind="bool"' +
      (autoChecked ? ' checked' : '') + (locked ? '' : '') + '>' +
      '<span>外币现金不足时自动从基础币种换汇（关闭后不足会直接失败）</span></label></div>';
    host.innerHTML = html;
  }

  function readSettingsForm(base) {
    var out = cloneDeep(base || defaultSettingsDeep());
    $$('#account-settings-fields [data-setting-path]').forEach(function (input) {
      var path = input.getAttribute('data-setting-path');
      var kind = input.getAttribute('data-kind');
      if (kind === 'bool') {
        setPath(out, path, !!input.checked);
        return;
      }
      var field = settingsFieldByPath(path);
      if (!field) return;
      setPath(out, path, settingInputToValue(field, input.value));
    });
    return out;
  }

  function settingsValidate(settings) {
    var errors = [];
    var add = function (message) {
      if (message && errors.indexOf(message) < 0) errors.push(message);
    };
    settingsFieldsFlat().forEach(function (field) {
      if (field.kind === 'bool') return;
      var value = Number(getPath(settings, field.path));
      if (!isFinite(value)) {
        add(field.label + ' 不是有效数字');
        return;
      }
      var range = settingsFieldRange(field);
      if (range && (value < range[0] - 1e-12 || value > range[1] + 1e-12)) {
        add(field.label + ' 超出范围（' + formatSettingsValue(field, range[0]) + ' – ' + formatSettingsValue(field, range[1]) + '）');
      }
    });
    var multRange = (settingsMeta().multiplier && settingsMeta().multiplier.range) || [0.1, 2];
    if (settings.leverageMultiplier < multRange[0] - 1e-9 || settings.leverageMultiplier > multRange[1] + 1e-9) {
      add('杠杆上限倍率需在 ' + multRange[0] + '× – ' + multRange[1] + '× 之间');
    }
    ['hk', 'us', 'fx', 'crypto'].forEach(function (market) {
      var mmr = Number(getPath(settings, 'margin.mmr.' + market));
      var lev = multiplierLeverage(market, settings.leverageMultiplier);
      var cap = 0.9 / lev;
      if (isFinite(mmr) && mmr > cap + 1e-12) {
        add((market === 'hk' ? '港股' : market === 'us' ? '美股' : market === 'fx' ? '外汇' : '加密') +
          '维持保证金率过高：当前倍率下需 ≤ ' + formatRatePercent(cap * 100) +
          '（0.9 ÷ 杠杆上限 ' + lev + 'x）');
      }
    });
    return errors;
  }

  function updateSettingsMultiplierUI() {
    var range = $('#settings-mult-range');
    var mult = range ? Number(range.value) : 1;
    if (!isFinite(mult)) mult = 1;
    var multRange = (settingsMeta().multiplier && settingsMeta().multiplier.range) || [0.1, 2];
    setText('#settings-mult-value', '×' + formatMultiplier(mult));
    setText('#settings-mult-range-label', multRange[0] + '× – ' + multRange[1] + '×');
    setText('#settings-mult-preview', leverageCapsText(mult));
    var recommended = multiplierLeverage('crypto', 1) + 'x';
    setText('#settings-mult-note',
      '推荐 1×：' + leverageCapsText(1) + '；倍率越高，杠杆上限越高，也越容易接近强平线。' +
      (multiplierLeverage('crypto', mult) === Number(recommended.replace('x', '')) ? '' : ' 风险自担。'));
    var quick = $('#settings-mult-quick');
    if (quick) {
      var values = (settingsMeta().multiplier && settingsMeta().multiplier.quick) || [0.1, 0.25, 0.5, 1, 2];
      quick.innerHTML = values.map(function (value) {
        var label = Math.abs(Number(value) - 1) < 1e-9 ? '×1 <em>推荐</em>' : '×' + value;
        return '<button type="button" data-mult="' + value + '"' + (Math.abs(Number(value) - mult) < 1e-9 ? ' class="active"' : '') + '>' + label + '</button>';
      }).join('');
    }
    $$('#settings-presets [data-preset]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === state.settingsPreset);
    });
  }

  function setMultiplierValue(value) {
    var range = $('#settings-mult-range');
    if (!range) return;
    range.value = String(value);
    onSettingsMultiplierChanged();
  }

  function updateSettingsLockUI() {
    var note = $('#settings-lock-note');
    if (note) {
      note.hidden = !state.settingsLocked;
      note.textContent = state.settingsLocked
        ? '有持仓或未成交委托：杠杆倍率与保证金参数已锁定，需先平仓并撤单。手续费、滑点与换汇仍可修改。'
        : '';
    }
    var range = $('#settings-mult-range');
    if (range) range.disabled = !!state.settingsLocked;
    $$('#settings-mult-quick button, #settings-presets button').forEach(function (btn) {
      btn.disabled = !!state.settingsLocked;
    });
  }

  function setSettingsForm(settings) {
    state.settingsFormDirty = false;
    var range = $('#settings-mult-range');
    if (range) range.value = String(settings.leverageMultiplier != null ? settings.leverageMultiplier : 1);
    updateSettingsMultiplierUI();
    renderSettingsFields(settings);
    updateSettingsLockUI();
    validateAllSettingsFields();
  }

  function applySettingsPreset(name) {
    if (state.settingsLocked) return;
    var preset = settingsMeta().presets && settingsMeta().presets[name];
    if (!preset) return;
    state.settingsPreset = name;
    state.settingsFormDirty = true;
    var current = readSettingsForm(defaultSettingsDeep());
    current.leverageMultiplier = preset.leverageMultiplier != null ? preset.leverageMultiplier : current.leverageMultiplier;
    if (preset.margin && preset.margin.mmr) {
      Object.keys(preset.margin.mmr).forEach(function (market) {
        setPath(current, 'margin.mmr.' + market, preset.margin.mmr[market]);
      });
    }
    setSettingsForm(current);
    var adjusted = clampMmrToMultiplier(current.leverageMultiplier);
    updateSettingsMultiplierUI();
    refreshMmrClampNote(current.leverageMultiplier, adjusted);
  }

  function resetSettingsToDefaults() {
    var multiplier = currentSettingsMultiplier();
    if (state.settingsLocked) {
      // Fees / slippage / conversion are still editable even with positions.
      var current = readSettingsForm(mergeDeep(defaultSettingsDeep(), state.view.settings || {}));
      current.leverageMultiplier = multiplier;
      var defaults = defaultSettingsDeep();
      ['fees', 'slippageBps', 'autoConvert', 'fxConvertSpread'].forEach(function (key) {
        current[key] = cloneDeep(defaults[key]);
      });
      setSettingsForm(current);
      state.settingsPreset = multiplier === 1 ? 'recommended' : null;
      updateSettingsMultiplierUI();
      refreshMmrClampNote(multiplier, []);
      return;
    }
    var reset = defaultSettingsDeep();
    reset.leverageMultiplier = multiplier;
    setSettingsForm(reset);
    state.settingsPreset = multiplier === 1 ? 'recommended' : null;
    var adjusted = clampMmrToMultiplier(multiplier);
    updateSettingsMultiplierUI();
    refreshMmrClampNote(multiplier, adjusted);
  }

  function renderSettingsPresets() {
    var host = $('#settings-presets');
    if (!host) return;
    var presets = settingsMeta().presets || {};
    var labels = { conservative: '保守', recommended: '推荐', aggressive: '激进' };
    host.innerHTML = Object.keys(labels).map(function (key) {
      if (!presets[key]) return '';
      return '<button type="button" data-preset="' + key + '">' + labels[key] + '</button>';
    }).join('') + '<span class="settings-preset-note" id="settings-preset-note">自定义</span>';
    updateSettingsMultiplierUI();
  }

  function setBasicAccountFieldsEnabled(enabled, allowName) {
    var nameInput = $('#new-account-name');
    if (nameInput) nameInput.disabled = !enabled && !allowName;
    ['#new-account-capital', '#new-account-currency', '#new-account-margin-mode'].forEach(function (selector) {
      var el = $(selector);
      if (el) el.disabled = !enabled;
    });
    var note = $('#settings-basic-note');
    if (note) {
      note.hidden = enabled;
      note.textContent = enabled ? ''
        : allowName
          ? '账户名称可修改；初始资金 / 基础币种 / 保证金模式创建后不可修改（保证金模式请用上方「切换模式」）。'
          : '账户名称 / 初始资金 / 基础币种 / 保证金模式创建后不可修改；保证金模式请用上方「切换模式」。';
    }
  }

  function updateCapitalUnit() {
    var select = $('#new-account-currency');
    setText('#account-capital-unit', select ? select.value : 'CNY');
  }

  function openAccountSettings() {
    if (!state.accountId || !state.view) {
      showToast('请先创建账户', 'warn');
      return;
    }
    var account = state.view.account || {};
    state.settingsMode = 'edit';
    state.accountModalRequired = false;
    state.settingsLocked = !!((state.view.positions && state.view.positions.length) || (state.view.openOrders && state.view.openOrders.length));
    var modal = $('#modal-account');
    if (!modal) return;
    modal.hidden = false;
    var clampNote = $('#settings-mmr-clamp-note');
    if (clampNote) clampNote.hidden = true;
    setText('#modal-account-title', '账户设置');
    setText('#account-modal-hint', '调整账户「' + (account.name || '') + '」的杠杆倍率、费率、滑点与保证金参数；仅影响之后的成交与风控计算。');
    setText('#btn-create-account', '保存设置');
    var nameInput = $('#new-account-name');
    var capitalInput = $('#new-account-capital');
    if (nameInput) nameInput.value = account.name || '';
    if (capitalInput) capitalInput.value = String(account.initialCapital != null ? account.initialCapital : 1000000);
    var currencySel = $('#new-account-currency');
    if (currencySel) currencySel.value = account.baseCurrency || 'CNY';
    updateCapitalUnit();
    var modeSel = $('#new-account-margin-mode');
    if (modeSel) modeSel.value = account.marginMode || 'isolated';
    setBasicAccountFieldsEnabled(false, true);
    var cancelBtn = $('#btn-cancel-account');
    if (cancelBtn) cancelBtn.hidden = false;
    var closeBtn = $('#modal-account [data-close-modal]');
    if (closeBtn) closeBtn.hidden = false;
    hideFormError('#account-modal-error');
    var base = mergeDeep(defaultSettingsDeep(), state.view.settings || {});
    renderSettingsPresets();
    state.settingsPreset = null;
    setSettingsForm(base);
  }

  function openCreateAccount(required) {
    state.accountModalRequired = !!required;
    state.settingsMode = 'create';
    state.settingsLocked = false;
    state.settingsPreset = 'recommended';
    var modal = $('#modal-account');
    if (!modal) return;
    modal.hidden = false;
    var clampNote = $('#settings-mmr-clamp-note');
    if (clampNote) clampNote.hidden = true;
    setText('#account-modal-hint', required
      ? '欢迎使用 千亦所 ChimaTrader。请先创建一个模拟账户，所有交易均使用虚拟资金。'
      : '创建一个新的模拟账户，可自定义费率、滑点、保证金与杠杆上限倍率。');
    setText('#modal-account-title', required ? '创建模拟账户' : '新建模拟账户');
    setText('#btn-create-account', '创建账户');
    var metaDefaults = settingsMeta().defaults || {};
    var nameInput = $('#new-account-name');
    var capitalInput = $('#new-account-capital');
    if (nameInput) nameInput.value = '';
    if (capitalInput) capitalInput.value = String(metaDefaults.initialCapital != null ? metaDefaults.initialCapital : 1000000);
    var currencySel = $('#new-account-currency');
    if (currencySel) currencySel.value = metaDefaults.baseCurrency || 'CNY';
    updateCapitalUnit();
    var modeSel = $('#new-account-margin-mode');
    if (modeSel) modeSel.value = 'isolated';
    setBasicAccountFieldsEnabled(true);
    hideFormError('#account-modal-error');
    var cancelBtn = $('#btn-cancel-account');
    if (cancelBtn) cancelBtn.hidden = !!required;
    var closeBtn = $('#modal-account [data-close-modal]');
    if (closeBtn) closeBtn.hidden = !!required;
    renderSettingsPresets();
    setSettingsForm(defaultSettingsDeep());
    state.settingsPreset = 'recommended';
    updateSettingsMultiplierUI();
    if (nameInput) setTimeout(function () { nameInput.focus(); }, 40);
  }

  function showAccountModalError(message) {
    showFormError('#account-modal-error', message);
    var body = $('#modal-account .modal-body');
    var errorEl = $('#account-modal-error');
    var reveal = function () {
      if (body) body.scrollTop = body.scrollHeight;
      if (errorEl && errorEl.scrollIntoView) {
        try { errorEl.scrollIntoView({ block: 'center' }); } catch (e) { /* older browser */ }
      }
    };
    reveal();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
    setTimeout(reveal, 60);
  }

  function settingsPayloadChanged(payload, current) {
    if (!current) return true;
    return Object.keys(payload).some(function (key) {
      return JSON.stringify(payload[key]) !== JSON.stringify(current[key]);
    });
  }

  async function submitAccountSettings() {
    var createMode = state.settingsMode === 'create';
    var name = ($('#new-account-name').value || '').trim();
    var capital = Number($('#new-account-capital').value);
    var errors = [];
    if (createMode) {
      var capitalRange = (settingsMeta().ranges && settingsMeta().ranges.initialCapital) || [1000, 1000000000];
      if (!(capital >= capitalRange[0] && capital <= capitalRange[1])) {
        errors.push('初始资金需在 ' + fmtNumber(capitalRange[0], 0, 0) + ' – ' + fmtNumber(capitalRange[1], 0, 0) + ' 之间');
      }
      if (name.length > 20) errors.push('账户名称需为 1–20 个字符');
      if (!name) name = '模拟账户' + (state.accounts.length + 1);
    } else if (!name) {
      errors.push('账户名称不能为空');
    } else if (name.length > 20) {
      errors.push('账户名称需为 1–20 个字符');
    }
    var multiplier = currentSettingsMultiplier();
    var base = createMode ? defaultSettingsDeep() : mergeDeep(defaultSettingsDeep(), state.view.settings || {});
    var draft = readSettingsForm(base);
    draft.leverageMultiplier = multiplier;
    settingsValidate(draft).forEach(function (message) {
      if (errors.indexOf(message) < 0) errors.push(message);
    });
    if (errors.length) {
      showAccountModalError(errors.join('\n'));
      return;
    }

    var nameChanged = false;
    var settingsChanged = false;
    var payload = null;
    if (!createMode) {
      nameChanged = name !== ((state.view.account && state.view.account.name) || '');
      if (state.settingsLocked) {
        payload = {
          fees: draft.fees,
          slippageBps: draft.slippageBps,
          autoConvert: draft.autoConvert,
          fxConvertSpread: draft.fxConvertSpread
        };
      } else {
        payload = draft;
      }
      var currentSettings = mergeDeep(defaultSettingsDeep(), state.view.settings || {});
      settingsChanged = settingsPayloadChanged(payload, currentSettings);
      if (!nameChanged && !settingsChanged) {
        showToast('没有需要保存的修改', 'warn');
        return;
      }
    }

    hideFormError('#account-modal-error');
    var btn = $('#btn-create-account');
    btn.disabled = true;
    try {
      if (createMode) {
        var body = {
          name: name,
          initialCapital: capital,
          baseCurrency: $('#new-account-currency') ? $('#new-account-currency').value : 'CNY',
          marginMode: $('#new-account-margin-mode') ? $('#new-account-margin-mode').value : 'isolated',
          settings: draft
        };
        var res = await api('/api/accounts', { method: 'POST', body: body });
        state.accountModalRequired = false;
        closeModal('modal-account');
        showToast('账户「' + name + '」已创建，初始资金 ' + fmtMoney(capital, 'CNY'), 'success');
        var newId = res && res.account ? res.account.id : null;
        await refreshAccounts(newId);
        state.auxLoadedAt = 0;
        loadActiveTabData();
        if (!state.prefs.onboardingSeen) {
          setTimeout(function () {
            if (!state.onboardingActive) openOnboarding();
          }, 500);
        }
      } else {
        if (nameChanged) {
          await api('/api/accounts/' + encodeURIComponent(state.accountId), {
            method: 'PATCH', body: { name: name }
          });
        }
        if (settingsChanged) {
          await api('/api/accounts/' + encodeURIComponent(state.accountId) + '/settings', {
            method: 'PATCH', body: { settings: payload }
          });
        }
        closeModal('modal-account');
        showToast(nameChanged && settingsChanged ? '账户名称和参数已保存'
          : nameChanged ? '账户名称已更新' : '账户参数已保存', 'success');
        await refreshAccounts(state.accountId);
        state.auxLoadedAt = 0;
        loadActiveTabData();
      }
    } catch (err) {
      var message;
      if (err && err.code === 'SETTINGS_INVALID') message = errorText(err);
      else if (err && err.code === 'NAME_INVALID') message = '账户名称需为 1–20 个字符' + (errorText(err) ? '（' + errorText(err) + '）' : '');
      else if (err && err.code === 'SETTINGS_LOCKED') message = '有持仓或挂单时不能修改杠杆倍率 / 保证金参数，请先平仓并撤单';
      else message = orderErrorMessage(err);
      // Backend may return a multi-line SETTINGS_INVALID message for every bad
      // field; keep the modal open and show the complete text.
      showAccountModalError(message);
    } finally {
      btn.disabled = false;
    }
  }

  function openResetAccount() {
    if (!state.accountId || !state.view) {
      showToast('请先创建账户', 'warn');
      return;
    }
    var account = state.view.account;
    setText('#reset-modal-hint', '将清空账户「' + (account.name || '') + '」的持仓、委托与成交记录，并恢复为新的初始资金。');
    $('#reset-account-capital').value = String(account.initialCapital != null ? account.initialCapital : 1000000);
    hideFormError('#reset-modal-error');
    openModal('modal-reset');
  }

  async function submitResetAccount() {
    if (!state.accountId) return;
    var capital = Number($('#reset-account-capital').value);
    if (!(capital > 0)) {
      showFormError('#reset-modal-error', '初始资金必须大于 0');
      return;
    }
    var btn = $('#btn-confirm-reset');
    btn.disabled = true;
    try {
      await api('/api/accounts/' + encodeURIComponent(state.accountId) + '/reset', {
        method: 'POST', body: { initialCapital: capital }
      });
      closeModal('modal-reset');
      showToast('账户已重置，初始资金 ' + fmtMoney(capital, 'CNY'), 'success');
      await refreshAccounts(state.accountId);
    } catch (err) {
      showFormError('#reset-modal-error', errorText(err));
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------- data/backup

  function formatBytes(bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value < 0) return '--';
    if (value >= 1024 * 1024) return fmtNumber(value / (1024 * 1024), 2, 2) + ' MB';
    if (value >= 1024) return fmtNumber(value / 1024, 2, 2) + ' KB';
    return Math.round(value) + ' B';
  }

  function backupMtimeText(mtime) {
    if (mtime == null) return '--';
    if (typeof mtime === 'number') return fmtDateTime(new Date(mtime).toISOString());
    var text = String(mtime);
    if (isFinite(Date.parse(text))) return fmtDateTime(text);
    return text;
  }

  function setBackupButtonsEnabled(enabled) {
    ['#btn-data-snapshot', '#btn-data-export-account', '#btn-data-export-all', '#btn-data-export-csv', '#btn-data-import'].forEach(function (selector) {
      var btn = $(selector);
      if (btn) btn.disabled = !enabled;
    });
  }

  function showDataError(message) {
    showFormError('#data-status-error', message);
  }
  function clearDataError() {
    hideFormError('#data-status-error');
  }

  function renderBackupStatus(status) {
    var data = status || {};
    var file = data.dataFile || {};
    setText('#data-file-path', file.path || '--');
    setText('#data-file-size', file.exists === false ? '不存在' : formatBytes(file.size));
    setText('#data-file-mtime', backupMtimeText(file.mtime));
    setText('#data-account-count', data.accountCount != null ? String(data.accountCount) : '--');
    var snapshots = Array.isArray(data.snapshots) ? data.snapshots.slice() : [];
    snapshots.sort(function (a, b) { return (Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0); });
    if (MOCK) {
      setText('#data-auto-info', '演示模式不生成自动快照');
    } else {
      setText('#data-auto-info', '每 ' + (data.autoMinutes != null ? data.autoMinutes : '--') + ' 分钟一份，已保留 ' + snapshots.length + ' 份' +
        (data.keep != null ? '（上限 ' + data.keep + '）' : ''));
    }
    var countEl = $('#data-snapshot-count');
    if (countEl) countEl.textContent = snapshots.length ? '(' + snapshots.length + ')' : '(0)';
    var list = $('#data-snapshots');
    if (list) {
      list.innerHTML = snapshots.slice(0, 3).map(function (snap) {
        return '<li>' + escapeHtml(snap.name || '') + ' · ' + escapeHtml(formatBytes(snap.size)) +
          ' · ' + escapeHtml(backupMtimeText(snap.mtime)) + '</li>';
      }).join('') || '<li>暂无快照</li>';
    }
    var wrap = $('#data-snapshots-wrap');
    if (wrap) wrap.hidden = false;
  }

  async function loadBackupStatus(force) {
    if (state.data.loading && !force) return;
    var token = ++state.data.loadToken;
    state.data.loading = true;
    clearDataError();
    try {
      var status = await api('/api/backup/status');
      if (token !== state.data.loadToken) return;
      state.data.status = status;
      renderBackupStatus(status);
      setBackupButtonsEnabled(!MOCK);
      var exportAccountBtn = $('#btn-data-export-account');
      if (exportAccountBtn) exportAccountBtn.disabled = MOCK || !state.accountId;
      var csvBtn = $('#btn-data-export-csv');
      if (csvBtn) csvBtn.disabled = MOCK || !state.accountId;
    } catch (err) {
      if (token !== state.data.loadToken) return;
      showDataError('数据状态读取失败：' + errorText(err));
      setText('#data-file-path', '--');
      setText('#data-file-size', '--');
      setText('#data-file-mtime', '--');
      setText('#data-account-count', '--');
      setText('#data-auto-info', '--');
      setBackupButtonsEnabled(false);
    } finally {
      if (token === state.data.loadToken) state.data.loading = false;
    }
  }

  function openDataManager() {
    $('#modal-data').hidden = false;
    hideFormError('#import-error');
    var demoNote = $('#data-demo-note');
    if (demoNote) demoNote.hidden = !MOCK;
    setBackupButtonsEnabled(!MOCK);
    loadBackupStatus();
  }

  function triggerDownload(url) {
    var link = document.createElement('a');
    link.href = url;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { if (link.parentNode) link.parentNode.removeChild(link); }, 1000);
  }

  function parseBackupFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var data = null;
        try { data = JSON.parse(String(reader.result || '')); } catch (e) { data = null; }
        if (!data || data.format !== 'chimatrader-backup') {
          reject(new Error('备份格式不正确'));
          return;
        }
        if (data.version !== 1) {
          reject(new Error('备份版本不支持（' + data.version + '）'));
          return;
        }
        if (!Array.isArray(data.accounts) || !data.accounts.length) {
          reject(new Error('备份中没有账户数据'));
          return;
        }
        resolve(data);
      };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file);
    });
  }

  async function onBackupFileSelected(event) {
    var input = event.target;
    var file = input && input.files ? input.files[0] : null;
    if (file) {
      clearDataError();
      try {
        var data = await parseBackupFile(file);
        state.data.importData = data;
        state.data.importName = file.name;
        setText('#import-file-summary', '已选择「' + file.name + '」：' + (data.accounts.length) + ' 个账户' +
          (data.exportedAt ? ' · 导出于 ' + backupMtimeText(data.exportedAt) : ''));
        setText('#import-error', '');
        $('#import-error').hidden = true;
        var confirmBox = $('#import-confirm-restore');
        if (confirmBox) confirmBox.checked = false;
        var restoreBtn = $('#btn-import-restore');
        if (restoreBtn) restoreBtn.disabled = true;
        openModal('modal-import');
      } catch (err) {
        var message = '备份文件无法导入（BACKUP_INVALID）：' + err.message;
        showDataError(message);
        showToast(message, 'error');
      }
    }
    if (input) input.value = '';
  }

  function backupErrorMessage(err) {
    if (!err) return '备份操作失败';
    if (err.code === 'CONFIRM_REQUIRED') return '恢复全部数据需要二次确认';
    if (err.code === 'BACKUP_INVALID') return '备份文件格式或版本不正确（BACKUP_INVALID）';
    if (err.code === 'BACKUP_NOT_FOUND') return '备份文件不存在';
    return errorText(err);
  }

  async function importBackup(mode) {
    if (state.data.importBusy || !state.data.importData) return;
    var isRestore = mode === 'restore';
    if (isRestore) {
      var confirmBox = $('#import-confirm-restore');
      if (!confirmBox || !confirmBox.checked) {
        showFormError('#import-error', '请先勾选「我确认覆盖当前全部数据」');
        return;
      }
    }
    state.data.importBusy = true;
    var newBtn = $('#btn-import-new');
    var restoreBtn = $('#btn-import-restore');
    if (newBtn) newBtn.disabled = true;
    if (restoreBtn) restoreBtn.disabled = true;
    hideFormError('#import-error');
    try {
      var body = { data: state.data.importData, mode: isRestore ? 'restore' : 'new-account' };
      if (isRestore) body.confirm = 'RESTORE';
      var res = await api('/api/backup/import', { method: 'POST', body: body });
      closeModal('modal-import');
      closeModal('modal-data');
      if (isRestore) {
        var count = res && res.accounts != null ? res.accounts : state.data.importData.accounts.length;
        await refreshAccounts();
        await loadActiveTabData();
        showToast('已恢复 ' + count + ' 个账户', 'success');
      } else {
        var account = res && res.account;
        var name = account && account.name ? account.name : '导入账户';
        await refreshAccounts(account ? account.id : null);
        state.auxLoadedAt = 0;
        loadActiveTabData();
        showToast('已导入为新账户「' + name + '」', 'success');
      }
      state.data.importData = null;
      state.data.importName = null;
      // Restore may create a before-restore snapshot; refresh the data status
      // so reopening the manager shows the latest backup list.
      loadBackupStatus(true);
    } catch (err) {
      showFormError('#import-error', backupErrorMessage(err));
    } finally {
      state.data.importBusy = false;
      if (newBtn) newBtn.disabled = false;
      if (restoreBtn) restoreBtn.disabled = !($('#import-confirm-restore') && $('#import-confirm-restore').checked);
    }
  }

  function applySnapshotResult(res) {
    var status = state.data.status;
    if (!status || !res) return;
    var name = res.name || String(res.file || '').split(/[\\/]/).pop();
    if (!name) return;
    var snapshots = Array.isArray(status.snapshots) ? status.snapshots.slice() : [];
    snapshots = snapshots.filter(function (snap) { return snap && snap.name !== name; });
    snapshots.unshift({ name: name, size: res.size, mtime: res.mtime });
    status.snapshots = snapshots;
    status.dataFile = status.dataFile || {};
    if (res.size != null) status.dataFile.size = res.size;
    if (res.mtime != null) status.dataFile.mtime = res.mtime;
    status.dataFile.exists = true;
    renderBackupStatus(status);
  }

  async function saveBackupSnapshot() {
    if (MOCK) return;
    var btn = $('#btn-data-snapshot');
    if (btn) btn.disabled = true;
    clearDataError();
    try {
      var res = await api('/api/backup/snapshot', { method: 'POST' });
      // Update immediately so the list reflects the new snapshot even before
      // the status request round-trip finishes, then reconcile with the server.
      applySnapshotResult(res);
      var savedName = res && res.name ? ('data/backups/' + res.name) : (res && res.file ? res.file : 'data/backups/');
      showToast('已保存到 ' + savedName, 'success');
      await loadBackupStatus(true);
    } catch (err) {
      showDataError('快照失败：' + errorText(err));
      showToast('快照失败：' + errorText(err), 'error');
    } finally {
      if (btn) btn.disabled = MOCK;
    }
  }

  function exportCurrentAccount() {
    if (!state.accountId) {
      showDataError('请先创建或选择账户');
      return;
    }
    triggerDownload('/api/backup/export?scope=account&accountId=' + encodeURIComponent(state.accountId));
    showToast('已开始下载当前账户备份', 'success');
  }

  function exportAllAccounts() {
    triggerDownload('/api/backup/export?scope=all');
    showToast('已开始下载全部账户备份', 'success');
  }

  function exportTradesCsv() {
    if (!state.accountId) {
      showDataError('请先创建或选择账户');
      return;
    }
    triggerDownload('/api/accounts/' + encodeURIComponent(state.accountId) + '/export/trades.csv');
    showToast('已开始下载成交记录 CSV', 'success');
  }

  // --------------------------------------------------------------- watchlist

  function addToWatchlist(symbol) {
    symbol = normalizeSymbol(symbol);
    if (!symbol || state.watchlist.indexOf(symbol) >= 0) return Promise.resolve();
    state.watchlist = state.watchlist.concat([symbol]);
    renderWatchlist();
    return api('/api/watchlist', { method: 'PUT', body: { symbols: state.watchlist } })
      .then(function (res) {
        if (res && Array.isArray(res.symbols)) state.watchlist = res.symbols.map(normalizeSymbol);
        renderWatchlist();
        renderChipsAll();
        if (state.universe.open) renderUniverse();
        return refreshQuotes();
      })
      .catch(function (err) {
        showToast('添加自选失败：' + errorText(err), 'error');
      });
  }

  async function removeFromWatchlist(symbol) {
    symbol = normalizeSymbol(symbol);
    var next = state.watchlist.filter(function (s) { return s !== symbol; });
    state.watchlist = next;
    renderWatchlist();
    try {
      var res = await api('/api/watchlist', { method: 'PUT', body: { symbols: next } });
      if (res && Array.isArray(res.symbols)) state.watchlist = res.symbols.map(normalizeSymbol);
      renderWatchlist();
      renderChipsAll();
      if (state.universe.open) renderUniverse();
      showToast('已从自选移除', 'info');
      if (state.selected === symbol && state.watchlist.length) {
        selectSymbol(state.watchlist[0]);
      }
    } catch (err) {
      showToast('移除自选失败：' + errorText(err), 'error');
      await refreshQuotes();
    }
  }

  // ------------------------------------------------------------------ search

  function onSearchInput() {
    var input = $('#search-input');
    var query = (input.value || '').trim();
    if (state.searchTimer) clearTimeout(state.searchTimer);
    if (!query) {
      closeSearch();
      return;
    }
    state.searchTimer = setTimeout(function () { runSearch(query); }, 220);
  }

  async function runSearch(query) {
    var token = ++state.searchToken;
    try {
      var res = await api('/api/search?q=' + encodeURIComponent(query) + '&limit=20');
      if (token !== state.searchToken) return;
      state.searchResults = (res && res.results) || [];
      state.searchIndex = -1;
      renderSearchResults();
    } catch (err) {
      if (token !== state.searchToken) return;
      state.searchResults = [];
      renderSearchResults('搜索失败：' + errorText(err));
    }
  }

  function renderSearchResults(errorMessage) {
    var box = $('#search-results');
    if (!box) return;
    if (errorMessage) {
      box.innerHTML = '<div class="search-empty">' + escapeHtml(errorMessage) + '</div>';
      box.hidden = false;
      return;
    }
    if (!state.searchResults.length) {
      box.innerHTML = '<div class="search-empty">没有匹配的标的</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = state.searchResults.map(function (item, index) {
      return '<div class="search-item' + (index === state.searchIndex ? ' is-active' : '') +
        '" data-search-symbol="' + escapeHtml(item.symbol) + '">' +
        '<span class="s-name">' + escapeHtml(item.name) + '</span>' +
        '<span class="s-code">' + escapeHtml(displayCode(item.symbol, item)) + '</span>' +
        '<span class="s-market">' + escapeHtml(marketLabel(item.market)) + '</span>' +
        '</div>';
    }).join('');
    box.hidden = false;
  }

  function closeSearch() {
    var box = $('#search-results');
    if (box) box.hidden = true;
    state.searchResults = [];
    state.searchIndex = -1;
  }

  function chooseSearchResult(symbol) {
    if (!symbol) return;
    symbol = normalizeSymbol(symbol);
    state.searchToken++;
    closeSearch();
    var input = $('#search-input');
    if (input) input.value = '';
    addToWatchlist(symbol);
    selectSymbol(symbol);
  }

  function moveSearchSelection(delta) {
    if (!state.searchResults.length) return;
    state.searchIndex += delta;
    if (state.searchIndex < 0) state.searchIndex = state.searchResults.length - 1;
    if (state.searchIndex >= state.searchResults.length) state.searchIndex = 0;
    renderSearchResults();
    var active = $('#search-results .search-item.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function onSearchKeydown(event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSearchSelection(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSearchSelection(-1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      var picked = state.searchResults[state.searchIndex >= 0 ? state.searchIndex : 0];
      if (picked) chooseSearchResult(picked.symbol);
    } else if (event.key === 'Escape') {
      closeSearch();
    }
  }

  // ------------------------------------------------------------------ symbol

  function pickInterval(market, preferred) {
    var list = marketIntervalsFor(market);
    if (preferred && list.indexOf(preferred) >= 0) return preferred;
    var pref = state.prefs && state.prefs.intervals ? state.prefs.intervals[market] : null;
    if (pref && list.indexOf(pref) >= 0) return pref;
    return defaultIntervalFor(market);
  }

  async function selectSymbol(symbol) {
    if (!symbol) return;
    symbol = normalizeSymbol(symbol);
    var market = marketOf(symbol);
    var previousMarket = state.selected ? marketOf(state.selected) : null;
    var changed = state.selected !== symbol;
    state.selected = symbol;
    if (changed) {
      state.orderHint = null;
      state.orderHintUntil = 0;
      var targetPos = findPosition(symbol);
      if (targetPos) {
        state.leverage = Number(targetPos.leverage) || 1;
      } else {
        var remembered = state.prefs && state.prefs.leverageByMarket
          ? Number(state.prefs.leverageByMarket[market]) || 1
          : 1;
        state.leverage = clampLeverage(market, remembered);
        state.orderAction = 'long';
        var tp = $('#order-tp');
        var sl = $('#order-sl');
        if (tp) tp.value = '';
        if (sl) sl.value = '';
      }
    }
    var intervals = marketIntervalsFor(market);
    if (previousMarket !== market || !state.interval || intervals.indexOf(state.interval) < 0) {
      state.interval = pickInterval(market, null);
    }
    rememberInterval(market, state.interval);
    if (changed) {
      patchPrefs({ selectedSymbol: symbol });
      rememberRecent(symbol);
    }
    renderWatchlist();
    renderQuoteHeader();
    renderQuoteStats();
    renderIntervals();
    renderChartModeButtons();
    renderOrderInfo();
    renderSmartChips('watch-chips', true);
    await loadChart();
  }

  function marketIntervals() {
    var market = marketOf(state.selected);
    var meta = state.markets[market];
    if (meta && Array.isArray(meta.intervals)) return meta.intervals;
    if (state.marketList.length) return state.marketList[0].intervals || ['1d'];
    return ['1d'];
  }

  // ------------------------------------------------------------------ charts

  function ensurePriceChart() {
    if (state.chart || !window.Charts) return;
    var container = $('#price-chart');
    if (!container) return;
    state.chart = window.Charts.createPriceChart(container, {
      onCrosshair: onChartCrosshair,
      onNeedReload: function () {
        // Gap between the last stored bar and the live quote (weekend/holiday/
        // resumed session): refetch instead of drawing fake bars.
        if (state.chartReloading) return;
        state.chartReloading = true;
        loadChart().catch(function () { /* noop */ }).then(function () { state.chartReloading = false; });
      }
    });
  }

  function sourceUnavailableText(message) {
    var text = String(message || '上游连接失败');
    return /^数据源不可用/.test(text) ? text : '数据源不可用：' + text;
  }

  function setChartPlaceholder(message, retry) {
    var placeholder = $('#chart-placeholder');
    if (!placeholder) return;
    placeholder.hidden = false;
    setText('#chart-placeholder-text', message);
    var btn = $('#chart-retry');
    if (btn) btn.hidden = !retry;
  }

  function hideChartPlaceholder() {
    var placeholder = $('#chart-placeholder');
    if (placeholder) placeholder.hidden = true;
    var btn = $('#chart-retry');
    if (btn) btn.hidden = true;
  }

  async function loadChart() {
    if (!state.selected || !window.Charts) return;
    ensurePriceChart();
    if (!state.chart) return;
    var token = ++state.chartToken;
    var symbol = state.selected;
    var interval = state.interval || '1d';
    setChartPlaceholder('正在加载行情数据…', false);
    try {
      var res = await api('/api/kline?symbol=' + encodeURIComponent(symbol) +
        '&interval=' + encodeURIComponent(interval) + '&limit=300');
      if (token !== state.chartToken) return;
      var bars = (res && res.bars) || [];
      state.chartBars = bars;
      var lastPrice = bars.length ? bars[bars.length - 1].c : (currentQuote() ? currentQuote().price : null);
      state.chartLastPrice = lastPrice;
      var precision = precisionFor(symbol, lastPrice);
      state.chart.setData({
        bars: bars,
        mode: state.chartMode,
        interval: interval,
        precision: precision
      });
      if (bars.length) {
        var quoteErr = quoteErrorFor(symbol);
        if (quoteErr) setChartPlaceholder(sourceUnavailableText(quoteErr.message), true);
        else hideChartPlaceholder();
      } else {
        setChartPlaceholder('暂无 K 线数据', false);
      }
      renderChartLegend(null);
      if (currentQuote()) updateChartLive(currentQuote());
    } catch (err) {
      if (token !== state.chartToken) return;
      state.chartBars = [];
      state.chart.setData({ bars: [], mode: state.chartMode, interval: interval, precision: 2 });
      var message = quoteErrorFor(symbol) ? quoteErrorFor(symbol).message : errorText(err);
      setChartPlaceholder(sourceUnavailableText(message), true);
    }
  }

  async function retrySymbol(symbol) {
    var target = normalizeSymbol(symbol || state.selected);
    if (!target) return;
    showToast('正在重试 ' + target + ' …', 'warn');
    await refreshQuotes();
    renderWatchlist();
    if (target === state.selected) {
      renderQuoteHeader();
      renderQuoteStats();
      renderOrderInfo();
      var error = quoteErrorFor(target);
      if (error) {
        state.chartQuoteError = true;
        setChartPlaceholder(sourceUnavailableText(error.message), true);
        showToast('该标的数据源仍不可用：' + error.message, 'error');
      } else {
        state.chartQuoteError = false;
        await loadChart();
        showToast('已重新拉取行情', 'success');
      }
    }
  }

  function setChartMode(mode) {
    if (mode !== 'candles' && mode !== 'line') return;
    if (state.chartMode === mode) return;
    state.chartMode = mode;
    patchPrefs({ chartMode: mode });
    renderChartModeButtons();
    // Reload from /api/kline so the chart is rebuilt with fresh, consistent data.
    loadChart();
  }

  // NOTE: do not name this setInterval — it would shadow the timer global.
  function setChartInterval(interval) {
    if (!interval || interval === state.interval) return;
    var intervals = marketIntervals();
    if (intervals.indexOf(interval) < 0) return;
    state.interval = interval;
    rememberInterval(marketOf(state.selected), interval);
    renderIntervals();
    loadChart();
  }

  function updateChartLive(quote) {
    if (!quote || quote.symbol !== state.selected) return;
    if (!state.chart || !state.chart.updateQuote) return;
    if (quote.price == null || !isFinite(quote.price)) return;
    state.chartLastPrice = quote.price;
    state.chart.updateQuote(quote);
  }

  function onChartCrosshair(payload) {
    renderChartLegend(payload);
  }

  function renderChartLegend(payload) {
    var legend = $('#chart-legend');
    if (!legend) return;
    if (!payload || !payload.bar) {
      legend.hidden = true;
      return;
    }
    var bar = payload.bar;
    var interval = state.interval || '1d';
    var intraday = (INTERVAL_MS[interval] || 86400000) < 86400000;
    var pct = bar.o ? ((bar.c / bar.o - 1) * 100) : 0;
    var cls = pnlClass(bar.c - bar.o);
    legend.innerHTML =
      '<span class="lg-time">' + escapeHtml(window.Charts.formatBarTime(bar.t, intraday)) + '</span>' +
      '<span><span class="lg-label">开</span><b>' + fmtPrice(bar.o, state.selected) + '</b></span>' +
      '<span><span class="lg-label">高</span><b class="up">' + fmtPrice(bar.h, state.selected) + '</b></span>' +
      '<span><span class="lg-label">低</span><b class="down">' + fmtPrice(bar.l, state.selected) + '</b></span>' +
      '<span><span class="lg-label">收</span><b class="' + cls + '">' + fmtPrice(bar.c, state.selected) + '</b></span>' +
      '<span><span class="lg-label">涨跌</span><b class="' + cls + '">' + fmtPct(pct) + '</b></span>' +
      '<span><span class="lg-label">量</span><b>' + fmtCompact(bar.v) + '</b></span>';
    legend.hidden = false;
  }

  // ------------------------------------------------------------- order form

  function marketPriceEstimate(side, quote) {
    if (!quote) return null;
    var market = quote.market;
    if (market === 'fx') {
      var fxSpread = feeConfigFor('fx').spreadBps;
      var half = (Number(fxSpread) / 2) / 10000;
      return side === 'buy' ? quote.price * (1 + half) : quote.price * (1 - half);
    }
    var base = side === 'buy'
      ? (quote.ask && quote.ask[0] ? quote.ask[0].price : quote.price)
      : (quote.bid && quote.bid[0] ? quote.bid[0].price : quote.price);
    var slip = slippageBpsFor(market) / 10000;
    return side === 'buy' ? base * (1 + slip) : base * (1 - slip);
  }

  function orderFillPrice() {
    var quote = currentQuote();
    if (!quote) return null;
    if (state.orderType === 'limit') {
      var limit = Number($('#order-price').value);
      return isFinite(limit) && limit > 0 ? limit : null;
    }
    return marketPriceEstimate(state.orderSide, quote);
  }

  function setTradeAction(action) {
    if (action !== 'long' && action !== 'short' && action !== 'close') return;
    var pos = currentPosition();
    if (action === 'close' && !pos) {
      showToast('当前标的没有持仓，无法平仓', 'warn');
      return;
    }
    if (action === 'short' && !allowShortFor(marketOf(state.selected))) {
      showToast('该市场不支持做空', 'warn');
      return;
    }
    state.orderAction = action;
    state.orderSide = effectiveOrderSide();
    if (action === 'close' && pos) {
      var input = $('#order-qty');
      if (input) input.value = String(roundTo(Number(pos.availableQty != null ? pos.availableQty : pos.qty), qtyDigits(pos.market)));
    }
    renderOrderInfo();
    renderOrderHint();
  }

  function setOrderType(type) {
    state.orderType = type === 'limit' ? 'limit' : 'market';
    renderOrderMode();
    var priceInput = $('#order-price');
    var quote = currentQuote();
    if (state.orderType === 'limit' && priceInput) {
      if (quote) {
        priceInput.value = Number(quote.price).toFixed(precisionFor(state.selected, quote.price));
        state.limitPriceSymbol = state.selected;
      }
    }
    renderOrderInfo();
    renderOrderHint();
  }

  function renderOrderMode() {
    var pos = currentPosition();
    var market = marketOf(state.selected);
    $$('#trade-switch [data-trade-action]').forEach(function (btn) {
      var action = btn.getAttribute('data-trade-action');
      btn.classList.toggle('active', action === state.orderAction);
      if (action === 'close') btn.disabled = !pos;
      else if (action === 'short') btn.disabled = !allowShortFor(market);
      else btn.disabled = false;
    });
    $$('.type-switch [data-order-type]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-order-type') === state.orderType);
    });
    var submit = $('#order-submit');
    if (submit) {
      submit.classList.toggle('is-buy', state.orderAction === 'long');
      submit.classList.toggle('is-sell', state.orderAction === 'short');
      submit.classList.toggle('is-close', state.orderAction === 'close');
    }
  }

  function leverageQuickValues(max) {
    var values = [1, 2, 5, 10, max];
    var out = [];
    values.forEach(function (value) {
      var lev = Math.min(max, Math.max(1, Math.round(value)));
      if (out.indexOf(lev) < 0) out.push(lev);
    });
    return out.slice(0, 5);
  }

  function renderLeverageBlock() {
    var market = marketOf(state.selected);
    var pos = currentPosition();
    var max = maxLeverageFor(market);
    var block = $('#leverage-block');
    if (!block) return;
    var leverage = pos
      ? (Number(pos.leverage) || 1)
      : (state.orderAction === 'close' ? leverageForCurrent() : clampLeverage(market, state.leverage));
    state.leverage = leverage;
    var locked = market === 'cn' || !!pos;
    block.classList.toggle('is-disabled', locked);
    setText('#leverage-value', leverage + 'x');
    if (market === 'cn') {
      setText('#leverage-max', 'A股恒 1x');
    } else {
      var recommended = multiplierLeverage(market, (settingsMeta().presets && settingsMeta().presets.recommended && settingsMeta().presets.recommended.leverageMultiplier) || 1);
      setText('#leverage-max', '账户上限 ' + max + 'x · 推荐 ' + recommended + 'x');
    }
    var range = $('#leverage-range');
    if (range) {
      range.min = '1';
      range.max = String(max);
      range.step = '1';
      range.value = String(leverage);
      range.disabled = locked;
    }
    var quick = $('#lev-quick');
    if (quick) {
      var values = market === 'cn' ? [1] : leverageQuickValues(max);
      quick.innerHTML = values.map(function (value) {
        var label = value === max ? '最大 ' + value + 'x' : value + 'x';
        return '<button type="button" data-lev="' + value + '"' +
          (value === leverage ? ' class="active"' : '') +
          (locked ? ' disabled' : '') + '>' + label + '</button>';
      }).join('');
    }
    var hint = $('#leverage-hint');
    if (!hint) return;
    var text = '';
    var warn = false;
    if (market === 'cn') {
      text = 'A股不支持杠杆（恒 1x），也不能开空。';
      warn = true;
    } else if (pos) {
      text = '当前持仓杠杆 ' + (pos.leverage || 1) + 'x，加仓/平仓沿用该杠杆。';
      warn = true;
    } else if (state.orderAction === 'close') {
      text = '平仓沿用持仓杠杆，不产生新的保证金。';
    } else if (leverage > 1) {
      text = '杠杆放大盈亏，借入部分按年化 ' + fmtNumber(interestAnnualFor(market) * 100, 1, 0) + '% 计息，注意强平风险。';
      warn = true;
    } else {
      text = '1x = 现货，不借币、不计息。';
    }
    hint.textContent = text;
    hint.classList.toggle('is-warn', warn);
  }

  function renderTpslBlock() {
    var body = $('#tpsl-body');
    var toggle = $('#tpsl-toggle');
    if (body) body.hidden = !state.showTpSl;
    if (toggle) toggle.setAttribute('aria-expanded', state.showTpSl ? 'true' : 'false');
    var pos = currentPosition();
    var saveBtn = $('#btn-save-protect');
    if (saveBtn) saveBtn.hidden = !pos;
    var currency = currentQuote() ? (currentQuote().currency || 'CNY') : 'CNY';
    setText('#tp-unit', currency);
    setText('#sl-unit', currency);
    var hint = $('#tpsl-hint');
    if (hint) {
      hint.textContent = pos
        ? (state.orderAction === 'close'
          ? '平仓单不会修改止盈止损；可点「保存到持仓保护」单独修改。'
          : '已有持仓：开仓单不会覆盖保护设置，请用「保存到持仓保护」。')
        : '开仓成交后自动生效；多仓需 止盈>现价>止损，空仓需 止盈<现价<止损。';
    }
  }

  function setRowVisible(selector, visible) {
    $$(selector).forEach(function (el) { el.hidden = !visible; });
  }

  function clearTpslInputs() {
    var tp = $('#order-tp');
    var sl = $('#order-sl');
    if (tp) tp.value = '';
    if (sl) sl.value = '';
  }

  function renderPositionBanner(pos) {
    var el = $('#order-position-banner');
    if (!el) return;
    if (!pos) {
      el.hidden = true;
      return;
    }
    var side = positionSide(pos);
    var risk = pos.riskRatio;
    el.hidden = false;
    el.innerHTML = '当前持仓 <b class="pb-dir-' + side + '">' + (side === 'long' ? '多' : '空') + '</b>' +
      ' · <b>' + fmtQty(pos.qty, pos.market) + ' ' + qtyUnit(pos.market) + '</b>' +
      ' · ' + (pos.leverage || 1) + 'x' +
      ' · 均价 ' + fmtPrice(pos.avgCost, pos.symbol) +
      ' · 保证金 ' + fmtMoney(pos.margin, pos.currency) +
      (pos.liqPrice != null ? ' · 强平价 ' + fmtPrice(pos.liqPrice, pos.symbol) : '') +
      ' · 风险率 <span class="pb-risk ' + riskClass(risk) + '">' + fmtRisk(risk) + '</span>';
  }

  function renderOrderInfo() {
    var quote = currentQuote();
    var market = quote ? quote.market : marketOf(state.selected);
    var currency = market === 'fx' ? 'USD' : (quote ? quote.currency : (market === 'cn' ? 'CNY' : market === 'hk' ? 'HKD' : market === 'crypto' ? 'USDT' : 'USD'));
    var pos = currentPosition();
    var isClose = isCloseOrder();
    var side = effectiveOrderSide();
    state.orderSide = side;

    renderOrderMode();
    renderMarketStatus();
    renderLeverageBlock();
    renderTpslBlock();
    renderPositionBanner(pos);
    setText('#order-market', quote ? marketLabel(market) : '--');

    var priceInput = $('#order-price');
    var priceUnit = $('#price-unit');
    var qtyUnitEl = $('#qty-unit');
    if (priceUnit) priceUnit.textContent = currency;
    if (qtyUnitEl) qtyUnitEl.textContent = qtyUnit(market);
    var priceLabel = $('#price-label');
    if (priceLabel) priceLabel.textContent = state.orderType === 'limit' ? '限价' : '价格';
    if (priceInput) {
      if (state.orderType === 'market') {
        priceInput.disabled = true;
        priceInput.placeholder = '市价';
        var est = marketPriceEstimate(side, quote);
        if (est != null) priceInput.value = Number(est).toFixed(precisionFor(state.selected, est));
      } else {
        priceInput.disabled = false;
        if (quote && state.limitPriceSymbol !== state.selected) {
          priceInput.value = Number(quote.price).toFixed(precisionFor(state.selected, quote.price));
          state.limitPriceSymbol = state.selected;
        }
      }
    }

    var lot = marketLot(market, quote);
    var qty = Number($('#order-qty').value);
    var unit = qtyUnit(market);
    var leverage = isClose ? ((pos && Number(pos.leverage)) || 1) : (pos ? (Number(pos.leverage) || 1) : clampLeverage(market, state.leverage));
    var marginAvailable = accountMarginAvailable();
    var fxRate = fxRateOf(currency);
    var marginOnly = !isClose && leverage > 1;
    setRowVisible('.margin-only', marginOnly);
    setRowVisible('.close-only', isClose);

    var qtyHintEl = $('#qty-hint');
    if (qtyHintEl) {
      var showHints = !!(state.prefs && state.prefs.newbieHints);
      qtyHintEl.hidden = !showHints;
      if (showHints) {
        var qtyBits = [];
        if (market === 'cn') qtyBits.push('A股 100 股整手');
        else if (market === 'hk') qtyBits.push('每手 ' + lot + ' 股');
        else if (market === 'us') qtyBits.push('最小 1 股');
        else if (market === 'fx') qtyBits.push('最小 0.01 单位，2 位小数');
        else if (market === 'crypto') qtyBits.push('最小 0.0001，4 位小数');
        if (isFinite(qty) && qty > 0) {
          var qtyText = '当前 ' + fmtQty(qty, market) + ' ' + unit;
          if (market === 'cn' && qty % 100 === 0) qtyText += '（' + (qty / 100) + ' 手）';
          qtyBits.push(qtyText);
        }
        qtyHintEl.textContent = qtyBits.join(' · ');
      }
    }

    var cash = cashOf(currency);
    var buyingPower = buyingPowerOf(currency);
    setText('#order-cash', fmtMoney(buyingPower, currency));
    var cashLabel = $('#order-cash-label');
    if (cashLabel) cashLabel.textContent = autoConvertEnabled() ? '可用现金（含换汇）' : '可用现金';
    setText('#order-balance-label', '折合 CNY');
    setText('#order-balance', fmtMoney(cash * fxRate, 'CNY'));

    var convertNote = $('#fx-convert-note');
    if (convertNote) {
      var showConvert = side === 'buy' && !isClose && autoConvertEnabled() && cash <= 1e-9 && buyingPower > 1e-9;
      convertNote.hidden = !showConvert;
      if (showConvert) {
        convertNote.textContent = '将从 CNY 自动换汇买入（换汇成本 ' + fmtNumber(fxConvertSpread() * 100, 2, 2) + '%）';
      }
    }

    var available = availableQty(state.selected);
    setText('#order-available', state.selected ? fmtQty(available, market) + ' ' + unit : '--');

    var fill = orderFillPrice();
    if (isFinite(qty) && qty > 0 && fill != null && isFinite(fill)) {
      var amount = qty * fill;
      var feeBreakdown = estimateFeeBreakdown(market, side, qty, fill, {
        currency: currency,
        nativeCash: cash,
        autoConvert: autoConvertEnabled(),
        rate: fxRate,
        spread: fxConvertSpread()
      });
      var fees = feeBreakdown.total;
      setText('#order-amount', fmtMoney(amount, currency));
      setText('#order-fees', fmtMoney(fees, currency));
      if (isClose) {
        var gross = pos ? (positionSide(pos) === 'long' ? (fill - pos.avgCost) : (pos.avgCost - fill)) * qty : 0;
        var net = gross - fees;
        setText('#preview-close-pnl', fmtSignedMoney(net, currency));
        var pnlEl = $('#preview-close-pnl');
        if (pnlEl) pnlEl.className = 'num ' + pnlClass(net);
        setText('#order-total-label', '预估平仓收入');
        setText('#order-total', fmtMoney(amount - fees, currency));
      } else {
        if (marginOnly) {
          var marginRequired = amount / leverage;
          var mmr = mmrFor(market);
          var liqPrice;
          if (side === 'buy') {
            liqPrice = (fill * qty - marginRequired) / (qty * (1 - mmr));
          } else {
            liqPrice = (fill * qty + marginRequired) / (qty * (1 + mmr));
          }
          var debt = amount * (1 - 1 / leverage);
          var annual = interestAnnualFor(market);
          var hourly = debt * annual / 8760;
          setText('#preview-margin', fmtMoney(marginRequired, currency));
          setText('#preview-margin-available', fmtMoney(marginAvailable, 'CNY'));
          setText('#preview-notional', fmtMoney(amount, currency));
          setText('#preview-mmr', fmtNumber(mmr * 100, 2, 2) + '%');
          if (state.view && state.view.marginMode === 'cross') {
            setText('#preview-liq', '全仓（账户级风险）');
          } else {
            setText('#preview-liq', fmtPrice(liqPrice, state.selected));
          }
          setText('#preview-interest', '≈' + fmtMoney(hourly, currency) + '/时 · 年化 ' +
            fmtNumber(annual * 100, 1, 0) + '%');
        }
        setText('#order-total-label', '预估支出');
        setText('#order-total', fmtMoney(amount + fees, currency));
      }
      renderFeePopover(feeBreakdown, currency);
    } else {
      setText('#order-amount', '--');
      setText('#order-fees', '--');
      setText('#preview-margin', '--');
      setText('#preview-margin-available', fmtMoney(marginAvailable, 'CNY'));
      setText('#preview-notional', '--');
      setText('#preview-mmr', '--');
      setText('#preview-liq', '--');
      setText('#preview-interest', '--');
      setText('#preview-close-pnl', '--');
      setText('#order-total-label', isClose ? '预估平仓收入' : '预估支出');
      setText('#order-total', '--');
      renderFeePopover(null, currency);
    }

    var submit = $('#order-submit');
    if (submit) {
      var name = quote && quote.name ? quote.name : '';
      if (isClose && pos) {
        var closeQty = isFinite(qty) && qty > 0 ? qty : pos.qty;
        submit.textContent = '平仓 ' + fmtQty(closeQty, market) + ' ' + unit;
      } else if (state.orderAction === 'short') {
        submit.textContent = '开空' + (name ? ' ' + name : '');
      } else {
        submit.textContent = '开多' + (name ? ' ' + name : '');
      }
    }
    updateSubmitState();
  }

  function renderMarketStatus() {
    var status = computeMarketStatus(state.selected, currentQuote());
    state.marketStatus = status;
    var bar = $('#market-status');
    if (!bar) return;
    bar.dataset.state = status.state;
    bar.title = sessionSummary(marketOf(state.selected)) || '交易时段以服务端配置为准';
    setText('#market-status-text', status.label + (status.detail ? ' · ' + status.detail : ''));
    var hintEl = $('#market-status-hint');
    if (hintEl) {
      if (status.hint) {
        hintEl.hidden = false;
        hintEl.textContent = status.hint;
      } else {
        hintEl.hidden = true;
      }
    }
    var rules = $('#market-rules');
    if (rules) {
      var showRules = !!(state.prefs && state.prefs.newbieHints) && !!state.selected;
      rules.hidden = !showRules;
      if (showRules) rules.innerHTML = marketRulesHTML(marketOf(state.selected), currentQuote());
    }
  }

  function renderFeePopover(breakdown, currency) {
    var pop = $('#fee-popover');
    if (!pop) return;
    if (!breakdown || !breakdown.lines || !breakdown.lines.length) {
      pop.innerHTML = '<div class="fp-title">费用构成（预估）</div>' +
        '<div class="fp-line"><span>填写数量后显示</span><b>--</b></div>' +
        '<div class="fp-note">最终费用以服务端成交结果为准。</div>';
      return;
    }
    var lines = breakdown.lines.map(function (line) {
      return '<div class="fp-line"><span>' + escapeHtml(line.label) + '</span><b>' +
        escapeHtml(fmtMoney(line.value, line.currency || currency)) + '</b></div>';
    }).join('');
    var hasConversion = breakdown.lines.some(function (line) { return line.currency && line.currency !== currency; });
    pop.innerHTML = '<div class="fp-title">费用构成（预估）</div>' + lines +
      '<div class="fp-line fp-total"><span>交易费用合计</span><b>' + escapeHtml(fmtMoney(breakdown.total, currency)) + '</b></div>' +
      '<div class="fp-note">' + (hasConversion ? '换汇成本以 CNY 计；' : '') + '最终以服务端成交结果为准。</div>';
  }

  function updateSubmitState() {
    var submit = $('#order-submit');
    if (!submit) return;
    var result = validateOrderForm();
    submit.disabled = !state.accountId || !result.ok || state.orderBusy;
  }

  function validateOrderForm() {
    if (!state.accountId) return { ok: false, message: '请先创建账户后再交易' };
    var quote = currentQuote();
    if (!state.selected || !quote) return { ok: false, message: '请先选择交易标的' };
    var market = quote.market;
    var currency = quote.currency || 'CNY';
    var pos = currentPosition();
    var isClose = isCloseOrder();
    var side = effectiveOrderSide();
    var action = state.orderAction;
    if (isClose && !pos) return { ok: false, message: '当前标的没有持仓，无法平仓' };
    if (action === 'short' && !allowShortFor(market)) {
      return { ok: false, message: '该市场不支持做空（A股不可做空）' };
    }
    if (action === 'short' && clampLeverage(market, state.leverage) <= 1) {
      return { ok: false, message: '开空需要选择 2x 及以上杠杆' };
    }
    var maxLev = maxLeverageFor(market);
    var leverage = isClose
      ? ((pos && Number(pos.leverage)) || 1)
      : (pos ? (Number(pos.leverage) || 1) : leverForOrder());
    if (!isClose) {
      if (market === 'cn' && leverage > 1) return { ok: false, message: 'A股不支持杠杆（恒 1x）' };
      if (leverage > maxLev + 1e-9) return { ok: false, message: '超过当前账户杠杆上限 ' + maxLev + 'x，可在账户设置里调高倍率' };
      if (pos) {
        var posSide = positionSide(pos);
        var wantSide = action === 'long' ? 'long' : 'short';
        if (posSide !== wantSide) {
          return { ok: false, message: '已有反向持仓，请先平仓，或使用「反手」' };
        }
        if (Math.abs(leverage - (Number(pos.leverage) || 1)) > 1e-9) {
          return { ok: false, message: '加仓杠杆需与现有持仓一致（当前 ' + (pos.leverage || 1) + 'x）' };
        }
      }
    }

    var qtyRaw = ($('#order-qty').value || '').trim();
    if (!qtyRaw) return { ok: false, message: '请输入数量' };
    var qty = Number(qtyRaw);
    if (!isFinite(qty) || qty <= 0) return { ok: false, message: '数量必须大于 0' };

    var lot = marketLot(market, quote);
    var unit = qtyUnit(market);
    if (qty < lot) return { ok: false, message: '数量不能低于最小交易单位 ' + fmtQty(lot, market) + ' ' + unit };
    if (market === 'cn' && Math.abs(qty / 100 - Math.round(qty / 100)) > 1e-9) {
      return { ok: false, message: 'A股数量需为 100 股的整数倍' };
    }
    if (market === 'hk' && Math.abs(qty / lot - Math.round(qty / lot)) > 1e-9) {
      return { ok: false, message: '港股数量需为每手 ' + lot + ' 股的整数倍' };
    }
    if (market === 'us' && !Number.isInteger(qty)) {
      return { ok: false, message: '美股数量需为整数股' };
    }
    if (market === 'fx' && Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) {
      return { ok: false, message: '外汇数量最多支持 2 位小数' };
    }
    if (market === 'crypto' && Math.abs(qty * 10000 - Math.round(qty * 10000)) > 1e-6) {
      return { ok: false, message: '加密数量最多支持 4 位小数' };
    }

    var limitPrice = null;
    if (state.orderType === 'limit') {
      limitPrice = Number($('#order-price').value);
      if (!isFinite(limitPrice) || limitPrice <= 0) return { ok: false, message: '请输入有效的限价' };
    }
    var fill = state.orderType === 'limit' ? limitPrice : marketPriceEstimate(side, quote);
    if (fill == null || !isFinite(fill)) return { ok: false, message: '行情加载中，请稍候' };

    var marketStatus = computeMarketStatus(state.selected, quote);
    state.marketStatus = marketStatus;
    if (state.orderType === 'market' && !marketStatus.canMarketOrder) {
      return {
        ok: false,
        message: '当前' + marketStatus.label + '：市价单无法成交。' +
          (marketStatus.hint || '可改用限价单提前挂单')
      };
    }

    var amount = qty * fill;
    var fees = estimateFees(market, side, qty, fill);
    if (isClose) {
      var closeAvail = Number(pos.availableQty != null ? pos.availableQty : pos.qty) || 0;
      if (qty > closeAvail + 1e-9) {
        return {
          ok: false,
          message: '可平数量不足：当前可平 ' + fmtQty(closeAvail, market) + ' ' + unit
        };
      }
    } else if (leverage > 1) {
      var marginRequired = amount / leverage;
      var needCny = (marginRequired + fees) * fxRateOf(currency);
      var availableMargin = accountMarginAvailable();
      if (needCny > availableMargin + 1e-6) {
        return {
          ok: false,
          message: '可用保证金不足：需约 ' + fmtMoney(needCny, 'CNY') + '，可用 ' + fmtMoney(availableMargin, 'CNY')
        };
      }
    } else if (side === 'buy') {
      var buyingPower = buyingPowerOf(currency);
      var need = amount + fees;
      if (need > buyingPower + 1e-6) {
        return {
          ok: false,
          message: '可用资金不足：本次约需 ' + fmtMoney(need, currency) + '，可用（含换汇）' + fmtMoney(buyingPower, currency)
        };
      }
    }

    var takeProfit = null;
    var stopLoss = null;
    if (!isClose && !pos && state.showTpSl) {
      var tpRaw = ($('#order-tp').value || '').trim();
      var slRaw = ($('#order-sl').value || '').trim();
      takeProfit = tpRaw ? Number(tpRaw) : null;
      stopLoss = slRaw ? Number(slRaw) : null;
      if (takeProfit != null && (!isFinite(takeProfit) || takeProfit <= 0)) return { ok: false, message: '止盈价无效' };
      if (stopLoss != null && (!isFinite(stopLoss) || stopLoss <= 0)) return { ok: false, message: '止损价无效' };
      if (action === 'long') {
        if (takeProfit != null && takeProfit <= fill) return { ok: false, message: '多仓止盈价需高于开仓价' };
        if (stopLoss != null && stopLoss >= fill) return { ok: false, message: '多仓止损价需低于开仓价' };
      } else {
        if (takeProfit != null && takeProfit >= fill) return { ok: false, message: '空仓止盈价需低于开仓价' };
        if (stopLoss != null && stopLoss <= fill) return { ok: false, message: '空仓止损价需高于开仓价' };
      }
    }

    return {
      ok: true, qty: qty, fill: fill, amount: amount, fees: fees,
      limitPrice: limitPrice, market: market, currency: currency,
      leverage: leverage, close: isClose, side: side,
      takeProfit: takeProfit, stopLoss: stopLoss
    };
  }

  function leverForOrder() {
    var pos = currentPosition();
    var market = marketOf(state.selected);
    if (pos) return Number(pos.leverage) || 1;
    return clampLeverage(market, state.leverage);
  }

  function renderOrderHint() {
    var el = $('#order-hint');
    if (!el) return;
    var hint = null;
    if (state.orderHint && Date.now() < state.orderHintUntil) {
      hint = state.orderHint;
    } else {
      state.orderHint = null;
      var validation = validateOrderForm();
      var qtyRaw = ($('#order-qty').value || '').trim();
      if (!state.accountId) hint = { kind: 'warn', text: '请先创建模拟账户后再交易' };
      else if (!state.selected) hint = { kind: 'warn', text: '请先选择交易标的' };
      else if (qtyRaw && !validation.ok) hint = { kind: 'error', text: validation.message };
    }
    if (hint) {
      el.hidden = false;
      el.className = 'order-hint is-' + hint.kind;
      el.textContent = hint.text;
    } else {
      el.hidden = true;
    }
  }

  function setOrderHint(kind, text) {
    state.orderHint = { kind: kind, text: text };
    state.orderHintUntil = Date.now() + 9000;
    if (state.orderHintTimer) clearTimeout(state.orderHintTimer);
    state.orderHintTimer = setTimeout(function () {
      if (Date.now() >= state.orderHintUntil) {
        state.orderHint = null;
        renderOrderHint();
      }
    }, 9100);
    renderOrderHint();
  }

  function maxQtyForSide() {
    var quote = currentQuote();
    if (!quote) return 0;
    var market = quote.market;
    var lot = marketLot(market, quote);
    var digits = qtyDigits(market);
    if (isCloseOrder()) {
      var pos = currentPosition();
      if (!pos) return 0;
      return roundTo(Number(pos.availableQty != null ? pos.availableQty : pos.qty) || 0, digits);
    }
    var side = effectiveOrderSide();
    var fill = marketPriceEstimate(side, quote);
    if (fill == null || !isFinite(fill) || fill <= 0) return 0;
    var leverage = currentPosition() ? (Number(currentPosition().leverage) || 1) : leverForOrder();
    var budget;
    if (leverage > 1) {
      // Available margin (CNY) × leverage converted into quote currency.
      var rate = fxRateOf(quote.currency || 'CNY') || 1;
      budget = accountMarginAvailable() / rate * leverage;
    } else {
      budget = buyingPowerOf(quote.currency || 'CNY');
    }
    var buffer = market === 'crypto' ? 0.0012 : market === 'fx' ? 0.0002 : 0.002;
    var max = budget / (fill * (1 + buffer));
    if (market === 'cn') max = Math.floor(max / 100) * 100;
    else if (market === 'hk') max = Math.floor(max / lot) * lot;
    else if (market === 'us') max = Math.floor(max);
    else if (market === 'fx') max = Math.floor(max * 100) / 100;
    else max = Math.floor(max * 10000) / 10000;
    var guard = 0;
    while (max > 0 && guard < 500) {
      var need;
      if (leverage > 1) {
        need = (max * fill) / leverage + estimateFees(market, side, max, fill);
      } else {
        need = max * fill + estimateFees(market, side, max, fill);
      }
      if (need <= budget + 1e-9) break;
      max = roundTo(max - lot, market === 'crypto' ? 4 : market === 'fx' ? 2 : 0);
      guard++;
    }
    if (!isFinite(max) || max < 0) max = 0;
    return roundTo(max, digits);
  }

  function applyQtyPct(pct) {
    var max = maxQtyForSide();
    var qty = max * (pct / 100);
    if (pct === 100) qty = max;
    var market = currentQuote() ? currentQuote().market : marketOf(state.selected);
    var digits = qtyDigits(market);
    qty = roundTo(qty, digits);
    if (market === 'cn') qty = Math.floor(qty / 100) * 100;
    else if (market === 'hk') {
      var lot = marketLot(market, currentQuote());
      qty = Math.floor(qty / lot) * lot;
    }
    var input = $('#order-qty');
    if (input) input.value = qty > 0 ? String(qty) : '';
    renderOrderInfo();
    renderOrderHint();
  }

  async function submitOrder() {
    var validation = validateOrderForm();
    if (!validation.ok) {
      setOrderHint('error', validation.message);
      showToast(validation.message, 'error');
      return;
    }
    var quote = currentQuote();
    var symbol = state.selected;
    var accountId = state.accountId;
    var epoch = state.accountEpoch;
    var actionLabel = validation.close ? '平仓' : (validation.side === 'buy' ? '开多' : '开空');
    var closeLeverage = null;
    state.orderBusy = true;
    updateSubmitState();
    try {
      var body = {
        symbol: symbol,
        side: validation.side,
        type: state.orderType,
        qty: validation.qty,
        leverage: validation.leverage
      };
      if (state.orderType === 'limit') body.limitPrice = validation.limitPrice;
      if (validation.close) body.close = true;
      if (!validation.close) {
        if (validation.takeProfit != null) body.takeProfit = validation.takeProfit;
        if (validation.stopLoss != null) body.stopLoss = validation.stopLoss;
      }
      var res = await api('/api/accounts/' + encodeURIComponent(accountId) + '/orders', { method: 'POST', body: body });
      if (epoch !== state.accountEpoch) return;
      var order = res && res.order;
      var fill = res && res.fill;
      var levText = (Number(validation.leverage) || 1) > 1 ? ' ' + validation.leverage + 'x' : '';
      if (fill) {
        setOrderHint('success', actionLabel + '已成交：' + (quote ? quote.name : symbol) +
          ' ' + fmtQty(fill.qty, validation.market) + ' ' + qtyUnit(validation.market) + levText +
          ' @ ' + fmtPrice(fill.price, symbol) + '，费用 ' + fmtMoney(fill.fees, validation.currency) +
          (fill.realizedPnl != null && validation.close ? '，实现盈亏 ' + fmtSignedMoney(fill.realizedPnl, validation.currency) : ''));
        showToast(actionLabel + '成功：' + (quote ? quote.name : symbol) + ' ' +
          fmtQty(fill.qty, validation.market) + ' ' + qtyUnit(validation.market) + levText, 'success');
        if (validation.close) {
          var qtyInput = $('#order-qty');
          if (qtyInput) qtyInput.value = '';
          state.orderAction = 'long';
          state.showTpSl = false;
          clearTpslInputs();
          var closeMarket = marketOf(symbol);
          var rememberedLev = state.prefs && state.prefs.leverageByMarket
            ? state.prefs.leverageByMarket[closeMarket] : null;
          state.leverage = clampLeverage(closeMarket, rememberedLev || 1);
          closeLeverage = state.leverage;
        }
      } else {
        setOrderHint('success', '限价委托已提交，等待撮合（委托价 ' + fmtPrice(order ? order.limitPrice : validation.limitPrice, symbol) + '）');
        showToast('限价委托已提交，可在「当前委托」中查看', 'success');
      }
      state.auxLoadedAt = Date.now();
      await Promise.allSettled([
        loadAccountView(epoch),
        refreshQuotes(),
        loadActiveTabData()
      ]);
      // A concurrent quote frame may have rendered against the pre-close view
      // and locked the selector to the old position leverage; restore the market
      // preference before the final render.
      if (closeLeverage != null) state.leverage = closeLeverage;
      renderAll();
      loadTradableCandidates();
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      var friendly = orderErrorMessage(err, marketOf(state.selected));
      setOrderHint('error', '下单失败：' + friendly);
      showToast('下单失败：' + friendly, 'error');
    } finally {
      state.orderBusy = false;
      updateSubmitState();
    }
  }

  async function prefillClose(symbol) {
    var pos = findPosition(symbol);
    if (!pos) return;
    await selectSymbol(symbol);
    var quote = quoteOf(symbol) || currentQuote();
    var priceInput = $('#order-price');
    var qtyInput = $('#order-qty');
    setOrderType('limit');
    if (priceInput && quote) priceInput.value = Number(quote.price).toFixed(precisionFor(symbol, quote.price));
    setTradeAction('close');
    if (qtyInput) {
      var qty = Number(pos.availableQty != null ? pos.availableQty : pos.qty) || 0;
      qtyInput.value = qty > 0 ? String(roundTo(qty, qtyDigits(pos.market))) : '';
    }
    renderOrderInfo();
    renderOrderHint();
    var panel = $('.order-panel');
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (qtyInput) qtyInput.focus();
  }

  async function reversePosition(symbol) {
    var pos = findPosition(symbol);
    if (!pos) return;
    var side = positionSide(pos);
    var targetSide = side === 'long' ? 'short' : 'long';
    var leverage = Number(pos.leverage) || 1;
    var qty = Number(pos.availableQty != null ? pos.availableQty : pos.qty) || 0;
    if (qty <= 0) return;
    if (!allowShortFor(pos.market)) {
      showToast('该市场不支持做空，无法反手', 'warn');
      return;
    }
    var confirmed = await askConfirm(
      '反手',
      '将先平掉 ' + fmtQty(qty, pos.market) + ' ' + qtyUnit(pos.market) + ' 的' +
      (side === 'long' ? '多' : '空') + '仓，再以 ' + leverage + 'x 杠杆开' +
      (targetSide === 'long' ? '多' : '空') + '仓。确定继续吗？',
      '确认反手'
    );
    if (!confirmed) return;
    var accountId = state.accountId;
    var epoch = state.accountEpoch;
    try {
      await api('/api/accounts/' + encodeURIComponent(accountId) + '/orders', {
        method: 'POST',
        body: {
          symbol: symbol,
          side: side === 'long' ? 'sell' : 'buy',
          type: 'market',
          qty: qty,
          close: true,
          leverage: leverage
        }
      });
      if (epoch !== state.accountEpoch) return;
      await loadAccountView(epoch);
      await refreshQuotes();
      renderAll();
      try {
        await api('/api/accounts/' + encodeURIComponent(accountId) + '/orders', {
          method: 'POST',
          body: {
            symbol: symbol,
            side: targetSide === 'long' ? 'buy' : 'sell',
            type: 'market',
            qty: qty,
            leverage: leverage
          }
        });
        showToast('反手成功：已平仓并开' + (targetSide === 'long' ? '多' : '空') + ' ' + leverage + 'x', 'success');
      } catch (openErr) {
        showToast('已平仓，但反向开仓失败：' + orderErrorMessage(openErr) + '；请手动重新开仓', 'error');
      }
      await Promise.allSettled([loadAccountView(epoch), refreshQuotes()]);
      renderAll();
      loadTradableCandidates();
    } catch (err) {
      showToast('反手失败（原仓位未变）：' + orderErrorMessage(err), 'error');
      await Promise.allSettled([loadAccountView(epoch), refreshQuotes()]);
      renderAll();
    }
  }

  async function savePositionProtect() {
    var pos = currentPosition();
    if (!pos) {
      showToast('当前标的没有持仓', 'warn');
      return;
    }
    var tpRaw = ($('#order-tp').value || '').trim();
    var slRaw = ($('#order-sl').value || '').trim();
    var tp = tpRaw ? Number(tpRaw) : null;
    var sl = slRaw ? Number(slRaw) : null;
    if (tp != null && (!isFinite(tp) || tp <= 0)) { setOrderHint('error', '止盈价无效'); return; }
    if (sl != null && (!isFinite(sl) || sl <= 0)) { setOrderHint('error', '止损价无效'); return; }
    var epoch = state.accountEpoch;
    try {
      await api('/api/accounts/' + encodeURIComponent(state.accountId) + '/positions/' + encodeURIComponent(pos.symbol) + '/protect', {
        method: 'POST',
        body: { takeProfit: tp, stopLoss: sl }
      });
      showToast('止盈止损已保存到持仓保护', 'success');
      setOrderHint('success', '已更新持仓保护：止盈 ' + (tp != null ? fmtPrice(tp, pos.symbol) : '未设置') +
        '，止损 ' + (sl != null ? fmtPrice(sl, pos.symbol) : '未设置'));
      await Promise.allSettled([loadAccountView(epoch), refreshQuotes()]);
      renderAll();
    } catch (err) {
      setOrderHint('error', '保护设置失败：' + orderErrorMessage(err));
      showToast('保护设置失败：' + orderErrorMessage(err), 'error');
    }
  }

  async function cancelOrder(orderId) {
    if (!state.accountId || !orderId) return;
    var confirmed = await askConfirm('撤销委托', '确定撤销该笔未成交委托吗？', '确认撤单');
    if (!confirmed) return;
    var epoch = state.accountEpoch;
    try {
      await api('/api/accounts/' + encodeURIComponent(state.accountId) + '/orders/' + encodeURIComponent(orderId), { method: 'DELETE' });
      if (epoch !== state.accountEpoch) return;
      if (state.editingOrderId === orderId) {
        state.editingOrderId = null;
        state.editingPrice = '';
      }
      showToast('委托已撤销', 'success');
      state.auxLoadedAt = Date.now();
      await Promise.allSettled([loadAccountView(epoch), loadActiveTabData()]);
      renderAll();
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      showToast('撤单失败：' + errorText(err), 'error');
    }
  }

  function startEditOrder(orderId) {
    var orders = (state.view && state.view.openOrders) || [];
    var order = orders.find(function (item) { return item.id === orderId; });
    if (!order) return;
    if (order.status !== 'open' || order.type !== 'limit') {
      showToast('只有未成交的限价单可以改价', 'warn');
      return;
    }
    state.editingOrderId = orderId;
    state.editingPrice = String(order.limitPrice != null ? order.limitPrice : '');
    renderOrders();
  }

  function cancelEditOrder() {
    state.editingOrderId = null;
    state.editingPrice = '';
    renderOrders();
  }

  async function saveOrderPrice() {
    if (!state.editingOrderId) return;
    var price = Number(state.editingPrice);
    if (!isFinite(price) || price <= 0) {
      showToast('请输入有效的委托价格', 'error');
      return;
    }
    var orderId = state.editingOrderId;
    var epoch = state.accountEpoch;
    try {
      await api('/api/accounts/' + encodeURIComponent(state.accountId) + '/orders/' + encodeURIComponent(orderId), {
        method: 'PATCH',
        body: { limitPrice: price }
      });
      if (epoch !== state.accountEpoch) return;
      state.editingOrderId = null;
      state.editingPrice = '';
      showToast('委托价格已修改', 'success');
      await Promise.allSettled([loadAccountView(epoch), loadActiveTabData()]);
      renderAll();
    } catch (err) {
      showToast('改价失败：' + orderErrorMessage(err), 'error');
    }
  }

  // ------------------------------------------------------ margin mode / risk

  function openMarginModeModal() {
    if (!state.view) {
      showToast('请先创建账户', 'warn');
      return;
    }
    var mode = (state.view.account && state.view.account.marginMode) || state.view.marginMode || 'isolated';
    $$('input[name="margin-mode"]').forEach(function (radio) { radio.checked = radio.value === mode; });
    var positions = (state.view.positions || []).length;
    var openOrders = (state.view.openOrders || []).length;
    var locked = positions + openOrders > 0;
    var lockEl = $('#margin-mode-locked');
    if (lockEl) {
      lockEl.hidden = !locked;
      lockEl.textContent = locked
        ? '当前有 ' + positions + ' 个持仓、' + openOrders + ' 笔未成交委托，无法切换保证金模式。请先全部平仓并撤单。'
        : '';
    }
    var errEl = $('#margin-mode-error');
    if (errEl) errEl.hidden = true;
    var btn = $('#btn-apply-margin-mode');
    if (btn) btn.disabled = locked;
    openModal('modal-margin-mode');
  }

  async function applyMarginMode() {
    if (!state.accountId) return;
    var checked = document.querySelector('input[name="margin-mode"]:checked');
    if (!checked) return;
    var mode = checked.value === 'cross' ? 'cross' : 'isolated';
    var epoch = state.accountEpoch;
    var btn = $('#btn-apply-margin-mode');
    if (btn) btn.disabled = true;
    try {
      await api('/api/accounts/' + encodeURIComponent(state.accountId), {
        method: 'PATCH',
        body: { marginMode: mode }
      });
      closeModal('modal-margin-mode');
      showToast('保证金模式已切换为' + (mode === 'cross' ? '全仓' : '逐仓'), 'success');
      await Promise.allSettled([loadAccountView(epoch), refreshQuotes()]);
      renderAll();
    } catch (err) {
      var errEl = $('#margin-mode-error');
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.code === 'MARGIN_MODE_LOCKED'
          ? '有持仓或挂单时不能切换保证金模式：请先平仓并撤单。'
          : orderErrorMessage(err);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function liquidationKey(item) {
    return String(item && item.t) + '|' + String(item && item.symbol) + '|' + String(item && item.reason);
  }

  function nameForSymbol(symbol) {
    if (!symbol) return '';
    var quote = quoteOf(symbol);
    if (quote && quote.name) return quote.name;
    var pos = findPosition(symbol);
    if (pos && pos.name) return pos.name;
    return displayCode(symbol, null);
  }

  function processLiquidations(list) {
    if (!Array.isArray(list)) return;
    if (!state.liquidationBaselineDone) {
      list.forEach(function (item) { state.seenLiquidations[liquidationKey(item)] = true; });
      state.liquidationBaselineDone = true;
      return;
    }
    list.forEach(function (item) {
      var key = liquidationKey(item);
      if (state.seenLiquidations[key]) return;
      state.seenLiquidations[key] = true;
      var name = item.name || nameForSymbol(item.symbol) || item.symbol || '持仓';
      if (item.reason === 'TAKE_PROFIT') showToast('止盈触发：' + name, 'success');
      else if (item.reason === 'STOP_LOSS') showToast('止损触发：' + name, 'warn');
      else showToast('⚠ ' + name + ' 已强平', 'error');
    });
  }

  function renderMarginStrip() {
    var strip = $('#margin-strip');
    var riskBanner = $('#risk-banner');
    var view = state.view;
    if (!strip) return;
    if (!view) {
      strip.hidden = true;
      if (riskBanner) riskBanner.hidden = true;
      return;
    }
    strip.hidden = false;
    var mode = (view.account && view.account.marginMode) || view.marginMode || 'isolated';
    var badge = $('#margin-mode-badge');
    if (badge) {
      badge.textContent = mode === 'cross' ? '全仓' : '逐仓';
      badge.classList.toggle('is-cross', mode === 'cross');
    }
    var multiplier = settingsMultiplier();
    var multBadge = $('#account-multiplier-badge');
    if (multBadge) {
      multBadge.textContent = '倍率 ×' + formatMultiplier(multiplier);
      multBadge.title = '账户杠杆上限倍率 ×' + multiplier + '\n' + accountLeverageCapsText();
    }
    setText('#account-leverage-caps', accountLeverageCapsText());
    var positions = view.positions || [];
    var rates = view.fxRates || {};
    var marginUsed = view.marginUsed != null ? Number(view.marginUsed) : positions.reduce(function (sum, pos) {
      return sum + (pos.margin != null ? Number(pos.margin) : Number(pos.marketValue || 0)) * (Number(rates[pos.currency]) || 1);
    }, 0);
    var totalInterest = view.totalInterest != null ? Number(view.totalInterest) : positions.reduce(function (sum, pos) {
      return sum + (Number(pos.accruedInterest) || 0) * (Number(rates[pos.currency]) || 1);
    }, 0);
    var marginAvailable = view.marginAvailable != null ? Number(view.marginAvailable) : buyingPowerOf('CNY');
    var risk = view.riskRatio != null ? Number(view.riskRatio) : null;
    setText('#margin-used', fmtMoney(marginUsed, 'CNY'));
    setText('#margin-available', fmtMoney(marginAvailable, 'CNY'));
    setText('#account-risk', risk != null ? fmtRisk(risk) : '--');
    var riskEl = $('#account-risk');
    if (riskEl) riskEl.className = 'num risk-text ' + riskClass(risk);
    setText('#total-interest', fmtMoney(totalInterest, 'CNY'));
    if (riskBanner) {
      if (risk != null && risk >= 0.8) {
        riskBanner.hidden = false;
        riskBanner.classList.toggle('is-critical', risk >= 0.9);
        riskBanner.textContent = risk >= 0.9
          ? '⚠ 账户风险率 ' + fmtRisk(risk) + '，已接近强平！请立即减仓或补充保证金。'
          : '⚠ 账户风险率 ' + fmtRisk(risk) + '，超过 80% 预警线，请注意强平风险。';
      } else {
        riskBanner.hidden = true;
      }
    }
  }

  // ---------------------------------------------------------------- tabs load

  function setTabLoading(tab, loading) {
    state.loadingTab = loading ? tab : null;
  }

  function applyTabUI() {
    var tab = state.activeTab;
    if (VALID_TABS.indexOf(tab) < 0) tab = 'positions';
    $$('#tabs .tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    $$('.tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === tab);
    });
    renderTabsMode();
  }

  function activateTab(tab) {
    if (!tab || VALID_TABS.indexOf(tab) < 0 || state.activeTab === tab) return;
    state.activeTab = tab;
    patchPrefs({ activeTab: tab });
    applyTabUI();
    state.auxLoadedAt = Date.now();
    renderTabSummary();
    loadActiveTabData();
    if (tab === 'equity') {
      // The panel becomes visible right before the chart is created; give the
      // browser one frame so the container has a measurable size.
      requestAnimationFrame(renderEquity);
    }
  }

  function loadActiveTabData() {
    if (!state.accountId) {
      renderAll();
      return Promise.resolve();
    }
    var id = encodeURIComponent(state.accountId);
    var epoch = state.accountEpoch;
    if (state.activeTab === 'history') return loadHistory(id, epoch);
    if (state.activeTab === 'trades') return loadTrades(id, epoch);
    if (state.activeTab === 'stats') return loadStats(id, epoch);
    if (state.activeTab === 'equity') return loadEquity(id, epoch);
    return Promise.resolve();
  }

  async function loadHistory(id, epoch) {
    setTabLoading('history', true);
    renderHistory();
    try {
      var res = await api('/api/accounts/' + id + '/orders?status=' + encodeURIComponent(state.historyFilter) + '&limit=200');
      if (epoch !== state.accountEpoch) return;
      state.historyOrders = (res && res.orders) || [];
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      state.historyOrders = [];
      showToast('历史委托加载失败：' + errorText(err), 'error');
    } finally {
      if (epoch === state.accountEpoch) {
        setTabLoading('history', false);
        renderHistory();
        renderTabSummary();
      }
    }
  }

  async function loadTrades(id, epoch) {
    setTabLoading('trades', true);
    renderTrades();
    try {
      var res = await api('/api/accounts/' + id + '/trades?limit=200');
      if (epoch !== state.accountEpoch) return;
      state.trades = (res && res.trades) || [];
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      state.trades = [];
      showToast('成交记录加载失败：' + errorText(err), 'error');
    } finally {
      if (epoch === state.accountEpoch) {
        setTabLoading('trades', false);
        renderTrades();
        renderTabSummary();
      }
    }
  }

  async function loadStats(id, epoch) {
    setTabLoading('stats', true);
    renderStats();
    try {
      var res = await api('/api/accounts/' + id + '/stats');
      if (epoch !== state.accountEpoch) return;
      state.stats = res || null;
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      state.stats = null;
      showToast('账户统计加载失败：' + errorText(err), 'error');
    } finally {
      if (epoch === state.accountEpoch) {
        setTabLoading('stats', false);
        renderStats();
        renderTabSummary();
      }
    }
  }

  async function loadEquity(id, epoch) {
    setTabLoading('equity', true);
    renderEquity();
    try {
      var res = await api('/api/accounts/' + id + '/equity?range=' + encodeURIComponent(state.equityRange));
      if (epoch !== state.accountEpoch) return;
      state.equity = res || null;
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      state.equity = null;
      showToast('净值曲线加载失败：' + errorText(err), 'error');
    } finally {
      if (epoch === state.accountEpoch) {
        setTabLoading('equity', false);
        renderEquity();
        renderTabSummary();
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  // ------------------------------------------------------------- live updates

  function updateLiveUI(dirs) {
    updateWatchlistLive(dirs);
    renderQuoteHeader();
    var quote = currentQuote();
    if (quote) {
      updateChartLive(quote);
      flashValue($('#quote-price'), dirs[state.selected]);
      flashValue($('#quote-change'), dirs[state.selected]);
    }
    updatePositionsLive(dirs);
    renderOrderInfo();
  }

  function updateWatchlistLive(dirs) {
    state.watchlist.forEach(function (symbol) {
      var ref = state.watchRefs[symbol];
      var quote = quoteOf(symbol);
      if (!ref || !quote) return;
      ref.price.textContent = fmtPrice(quote.price, symbol);
      ref.price.className = 'w-price num ' + pnlClass(quote.change);
      ref.pct.textContent = quote.changePct != null ? fmtPct(quote.changePct) : '--';
      ref.pct.className = 'w-pct num ' + pnlClass(quote.changePct);
      if (dirs[symbol]) {
        flashValue(ref.price, dirs[symbol]);
        flashValue(ref.pct, dirs[symbol]);
      }
    });
  }

  function updatePositionsLive(dirs) {
    if (!state.view || !Array.isArray(state.view.positions)) return;
    state.view.positions.forEach(function (pos) {
      var ref = state.positionRefs[pos.symbol];
      var quote = quoteOf(pos.symbol);
      if (!ref || !quote || quote.price == null) return;
      var m = positionMetrics(pos, quote);
      ref.price.textContent = fmtPrice(m.last, pos.symbol);
      ref.price.className = 'ta-r num';
      ref.mv.textContent = fmtMoney(m.marketValue, pos.currency);
      ref.pnl.textContent = fmtSignedMoney(m.unrealized, pos.currency);
      ref.pnl.className = 'ta-r num ' + pnlClass(m.unrealized);
      ref.pct.textContent = fmtPct(m.unrealizedPct);
      ref.pct.className = 'ta-r num ' + pnlClass(m.unrealizedPct);
      ref.today.textContent = fmtSignedMoney(m.today, pos.currency);
      ref.today.className = 'ta-r num ' + pnlClass(m.today);
      if (dirs[pos.symbol]) flashValue(ref.price, dirs[pos.symbol]);
    });
  }

  function renderAll() {
    syncAccountSelect();
    renderTopbar();
    renderMarginStrip();
    renderWatchlist();
    renderSmartChips('watch-chips', true);
    if (state.universe.open) renderSmartChips('universe-chips', true);
    renderQuoteHeader();
    renderQuoteStats();
    renderIntervals();
    renderChartModeButtons();
    renderOrderInfo();
    renderOrderHint();
    renderPositions();
    if (!state.editingOrderId) renderOrders();
    renderTabCounts();
    renderTabSummary();
    renderConnection();
    if (state.activeTab === 'history') renderHistory();
    if (state.activeTab === 'trades') renderTrades();
    if (state.activeTab === 'stats') renderStats();
    if (state.activeTab === 'equity') renderEquity();
  }
  function renderTopbar() {
    var view = state.view;
    var equityEl = $('#metric-equity');
    var todayEl = $('#metric-today-pnl');
    var totalEl = $('#metric-total-pnl');
    if (!equityEl || !todayEl || !totalEl) return;
    if (!view) {
      equityEl.textContent = '--';
      equityEl.className = 'metric-value num flat';
      todayEl.textContent = '--';
      todayEl.className = 'metric-value num flat';
      totalEl.textContent = '--';
      totalEl.className = 'metric-value num flat';
      return;
    }
    equityEl.textContent = fmtMoney(view.equity && view.equity.total, 'CNY');
    equityEl.className = 'metric-value num';
    var today = Number(view.todayPnl) || 0;
    todayEl.textContent = fmtSignedMoney(today, 'CNY');
    todayEl.className = 'metric-value num ' + pnlClass(today);
    var total = Number(view.totalPnl) || 0;
    var totalPct = view.totalPnlPct;
    totalEl.textContent = fmtSignedMoney(total, 'CNY') +
      (totalPct != null && isFinite(totalPct) ? ' (' + fmtPct(totalPct) + ')' : '');
    totalEl.className = 'metric-value num ' + pnlClass(total);
  }

  function renderConnection() {
    var dot = $('#conn-dot');
    var label = $('#conn-label');
    var timeEl = $('#conn-time');
    var box = $('#conn-box');
    if (!dot || !label) return;
    var mode = state.stream.mode;
    var displayMode = mode;
    if (mode === 'poll' && state.lastQuoteError &&
      (!state.lastQuoteAt || Date.now() - state.lastQuoteAt > 6000)) {
      displayMode = 'offline';
    }
    var dotState = 'unknown';
    var labelText = '连接中…';
    if (displayMode === 'stream') { dotState = 'ok'; labelText = '实时推送'; }
    else if (displayMode === 'poll') { dotState = 'warn'; labelText = '轮询'; }
    else if (displayMode === 'offline') { dotState = 'err'; labelText = '离线'; }

    var lastFrame = state.stream.lastQuotesFrameAt || state.lastQuoteAt;
    var titleParts = [];
    titleParts.push('行情通道：' + labelText + (MOCK ? '（模拟）' : ''));
    titleParts.push('最后行情帧：' + (lastFrame ? fmtClock(lastFrame) : '尚未收到'));
    if (state.stream.fallbackReason) titleParts.push('兜底原因：' + state.stream.fallbackReason);
    if (state.lastQuoteError) titleParts.push('行情错误：' + state.lastQuoteError);
    if (state.quoteErrors && state.quoteErrors.length) {
      titleParts.push('部分标的失败：' + state.quoteErrors.map(function (e) { return e.symbol; }).join('、'));
    }
    if (state.health && Array.isArray(state.health.sources) && state.health.sources.length) {
      var sources = state.health.sources;
      var okCount = sources.filter(function (s) { return s.ok; }).length;
      titleParts.push('数据源：' + okCount + '/' + sources.length + ' 正常');
      sources.forEach(function (source) {
        titleParts.push('  ' + source.source + '：' + (source.ok ? '正常' : '异常') +
          (source.latencyMs != null ? ' ' + source.latencyMs + 'ms' : '') +
          (source.message ? '（' + source.message + '）' : ''));
      });
    }
    if (displayMode === 'offline') {
      dotState = 'err';
      titleParts.push('实时推送与轮询均不可用，将自动重试');
    }
    titleParts.push('点击查看数据源状态');
    dot.dataset.state = dotState;
    label.textContent = labelText;
    if (timeEl) timeEl.textContent = lastFrame ? '最后帧 ' + fmtClock(lastFrame) : '等待行情…';
    if (box) box.title = titleParts.join('\n');
  }

  function renderWatchlist() {
    var container = $('#watch-list');
    if (!container) return;
    var html = '';
    state.watchlist.forEach(function (symbol) {
      var quote = quoteOf(symbol);
      var error = quoteErrorFor(symbol);
      var name = quote && quote.name ? quote.name : symbol;
      var code = displayCode(symbol, quote);
      var price = quote ? fmtPrice(quote.price, symbol) : '--';
      var changePct = quote && quote.changePct != null ? quote.changePct : null;
      var cls = pnlClass(changePct);
      var quoteHTML = error
        ? '<div class="watch-quote-error"><span class="w-unavailable">数据源不可用</span>' +
          '<button type="button" class="link-btn w-retry" data-retry-symbol="' + escapeHtml(symbol) + '">重试</button></div>'
        : '<span class="w-price num ' + cls + '">' + price + '</span>' +
          '<span class="w-pct num ' + cls + '">' + (changePct != null ? fmtPct(changePct) : '--') + '</span>';
      html += '<div class="watch-row' + (symbol === state.selected ? ' active' : '') +
        (error ? ' is-source-error' : '') + '" data-symbol="' +
        escapeHtml(symbol) + '" role="button" tabindex="0">' +
        '<div class="watch-name"><span class="w-name">' + escapeHtml(name) + '</span>' +
        '<span class="w-code">' + escapeHtml(code) + '</span></div>' +
        '<div class="watch-quote">' + quoteHTML + '</div>' +
        '<button type="button" class="w-del" data-del-symbol="' + escapeHtml(symbol) + '" title="删除自选" aria-label="删除自选">×</button>' +
        '</div>';
    });
    if (!state.watchlist.length) {
      html = '<div class="empty-state" style="font-size:11.5px">自选列表为空<br>用上方搜索添加标的</div>';
    }
    container.innerHTML = html;
    state.watchRefs = {};
    $$('.watch-row', container).forEach(function (row) {
      var symbol = row.getAttribute('data-symbol');
      var priceEl = row.querySelector('.w-price');
      var pctEl = row.querySelector('.w-pct');
      if (symbol && priceEl && pctEl) state.watchRefs[symbol] = { row: row, price: priceEl, pct: pctEl };
    });
    setText('#watch-count', String(state.watchlist.length));
  }

  function renderQuoteHeader() {
    var quote = currentQuote();
    var nameEl = $('#quote-name');
    if (!nameEl) return;
    var quoteError = quoteErrorFor(state.selected);
    var sourceErrorEl = $('#quote-source-error');
    var changeEl = $('#quote-change');
    var pctEl = $('#quote-change-pct');
    var priceEl = $('#quote-price');
    if (!quote || quoteError) {
      setText('#quote-name', quote ? (quote.name || state.selected) : state.selected || '--');
      setText('#quote-code', quote ? displayCode(quote.symbol, quote) : '--');
      setText('#quote-market', state.selected ? marketLabel(marketOf(state.selected)) : '--');
      if (quoteError) {
        priceEl.hidden = true;
        changeEl.hidden = true;
        pctEl.hidden = true;
        if (sourceErrorEl) {
          sourceErrorEl.hidden = false;
          sourceErrorEl.title = quoteError.message;
        }
      } else {
        priceEl.hidden = false;
        changeEl.hidden = false;
        pctEl.hidden = false;
        if (sourceErrorEl) sourceErrorEl.hidden = true;
        priceEl.textContent = '--';
        priceEl.className = 'num flat';
        changeEl.textContent = '--';
        changeEl.className = 'num flat';
        pctEl.textContent = '--';
        pctEl.className = 'num change-pill flat';
      }
      var staleEl = $('#quote-stale');
      if (staleEl) staleEl.hidden = true;
      return;
    }
    priceEl.hidden = false;
    changeEl.hidden = false;
    pctEl.hidden = false;
    if (sourceErrorEl) sourceErrorEl.hidden = true;
    setText('#quote-name', quote.name || state.selected);
    setText('#quote-code', displayCode(quote.symbol, quote));
    setText('#quote-market', marketLabel(quote.market));
    priceEl.textContent = fmtPrice(quote.price, quote.symbol);
    priceEl.className = 'num ' + pnlClass(quote.change);
    changeEl.textContent = (quote.change > 0 ? '+' : '') + fmtPrice(quote.change, quote.symbol);
    changeEl.className = 'num ' + pnlClass(quote.change);
    pctEl.textContent = fmtPct(quote.changePct);
    pctEl.className = 'num change-pill ' + pnlClass(quote.changePct);
    var stale = $('#quote-stale');
    if (stale) stale.hidden = !quote.stale;
  }

  function renderQuoteStats() {
    var quote = currentQuote();
    var stats = [
      ['#st-open', quote ? fmtPrice(quote.open, quote.symbol) : '--'],
      ['#st-high', quote ? fmtPrice(quote.high, quote.symbol) : '--'],
      ['#st-low', quote ? fmtPrice(quote.low, quote.symbol) : '--'],
      ['#st-prev', quote ? fmtPrice(quote.prevClose, quote.symbol) : '--'],
      ['#st-volume', quote ? fmtCompact(quote.volume) : '--'],
      ['#st-amount', quote ? fmtCompact(quote.amount) : '--']
    ];
    stats.forEach(function (pair) { setText(pair[0], pair[1]); });
    setText('#st-pe', quote && quote.extra && quote.extra.pe != null ? fmtNumber(quote.extra.pe, 2, 2) : '--');
    var extraWrap = $('#st-extra-wrap');
    if (extraWrap) extraWrap.hidden = !(quote && quote.extra && quote.extra.pe != null);
  }

  function renderIntervals() {
    var group = $('#interval-group');
    if (!group) return;
    var intervals = marketIntervals();
    if (intervals.indexOf(state.interval) < 0) state.interval = pickInterval(marketOf(state.selected), null);
    group.innerHTML = intervals.map(function (interval) {
      return '<button type="button" class="seg' + (interval === state.interval ? ' active' : '') +
        '" data-interval="' + escapeHtml(interval) + '">' + escapeHtml(interval) + '</button>';
    }).join('');
  }

  function renderChartModeButtons() {
    $$('#chart-mode-group [data-chart-mode]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-chart-mode') === state.chartMode);
    });
    var chips = $('#ma-chips');
    if (chips) chips.hidden = state.chartMode !== 'candles';
  }

  function renderPositions() {
    var table = $('#table-positions');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    var empty = $('#empty-positions');
    var wrap = table.parentElement;
    var positions = (state.view && state.view.positions) || [];
    if (!positions.length) {
      tbody.innerHTML = '';
      state.positionRefs = {};
      if (wrap) wrap.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.innerHTML = state.accountId ? emptyStateHTML('positions') : '<div class="empty-title">请先创建模拟账户</div>';
      }
      return;
    }
    if (wrap) wrap.hidden = false;
    if (empty) empty.hidden = true;
    tbody.innerHTML = positions.map(function (pos) {
      var qty = Number(pos.qty) || 0;
      var avail = Number(pos.availableQty != null ? pos.availableQty : qty) || 0;
      var side = positionSide(pos);
      var m = positionMetrics(pos);
      var last = m.last;
      var avg = m.avg;
      var leverage = Number(pos.leverage) || 1;
      var risk = pos.riskRatio != null ? Number(pos.riskRatio) : null;
      var rowCls = risk != null && risk >= 0.9 ? ' class="row-risk-critical"'
        : (risk != null && risk >= 0.8 ? ' class="row-risk-high"' : '');
      return '<tr data-symbol="' + escapeHtml(pos.symbol) + '"' + rowCls + '>' +
        '<td><div class="cell-sym"><span class="cs-name">' + escapeHtml(pos.name || pos.symbol) + '</span>' +
        '<span class="cs-code">' + escapeHtml(displayCode(pos.symbol, pos)) + '</span></div></td>' +
        '<td><span class="dir-tag ' + side + '">' + (side === 'long' ? '多' : '空') + '</span></td>' +
        '<td>' + escapeHtml(marketLabel(pos.market)) + '</td>' +
        '<td class="ta-r num">' + fmtQty(qty, pos.market) + '</td>' +
        '<td class="ta-r num">' + fmtQty(avail, pos.market) + '</td>' +
        '<td class="ta-r num"><span class="lev-tag' + (leverage > 1 ? ' is-max' : '') + '">' + leverage + 'x</span></td>' +
        '<td class="ta-r num">' + fmtPrice(avg, pos.symbol) + '</td>' +
        '<td class="ta-r num" data-col="last-price">' + fmtPrice(last, pos.symbol) + '</td>' +
        '<td class="ta-r num">' + (pos.margin != null ? fmtMoney(pos.margin, pos.currency) : '--') + '</td>' +
        '<td class="ta-r num">' + (pos.liqPrice != null ? fmtPrice(pos.liqPrice, pos.symbol) : '--') + '</td>' +
        '<td class="ta-r num risk-text ' + riskClass(risk) + '">' + fmtRisk(risk) + '</td>' +
        '<td class="ta-r num" data-col="market-value">' + fmtMoney(m.marketValue, pos.currency) + '</td>' +
        '<td class="ta-r num ' + pnlClass(m.unrealized) + '" data-col="unrealized">' + fmtSignedMoney(m.unrealized, pos.currency) + '</td>' +
        '<td class="ta-r num ' + pnlClass(m.unrealizedPct) + '" data-col="unrealized-pct">' + fmtPct(m.unrealizedPct) + '</td>' +
        '<td class="ta-r num ' + pnlClass(m.today) + '" data-col="today-pnl">' + fmtSignedMoney(m.today, pos.currency) + '</td>' +
        '<td class="ta-r num">' + (pos.accruedInterest != null && Number(pos.accruedInterest) > 0
          ? fmtMoney(pos.accruedInterest, pos.currency) : '--') + '</td>' +
        '<td class="ta-r cell-actions"><button type="button" class="link-btn is-danger" data-action="close" data-symbol="' +
        escapeHtml(pos.symbol) + '">平仓</button>' +
        '<button type="button" class="link-btn" data-action="reverse" data-symbol="' +
        escapeHtml(pos.symbol) + '">反手</button></td>' +
        '</tr>';
    }).join('');
    state.positionRefs = {};
    $$('tr[data-symbol]', tbody).forEach(function (row) {
      var symbol = row.getAttribute('data-symbol');
      state.positionRefs[symbol] = {
        price: row.querySelector('[data-col="last-price"]'),
        mv: row.querySelector('[data-col="market-value"]'),
        pnl: row.querySelector('[data-col="unrealized"]'),
        pct: row.querySelector('[data-col="unrealized-pct"]'),
        today: row.querySelector('[data-col="today-pnl"]')
      };
    });
  }

  function renderOrders() {
    var table = $('#table-orders');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    var empty = $('#empty-orders');
    var wrap = table.parentElement;
    var orders = (state.view && state.view.openOrders) || [];
    if (!orders.length) {
      tbody.innerHTML = '';
      state.editingOrderId = null;
      state.editingPrice = '';
      if (wrap) wrap.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.innerHTML = state.accountId ? emptyStateHTML('orders') : '<div class="empty-title">请先创建模拟账户</div>';
      }
      return;
    }
    if (wrap) wrap.hidden = false;
    if (empty) empty.hidden = true;
    tbody.innerHTML = orders.map(function (order) {
      var editing = state.editingOrderId === order.id;
      var leverage = Number(order.leverage) || 1;
      var priceCell;
      if (editing) {
        priceCell = '<input class="order-edit-input" id="order-edit-price" type="number" step="any" min="0" value="' +
          escapeHtml(state.editingPrice) + '" aria-label="新的委托价格">' +
          '<span class="order-edit-actions">' +
          '<button type="button" class="link-btn" data-action="save-price" data-order-id="' + escapeHtml(order.id) + '">保存</button>' +
          '<button type="button" class="link-btn is-muted" data-action="cancel-edit" data-order-id="' + escapeHtml(order.id) + '">取消</button>' +
          '</span>';
      } else {
        priceCell = order.limitPrice != null ? fmtPrice(order.limitPrice, order.symbol) : '市价';
      }
      return '<tr data-order-id="' + escapeHtml(order.id) + '">' +
        '<td class="num">' + escapeHtml(fmtDateTime(order.createdAt)) + '</td>' +
        '<td><div class="cell-sym"><span class="cs-name">' + escapeHtml(order.name || order.symbol) + '</span>' +
        '<span class="cs-code">' + escapeHtml(displayCode(order.symbol, order)) + '</span></div></td>' +
        '<td><span class="side-tag ' + escapeHtml(order.side) + '">' + escapeHtml(SIDE_LABEL[order.side] || order.side) + '</span>' +
        (order.close ? '<span class="close-badge">平</span>' : '') + '</td>' +
        '<td>' + (order.type === 'limit' ? '限价' : '市价') + '</td>' +
        '<td class="ta-r num"><span class="lev-tag' + (leverage > 1 ? ' is-max' : '') + '">' + leverage + 'x</span></td>' +
        '<td class="ta-r num">' + priceCell + '</td>' +
        '<td class="ta-r num">' + fmtQty(order.qty, order.market) + '</td>' +
        '<td class="ta-r num">' + fmtQty(order.filledQty || 0, order.market) + '</td>' +
        '<td><span class="status-tag open">未成交</span></td>' +
        '<td class="ta-r cell-actions">' +
        (order.type === 'limit' && !editing
          ? '<button type="button" class="link-btn" data-action="edit-price" data-order-id="' + escapeHtml(order.id) + '">改价</button>'
          : '') +
        '<button type="button" class="link-btn is-danger" data-action="cancel" data-order-id="' +
        escapeHtml(order.id) + '">撤单</button></td>' +
        '</tr>';
    }).join('');
    if (state.editingOrderId) {
      var input = $('#order-edit-price');
      if (input) {
        input.focus();
        var len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) { /* noop */ }
      }
    }
  }

  function renderHistory() {
    var table = $('#table-history');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    var empty = $('#empty-history');
    var wrap = table.parentElement;
    var orders = state.historyOrders || [];
    var filter = $('#history-filter');
    if (filter) filter.value = state.historyFilter;
    if (!orders.length) {
      tbody.innerHTML = '';
      if (wrap) wrap.hidden = true;
      if (empty) {
        empty.hidden = false;
        if (state.loadingTab === 'history') empty.innerHTML = '<div class="empty-title">正在加载历史委托…</div>';
        else empty.innerHTML = state.accountId ? emptyStateHTML('history') : '<div class="empty-title">请先创建模拟账户</div>';
      }
      return;
    }
    if (wrap) wrap.hidden = false;
    if (empty) empty.hidden = true;
    tbody.innerHTML = orders.map(function (order) {
      var status = order.status || 'open';
      return '<tr>' +
        '<td class="num">' + escapeHtml(fmtDateTime(order.createdAt)) + '</td>' +
        '<td><div class="cell-sym"><span class="cs-name">' + escapeHtml(order.name || order.symbol) + '</span>' +
        '<span class="cs-code">' + escapeHtml(displayCode(order.symbol, order)) + '</span></div></td>' +
        '<td><span class="side-tag ' + escapeHtml(order.side) + '">' + escapeHtml(SIDE_LABEL[order.side] || order.side) + '</span></td>' +
        '<td>' + (order.type === 'limit' ? '限价' : '市价') + '</td>' +
        '<td class="ta-r num">' + (order.limitPrice != null ? fmtPrice(order.limitPrice, order.symbol) : '市价') + '</td>' +
        '<td class="ta-r num">' + fmtQty(order.qty, order.market) + '</td>' +
        '<td class="ta-r num">' + (order.avgFillPrice != null ? fmtPrice(order.avgFillPrice, order.symbol) : '--') + '</td>' +
        '<td class="ta-r num">' + fmtMoney(order.fees, 'CNY') + '</td>' +
        '<td><span class="status-tag ' + escapeHtml(status) + '">' + escapeHtml(STATUS_LABEL[status] || status) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderTrades() {
    var table = $('#table-trades');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    var empty = $('#empty-trades');
    var wrap = table.parentElement;
    var trades = state.trades || [];
    if (!trades.length) {
      tbody.innerHTML = '';
      if (wrap) wrap.hidden = true;
      if (empty) {
        empty.hidden = false;
        if (state.loadingTab === 'trades') empty.innerHTML = '<div class="empty-title">正在加载成交记录…</div>';
        else empty.innerHTML = state.accountId ? emptyStateHTML('trades') : '<div class="empty-title">请先创建模拟账户</div>';
      }
      return;
    }
    if (wrap) wrap.hidden = false;
    if (empty) empty.hidden = true;
    tbody.innerHTML = trades.map(function (trade) {
      var realized = trade.realizedPnl;
      return '<tr>' +
        '<td class="num">' + escapeHtml(fmtDateTime(trade.t)) + '</td>' +
        '<td><div class="cell-sym"><span class="cs-name">' + escapeHtml(trade.name || trade.symbol) + '</span>' +
        '<span class="cs-code">' + escapeHtml(displayCode(trade.symbol, trade)) + '</span></div></td>' +
        '<td><span class="side-tag ' + escapeHtml(trade.side) + '">' + escapeHtml(SIDE_LABEL[trade.side] || trade.side) + '</span></td>' +
        '<td class="ta-r num">' + fmtPrice(trade.price, trade.symbol) + '</td>' +
        '<td class="ta-r num">' + fmtQty(trade.qty, trade.market) + '</td>' +
        '<td class="ta-r num">' + fmtMoney(trade.fees, 'CNY') + '</td>' +
        '<td class="ta-r num ' + (trade.side === 'sell' ? pnlClass(realized) : 'flat') + '">' +
        (trade.side === 'sell' && realized != null ? fmtSignedMoney(realized, 'CNY') : '--') + '</td>' +
        '</tr>';
    }).join('');
  }

  function normalizeRate(rate) {
    if (rate == null || !isFinite(rate)) return null;
    return rate <= 1 ? rate * 100 : rate;
  }

  function renderStats() {
    var cards = $('#stat-cards');
    var empty = $('#empty-stats');
    var body = $('.stats-body');
    if (!cards) return;
    var stats = state.stats;
    if (!stats) {
      cards.innerHTML = '';
      if (body) body.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.loadingTab === 'stats' ? '正在加载统计数据…' : '暂无统计数据。';
      }
      return;
    }
    if (body) body.hidden = false;
    if (empty) empty.hidden = true;
    var winRate = normalizeRate(stats.winRate);
    var cardsData = [
      { label: '成交笔数', value: fmtNumber(stats.tradeCount || 0, 0), cls: '' },
      { label: '胜率', value: winRate != null ? fmtNumber(winRate, 2, 2) + '%' : '--', cls: winRate != null && winRate >= 50 ? 'up' : '' },
      { label: '盈亏比', value: stats.profitFactor != null ? fmtNumber(stats.profitFactor, 2, 2) : '--', cls: '' },
      { label: '最大回撤', value: stats.maxDrawdown != null ? fmtNumber(stats.maxDrawdown, 2, 2) + '%' : '--', cls: 'down' },
      { label: '夏普比率', value: stats.sharpe != null ? fmtNumber(stats.sharpe, 2, 2) : '--', cls: '' },
      { label: '总手续费', value: fmtMoney(stats.totalFees, 'CNY'), cls: '' }
    ];
    cards.innerHTML = cardsData.map(function (card) {
      return '<div class="metric-card"><div class="mc-label">' + escapeHtml(card.label) + '</div>' +
        '<div class="mc-value ' + card.cls + '">' + card.value + '</div></div>';
    }).join('');

    var byMarket = stats.byMarket || {};
    var marketRows = Object.keys(byMarket).map(function (key) {
      var entry = byMarket[key] || {};
      var rate = normalizeRate(entry.winRate);
      return '<tr><td>' + escapeHtml(marketLabel(key)) + '</td>' +
        '<td class="ta-r num">' + fmtNumber(entry.tradeCount || 0, 0) + '</td>' +
        '<td class="ta-r num ' + pnlClass(entry.realizedPnl) + '">' + fmtSignedMoney(entry.realizedPnl || 0, 'CNY') + '</td>' +
        '<td class="ta-r num">' + fmtMoney(entry.fees || 0, 'CNY') + '</td>' +
        '<td class="ta-r num">' + (rate != null ? fmtNumber(rate, 2, 2) + '%' : '--') + '</td></tr>';
    }).join('');
    var marketTable = $('#table-stat-market');
    if (marketTable) {
      marketTable.querySelector('tbody').innerHTML = marketRows ||
        '<tr><td colspan="5" class="empty-state" style="display:table-cell;padding:18px">暂无分市场统计</td></tr>';
    }

    var bySymbol = stats.bySymbol || [];
    var symbolTable = $('#table-stat-symbol');
    if (symbolTable) {
      symbolTable.querySelector('tbody').innerHTML = bySymbol.length ? bySymbol.map(function (entry) {
        return '<tr><td><div class="cell-sym"><span class="cs-name">' + escapeHtml(entry.name || entry.symbol) + '</span>' +
          '<span class="cs-code">' + escapeHtml(displayCode(entry.symbol, entry)) + '</span></div></td>' +
          '<td class="ta-r num">' + fmtNumber(entry.tradeCount || 0, 0) + '</td>' +
          '<td class="ta-r num ' + pnlClass(entry.realizedPnl) + '">' + fmtSignedMoney(entry.realizedPnl || 0, 'CNY') + '</td>' +
          '<td class="ta-r num">' + fmtMoney(entry.fees || 0, 'CNY') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="empty-state" style="display:table-cell;padding:18px">暂无分标的统计</td></tr>';
    }
  }

  function renderEquity() {
    var chartContainer = $('#equity-chart');
    var meta = $('#equity-meta');
    var empty = $('#empty-equity');
    var legend = $('#equity-legend');
    if (!chartContainer || !meta) return;
    var equity = state.equity;

    $$('#equity-range-group [data-equity-range]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-equity-range') === state.equityRange);
    });

    if (!state.accountId) {
      meta.innerHTML = '';
      chartContainer.hidden = true;
      if (legend) legend.hidden = true;
      if (empty) { empty.hidden = false; empty.textContent = '请先创建模拟账户。'; }
      return;
    }
    if (!equity || !equity.points || !equity.points.length) {
      meta.innerHTML = '';
      chartContainer.hidden = true;
      if (legend) legend.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.loadingTab === 'equity' ? '正在加载净值数据…' : '暂无净值数据，完成第一笔交易后即可查看。';
      }
      return;
    }
    chartContainer.hidden = false;
    if (empty) empty.hidden = true;
    var points = equity.points;
    var stats = equity.stats || {};
    var first = points[0] ? points[0].equity : null;
    var last = points[points.length - 1] ? points[points.length - 1].equity : null;
    var ret = stats.returnPct != null ? stats.returnPct : (first ? (last / first - 1) * 100 : null);
    var maxDd = stats.maxDrawdown != null ? stats.maxDrawdown : '--';
    var sharpe = stats.sharpe != null ? stats.sharpe : '--';
    meta.innerHTML =
      '<span>期初权益<b>' + fmtMoney(first, 'CNY') + '</b></span>' +
      '<span>期末权益<b>' + fmtMoney(last, 'CNY') + '</b></span>' +
      '<span>区间收益<b class="' + pnlClass(ret) + '">' + fmtPct(ret) + '</b></span>' +
      '<span>最大回撤<b class="down">' + (maxDd === '--' ? '--' : fmtNumber(maxDd, 2, 2) + '%') + '</b></span>' +
      '<span>夏普比率<b>' + (sharpe === '--' ? '--' : fmtNumber(sharpe, 2, 2)) + '</b></span>';

    if (!state.equityChart && window.Charts) {
      state.equityChart = window.Charts.createEquityChart(chartContainer, { onCrosshair: onEquityCrosshair });
    }
    if (state.equityChart) {
      state.equityChart.setData(points, state.equityRange);
    }
  }

  function onEquityCrosshair(payload) {
    var legend = $('#equity-legend');
    if (!legend) return;
    if (!payload || !payload.point) {
      legend.hidden = true;
      return;
    }
    var intraday = state.equityRange === '1d' || state.equityRange === '1w';
    var point = payload.point;
    legend.innerHTML = '<span>' + escapeHtml(window.Charts.formatBarTime(point.t, intraday)) + '</span> · 权益 <b>' +
      fmtMoney(payload.value != null ? payload.value : point.equity, 'CNY') + '</b>';
    legend.hidden = false;
  }

  function renderTabCounts() {
    var view = state.view;
    setText('#count-positions', String(view && view.positions ? view.positions.length : 0));
    setText('#count-orders', String(view && view.openOrders ? view.openOrders.length : 0));
  }

  function renderTabSummary() {
    var el = $('#tab-summary');
    if (!el) return;
    var text = '';
    var view = state.view;
    if (!state.accountId) {
      text = '';
    } else if (state.activeTab === 'positions') {
      var mv = state.view && state.view.equity && state.view.equity.total != null
        ? '总权益 ' + fmtMoney(state.view.equity.total, 'CNY') : '';
      text = (view && view.positions ? view.positions.length : 0) + ' 个持仓' + (mv ? ' · ' + mv : '');
    } else if (state.activeTab === 'orders') {
      text = (view && view.openOrders ? view.openOrders.length : 0) + ' 笔未成交';
    } else if (state.activeTab === 'history') {
      text = state.loadingTab === 'history' ? '加载中…' : '共 ' + state.historyOrders.length + ' 条';
    } else if (state.activeTab === 'trades') {
      text = state.loadingTab === 'trades' ? '加载中…' : '共 ' + state.trades.length + ' 条';
    } else if (state.activeTab === 'stats') {
      text = state.stats ? '总手续费 ' + fmtMoney(state.stats.totalFees || 0, 'CNY') : '';
    } else if (state.activeTab === 'equity') {
      var ret = state.equity && state.equity.stats ? state.equity.stats.returnPct : null;
      text = ret != null ? '区间收益 ' + fmtPct(ret) : '';
    }
    el.textContent = text;
  }

  // ---------------------------------------------------------------- tabs bar

  function renderTabsMode() {
    var filter = $('#history-filter');
    if (filter) filter.hidden = state.activeTab !== 'history';
    var ranges = $('#equity-range-group');
    if (ranges) ranges.hidden = state.activeTab !== 'equity';
  }

  // ------------------------------------------------------------------ toasts

  function showToast(message, kind) {
    var container = $('#toasts');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, 4200);
  }

  function showBanner(message) {
    var banner = $('#global-banner');
    if (!banner) return;
    state.lastErrorBanner = message;
    setText('#banner-text', message);
    banner.hidden = false;
  }

  function hideBanner() {
    var banner = $('#global-banner');
    if (banner) banner.hidden = true;
    state.lastErrorBanner = null;
  }

  function showFormError(selector, message) {
    var el = $(selector);
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
  }
  function hideFormError(selector) {
    var el = $(selector);
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  // ------------------------------------------------------------------ modals

  function openModal(id) {
    var modal = document.getElementById(id);
    if (modal) modal.hidden = false;
  }
  function closeModal(id) {
    var modal = document.getElementById(id);
    if (modal) modal.hidden = true;
  }

  function askConfirm(title, message, okText) {
    return new Promise(function (resolve) {
      state.confirmResolve = resolve;
      setText('#confirm-title', title);
      setText('#confirm-message', message);
      var ok = $('#confirm-ok');
      if (ok) ok.textContent = okText || '确认';
      openModal('modal-confirm');
    });
  }

  function resolveConfirm(value) {
    closeModal('modal-confirm');
    var resolve = state.confirmResolve;
    state.confirmResolve = null;
    if (resolve) resolve(value);
  }

  // ------------------------------------------------------------------- help

  function openHelp() {
    var toggle = $('#toggle-hints');
    if (toggle) toggle.checked = !!(state.prefs && state.prefs.newbieHints);
    openModal('modal-help');
  }

  function setNewbieHints(enabled) {
    patchPrefs({ newbieHints: !!enabled });
    var toggle = $('#toggle-hints');
    if (toggle) toggle.checked = !!enabled;
    renderOrderInfo();
    showToast(enabled ? '已开启新手提示' : '已关闭新手提示', 'info');
  }

  // ------------------------------------------------------------- onboarding

  function openOnboarding() {
    if (state.onboardingActive) return;
    if (state.accountModalRequired) return;
    var overlay = $('#onboarding');
    if (!overlay) return;
    state.onboardingActive = true;
    state.onboardingStep = 0;
    overlay.hidden = false;
    document.body.classList.add('onboarding-open');
    showOnboardingStep(0);
  }

  function closeOnboardingOverlay() {
    state.onboardingActive = false;
    var overlay = $('#onboarding');
    if (overlay) overlay.hidden = true;
    document.body.classList.remove('onboarding-open');
  }

  function showOnboardingStep(index) {
    if (!state.onboardingActive) return;
    var steps = ONBOARDING_STEPS;
    if (index >= steps.length) { finishOnboarding(); return; }
    if (index < 0) index = 0;
    state.onboardingStep = index;
    var step = steps[index];
    var target = $(step.target);
    if (target && typeof target.scrollIntoView === 'function') {
      var rect = target.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        target.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    }
    setText('#onboarding-step-label', '第 ' + (index + 1) + ' / ' + steps.length + ' 步');
    setText('#onboarding-title', step.title);
    setText('#onboarding-text', step.text);
    var hint = $('#onboarding-hint');
    if (hint) {
      hint.hidden = !step.hint;
      hint.textContent = step.hint || '';
    }
    var dots = $('#onboarding-dots');
    if (dots) {
      dots.innerHTML = steps.map(function (_, dotIndex) {
        return '<i class="' + (dotIndex === index ? 'active' : '') + '"></i>';
      }).join('');
    }
    var prev = $('#onboarding-prev');
    if (prev) prev.hidden = index === 0;
    setText('#onboarding-next', index === steps.length - 1 ? '开始练习' : '下一步');
    requestAnimationFrame(function () {
      positionOnboarding(step);
      var card = $('#onboarding-card');
      if (card && card.focus) card.focus({ preventScroll: true });
    });
  }

  function positionOnboarding(step) {
    var target = step ? $(step.target) : null;
    var spotlight = $('#onboarding-spotlight');
    var card = $('#onboarding-card');
    if (!spotlight || !card) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var pad = 8;
    var rect = target
      ? target.getBoundingClientRect()
      : { left: vw / 2 - 120, top: vh / 2 - 100, width: 240, height: 180 };
    var x = Math.max(pad, rect.left - pad);
    var y = Math.max(pad, rect.top - pad);
    var w = Math.max(80, Math.min(vw - x - pad, rect.width + pad * 2));
    var h = Math.max(60, Math.min(vh - y - pad, rect.height + pad * 2));
    spotlight.style.left = x + 'px';
    spotlight.style.top = y + 'px';
    spotlight.style.width = w + 'px';
    spotlight.style.height = h + 'px';
    card.style.visibility = 'hidden';
    card.style.left = '16px';
    card.style.top = '16px';
    var cardW = Math.min(360, vw - 32);
    card.style.width = cardW + 'px';
    var cardH = card.offsetHeight || 220;
    var below = y + h + 14;
    var above = y - cardH - 14;
    var top;
    if (below + cardH <= vh - 16) top = below;
    else if (above >= 16) top = above;
    else top = Math.min(vh - cardH - 16, Math.max(16, below));
    var left = Math.min(vw - cardW - 16, Math.max(16, x + w / 2 - cardW / 2));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.visibility = 'visible';
  }

  function onboardingNext() {
    if (!state.onboardingActive) return;
    if (state.onboardingStep >= ONBOARDING_STEPS.length - 1) finishOnboarding();
    else showOnboardingStep(state.onboardingStep + 1);
  }

  function onboardingPrev() {
    if (!state.onboardingActive) return;
    showOnboardingStep(state.onboardingStep - 1);
  }

  function finishOnboarding() {
    if (!state.onboardingActive) return;
    closeOnboardingOverlay();
    patchPrefs({ onboardingSeen: true });
    focusWatchlist();
  }

  function replayOnboarding() {
    closeModal('modal-help');
    state.prefs.onboardingSeen = false;
    savePrefs();
    openOnboarding();
  }

  // ------------------------------------------------------------------ events

  function bindEvents() {
    on($('#account-select'), 'change', function (event) {
      selectAccount(event.target.value);
    });
    on($('#btn-new-account'), 'click', function () { openCreateAccount(false); });
    on($('#btn-account-settings'), 'click', openAccountSettings);
    on($('#btn-data'), 'click', openDataManager);
    on($('#btn-data-refresh'), 'click', loadBackupStatus);
    on($('#btn-data-snapshot'), 'click', saveBackupSnapshot);
    on($('#btn-data-export-account'), 'click', exportCurrentAccount);
    on($('#btn-data-export-all'), 'click', exportAllAccounts);
    on($('#btn-data-export-csv'), 'click', exportTradesCsv);
    on($('#btn-data-import'), 'click', function () { var input = $('#data-import-file'); if (input) input.click(); });
    on($('#data-import-file'), 'change', onBackupFileSelected);
    on($('#import-confirm-restore'), 'change', function (event) {
      var btn = $('#btn-import-restore');
      if (btn) btn.disabled = !event.target.checked;
      if (event.target.checked) hideFormError('#import-error');
    });
    on($('#btn-import-new'), 'click', function () { importBackup('new-account'); });
    on($('#btn-import-restore'), 'click', function () { importBackup('restore'); });
    on($('#btn-reset-account'), 'click', openResetAccount);
    on($('#new-account-currency'), 'change', updateCapitalUnit);
    on($('#btn-help'), 'click', openHelp);
    on($('#toggle-hints'), 'change', function (event) { setNewbieHints(event.target.checked); });
    on($('#btn-replay-onboarding'), 'click', replayOnboarding);
    on($('#onboarding-next'), 'click', onboardingNext);
    on($('#onboarding-prev'), 'click', onboardingPrev);
    on($('#onboarding-skip'), 'click', finishOnboarding);
    on($('#onboarding-card'), 'keydown', function (event) {
      if (event.key === 'ArrowRight') { event.preventDefault(); onboardingNext(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); onboardingPrev(); }
      else if (event.key === 'Enter') { event.preventDefault(); onboardingNext(); }
    });

    // universe picker
    on($('#btn-universe'), 'click', openUniverse);
    on($('#btn-universe-search'), 'click', openUniverse);
    on($('#universe-close'), 'click', closeUniverse);
    on($('#universe-close-foot'), 'click', closeUniverse);
    on($('#modal-universe'), 'click', function (event) {
      if (event.target === event.currentTarget) closeUniverse();
    });
    on($('#universe-tabs'), 'click', function (event) {
      var tab = event.target.closest('[data-market]');
      if (!tab) return;
      var market = tab.getAttribute('data-market');
      if (!market || market === state.universe.activeMarket) return;
      state.universe.activeMarket = market;
      state.universe.query = '';
      state.universe.searchResults = [];
      var search = $('#universe-search');
      if (search) search.value = '';
      renderUniverse();
      loadUniverseMarket(market);
    });
    on($('#universe-sort'), 'click', function (event) {
      var btn = event.target.closest('[data-sort]');
      if (!btn) return;
      var sort = btn.getAttribute('data-sort') === 'change' ? 'change' : 'amount';
      if (sort === state.universe.sort) return;
      state.universe.sort = sort;
      renderUniverse();
      loadUniverseMarket(state.universe.activeMarket);
    });
    on($('#universe-search'), 'input', onUniverseSearchInput);
    on($('#universe-search'), 'keydown', function (event) {
      if (event.key === 'Escape') closeUniverse();
      else if (event.key === 'Enter') {
        var first = document.querySelector('#universe-list .universe-row');
        if (first) viewUniverseSymbol(first.getAttribute('data-symbol'));
      }
    });
    on($('#universe-list'), 'click', function (event) {
      var watchBtn = event.target.closest('[data-action="watch"]');
      if (watchBtn) {
        event.stopPropagation();
        onUniverseWatch(watchBtn.getAttribute('data-symbol'));
        return;
      }
      var row = event.target.closest('.universe-row');
      if (row) viewUniverseSymbol(row.getAttribute('data-symbol'));
    });
    on($('#universe-list'), 'keydown', function (event) {
      if (event.key !== 'Enter') return;
      var row = event.target.closest('.universe-row');
      if (row) viewUniverseSymbol(row.getAttribute('data-symbol'));
    });
    on($('#btn-cancel-account'), 'click', function () {
      if (!state.accountModalRequired) closeModal('modal-account');
    });
    on($('#btn-create-account'), 'click', submitAccountSettings);
    on($('#settings-presets'), 'click', function (event) {
      var btn = event.target.closest('[data-preset]');
      if (btn) applySettingsPreset(btn.getAttribute('data-preset'));
    });
    on($('#settings-mult-range'), 'input', function () {
      onSettingsMultiplierChanged();
    });
    on($('#settings-mult-quick'), 'click', function (event) {
      var btn = event.target.closest('[data-mult]');
      if (!btn || btn.disabled) return;
      state.settingsFormDirty = true;
      setMultiplierValue(Number(btn.getAttribute('data-mult')));
    });
    on($('#btn-settings-reset-all'), 'click', resetSettingsToDefaults);
    on($('#account-settings-fields'), 'input', function (event) {
      var input = event.target.closest('[data-setting-path]');
      if (input) validateSettingsField(input);
      state.settingsPreset = null;
      state.settingsFormDirty = true;
      updateSettingsMultiplierUI();
    });
    on($('#account-settings-fields'), 'click', function (event) {
      var btn = event.target.closest('[data-setting-reset]');
      if (!btn || btn.disabled) return;
      var path = btn.getAttribute('data-setting-reset');
      var field = settingsFieldByPath(path);
      var input = document.querySelector('#account-settings-fields [data-setting-path="' + path + '"]');
      if (!field || !input) return;
      var value = getPath(defaultSettingsDeep(), path);
      var adjusted = [];
      if (path.indexOf('margin.mmr.') === 0 && field.market) {
        var cap = mmrCapFor(field.market, currentSettingsMultiplier());
        if (Number(value) > cap + 1e-12) {
          value = cap;
          adjusted.push(field.market);
        }
      }
      input.value = settingDisplayInputValue(field, value);
      validateSettingsField(input);
      state.settingsPreset = null;
      state.settingsFormDirty = true;
      updateSettingsMultiplierUI();
      if (adjusted.length) refreshMmrClampNote(currentSettingsMultiplier(), adjusted);
    });
    on($('#new-account-capital'), 'keydown', function (event) {
      if (event.key === 'Enter') submitAccountSettings();
    });
    on($('#new-account-name'), 'keydown', function (event) {
      if (event.key === 'Enter') submitAccountSettings();
    });
    on($('#btn-cancel-reset'), 'click', function () { closeModal('modal-reset'); });
    on($('#btn-confirm-reset'), 'click', submitResetAccount);
    on($('#reset-account-capital'), 'keydown', function (event) {
      if (event.key === 'Enter') submitResetAccount();
    });
    on($('#confirm-cancel'), 'click', function () { resolveConfirm(false); });
    on($('#confirm-ok'), 'click', function () { resolveConfirm(true); });
    $$('[data-close-modal]').forEach(function (btn) {
      on(btn, 'click', function () {
        var id = btn.getAttribute('data-close-modal');
        if (id === 'modal-account' && state.accountModalRequired) return;
        if (id === 'modal-confirm') { resolveConfirm(false); return; }
        closeModal(id);
      });
    });
    on($('#banner-close'), 'click', hideBanner);

    on($('#trade-switch'), 'click', function (event) {
      var btn = event.target.closest('[data-trade-action]');
      if (btn) setTradeAction(btn.getAttribute('data-trade-action'));
    });
    $$('.type-switch [data-order-type]').forEach(function (btn) {
      on(btn, 'click', function () { setOrderType(btn.getAttribute('data-order-type')); });
    });
    on($('#leverage-range'), 'input', function (event) { setLeverage(Number(event.target.value)); });
    on($('#lev-quick'), 'click', function (event) {
      var btn = event.target.closest('[data-lev]');
      if (btn) setLeverage(Number(btn.getAttribute('data-lev')));
    });
    on($('#tpsl-toggle'), 'click', function () {
      state.showTpSl = !state.showTpSl;
      renderTpslBlock();
    });
    on($('#btn-save-protect'), 'click', savePositionProtect);
    on($('#order-tp'), 'input', function () { renderOrderHint(); });
    on($('#order-sl'), 'input', function () { renderOrderHint(); });
    on($('#margin-mode-badge'), 'click', openMarginModeModal);
    on($('#btn-margin-mode'), 'click', openMarginModeModal);
    on($('#account-multiplier-badge'), 'click', openAccountSettings);
    on($('#btn-apply-margin-mode'), 'click', applyMarginMode);
    on($('#order-submit'), 'click', submitOrder);
    on($('#order-submit'), 'keydown', function (event) {
      if (event.key === 'Enter') submitOrder();
    });
    on($('#order-price'), 'input', function () {
      state.limitPriceSymbol = state.selected;
      renderOrderInfo();
      renderOrderHint();
    });
    on($('#order-qty'), 'input', function () { renderOrderInfo(); renderOrderHint(); });
    on($('#quick-qty'), 'click', function (event) {
      var btn = event.target.closest('[data-qty-pct]');
      if (btn) applyQtyPct(Number(btn.getAttribute('data-qty-pct')));
    });

    on($('#search-input'), 'input', onSearchInput);
    on($('#search-input'), 'keydown', onSearchKeydown);
    on($('#search-input'), 'focus', function () {
      if (state.searchResults.length) renderSearchResults();
    });
    on($('#search-results'), 'mousedown', function (event) {
      var item = event.target.closest('[data-search-symbol]');
      if (item) {
        event.preventDefault();
        chooseSearchResult(item.getAttribute('data-search-symbol'));
      }
    });

    on($('#watch-list'), 'click', function (event) {
      var retry = event.target.closest('[data-retry-symbol]');
      if (retry) {
        event.stopPropagation();
        retrySymbol(retry.getAttribute('data-retry-symbol'));
        return;
      }
      var del = event.target.closest('[data-del-symbol]');
      if (del) {
        event.stopPropagation();
        removeFromWatchlist(del.getAttribute('data-del-symbol'));
        return;
      }
      var row = event.target.closest('.watch-row');
      if (row) selectSymbol(row.getAttribute('data-symbol'));
    });
    on($('#watch-list'), 'keydown', function (event) {
      if (event.key !== 'Enter') return;
      var row = event.target.closest('.watch-row');
      if (row) selectSymbol(row.getAttribute('data-symbol'));
    });
    on($('#btn-refresh-watch'), 'click', pollNow);
    on($('#btn-chart-refresh'), 'click', function () { loadChart(); });
    on($('#conn-box'), 'click', openSourcesModal);
    on($('#conn-box'), 'keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSourcesModal();
      }
    });
    on($('#source-banner-details'), 'click', openSourcesModal);
    on($('#source-banner-close'), 'click', muteSourceBanner);
    on($('#btn-source-refresh'), 'click', refreshHealth);
    on($('#quote-retry'), 'click', function () { retrySymbol(state.selected); });
    on($('#chart-retry'), 'click', function () { retrySymbol(state.selected); });

    on($('#interval-group'), 'click', function (event) {
      var btn = event.target.closest('[data-interval]');
      if (btn) setChartInterval(btn.getAttribute('data-interval'));
    });
    on($('#chart-mode-group'), 'click', function (event) {
      var btn = event.target.closest('[data-chart-mode]');
      if (btn) setChartMode(btn.getAttribute('data-chart-mode'));
    });

    on($('#tabs'), 'click', function (event) {
      var tab = event.target.closest('[data-tab]');
      if (tab) activateTab(tab.getAttribute('data-tab'));
    });
    on($('#history-filter'), 'change', function (event) {
      state.historyFilter = event.target.value;
      state.auxLoadedAt = Date.now();
      loadActiveTabData();
    });
    on($('#equity-range-group'), 'click', function (event) {
      var btn = event.target.closest('[data-equity-range]');
      if (!btn) return;
      var range = btn.getAttribute('data-equity-range');
      if (range === state.equityRange) return;
      state.equityRange = range;
      state.auxLoadedAt = Date.now();
      loadEquity(encodeURIComponent(state.accountId), state.accountEpoch);
    });

    on($('#table-positions'), 'click', function (event) {
      var closeBtn = event.target.closest('[data-action="close"]');
      if (closeBtn) { prefillClose(closeBtn.getAttribute('data-symbol')); return; }
      var reverseBtn = event.target.closest('[data-action="reverse"]');
      if (reverseBtn) reversePosition(reverseBtn.getAttribute('data-symbol'));
    });
    on($('#table-orders'), 'click', function (event) {
      var cancelBtn = event.target.closest('[data-action="cancel"]');
      if (cancelBtn) { cancelOrder(cancelBtn.getAttribute('data-order-id')); return; }
      var editBtn = event.target.closest('[data-action="edit-price"]');
      if (editBtn) { startEditOrder(editBtn.getAttribute('data-order-id')); return; }
      var saveBtn = event.target.closest('[data-action="save-price"]');
      if (saveBtn) { saveOrderPrice(); return; }
      var cancelEditBtn = event.target.closest('[data-action="cancel-edit"]');
      if (cancelEditBtn) cancelEditOrder();
    });
    on($('#table-orders'), 'input', function (event) {
      if (event.target && event.target.id === 'order-edit-price') {
        state.editingPrice = event.target.value;
      }
    });
    on($('#table-orders'), 'keydown', function (event) {
      if (!event.target || event.target.id !== 'order-edit-price') return;
      if (event.key === 'Enter') { event.preventDefault(); saveOrderPrice(); }
      else if (event.key === 'Escape') { event.preventDefault(); cancelEditOrder(); }
    });

    on(document, 'mousedown', function (event) {
      if (!event.target.closest || !event.target.closest('.search-wrap')) closeSearch();
    });
    on(document, 'click', function (event) {
      var gotoBtn = event.target.closest ? event.target.closest('[data-action="goto-watchlist"]') : null;
      if (gotoBtn) {
        event.preventDefault();
        focusWatchlist();
        return;
      }
      var chip = event.target.closest ? event.target.closest('[data-chip-symbol]') : null;
      if (chip) {
        event.preventDefault();
        viewUniverseSymbol(chip.getAttribute('data-chip-symbol'));
      }
    });
    on(document, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (state.onboardingActive) { finishOnboarding(); return; }
      if (state.universe.open) { closeUniverse(); return; }
      if (!$('#modal-margin-mode').hidden) { closeModal('modal-margin-mode'); return; }
      if (!$('#modal-import').hidden) { closeModal('modal-import'); return; }
      if (!$('#modal-data').hidden) { closeModal('modal-data'); return; }
      if (!$('#modal-sources').hidden) { closeModal('modal-sources'); return; }
      if (!$('#modal-help').hidden) { closeModal('modal-help'); return; }
      closeSearch();
      if (state.confirmResolve) { resolveConfirm(false); return; }
      if (!$('#modal-reset').hidden) { closeModal('modal-reset'); return; }
      if (!$('#modal-account').hidden && !state.accountModalRequired) closeModal('modal-account');
      if (document.activeElement && document.activeElement.id === 'fee-info') document.activeElement.blur();
    });

    on(window, 'resize', function () {
      if (state.equityChart && state.activeTab === 'equity') {
        // ResizeObserver inside the chart layer handles the actual resize.
        renderEquity();
      }
      if (state.onboardingActive) {
        positionOnboarding(ONBOARDING_STEPS[state.onboardingStep]);
      }
    });

    renderTabsMode();
  }

  // -------------------------------------------------------------------- start

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
