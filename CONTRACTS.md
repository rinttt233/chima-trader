# 千亦所 ChimaTrader — 接口契约（并行开发唯一事实来源）

本地多市场模拟交易平台。A股 / 港股 / 美股 / 外汇 / 加密，真实行情驱动，不涉及任何真实资金。

- 运行环境：Node.js 24（**不引入任何第三方 npm 依赖**，仅 Node 标准库），Windows，单进程 HTTP 服务 + 浏览器 SPA。
- 数据只落本地 `data/`，前端为静态文件。
- 代码与标识符一律英文；**面向用户的文案用中文**；注释用英文。

---

## 1. 目录与文件归属

```
chima-trader/
  CONTRACTS.md          Lead
  README.md             Lead
  config.json           Lead
  server.mjs            Lead
  selfcheck.mjs         Lead
  lib/net.mjs           Teammate A (data)
  lib/symbols.mjs       Teammate A (data)
  lib/marketdata.mjs    Teammate A (data)
  lib/sources/*.mjs     Teammate A (data)
  lib/engine.mjs        Teammate B (engine)
  lib/store.mjs         Teammate B (engine)
  lib/stats.mjs         Teammate B (engine)
  test/marketdata.check.mjs  Teammate A
  test/engine.test.mjs       Teammate B
  test/http.smoke.mjs        Lead
  public/index.html     Teammate C (frontend)
  public/styles.css     Teammate C
  public/app.js         Teammate C
  public/charts.js      Teammate C
  public/mock.js        Teammate C
  public/vendor/lightweight-charts.standalone.production.js  Lead 提供（勿改）
  data/state.json       runtime 生成（勿手工改）
  temp/                 临时脚本，交付前清空
```

**只写自己归属的文件。** 需要改别人的契约，先在任务里报告，不要直接改。

---

## 2. 符号格式（Symbol ID）

统一 `market:code`，小写 market，code 保留源站风格：

| market | code 示例 | 含义 | 币种 |
|---|---|---|---|
| `cn` | `sh600519` `sz000001` `sh000001` `bj430047` | A股（含指数，指数仅展示不可交易） | CNY |
| `hk` | `hk00700` | 港股 | HKD |
| `us` | `usAAPL` `usNVDA` `usSPY` | 美股 | USD |
| `fx` | `fx:EURUSD` `fx:USDJPY` `fx:XAUUSD` `fx:XAGUSD` | 外汇/金银 | 见 3.4 |
| `crypto` | `crypto:BTCUSDT` `crypto:ETHUSDT` | Binance 现货 | USDT |

**规范化规则**：一律以 `market:code` 为唯一真源（`cn:sh600519`、`hk:hk00700`、`us:usAAPL`、`fx:EURUSD`、`crypto:BTCUSDT`）。`parseSymbol()` 额外接受别名（`fx:fxEURUSD`、`whEURUSD`、`crypto:cryptoBTCUSDT`、裸 `BTCUSDT`），**但返回值里的 `symbol` 一定是规范化形式**。HTTP 层入库/入库前统一归一（watchlist、委托、持仓、提醒的 key 都用规范化形式），接口返回的 `quote.symbol` 也用规范化形式；`errors[].symbol` 回显请求时的原字符串。

`lib/symbols.mjs` 负责：解析/生成 symbol、映射各源代码（腾讯 `sh600519`、Binance `BTCUSDT`）、币种、market 元数据。

---

## 3. 数据结构

### 3.1 Quote

```js
{
  symbol: 'cn:sh600519',
  market: 'cn',
  code: '600519',
  name: '贵州茅台',
  currency: 'CNY',
  price: 1335.0,
  prevClose: 1318.49,
  open: 1311.84,
  high: 1343.88,
  low: 1310.0,
  change: 16.51,
  changePct: 1.25,
  volume: 57686,            // 股/手：A股为手，港美股为股，加密为基础币数量，fx 为 0
  amount: 7677216283,      // 成交额（原币种）
  bid: [{ price: 1335.0, size: 116 }],   // 0~5 档；无盘口时为空数组
  ask: [{ price: 1335.01, size: 2 }],
  ts: '2026-10-23T16:14:58+08:00',        // 行情时间，带时区
  stale: false,             // 行情过期（采集失败用缓存时 true）
  source: 'tencent',
  extra: {                  // 可选，前端只读展示
    limitUp: 1450.34, limitDown: 1186.64,   // A股涨跌停价，其它市场 null
    turnoverRate: 0.46, pe: 20.49, pb: 6.64, marketCap: 16688.59
  }
}
```

