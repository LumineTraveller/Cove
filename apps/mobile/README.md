# Cove Mobile

Cove 的独立 React Native 手机客户端。当前功能：

- 使用邮箱账号和服务器地址注册、登录
- 创建或加入房间
- 加入语音、开启或关闭麦克风
- 播放房间语音包
- 观看其他成员的屏幕共享
- 只观看其他成员的共享，不提供手机发起共享或批注；全屏音量可按需展开
- 接收电脑端单应用音频共享，显示共享者/应用名，独立调节音量（默认 100%，步长 1%）
- 启动时自动识别 Android 更新，应用内显示说明、下载进度并校验 APK，通过后仅打开系统安装确认，无需先填写聊天地址或登录

手机端可以创建或加入房间，并直接观看其他成员的屏幕共享。观看区域提供独立共享音量和静音；音频设置与全屏观看中也能调节同一音量。全屏默认不展开工具栏，视频使用完整观看区域。手机不发起屏幕采集、不绘制批注，也不提供媒体状态面板。远控仍遵守共享者和服务器的授权。

音量滑条扩大了触控区域，并在拖动开始后保留整个手势的横向坐标，即使手指上下偏离轨道也继续调整。用户音量仍支持 0–200%，共享和语音包音量仍为 0–100%。

Android 加入语音并获得当前房间列表后，优先预备收藏及前排的最多 6 个语音包。原生端最多保留 8 个准备好的播放器，下载并发为 2，每个文件沿用 8 MB 上限；缓存仅在应用私有临时目录中存在。退出语音、切房间、凭据变化或应用销毁会取消下载并释放相应会话；标准化文件变化会重新准备。仍以服务器播放广播为准，不提前播放未经确认的本地请求。没有预备完成或不支持原生播放的安装包使用原有输出设备校验及短音频缓冲回退。

加入语音后不会再因距离传感器检测到贴脸而熄屏；正常自动锁屏和电源键锁屏仍然保留，后台麦克风服务不受影响。

## 构建 Android 安装包

环境要求：Node.js 22、JDK 17、Android SDK 以及 Android NDK。

```powershell
npm install
npm run typecheck
npm run lint
npm run android:apk
```

本目录在三端重构中位于 `apps/mobile`。首次使用先在仓库根目录安装依赖并运行 `npm run build:packages`，再在本目录运行 `npm ci`；共享包的 Metro 监听已配置。
独立验证包可在 `android` 运行 `gradlew.bat assembleDebug -PcoveRefactor -PreactNativeArchitectures=arm64-v8a`，包名为 `com.cove.mobile.refactor`，内嵌 JS，不覆盖正式版。正式发布不使用该调试标志。

可独立安装的 Release APK 位于：

```text
android/app/build/outputs/apk/release/app-release.apk
```

`npm run android:apk:debug` 只用于编译调试包；日常开发可先运行 `npm start`，再在另一个终端运行 `npm run android`。

## 连接服务器

首次启动时填写服务器根地址，例如：

```text
https://frp-mix.com:51758
```

不要在末尾填写 `/api/rooms` 或 `/mobile`。应用会保存服务器地址和用户名，后续仍可在登录页修改。

Android 登录页输入 HTTPS 地址后，可选择“允许此服务器使用不受信任的证书”。默认关闭，只有当前 HTTPS 主机和端口享有例外；切换地址会重置，其他服务器以及跨来源重定向仍验证证书。例外覆盖 WSS、HTTP API 和语音包下载，不改变 mediasoup 的媒体传输。仅对你信任的自建服务器开启，正式部署仍建议使用有效证书。旧安装包必须重新构建安装才能使用此原生功能。

## 回归测试

在 `apps/mobile` 目录运行 `npm test -- --runInBand`、`npm run typecheck`、`npm run lint`。
在 `apps/mobile/android` 目录运行 `./gradlew.bat :app:testDebugUnitTest -PcoveRefactor`，包含本机自签名 HTTPS/WSS 正向测试、其他主机/端口及重定向拒绝测试、关闭例外测试。无需公网服务器。

媒体仍通过 Cove 服务器配置的 mediasoup UDP 端口传输，所以服务器和 Sakura Frp 的 UDP 隧道必须保持运行。Android 原生应用允许使用 HTTP 地址进行局域网测试，但公网部署仍建议使用 HTTPS。

## iOS

工程保留了 iOS 目录，但 Windows 无法生成 iOS 安装包。需要在 macOS 上安装 Xcode 和 CocoaPods 后再完成签名与构建。

## Android 更新机制与发布

首次启动自动检查；返回前台时距上次完整检查超过 6 小时会再检查。网络失败不阻止登录、不自动弹错误；失败后再次返回前台可在 1 分钟后重试。登录页和房间列表的版本文字均可手动检查，不依赖 Cove 服务器连接。

更新提示包含版本、说明、APK 大小和下载来源。下载地址变量是 `src/features/updates/updateConfig.ts` 中的 `UPDATE_DOWNLOAD_BASE_URL`，默认留空，只检查 GitHub，不使用聊天服务器或硬编码域名补填；修改后需重新打包，不随聊天服务器切换。官方域名是 `cove.luxe`，不预填到变量中。配置有效 HTTPS 下载地址后，并行检查 GitHub 的 `main/mobile/update.json` 与该服务器的 `/releases/mobile/update.json`，优先选择最高 `versionCode`，相同版本优先使用服务器；只有提供相同版本/大小/SHA-256 的镜像可切换。下载地址无效、使用 HTTP 或未提供清单时回退 GitHub。两源同版本元数据冲突会拒绝下载。桌面版 Release 不参与手机更新判断。

