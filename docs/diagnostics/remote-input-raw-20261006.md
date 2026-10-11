# Cove 2.0.1：远控光标跳变、绿色边框和顶部输入修复

已定位并修复浏览器渲染帧率限制鼠标输入的路径。2026-10-06 20:00:14 UTC 的受控双端对照，旧组件产生 38 次真实 Windows 光标变化，新组件产生 127 次；原生光标间隔中位数由 33.23 ms 变为 8.35 ms。该结果证明本机链路的瓶颈和修复，尚不能认定用户异地会话已经验收。

产品及诊断提交为 `76992b24e8ad6a84c8fc6405f21d7e4a67274274`，位于现有独立 `fix/remote-input-latency-20261007` 分支。没有安装、发布、部署、推送或合并。服务端代码/配置、移动端和正式工作树没有修改，旧媒体优化没有恢复。

## 版本和来源核对

19:33 UTC 核对本机 `AppData/Local/Programs/cove-client/resources/app.asar`：版本 2.0.1、包名 cove-client。ASAR SHA-256 为 `f0944ac08f738849d92321b5c83ed6ed4ccc8373677586d196d19b3e2c2dc299`；helper 为 `82e1d5097e57e32933440c83d4d0894d1b7cdcffdbba48cb21e091be7b8ae026`。两者及 main/remote-control/remote-input-queue 模块逐字节匹配上一轮交付的候选。此时没有运行中的 Cove.exe，无法取得用户刚才那次会话的采样或网络统计。

## 根因和改动