- 字段缺失用 `null`，不要缺键。
- 采集失败：返回上一次成功缓存的 quote，`stale: true`；缓存也没有则该 symbol 进 `errors`。

### 3.2 Bar

```js
{ t: '2026-10-21T00:00:00+08:00', o: 1331.88, h: 1331.98, l: 1302.36, c: 1309.69, v: 33514 }
```

### 3.3 各市场可用周期（`GET /api/markets` 返回）

| market | intervals |
|---|---|
| cn | `1m 5m 15m 30m 60m 1d 1w 1M` |
| hk | `1m 5m 15m 30m 60m 1d 1w 1M`（分钟线由当日分时聚合） |
| us | `1d 1w 1M`（分钟线若 Yahoo 可用则补 `1m 5m 15m 30m 60m`） |
| fx | `1d 1w 1M`（分钟线若 Yahoo 可用则补） |
| crypto | `1m 5m 15m 30m 1h 4h 1d 1w` |

缺失周期必须返回 400 `KLINE_INTERVAL_UNSUPPORTED`，前端按 markets 元数据渲染按钮。

### 3.4 币种与换算

- 账户基础币种默认 `CNY`；每个账户有独立的多币种现金账户 `cash: { CNY, HKD, USD, USDT }`。
- 权益折算用 `getFxRates()`，返回对 CNY 的汇率：`{ CNY: 1, USD: 7.x, HKD: 0.85x, USDT: 7.x }`。
- 外汇 symbol 的"币种"：`fxEURUSD`/`fxXAUUSD` 等一律以 **USD** 计价（EUR/USD 涨跌的盈亏以 USD 计）；`fxUSDCNY` 也按 USD 计价。UI 显示 `currency: 'USD'`。

---

## 4. `lib/marketdata.mjs` 对外接口（Teammate A 实现，Lead/B 按此调用）

```js
export async function getQuotes(symbols, options)   // options.maxAgeMs：覆盖默认 800ms 缓存（0=强制刷新），SSE 推流用
export async function getKline(symbol, interval, limit = 300) // -> { symbol, interval, bars: Bar[] }
export async function search(query, limit = 20) // -> [{ symbol, code, name, market, currency }]
export async function getUniverse(market, options) // -> { items:[{symbol,code,name,currency,price,changePct,amount}], source, updatedAt, note? }
export async function getFxRates()          // -> { CNY:1, USD:number, HKD:number, USDT:number }
export async function getMarkets()          // -> MARKET_META[]（含 intervals、sessions、可交易性）
export function getMarketMeta(market)       // -> 单个 market 元数据
export async function health()              // -> [{ source, ok, latencyMs, message }]
```

- `getQuotes` 必须**批量**：多 symbol 一次请求拿回，单次调用内部最多 2 个网络请求（腾讯批量 + Binance 批量）。
- 所有网络请求带 5s 超时、2 次重试、TTL 缓存（quotes 800ms，kline 依周期 5s~5min，fxRates 30s，markets 静态）。
- 国内源（腾讯）**直连**；境外源（Binance/CoinGecko/Yahoo）走 `config.json` 里的本地代理隧道，失败自动降级并标记 `health`。

---

## 5. `lib/engine.mjs` 对外接口（Teammate B 实现）

纯函数 + 可变 account 对象，不碰网络、不碰文件。`now` 一律显式传入（ISO 字符串或 Date）。

