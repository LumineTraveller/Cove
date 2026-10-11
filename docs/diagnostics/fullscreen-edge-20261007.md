# Cove 完全全屏最顶行输入：舍入修复与验证记录

## 当前结论

在刚交付的统一候选基础上，已复现 y=0 原始指针事件进入 VIDEO 后被映射拒绝的问题，并完成最小修复。桌面测试时段随后获得明确授权，**04:01:03 UTC 的可见全屏全宽横移与真实原生回放、04:03:38 UTC 的控制激活且视频焦点下原生 Escape 均通过**。光标和原前台窗口恢复，未检测到用户活动，没有当前执行环境阻塞。

产品修复及安装包构建源码提交：`aaed71019747e60eecaa8a36f5c011e9a6f0f62d`，独立分支 `fix/remote-input-latency-20261007`；其后提交只完善测试工具和验收记录。基础为 `a706e218` / `d0e3540`，保留 `74331dc` 桌面账号密码记忆。产品代码只改两个文件：ScreenVideo 传入实际 devicePixelRatio，normalizedVideoPoint 容忍不足一个物理像素量级的布局舍入空隙。未改媒体采集/编码/发送、服务器、移动端、批注实现或正式 main；未安装、发布、部署或推送。

## 实际版本与根因证据

2026-10-07 03:29:09 UTC，只读核对本机正在运行的已安装路径 `AppData/Local/Programs/cove-client`：

- app.asar SHA-256：`88c6c1379908860e4a2d7fc921531ffd54855280f8ef622baef68144c46e90ec`。
- remote-input-helper.exe SHA-256：`f633c96636f187ee4bfacff3132652ab5bac606e99c2e28a13048d83c56a497b`。
- 二者与上一统一候选逐字节一致。主进程 PID 68528 的创建时间为 02:45:19 UTC；helper PID 94748 创建于 02:48:47 UTC。这是本机观察，不应据此把另一端 03:17 的重启或 connected 状态当作其构建哈希验证。

没有读取进程参数、真实账号、密码或用户配置。[本机版本证据](fullscreen-edge/installed-version.json) 单独记录了哈希采样时间与先前进程元数据来源。

在实际产品 ShareViewV2、RemoteScreenVideo、样式和完全全屏按钮的离屏独立窗口中，03:24:56 UTC 记录修复前行为。物理显示器为 2560×1600、系统缩放 150%；完全全屏 CSS 区域被舍入为 1707×1067，合成视频为 2560×1600：

`1707 × (1600 / 2560) = 1066.875`，顶部空隙为 `(1067 - 1066.875) / 2 = 0.0625 CSS px`。

`apps/desktop/src/features/remote-control/remoteControl.ts` 原先严格使用 object-contain 浮点边界拒绝黑边，因 `0 < 0.0625` 将顶行视为黑边。原始 pointerrawupdate 已命中 VIDEO，x=0 与 y=0 也分别被发送节流器、服务器校验及原生输入校验允许；问题发生在发出前的归一化映射。当前入口位于 `apps/desktop/src/features/media/screen/ScreenVideo.tsx:79`，新舍入处理位于 `apps/desktop/src/features/remote-control/remoteControl.ts:85`。

03:29:17 UTC 的 Windows WM_NCHITTEST 查询中，自有原生全屏窗口的外框和客户区均为 `(0,0)-(2560,1600)`，顶行、y=1/2/10、左右顶角的返回值全为 1（HTCLIENT）。本复现场景的标题栏及原生缩放边框没有截走事件。查询异步执行，未阻塞 Electron 消息循环；不是实际系统鼠标横移的证明。当前用户 Cove 主窗口另一次只读查询处于最小化状态，不用于证明其完整全屏命中。

## 修复与已完成检查

先拒绝实际视频元素矩形以外的点；对 object-contain 产生的整条空隙，仅在它不超过 `1 / devicePixelRatio` CSS 像素时，将命中范围延伸到元素边缘。仍按真实 contain 区域归一化，并将边界夹到 0/1。常规黑边、菜单命中和授权范围不扩张；未增加全局鼠标监听或重复发送。原有 8 ms 节流、动作顺序、撤销和释放保持原实现。

| 页面缩放 | 修复前 y=0 原始 / 发送 | 修复后 y=0 原始 / 发送 | 总发送（前→后） |
| --- | ---: | ---: | ---: |
| 100% | 4 / 0 | 4 / 4 | 12→16 |
| 125% | 4 / 0 | 4 / 4 | 12→16 |
| 150% | 4 / 0 | 4 / 4 | 12→16 |

每档覆盖 x=0、x=1、中间、最右内侧，y=0、1、2、10；顶行归一化为 y=0。检查使用可信 Chromium 输入和离屏实际组件，不代表物理鼠标采样。Fullscreen API 退出、完全全屏重入、可信 Esc 退出，以及停止控制后不再发送均通过。[汇总与边界](fullscreen-edge/summary.json)、[修复前记录](fullscreen-edge/baseline-hidden-inspection.json)、[修复后记录](fullscreen-edge/fixed-hidden-scale-1.5.json) 保存完整小型证据。

- 34 项远控回归通过，新增两个针对舍入顶角、多档像素比、负坐标几何及真实黑边的测试；没有重跑此前全部媒体实验。
- 桌面类型检查、生产前端构建、Electron/C# 编译通过。仅恢复本次构建生成的 rnnoise 文件行尾变动。
- 03:39:44 UTC，最终包真实 Cove.exe / ASAR 启动通过；独立隐藏配置中的账号密码桥、Windows safeStorage 加解密、外来窗口 IPC 拒绝、授权/撤销、队列清空、迟到 ACK 拒绝和输入释放通过。此包测试将系统 SendInput 替换为仅记录实现、快捷键替换为自有回调，**不算本轮真实 Windows 注入通过**。
- 03:40:33 UTC，五项 NSIS 载荷与已测试 unpacked 文件一致；最终前端 JS/CSS 与本次源码构建输出一致，账号记忆编译文件一致。
- 04:04:09 UTC，在真实桌面测试后复验同一安装包，五项载荷再次匹配，大小和 SHA-256 不变；实际测试 helper 和 controller 也与最终包载荷匹配。此后只改测试工具及证据，未改产品源码或重新打包。

