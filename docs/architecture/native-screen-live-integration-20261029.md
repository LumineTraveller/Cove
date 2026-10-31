# 2026-10-29 实际客户端采集未升级调查

## 现场证据

用户在 `npm run dev -- --client --electron` 启动的普通窗口共享时反馈没有改善。
本次保留当前语音、共享和配置，只读取已有统计与聚合诊断，没有触发热更新。

- 当前实际视频为 864×540、轨道配置 120 fps；界面的 WebRTC media-source 差分
  在多次观察中约 33–85 fps。这是分散观察，不是固定时长的受控基准。
- DOM 视频轨道 `getNativeScreenCaptureDiagnostics(track)` 为 `null`，轨道仍为普通
  `displaySurface: monitor`，当前共享没有使用已提交的原生轨道。
- 全局最近一次原生尝试为 `start_rejected`，`helperResponseOk: false`，没有首帧、
  首次写入或 committed 时间。旧代码没有保留返回的具体 reason，历史无法还原。
  最近尝试不是 producer/session 的唯一关联证据，不能把旧记录自动归为当前共享。
- DOM 视频后续读取为 readyState 4、error null，并可看到画面。最初 AX 的
  “无法播放媒体”不是持续播放错误的充分证据。
- 当时只有本地共享者；原有 screen demand 策略会在无人观看时暂停 producer，
  编码/发送/码率为 0 不能直接判定网络或编码故障。没有擅自恢复该 producer。

因此此前受控 1728×1080 接近 120 fps 的原生路径测试，不能代表此次普通窗口已经
生效，也不能据此否认用户的低帧反馈。启动配置 enabled 与切换 committed 必须分开。

## 已排查与尚未确定

- 开发目录 helper/bridge 的哈希与 a3376f8 验收载荷一致，没有发现旧二进制。
- 普通 main 与性能夹具都验证 IPC sender 和 mainFrame 所有权；没有放宽校验。
- 普通 main 直接保存 Electron source.display_id，性能夹具在单屏时有显示器匹配
  回退。另开只读、无缩略图的 Electron 44 进程核查后，当前一块屏幕的 source id
  存在且匹配 primary；不能认定这个集成差异就是本次失败原因。
- 该元数据核查从 DIP 换算的物理尺寸为 2561×1601，真实面板为 2560×1600；
  controller 已允许不超过 2 像素差，因此不能把这 1 像素舍入直接认定为拒绝原因。
- `unavailable`、先前故障后的会话内禁用、helper/readiness 或资源失败仍未确定。
  18 毫秒的响应时间不足以区分这些分支。
- 原性能夹具发送端没有普通 UI 的本地预览，且 game=true 省略活动分析 video。
  本地预览/分析与 GPU 引用释放的影响尚需对照，不能先宣称为性能根因。

## 本补丁：仅诊断，不是性能修复

1. renderer 最近尝试保存白名单 `startFailureReason`、`backendEndReason`，未知文本
   统一归为 `unknown_failure`；不保存 source/request/session id 或任意错误文本。
2. 普通 main 每个可信 start 响应只记录一次 `[native-screen-start]`，包括响应状态、
   固定拒绝码、controller 当前故障码、禁用状态和累积计数；不增加每帧日志。
   controllerFailureReason 是当前 controller 故障码，可能由清理失败覆盖，不称首因。
3. 现有诊断历史和导出增加 `lastNativeAttempt`，明确表示最近尝试；不会把它
   伪装成当前 producer 的独立关联或成功证据。

没有改变采集方式、编码、码率、像素尺寸、启动门槛、重试、超时、清理、安全回退
或远控授权。日志/快照失败不能改变 IPC 的结果。未知原因未做猜测性修复。

## 复现与后续验收

补丁位于独立 `Cove-native-live-integration` 工作区，旧运行目录没有修改。
重新启动测试客户端才会加载新 main；重启会中断该测试客户端的当前语音/共享，
因此在用户确认前保持当前客户端运行。无须重启 Cove 服务器。

复现后依次检查：

1. `[native-screen-start]` 的 result reason 与 controllerFailureReason；
2. renderer 最近尝试的阶段、固定失败码与 committed 时间；
3. 当前 track 的 captureProvider 必须非 null 且 backend 为 native-gpu；
4. 使用同一时间区间的 framesReceived/Written 差分、WebRTC source/encode/send
   计数及观看端 receive/decode，明确源实际更新频率与所有阶段的差异；
5. 普通本地预览、活动分析、前后台与无人观看/有人观看分别对照。

在普通客户端的真实路径提交和完整流验证之前，不把这项补丁称为 120 fps 修复，
不替换已冻结的测试包，不发布。

## 重启后的真实窗口与呈现对照

诊断版本 `4b569dc` 使用原先隔离的开发配置重启后，已在普通房间 UI 确认
GPU BGRA / Generator 路径实际 committed，视频为 live/readyState 4，未见播放错误。
启动成功不能追溯证明旧版本 `start_rejected` 的具体原因；历史原因仍未知。

- 864×540 的两个 5 秒区间：renderer 接收约 113/118 fps、写入约 107/111 fps。
- 切换为 1080 高度后的两个 5 秒区间：实际 1728×1080，接收约 113 fps、
  写入约 103 fps。普通 UI 的缺口仍存在，不能用隔离结果代替。
- 有观看者的现场诊断中，编码/发送曾在约 76–88 fps；这是非受控观察，
  不能用于计算优化幅度或认定硬件上限。

随后同一原生 track 上执行有界预览绑定对照：8 秒正常预览、10 秒仅解除
LocalScreenVideo 的 `srcObject`、8 秒恢复。没有停止采集/track、修改 producer、
创建第二消费者或改变编码设置；finally 确认同一预览恢复 `playing`。