```js
export function createAccount({ id, name, initialCapital, baseCurrency = 'CNY' })
export function validateOrder(account, req, quote, { cfg, now })   // -> { ok, code?, message? }
export function calcFees(market, side, qty, price, cfg)            // -> { total, breakdown: {...} }
export function placeOrder(account, req, quote, { cfg, now })      // -> { order, fill|null, error|null }
export function tickAccount(account, quotesBySymbol, { cfg, now }) // 撮合挂单 -> { fills: [], orderUpdates: [] }
export function portfolioView(account, quotesBySymbol, fxRates, now) // -> 见 6.5 / 6A
export function rollDay(account, now)                              // T+1 日切
export function canTradeMarket(market, nowISO)                     // -> boolean
// v2（杠杆/保证金，见 §6A）
export function checkRisk(account, quotesBySymbol, fxRates, { cfg, now })
   // -> { liquidations:[...], triggered:[...], warnings:[{code,message,symbol?,riskRatio?}] }，直接改 account
export function setProtect(account, symbol, { takeProfit, stopLoss }, quote, cfg)
   // -> { ok, code?, message? }；空对象字段表示清除
export function amendOrder(account, orderId, { limitPrice }, quote, cfg, now)
   // -> { ok, code?, message?, order? }
export function setMarginMode(account, marginMode)
   // -> { ok, code?, message? }；有持仓/挂单时 MARGIN_MODE_LOCKED
```

`req`：`{ symbol, side: 'buy'|'sell', type: 'market'|'limit', qty, limitPrice }`

`cfg`（config.json 注入）：`{ fees: {...}, slippageBps: {...}, leverage: {...}, lots: {...}, sessions: {...} }`

### 5.1 `lib/store.mjs` / `lib/stats.mjs` 接口（Teammate B 实现）

```js
// store.mjs —— 唯一负责 data/ 落盘，原子写（写 .tmp 再 rename），内存态即真源
export function createStore({ dataDir })
store.load()                      // -> state（不存在则初始化默认 state）
store.state                       // 内存态
store.save()                      // 同步原子写
store.saveDebounced(ms = 300)     // 合并写
store.listAccounts()              // -> account[]
store.getAccount(id)              // -> account | null
store.addAccount(account)
store.removeAccount(id)           // -> boolean
store.replaceAccount(account)
store.getWatchlist()              // -> string[]
store.setWatchlist(symbols)
store.listAlerts() / store.addAlert(a) / store.removeAlert(id)
store.nextId(prefix)              // 生成唯一 id，如 'ord_1a2b3c'

// stats.mjs
export function computeStats(account)            // -> { tradeCount, winRate, profitFactor, avgWin, avgLoss,
                                                 //      maxDrawdown, sharpe, totalFees, byMarket:[...], bySymbol:[...] }
export function equitySeries(account, range, nowISO) // range: '1d'|'1w'|'1m'|'all' -> [{t, equity}]
```

`state` 形状：

```js
{
  version: 1,
  createdAt: 'ISO',
  accounts: {
    acc_xxx: {
      id, name, baseCurrency, initialCapital, createdAt,
      marginMode: 'isolated' | 'cross',        // v2，默认 isolated
      cash: { CNY: 0, HKD: 0, USD: 0, USDT: 0 },
      positions: { 'cn:sh600519': {
        symbol, market, name, currency,
        side: 'long'|'short', qty, avgCost,
        leverage, margin, debt, accruedInterest, lastInterestAt,   // v2
        takeProfit, stopLoss,                                      // v2，number|null
        todayBuyQty, todayBuyDate, openedAt
      } },
      orders: [ { id, symbol, market, name, side, type, qty, limitPrice, leverage, close,
                  takeProfit, stopLoss, status, filledQty, avgFillPrice,
                  fees, createdAt, updatedAt, rejectCode, rejectMessage, fills:[{t, qty, price, fees}] } ],
      trades: [ { id, orderId, symbol, market, name, side, qty, price, fees, realizedPnl, interest, t } ],
      liquidations: [ { t, symbol, side, qty, price, pnl, fees, reason } ],   // v2
      equityHistory: [ { t, equity } ],
      dayStartEquity: number,
      dayKey: 'YYYY-MM-DD',        // Asia/Shanghai 日期，用于日切
      realizedPnl: number,
      totalFees: number,
      totalInterest: number,       // v2
      conversions: [ { t, from, to, amountFrom, amountTo, rate, reason } ]
    }
  },
  watchlist: ['cn:sh600519'],
  alerts: [ { id, symbol, direction, price, createdAt, triggeredAt } ]
}
```

---

## 6. 交易规则（Teammate B 的验收标准，必须写进 `test/engine.test.mjs`）

### 6.1 市场规则

