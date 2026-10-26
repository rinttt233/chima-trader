// lib/engine.mjs — ChimaTrader matching engine v2 (margin / leverage / short selling).
//
// Responsibilities (CONTRACTS.md §5, §6, §6A):
//   * per-market order validation: lot size, price band, session, cash / margin / position
//   * fee model (calcFees) and fill-price model (book price + slippage + fx spread)
//   * order placement (open / add / close / short), session-gated limit matching
//   * v2 money model: initial margin, borrowed debt, hourly interest, mark-to-market
//     equity, isolated & cross margin risk with forced liquidation, TP/SL triggers
//   * automatic FX conversion of the account base currency when a buy currency is
//     short (only when the caller supplies fxRates)
//   * portfolio valuation with multi-currency accounts folded into CNY
//   * symbol parsing delegated to lib/symbols.mjs; orders/positions/trades are always
//     keyed by the canonical `market:code` form returned there
//
// Conventions:
//   * `now` may be an ISO-8601 string, a Date or a millisecond number; it is never read
//     from the machine time zone. Calendar decisions use Intl with the zone of the
//     market (Asia/Shanghai for cn/fx, Asia/Hong_Kong for hk, America/New_York for us).
//   * money is a plain `number`; cash / margin / debt / fees are rounded to 2 decimals,
//     interest to 8 decimals, prices per market (see PRICE_DECIMALS).
//   * accounts are mutated in place; `now` is always injected so tests stay offline.

import { parseSymbol as canonicalParseSymbol } from './symbols.mjs';

const MARKETS = ['cn', 'hk', 'us', 'fx', 'crypto'];
const MARKET_CURRENCY = { cn: 'CNY', hk: 'HKD', us: 'USD', fx: 'USD', crypto: 'USDT' };
const CASH_CURRENCIES = ['CNY', 'HKD', 'USD', 'USDT'];
const PRICE_DECIMALS = { cn: 2, hk: 3, us: 4, fx: 5, crypto: 8 };
const MARKET_LABEL = { cn: 'A股', hk: '港股', us: '美股', fx: '外汇', crypto: '加密' };
const DEFAULT_FX_RATES = { CNY: 1, HKD: 0.92, USD: 7.1, USDT: 7.1 };
const SHORT_ALLOWED = { cn: false, hk: true, us: true, fx: true, crypto: true };
const HOURS_PER_YEAR = 8760;
const EPS = 1e-9;
const MAX_CONVERSIONS = 1000;
const MAX_LIQUIDATIONS = 500;

// Fallback config, identical to config.json. The server always injects the real config,
// but the engine must stay usable (and testable) on its own.
export const DEFAULT_CFG = {
  fees: {
    cn: { commissionRate: 0.00025, commissionMin: 5, stampDutyRate: 0.0005, stampDutySide: 'sell', transferFeeRate: 0.00001 },
    hk: { commissionRate: 0.00025, commissionMin: 100, stampDutyRate: 0.001, stampDutySide: 'both', exchangeFeeRate: 0.0000565, settlementFeeRate: 0.00002 },
    us: { perShare: 0.005, commissionMin: 1, secFeeRate: 0.0000278, secFeeSide: 'sell' },
    fx: { spreadBps: 1.5, commissionRate: 0 },
    crypto: { commissionRate: 0.001 }
  },
  slippageBps: { cn: 1, hk: 1, us: 1, fx: 2, crypto: 3 },
  leverage: { cn: 1, hk: 10, us: 10, fx: 200, crypto: 100 },
  lots: { cn: 100, hk: 100, us: 1, fx: 0.01, crypto: 0.0001 },
  sessions: {
    cn: [{ start: '09:30', end: '11:30', tz: 'Asia/Shanghai' }, { start: '13:00', end: '15:00', tz: 'Asia/Shanghai' }],
    hk: [{ start: '09:30', end: '12:00', tz: 'Asia/Hong_Kong' }, { start: '13:00', end: '16:00', tz: 'Asia/Hong_Kong' }],
    us: [{ start: '09:30', end: '16:00', tz: 'America/New_York' }]
  },
  margin: {
    // Maintenance margin ratios from config.json (contract §6A.1 / §6B.4); kept
    // identical to config.json so behaviour does not change when cfg is not injected.
    mmr: { cn: 1, hk: 0.04, us: 0.04, fx: 0.0005, crypto: 0.001 },
    interestAnnual: { cn: 0, hk: 0.06, us: 0.06, fx: 0.03, crypto: 0.08 },
    liquidationFeeRate: { cn: 0, hk: 0.002, us: 0.002, fx: 0, crypto: 0.005 }
  }
};

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Round half-up on the absolute value; tolerant to binary float noise (1.695 -> 1.70). */
export function roundTo(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  const factor = 10 ** decimals;
  const scaled = Number((Math.abs(n) * factor).toPrecision(12));
  const rounded = Math.round(scaled) / factor;
  return n < 0 ? -rounded : rounded;
}

const round2 = (value) => roundTo(value, 2);
const round4 = (value) => roundTo(value, 4);
const round8 = (value) => roundTo(value, 8);
const roundQty = (value) => roundTo(value, 8);

function roundPrice(market, price) {
  return roundTo(price, PRICE_DECIMALS[market] ?? 4);
}

function sum(values) {
  let total = 0;
  for (const value of values) total += toFinite(value, 0);
  return total;
}

function fmtNum(value) {
  const n = toFinite(value, 0);
  return String(roundTo(n, Math.abs(n) < 1 ? 6 : 2));
}

