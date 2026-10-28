千亦所 ChimaTrader @VERSION@ 免安装便携版（Windows 7 / 8 / 10 / 11）
================================================================

【这是什么】
本目录是千亦所 ChimaTrader 网页交易模拟器的免安装便携版：内置 Node 运行时
（runtime\node.exe，Windows 版为 Node.js 12.22.12），不需要另外安装 Node.js，
不需要管理员权限，解压后即可运行。本包不含 Node.js 安装程序，也不含 node_modules。

【运行要求】
- 系统：Windows 7 SP1 或更高版本（64 位请用 win7-x64 包，32 位请用 win7-x86 包）。
- 浏览器：Chrome 109、Firefox 115 ESR 或 Edge 109（这是 Windows 7 上最后可用的版本）。
  Internet Explorer（IE）无法运行本应用。
- 网络：A 股 / 港股 / 美股 / 外汇 / 加密行情需要联网；部分境外行情源（Binance、
  CoinGecko、Yahoo）在部分网络环境下需要本机代理，见下文「代理」。

【启动】
1. 双击 start.cmd。会弹出一个最小化的黑窗口，标题为 ChimaTrader，服务在该窗口中运行。
2. 服务地址为 http://127.0.0.1:8787 ，启动脚本会在约 4 秒后自动打开浏览器。
3. 如果浏览器没有自动打开，请手动访问 http://127.0.0.1:8787 。

【桌面图标】
本目录附带 chima-trader.ico（千亦所新图标）。双击 create-shortcut.cmd 即可在桌面创建
带该图标的「ChimaTrader」快捷方式，以后从桌面启动即可。

【停止】
关闭标题为 ChimaTrader 的窗口，或在该窗口中按 Ctrl+C。数据会自动保存。

【数据与备份】
- 运行数据保存在本目录下的 data\state.json，自动备份在 data\backups\。
- 迁移数据：直接把 data 目录复制到新解压的包内即可。
- 首次运行会自动生成 data\state.json 和默认账户；删掉 data 目录可重新开始。

【修改端口】
- 推荐用环境变量：在命令行执行 set PORT=8799 后再运行 start.cmd
  （此时启动脚本会检查 8799 并打开 8799）。
- 也可以修改 config.json 里的 server.port，但这种情况下 start.cmd 的开机检查与
  自动打开地址仍按 8787（或 PORT）执行，请手动访问 http://127.0.0.1:<新端口>。

【代理】
config.json 的 proxy 段默认指向本机 127.0.0.1:65532（"enabled": true）。
- 不需要代理的网络环境：把 "enabled" 改成 false。
- 需要代理：改成你本机代理的 host / port，并按需调整 hosts（走代理的行情域名）。
- A 股 / 港股 / 外汇直连腾讯、新浪；加密行情优先 Binance（主站经代理，
  data-api.binance.vision 直连兜底）；美股日线有新浪兜底。

【目录说明】
  start.cmd            启动脚本（双击运行）
  app.mjs              应用服务端（单文件 ESM，已打包并补丁到 Node 12 可运行）
  config.json          配置文件（端口、代理、费率、默认自选等）
  public\              前端页面与脚本
  runtime\node.exe     内置 Node 运行时
  runtime\LICENSE      Node.js 许可证
  data\                运行数据与备份（可随时删除，会重新生成）
  README-PORTABLE.txt  本说明

【兼容性与安全说明】
- 为兼容 Windows 7，运行时固定使用 Node.js 12.22.12（Node 官方最后支持 Windows 7
  的版本）。应用已通过 esbuild 打包，并补齐了 Node 12 缺少的 API（fetch、
  AbortController、GBK TextDecoder、fs.rmSync、node: 模块前缀等）。
- 前端脚本已降级到 ES2017 语法，可在 Chrome 109 / Firefox 115 ESR 上运行。
- 服务只监听 127.0.0.1，默认不对外网开放；请勿改成 0.0.0.0 暴露到公网。
- 本便携版为了兼容老系统使用固定版本的运行时，其安全性由本机与网络环境负责；
  如对安全性有更高要求，请改用新版 Node.js 运行源码版。

【常见问题】
- 提示端口被占用：关掉其他 ChimaTrader 实例，或按「修改端口」换一个端口。
- 双击后窗口一闪而过：通常是解压不完整（缺少 runtime\node.exe），请重新解压。
- 页面能打开但行情缺失：检查网络 / 代理，页面顶部的数据源状态会给出提示。
- IE 打开是空白页：IE 不支持本应用，请改用 Chrome 109 或 Firefox 115 ESR。
