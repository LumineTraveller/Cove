# 2026-10-23 连接恢复验收

本轮从 `b8c3b99ff4363f6a3b9a01d56069f7f0bb7c9546` 开始，
保留 `d8eb548` 和 `b8c3b99` 回滚点。代码位于独立目录
`Cove-connection-stability`、分支 `codex/connection-lifecycle-stability`。
常用桌面项目仍在 `ad7b0c3`，原有图标删除保持原状。

## 本轮交付范围

- 恢复诊断复用现有手动导出：匿名回合、固定四通道、阶段、最多三次尝试、
  相对耗时、取消和兜底；内存最多 256 条，相邻重复合并，导出再次校验。
  不记录 token、ICE 密码、SDP、用户内容或房间/用户/transport 标识。
- 退出时补齐旧服务端路径的诊断取消，空闲/重复清理不产生新记录。
  此修复不改变媒体资源、重试时序或 UI 意图。
- 修复远控请求 TTL timer 在接受、拒绝、撤销、权限变化边界和服务停止后
  未撤销的问题。先有失败回归，再补所有权清理；没有用 unref 隐藏残留。
- 增加真实 Chromium/mediasoup UDP 应用级断流、仅信令故障、会话丢失、
  重试耗尽和反复操作工具；每次运行独立 Vite 缓存，避免共享包旧预编译代码。
- 准备同一产品源码 `422f6caff7ad3d41d2fe91f5b3c421c58ec7438e`
  的 Windows 桌面、服务端和 Android 验收包。后续测试工具和文档提交不改
  `apps/`、`packages/`；用 Git 树比较证明产品源码一致。

没有调整码率、编码和画质策略，没有推送、发布、部署、安装或连接正式服务。
测试只使用隔离进程和本机应用级代理，没有修改防火墙、VPN、系统网络或正式签名。

## 已完成的验证

| 检查 | 实际结果 |
| --- | --- |
| 四个共享包 noEmit 类型检查 | 全部通过；最新 client-core 已先单独编译 |
| 桌面 renderer / Electron 类型检查与测试 | 438 TS + 85 CJS 通过 |
| 手机 TypeScript / Jest | 46 套、562 项通过；原生设备边界模拟 |
| 服务端类型/构建与测试 | 195 TS + 5 原生契约通过 |
| 共享客户端行为 | 16 项通过，包括诊断容量、脱敏和退出取消 |
| 根契约及 Android 构建工具 | 58 项通过（41 根测试 + 17 Android 工具测试） |
| 真实 SQLite / mediasoup 服务端冒烟 | 注册、房间、启动/停止/重启通过 |
| Windows 包独立目录验证 | 4571 文件 hash 一致，运行时/HTTP/隐藏登录界面通过 |
| Android 完整构建 | assembleDebug + testDebugUnitTest 成功，189 个任务，Gradle 8 分 25 秒 |
| Android JVM 单测 | 11 套、64 项通过，失败/错误/跳过均 0；不等于 Android 真机执行 |

日志在 `runtime/acceptance-20261023/`：
`regression-{desktop,mobile,server}-422f-final.log`、
`shared-types-422f-final.log`、`root-contracts-cache-final.log`。

Windows 包在无祖先 node_modules 的独立 Windows Temp UUID 中提取验证；
包内 Node 拒绝包外解析，SQLite、mediasoup、FFmpeg、真实 HTTP、
Electron runtime 和隐藏 UI 断言全部通过；临时目录已删除。
隐藏 UI 有两条 GPU stderr 日志，原文保留，退出码和登录断言均成功；
这不构成真实设备 GPU 和屏幕采集的验收。

## 真实媒体与持续测试

当前已确认新的隔离缓存 UDP 基线通过：
`c2e0754e-37c0-4648-88e9-1e2971f2d007`。
它验证实际 UDP 中断、原 transport 恢复、视频解码帧增长、
接收音频非隐藏样本增长及分析器非零 PCM。没有验证扬声器实际出声。
真实媒体夹具使用合成音轨和 VP8 画面；H.264/HEVC 硬编、原生采集与
实际声卡路径不属于本轮浏览器验证的结论。

最终强化持续轮 `2eed11b8-7483-40b2-a0de-b81de80fcbc3` 已通过：
实际 606.309 秒、61 循环，122 次加入、124 次离开（含初始清理），
61 次开始共享、62 次停止、122 次观看、61 次取消观看，30 次信令恢复，
15 次周期 UDP 媒体恢复，另有初始 ICE 恢复。15 次周期故障均有独立的
视频帧、音频收包和非隐藏样本增长证据，最小视频增长 4 帧。
这轮使用工具提交 `9e5e02b`，产品树与上述 422f6ca 完全相同。

