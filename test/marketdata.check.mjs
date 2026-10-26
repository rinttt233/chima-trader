// test/marketdata.check.mjs — online self-check for the market data layer.
//
// Run: node test/marketdata.check.mjs
//
// Prints PASS / WARN / FAIL per market and source. Exit code 1 when a mandatory
// (Tencent backed) check fails. Checks that depend on foreign sources (Binance /
// CoinGecko / Yahoo) only WARN when the proxy is unreachable, as agreed in the
// integration contract.

import {
  getQuotes,
  getKline,
  search,
  getUniverse,
  getFxRates,
  getFxCurrencies,
  getMarkets,
  getMarketMeta,
  health,
  _resetCacheForTest,
  MarketDataError,
} from '../lib/marketdata.mjs';
import { parseSymbol } from '../lib/symbols.mjs';
import { probeProxy, configureProxy } from '../lib/net.mjs';
import { CRYPTO_STABLECOIN_BASES } from '../lib/sources/universe.mjs';

const startedAt = Date.now();
const counts = { PASS: 0, WARN: 0, FAIL: 0 };
const failures = [];

function record(status, label, detail) {
  counts[status] += 1;
  if (status === 'FAIL') failures.push(`${label}：${detail || ''}`);
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`[${status}] ${label}${suffix}`);
}

