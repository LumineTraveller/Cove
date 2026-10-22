# Cove

当前分支包含本地改进，尚未发布。模块边界和扩展约定见 [架构说明](docs/architecture/README.md)，连接生命周期与恢复边界见 [连接恢复说明](docs/architecture/connection-recovery.md)，历史重构记录见 [REFACTOR_STATUS.md](REFACTOR_STATUS.md)。版本号以各应用的 `package.json` 和发布清单为准。

2026-10-22 本地交付、独立测试启动入口、回归结果和统一人工验收步骤见 [本次改进验收说明](docs/testing/2026-10-22-improvements.md)。

Cove 是一个可自托管的实时语音与聊天应用。成员在房间内保持在线状态，随时加入语音、共享屏幕、播放语音包，并支持远程控制共享方的桌面。

提供三个客户端形态，共用同一个服务器：

- **Windows 桌面客户端** —— Electron + React，功能最完整（屏幕共享、系统/单应用音频共享、远程控制）
- **Windows 桌面服务器** —— Electron 托盘程序，内嵌服务端，适合本机或小范围自托管
- **Android 手机客户端** —— React Native，可创建或加入房间、加入语音、发起或观看屏幕共享、播放语音包，也可请求控制支持远控的桌面共享

## 技术栈

| 层 | 技术 |
|---|---|
| 服务器 | Node.js + TypeScript、Express、Socket.IO（信令与聊天）、**mediasoup**（WebRTC SFU）、**better-sqlite3**（持久化） |
| 桌面客户端 | React 18 + TypeScript + Vite + Tailwind CSS、mediasoup-client、socket.io-client、Electron |
| 手机客户端 | React Native（bare workflow，New Architecture + Hermes）、react-native-webrtc、mediasoup-client、Kotlin 原生模块 |

媒体走 SFU 架构：客户端与服务器建立 WebRTC 连接，由服务器转发。当前实现依赖可达的 SFU 候选地址，需要正确配置公网 IP 并放通 UDP/TCP 媒体端口；没有配置通用 TURN 中继，受限网络仍需单独验证。

## 仓库结构

```
apps/
  desktop/               Electron + React 桌面客户端
    src/app/             应用组合与登录入口
    src/features/        房间、聊天、媒体、账户、更新等功能模块
    electron/            Windows 采集、远控、更新器和 IPC
    tests/               单元、原生 helper 与真实 Chromium 回归
  server/                Node 服务端与 Electron 托盘外壳
    src/bootstrap/       运行时装配、启动和资源释放
    src/features/        按业务拆分的服务、HTTP 与 Socket 处理器
    src/features/media/  mediasoup worker/router/transport
  mobile/                独立 React Native 包与 lockfile
    src/features/        会话、房间、媒体、键盘、更新等功能模块
    scripts/             APK 清单与发布校验
    __tests__/           Jest 回归
    android/             原生工程、RNNoise 与 WebRTC 插桩
packages/
  contracts/             共用数据协议与兼容字段
  client-core/           ACK 请求、会话注册、断线宽限
  media-core/            平台无关采集、处理和路由扩展接口
  diagnostics/           结构化诊断与错误作用域接口
tooling/                 隔离开发启动器、迁移工具与校验工具
tests/                   跨端协议和模块边界回归
baseline/                原工作区指纹和旧路径到新路径映射
mobile/update.json       保留原 raw 更新清单 URL 的兼容副本
scripts/                 发布脚本（镜像安装包到下载服务器）
docs/                    技术实验记录
.github/workflows/       PR/main 回归门禁、桌面与手机发布工作流
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

直接启动服务端时 HTTP 默认 **3001**，可通过 `COVE_HTTP_PORT` 配置；媒体默认 **40000**，UDP 与 TCP 共用同号端口。隔离开发启动器单独使用 HTTP **3301**、媒体 **41000** 和 Vite **55173**。

## 快速开始（开发）

前提：Node.js 24、npm。Windows 桌面客户端的部分功能（系统音频、受控端远程输入）依赖 Windows。普通回归与服务端测试使用 Node 24 的 `node:sqlite`；手机包需要独立安装依赖。

```bash
npm ci
npm --prefix apps/mobile ci
npm run build:packages
```

启动方式：

```bash
npm run dev          # 隔离服务器(:3301) 与 Vite(:55173)
npm run dev:app      # 服务器 + Vite + Electron 桌面客户端（完整体验）
npm run dev:server   # 仅启动 Node 服务端
npm run dev:client   # 仅启动 Vite + Electron 客户端

./start.ps1          # Windows：启动隔离全套，不清理其他应用的端口
```

浏览器访问 `http://127.0.0.1:55173`，或使用 Electron 窗口。本地隔离服务地址为 `http://127.0.0.1:3301`，数据库和桌面档案均放在本目录的 `runtime/`，不会读取原应用的账号或生产数据。

客户端通过 `localStorage.cove_server_url` 记住服务器地址；开发环境可用 `VITE_COVE_DEFAULT_SERVER` 注入默认值。打包后的默认策略保持不变。

### 手机端

手机端是独立的 npm 包，需要单独安装依赖，并要求 JDK 17、Android SDK 与 NDK：