最终扩展轮 `ccbde39c-8436-4625-80b8-382f6770dac4` 也通过，实际 73.100 秒：
真实 UDP 音视频恢复，静音/观看意图和同一 transport/producer/consumer 保留；
仅信令中断不重启 ICE；远控撤权；取消观看和恢复中离开优先；真实三次请求
耗尽后安全退出且恢复网络不自动重入；服务实例停止/启动后新会话不自动
加入、共享、观看或恢复远控，显式加入后合成音轨 PCM 恢复。

两轮都确认 `backendStopped=true`，没有将 transport connected 或 restartIce
promise 成功单独视为媒体已恢复。证据为 `ice-restart-udp-{soak,extended}-result.json`
及对应浏览器日志；实际音频分析使用静音输出 sink，没有测试扬声器。

旧口径的 `8734` 轮已独立通过 600.475 秒、60 循环，归档
`soak-8734-result.json`；不与最终轮拼接计时。
327 秒中断轮和两次旧 Vite 缓存失败轮均保留，未算通过。

持续场景测量 hook/浏览器可观测的 transport、producer、consumer、
PeerConnection、track、分析 tap、interval、timeout 和监听器基线。
原生内部 timer、原生堆内存、实际端到端延迟和长通话尚未测量；
十分钟反复操作不等于长时间通话，也不等于物理 Wi-Fi/蜂窝换网。

复现入口（已有依赖、共享包和应用构建就绪后）：

```powershell
node tooling/verify-ice-restart.cjs --udp --acceptance --soak-seconds=600
node tooling/verify-ice-restart.cjs --udp --acceptance --extended --renderer-port=55198 --media-port=41025
node tooling/ci-regression.cjs desktop
node tooling/ci-regression.cjs mobile
node tooling/ci-regression.cjs server
```

## 验收包与运行

Windows 文件：

`runtime/acceptance-20261023/artifacts/Cove-Acceptance-20261023-422f6caff7ad-win-x64.zip`

大小 `232744691` 字节，SHA-256：

`2711c3b83ecdac962ae71cbdcfc8d93ea8f257dcb01264a5d3e7407845509477`

桌面/服务端版本均 2.1.0。桌面使用 Electron 44.0.0 / Node 24.18.1 /
ABI 149；服务端携带已验证签名的 Node 24.11.1 / ABI 137、SQLite、
mediasoup worker 和 FFmpeg 6.1.1，不需要开发环境或全局安装。
它是未正式签名的便携测试包，不是正式升级安装器。

1. 将整个 ZIP 解压到一个新的可写目录。
2. 先运行 `Server/Start-Server.cmd`，再运行 `Desktop/Start-Desktop.cmd`。
   桌面默认地址 `http://127.0.0.1:33991`，注册测试账号。
3. 数据、日志和缓存均保留在各包的 `acceptance-data`；自动更新和安装修复
   已关闭。不要复制正式配置、数据库或凭据。
4. 手机 LAN 验收时，先停测试服务端，将 `Server/acceptance.config.json`
   的 `listenHost` 设为 `0.0.0.0`，`announceAddress` 设为本机私有 IPv4，
   再启动；手机手动输入 `http://该IP:33991`。默认不会自动开放 LAN。
5. 停止时关闭桌面，服务端控制台按 Ctrl+C。

Android 完整 APK 已生成：

`runtime/acceptance-20261023/artifacts/Cove-Mobile-0.8.2-acceptance-20261023.apk`

大小 `92784354` 字节，SHA-256：

`7a7a9391396a110b954f33b01f044ce1d52e5fd0c45bef8a5c368d612ecdc8f5`

实际完整 Gradle 构建 8 分 25 秒成功，189 个任务全部执行；包含迁移验证和
成品核验的外层命令实际 515.910 秒，退出码 0。源 pin 为 422f6ca，快照
`sourceDirty=false`，工具为 `6bd9a7b`。APK 实查最低 API 24、目标 API 36，
包含 arm64-v8a/armeabi-v7a、离线 JS 和 acceptance BuildConfig。
现有测试证书 SHA-256 为
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。