| market | 交易时段（本地时间） | 最小单位 | T+1 | 涨跌停 | 结算 |
|---|---|---|---|---|---|
| cn | 09:30–11:30, 13:00–15:00 Asia/Shanghai | 100 股整数倍 | **卖出只可用昨日及以前持仓** | 有（用 quote.extra.limitUp/Down） | 现金即时可用 |
| hk | 09:30–12:00, 13:00–16:00 Asia/Hong_Kong | 每手 lotSize 股：取 `quote.extra.lotSize`，缺失时取 `cfg.lots.hk`（默认 100） | 否（T+0） | 无 | 即时 |
| us | 09:30–16:00 America/New_York | 1 股 | 否（T+0） | 无 | 即时 |
| fx | 周一 05:00 – 周六 05:00 Asia/Shanghai，其余时间休市（每日 05:00–06:00 视为维护休市） | 最小 1 单位，支持小数 2 位 | 否 | 无 | 即时 |
| crypto | 7×24 | 最小按 Binance stepSize（默认 0.0001） | 否 | 无 | 即时 |

### 6.2 手续费（config.json 可改，默认值如下图；全部单向收费，买入卖出各算一次）

| market | commission | stampDuty | other | 说明 |
|---|---|---|---|---|
| cn | 0.025%，最低 5 CNY | 卖出 0.05% | 过户费 0.001%（双向） | 与真实券商接近 |
| hk | 0.025%，最低 100 HKD | 0.1% 双向 | 交易费 0.00565% + 结算费 0.002% | 粗略合计 |
| us | 0.005 USD/股，最低 1 USD | 无 | 卖出 SEC 费 0.00278% | |
| fx | 无佣金，用点差 | 无 | 见 6.3 | |
| crypto | 0.1% 双向 | 无 | 无 | |

### 6.3 成交价模型

- 有盘口：市价买入 = `ask[0].price`，卖出 = `bid[0].price`；无盘口：`price`。
- 再叠加滑点 `slippageBps`（默认 cn/hk/us 1bp，fx 2bp，crypto 3bp），买入向上、卖出向下。
- 限价单：价格可成交则按"更优价"成交（买入 `min(limit, ask)` 再叠加滑点，且不得劣于 limit；若加滑点后劣于 limit 则按 limit 成交）。不可成交则挂单。
- A股：成交价必须落在 `[limitDown, limitUp]` 内，超出则拒绝（`PRICE_LIMIT`）。涨停价买入、跌停价卖出视为流动性不足，拒绝（`NO_LIQUIDITY`）。
- 外汇：报价上下各加 `spreadBps/2`（默认 1.5bp）作为实际买卖价。
- 市场休市时：市价单拒绝 `MARKET_CLOSED`；限价单允许挂单（下一交易时段参与撮合）。

### 6.4 挂单撮合（`tickAccount`，服务器每 2s 调一次）

- 买入限价：`quote.price <= limitPrice` → 成交，成交价 `min(limitPrice, quote.price)`；卖出限价：`quote.price >= limitPrice` → 成交。
- 成交后扣现金/加持仓（含手续费）；现金不足或持仓不足时撤单（`INSUFFICIENT_CASH` / `INSUFFICIENT_POSITION`）。
- 挂单生命周期：`open` → `filled` / `cancelled` / `rejected`；带 `createdAt`、`updatedAt`。

### 6.5 持仓与权益

- 持仓平均成本：加仓加权平均，减仓成本不变；卖出实现盈亏 = `(卖价 - 均价) * qty - 手续费`。
- 持仓：`{ symbol, qty, availableQty, avgCost, market, name, currency, lastPrice, marketValue, unrealizedPnl, unrealizedPnlPct, todayPnl }`
- 权益 = Σ现金折算 + Σ持仓市值折算（按 fxRates 折 CNY）。
- 账户快照还包括 `dayStartEquity`（当日 00:00 权益，用于当日盈亏）、`todayPnl`、`totalPnl`、`totalPnlPct`。

### 6.6 资金校验与自动换汇