```bash
cd apps/mobile
npm ci
npm run typecheck && npm run lint
npm run android:apk    # 产物在 android/app/build/outputs/apk/release/
```

详见 [手机端说明](apps/mobile/README.md)。测试用独立 Android 包可在 `apps/mobile/android` 运行 `gradlew.bat assembleDebug -PcoveRefactor -PreactNativeArchitectures=arm64-v8a`；包名为 `com.cove.mobile.refactor`，内置 JS/Hermes，不覆盖正式版。

## 构建

```bash
npm run build:client            # apps/desktop/dist-app/
npm run build:server            # apps/server/dist-app/
npm run build -w cove-server    # 仅编译 Node 服务端
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
| `COVE_SERVER_SECURITY_ENABLED` | 服务器访问门禁默认开启；显式设为 `false`、`0`、`no` 或 `off` 可关闭 |
| `COVE_BOOTSTRAP_TOKEN` / `COVE_BOOTSTRAP_TOKEN_FILE` | 由部署系统提供一次性初始化凭据，代替自动生成的 `bootstrap-token.txt` |
| `COVE_TRUST_PROXY` | 反向代理正确设置了 `X-Forwarded-Proto` 时设为 `true` |
| `MEDIASOUP_WORKER_BIN` | mediasoup worker 可执行文件路径（打包后指向 `app.asar.unpacked`，通常无需手动设置） |

桌面服务器也可以把这些写进 `~/.cove/server-config.json`，启动时会读入并转为环境变量：

```json
{
  "mediasoupIp": "203.0.113.10",
  "mediasoupPort": 40000,
  "serverSecurityEnabled": true
}
```

### Linux 服务器

服务端编译产物是普通 Node 程序，可以用 systemd 托管：

```bash
npm ci && npm run build:packages
npm run build -w cove-server
node apps/server/dist/index.js
```

需要放通 3001（HTTP/Socket.IO）与 `MEDIASOUP_PORT`（媒体，UDP+TCP）。公网部署必须使用 HTTPS/WSS。

服务端在检测到同级的 `apps/desktop/dist` 时会一并托管前端静态文件，可以直接用服务器地址访问网页版客户端。部署必须同时带上所依赖的共享包和 workspace 运行依赖，不可只复制 `dist`。

## 服务器访问安全

服务器访问密码能力**默认开启**，桌面端与移动端按服务器返回的状态显示密码输入并完成验证。显式关闭时沿用现有账号登录流程，新旧客户端都不需要服务器访问密码，也不会生成初始化凭据。未设置、空值或无法识别的开关值都保持开启，避免配置拼写错误绕过门禁。

通常无需设置启用开关；需要明确关闭时，在启动服务器前设置：

```powershell
$env:COVE_SERVER_SECURITY_ENABLED = "false"
```

打包服务器新建的 `~/.cove/server-config.json` 默认写入 `"serverSecurityEnabled": true`。已有配置不会自动改写：其中显式的布尔值会在启动时覆盖环境变量；已有 `false` 仍保持关闭，需要启用时由管理员改为 `true` 后重启。普通 Node 服务器直接使用环境变量开关，不读取这个打包配置文件。

开启后的新服务器需要先初始化。首次启动沿用现有机制，在数据目录生成一次性管理员凭据 `bootstrap-token.txt`，也可以由部署系统通过 `COVE_BOOTSTRAP_TOKEN` 或 `COVE_BOOTSTRAP_TOKEN_FILE` 提供；服务器访问密码由管理员在客户端初始化时设置，源码不包含默认密码。尚未初始化时受保护的 REST 和 Socket.IO 请求会被拒绝。本次源码变更没有读取或设置实际凭据，也没有启用正在运行的服务器；真实凭据应在用户后续发布时本地配置。

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
- 信令与媒体分别判断断线：短暂信令中断可保留已有媒体和静音状态；新服务器会话或持续媒体失败会清理旧资源，需要重新加入
- 支持的新服务端可对已有媒体通道进行有界 ICE restart：持续断开等待 1.5 秒自愈、失败立即尝试，最多 3 次请求、20 秒总期限；旧服务端保持原策略。不会自动打开采集或恢复远控授权，见 [ICE 恢复说明](docs/architecture/ice-restart.md)
- 登录登记确认缺失时有限重试，耗尽后保留登录记录并允许手动重试；不将丢失 ACK 当成凭据失效

**屏幕与音频共享**
- 屏幕共享，多档分辨率与帧率预设，按画面活跃度自动调整帧率
- 共享屏幕附带系统音频
- Windows 独有：共享单个应用的音频（WASAPI 进程级采集，自动排除 Cove 自身）
- Android：支持屏幕共享和采集缩放选项，目标为 30 FPS；可选播放音频受 Android 版本和被共享应用录音策略限制
- 桌面可显式开启“兼容观看（VP8）”，默认关闭；不改变分辨率、帧率或码率上限，需停止后重新共享。详见 [编码兼容说明](docs/architecture/screen-codec-compatibility.md)，设备兼容性仍需真机验证

**远程控制**
- 请求控制他人的共享屏幕，支持指针、滚轮、按键与安全白名单
- 本地用户活动时自动让位，`Ctrl+Alt+Shift+X` 全局急停
- Android 可作为控制端；远控授权在断线后撤销，重连不会自动重新授权

**语音包**
- 上传音频、裁剪编辑、拖拽排序、重命名、向全房间播放、收藏

**个人资料**
- 头像裁剪（支持 GIF）、本地个人备注名、在线成员与平台标识

**其他**
- 明暗主题、聊天字号调节、自签名服务器证书例外
- 桌面端内置更新中心，手机端启动时自动检查更新

自动更新下载地址与聊天服务器独立：桌面端配置 `apps/desktop/electron/update-config.ts`、手机端配置 `apps/mobile/src/features/updates/updateConfig.ts` 中的 `UPDATE_DOWNLOAD_BASE_URL`，默认留空，只检查 GitHub，不从聊天服务器推导或补填下载地址。明确填写有效 HTTPS 下载地址后，启动时无需登录即可检查该服务器的更新，GitHub 保留为备用源；修改后需重新打包。官方域名为 `cove.luxe`，不预填到下载变量中。桌面端手动“从服务器下载”仍使用当前填写的聊天服务器地址。

## 测试

普通 PR 和 `main` 提交的自动门禁位于 [regression.yml](.github/workflows/regression.yml)，与本地使用同一入口。工作流只检查代码，不打包、发布或安装到设备：

```bash
node tooling/ci-regression.cjs server   # 共享包、服务端类型/单测、loopback 集成和真实 SQLite/SFU smoke
node tooling/ci-regression.cjs desktop  # 桌面类型、独立进程 TS/CJS 测试；Windows 包含原生 helper 夹具
node tooling/ci-regression.cjs mobile   # 手机类型与 Jest（原生边界使用 mock）
node tooling/ci-regression.cjs server --plan  # 仅列出步骤，不执行
```

先按上文安装根目录和手机依赖。入口会构建共享包，遇到失败立即停止；服务端 smoke 只使用 `runtime/` 临时资料和本地端口。桌面测试必须使用桌面目录的 JSX 配置及每文件进程隔离，不能将全套测试改成 `--test-isolation=none`。

这些门禁覆盖逻辑、原生边界夹具和本地集成，不等同于真机或真实网络验收。真实 Chromium 音频测试见 `apps/desktop/package.json` 的 `test:microphone`、`test:rnnoise` 等脚本。手机端 Kotlin 测试在 `apps/mobile/android` 执行 `gradlew.bat testDebugUnitTest -PcoveRefactor`。Android 路由、Wi-Fi/蜂窝切换、弱网、锁屏和长通话仍需统一验收；更多命令见 [自动回归说明](docs/architecture/regression-ci.md) 和 [媒体恢复验证矩阵](docs/testing/media-recovery-matrix.md)。

离线诊断导出可用 `node tooling/analyze-media-diagnostics.cjs <诊断文件.json>` 汇总；`node tooling/verify-media-recovery.cjs --repeat 3` 可重复运行本地恢复回归。RTT 是往返时间，回归报告中的 testDuration 是测试耗时，二者都不是端到端媒体延迟，也不能据此宣称画面或声音延迟改善。

## 发布

桌面端与服务器共用版本号（tag `v*.*.*`），手机端独立编号（tag `mobile-v*.*.*`）。

发布流程有严格的顺序与校验要求：**GitHub Release 先公开，下载服务器镜像最后发布**；更新清单中的版本号与 SHA-256 必须来自最终构建产物实算，不得手填。Gitee 只同步仓库代码与标签，不创建 Release、不上传附件。

完整流程见 [`AGENTS.md`](AGENTS.md)；当前版本内容见 [`RELEASE_NOTES.md`](RELEASE_NOTES.md)，历史见 [`CHANGELOG.md`](CHANGELOG.md)。

本次重构未发布任何更新。后续手机版发布应在核验最终 APK 和下载源之后，同时同步 `apps/mobile/update.json` 与根目录 `mobile/update.json`，保持旧客户端 raw URL 兼容。

## 已知限制

- 服务端成员与语音状态保存在内存中，重启服务器会使所有成员退出语音（房间、消息、账号、禁言记录不受影响）。
- WASAPI 系统/单应用音频共享和远控受控端仅支持 Windows；Android 可作为远控控制端，其播放音频采集使用系统屏幕共享授权，受应用录音策略限制。
- 手机端可发起屏幕共享并选择采集缩放；可选播放音频采集要求 Android 10 及以上且被共享应用允许录制，需要配套支持独立共享通道的服务端。实际帧率取决于画面、编码器和设备。
- 手机端 Release APK 默认保留既有 debug keystore 签名；外部正式签名仅提供显式配置入口，不能直接切换现有用户的签名身份。确认、备份和覆盖安装边界见 [签名迁移说明](docs/architecture/mobile-signing-migration.md)。
- Windows 服务端托盘仍保留现有 Electron 运行时；维护候选未通过原生 SQLite ABI 验证，未激活升级，详见 [运行时维护状态](docs/architecture/runtime-maintenance.md)。
