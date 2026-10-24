# 开发笔记 · 千亦所 ChimaTrader

> 记录开发中踩实的坑、验证过的接口和设计取舍，方便以后维护或复用。

## 1. 数据源（2026-10 实测）

### 1.1 国内：腾讯行情（直连，无需代理，GBK）

| 用途 | 接口 | 备注 |
|---|---|---|
| 批量报价 | `https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL,whEURUSD` | 一次多标的；返回 `v_<code>="f0~f1~...";` |
| 日/周/月 K | `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,<start>,<end>,<limit>,qfq` | 键名 `qfqday`/`qfqweek`/`qfqmonth`，也可能是 `day` |
| A股分钟 K | `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m5,,<limit>` | `m1/m5/m15/m30/m60`；**港股/美股该接口为空** |
| 分时 | `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh600519` | 港股可用；美股只有 1 个点 |
| 搜索 | `https://smartbox.gtimg.cn/s3/?v=2&q=<urlencode>&t=all` | GBK，`v_hint="..."`，记录 `^` 分隔、字段 `~` 分隔 |

字段结论（均与 K 线交叉验证过）：

- **A 股**：1 名称、2 代码、3 现价、4 昨收、5 今开、6 量(手)、9–18 买五档（价,量交替）、19–28 卖五档、30 时间、31 涨跌、32 涨跌幅、33 高、34 低、36 量、37 额、38 换手、39 PE、43 振幅、44 流通市值、45 总市值、46 PB、47 涨停、48 跌停、51 均价。
- **港股**：0=`100`、1 名称、2 代码、3 现价、4 昨收、5 今开、6 量(股)、9–18/19–28 五档、30 时间、31/32 涨跌/幅、33/34 高低、37 成交额(HKD 原值)、39 PE、43 振幅、45 总市值、**60=每手股数**、75=`HKD`。
- **美股**：1 名称、2 代码(`AAPL.OQ`)、3/4/5/6 同 A 股、**盘口只有一档：9/10 买一、19/20 卖一**、30 时间(纽约)、35 币种、37 成交额、39 PE、45 总市值(亿美元)。
- **外汇 `wh*`**：**6=昨收、7=今开**（容易搞反，用 `12 = price - 6` 验证）、8/9 高低、5 时间、21 日期、10 重复现价。可用代码：`whEURUSD whGBPUSD whUSDJPY whAUDUSD whUSDCAD whUSDCHF whNZDUSD whEURJPY whGBPJPY whEURGBP whUSDCNY whHKDCNY`。
- **金银 `hf_XAU` / `hf_XAG`**：逗号分隔，`0 现价, 1 涨跌幅(相对开盘), 4 高, 5 低, 6 时间, 7 开, 8 昨收, 12 日期, 13 名称`。

**两个坏掉的源**：腾讯的**美股 K 线不可用**（day 只回 2 根、含 2011 锚点，week/month 各 1 根）；腾讯**没有任何金银 K 线**（fqkline/mkline/minute 全空）。

### 1.2 境外（需本地代理）

- **Binance**：`/api/v3/ticker/24hr?symbols=[...]`、`/api/v3/klines`、`/api/v3/exchangeInfo`（取 `LOT_SIZE.stepSize`、`PRICE_FILTER.tickSize`）。币安现货 24h ticker 里 `prevClosePrice` 可当昨收。
- **Yahoo**：`query1.finance.yahoo.com/v8/finance/chart/<sym>?range=&interval=`，美股/港/外汇分钟 K 线的兜底；`1m` 只能取 7 天、`5m` 60 天。
- **CoinGecko**：`simple/price` 加密报价兜底（免费额度容易 429）。
- **新浪现货**：`stock2.finance.sina.com.cn` 金银日线，国内直连，**GBK + 必须带 Referer**。
- **东方财富**：`push2.eastmoney.com` 能覆盖 A/港/美/外汇且批量接口很稳，但 `push2his`/单标的接口实测会**间歇性掐连接**，不适合做主力，只能备用。

### 1.3 代理

开发机系统代理在 `127.0.0.1:65532`（IE/WinINET 设置）。Node 原生 `fetch` **不会**读系统代理，直接访问境外会超时。可行做法：用 `net.connect` 到代理，发 `CONNECT host:443`，拿到 200 后 `tls.connect({socket, servername})`，再手写 HTTP GET（`Connection: close`）。实测 Binance/CoinGecko/Yahoo 全部可用。

判断是否走代理：同一域名先试直连、失败换代理，结果按 host 缓存 10 分钟；代理整个挂掉时做 30 秒熔断，避免拖慢 2 秒轮询。

## 2. 设计取舍

