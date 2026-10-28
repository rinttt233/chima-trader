千亦所 ChimaTrader @VERSION@ 免安装便携版（Linux x86_64 / arm64）
================================================================

【这是什么】
本目录是千亦所 ChimaTrader 网页交易模拟器的免安装便携版：内置 Node 运行时
（runtime/bin/node，Linux 版为 Node.js 16.20.2，glibc >= 2.17），不需要另外
安装 Node.js，解压后即可运行。本包不含 Node.js 安装程序，也不含 node_modules。

【运行要求】
- 系统：Linux x86_64（包名 linux-x64）或 arm64 / aarch64（包名 linux-arm64），
  glibc >= 2.17，例如 CentOS 7、Ubuntu 16.04、Debian 9 及更新的发行版。
  不适用于 Alpine / musl 系统。
- 浏览器：较新的 Chrome / Edge / Firefox 等现代浏览器（前端脚本为 ES2017）。
- 网络：A 股 / 港股 / 美股 / 外汇 / 加密行情需要联网；部分境外行情源（Binance、
  CoinGecko、Yahoo）在部分网络环境下需要本机代理，见下文「代理」。

【启动】
1. 解压：tar -xzf chima-trader-@VERSION@-linux-x64-glibc217.tar.gz
2. 进入目录：cd chima-trader
3. 运行：./start.sh        （首次请确认有执行权限：chmod +x start.sh runtime/bin/node）
   可选参数：
     ./start.sh --no-browser          不尝试自动打开浏览器
     ./start.sh --port 8799           临时改用 8799 端口
     PORT=8799 ./start.sh             同上（环境变量方式）
4. 服务地址为 http://127.0.0.1:8787 （或 --port 指定的端口），脚本会打印该地址。
   在有图形界面（DISPLAY / WAYLAND_DISPLAY）且安装了 xdg-open 时，会自动在后台
   打开浏览器；否则请手动在浏览器中访问该地址。

【停止】
在运行 start.sh 的终端里按 Ctrl+C。数据会自动保存。

【数据与备份】
- 运行数据保存在本目录下的 data/state.json，自动备份在 data/backups/。
- 迁移数据：直接把 data 目录复制到新解压的包内即可。
- 首次运行会自动生成 data/state.json 和默认账户；删掉 data 目录可重新开始。

【代理】
config.json 的 proxy 段默认指向本机 127.0.0.1:65532（"enabled": true）。
- 不需要代理的网络环境：把 "enabled" 改成 false。
- 需要代理：改成你本机代理的 host / port，并按需调整 hosts（走代理的行情域名）。
- A 股 / 港股 / 外汇直连腾讯、新浪；加密行情优先 Binance（主站经代理，
  data-api.binance.vision 直连兜底）；美股日线有新浪兜底。

【目录说明】
  start.sh             启动脚本
  app.mjs              应用服务端（单文件 ESM，Node 12+ / 16 均可运行）
  config.json          配置文件（端口、代理、费率、默认自选等）
  public/              前端页面与脚本
  runtime/bin/node     内置 Node 运行时（0755）
  runtime/LICENSE      Node.js 许可证
  data/                运行数据与备份（可随时删除，会重新生成）
  README-PORTABLE.txt  本说明

【兼容性与安全说明】
- Linux 运行时固定使用 Node.js 16.20.2（官方 glibc >= 2.17 的构建，兼容 CentOS 7、
  Ubuntu 16.04 等老系统）；应用本体按 Node 12 语法打包，在 Node 16 上同样可用。
- 前端脚本已降级到 ES2017 语法，可在较老的浏览器上运行。
- 服务只监听 127.0.0.1，默认不对外网开放；请勿改成 0.0.0.0 暴露到公网。
- 本便携版为了兼容老系统使用固定版本的运行时，其安全性由本机与网络环境负责；
  如对安全性有更高要求，请改用新版 Node.js 运行源码版。

【常见问题】
- 提示 Permission denied：执行 chmod +x start.sh runtime/bin/node 后再运行。
- 提示端口被占用：关掉其他 ChimaTrader 实例，或用 --port 换一个端口。
- 浏览器没有自动打开：手动访问脚本打印的 URL（http://127.0.0.1:8787）。
- 页面能打开但行情缺失：检查网络 / 代理，页面顶部的数据源状态会给出提示。
- 报错 glibc 版本过低：本包要求 glibc >= 2.17，请升级系统或换用更新的发行版。
