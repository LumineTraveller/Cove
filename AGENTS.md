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

## 其他约定

- 桌面端、服务端和手机版本号可以独立递增，但手机版发布必须遵守上述 Android 版本检查。
- 生产发布前保留现有数据目录和可回滚备份；不要把测试构建或临时安装包提交进仓库。
