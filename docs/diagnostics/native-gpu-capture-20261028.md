# Windows 原生 GPU 采集候选：实现与验收

本轮从 `f315aa5`、独立分支 `codex/native-gpu-capture` 增量实现。
正式 Cove、Android、服务端、编码选择/码率策略和发布渠道没有更改。
这是默认关闭、仅测试构建或显式环境开关启用的 Windows 采集后端。
结构与复现入口见[架构说明](../architecture/native-gpu-screen-capture.md)。

## 已实现

先按原流程成功共享，再后台创建原生候选；同一 producer 串行
`replaceTrack` 成功、归属仍有效后，才停止原采集轨道。失败保持原画面。
原生路径是 DXGI → GPU 光标合成/area 缩放 → 三槽共享 BGRA 纹理 →
Electron VideoFrame → 原 WebRTC/mediasoup 发布器，没有全尺寸 CPU 图像管道。

主进程拥有 helper、句柄、导入引用和有界 watchdog；renderer 候选拥有
generator/writer；升级协调器拥有替换与回滚；原 hook 继续拥有用户意图、
producer、音频和停止行为。停止/离房/设置更新均能取消旧准备，迟到结果
不能接管新共享。纹理仅在对应 `allReferencesReleased` 后复用。

helper 或 renderer 故障会安全结束本次共享、沿旧流程关闭 producer；
不自动重新采集或恢复远控授权。语音保留，下一次手动共享走 stock。
正式构建仍走 stock；测试版不安装或覆盖正式版。

同帧率对照未证明 30 FPS 普遍省 CPU，因此正常 30 FPS 分享保留 stock。
60/120 FPS、单物理主显示器、SDR 横屏、档位模式才尝试原生升级。
原始分辨率、多显示器、窗口或不支持的格式保持原路径。

## 真实双端结果

Windows 11 23H2、Electron 44/Chromium 152、RTX 4060 Laptop；物理源为
2560×1600 @ 240 Hz 的自有动态测试画面。两端是真实 Chromium，走本机
mediasoup SFU 与实际产品 hooks。每项先预热 5 秒、采样 6 秒；双方协商的
codec/Fmtp、hint、degradation 和实际输出尺寸相同。没有加码率、重复帧
充数、截图存档或把请求帧率作为实际 FPS。

| 120 FPS 请求 | 实际编码尺寸 | stock 解码 FPS | 原生解码 FPS |
| --- | --- | ---: | ---: |
| 540p / VP8 / 游戏模式 | 864×540 | 72.88 | 107.15 |
| 540p / AV1 / 游戏模式 | 864×540 | 73.44 | 102.60 |
| 1080p / VP8 / 游戏模式 | 1728×1080 | 51.93 | 79.78 |
| 540p / VP8 / 普通活动分析 | 864×540 | 77.11 | 110.15 |

另两轮 540p VP8 原生解码为 110.76/110.92 FPS。结果应表述为本机约
103–111 FPS，**没有达到完整 120 FPS**。offscreen 的视频呈现计数不等于
物理显示器实际扫描；这些也不是互联网延迟或所有机器的性能保证。
原生轨道部分样本没有暴露 `encoderImplementation`，因此只确认原编码
选择代码与协商参数未改，不能用缺失的字段宣称具体实现已被实测确认。

最终矩阵原始记录：

- `runtime/fps-validation-native-gpu-20261028/stock-final-matrix-b11mNZ/result.json`
- `runtime/fps-validation-native-gpu-20261028/gpu-final-matrix-pjLDZo/result.json`
- `runtime/fps-validation-native-gpu-20261028/gpu-final-lifecycle-37ZzHD/result.json`

CPU 计数包含整个 Electron 测试应用（动态源、收发两端、browser/GPU
进程）和原生 helper，100% 表示一个 CPU 核；不含 Node SFU 或实际 GPU
执行时间。120 档的总 CPU 随更多画面处理而增加：540p VP8 约 3.01→3.28
核，1080p VP8 约 3.54→4.78 核。不能宣称总占用普遍下降。

