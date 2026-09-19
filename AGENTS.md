# Cove 项目工作准则

## AI 协作纪律（必须遵守）

- 每轮任务完成后，直接以文字总结结束回合。**禁止进入"待命"状态**：不得重复调用任何工具输出 ready/done 之类的空转确认，不得连续输出无信息量的收尾消息。总结完毕即停止，等待用户下一条指令。
- 空转的重复确认会白白消耗大量 token，属于必须杜绝的行为；本条对每一次交互生效，无论前文是否重复提及。

## 手机开发与发布

普通手机版代码修改、提交和推送，按受影响功能验证；只有准备或发布手机版更新时，才执行下面的发布流程。修改 `mobile/update.json`、创建 `mobile-v*` 发布标签、上传或发布手机版 Release 都属于发布操作。各阶段的检查在对应操作前完成，发布后的远端核验用于确认交付完成。

### 构建发布 APK 前

1. 读取 `mobile/package.json` 的 `version`、`mobile/android/app/build.gradle` 的 `versionName` 和 `versionCode`，以及现有 `mobile/update.json` 的 `release.versionName` 和 `release.versionCode`；核对线上清单，记录旧版本基线。
2. 确认 `package.json.version` 与 Android `versionName` 完全一致，并且新的 Android `versionCode` 严格大于线上旧值。只改显示版本号、不递增 Android `versionCode` 时停止发布。

### 提交或推送发布清单、创建发布标签或发布 Release 前

1. 构建最终 APK，用 `output-metadata.json` 核对 `applicationId`、`versionName`、`versionCode` 和对应文件；再用 `apkanalyzer` 或 `aapt` 从该 APK 核对包名、版本号及最低 Android API，检查 APK 内 `lib/<ABI>/` 确认实际架构。
2. 从同一个最终 APK 计算文件大小和 SHA-256，生成更新清单。清单版本与校验值必须来自该 APK，不能手填或沿用旧值。推送生效清单前，先完成下面的附件可下载检查。

### 发布顺序与完成条件

1. 先确认 GitHub 手机版 Release 已公开且 APK 附件可下载。Gitee 不创建、不编辑、不上传 Release 附件；Gitee 仅作为仓库同步目标。
2. 将源代码、必要的 Git 标签和更新清单推送到 GitHub 和 Gitee 的 `main` 后，分别核验两个 raw 地址返回的新版本。除非用户明确要求，不在 Gitee 创建或修改 Release。
3. 只有 Android 版本号已递增、GitHub Release APK 元数据与清单一致、两个更新源清单一致，才算发布完成。Gitee 仓库不需要有对应的 Release 或附件。

## Gitee 同步规则

- Gitee 只同步 Git 仓库内容，包括按发布流程需要的提交、`main` 分支和必要标签；不创建、不编辑、不上传、不删除 Gitee Release 或 Release 附件。
- 手机版 APK 的发布页和下载附件以 GitHub Release 为唯一发布载体；Gitee 只接收仓库代码和 `mobile/update.json` 等更新清单。
- 不再执行 Gitee Release 附件配额统计或清理；如需处理历史 Gitee Release，必须获得用户明确要求。

## 其他约定

- 桌面端、服务端和手机版本号可以独立递增，但手机版发布必须遵守上述 Android 版本检查。
- 生产发布前保留现有数据目录和可回滚备份；不要把测试构建或临时安装包提交进仓库。