- 买入需要的现金 = `qty * fillPrice + 手续费`，必须在对应币种现金余额内（**不做融资**；fx 的杠杆字段保留但默认 1）。
- 卖出必须满足 `availableQty`（A股 T+1 未解锁部分不可卖）。
- **自动换汇**：下单/撮合时若目标币种现金不足，且调用方传入了 `fxRates`（对 CNY 汇率）且 `cfg.autoConvert !== false`，则从账户基础币种（默认 CNY）自动换入差额，换汇成本 `fxConvertSpread`（默认 0.3%）。换汇记录写入 `account.conversions`：`{ t, from, to, amountFrom, amountTo, rate, reason }`，仅用于审计展示。基础币种也不足时仍然拒绝 `INSUFFICIENT_CASH`。
- 因此 `placeOrder(account, req, quote, { cfg, now, fxRates })` 与 `tickAccount(account, quotesBySymbol, { cfg, now, fxRates })` 的 options 里都要接受 `fxRates`（缺省时不换汇）。

---

## 6A. 杠杆 / 保证金 / 做空（v2）

### 6A.1 能力范围

| market | 最大杠杆 `cfg.leverage` | 允许做空 | 维持保证金率 `cfg.margin.mmr` | 借币年化 `cfg.margin.interestAnnual` | 强平费 `cfg.margin.liquidationFeeRate` |
|---|---|---|---|---|---|
| cn | 1 | 否 | — | 0 | 0 |
| hk | 4 | 是 | 12.5% | 6% | 0.2% |
| us | 4 | 是 | 12.5% | 6% | 0.2% |
| fx | 100 | 是 | 0.5% | 3% | 0 |
| crypto | 20 | 是 | 0.5% | 8% | 0.5% |

> 维持保证金率必须显著低于 `1/maxLeverage`（初始保证金率），否则开仓即贴强平线：4x 时初始 25%、维持 12.5% 才有 12.5% 的安全垫；100x 时初始 1%、维持 0.5%。

- 杠杆默认 1（= 现货）。`leverage` 取 `[1, max]` 内整数/小数（crypto 支持 2/3/5/10/20，fx 支持 10/20/50/100；实现上只做范围校验，不限制档位）。
- A股（cn）恒为 1x、不可做空；对 cn 传 `leverage>1` 或开空 → `LEVERAGE_NOT_ALLOWED` / `SHORT_NOT_ALLOWED`。

### 6A.2 账户与持仓模型

账户（store state 内）新增：

```js
{
  marginMode: 'isolated' | 'cross',   // 默认 'isolated'
  totalInterest: 0,
  liquidations: [ { t, symbol, side, qty, price, pnl, fees, reason: 'LIQUIDATION'|'TAKE_PROFIT'|'STOP_LOSS' } ]
}
```

持仓（`account.positions[symbol]`，v2 结构，v1 字段保留兼容）：

```js
{
  symbol, market, name, currency,
  side: 'long' | 'short',
  qty,                    // 恒为正
  avgCost,                // 开仓均价
  leverage,               // 1..max
  margin,                 // 初始保证金（计价币种）
  debt,                   // 融资/借券金额（计价币种）= notional * (1 - 1/leverage)
  accruedInterest,        // 已计利息（计价币种），负债
  lastInterestAt,         // ISO
  takeProfit, stopLoss,   // number|null
  openedAt, todayBuyQty, todayBuyDate   // T+1 仍只用于 cn 现货多头
}
```

### 6A.3 资金与权益

- 开仓：从现金扣除 `初始保证金 = notional/leverage` 与手续费；`position.margin` 记账。杠杆部分不占用现金。
- 权益（CNY）`equity.total` = Σ现金折算 + Σ`margin`折算 + Σ未实现盈亏折算 − Σ`accruedInterest`折算。
- 利息：`debt` 按 `interestAnnual/8760` 每小时累计，每 tick 按 `now - lastInterestAt` 增量累计进 `accruedInterest`；平仓时从平仓所得中扣除。`account.totalInterest` 累计。
- 手续费：开/平仓均按 §6.2 市场费率对 `notional` 收取；强平额外收 `liquidationFeeRate * notional`。
- 账户级字段（portfolioView 返回）：`marginMode`、`marginUsed`（孤立模式=Σmargin；全仓=Σ维持保证金）、`marginAvailable`（=权益−marginUsed，注意权益已扣过利息，不要重复减）、`maintenanceMargin`（Σ notional*mmr）、`riskRatio`（孤立=按持仓聚合；全仓=maintenance/权益）、`equity.total`、`totalInterest`。

### 6A.4 委托语义（v2 扩展）

`POST /api/accounts/:id/orders` body 扩展：

