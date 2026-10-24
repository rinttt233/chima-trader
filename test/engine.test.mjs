// test/engine.test.mjs — offline unit tests for lib/engine.mjs, lib/store.mjs, lib/stats.mjs.
//
// Run with: node test/engine.test.mjs
// No network access, no real files outside a temp directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  accrueInterest,
  amendOrder,
  availableQty,
  calcFees,
  canTradeMarket,
  checkRisk,
  createAccount,
  dayKeyOf,
  parseSymbol,
  placeOrder,
  portfolioView,
  rollDay,
  setMarginMode,
  setProtect,
  tickAccount,
  validateOrder
} from '../lib/engine.mjs';
import { createStore } from '../lib/store.mjs';
import { computeStats, equitySeries } from '../lib/stats.mjs';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const NOW_FRI = '2026-10-23T10:00:00+08:00'; // Friday, cn session open
const NOW_MON = '2026-10-26T10:00:00+08:00'; // Monday, cn session open
const NOW_SAT = '2026-10-24T10:00:00+08:00'; // Saturday, cn closed
const NOW_US_THU = '2026-10-22T14:00:00Z'; // Thursday 10:00 America/New_York

const round2 = (value) => Math.round(Number(value) * 100) / 100;

function makeQuote(overrides = {}) {
  return {
    symbol: 'cn:sh600519',
    market: 'cn',
    code: '600519',
    name: '贵州茅台',
    currency: 'CNY',
    price: 100,
    prevClose: 99,
    open: 99.5,
    high: 101,
    low: 98.5,
    change: 1,
    changePct: 1.01,
    volume: 1000,
    amount: 100000,
    bid: [],
    ask: [],
    ts: NOW_FRI,
    stale: false,
    source: 'test',
    extra: { limitUp: 110, limitDown: 90 },
    ...overrides
  };
}

const cnQuote = (overrides = {}) => makeQuote({ symbol: 'cn:sh600519', market: 'cn', code: '600519', name: '贵州茅台', currency: 'CNY', extra: { limitUp: 110, limitDown: 90 }, ...overrides });
const hkQuote = (overrides = {}) => makeQuote({ symbol: 'hk:hk00700', market: 'hk', code: '00700', name: '腾讯控股', currency: 'HKD', price: 300, prevClose: 295, extra: {}, ts: NOW_FRI, ...overrides });
const usQuote = (overrides = {}) => makeQuote({ symbol: 'us:usAAPL', market: 'us', code: 'AAPL', name: '苹果', currency: 'USD', price: 200, prevClose: 198, extra: {}, ts: NOW_US_THU, ...overrides });
const fxQuote = (overrides = {}) => makeQuote({ symbol: 'fx:EURUSD', market: 'fx', code: 'EURUSD', name: '欧元美元', currency: 'USD', price: 1.08, prevClose: 1.0795, extra: {}, ...overrides });
const cryptoQuote = (overrides = {}) => makeQuote({ symbol: 'crypto:BTCUSDT', market: 'crypto', code: 'BTCUSDT', name: '比特币', currency: 'USDT', price: 60000, prevClose: 59500, extra: {}, ...overrides });
const ethQuote = (overrides = {}) => makeQuote({ symbol: 'crypto:ETHUSDT', market: 'crypto', code: 'ETHUSDT', name: '以太坊', currency: 'USDT', price: 3000, prevClose: 2990, extra: {}, ...overrides });

// v2 helpers: leveraged accounts and CNY-neutral fx rates (so equity values are the
// raw instrument-currency numbers and easy to assert).
const RATES_ONE = { CNY: 1, USD: 1, HKD: 1, USDT: 1 };

function leveragedAccount(options = {}) {
  return createAccount(
    { id: options.id ?? 'acc_lev', name: '杠杆账户', initialCapital: options.initialCapital ?? 100000, baseCurrency: options.baseCurrency ?? 'USDT', marginMode: options.marginMode ?? 'isolated' },
    { now: options.now ?? NOW_FRI }
  );
}

function openCrypto10x(account, overrides = {}, options = {}) {
  const result = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: options.side ?? 'buy', type: 'market', qty: options.qty ?? 0.1, leverage: options.leverage ?? 10 }, cryptoQuote(overrides), { cfg: CFG, now: options.now ?? NOW_FRI });
  assert.equal(result.error, null, `open failed: ${JSON.stringify(result.error)}`);
  return result;
}

function makeAccount(options = {}) {
  return createAccount({ id: options.id ?? 'acc_test', name: options.name ?? '测试账户', initialCapital: options.initialCapital ?? 1000000, baseCurrency: options.baseCurrency ?? 'CNY' }, { now: options.now ?? NOW_FRI });
}

function expectError(result, code) {
  assert.equal(result.error?.code, code, `expected error ${code}, got ${JSON.stringify(result.error)}`);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0, 'error message must be non-empty Chinese text');
}

function expectValidation(account, req, quote, code, now = NOW_FRI) {
  const result = validateOrder(account, req, quote, { cfg: CFG, now });
  assert.equal(result.ok, false, `expected ${code}, validation passed`);
  assert.equal(result.code, code);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
}

// ---------------------------------------------------------------------------
// accounts & sessions
// ---------------------------------------------------------------------------

test('createAccount seeds cash in base currency, day baseline and equity history', () => {
  const account = makeAccount({ initialCapital: 100000 });
  assert.equal(account.cash.CNY, 100000);
  assert.equal(account.cash.USD, 0);
  assert.equal(account.cash.HKD, 0);
  assert.equal(account.cash.USDT, 0);
  assert.deepEqual(account.positions, {});
  assert.equal(account.dayStartEquity, 100000);
  assert.equal(account.dayKey, '2026-10-23');
  assert.equal(account.equityHistory.length, 1);
  assert.equal(account.equityHistory[0].equity, 100000);
  assert.equal(account.realizedPnl, 0);
  assert.equal(account.totalFees, 0);

  const hkAccount = makeAccount({ initialCapital: 50000, baseCurrency: 'HKD' });
  assert.equal(hkAccount.cash.HKD, 50000);
  assert.equal(hkAccount.cash.CNY, 0);
});

test('canTradeMarket follows each market session in its own time zone', () => {
  assert.equal(canTradeMarket('cn', '2026-10-23T10:00:00+08:00'), true);
  assert.equal(canTradeMarket('cn', '2026-10-23T11:29:00+08:00'), true);
  assert.equal(canTradeMarket('cn', '2026-10-23T11:30:00+08:00'), false); // session end is exclusive
  assert.equal(canTradeMarket('cn', '2026-10-23T12:00:00+08:00'), false); // lunch break
  assert.equal(canTradeMarket('cn', '2026-10-23T14:00:00+08:00'), true);
  assert.equal(canTradeMarket('cn', NOW_SAT), false); // weekend

  assert.equal(canTradeMarket('hk', '2026-10-23T10:00:00+08:00'), true);
  assert.equal(canTradeMarket('hk', '2026-10-23T12:30:00+08:00'), false);
  assert.equal(canTradeMarket('hk', '2026-10-23T16:30:00+08:00'), false);

  assert.equal(canTradeMarket('us', NOW_US_THU), true);
  assert.equal(canTradeMarket('us', '2026-10-22T21:00:00Z'), false); // 17:00 New York
  assert.equal(canTradeMarket('us', '2026-10-24T14:00:00Z'), false); // Saturday
  assert.equal(canTradeMarket('us', '2026-10-24T15:00:00Z'), false);

  assert.equal(canTradeMarket('crypto', NOW_SAT), true);
  assert.equal(canTradeMarket('crypto', '2026-10-25T03:00:00+08:00'), true);

  // fx: Monday 05:00 -> Saturday 05:00 Asia/Shanghai, 05:00-06:00 closed daily.
  assert.equal(canTradeMarket('fx', '2026-10-26T06:30:00+08:00'), true);
  assert.equal(canTradeMarket('fx', '2026-10-26T05:30:00+08:00'), false);
  assert.equal(canTradeMarket('fx', '2026-10-27T04:00:00+08:00'), true);
  assert.equal(canTradeMarket('fx', '2026-10-27T05:30:00+08:00'), false);
  assert.equal(canTradeMarket('fx', '2026-10-24T04:00:00+08:00'), true); // Saturday before 05:00
  assert.equal(canTradeMarket('fx', '2026-10-24T06:00:00+08:00'), false);
  assert.equal(canTradeMarket('fx', '2026-10-25T10:00:00+08:00'), false); // Sunday
});

test('dayKeyOf uses Asia/Shanghai regardless of the machine time zone', () => {
  assert.equal(dayKeyOf('2026-10-23T10:00:00+08:00'), '2026-10-23');
  assert.equal(dayKeyOf('2026-10-23T16:30:00Z'), '2026-10-24'); // 00:30 Shanghai next day
});

test('parseSymbol normalizes aliases to market:code and is the account key source', () => {
  // Canonical forms (contract §2).
  assert.equal(parseSymbol('cn:sh600519').symbol, 'cn:sh600519');
  assert.equal(parseSymbol('hk:hk00700').symbol, 'hk:hk00700');
  assert.equal(parseSymbol('us:usAAPL').symbol, 'us:usAAPL');
  assert.equal(parseSymbol('fx:EURUSD').symbol, 'fx:EURUSD');
  assert.equal(parseSymbol('crypto:BTCUSDT').symbol, 'crypto:BTCUSDT');
  // Aliases and bare source codes are accepted but always normalised.
  assert.equal(parseSymbol('fx:fxEURUSD').symbol, 'fx:EURUSD');
  assert.equal(parseSymbol('whEURUSD').symbol, 'fx:EURUSD');
  assert.equal(parseSymbol('crypto:cryptoBTCUSDT').symbol, 'crypto:BTCUSDT');
  assert.equal(parseSymbol('BTCUSDT').symbol, 'crypto:BTCUSDT');
  assert.equal(parseSymbol('sh600519').symbol, 'cn:sh600519');
  assert.equal(parseSymbol('usAAPL').symbol, 'us:usAAPL');
  assert.equal(parseSymbol('hk00700').symbol, 'hk:hk00700');
  // Currency follows the canonical market.
  assert.equal(parseSymbol('crypto:BTCUSDT').currency, 'USDT');
  assert.equal(parseSymbol('fx:EURUSD').currency, 'USD');
  // Invalid input must never throw out of the engine.
  assert.equal(parseSymbol('nonsense'), null);
  assert.equal(parseSymbol(''), null);
  assert.equal(parseSymbol(null), null);

  // Orders and positions are keyed by the canonical symbol, never the alias.
  const account = makeAccount({ baseCurrency: 'USDT', initialCapital: 100000 });
  const placed = placeOrder(account, { symbol: 'crypto:cryptoBTCUSDT', side: 'buy', type: 'market', qty: 0.1 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(placed.error, null);
  assert.equal(placed.order.symbol, 'crypto:BTCUSDT');
  assert.equal(account.trades[0].symbol, 'crypto:BTCUSDT');
  assert.ok(account.positions['crypto:BTCUSDT']);
  assert.equal(account.positions['crypto:cryptoBTCUSDT'], undefined);

  // A quote keyed by a legacy alias is still matched by tickAccount.
  const hang = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, limitPrice: 59000 },
    cryptoQuote({ price: 60000 }), { cfg: CFG, now: NOW_FRI });
  assert.equal(hang.order.status, 'open');
  const tick = tickAccount(account, { 'crypto:cryptoBTCUSDT': cryptoQuote({ price: 58000 }) }, { cfg: CFG, now: NOW_FRI });
  assert.equal(tick.fills.length, 1);
  assert.equal(tick.fills[0].symbol, 'crypto:BTCUSDT');
});

// ---------------------------------------------------------------------------
// A-share rules
// ---------------------------------------------------------------------------

test('cn market buy fills at ask plus slippage and books cash / position / trade', () => {
  const account = makeAccount();
  const quote = cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }], bid: [{ price: 99.99, size: 100 }] });
  const result = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, quote, { cfg: CFG, now: NOW_FRI });

  assert.equal(result.error, null);
  assert.equal(result.order.status, 'filled');
  assert.equal(result.order.filledQty, 100);
  assert.equal(result.fill.price, 100.02); // 100.01 * (1 + 1bp), rounded to fen
  assert.equal(result.fill.fees, 5.1);
  assert.equal(result.fill.qty, 100);
  assert.equal(account.cash.CNY, 989992.9);
  assert.equal(account.totalFees, 5.1);
  assert.equal(account.positions['cn:sh600519'].qty, 100);
  assert.equal(account.positions['cn:sh600519'].avgCost, 100.02);
  assert.equal(account.positions['cn:sh600519'].todayBuyQty, 100);
  assert.equal(account.positions['cn:sh600519'].todayBuyDate, '2026-10-23');
  assert.equal(account.trades.length, 1);
  assert.equal(account.trades[0].price, 100.02);
  assert.equal(account.trades[0].side, 'buy');
  assert.equal(account.orders.length, 1);
});

