# Cove Mobile

Cove 的独立 React Native 手机客户端。当前 Android 版本仅保留以下功能：

- 使用用户名和服务器地址登录
- 加入已有房间
- 加入语音、开启或关闭麦克风
- 播放房间语音包
- 观看其他成员的屏幕共享

手机端不负责创建或删除房间，也不能发起屏幕共享。

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

媒体仍通过 Cove 服务器配置的 mediasoup UDP 端口传输，所以服务器和 Sakura Frp 的 UDP 隧道必须保持运行。Android 原生应用允许使用 HTTP 地址进行局域网测试，但公网部署仍建议使用 HTTPS。

## iOS

工程保留了 iOS 目录，但 Windows 无法生成 iOS 安装包。需要在 macOS 上安装 Xcode 和 CocoaPods 后再完成签名与构建。
