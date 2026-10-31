# 原生屏幕采集验收记录（2026-10-29）

## 结论与采用路径

本轮采用原生 DDA → GPU 缩放/光标合成 → 三个 BGRA 共享纹理 →
Electron 隔离渲染器 → 有界 Generator 写入队列 → 原 Producer 的路径。
保留用户选择的 AV1/VP8、码率、分辨率比例和降级策略。
GPU 路线不经主进程传送整帧 CPU 像素，但 Chromium 后续仍可能转换、读回和
进行软件编码，不能称整条链路零拷贝。

本机 1080 高度的真实整屏采集已测得约 118–120 fps。最终普通策略下的一次
30.915 秒采样为采集 118.41、写入 117.22、编码 116.65、解码 116.59 fps。
这不是每个环节恒定 120 fps，也不是长通话可靠性承诺。

本机屏幕为 2560×1600、240 Hz，保持比例后的 1080 档实际为 **1728×1080**。
没有把它写成 1920×1080。更大的 1920×1200 对照通过了画面和资源检查，
但采集约 115.59 fps，尚未达到 120。其他显示器上的完整 1920×1080 仍需实测。

## 环境与测量边界

- Windows 11 23H2；Ryzen 9 7945HX；RTX 4060 Laptop，驱动 560.94。
- Electron 44.0.0 / Chromium 152.0.7977.54。
- 两个真实 Chromium 客户端、产品媒体 hooks、隔离本机 SFU，以及受控动态整屏画面。
- 原生采集速率使用 helper 自身时钟上的 `newFrames` 增量，排除 refresh。
  写入、media-source、编码、解码使用各自真实计数，不能互相替代。
- 每次检查真实输出尺寸、已知颜色、不断前进的画面序列与最终资源清理。
  这没有逐帧保存屏幕，也没有用重复帧填充速率。
- 不连接正式服务，不安装、不发布、不修改系统网络或显示配置。

## 关键实测

原始结果在仓库忽略的 `runtime/fps-validation-throughput-20261028/` 内。
目录日期使用执行时 UTC；本文日期使用上海时间。

| 结果目录后缀/条件 | 真实尺寸 | 采集 fps | 编码 fps | 解码 fps | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| `1080-gpu-direct-30s-av1-rA7zP2`，31 秒，测试进程禁用后台降优先级 | 1728×1080 | 119.95 | 117.68 | 117.71 | 通过 |
| `final-1080-gpu-30s-republish-av1-91uHea`，30.915 秒，默认进程策略 | 1728×1080 | 118.41 | 116.65 | 116.59 | 通过，另通过停止后重新共享 |
| `final-1080-minimized-matched-observer-av1-9k8RhJ`，真正最小化，默认后台策略 | 1728×1080 | 119.82 | 117.91 | 117.69 | 通过 |
| `1080-gpu-direct-no-live-info-vp8-O48y5L`，现有兼容模式 | 1728×1080 | 119.32 | 102.86 | 102.74 | 通过，编码侧缺口保留 |
| `1920x1200-gpu-direct-av1-WoHD9V`，更大画幅 | 1920×1200 | 115.59 | 95.24 | 95.23 | 画面/清理通过，帧率未达目标 |

各速率的计数边界和时钟区间不同。表内通过表示尺寸、画面前进和清理等契约
通过；不能仅凭 `passed:true` 宣称 120 fps 达标。

`1080-stock-matched-no-live-info-av1-5Boob0` 的 Chromium 原路径发生自动缩小，
输出曾为 384×240/576×360，因尺寸保护判定失败。其约 48 fps 和 CPU 数字
不能作为等分辨率性能节省对比；本轮不据此宣称总 CPU 降幅。

## 定位并修正的测量干扰

1. **共享启动后立即枚举完整 GPU 信息。** 测试夹具原本调用
   `app.getGPUInfo('complete')`。Electron 会请求 Dawn 等能力收集，其中有同步
   加载驱动、创建设备的活动 GPU 主线程工作，足以干扰 capture 和 release fence。
   相同 Canvas 模块在跳过此查询后从启动后超时变为持续工作；原 BGRA 直接路线
   也随之通过。默认改为共享期间不做完整枚举，仍保留启动/结束时的 basic 信息。
   详细源码依据见同目录 `native-gpu-screen-capture.md`。
2. **最小化测试额外改用了 bitmap OSR 接收端。** 它与普通窗口基线不等价，
   会在同一机器增加合成和复制负担。将接收端对齐为普通 hidden 窗口后，默认
   后台策略、真实最小化/hidden 状态仍通过完整尺寸与约 120 fps 采集验证。
   因而没有向产品加入后台节流 governor 或进程优先级开关。

