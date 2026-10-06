# Cove 2.0.1 远控与桌面账号密码记忆统一候选

2026-10-06 UTC，本地独立分支 `fix/remote-input-latency-20261007`。本包整合已验收的远控原始指针采样、全屏命中和边框修复，以及桌面账号密码记忆。未安装、发布、推送或部署；服务器、移动端和暂停的媒体优化实验未修改。

## 来源与身份

- 远控产品修复：`76992b24e8ad6a84c8fc6405f21d7e4a67274274`；其诊断记录提交：`f6500f1`。
- 桌面密码记忆来源：`01a06308da0006b59c1427f3e01cc984190d33a9`，从本地 `Cove-mobile-unlock-crash` 仓库导入为 `74331dc`。只导入这一桌面提交，未导入 Android 提交 `d417ed6`，未重新构建移动端。`git diff 76992b2 HEAD -- apps/mobile mobile` 为空。
- 构建代码与工具提交：`d0e354095ae89de84483cf804948037905c8a10f`。本报告的后续提交只保存交付证据，不改变包内容。
- 身份保持 `Cove`、`com.cove.app`、`cove-client`、版本 `2.0.1`，未创建 Lab flavor、未调整版本或 lockfile。

远控采样入口为 `apps/desktop/src/features/media/screen/ScreenVideo.tsx:97`，忽略原始鼠标采样后的重复 pointermove；保留 8 ms 节流、尾部可靠发送、授权与撤销、动作顺序及紧急停止。全屏标题栏隐藏规则位于 `apps/desktop/src/styles/ui-v2.css:3078`。原有原生输入失败释放和 DPI 坐标修复仍保留。

密码主进程接入位于 `apps/desktop/electron/main.ts:293`，加密存储位于 `apps/desktop/electron/account-password-store.ts:28`。账号密码由 Windows safeStorage 加密并按服务器地址和账号隔离；默认不记忆，只在登录成功且用户勾选后保存。实际界面入口为 `apps/desktop/src/app/App.tsx:1101`，成功保存为 `:626`。服务器密码独立，不写入账号密码记录。支持取消某个记忆、忘记账号和清除所有密码；渲染进程 localStorage 不保存密码。

## 安装包与最终载荷

文件：`apps/desktop/dist-app-remote-input-2.0.1/Cove-Setup-2.0.1-remote-input-account-memory.exe`

- 大小：106,573,237 bytes。
- SHA-256：`07ffb8bf4dc47bc21f732e6fb79324d80f684cc2c4106c597e1a68139c9b9144`。
- 2026-10-06 20:49:50 UTC，从 NSIS 载荷流式读取并核对 Cove.exe、app.asar 和三个原生 helper，五个文件全部与已测试的 win-unpacked 文件相同。
- app.asar SHA-256：`88c6c1379908860e4a2d7fc921531ffd54855280f8ef622baef68144c46e90ec`。
- 最终 JS 含原始指针入口，应用绘制的绿色远控边框已移除；桌面密码存储和 IPC 编译文件与源码构建输出一致。

详细哈希、载荷及运行证据见 [artifact.json](remote-input-account-memory/artifact.json)。其中服务器版本政策为 18:44:40 UTC 的既有只读观测，最低版本 2.0.0、协议 3；并非本轮重新访问服务器所得，也不能证明跨网性能。

复用现有 Electron 依赖和同一个 unpacked 输出，没有为统一包再复制依赖或 Electron。先前两个 2.0.1 安装包和 `runtime/rollback-2.0.0/Cove-Setup-2.0.0.exe` 保留，未执行安装或回退。

## 整合后的验证

类型检查、Electron TypeScript 编译、生产前端构建、原生 helper 编译均通过。单元与原生回归共 100 项：账号认证/记忆 25、远控 32、批注 15、采集/呈现 28。实际浏览器界面检查共 20 项：密码界面 10、远控光标界面 10。

密码界面使用真实产品 App、preload 和 Windows safeStorage；仅使用独立配置目录、虚构账号和本地模拟登录接口。覆盖成功保存、失败登录保留旧凭据、账号回填、服务器密码隔离、无明文 localStorage、取消/忘记/清除。未读取真实用户账号、密码或配置。证据见 [account-password-ui.json](remote-input-account-memory/account-password-ui.json) 和 [remote-cursor-ui.json](remote-input-account-memory/remote-cursor-ui.json)。

20:42:59 UTC，30 FPS 渲染环境下，原始与新 React 组件分别经过可信 Chromium 输入、原有授权 Socket.IO 中继、真实 IPC、原生队列及生产 SendInput，另用独立 Windows GetCursorPos 观测自有测试窗口内的光标：

| 项目 | 原始组件 | 统一候选 |
| --- | ---: | ---: |
| 发送 / IPC / 独立 OS 光标变化 | 28 / 28 / 28 | 133 / 133 / 133 |
| OS 变化间隔 P50 / P95 | 33.03 / 44.08 ms | 8.20 / 15.68 ms |
| OS 变化最大间隔 | 412.28 ms | 16.57 ms |
| 顶部区域输入通过 | 0 | 3 |
| 顶部实际命中 | 标题栏 DIV | VIDEO |
| 应用绿色边框数 | 1 | 0 |

该原始组件阶段有启动调度停顿，不能用 28→133 推导性能提升百分比；此前原始采样修复的较稳定对照已保存在 [原始采样报告](remote-input-raw-20261006.md)。本次主要确认整合没有破坏路径。独立 OS 记录逐条与 native ACK 坐标一致，注入坐标与目标每轴误差不超过 1 px，无抑制或失败。真实 Windows 注册的 Ctrl+Alt+Shift+X 热键触发紧急停止；GetAsyncKeyState 证实左键、Shift、Ctrl、Alt、X 全部释放，撤销后的输入被拒绝。原始事件与常规事件未重复发送，关闭控制后未产生采样。见 [windows-pipeline-summary.json](remote-input-account-memory/windows-pipeline-summary.json)。

20:47:37 UTC，启动最终包的真实 Cove.exe 与 app.asar，隔离配置、窗口、网络和自动更新，确认身份/登录界面、真正的账号密码 IPC、Windows 加解密、服务器端口隔离、删除/清除，以及外来窗口 IPC 拒绝均通过。远控授权、队列撤销、延迟 ACK、紧急释放也通过。此最终包测试在内存中将 SendInput 换成仅记录的测试实现、快捷键换成自有回调；安装包文件未改。真实系统光标和真实 Windows 快捷键验证来自前述独立端到端测试，不能把最终包隔离检查当作同一项真实注入测试。

## 实测边界与使用

尚未覆盖用户跨网链路、实际硬件控制鼠标采样、视频反馈、DWM/显示器呈现时间、在真实用户配置上升级安装，以及真实账号密码。当前同机结果不能承诺与本地 240 Hz 硬件鼠标相同的体验，也不能诊断原先 2K60 媒体降帧的根因。

用户准备实测时先正常退出两端 Cove，再自行安装这个明确命名的统一包；版本仍为 2.0.1，因此界面版本号无法区分旧候选。可在授权远控后验证平移、点击、拖拽、滚轮、Shift 拖拽、顶部命中和紧急停止；密码记忆只在需要时勾选，并验证重新进入账号、切换服务器、忘记及清除。远控反馈应区分控制端白点、被控端 OS 光标和视频回显。

本轮执行连接已恢复，所有已授权整合、构建与核验完成，无当前执行环境阻塞。没有启动新的媒体优化搜索、部署、主服务变更或移动端构建。