test('cn rejects non 100-share lots with LOT_SIZE', () => {
  const account = makeAccount();
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 150 }, cnQuote(), 'LOT_SIZE');
  const result = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 150 }, cnQuote(), { cfg: CFG, now: NOW_FRI });
  expectError(result, 'LOT_SIZE');
  assert.equal(result.fill, null);
  assert.equal(result.order.status, 'rejected');
  assert.equal(account.orders.at(-1).rejectCode, 'LOT_SIZE');
  assert.equal(account.cash.CNY, 1000000);
});

test('cn T+1 locks same-day buys and unlocks them after rollDay', () => {
  const account = makeAccount();
  const buyQuote = cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }], bid: [{ price: 99.99, size: 100 }] });
  const buy = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, buyQuote, { cfg: CFG, now: NOW_FRI });
  assert.equal(buy.error, null);
  assert.equal(availableQty(account, 'cn:sh600519', NOW_FRI), 0);

  const sellQuote = cnQuote({ price: 101, ask: [{ price: 101.01, size: 100 }], bid: [{ price: 100.99, size: 100 }] });
  expectValidation(account, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100 }, sellQuote, 'INSUFFICIENT_POSITION');
  const blocked = placeOrder(account, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100 }, sellQuote, { cfg: CFG, now: NOW_FRI });
  expectError(blocked, 'INSUFFICIENT_POSITION');
  assert.match(blocked.error.message, /T\+1/);

  // Next trading day: day roll unlocks the position.
  assert.equal(rollDay(account, NOW_MON), true);
  assert.equal(availableQty(account, 'cn:sh600519', NOW_MON), 100);
  assert.equal(account.positions['cn:sh600519'].todayBuyQty, 0);

  const sell = placeOrder(account, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100 }, sellQuote, { cfg: CFG, now: NOW_MON });
  assert.equal(sell.error, null);
  assert.equal(sell.fill.price, 100.98); // 100.99 * (1 - 1bp)
  assert.equal(sell.fill.fees, 10.15);
  assert.equal(sell.fill.realizedPnl, 85.85); // (100.98 - 100.02) * 100 - 10.15
  assert.equal(account.positions['cn:sh600519'], undefined);
  assert.equal(account.cash.CNY, 1000080.75);
  assert.equal(account.realizedPnl, 85.85);
});

test('cn honours the daily price band and rejects limit-up buying', () => {
  const account = makeAccount();
  // Limit price outside the band.
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 120 }, cnQuote(), 'PRICE_LIMIT');
  // Slippage pushes the market fill above limitUp.
  const slipped = cnQuote({ price: 109.99, ask: [{ price: 110, size: 100 }], bid: [{ price: 109.98, size: 100 }] });
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, slipped, 'PRICE_LIMIT');
  // Buying at the limit-up price means no counterparty.
  const limitUp = cnQuote({ price: 110, ask: [{ price: 110, size: 100 }], bid: [{ price: 109.99, size: 100 }] });
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, limitUp, 'NO_LIQUIDITY');
  // Selling at the limit-down price means no counterparty either.
  account.positions['cn:sh600519'] = {
    symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', currency: 'CNY',
    qty: 100, avgCost: 100, todayBuyQty: 0, todayBuyDate: null, openedAt: NOW_FRI
  };
  const limitDown = cnQuote({ price: 90, ask: [{ price: 90.01, size: 100 }], bid: [{ price: 90, size: 100 }], extra: { limitUp: 110, limitDown: 90 } });
  expectValidation(account, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100 }, limitDown, 'NO_LIQUIDITY');
});

test('closed market rejects market orders but accepts limit orders', () => {
  const account = makeAccount();
  const satQuote = cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }], bid: [{ price: 99.99, size: 100 }], ts: NOW_SAT });
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, satQuote, 'MARKET_CLOSED', NOW_SAT);

  const parked = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 95 }, satQuote, { cfg: CFG, now: NOW_SAT });
  assert.equal(parked.error, null);
  assert.equal(parked.fill, null);
  assert.equal(parked.order.status, 'open');
  assert.equal(parked.order.limitPrice, 95);
  assert.equal(account.cash.CNY, 1000000);
});

// ---------------------------------------------------------------------------
// Hong Kong / US / FX / crypto rules
// ---------------------------------------------------------------------------

test('hk uses quote lotSize, trades T+0 and has no price band', () => {
  const account = makeAccount({ baseCurrency: 'HKD', initialCapital: 1000000 });
  const lotQuote = hkQuote({ extra: { lotSize: 500 }, ask: [{ price: 300.1, size: 500 }], bid: [{ price: 299.9, size: 500 }] });
  expectValidation(account, { symbol: 'hk:hk00700', side: 'buy', type: 'market', qty: 100 }, lotQuote, 'LOT_SIZE');

  const buy = placeOrder(account, { symbol: 'hk:hk00700', side: 'buy', type: 'market', qty: 500 }, lotQuote, { cfg: CFG, now: NOW_FRI });
  assert.equal(buy.error, null);
  assert.equal(buy.fill.price, 300.13); // 300.1 * (1 + 1bp), 3 decimals
  assert.equal(account.positions['hk:hk00700'].qty, 500);

  // T+0: the same day sell is allowed, and a far-fetched price triggers no PRICE_LIMIT.
  const sell = placeOrder(account, { symbol: 'hk:hk00700', side: 'sell', type: 'market', qty: 500 }, hkQuote({ ask: [{ price: 300.1, size: 500 }], bid: [{ price: 299.9, size: 500 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(sell.error, null);
  assert.equal(sell.fill.price, 299.87); // 299.9 * (1 - 1bp)
  assert.equal(account.positions['hk:hk00700'], undefined);

  // Default lot size from cfg.lots.hk when the quote has no lotSize.
  expectValidation(account, { symbol: 'hk:hk00700', side: 'buy', type: 'market', qty: 150 }, hkQuote({ extra: {} }), 'LOT_SIZE');
  assert.equal(validateOrder(account, { symbol: 'hk:hk00700', side: 'buy', type: 'market', qty: 100 }, hkQuote({ extra: {}, price: 999.9 }), { cfg: CFG, now: NOW_FRI }).ok, true);
});

test('us trades single shares T+0 and charges per-share commission', () => {
  const account = makeAccount({ baseCurrency: 'USD', initialCapital: 10000 });
  expectValidation(account, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1.5 }, usQuote(), 'LOT_SIZE', NOW_US_THU);

  const buy = placeOrder(account, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1 }, usQuote({ ask: [{ price: 200.01, size: 10 }], bid: [{ price: 199.99, size: 10 }] }), { cfg: CFG, now: NOW_US_THU });
  assert.equal(buy.error, null);
  assert.equal(buy.fill.price, 200.03); // 200.01 * (1 + 1bp), 4 decimals
  assert.equal(buy.fill.fees, 1);
  assert.equal(account.cash.USD, 9798.97);

  const sell = placeOrder(account, { symbol: 'us:usAAPL', side: 'sell', type: 'market', qty: 1 }, usQuote({ ask: [{ price: 200.01, size: 10 }], bid: [{ price: 199.99, size: 10 }] }), { cfg: CFG, now: NOW_US_THU });
  assert.equal(sell.error, null);
  assert.equal(sell.fill.price, 199.97);
  assert.equal(sell.fill.fees, 1.01); // 1 commission + 199.97 * 0.0000278 SEC fee
  assert.equal(sell.fill.realizedPnl, -1.07);
  assert.equal(account.positions['us:usAAPL'], undefined);
  assert.equal(account.cash.USD, 9997.93);
});

test('fx applies half spread plus slippage, zero commission and a 2-decimal quantity limit', () => {
  const account = makeAccount({ baseCurrency: 'USD', initialCapital: 100000 });
  const buy = placeOrder(account, { symbol: 'fx:EURUSD', side: 'buy', type: 'market', qty: 1000 }, fxQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(buy.error, null);
  assert.equal(buy.fill.price, 1.0803); // 1.08 * (1 + 0.75bp) * (1 + 2bp)
  assert.equal(buy.fill.fees, 0);
  assert.equal(account.cash.USD, 98919.7);

  const sell = placeOrder(account, { symbol: 'fx:EURUSD', side: 'sell', type: 'market', qty: 1000 }, fxQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(sell.error, null);
  assert.equal(sell.fill.price, 1.0797);
  assert.equal(sell.fill.fees, 0);
  assert.equal(account.realizedPnl, -0.6);

  expectValidation(account, { symbol: 'fx:EURUSD', side: 'buy', type: 'market', qty: 0.5 }, fxQuote(), 'QTY_INVALID');
  expectValidation(account, { symbol: 'fx:EURUSD', side: 'buy', type: 'market', qty: 1.005 }, fxQuote(), 'QTY_INVALID');
  assert.equal(validateOrder(account, { symbol: 'fx:EURUSD', side: 'buy', type: 'market', qty: 1.5 }, fxQuote(), { cfg: CFG, now: NOW_FRI }).ok, true);

  const sunday = '2026-10-25T10:00:00+08:00';
  expectValidation(account, { symbol: 'fx:EURUSD', side: 'buy', type: 'market', qty: 1000 }, fxQuote(), 'MARKET_CLOSED', sunday);
});

test('crypto trades 7x24, rounds qty down to the step and charges 0.1%', () => {
  const account = makeAccount({ baseCurrency: 'USDT', initialCapital: 100000 });
  const sunday = '2026-10-25T03:00:00+08:00';
  const buy = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.0123456 }, cryptoQuote(), { cfg: CFG, now: sunday });
  assert.equal(buy.error, null);
  assert.equal(buy.order.qty, 0.0123); // floored to the 0.0001 step
  assert.equal(buy.fill.price, 60018); // 60000 * (1 + 3bp)
  assert.equal(buy.fill.fees, 0.74); // 0.0123 * 60018 * 0.001
  assert.equal(account.positions['crypto:BTCUSDT'].qty, 0.0123);

  expectValidation(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.00005 }, cryptoQuote(), 'QTY_INVALID', sunday);

  const sell = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.0123 }, cryptoQuote(), { cfg: CFG, now: sunday });
  assert.equal(sell.error, null);
  assert.equal(sell.fill.price, 59982); // 60000 * (1 - 3bp)
  assert.equal(sell.fill.fees, 0.74);
});

// ---------------------------------------------------------------------------
// fees
// ---------------------------------------------------------------------------

test('calcFees matches the configured schedule for every market', () => {
  const cnBuy = calcFees('cn', 'buy', 100, 100, CFG);
  assert.deepEqual(cnBuy.breakdown, { commission: 5, stampDuty: 0, transferFee: 0.1 });
  assert.equal(cnBuy.total, 5.1);

  const cnSell = calcFees('cn', 'sell', 100, 100, CFG);
  assert.deepEqual(cnSell.breakdown, { commission: 5, stampDuty: 5, transferFee: 0.1 });
  assert.equal(cnSell.total, 10.1);

  const cnLarge = calcFees('cn', 'buy', 1000, 100, CFG); // notional 100000 -> commission 25
  assert.equal(cnLarge.breakdown.commission, 25);
  assert.equal(cnLarge.breakdown.transferFee, 1);
  assert.equal(cnLarge.total, 26);

  const hkBuy = calcFees('hk', 'buy', 100, 300, CFG);
  assert.deepEqual(hkBuy.breakdown, { commission: 100, stampDuty: 30, exchangeFee: 1.7, settlementFee: 0.6 });
  assert.equal(hkBuy.total, 132.3);
  assert.equal(calcFees('hk', 'sell', 100, 300, CFG).total, 132.3); // stamp duty both ways

  const usBuy = calcFees('us', 'buy', 100, 200, CFG);
  assert.deepEqual(usBuy.breakdown, { commission: 1, secFee: 0 });
  assert.equal(usBuy.total, 1);
  const usSell = calcFees('us', 'sell', 100, 200, CFG);
  assert.deepEqual(usSell.breakdown, { commission: 1, secFee: 0.56 });
  assert.equal(usSell.total, 1.56);

  assert.equal(calcFees('fx', 'buy', 1000, 1.08, CFG).total, 0);
  assert.equal(calcFees('crypto', 'buy', 0.1, 60000, CFG).total, 6);
  assert.equal(calcFees('crypto', 'sell', 0.1, 60000, CFG).total, 6);
});

