# Cove 手机端修复与验收记录（2026-10-30）

五项修改已实现。Android 自动化回归及模拟器验收通过；真实手机与跨设备音频验收尚未完成，原因见下文。没有发布、推送或替换正式版本。

## 源码与隔离

- 正确基线：`C:\Users\cyj06\Documents\Codex\2026-10-25\task\Cove-Capture-Restart` 的 `c4540aa`，手机端 `0.8.3` / versionCode `16`。
- 本次工作副本：`C:\Users\cyj06\Documents\Codex\2026-10-30\task\Cove-mobile-20261030`，本地导入提交 `a73d040`。
- 桌面主目录的旧版 `0.8.1` 并非目标；其已有图标删除未改动。桌面采集实验、服务端、版本号、依赖锁文件和更新清单均未修改。

## 实现结果

| 请求 | 实现 |
| --- | --- |
| 手机批注与发起共享占用界面 | 移除入口、绘图会话、手机共享发布器接线和 Android 屏幕投影服务/权限。接收共享保留；远控按授权工作，工具按需展开。全屏视频使用完整区域。 |
| 音量条偏离即停止 | 统一手势逻辑，扩大触控区，保留按下时的屏幕横坐标原点，锁住 Android 原生滚动拦截；离开轨道后仍连续更新。用户音量保留 0–200%，其他音量 0–100%。 |
| 共享音量丢失 | 观看区域、音频设置、全屏按需浮层共用同一个共享音量/静音状态；无需加入语音即可调节接收音量。 |
| 语音包启动慢 | Android 会话内下载并预备原生音频播放器，优先收藏/前排最多 6 项；按下时继续预热。缓存最多 8 项、2 并发、单文件沿用 8 MB 上限。退出语音、换房、凭据变化和销毁时取消并释放；仍等待服务器权威广播。未准备好时保留路由校验，并缩短流式音频启动缓冲。 |
| 文字偏上、媒体状态入口 | 按钮禁止图文折行，明确行高与 Android 字体内边距/垂直对齐；移除媒体状态面板入口及诊断采集 API 接线。 |

原生预备播放器沿用现有受保护下载源与请求头校验，不修改通话路由或音频焦点。语音音频会话继续管理输出设备。后台暂停、回前台恢复；缓存不跨应用重启。旧功能的未接线源文件保留，桌面相关实现未删改。

## 自动化与构建

- JavaScript：47 个测试套件、572 项测试全部通过。涵盖全屏布局、三个共享音量入口、手势越界/重渲染、原生事件隔离、回退播放、凭据切换停止旧播放和预热上限。
- Android：12 个测试套件、74 项原生单元测试全部通过。新播放器还通过下面的实际 Android 模拟器运行验证。
- `typecheck` 通过；`lint` 退出码 0，0 错误、59 条警告。
- 同时修正一个既有授权测试夹具：生成凭证时只取一次 `Date.now()`，避免跨毫秒使有效期偶发超出最大值；未更改授权产品逻辑。
- 隔离构建使用 `-PcoveRefactor`、正常 `index.js` 入口和内嵌 JS，包名 `com.cove.mobile.refactor`，与正式包分离。验收包保持 `0.8.3 (16)`，含 `arm64-v8a` 与 `x86_64`。
- 构建辅助配置、缓存、测试服务器和 QA 入口均在忽略的 `runtime/` 或临时目录；没有进入产品入口。

[独立验收 APK](../../runtime/deliverables/Cove-Mobile-0.8.3-mobile-fixes-acceptance.apk) 为正常产品入口，已在模拟器安装、冷启动至真实登录页；不包含 QA 夹具。APK 长度 112247188 字节，SHA-256 为 `51a6667347efecdd147658bab6d848e81b201e520d6554f02668904b4033c2f7`。检查确认包含两种 ABI、内嵌 JS，屏幕投影权限和服务均不存在。见 [APK 校验记录](../../runtime/deliverables/apk-verification.json)、[正常入口截图](../../runtime/mobile-qa/normal-app-start.png)。

