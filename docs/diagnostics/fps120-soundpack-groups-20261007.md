# Cove：120 FPS、语音包拖拽与极简分组

本轮本地实现完成，两个功能提交可分别审阅。没有安装、发布、推送、部署或合并正式 main。

## 基线与提交

- 工作树：`C:\Users\cyj06\Documents\Codex\2026-10-07\task-3\Cove`
- 分支：`feature/fps120-soundpack-groups-20261007`
- 安全候选基线：`b5f2c85`，来自 `fix/screen-safe-default-20261007`；没有从当时的诊断 checkout 开始。
- `12b45da`：完整 120 FPS 选项、类型、偏好、采集/发送/策略/诊断链路与回归测试。
- `10f9a06`：一致拖拽命中、极简分组、本地持久化、竞态保护与回归测试。
- 正式仓库 `C:\Users\cyj06\Desktop\Projects\Cove` 开始时为 `main / 65df169`。旧诊断树开始时为 `diagnostic/capacity-evidence-20261007 / 25cb9a5`。
- 依赖通过目录 junction 复用；共享包指向本工作树并在这里编译，没有复制大依赖或历史样本，也没有安装依赖。

## 120 FPS

设置显示 30/60/120 FPS。游戏模式也使用所选 FPS，切换模式不会覆盖 FPS、分辨率档位或原生分辨率偏好。普通模式保留既有内容检测/静态降帧策略：变化画面使用所选帧率，静止后降至 15 FPS。

`ScreenFps`、捕获 `frameRate.ideal/max`、RTP `maxFramerate`、起播/更新、活动策略与诊断请求计划均支持 120；没有添加硬性 `min:120`。更新参数会替换旧的起播宽限期定时器，避免旧回调把 120 写回 60。

`cove_screen_preferences_v1` 保存 FPS、preset、audio、gameMode、nativeResolution；支持原有 30/60、部分设置以及缺失/损坏设置回退。保留原默认 720p/30 与用户选项。起始预算仍为 10 Mbps，上限仍为 200 Mbps，没有引入已撤回的激进起播预算。

主要共享冲突路径：

- `apps/desktop/src/features/media/screen/screenCapture.ts`
- `apps/desktop/src/features/media/screen/useScreenPublishing.ts`
- `apps/desktop/src/features/media/screen/useScreenAnalysis.ts`（注释）
- `apps/desktop/src/features/media/diagnostics/useMediaDiagnostics.ts`
- `apps/desktop/src/features/media/useWebRTC.ts`
- `apps/desktop/src/features/media/screen/ScreenShareSettingsV2.tsx`
- `apps/desktop/src/features/media/screen/screenPreferences.ts`（新增）
- `apps/desktop/src/features/media/desktopMediaSupport.ts`
- `apps/desktop/src/features/rooms/ChatRoomV2.tsx`（只移除游戏切换强制 60）

这些改动可与独立掉帧调查分别整合。选项与参数贯通不代表物理采集、编码、网络或解码已经达到 120 FPS。

## 语音包分组与拖拽

组结构为 `{id, soundIds: string[]}`，持久化外层为 `{version:1, groups:[...]}`。存储键 `cove:soundpack-groups:v1:<server>:<account>` 按标准化服务器地址和稳定账号隔离。旧安装默认把已有服务端顺序归入一组；新素材加入第一组，删除的素材从成员列表剔除，空组保留。

界面只增加细分隔线和组间留白，组容器透明、无边框，没有组标题、组卡片或额外装饰。线属于其下方的组，拖线交换完整组；素材仍由卡片拖动，可跨组移动。存在任何空组时，“添加分组”禁用；移走最后一个素材不会删除素材或擅自删除空组。

新的拖拽 Hook 使用同一指针命中结果驱动占位预览和松手提交；松手会同步处理最终坐标，避免动画帧未更新造成预览与保存顺序不同。拖拽中抑制其他卡片的普通 hover 高亮，只让目标占位指示落点。支持滚动、Esc、pointercancel、窗口失焦、面板关闭及外部列表变化取消。

持久化保留组顺序、组内顺序和空组。具体保护包括加载范围匹配、过期 fetch 忽略/重试、范围和操作代次限制晚到 ACK、失败回退，以及 StrictMode effect 重放后正确恢复 mounted 状态。键盘将组移到第一位仍能提交或取消并正确收尾焦点。

服务端继续收到原有扁平 `{roomId, orderedIds}`，并使用原 ACK/广播接口；没有服务器或共享契约改动，也不需要部署服务器。组是本机账号设置，不跨设备同步。旧客户端仍看到兼容的扁平顺序。

