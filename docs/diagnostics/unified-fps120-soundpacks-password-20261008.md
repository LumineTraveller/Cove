# Cove 2.0.1 本地统一候选

本候选整合 120 FPS 设置、语音包一致拖拽/极简分组，以及密码入口与首次自动填充修复。未安装、推送、发布、部署、修改正式 main 或服务器；独立 FPS 根因工作树未修改。

## 来源与交付

- 分支：`feature/fps120-soundpack-groups-20261007`。
- 安全基线：`b5f2c85809d46046138e395eb6c1a90efcb33a38`。
- 产品源码提交：`64588a3a918334d2b71efaa8f7cfff42e45383d3`。
- 功能提交：`12b45da`（120 FPS）、`10f9a06`（拖拽/分组）、`64588a3`（密码修复；cherry-pick 自 `605d440`，无冲突）。
- 唯一安装包：`apps/desktop/dist-app-unified-2.0.1/Cove-Setup-2.0.1-unified-fps120-soundpacks-password.exe`。
- 大小：`106576310` 字节。
- SHA-256：`9e99fbf0e5656c7f3bb43bdd2e5fe5d22eb313ead3eabbf39b8988f6afece1af`。
- 保持 `Cove` / `com.cove.app` / `cove-client` / `2.0.1`，NSIS x64、oneClick、perMachine=false。仅改变候选文件名；旧安装包和用户数据保留。本轮只构建这一份安装包。
- 构建复用现有依赖和 Electron 44；生产 renderer 与 Electron main/helper 编译成功。没有安装依赖包的新版本。

## 已完成的合并后验证

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 120 FPS 实际产品设置/房间/media Hook UI | 21/21，Electron 44 | `runtime/ui-validation/fps120/result.json` |
| 语音包实际 SoundPackPanel UI | 98/98，16 流程，Electron 44 | `runtime/ui-validation/soundpack-merge-64588a3-20261008/result/result.json` |
| 完整 Electron 进程退出再启动的分组持久化 | 24/24，两个不同 PID 均正常退出 | `runtime/ui-validation/soundpack-merge-64588a3-20261008/full-restart/result.json` |
| 实际产品密码入口/自动填充/账号竞态 UI | 22/22，Electron 44，退出码 0 | `runtime/unified-password/dev-ui-local/desktop-ui.json`，同目录 `runtime-identity.json` |
| 最终 ASAR 密码界面与跨服务器隔离 | 100%/150%/200% 均通过，退出码 0 | `runtime/unified-password/packaged-dpi{1,1.5,2}-ui.json` |
| 屏幕采集/偏好/发布/分析/呈现单元测试 | 37/37 | `runtime/unified-candidate-validation/unit-screen-capture.log` |
| 媒体诊断单元测试 | 7/7 | `runtime/unified-candidate-validation/unit-media-diagnostics.log` |
| 排序/分组数据和命中单元测试 | 14/14 | `runtime/unified-candidate-validation/unit-sortable.log` |
| 账号认证/密码记忆单元测试 | 25/25 | `runtime/unified-password/account-unit-tests-resumed.log` |
| 共享包、桌面类型、renderer、main/helper 构建 | 通过 | 本轮命令退出码均为 0 |
| 架构与启动检查 | 6/8；两项基线已知失败 | `runtime/unified-candidate-validation/summary-unit-baseline.json` |
| NSIS 最终 payload/编译字节/身份/更新元数据 | 通过，退出码 0 | `runtime/unified-candidate-validation/payload-report.json` |
| 实际最终 Cove.exe 隔离启动与退出 | 通过，isPackaged=true，退出码 0 | `runtime/unified-candidate-validation/packaged-startup-smoke.json` |

语音包覆盖左右边缘、换行、滚动、最终 pointerup、连续操作、跨组、整组交换、空组禁新增、取消、ACK 回退、账号 fetch/ACK 竞态及外部删除。完整进程重启实测保留组顺序、组内顺序、空组与禁新增状态，使用同一独立测试 profile，第二进程不重置数据。

