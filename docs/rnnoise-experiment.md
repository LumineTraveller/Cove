# RNNoise 可回退试听实验

从桌面端 v1.3.0 起，安装包内提供 RNNoise 实验模式。它不改变默认降噪方式：系统降噪仍是默认选项，RNNoise 仅在用户主动选择时启用。

## 试听与回退

1. 打开设置 → 音频设备 → 麦克风降噪，选择 **RNNoise（实验）**。
2. 加入语音，比较正常说话、轻声、句尾，以及风扇和键盘噪声下的表现。建议使用耳机、保持同一设备和输入音量，让对端比较两种模式。
3. 随时选择 **系统降噪（默认）** 或点击 **恢复系统降噪**。切换会重新采集麦克风，保留静音状态。

实验选择只保存在当前页面内存中；重开应用恢复系统降噪。初始化失败会重新采集启用系统降噪的麦克风；如果新旧两种采集都失败，切换报错并保留原发送音轨。运行中的处理器异常会尝试恢复系统降噪并显示提示，设备切换等冲突时可手动重试。不会把禁用系统降噪的原始音轨偷偷作为 RNNoise 结果发送。

## 接入边界

- 固定依赖 `@jitsi/rnnoise-wasm@0.2.1`，使用同步 RNNoise 0.2 WASM 模型，按需加载本地资源，不调用云端降噪服务。
- 实验模式关闭浏览器降噪，保留回声消除、自动增益与既有音量/压缩/输出余量处理；系统模式保留原处理链。
- 两种模式均在采集阶段优先请求并核验 `echoCancellation: { exact: 'all' }`，先消除本机播放回声，再做降噪。布尔值 `true` 让 Chromium 自行选择，并不保证使用系统播放参考；RNNoise 本身不负责区分本地人声和扬声器中的远端人声。Chromium 的选择逻辑见 [音频处理实现](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/platform/mediastream/media_stream_audio_processor_options.cc)。
- 老设备/浏览器不支持 `all` 时，重新请求显式开启常规 AEC 的音轨并显示覆盖范围不足的提示；权限拒绝、设备占用或设备 ID 错误不会伪装成 AEC 兼容性问题。系统播放参考只由 Chromium 在本机用于抵消回声，不会作为另一条麦克风或共享音轨发送。
- AudioWorklet 使用 48 kHz 单声道，480 个采样一帧，按 RNNoise 要求转换浮点 PCM 幅度。不叠加自制频谱降噪或噪声门。
- 音频块桥接固定增加 480 个采样（10 ms）延迟；模型、设备、压缩器与网络仍有各自延迟，不能把 10 ms 当作总延迟。
- 系统回声参考还可能增加采集延迟，沿用 Chromium 的默认延迟对齐，不自行调短。扬声器失真、过大音量或复杂声学环境仍可能有残留，`all` 是处理范围，不是“任何情况下绝对无回声”的保证。
- 模型原始构建块约 1.94 MB，仅选择实验模式后加载。第三方许可随前端产物保存在 `third-party/RNNoise.txt`。

## 验证

在 `client` 目录运行：

```powershell
npm run test:audio-devices
npm run test:microphone
npm run test:microphone-echo
npm run test:rnnoise
npm run build
```

`test:rnnoise` 覆盖输入约束、初始化失败回退、资源清理、PCM 幅度、不同音频块长的连续性，并在真实 Electron AudioWorklet 中加载 WASM，反复启用和恢复原处理链。可选传入本地语音 WAV 进行输出存活检查：

```powershell
npx electron tests/rnnoise.electron.cjs C:\path\to\speech.wav
```

`tests/ui/rnnoise-qa.html` 是开发服务器上的独立组件夹具，仅模拟切换与错误提示，不采集真实麦克风。

`test:microphone-echo` 默认在 Electron 内使用虚拟麦克风验证实际协商出的 `all` 模式。需要核验真实设备时，可显式运行 `npm run test:microphone-echo -- --real-capture`；它只短暂打开麦克风、读取处理设置后释放，不录音、不播放也不上传音频。该检查不能代替扬声器声学测试。

回声修复后的调试客户端需退出并重新加入语音，让旧采集音轨重建。试听时依次检查：对方单独说话、本机播放其他应用声音、双方同时说话；最后一种用于确认没有以静音本地麦克风来掩盖回声。

合成噪声与语音测试只能排除部分工程故障，不能证明真实麦克风音质更好。RNNoise 仍不默认启用；如需评估，请在真实设备和对端试听中比较后再决定是否长期使用。