test('slippage always moves the fill against the trader', () => {
  // cn with a book: buy at ask, sell at bid.
  const cnBuy = makeAccount();
  const buyQuote = cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }], bid: [{ price: 99.99, size: 100 }] });
  const buy = placeOrder(cnBuy, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, buyQuote, { cfg: CFG, now: NOW_FRI });
  assert.ok(buy.fill.price > 100, 'buy fill must be above the reference price');

  // crypto without a book uses quote.price then adds 3bp.
  const cryptoAccount = makeAccount({ baseCurrency: 'USDT', initialCapital: 100000 });
  const cryptoBuy = placeOrder(cryptoAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(cryptoBuy.fill.price, 60018);
  const cryptoSell = placeOrder(cryptoAccount, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.1 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(cryptoSell.fill.price, 59982);
  assert.ok(cryptoSell.fill.price < 60000, 'sell fill must be below the reference price');
});

// ---------------------------------------------------------------------------
// limit orders
// ---------------------------------------------------------------------------

test('limit buy parks as open and later fills at the better quote price', () => {
  const account = makeAccount();
  const hangQuote = cnQuote({ price: 100.5, ask: [{ price: 100.51, size: 100 }], bid: [{ price: 100.49, size: 100 }] });
  const placed = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 100 }, hangQuote, { cfg: CFG, now: NOW_FRI });
  assert.equal(placed.error, null);
  assert.equal(placed.fill, null);
  assert.equal(placed.order.status, 'open');
  assert.equal(account.cash.CNY, 1000000);
  assert.equal(account.orders.filter((order) => order.status === 'open').length, 1);

  const tick = tickAccount(account, { 'cn:sh600519': cnQuote({ price: 99.5, ask: [{ price: 99.49, size: 100 }], bid: [{ price: 99.48, size: 100 }] }) }, { cfg: CFG, now: '2026-10-23T10:00:02+08:00' });
  assert.equal(tick.fills.length, 1);
  assert.equal(tick.fills[0].price, 99.5); // min(limit 100, quote 99.5)
  assert.equal(tick.fills[0].fees, 5.1);
  assert.equal(tick.orderUpdates.length, 1);
  assert.equal(tick.orderUpdates[0].status, 'filled');
  assert.equal(tick.orderUpdates[0].avgFillPrice, 99.5);
  assert.equal(account.cash.CNY, 990044.9);
  assert.equal(account.positions['cn:sh600519'].qty, 100);
});

test('limit order that never crosses stays open', () => {
  const account = makeAccount();
  placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 95 }, cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  const tick = tickAccount(account, { 'cn:sh600519': cnQuote({ price: 101 }) }, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(tick.fills, []);
  assert.deepEqual(tick.orderUpdates, []);
  assert.equal(account.orders.at(-1).status, 'open');

  // Sell limit needs quote.price >= limit.
  placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  const sellHang = placeOrder(account, { symbol: 'cn:sh600519', side: 'sell', type: 'limit', qty: 100, limitPrice: 110 }, cnQuote({ price: 100 }), { cfg: CFG, now: NOW_FRI });
  assert.equal(sellHang.order.status, 'open');
  const sellTick = tickAccount(account, { 'cn:sh600519': cnQuote({ price: 109 }) }, { cfg: CFG, now: NOW_MON });
  assert.deepEqual(sellTick.fills, []);
  assert.equal(account.orders.at(-1).status, 'open');
});

test('limit fills are never worse than the limit price', () => {
  const buyAccount = makeAccount();
  const buy = placeOrder(buyAccount, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 100.1 },
    cnQuote({ price: 100.05, ask: [{ price: 100.05, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(buy.error, null);
  assert.equal(buy.order.status, 'filled');
  assert.equal(buy.fill.price, 100.06); // min(limit, 100.05 * 1.0001)
  assert.ok(buy.fill.price <= 100.1);

  const sellAccount = makeAccount();
  placeOrder(sellAccount, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  rollDay(sellAccount, NOW_MON); // unlock the T+1 position
  const sell = placeOrder(sellAccount, { symbol: 'cn:sh600519', side: 'sell', type: 'limit', qty: 100, limitPrice: 99.9 },
    cnQuote({ price: 99.95, bid: [{ price: 99.95, size: 100 }] }), { cfg: CFG, now: NOW_MON });
  assert.equal(sell.error, null);
  assert.equal(sell.fill.price, 99.94); // max(limit, 99.95 * 0.9999)
  assert.ok(sell.fill.price >= 99.9);
});

test('tickAccount rejects parked orders when cash or position disappeared', () => {
  const cashAccount = makeAccount({ initialCapital: 2000 });
  placeOrder(cashAccount, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 100 },
    cnQuote({ price: 100.5, ask: [{ price: 100.51, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  const cashTick = tickAccount(cashAccount, { 'cn:sh600519': cnQuote({ price: 99 }) }, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(cashTick.fills, []);
  assert.equal(cashTick.orderUpdates.length, 1);
  assert.equal(cashTick.orderUpdates[0].status, 'rejected');
  assert.equal(cashTick.orderUpdates[0].rejectCode, 'INSUFFICIENT_CASH');

  const cryptoAccount = makeAccount({ baseCurrency: 'USDT', initialCapital: 100000 });
  placeOrder(cryptoAccount, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'limit', qty: 0.1, limitPrice: 70000 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  const positionTick = tickAccount(cryptoAccount, { 'crypto:BTCUSDT': cryptoQuote({ price: 71000 }) }, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(positionTick.fills, []);
  assert.equal(positionTick.orderUpdates[0].rejectCode, 'INSUFFICIENT_POSITION');
});

test('tickAccount never fills a limit order while its market is closed', () => {
  const account = makeAccount();
  const placed = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 100 },
    cnQuote({ price: 100.5, ask: [{ price: 100.51, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(placed.order.status, 'open');

  // Saturday: the (stale) quote crosses the limit, but the market is closed.
  const weekend = tickAccount(account, { 'cn:sh600519': cnQuote({ price: 90 }) }, { cfg: CFG, now: NOW_SAT });
  assert.deepEqual(weekend.fills, []);
  assert.deepEqual(weekend.orderUpdates, []);
  assert.equal(account.orders.at(-1).status, 'open');
  assert.equal(account.cash.CNY, 1000000);
  assert.equal(account.positions['cn:sh600519'], undefined);

  // Monday open: the same parked order executes.
  const monday = tickAccount(account, { 'cn:sh600519': cnQuote({ price: 90 }) }, { cfg: CFG, now: NOW_MON });
  assert.equal(monday.fills.length, 1);
  assert.equal(monday.fills[0].price, 90);
  assert.equal(account.orders.at(-1).status, 'filled');
});

test('crypto limit orders keep matching overnight and at weekends', () => {
  const account = makeAccount({ baseCurrency: 'USDT', initialCapital: 100000 });
  const sundayNight = '2026-10-25T03:00:00+08:00'; // Sunday 03:00 Asia/Shanghai
  const placed = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, limitPrice: 59000 },
    cryptoQuote({ price: 60000 }), { cfg: CFG, now: sundayNight });
  assert.equal(placed.order.status, 'open');

  const tick = tickAccount(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 58000 }) }, { cfg: CFG, now: '2026-10-25T03:00:02+08:00' });
  assert.equal(tick.fills.length, 1);
  assert.equal(tick.fills[0].price, 58000); // min(limit 59000, quote 58000)
  assert.equal(account.positions['crypto:BTCUSDT'].qty, 0.1);
  assert.equal(account.cash.USDT, 94194.2); // 100000 - 5800 - 5.8
});

test('a buy converts the base currency when the target currency is short (§6.6)', () => {
  const account = makeAccount({ initialCapital: 1000000 }); // CNY base, no USD
  const rates = { CNY: 1, USD: 7.2, HKD: 0.9, USDT: 7.2 };
  const result = placeOrder(account, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1 },
    usQuote({ ask: [{ price: 200.01, size: 10 }], bid: [{ price: 199.99, size: 10 }] }), { cfg: CFG, now: NOW_US_THU, fxRates: rates });

  assert.equal(result.error, null);
  assert.equal(result.fill.price, 200.03);
  assert.equal(result.fill.fees, 1);
  assert.equal(account.positions['us:usAAPL'].qty, 1);
  // 201.03 USD needed, converted at 7.2 with the default 0.3% conversion spread.
  assert.equal(account.conversions.length, 1);
  const conversion = account.conversions[0];
  assert.equal(conversion.from, 'CNY');
  assert.equal(conversion.to, 'USD');
  assert.equal(conversion.amountTo, 201.03);
  assert.equal(conversion.amountFrom, 1451.76); // 201.03 * 7.2 * 1.003
  assert.equal(conversion.rate, 7.2);
  assert.equal(conversion.reason, result.order.id);
  assert.equal(account.cash.CNY, 998548.24);
  assert.equal(account.cash.USD, 0); // exactly funded
  const view = portfolioView(account, {}, rates, NOW_US_THU);
  assert.equal(view.conversions.length, 1);

  // The base currency does not cover the conversion -> still INSUFFICIENT_CASH.
  const poor = makeAccount({ initialCapital: 100 });
  const rejected = placeOrder(poor, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1 },
    usQuote({ ask: [{ price: 200.01, size: 10 }] }), { cfg: CFG, now: NOW_US_THU, fxRates: rates });
  expectError(rejected, 'INSUFFICIENT_CASH');
  assert.equal(poor.conversions.length, 0);
  assert.equal(poor.cash.CNY, 100);

  // Without fxRates the behaviour is unchanged: no conversion, plain rejection.
  const noRates = makeAccount({ initialCapital: 1000000 });
  const noRatesResult = placeOrder(noRates, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1 },
    usQuote({ ask: [{ price: 200.01, size: 10 }] }), { cfg: CFG, now: NOW_US_THU });
  expectError(noRatesResult, 'INSUFFICIENT_CASH');
  assert.equal(noRates.conversions.length, 0);
  assert.equal(noRates.cash.CNY, 1000000);

  // cfg.autoConvert === false disables the feature even when fxRates are supplied.
  const disabled = makeAccount({ initialCapital: 1000000 });
  const disabledResult = placeOrder(disabled, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1 },
    usQuote({ ask: [{ price: 200.01, size: 10 }] }), { cfg: { ...CFG, autoConvert: false }, now: NOW_US_THU, fxRates: rates });
  expectError(disabledResult, 'INSUFFICIENT_CASH');
  assert.equal(disabled.conversions.length, 0);

  // validateOrder plans the conversion but must never mutate the account.
  const probe = makeAccount({ initialCapital: 1000000 });
  const before = JSON.stringify(probe);
  assert.equal(validateOrder(probe, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1 },
    usQuote({ ask: [{ price: 200.01, size: 10 }] }), { cfg: CFG, now: NOW_US_THU, fxRates: rates }).ok, true);
  assert.equal(JSON.stringify(probe), before);
});

test('tickAccount also converts for a parked limit order (§6.6)', () => {
  const account = makeAccount({ initialCapital: 1000000 }); // CNY base, no HKD
  const rates = { CNY: 1, USD: 7.2, HKD: 0.9, USDT: 7.2 };
  const placed = placeOrder(account, { symbol: 'hk:hk00700', side: 'buy', type: 'limit', qty: 100, limitPrice: 290 },
    hkQuote({ price: 295, ask: [{ price: 295.1, size: 100 }] }), { cfg: CFG, now: NOW_FRI, fxRates: rates });
  assert.equal(placed.order.status, 'open');
  assert.equal(account.conversions.length, 0); // nothing converted until execution

  const tick = tickAccount(account, { 'hk:hk00700': hkQuote({ price: 290 }) }, { cfg: CFG, now: NOW_FRI, fxRates: rates });
  assert.equal(tick.fills.length, 1);
  assert.equal(tick.fills[0].price, 290);
  assert.equal(account.conversions.length, 1);
  assert.equal(account.conversions[0].to, 'HKD');
  assert.equal(account.positions['hk:hk00700'].qty, 100);
  // 100 * 290 + 131.22 fees = 29131.22 HKD -> 29131.22 * 0.9 * 1.003 CNY
  assert.equal(account.conversions[0].amountTo, 29131.22);
  assert.equal(account.conversions[0].amountFrom, 26296.75);
  assert.equal(account.cash.CNY, 973703.25);
});

// ---------------------------------------------------------------------------
// funding / validation errors
// ---------------------------------------------------------------------------

test('insufficient cash and position are reported with contract codes', () => {
  const poor = makeAccount({ initialCapital: 1000 });
  expectValidation(poor, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), 'INSUFFICIENT_CASH');
  const result = placeOrder(poor, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  expectError(result, 'INSUFFICIENT_CASH');
  assert.equal(poor.cash.CNY, 1000);
  assert.equal(poor.positions['cn:sh600519'], undefined);

  const empty = makeAccount();
  expectValidation(empty, { symbol: 'us:usAAPL', side: 'sell', type: 'market', qty: 1 }, usQuote(), 'INSUFFICIENT_POSITION', NOW_US_THU);
  expectValidation(empty, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100 }, cnQuote(), 'INSUFFICIENT_POSITION');
});

test('invalid symbols, quantities and order types are rejected', () => {
  const account = makeAccount();
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, null, 'SYMBOL_INVALID');
  expectValidation(account, { symbol: 'zz:foo', side: 'buy', type: 'market', qty: 100 }, cnQuote(), 'SYMBOL_INVALID');
  expectValidation(account, { symbol: 'hk:hk00700', side: 'buy', type: 'market', qty: 100 }, cnQuote(), 'SYMBOL_INVALID');
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 0 }, cnQuote(), 'QTY_INVALID');
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: -100 }, cnQuote(), 'QTY_INVALID');
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100 }, cnQuote(), 'PRICE_INVALID');
  expectValidation(account, { symbol: 'cn:sh600519', side: 'hold', type: 'market', qty: 100 }, cnQuote(), 'PRICE_INVALID');
  expectValidation(account, { symbol: 'cn:sh600519', side: 'buy', type: 'stop', qty: 100 }, cnQuote(), 'PRICE_INVALID');
  assert.deepEqual(validateOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote(), { cfg: CFG, now: NOW_FRI }), { ok: true });
});

