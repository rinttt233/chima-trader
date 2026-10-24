// lib/stats.mjs — read-only account statistics derived from trades / equityHistory.
//
// Nothing here mutates the account and nothing touches the network or the filesystem.
// Shapes follow CONTRACTS.md §7 and public/mock.js so the REST layer can pass the
// result through unchanged: `byMarket` is an object keyed by market, `bySymbol` is an
// array, `winRate` is a fraction in [0, 1] (the UI renders it as a percentage), while
// `maxDrawdown` is a percentage and `sharpe` an annualised ratio.

import { dayKeyOf, marketLabel, roundTo, shanghaiDayStartUtc } from './engine.mjs';

const DAY_MS = 24 * 3600 * 1000;
const TRADING_DAYS_PER_YEAR = 252;

const round2 = (value) => roundTo(Number(value) || 0, 2);
const round4 = (value) => roundTo(Number(value) || 0, 4);

function finiteOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptyBucket(key, extra = {}) {
  return { key, tradeCount: 0, winCount: 0, lossCount: 0, fees: 0, realizedPnl: 0, ...extra };
}

/**
 * A trade realises PnL when it closes (part of) a position. v2 trades carry an explicit
 * `reason` (so short closes count too); v1 archives are recognised by their sell side.
 */
function isCloseTrade(trade) {
  const reason = String(trade?.reason ?? '').toUpperCase();
  if (reason) return reason !== 'OPEN';
  return String(trade?.side ?? '').toLowerCase() === 'sell';
}

function closeBucket(bucket) {
  const decided = bucket.winCount + bucket.lossCount;
  return {
    ...bucket,
    fees: round2(bucket.fees),
    realizedPnl: round2(bucket.realizedPnl),
    winRate: decided > 0 ? round4(bucket.winCount / decided) : null
  };
}

/**
 * Aggregate trading statistics (contract §5.1 / §7).
 *
 * - tradeCount counts every fill; winRate / winCount / lossCount only consider closing
 *   trades (long sold, short bought back, liquidations, TP/SL) with a realised PnL.
 * - profitFactor = Σwin / |Σloss|; null when there is no losing trade.
 * - avgWin / avgLoss are positive magnitudes (avgLoss is reported as a positive cost).
 * - maxDrawdown is the peak-to-trough drawdown of equityHistory in percent.
 * - sharpe is annualised (rf=0, daily closes, 252 trading days); null when there are
 *   fewer than 2 daily returns or the return series has no dispersion.
 * - avgLeverage / liquidationCount / interestPaid are v2 extensions (leverage risk).
 * - `byMarket` is an object keyed by market (mock.js / §7 shape); `byMarketList` keeps
 *   the same rows as a sorted array for callers that prefer iterating.
 */
