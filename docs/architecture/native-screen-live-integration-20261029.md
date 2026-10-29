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