// ---------------------------------------------------------------------------
// portfolio valuation & day roll
// ---------------------------------------------------------------------------

test('portfolioView folds multi-currency cash and positions into CNY', () => {
  const account = makeAccount({ initialCapital: 100000 });
  account.cash = { CNY: 100000, HKD: 50000, USD: 10000, USDT: 0 };
  // Positions opened on a previous day (overnight) so todayPnl is measured from
  // prevClose; the intraday-basis rule is covered by dedicated tests below.
  const OVERNIGHT_OPENED_AT = '2026-10-22T09:30:00+08:00';
  account.positions = {
    'cn:sh600519': { symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', currency: 'CNY', qty: 100, avgCost: 100, todayBuyQty: 0, todayBuyDate: null, openedAt: OVERNIGHT_OPENED_AT },
    'hk:hk00700': { symbol: 'hk:hk00700', market: 'hk', name: '腾讯控股', currency: 'HKD', qty: 100, avgCost: 300, todayBuyQty: 0, todayBuyDate: null, openedAt: OVERNIGHT_OPENED_AT },
    'us:usAAPL': { symbol: 'us:usAAPL', market: 'us', name: '苹果', currency: 'USD', qty: 10, avgCost: 200, todayBuyQty: 0, todayBuyDate: null, openedAt: OVERNIGHT_OPENED_AT },
    'crypto:BTCUSDT': { symbol: 'crypto:BTCUSDT', market: 'crypto', name: '比特币', currency: 'USDT', qty: 0.1, avgCost: 60000, todayBuyQty: 0, todayBuyDate: null, openedAt: OVERNIGHT_OPENED_AT }
  };
  account.dayStartEquity = 300000;
  const quotes = {
    'cn:sh600519': cnQuote({ price: 110, prevClose: 105 }),
    'hk:hk00700': hkQuote({ price: 320, prevClose: 310 }),
    'us:usAAPL': usQuote({ price: 210, prevClose: 205 }),
    'crypto:BTCUSDT': cryptoQuote({ price: 61000, prevClose: 60000 })
  };
  const view = portfolioView(account, quotes, { CNY: 1, USD: 7.2, HKD: 0.9, USDT: 7.2 }, NOW_FRI);

  assert.deepEqual(view.cash, { CNY: 100000, HKD: 50000, USD: 10000, USDT: 0 });
  assert.deepEqual(view.equity.byMarket, { cn: 11000, hk: 28800, us: 15120, fx: 0, crypto: 43920 });
  assert.equal(view.equity.total, 315840);
  assert.equal(view.dayStartEquity, 300000);
  assert.equal(view.todayPnl, 15840);
  assert.equal(view.totalPnl, 215840);
  assert.equal(view.totalPnlPct, 215.84);
  assert.equal(view.positions.length, 4);

  const cnPosition = view.positions.find((position) => position.symbol === 'cn:sh600519');
  assert.equal(cnPosition.marketValue, 11000);
  assert.equal(cnPosition.availableQty, 100);
  assert.equal(cnPosition.unrealizedPnl, 1000);
  assert.equal(cnPosition.unrealizedPnlPct, 10);
  assert.equal(cnPosition.todayPnl, 500);

  const cryptoPosition = view.positions.find((position) => position.symbol === 'crypto:BTCUSDT');
  assert.equal(cryptoPosition.currency, 'USDT');
  assert.equal(round2(cryptoPosition.todayPnl), 100);
});

test('portfolioView reports open orders and defaults missing quotes to cost', () => {
  const account = makeAccount();
  const placement = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 90 },
    cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(placement.order.status, 'open');

  const view = portfolioView(account, {}, {}, NOW_FRI);
  assert.equal(view.equity.total, 1000000);
  assert.equal(view.openOrders.length, 1);
  assert.equal(view.openOrders[0].id, placement.order.id);
  assert.deepEqual(view.positions, []);
  assert.equal(view.todayPnl, 0);
  assert.equal(view.fxRates.CNY, 1);
});