export function computeStats(account) {
  const trades = Array.isArray(account?.trades) ? account.trades : [];
  const closes = trades.filter((trade) => isCloseTrade(trade) && Number.isFinite(Number(trade?.realizedPnl)));
  const wins = closes.filter((trade) => Number(trade.realizedPnl) > 0);
  const losses = closes.filter((trade) => Number(trade.realizedPnl) < 0);
  const grossWin = wins.reduce((acc, trade) => acc + Number(trade.realizedPnl), 0);
  const grossLoss = Math.abs(losses.reduce((acc, trade) => acc + Number(trade.realizedPnl), 0));
  const decided = wins.length + losses.length;

  const byMarket = new Map();
  const bySymbol = new Map();
  let leverageSum = 0;
  let leverageCount = 0;
  let feeTotal = 0;
  for (const trade of trades) {
    const market = typeof trade?.market === 'string' && trade.market ? trade.market : (String(trade?.symbol ?? '').split(':')[0] || 'unknown');
    const symbol = trade?.symbol ?? 'unknown';
    const pnl = finiteOr(trade?.realizedPnl, 0);
    const fees = finiteOr(trade?.fees, 0) + finiteOr(trade?.liquidationFee, 0);
    feeTotal += fees;
    const leverage = Number(trade?.leverage);
    if (Number.isFinite(leverage) && leverage > 0) {
      leverageSum += leverage;
      leverageCount += 1;
    }

    if (!byMarket.has(market)) byMarket.set(market, emptyBucket(market, { market, label: marketLabel(market) }));
    const marketBucket = byMarket.get(market);
    marketBucket.tradeCount += 1;
    marketBucket.fees += fees;
    marketBucket.realizedPnl += pnl;
    if (isCloseTrade(trade)) {
      if (pnl > 0) marketBucket.winCount += 1;
      else if (pnl < 0) marketBucket.lossCount += 1;
    }

    if (!bySymbol.has(symbol)) bySymbol.set(symbol, emptyBucket(symbol, { symbol, name: trade?.name ?? symbol, market }));
    const symbolBucket = bySymbol.get(symbol);
    symbolBucket.tradeCount += 1;
    symbolBucket.fees += fees;
    symbolBucket.realizedPnl += pnl;
    if (!symbolBucket.lastTradeAt || String(trade?.t ?? '') > symbolBucket.lastTradeAt) symbolBucket.lastTradeAt = trade?.t ?? null;
    if (isCloseTrade(trade)) {
      if (pnl > 0) symbolBucket.winCount += 1;
      else if (pnl < 0) symbolBucket.lossCount += 1;
    }
  }

  const history = equitySummary(account);
  const marketRows = [...byMarket.values()].map(closeBucket).sort((a, b) => b.tradeCount - a.tradeCount || a.market.localeCompare(b.market));
  const byMarketObject = {};
  for (const row of marketRows) byMarketObject[row.market] = row;
  const liquidationRows = Array.isArray(account?.liquidations) ? account.liquidations : [];

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: decided > 0 ? round4(wins.length / decided) : null,
    profitFactor: grossLoss > 0 ? round4(grossWin / grossLoss) : null,
    avgWin: wins.length > 0 ? round2(grossWin / wins.length) : 0,
    avgLoss: losses.length > 0 ? round2(grossLoss / losses.length) : 0,
    totalFees: round2(feeTotal),
    realizedPnl: round2(trades.reduce((acc, trade) => acc + finiteOr(trade?.realizedPnl, 0), 0)),
    maxDrawdown: history.maxDrawdown,
    sharpe: history.sharpe,
    avgLeverage: leverageCount > 0 ? round2(leverageSum / leverageCount) : null,
    liquidationCount: liquidationRows.filter((row) => String(row?.reason ?? '').toUpperCase() === 'LIQUIDATION').length,
    interestPaid: round2(finiteOr(account?.totalInterest, 0)),
    byMarket: byMarketObject,
    byMarketList: marketRows,
    bySymbol: [...bySymbol.values()].map(closeBucket).sort((a, b) => b.realizedPnl - a.realizedPnl || a.symbol.localeCompare(b.symbol))
  };
}

function sortedEquityPoints(account) {
  const raw = Array.isArray(account?.equityHistory) ? account.equityHistory : [];
  const points = [];
  for (const point of raw) {
    const ms = Date.parse(point?.t ?? '');
    const equity = Number(point?.equity);
    if (!Number.isFinite(ms) || !Number.isFinite(equity)) continue;
    points.push({ ms, t: point.t, equity });
  }
  points.sort((a, b) => a.ms - b.ms);
  return points;
}

function equitySummary(account) {
  const points = sortedEquityPoints(account);
  if (points.length === 0) return { maxDrawdown: 0, sharpe: null };

  // Peak-to-trough drawdown (percent of the running peak).
  let peak = points[0].equity;
  let maxDrawdown = 0;
  for (const point of points) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const drawdown = ((peak - point.equity) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }

  // Sharpe from daily closes (last equity snapshot of each Asia/Shanghai day).
  const dailyClose = new Map();
  for (const point of points) dailyClose.set(dayKeyOf(point.ms), point.equity);
  const closes = [...dailyClose.values()];
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    const previous = closes[i - 1];
    if (previous > 0) returns.push(closes[i] / previous - 1);
  }
  let sharpe = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
    const variance = returns.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    if (Number.isFinite(sd) && sd > 1e-12) sharpe = round4((mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR));
  }

  return { maxDrawdown: round2(maxDrawdown), sharpe };
}

/**
 * Equity history filtered by range (contract §5.1).
 *   '1d'  -> since 00:00 Asia/Shanghai of `nowISO`
 *   '1w'  -> last 7 days from `nowISO`
 *   '1m'  -> last 30 days from `nowISO`
 *   'all' -> everything up to `nowISO` (unknown ranges behave like 'all')
 * -> [{ t, equity }] sorted ascending.
 */
export function equitySeries(account, range = 'all', nowISO) {
  const points = sortedEquityPoints(account);
  const nowMs = Date.parse(nowISO ?? '') || Date.now();
  const normalized = String(range ?? 'all').toLowerCase();

  let startMs = -Infinity;
  if (normalized === '1d') startMs = shanghaiDayStartUtc(dayKeyOf(nowMs));
  else if (normalized === '1w') startMs = nowMs - 7 * DAY_MS;
  else if (normalized === '1m') startMs = nowMs - 30 * DAY_MS;

  return points
    .filter((point) => point.ms >= startMs && point.ms <= nowMs)
    .map((point) => ({ t: point.t, equity: round2(point.equity) }));
}
