# Cove

Cove 是一个可自托管的实时语音与聊天应用。成员在房间内保持在线状态，随时加入语音、共享屏幕、播放语音包，并支持远程控制共享方的桌面。

提供三个客户端形态，共用同一个服务器：

- **Windows 桌面客户端** —— Electron + React，功能最完整（屏幕共享、系统/单应用音频共享、远程控制）
- **Windows 桌面服务器** —— Electron 托盘程序，内嵌服务端，适合本机或小范围自托管
- **Android 手机客户端** —— React Native，可创建或加入房间、加入语音、发起或观看屏幕共享、播放语音包

## 技术栈

| 层 | 技术 |
|---|---|
| 服务器 | Node.js + TypeScript、Express、Socket.IO（信令与聊天）、**mediasoup**（WebRTC SFU）、**better-sqlite3**（持久化） |
| 桌面客户端 | React 18 + TypeScript + Vite + Tailwind CSS、mediasoup-client、socket.io-client、Electron |
| 手机客户端 | React Native（bare workflow，New Architecture + Hermes）、react-native-webrtc、mediasoup-client、Kotlin 原生模块 |

媒体走 SFU 架构：所有客户端只与服务器建立 WebRTC 连接，由服务器转发，**不需要 STUN/TURN**。

## 仓库结构

```
client/                  桌面客户端
  src/                   React 渲染进程（页面、组件、媒体引擎）
  electron/              Electron 主进程（窗口、IPC、更新器、原生音频采集、远程控制）
  tests/                 客户端测试
server/                  服务器
  src/index.ts           HTTP + Socket.IO + mediasoup 信令入口（核心）
  src/ms.ts              mediasoup SFU 封装（worker / router / transport）
  electron/main.ts       托盘式服务器外壳，负责数据目录与配置
  tests/                 服务器测试
mobile/                  Android 客户端（独立包，不在 npm workspaces 内，有自己的 lockfile）
  src/                   React Native 代码
  scripts/               更新清单生成与发布校验脚本
  __tests__/             Jest 测试
  android/               原生工程与 Kotlin 模块
scripts/                 发布脚本（镜像安装包到下载服务器）
docs/                    技术实验记录
.github/workflows/       release-client.yml、release-mobile.yml
AGENTS.md                发布流程与协作约定（发布前必读）
CHANGELOG.md             历史版本记录
RELEASE_NOTES.md         当前版本的发布说明
start.ps1                Windows 一键启动开发环境（服务器 + Vite + Electron）
```

`assets/branding/` 存放图标源文件；`design-audit/`、`design-qa/` 是设计走查截图。

## 架构概览

```
桌面客户端 ─┐
            ├── Socket.IO ──▶ 服务器 ──▶ SQLite (~/.cove/cove.db)
Android    ─┘                    │
                                 └── mediasoup SFU（单 worker / 单 router）
   音频·屏幕：客户端 ──WebRTC──▶ SFU ──WebRTC──▶ 同房间其他成员
```

- **信令与聊天**走 Socket.IO：登录注册、房间增删改、成员与语音状态、消息、语音包、远程控制协商。
- **媒体**走 mediasoup：服务端只有一个全局 Router，房间隔离在应用层按 `roomId` 过滤完成。
- 媒体源用 `appData.type` 区分四类：`mic`（麦克风）、`screen`（屏幕画面）、`screen-audio`（屏幕附带音频）、`application-audio`（单应用音频）。
- 屏幕类媒体**按需推流**：没有观看者时，服务端暂停 SFU 端 Producer，并通过 `screen:demand` 通知发送端暂停本地 Producer，避免继续发送无用 RTP。
- 服务端创建的每个 Consumer 初始都处于 paused 状态；接收端完成 Consumer 配置后，必须显式发送 `ms:resume-consumer` 才会开始接收媒体。这与屏幕无人观看时的 Producer 按需暂停是两套不同流程。

服务器默认监听 **3001** 端口（当前为硬编码，不支持 `PORT` 环境变量）；媒体默认使用 **40000** 端口，UDP 与 TCP 复用同一端口，因此内网穿透只需转发这一个同号端口。

## 快速开始（开发）

前提：Node.js LTS（建议 22）、npm。Windows 桌面客户端的部分功能（系统音频、远程控制）依赖 Windows。

```bash
git clone https://github.com/LumineTraveller/Cove.git
cd Cove
npm install          # 一次安装 server 与 client 两个 workspace
```

启动方式：

```bash
npm run dev          # 同时启动服务器(:3001) 与客户端 Vite(:5173)
npm run dev:app      # 服务器 + Vite + Electron 桌面客户端（完整体验）
npm run dev:server   # 仅启动托盘式服务器
npm run dev:client   # 仅启动 Vite + Electron 客户端

./start.ps1          # Windows：清理 3001/5173 端口占用后一键启动全套
```