120 FPS 设置贯穿类型/偏好、capture ideal/max、sender maxFramerate、普通/游戏策略及诊断请求计划，无硬性 min:120 或残留 60 截断。保留用户分辨率/native 偏好、10 Mbps 起播/200 Mbps 上限，以及普通模式 250ms 内容检测、4s 静态降至 15 FPS。

组结构 `{version:1, groups:[{id,soundIds}]}` 按服务器和稳定账号在本机持久化。旧素材归为一组，空组保留；任一空组存在时禁新增。服务器仍接收原扁平排序契约，无共享契约或服务器改动，组不跨设备同步。

最终 ASAR SHA-256 为 `68773d10c997066d5f0cf58bcefcf33b4b204ede5f3a33a9e7e3052530099572`。密码矩阵使用实际该 ASAR 的 renderer/preload/store/IPC，由外部 Electron 44 的普通隐藏 BrowserWindow 加载，harness 的 isPackaged=false；独立 Cove.exe smoke 则实际启动最终包中程序，isPackaged=true。两者绑定同一 ASAR，不混同开发夹具或旧包。

密码矩阵实测 DPR 为 1/1.5/2，每档分别检查 1280×800、1100×600、1280×1080 视窗的可见入口、指针命中、首次自动填充、服务器访问密码留空、内部滚动及原生滚轮，并每档执行四项跨服务器延迟读取/乱序释放隔离检查。200% 下宽度存在一像素取整（1279/1099），所有行为与可见性检查通过。

NSIS 的 Cove.exe、app.asar、三个 helper 通过 7-Zip 流式哈希与 unpacked 匹配，没有再复制整个 payload。31 个 dist/dist-electron 文件、7 个共享包运行库文件及三个 helper 与本树最终编译字节一致。PE/ASAR 的 Cove 2.0.1 身份、latest.yml 的精确文件名、大小与 SHA-512，以及 120/分组/密码/raw-input/preload 特征均通过。programmatic builder 未生成 effective-config 文件，这一缺失如实记录；appId 来源为源 manifest 与实际本地构建脚本输入断言，builder-debug 原文件及 hash 保留。

## 基线失败与边界

两项架构失败在安全基线已存在：`remote-input-helper.cs` 的规范化 SHA-256 为 `88d1330ffe1985ee4c112ac6246b3bb49f95da71ae07fcfe24c5467625bd088a`，冻结期望为 `6fc1bb96e4c0cf8747de9a53bfdfcb3547d9b042e1edd386213a59c4283ee87f`；桌面实际 2.0.1，冻结 desktop 期望 2.0.0。源码、快照、测试和 lockfile 均与 b5f2c85 一致，没有改期望掩盖失败。详情在 `runtime/unified-candidate-validation/baseline-evidence.json`。

已查看本地真实组件截图；Library 原参考图授权下载仍为 HTTP 403，原图像素未取得，不能宣称与该原图比对。UI 测试使用合成数据、隔离 profile 和拒绝原生采集权限，没有读取个人账号/屏幕/麦克风。120 FPS 参数请求得到验证，实际硬件采集/编码/网络性能及真实安装覆盖过程未验证。

初次严格启动 smoke 在调试连接立即关闭的退出路径观察到 0xC0000005。仅修改 runtime harness 为确认延迟退出请求、禁用 debugger、等待 inspector 关闭再退出后，严格退出码 0 检查通过；产品字节未变。首次观察及最终测试顺序均保留，不能凭首轮观察宣称已发现产品回归。密码较早验证误用 Electron 29，44 offscreen 150% 截图曾报 UnknownVizError；这些记录保留，最终验收采用 Electron 44、与生产同类的普通 BrowserWindow 结果。

实际 Cove.exe 测试在启动前暂停主入口并安装进程内测试保护，隔离 userData/sessionData，隐藏窗口，屏蔽网络/更新器、原生子进程、真实采集、外部链接及快捷键；未改变 ASAR、fuse、IPC 信任规则或安全配置。证明本地包内启动、品牌、入口、密码状态 IPC 与退出，不证明真实安装覆盖/回滚或不带测试保护的完整业务会话。开发服务和本轮测试进程均已退出。