显式研究入口保留：`COVE_FPS_LIVE_GPU_INFO=1` 重现完整枚举干预；
`COVE_FPS_MINIMIZED_VIEWER=offscreen` 保留额外 OSR 负担；
`COVE_FPS_DISABLE_RENDERER_BACKGROUNDING=1` 和
`COVE_FPS_MINIMIZED_THROTTLING=0` 只用于区分因素。默认测量不依赖它们。

## 未采用的路径与安全门

- Canvas 研究模块在有限合成输入中曾达到约 120 个不同画面/秒，但实际全链路
  只约 90 fps，比原 BGRA 直接路径慢。普通主程序不传该研究开关，验收包默认
  不采用 Canvas 转换。其私有队列、取消、阶段统计和 Chromium 1 ms 通知门保护
  仅作为隔离研究参考，不能冒充产品性能成绩。
- GPU NV12 直接输入在 `1080-gpu-nv12-no-live-info-av1-UKgp6e` 触发渲染器
  `0xc0000005` 崩溃，该运行判失败。主进程原生资源及 SFU 资源归零，但崩溃
  渲染器无法完成自身清理观测。未重复尝试驱动补丁或绕过校验。
- Controller 现在在加载桥、创建 helper、消耗选择或 request ID 前，以
  `unsupported_pixel_format` 拒绝 GPU NV12，保留已发布的原采集流。
  GPU BGRA 与已经验证的 CPU NV12 BT601/BT709 不受此门影响。这不改变编码格式。

## 生命周期与自动检查

`final-540-gpu-lifecycle-av1-KpiFOL` 通过以下九步：静止画面下晚加入观看；
三轮 720p60 ↔ 540p120 设置切换；结束本轮自建原生 helper；故障后手动重新共享
并回到 Chromium 原路径。语音身份和 RTP 进度保留，最终媒体、helper、句柄与
SFU 资源归零。约 9.09 秒操作序列是短时回归，不是长稳测试。
该次静止检查没有命中 helper 的 no-present refresh 分支，不将它算作该分支覆盖。

最终 30 秒对照还验证了 stop 后旧源结束、新消费者建立、真实解码继续前进，
没有请求 GPU 重启。正常最小化测试中记录了原生窗口最小化、DOM hidden、
后台节流仍为 true，未靠伪造可见性通过。

自动检查证据：

- `npm test --workspace apps/desktop`：903 次测试执行，23 组脚本，零失败。
- 原生 helper 严格编译及 272 项 CPU 自测通过；没有安装或下载编译工具。
- 前端/Electron 类型检查；工具 CPU 回归 49 项；独立补丁审阅。
- 前端生产构建和验收包校验结果随候选包保存。

本轮原生二进制：

- helper SHA-256：`adcec7f92f16aa7c786e3787c15860b4a523cdce6200e6895d485273b9342229`
- bridge SHA-256：`3f5ca9fbe932208206162b2b7165b9b04caed7b77f9ee2c4d1045300bd05cd4a`

## 重复验证与回滚

先运行已有构建命令，不安装缺少的依赖：

```powershell
npm test --workspace apps/desktop
node apps/desktop/electron/build-native-screen-capture.cjs --output apps/desktop/build/native-screen-capture-helper.exe --handles-output apps/desktop/build/native-screen-handles.node --self-test
npm run build --workspace apps/desktop
```

真实前台测试需要独占受控画面，测试入口为
`node tooling/verify-screen-performance.cjs`。本机 1080 档示例配置：

```powershell
$env:COVE_FPS_NATIVE_GPU='1'
$env:COVE_FPS_NATIVE_STORAGE='gpu'
$env:COVE_FPS_NATIVE_PIXEL_FORMAT='bgra'
$env:COVE_FPS_NATIVE_FRAME_SINK='generator'
$env:COVE_FPS_NATIVE_COMPLETION='query'
$env:COVE_NATIVE_GPU_CAPTURE_TIMING='1'
$env:COVE_FPS_LIVE_GPU_INFO='0'
$env:COVE_FPS_DISABLE_RENDERER_BACKGROUNDING='0'
$env:COVE_FPS_PEER_RENDER_MODE='hidden'
$env:COVE_FPS_SAMPLE_SECONDS='30'
$env:COVE_FPS_CASES='[{"source":"native","captureTarget":"screen","preset":"1080p","fps":120,"game":true,"compatibility":false,"expectCodec":"video/AV1","expectWidth":1728,"expectHeight":1080}]'
node tooling/verify-screen-performance.cjs
```

候选包为独立 Native Capture Lab 便携目录，不更新正式安装或发布渠道。
关闭该测试版后，`Start-Stock.cmd` 可只为本次启动禁用原生采集；旧验收包保留。
helper 启动资格/时限不满足时保留原流，已切换后的原生故障安全结束共享，
用户手动重试使用原采集路径。不会自动增加采集或恢复远控权限。

本轮没有推送、发布、部署或重启服务器。完整 1920×1080、其他硬件、HDR、
多显示器、独占全屏与长时间游戏负载仍不能用本机短时对照代替。
