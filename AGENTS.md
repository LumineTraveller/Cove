# Cove 项目工作准则

## 手机版本发布前置检查（必须执行）

任何提交、推送或发布 Android 手机版更新（包括 `mobile/update.json`、`mobile-v*` 标签和 Gitee/GitHub Release）之前，必须先完成以下检查；未通过时不得发布：

1. 读取 `mobile/package.json` 的 `version`。
2. 读取 `mobile/android/app/build.gradle` 的 `versionName` 和 `versionCode`。
3. 读取现有 `mobile/update.json` 的 `release.versionName` 和 `release.versionCode`。
4. 确认 `package.json.version` 与 Android `versionName` 完全一致，并且新的 Android `versionCode` 严格大于线上清单中的旧值；只改显示版本号、不递增 Android `versionCode` 时必须停止。
5. 构建 APK 后，使用 `output-metadata.json` 再次核对 `applicationId`、`versionName`、`versionCode`、最低 Android API 和 APK 架构。
6. 从最终 APK 计算实际文件大小和 SHA-256，生成更新清单；清单中的版本和校验值必须来自这一个最终 APK，不能手填或沿用旧值。
7. 先确认 GitHub 手机版 Release 已公开并且 APK 附件可下载，再同步 Gitee Release；更新清单推送到 GitHub 和 Gitee 的 `main` 后，分别核验两个 raw 地址返回的新版本。

手机版更新发布完成的判定条件是：Android 版本号已递增、Release APK 元数据与清单一致、两个更新源的清单一致。仅上传 Release 附件而不更新 `mobile/update.json` 不算完成。

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