原长路径构建
在 `:app:buildCMakeDebug[arm64-v8a]` 明确失败：SDK 自带 Ninja 1.10.2 无法
Stat 超过 260 字符的 ReactAndroid CMake 输入。系统长路径开关为 0，未修改。
实际小探针还证明长 header 的首次干净构建通过、再次读取 Ninja deps 会失败。
工具将副本和 Gradle cache 迁入带所有权标记的短用户 Temp 目录，并在每次
构建前先校验全部目标，再仅清理此副本的 `.cxx`；不会修改 SDK、产品代码、
系统设置或 CMake 生成图。新实际生成图的 190 个显式绝对输入/包含根最长
224 字符，没有超过 260；最终完整构建成功，未将探针成功替代成品核验。
它使用独立应用 ID `com.cove.mobile.refactor`、名称“Cove 验收测试”，
版本 0.8.2/code 15，保留仓库现有 debug 签名；不会生成或替换密钥，
不能作为正式版签名升级。离线 JS bundle 已生成，不需要 Metro。
当前 `adb devices` 无设备，未做安装或真机启动。

Android 本机续建入口（现有 JDK/SDK、官方隔离 Gradle 和 422f6ca 快照已就绪）：

```powershell
$env:COVE_ACCEPTANCE_SOURCE_COMMIT = '422f6caff7ad3d41d2fe91f5b3c421c58ec7438e'
$env:COVE_ACCEPTANCE_ID = 'cove-acceptance-20261023'
if (!(Test-Path -LiteralPath 'runtime/acceptance-20261023/android-tools/short-layout.json')) {
  node tooling/android-acceptance.cjs shorten
  if ($LASTEXITCODE -ne 0) { throw 'Android snapshot migration failed' }
}
node tooling/android-acceptance.cjs resume
```

新工作区应先以当前完整 HEAD 作为 `COVE_ACCEPTANCE_SOURCE_COMMIT` 执行
`prepare`，再 `shorten`、`resume`。迁移会校验产品树、每个 tracked 文件、
共享 dist 和缓存源路径；续建保留快照的真实源码 pin，并另记工具提交。
本轮产品源码与后续工具/文档提交的产品树相同，不能把旧工具环境失败写成
新源码编译失败。已有包优先使用，无需用户配置开发环境。

Gradle 9.3.1 / AGP 8.12.0 / JDK 17 / SDK 36 / NDK 27.1；缓存和
原生副本只在本轮 runtime 或标记的用户 Temp。普通 JS 借用依赖仅读，
8 个 Gradle 原生包物理复制后才构建；不自动下载 JDK/SDK，不使用全局或
正式发布工具链设置。回收 Temp 时须先停止本轮构建，并核对 owner marker。

最终实际两套 ABI 各有 15 个原生库，库名集合相同；Cove RNNoise、appmodules、
Hermes 和 WebRTC 均齐全。30 个库的 ELF class/machine 全部符合架构：
arm64 为 64-bit/AArch64(183)，armv7 为 32-bit/ARM(40)。APK 内离线 JS
为 3475160 字节；两 ABI 主 Ninja 图各 190 个显式绝对输入/包含根，最长均 224。
这些是成品静态完整性检查，不代表在 ARM 设备上运行过。

原始 JUnit XML 保存在 `android-tools/unit-results/`，汇总为
`native-unit-summary.json`；原生库/ELF 证据为 `apk-native-libraries.json`、
`apk-native-elf.json`。短目录激活后的工具回归另跑 17/17，通过；完整 58 项
契约记录保留不覆盖。旧路径失败与 Ninja 首次/二次探针原样保留，不算成功构建。

本轮所有产物、SHA-256 和日志哈希统一见
`runtime/acceptance-20261023/validation-manifest.json`；便捷入口为
`runtime/acceptance-20261023/artifacts/验收入口.md`，只推荐其中本轮两个包。

## 最小真机验收与回滚

- 静音/未静音语音和观看时，分别短暂掉网、切换 Wi-Fi 与蜂窝，观察实际声音、
  视频和恢复导出，不能只看连接图标。
- 恢复中主动离开、取消观看或切房间；确认不会复活已取消意图或自动重新采集、
  开启共享。
- 远控在断线后撤权，必须再次人工批准；包不能自动恢复授权。
- 重启隔离服务端，确认旧会话安全退出、需要手动重新加入；连续恢复至少 30 次，
  再做较长真实通话，检查重复声音、卡顿和资源增长。

回滚只需退出测试进程并回到原应用；两者数据目录独立。Android 测试包使用
独立标识，不能覆盖正式版。测试目录可另行归档，保留原应用和正式数据。
源码回滚点为本轮起点 `b8c3b99`，更早结构基线为 `d8eb548`。
目前仅定位为隔离验收候选，尚不具备正式发布条件。
