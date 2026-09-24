# Cove Mobile

Cove 的独立 React Native 手机客户端。当前 Android 版本仅保留以下功能：

- 使用用户名和服务器地址登录
- 加入已有房间
- 加入语音、开启或关闭麦克风
- 播放房间语音包
- 观看其他成员的屏幕共享
- 接收电脑端单应用音频共享，显示共享者/应用名，独立调节音量（默认 100%，步长 1%）
- 启动时自动识别 Android 更新，应用内显示更新说明，可从当前连接的 HTTPS 服务器或 GitHub 下载 APK

手机端不负责创建或删除房间，也不能发起屏幕共享。
本次音频共享同步指接收电脑端共享，不包含采集手机上其他 App 的音频。
加入语音后不会再因距离传感器检测到贴脸而熄屏；正常自动锁屏和电源键锁屏仍然保留，后台麦克风服务不受影响。

## 构建 Android 安装包

环境要求：Node.js 22、JDK 17、Android SDK 以及 Android NDK。

```powershell
npm install
npm run typecheck
npm run lint
npm run android:apk
```

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

在 `mobile` 目录运行 `npm test -- --runInBand`、`npm run typecheck`。
在 `mobile/android` 目录运行 `./gradlew.bat :app:testDebugUnitTest`，包含本机自签名 HTTPS/WSS 正向测试、其他主机/端口及重定向拒绝测试、关闭例外测试。无需公网服务器。

媒体仍通过 Cove 服务器配置的 mediasoup UDP 端口传输，所以服务器和 Sakura Frp 的 UDP 隧道必须保持运行。Android 原生应用允许使用 HTTP 地址进行局域网测试，但公网部署仍建议使用 HTTPS。

## iOS

工程保留了 iOS 目录，但 Windows 无法生成 iOS 安装包。需要在 macOS 上安装 Xcode 和 CocoaPods 后再完成签名与构建。

## Android 更新机制与发布

首次启动自动检查；返回前台时距上次完整检查超过 6 小时会再检查。网络失败不阻止登录、不自动弹错误；失败后再次返回前台可在 1 分钟后重试。登录页和房间列表的版本文字均可手动检查，不依赖 Cove 服务器连接。

更新提示包含版本、说明、APK 大小和下载来源。并行检查 GitHub 的 `main/mobile/update.json` 与当前输入的 HTTPS 服务器的 `/releases/mobile/update.json`，优先选择最高 `versionCode`，相同版本优先使用服务器；只有提供相同版本/大小/SHA-256 的镜像可切换。当前服务器无效、使用 HTTP 或未提供清单时只使用 GitHub。两源同版本元数据冲突会拒绝下载。桌面版 Release 不参与手机更新判断。

点击“在浏览器中下载更新”后由浏览器下载 APK，再由用户确认安装；**不是应用内下载进度或静默安装**。本实现不在应用内校验下载后的 APK 文件，清单 SHA-256 用于镜像一致性检查及发布者复核。浏览器打不开时可切换来源或打开发布页面。更新清单请求使用独立的标准 TLS 校验，不受服务器证书例外影响。

`update.json` 是手机端独立更新清单；`release: null` 可用于尚未发布手机更新时，不会把桌面安装包或旧 APK 当成新版。发布流程（以下命令在 `mobile` 目录运行）：

1. 修改 `mobile/package.json` 和 `android/app/build.gradle` 的手机版本，递增 Gradle `versionCode`；使用与现有安装包一致的签名证书和应用 ID。不要更换签名导致无法覆盖安装。
2. 准备手机端专用更新说明 Markdown 文件，测试后执行 `npm run android:apk -- -PreactNativeArchitectures=armeabi-v7a,arm64-v8a` 重新构建 ARM 手机版。不要使用上次残留 APK；需要 x86 模拟器包时可单独构建，但不混入正式手机清单。
3. 提交手机端代码并将独立标签 `mobile-vX.Y.Z` 推送两平台。执行 `npm run update:prepare -- <更新说明文件路径> mobile-vX.Y.Z`，读取 APK 构建元数据，核对版本并生成 `build/updates/mobile-vX.Y.Z/Cove-Mobile-X.Y.Z.apk` 和 `update.json`；不上传、不修改在线清单，且拒绝覆盖已有暂存文件。
4. 在 GitHub 新建独立手机 Release，例如标题 `cove mobile 0.4.0`、标签 `mobile-v0.4.0`，上传生成的 APK（保留文件名）和手机端更新说明。**不把手机版附加到桌面 Release，不替换桌面附件、原有说明或标签**。确认 APK 地址可下载且大小、SHA-256 与清单一致。Gitee 不创建 Release。
5. 在仓库根目录执行 `scripts/publish-mobile-release-to-cloud.ps1 -FeedPath mobile/build/updates/mobile-vX.Y.Z/update.json`，镜像同一个 GitHub APK 到 `Cove_server:/var/www/cove-download`，先确认公开 APK 可下载，再由脚本最后公布服务器清单。
6. 将生成的清单复制到仓库 `mobile/update.json`，提交并推送两平台 `main`。检查 GitHub、Gitee raw 清单与服务器清单一致；手机端只把 GitHub 和当前连接的 HTTPS 服务器作为下载来源。

GitHub 发布手机版时指定 `make_latest: false`，保留桌面版为 Latest；桌面客户端仍以 GitHub 作为服务器镜像故障时的备用源。手机端不依赖 Latest 或发行版的预览标记，只认独立更新清单。

现有手机工程仍用 `debug.keystore` 签名 Release；它不适合作为正式分发的长期安全凭据。迁移专用发布密钥需同时规划老用户换装，不能直接换钥匙后宣称支持覆盖升级。Android 要求覆盖更新保持签名身份一致且 `versionCode` 不降低，参见 [Android 签名文档](https://developer.android.com/studio/publish/app-signing) 和 [版本管理文档](https://developer.android.com/studio/publish/versioning)。

尚未安装本机制的旧手机端需要先手动安装一次包含此功能的新版，之后才能自动识别后续发布。