## 覆盖候选

`apps/desktop/dist-app-remote-input-2.0.1/Cove-Setup-2.0.1-fullscreen-edge-account-memory.exe`

大小：106,573,126 bytes。

SHA-256：`d783adf8f736d5a40a06b6614703387b744c94e65a4c9cd6c8296c6939ec661d`。

身份保持 Cove / com.cove.app / cove-client / 2.0.1，无 Lab flavor。旧统一候选、原始输入单独包和 2.0.0 回退包保留；复用同一 unpacked 输出和现有依赖，未新增一份大型运行时。安装包与完整载荷哈希见 [artifact.json](fullscreen-edge/artifact.json)。其中版本政策引用 2026-10-06 18:44:40 UTC 的既有只读观测，不是本轮重新访问主服务。

## 真实桌面复测及边界

原协调阻塞已解除。`tooling/fullscreen-edge-live.cjs` 实际显示自有窗口，通过产品完全全屏按钮进入全屏，用生产 native controller/queue/helper 产生系统鼠标移动，另用 C# GetCursorPos 独立验证位置。真实物理客户区为 2560×1600、150% 系统缩放；顶部 y=0 从 x=0 横扫到 x=2559，含相邻顶角像素，同时覆盖 y=1/2。

| 页面缩放 / 实际 DPR | 系统移动 / 原始事件 / 映射发送 | 顶行系统移动 / 原始 / 映射 | 顶行物理范围 |
| --- | ---: | ---: | --- |
| 100% / 1.5 | 49 / 46 / 46 | 35 / 34 / 34 | (0,0)→(2559,0) |
| 125% / 1.875 | 49 / 46 / 46 | 35 / 34 / 34 | (0,0)→(2559,0) |
| 150% / 2.25 | 49 / 46 / 46 | 35 / 34 / 34 | (0,0)→(2559,0) |

147 次源端系统移动的独立 OS 坐标与目标完全一致，所有实际投递的原始事件均可信且命中 VIDEO，顶行事件全部归一化到 y=0。三档真实可见布局的顶部 contain 空隙分别约 0.1250、0.1000、0.0833 CSS px，证实离屏复现的同类舍入问题也存在于可见窗口。

49→46 的差异发生在 DOM 投递之前：每一行的 x=0→1 物理移动被 OS 独立观测，但没有产生第二个 DOM pointerrawupdate；原始事件数与映射发送数相同。不能把每条 native 命令都当作一个必然存在的 DOM 原始事件，或把这个差异归给映射丢弃。

捕获输出随后进入生产验证器、原生队列和同一包内 helper，138 条真实原生回放均无抑制，独立 OS 位置与归一化命令的目标每轴误差不超过 1 px。全屏退出、重入、停止后不再发送和撤销后拒绝输入通过。04:03:38 UTC 另做了短小的原生 Escape 检查：激活控制并给予视频焦点后，用生产 helper 仅向自有前台窗口注入 Escape 按下/释放，全屏退出、重入及键释放通过。

测试使用独立配置，不点击、不输入用户内容、不读取真实配置、不录制用户屏幕。活动保护通过低层输入钩子只输出是否出现用户活动的布尔状态，不记录用户按键内容；硬件输入、外来注入或前台/目标窗口不符即停止。检测到用户接管时不覆盖其新的光标/前台状态；正常完成则还原原始状态。两次成功测试都未检测到活动，光标和原前台窗口恢复，测试 helper 已退出。正在运行的真实 Cove 会话及其紧急快捷键注册未操作。

最初可见启动器沿用了离屏检查的 `windowsHide:true`，使自身窗口隐藏，检查在任何注入之前停止；改用授权的可见启动后继续。第一次计数检查假定每条系统移动都产生 DOM 事件，已依据真实原始事件记录修正口径。这些是测试工具问题，产品源码和安装包未再更改。

物理源事件采样与捕获输出的原生回放分阶段执行，避免同机控制端/被控端反馈环；不将其描述为同时工作的跨网端到端测试。当前仅一块物理显示器，混合 DPI 多屏仍缺实机覆盖；负原点已有几何单测。用户跨网视频回显、另一端安装哈希和升级安装未测。

摘要见 [live-summary.json](fullscreen-edge/live-summary.json)，完整自有窗口数据见 [live-windows.json](fullscreen-edge/live-windows.json)，激活控制的原生 Escape 检查见 [live-native-escape.json](fullscreen-edge/live-native-escape.json)。重复运行仅应在已协调的桌面时段进行，Vite 使用 127.0.0.1:55179：

```powershell
$env:COVE_EDGE_DESKTOP_WINDOW_GRANTED='1'
node -e "const cp=require('child_process');const e=require('./apps/desktop/node_modules/electron');const r=cp.spawnSync(e,['tooling/fullscreen-edge-live.cjs'],{stdio:'inherit',windowsHide:false});process.exit(r.status??1);"
```

本轮实际证据为 `runtime/fullscreen-edge/live-windows.json` 和 `live-native-escape.json`。当前没有桌面协调或工具权限阻塞；对端安装哈希、用户跨网反馈及混合 DPI 多屏仍属验证边界。
