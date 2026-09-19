# Cove

Cove 是一个实时语音与聊天应用，包含客户端（Web / Electron）和服务器两部分，支持自托管或本地运行。它为多用户房间提供在线存在(presence)、音频/屏幕采集和自定义语音包(soundpacks)功能。

## 技术栈
- 语言：TypeScript（客户端 & 服务器）
- 客户端：React + Vite（TypeScript）
- 服务器：Node.js（TypeScript） + Electron（桌面打包/运行）
- 主要库/工具（仓库中可见）：Electron、Vite、React、Tailwind CSS、PostCSS、concurrently

## 仓库结构
```
.github/                   GitHub 工作流与仓库配置
.gitignore                 忽略规则
CHANGELOG.md               更新日志
Cove服务器配置指南.pdf      服务器部署与配置指南（中文）
RELEASE_NOTES.md           发布说明
assets/                    静态资源
client/                    前端应用（Vite + React + TypeScript）
design-audit/              设计审计材料
design-qa.md               设计/QA 记录
design-qa/                 设计 QA 相关文件
mobile/                    移动端相关（可能为进行中）
package-lock.json          npm 锁文件
package.json               根工作区 package.json（包含 scripts 与 workspace 配置）
server/                    服务器代码、Electron 打包相关
start.ps1                  Windows 启动/辅助脚本
```

## 各部分如何协同
- 这是一个基于 npm workspaces 的 monorepo，两个主要包：client（UI）和 server（后端 + Electron）。
- 客户端（client/src）是一个 Vite + React 的单页应用，主要页面文件有 client/src/pages/ChatRoom.tsx（聊天室页面）、RoomList.tsx（房间列表），组件如 SoundPackPanel、ProfileModal 等负责 UI 展示与交互。
- 服务器（server/src/index.ts）负责实时协同、presence 与 voice 的协调，包含 voicePresence、presence 等模块；Electron 相关的代码也放在 server/electron 或 client/electron 目录下以支持桌面打包。
- 运行时流程：客户端通过 client/src/socket.ts 与服务器建立 WebSocket（或类似）连接，用于实时存在和消息/音频路由；客户端负责音频采集与播放（applicationAudio.ts、screenCapture.ts、mediaDiagnostics.ts），服务器负责房间与音频分发、声包管理等逻辑。

## 主要功能
- 多房间聊天与界面（client/src/pages/ChatRoom.tsx、RoomList.tsx）
- 实时 presence 与语音支持（server/src/presence.ts、server/src/voicePresence.ts；client 侧有 socket 支持）
- 应用级音频与屏幕采集（client/src/applicationAudio.ts、client/src/screenCapture.ts）
- 语音包管理与展示（client/src/components/SoundPackPanel.tsx、server/src/soundpackAudience.ts）
- Electron 桌面打包与测试（server/electron、client/electron 相关目录）
- 媒体设备诊断工具（client/src/mediaDiagnostics.ts）

## 快速开始（开发）
前提：
- 安装 Node.js（建议 LTS）与 npm

从仓库克隆并安装依赖：
```bash
git clone https://github.com/LumineTraveller/Cove.git
cd Cove
npm install
```

运行开发模式（如果根 package.json 的 `dev` 脚本会同时启动 server 与 client）：
```bash
npm run dev
```

或者分别启动：
```bash
# 在一个终端启动服务器
cd server
npm install
npm run dev

# 在另一个终端启动客户端
cd ../client
npm install
npm run dev
```

- 客户端通常会通过 Vite 提供本地开发服务器；服务器在本地运行后，客户端通过配置的地址/端口连接。
- Windows 平台有 start.ps1 脚本帮助启动（根据用途双击或在 PowerShell 中运行）。

构建与打包（示例）：
```bash
# 构建 workspace（client 与 server）
npm run build
# 随后使用 server 中的 electron 打包脚本进行桌面构建（详见 server/package.json）
```

详细部署与生产环境配置请参阅仓库中的中文文档：Cove服务器配置指南.pdf

## 服务器访问安全

服务器访问密码能力随程序安装，但默认关闭。关闭时沿用现有账号登录流程，新旧客户端均
不需要服务器访问密码，也不会生成初始化凭据。需要启用时，在启动服务器前设置：

```powershell
$env:COVE_SERVER_SECURITY_ENABLED = "true"
```

打包的服务器也可以在 `~/.cove/server-config.json` 中设置
`"serverSecurityEnabled": true`，然后重启服务器。启用后的首次启动会在数据目录生成
一次性管理员凭据 `bootstrap-token.txt`（默认 `~/.cove`，或 `COVE_DATA_DIR` 指定的
目录）。也可以通过环境变量
`COVE_BOOTSTRAP_TOKEN` 或 `COVE_BOOTSTRAP_TOKEN_FILE` 由部署系统提供凭据。
客户端第一次连接新服务器时，用这个凭据设置独立的“服务器访问密码”；它与
账号密码、房间密码互不相同，初始化成功后一次性凭据会被删除（使用环境变量时
由外部密钥管理）。

`GET /api/security/status` 只是用于检查服务器状态，不会主动弹出客户端初始化窗口。
桌面端登录页会在输入服务器地址后自动检查状态，并在地址下方显示“服务器安全设置”：
新服务器填写一次性初始化凭据，并在“服务器访问密码”中设置至少 8 位的新密码；已初始化
服务器只填写已有的服务器访问密码即可。这个密码与账号密码是两套独立凭据。

仅在服务器明确启用访问门禁后，未携带当前客户端协议标识的旧版客户端会收到“客户端版本过旧，无法
登录，请升级到最新版本”的提示；服务器不会因此删除原有账号或聊天数据。

服务器访问密码只在服务端以带盐哈希保存。客户端拿到的是有过期时间的访问令牌，
桌面端令牌只保留在当前应用窗口的 sessionStorage/内存中，移动端只保留在当前进程内，
不会把服务器密码写入 URL、localStorage
或 AsyncStorage。公网连接的初始化、解锁、REST、静态音频/图片和 Socket.IO 均须
使用 HTTPS/WSS；仅 loopback 的本地开发连接允许 HTTP。反向代理部署如能正确设置
`X-Forwarded-Proto`，可显式设置 `COVE_TRUST_PROXY=true`。

客户端历史记录仍保存用户输入的服务器 URL 用于实际连接；DNS 解析得到的规范化
IPv4/IPv6 地址集合只用于历史记录键，因此同一服务器的域名和 IP 别名可以合并，
不会把连接地址替换成解析后的 IP。

## 测试
仓库包含 client/tests 与 server/tests 目录。运行对应包内的测试脚本：
```bash
cd client
npm test

cd ../server
npm test
```
（具体脚本请查看各自 package.json 中的 test 配置。）

## 仓库中的重要文件/入口
- 客户端入口：client/src/main.tsx、client/src/pages/ChatRoom.tsx
- 服务器入口：server/src/index.ts、server/src/voicePresence.ts
- 服务器配置指南（中文）：Cove服务器配置指南.pdf
- 更新与发布记录：CHANGELOG.md、RELEASE_NOTES.md
