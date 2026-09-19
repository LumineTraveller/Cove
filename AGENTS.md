# Cove 项目工作准则

## 手机开发与发布

普通手机版代码修改、提交和推送，按受影响功能验证；只有准备或发布手机版更新时，才执行下面的发布流程。修改 `mobile/update.json`、创建 `mobile-v*` 发布标签、上传或发布手机版 Release 都属于发布操作。各阶段的检查在对应操作前完成，发布后的远端核验用于确认交付完成。

### 构建发布 APK 前

1. 读取 `mobile/package.json` 的 `version`、`mobile/android/app/build.gradle` 的 `versionName` 和 `versionCode`，以及现有 `mobile/update.json` 的 `release.versionName` 和 `release.versionCode`；核对线上清单，记录旧版本基线。
2. 确认 `package.json.version` 与 Android `versionName` 完全一致，并且新的 Android `versionCode` 严格大于线上旧值。只改显示版本号、不递增 Android `versionCode` 时停止发布。

### 提交或推送发布清单、创建发布标签、上传或发布 Release 前

1. 构建最终 APK，用 `output-metadata.json` 核对 `applicationId`、`versionName`、`versionCode` 和对应文件；再用 `apkanalyzer` 或 `aapt` 从该 APK 核对包名、版本号及最低 Android API，检查 APK 内 `lib/<ABI>/` 确认实际架构。
2. 从同一个最终 APK 计算文件大小和 SHA-256，生成更新清单。清单版本与校验值必须来自该 APK，不能手填或沿用旧值。推送生效清单前，先完成下面的附件可下载检查。

### 发布顺序与完成条件

1. 先确认 GitHub 手机版 Release 已公开且 APK 附件可下载，再按配额规则同步 Gitee Release。
2. 将更新清单推送到 GitHub 和 Gitee 的 `main` 后，分别核验两个 raw 地址返回的新版本。
3. 只有 Android 版本号已递增、Release APK 元数据与清单一致、两个更新源清单一致，才算发布完成。只上传附件不算完成。

## Gitee Release 附件配额与删除规则

Gitee 单仓库的附件总容量上限为 **1 GiB（1,073,741,824 字节，含仓库附件与 Release 附件）**，单个附件不得超过 **100 MiB（104,857,600 字节）**。向 Gitee 同步 Release 附件前先估算剩余配额；一旦超限，按以下规则清理：

1. **以 Release 为单位整体删除**：先删最早的 Release，不够再删次早的，逐个累加直到剩余空间足够；能少删就少删，不做无差别清空。
2. **不删除单个附件**（会让 Release 页面与实际文件不一致），**不删除 Git 标签**，也不动 GitHub 上的对应 Release。
3. **当前版本与上一个版本的 Release 不得删除**，保证用户仍能下载到最新版和可回滚的上一版。
4. 单个附件超过 100 MiB 时，必须先从源头压缩（通常是打包进安装包的视频、图片等静态资源），不能靠删旧 Release 绕过单文件限制。
5. 删除完成后必须重新统计所有 Release 附件大小之和，确认再加上本次要上传的附件后仍未超出配额，才算清理完成。

## 其他约定

- 桌面端、服务端和手机版本号可以独立递增，但手机版发布必须遵守上述 Android 版本检查。
- 生产发布前保留现有数据目录和可回滚备份；不要把测试构建或临时安装包提交进仓库。
