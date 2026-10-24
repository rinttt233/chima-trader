// lib/sources/fallback-universe.mjs — built-in curated lists used when the live
// full-market list sources are unavailable. Prices are always fetched live through
// getQuotes() (Tencent / CoinGecko), so this file only needs codes.

import { HK_LOT_SIZES } from '../symbols.mjs';

/** ~60 liquid A-share codes spanning SSE / SZSE / STAR / ChiNext. */
export const CN_FALLBACK_CODES = Object.freeze([
  'cn:sh600519', // 贵州茅台
  'cn:sz300750', // 宁德时代
  'cn:sh601318', // 中国平安
  'cn:sh600036', // 招商银行
  'cn:sz000858', // 五粮液
  'cn:sh601899', // 紫金矿业
  'cn:sh600900', // 长江电力
  'cn:sz000333', // 美的集团
  'cn:sh601166', // 兴业银行
  'cn:sh600030', // 中信证券
  'cn:sh688981', // 中芯国际
  'cn:sz002594', // 比亚迪
  'cn:sh601012', // 隆基绿能
  'cn:sh601888', // 中国中免
  'cn:sh600276', // 恒瑞医药
  'cn:sz000651', // 格力电器
  'cn:sh600887', // 伊利股份
  'cn:sh601398', // 工商银行
  'cn:sh601288', // 农业银行
  'cn:sh601988', // 中国银行
  'cn:sz000001', // 平安银行
  'cn:sz000002', // 万科A
  'cn:sh601668', // 中国建筑
  'cn:sh600028', // 中国石化
  'cn:sh601857', // 中国石油
  'cn:sh600050', // 中国联通
  'cn:sh601728', // 中国电信
  'cn:sh600941', // 中国移动
  'cn:sh601088', // 中国神华
  'cn:sh600309', // 万华化学
  'cn:sh603259', // 药明康德
  'cn:sh688111', // 金山办公
  'cn:sz300059', // 东方财富
  'cn:sz300124', // 汇川技术
  'cn:sz300760', // 迈瑞医疗
  'cn:sz002415', // 海康威视
  'cn:sz002475', // 立讯精密
  'cn:sz300015', // 爱尔眼科
  'cn:sh600585', // 海螺水泥
  'cn:sh601601', // 中国太保
  'cn:sh601628', // 中国人寿
  'cn:sh601818', // 光大银行
  'cn:sh601939', // 建设银行
  'cn:sh600016', // 民生银行
  'cn:sh600048', // 保利发展
  'cn:sh600104', // 上汽集团
  'cn:sh600690', // 海尔智家
  'cn:sh601111', // 中国国航
  'cn:sh601390', // 中国中铁
  'cn:sh601766', // 中国中车
  'cn:sh601989', // 中国重工
  'cn:sh603501', // 韦尔股份
  'cn:sh688036', // 传音控股
  'cn:sh688012', // 中微公司
  'cn:sz002304', // 洋河股份
  'cn:sz000568', // 泸州老窖
  'cn:sz000725', // 京东方A
  'cn:sz002352', // 顺丰控股
  'cn:sz300274', // 阳光电源
  'cn:sz300308', // 中际旭创
  'cn:sh601138', // 工业富联
]);

/** All HK board-lot codes from symbols.mjs (39 liquid names). */
export const HK_FALLBACK_CODES = Object.freeze(
  Object.keys(HK_LOT_SIZES).map((code) => `hk:${code}`),
);

/** ~60 liquid US tickers covering megacaps, banks, energy, retail and tech. */
export const US_FALLBACK_CODES = Object.freeze([
  'us:AAPL', 'us:MSFT', 'us:NVDA', 'us:AMZN', 'us:GOOGL', 'us:META', 'us:TSLA', 'us:BRK.B',
  'us:JPM', 'us:V', 'us:UNH', 'us:XOM', 'us:WMT', 'us:LLY', 'us:JNJ', 'us:MA',
  'us:PG', 'us:HD', 'us:COST', 'us:AVGO', 'us:MRK', 'us:ABBV', 'us:CVX', 'us:PEP',
  'us:KO', 'us:ADBE', 'us:CRM', 'us:NFLX', 'us:AMD', 'us:INTC', 'us:CSCO', 'us:QCOM',
  'us:TXN', 'us:ORCL', 'us:IBM', 'us:BAC', 'us:WFC', 'us:GS', 'us:MS', 'us:C',
  'us:VZ', 'us:T', 'us:PFE', 'us:DIS', 'us:NKE', 'us:MCD', 'us:BA', 'us:CAT',
  'us:GE', 'us:HON', 'us:UPS', 'us:RTX', 'us:LMT', 'us:SBUX', 'us:PYPL', 'us:UBER',
  'us:ABNB', 'us:PLTR', 'us:SNOW', 'us:SHOP', 'us:COIN', 'us:MSTR',
]);