- **符号规范化**：`market:code` 是唯一真源（`cn:sh600519`、`hk:hk00700`、`us:usAAPL`、`fx:EURUSD`、`crypto:BTCUSDT`）。别名（`fx:fxEURUSD`、`whEURUSD`、`crypto:cryptoBTCUSDT`、裸 `BTCUSDT`）只在入口归一，绝不入库。两端各写一份解析是踩坑源头，后来强制 engine 复用 `symbols.mjs`。
- **自动换汇**：单币种入金（CNY）后港美/加密账户没余额，一开始下单直接被拒。后来在引擎里做「买入时从基础币种补差额」，并给前端一个 `buyingPower` 字段（服务端算好的可买力，含 0.3% 换汇成本），前端不再自己猜。
- **陈旧行情门禁**：没有节假日日历，`canTradeMarket` 在 A 股长假时仍认为开市。补一条「行情时间戳超过 10 分钟就拒绝市价成交、不参与挂单撮合」的规则，节假日问题被自然覆盖。
- **持久化时机**：撮合是 2 秒循环、行情标记高频变化，用 300ms 合并写盘；但**成交/撤单必须同步写盘**——否则强制结束进程会丢成交（实测 Windows 上 `child.kill()` 不会触发 SIGTERM 处理器）。
- **启动引导**：`normalizeState()` 会丢弃未知顶层字段，`bootstrapped` 标记存不住，导致每次重启多出一个「默认账户」。改成「state 里没有任何账户时才创建默认账户」。
- **图表**：直接用 TradingView `lightweight-charts` v4.2 UMD（Apache-2.0，文件头保留版权声明），本地 `public/vendor/` 引入，无 CDN、无构建。

## 3. 验证手段

- 离线单测：`node:test`，33 例覆盖 T+1、涨跌停、手续费、滑点、限价撮合、多币种、日切、store 原子写。
- 联网自检：约 50 项，逐市场检查报价/日 K/可用分钟线/搜索/汇率/错误语义；腾讯必须 PASS，境外源失败记 WARN。
- HTTP 冒烟：自己拉起真实进程，打全部 REST 接口，含「下单→持仓→成交→撤单」闭环。
- UI 端到端：用 Edge `--headless=new --remote-debugging-port` + CDP（Node 22 内置 WebSocket），真实点击完成「选标的→读图→下单→持仓→切标签」，并抓 console error。
  - 复用点：CDP 的 `Runtime.evaluate` + `Page.captureScreenshot` 足够做轻量 E2E，不需要 Playwright。
  - 坑：`--virtual-time-budget` 截图会与 fetch 竞争，交互测试要用真实的 `sleep` + `data-app-ready` 标志。

## 4. 值得记住的 bug

- 前端把图表周期函数命名为 `setInterval`，把全局定时器遮蔽了 → 2 秒轮询从未启动，报价不刷新。改名为 `setChartInterval`。
- 服务端容器名 `app/assets` 之类无所谓，但**路由里 `url.pathname.split('/')` 的下标很容易错**：`/api/accounts/<id>` 的 id 是第 3 段（0 是空串），写成第 2 段会把 `accounts` 当 id，报 404。
- 数据层 `getQuotes` 一开始按请求原文回显 `quote.symbol`，而引擎按规范 key 建仓 → 持仓查不到。统一成「返回规范形式，errors 回显原文」。
- `store.load()` 后把 `state` 当只读用的约定要写死：所有变更都走 store 方法或明确 `save()`，否则「哪些改动落了盘」会失控。

## 5. 可复用结论

- 一个本地交易的完整闭环 = 行情适配层（多源 + 降级 + 缓存）+ 纯函数撮合引擎（时间/费用/规则可测）+ JSON 原子存储 + 静态 SPA + 自检脚本，可以完全不依赖 npm 生态。
- 腾讯 `qt.gtimg.cn` 是国内做 A/港/美/外汇行情的性价比首选：一个批量接口、免费、无 Key、中文名、五档盘口齐全；缺点是字段位置要靠交叉验证确定、美股 K 线与金银 K 线缺失。
- 做「绑定真实行情」的产品，最值得先验证的是**网络路径**（直连/代理/限流/字段），而不是先把界面铺开。

## 6. 实时推送（SSE）设计

- 服务端一个 500ms 基础 tick：crypto 每 tick 拉一次（Binance），fx 每 2 tick（1s，腾讯 `wh*`），股票每 4 tick（2s，腾讯批量）。按市场分级而不是统一 2s，是因为加密/外汇源本身高频、股票盘口变化慢。
- 推送集合 = 全局 watchlist ∪ 所有账户持仓/挂单 ∪ 客户端 `symbols` 参数。这样自选一改、一持仓，流的覆盖范围自动跟着变，前端不用重连。
- 为了突破 `marketdata.getQuotes` 的 800ms 缓存，给它加了 `options.maxAgeMs`（0 = 强制刷新）；流循环传 0，普通接口保持默认缓存。
- 广播只在「本次确实拉到新数据」时发生；没有客户端时循环直接跳过，不去打数据源。
- 前端用 EventSource，失败/5s 无帧自动切回轮询，并每 5s 尝试重连——SSE 不是可靠性设施，只是加速层，任何情况都必须能退回轮询。