test('rollDay resets T+1 markers and snapshots the daily equity baseline', () => {
  const account = makeAccount();
  placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(account.positions['cn:sh600519'].todayBuyQty, 100);

  assert.equal(rollDay(account, NOW_FRI), false); // same day, nothing to do
  assert.equal(rollDay(account, NOW_MON, 1012345.6), true);
  assert.equal(account.dayKey, '2026-10-26');
  assert.equal(account.dayStartEquity, 1012345.6);
  assert.equal(account.positions['cn:sh600519'].todayBuyQty, 0);
  assert.equal(account.positions['cn:sh600519'].todayBuyDate, '2026-10-26');
  assert.equal(rollDay(account, '2026-10-26T15:00:00+08:00'), false);

  // Without an explicit snapshot the last equityHistory point is used.
  account.equityHistory.push({ t: '2026-10-26T15:00:00+08:00', equity: 987654 });
  assert.equal(rollDay(account, '2026-10-27T09:00:00+08:00'), true);
  assert.equal(account.dayStartEquity, 987654);
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('store writes state atomically and loads it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimatrader-store-'));
  try {
    const store = createStore({ dataDir: dir, watchlist: CFG.defaults.watchlist });
    const state = store.load();
    assert.deepEqual(state.accounts, {}, 'default state must not create accounts');
    assert.deepEqual(store.getWatchlist(), CFG.defaults.watchlist);
    assert.deepEqual(store.listAlerts(), []);
    assert.ok(fs.existsSync(path.join(dir, 'state.json')));

    const account = makeAccount({ id: 'acc_store', initialCapital: 50000 });
    store.addAccount(account);
    placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
    store.replaceAccount(account);

    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['state.json'], 'atomic write must not leave temp files');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.accounts.acc_store.cash.CNY, 39992.9); // 50000 - 10002 - 5.1

    const reloaded = createStore({ dataDir: dir });
    const loaded = reloaded.load();
    assert.equal(loaded.accounts.acc_store.positions['cn:sh600519'].qty, 100);
    assert.equal(loaded.accounts.acc_store.trades.length, 1);
    assert.equal(reloaded.getAccount('acc_store').initialCapital, 50000);
    assert.equal(reloaded.listAccounts().length, 1);
    assert.deepEqual(reloaded.getWatchlist(), CFG.defaults.watchlist);

    // watchlist / alerts
    assert.deepEqual(reloaded.setWatchlist(['us:usAAPL']), ['us:usAAPL']);
    const alert = reloaded.addAlert({ symbol: 'cn:sh600519', direction: 'above', price: 1500 });
    assert.match(alert.id, /^alert_/);
    assert.equal(reloaded.listAlerts().length, 1);
    assert.equal(reloaded.removeAlert(alert.id), true);
    assert.equal(reloaded.removeAlert('missing'), false);
    assert.deepEqual(createStore({ dataDir: dir }).load().watchlist, ['us:usAAPL']);

    // nextId uniqueness
    const ids = new Set(Array.from({ length: 50 }, () => reloaded.nextId('ord')));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^ord_[0-9a-f]{6}$/);

    // removal
    assert.equal(reloaded.removeAccount('acc_store'), true);
    assert.equal(reloaded.removeAccount('acc_store'), false);
    assert.equal(reloaded.getAccount('acc_store'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store recovers from a corrupt state file and flushes debounced saves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimatrader-store-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '{ not valid json', 'utf8');
    const store = createStore({ dataDir: dir, watchlist: ['cn:sh600519'] });
    const state = store.load();
    assert.deepEqual(state.accounts, {});
    assert.deepEqual(store.getWatchlist(), ['cn:sh600519']);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('state.corrupt-'));
    assert.equal(backups.length, 1, 'corrupt state must be kept as a backup');

    // The default state is persisted immediately after recovery.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(raw.version, 1);

    // Debounced save: mutate the in-memory state, then wait for the timer.
    store.state.accounts.acc_debounced = makeAccount({ id: 'acc_debounced' });
    store.saveDebounced(10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const rawAfter = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.ok(rawAfter.accounts.acc_debounced, 'debounced save must reach disk');

    // flush() writes a pending timer right away.
    store.state.watchlist = ['us:usAAPL'];
    store.saveDebounced(5000);
    store.flush();
    const rawFlushed = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(rawFlushed.watchlist, ['us:usAAPL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function statsAccount() {
  return {
    trades: [
      { id: 't1', orderId: 'o1', symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', side: 'buy', qty: 100, price: 100, fees: 5.1, realizedPnl: 0, t: '2026-10-20T10:00:00+08:00' },
      { id: 't2', orderId: 'o2', symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', side: 'sell', qty: 100, price: 110, fees: 10.1, realizedPnl: 100, t: '2026-10-21T10:00:00+08:00' },
      { id: 't3', orderId: 'o3', symbol: 'us:usAAPL', market: 'us', name: '苹果', side: 'sell', qty: 1, price: 200, fees: 2, realizedPnl: -50, t: '2026-10-22T10:00:00+08:00' },
      { id: 't4', orderId: 'o4', symbol: 'us:usAAPL', market: 'us', name: '苹果', side: 'sell', qty: 1, price: 190, fees: 3, realizedPnl: 30, t: '2026-10-22T11:00:00+08:00' }
    ],
    equityHistory: [
      { t: '2026-10-01T15:00:00+08:00', equity: 100000 },
      { t: '2026-10-02T15:00:00+08:00', equity: 110000 },
      { t: '2026-10-03T15:00:00+08:00', equity: 105000 },
      { t: '2026-10-04T15:00:00+08:00', equity: 120000 },
      { t: '2026-10-05T15:00:00+08:00', equity: 90000 }
    ]
  };
}

test('computeStats derives win rate, profit factor, fees and per-market buckets', () => {
  const stats = computeStats(statsAccount());
  assert.equal(stats.tradeCount, 4);
  assert.equal(stats.winCount, 2);
  assert.equal(stats.lossCount, 1);
  assert.equal(stats.winRate, 0.6667); // fraction in [0,1]; the UI renders it as a percentage
  assert.equal(stats.profitFactor, 2.6); // 130 / 50
  assert.equal(stats.avgWin, 65); // (100 + 30) / 2
  assert.equal(stats.avgLoss, 50);
  assert.equal(stats.totalFees, 20.2);
  assert.equal(stats.realizedPnl, 80);

  // byMarket is an object keyed by market (§7 / mock.js shape).
  assert.deepEqual(Object.keys(stats.byMarket).sort(), ['cn', 'us']);
  const cn = stats.byMarket.cn;
  assert.equal(cn.market, 'cn');
  assert.equal(cn.tradeCount, 2);
  assert.equal(cn.realizedPnl, 100);
  assert.equal(cn.fees, 15.2);
  assert.equal(cn.winRate, 1);
  const us = stats.byMarket.us;
  assert.equal(us.realizedPnl, -20);
  assert.equal(us.winRate, 0.5);

  // The same rows are also exposed as a sorted array for convenience.
  assert.equal(stats.byMarketList[0].market, 'cn');

  assert.equal(stats.bySymbol[0].symbol, 'cn:sh600519');
  assert.equal(stats.bySymbol[0].realizedPnl, 100);
  assert.equal(stats.bySymbol[1].symbol, 'us:usAAPL');
  assert.equal(stats.bySymbol[1].tradeCount, 2);
});

test('computeStats reports max drawdown and sharpe, null when data is insufficient', () => {
  const stats = computeStats(statsAccount());
  assert.equal(stats.maxDrawdown, 25); // 120000 -> 90000
  assert.ok(Number.isFinite(stats.sharpe));
  assert.ok(stats.sharpe < 0);

  const flat = { trades: [], equityHistory: [
    { t: '2026-10-01T15:00:00+08:00', equity: 100000 },
    { t: '2026-10-02T15:00:00+08:00', equity: 100000 },
    { t: '2026-10-03T15:00:00+08:00', equity: 100000 }
  ] };
  const flatStats = computeStats(flat);
  assert.equal(flatStats.sharpe, null); // no dispersion
  assert.equal(flatStats.maxDrawdown, 0);
  assert.equal(flatStats.winRate, null);
  assert.equal(flatStats.profitFactor, null);
  assert.equal(flatStats.tradeCount, 0);

  const short = { trades: [], equityHistory: [
    { t: '2026-10-01T15:00:00+08:00', equity: 100000 },
    { t: '2026-10-02T15:00:00+08:00', equity: 101000 }
  ] };
  assert.equal(computeStats(short).sharpe, null); // one return only
  assert.equal(computeStats({}).maxDrawdown, 0);
});

test('equitySeries filters equityHistory by range and now', () => {
  const account = {
    equityHistory: [
      { t: '2026-10-01T15:00:00+08:00', equity: 100000 },
      { t: '2026-10-20T15:00:00+08:00', equity: 105000 },
      { t: '2026-10-23T09:30:00+08:00', equity: 108000 },
      { t: '2026-10-23T10:30:00+08:00', equity: 109000 } // after `now`, must be filtered out
    ]
  };
  const now = '2026-10-23T10:00:00+08:00';
  assert.deepEqual(equitySeries(account, 'all', now).map((point) => point.equity), [100000, 105000, 108000]);
  assert.deepEqual(equitySeries(account, '1d', now).map((point) => point.equity), [108000]);
  assert.deepEqual(equitySeries(account, '1w', now).map((point) => point.equity), [105000, 108000]);
  assert.deepEqual(equitySeries(account, '1m', now).map((point) => point.equity), [100000, 105000, 108000]);
  assert.deepEqual(equitySeries({ equityHistory: [] }, 'all', now), []);
  assert.deepEqual(equitySeries(account, 'bogus', now).map((point) => point.equity), [100000, 105000, 108000]);
});

// ===========================================================================
// v2: leverage / margin / short selling (§6A)
// ===========================================================================

const NOW_12H = '2026-10-23T22:00:00+08:00'; // 12h after NOW_FRI
const NOW_24H = '2026-10-24T10:00:00+08:00'; // 24h after NOW_FRI

test('createAccount seeds the v2 margin fields and honours marginMode', () => {
  const account = makeAccount();
  assert.equal(account.marginMode, 'isolated');
  assert.equal(account.totalInterest, 0);
  assert.deepEqual(account.liquidations, []);
  assert.deepEqual(account.conversions, []);
  const cross = createAccount({ id: 'acc_cross', name: '全仓', initialCapital: 1000, marginMode: 'cross' }, { now: NOW_FRI });
  assert.equal(cross.marginMode, 'cross');
  assert.equal(createAccount({ id: 'acc_x', name: 'x', initialCapital: 1 }, { now: NOW_FRI }).marginMode, 'isolated');
});

test('crypto 10x long opens with margin/debt and exposes a liquidation price', () => {
  const account = leveragedAccount();
  const result = openCrypto10x(account);
  assert.equal(result.fill.price, 60018); // 60000 * (1 + 3bp)
  assert.equal(result.fill.fees, 6); // 6001.8 * 0.1%
  assert.equal(account.cash.USDT, 99393.82); // margin 600.18 + fee 6 deducted
  const position = account.positions['crypto:BTCUSDT'];
  assert.equal(position.side, 'long');
  assert.equal(position.qty, 0.1);
  assert.equal(position.avgCost, 60018);
  assert.equal(position.leverage, 10);
  assert.equal(position.margin, 600.18); // notional / leverage
  assert.equal(position.debt, 5401.62); // notional - margin
  assert.equal(position.accruedInterest, 0);
  assert.equal(result.fill.leverage, 10);
  assert.equal(result.fill.reason, 'OPEN');

  const view = portfolioView(account, { 'crypto:BTCUSDT': cryptoQuote() }, RATES_ONE, NOW_FRI, CFG);
  assert.equal(view.equity.total, 99992.2); // cash + margin - slippage loss
  assert.equal(view.marginUsed, 600.18);
  assert.equal(view.maintenanceMargin, 30); // 0.1 * 60000 * 0.005
  assert.equal(view.marginAvailable, 99392.02);
  assert.equal(view.riskRatio, 0.0501); // 30 / 598.38
  const positionView = view.positions[0];
  assert.equal(positionView.side, 'long');
  assert.equal(positionView.leverage, 10);
  assert.equal(positionView.margin, 600.18);
  assert.equal(positionView.maintenanceMargin, 30);
  assert.equal(positionView.riskRatio, 0.0501);
  assert.equal(positionView.unrealizedPnl, -1.8);
  // liqPrice = (avgCost*qty - margin) / (qty*(1-mmr))
  const expectedLiq = (60018 * 0.1 - 600.18) / (0.1 * 0.995);
  assert.ok(Math.abs(positionView.liqPrice - expectedLiq) < 0.02, `liqPrice ${positionView.liqPrice} vs ${expectedLiq}`);
  assert.equal(view.totalInterest, 0);
  assert.deepEqual(view.liquidations, []);
});

test('crypto 10x short opens a short position with borrowed debt', () => {
  const account = leveragedAccount();
  const result = openCrypto10x(account, {}, { side: 'sell' });
  assert.equal(result.fill.price, 59982); // 60000 * (1 - 3bp)
  assert.equal(result.fill.fees, 6);
  assert.equal(account.cash.USDT, 99394.18);
  const position = account.positions['crypto:BTCUSDT'];
  assert.equal(position.side, 'short');
  assert.equal(position.margin, 599.82);
  assert.equal(position.debt, 5398.38);

  const view = portfolioView(account, { 'crypto:BTCUSDT': cryptoQuote() }, RATES_ONE, NOW_FRI, CFG);
  const positionView = view.positions[0];
  assert.equal(positionView.side, 'short');
  assert.equal(positionView.unrealizedPnl, -1.8); // (59982 - 60000) * 0.1
  // opened today, so todayPnl uses the entry price (equals the unrealised PnL)
  assert.equal(positionView.todayPnl, -1.8);
  const expectedLiq = (59982 * 0.1 + 599.82) / (0.1 * 1.005);
  assert.ok(Math.abs(positionView.liqPrice - expectedLiq) < 0.02);
});

test('borrowed debt accrues hourly interest over 24h', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const added = accrueInterest(account, NOW_24H);
  const expected = 5401.62 * 0.08 / 8760 * 24; // debt * annual / hoursPerYear * hours
  assert.ok(Math.abs(added - expected) < 1e-6, `interest ${added} vs ${expected}`);
  assert.ok(Math.abs(account.positions['crypto:BTCUSDT'].accruedInterest - expected) < 1e-6);
  assert.ok(Math.abs(account.totalInterest - expected) < 1e-6);
  // A second accrual for the same instant must not double charge.
  assert.equal(accrueInterest(account, NOW_24H), 0);

  const view = portfolioView(account, { 'crypto:BTCUSDT': cryptoQuote() }, RATES_ONE, NOW_24H, CFG);
  assert.equal(view.equity.total, 99991.02); // equity is reduced by the accrued interest
  assert.equal(view.positions[0].accruedInterest, account.positions['crypto:BTCUSDT'].accruedInterest);
  assert.equal(view.accruedInterest, 1.18); // account-level, rounded to fen
});

test('isolated margin call liquidates a position below its liquidation price', () => {
  const account = leveragedAccount();
  openCrypto10x(account);

  const risk = checkRisk(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 54200 }) }, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.equal(risk.liquidations.length, 1);
  assert.equal(risk.liquidations[0].reason, 'LIQUIDATION');
  assert.equal(risk.liquidations[0].symbol, 'crypto:BTCUSDT');
  assert.equal(risk.liquidations[0].price, 54183.74); // 54200 * (1 - 3bp) slippage
  assert.equal(risk.liquidations[0].pnl, -615.94); // closes at a loss incl. fees + liquidation fee
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
  assert.equal(account.cash.USDT, 99378.06);
  assert.equal(account.liquidations.length, 1);
  assert.equal(account.liquidations[0].reason, 'LIQUIDATION');
  const liquidationTrade = account.trades.at(-1);
  assert.equal(liquidationTrade.reason, 'LIQUIDATION');
  assert.equal(liquidationTrade.realizedPnl, -615.94);
  // the forced exit is also recorded as an order with reason LIQUIDATION
  assert.equal(account.orders.at(-1).reason, 'LIQUIDATION');
  assert.equal(account.orders.at(-1).status, 'filled');
  assert.equal(portfolioView(account, {}, RATES_ONE, NOW_FRI, CFG).equity.total, 99378.06);
});

test('risk warning fires above 0.8 without liquidating', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const risk = checkRisk(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 54300 }) }, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(risk.liquidations, []);
  assert.equal(risk.warnings.length, 1);
  assert.equal(risk.warnings[0].code, 'RISK_HIGH');
  assert.equal(risk.warnings[0].symbol, 'crypto:BTCUSDT');
  assert.ok(risk.warnings[0].riskRatio > 0.8);
  assert.match(risk.warnings[0].message, /接近强平/);
  assert.ok(account.positions['crypto:BTCUSDT'], 'position must survive a warning');
  // 27.15 / 28.38 = 0.9566...
  assert.equal(risk.warnings[0].riskRatio, 0.9567);
});

test('cross margin liquidates the biggest loser first until equity covers maintenance', () => {
  const account = leveragedAccount({ initialCapital: 1000, marginMode: 'cross' });
  account.positions['crypto:BTCUSDT'] = {
    symbol: 'crypto:BTCUSDT', market: 'crypto', name: '比特币', currency: 'USDT', side: 'long',
    qty: 1, avgCost: 60000, leverage: 10, margin: 6000, debt: 54000,
    accruedInterest: 0, interestAnnual: 0, lastInterestAt: NOW_FRI, takeProfit: null, stopLoss: null,
    openedAt: NOW_FRI, todayBuyQty: 0, todayBuyDate: null
  };
  account.positions['crypto:ETHUSDT'] = {
    symbol: 'crypto:ETHUSDT', market: 'crypto', name: '以太坊', currency: 'USDT', side: 'long',
    qty: 10, avgCost: 3000, leverage: 10, margin: 3000, debt: 27000,
    accruedInterest: 0, interestAnnual: 0, lastInterestAt: NOW_FRI, takeProfit: null, stopLoss: null,
    openedAt: NOW_FRI, todayBuyQty: 0, todayBuyDate: null
  };
  const quotes = { 'crypto:BTCUSDT': cryptoQuote({ price: 51000 }), 'crypto:ETHUSDT': ethQuote({ price: 2900 }) };
  const risk = checkRisk(account, quotes, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.equal(risk.liquidations.length, 2);
  assert.equal(risk.liquidations[0].symbol, 'crypto:BTCUSDT'); // biggest unrealised loss first
  assert.equal(risk.liquidations[1].symbol, 'crypto:ETHUSDT');
  assert.deepEqual(Object.keys(account.positions), []);
  assert.equal(account.cash.USDT, -503.85); // forced exits couldn't cover the debt
  assert.equal(account.liquidations.length, 2);
});

test('cross margin warns when the account risk ratio is high', () => {
  const account = leveragedAccount({ initialCapital: 10000, marginMode: 'cross' });
  account.positions['crypto:BTCUSDT'] = {
    symbol: 'crypto:BTCUSDT', market: 'crypto', name: '比特币', currency: 'USDT', side: 'long',
    qty: 1, avgCost: 60000, leverage: 10, margin: 6000, debt: 54000,
    accruedInterest: 0, interestAnnual: 0, lastInterestAt: NOW_FRI, takeProfit: null, stopLoss: null,
    openedAt: NOW_FRI, todayBuyQty: 0, todayBuyDate: null
  };
  const risk = checkRisk(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 44250 }) }, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(risk.liquidations, []);
  assert.equal(risk.warnings.length, 1);
  assert.equal(risk.warnings[0].code, 'RISK_HIGH');
  assert.equal(risk.warnings[0].symbol, null); // account level
  // equity = 10000 + 6000 - 15750 = 250, maintenance = 221.25 -> 0.885
  assert.equal(risk.warnings[0].riskRatio, 0.885);
  assert.ok(account.positions['crypto:BTCUSDT']);
});