主要文件为 `SoundPackPanel.tsx`、新增 `soundpackGroups.ts` / `useSoundpackGroups.ts` 与两个现有样式文件。

## 验证证据

| 验证 | 结果 |
| --- | --- |
| 屏幕采集、设置、发布/分析 Hook、视频呈现测试 | 37/37 |
| 媒体诊断测试 | 7/7 |
| 原排序与分组数据/命中测试 | 14/14 |
| 真实 ChatRoomV2 / 设置 / useWebRTC UI | 21/21，0 渲染错误 |
| 真实 SoundPackPanel UI | 98/98，0 渲染错误 |
| 原 sortable Electron UI | 通过同排插入、键盘及连续拖拽 |
| 桌面 TypeScript 检查 | 通过 |
| 桌面生产 renderer 构建 | 通过 |
| git diff --check | 通过 |

最终两套功能 UI 使用 Electron 44.0.0 / Chromium 152.0.7977.54。分组回归使用离线构建、真实组件/CSS、Chromium 原生鼠标和键盘输入，范围为 1000×800；测试数据、后端和账号均为合成夹具。屏幕 UI 回归复用真实房间组件，替换媒体/信令边界，拒绝原生权限并使用合成视频；未读取个人屏幕、麦克风或账号。

分组覆盖：同排左右卡片边缘、换行、最终 pointerup、跨组/空组/再填入、整组交换、键盘整组到第一位、Esc 与 pointercancel、滚动、失败 ACK 回退、账号切换期间的 fetch 与晚到 ACK、拖拽时外部删除，以及销毁/重建 Electron 窗口后的持久化。

本地证据（不提交生成文件）：

- `runtime/ui-validation/fps120/result.json`
- `runtime/ui-validation/fps120/normal-120-native.png`
- `runtime/ui-validation/fps120/game-120-native.png`
- `runtime/ui-validation/fps120/reloaded-120-native.png`
- `runtime/soundpack-groups-ui/result.json`
- `runtime/soundpack-groups-ui/divider-group-preview.png`
- `runtime/soundpack-groups-ui/divider-group-committed.png`
- `runtime/soundpack-groups-ui/cross-group-preview.png`
- `runtime/soundpack-groups-ui/restart-persistence.png`
- `runtime/soundpack-groups-fixture/manifest.json`（源码 hash）
- `runtime/validation/`（相关单元测试日志）

已查看实际本地 UI 截图：120 FPS 三列排列、原生分辨率/游戏模式、现有语音包素材卡片、细线与留白、拖拽预览。

重跑命令（本工作树根目录，已有依赖）：

```powershell
npm.cmd run build:packages
npm.cmd run test:screen-capture -w cove-client
npm.cmd run test:media-diagnostics -w cove-client
npm.cmd run test:sortable -w cove-client
npm.cmd run typecheck -w cove-client
npm.cmd run build -w cove-client
node apps/desktop/tests/ui/build-soundpack-groups-fixture.cjs
node apps/desktop/node_modules/electron/cli.js apps/desktop/tests/ui/soundpack-groups.electron.cjs
```

120 FPS UI 需本工作树 Vite 在隔离 loopback 55174 启动后，运行 `node apps/desktop/node_modules/electron/cli.js apps/desktop/tests/ui/fps120-qa.electron.cjs`。两套 UI runner 均把 profile 和证据放在本工作树 runtime；不得同时运行共用一个分组测试 profile 的 runner。

## 已知限制与素材阻塞

用户的 Library 图片 `libfile_e8ddc1103c3c8191b3c2f53f2b79ac48` 通过当前 Library 技能的已解析引用流程准备成功，但授权下载在有效期内返回 HTTP 403，消费端未取得可读图片。没有绕过拒绝或猜测图片内容；原参考截图像素仍未查看。继续实现所依据的是明确需求、现有代码和真实本地组件像素。

`node --test tests/architecture.test.cjs tests/dev-startup.test.cjs` 为 6/8：两个冻结的迁移快照检查失败（原生 remote-input helper 指纹、桌面版本 2.0.1 与冻结 desktop 版本 2.0.0 不符）。该检查逐包对照冻结快照，并不要求桌面版本等于根目录版本。这些源文件/版本与安全基线 b5f2c85 一致，属于候选已有变化；本轮没有改原生输入代码、版本或旧迁移基线。HTTP/Socket 入口、模块依赖边界、第三方依赖、正式 Cove 身份和启动器行为检查通过。

没有生成安装包、安装、发布或部署；现有 Cove 品牌与应用身份不变。真实硬件 120 FPS 性能、生产网络与跨设备分组同步不在本轮证明范围内。
