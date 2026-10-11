# 桌面远控输入延迟与鼠标跳变：本地修复候选

基线为正式 `Projects\Cove` 的 `65df1690f6f88f2dbfde13e244c297be567abccc`，首次核对时间为 2026-10-06 17:37:44 UTC，工作树当时干净。修复位于独立副本 `C:\Users\cyj06\Documents\Codex\2026-10-06\task-2\Cove-remote-input-fix`，分支 `fix/remote-input-latency-20261007`，回退分支 `checkpoint/published-main-65df169`。产品修复提交为 `d4c18a4`；桌面版本号仍为 2.0.0。本轮没有安装、发布、推送、重启服务，也没有修改正式目录、移动端、认证或服务端协议。

持续快速移动时的稀疏跳变，最吻合已复现的移动限频，以及可复现的可靠传输积压。首次开启控制时还存在 helper 在“ready”之后才支付解析冷启动开销的问题。这三项均有代码和隔离实验支持，但没有用户这次会话的输入时间戳，不能确定各项在真实体验中的占比，也不能宣称真实网络体验已经完成验收。

## 代码证据与修复

| 阶段 | 发现及准确位置 | 最小修复或保留边界 |
| --- | --- | --- |
| 控制端采样→发送 | 基线 `remoteControl.ts` 的固定 16 ms 合并把位置更新限制在约 62.5 Hz；超过此频率的真实采样被合并。`useRoomController.ts:884` 的回调使用稳定 `useCallback([])`，没有随渲染重建的证据。 | `apps/desktop/src/features/remote-control/remoteControl.ts:10,30` 改为 8 ms，最高约 125 Hz，保留即时首样本、最新尾样本和动作屏障，不生成插值位置。低刷新采样本身仍可能只有 60 Hz。 |
| 发送→Socket.IO | 基线 `RemoteControlLifecycle.send()` 对在线连接逐条可靠 emit。Engine.IO 暂时不可写或已有缓冲包时仍会保存旧位置。Socket.IO 没有在应用发送端自动合并这些位置。 | `apps/desktop/src/features/remote-control/remoteControlSession.ts:156,184`：不可写时只保留一个最新的未发送移动；drain/upgrade 后可靠发送最终尾部；按钮、滚轮、键盘先发送对应移动再发送动作。没有改为易丢失的 volatile 尾样本。 |
| 会话撤销 | 断线、停止、取消、旧会话重放必须不能重启注入。 | `remoteControlSession.ts:178` 清理监听，stop 同步清除未发送位置；强制移动屏障后 `:169` 再核对授权，撤销可阻止紧随其后的按钮动作。既有会话安全逻辑保留。 |
| 服务转发 | `apps/server/src/features/remote-control/socketHandlers.ts:215` 仍可靠转发；`remoteControl.ts:4` 限制每会话 240 条输入/秒。 | 未修改服务器。125 Hz 不是服务器限额；频繁动作屏障也计入其预算。下行可靠队列仍可能积压，需真实链路数据甄别。 |
| IPC→原生排队 | `apps/desktop/electron/remote-input-queue.ts:83` 只有一条命令进入管道，其余保留在有界应用队列。64 条上限、500 ms 超时及动作顺序没有改变。 | 热身后的空输入管道足以处理此发送频率，本轮不扩大并发或管道队列。空输入不能排除真实 SendInput/IPC 成本。 |
| 原生准备→第一条输入 | 基线先输出 ready，再首次调用 `JavaScriptSerializer.Deserialize<Message>` 和 Handle。冷启动的第一条空输入回执明显慢于热身后。 | `apps/desktop/electron/remote-input-helper.cs:286` 在 ready 之前解析并处理一个未知类型 no-op，支付解析/分派 JIT 成本。预热不注入鼠标或按键；准备阶段仍需花费这部分时间。 |
| 本地鼠标优先 | `remote-input-helper.cs:61` 保留硬件鼠标活动后的 400 ms 保护窗口。受控用户移动鼠标可让远控暂时停顿，然后直接跳到最新位置。 | 属于既有优先控制机制，没有删除或缩短；本次用户是否触发它没有数据。 |
| OS 光标→视频反馈 | helper ACK 表示消费命令，未证明 SendInput 成功或 OS 光标已经呈现；控制端看到的视频还经过采集、编码、网络、解码与呈现。 | 本轮没有改光标视觉平滑、视频链路、200 Mbps/GCC/codec/FPS，也没有继续旧优化实验。 |