test('take profit closes a leveraged long', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  assert.equal(setProtect(account, 'crypto:BTCUSDT', { takeProfit: 62000, stopLoss: 57000 }, cryptoQuote(), CFG).ok, true);
  assert.equal(account.positions['crypto:BTCUSDT'].takeProfit, 62000);
  assert.equal(account.positions['crypto:BTCUSDT'].stopLoss, 57000);

  const risk = checkRisk(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 62000 }) }, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(risk.liquidations, []);
  assert.equal(risk.triggered.length, 1);
  assert.equal(risk.triggered[0].reason, 'TAKE_PROFIT');
  assert.equal(risk.triggered[0].price, 61981.4); // 62000 * (1 - 3bp)
  assert.equal(risk.triggered[0].pnl, 190.14);
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
  assert.equal(account.cash.USDT, 100184.14);
  assert.equal(account.liquidations.at(-1).reason, 'TAKE_PROFIT');
});

test('stop loss closes a leveraged short', () => {
  const account = leveragedAccount();
  openCrypto10x(account, {}, { side: 'sell' });
  assert.equal(setProtect(account, 'crypto:BTCUSDT', { takeProfit: 58000, stopLoss: 61000 }, cryptoQuote(), CFG).ok, true);
  const risk = checkRisk(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 61500 }) }, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.equal(risk.triggered.length, 1);
  assert.equal(risk.triggered[0].reason, 'STOP_LOSS');
  assert.equal(risk.triggered[0].price, 61518.45); // 61500 * (1 + 3bp)
  assert.equal(risk.triggered[0].pnl, -159.8);
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
  assert.equal(account.cash.USDT, 99834.21);
});

test('partial close releases proportional margin/debt and keeps the rest', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const close = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.04, close: true }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(close.error, null);
  assert.equal(close.fill.price, 59982);
  assert.equal(close.fill.realizedPnl, -3.84); // (59982-60018)*0.04 - 2.4 fees
  assert.equal(account.cash.USDT, 99630.05);
  const position = account.positions['crypto:BTCUSDT'];
  assert.equal(position.qty, 0.06);
  assert.equal(position.margin, 360.11); // 600.18 * 60%
  assert.equal(position.debt, 3240.97);
  assert.equal(position.avgCost, 60018); // average cost unchanged when reducing
});

test('close with qty omitted closes the whole position and pays accrued interest', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const interest = accrueInterest(account, NOW_12H);
  assert.ok(interest > 0);
  const close = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', close: true }, cryptoQuote(), { cfg: CFG, now: NOW_12H });
  assert.equal(close.error, null);
  assert.equal(close.order.qty, 0.1); // defaults to the full position
  assert.equal(close.fill.interest, 0.59195836);
  assert.equal(close.fill.realizedPnl, -10.19); // gross -3.6 - fees 6 - interest
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
  assert.equal(account.cash.USDT, 99983.81);

  // closing more than the position is rejected
  const again = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.1, close: true }, cryptoQuote(), { cfg: CFG, now: NOW_12H });
  assert.equal(again.error.code, 'INSUFFICIENT_POSITION');
});

test('a close can be followed by an opposite open (position reverse)', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const close = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', close: true }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(close.error, null);
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);

  const short = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(short.error, null);
  assert.equal(account.positions['crypto:BTCUSDT'].side, 'short');

  const cover = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', close: true }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(cover.error, null);
  assert.equal(cover.fill.realizedPnl, -9.6); // (59982 - 60018) * 0.1 - 6 fees
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
});

test('tickAccount fills a parked close limit order', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const hang = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'limit', qty: 0.1, limitPrice: 61500, close: true }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(hang.error, null);
  assert.equal(hang.order.status, 'open');
  assert.equal(hang.order.close, true);
  assert.equal(hang.order.positionSide, 'long');

  const tick = tickAccount(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 61500 }) }, { cfg: CFG, now: NOW_FRI });
  assert.equal(tick.fills.length, 1);
  assert.equal(tick.fills[0].price, 61500);
  assert.equal(tick.fills[0].reason, 'CLOSE');
  assert.equal(tick.fills[0].realizedPnl, 142.05);
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
  assert.equal(account.cash.USDT, 100136.05);
  assert.equal(account.orders.at(-1).status, 'filled');
});

test('tickAccount rejects a close order whose position disappeared', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'limit', qty: 0.1, limitPrice: 61500, close: true }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  delete account.positions['crypto:BTCUSDT'];
  const tick = tickAccount(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 61500 }) }, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(tick.fills, []);
  assert.equal(tick.orderUpdates.length, 1);
  assert.equal(tick.orderUpdates[0].status, 'rejected');
  assert.equal(tick.orderUpdates[0].rejectCode, 'INSUFFICIENT_POSITION');
});

test('tickAccount rejects a leveraged open order when margin ran out', () => {
  const account = leveragedAccount({ initialCapital: 500 });
  const hang = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, limitPrice: 59000, leverage: 10 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(hang.error, null);
  assert.equal(hang.order.status, 'open');
  const tick = tickAccount(account, { 'crypto:BTCUSDT': cryptoQuote({ price: 58000 }) }, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(tick.fills, []);
  assert.equal(tick.orderUpdates.length, 1);
  assert.equal(tick.orderUpdates[0].status, 'rejected');
  assert.equal(tick.orderUpdates[0].rejectCode, 'INSUFFICIENT_MARGIN');
  assert.equal(account.positions['crypto:BTCUSDT'], undefined);
});

test('amendOrder updates an open limit price and validates it', () => {
  const account = makeAccount();
  const quote = cnQuote({ price: 100, ask: [{ price: 100.01, size: 100 }], bid: [{ price: 99.99, size: 100 }] });
  const hang = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 95 }, quote, { cfg: CFG, now: NOW_FRI });
  assert.equal(hang.order.status, 'open');

  const amended = amendOrder(account, hang.order.id, { limitPrice: 99 }, quote, CFG, '2026-10-23T10:00:05+08:00');
  assert.equal(amended.ok, true);
  assert.equal(amended.order.limitPrice, 99);
  assert.equal(amended.order.status, 'open');

  assert.equal(amendOrder(account, hang.order.id, { limitPrice: 120 }, quote, CFG).code, 'PRICE_LIMIT');
  assert.equal(amendOrder(account, hang.order.id, { limitPrice: 0 }, quote, CFG).code, 'PRICE_INVALID');
  assert.equal(amendOrder(account, 'missing_order', { limitPrice: 99 }, quote, CFG).code, 'ORDER_NOT_FOUND');

  const filled = placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 100.5 }, quote, { cfg: CFG, now: NOW_FRI });
  assert.equal(filled.order.status, 'filled');
  assert.equal(amendOrder(account, filled.order.id, { limitPrice: 101 }, quote, CFG).code, 'ORDER_NOT_AMENDABLE');
  // the server forwards its whole option bag as the 5th argument; that must still work
  const bag = amendOrder(account, hang.order.id, { limitPrice: 98.5 }, quote, { cfg: CFG, now: '2026-10-23T10:00:06+08:00' });
  assert.equal(bag.ok, true);
  assert.equal(bag.order.limitPrice, 98.5);
});

test('setMarginMode requires an empty account', () => {
  const empty = makeAccount();
  assert.equal(setMarginMode(empty, 'cross').ok, true);
  assert.equal(empty.marginMode, 'cross');
  assert.equal(setMarginMode(empty, 'isolated').ok, true);
  assert.equal(setMarginMode(empty, 'weird').code, 'MARGIN_MODE_INVALID');

  const withPosition = makeAccount();
  placeOrder(withPosition, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(setMarginMode(withPosition, 'cross').code, 'MARGIN_MODE_LOCKED');

  const withOrder = makeAccount();
  placeOrder(withOrder, { symbol: 'cn:sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 95 }, cnQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(withOrder.orders.at(-1).status, 'open');
  assert.equal(setMarginMode(withOrder, 'cross').code, 'MARGIN_MODE_LOCKED');
});

test('leverage limits and A-share short selling are rejected', () => {
  const cnAccount = makeAccount();
  assert.equal(placeOrder(cnAccount, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100, leverage: 2 }, cnQuote(), { cfg: CFG, now: NOW_FRI }).error.code, 'LEVERAGE_NOT_ALLOWED');
  assert.equal(placeOrder(cnAccount, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100, leverage: 2 }, cnQuote(), { cfg: CFG, now: NOW_FRI }).error.code, 'SHORT_NOT_ALLOWED');
  // plain spot sell without a position is still INSUFFICIENT_POSITION (contract §6A.4)
  assert.equal(placeOrder(cnAccount, { symbol: 'cn:sh600519', side: 'sell', type: 'market', qty: 100 }, cnQuote(), { cfg: CFG, now: NOW_FRI }).error.code, 'INSUFFICIENT_POSITION');

  // cfg override (v3 §6B): the server passes each account's effective cfg, so the
  // leverage cap comes from cfg, not from the global config file.
  const cryptoCfg = { ...CFG, leverage: { ...CFG.leverage, crypto: 20 } };
  const cryptoAccount = leveragedAccount();
  assert.equal(placeOrder(cryptoAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 21 }, cryptoQuote(), { cfg: cryptoCfg, now: NOW_FRI }).error.code, 'LEVERAGE_NOT_ALLOWED');
  assert.equal(placeOrder(cryptoAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 20 }, cryptoQuote(), { cfg: cryptoCfg, now: NOW_FRI }).error, null);
  assert.equal(placeOrder(cryptoAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 0.5 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI }).error.code, 'LEVERAGE_NOT_ALLOWED');

  const usCfg = { ...CFG, leverage: { ...CFG.leverage, us: 4 } };
  const usAccount = makeAccount({ baseCurrency: 'USD', initialCapital: 10000 });
  assert.equal(placeOrder(usAccount, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1, leverage: 5 }, usQuote(), { cfg: usCfg, now: NOW_US_THU }).error.code, 'LEVERAGE_NOT_ALLOWED');
  // the cfg max leverage itself is accepted
  assert.equal(placeOrder(usAccount, { symbol: 'us:usAAPL', side: 'buy', type: 'market', qty: 1, leverage: 4 }, usQuote(), { cfg: usCfg, now: NOW_US_THU }).error, null);
});

test('adding to a position requires the same leverage (LEVERAGE_MISMATCH)', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const mismatch = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 5 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(mismatch.error.code, 'LEVERAGE_MISMATCH');

  const add = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(add.error, null);
  const position = account.positions['crypto:BTCUSDT'];
  assert.equal(position.qty, 0.2);
  assert.equal(position.avgCost, 60018); // weighted average of two identical fills
  assert.equal(position.margin, 1200.36);
  assert.equal(position.debt, 10803.24);
});

test('plain opposite orders on a leveraged position conflict (POSITION_CONFLICT)', () => {
  const longAccount = leveragedAccount();
  openCrypto10x(longAccount);
  assert.equal(placeOrder(longAccount, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.1 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI }).error.code, 'POSITION_CONFLICT');
  // close:true is the supported way
  assert.equal(placeOrder(longAccount, { symbol: 'crypto:BTCUSDT', side: 'sell', type: 'market', qty: 0.1, close: true }, cryptoQuote(), { cfg: CFG, now: NOW_FRI }).error, null);

  const shortAccount = leveragedAccount();
  openCrypto10x(shortAccount, {}, { side: 'sell' });
  assert.equal(placeOrder(shortAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI }).error.code, 'POSITION_CONFLICT');
});

