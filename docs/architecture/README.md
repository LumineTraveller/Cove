# Cove 三端模块化架构

## 基线与范围

重构基线是原目录的完整当前源码，包含尚未提交的修复，不只是 v1.5.4 标签。`refactor-baseline` 本地标签保存该基线；`baseline/relocation-map.json` 可追溯旧路径。原目录、线上服务器、账号数据库和发布记录均不修改。

本次改变模块组织、依赖装配与资源生命周期，不改变编码器、带宽/采集参数、降噪模型、UI 样式值、信令事件名、请求载荷或版本号。平台原生媒体代码保留，不把 DOM、Electron、Android 或 React 的对象放进共享协议。

## 依赖方向

```text
apps/desktop ─┬─ contracts    ← apps/server
apps/mobile  ─┘  client-core  ← apps/server

应用内：视图 → 功能控制器 → 功能服务/平台适配器
服务端：bootstrap → HTTP/Socket 注册器 → 领域服务 → 存储与媒体资源

media-core / diagnostics：平台无关扩展接口，不反向依赖应用
```

应用不得导入另一应用的源码。桌面 React 18 与手机 React 19 依赖分别解析；手机继续独立安装，Metro 限定自己的 node_modules，并显式监听共享包。共享包先编译，Node/Metro 使用 CommonJS，Vite 预构建与生产 CommonJS 转换配置覆盖 workspace 包。

## 服务端

`src/index.ts` 是兼容启动入口。`createServerRuntime` 装配数据库、SFU、会话和业务依赖，并统一启动/关闭。并发 start/stop 共享操作结果；启动失败释放资源；停止关闭计时器、Socket.IO、mediasoup worker，并等待语音包转换收尾后关闭数据库。

功能划分：

- `accounts` / `security`：账号认证、服务器门禁与凭据检查。
- `sessions`：身份映射、在线状态、断线宽限和清理。
- `rooms` / `chat`：成员权限、房间配置、历史消息和图片。
- `voice` / `media`：语音席位、禁言、Producer/Consumer 与独立屏幕通道。
- `soundpacks`：持久化、响度统一、上传与同步播放。
- `profiles` / `remote-control`：头像和远控授权。
- `storage`：数据库及查询，保持现有数据兼容迁移。

HTTP 和 Socket 注册器按功能组织，注册器保留原本的每连接防重入状态。领域服务通过明确类型的依赖对象取得资源，不在模块导入时启动数据库或网络服务。少量前向引用使用惰性 getter，避免装配顺序改变既有闭包语义；调用只能发生在装配完成后。

## 桌面端

`ChatRoomV2` 负责界面组合，`useRoomController` 负责房间级协调；具体聊天、导航、成员头像、设置、共享视图、音量和控制浮球已成为独立组件。

`useWebRTC` 保持原公开接口，但内部由音频设备/增益/电平、麦克风、语音、传输、屏幕发布、观看、共享音频、应用音频和媒体诊断 Hook 组成。现有异步代次、静音策略、断线宽限和取消清理逻辑保留。拆分不引入新的媒体同步算法。

Electron 的采集、WASAPI、远控 helper、更新器仍是平台适配层，渲染进程不直接操作进程或文件系统。开发模式可指定独立 userData 和渲染地址，正式版默认策略不变。

## 手机端

`App` 组合页面和更新器；`useCoveSession` 管理会话。`RoomScreen` 只组合 UI，`useRoomController` 管理入房、权限、聊天和设置状态；样式及音量滑块独立。

`useMobileMedia` 装配语音加入/拆除、传输、观看、设备、音量和麦克风 Hook；手机屏幕共享继续使用单独的共享通道。每个模块显式解构已初始化依赖，Hook 依赖数组列出稳定的 ref/回调，不依赖每次 render 新建的参数对象，防止重新渲染触发清理。

Kotlin/C++ 的音频会话、RNNoise、播放音频采集、设备路由、证书和键盘插桩保持原实现。`-PcoveRefactor` 仅影响 debug 测试变体：不同包名并内嵌 JS；正式版签名、versionCode 和发布策略不变。

## 扩展点

`contracts` 是线上兼容协议的唯一共用定义；新增字段应可选，旧客户端不得因缺失新字段被拒绝。

`client-core` 提供 ACK 单次完成/超时、注册代次去重、断线宽限策略。桌面/服务器原 5 秒、手机原 7.5 秒期限继续由平台入口选择。

`media-core` 定义 CaptureAdapter、NoiseProcessor、AudioRouting、MediaPublication 和 OperationEpoch；用于未来替换平台能力。这些接口并不表示原生媒体代码已经被重新实现，也不虚构新的编码能力。

`diagnostics` 定义 operation/media/session/server 错误作用域和结构化日志 sink，给后续统一诊断留入口。现有日志与用户可见错误保留，尚未把每条历史日志改成新格式。

新增功能应进入对应 feature；仅当两端行为真正一致才下沉到共享包。不要仅为减少重复而共享平台采集、播放或 React 状态对象。

## 验证与运行

根目录安装并编译共享包后，`npm run dev:app` 使用 HTTP 3301、媒体 41000、Vite 55173 和 `runtime/` 数据。端口被占用会报错，不关闭用户其他进程；关闭启动器只清理自己创建的子进程。

```powershell
npm ci
npm --prefix apps/mobile ci
npm run check
npm test
node tooling/runtime-smoke.cjs
```

启动 `node tooling/dev.cjs --client` 后，可在另一终端运行真实 Chromium 回归：

```powershell
$env:COVE_TEST_NODE = (Get-Command node).Source
& .\apps\desktop\node_modules\.bin\electron.cmd apps/desktop/tests/ui/media-integration.electron.cjs
& .\apps\desktop\node_modules\.bin\electron.cmd apps/desktop/tests/ui/share-chat-animation.cjs
& .\apps\desktop\node_modules\.bin\electron.cmd apps/desktop/tests/ui/login-memory.electron.cjs
& .\apps\desktop\node_modules\.bin\electron.cmd apps/desktop/tests/ui/connection-recovery.cjs
& .\apps\desktop\node_modules\.bin\electron.cmd tests/dev-window.electron.cjs
```

上述媒体测试只生成合成图像和模拟音频，不访问个人屏幕/麦克风。`dev-window` 使用临时独立用户目录加载真实开发主入口，检查登录页和窗口可见性；Electron 必须以可见进程启动，只有后台辅助进程设置 `windowsHide: true`。手机测试在 `apps/mobile/android` 执行 `gradlew.bat assembleDebug testDebugUnitTest -PcoveRefactor -PreactNativeArchitectures=arm64-v8a`。

架构门禁核对 HTTP/Socket 入口清单、依赖边界、原生源码指纹、外部依赖锁定版本和更新清单兼容副本。`tooling/verify-original.cjs` 是本次交付用只读检查，不应作为永久 CI 门禁阻止用户继续开发原目录。

`tooling/extract-*`、`reorganize`、`repair-*` 等是本次迁移记录，不是日常命令，其中部分不是幂等脚本，禁止在完成的目录上盲目重跑。
