// lib/store.mjs — the only module that touches <dataDir>/state.json.
//
// The in-memory state is the source of truth; every save is atomic (write a temp file
// in the same directory, fsync-free then rename over the target) so a crash mid-write
// can never leave a truncated state.json behind. A missing state file is initialised
// to a default state — with no accounts: account creation is a server decision — and
// persisted immediately.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const STATE_VERSION = 1;
const CASH_CURRENCIES = ['CNY', 'HKD', 'USD', 'USDT'];

function newCash() {
  return { CNY: 0, HKD: 0, USD: 0, USDT: 0 };
}

/** Default (empty) state. The watchlist is injected from config.json defaults. */
export function emptyState(watchlist = []) {
  return {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    accounts: {},
    watchlist: Array.isArray(watchlist) ? watchlist.map(String) : [],
    alerts: []
  };
}

function normalizeAccount(raw, id) {
  const account = raw && typeof raw === 'object' ? raw : {};
  const cash = newCash();
  for (const currency of CASH_CURRENCIES) {
    const value = Number(account.cash?.[currency]);
    cash[currency] = Number.isFinite(value) ? value : 0;
  }
  const positions = {};
  if (account.positions && typeof account.positions === 'object') {
    for (const [symbol, position] of Object.entries(account.positions)) {
      if (!position || typeof position !== 'object') continue;
      const qty = Number(position.qty) || 0;
      const avgCost = Number(position.avgCost) || 0;
      const leverage = Math.max(1, Number(position.leverage) || 1);
      const notional = qty * avgCost;
      // v1 archives have no margin/debt: treat them as fully cash-funded spot longs.
      const margin = position.margin !== null && position.margin !== undefined && Number.isFinite(Number(position.margin))
        ? Number(position.margin)
        : notional / leverage;
      const debt = position.debt !== null && position.debt !== undefined && Number.isFinite(Number(position.debt))
        ? Number(position.debt)
        : Math.max(0, notional - margin);
      const protectPrice = (value) => (value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
      positions[symbol] = {
        symbol: position.symbol ?? symbol,
        market: position.market ?? String(symbol).split(':')[0] ?? '',
        name: position.name ?? symbol,
        currency: position.currency ?? 'CNY',
        side: position.side === 'short' ? 'short' : 'long',
        qty,
        avgCost,
        leverage,
        margin,
        debt,
        accruedInterest: Number(position.accruedInterest) || 0,
        interestAnnual: Number(position.interestAnnual) || 0,
        lastInterestAt: position.lastInterestAt ?? null,
        takeProfit: protectPrice(position.takeProfit),
        stopLoss: protectPrice(position.stopLoss),
        todayBuyQty: Number(position.todayBuyQty) || 0,
        todayBuyDate: position.todayBuyDate ?? null,
        openedAt: position.openedAt ?? null
      };
    }
  }
  const orders = Array.isArray(account.orders) ? account.orders : [];
  const trades = Array.isArray(account.trades) ? account.trades : [];
  const conversions = Array.isArray(account.conversions) ? account.conversions.filter((item) => item && item.t) : [];
  const liquidations = Array.isArray(account.liquidations) ? account.liquidations.filter((item) => item && item.t) : [];
  let equityHistory = Array.isArray(account.equityHistory) ? account.equityHistory.filter((point) => point && point.t) : [];
  if (!equityHistory.length) {
    equityHistory = [{
      t: account.createdAt ?? new Date().toISOString(),
      equity: Number(account.initialCapital) || 0
    }];
  }
  const normalized = {
    id: account.id ?? id,
    name: account.name ?? '模拟账户',
    baseCurrency: account.baseCurrency ?? 'CNY',
    initialCapital: Number(account.initialCapital) || 0,
    marginMode: account.marginMode === 'cross' ? 'cross' : 'isolated',
    createdAt: account.createdAt ?? new Date().toISOString(),
    cash,
    positions,
    orders,
    trades,
    conversions,
    liquidations,
    totalInterest: Number(account.totalInterest) || 0,
    equityHistory,
    dayStartEquity: Number(account.dayStartEquity) || 0,
    dayKey: account.dayKey ?? null,
    realizedPnl: Number(account.realizedPnl) || 0,
    totalFees: Number(account.totalFees) || 0
  };
  // Preserve account-level fields this normalizer does not know about (v3
  // `account.settings`, future extensions) — dropping them silently resets user data
  // on restart (e.g. per-account fees / leverage caps).
  for (const [key, value] of Object.entries(account)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) normalized[key] = value;
  }
  if (!normalized.settings || typeof normalized.settings !== 'object' || Array.isArray(normalized.settings)) {
    normalized.settings = {};
  }
  return normalized;
}

function normalizeState(raw, defaultWatchlist) {
  const base = emptyState(defaultWatchlist);
  if (!raw || typeof raw !== 'object') return base;

  const accounts = {};
  if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
    for (const [id, account] of Object.entries(raw.accounts)) {
      if (!account || typeof account !== 'object') continue;
      accounts[account.id ?? id] = normalizeAccount(account, id);
    }
  }
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts.filter((alert) => alert && alert.id).map((alert) => ({
      id: String(alert.id),
      symbol: alert.symbol ?? '',
      direction: alert.direction ?? 'above',
      price: Number(alert.price) || 0,
      createdAt: alert.createdAt ?? new Date().toISOString(),
      triggeredAt: alert.triggeredAt ?? null
    }))
    : [];
  const watchlist = Array.isArray(raw.watchlist) ? raw.watchlist.map(String) : base.watchlist;

  const normalized = {
    version: Number(raw.version) || STATE_VERSION,
    createdAt: raw.createdAt ?? base.createdAt,
    accounts,
    watchlist,
    alerts
  };
  // Preserve unknown top-level state fields as well (e.g. server `bootstrapped`);
  // otherwise they are silently dropped on every restart.
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) normalized[key] = value;
  }
  return normalized;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable -> busy wait is not worth it; just continue.
  }
}