test('leveraged opens report INSUFFICIENT_MARGIN while spot keeps INSUFFICIENT_CASH', () => {
  const small = leveragedAccount({ initialCapital: 500 });
  const marginError = placeOrder(small, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(marginError.error.code, 'INSUFFICIENT_MARGIN');
  assert.match(marginError.error.message, /保证金/);

  const spot = makeAccount({ initialCapital: 1000 });
  const cashError = placeOrder(spot, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(cashError.error.code, 'INSUFFICIENT_CASH');
});

test('setProtect validates direction and can clear values', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  assert.equal(setProtect(account, 'crypto:BTCUSDT', { takeProfit: 59000 }, cryptoQuote(), CFG).code, 'PROTECT_PRICE_INVALID'); // TP below price for a long
  assert.equal(setProtect(account, 'crypto:BTCUSDT', { stopLoss: 61000 }, cryptoQuote(), CFG).code, 'PROTECT_PRICE_INVALID');
  assert.equal(setProtect(account, 'crypto:BTCUSDT', { takeProfit: 62000, stopLoss: 57000 }, cryptoQuote(), CFG).ok, true);
  // clearing only the TP keeps the SL
  assert.equal(setProtect(account, 'crypto:BTCUSDT', { takeProfit: null }, cryptoQuote(), CFG).ok, true);
  assert.equal(account.positions['crypto:BTCUSDT'].takeProfit, null);
  assert.equal(account.positions['crypto:BTCUSDT'].stopLoss, 57000);
  assert.equal(setProtect(makeAccount(), 'crypto:BTCUSDT', { takeProfit: 1 }, cryptoQuote(), CFG).code, 'INSUFFICIENT_POSITION');

  const shortAccount = leveragedAccount();
  openCrypto10x(shortAccount, {}, { side: 'sell' });
  assert.equal(setProtect(shortAccount, 'crypto:BTCUSDT', { takeProfit: 58000, stopLoss: 61000 }, cryptoQuote(), CFG).ok, true);
  assert.equal(setProtect(shortAccount, 'crypto:BTCUSDT', { takeProfit: 61000 }, cryptoQuote(), CFG).code, 'PROTECT_PRICE_INVALID');
});

test('hk and us allow leveraged shorts', () => {
  const usAccount = makeAccount({ baseCurrency: 'USD', initialCapital: 10000 });
  const usShort = placeOrder(usAccount, { symbol: 'us:usAAPL', side: 'sell', type: 'market', qty: 1, leverage: 4 },
    usQuote({ ask: [{ price: 200.01, size: 10 }], bid: [{ price: 199.99, size: 10 }] }), { cfg: CFG, now: NOW_US_THU });
  assert.equal(usShort.error, null);
  assert.equal(usShort.fill.price, 199.97);
  assert.equal(usAccount.positions['us:usAAPL'].side, 'short');
  assert.equal(usAccount.positions['us:usAAPL'].margin, 49.99);
  assert.equal(usAccount.positions['us:usAAPL'].debt, 149.98);

  const hkAccount = makeAccount({ baseCurrency: 'HKD', initialCapital: 1000000 });
  const hkShort = placeOrder(hkAccount, { symbol: 'hk:hk00700', side: 'sell', type: 'market', qty: 100, leverage: 4 },
    hkQuote({ ask: [{ price: 300.1, size: 100 }], bid: [{ price: 299.9, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(hkShort.error, null);
  assert.equal(hkShort.fill.price, 299.87);
  assert.equal(hkAccount.positions['hk:hk00700'].side, 'short');
  assert.equal(hkAccount.positions['hk:hk00700'].margin, 7496.75);
  assert.equal(hkAccount.positions['hk:hk00700'].debt, 22490.25);
});

test('portfolioView exposes the v2 margin fields in cross mode', () => {
  const account = leveragedAccount({ marginMode: 'cross' });
  openCrypto10x(account);
  const view = portfolioView(account, { 'crypto:BTCUSDT': cryptoQuote() }, RATES_ONE, NOW_FRI, CFG);
  assert.equal(view.marginMode, 'cross');
  assert.equal(view.marginUsed, 30); // cross mode uses the maintenance margin
  assert.equal(view.maintenanceMargin, 30);
  assert.equal(view.riskRatio, 0.0003); // 30 / 99992.2
  assert.equal(view.positions[0].liqPrice, null); // cross mode has no per-position liq price
  assert.equal(view.positions[0].riskRatio, null);
  assert.equal(view.marginAvailable, round2(view.equity.total - 30));
  assert.equal(view.baseCurrency, 'USDT');
  assert.ok('takeProfit' in view.positions[0] && 'stopLoss' in view.positions[0]);
  assert.ok('openedAt' in view.positions[0]);
});

test('spot A-share positions are never liquidated', () => {
  const account = makeAccount();
  placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  const risk = checkRisk(account, { 'cn:sh600519': cnQuote({ price: 50 }) }, { CNY: 1 }, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(risk.liquidations, []);
  assert.deepEqual(risk.triggered, []);
  assert.deepEqual(risk.warnings, []);
  assert.equal(account.positions['cn:sh600519'].qty, 100);
  assert.equal(account.cash.CNY, 989992.9);
});

test('accrueInterest ignores positions without debt', () => {
  const account = makeAccount();
  placeOrder(account, { symbol: 'cn:sh600519', side: 'buy', type: 'market', qty: 100 }, cnQuote({ ask: [{ price: 100.01, size: 100 }] }), { cfg: CFG, now: NOW_FRI });
  assert.equal(accrueInterest(account, NOW_24H), 0);
  assert.equal(account.totalInterest, 0);
});

test('computeStats reports v2 leverage, liquidation and interest metrics', () => {
  const account = {
    trades: [
      { id: 't1', symbol: 'crypto:BTCUSDT', market: 'crypto', side: 'buy', reason: 'OPEN', qty: 0.1, price: 60018, fees: 1, leverage: 10, realizedPnl: 0, t: NOW_FRI },
      { id: 't2', symbol: 'crypto:BTCUSDT', market: 'crypto', side: 'sell', reason: 'CLOSE', qty: 0.1, price: 61000, fees: 2, leverage: 10, realizedPnl: 50, t: NOW_FRI },
      { id: 't3', symbol: 'crypto:BTCUSDT', market: 'crypto', side: 'buy', reason: 'STOP_LOSS', qty: 0.1, price: 59000, fees: 1, leverage: 5, realizedPnl: -20, t: NOW_FRI }
    ],
    liquidations: [{ t: NOW_FRI, symbol: 'crypto:BTCUSDT', reason: 'LIQUIDATION' }, { t: NOW_FRI, symbol: 'crypto:BTCUSDT', reason: 'STOP_LOSS' }],
    totalInterest: 3.5,
    equityHistory: [{ t: NOW_FRI, equity: 100000 }]
  };
  const stats = computeStats(account);
  assert.equal(stats.tradeCount, 3);
  assert.equal(stats.winCount, 1);
  assert.equal(stats.lossCount, 1);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.realizedPnl, 30);
  assert.equal(stats.avgLeverage, 8.33); // (10 + 10 + 5) / 3
  assert.equal(stats.liquidationCount, 1);
  assert.equal(stats.interestPaid, 3.5);
  // short closes (buy side) are counted through their reason, not their side
  assert.equal(stats.byMarket.crypto.winCount, 1);
});

test('store keeps the v2 margin fields and TP/SL across save/load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimatrader-store-v2-'));
  try {
    const store = createStore({ dataDir: dir, watchlist: [] });
    store.load();
    const account = leveragedAccount({ id: 'acc_v2' });
    openCrypto10x(account);
    setProtect(account, 'crypto:BTCUSDT', { takeProfit: 62000, stopLoss: 57000 }, cryptoQuote(), CFG);
    accrueInterest(account, NOW_24H);
    store.addAccount(account);
    const crossAccount = createAccount({ id: 'acc_v2_cross', name: '全仓', initialCapital: 1000, marginMode: 'cross' }, { now: NOW_FRI });
    store.addAccount(crossAccount);

    const state = createStore({ dataDir: dir }).load();
    assert.equal(state.accounts.acc_v2_cross.marginMode, 'cross');
    const loaded = state.accounts.acc_v2;
    assert.equal(loaded.marginMode, 'isolated');
    assert.equal(loaded.totalInterest, account.totalInterest);
    assert.deepEqual(loaded.liquidations, []);
    const position = loaded.positions['crypto:BTCUSDT'];
    assert.equal(position.side, 'long');
    assert.equal(position.leverage, 10);
    assert.equal(position.margin, 600.18);
    assert.equal(position.debt, 5401.62);
    assert.equal(position.accruedInterest, account.positions['crypto:BTCUSDT'].accruedInterest);
    assert.equal(position.interestAnnual, 0.08);
    assert.equal(Date.parse(position.lastInterestAt), Date.parse(NOW_24H));
    assert.equal(position.takeProfit, 62000);
    assert.equal(position.stopLoss, 57000);

    // forced exits land in state as well (clear the SL first so the margin call runs)
    assert.equal(setProtect(loaded, 'crypto:BTCUSDT', { takeProfit: null, stopLoss: null }, cryptoQuote(), CFG).ok, true);
    checkRisk(loaded, { 'crypto:BTCUSDT': cryptoQuote({ price: 52000 }) }, RATES_ONE, { cfg: CFG, now: NOW_24H });
    assert.equal(loaded.liquidations.length, 1);
    assert.equal(loaded.liquidations[0].reason, 'LIQUIDATION');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store migrates v1 archives to the v2 position shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimatrader-store-v1-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      version: 1,
      createdAt: NOW_FRI,
      accounts: {
        acc_old: {
          id: 'acc_old',
          name: '旧账户',
          baseCurrency: 'CNY',
          initialCapital: 1000,
          createdAt: NOW_FRI,
          cash: { CNY: 0, HKD: 0, USD: 0, USDT: 0 },
          positions: {
            'cn:sh600519': { symbol: 'cn:sh600519', market: 'cn', name: '贵州茅台', currency: 'CNY', qty: 100, avgCost: 10, todayBuyQty: 0, todayBuyDate: null, openedAt: NOW_FRI }
          },
          orders: [],
          trades: [],
          equityHistory: [{ t: NOW_FRI, equity: 1000 }],
          dayStartEquity: 1000,
          dayKey: '2026-10-23',
          realizedPnl: 0,
          totalFees: 0
        }
      },
      watchlist: [],
      alerts: []
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacy), 'utf8');
    const loaded = createStore({ dataDir: dir }).load().accounts.acc_old;
    assert.equal(loaded.marginMode, 'isolated');
    assert.equal(loaded.totalInterest, 0);
    assert.deepEqual(loaded.liquidations, []);
    const position = loaded.positions['cn:sh600519'];
    assert.equal(position.side, 'long');
    assert.equal(position.leverage, 1);
    assert.equal(position.margin, 1000); // qty * avgCost for a spot long
    assert.equal(position.debt, 0);
    assert.equal(position.accruedInterest, 0);
    assert.equal(position.takeProfit, null);
    assert.equal(position.stopLoss, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// v3: account-level settings + cfg pass-through (§6B)
// ===========================================================================

test('store keeps account.settings across save/load (v3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papertrader-store-v3-'));
  try {
    const settings = {
      leverageMultiplier: 0.5,
      fees: { ...CFG.fees, crypto: { ...CFG.fees.crypto, commissionRate: 0.002 } },
      slippageBps: { cn: 2, hk: 3, us: 4, fx: 5, crypto: 6 },
      margin: {
        mmr: { cn: 1, hk: 0.04, us: 0.04, fx: 0.002, crypto: 0.004 },
        interestAnnual: { ...CFG.margin.interestAnnual },
        liquidationFeeRate: { ...CFG.margin.liquidationFeeRate }
      },
      autoConvert: false,
      fxConvertSpread: 0.005,
      futureField: { nested: [1, 2, 3] } // unknown extension inside settings must survive
    };
    const store = createStore({ dataDir: dir, watchlist: [] });
    store.load();
    const account = makeAccount({ id: 'acc_settings' });
    account.settings = settings;
    store.addAccount(account);

    const loaded = createStore({ dataDir: dir }).load().accounts.acc_settings;
    assert.deepEqual(loaded.settings, settings);
    assert.equal(loaded.settings.leverageMultiplier, 0.5);
    assert.equal(loaded.settings.fees.crypto.commissionRate, 0.002);
    assert.equal(loaded.settings.margin.mmr.crypto, 0.004);
    assert.equal(loaded.settings.autoConvert, false);
    assert.equal(loaded.settings.fxConvertSpread, 0.005);

    // The restored settings still work as the account's effective cfg.
    const effective = { ...CFG, ...loaded.settings };
    assert.equal(calcFees('crypto', 'buy', 0.1, 60000, effective).total, 12); // 0.002 * 6000
    assert.equal(calcFees('crypto', 'buy', 0.1, 60000, CFG).total, 6); // global 0.001
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store loads v1/v2 archives without account.settings and keeps unknown state fields (v3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papertrader-store-v3-legacy-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const legacyState = {
      version: 1,
      createdAt: NOW_FRI,
      bootstrapped: true, // top-level server flag that used to be dropped by the normalizer
      accounts: {
        acc_legacy: {
          id: 'acc_legacy',
          name: '旧账户',
          baseCurrency: 'CNY',
          initialCapital: 100000,
          createdAt: NOW_FRI,
          cash: { CNY: 100000, HKD: 0, USD: 0, USDT: 0 },
          positions: {},
          orders: [],
          trades: [],
          equityHistory: [{ t: NOW_FRI, equity: 100000 }],
          dayStartEquity: 100000,
          dayKey: '2026-10-23',
          realizedPnl: 0,
          totalFees: 0
        }
      },
      watchlist: [],
      alerts: []
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacyState), 'utf8');

    const state = createStore({ dataDir: dir }).load();
    assert.equal(state.bootstrapped, true); // unknown top-level flags are preserved
    const loaded = state.accounts.acc_legacy;
    assert.ok(loaded);
    assert.deepEqual(loaded.settings, {}); // missing settings defaults to an empty object
    assert.equal(loaded.marginMode, 'isolated');
    assert.equal(loaded.cash.CNY, 100000);
    // and a second save/load round trip stays clean
    const second = createStore({ dataDir: dir });
    second.load();
    const account = second.getAccount('acc_legacy');
    account.settings = { leverageMultiplier: 2 };
    second.replaceAccount(account);
    assert.deepEqual(createStore({ dataDir: dir }).load().accounts.acc_legacy.settings, { leverageMultiplier: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('calcFees uses the fees from the injected cfg (v3 effective cfg)', () => {
  const cfgCrypto = { ...CFG, fees: { ...CFG.fees, crypto: { commissionRate: 0.002 } } };
  assert.equal(calcFees('crypto', 'buy', 0.1, 60000, CFG).total, 6); // 0.001 * 6000
  assert.equal(calcFees('crypto', 'buy', 0.1, 60000, cfgCrypto).total, 12); // 0.002 * 6000
  assert.equal(calcFees('crypto', 'sell', 0.1, 60000, cfgCrypto).total, 12);

  const cfgHk = { ...CFG, fees: { ...CFG.fees, hk: { ...CFG.fees.hk, commissionMin: 50 } } };
  assert.equal(calcFees('hk', 'buy', 100, 200, CFG).breakdown.commission, 100); // config minimum
  assert.equal(calcFees('hk', 'buy', 100, 200, cfgHk).breakdown.commission, 50); // cfg minimum
});

test('placeOrder uses the cfg leverage cap (v3 effective cfg)', () => {
  const cfgCrypto20 = { ...CFG, leverage: { ...CFG.leverage, crypto: 20 } };
  const account = leveragedAccount();
  const rejected = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 21 }, cryptoQuote(), { cfg: cfgCrypto20, now: NOW_FRI });
  assert.equal(rejected.error.code, 'LEVERAGE_NOT_ALLOWED');
  assert.match(rejected.error.message, /20x/); // the cap comes from cfg, not the global file

  const accepted = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 20 }, cryptoQuote(), { cfg: cfgCrypto20, now: NOW_FRI });
  assert.equal(accepted.error, null);
  assert.equal(accepted.order.leverage, 20);
  assert.equal(account.positions['crypto:BTCUSDT'].leverage, 20);
  assert.equal(account.positions['crypto:BTCUSDT'].margin, 300.09); // 6001.8 / 20
});

test('placeOrder uses the cfg slippageBps (v3 effective cfg)', () => {
  const cfgSlip = { ...CFG, slippageBps: { ...CFG.slippageBps, crypto: 20 } };
  const baseAccount = leveragedAccount();
  const baseFill = placeOrder(baseAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  const slippedAccount = leveragedAccount();
  const slippedFill = placeOrder(slippedAccount, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: cfgSlip, now: NOW_FRI });
  assert.equal(baseFill.fill.price, 60018); // default 3bp
  assert.equal(slippedFill.fill.price, 60120); // cfg 20bp
  assert.ok(slippedFill.fill.price - baseFill.fill.price > 100);
  // the cfg also changes the fee charged on the slipped notional
  assert.equal(slippedFill.fill.fees, 6.01); // 0.1 * 60120 * 0.001 = 6.012
});

test('checkRisk uses cfg.margin.mmr for maintenance and liquidation (v3)', () => {
  const quote = { 'crypto:BTCUSDT': cryptoQuote({ price: 55000 }) };
  const lowAccount = leveragedAccount();
  openCrypto10x(lowAccount);
  const lowRisk = checkRisk(lowAccount, quote, RATES_ONE, { cfg: CFG, now: NOW_FRI });
  assert.deepEqual(lowRisk.liquidations, []);
  assert.ok(lowAccount.positions['crypto:BTCUSDT'], 'default mmr 0.5% keeps the position alive');

  const cfgHighMmr = { ...CFG, margin: { ...CFG.margin, mmr: { ...CFG.margin.mmr, crypto: 0.05 } } };
  const highAccount = leveragedAccount();
  openCrypto10x(highAccount);
  const highRisk = checkRisk(highAccount, quote, RATES_ONE, { cfg: cfgHighMmr, now: NOW_FRI });
  assert.equal(highRisk.liquidations.length, 1);
  assert.equal(highRisk.liquidations[0].reason, 'LIQUIDATION');
  assert.equal(highAccount.positions['crypto:BTCUSDT'], undefined);
});

test('an open stores the cfg interestAnnual and accrueInterest uses it (v3)', () => {
  const cfgRate = { ...CFG, margin: { ...CFG.margin, interestAnnual: { ...CFG.margin.interestAnnual, crypto: 0.2 } } };
  const account = leveragedAccount();
  const opened = placeOrder(account, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: cfgRate, now: NOW_FRI });
  assert.equal(opened.error, null);
  const position = account.positions['crypto:BTCUSDT'];
  assert.equal(position.interestAnnual, 0.2); // from the injected cfg
  assert.equal(position.debt, 5401.62);
  const added = accrueInterest(account, NOW_24H);
  const expected = position.debt * 0.2 / 8760 * 24;
  assert.ok(Math.abs(added - expected) < 1e-6, `interest ${added} vs ${expected}`);
  assert.ok(Math.abs(account.totalInterest - expected) < 1e-6);
  assert.ok(Math.abs(position.accruedInterest - expected) < 1e-6);

  // without the override the global 8% applies
  const plain = leveragedAccount();
  placeOrder(plain, { symbol: 'crypto:BTCUSDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }, cryptoQuote(), { cfg: CFG, now: NOW_FRI });
  assert.equal(plain.positions['crypto:BTCUSDT'].interestAnnual, CFG.margin.interestAnnual.crypto);
});

test('portfolioView 5th cfg argument drives liqPrice/riskRatio (v3)', () => {
  const account = leveragedAccount();
  openCrypto10x(account);
  const quotes = { 'crypto:BTCUSDT': cryptoQuote() };
  const cfgHighMmr = { ...CFG, margin: { ...CFG.margin, mmr: { ...CFG.margin.mmr, crypto: 0.05 } } };
  const low = portfolioView(account, quotes, RATES_ONE, NOW_FRI, CFG);
  const high = portfolioView(account, quotes, RATES_ONE, NOW_FRI, cfgHighMmr);

  const expectedLowLiq = (60018 * 0.1 - 600.18) / (0.1 * 0.995);
  const expectedHighLiq = (60018 * 0.1 - 600.18) / (0.1 * 0.95);
  assert.ok(Math.abs(low.positions[0].liqPrice - expectedLowLiq) < 0.02);
  assert.ok(Math.abs(high.positions[0].liqPrice - expectedHighLiq) < 0.02);
  assert.ok(high.positions[0].liqPrice > low.positions[0].liqPrice + 1000);
  assert.equal(low.positions[0].riskRatio, 0.0501);
  assert.equal(high.positions[0].riskRatio, 0.5014);
  assert.equal(low.maintenanceMargin, 30);
  assert.equal(high.maintenanceMargin, 300);
  assert.equal(low.riskRatio, 0.0501);
  assert.equal(high.riskRatio, 0.5014);
});

// ===========================================================================
// v1.1.1: per-position todayPnl baseline (§6.5)
// ===========================================================================

const YESTERDAY = '2026-10-22T10:00:00+08:00';

function overnightPosition(overrides = {}) {
  return {
    symbol: 'crypto:BTCUSDT',
    market: 'crypto',
    name: '比特币',
    currency: 'USDT',
    side: 'long',
    qty: 0.1,
    avgCost: 60018,
    leverage: 10,
    margin: 600.18,
    debt: 5401.62,
    accruedInterest: 0,
    interestAnnual: 0.08,
    lastInterestAt: YESTERDAY,
    takeProfit: null,
    stopLoss: null,
    openedAt: YESTERDAY,
    todayBuyQty: 0,
    todayBuyDate: '2026-10-22',
    ...overrides
  };
}

test('portfolioView: a position opened today measures todayPnl from its entry price', () => {
  const account = leveragedAccount();
  openCrypto10x(account); // filled at 60018 on NOW_FRI
  const openedAt = account.positions['crypto:BTCUSDT'].openedAt;
  assert.equal(dayKeyOf(openedAt), dayKeyOf(NOW_FRI)); // same Asia/Shanghai day

  const quotes = { 'crypto:BTCUSDT': cryptoQuote({ price: 60100, prevClose: 59500 }) };
  const view = portfolioView(account, quotes, RATES_ONE, NOW_FRI, CFG);
  const position = view.positions[0];
  assert.equal(position.todayPnl, 8.2); // (60100 - 60018) * 0.1, entry-based
  assert.equal(position.todayPnl, position.unrealizedPnl); // same-day entry -> equals mark-to-market
  const overnightBasis = round2((60100 - 59500) * 0.1);
  assert.equal(overnightBasis, 60); // the old（错误）口径会给出 60
  assert.notEqual(position.todayPnl, overnightBasis);
  // the account-level todayPnl stays equity - dayStartEquity
  assert.equal(view.todayPnl, round2(view.equity.total - view.dayStartEquity));
});

test('portfolioView: an overnight position measures todayPnl from prevClose', () => {
  const account = leveragedAccount();
  account.positions['crypto:BTCUSDT'] = overnightPosition();
  const quotes = { 'crypto:BTCUSDT': cryptoQuote({ price: 60100, prevClose: 59500 }) };
  const position = portfolioView(account, quotes, RATES_ONE, NOW_FRI, CFG).positions[0];
  assert.equal(position.todayPnl, 60); // (60100 - 59500) * 0.1
  assert.equal(position.unrealizedPnl, 8.2); // (60100 - 60018) * 0.1

  // a missing or invalid openedAt is treated as an overnight position as well
  delete account.positions['crypto:BTCUSDT'].openedAt;
  assert.equal(portfolioView(account, quotes, RATES_ONE, NOW_FRI, CFG).positions[0].todayPnl, 60);
  account.positions['crypto:BTCUSDT'].openedAt = 'not-a-date';
  assert.equal(portfolioView(account, quotes, RATES_ONE, NOW_FRI, CFG).positions[0].todayPnl, 60);

  // a missing prevClose falls back to lastPrice, so there is no day move to report
  const noPrev = { 'crypto:BTCUSDT': cryptoQuote({ price: 60100, prevClose: null }) };
  assert.equal(portfolioView(account, noPrev, RATES_ONE, NOW_FRI, CFG).positions[0].todayPnl, 0);
});

test('portfolioView: a short opened today measures todayPnl from its entry price', () => {
  const account = leveragedAccount();
  openCrypto10x(account, {}, { side: 'sell' }); // filled at 59982 on NOW_FRI
  const quotes = { 'crypto:BTCUSDT': cryptoQuote({ price: 59900, prevClose: 59500 }) };
  const position = portfolioView(account, quotes, RATES_ONE, NOW_FRI, CFG).positions[0];
  assert.equal(position.side, 'short');
  assert.equal(position.todayPnl, 8.2); // (59982 - 59900) * 0.1
  assert.equal(position.todayPnl, position.unrealizedPnl);
  assert.notEqual(position.todayPnl, round2((59500 - 59900) * 0.1)); // not the old -40

  // the same short held overnight uses prevClose: (prevClose - last) * qty
  const overnightAccount = leveragedAccount();
  overnightAccount.positions['crypto:BTCUSDT'] = overnightPosition({ side: 'short', avgCost: 59982, margin: 599.82, debt: 5398.38 });
  const overnightView = portfolioView(overnightAccount, quotes, RATES_ONE, NOW_FRI, CFG);
  assert.equal(overnightView.positions[0].todayPnl, -40); // (59500 - 59900) * 0.1
});