浏览器访问 `http://localhost:5173`，或直接用 Electron 窗口。首次进入需要填写服务器地址（默认 `http://localhost:3001`）并注册账号。

客户端通过 `localStorage.cove_server_url` 记住服务器地址，也可用 `VITE_SERVER_URL` 注入默认值。

### 手机端

手机端是独立的 npm 包，需要单独安装依赖，并要求 JDK 17、Android SDK 与 NDK：

```bash
cd mobile
npm install
npm run typecheck && npm run lint
npm run android:apk    # 产物在 android/app/build/outputs/apk/release/
```

详见 [`mobile/README.md`](mobile/README.md)。

## 构建

```bash
npm run build:client     # 构建桌面客户端安装包 → client/dist-app/Cove-Setup-<版本>.exe
npm run build:server     # 构建服务器安装包   → server/dist-app/Cove-Server-Setup-<版本>.exe
npm run build -w server  # 仅编译服务端 TS（用于 Linux systemd 部署）
```

## 部署与配置

### 数据目录

服务端所有状态都在一个数据目录里，默认 `~/.cove`，可用 `COVE_DATA_DIR` 覆盖：

```
cove.db                SQLite 数据库（WAL 模式）
sounds/                语音包音频
chat-images/<roomId>/  聊天图片
server-config.json     桌面服务器的配置文件
bootstrap-token.txt    启用访问门禁后首次启动生成的一次性凭据
server.log             桌面服务器日志
```

数据库结构变更通过启动时的兼容性迁移完成，**不会删除已有账号、房间、聊天记录或语音包**。

### 环境变量

| 变量 | 说明 |
|---|---|
| `MEDIASOUP_IP` | 服务器对外的公网 IP。本地开发填 `127.0.0.1`；内网穿透填隧道的公网 IP |
| `MEDIASOUP_PORT` | WebRTC 媒体端口，默认 `40000`。隧道的公网端口必须与之相同 |
| `COVE_DATA_DIR` | 数据目录，默认 `~/.cove` |
| `COVE_DOWNLOAD_DIR` | 安装包与更新清单的静态目录。Linux 默认 `/var/www/cove-download`，让服务器自身充当下载镜像 |
| `COVE_SERVER_SECURITY_ENABLED` | 是否启用服务器访问门禁，默认关闭 |
| `COVE_BOOTSTRAP_TOKEN` / `COVE_BOOTSTRAP_TOKEN_FILE` | 由部署系统提供一次性初始化凭据，代替自动生成的 `bootstrap-token.txt` |
| `COVE_TRUST_PROXY` | 反向代理正确设置了 `X-Forwarded-Proto` 时设为 `true` |
| `MEDIASOUP_WORKER_BIN` | mediasoup worker 可执行文件路径（打包后指向 `app.asar.unpacked`，通常无需手动设置） |

桌面服务器也可以把这些写进 `~/.cove/server-config.json`，启动时会读入并转为环境变量：

```json
{
  "mediasoupIp": "203.0.113.10",
  "mediasoupPort": 40000,
  "serverSecurityEnabled": false
}
```

### Linux 服务器

服务端编译产物是普通 Node 程序，可以用 systemd 托管：

```bash
npm run build -w server     # 产出 server/dist
node server/dist/index.js   # 或交给 systemd 的 ExecStart
```

需要放通 3001（HTTP/Socket.IO）与 `MEDIASOUP_PORT`（媒体，UDP+TCP）。公网部署必须使用 HTTPS/WSS。

服务端在检测到同级的 `client/dist` 时会一并托管前端静态文件，可以直接用服务器地址访问网页版客户端。

## 服务器访问安全

服务器访问密码能力随程序安装，但**默认关闭**。关闭时沿用现有账号登录流程，新旧客户端都不需要服务器访问密码，也不会生成初始化凭据。

需要启用时，在启动服务器前设置：

```powershell
$env:COVE_SERVER_SECURITY_ENABLED = "true"
```

打包的服务器也可以在 `~/.cove/server-config.json` 中设置 `"serverSecurityEnabled": true` 后重启。启用后的首次启动会在数据目录生成一次性管理员凭据 `bootstrap-token.txt`，也可以改用 `COVE_BOOTSTRAP_TOKEN` 或 `COVE_BOOTSTRAP_TOKEN_FILE` 由部署系统提供。

客户端第一次连接新服务器时用这个凭据设置独立的“服务器访问密码”。**它与账号密码、房间密码是三套互不相同的凭据**，初始化成功后一次性凭据会被删除（使用环境变量时由外部密钥管理）。

`GET /api/security/status` 只用于检查服务器状态，不会主动弹出客户端初始化窗口。桌面端登录页在输入服务器地址后自动检查状态，并在地址下方显示“服务器安全设置”：新服务器填写一次性初始化凭据并设置至少 8 位的新密码；已初始化服务器只填写已有的服务器访问密码。

