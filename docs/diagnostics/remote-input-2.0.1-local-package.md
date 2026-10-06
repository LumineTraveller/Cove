# Cove 2.0.1 本地远控测试更新包

本地包已生成并验证；没有安装、推送、公开发布或部署。保留正式 Cove 身份：`appId=com.cove.app`、安装产品名 `Cove`、包/运行时名称 `cove-client`，无 Network Lab/Media Fix build flavor。默认用户数据路径沿用正式应用。桌面 patch 版本为 2.0.1，服务端与移动端均未修改。

修复来源为 `d4c18a4`，有限计时及诊断为 `152bfce`，本地版本标记为 `f7adb6c`。仅桌面清单和根 lockfile 的桌面版本项更新到 2.0.1；版本身份回归改为跟随桌面清单，未改变认证实现或服务器最低版本策略。

| 文件 | 路径 | 字节数 | SHA-256 |
| --- | --- | --- | --- |
| 2.0.1 本地更新安装包 | `apps/desktop/dist-app-remote-input-2.0.1/Cove-Setup-2.0.1.exe` | 106570641 | `6a3eb185ea82d2adbc2debb080f6ec9854a7b2270384f39776c8f027247612a9` |
| 2.0.0 正式回退安装包 | `runtime/rollback-2.0.0/Cove-Setup-2.0.0.exe` | 106487680 | `6a80c3ca1237cde6f13887dbc668d6f7df3a20e9c2783547ac52ac4475233115` |

以上路径相对 `C:\Users\cyj06\Documents\Codex\2026-10-06\task-2\Cove-remote-input-fix`。旧包来自 [正式 v2.0.0 发布](https://github.com/LumineTraveller/Cove/releases/tag/v2.0.0)，大小和 SHA-256 与发布元数据一致，已保留供用户手动回退；没有执行回退安装。

本地 `latest.yml`/blockmap 仅作为打包产物保留，没有上传到更新源。安装包 SHA-512 为 `NwbT2vJXCfEZg8/M0a/wkqQozUWbVLsgAAgqw903Rc15Z5YxFSRWbTDddn3tk+GYAQAava54UWw1Z3mcungl/g==`，与生成的清单逐字匹配。NSIS EXE 的 ProductName/ProductVersion 分别为 Cove/2.0.1。

## 最终包验证

2026-10-06 18:40:47 UTC 启动了最终 `win-unpacked/Cove.exe`，并在应用入口运行之前用本地 inspector 安装测试隔离。它实际运行最终 ASAR，`app.isPackaged=true`，`app.getVersion()=2.0.1`，登录界面与品牌资源正常加载。窗口隐藏，userData/sessionData 使用工作区临时路径；HTTP/WebSocket 和更新器被测试隔离，没有读取正式账号资料或触发自动更新清理。

实际打包的 preload→IPC→RemoteInputController→有界队列链路验证通过：

- 非主窗口的激活和输入请求被拒绝；主窗口正常激活，helper 预热没有输入动作。
- 已记录按键/鼠标按下后，阻塞 native ACK 并提交 80 条移动；撤销清除未发送移动，旧会话后续输入被拒绝。
- 停止时释放保持的 Shift 与鼠标左键；迟到 ACK 不重启输入或 helper。
- 紧急停止回调停止并释放第二个会话；两个 helper 均退出，快捷键测试状态清空。

此项用 test-only 编译副本在 SendInput 边界记录动作，并用进程内回调表替代全局快捷键注册。替身只存在于测试进程内，**没有写入或替换安装包中的 helper**。它证明最终包的权限与排队/释放顺序，不能证明真实 OS 光标、UIPI/提权窗口、物理 DPI 或全局热键注册在用户环境中已验收。

2026-10-06 18:48:55 UTC 从最终 NSIS 安装器流式读取 5 项 payload：Cove.exe、app.asar、remote-input-helper.exe、annotation-window-helper.exe 和 application-audio-helper.exe。五项大小与 SHA-256 均匹配已经启动检查的 unpacked 文件；没有生成第二份大型 payload 副本。最终生产 helper 另做未知 no-op→stop→后续 no-op 检查，输出仅 ready 和第一条 ACK，进程正常退出，没有发送真实 OS 输入。

正式 `http://39.106.95.59:3001/api/version` 只读响应确认桌面 2.0.1、协议 3 被接受：`minimumClientVersion=2.0.0`、`upgradeRequired=false`。请求没有登录凭据；服务配置及最低版本没有改变。完整响应及实际观测时间见同目录 `remote-input-2.0.1/artifact.json`。

本轮更新/版本界面 13 项、账号及请求身份 16 项、撤销/原生控制器/队列 22 项通过，桌面类型检查通过。此前完整远控/批注/屏幕相关 86 项通过的记录仍见 [输入诊断报告](remote-input-latency-20261006.md)。打包复用了现有依赖及 Electron 44，没有创建新的源码或依赖副本。

## 手动复测与保留边界

用户可在停止共享并退出运行中的 Cove 后手动安装本包；控制者与共享发起者都使用 2.0.1 才能覆盖采样/传输及 helper 两侧修复。随后在自行创建的测试窗口完成静止、慢移、快移、拖拽、滚轮/按键及撤销检查。需要回退时使用保留的正式 2.0.0 包；本轮没有实际安装或验证安装后回退过程。

真实 WAN、服务端下行排队、真实 SendInput 与 OS 光标呈现、视频反馈仍待两端复测。测试结果不能视为这些环节的体验验收，也没有恢复旧的媒体优化研究。

清理任务请继续保护整个独立工作区，尤其是 `apps/desktop/dist-app-remote-input-2.0.1`、`runtime/rollback-2.0.0`、`runtime/packaged-remote-input-*` 及现有依赖/验证记录；本轮没有执行盘点清理或删除旧文件。