小白点由 `apps/desktop/src/styles/ui-v2.css:3032` 的 CSS 光标定义，仅改变控制端本地光标外观，没有预测或 OS 注入。原生批注覆盖层在 `apps/desktop/electron/annotation-overlay.ts:108,109` 控制鼠标穿透和焦点；绘画激活条件在 `useSharerAnnotationOverlay.ts:95`。`ShareViewV2.tsx:97` 在本地绘画时关闭该画面的远控输入。没有证据表明白点样式引入了这次输入延迟；批注模式与实际会话转换仍需用户复测。

## 有限测量与验证

测量均在独立工作区，未录制屏幕、操作用户窗口或向 OS 注入鼠标/键盘。所有时间为 UTC。原始结果保存在相邻 `remote-input-20261006/` 目录，运行细节及完整回归日志保存在工作区 `runtime/`。Electron 为 44.0.0，Chromium 为 152.0.7977.54，Node 为 v24.11.1。

| 验证 | 正式基线 | 候选 | 解释与限制 |
| --- | --- | --- | --- |
| 隐藏 Chromium 窗口内 144 个合成 pointermove，约 1 秒，18:09:10 | 发送 62 个，P95 发送间隔 17.5 ms，最大 18.9 ms | 发送 111 个，P95 间隔 12.0 ms，最大 12.6 ms | 两者最终样本索引均为 143。说明真实浏览器定时器下位置更新更密；没有证明 OS 光标帧率。采样到发送均值没有稳定下降，不能用这项推导端到端延迟改善百分比。 |
| 同机 helper：ready 后首条 no-op 回执，18:13:06 | 77.30 ms | 0.92 ms | 冷解析开销移动到准备阶段，不能解读为每次会话总启动耗时下降同等数值。进程启动到 ready 的单次值分别为 318.50/294.61 ms，易受调度和运行时冷启动影响。 |
| 同机 helper：20 条预热之后的 200 条 no-op，18:13:06 | P95 0.161 ms，最大 0.670 ms | P95 0.154 ms，最大 0.644 ms | 热身后 ACK 本身不是明显的持续吞吐瓶颈；不含 SendInput 或 Electron IPC。 |
| 回环发送端人工不可写 200 ms，18:09:07 | 恢复时缓冲 10 包：1 个测试标记及 9 个旧位置 | 缓冲 1 包：仅测试标记；未发送移动保留最新值 | 两者最终尾样本均被消费。源端积压位置被合并，不能据此认为服务器下行或 WAN 排队也已解决。 |
| 回环静止、30 Hz 慢移、144 Hz 快移、拖拽混合滚轮/Shift、人工背压 | 所有情形尾样本正确，动作顺序正确，限流拒绝 0 | 同左 | 真实 Socket.IO 回环、原服务器授权/清洗/限流类、原本地队列；原生管道强制改写为 no-op。Node 的 Windows 定时粒度与浏览器不同，不能从这个回环计数推导界面采样频率。 |

功能回归共 **86 项通过**：远控 32；批注模型/输入 12 和覆盖层 3；屏幕采集/呈现策略 28；服务器远控及批注 11。覆盖了高刷新真实样本保持、500 Hz 输入限频、最终尾部、点击/拖拽/滚轮/按键屏障、归一化坐标的 100/125/150/200% 缩放及横竖视频黑边、断线/撤销/重放、旧 helper 释放、管道背压/超时，以及批注覆盖层穿透和焦点。

