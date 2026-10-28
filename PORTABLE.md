# 免安装便携版（Windows 7 / Linux）

除了源码运行（需要 Node.js ≥ 20），本仓库还提供**自带运行时、无需安装 Node.js** 的便携包：

| 包 | 运行环境 | 说明 |
|---|---|---|
| `chima-trader-1.3.1-win7-x64-no-node.zip` | Windows 7 SP1+（64 位） | 自带 Node 12.22.12，双击 `start.cmd` 即用；也兼容 Win10/Win11 |
| `chima-trader-1.3.1-win7-x86-no-node.zip` | Windows 7 SP1+（32 位） | 自带 32 位 Node 12.22.12 |
| `chima-trader-1.3.1-linux-x64-glibc217.tar.gz` | Linux x86_64，glibc ≥ 2.17 | 自带 Node 16.20.2（官方 glibc-217 兼容构建），CentOS 7 / Ubuntu 16+ 等老系统可跑 |
| `chima-trader-1.3.1-linux-arm64-glibc217.tar.gz` | Linux arm64，glibc ≥ 2.17 | 同上，面向 ARM 服务器/开发板 |

> 运行时版本说明：Windows 7 官方最后支持到 Node 12.22.12，这是能运行本应用的**最高**版本；Linux 选择 Node 16 官方 glibc-217 兼容构建，以兼容 CentOS 7 等 glibc 2.17 老系统。两者都已停止官方安全更新，**仅建议在本机/内网环境使用**；能升级系统的机器请优先用源码 + Node 20。

## 下载

从 GitHub Releases 下载对应压缩包和 `SHA256SUMS.txt`，校验后再解压：

```powershell
# Windows PowerShell 5+
Get-FileHash .\chima-trader-1.3.1-win7-x64-no-node.zip -Algorithm SHA256
# 对比 SHA256SUMS.txt 中同名文件的值
```

```bash
# Linux
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Windows 使用

1. 解压到**全英文、无空格**的目录（例如 `D:\ChimaTrader`；老系统对中文路径兼容性差）。
2. 双击 `start.cmd`。它会：
   - 启动自带的 `runtime\node.exe app.mjs`（端口 8787）；
   - 自动查找 Chrome / Edge / Firefox 并打开 `http://127.0.0.1:8787`；
   - 找不到浏览器时用系统默认浏览器打开，并提示建议浏览器。
3. 关闭那个标题为「ChimaTrader」的窗口（或在任务管理器结束 `node.exe`）即停止服务；数据已自动保存。
4. 首次运行会在 `data\` 下生成 `state.json` 和 `backups\`；换机器时整个目录拷走即可。

**浏览器要求（Win7）**：Chrome 109（Win7 最后支持版）或 Firefox 115 ESR。IE 11 无法运行本应用；如默认浏览器是 IE，请安装上述任一浏览器。

## Linux 使用

```bash
tar -xzf chima-trader-1.3.1-linux-x64-glibc217.tar.gz
cd chima-trader
chmod +x start.sh          # 解压工具可能丢失执行位
./start.sh                 # 前台运行；有桌面环境会尝试用 xdg-open 打开浏览器
# 服务器/无桌面环境：
./start.sh --no-browser
```

访问 `http://127.0.0.1:8787`。`Ctrl+C` 停止；数据在 `data/`。

如需对局域网开放，把 `config.json` 的 `server.host` 改为 `0.0.0.0` 并注意安全（无鉴权，仅供本机/内网模拟使用）。

## 通用说明

- **数据**：全部保存在程序目录的 `data/state.json`（原子写），`data/backups/` 保存自动快照；界面「数据」面板可导出/导入备份。
- **端口**：默认 8787；改 `config.json` 的 `server.port`，或启动时设环境变量 `PORT`。
- **境外行情**：加密主站与美股分钟线需要本机代理，在 `config.json` 的 `proxy` 配置（默认 `127.0.0.1:65532`）。无代理时会自动直连兜底（加密行情、美股日线），详见 README 的「数据源异常排查」。
- **浏览器访问**：服务只监听 `127.0.0.1`，不要用 `file://` 直接打开 `public/index.html`。
- **文件路径**：Windows 建议英文路径；Linux 任意路径均可。

## 从源码构建便携包

便携包由 `tools/portable/build.mjs` 生成（需要构建期依赖 esbuild 与 iconv-lite，仅打包用，运行时零依赖）：

```bash
cd tools/portable
npm install esbuild iconv-lite     # 仅构建机需要
cd ../..
node tools/portable/build.mjs      # 产物输出到 temp/port/dist/
```

- 构建脚本会校验 Node 运行时版本与 SHA256（Windows 12.22.12 / Linux 16.20.2），前端 JS 降级到 ES2017 以兼容老浏览器。
- 运行时来自 Node 官方发布包（Windows 用 [npmmirror](https://npmmirror.com/mirrors/node/) 镜像），许可证随包附带。

## 第三方许可

- **Node.js**：MIT 风格许可 + 第三方组件许可，随包 `runtime/LICENSE`。
- **iconv-lite**（仅打包进 `app.mjs`，用于 GBK 解码）：MIT。
- 其余依赖与数据源说明见仓库根目录 `THIRD_PARTY_NOTICES.md`。