```js
{
  symbol, side: 'buy'|'sell', type: 'market'|'limit', qty, limitPrice?,
  leverage?: number,        // 默认 1
  close?: boolean,          // true = 平仓单：只能减小/关闭现有持仓，qty 缺省=全部
  takeProfit?: number|null, // 开仓成功后写入持仓
  stopLoss?: number|null
}
```

规则：
- 无持仓时：`buy` 开多；`sell` 且 `leverage>1` 且市场允许做空 → 开空；`sell` 且杠杆=1 → `INSUFFICIENT_POSITION`。
- 已有同向持仓：加仓，按加权平均成本，追加保证金；杠杆必须与现有持仓一致（不一致 → `LEVERAGE_MISMATCH`）。
- 已有反向持仓且 `close !== true` → `POSITION_CONFLICT`（必须先平仓）。
- `close: true`：方向必须与持仓相反（多仓用 sell，空仓用 buy），`qty <= 持仓量`；平仓盈亏：多 `(价-均价)*qty`，空 `(均价-价)*qty`，再扣手续费与已计利息；部分平仓按比例结转 `margin` 与 `accruedInterest`。
- 保证金不足 → `INSUFFICIENT_MARGIN`（不再用 `INSUFFICIENT_CASH` 表示杠杆开仓资金不足；杠杆=1 现货仍用 `INSUFFICIENT_CASH`）。
- 限价挂单：开仓单需在成交时再校验保证金；平仓单成交时校验持仓仍存在。
- T+1 仍只限制 cn 多头现货的可卖数量；杠杆仓位与其它市场 T+0。

### 6A.5 强平 / 止盈止损

`checkRisk(account, quotesBySymbol, fxRates, { cfg, now })` 由服务端每 2s 调用一次，返回 `{ liquidations:[...], triggered:[...], warnings:[...] }`，并直接修改 account：

1. **孤立模式**：逐仓检查。持仓风险价值 `posEquity = margin + 未实现盈亏 - accruedInterest`；`maintenance = notional * mmr`。当 `posEquity <= maintenance` → 该仓位市价强平（收手续费 + 强平费），记录 `liquidations`。
2. **全仓模式**：`accountEquity = 权益`；`totalMaintenance = Σ maintenance`。当 `accountEquity <= totalMaintenance` → 按未实现亏损从大到小依次强平，直到 `accountEquity > totalMaintenance`（或全部平完）。
3. **止盈止损**：持仓上有 `takeProfit/stopLoss` 时逐 tick 判断（多：`price>=TP` 或 `price<=SL`；空：`price<=TP` 或 `price>=SL`）→ 市价平仓，reason 记 `TAKE_PROFIT`/`STOP_LOSS`。
4. 强平价 `liqPrice`（孤立模式，忽略利息近似）：
   - 多：`(avgCost*qty - margin) / (qty*(1-mmr))`
   - 空：`(avgCost*qty + margin) / (qty*(1+mmr))`
   - 全仓模式返回 `null`（由账户级风险统一管理）。
5. 风险率 `riskRatio`：孤立 = `maintenance / max(posEquity, eps)`；全仓 = `totalMaintenance / max(equity, eps)`。>0.8 时服务端在 `warnings` 里给中文提示（前端据此高亮/提醒）。

### 6A.6 挂单改价与仓位保护

- `PATCH /api/accounts/:id/orders/:orderId` body `{ limitPrice }`：仅 `status==='open'` 且 `type==='limit'` 可改；重新校验价格合法性与涨跌停；改价后保持 open。
- `POST /api/accounts/:id/positions/:symbol/protect` body `{ takeProfit?: number|null, stopLoss?: number|null }`：设置/清除持仓的止盈止损（价格方向必须合理：多仓 TP>现价>SL，空仓 TP<现价<SL，否则 `PROTECT_PRICE_INVALID`）。
- `PATCH /api/accounts/:id` body `{ marginMode }`：仅当账户无任何持仓且无未成交委托时可切换，否则 `MARGIN_MODE_LOCKED`。

---

## 7. REST API（Lead 在 server.mjs 实现）

所有响应 JSON。错误：HTTP 4xx/5xx + `{ "error": { "code": "XXX", "message": "中文说明" } }`。