用户点击“下载并校验更新”后，在应用内从所选官方源下载，展示真实下载字节与进度，可取消后重试；更新弹窗不再提供浏览器下载入口。镜像源与 APK 重定向均在原生层校验，使用独立的标准 TLS，不受聊天服务器证书例外影响。当前选择的聊天服务器不会成为更新来源。

安装包保存在 Cove 私有更新目录，下载中的暂存文件不在 FileProvider 的共享范围内。下载后核对完整大小与 SHA-256，再从实际 APK 读取包名、versionCode、versionName、最低 Android API 和签名证书集合，与官方清单及本机已安装身份匹配后才允许安装。每次点击安装均重新校验文件和身份，然后只打开 Android 系统安装器，由用户最终确认。Android 8 及以上没有允许此应用安装更新时会明确提示，只有用户单独点击才打开系统权限设置；拒绝权限或取消安装后不会自动再次打开。

下载超时、网络中断、取消或应用进入后台会结束当前任务，清理未完成文件后可安全重新下载；不对未完成 APK 做 Range 续传。重启后不恢复未验证的安装状态；重新检查并点击下载会先复验私有目录中已完成的同一安装包，合格缓存可复用。空间不足时提示腾出空间后重试。取消、进度与异步回调按下载请求 ID 隔离，旧任务不能覆盖新任务。

`-PcoveRefactor` 构建的 `com.cove.mobile.refactor` 是独立测试身份，不可接收正式 `com.cove.mobile` 更新；原生模块会明确拒绝，不能通过放宽包名或签名校验验收。此轮本地候选保持正式版本号、签名策略和已发布清单不变，不安装现用设备。Jest、HTTP 故障夹具和 JVM 身份测试验证各层契约；系统安装器、权限与 OEM 差异仍需另行真机验收。

`update.json` 是手机端独立更新清单；`release: null` 可用于尚未发布手机更新时，不会把桌面安装包或旧 APK 当成新版。发布流程（以下命令在 `apps/mobile` 目录运行）：

1. 修改本目录 `package.json` 和 `android/app/build.gradle` 的手机版本，递增 Gradle `versionCode`；使用与现有安装包一致的签名证书和应用 ID。不要更换签名导致无法覆盖安装。
2. 准备手机端专用更新说明 Markdown 文件，测试后执行 `npm run android:apk -- -PreactNativeArchitectures=armeabi-v7a,arm64-v8a` 重新构建 ARM 手机版。不要使用上次残留 APK；需要 x86 模拟器包时可单独构建，但不混入正式手机清单。
3. 提交手机端代码并将独立标签 `mobile-vX.Y.Z` 推送两平台。执行 `npm run update:prepare -- <更新说明文件路径> mobile-vX.Y.Z`，读取 APK 构建元数据，核对版本并生成 `build/updates/mobile-vX.Y.Z/Cove-Mobile-X.Y.Z.apk` 和 `update.json`；不上传、不修改在线清单，且拒绝覆盖已有暂存文件。
4. GitHub 手机 Release 上传生成的 APK（保留文件名）及由同一 APK 生成的 `update.json`，Release 说明使用手机端更新说明。**不把手机版附加到桌面 Release，不替换桌面附件、原有说明或标签**。确认 APK 地址可下载且大小、SHA-256 与清单一致。Gitee 不创建 Release。
5. 在仓库根目录执行 `scripts/publish-mobile-release-to-cloud.ps1 -FeedPath apps/mobile/build/updates/mobile-vX.Y.Z/update.json`，镜像同一个 GitHub APK 到 `Cove_server:/var/www/cove-download`，先确认公开 APK 可下载，再由脚本最后公布服务器清单。
6. 将生成的清单同时复制到 `apps/mobile/update.json` 与根目录 `mobile/update.json`，提交并推送两平台 `main`。后者保留旧 raw URL 兼容。检查 GitHub、Gitee raw 清单与服务器清单一致；手机端只把 GitHub 和独立配置的 HTTPS 下载服务器作为下载来源。

GitHub 发布手机版时指定 `make_latest: false`，保留桌面版为 Latest；桌面客户端仍以 GitHub 作为服务器镜像故障时的备用源。手机端不依赖 Latest 或发行版的预览标记，只认独立更新清单。

现有手机工程仍用 `debug.keystore` 签名 Release；它不适合作为正式分发的长期安全凭据。迁移专用发布密钥需同时规划老用户换装，不能直接换钥匙后宣称支持覆盖升级。Android 要求覆盖更新保持签名身份一致且 `versionCode` 不降低，参见 [Android 签名文档](https://developer.android.com/studio/publish/app-signing) 和 [版本管理文档](https://developer.android.com/studio/publish/versioning)。

尚未安装本机制的旧手机端需要先手动安装一次包含此功能的新版，之后才能自动识别后续发布。
