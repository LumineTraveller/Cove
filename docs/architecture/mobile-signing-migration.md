# Android 正式签名准备与迁移边界

本次只准备显式配置和校验入口，没有创建、导出、替换或使用正式密钥，没有改
Secrets、持续权限、现有 APK 或发布签名。默认 `legacy` 模式继续使用原来的
debug keystore，现有 release workflow 的证书 SHA-256 检查仍保持：

`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`

**切换签名仍需用户单独确认迁移方案与密钥使用。** Android 更新会比较已安装
APK 与新 APK 的签名证书；直接换一把密钥不能假定仍能覆盖旧安装。官方对应用
签名、密钥升级及更新兼容性的说明见
[Android app signing](https://developer.android.com/studio/publish/app-signing)。

## 配置入口

`android/signing-config.gradle` 只有显式设置 `COVE_ANDROID_SIGNING_MODE=external`
才启用外部签名。默认值为 `legacy`；存在其他遗留环境变量不会自动切换。
外部模式必须同时提供以下环境变量，缺项、相对路径、不存在的 keystore、错误
指纹格式或误选旧 debug.keystore 都会在配置阶段失败，错误不包含密码值：

| 变量 | 含义 |
| --- | --- |
| `COVE_ANDROID_STORE_FILE` | 现有 keystore 的绝对路径 |
| `COVE_ANDROID_STORE_PASSWORD` | keystore 密码 |
| `COVE_ANDROID_KEY_ALIAS` | 已存在的签名 alias |
| `COVE_ANDROID_KEY_PASSWORD` | alias 密码 |
| `COVE_ANDROID_EXPECTED_SIGNER_SHA256` | 预先独立核实的证书指纹，64 位十六进制 |

不要把密钥或密码放到仓库、命令行参数、可分享日志或 checked-in Gradle
properties。应通过单独获准的安全输入环境提供；本说明不包含生成密钥或配置
远端 Secrets 的动作。

## 本地校验

在 `apps/mobile` 目录执行 `node scripts/verify-signing.cjs`。默认只报告 legacy，
不读取 keystore。外部模式进行路径/必填值预检，输出不包含密码、alias 或路径。
预检不是 keystore 密码/真实签名的证明；实际 Gradle 签名及 APK 校验仍需完成。

对获准构建出的 APK，用本机 Android SDK 的 `apksigner verify --verbose
--print-certs <APK>` 生成 UTF-8 报告，并检查该工具退出码为 0；然后执行：

```powershell
node scripts/verify-signing.cjs --report <报告路径>
```

校验要求 `Verifies` 成功标记、只有一个 signer，以及证书 SHA-256 与选定模式
的预期值完全一致；不会因为只看到某个证书字段就忽略签名验证失败。
默认模式核对旧证书，外部模式核对显式指定的证书。该工具不发布或安装 APK。

## 切换前的独立验收

先记录当前公开 APK 的真实证书及用户覆盖的 Android 版本，再明确采用保持
旧身份、经验证的签名谱系/轮换，还是新包名并行迁移。不能以 Play App Signing
的密钥升级规则代替本项目直接分发 APK 的实测。需验证已有安装的数据保留、
应用内更新和旧/新系统覆盖安装，准备密钥备份、权限和回退安排，最后再单独
改 release workflow 的身份校验与获准的密钥注入。

当前只通过配置/校验单元测试，未用正式密钥签包、未覆盖安装、未验证真实
Android 签名轮换。因此不能把 external 入口的存在写成已完成正式签名迁移。