/**
 * Atomic JSON write: temp file in the same directory + rename. Windows can report
 * EPERM/EBUSY when the target is briefly held open (AV scanners, editors), so the
 * rename is retried a few times.
 */
function writeAtomically(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now().toString(36)}.${randomBytes(3).toString('hex')}.tmp`);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return targetPath;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error.code)) break;
      sleepSync(10 * (attempt + 1));
    }
  }
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // best effort cleanup
  }
  throw lastError;
}

/**
 * Create the persistence layer.
 * @param {{ dataDir?: string, watchlist?: string[] }} options
 *   `watchlist` seeds the default state (server passes config.defaults.watchlist).
 */
export function createStore({ dataDir, watchlist = [] } = {}) {
  const resolvedDir = path.resolve(dataDir ?? 'data');
  const statePath = path.join(resolvedDir, 'state.json');
  const defaultWatchlist = Array.isArray(watchlist) ? watchlist.map(String) : [];
  let internalState = null;
  let debounceTimer = null;

  function persist() {
    internalState.createdAt = internalState.createdAt ?? new Date().toISOString();
    writeAtomically(statePath, internalState);
    return internalState;
  }

  function clearTimer() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  const store = {
    get dataDir() {
      return resolvedDir;
    },
    get statePath() {
      return statePath;
    },

    /** Load (or initialise) the state. Missing file => default state, persisted. */
    load() {
      fs.mkdirSync(resolvedDir, { recursive: true });
      if (!fs.existsSync(statePath)) {
        internalState = emptyState(defaultWatchlist);
        persist();
        return internalState;
      }
      let rawText;
      try {
        rawText = fs.readFileSync(statePath, 'utf8');
      } catch {
        internalState = emptyState(defaultWatchlist);
        return internalState;
      }
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Keep the broken file for inspection and continue with a clean state.
        try {
          fs.renameSync(statePath, path.join(resolvedDir, `state.corrupt-${Date.now()}.json`));
        } catch {
          // ignore — default state is still usable
        }
        internalState = emptyState(defaultWatchlist);
        persist();
        return internalState;
      }
      internalState = normalizeState(parsed, defaultWatchlist);
      return internalState;
    },

    /** In-memory state (loads lazily). Treat as read-only; mutate via the helpers. */
    get state() {
      if (!internalState) store.load();
      return internalState;
    },

    /** Synchronous atomic write. */
    save() {
      clearTimer();
      return persist();
    },

    /** Coalesce writes: the last call within `ms` wins. Use for frequent mutations. */
    saveDebounced(ms = 300) {
      clearTimer();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        try {
          persist();
        } catch (error) {
          // A background save must never take the server down.
          console.error(`[store] debounced save failed: ${error.message}`);
        }
      }, Math.max(0, Number(ms) || 0));
      return store;
    },

    /** Flush a pending debounced write immediately. */
    flush() {
      if (debounceTimer) clearTimer();
      return persist();
    },

    listAccounts() {
      return Object.values(store.state.accounts);
    },

    getAccount(id) {
      const account = store.state.accounts[id];
      return account ?? null;
    },

    addAccount(account) {
      if (!account || typeof account !== 'object' || !account.id) throw new Error('addAccount 需要带 id 的账户对象');
      store.state.accounts[account.id] = account;
      persist();
      return account;
    },

    removeAccount(id) {
      const accounts = store.state.accounts;
      if (!Object.prototype.hasOwnProperty.call(accounts, id)) return false;
      delete accounts[id];
      persist();
      return true;
    },

    /** Replace (or upsert) an account, typically after the engine mutated it in place. */
    replaceAccount(account) {
      if (!account || typeof account !== 'object' || !account.id) throw new Error('replaceAccount 需要带 id 的账户对象');
      store.state.accounts[account.id] = account;
      persist();
      return account;
    },

    getWatchlist() {
      const list = store.state.watchlist;
      return Array.isArray(list) ? [...list] : [];
    },

    setWatchlist(symbols) {
      store.state.watchlist = Array.isArray(symbols) ? symbols.map(String) : [];
      persist();
      return store.getWatchlist();
    },

    listAlerts() {
      const list = store.state.alerts;
      return Array.isArray(list) ? [...list] : [];
    },

    addAlert(alert) {
      const record = {
        id: typeof alert?.id === 'string' && alert.id ? alert.id : store.nextId('alert'),
        symbol: String(alert?.symbol ?? ''),
        direction: alert?.direction === 'below' ? 'below' : 'above',
        price: Number(alert?.price) || 0,
        createdAt: alert?.createdAt ?? new Date().toISOString(),
        triggeredAt: alert?.triggeredAt ?? null
      };
      store.state.alerts.push(record);
      persist();
      return record;
    },

    removeAlert(id) {
      const alerts = store.state.alerts;
      const index = alerts.findIndex((alert) => alert.id === id);
      if (index < 0) return false;
      alerts.splice(index, 1);
      persist();
      return true;
    },

    /** Unique id such as 'ord_1a2b3c'. */
    nextId(prefix = 'id') {
      const state = store.state;
      const known = new Set(Object.keys(state.accounts));
      for (const account of Object.values(state.accounts)) {
        for (const order of account.orders ?? []) known.add(order.id);
      }
      for (const alert of state.alerts ?? []) known.add(alert.id);
      const head = String(prefix || 'id').replace(/[^A-Za-z0-9_]/g, '') || 'id';
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = `${head}_${randomBytes(3).toString('hex')}`;
        if (!known.has(candidate)) return candidate;
      }
      return `${head}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    }
  };

  return store;
}