## 7. 全市场列表（标的库）

| 市场 | 源 | 说明 |
|---|---|---|
| A股 | 新浪 `Market_Center.getHQNodeData?node=hs_a` | 分页 100/页，GBK JSON，按成交额/涨跌幅排序，直连稳定 |
| 港股 | 新浪 `getHKStockData?node=qbgg_hk` | 60/页，**分页要并发**（串行 5 页要 7s，并发后 1.5s） |
| 美股 | Nasdaq screener（代理） | 一次拉全表 6978 行本地排序；`download=true` 才有 volume；过滤 warrant/unit/right/preferred 要**按词边界**，否则会误杀 UnitedHealth |
| 外汇 | 腾讯批量报价 | 12 对 + XAU/XAG，固定顺序 |
| 加密 | Binance `/ticker/24hr` | 全量 700+ USDT 对，**必须剔除稳定币 base**（USDC/FDUSD/…），否则成交额榜前排全是稳定币 |

- 回落链：实时源 → 内置精选（61/39/61 只，用报价层补价格）→ 24h 内存快照 → 空列表 + 中文 note。任何情况都返回 200，不抛 500。
- 美股名称可以借腾讯批量报价中文化（`usAAPL` → 苹果），一次请求覆盖前 80 条，拿不到就保留英文截断。

## 8. 前端状态与记忆

- 单 key `chimatrader.prefs.v1` 存：各市场周期、图表模式、当前标的、账户、底部标签、新手提示开关、引导已看、最近查看、**各市场杠杆倍数**。写入用 try/catch 包住（隐私模式下 localStorage 可能抛异常）。
- 引导用「CSS 遮罩 + spotlight 高亮」实现，不依赖图片或第三方库；`onboardingSeen` 与 `newbieHints` 分开，用户可关提示但保留引导标记。
- 休市状态不要只判断时间：`sessions` 只说明“理论上开市”，真实开市要看 `quote.ts` 是否新鲜（节假日会被这一条兜住）。
- SSE 推送下不要整表重绘：自选行、持仓行按 symbol 做局部更新，图表只 `series.update()` 最后一根，否则 500ms 帧率下会卡。
- 「平仓」按钮不要直接市价平：先在下单面板预填平仓单（数量=可平、方向=反向），让用户确认价格/类型再提交。既有确认感，也避免误触一键清仓。

## 9. 杠杆/保证金（v2）的坑

1. **维持保证金率不能等于 1/最大杠杆**。4x 时初始保证金 25%，如果维持保证金也是 25%，开仓瞬间就贴强平线，第一个不利 tick 就被强平。正确取值约 `1/(2*maxLeverage)`：hk/us 4x → 12.5%，fx 100x → 0.5%。crypto 20x 的 0.5% 天然有 4.5% 安全垫，是对的。
2. **权益里已经减过利息，`可用保证金` 不要再减一次**。`marginAvailable = equity - marginUsed`，重复减会让数字对不上（差得很小但会困惑）。
3. **现货仓位不能参与维持保证金计算**：A 股 mmr=1，如果不做「杠杆仓才纳入风险计算」的豁免，第一次 tick 就会把所有 A 股持仓强平。
4. **杠杆仓的反向单必须显式平仓**（`close:true`），不能像现货那样默认隐式平掉，否则加仓/试单容易误平。现货保持旧语义兼容 v1。
5. **强平只在开市且行情新鲜时执行**，成交价走标准市价模型（盘口+滑点），且不能被 A 股涨跌停的 `PRICE_LIMIT` 挡住（强平是风控动作）。
6. **利息存到持仓上**（`interestAnnual`），`accrueInterest` 就不需要 cfg 参数；按 `lastInterestAt` 增量累计，重复调用幂等（测试用精确数值断言 1.18391671）。
7. **store 的 normalize 必须保留 v2 字段**并对 v1 老存档补默认值，否则重启后 margin/leverage 全丢（这个坑和之前 `bootstrapped` 字段被丢掉是同一类）。
8. 前端做保证金预览时，强平价公式要与后端完全一致（多：`(avg-margin/qty)/(1-mmr)`，空：`(avg+margin/qty)/(1+mmr)`），否则用户看到的强平线和真实触发点不一致。
