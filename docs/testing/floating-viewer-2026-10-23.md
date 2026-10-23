# Cove 桌面置顶小窗验收

## 版本与范围

原验收版 `3435e96c` 保留在 `codex/connection-lifecycle-stability`，原 Windows ZIP、Android APK 和 Library 副本均未覆盖。新功能位于 `codex/desktop-floating-viewer`；功能提交为 `2cf777d`，独立审阅后的异步事件保护修复为 `73a85a5`。桌面、服务端显示版本仍为 2.1.0；手机仍用原 0.8.2 验收 APK，不需要重打。

本轮只改变桌面观看的呈现，不改服务端/手机、信令、Consumer、采集、编码、画质或声音路由。平台设计见 [floating-viewer.md](../architecture/floating-viewer.md)。

## 操作与预期

1. 正常观看他人共享，打开共享底栏的“共享操作”（共享管理上拉栏），再点击“置顶小窗”。原生窗口可拖动、等比例缩放，并保持置顶；原观看区域显示“正在置顶小窗中观看”和返回按钮。
2. 可以最小化主窗口，观看和声音继续。点击小窗自带的返回/关闭按钮，或主窗口画面内／“共享操作”上拉栏中的“返回主窗口”，回到原观看；保持语音和观看连接。
3. 首版小窗只观看。正在远控、等待远控批准或正在批注时，先结束相应操作；小窗期间不显示这些操作，且全屏入口暂时禁用。返回不会自动申请权限。
4. 真正“结束观看”、共享者停止共享、切换观看、换流、离房或退出应用时，结束对应小窗；不自动重开。ICE 恢复保留同一远程流时，小窗继续显示。
5. 小窗失败时保留原观看并提示重试；不新增媒体重连、音频播放器或采集。

## 自动验证入口

仅使用已有依赖和隔离测试进程，不安装、不连接正式服务：

```powershell
node tooling/ci-regression.cjs desktop
node --test tests/architecture.test.cjs tests/ci-regression.test.cjs
node tooling/verify-floating-viewer.cjs
```

`verify-floating-viewer` 在 `runtime/pip-20261023/integration-*` 建立独立用户目录、Vite 缓存、测试数据库与本机端口；使用真实 Electron、真实 SFU/UDP 和合成画面/静音输出的合成音频。报告明确记录开始/结束、资源及失败原因，不将失败轮计入通过。

## 已验证与证据

- 原生能力探测：Electron 44.0.0 / Chromium 152.0.7977.54，18 项通过。实际 HWND 置顶、移动与等比例缩放；默认后台节流下最小化持续播放；通过原生 X/返回按钮，视频与语音轨道均继续存活且没有 clone/stop/pause。报告位于 `runtime/pip-20261023/result-639c4162-561a-4080-bb9b-960c26df8d53/`。
- 生命周期单测：48 项通过。含重复进入/返回、主动取消、换源、关闭失败后重试、销毁、迟到响应，以及同一视频新请求等待期间旧 enter/leave 三种事件组合；独立复核将后者扩展为同源/换源六种反例，全部通过。
- 完整桌面类型、486 项 TS 与 85 项 CJS 回归通过：`runtime/pip-20261023/regression-desktop-freeze.log`。模块边界/CI 契约 15 项通过：`runtime/pip-20261023/architecture-final.log`。
- 真实浏览器集成验证原视频/流/轨道与 Consumer/Producer/音频图保持不变、主窗口最小化和返回、原生关闭、UDP 中断后 ICE 参数更新及新解码帧/非静音语音 PCM 恢复、重复开关、换流、停看、共享结束、卸载与离开。最后 React 所有者卸载后，轨道/连接/消费者/生产者/音频上下文/计时器/间隔均为零；测试服务端停止，测试窗口销毁。最终记录由 `runtime/pip-20261023/integration-latest.json` 指向。

浏览器音频证据为真实合成语音 Consumer 及现有语音输出图，没有启动 Windows 系统/共享声音采集；不将其表述为物理扬声器或原生 WASAPI 验收。

最终浏览器集成结果、包路径和 SHA256 随交付清单提供，不能用单纯 transport connected 代替帧/音频进展。

## 未验证边界与回退

未实际拔插显示器、修改系统缩放或跨显示器手工拖动；工作区约束由 Chromium 原生窗口管理负责。没有新增或变更系统显示、网络、权限设置。合成音频验证解码/音频图保持，不声称物理扬声器验收或延迟提升。

新包解压到独立目录，退出测试应用和测试服务端即可继续使用原验收包/正式应用；不要把正式数据复制到测试目录。源码需要回退时使用保留的原分支 `codex/connection-lifecycle-stability`（`3435e96c`），无需数据迁移。没有安装、推送、发布或部署。