原生安全回归使用测试专用编译副本，将唯一 SendInput 边界替换为 stdout 记录并省略该副本的全局硬件钩子。它验证预热零注入、鼠标/按键分派顺序、绝对坐标和 stop 后释放，不会调用真实系统输入。它不等同于真实 DPI、多显示器、提权窗口或 Windows 光标呈现验收。测试生成的小文件保留在 `runtime/cove-native-input-fixture-*`，未执行盘点清理或删除。

共享包构建、桌面类型检查、Electron/C# 编译、计时脚本严格类型检查和桌面生产构建通过。默认沙箱曾阻止 Vite/esbuild 父目录查找及 Electron 子进程读取；隔离路径下的构建/隐藏测试通过自动审批后完成。没有遗留审批阻塞。

## 重现命令与交接

在独立副本根目录运行已有依赖，不需下载、开启旧研究或连接正式服务：

```powershell
npm run test:remote-control -w cove-client
npm run test:annotations -w cove-client
npm run test:screen-capture -w cove-client
node node_modules/tsx/dist/cli.mjs --test apps/server/tests/remoteControl.test.ts apps/server/tests/annotations.test.ts apps/server/tests/annotationSocketIntegration.test.ts
node tooling/remote-input-noop-timing.cjs runtime/noop-candidate.json
node tooling/remote-input-noop-timing.cjs runtime/noop-baseline.json --baseline
node node_modules/tsx/dist/cli.mjs tooling/remote-input-pipeline-timing.ts
```

隐藏浏览器测量从 `apps/desktop` 运行 `node_modules/electron/dist/electron.exe tests/remoteControlTiming.electron.cjs`。脚本设置独立 userData/sessionData，窗口不显示、不抢焦点、不连接服务。回环脚本仅绑定 `127.0.0.1` 的系统分配端口。基线 helper 是修复前在此工作区编译并保留的 `runtime/remote-input-helper-baseline.exe`；纯净新 checkout 要先从 checkpoint 编译并保存该基线，不能把候选 helper 当成基线。

产品变更仅三个文件及相关回归。可供父任务审阅/cherry-pick `d4c18a4`，或在独立副本选择 checkpoint 对比。正式目录无需回滚。构建出的本地 helper SHA-256 为 `3AB21B49FA050D9784198ECB25EFF358894A91D66E72F2942D30A77E037D5BC7`；这是本轮文件指纹，不是发布包指纹，也不是每次重编译均相同的承诺。

仍需用户在空闲时用候选完成约 30 秒、只针对自行创建测试窗口的两端复测。本轮没有安装候选，也没有打断正在进行的共享：

1. 记录两端运行候选及控制端显示器刷新率，维持原共享分辨率/FPS/码率设置。先退出绘画模式；共享发起者把本地鼠标静置至少 0.5 秒。
2. 依次静止、慢直线、快速往返、拖动测试窗口内对象，核对滚轮和 Shift 拖动。共享发起者观察真实 OS 鼠标，控制者分别观察本地小白点和视频反馈；不需要录制无关屏幕。
3. 核对本地鼠标优先保护、绘画进入/退出、撤销控制及断线后的停止行为。
4. 若仍有持续延迟，下一次最小采集应记录 Socket.IO 实际 transport、两端移动接收频率、源端发送缓冲和本地队列年龄/ACK耗时，并与现有视频诊断同一时段对齐。跨机时钟需校准或使用往返测量；不能把不同机器的 performance.now 直接相减。当前没有这次用户会话的此类数据。

服务器下行可靠排队、真实 SendInput 成本/失败、硬件鼠标保护触发情况和视频反馈延迟仍待验证。若确实需要服务端输入新鲜度或时间戳协议变更，应先与另一个负责移动端/认证的任务协调。本轮没有将它们混入桌面修复。
