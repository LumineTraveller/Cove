# 依赖与服务端运行时维护（2026-10-22）

本次只读审计当前根目录与手机的 package-lock：`npm audit --package-lock-only
--ignore-scripts` 两份结果均为 0 advisories。结果仅代表查询当时 npm 公告库对
锁文件的检查，不能证明 Electron、原生二进制或运行中的服务没有风险。
没有执行 `npm audit fix`、安装依赖或改写借用的 node_modules。

服务端和根目录仍固定 Electron 29.4.6，桌面为 44.0.0。Electron 官方仅维护
最近三个稳定大版本，且只给各大版本的最新 minor 提供相应修复；29 已超出维护
窗口。44.0.0 是复用现有桌面资源的候选基线，不声称它是最新安全补丁。
依据：[Electron 支持政策](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)、
[44.0.0 发布说明](https://releases.electronjs.org/release/v44.0.0)。

## 已实现的维护入口

`apps/server/scripts/native-runtime.cjs` 从服务端 package.json 读取固定 Electron
版本，不再把 29.4.6 硬编码在 native rebuild 命令里，也不使用可能安装新工具的
`npx`。它调用已有 `prebuild-install`。重建前会比较真实路径，拒绝写入指向其他
checkout 的目录链接。本任务使用共享依赖链接，因此不能通过该入口改写常用副本。

```powershell
# 仓库根目录；只打印路径、目标及参数，不写依赖、不下载
node apps/server/scripts/native-runtime.cjs plan
node apps/server/scripts/native-runtime.cjs plan --candidate
# 仅打开 :memory: SQLite，不导入服务端、不建 HTTP/媒体监听或托盘
node apps/server/scripts/native-runtime.cjs check --candidate
# 候选已有私有 native 副本时，可明确选择它；命令不复制或安装依赖
node apps/server/scripts/native-runtime.cjs check --candidate --module-dir <绝对路径>
```

`electron/runtime-candidate.json` 明确标为 `candidate-not-activated`。它不改变
服务端 package.json、锁文件、当前 release workflow 或已安装服务。普通
`rebuild:native` 仍以服务端 manifest 的版本为准；候选 rebuild 另外要求模块位于
本副本 `runtime/`，避免以“验证候选”为由污染正式或共享依赖。

## 候选的实际验证结果

实际运行现有 Electron 44.0.0，确认其 Node 24.18.1 / NODE_MODULE_VERSION 149。
当前借用的 better-sqlite3 12.10.0 二进制是 ABI 137；内存数据库加载被明确拒绝。
探针记录在本地 `runtime/server-runtime/44.0.0-win32-x64.json`，失败会返回非零，
不会因 Electron 的退出状态差异把 JSON 中 `ok:false` 判成通过。

本机 node-gyp 缓存仅有 24.11.1、29.4.6 headers，没有 44.0.0 headers；未找到
默认 Visual Studio Installer。没有为此安装/下载 headers、编译器或新依赖。
因此没有激活这个跨大版本升级，也没有生成宣称可发布的新版托盘安装包。
官方也要求 Electron 升级时针对其 ABI 重建原生模块；better-sqlite3 12.10.0
发布说明还记录过撤回 Electron 42 预编译支持，不能假定 44 的预编译包存在。
依据：[原生模块文档](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)、
[better-sqlite3 12.10.0](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.10.0)。

## 激活前需完成

在单独安装/构建授权及隔离依赖环境中准备目标 Electron 的 native 产物，先使
候选 ABI/内存 SQL 探针通过；再验证完整服务端的认证、房间、真实 SFU worker、
FFmpeg，托盘图标/菜单/退出，以及打包后的 unpacked native 路径。迁移测试只能
使用临时数据、loopback 端口和独立 profile。随后再单独更新 server/root
manifest、锁文件与有依据的依赖快照测试，运行正常 CI 及安装包冒烟。

这项升级目前是**已落地验证入口、已确认原生阻塞、尚未激活**，不是已完成升级。