async function check(label, task, { optional = false, retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const detail = await task();
      record('PASS', label, typeof detail === 'string' ? detail : undefined);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Foreign endpoints occasionally answer 403/429 under bursts; retry once
        // before deciding so a transient hiccup does not fail the whole check.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  record(optional ? 'WARN' : 'FAIL', label, lastError?.message || String(lastError));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const QUOTE_KEYS = [
  'symbol', 'market', 'code', 'name', 'currency', 'price', 'prevClose', 'open', 'high', 'low',
  'change', 'changePct', 'volume', 'amount', 'bid', 'ask', 'ts', 'stale', 'source', 'extra',
];
const EXTRA_KEYS = ['limitUp', 'limitDown', 'lotSize', 'turnoverRate', 'pe', 'pb', 'marketCap'];
const BAR_KEYS = ['t', 'o', 'h', 'l', 'c', 'v'];
const SEARCH_KEYS = ['symbol', 'code', 'name', 'market', 'currency'];

function validateQuote(quote, { market, requirePriceBook = false } = {}) {
  assert(quote && typeof quote === 'object', '行情对象不存在');
  for (const key of QUOTE_KEYS) {
    assert(Object.hasOwn(quote, key), `Quote 缺少字段 ${key}`);
  }
  for (const key of EXTRA_KEYS) {
    assert(Object.hasOwn(quote.extra, key), `Quote.extra 缺少字段 ${key}`);
  }
  assert(Number.isFinite(quote.price) && quote.price > 0, `价格非法：${quote.price}`);
  assert(typeof quote.name === 'string' && quote.name.length > 0, '缺少名称');
  assert(Number.isFinite(Date.parse(quote.ts)), `行情时间非法：${quote.ts}`);
  assert(Array.isArray(quote.bid) && Array.isArray(quote.ask), '盘口不是数组');
  for (const level of [...quote.bid, ...quote.ask]) {
    assert(Number.isFinite(level.price) && level.price > 0, '盘口价格非法');
    assert(Number.isFinite(level.size) && level.size > 0, '盘口数量非法');
  }
  assert(quote.stale === false, 'stale 标记异常');
  assert(typeof quote.source === 'string' && quote.source.length > 0, '缺少数据源');
  if (market) assert(quote.market === market, `市场不符：${quote.market} != ${market}`);
  if (requirePriceBook) assert(quote.bid.length > 0 && quote.ask.length > 0, '盘口为空');
}

function validateBars(bars, label) {
  assert(Array.isArray(bars) && bars.length >= 2, `${label} K 线数量不足（${bars?.length ?? 0}）`);
  let previous = -Infinity;
  bars.forEach((bar, index) => {
    assert(bar && typeof bar === 'object', `${label} 第 ${index} 根 K 线为空`);
    for (const key of BAR_KEYS) {
      assert(Object.hasOwn(bar, key), `${label} 第 ${index} 根缺少字段 ${key}`);
    }
    for (const key of ['o', 'h', 'l', 'c', 'v']) {
      assert(Number.isFinite(bar[key]), `${label} 第 ${index} 根 ${key} 非法：${bar[key]}`);
    }
    const epoch = Date.parse(bar.t);
    assert(Number.isFinite(epoch), `${label} 第 ${index} 根时间非法：${bar.t}`);
    assert(epoch > previous, `${label} 时间未按升序排列`);
    previous = epoch;
    assert(bar.h >= bar.l, `${label} 第 ${index} 根 high < low`);
    assert(bar.h >= Math.max(bar.o, bar.c) - 1e-9, `${label} 第 ${index} 根 high 低于开收盘价`);
    assert(bar.l <= Math.min(bar.o, bar.c) + 1e-9, `${label} 第 ${index} 根 low 高于开收盘价`);
  });
}

function validateSearchResults(results) {
  assert(Array.isArray(results), '搜索结果不是数组');
  for (const item of results) {
    for (const key of SEARCH_KEYS) assert(Object.hasOwn(item, key), `搜索结果缺少字段 ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('千亦所 ChimaTrader 行情数据层自检');
  console.log(`时间：${new Date().toISOString()}，Node ${process.version}`);
  console.log('');

  const proxy = await probeProxy(1500);
  console.log(`代理状态：${proxy.ok ? '可用' : '不可用'} — ${proxy.message}`);
  console.log('');

  // ---- data source health --------------------------------------------------
  console.log('== 数据源健康 (health) ==');
  const healthEntries = await health();
  await check('health 返回结构', async () => {
    assert(Array.isArray(healthEntries) && healthEntries.length > 0, 'health 返回为空');
    for (const entry of healthEntries) {
      assert(typeof entry.source === 'string' && entry.source.length > 0, 'health 条目缺少 source');
      assert(typeof entry.ok === 'boolean', `health(${entry.source}) ok 不是布尔值`);
      assert(entry.latencyMs === null || Number.isFinite(entry.latencyMs), `health(${entry.source}) latencyMs 非法`);
      assert(typeof entry.message === 'string' && entry.message.length > 0, `health(${entry.source}) 缺少中文说明`);
      const expectedCritical = ['tencent', 'tencent-fx', 'binance', 'sina'].includes(entry.source);
      assert(entry.critical === expectedCritical, `health(${entry.source}) critical 应为 ${expectedCritical}`);
      assert(
        Array.isArray(entry.markets) && entry.markets.every((market) => ['cn', 'hk', 'us', 'fx', 'crypto'].includes(market)),
        `health(${entry.source}) markets 非法`,
      );
      assert(typeof entry.hint === 'string' && entry.hint.length > 0, `health(${entry.source}) 缺少 hint`);
    }
    return `共 ${healthEntries.length} 个数据源（含 critical/markets/hint）`;
  });
  const healthBySource = Object.fromEntries(healthEntries.map((entry) => [entry.source, entry]));
  for (const source of ['tencent', 'tencent-fx', 'binance', 'coingecko', 'yahoo', 'sina']) {
    const entry = healthBySource[source];
    await check(`health(${source})`, async () => {
      assert(entry, `health() 缺少 ${source} 条目`);
      assert(entry.ok, entry.message);
      return entry.message;
    }, { optional: source === 'coingecko' || source === 'yahoo' || source === 'sina' });
  }
  const tencentOk = healthBySource.tencent?.ok === true;
  const yahooOk = healthBySource.yahoo?.ok === true;
  const binanceOk = healthBySource.binance?.ok === true;
  const coingeckoOk = healthBySource.coingecko?.ok === true;
  const sinaOk = healthBySource.sina?.ok === true;
  const cryptoAvailable = binanceOk || coingeckoOk;
  const minuteAvailable = yahooOk;
  const metalAvailable = sinaOk || yahooOk;
  if (!proxy.ok) {
    console.log('[WARN] 本地代理不可达：境外行情源按契约降级（WARN），腾讯相关源仍必须通过');
  }
  console.log('');

  // ---- symbol parsing (offline) -------------------------------------------
  console.log('== 符号解析 (parseSymbol) ==');
  const symbolCases = [
    ['cn:sh600519', 'cn:sh600519'],
    ['sh600519', 'cn:sh600519'],
    ['600519', 'cn:sh600519'],
    ['hk:00700', 'hk:hk00700'],
    ['hk00700', 'hk:hk00700'],
    ['us:AAPL', 'us:usAAPL'],
    ['usAAPL', 'us:usAAPL'],
    ['us:aapl.oq', 'us:usAAPL'],
    ['fx:fxEURUSD', 'fx:EURUSD'],
    ['fx:EURUSD', 'fx:EURUSD'],
    ['whEURUSD', 'fx:EURUSD'],
    ['fx:fxXAUUSD', 'fx:XAUUSD'],
    ['hf_XAU', 'fx:XAUUSD'],
    ['fx:EURJPY', 'fx:EURJPY'],
    ['eurjpy', 'fx:EURJPY'],
    ['fx:EUR/JPY', 'fx:EURJPY'],
    ['fx:CADJPY', 'fx:CADJPY'],
    ['fx:USDHKD', 'fx:USDHKD'],
    ['fx:CNYJPY', 'fx:CNYJPY'],
    ['crypto:cryptoBTCUSDT', 'crypto:BTCUSDT'],
    ['crypto:BTCUSDT', 'crypto:BTCUSDT'],
    ['BTCUSDT', 'crypto:BTCUSDT'],
  ];
  await check(`规范化 market:code（${symbolCases.length} 个写法）`, async () => {
    const bad = [];
    for (const [input, expected] of symbolCases) {
      try {
        const parsed = parseSymbol(input);
        if (parsed.symbol !== expected) bad.push(`${input} -> ${parsed.symbol}（期望 ${expected}）`);
      } catch (err) {
        bad.push(`${input} 抛错：${err.message}`);
      }
    }
    assert(bad.length === 0, bad.join('；'));
    return '全部通过';
  });
  await check('非法代码抛中文错误', async () => {
    for (const input of ['', 'xx:foo', 'hk:abc', 'fx:EURO', 'fx:EUREUR', 'fx:XYZUSD', 'fx:EUR']) {
      let threw = false;
      try {
        parseSymbol(input);
      } catch (err) {
        threw = true;
        assert(/[\u4e00-\u9fff]/.test(err.message), `错误信息不是中文：${err.message}`);
      }
      assert(threw, `${input || '(空串)'} 未抛错`);
    }
    return '全部抛错';
  });
  await check('fx 任意货币对解析字段', async () => {
    const eurjpy = parseSymbol('fx:EURJPY');
    assert(eurjpy.baseCurrency === 'EUR' && eurjpy.quoteCurrency === 'JPY', 'EURJPY base/quote 不符');
    assert(eurjpy.currency === 'JPY', 'EURJPY 币种应为 quote 币种 JPY');
    assert(eurjpy.name === '欧元/日元', `EURJPY 名称不符：${eurjpy.name}`);
    const cadjpy = parseSymbol('fx:CADJPY');
    assert(cadjpy.cross === true, 'CADJPY 应标记为合成对');
    assert(cadjpy.tencentCode === null, 'CADJPY 不应有腾讯代码');
    assert(cadjpy.currency === 'JPY' && cadjpy.baseCurrency === 'CAD', 'CADJPY 币种字段不符');
    const usdhkd = parseSymbol('fx:USDHKD');
    assert(usdhkd.currency === 'HKD' && usdhkd.quoteCurrency === 'HKD', 'USDHKD quote 币种应为 HKD');
    const gold = parseSymbol('fx:XAUUSD');
    assert(gold.baseCurrency === 'XAU' && gold.quoteCurrency === 'USD', 'XAUUSD base/quote 不符');
    return `EURJPY=${eurjpy.name}；CADJPY cross=${cadjpy.cross}；USDHKD currency=${usdhkd.currency}`;
  });
  console.log('');

  // ---- market metadata -----------------------------------------------------
  console.log('== 市场元数据 (markets) ==');
  const markets = await getMarkets();
  await check('getMarkets 结构', async () => {
    assert(Array.isArray(markets) && markets.length === 5, `市场数量异常：${markets?.length}`);
    for (const market of markets) {
      assert(typeof market.id === 'string', '缺少市场 id');
      assert(typeof market.name === 'string' && market.name.length > 0, `${market.id} 缺少中文名`);
      assert(typeof market.currency === 'string', `${market.id} 缺少币种`);
      assert(typeof market.tradeable === 'boolean', `${market.id} 缺少 tradeable`);
      assert(Array.isArray(market.intervals) && market.intervals.length > 0, `${market.id} 缺少 intervals`);
      assert(Array.isArray(market.sessions), `${market.id} 缺少 sessions`);
      for (const session of market.sessions) {
        assert(typeof session.start === 'string' && typeof session.end === 'string' && typeof session.tz === 'string',
          `${market.id} session 结构非法`);
      }
    }
    const byId = Object.fromEntries(markets.map((market) => [market.id, market]));
    assert(byId.cn.intervals.join(' ') === '1m 5m 15m 30m 60m 1d 1w 1M', 'cn intervals 不符');
    assert(byId.crypto.intervals.join(' ') === '1m 5m 15m 30m 1h 4h 1d 1w', 'crypto intervals 不符');
    assert(byId.fx.sessions.length === 2, 'fx sessions 应为 2 段');
    assert(byId.crypto.sessions.length === 1, 'crypto sessions 应为 1 段');
    return `cn/hk/us/fx/crypto；us 分钟线${minuteAvailable ? '可用' : '不可用（Yahoo 不可达）'}`;
  });
  await check('getMarketMeta 同步接口', async () => {
    const cn = getMarketMeta('cn');
    assert(cn && cn.id === 'cn' && Array.isArray(cn.intervals), 'getMarketMeta(cn) 异常');
    assert(getMarketMeta('nope') === null, '未知市场应返回 null');
    return `cn 支持 ${cn.intervals.length} 个周期`;
  });
  console.log('');

  // ---- universe (全市场标的库) ---------------------------------------------
  console.log('== 全市场列表 (universe) ==');
  const UNIVERSE_CURRENCY = { cn: 'CNY', hk: 'HKD', us: 'USD', fx: 'USD', crypto: 'USDT' };
  const UNIVERSE_LIVE_SOURCES = { us: ['nasdaq', 'yahoo'], crypto: ['binance'] };
  const universeCases = [
    ['cn', 'amount', true],
    ['cn', 'change', true],
    ['hk', 'amount', true],
    ['hk', 'change', true],
    ['fx', 'amount', true],
    ['fx', 'change', true],
    ['us', 'amount', false],
    ['us', 'change', false],
    ['crypto', 'amount', false],
    ['crypto', 'change', false],
  ];
  for (const [market, sort, required] of universeCases) {
    const label = `[${market}] 标的库 sort=${sort}`;
    try {
      const result = await getUniverse(market, { limit: 10, sort });
      assert(Array.isArray(result.items), 'items 不是数组');
      assert(result.items.length >= 5, `条目不足 5 条（${result.items.length}）`);
      assert(result.items.length <= 10, `超出 limit（${result.items.length}）`);
      assert(typeof result.source === 'string' && result.source.length > 0, '缺少 source');
      assert(Number.isFinite(Date.parse(result.updatedAt)), `updatedAt 非法：${result.updatedAt}`);
      if (result.note !== undefined) assert(typeof result.note === 'string' && result.note.length > 0, 'note 不是字符串');
      for (const item of result.items) {
        for (const key of ['symbol', 'code', 'name', 'currency', 'price', 'changePct', 'amount']) {
          assert(Object.hasOwn(item, key), `item 缺少字段 ${key}`);
        }
        assert(item.symbol.startsWith(`${market}:`), `symbol 前缀不符：${item.symbol}`);
        assert(parseSymbol(item.symbol).symbol === item.symbol, `symbol 未规范化：${item.symbol}`);
        assert(typeof item.code === 'string' && item.code.length > 0, 'code 为空');
        assert(typeof item.name === 'string' && item.name.length > 0, `name 为空（${item.symbol}）`);
        const expectedCurrency = market === 'fx' ? parseSymbol(item.symbol).currency : UNIVERSE_CURRENCY[market];
        assert(item.currency === expectedCurrency, `currency 不符：${item.currency}`);
        assert(Number.isFinite(item.price) && item.price > 0, `price 非法：${item.price}`);
        assert(Number.isFinite(item.amount) && item.amount >= 0, `amount 非法：${item.amount}`);
        assert(item.changePct === null || Number.isFinite(item.changePct), `changePct 非法：${item.changePct}`);
      }
      const field = sort === 'change' ? 'changePct' : 'amount';
      for (let index = 1; index < result.items.length; index += 1) {
        const previous = Number.isFinite(result.items[index - 1][field]) ? result.items[index - 1][field] : -Infinity;
        const current = Number.isFinite(result.items[index][field]) ? result.items[index][field] : -Infinity;
        assert(previous >= current, `未按 ${field} 降序（第 ${index} 条）`);
      }
      if (market === 'crypto') {
        const broad = await getUniverse('crypto', { limit: 300, sort });
        const stablecoins = broad.items.filter((item) =>
          CRYPTO_STABLECOIN_BASES.has(item.code.replace(/USDT$/, '')),
        );
        assert(
          stablecoins.length === 0,
          `稳定币未过滤：${stablecoins.slice(0, 5).map((item) => item.symbol).join(',')}`,
        );
      }
      if (market === 'us') {
        const noise = /\b(warrants?|units?|rights?|preferred|depositary shares?)\b/i;
        const noisy = result.items.filter((item) => noise.test(item.name));
        assert(noisy.length === 0, `脚本类标的未过滤：${noisy.slice(0, 3).map((item) => item.name).join('；')}`);
        assert(result.items.every((item) => item.name.length <= 40), '美股名称未截断到 40 字符');
      }
      const sample = result.items[0];
      const detail = `${result.items.length} 条 source=${result.source} 首条=${sample.symbol} ${sample.name} price=${sample.price} chg%=${sample.changePct} amount=${sample.amount}` +
        (result.note ? ` note=${result.note}` : '');
      const liveSources = UNIVERSE_LIVE_SOURCES[market];
      if (liveSources && !liveSources.includes(result.source)) {
        record('WARN', label, `${detail}（实时源不可用，已降级）`);
      } else {
        record('PASS', label, detail);
      }
    } catch (err) {
      record(required ? 'FAIL' : 'WARN', label, err?.message || String(err));
    }
  }
  await check('getUniverse 非法参数返回 400', async () => {
    for (const [market, options] of [['xx', {}], ['cn', { sort: 'volume' }]]) {
      let error = null;
      try {
        await getUniverse(market, options);
      } catch (err) {
        error = err;
      }
      assert(error instanceof MarketDataError, '非法参数未抛出 MarketDataError');
      assert(error.status === 400, `非法参数状态码 ${error.status}`);
      assert(/[\u4e00-\u9fff]/.test(error.message), '错误信息不是中文');
    }
    return 'MARKET_INVALID / SORT_INVALID';
  });
  console.log('');

  // ---- quotes --------------------------------------------------------------
  console.log('== 报价 (quotes) ==');
  const fiveMarkets = ['cn:sh600519', 'hk:hk00700', 'us:usAAPL', 'fx:fxEURUSD', 'crypto:BTCUSDT'];
  const batch = await getQuotes(fiveMarkets);
  const batchBySymbol = Object.fromEntries(batch.quotes.map((quote) => [quote.symbol, quote]));

  await check('[cn] 报价 cn:sh600519', async () => {
    const quote = batchBySymbol['cn:sh600519'];
    validateQuote(quote, { market: 'cn', requirePriceBook: true });
    assert(Number.isFinite(quote.prevClose), '缺少昨收');
    assert(Number.isFinite(quote.extra.limitUp) && quote.extra.limitUp > 0, '缺少涨停价');
    assert(Number.isFinite(quote.extra.limitDown) && quote.extra.limitDown > 0, '缺少跌停价');
    assert(quote.extra.lotSize === 100, 'A股 lotSize 应为 100');
    assert(quote.price >= quote.extra.limitDown && quote.price <= quote.extra.limitUp, '现价不在涨跌停区间');
    return `${quote.name} ${quote.price} (${quote.changePct}%) 盘口 ${quote.bid.length}/${quote.ask.length} 档`;
  }, { optional: !tencentOk });
  await check('[hk] 报价 hk:hk00700', async () => {
    const quote = batchBySymbol['hk:hk00700'];
    validateQuote(quote, { market: 'hk' });
    assert(quote.currency === 'HKD', '港股币种应为 HKD');
    assert(Number.isFinite(quote.extra.lotSize) && quote.extra.lotSize > 0, '港股缺少每手股数');
    return `${quote.name} ${quote.price} (${quote.changePct}%) 每手 ${quote.extra.lotSize}`;
  }, { optional: !tencentOk });
  await check('[us] 报价 us:usAAPL', async () => {
    const quote = batchBySymbol['us:usAAPL'];
    validateQuote(quote, { market: 'us' });
    assert(quote.currency === 'USD', '美股币种应为 USD');
    return `${quote.name} ${quote.price} (${quote.changePct}%) 时间 ${quote.ts}`;
  }, { optional: !tencentOk });
  await check('[fx] 报价 fx:fxEURUSD', async () => {
    const quote = batchBySymbol['fx:EURUSD'];
    validateQuote(quote, { market: 'fx' });
    assert(quote.currency === 'USD', '外汇按 USD 计价');
    assert(quote.bid.length === 0 && quote.ask.length === 0, '外汇无盘口时应为空数组');
    return `${quote.name} ${quote.price} (${quote.changePct}%)`;
  }, { optional: !tencentOk });
  await check('[fx] 报价 fx:fxXAUUSD', async () => {
    const result = await getQuotes(['fx:fxXAUUSD']);
    const quote = result.quotes[0];
    validateQuote(quote, { market: 'fx' });
    return `${quote.name} ${quote.price} (${quote.changePct}%)`;
  }, { optional: !tencentOk });
  await check('[crypto] 报价 crypto:BTCUSDT', async () => {
    const quote = batchBySymbol['crypto:BTCUSDT'];
    validateQuote(quote, { market: 'crypto' });
    assert(quote.currency === 'USDT', '加密币种应为 USDT');
    assert(quote.bid.length === 1 && quote.ask.length === 1, '加密应有 1 档盘口');
    return `${quote.name} ${quote.price} (${quote.changePct}%) 来源 ${quote.source}`;
  }, { optional: !cryptoAvailable });

  await check('批量报价 5 个市场一次拿回', async () => {
    assert(Array.isArray(batch.errors), 'errors 不是数组');
    const missing = fiveMarkets
      .map((symbol) => parseSymbol(symbol).symbol)
      .filter((symbol) => !batchBySymbol[symbol]);
    const requiredMissing = missing.filter((symbol) => {
      if (symbol.startsWith('crypto:')) return !cryptoAvailable;
      return false;
    });
    assert(requiredMissing.length === 0, `缺少报价：${missing.join(', ')}`);
    return `${batch.quotes.length} 条报价 / ${batch.errors.length} 条错误`;
  });
  await check('报价结果使用规范化 symbol', async () => {
    const result = await getQuotes(['fx:fxEURUSD', 'hk:00700', 'crypto:cryptoBTCUSDT']);
    const symbols = result.quotes.map((quote) => quote.symbol).sort();
    assert(symbols.includes('fx:EURUSD'), 'fx 未规范化为 fx:EURUSD');
    assert(symbols.includes('hk:hk00700'), 'hk 未规范化为 hk:hk00700');
    assert(symbols.includes('crypto:BTCUSDT'), 'crypto 未规范化为 crypto:BTCUSDT');
    return symbols.join(', ');
  }, { optional: !cryptoAvailable });
  await check('坏代码进入 errors 且不抛异常', async () => {
    const result = await getQuotes(['cn:nope', 'xx:foo']);
    assert(Array.isArray(result.errors) && result.errors.length === 2, 'errors 数量不符');
    assert(result.quotes.length === 0, '坏代码不应产生报价');
    assert(result.errors.every((item) => item.symbol && /[\u4e00-\u9fff]/.test(item.message)), '错误信息不完整');
    return result.errors.map((item) => `${item.symbol}: ${item.message}`).join('；');
  });
  await check('getQuotes maxAgeMs=0 强制刷新（SSE 用）', async () => {
    const result = await getQuotes(['cn:sh600519'], { maxAgeMs: 0 });
    assert(result.quotes.length === 1, '强制刷新未返回报价');
    assert(Number.isFinite(result.quotes[0].price) && result.quotes[0].price > 0, '强制刷新价格非法');
    return `${result.quotes[0].symbol} ${result.quotes[0].price}`;
  }, { optional: !tencentOk });
  console.log('');

  // ---- fx v5: arbitrary currency pairs -------------------------------------
  console.log('== 外汇 v5 任意货币对 (fx pairs) ==');
  const crossPairs = ['fx:EURJPY', 'fx:USDHKD', 'fx:CNYJPY', 'fx:CADJPY'];
  const CROSS_EXPECTED = {
    'fx:EURJPY': ['EUR', 'JPY'],
    'fx:USDHKD': ['USD', 'HKD'],
    'fx:CNYJPY': ['CNY', 'JPY'],
    'fx:CADJPY': ['CAD', 'JPY'],
  };
  const crossBatch = await getQuotes(crossPairs);
  const crossBySymbol = Object.fromEntries(crossBatch.quotes.map((quote) => [quote.symbol, quote]));
  const validateFxPairQuote = (quote, [baseCurrency, quoteCurrency], { requireCrossSource = false } = {}) => {
    assert(quote && typeof quote === 'object', '交叉报价不存在');
    assert(quote.market === 'fx', `市场不符：${quote.market}`);
    assert(quote.baseCurrency === baseCurrency, `baseCurrency 不符：${quote.baseCurrency}`);
    assert(quote.quoteCurrency === quoteCurrency, `quoteCurrency 不符：${quote.quoteCurrency}`);
    assert(quote.currency === quoteCurrency, `currency 应为 quote 币种：${quote.currency}`);
    assert(typeof quote.name === 'string' && quote.name.includes('/'), `名称异常：${quote.name}`);
    assert(Number.isFinite(quote.price) && quote.price > 0, `价格非法：${quote.price}`);
    assert(quote.pairRate === quote.price, 'pairRate 应等于 price');
    assert(Number.isFinite(quote.usdPerBase) && quote.usdPerBase > 0, `usdPerBase 非法：${quote.usdPerBase}`);
    assert(Number.isFinite(quote.usdPerQuote) && quote.usdPerQuote > 0, `usdPerQuote 非法：${quote.usdPerQuote}`);
    const ratio = quote.usdPerBase / quote.usdPerQuote;
    assert(
      Math.abs(ratio - quote.price) / quote.price < 1e-3,
      `usdPerBase/usdPerQuote 与 price 不一致（${ratio} vs ${quote.price}）`,
    );
    assert(Array.isArray(quote.bid) && Array.isArray(quote.ask), '盘口应为数组');
    assert(Number.isFinite(Date.parse(quote.ts)), `时间非法：${quote.ts}`);
    if (requireCrossSource) assert(quote.source === 'cross', `合成对来源应为 cross：${quote.source}`);
  };
  await check('[fx-v5] 交叉报价 EURJPY/USDHKD/CNYJPY/CADJPY', async () => {
    for (const symbol of crossPairs) {
      validateFxPairQuote(crossBySymbol[symbol], CROSS_EXPECTED[symbol], { requireCrossSource: true });
    }
    return crossPairs.map((symbol) => `${symbol} ${crossBySymbol[symbol].price}`).join('，');
  }, { optional: !tencentOk || crossBatch.errors.length > 0 });
  await check('[fx-v5] 内置对 USD 结算字段（EURUSD/USDJPY/金银）', async () => {
    const result = await getQuotes(['fx:EURUSD', 'fx:USDJPY', 'fx:XAUUSD']);
    const bySymbol = Object.fromEntries(result.quotes.map((quote) => [quote.symbol, quote]));
    const eurusd = bySymbol['fx:EURUSD'];
    assert(eurusd && eurusd.currency === 'USD', 'EURUSD currency 应为 USD');
    assert(eurusd.usdPerQuote === 1 && Math.abs(eurusd.usdPerBase - eurusd.price) < 1e-6, 'EURUSD usdPerBase 应等于 price');
    const usdjpy = bySymbol['fx:USDJPY'];
    assert(usdjpy && usdjpy.currency === 'JPY', 'USDJPY currency 应为 JPY');
    assert(usdjpy.usdPerBase === 1, 'USDJPY usdPerBase 应为 1');
    assert(Math.abs(usdjpy.usdPerQuote - 1 / usdjpy.price) < 1e-6, 'USDJPY usdPerQuote 应为 1/price');
    const gold = bySymbol['fx:XAUUSD'];
    assert(gold && gold.usdPerBase === gold.price && gold.usdPerQuote === 1, '金银 USD 字段不符');
    return `EURUSD usdPerBase=${eurusd.usdPerBase}；USDJPY usdPerQuote=${usdjpy.usdPerQuote}；XAU usdPerBase=${gold.usdPerBase}`;
  }, { optional: !tencentOk });
  await check('[fx-v5] getFxCurrencies（1 单位币种值多少 USD）', async () => {
    const currencies = await getFxCurrencies();
    assert(Array.isArray(currencies) && currencies.length === 10, `币种数量异常：${currencies?.length}`);
    const byCode = Object.fromEntries(currencies.map((entry) => [entry.code, entry]));
    for (const code of ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY', 'HKD']) {
      const entry = byCode[code];
      assert(entry, `缺少币种 ${code}`);
      assert(typeof entry.name === 'string' && entry.name.length > 0, `${code} 缺少中文名`);
      assert(Number.isFinite(entry.usdPerUnit) && entry.usdPerUnit > 0, `${code} usdPerUnit 非法：${entry.usdPerUnit}`);
      assert(Number.isFinite(Date.parse(entry.updatedAt)), `${code} updatedAt 非法`);
    }
    assert(byCode.USD.usdPerUnit === 1, 'USD usdPerUnit 应为 1');
    assert(byCode.EUR.usdPerUnit > 0.5 && byCode.EUR.usdPerUnit < 2, `EUR 汇率异常：${byCode.EUR.usdPerUnit}`);
    assert(byCode.JPY.usdPerUnit > 0.001 && byCode.JPY.usdPerUnit < 0.05, `JPY 汇率异常：${byCode.JPY.usdPerUnit}`);
    assert(byCode.HKD.usdPerUnit > 0.05 && byCode.HKD.usdPerUnit < 0.3, `HKD 汇率异常：${byCode.HKD.usdPerUnit}`);
    return currencies.map((entry) => `${entry.code}=${entry.usdPerUnit}`).join(' ');
  }, { optional: !tencentOk });
  for (const [label, symbol, interval] of [
    ['EURJPY 日K', 'fx:EURJPY', '1d'],
    ['EURJPY 周K', 'fx:EURJPY', '1w'],
    ['USDHKD 日K', 'fx:USDHKD', '1d'],
    ['CNYJPY 日K', 'fx:CNYJPY', '1d'],
  ]) {
    await check(`[fx-v5] 合成 ${label}`, async () => {
      const result = await getKline(symbol, interval, 20);
      assert(result.symbol === parseSymbol(symbol).symbol, `symbol 未规范化：${result.symbol}`);
      validateBars(result.bars, `fx-v5 ${label}`);
      const last = result.bars[result.bars.length - 1];
      return `${result.bars.length} 根，最新 ${last.t.slice(0, 10)} 收 ${last.c}`;
    }, { optional: !tencentOk });
  }
  await check('[fx-v5] 合成对分钟线（Yahoo 可用才有）', async () => {
    const result = await getKline('fx:EURJPY', '5m', 10);
    validateBars(result.bars, 'fx-v5 EURJPY 5m');
    return `${result.bars.length} 根，最新 ${result.bars[result.bars.length - 1].t}`;
  }, { optional: !minuteAvailable });
  console.log('');

  // ---- daily K-lines -------------------------------------------------------
  console.log('== 日/周/月 K 线 ==');
  const dailyCases = [
    ['[cn] 日K cn:sh600519', 'cn:sh600519', '1d', { optional: !tencentOk }],
    ['[cn] 周K cn:sh600519', 'cn:sh600519', '1w', { optional: !tencentOk }],
    ['[cn] 月K cn:sh600519', 'cn:sh600519', '1M', { optional: !tencentOk }],
    ['[hk] 日K hk:hk00700', 'hk:hk00700', '1d', { optional: !tencentOk }],
    ['[hk] 周K hk:hk00700', 'hk:hk00700', '1w', { optional: !tencentOk }],
    ['[us] 日K us:usAAPL', 'us:usAAPL', '1d', { optional: !yahooOk }],
    ['[us] 周K us:usAAPL', 'us:usAAPL', '1w', { optional: !yahooOk }],
    ['[fx] 日K fx:fxEURUSD', 'fx:fxEURUSD', '1d', { optional: !tencentOk }],
    ['[fx] 月K fx:fxEURUSD', 'fx:fxEURUSD', '1M', { optional: !tencentOk }],
    ['[fx] 现货金日K fx:fxXAUUSD', 'fx:fxXAUUSD', '1d', { optional: !metalAvailable }],
    ['[fx] 现货金周K fx:fxXAUUSD', 'fx:fxXAUUSD', '1w', { optional: !metalAvailable }],
    ['[crypto] 日K crypto:BTCUSDT', 'crypto:BTCUSDT', '1d', { optional: !cryptoAvailable }],
  ];
  for (const [label, symbol, interval, options] of dailyCases) {
    await check(label, async () => {
      const result = await getKline(symbol, interval, 30);
      assert(result.symbol === parseSymbol(symbol).symbol, `返回 symbol 未规范化：${result.symbol}`);
      assert(result.interval === interval, '返回 interval 不符');
      validateBars(result.bars, label);
      const last = result.bars[result.bars.length - 1];
      return `${result.bars.length} 根，最新 ${last.t.slice(0, 10)} 收 ${last.c}`;
    }, options);
  }
  console.log('');

  // ---- minute K-lines ------------------------------------------------------
  console.log('== 分钟 K 线 ==');
  const minuteCases = [
    ['[cn] 分钟K 1m', 'cn:sh600519', '1m', { optional: !tencentOk }],
    ['[cn] 分钟K 5m', 'cn:sh600519', '5m', { optional: !tencentOk }],
    ['[cn] 分钟K 60m', 'cn:sh600519', '60m', { optional: !tencentOk }],
    ['[hk] 分钟K 1m', 'hk:hk00700', '1m', { optional: !tencentOk }],
    ['[hk] 分钟K 5m', 'hk:hk00700', '5m', { optional: !tencentOk }],
    ['[hk] 分钟K 30m', 'hk:hk00700', '30m', { optional: !tencentOk }],
    ['[us] 分钟K 5m', 'us:usAAPL', '5m', { optional: !minuteAvailable }],
    ['[fx] 分钟K 5m', 'fx:fxEURUSD', '5m', { optional: !minuteAvailable }],
    ['[fx] 现货金分钟K 15m', 'fx:fxXAUUSD', '15m', { optional: !minuteAvailable }],
    ['[crypto] 分钟K 1m', 'crypto:BTCUSDT', '1m', { optional: !cryptoAvailable }],
    ['[crypto] 4h K', 'crypto:BTCUSDT', '4h', { optional: !cryptoAvailable }],
  ];
  for (const [label, symbol, interval, options] of minuteCases) {
    await check(label, async () => {
      const result = await getKline(symbol, interval, 20);
      validateBars(result.bars, label);
      const last = result.bars[result.bars.length - 1];
      return `${result.bars.length} 根，最新 ${last.t}`;
    }, options);
  }
  console.log('');

  // ---- search --------------------------------------------------------------
  console.log('== 搜索 (search) ==');
  const searchCases = [
    ['[cn] 搜索“茅台”', '茅台', 'cn:sh600519', { optional: !tencentOk }],
    ['[hk] 搜索“腾讯”', '腾讯', 'hk:hk00700', { optional: !tencentOk }],
    ['[us] 搜索“AAPL”', 'AAPL', 'us:usAAPL', { optional: !tencentOk }],
    ['[fx] 搜索“黄金”', '黄金', 'fx:XAUUSD', {}],
    ['[fx-v5] 搜索“eurjpy”', 'eurjpy', 'fx:EURJPY', {}],
    ['[fx-v5] 搜索“cad/jpy”', 'cad/jpy', 'fx:CADJPY', {}],
    ['[crypto] 搜索“BTC”', 'BTC', 'crypto:BTCUSDT', {}],
  ];
  for (const [label, query, expected, options] of searchCases) {
    await check(label, async () => {
      const results = await search(query, 10);
      validateSearchResults(results);
      assert(results.length > 0, '没有搜索结果');
      assert(results.some((item) => item.symbol === expected), `结果中没有 ${expected}`);
      return results.slice(0, 3).map((item) => `${item.symbol}(${item.name})`).join('，');
    }, options);
  }
  console.log('');

  // ---- fx rates ------------------------------------------------------------
  console.log('== 汇率 (fxRates) ==');
  await check('[all] 对 CNY 汇率', async () => {
    const rates = await getFxRates();
    assert(rates.CNY === 1, 'CNY 汇率应为 1');
    assert(Number.isFinite(rates.USD) && rates.USD > 1 && rates.USD < 20, `USD 汇率异常：${rates.USD}`);
    assert(Number.isFinite(rates.HKD) && rates.HKD > 0.1 && rates.HKD < 2, `HKD 汇率异常：${rates.HKD}`);
    assert(Number.isFinite(rates.USDT) && Math.abs(rates.USDT - rates.USD) < 0.5, 'USDT 应近似 USD');
    return `CNY=1 USD=${rates.USD} HKD=${rates.HKD} USDT=${rates.USDT}`;
  }, { optional: !tencentOk });
  console.log('');

  // ---- error semantics -----------------------------------------------------
  console.log('== 错误语义 ==');
  await check('不支持周期返回 KLINE_INTERVAL_UNSUPPORTED(400)', async () => {
    for (const [symbol, interval] of [['cn:sh600519', '4h'], ['crypto:BTCUSDT', '1M'], ['fx:EURUSD', '1h']]) {
      let error = null;
      try {
        await getKline(symbol, interval, 5);
      } catch (err) {
        error = err;
      }
      assert(error instanceof MarketDataError, `${symbol} ${interval} 未抛 MarketDataError`);
      assert(error.code === 'KLINE_INTERVAL_UNSUPPORTED', `${symbol} ${interval} 错误码 ${error.code}`);
      assert(error.status === 400, `${symbol} ${interval} HTTP 状态 ${error.status}`);
      assert(/[\u4e00-\u9fff]/.test(error.message), '错误信息不是中文');
    }
    return 'cn 4h / crypto 1M / fx 1h 均被拒绝';
  });
  await check('非法 symbol 返回 SYMBOL_INVALID(400)', async () => {
    let error = null;
    try {
      await getKline('xx:foo', '1d', 5);
    } catch (err) {
      error = err;
    }
    assert(error instanceof MarketDataError && error.code === 'SYMBOL_INVALID', '非法 symbol 未返回 SYMBOL_INVALID');
    assert(error.status === 400, '非法 symbol 状态码不为 400');
    return error.message;
  });
  await check('[fx-v5] 非法货币对返回 SYMBOL_INVALID(400)', async () => {
    for (const pair of ['fx:EUREUR', 'fx:XYZUSD']) {
      let error = null;
      try {
        await getKline(pair, '1d', 5);
      } catch (err) {
        error = err;
      }
      assert(error instanceof MarketDataError && error.code === 'SYMBOL_INVALID', `${pair} 未返回 SYMBOL_INVALID`);
      assert(error.status === 400, `${pair} 状态码 ${error.status}`);
      assert(/[\u4e00-\u9fff]/.test(error.message), '错误信息不是中文');
    }
    const result = await getQuotes(['fx:EUREUR']);
    assert(result.quotes.length === 0 && result.errors.length === 1, '非法货币对报价应进入 errors');
    return result.errors[0].message;
  });
  console.log('');

  // ---- proxy off: direct fallbacks -----------------------------------------
  console.log('== 代理关闭兜底 (proxy off) ==');
  configureProxy({ host: '127.0.0.1', port: 1 }); // simulate an unavailable local proxy
  _resetCacheForTest();
  const offlineHealth = await health();
  const offlineBySource = Object.fromEntries(offlineHealth.map((entry) => [entry.source, entry]));
  await check('[proxy-off] health 直连兜底说明', async () => {
    for (const entry of offlineHealth) {
      assert(typeof entry.critical === 'boolean', `health(${entry.source}) 缺少 critical`);
      assert(Array.isArray(entry.markets), `health(${entry.source}) 缺少 markets`);
      assert(typeof entry.hint === 'string' && entry.hint.length > 0, `health(${entry.source}) 缺少 hint`);
    }
    const binanceEntry = offlineBySource.binance;
    assert(binanceEntry?.ok === true, `代理离线时 binance 应可用（vision 直连）：${binanceEntry?.message}`);
    assert(
      String(binanceEntry.message).includes('vision'),
      `binance 消息未说明使用 vision：${binanceEntry.message}`,
    );
    const yahooEntry = offlineBySource.yahoo;
    assert(yahooEntry?.ok === false, '代理离线时 yahoo 应不可用');
    assert(
      /新浪|日\/周\/月线/.test(String(yahooEntry.message)),
      `yahoo 消息未说明新浪兜底：${yahooEntry.message}`,
    );
    return `binance=${binanceEntry.message}；yahoo=${yahooEntry.message}`;
  });
  await check('[proxy-off] crypto 报价（data-api.binance.vision）', async () => {
    const result = await getQuotes(['crypto:BTCUSDT', 'crypto:ETHUSDT']);
    assert(result.quotes.length === 2 && result.errors.length === 0, `报价失败：${JSON.stringify(result.errors)}`);
    for (const quote of result.quotes) {
      assert(Number.isFinite(quote.price) && quote.price > 0, `价格非法：${quote.price}`);
    }
    return result.quotes.map((quote) => `${quote.symbol}=${quote.price}`).join('，');
  });
  await check('[proxy-off] 交叉汇率（腾讯直连腿）', async () => {
    const result = await getQuotes(['fx:EURJPY', 'fx:CADJPY', 'fx:USDHKD', 'fx:CNYJPY']);
    assert(result.quotes.length === 4 && result.errors.length === 0, `交叉报价失败：${JSON.stringify(result.errors)}`);
    for (const quote of result.quotes) {
      assert(Number.isFinite(quote.usdPerBase) && quote.usdPerBase > 0, `${quote.symbol} usdPerBase 非法`);
      assert(Number.isFinite(quote.usdPerQuote) && quote.usdPerQuote > 0, `${quote.symbol} usdPerQuote 非法`);
      const ratio = quote.usdPerBase / quote.usdPerQuote;
      assert(Math.abs(ratio - quote.price) / quote.price < 1e-3, `${quote.symbol} 交叉价与 USD 腿不一致`);
    }
    return result.quotes.map((quote) => `${quote.symbol}=${quote.price}`).join('，');
  });
  await check('[proxy-off] 合成 EURJPY 日K（腾讯直连腿）', async () => {
    const result = await getKline('fx:EURJPY', '1d', 20);
    validateBars(result.bars, 'proxy-off EURJPY');
    return `${result.bars.length} 根`;
  });
  for (const interval of ['1d', '1h', '1m']) {
    await check(`[proxy-off] crypto ${interval} K（data-api.binance.vision）`, async () => {
      const result = await getKline('crypto:BTCUSDT', interval, 20);
      validateBars(result.bars, `crypto ${interval}`);
      return `${result.bars.length} 根，最新 ${result.bars[result.bars.length - 1].t}`;
    });
  }
  for (const interval of ['1d', '1w', '1M']) {
    await check(`[proxy-off] us ${interval} K（新浪日线兜底）`, async () => {
      const result = await getKline('us:usAAPL', interval, 20);
      validateBars(result.bars, `us ${interval}`);
      const last = result.bars[result.bars.length - 1];
      return `${result.bars.length} 根，最新 ${last.t.slice(0, 10)} 收 ${last.c}`;
    });
  }
  await check('[proxy-off] /api/markets 移除 us/fx 分钟周期', async () => {
    const markets = await getMarkets();
    const byId = Object.fromEntries(markets.map((market) => [market.id, market]));
    const minuteIntervals = ['1m', '5m', '15m', '30m', '60m'];
    for (const market of ['us', 'fx']) {
      const leaked = byId[market].intervals.filter((interval) => minuteIntervals.includes(interval));
      assert(leaked.length === 0, `${market} 仍包含分钟周期：${leaked.join(',')}`);
      assert(byId[market].intervals.includes('1d'), `${market} 丢失日线周期`);
    }
    assert(
      byId.crypto.intervals.includes('1h') && byId.crypto.intervals.includes('1m'),
      'crypto 周期不应受影响',
    );
    return `us=${byId.us.intervals.join(' ')}；fx=${byId.fx.intervals.join(' ')}；crypto=${byId.crypto.intervals.join(' ')}`;
  });
  console.log('');

  // ---- summary -------------------------------------------------------------
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('== 汇总 ==');
  console.log(`PASS ${counts.PASS} / WARN ${counts.WARN} / FAIL ${counts.FAIL}，耗时 ${elapsed}s`);
  if (counts.WARN > 0) {
    console.log('WARN 说明：境外数据源（Binance/CoinGecko/Yahoo/新浪）受网络与本地代理影响，');
    console.log('      代理不可达时按契约降级为 WARN；腾讯行情源必须全部 PASS。');
  }
  if (counts.FAIL > 0) {
    console.log('失败项：');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('自检通过。');
  }
}

main().catch((err) => {
  console.error(`[FAIL] 自检执行异常：${err?.stack || err}`);
  process.exitCode = 1;
});
