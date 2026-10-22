# 普通 PR / main 自动回归

`.github/workflows/regression.yml` 为普通 `pull_request` 和 `main` push 配置三项只读门禁，支持手动触发。它不请求发布权限、不使用 Secrets、不生成发布标签、不上传安装包。相同分支的新提交会取消旧回归，减少重复占用 runner。

| 门禁 | 环境 | 范围 |
| --- | --- | --- |
| Shared core and server | Ubuntu / Node 24 | 共享包构建、client-core 测试、架构边界、服务端及托盘类型检查、服务端每文件隔离单测与 loopback 集成、真实 SQLite/mediasoup smoke |
| Windows desktop | Windows / Node 24 | 共享包构建、桌面类型检查、Electron TS 编译、每文件隔离 TS/CJS 测试；原生输入测试用 no-op 或替换后的 OS 边界，不移动真实鼠标 |
| Mobile logic | Ubuntu / Node 24 | 独立手机 lockfile 安装、共享包构建、手机类型检查与 Jest；原生设备边界使用 mock |

根目录与手机依赖分别通过各自 lockfile 的 `npm ci` 安装。Node 24 用于服务端 `node:sqlite` 夹具。Windows 桌面任务不执行 Electron 的原生 SQLite rebuild，避免改变 Node 运行时的原生模块 ABI；正式安装包仍须走独立发布验证。

## 本地入口

```powershell
node tooling/ci-regression.cjs server
node tooling/ci-regression.cjs desktop
node tooling/ci-regression.cjs mobile
node tooling/ci-regression.cjs desktop --plan
```

入口不安装依赖、不调用 shell 拼接命令；每个步骤有十分钟上限，失败立即停止。新增顶层 `*.test.ts` / `*.test.cjs` 会自动加入对应范围；Electron、人工媒体实验等其它后缀不会被误当作普通单测。桌面 TS 测试使用 `apps/desktop` 的 JSX 配置，每文件独立进程，避免跨文件全局 mock 污染。

`tooling/runtime-smoke.cjs` 使用由 `@cove/contracts` 派生的协议与版本标识，创建本副本 `runtime/smoke-*` 临时资料。它只连接自己启动的本地测试运行时，验证真实 SQLite、mediasoup codec/transport、账号登记、房间和启动/清理。HTTP 使用随机端口，媒体端口为 41020；不要在已有进程占用该端口时运行。它不读取现用 `~/.cove` 数据。CI runner 不运行带 `--hold` 的人工实验模式。

## 本次验证与边界

本模块验证时，runner 计划生成、六项入口契约测试及 workflow YAML 解析通过；实际 `desktop` 入口完成共享包构建、桌面类型检查、Electron TS 编译、394 项 TS 和 85 项 CJS 测试，日志位于本地 `runtime/ci-desktop.log`。修正协议后的真实 SQLite/SFU runtime smoke 通过。完整最终代码回归由整合阶段统一重跑。仅修改工作流文件不会触发远端执行，本次没有推送，也没有远端 workflow 成功记录。

自动逻辑、夹具、loopback 和原生 worker 测试不能替代 Android 真机路由、屏幕录制权限、Wi-Fi/蜂窝切换、真实弱网、锁屏/挂起、长通话与已安装新旧客户端/服务端组合验收。普通门禁不构建 Android APK、不自动安装设备，也不据此宣称可发布或性能提升。
