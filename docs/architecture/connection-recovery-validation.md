# 连接生命周期重构验证记录（2026-10-22）

基线为 `a355579`（桌面 2.1.0 / 手机 0.8.2），工作分支为
`codex/connection-lifecycle-stability`。常用的 2.0.1 目录及其原有图标删除未修改。
没有安装依赖、改服务端协议、推送、发布、部署或访问生产服务。

## 变更与回滚边界

| 提交 | 范围 | 行为说明 |
| --- | --- | --- |
| `2ea0687` | 结构重构 | 提取共享信令恢复 controller 和手机薄适配 hook；媒体期限从 teardown 移出，保留两端当时的恢复策略 |
| `18cf5d4` | 已复现缺陷修复 | 原生音频独立所有权、迟到路由结果失效、观看/初始化 Promise 按媒体代次隔离、纯观看连接归属 |
| `d9ef3f7` | 显式策略变化 | 同 socket 最多六次登记、耗尽后手动重试；手机信令超时保留已有可恢复媒体，继续保留独立媒体失败期限 |

新增策略可以通过撤销 `d9ef3f7` 单独回退，保留前两项结构和资源修复。
如需完整回退，按相反顺序撤销这三个提交即可。没有数据库或线上迁移。
验证文档后续提交不改变运行行为。

## 已完成验证

先完成当前 main 基线的 57 项连接/媒体/服务端期限相关测试，以及手机
123 项相关测试。新增测试先复现旧 ACK、原生等待后幽灵加入/清理缺口等问题。
独立审阅发现旧 `deviceSetup` Promise 阻塞新操作后，再增加组合测试，确认
“旧观看初始化待 ACK → fresh reconnect → 立即加入/观看”两项在修复前失败、修复后通过。

最终运行代码验证：

| 检查 | 结果 | 能证明的范围 |
| --- | --- | --- |
| 手机 Jest 全量 | 45 套 / 520 项通过 | 登记、媒体 hook、UI、共享与远控等既有回归；含新增断线/取消组合 |
| 桌面及 client-core TS 测试全量 | 386 项通过 | 使用桌面 tsconfig、Node 默认进程隔离运行；包含登记/30 秒期限/共享恢复策略 |
| 架构、启动、导航、Electron 适配等 CJS 检查 | 54 项通过 | 包边界、既有 UI/更新适配约束；编译产物来自本副本 |
| Socket.IO 恢复、远控撤权、媒体生命周期 | 17 项通过 | loopback 真实信令中断/恢复及服务端处理器；媒体生命周期使用测试资源 |
| 服务端房间完整运行时集成 | 10 项通过 | 临时 SQLite、合成音频与伪媒体；认证、接管、容量、房间、独立屏幕 transport |
| 原生 SFU 集成 | 6 项通过（含父用例） | 真实 mediasoup worker、loopback 合成资源；乱序分配、离开/迟到发布、消费取消、短断线后继续发布 |
| Electron 44 渲染器夹具 | 8 项断言通过 | 实际 ChatRoomV2/useWebRTC，假信令；断线/登记等待不清理、页面离开仍清理 |
| TypeScript | 桌面、手机、服务端、Electron 通过 | 另完成共享包构建和 Electron TypeScript 编译 |
| 独立只读补丁审阅 | 未发现新增阻塞性回归 | 已再次审阅旧 Promise 修复、主动离开/切房、迟到回调、幂等清理、旧服务端兼容 |
| 工作区 | `git diff --check` 通过 | 三个实现提交后工作区干净 |

关键新增断言包括：三轮延迟 CONNECT 保留静音/已有媒体，不重复 produce；
纯观看不申请麦克风、不启动捕获；发送或接收单侧失败仍按 7.5 秒清理；
离开、卸载、切房、换 socket 后的迟到原生结果不能复活旧加入或停止新会话；
旧初始化不能阻塞新的加入/观看；登记耗尽后保留凭据并可同 socket 重试。

常规复跑入口（先构建共享包）：

```powershell
# apps/mobile
node node_modules/jest/bin/jest.js --runInBand --no-cache
# apps/desktop：必须使用该目录的 tsconfig 和独立测试进程
node --import tsx --test --test-concurrency=1 tests/*.test.ts ../../packages/client-core/tests/*.test.ts
# 仓库根目录
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/mobile/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/server/tsconfig.build.json
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/electron/tsconfig.json
```

## 环境限制与未验证项

本机复用已存在的依赖，通过本副本中的目录链接读取；没有安装或重建原目录依赖。
默认沙箱阻止 tsx/esbuild、ffmpeg、mediasoup worker 及 Electron IPC，因而这些
本地测试通过明确限定的沙箱升级运行，均已完成，没有待批准/结果不明的动作。
一度采用 `--test-isolation=none` 扩跑桌面测试，导致全局 mock 冲突和错误 JSX
配置下的四项失败；改为桌面目录配置与默认进程隔离后，386 项全部通过。
没有为适应该测试启动方式修改产品代码。

Electron 夹具使用全新临时 profile、隐藏窗口、拒绝设备权限并限制为本任务
`127.0.0.1:55193`。临时 Vite 及失败残留测试进程已停止。原生 SFU 和房间
集成只使用 loopback、临时数据及合成媒体。

**仍不具备直接发布验收条件。** Android 真机路由、Wi-Fi/蜂窝切换、真实丢包/
抖动、锁屏/系统挂起、长时间通话和实际已安装的新旧客户端/服务端组合尚未
整链路验证。服务端重启/状态丢失在客户端层验证为 fresh session 清理旧资源，
没有声称完成真实应用服务器重启的双客户端整链路验收。

没有引入 ICE restart、自动重新加入、自动重开麦克风/屏幕共享，或远控授权
自动恢复。现有 Socket.IO 物理重连退避与服务端 5 秒 peer grace 不变；六次上限
约束的是每个连接的应用登记轮次，并不将既有物理重连改成六次。