- `apps/desktop/src/features/media/screen/ScreenVideo.tsx:97`：旧组件只使用 pointermove。Chromium 会按渲染更新合并此类事件，在控制端画面渲染较慢时，8 ms 的后置节流仍收不到足够位置。[Chrome 的输入对齐说明](https://developer.chrome.com/blog/aligning-input-events)解释了这种合并。改为支持安全上下文中的 pointerrawupdate，只使用真实最新鼠标位置；保留 8 ms/125 Hz 发送上限、最终尾部和点击/键盘/滚轮动作屏障。`:136` 避免同一鼠标再次从 pointermove 重复发送；不支持原始事件的环境以及笔/触摸仍走原路径，退出控制会移除监听和待发尾部。
- `apps/desktop/src/styles/ui-v2.css:3078`：应用全屏共享层原来低于 38 px 透明原生拖动标题栏。对照顶部命中为 cove-window-titlebar，三个可信移动均不能进入视频。应用全屏时隐藏该标题栏，并标记共享面为 no-drag；修复后命中 VIDEO、三个输入均送达。共享状态栏及 Esc 保留退出操作，普通窗口标题栏保持原行为。
- 原 `ScreenVideo.tsx:184` 的 remote-control-frame 和原 CSS `:3035` 无条件绘制绿色应用边框，已删除。最终打包 JS/CSS 均无此标记。没有禁用或修改 Windows 系统捕获/隐私提示。
- `apps/desktop/electron/remote-input-helper.cs:176`：检查 SendInput 返回值；Windows 拒绝注入时返回错误并安全停止，不能再仅以消费 ACK 伪装成功。`:275,286` 对每个已按下键/按钮都尝试释放，单项失败不会跳过其他项，并报告释放失败。`:303` 让 helper 的屏幕指标、标题按钮命中和诊断位置使用与绝对注入一致的物理 DPI 空间。
- helper 的 `--diagnostic` 参数仅在自有测量进程开启，回执附带处理时长、物理位置和硬件优先抑制标记。正常客户端不会开启，也没有增加插值或长队列。

## 真实 Windows 与双端测量

本机显示器 2560×1600，Windows 缩放 150%，Electron 44/Chromium 152。独立原生测试窗、独立 Electron 配置；仅绑定 127.0.0.1 的 Socket.IO 中继，使用现有服务端授权/清洗/转发代码。控制源为 Electron 可信鼠标输入，实际 React 视频组件、渲染进程 IPC、原 RemoteInputController/有界队列、真实生产 SendInput 和 Windows GetCursorPos 均参与。控制源不是物理鼠标采样；没有连接正式服务，没有录制用户屏幕。

对照旧/新组件都使用同一新 helper，以隔离浏览器入口这一变量。额外的旧安装包 helper 直接测试在 19:36 UTC 完成：150 个实际注入位置零误差，持续 ACK P95 1.36 ms；首个冷鼠标调用曾达 64.3 ms，不能用此前 no-op 预热试验排除真实首帧冷开销。

下面为 20:00:14 UTC 的有限低渲染帧率对照：将测试浏览器离屏渲染设为 30 FPS，输入源 150 个位置、目标 8 ms 间隔。实际异地客户端的渲染帧率尚未采集；不能把视频 FPS 直接当作浏览器渲染 FPS。

| 测量 | 旧组件 | 新组件 |
| --- | ---: | ---: |
| 浏览器收到原始鼠标事件 | 143 | 145 |
| 发出/IPC/实际光标变化 | 38 / 38 / 38 | 127 / 127 / 127 |
| 实际光标变化间隔 P50 / P95 | 33.23 / 34.39 ms | 8.35 / 16.12 ms |
| 原始样本到发送 P95 | 15.60 ms | 8.80 ms |
| 发送到本机中继 P95 | 1.04 ms | 0.58 ms |
| 中继到 IPC P95 | 0.49 ms | 0.37 ms |
| IPC 到管道发送 P95 | 0.07 ms | 0.04 ms |
| 管道 ACK P95 | 1.91 ms | 1.27 ms |
| helper 处理 P95 | 1.10 ms | 0.90 ms |
| 注入后物理位置误差 | 各轴 ≤1 px | 各轴 ≤1 px |
| 本地硬件优先抑制 | 0 | 0 |
| 顶部三个移动送达 | 0 | 3 |

时间戳比较仅发生在同一 Windows 主机，按各进程 performance.timeOrigin 对齐；相同位置回返时取最近且不晚于下游的记录。光标间隔来自独立原生采样进程。GetCursorPos 更新不能代替 DWM/显示器每帧呈现计时；本轮没有测 WAN 的 RTT、丢包或可靠传输阻塞。

新链路没有保证每个间隔都为 8 ms：实测 P95 仍约16 ms，存在浏览器定时与系统调度抖动。源端 125 Hz 上限也低于本机 240 Hz 屏幕与高轮询物理鼠标，不能承诺与本地硬件体验完全等同。

真实按住测试窗内左键和 Shift，再通过真实 Windows 注入 Control/Alt/X，触发实际注册的 Ctrl+Alt+Shift+X。独立 GetAsyncKeyState 确认 left/shift/control/alt/x 均释放，最终无保持状态；已撤销会话后输入拒绝。另验证原始移动与普通移动不重复、关闭控制后不采样，均有断言。

32 项远控、15 项批注、28 项采集/呈现、10 项浏览器光标检查通过；新增原生拒绝注入和部分释放失败的回归覆盖在远控32项内。桌面类型检查、生产构建及 Electron/C# 编译通过。最终 unpacked Cove.exe 的真实 ASAR 启动与权限/撤销烟测在20:02:49 UTC通过；该包级安全烟测仍使用无输入替身，与前述真实 OS 实验分开记录。

## 交付和复测

同身份本地安装包位于 `apps/desktop/dist-app-remote-input-2.0.1/Cove-Setup-2.0.1-raw-input.exe`；仍为版本2.0.1、appId com.cove.app、产品 Cove，无 Lab flavor。实际大小、SHA-256、五项 NSIS载荷校验及包级结果见 [产物清单](../../runtime/remote-input-raw-artifact.json)。旧2.0.1安装包和 runtime/rollback-2.0.0 均保留；只复用一份 unpacked 输出与现有依赖。

用户需在停止共享、退出 Cove 后自行安装；控制端与共享端都使用这个 raw-input 文件，因为单看2.0.1版本号无法区分两轮候选。先在自建空白窗口做慢移、快移、拖拽、滚轮、Shift拖拽和紧急停止；共享者观察 OS 光标，控制端分别观察本地白点和返回视频。全屏顶部与退出操作一起复核。

若仍卡顿，下一步是两端同一时段约10秒的限定诊断：采样/发送/接收次数与间隔、实际 transport、发送缓冲、接收到 IPC、队列等待/ACK、硬件优先抑制；另记 RTT/丢包和视频反馈。跨主机不能直接相减 performance.now。默认应用未开启 helper 的逐输入诊断，不应把本机数据当成用户实测。本轮没有外部权限阻塞，但用户异地会话不在当前执行环境中，且核对时客户端已退出；需要用户安装本候选后提供该有限复测结果。

复现入口：tooling/remote-input-live.cjs、tooling/remote-input-windows-probe.cs 及 apps/desktop/tests/ui/remote-input-live.*。详细小文件保留于 runtime/remote-input-live/result-render30-traced.json 和 windows-render30-traced.json；没有生成大量视频/原始屏幕样本。

最终安装器校验在20:06:35 UTC完成，20:07:18 UTC确认已安装ASAR仍为旧包且无运行中的Cove/helper。随后执行终端出现 `exec-server transport disconnected`，重连超时；文件写入工具仍可用，已补齐本报告及相邻 `remote-input-raw/` 摘要。产品提交76992b2已存在，最后的文档提交尚未执行。这是执行连接阻塞，未发生自动审批拒绝。

20:37 UTC执行连接恢复，已确认此前没有重复整合。该报告与摘要现补交文档提交；随后将另行整合独立桌面密码记忆提交01a0630，并以新的统一安装包及报告交付，以上数据仍属于raw-input独立候选。
