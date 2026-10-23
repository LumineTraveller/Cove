# 加入／退出语音提示音

桌面 2.1.1 与 Android 0.8.3 使用相同的两份 PCM WAV 资源，不再分别使用桌面双音合成与 Android 系统提示音。

## 已选声音与增益基线

采用用户确认的 **F 柔和三音微调版（F-refined-01）**：加入时三音上行，退出时三音下行，保留该试听稿已放慢的节奏与音高。随后按用户要求，将该微调稿的 PCM 样本幅值再乘 **2**，不重新归一化。

这里的“放大 100%”指资源幅值增加 100%，不修改系统音量、通话音量、麦克风增益或用户的主音量设置，也不表示主观响度一定翻倍。

每份资源为 **48 kHz、单声道、PCM16 WAV**，文件时长 **400 ms**，声音主体约 **305 ms**，余下为静音尾部。两端资源应逐字节一致：

| 用途 | 桌面资源 | Android 资源 |
| --- | --- | --- |
| 加入 | `apps/desktop/src/features/media/audio/assets/voice-join.wav` | `apps/mobile/android/app/src/main/res/raw/voice_join.wav` |
| 退出 | `apps/desktop/src/features/media/audio/assets/voice-leave.wav` | `apps/mobile/android/app/src/main/res/raw/voice_leave.wav` |

`F-refined-01` 是确认试听稿的基线名称。正式构建不读取本地 `runtime/` 试听目录，只使用上表中受版本控制的 WAV。

## 播放与资源所有权

桌面的 `presenceTone.ts` 负责加载、解码及播放资源，仍由 `useAudioMeters` 提供已有 AudioContext 和输出节点：

- 按 AudioContext 缓存解码结果，并合并同一资源的并发解码。
- 通过原主音量节点和已选输出设备播放，静音保持有效。
- 播放结束只断开本次 AudioBufferSourceNode；不关闭共用的上下文。
- 解码完成后重新检查上下文是否已关闭，避免迟到的解码启动声音。
- 资源或解码失败仅使提示音缺失，不影响语音流程；失败的缓存可重试。

Vite 生产构建只对这两份 WAV 使用定向内联，生成 `data:audio/` 资源地址，以支持打包后的 `file://` 页面，其他资源保留原有策略。开发模式仍可通过 Vite 的资源地址加载。

Android 的 `PresenceTonePlayer.kt` 使用 SoundPool 加载同一资源，沿用 `STREAM_MUSIC` 音量与既有音频路由，不修改系统／通话音量。播放器最多保留两路短音频；加载期间只保留最新一次请求，不排队播放过期事件。模块失效时关闭播放器，迟到的加载回调不得重新播放。

本次只改本地提示音资源与播放适配，不改变触发加入／退出事件的条件、连接恢复、媒体会话、远控授权或用户数据。

## 针对性检查入口

在仓库根目录运行：

```sh
npm run test:presence-tones -w cove-client
```

入口为 `apps/desktop/tests/presenceTone.electron.cjs`。它使用现有 Electron 与 Vite，将生产模块构建成真实 `file://` 测试页面，通过 OfflineAudioContext 解码和渲染，不打开麦克风／屏幕，不输出到扬声器，不连接业务服务器；HTTP／WebSocket 请求被阻止。

检查覆盖：

- 两端 WAV 字节一致、格式与采样率正确。
- 生产资源被内联，不依赖本地文件或 HTTP 资源请求。
- 渲染保留批准的 PCM，考虑不同 PCM16 解码器允许的量化差异；不为满足阈值更改播放增益。
- 输出为有限样本、无削波，起点及尾部保持静音。
- 主音量比例和静音仍控制提示音。
- 单次／并发播放只创建所需源节点，结束后断开；并发请求复用解码。
- 上下文关闭后的迟到解码不启动声音，资源失败被限制在提示音内且后续可重试。

默认产物位于 `runtime/presence-resources/`，可用 `COVE_TONE_ARTIFACTS` 指定另一隔离目录。其中 `production-build/` 为测试构建；`result.json` 记录运行结果。应结合本轮退出码和结果判断，不能把本说明当成已通过的证明。

这项检查验证桌面生产资源与 Web Audio 播放边界，不证明 Android SoundPool 在真机上的播放、实际输出设备路由或所有耳机的听感。Android 构建／资源检查和两端实际听感应单独记录，不因资源相同而宣称听感完全一致。

## 回退

提示音资源与平台播放器可独立回退；无需更新服务端协议、迁移数据或调整通话设置。回退资源时应同时维护桌面与 Android 对应文件，并重新核对两端一致性。