仅在服务器明确启用访问门禁后，未携带当前客户端协议标识的旧版客户端会收到“客户端版本过旧，无法登录，请升级到最新版本”的提示；服务器不会因此删除原有账号或聊天数据。

### 凭据存储

服务器访问密码只在服务端以带盐哈希保存。客户端拿到的是有过期时间的访问令牌：桌面端令牌只保留在当前应用窗口的 sessionStorage/内存中，移动端只保留在当前进程内，**不会把服务器密码写入 URL、localStorage 或 AsyncStorage**。

公网连接的初始化、解锁、REST、静态音频/图片和 Socket.IO 均须使用 HTTPS/WSS；仅 loopback 的本地开发连接允许 HTTP。反向代理部署如能正确设置 `X-Forwarded-Proto`，可显式设置 `COVE_TRUST_PROXY=true`。

客户端历史记录仍保存用户输入的服务器 URL 用于实际连接；DNS 解析得到的规范化 IPv4/IPv6 地址集合只用作历史记录键，因此同一服务器的域名和 IP 别名可以合并，不会把连接地址替换成解析后的 IP。

## 主要功能

**房间与聊天**
- 创建/删除房间，房间密码、人数上限、房间头像与明暗主题渐变背景
- 文字聊天、图片与动图（支持剪贴板粘贴 GIF）、链接解析、历史分页
- 房主可禁言或移出成员

**语音**
- 随时加入/退出房间语音，独立调节每个成员的音量
- 麦克风降噪（RNNoise）、回声消除、发送增益、输入设备选择
- 断线宽限：网络抖动或短暂掉线不会立刻失去语音席位

**屏幕与音频共享**
- 屏幕共享，多档分辨率与帧率预设，按画面活跃度自动调整帧率
- 共享屏幕附带系统音频
- Windows 独有：共享单个应用的音频（WASAPI 进程级采集，自动排除 Cove 自身）

**远程控制**
- 请求控制他人的共享屏幕，支持指针、滚轮、按键与安全白名单
- 本地用户活动时自动让位，`Ctrl+Alt+Shift+X` 全局急停

**语音包**
- 上传音频、裁剪编辑、拖拽排序、重命名、向全房间播放、收藏

**个人资料**
- 头像裁剪（支持 GIF）、本地个人备注名、在线成员与平台标识

**其他**
- 明暗主题、聊天字号调节、自签名服务器证书例外
- 桌面端内置更新中心，手机端启动时自动检查更新

自动更新下载地址与聊天服务器独立：桌面端配置 `client/electron/update-config.ts`、手机端配置 `mobile/src/updateConfig.ts` 中的 `UPDATE_DOWNLOAD_BASE_URL`，默认留空，只检查 GitHub，不从聊天服务器推导或补填下载地址。明确填写有效 HTTPS 下载地址后，启动时无需登录即可检查该服务器的更新，GitHub 保留为备用源；修改后需重新打包。官方域名为 `cove.luxe`，不预填到下载变量中。桌面端手动“从服务器下载”仍使用当前填写的聊天服务器地址。

## 测试

```bash
npm test -w server     # 服务器：presence、语音、账号、安全、房间、远程控制、断线恢复
npm test -w client     # 客户端：更新器、连接、音频设备、聊天、远程控制、排序等
cd mobile && npm test  # 手机端（jest）：媒体、界面、更新、存储、证书
```

客户端还有若干需要 Electron 运行环境的测试，见 `client/package.json` 中的 `test:microphone`、`test:rnnoise` 等脚本。手机端的 Kotlin 单元测试（键盘坐标换算、更新源网络、证书策略）不走 jest，需要在 `mobile/android` 下用 `gradlew test` 运行。

## 发布

桌面端与服务器共用版本号（tag `v*.*.*`），手机端独立编号（tag `mobile-v*.*.*`）。

发布流程有严格的顺序与校验要求：**GitHub Release 先公开，下载服务器镜像最后发布**；更新清单中的版本号与 SHA-256 必须来自最终构建产物实算，不得手填。Gitee 只同步仓库代码与标签，不创建 Release、不上传附件。

完整流程见 [`AGENTS.md`](AGENTS.md)；当前版本内容见 [`RELEASE_NOTES.md`](RELEASE_NOTES.md)，历史见 [`CHANGELOG.md`](CHANGELOG.md)。

## 已知限制

- 服务端成员与语音状态保存在内存中，重启服务器会使所有成员退出语音（房间、消息、账号、禁言记录不受影响）。
- WASAPI 系统/单应用音频共享与远程控制仅支持 Windows；Android 的播放音频采集使用系统屏幕共享授权，受应用录音策略限制。
- 手机端可发起屏幕共享；可选播放音频采集要求 Android 10 及以上且被共享应用允许录制，需要配套新版服务端的独立共享通道。没有分辨率、帧率设置。
- 手机端 Release APK 目前使用 debug keystore 签名，更换签名密钥会破坏覆盖安装。