```
GET  /api/health
   -> { ok, version, uptimeSec, serverTime, sources:[{source,ok,latencyMs,message}] }

GET  /api/markets
   -> { markets:[{ id, name, currency, tradeable, intervals, sessions:[{start,end,tz}] }] }

GET  /api/quotes?symbols=cn:sh600519,hk:00700
   -> { quotes:[Quote], errors:[{symbol,message}] }

GET  /api/stream?symbols=<可选,逗号分隔>
   SSE (text/event-stream)，服务端主动推送行情，替代前端 2 秒轮询。
   推送集合 = 全局 watchlist ∪ 全部账户的持仓/未成交委托 ∪ 本连接 symbols 参数。
   事件：
     event: quotes
     data: { quotes:[Quote], errors:[{symbol,message}], ts:'ISO' }
     event: heartbeat
     data: { ts:'ISO' }            // 每 15s 一次，兼作保活
   分级刷新：crypto 500ms、fx 1000ms、cn/hk/us 2000ms（见 config.refresh.stream）。
   连接建立后立即推一帧快照。客户端断开后服务端不得泄漏连接。
   前端在 EventSource 不可用/连续失败 >5s 时回退到 /api/quotes 轮询。

GET  /api/kline?symbol=cn:sh600519&interval=5m&limit=300
   -> { symbol, interval, bars:[Bar] }

GET  /api/search?q=茅台&limit=20
   -> { results:[{symbol,code,name,market,currency}] }

GET  /api/universe?market=cn|hk|us|fx|crypto&limit=100&sort=amount|change
   -> { market, items:[{symbol,code,name,currency,price,changePct,amount}], source, updatedAt, note? }
   全市场标的列表（用于「标的库」选择器）：
   - cn：新浪全市场排行（`Market_Center.getHQNodeData`，直连，分页，按成交额/涨跌幅排序）
   - hk：新浪港股列表（`getHKStockData`，直连）
   - us：Nasdaq screener（代理，全美股）→ Yahoo most_actives/day_gainers 兜底 → 内置精选列表
   - fx：12 个货币对 + 伦敦金/银，走批量报价
   - crypto：Binance 全量 USDT 交易对（代理，按成交额/涨跌幅排序），CoinGecko 兜底
   失败时返回内置精选列表 + `note` 说明原因，不得抛 500；缓存 60s。

GET  /api/watchlist
   -> { symbols:['cn:sh600519', ...] }
PUT  /api/watchlist   body { symbols:[...] } -> { symbols:[...] }

GET  /api/accounts    -> { accounts:[{id,name,baseCurrency,initialCapital,createdAt,marginMode}] }
POST /api/accounts    body { name, initialCapital, baseCurrency?, marginMode? } -> { account }
PATCH /api/accounts/:id  body { marginMode:'isolated'|'cross' } -> { account }   // 有持仓/挂单时 409 MARGIN_MODE_LOCKED
POST /api/accounts/:id/reset  body { initialCapital } -> { account }
DELETE /api/accounts/:id -> { ok:true }

GET  /api/accounts/:id
   -> { account:{id,name,baseCurrency,marginMode,...}, cash:{CNY,HKD,USD,USDT}, equity:{total,byMarket:{...}},
        positions:[{symbol,market,name,currency,side,qty,availableQty,avgCost,lastPrice,marketValue,
                    unrealizedPnl,unrealizedPnlPct,todayPnl,leverage,margin,liqPrice,riskRatio,
                    maintenanceMargin,accruedInterest,takeProfit,stopLoss,openedAt}],
        openOrders:[...], dayStartEquity, todayPnl, totalPnl, totalPnlPct, fxRates,
        marginUsed, marginAvailable, maintenanceMargin, riskRatio, totalInterest, liquidations:[...] }

POST /api/accounts/:id/orders  body { symbol, side, type, qty, limitPrice?,
                                      leverage?, close?, takeProfit?, stopLoss? }   // 见 §6A.4
   -> 201 { order, fill }        // fill 为 null 表示挂单
   -> 400 { error:{code,message} }

DELETE /api/accounts/:id/orders/:orderId -> { ok:true }
PATCH  /api/accounts/:id/orders/:orderId  body { limitPrice } -> { ok:true, order }   // 仅 open 的限价单
POST   /api/accounts/:id/positions/:symbol/protect  body { takeProfit?, stopLoss? } -> { ok:true, position }
GET  /api/accounts/:id/orders?status=all|open|filled|cancelled&limit=200 -> { orders:[] }
GET  /api/accounts/:id/trades?limit=200 -> { trades:[] }
GET  /api/accounts/:id/stats -> { tradeCount, winRate, profitFactor, avgWin, avgLoss,
                                 maxDrawdown, sharpe, totalFees, byMarket:{...}, bySymbol:[...] }
GET  /api/accounts/:id/equity?range=1d|1w|1m|all -> { points:[{t,equity}], stats:{...} }
GET  /api/accounts/:id/export/trades.csv -> text/csv（UTF-8 BOM，Excel 可直接打开）

GET  /api/alerts -> { alerts:[{id,symbol,direction,price,createdAt,triggeredAt}] }
POST /api/alerts body { symbol, direction:'above'|'below', price } -> { alert }
DELETE /api/alerts/:id -> { ok:true }

POST /api/dev/tick -> { ok:true }   // 强制撮合一次（测试用）
```

