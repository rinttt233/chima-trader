# Android APK（独立本地版）

> 手机装了就能用：**内置 Node 运行时，服务跑在手机本机 `127.0.0.1:8787`，不依赖电脑/服务器，不上传任何账户数据**。

## 下载与安装

从 [Releases](https://github.com/rinttt233/chima-trader/releases) 下载：

- `chima-trader-1.4.2-android-arm64.apk`（约几十 MB，arm64 手机）

安装：

1. 传到手机（数据线/网盘均可），点击安装；
2. 系统提示「未知来源」时允许（仅此一次）；
3. 打开「千亦所 ChimaTrader」，首次启动会在应用私有目录解压本地服务（几秒），随后自动进入界面。

系统要求：**Android 7.0（API 24）及以上，arm64-v8a**（绝大多数 2016 年后的手机）。没有为 32 位老设备出包。

首次启动需要把内置的 Node 服务解压到应用私有目录，**大约 5–30 秒**（视手机性能），随后自动进入界面；请耐心等待，不要重复点开。启动成功后通知栏会出现一条常驻通知「千亦所 ChimaTrader」，这是前台服务保活，属于正常现象。

**停止**：在通知栏点「退出」才会真正停止本地服务并结束进程（数据会先保存）；直接划掉任务卡片通常只关闭界面，服务仍在后台运行。

## 隐私：数据不共享

- **无后端服务器**：APK 内置 Node 18 运行时，服务端只在手机本机 `127.0.0.1:8787` 监听，外部网络无法访问。
- **无账号、无云端、无遥测**：不登录、不统计、不同步。
- **账户数据只存手机应用私有目录**：`/data/data/com.chimatrader.app/files/data/state.json`（无需任何存储权限即可读写）。
- **系统备份已关闭**：`android:allowBackup="false"`，不会自动传到 Google 云备份。
- **权限只有**：`INTERNET`（拉公开行情）、`FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC`（保持本地服务运行）、`POST_NOTIFICATIONS`（前台服务通知）、`WAKE_LOCK`（后台运行）。不申请通讯录、定位、存储、相机等。
- 行情请求直接发给腾讯/新浪/Binance 等公开接口（对方只能看到你的 IP，不涉及账户信息）；没有第三方 SDK。

## 数据与备份

- 交易数据实时保存在应用私有目录的 `data/state.json`，`data/backups/` 有自动快照；
- 应用内「数据」面板可 **导出 JSON**（保存到 `Android/data/com.chimatrader.app/files/Download/`，用文件管理器可取）和 **导入备份**（系统文件选择器）；
- **卸载会删除数据**：换机/重装前请先导出备份。

## 升级

- APK 使用**固定签名密钥**（证书 `CN=ChimaTrader`，SHA-256 `d40668929f3c9372cc81958c161b5298c19f9e128c08046851f24661664ef02a`）签名，后续同密钥版本可直接覆盖安装，数据保留；
- 若将来更换签名，需先导出备份 → 卸载 → 安装新版 → 导入备份。

## 已知限制

- **仅 arm64**，Android 7+；没有 Play 商店版本（自行 sideload）。
- **16KB 页设备**：内置的 `libnode.so` 由 nodejs-mobile v18.20.4 提供，是 4KB 页对齐；部分 Android 15/16 的 16KB-only 设备可能无法运行，主流 4KB 页手机不受影响。后续要支持需自行编译带 16KB 对齐的 Node 运行时。
- 后台运行依赖前台服务常驻通知；部分厂商的省电策略可能杀掉进程，建议把本应用加入「电池优化白名单」。
- 行情：A 股/港股/外汇报价、加密（直连备用域名）、美股日线可用；**加密主站/美股与外汇分钟线需要代理**——手机上默认关闭代理，因此分钟线不可用（周期按钮会自动隐藏）。这与桌面版无代理时的行为一致。
- APK 使用自签证书（本项目的固定密钥）分发：安装时系统会提示未知来源，属于正常。请只从本仓库 Release 下载；校验 SHA256 与签名指纹。
- WebView 内的文件下载/选择依赖系统组件；个别老机型如果导入文件无反应，可先把备份文件放到手机存储再用文件选择器选择。
- 不含 iOS 版本。

## 构建（开发者）

APK 由 GitHub Actions 云构建，工作流：`.github/workflows/android.yml`。

- 工程：`android/`（Gradle 8.7 + AGP 8.5.2 + JDK 17 + NDK 26 + CMake 3.22；`compileSdk 34 / targetSdk 33 / minSdk 24`，仅 `arm64-v8a`）
- Node 运行时：[nodejs-mobile v18.20.4](https://github.com/nodejs-mobile/nodejs-mobile/releases) 的 `libnode.so` + headers，CI 自动下载；JNI 调 `node::Start`
- Node 侧资产：`tools/android/build-node-assets.mjs` 用 esbuild 把根目录 `server.mjs` 打成单文件 `app.mjs`（target node18，注入 GBK 解码/兼容 shim），复制 `public/` 与 `config.json`，生成 `main.js`
- 签名：CI 从仓库 Secrets（`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`）解码固定 keystore，`assembleRelease`；密钥不进仓库
- 本地构建：需 JDK 17、Android SDK 34、NDK 26、CMake 3.22、Node 20；`node tools/android/build-node-assets.mjs && gradle -p android assembleRelease`

## 架构

```
APK
├─ Android (Java)          MainActivity(WebView) + NodeService(前台服务)
├─ libnode.so (arm64)      nodejs-mobile 18.20.4
└─ assets/nodejs-project/   main.js（入口）· app.mjs（打包后的服务端）· public/ · config.json
```

启动流程：`NodeService` 把 assets 复制到 `filesDir/nodejs-project`（保留 `filesDir/data`）→ 启动 Node 跑 `main.js` → 服务端监听 127.0.0.1:8787 → WebView 轮询 `/api/health` 成功后加载界面。
