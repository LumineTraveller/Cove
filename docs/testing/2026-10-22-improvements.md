# 2026-10-22 本地改进与统一验收

本文记录 `d8eb548` 的交付基线。其后新增的 ICE restart 设计、行为、验证和回滚
单独记录在 [ICE 恢复说明](../architecture/ice-restart.md)；下文“未引入 ICE restart”
及测试计数描述该基线，不代表后续增量仍未实现。

本次只交付本地源码和可运行测试入口，未推送、发布、部署或安装到设备。分支为
`codex/connection-lifecycle-stability`，基于当前 main `a355579`，保留最初三个连接改进提交。
用户常用的 `C:\Users\cyj06\Desktop\Projects\Cove` 未被改动；其中原有图标删除也未覆盖。

## 直接运行本地测试版本

在 PowerShell 中进入当前完整副本：

```powershell
Set-Location C:\Users\cyj06\Documents\Codex\2026-10-22\task\Cove-connection-stability
.\tooling\start-local-test.ps1 -Check
.\tooling\start-local-test.ps1
```

入口复用本机已有 Node、依赖和 Windows 编译工具，不下载或安装依赖；启动独立
Node 服务端、Vite 和桌面 Electron 窗口。`-Check` 只输出检查结果，不启动服务。
默认 HTTP 为 `127.0.0.1:3313`、媒体端口为 `41020`、Vite 为 `127.0.0.1:55193`。
如端口被占用，可指定 `-HttpPort`、`-MediaPort`、`-RendererPort`；不会清理其他程序。
`Ctrl+C` 只终止入口自己启动的进程树。也可分别用 `-ServerOnly`、`-ClientOnly` 启动。

测试服务器数据、桌面档案、下载目录和 Vite 缓存分别放在
`runtime/acceptance-server`、`runtime/acceptance-desktop`、
`runtime/acceptance-downloads`、`runtime/acceptance-vite-cache`。
入口启用本地服务器访问门禁，并清除当前子进程继承的 bootstrap token 配置，
不会借用现用服务的一次性凭据或数据。首次启动后，用测试目录中的
`runtime/acceptance-server/bootstrap-token.txt` 在登录页初始化测试服务器，
再创建测试账号和测试房间。退出入口时恢复调用它的进程环境变量。

此副本的依赖使用已安装依赖的目录链接；不要在此运行安装或 native rebuild，
以免改变被借用的依赖。Git 对象已完整复制，源码历史不依赖旧副本的 Git 对象目录。

已生成的编译结果位于 `apps/desktop/dist`、`apps/desktop/dist-electron`、
`apps/desktop/build` 和 `apps/server/dist`。三个 Windows helper 已成功本地编译。
没有生成桌面安装包或 APK，没有自动打开现用应用，也没有安装到任何设备。
启动入口的检查模式、隔离服务端实际启动（HTTP 状态检查为 200、门禁开启）、底层编译
和真实 Chromium 测试已验证；测试后已停止该入口自有进程，交互式界面的完整验收
仍由下面的清单记录。

## 结构与行为变化

| 范围 | 变化与维护入口 | 独立提交 |
| --- | --- | --- |
| 连接和恢复 | 共享登记/恢复决策与平台适配器、媒体资源和 UI 意图分离；登记 ACK 有界重试；信令暂断保留健康媒体；迟到回调按会话所有权失效。新增恢复策略从 `packages/client-core` 策略层扩展，平台采集仍留在应用侧 | `2ea0687`、`18cf5d4`、`d9ef3f7`、`cc6705e` |
| 换流续看 | `screenWatchRecovery.ts` 管理既有观看意图；同一共享 session 的 producer 替换最多 5 秒、合计 3 次，不因公告风暴重置预算；取消、离开、切房间和明确停止优先。服务端通过可选能力字段确认支持 | `b874334` |
| 编码兼容与采集所有权 | 显式 VP8 兼容开关默认关闭，根据发送能力协商，失败在采集前提示。video/audio 发布各自取消异步工作、清理自己拥有的资源，旧关闭事件不误停新流 | `5086551`、`318a6e5`、`559463f` |
| 语音包 | FFmpeg 全局有界队列、等待/执行超时、取消和资源保护，拥塞有明确错误；排序验证完整房间列表，覆盖 500/501/2000 项及乱序/过期输入 | `b4cfe13`、`abba532` |
| 诊断与回归 | RTT 明确为客户端至 SFU 往返时间；离线汇总与可重复恢复工具；协议 fixture 使用当前共享协议，普通 PR/main 接入同一本地门禁 | `479f6a4`、`ede7ab5`、`b70f947`、`4b7a9c4` |
| 运行时和签名准备 | native rebuild 目标从 manifest 派生并检查物理隔离；Android 外部签名显式配置和校验，默认保留旧签名身份。重大运行时候选未直接启用 | `4a59913`、`16036d0`、`842735d` |

没有引入 ICE restart、自动重新加入语音、自动重新采集或自动恢复远控授权。
媒体失效和服务端新会话仍清理旧媒体，需要用户重新加入。观看续接只适用于已确认
支持可选能力的新服务端与共享方；旧服务端和未带新字段的旧事件保持原停止行为。
本地代码尚未部署，不能假设现用服务端已经支持这些能力。

扩展边界及所有权细节分别见 [连接恢复](../architecture/connection-recovery.md)、
[共享生命周期](../architecture/screen-publication-lifecycle.md)、
[编码协商](../architecture/screen-codec-compatibility.md)、
[语音包处理](../architecture/soundpack-processing.md)。