function fmtPercent(ratio) {
  return `${(toFinite(ratio, 0) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// calendar (zone aware, never uses the machine time zone)
// ---------------------------------------------------------------------------

const formatterCache = new Map();
const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function zoneFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        weekday: 'short'
      });
    } catch {
      formatter = null;
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number') return new Date(now);
  if (typeof now === 'string' && now) return new Date(now);
  return new Date();
}

export function toISO(now) {
  const date = toDate(now);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** Wall-clock parts of `now` inside `timeZone` (falls back to Asia/Shanghai). */
export function zonedParts(now, timeZone = 'Asia/Shanghai') {
  const date = toDate(now);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = zoneFormatter(timeZone) ?? zoneFormatter('Asia/Shanghai');
  if (!formatter) return null;
  const parts = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  const weekday = String(parts.weekday ?? '').slice(0, 3);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[weekday] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

/** Asia/Shanghai calendar day used as the T+1 / daily-snapshot key: 'YYYY-MM-DD'. */
export function dayKeyOf(now, timeZone = 'Asia/Shanghai') {
  const parts = zonedParts(now, timeZone);
  if (!parts) return '1970-01-01';
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** UTC instant of a `YYYY-MM-DD` Asia/Shanghai midnight, used by stats/equity filters. */
export function shanghaiDayStartUtc(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  return Date.UTC(year, month - 1, day) - 8 * 3600 * 1000;
}

function parseHhmm(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function sessionOpen(date, session) {
  const parts = zonedParts(date, session.tz || 'Asia/Shanghai');
  if (!parts) return false;
  if (parts.weekday < 1 || parts.weekday > 5) return false; // Mon..Fri only
  const open = parseHhmm(session.start);
  const close = parseHhmm(session.end);
  if (open === null || close === null) return false;
  return parts.minutes >= open && parts.minutes < close;
}

// FX trades from Monday 05:00 through Saturday 05:00 Asia/Shanghai; every day
// 05:00-06:00 is a maintenance window (contract §6.1).
function fxOpen(date) {
  const parts = zonedParts(date, 'Asia/Shanghai');
  if (!parts || parts.weekday < 1) return false;
  const minutes = parts.minutes;
  const maintenance = minutes >= 5 * 60 && minutes < 6 * 60;
  if (parts.weekday === 1) return minutes >= 6 * 60; // Monday opens after maintenance
  if (parts.weekday >= 2 && parts.weekday <= 5) return !maintenance;
  if (parts.weekday === 6) return minutes < 5 * 60; // Saturday until 05:00
  return false; // Sunday
}

/**
 * Is `market` open at `nowISO`? Sessions come from cfg.sessions when provided,
 * falling back to the built-in defaults (contract §6.1).
 *
 * Known simplification: no exchange holiday calendar, weekdays are assumed open.
 */
export function canTradeMarket(market, nowISO, cfg = null) {
  const id = String(market ?? '').toLowerCase();
  const date = toDate(nowISO);
  if (Number.isNaN(date.getTime())) return false;
  if (id === 'crypto') return true; // 7x24
  if (id === 'fx') return fxOpen(date);
  const injected = cfg?.sessions?.[id];
  const sessions = Array.isArray(injected) && injected.length ? injected : DEFAULT_CFG.sessions[id];
  if (!Array.isArray(sessions) || !sessions.length) return false;
  return sessions.some((session) => sessionOpen(date, session));
}

export function marketLabel(market) {
  return MARKET_LABEL[String(market ?? '').toLowerCase()] ?? String(market ?? '');
}

// ---------------------------------------------------------------------------
// symbols
// ---------------------------------------------------------------------------

/**
 * Parse an input symbol/alias into the canonical shape used as the engine's key:
 * { symbol: 'market:code', market, code, currency }.
 *
 * Parsing itself is delegated to lib/symbols.mjs (contract §2, single source of
 * truth: `cn:sh600519`, `hk:hk00700`, `us:usAAPL`, `fx:EURUSD`, `crypto:BTCUSDT`
 * plus aliases such as `crypto:cryptoBTCUSDT`, `whEURUSD`, bare `BTCUSDT`). This
 * wrapper only converts the library's thrown errors into `null` so that order
 * validation can answer SYMBOL_INVALID instead of throwing.
 */
export function parseSymbol(input) {
  try {
    const parsed = canonicalParseSymbol(input);
    if (!parsed || typeof parsed !== 'object' || !parsed.symbol) return null;
    return {
      symbol: parsed.symbol,
      market: parsed.market,
      code: parsed.code,
      currency: parsed.currency ?? MARKET_CURRENCY[parsed.market] ?? 'CNY'
    };
  } catch {
    return null;
  }
}

export function marketCurrency(market) {
  return MARKET_CURRENCY[String(market ?? '').toLowerCase()] ?? 'CNY';
}

/**
 * Accepts either a { symbol: quote } map or a [quote] array. Every entry is also
 * indexed under its canonical symbol, so a caller that keys quotes by a legacy alias
 * (or by the symbol it requested) still resolves after normalization.
 */
function quotesToMap(input) {
  if (!input || typeof input !== 'object') return {};
  const map = {};
  if (Array.isArray(input)) {
    for (const quote of input) if (quote?.symbol) map[quote.symbol] = quote;
  } else {
    for (const [key, quote] of Object.entries(input)) {
      map[key] = quote;
      const info = typeof key === 'string' ? parseSymbol(key) : null;
      if (info && !(info.symbol in map)) map[info.symbol] = quote;
    }
  }
  return map;
}

function normalizeFxRates(fxRates) {
  const rates = { ...DEFAULT_FX_RATES };
  for (const currency of CASH_CURRENCIES) {
    const value = toFinite(fxRates?.[currency], NaN);
    if (Number.isFinite(value) && value > 0) rates[currency] = value;
  }
  rates.CNY = 1;
  return rates;
}

// ---------------------------------------------------------------------------
// config + fees (contract §6.2 / §6A.1)
// ---------------------------------------------------------------------------

function resolveCfg(cfg) {
  const injected = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    fees: { ...DEFAULT_CFG.fees, ...(injected.fees ?? {}) },
    slippageBps: { ...DEFAULT_CFG.slippageBps, ...(injected.slippageBps ?? {}) },
    leverage: { ...DEFAULT_CFG.leverage, ...(injected.leverage ?? {}) },
    lots: { ...DEFAULT_CFG.lots, ...(injected.lots ?? {}) },
    sessions: { ...DEFAULT_CFG.sessions, ...(injected.sessions ?? {}) },
    margin: {
      mmr: { ...DEFAULT_CFG.margin.mmr, ...(injected.margin?.mmr ?? {}) },
      interestAnnual: { ...DEFAULT_CFG.margin.interestAnnual, ...(injected.margin?.interestAnnual ?? {}) },
      liquidationFeeRate: { ...DEFAULT_CFG.margin.liquidationFeeRate, ...(injected.margin?.liquidationFeeRate ?? {}) }
    },
    // Automatic FX conversion (contract §6.6): only used when the caller passes fxRates.
    autoConvert: injected.autoConvert !== false,
    fxConvertSpread: toFinite(injected.fxConvertSpread, 0.003)
  };
}

function maxLeverageOf(market, config) {
  return Math.max(1, toFinite(config?.leverage?.[market], 1));
}

function mmrOf(market, config) {
  return Math.max(0, toFinite(config?.margin?.mmr?.[market], 0));
}

function interestAnnualOf(market, config) {
  return Math.max(0, toFinite(config?.margin?.interestAnnual?.[market], 0));
}

function liquidationFeeRateOf(market, config) {
  return Math.max(0, toFinite(config?.margin?.liquidationFeeRate?.[market], 0));
}

/**
 * Fees for one side of a trade. Every component is rounded to 2 decimals first and
 * `total` is the rounded sum, so `breakdown` always adds up to `total`.
 *
 * cn    commission max(notional*0.00025, 5) + sell stampDuty 0.0005 + transfer 0.00001
 * hk    commission max(notional*0.00025, 100) + stampDuty 0.001 both sides
 *       + exchange 0.0000565 + settlement 0.00002
 * us    max(shares*0.005, 1) + sell SEC fee 0.0000278
 * fx    0 (the cost is the spread)
 * crypto notional*0.001 both sides
 */
export function calcFees(market, side, qty, price, cfg) {
  const id = String(market ?? '').toLowerCase();
  const config = resolveCfg(cfg).fees[id] ?? {};
  const shares = toFinite(qty, 0);
  const notional = shares * toFinite(price, 0);
  const isSell = String(side ?? '').toLowerCase() === 'sell';
  const breakdown = {};

  if (id === 'cn') {
    breakdown.commission = round2(Math.max(notional * toFinite(config.commissionRate, 0.00025), toFinite(config.commissionMin, 5)));
    const stampSide = config.stampDutySide ?? 'sell';
    breakdown.stampDuty = round2(stampSide === 'both' || (stampSide === 'sell' && isSell) ? notional * toFinite(config.stampDutyRate, 0.0005) : 0);
    breakdown.transferFee = round2(notional * toFinite(config.transferFeeRate, 0.00001));
  } else if (id === 'hk') {
    breakdown.commission = round2(Math.max(notional * toFinite(config.commissionRate, 0.00025), toFinite(config.commissionMin, 100)));
    const stampSide = config.stampDutySide ?? 'both';
    breakdown.stampDuty = round2(stampSide === 'both' || (stampSide === 'sell' && isSell) ? notional * toFinite(config.stampDutyRate, 0.001) : 0);
    breakdown.exchangeFee = round2(notional * toFinite(config.exchangeFeeRate, 0.0000565));
    breakdown.settlementFee = round2(notional * toFinite(config.settlementFeeRate, 0.00002));
  } else if (id === 'us') {
    breakdown.commission = round2(Math.max(shares * toFinite(config.perShare, 0.005), toFinite(config.commissionMin, 1)));
    const secSide = config.secFeeSide ?? 'sell';
    breakdown.secFee = round2(secSide === 'both' || (secSide === 'sell' && isSell) ? notional * toFinite(config.secFeeRate, 0.0000278) : 0);
  } else if (id === 'fx') {
    breakdown.commission = 0; // spread only
  } else if (id === 'crypto') {
    breakdown.commission = round2(notional * toFinite(config.commissionRate, 0.001));
  } else {
    breakdown.commission = 0;
  }

  return {
    total: round2(sum(Object.values(breakdown))),
    breakdown,
    currency: marketCurrency(id)
  };
}

// ---------------------------------------------------------------------------
// accounts + positions (v2)
// ---------------------------------------------------------------------------

function emptyCash() {
  return { CNY: 0, HKD: 0, USD: 0, USDT: 0 };
}

function ensureCash(account) {
  if (!account.cash || typeof account.cash !== 'object') account.cash = emptyCash();
  for (const currency of CASH_CURRENCIES) {
    account.cash[currency] = round2(toFinite(account.cash[currency], 0));
  }
  return account.cash;
}

function ensureAccountLists(account) {
  if (!Array.isArray(account.orders)) account.orders = [];
  if (!Array.isArray(account.trades)) account.trades = [];
  if (!Array.isArray(account.equityHistory)) account.equityHistory = [];
  if (!Array.isArray(account.conversions)) account.conversions = [];
  if (!Array.isArray(account.liquidations)) account.liquidations = [];
  if (!Number.isFinite(Number(account.totalInterest))) account.totalInterest = 0;
  if (account.marginMode !== 'cross') account.marginMode = 'isolated';
  if (!account.positions || typeof account.positions !== 'object') account.positions = {};
  return account;
}

function cashOf(account, currency) {
  return round2(toFinite(account?.cash?.[currency], 0));
}

function marginModeOf(account) {
  return account?.marginMode === 'cross' ? 'cross' : 'isolated';
}

// --- read-only position accessors (never mutate; safe inside validateOrder) ---

function sideOf(position) {
  return position?.side === 'short' ? 'short' : 'long';
}

function qtyOf(position) {
  return Math.max(0, roundQty(toFinite(position?.qty, 0)));
}

function avgCostOf(position) {
  return Math.max(0, toFinite(position?.avgCost, 0));
}

function leverageOf(position) {
  const leverage = toFinite(position?.leverage, 1);
  return leverage >= 1 ? leverage : 1;
}

function marginOf(position) {
  const explicit = toFinite(position?.margin, NaN);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const notional = qtyOf(position) * avgCostOf(position);
  return notional / leverageOf(position);
}

function debtOf(position) {
  const explicit = toFinite(position?.debt, NaN);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const notional = qtyOf(position) * avgCostOf(position);
  return Math.max(0, notional - marginOf(position));
}

function interestOf(position) {
  return Math.max(0, toFinite(position?.accruedInterest, 0));
}

/**
 * fx v5 (contract §6D / §6A.4): FX positions are settled in USD and carry a
 * `notionalUsd` = qty × usdPerBase captured at open. When the field is missing
 * (archives, or a store normalizer that has not learned about it yet) it is
 * reconstructed from the persisted margin + debt — their sum equals the USD notional
 * within one cent — falling back to qty × avgCost. For USD-quoted pairs the resulting
 * formulas are numerically identical to the pre-v5 quote-currency formulas.
 */
function isFxPosition(position) {
  return String(position?.market ?? '').toLowerCase() === 'fx';
}

function hasUsdNotional(position) {
  return isFxPosition(position) && qtyOf(position) > 0;
}

function notionalUsdOf(position) {
  const stored = Number(position?.notionalUsd);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const margin = Number(position?.margin);
  const debt = Number(position?.debt);
  if (Number.isFinite(margin) && Number.isFinite(debt) && margin + debt > 0) return margin + debt;
  return qtyOf(position) * avgCostOf(position);
}

/** USD value of one base unit at open: quote.usdPerBase, falling back to the pair rate. */
function usdPerBaseOf(quote, price) {
  const value = toFinite(quote?.usdPerBase, NaN);
  if (Number.isFinite(value) && value > 0) return value;
  return toFinite(price, NaN);
}

/**
 * Price to use for FX fee notional: fees are USD-based, so for fx we multiply qty by
 * the USD value of one base unit instead of the pair rate (they are identical for
 * USD-quoted pairs such as EURUSD).
 */
function feeNotionalPrice(market, quote, price) {
  if (String(market ?? '').toLowerCase() !== 'fx') return price;
  const unit = usdPerBaseOf(quote, price);
  return Number.isFinite(unit) && unit > 0 ? unit : price;
}

function interestAnnualOfPosition(position) {
  return Math.max(0, toFinite(position?.interestAnnual, 0));
}

function protectOf(position, key) {
  const value = Number(position?.[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function currencyOf(position, market) {
  return position?.currency ?? marketCurrency(market);
}

function isLeveraged(position) {
  return leverageOf(position) > 1;
}

function unrealizedPnlOf(position, lastPrice) {
  const qty = qtyOf(position);
  const avgCost = avgCostOf(position);
  const price = toFinite(lastPrice, NaN);
  if (!(qty > 0) || !(price > 0)) return 0;
  if (hasUsdNotional(position)) {
    // fx v5: USD-settled PnL — notionalUsd × (price/avgCost − 1) (sign follows side).
    if (!(avgCost > 0)) return 0;
    const ratio = price / avgCost;
    const notionalUsd = notionalUsdOf(position);
    return sideOf(position) === 'short' ? notionalUsd * (1 - ratio) : notionalUsd * (ratio - 1);
  }
  return sideOf(position) === 'short' ? (avgCost - price) * qty : (price - avgCost) * qty;
}

/** Mark-to-market contribution of one position: initial margin + uPnL - accrued interest. */
function positionEquityOf(position, lastPrice) {
  return marginOf(position) + unrealizedPnlOf(position, lastPrice) - interestOf(position);
}

function maintenanceOf(position, lastPrice, mmr) {
  if (!isLeveraged(position)) return 0; // cash-funded spot positions are not margin positions
  const rate = Math.max(0, mmr);
  // fx v5: maintenance is measured on the USD notional captured at open.
  if (hasUsdNotional(position)) return notionalUsdOf(position) * rate;
  const price = toFinite(lastPrice, avgCostOf(position));
  return qtyOf(position) * price * rate;
}

function currentMarketOf(position, symbol) {
  return position?.market ?? parseSymbol(symbol)?.market ?? '';
}

/**
 * Liquidation price (isolated mode, interest ignored — contract §6A.5).
 * fx v5 uses the USD-notional basis:
 *   long  price = avgCost × (1 − (margin − maintenance)/notionalUsd)
 *   short price = avgCost × (1 + (margin − maintenance)/notionalUsd)
 */
function liqPriceOf(position, mmr) {
  const qty = qtyOf(position);
  if (!isLeveraged(position) || !(qty > 0)) return null;
  const rate = Math.max(0, mmr);
  if (hasUsdNotional(position)) {
    const avgCost = avgCostOf(position);
    const notionalUsd = notionalUsdOf(position);
    if (!(avgCost > 0) || !(notionalUsd > 0)) return null;
    const delta = (marginOf(position) - notionalUsd * rate) / notionalUsd;
    return avgCost * (sideOf(position) === 'short' ? 1 + delta : 1 - delta);
  }
  if (sideOf(position) === 'short') {
    const denominator = qty * (1 + rate);
    if (!(denominator > 0)) return null;
    return (avgCostOf(position) * qty + marginOf(position)) / denominator;
  }
  const denominator = qty * (1 - rate);
  if (!(denominator > 0)) return null;
  return (avgCostOf(position) * qty - marginOf(position)) / denominator;
}

/** Fill in v2 defaults on a stored position (mutating migration for persisted state). */
function normalizePosition(position, symbol) {
  if (!position || typeof position !== 'object') return null;
  const market = currentMarketOf(position, symbol);
  if (position.side !== 'short') position.side = 'long';
  position.symbol = position.symbol ?? symbol;
  position.market = market;
  position.currency = currencyOf(position, market);
  position.qty = qtyOf(position);
  position.avgCost = round8(avgCostOf(position));
  position.leverage = leverageOf(position);
  position.margin = round2(marginOf(position));
  position.debt = round2(debtOf(position));
  position.accruedInterest = round8(interestOf(position));
  position.interestAnnual = interestAnnualOfPosition(position);
  position.lastInterestAt = position.lastInterestAt ?? null;
  position.takeProfit = protectOf(position, 'takeProfit');
  position.stopLoss = protectOf(position, 'stopLoss');
  position.openedAt = position.openedAt ?? null;
  position.todayBuyQty = roundQty(toFinite(position.todayBuyQty, 0));
  position.todayBuyDate = position.todayBuyDate ?? null;
  return position;
}

/**
 * Sellable / closable quantity. A-share (cn) long positions are T+1: shares bought on
 * the current Asia/Shanghai day are locked. Leveraged positions and shorts are T+0.
 */
export function availableQty(account, symbol, now) {
  const info = parseSymbol(symbol);
  const key = info?.symbol ?? symbol;
  const position = account?.positions?.[symbol] ?? account?.positions?.[key] ?? null;
  if (!position) return 0;
  const qty = qtyOf(position);
  if (!(qty > 0)) return 0;
  const market = currentMarketOf(position, key);
  if (sideOf(position) === 'long' && market === 'cn' && position.todayBuyDate === dayKeyOf(now)) {
    return Math.max(0, roundQty(qty - toFinite(position.todayBuyQty, 0)));
  }
  return qty;
}

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/**
 * Create a fresh account. Capital is deposited in `baseCurrency`.
 * `options.now` and the `marginMode` field are engine extensions that keep tests and
 * bootstrap deterministic (server passes marginMode for POST /api/accounts).
 */
export function createAccount({ id, name, initialCapital, baseCurrency = 'CNY', marginMode = 'isolated' } = {}, options = {}) {
  const now = toISO(options.now ?? new Date());
  const base = CASH_CURRENCIES.includes(baseCurrency) ? baseCurrency : 'CNY';
  const capital = round2(Math.max(0, toFinite(initialCapital, 0)));
  const cash = emptyCash();
  cash[base] = capital;
  return {
    id: id ?? nextId('acc'),
    name: name ?? '模拟账户',
    baseCurrency: base,
    initialCapital: capital,
    marginMode: marginMode === 'cross' ? 'cross' : 'isolated',
    createdAt: now,
    cash,
    positions: {},
    orders: [],
    trades: [],
    conversions: [],
    liquidations: [],
    totalInterest: 0,
    equityHistory: [{ t: now, equity: capital }],
    dayStartEquity: capital,
    dayKey: dayKeyOf(now),
    realizedPnl: 0,
    totalFees: 0
  };
}

// ---------------------------------------------------------------------------
// funding (auto FX conversion, contract §6.6) — never mutates the account
// ---------------------------------------------------------------------------

/**
 * Decide how a debit in `currency` gets funded. Never mutates the account: when the
 * target currency is short and the caller supplied fxRates (and autoConvert is not
 * disabled) it returns the conversion that placeOrder/tickAccount must apply.
 */
function planBuyFunding(account, currency, required, { config, fxRates, ts, orderId, code = 'INSUFFICIENT_CASH', label = '资金' } = {}) {
  const have = cashOf(account, currency);
  if (have + EPS >= required) return { ok: true, conversion: null };

  const shortageText = `可用 ${currency} ${label}不足：需要 ${fmtNum(required)}，可用 ${fmtNum(have)}`;
  const base = account?.baseCurrency ?? 'CNY';
  if (config.autoConvert === false || !fxRates || typeof fxRates !== 'object' || currency === base) {
    return { ok: false, code, message: shortageText };
  }
  const rateTo = toFinite(fxRates[currency], NaN);
  const rateFrom = toFinite(fxRates[base], NaN);
  if (!(rateTo > 0) || !(rateFrom > 0)) return { ok: false, code, message: shortageText };

  const amountTo = round2(required - have);
  const amountFrom = round2((amountTo * rateTo / rateFrom) * (1 + toFinite(config.fxConvertSpread, 0.003)));
  const baseCash = cashOf(account, base);
  if (baseCash + EPS < amountFrom) {
    return {
      ok: false,
      code,
      message: `${shortageText}；${base} 自动换汇也不足：需要 ${fmtNum(amountFrom)}，可用 ${fmtNum(baseCash)}`
    };
  }
  return {
    ok: true,
    conversion: {
      t: ts,
      from: base,
      to: currency,
      amountFrom,
      amountTo,
      rate: roundTo(rateTo / rateFrom, 6),
      reason: orderId ?? null
    }
  };
}

function applyConversion(account, conversion) {
  ensureAccountLists(account);
  const cash = ensureCash(account);
  cash[conversion.from] = round2(toFinite(cash[conversion.from], 0) - conversion.amountFrom);
  cash[conversion.to] = round2(toFinite(cash[conversion.to], 0) + conversion.amountTo);
  account.conversions.push(conversion);
  if (account.conversions.length > MAX_CONVERSIONS) {
    account.conversions.splice(0, account.conversions.length - MAX_CONVERSIONS);
  }
  return conversion;
}

// ---------------------------------------------------------------------------
// interest accrual (contract §6A.3)
// ---------------------------------------------------------------------------

/**
 * Accrue borrow interest for every leveraged position:
 *   interest = debt * annualRate / 8760 * hours since lastInterestAt
 * Adds to position.accruedInterest and account.totalInterest and returns the amount
 * added this call. `cfg` is optional: the rate is stored on the position at open.
 */
export function accrueInterest(account, now, cfg = null) {
  if (!account || typeof account !== 'object') return 0;
  ensureAccountLists(account);
  const config = cfg ? resolveCfg(cfg) : null;
  const ts = toISO(now ?? new Date());
  const nowMs = Date.parse(ts);
  let added = 0;

  for (const [symbol, position] of Object.entries(account.positions)) {
    const debt = debtOf(position);
    const annual = interestAnnualOfPosition(position) || (config ? interestAnnualOf(currentMarketOf(position, symbol), config) : 0);
    if (!(debt > 0) || !(annual > 0)) {
      if (!position.lastInterestAt) position.lastInterestAt = ts;
      continue;
    }
    const lastMs = Date.parse(position.lastInterestAt ?? position.openedAt ?? ts);
    if (!Number.isFinite(lastMs)) {
      position.lastInterestAt = ts;
      continue;
    }
    const hours = (nowMs - lastMs) / 3600000;
    if (!(hours > 0)) {
      position.lastInterestAt = ts;
      continue;
    }
    const interest = round8(debt * annual / HOURS_PER_YEAR * hours);
    if (interest > 0) {
      position.accruedInterest = round8(interestOf(position) + interest);
      account.totalInterest = round8(toFinite(account.totalInterest, 0) + interest);
      added += interest;
    }
    position.lastInterestAt = ts;
  }

  return round8(added);
}

// ---------------------------------------------------------------------------
// fills: open / add / close
// ---------------------------------------------------------------------------

function tradeRecord(account, order, { price, qty, fees, interest = 0, liquidationFee = 0, realizedPnl = 0, leverage, positionSide, reason, ts }) {
  const market = order.market;
  return {
    id: nextId('trd'),
    orderId: order.id,
    symbol: order.symbol,
    market,
    name: order.name,
    side: order.side,
    positionSide: positionSide ?? (order.side === 'buy' ? 'long' : 'short'),
    qty: roundQty(qty),
    price: roundPrice(market, price),
    fees: round2(fees.total),
    interest: round8(interest),
    liquidationFee: round2(liquidationFee),
    realizedPnl: round2(realizedPnl),
    leverage: round4(leverage ?? 1),
    reason,
    t: ts,
    currency: marketCurrency(market)
  };
}

function executeOpen(account, order, { price, qty, fees, ts, cfg, quote = null }) {
  ensureAccountLists(account);
  const config = resolveCfg(cfg);
  const cash = ensureCash(account);
  const market = order.market;
  const currency = marketCurrency(market);
  const positionSide = order.side === 'buy' ? 'long' : 'short';
  const leverage = Math.max(1, toFinite(order.leverage, 1));
  const isFx = market === 'fx';
  // fx v5 settles in USD: margin/debt are based on the USD notional of the base units.
  const notionalUsd = isFx ? round2(qty * (usdPerBaseOf(quote, price) || price)) : null;
  const notional = isFx ? notionalUsd : qty * price;
  const margin = round2(notional / leverage);
  const debt = round2(notional - margin);
  const dayKey = dayKeyOf(ts);

  cash[currency] = round2(toFinite(cash[currency], 0) - margin - fees.total);

  let position = normalizePosition(account.positions[order.symbol], order.symbol);
  if (position) {
    const oldQty = qtyOf(position);
    const newQty = roundQty(oldQty + qty);
    const oldCost = oldQty * avgCostOf(position);
    position.qty = newQty;
    position.avgCost = newQty > 0 ? round8((oldCost + qty * price) / newQty) : 0;
    position.margin = round2(marginOf(position) + margin);
    position.debt = round2(debtOf(position) + debt);
    if (isFx) {
      // legacy fx positions fall back to qty × avgCost (USD-quoted assumption, §6A.2)
      const previousNotionalUsd = hasUsdNotional(position) ? notionalUsdOf(position) : oldQty * avgCostOf(position);
      position.notionalUsd = round2(previousNotionalUsd + notionalUsd);
    }
    position.leverage = leverage;
    position.interestAnnual = interestAnnualOf(market, config);
    position.lastInterestAt = position.lastInterestAt ?? ts;
    const nextTakeProfit = protectOf(order, 'takeProfit');
    const nextStopLoss = protectOf(order, 'stopLoss');
    if (nextTakeProfit !== null) position.takeProfit = nextTakeProfit;
    if (nextStopLoss !== null) position.stopLoss = nextStopLoss;
  } else {
    position = {
      symbol: order.symbol,
      market,
      name: order.name,
      currency,
      side: positionSide,
      qty: roundQty(qty),
      avgCost: round8(price),
      leverage,
      margin,
      debt,
      accruedInterest: 0,
      interestAnnual: interestAnnualOf(market, config),
      lastInterestAt: ts,
      takeProfit: protectOf(order, 'takeProfit'),
      stopLoss: protectOf(order, 'stopLoss'),
      openedAt: ts,
      todayBuyQty: 0,
      todayBuyDate: dayKey
    };
    if (isFx) position.notionalUsd = notionalUsd;
    account.positions[order.symbol] = position;
  }

  if (market === 'cn' && sideOf(position) === 'long') {
    if (position.todayBuyDate !== dayKey) {
      position.todayBuyDate = dayKey;
      position.todayBuyQty = 0;
    }
    position.todayBuyQty = roundQty(toFinite(position.todayBuyQty, 0) + qty);
  }

  account.totalFees = round2(toFinite(account.totalFees, 0) + fees.total);
  const trade = tradeRecord(account, order, { price, qty, fees, interest: 0, liquidationFee: 0, realizedPnl: 0, leverage, positionSide, reason: 'OPEN', ts });
  account.trades.push(trade);
  return trade;
}

/**
 * Close (part of) a position. Long closes with a sell, short closes with a buy.
 *   realized = (price - avgCost) * qty   (long)
 *   realized = (avgCost - price) * qty   (short)
 * minus fees, the proportional accrued interest and any liquidation fee. The released
 * margin is credited back to cash. Partial closes carry margin / debt / interest
 * proportionally. Returns { trade, record } where record is set for forced exits.
 */
function executeClose(account, order, { price, qty, fees, ts, cfg, reason = 'CLOSE', liquidationFeeRate = 0 }) {
  ensureAccountLists(account);
  const cash = ensureCash(account);
  const position = normalizePosition(account.positions[order.symbol], order.symbol);
  if (!position) return null;

  const market = currentMarketOf(position, order.symbol);
  const currency = currencyOf(position, market);
  const positionQty = qtyOf(position);
  const closeQty = Math.min(roundQty(qty), positionQty);
  if (!(closeQty > 0) || !(positionQty > 0)) return null;

  const ratio = closeQty / positionQty;
  const side = sideOf(position);
  const avgCost = avgCostOf(position);
  const leverage = leverageOf(position);
  const usdNotional = hasUsdNotional(position);
  const closedNotionalUsd = usdNotional ? notionalUsdOf(position) * ratio : 0;
  let gross;
  if (usdNotional) {
    // fx v5 (USD settled): closed part of the USD notional × price ratio change.
    const ratioChange = avgCost > 0 ? price / avgCost : 1;
    gross = side === 'short' ? closedNotionalUsd * (1 - ratioChange) : closedNotionalUsd * (ratioChange - 1);
  } else {
    gross = side === 'short' ? (avgCost - price) * closeQty : (price - avgCost) * closeQty;
  }
  const releasedMargin = round2(marginOf(position) * ratio);
  const interestPaid = round8(interestOf(position) * ratio);
  const liquidationFee = liquidationFeeRate > 0
    ? round2((usdNotional ? closedNotionalUsd : price * closeQty) * liquidationFeeRate)
    : 0;
  const netPnl = round2(gross - fees.total - interestPaid - liquidationFee);

  cash[currency] = round2(toFinite(cash[currency], 0) + releasedMargin + gross - fees.total - interestPaid - liquidationFee);
  account.realizedPnl = round2(toFinite(account.realizedPnl, 0) + netPnl);
  account.totalFees = round2(toFinite(account.totalFees, 0) + fees.total + liquidationFee);

  if (ratio >= 1 - 1e-9) {
    delete account.positions[order.symbol];
  } else {
    position.qty = roundQty(positionQty - closeQty);
    position.margin = round2(marginOf(position) - releasedMargin);
    position.debt = round2(debtOf(position) * (1 - ratio));
    position.accruedInterest = round8(interestOf(position) - interestPaid);
    if (usdNotional) position.notionalUsd = round2(notionalUsdOf(position) * (1 - ratio));
    if (position.qty <= EPS) delete account.positions[order.symbol];
  }

  const trade = tradeRecord(account, order, {
    price,
    qty: closeQty,
    fees,
    interest: interestPaid,
    liquidationFee,
    realizedPnl: netPnl,
    leverage,
    positionSide: side,
    reason,
    ts
  });
  account.trades.push(trade);

  let record = null;
  if (reason === 'LIQUIDATION' || reason === 'TAKE_PROFIT' || reason === 'STOP_LOSS') {
    record = {
      t: ts,
      symbol: order.symbol,
      side,
      qty: roundQty(closeQty),
      price: roundPrice(market, price),
      pnl: netPnl,
      fees: round2(fees.total + liquidationFee),
      interest: round8(interestPaid),
      reason
    };
    account.liquidations.push(record);
    if (account.liquidations.length > MAX_LIQUIDATIONS) {
      account.liquidations.splice(0, account.liquidations.length - MAX_LIQUIDATIONS);
    }
  }
  return { trade, record };
}

function completeFill(account, order, { price, qty, fees, ts, cfg, intent, reason, quote = null }) {
  let trade = null;
  if (intent === 'close') {
    const result = executeClose(account, order, { price, qty, fees, ts, cfg, reason: reason ?? 'CLOSE' });
    trade = result?.trade ?? null;
  } else {
    trade = executeOpen(account, order, { price, qty, fees, ts, cfg, quote });
  }
  if (!trade) return null;
  order.status = 'filled';
  order.filledQty = roundQty(qty);
  order.avgFillPrice = roundPrice(order.market, price);
  order.fees = round2(fees.total);
  order.updatedAt = ts;
  order.fills.push({ t: ts, qty: roundQty(qty), price: order.avgFillPrice, fees: order.fees });
  return trade;
}

// ---------------------------------------------------------------------------
// order intent resolution (open / add / close / implicit spot close)
// ---------------------------------------------------------------------------

/**
 * Decide what an order does to the current position:
 *   - close:true          -> close (side must oppose the position)
 *   - same direction      -> add (leverage must match, LEVERAGE_MISMATCH otherwise)
 *   - opposite direction  -> POSITION_CONFLICT, except that plain leverage-1 spot
 *                            orders behave like v1: selling a cash-funded long (or
 *                            buying back a spot short) closes it.
 *   - flat sell <= 1x     -> INSUFFICIENT_POSITION (matters only for immediate fills;
 *                            hanging limit orders are validated again at fill time)
 */
function resolveIntent(account, symbol, side, leverage, closeRequested, requirePosition) {
  const position = account?.positions?.[symbol] ?? null;
  const positionQty = position ? qtyOf(position) : 0;
  const hasPosition = Boolean(position) && positionQty > 0;
  const positionSide = hasPosition ? sideOf(position) : null;
  const positionLeverage = hasPosition ? leverageOf(position) : 1;
  const targetSide = side === 'buy' ? 'long' : 'short';

  if (closeRequested === true) {
    if (!hasPosition) return { code: 'INSUFFICIENT_POSITION', message: '当前无持仓可平仓' };
    if (side !== (positionSide === 'long' ? 'sell' : 'buy')) {
      return { code: 'POSITION_CONFLICT', message: `${positionSide === 'long' ? '多头' : '空头'}持仓需用${positionSide === 'long' ? '卖出' : '买入'}平仓` };
    }
    return { intent: 'close', position, positionSide, leverage: positionLeverage };
  }

  if (hasPosition) {
    if (targetSide === positionSide) {
      if (Math.abs(leverage - positionLeverage) > 1e-9) {
        return { code: 'LEVERAGE_MISMATCH', message: `加仓杠杆必须与现有持仓一致（当前 ${positionLeverage}x）` };
      }
      return { intent: 'open', position, positionSide: targetSide, leverage };
    }
    // opposite direction: a cash-funded spot position can still be closed with a plain order
    if (!isLeveraged(position) && leverage <= 1) {
      return { intent: 'close', position, positionSide, leverage: positionLeverage, implicit: true };
    }
    return { code: 'POSITION_CONFLICT', message: `已有相反方向持仓（${positionSide === 'long' ? '多头' : '空头'}），请先平仓` };
  }

  if (side === 'sell' && leverage <= 1) {
    if (requirePosition) return { code: 'INSUFFICIENT_POSITION', message: '无持仓可卖出（做空需要开启杠杆）' };
    return { intent: 'open', position: null, positionSide: 'short', leverage };
  }
  return { intent: 'open', position: null, positionSide: targetSide, leverage };
}

// ---------------------------------------------------------------------------
// order planning / validation (v2)
// ---------------------------------------------------------------------------

function priceBand(market, quote) {
  if (market !== 'cn') return null;
  const up = toFinite(quote?.extra?.limitUp, NaN);
  const down = toFinite(quote?.extra?.limitDown, NaN);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up <= 0 || down <= 0) return null;
  return { up, down };
}

function parseProtectField(value) {
  if (value === undefined) return { provided: false, value: null };
  if (value === null || value === '') return { provided: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { provided: true, invalid: true, value: null };
  return { provided: true, value: n };
}

function protectDirectionError(positionSide, reference, takeProfit, stopLoss) {
  const ref = toFinite(reference, NaN);
  if (!Number.isFinite(ref) || ref <= 0) return null;
  if (takeProfit !== null) {
    if (positionSide === 'long' && !(takeProfit > ref + EPS)) return '多头止盈价必须高于参考价';
    if (positionSide === 'short' && !(takeProfit < ref - EPS)) return '空头止盈价必须低于参考价';
  }
  if (stopLoss !== null) {
    if (positionSide === 'long' && !(stopLoss < ref - EPS)) return '多头止损价必须低于参考价';
    if (positionSide === 'short' && !(stopLoss > ref + EPS)) return '空头止损价必须高于参考价';
  }
  return null;
}

function makeOrderDraft(account, req, info, quote, ts) {
  const type = req.type === 'limit' ? 'limit' : 'market';
  const symbol = typeof req.symbol === 'string' && req.symbol ? req.symbol : quote?.symbol ?? '';
  return {
    id: typeof req.id === 'string' && req.id ? req.id : nextId('ord'),
    symbol,
    market: info?.market ?? quote?.market ?? '',
    name: quote?.name ?? account?.positions?.[symbol]?.name ?? symbol,
    side: req.side,
    type,
    qty: toFinite(req.qty, 0),
    limitPrice: type === 'limit' ? toFinite(req.limitPrice, NaN) : null,
    leverage: toFinite(req.leverage, 1),
    close: req.close === true,
    positionSide: null,
    takeProfit: null,
    stopLoss: null,
    reason: null,
    status: 'pending',
    filledQty: 0,
    avgFillPrice: null,
    fees: 0,
    createdAt: ts,
    updatedAt: ts,
    rejectCode: null,
    rejectMessage: null,
    fills: []
  };
}

/**
 * Reference (pre-slippage) executable price: best ask/bid when a book exists,
 * otherwise the last price. FX quotes get half the configured spread on each side.
 */
function bookPrice(market, side, quote, config) {
  let price = side === 'buy'
    ? toFinite(quote?.ask?.[0]?.price, NaN)
    : toFinite(quote?.bid?.[0]?.price, NaN);
  if (!Number.isFinite(price) || price <= 0) price = toFinite(quote?.price, NaN);
  if (!Number.isFinite(price) || price <= 0) return NaN;
  if (market === 'fx') {
    const halfBps = toFinite(config.fees?.fx?.spreadBps, 1.5) / 2;
    const rate = halfBps / 10000;
    price = side === 'buy' ? price * (1 + rate) : price * (1 - rate);
  }
  return price;
}

/** Standard market execution price (book + slippage) used by forced exits too. */
function marketExecutionPrice(market, side, quote, config) {
  const base = bookPrice(market, side, quote, config);
  if (!Number.isFinite(base) || base <= 0) return NaN;
  const slippage = toFinite(config.slippageBps?.[market], 0) / 10000;
  return side === 'buy' ? base * (1 + slippage) : base * (1 - slippage);
}

function validateQuantity(market, qty, quote, config) {
  if (!Number.isFinite(qty) || qty <= 0) return { code: 'QTY_INVALID', message: '委托数量必须为大于 0 的数字' };
  if (market === 'cn') {
    if (!Number.isInteger(qty) || qty % 100 !== 0) return { code: 'LOT_SIZE', message: 'A股委托数量必须为 100 股的整数倍' };
  } else if (market === 'hk') {
    const lot = Math.max(1, Math.trunc(toFinite(quote?.extra?.lotSize ?? config.lots.hk, 100)));
    if (!Number.isInteger(qty) || qty % lot !== 0) return { code: 'LOT_SIZE', message: `港股委托数量必须为每手 ${lot} 股的整数倍` };
  } else if (market === 'us') {
    if (!Number.isInteger(qty)) return { code: 'LOT_SIZE', message: '美股委托数量必须为整数股' };
  } else if (market === 'fx') {
    if (qty < 1 - EPS) return { code: 'QTY_INVALID', message: '外汇最小委托量为 1 单位' };
    if (Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) return { code: 'QTY_INVALID', message: '外汇委托数量最多支持 2 位小数' };
  } else if (market === 'crypto') {
    const step = toFinite(config.lots.crypto, 0.0001) || 0.0001;
    const floored = roundQty(Math.floor(qty / step + EPS) * step);
    if (floored <= 0) return { code: 'QTY_INVALID', message: `委托数量低于最小步长 ${step}` };
    return { qty: floored };
  }
  return { qty: roundQty(qty) };
}

const fail = (code, message, order) => ({ ok: false, code, message, order, fill: null });

/**
 * Full order evaluation. Returns the draft order plus, when the order would execute
 * right away, the resolved fill price, the fee object, the intent (open/close) and any
 * planned FX conversion. placeOrder/validateOrder share this implementation so they
 * cannot disagree.
 */
function evaluateOrder(account, req, quote, { cfg, now, fxRates } = {}) {
  const config = resolveCfg(cfg);
  const ts = toISO(now ?? new Date());
  const request = req && typeof req === 'object' ? req : {};
  const rawSymbol = typeof request.symbol === 'string' && request.symbol
    ? request.symbol
    : (typeof quote?.symbol === 'string' ? quote.symbol : '');
  const info = parseSymbol(rawSymbol);
  const order = makeOrderDraft(account, request, info, quote, ts);

  if (!quote || typeof quote !== 'object') return fail('SYMBOL_INVALID', '行情不可用，无法下单', order);
  if (!info) return fail('SYMBOL_INVALID', '标的代码格式无效，应形如 cn:sh600519', order);

  // The quote must describe the same instrument (compare market+code so a normalising
  // parser cannot cause a false mismatch).
  let canonicalSymbol = info.symbol;
  if (quote.symbol) {
    const quoteInfo = parseSymbol(quote.symbol);
    if (!quoteInfo || quoteInfo.market !== info.market || quoteInfo.code !== info.code) {
      return fail('SYMBOL_INVALID', '行情标的与下单标的不一致', order);
    }
    canonicalSymbol = quoteInfo.symbol; // key used by quotesBySymbol
  }

  const market = info.market;
  order.market = market;
  order.symbol = canonicalSymbol;
  if (!order.name || order.name === order.symbol) order.name = quote.name ?? order.symbol;

  const side = String(request.side ?? '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') return fail('PRICE_INVALID', '买卖方向无效（仅支持 buy / sell）', order);
  order.side = side;

  const type = request.type === undefined || request.type === null ? 'market' : String(request.type).toLowerCase();
  if (type !== 'market' && type !== 'limit') return fail('PRICE_INVALID', '订单类型无效（仅支持 market / limit）', order);
  order.type = type;

  let limitPrice = null;
  if (type === 'limit') {
    limitPrice = toFinite(request.limitPrice, NaN);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) return fail('PRICE_INVALID', '限价必须为大于 0 的数字', order);
    order.limitPrice = limitPrice;
  }

  const lastPrice = toFinite(quote.price, NaN);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return fail('PRICE_INVALID', '行情价格无效，无法下单', order);

  const band = priceBand(market, quote);
  if (band) {
    if (limitPrice !== null && (limitPrice > band.up + EPS || limitPrice < band.down - EPS)) {
      return fail('PRICE_LIMIT', `委托价 ${fmtNum(limitPrice)} 超出涨跌停区间 [${fmtNum(band.down)}, ${fmtNum(band.up)}]`, order);
    }
    // At the exact limit price there is no counterparty on that side.
    if (side === 'buy' && lastPrice >= band.up - EPS) return fail('NO_LIQUIDITY', '当前价格处于涨停价，无法买入', order);
    if (side === 'sell' && lastPrice <= band.down + EPS) return fail('NO_LIQUIDITY', '当前价格处于跌停价，无法卖出', order);
  }

  const open = canTradeMarket(market, ts, config);
  if (!open && type === 'market') {
    return fail('MARKET_CLOSED', `${marketLabel(market)}当前休市，市价单无法成交`, order);
  }

  // Resolve the executable price first: whether an order fills now decides how strict
  // the position / margin checks must be (hanging limit orders validate at fill time).
  let fillPrice = null;
  if (open) {
    const base = bookPrice(market, side, quote, config);
    if (!Number.isFinite(base) || base <= 0) return fail('PRICE_INVALID', '行情价格无效，无法下单', order);
    const slippage = toFinite(config.slippageBps?.[market], 0) / 10000;
    if (type === 'market') {
      fillPrice = side === 'buy' ? base * (1 + slippage) : base * (1 - slippage);
    } else if (side === 'buy') {
      if (base <= limitPrice + EPS) fillPrice = Math.min(limitPrice, base * (1 + slippage));
    } else if (base >= limitPrice - EPS) {
      fillPrice = Math.max(limitPrice, base * (1 - slippage));
    }
    if (fillPrice !== null) {
      fillPrice = roundPrice(market, fillPrice);
      if (band && (fillPrice > band.up + EPS || fillPrice < band.down - EPS)) {
        return fail('PRICE_LIMIT', `成交价 ${fmtNum(fillPrice)} 超出涨跌停区间 [${fmtNum(band.down)}, ${fmtNum(band.up)}]`, order);
      }
    }
  }
  const immediate = fillPrice !== null;

  // --- leverage / capability checks (open requests only) ---
  const closeRequested = request.close === true;
  const leverage = toFinite(request.leverage, 1);
  if (!closeRequested) {
    if (!Number.isFinite(leverage) || leverage < 1) return fail('LEVERAGE_NOT_ALLOWED', '杠杆必须为不小于 1 的数值', order);
    if (market === 'cn' && leverage > 1) {
      return side === 'sell'
        ? fail('SHORT_NOT_ALLOWED', 'A股不支持做空', order)
        : fail('LEVERAGE_NOT_ALLOWED', 'A股不支持杠杆交易', order);
    }
    if (leverage > maxLeverageOf(market, config) + EPS) {
      return fail('LEVERAGE_NOT_ALLOWED', `${marketLabel(market)}最大杠杆为 ${maxLeverageOf(market, config)}x`, order);
    }
  }

  // --- intent resolution (open / add / close / implicit spot close) ---
  const resolution = resolveIntent(account, order.symbol, side, leverage, closeRequested, immediate);
  if (resolution.code) return fail(resolution.code, resolution.message, order);
  const intent = resolution.intent;
  const position = resolution.position;
  const positionSide = resolution.positionSide;
  order.close = intent === 'close';
  order.positionSide = positionSide;
  order.leverage = intent === 'close' ? leverageOf(position) : leverage;

  if (intent === 'open' && positionSide === 'short' && !SHORT_ALLOWED[market]) {
    return fail('SHORT_NOT_ALLOWED', `${marketLabel(market)}不支持做空`, order);
  }

  // --- quantity ---
  const rawQty = request.qty === undefined || request.qty === null ? null : toFinite(request.qty, NaN);
  let qty;
  if (intent === 'close') {
    const positionQty = qtyOf(position);
    if (rawQty === null) {
      qty = roundQty(positionQty);
    } else {
      const qtyCheck = validateQuantity(market, rawQty, quote, config);
      if (qtyCheck.code) return fail(qtyCheck.code, qtyCheck.message, order);
      qty = qtyCheck.qty;
      if (qty > positionQty + EPS) {
        return fail('INSUFFICIENT_POSITION', `平仓数量超过持仓：持仓 ${fmtNum(positionQty)}，委托 ${fmtNum(qty)}`, order);
      }
    }
    order.leverage = leverageOf(position);
  } else {
    const qtyCheck = validateQuantity(market, rawQty === null ? NaN : rawQty, quote, config);
    if (qtyCheck.code) return fail(qtyCheck.code, qtyCheck.message, order);
    qty = qtyCheck.qty;
  }
  order.qty = qty;

  // --- take profit / stop loss (open orders only) ---
  const takeProfitField = parseProtectField(request.takeProfit);
  const stopLossField = parseProtectField(request.stopLoss);
  if (intent === 'open') {
    if (takeProfitField.invalid || stopLossField.invalid) {
      return fail('PROTECT_PRICE_INVALID', '止盈止损价必须为大于 0 的数字或 null', order);
    }
    const reference = immediate ? fillPrice : lastPrice;
    const directionError = protectDirectionError(positionSide, reference, takeProfitField.value, stopLossField.value);
    if (directionError) return fail('PROTECT_PRICE_INVALID', directionError, order);
    order.takeProfit = takeProfitField.value;
    order.stopLoss = stopLossField.value;
  }

  if (!immediate) {
    return { ok: true, code: null, message: null, order, fill: null, intent, positionSide, conversion: null, config };
  }

  const currency = marketCurrency(market);
  const fees = calcFees(market, side, qty, feeNotionalPrice(market, quote, fillPrice), config);

  if (intent === 'close') {
    const closable = positionSide === 'long' ? availableQty(account, order.symbol, ts) : qtyOf(position);
    if (qty > closable + EPS) {
      const hint = market === 'cn' && positionSide === 'long' ? '（A股 T+1，当日买入的股份不可卖出）' : '';
      return fail('INSUFFICIENT_POSITION', `可平数量不足：需要 ${fmtNum(qty)}，可平 ${fmtNum(closable)}${hint}`, order);
    }
    return {
      ok: true,
      code: null,
      message: null,
      order,
      fill: { price: fillPrice, qty, fees },
      intent,
      positionSide,
      conversion: null,
      config
    };
  }

  // fx v5: margin/debt are computed on the USD notional (qty × usdPerBase).
  const notional = market === 'fx'
    ? qty * (usdPerBaseOf(quote, fillPrice) || fillPrice)
    : qty * fillPrice;
  const margin = round2(notional / leverage);
  const required = round2(margin + fees.total);
  const leveraged = leverage > 1;
  const funding = planBuyFunding(account, currency, required, {
    config,
    fxRates,
    ts,
    orderId: order.id,
    code: leveraged ? 'INSUFFICIENT_MARGIN' : 'INSUFFICIENT_CASH',
    label: leveraged ? '保证金' : '资金'
  });
  if (!funding.ok) return fail(funding.code, funding.message, order);

  return {
    ok: true,
    code: null,
    message: null,
    order,
    fill: { price: fillPrice, qty, fees },
    intent,
    positionSide,
    conversion: funding.conversion,
    config
  };
}

/** Validate an order without mutating the account: -> { ok, code?, message? }. */
export function validateOrder(account, req, quote, { cfg, now, fxRates } = {}) {
  const plan = evaluateOrder(account, req, quote, { cfg, now: now ?? new Date(), fxRates });
  return plan.ok ? { ok: true } : { ok: false, code: plan.code, message: plan.message };
}

/**
 * Place an order: fills immediately when possible, otherwise parks it as `open`.
 * Rejected orders are still recorded on the account (status 'rejected') so the UI can
 * show the history. When the debit currency is short and `fxRates` is supplied, the
 * shortfall is converted from the account base currency first (§6.6).
 * -> { order, fill|null, error|null }
 */
export function placeOrder(account, req, quote, { cfg, now, fxRates } = {}) {
  ensureAccountLists(account);
  const plan = evaluateOrder(account, req, quote, { cfg, now: now ?? new Date(), fxRates });
  const order = plan.order;
  const ts = order.createdAt;

  if (!plan.ok) {
    order.status = 'rejected';
    order.rejectCode = plan.code;
    order.rejectMessage = plan.message;
    order.updatedAt = ts;
    account.orders.push(order);
    return { order, fill: null, error: { code: plan.code, message: plan.message } };
  }

  let fill = null;
  if (plan.fill) {
    if (plan.conversion) applyConversion(account, plan.conversion);
    fill = completeFill(account, order, { price: plan.fill.price, qty: plan.fill.qty, fees: plan.fill.fees, ts, cfg: plan.config, intent: plan.intent, quote });
  } else {
    order.status = 'open';
  }
  account.orders.push(order);
  return { order, fill, error: null };
}

/** Cancel a parked order: -> boolean (false when unknown or no longer open). */
export function cancelOrder(account, orderId, now) {
  const order = (account?.orders ?? []).find((item) => item.id === orderId);
  if (!order || order.status !== 'open') return false;
  order.status = 'cancelled';
  order.updatedAt = toISO(now ?? new Date());
  return true;
}

/**
 * Amend the price of an open limit order (contract §6A.6). Only `status==='open'` and
 * `type==='limit'` orders can change; the new price is re-validated against the price
 * band. -> { ok, code?, message?, order? }
 */
export function amendOrder(account, orderId, { limitPrice } = {}, quote, cfg, now) {
  // The 5th argument is `cfg`, but tolerate a `{ cfg, now }` options object so callers
  // that forward the whole option bag (like server.mjs) keep working.
  const optionsBag = cfg && typeof cfg === 'object' && !cfg.fees && !cfg.leverage && (cfg.cfg || cfg.now) ? cfg : null;
  const config = resolveCfg(optionsBag ? optionsBag.cfg : cfg);
  const ts = toISO(now ?? optionsBag?.now ?? new Date());
  const order = (account?.orders ?? []).find((item) => item.id === orderId);
  if (!order) return { ok: false, code: 'ORDER_NOT_FOUND', message: '委托不存在' };
  if (order.status !== 'open' || order.type !== 'limit') {
    return { ok: false, code: 'ORDER_NOT_AMENDABLE', message: '仅未成交的限价委托可以改价' };
  }
  const price = toFinite(limitPrice, NaN);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, code: 'PRICE_INVALID', message: '限价必须为大于 0 的数字' };
  if (quote && typeof quote === 'object') {
    if (quote.symbol) {
      const quoteInfo = parseSymbol(quote.symbol);
      const orderInfo = parseSymbol(order.symbol);
      if (!quoteInfo || !orderInfo || quoteInfo.market !== orderInfo.market || quoteInfo.code !== orderInfo.code) {
        return { ok: false, code: 'SYMBOL_INVALID', message: '行情标的与委托标的不一致' };
      }
    }
    const band = priceBand(order.market, quote);
    if (band && (price > band.up + EPS || price < band.down - EPS)) {
      return { ok: false, code: 'PRICE_LIMIT', message: `委托价 ${fmtNum(price)} 超出涨跌停区间 [${fmtNum(band.down)}, ${fmtNum(band.up)}]` };
    }
  } else if (order.market === 'cn') {
    return { ok: false, code: 'SYMBOL_INVALID', message: '行情不可用，无法校验涨跌停' };
  }
  order.limitPrice = price;
  order.updatedAt = ts;
  return { ok: true, order };
}

/**
 * Set / clear take-profit and stop-loss on a position (contract §6A.6).
 * A field that is present (even `null`) is applied; absent fields stay untouched.
 * -> { ok, code?, message?, position? }
 */
export function setProtect(account, symbol, patch = {}, quote, cfg) {
  ensureAccountLists(account);
  const info = parseSymbol(symbol);
  const key = info?.symbol ?? String(symbol ?? '');
  const position = normalizePosition(account.positions?.[symbol] ?? account.positions?.[key], key);
  if (!position) return { ok: false, code: 'INSUFFICIENT_POSITION', message: '当前无持仓，无法设置止盈止损' };

  const lastPrice = toFinite(quote?.price, NaN);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return { ok: false, code: 'PRICE_INVALID', message: '行情价格无效，无法设置止盈止损' };

  const body = patch && typeof patch === 'object' ? patch : {};
  const hasTp = Object.prototype.hasOwnProperty.call(body, 'takeProfit');
  const hasSl = Object.prototype.hasOwnProperty.call(body, 'stopLoss');
  const tpField = hasTp ? parseProtectField(body.takeProfit) : { provided: false, value: null };
  const slField = hasSl ? parseProtectField(body.stopLoss) : { provided: false, value: null };
  if (tpField.invalid || slField.invalid) {
    return { ok: false, code: 'PROTECT_PRICE_INVALID', message: '止盈止损价必须为大于 0 的数字或 null' };
  }
  const nextTp = hasTp ? tpField.value : protectOf(position, 'takeProfit');
  const nextSl = hasSl ? slField.value : protectOf(position, 'stopLoss');
  const directionError = protectDirectionError(sideOf(position), lastPrice, nextTp, nextSl);
  if (directionError) return { ok: false, code: 'PROTECT_PRICE_INVALID', message: directionError };

  if (hasTp) position.takeProfit = tpField.value;
  if (hasSl) position.stopLoss = slField.value;
  return { ok: true, position };
}

/**
 * Switch the account margin mode (contract §6A.6). Only possible with no positions and
 * no open orders. -> { ok, code?, message? }
 */
export function setMarginMode(account, marginMode) {
  ensureAccountLists(account);
  const mode = String(marginMode ?? '').toLowerCase();
  if (mode !== 'isolated' && mode !== 'cross') {
    return { ok: false, code: 'MARGIN_MODE_INVALID', message: '保证金模式无效（仅支持 isolated / cross）' };
  }
  const hasPosition = Object.values(account.positions).some((position) => qtyOf(position) > 0);
  const hasOpenOrder = account.orders.some((order) => order.status === 'open');
  if (hasPosition || hasOpenOrder) {
    return { ok: false, code: 'MARGIN_MODE_LOCKED', message: '有持仓或未成交委托时不能切换保证金模式' };
  }
  account.marginMode = mode;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// limit order matching (contract §6.4 / §6A.4)
// ---------------------------------------------------------------------------

function rejectOpenOrder(order, code, message, ts, orderUpdates) {
  order.status = 'rejected';
  order.rejectCode = code;
  order.rejectMessage = message;
  order.updatedAt = ts;
  orderUpdates.push(order);
}

/**
 * Match every open limit order against the latest quotes.
 * Orders are only matched while their market is open (a weekend/overnight stale quote
 * must not execute them). Open orders re-check their position/margin state at fill
 * time; close orders re-check that the position still exists and covers the quantity.
 * -> { fills: trade[], orderUpdates: order[] }
 */
export function tickAccount(account, quotesBySymbol, { cfg, now, fxRates } = {}) {
  ensureAccountLists(account);
  const config = resolveCfg(cfg);
  const ts = toISO(now ?? new Date());
  const quotes = quotesToMap(quotesBySymbol);
  const fills = [];
  const orderUpdates = [];

  for (const order of account.orders) {
    if (order.status !== 'open' || order.type !== 'limit') continue;
    // Never match on stale quotes from outside the market session.
    if (!canTradeMarket(order.market, ts, config)) continue;
    const quote = quotes[order.symbol];
    if (!quote || typeof quote !== 'object') continue;
    const lastPrice = toFinite(quote.price, NaN);
    const limitPrice = toFinite(order.limitPrice, NaN);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0 || !Number.isFinite(limitPrice)) continue;

    let fillPrice = null;
    if (order.side === 'buy' && lastPrice <= limitPrice + EPS) fillPrice = Math.min(limitPrice, lastPrice);
    else if (order.side === 'sell' && lastPrice >= limitPrice - EPS) fillPrice = Math.max(limitPrice, lastPrice);
    if (fillPrice === null) continue;

    fillPrice = roundPrice(order.market, fillPrice);
    const band = priceBand(order.market, quote);
    if (band && (fillPrice > band.up + EPS || fillPrice < band.down - EPS)) continue; // stay open

    // Re-resolve against the current position: it may have been closed or reduced.
    const resolution = resolveIntent(account, order.symbol, order.side, toFinite(order.leverage, 1), order.close === true, true);
    if (resolution.code) {
      rejectOpenOrder(order, resolution.code, resolution.message, ts, orderUpdates);
      continue;
    }
    const intent = resolution.intent;
    order.close = intent === 'close';
    order.positionSide = resolution.positionSide;

    if (intent === 'close') {
      const position = resolution.position;
      const positionQty = qtyOf(position);
      if (order.qty > positionQty + EPS) {
        rejectOpenOrder(order, 'INSUFFICIENT_POSITION', `持仓不足以平仓：持仓 ${fmtNum(positionQty)}，委托 ${fmtNum(order.qty)}，委托已撤销`, ts, orderUpdates);
        continue;
      }
      const closable = resolution.positionSide === 'long' ? availableQty(account, order.symbol, ts) : positionQty;
      if (order.qty > closable + EPS) {
        rejectOpenOrder(order, 'INSUFFICIENT_POSITION', `可平数量不足：可平 ${fmtNum(closable)}，委托 ${fmtNum(order.qty)}，委托已撤销`, ts, orderUpdates);
        continue;
      }
      const fees = calcFees(order.market, order.side, order.qty, feeNotionalPrice(order.market, quote, fillPrice), config);
      const trade = completeFill(account, order, { price: fillPrice, qty: order.qty, fees, ts, cfg: config, intent: 'close', quote });
      if (!trade) {
        rejectOpenOrder(order, 'INSUFFICIENT_POSITION', '持仓已不存在，委托已撤销', ts, orderUpdates);
        continue;
      }
      fills.push(trade);
      orderUpdates.push(order);
      continue;
    }

    // Opening / adding: validate the margin at fill time (cash may have moved since).
    const leverage = Math.max(1, toFinite(order.leverage, 1));
    const fees = calcFees(order.market, order.side, order.qty, feeNotionalPrice(order.market, quote, fillPrice), config);
    // fx v5: margin is based on the USD notional of the base units.
    const notional = order.market === 'fx'
      ? order.qty * (usdPerBaseOf(quote, fillPrice) || fillPrice)
      : order.qty * fillPrice;
    const required = round2(notional / leverage + fees.total);
    const currency = marketCurrency(order.market);
    const leveraged = leverage > 1;
    const funding = planBuyFunding(account, currency, required, {
      config,
      fxRates,
      ts,
      orderId: order.id,
      code: leveraged ? 'INSUFFICIENT_MARGIN' : 'INSUFFICIENT_CASH',
      label: leveraged ? '保证金' : '资金'
    });
    if (!funding.ok) {
      rejectOpenOrder(order, funding.code, `${funding.message}，委托已撤销`, ts, orderUpdates);
      continue;
    }
    if (funding.conversion) applyConversion(account, funding.conversion);

    const trade = completeFill(account, order, { price: fillPrice, qty: order.qty, fees, ts, cfg: config, intent: 'open', quote });
    if (!trade) {
      rejectOpenOrder(order, 'INSUFFICIENT_MARGIN', '开仓失败，委托已撤销', ts, orderUpdates);
      continue;
    }
    fills.push(trade);
    orderUpdates.push(order);
  }

  return { fills, orderUpdates };
}

// ---------------------------------------------------------------------------
// portfolio valuation (contract §6.5 / §6A.3 / §6A.5)
// ---------------------------------------------------------------------------

function valuationOf(account, quotes, rates, config) {
  let cashCny = 0;
  const cash = account.cash ?? {};
  for (const currency of CASH_CURRENCIES) {
    cashCny += round2(toFinite(cash[currency], 0)) * toFinite(rates[currency], 1);
  }
  const byMarket = { cn: 0, hk: 0, us: 0, fx: 0, crypto: 0 };
  let total = cashCny;
  let marginCny = 0;
  let maintenanceCny = 0;
  let posEquityLeveragedCny = 0;
  let interestCny = 0;

  for (const [symbol, position] of Object.entries(account.positions ?? {})) {
    const qty = qtyOf(position);
    if (!(qty > 0)) continue;
    const market = currentMarketOf(position, symbol);
    const quote = quotes[symbol] ?? null;
    const lastPrice = toFinite(quote?.price, avgCostOf(position));
    const rate = toFinite(rates[currencyOf(position, market)], 1);
    const contribution = positionEquityOf(position, lastPrice) * rate;
    const interest = interestOf(position) * rate;
    const leveraged = isLeveraged(position);

    total += contribution;
    if (!Number.isFinite(byMarket[market])) byMarket[market] = 0;
    byMarket[market] += contribution;
    marginCny += marginOf(position) * rate;
    interestCny += interest;
    if (leveraged) {
      posEquityLeveragedCny += contribution;
      maintenanceCny += maintenanceOf(position, lastPrice, mmrOf(market, config)) * rate;
    }
  }

  return {
    total: round2(total),
    cashCny: round2(cashCny),
    byMarket,
    marginCny: round2(marginCny),
    maintenanceCny: round2(maintenanceCny),
    posEquityLeveragedCny: round2(posEquityLeveragedCny),
    interestCny: round2(interestCny)
  };
}

/**
 * Snapshot used by GET /api/accounts/:id (contract §6.5 + §6A.3).
 *
 * equity.total = Σ cash*fx + Σ (margin + uPnL − accruedInterest)*fx
 * equity.byMarket[m] = Σ (margin + uPnL − accruedInterest)*fx for positions in m
 *                      (cash is reported separately, so Σ byMarket + cashCNY = total)
 *
 * `cfg` is an optional 5th argument used only for margin ratios (mmr); it defaults to
 * config.json's values (DEFAULT_CFG.margin).
 */
export function portfolioView(account, quotesBySymbol, fxRates, now, cfg = null) {
  const quotes = quotesToMap(quotesBySymbol);
  const rates = normalizeFxRates(fxRates);
  const config = resolveCfg(cfg);
  const ts = toISO(now ?? new Date());
  const mode = marginModeOf(account);
  const valuation = valuationOf(account, quotes, rates, config);
  const dayKey = dayKeyOf(ts);

  const positions = [];
  for (const [symbol, position] of Object.entries(account.positions ?? {})) {
    const qty = qtyOf(position);
    if (!(qty > 0)) continue;
    const market = currentMarketOf(position, symbol);
    const quote = quotes[symbol] ?? null;
    const side = sideOf(position);
    const leverage = leverageOf(position);
    const avgCost = avgCostOf(position);
    const lastPrice = toFinite(quote?.price, avgCost);
    const prevCloseRaw = toFinite(quote?.prevClose, NaN);
    const prevClose = Number.isFinite(prevCloseRaw) && prevCloseRaw > 0 ? prevCloseRaw : lastPrice;
    const margin = marginOf(position);
    const interest = interestOf(position);
    const unrealizedPnl = unrealizedPnlOf(position, lastPrice);
    const posEquity = margin + unrealizedPnl - interest;
    const leveraged = isLeveraged(position);
    const maintenance = maintenanceOf(position, lastPrice, mmrOf(market, config));
    // Today's PnL baseline (contract §6.5): a position opened on the current
    // Asia/Shanghai calendar day is measured from its entry price, so the overnight
    // move that happened before the entry is not attributed to today; an overnight
    // position (or one with a missing/invalid openedAt) is measured from prevClose.
    const openedAtMs = Date.parse(position.openedAt ?? '');
    const openedToday = Number.isFinite(openedAtMs) && dayKeyOf(openedAtMs) === dayKey;
    const todayBase = openedToday ? avgCost : prevClose;
    let todayPnl;
    let notionalUsdView = null;
    if (hasUsdNotional(position)) {
      // fx v5: USD-settled day PnL follows the same ratio basis as unrealised PnL.
      const notionalUsd = notionalUsdOf(position);
      notionalUsdView = round2(notionalUsd);
      const basis = todayBase > 0 && lastPrice > 0 ? lastPrice / todayBase : 1;
      todayPnl = side === 'short' ? notionalUsd * (1 - basis) : notionalUsd * (basis - 1);
    } else {
      todayPnl = (side === 'short' ? todayBase - lastPrice : lastPrice - todayBase) * qty;
    }
    const liqPrice = mode === 'isolated' ? liqPriceOf(position, mmrOf(market, config)) : null;
    const riskRatio = mode === 'isolated' && leveraged && maintenance > 0
      ? round4(maintenance / Math.max(posEquity, EPS))
      : null;
    // Market value is the current exposure in the position's settlement currency:
    // for fx v5 that is the USD value of the base units (qty × usdPerBase).
    let marketValue = qty * lastPrice;
    if (notionalUsdView !== null) {
      const currentUsdPerBase = usdPerBaseOf(quote, NaN);
      marketValue = Number.isFinite(currentUsdPerBase) && currentUsdPerBase > 0
        ? qty * currentUsdPerBase
        : (avgCost > 0 ? notionalUsdOf(position) * (lastPrice / avgCost) : notionalUsdOf(position));
    }

    positions.push({
      symbol,
      market,
      name: position.name ?? quote?.name ?? symbol,
      currency: currencyOf(position, market),
      side,
      qty,
      availableQty: roundQty(availableQty(account, symbol, ts)),
      avgCost: round8(avgCost),
      lastPrice: roundTo(lastPrice, PRICE_DECIMALS[market] ?? 4),
      marketValue: round2(marketValue),
      notionalUsd: notionalUsdView,
      unrealizedPnl: round2(unrealizedPnl),
      unrealizedPnlPct: margin > 0 ? round4((unrealizedPnl / margin) * 100) : 0,
      todayPnl: round2(todayPnl),
      leverage: round4(leverage),
      margin: round2(margin),
      debt: round2(debtOf(position)),
      accruedInterest: round8(interest),
      maintenanceMargin: round2(maintenance),
      liqPrice: liqPrice === null ? null : roundTo(liqPrice, PRICE_DECIMALS[market] ?? 4),
      riskRatio,
      takeProfit: protectOf(position, 'takeProfit'),
      stopLoss: protectOf(position, 'stopLoss'),
      openedAt: position.openedAt ?? null
    });
  }

  const byMarket = {};
  for (const market of MARKETS) byMarket[market] = round2(valuation.byMarket[market] ?? 0);
  for (const key of Object.keys(valuation.byMarket)) {
    if (!(key in byMarket)) byMarket[key] = round2(valuation.byMarket[key] ?? 0);
  }

  const total = valuation.total;
  const marginUsed = mode === 'cross' ? valuation.maintenanceCny : valuation.marginCny;
  const riskRatio = mode === 'cross'
    ? (valuation.maintenanceCny > 0 ? round4(valuation.maintenanceCny / Math.max(total, EPS)) : 0)
    : (valuation.maintenanceCny > 0 ? round4(valuation.maintenanceCny / Math.max(valuation.posEquityLeveragedCny, EPS)) : 0);
  // Contract §6A.3: marginAvailable = equity − marginUsed (equity already nets the
  // accrued interest, so subtracting it again would double count).
  const marginAvailable = round2(total - marginUsed);
  const dayStartEquity = round2(toFinite(account.dayStartEquity, total));
  const initialEquity = round2(toFinite(account.initialCapital, 0) * toFinite(rates[account.baseCurrency ?? 'CNY'], 1));
  const totalPnl = round2(total - initialEquity);

  return {
    cash: Object.fromEntries(CASH_CURRENCIES.map((currency) => [currency, round2(toFinite(account.cash?.[currency], 0))])),
    positions,
    equity: { total, byMarket },
    openOrders: (account.orders ?? []).filter((order) => order.status === 'open'),
    conversions: Array.isArray(account.conversions) ? account.conversions.slice(-50) : [],
    liquidations: Array.isArray(account.liquidations) ? account.liquidations.slice(-50) : [],
    marginMode: mode,
    marginUsed,
    marginAvailable,
    maintenanceMargin: valuation.maintenanceCny,
    riskRatio,
    totalInterest: round8(toFinite(account.totalInterest, 0)),
    accruedInterest: round8(valuation.interestCny),
    dayStartEquity,
    todayPnl: round2(total - dayStartEquity),
    totalPnl,
    totalPnlPct: initialEquity > 0 ? round4((totalPnl / initialEquity) * 100) : 0,
    fxRates: { ...rates },
    baseCurrency: account.baseCurrency ?? 'CNY',
    ts
  };
}

// ---------------------------------------------------------------------------
// risk control: TP/SL, isolated & cross liquidation (contract §6A.5)
// ---------------------------------------------------------------------------

function tpSlReason(position, price) {
  const side = sideOf(position);
  const takeProfit = protectOf(position, 'takeProfit');
  const stopLoss = protectOf(position, 'stopLoss');
  if (takeProfit !== null) {
    if (side === 'long' ? price >= takeProfit : price <= takeProfit) return 'TAKE_PROFIT';
  }
  if (stopLoss !== null) {
    if (side === 'long' ? price <= stopLoss : price >= stopLoss) return 'STOP_LOSS';
  }
  return null;
}

/** Forced market close of a whole position; records order, trade and liquidation row. */
function forceClosePosition(account, symbol, position, { quote, config, ts, reason }) {
  const market = currentMarketOf(position, symbol);
  const side = sideOf(position);
  const closeSide = side === 'long' ? 'sell' : 'buy';
  let price = marketExecutionPrice(market, closeSide, quote, config);
  if (!Number.isFinite(price) || price <= 0) return null;
  const band = priceBand(market, quote);
  if (band) price = Math.min(band.up, Math.max(band.down, price));
  price = roundPrice(market, price);

  const qty = roundQty(qtyOf(position));
  if (!(qty > 0)) return null;
  const fees = calcFees(market, closeSide, qty, feeNotionalPrice(market, quote, price), config);
  const liquidationFeeRate = reason === 'LIQUIDATION' ? liquidationFeeRateOf(market, config) : 0;

  const order = {
    id: nextId('ord'),
    symbol,
    market,
    name: position.name ?? symbol,
    side: closeSide,
    type: 'market',
    qty,
    limitPrice: null,
    leverage: leverageOf(position),
    close: true,
    positionSide: side,
    takeProfit: null,
    stopLoss: null,
    reason,
    status: 'pending',
    filledQty: 0,
    avgFillPrice: null,
    fees: 0,
    createdAt: ts,
    updatedAt: ts,
    rejectCode: null,
    rejectMessage: null,
    fills: []
  };
  const result = executeClose(account, order, { price, qty, fees, ts, cfg: config, reason, liquidationFeeRate });
  if (!result) return null;
  order.status = 'filled';
  order.filledQty = qty;
  order.avgFillPrice = price;
  order.fees = round2(fees.total);
  order.updatedAt = ts;
  order.fills.push({ t: ts, qty, price, fees: order.fees });
  account.orders.push(order);
  return result.record;
}

/**
 * Risk engine, called by the server every tick (contract §6A.5).
 *
 * 1. accrues interest for the elapsed time,
 * 2. triggers take-profit / stop-loss for positions of markets that are open,
 * 3. isolated mode: liquidates each position whose posEquity breaks below maintenance,
 *    cross mode: liquidates positions (largest unrealised loss first) until the
 *    account equity is back at/above the total maintenance margin,
 * 4. returns warnings when an isolated position / the cross account risk ratio > 0.8.
 *
 * Mutates the account (orders, trades, liquidations). Forced exits execute at the
 * standard market price (book + slippage), clamped into the A-share price band.
 * -> { liquidations: liquidationRows, triggered: tpSlRows, warnings: [...] }
 */
export function checkRisk(account, quotesBySymbol, fxRates, { cfg, now } = {}) {
  ensureAccountLists(account);
  const config = resolveCfg(cfg);
  const ts = toISO(now ?? new Date());
  const quotes = quotesToMap(quotesBySymbol);
  const rates = normalizeFxRates(fxRates);
  const mode = marginModeOf(account);
  const liquidations = [];
  const triggered = [];

  accrueInterest(account, ts, config);

  // 1) take profit / stop loss
  for (const symbol of Object.keys(account.positions)) {
    const position = normalizePosition(account.positions[symbol], symbol);
    if (!position) continue;
    const quote = quotes[symbol];
    const price = toFinite(quote?.price, NaN);
    if (!Number.isFinite(price) || price <= 0) continue;
    const market = currentMarketOf(position, symbol);
    if (!canTradeMarket(market, ts, config)) continue;
    const reason = tpSlReason(position, price);
    if (!reason) continue;
    const record = forceClosePosition(account, symbol, position, { quote, config, ts, reason });
    if (record) triggered.push(record);
  }

  // 2) margin calls
  if (mode === 'isolated') {
    for (const symbol of Object.keys(account.positions)) {
      const position = account.positions[symbol];
      if (!position || !isLeveraged(position)) continue;
      const quote = quotes[symbol];
      const price = toFinite(quote?.price, NaN);
      if (!Number.isFinite(price) || price <= 0) continue;
      const market = currentMarketOf(position, symbol);
      if (!canTradeMarket(market, ts, config)) continue;
      const posEquity = positionEquityOf(position, price);
      const maintenance = maintenanceOf(position, price, mmrOf(market, config));
      // liquidate once the position equity breaks *below* the maintenance margin
      if (posEquity < maintenance - EPS) {
        const record = forceClosePosition(account, symbol, position, { quote, config, ts, reason: 'LIQUIDATION' });
        if (record) liquidations.push(record);
      }
    }
  } else {
    let valuation = valuationOf(account, quotes, rates, config);
    if (valuation.maintenanceCny > 0 && valuation.total < valuation.maintenanceCny - EPS) {
      const candidates = [];
      for (const [symbol, position] of Object.entries(account.positions)) {
        if (!isLeveraged(position)) continue;
        const quote = quotes[symbol];
        const price = toFinite(quote?.price, NaN);
        if (!Number.isFinite(price) || price <= 0) continue;
        const market = currentMarketOf(position, symbol);
        if (!canTradeMarket(market, ts, config)) continue;
        const rate = toFinite(rates[currencyOf(position, market)], 1);
        candidates.push({ symbol, unrealizedCny: unrealizedPnlOf(position, price) * rate });
      }
      candidates.sort((a, b) => a.unrealizedCny - b.unrealizedCny); // biggest loss first
      for (const candidate of candidates) {
        valuation = valuationOf(account, quotes, rates, config);
        // stop once the account equity is back at/above the maintenance margin
        if (valuation.total >= valuation.maintenanceCny + EPS) break;
        const position = account.positions[candidate.symbol];
        if (!position) continue;
        const record = forceClosePosition(account, candidate.symbol, position, { quote: quotes[candidate.symbol], config, ts, reason: 'LIQUIDATION' });
        if (record) liquidations.push(record);
      }
    }
  }

  // 3) warnings for the remaining risk
  const warnings = [];
  const valuation = valuationOf(account, quotes, rates, config);
  if (mode === 'cross') {
    if (valuation.maintenanceCny > 0) {
      const riskRatio = valuation.maintenanceCny / Math.max(valuation.total, EPS);
      if (riskRatio > 0.8) {
        warnings.push({
          code: 'RISK_HIGH',
          symbol: null,
          riskRatio: round4(riskRatio),
          message: `账户风险率 ${fmtPercent(riskRatio)}，接近强平，请及时减仓或补充保证金`
        });
      }
    }
  } else {
    for (const [symbol, position] of Object.entries(account.positions)) {
      if (!position || !isLeveraged(position)) continue;
      const quote = quotes[symbol];
      const price = toFinite(quote?.price, NaN);
      if (!Number.isFinite(price) || price <= 0) continue;
      const market = currentMarketOf(position, symbol);
      const maintenance = maintenanceOf(position, price, mmrOf(market, config));
      if (!(maintenance > 0)) continue;
      const posEquity = positionEquityOf(position, price);
      const riskRatio = maintenance / Math.max(posEquity, EPS);
      if (riskRatio > 0.8) {
        warnings.push({
          code: 'RISK_HIGH',
          symbol,
          riskRatio: round4(riskRatio),
          message: `${position.name ?? symbol} ${sideOf(position) === 'long' ? '多' : '空'}仓风险率 ${fmtPercent(riskRatio)}，接近强平`
        });
      }
    }
  }

  return { liquidations, triggered, warnings };
}

// ---------------------------------------------------------------------------
// day roll (T+1 unlock + daily pnl baseline)
// ---------------------------------------------------------------------------

/**
 * Roll the account to the Asia/Shanghai day of `now` when the day changed: clears the
 * T+1 lock flags of all positions and snapshots dayStartEquity (an explicit equity may
 * be passed as the 3rd argument, otherwise the last equityHistory point is used).
 * -> boolean, true when a day boundary was crossed.
 */
export function rollDay(account, now, equity) {
  ensureAccountLists(account);
  const ts = toISO(now ?? new Date());
  const dayKey = dayKeyOf(ts);
  if (account.dayKey === dayKey) return false;

  let snapshot = null;
  if (typeof equity === 'number' && Number.isFinite(equity)) snapshot = equity;
  else if (equity && typeof equity === 'object') {
    const candidate = equity.equity ?? equity.total ?? equity.dayStartEquity;
    if (Number.isFinite(Number(candidate))) snapshot = Number(candidate);
  }
  if (snapshot === null) {
    const history = account.equityHistory ?? [];
    const last = history.length ? history[history.length - 1] : null;
    const candidate = Number(last?.equity);
    if (Number.isFinite(candidate)) snapshot = candidate;
  }

  for (const position of Object.values(account.positions)) {
    position.todayBuyQty = 0;
    position.todayBuyDate = dayKey;
  }
  account.dayKey = dayKey;
  if (snapshot !== null) account.dayStartEquity = round2(snapshot);
  return true;
}

/** Append (or overwrite the last point of) equityHistory. Returns the history array. */
export function appendEquityPoint(account, equity, nowISO, maxPoints = 5000) {
  ensureAccountLists(account);
  const value = round2(Number(equity));
  if (!Number.isFinite(value)) return account.equityHistory;
  const ts = toISO(nowISO ?? new Date());
  const history = account.equityHistory;
  const last = history[history.length - 1];
  if (last && last.t === ts) last.equity = value;
  else history.push({ t: ts, equity: value });
  if (maxPoints > 0 && history.length > maxPoints) history.splice(0, history.length - maxPoints);
  return history;
}

export { CASH_CURRENCIES, MARKETS, PRICE_DECIMALS };
