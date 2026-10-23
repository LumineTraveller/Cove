# Cove

Cove 是面向朋友和小群体的自托管语音、聊天与屏幕共享应用。大家可以在同一个房间里聊天、通话、观看共享画面、播放语音包，也可以在获得授权后远程操作共享者的 Windows 桌面。

| 应用 | 当前源码版本 | 平台 |
| --- | --- | --- |
| 桌面客户端 | **2.1.1** | Windows |
| 桌面服务端 | **2.1.1** | Windows 托盘；服务端也可独立运行在 Linux |
| 手机客户端 | **0.8.3** | Android |

[下载与项目主页](https://cove.luxe) · [GitHub Releases](https://github.com/LumineTraveller/Cove/releases) · [本版说明](RELEASE_NOTES.md) · [历史更新](CHANGELOG.md)

## 开始使用

1. 从官网下载 Windows 客户端，或在 GitHub Releases 下载 Android APK。Windows 服务端安装包供需要自建服务器的人使用，普通成员只需安装客户端。
2. 填写你要连接的服务器地址，使用自己的账号注册或登录。如果服务器启用了访问门禁，先输入管理员提供的服务器访问密码。
3. 创建或加入房间，再加入语音、开始共享或观看朋友的共享。

服务器访问密码、账号密码和房间密码各自独立。请向邀请你的人确认服务器地址和访问方式；自建服务器不会自动获得官方服务器上的账号与房间。

桌面观看时，打开共享底栏的 **“共享操作”上拉菜单 → “置顶小窗”**，即可把画面放到可拖动、缩放的置顶窗口中。关闭小窗或点击“返回主窗口”会回到原观看界面，语音继续。小窗只用于观看；进入前需要退出远控或批注。

## 可以做什么

| 功能 | Windows 桌面端 | Android 手机端 |
| --- | --- | --- |
| 房间与聊天 | 房间密码、人数限制、文字、图片、动图、历史消息 | 创建／加入房间、聊天与图片消息 |
| 语音 | 加入／退出、静音、成员独立音量、输入输出设备选择、降噪与回声消除 | 加入／退出、静音、音量与音频路由、原生降噪 |
| 屏幕共享 | 发起与观看，分辨率／帧率预设，全屏与置顶小窗 | 发起与观看，采集缩放与画质设置 |
| 共享音频 | 系统音频或单个应用音频，可独立调节共享声音 | 可选采集播放音频，受 Android 版本及被共享应用的录音策略限制 |
| 远程控制 | 请求控制、授权、撤销与本地急停；Windows 可作为受控端 | 可请求控制支持远控的 Windows 共享端 |
| 语音包 | 当前房间内上传、编辑、排序、收藏与同步播放 | 当前房间内管理与播放 |
| 诊断与更新 | 媒体状态、手动导出诊断、更新中心 | 媒体状态、手动导出诊断、应用内更新检查 |

桌面端还支持共享画面批注、房间外观设置、个人备注、头像与明暗主题。远控和共享都需要相应权限；Windows 全局远控急停键为 `Ctrl+Alt+Shift+X`。

语音包按房间隔离。升级保留已有记录和音频文件；历史上未归属房间的全局语音包不会被自动分配或广播到新房间。

### 连接与恢复

Cove 分开处理信令连接与媒体连接：信令暂时中断时，健康的语音／观看媒体可以保留，不会仅因登记超时就立即被清理。支持该能力的客户端与服务端会对失败的既有媒体通道进行有限次数的 ICE restart；旧服务端使用兼容的恢复路径。

恢复会保留仍有效的静音和观看意图，但不会自动打开麦克风、启动共享或恢复远控授权。主动离开、切房间和取消观看优先于恢复；服务器重启、会话失效或恢复耗尽时，会清理失效资源并提示重新加入。网络切换能否恢复仍取决于设备、网络和服务器地址可达性。

遇到偶发问题，可以手动导出媒体诊断，保留发生时间和操作步骤。导出包含有限的媒体数值及恢复阶段，不包含账号凭据、ICE 密码、完整 SDP 或聊天内容。RTT 表示往返时间，不是端到端画面／声音延迟。详见 [连接恢复](docs/architecture/connection-recovery.md)、[ICE restart](docs/architecture/ice-restart.md) 和 [恢复诊断](docs/architecture/recovery-diagnostics.md)。

## 开发

仓库使用 npm workspaces，手机端依赖独立安装。建议使用 Node.js **24**（与仓库回归 CI 一致）和 npm；Android 构建还需要 JDK **17**、Android SDK 与 NDK，具体版本见 [手机端说明](apps/mobile/README.md) 和原生工程配置。

```bash
npm ci
npm --prefix apps/mobile ci
npm run build:packages
```

启动本地开发环境：

```bash
npm run dev          # 隔离服务端 + Vite，浏览器访问前端
npm run dev:app      # 隔离服务端 + Vite + Electron 客户端
npm run dev:server   # 仅隔离 Node 服务端
npm run dev:client   # 仅 Vite + Electron，连接已有服务端
```

Windows 也可运行 `./start.ps1` 启动完整开发环境。默认 HTTP 为 `3301`、媒体端口为 `41000`、Vite 为 `55173`；服务端数据和桌面开发档案放在仓库的 `runtime/` 下。启动器只管理自己创建的进程，端口冲突时不会关闭其他程序。

手机开发与构建：

```bash
cd apps/mobile
npm start            # Metro
npm run android      # 构建并运行到已连接的开发设备
npm run android:apk  # 生成 Release APK
```

### 仓库结构

```text
apps/
  desktop/           Electron + React 桌面客户端
  server/            Node 服务端与 Windows 托盘外壳
  mobile/            React Native Android 客户端，独立 lockfile
packages/
  contracts/         共用协议与兼容字段
  client-core/       登记、请求、连接恢复与诊断策略
  media-core/        平台无关媒体扩展接口
  diagnostics/       结构化诊断接口
tooling/             隔离开发、构建与回归工具
tests/               跨端协议和模块边界回归
scripts/             发布与下载镜像脚本
docs/                架构、验证及维护说明
mobile/update.json   旧 raw 更新地址的兼容清单
```

桌面端使用 React、TypeScript、Vite 和 Electron；手机端使用 React Native、Hermes 与 Kotlin 原生模块。Socket.IO 承载信令和聊天，mediasoup SFU 转发 WebRTC 媒体，SQLite 保存账号、房间、聊天和语音包记录。应用之间通过共享包协作，不直接导入另一端的源码。

### 构建与检查

```bash
npm run build:client            # Windows 客户端：apps/desktop/dist-app/
npm run build:server            # Windows 服务端：apps/server/dist-app/
npm run build -w cove-server    # 仅编译 Node 服务端
npm run check                  # 类型、构建与架构检查
```

按受影响范围运行回归：

```bash
node tooling/ci-regression.cjs desktop
node tooling/ci-regression.cjs mobile
node tooling/ci-regression.cjs server
```

[普通 PR／main 回归工作流](.github/workflows/regression.yml) 使用相同入口。逻辑测试、原生边界夹具和本机 SFU 测试不能替代真实设备的音频路由、弱网或长通话验收。更多入口见 [自动回归说明](docs/architecture/regression-ci.md) 和 [媒体恢复验证矩阵](docs/testing/media-recovery-matrix.md)。

## 自建服务器

Windows 可使用桌面服务端安装包，通过托盘配置运行。Linux 可直接构建和启动 Node 服务端：

```bash
npm ci
npm run build:packages
npm run build -w cove-server
MEDIASOUP_IP=203.0.113.10 node apps/server/dist/index.js
```

示例中的 `203.0.113.10` 需替换成客户端能够访问的实际公网 IP。可用 systemd 等进程管理器托管 Node 服务。

直接启动时，HTTP／Socket.IO 默认使用 **3001**，WebRTC 媒体默认使用 **40000（UDP 与 TCP）**。公网部署需要 HTTPS／WSS，并正确转发媒体端口；只代理 HTTP 无法保证媒体可达。当前没有配置通用 TURN 中继。

| 环境变量 | 用途 |
| --- | --- |
| `COVE_HTTP_PORT` | HTTP／Socket.IO 监听端口，默认 `3001` |
| `MEDIASOUP_IP` | 对客户端公布的可达媒体地址，本机开发可用 `127.0.0.1` |
| `MEDIASOUP_PORT` | 媒体端口，默认 `40000`，映射时需保持公布地址与端口正确 |
| `COVE_DATA_DIR` | 数据目录，默认 `~/.cove` |
| `COVE_DOWNLOAD_DIR` | 安装包和更新清单目录；Linux 默认 `/var/www/cove-download` |
| `COVE_TRUST_PROXY` | 仅在可信反向代理正确设置转发头时设为 `true` |
| `COVE_SERVER_SECURITY_ENABLED` | 访问门禁默认开启；显式设为 `false` 可关闭 |
| `COVE_BOOTSTRAP_TOKEN` / `COVE_BOOTSTRAP_TOKEN_FILE` | 由部署环境提供一次性初始化凭据 |

服务端默认数据目录包含 `cove.db`、`sounds/`、`chat-images/` 等内容。升级前备份完整数据目录；运行中备份数据库应使用 SQLite 在线备份，或先停止服务再备份。服务器重启会丢失内存中的在线／语音会话，持久化记录仍保留。

桌面服务端将配置保存到数据目录中的 `server-config.json`；其中已有的显式配置会在启动时生效。普通 Node 服务端使用环境变量。部署时需带上共享包和 workspace 运行依赖，不能只复制 `apps/server/dist`。

### 首次访问与安全

访问门禁开启的新服务器会生成一次性 `bootstrap-token.txt`，也可以使用上面的环境变量注入初始化凭据。管理员在客户端“服务器安全设置”中完成初始化，设置独立的服务器访问密码。源码没有默认访问密码。

客户端在服务器要求时完成访问验证；账号登录和房间密码仍分别校验。门禁开启时，不支持所需协议的旧客户端可能需要先升级。公网连接应使用 HTTPS／WSS，避免在 URL、日志或共享截图里暴露访问凭据。

## 更新与发布

官网下载地址和 GitHub Releases 提供分发入口；自动更新的下载来源与用户填写的聊天服务器地址独立：

- 桌面端配置：`apps/desktop/electron/update-config.ts`。
- 手机端配置：`apps/mobile/src/features/updates/updateConfig.ts`。
- 两端的 `UPDATE_DOWNLOAD_BASE_URL` 默认留空，此时只检查 GitHub。显式设置有效 HTTPS 下载地址并重新打包后，才检查该下载服务器，保留 GitHub 备用源。
- 不从聊天地址推导自动更新地址，也不自动补填官方域名。官方域名为 `cove.luxe`。
- 桌面手动“从服务器下载”使用当前选择的聊天服务器地址；自建服务器需另外提供对应的 `/downloads/` 和 `/releases/` 文件。

Android 更新由应用检查清单，再交给浏览器／系统安装器完成下载和用户确认安装。覆盖升级需要兼容的签名身份及递增的 `versionCode`；更换签名的边界见 [Android 签名迁移说明](docs/architecture/mobile-signing-migration.md)。

桌面客户端与桌面服务端使用 `vX.Y.Z` 标签，手机使用独立的 `mobile-vX.Y.Z` 标签。发布先校验最终安装包，再公开 GitHub Release、镜像同一产物，最后公布更新清单。Android 清单需同时维护 `apps/mobile/update.json` 与兼容副本 `mobile/update.json`。Gitee 只同步源码、清单及标签，不创建 Release 或上传附件。完整操作与完成条件见 [AGENTS.md](AGENTS.md)。

## 进一步阅读

- [模块架构与扩展点](docs/architecture/README.md)
- [屏幕发布与换流生命周期](docs/architecture/screen-publication-lifecycle.md)
- [桌面与手机编码兼容](docs/architecture/screen-codec-compatibility.md)
- [语音包处理队列与资源限制](docs/architecture/soundpack-processing.md)
- [桌面置顶观看小窗](docs/architecture/floating-viewer.md)
- [Windows 服务端运行时维护](docs/architecture/runtime-maintenance.md)
- [Android 构建与发布](apps/mobile/README.md)