## 已完成的验证

| 项目 | 结果及证据 |
| --- | --- |
| 桌面最终门禁 | 共享包构建、类型检查和 Electron 编译通过；417 个 TS 测试、85 个 CJS 测试通过。`runtime/ci-desktop-final.log` |
| 手机最终门禁 | 类型检查和 46 个 Jest suites、528 个测试通过。原生边界使用 mock；`runtime/ci-mobile-final.log` |
| 服务端门禁 | 151 个服务端 TS 测试、共享核心 8 个和根工具 29 个测试通过；真实 SQLite/SFU smoke 通过。随后 native 隔离守卫的 5 个测试单独通过。`runtime/ci-server-final.log` |
| 恢复专项 | 3 轮、9 个 suite-round 全部通过，无超时和取消。`runtime/recovery-verification-final.json` |
| 双 Chromium 实际媒体 | 真实 Chromium/WebRTC/SFU + 合成输入；协商 VP8、非黑解码帧、同 session 信令恢复、停止共享后保留语音和自有后端清理均通过。`runtime/media-integration-result.json`、`runtime/real-webrtc-final.log` |
| 桌面生产构建与 helper | Vite 构建、Electron 编译、remote-input/application-audio/annotation-window helper 编译通过。`runtime/desktop-build-final.log` |
| 依赖审计 | 根目录和手机 lockfile 只读审计为 0 个公告；没有盲目改锁文件或强制升级。运行时支持期限和 ABI 另行检查，不能用审计结果替代 |

复跑普通回归：

```powershell
node tooling/ci-regression.cjs server
node tooling/ci-regression.cjs desktop
node tooling/ci-regression.cjs mobile
node tooling/verify-media-recovery.cjs --repeat 3 --output runtime/recovery-verification.json
```

三条门禁会构建共享包并执行类型检查及各自测试；不会发布。真实媒体测试不是默认
CI 的一部分，其入口为 `apps/desktop/tests/ui/media-integration.electron.cjs`，需要本地
Vite fixture、独立 Node 和桌面 Electron。上述 Chromium 结果没有测真实屏幕采集、
Android 编码、Wi-Fi/蜂窝切换、真实弱网或长通话，也没有测端到端延迟。

## 统一用户验收顺序

具体预期和自动/人工边界见 [完整矩阵](media-recovery-matrix.md)。建议每项记录
客户端/服务端提交、设备与系统、网络、步骤、预期/实际结果及诊断 JSON。

1. 在独立测试房间验证正常加入、静音、共享、观看、停止共享和离开；停止共享不退出语音。
2. 通话和观看中制造短暂信令中断，确认健康媒体保留、没有重复播放或重复生产/消费，远控权限撤销且不自动恢复。
3. 连续恢复多次，并在恢复等待中主动离开、切房间或取消观看；确认迟到事件不重建幽灵会话，也不打开共享。
4. 用测试服务模拟状态丢失；确认旧媒体清理、需要重新加入。不要在现用服务器上重启或注入故障。
5. Android 共享触发编码回退时检查既有观看者续看；主动停止优先、不同共享 session 不续接，旧 producer 关闭不误停新画面。
6. 桌面默认模式和显式 VP8 模式分别对 Android 观看，确认协商成功或明确提示，不静默改变全体用户默认画质。
7. 同时处理多个语音包、排队中取消、执行中取消、达到队列上限，并验证超过 500 项的完整排序和失效列表拒绝。
8. 在真实 Android 上验 Wi-Fi/蜂窝切换、锁屏、长时间通话与观看；对照进程资源、音频重复、恢复次数和状态提示。

## 保留边界、发布条件与回滚

- Windows 服务端托盘仍使用 Electron 29.4.6。Electron 44 候选未激活：本机已有 SQLite native ABI 与候选不匹配，缺候选 headers/完整 native 构建环境；没有下载、安装工具或重建共享依赖。候选报告在 `runtime/server-runtime/44.0.0-win32-x64.json`，后续步骤见 [运行时维护](../architecture/runtime-maintenance.md)。
- Android 正式签名只准备入口与校验；未生成/替换密钥、未修改旧签名或 Secrets。完整 Gradle 构建缺可复用的 Gradle distribution/Groovy 运行时，因此没有 APK；具备环境后按 `apps/mobile/README.md` 的独立 `coveRefactor` 流程构建，禁止直接替换现用正式版。签名身份迁移需另行确认，见 [迁移说明](../architecture/mobile-signing-migration.md)。
- 旧全局语音包迁移属于可选项，本次未新增迁移入口，也未执行迁移。没有以该事项拖延已完成的核心改动。
- 独立审阅已检查主动离开/切房间、迟到回调、清理幂等、旧服务端兼容，并修正两项发现；最终冻结补丁的只读评估随交付报告提供。自动测试通过不代表发布验收完成；当前仍需上述真机和真实网络验证，不能标为可直接发布。
- 各功能按独立提交保留，可在此本地分支使用 `git revert <对应提交>` 回退；先保存本地新改动。需整体返回基线时使用单独分支/副本查看 `a355579`，不要对用户常用目录执行硬重置。本次未新增数据库结构迁移，测试数据全部在此副本的 `runtime/`。

此前一次编辑被自动审批误判为初始只读范围而拒绝；提供用户已授权实现的会话证据后，
同一操作重试获准并完成，后续回归通过。当前没有遗留拒绝、待批权限或结果不明的执行。