静态路由：`/` → `public/index.html`，`/vendor/...`、`/styles.css`、`/app.js`、`/charts.js`、`/mock.js` 直接映射 `public/`。`/api/*` 之外的未知路径返回 404。

---

## 8. 前端要求（Teammate C）

- 单页，深色主题，中文界面，响应式（≥1280 桌面为主，窄屏可用）。
- 顶部：账户选择/新建、总权益、当日盈亏、连接状态（数据源健康）。
- 主区：左侧自选列表（实时价+涨跌幅）；中间图表区（K 线 + 成交量 + MA5/10/20 + 分时切换 + 周期切换）；右侧下单面板（买/卖、市价/限价、数量、预估费用、可用资金/可卖数量）。
- 下方标签页：持仓 / 当前委托 / 历史委托 / 成交记录 / 账户统计 / 净值曲线。
- 图表用 `public/vendor/lightweight-charts.standalone.production.js`（v4 API：`LightweightCharts.createChart`、`chart.addCandlestickSeries()`）。
- 无后端时用 `public/mock.js`（`?mock=1` 启用）提供假数据自测，mock 形状必须与第 3、7 节完全一致。
- 每 2s 轮询 `/api/quotes` 与当前账户快照；图表按需刷新。
- 所有用户可见文案中文；金额千分位、涨跌红涨绿跌（A股习惯：涨红跌绿）。
- 下单失败用内联提示，不用 alert。
- **实时行情**：优先 `EventSource('/api/stream')`；失败或 >5s 无 `quotes` 帧时自动退回 2s `/api/quotes` 轮询并定期重连；页头显示「实时推送/轮询/离线」三态。
- **状态记忆**：localStorage 单 key `chimatrader.prefs.v1`，至少包含各市场 K 线周期、图表模式、当前标的、账户 id、底部标签页、新手提示开关、引导是否已看、最近查看（≤12）。
- **新手引导**：首次进入 4 步引导（可跳过/重看），顶栏「帮助」常驻；休市时下单面板要显示市场状态与原因。
- **标的库**：`GET /api/universe` 提供全市场列表，失败时不得白屏（缓存/自选+持仓兜底 + 提示条）。

---

## 9. 验收与自检

- `node test/engine.test.mjs`：Teammate B 写，`node:test`，覆盖 6.1–6.6 每条规则，**不联网**。
- `node test/marketdata.check.mjs`：Teammate A 写，联网检查每个源、每个市场至少 1 个 symbol 的报价与 K 线可用性。
- `node selfcheck.mjs`：Lead 写，串联两者 + 启动临时服务打 `/api/*` 冒烟（含下单→持仓→撤单流程），全绿才退出 0。
- 交付前：`temp/` 清空，`data/state.json` 不提交敏感内容（本来也没有）。

---

## 10. 硬性约束

1. 只用 Node 标准库，`node:fs/node:http/node:https/node:tls/node:net/node:test/node:crypto` 等。
2. 不写真实交易接口、不接入任何下单 API，仅公开行情只读接口。
3. 所有金额用 number（元/美元等），显示层做格式化；内部计算保留 float，不做定点数。
4. 时间统一 ISO 8601 带时区；服务端以 `Asia/Shanghai` 为展示基准。
5. 失败必须降级且可解释：网络异常 → 缓存/`stale:true`/HTTP 503 + 中文 message，禁止抛栈到前端。