日志：[Jest](../../runtime/mobile-jest.log)、[结果 JSON](../../runtime/mobile-jest-results.json)、[类型检查](../../runtime/mobile-typecheck.log)、[lint](../../runtime/mobile-lint.log)、[Android 单元测试](../../runtime/android-unit-tests.log)、[正常 APK 构建](../../runtime/mobile-build.log)。

## Android 模拟器操作验收

环境为 Pixel 7 Pro AVD / Android 14 API 34 / x86_64 / 1440×3120。运行真实 React Native 界面和真实 Android 音频播放器；房间控制器、信令及黑色视频源是合成夹具，音频为本机受保护 HTTP 端点提供的 2 秒 WAV。没有连接真实房间、读取真实账户或采集麦克风。

- 浅色、深色、横竖屏均检查；聊天/语音包/音频设置文字中心与按钮中心相差 0.5 像素。
- 实际 Android 手势从音量条 20% 位置拖至 85%，同时移至行底部以下 160 像素，持续产生 17 次更新，最终 84.76%；父滚动区没有抢走手势。
- 用户音量越界拖动可到 168%，200% 范围保留。
- 普通观看、全屏浮层、音频设置共享同一个音量值；全屏默认没有底部批注/共享工具区域。复验修正了全屏系统栏留空。
- `dumpsys media.player` 记录后台 `renderer(paused(1))`，回前台后 `paused(0)`；离开语音包测试会话后应用私有预备缓存从 1 个音频文件变为 0 个。

截图：[浅色按钮](../../runtime/mobile-qa/portrait-light.png)、[深色](../../runtime/mobile-qa/portrait-dark.png)、[用户滑条越界](../../runtime/mobile-qa/profile-drag-outside.png)、[最终全屏](../../runtime/mobile-qa/fullscreen-final.png)、[全屏音量](../../runtime/mobile-qa/fullscreen-volume.png)、[横屏](../../runtime/mobile-qa/fullscreen-landscape.png)、[音频设置](../../runtime/mobile-qa/audio-settings.png)、[语音包](../../runtime/mobile-qa/soundboard.png)。早期截图的系统栏空隙已由最终全屏截图复验消除。

## 语音包启动测量

条件：同一 Android 模拟器、相同合成 WAV、相同选定扬声器及 InCallManager 语音音频会话。基线使用导入提交的原版播放器；修复版缓存已准备完成。两组各 10 次，每次间隔 3 秒；未将首个冷启动预检样本计入组内统计。

测量边界为 JS 按钮处理开始到播放器报告 `isPlaying`；原版使用 Video 播放状态回调，新版使用原生 `MediaPlayer.isPlaying` 事件。包含桥接/调度时间，排除真实服务器信令往返、实际声卡与扬声器出声时间。该结果不能作为真机声学延迟承诺。

| 播放器 | 次数 | 中位数 | 范围 |
| --- | ---: | ---: | ---: |
| 原版 | 10 | 353.5 ms | 218–401 ms |
| 修复版，缓存已就绪 | 10 | 16.5 ms | 12–31 ms |

启动中位数降低 95.33%。原版首个冷启动预检样本为 1472 ms，仅单次记录，不做冷启动统计。全部修复版样本的原生 `isPlaying` 为 true。

[完整原始样本、统计方法与环境](../../runtime/mobile-qa/latency-results.json)。后台/恢复记录：[后台](../../runtime/mobile-qa/player-background.txt)、[恢复](../../runtime/mobile-qa/player-resumed.txt)。

## 尚未完成的真实设备验收

目标动作：在真实 Android 手机上安装隔离验收 APK，触控拖动、横竖屏观看真实桌面共享、确认共享声音增益/静音以及扬声器/耳机路由，测量实际点击到可听声音的时间。

阻碍：本机 `adb devices -l` 仅有本次创建的 `emulator-5580`；开始工作前列表为空，`adb mdns services` 也没有发现可连接的无线设备。没有已连接并授权的 USB/Wi-Fi 实体手机，也没有可验证的真实跨设备音频链路。此动作未执行，状态为受设备条件阻碍；不是审批拒绝，也没有未知安装结果。

已经完成代码、自动化、正常验收 APK 构建、模拟器交互和原生播放器测量。实体手机、真实房间音视频链路、蓝牙/有线耳机及声学端到端延迟仍未验收；iOS 未在此 Windows 环境构建。
