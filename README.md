# Cove

Cove 是一个实时语音与聊天应用，包含客户端（Web / Electron）和服务器两部分，支持自托管或本地运行。它为多用户房间提供在线存在(presence)、音频/屏幕采集和自定义声包(soundpacks)功能。

## 技术栈
- 语言：TypeScript（客户端 & 服务器）
- 客户端：React + Vite（TypeScript）
- 服务器：Node.js（TypeScript） + Electron（桌面打包/运行）
- 主要库/工具（仓库中可见）：Electron、Vite、React、Tailwind CSS、PostCSS、concurrently

## 仓库结构（重要的顶级条目）
```
.github/                   GitHub 工作流与仓库配置
.gitignore                 忽略规则
CHANGELOG.md               更新日志
Cove服务器配置指南.pdf     服务器部署与配置指南（中文）
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

## 主要功能（从代码中观察到）
- 多房间聊天与界面（client/src/pages/ChatRoom.tsx、RoomList.tsx）
- 实时 presence 与语音支持（server/src/presence.ts、server/src/voicePresence.ts；client 侧有 socket 支持）
- 应用级音频与屏幕采集（client/src/applicationAudio.ts、client/src/screenCapture.ts）
- 声包管理与展示（client/src/components/SoundPackPanel.tsx、server/src/soundpackAudience.ts）
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

## 测试
仓库包含 client/tests 与 server/tests 目录。运行对应包内的测试脚本：
```bash
cd client
npm test

cd ../server
npm test
```
（具体脚本请查看各自 package.json 中的 test 配置。）

## 贡献
- 提交 issue 或 PR 报告 bug、请求新特性或改善文档。
- 在提交代码前请确保通过本地构建与测试，遵循 TypeScript 代码风格并添加必要的测试。
- 仓库未在根目录发现 LICENSE 文件，请在贡献前与仓库维护者确认许可与贡献政策。

## 仓库中的重要文件/入口
- 客户端入口：client/src/main.tsx、client/src/pages/ChatRoom.tsx
- 服务器入口：server/src/index.ts、server/src/voicePresence.ts
- 服务器配置指南（中文）：Cove服务器配置指南.pdf
- 更新与发布记录：CHANGELOG.md、RELEASE_NOTES.md

## 建议你可以问的问题（示例）
- 语音的端到端路由是如何实现的？请查看 server/src/voicePresence.ts 与 client/src/applicationAudio.ts。
- 声包（soundpacks）如何加载与分发到客户端？请查看 client/src/components/SoundPackPanel.tsx 与 server/src/soundpackAudience.ts。
- 生产环境下服务器需要哪些环境变量或证书？请参考 Cove服务器配置指南.pdf 与 client/src/serverCertificate.ts。

---

如果你需要，我可以把这份 README.md 直接提交到仓库（我现在就可以帮你上传）。