| 阶段 | 接收 fps | 写入 fps | busy 丢帧 fps |
| --- | ---: | ---: | ---: |
| 预览基线 8.000 秒 | 108.25 | 98.75 | 9.50 |
| 解除预览 10.003 秒 | 111.87 | 102.27 | 9.70 |
| 恢复预览 8.002 秒 | 115.22 | 106.73 | 8.75 |

完整区间均位于同一 60 秒合成动态窗口显示期内；源 rAF 约 236 fps，仅表示绘制
回调频率，不是物理扫描输出。存在随时间变化的趋势，解除预览没有消除缺口或出现
明确阶跃，因此不能把本地预览认定为主因。原始只读聚合位于
`runtime/live-preview-detach-result.json`、`runtime/controlled-preview-source-giJGWJ/result.json`。

隐藏窗口配对 SFU 对照使用产品 `LocalScreenVideo`、同一 track、相同
1728×1080 / 120 / AV1、普通窗口且 publisher `backgroundThrottling:true`：

| 12 秒对照目录后缀 | 本地预览 | helper 新帧 fps | 写入 fps | 编码 fps | 解码 fps |
| --- | --- | ---: | ---: | ---: | ---: |
| `QJXYvx` | 关 | 119.99 | 120.02 | 119.33 | 119.43 |
| `ogrbbe` | 开 | 120.03 | 120.11 | 119.03 | 119.07 |

两组均通过颜色、逐帧序号推进/非未来、实际尺寸/codec 和资源回收守卫。但 hidden
视频不等价于可见产品窗口合成，也没有完整房间 UI。下一层验证明确覆盖可见呈现、
发送需求状态与 GPU 引用驻留；不得据此宣称普通 UI 已达到 120 fps。

另修正旧报告配置边界：`91uHea` 虽未启用全局
`disable-renderer-backgrounding`，其非最小化 publisher 仍显式使用
`backgroundThrottling:false`；不能称为完全等同产品默认窗口策略。

### 可见呈现层的进一步配对

`COVE_FPS_VISIBLE_PRESENTATION=1` 使用居中占屏幕约 75% 的真实可见发布窗口，
产品 CSS、`LocalScreenVideo` 与真实 `DiagnosticsOverlayV2`；动态源全屏在后，
持续检查已拥有的发布窗口前台、实际几何、标记未遮挡、颜色、序号与完整链路尺寸。
这是呈现层对照，仍不是完整房间 UI。默认测试布局不变。

| 12 秒对照目录后缀 | 可见本地预览 | helper 新帧 fps | 写入 fps | 编码 fps | 解码 fps |
| --- | --- | ---: | ---: | ---: | ---: |
| `uqjmV9` | 关 | 119.86 | 118.67 | 117.26 | 117.35 |
| `alDBlG` | 开 | 119.78 | 118.86 | 117.61 | 117.83 |

实际采样区间分别为 12.429 / 12.384 秒，均通过所有守卫及清理。开启预览时其播放
计数约 118.52 fps、丢弃计数为 0；不代表物理扫描输出。两组源绘制回调约 240 fps。
结果不支持“产品预览组件本身将帧率限制在 80”这一解释。

可见测试曾在媒体启动前拒绝两次不可见窗口（`n0zsOc`、`W7HzSi`），没有当作性能
数据。无媒体独立 A/B 确认 launcher 的 `windowsHide:true` 能造成
`focused:true / visible:false`；只对显式可见实验改为 `windowsHide:false` 后资格
守卫通过。默认 hidden 测试、Vite 与后台进程保持原策略；没有放宽可见性守卫。

## 完整应用的显式底层计时

```powershell
$env:COVE_NATIVE_GPU_CAPTURE='1'
$env:COVE_NATIVE_GPU_CAPTURE_TIMING='1'
npm run dev -- --client --electron
```

该开关只增加观察：每 5 秒一条 `[native-screen-timing]`，从首个受信 start 开始，
最多 119 条 sample 加 1 条 limited，10 分钟后停止 main 快照采样和输出。原生
helper 已启用的计时及有界 stderr 解析持续到该采集结束；不停止或改变共享。
退出应用清理观察器。默认关闭，无新增 IPC 或权限，不查询完整 GPU 驱动信息。

只记录固定数值聚合与枚举；单块上限 64 KiB、单行 UTF-8 上限 16 KiB，仅保留
一条最新 helper 样本。不得记录 request/session ID、句柄、凭据、SDP 或画面。
观察、日志或异步回调失败不改变媒体生命周期、GPU lease 或 credit 条件。

- 同一 `helperCaptureNumber` 且 `helperMatchesLatestStart:true` 才比较 helper
  `counts.newFrames / elapsedUs` 的差分；helper 与 main 的采样边界不同。
- `noSlot`、`leaseResidence/importedResidence` 与 broker `reference` 定位下游
  引用归还背压；`reference.totalMs` 是总驻留墙钟时间，并非 GPU 执行时间。
- `noPresent`、`missedTicks`、`stages.gpuWait/acquire/slotCreditWait` 区分源更新、
  helper 串行工作和等待帧槽。不能把 `writer.write()`墙钟耗时直接当纯 GPU 时间。
- 面板四值现明确标为“报告/源/编码/发送”：第一项来自轨道 getSettings，第二项
  是 WebRTC 送入编码器前的 source 统计，均不等于原生 DXGI 裸取帧。

验证入口：`npm run test:native-screen-capture -w cove-client`；工具纯测试可用
`node --test tests/screen-performance-local-preview.test.cjs tests/screen-performance-visible-presentation.test.cjs`。
关闭计时环境变量并重启该测试客户端即可回到原先默认观察策略；既有冻结包保持不变。
