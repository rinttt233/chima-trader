# 第三方组件声明 / Third-party notices

本项目自身代码以 MIT 许可发布（见 `LICENSE`）。以下第三方组件保留其原始许可：

## TradingView Lightweight Charts™ v4.2.0

- 文件：`public/vendor/lightweight-charts.standalone.production.js`
- 许可：Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- 版权：Copyright (c) 2024 TradingView, Inc.
- 说明：源码文件头部已保留原始 license 头信息，未做修改。

## 行情数据来源

本项目仅通过各数据源公开的只读行情接口获取数据，未使用其私有 API 或 SDK：

- 腾讯行情（`qt.gtimg.cn` / `ifzq.gtimg.cn`）
- 新浪财经排行与现货金银（`vip.stock.finance.sina.com.cn` / `stock2.finance.sina.com.cn`）
- Binance 公共行情 API（`api.binance.com`）
- CoinGecko 公共 API（`api.coingecko.com`）
- Yahoo Finance 公开图表接口（`query1.finance.yahoo.com`）
- Nasdaq screener 公开接口（`api.nasdaq.com`）

这些数据源的使用应遵守各站点的服务条款；本项目仅用于学习与模拟练习，不构成任何投资建议。