策略选择前还强制对照了同一 30 FPS 工作量：540p stock/native 实际
29.21/29.56 FPS、CPU 1.61/1.69 核；1080p 29.32/29.28 FPS、2.22/2.15 核。
单次短样本及几百分点差异不足证明普遍节能，这也是最终低档保留 stock
的依据。记录在 `stock-matched-30-XK5PcV`、`gpu-matched-30-zpEYFf`。

## 剩余瓶颈

最终 1080p 路径约为 helper 更新 109.8 → writer 写入 83.4 → 解码 79.8
FPS；writer 平均等待 6.99 ms，忙时有界丢帧约 26.4 FPS。
540p 对应 helper 114–117、writer 105–112，忙时丢帧约 4–9 FPS。
网络收发与编码/解码计数接近；剩余缺口主要在浏览器轨道交接/背压层，
不能再归因于原生桌面取帧或某一个 codec。

精确源码核实了以下事实，而非仅凭耗时猜测：

- [Electron 44 contextBridge](https://github.com/electron/electron/blob/v44.0.0/shell/renderer/api/electron_api_context_bridge.cc#L384)
  对 VideoFrame 使用同一 blink 对象在另一 realm 包装，不读回像素。
- [Chromium 152 generator sink](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc#L209)
  会尝试将 RGB SharedImage 转为 REC709 limited 的 NV12 mappable 帧，
  转换完成、PushFrame 后才 resolve。write 耗时包含这一阶段，不等于编码耗时。
- [SharedImage 两种重载](https://github.com/chromium/chromium/blob/152.0.7977.54/gpu/ipc/client/client_shared_image_interface.cc#L145)
  说明 Electron 公开 NV12 导入不自动获得 mappable backing；直接换格式
  可能只是把等待移到原软件编码器的同步读回，不能据 writer 变快验收。

因此本轮没有增加帧队列、改变编码器或修改 Electron 内核。独立 NV12
组件实验停在 `gpu_completion_timeout`，未导出句柄、未进行 Electron
导入/颜色/吞吐验证，**没有进入候选版**。工具及明确失败说明位于
`tooling/native-screen-capture/nv12-probe/`；不能把 Blt 提交成功算通过。

## 验证与边界

- 桌面完整 `npm test -w cove-client` 最终 622 项通过，包含新增原生生命周期单测；
  Electron/renderer 类型检查及生产构建通过。
- 原生 CPU/HLSL/调度自测 73 项通过；合成 GPU 16 cases、144 帧、46,404
  像素对参考算法，最大误差 1 LSB（容差 2）。没有将测试小尺寸 readback
  放进产品路径。
- 真实 N-API 测试覆盖显式 close、同值句柄被复用后重复 close、GC、子进程
  退出与 CPU 计数；最终模块仅依赖系统 DLL。
- 八次真实 helper 会话、六次 540p120↔720p60 设置更新保持同一
  producer/consumer；静止后新 consumer 实际解码画面；自有 helper 被终止后
  语音继续、没有自动重采、手动 stock 重发解码成功。常规清理前即达到
  helper/import/引用/连接/计时器等全部归零，安全 reset 未掩盖遗漏。
- Windows 在静止画面下仍有桌面 present，本轮未单独触发“完全没有 OS
  更新”的 250ms heartbeat 分支；测试记录此项，严格模式可要求该分支。
  GPU/驱动重置、物理显示器插拔、HDR、多显卡、多显示器、长时间通话及
  已授权真实远控中的故障撤权不作为本轮实测通过项目。

独立只读审阅发现并修复了部分接管后 stock 泄漏，以及 renderer 故障
未禁用下一次原生尝试的问题。定向复核未发现剩余阻断，但不代表零回归。
这是一轮本地候选，尚不作为向所有用户自动发布的验收结论。
