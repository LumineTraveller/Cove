# Windows 桌面端安装文件检查与恢复

此功能检查当前版本的 Windows x64 程序文件。它不会把账号、设置、聊天记录、语音包、Electron 缓存、默认 `userData` 或用户目录中的 `.cove` 当成待修复文件，也不会通过删除这些数据来修复程序。

历史 **2.0.2 没有官方安装完整性清单附件**。2.1.0 发布流程上传匹配的官方清单，不为历史 Release 补造清单。缺少清单、离线或无法取得官方校验信息时，不能据此判断安装文件完整；无清单的旧版禁用应用内自动修复，使用官方版本页手动恢复。

## 应用仍能启动时

在设置的“更新中心”页找到“安装完整性”，点击“检查安装文件”。检查使用当前精确版本的官方清单，报告缺失、大小不符或 SHA-256 不符的程序文件。取消检查不会改写安装文件。

对于已经发布官方清单、并通过安装路径安全预检的版本，如果提供同版本修复安装包，可以先下载，再明确确认启动安装器。下载完成不等于安装完成，修复也不是自动更新到另一版本。安装器由 Windows 启动，安装过程仍需遵循系统提示。应用先暂停普通更新器退出时的自动安装，再请求 Windows 启动修复安装器，避免两个安装器同时启动；只有操作系统成功接受启动请求后才退出。启动失败会恢复原来的自动安装策略，保留错误状态，不能提示修复完成。

应用内修复会拒绝检测到的符号链接、junction、硬链接和异常目录。检查只能验证当时的路径状态，恶意本地程序仍可能在最后一次检查之后或系统安装器运行期间改动路径；此功能不能替代反恶意软件，也没有经过本次任务的真实安装器集成验证。

## Cove 已经无法启动时

`Cove.exe`、`resources/app.asar` 或 Electron 运行时损坏时，主进程可能根本无法运行，应用内入口也无法打开。此时使用浏览器和官方完整安装器恢复：

1. 确认已安装版本。可以查看 Windows“已安装的应用”中的版本、`Cove.exe` 文件属性中的产品版本，或之前保存的安装器文件名。不要用“最新版”代替需要恢复的精确版本。
2. 在浏览器打开官方版本页：`https://github.com/LumineTraveller/Cove/releases/tag/v<版本号>`。例如，2.0.2 的页面是 [Cove v2.0.2](https://github.com/LumineTraveller/Cove/releases/tag/v2.0.2)。
3. 从该版本的 Assets 下载原 Windows x64 **NSIS 完整客户端安装器** `Cove-Setup-<版本号>.exe`。当前官方 Windows 客户端产物为 x64；如将来同页有多个架构，必须选与原安装相同的架构。`Cove-Server-Setup-...exe`、`.blockmap`、`latest.yml` 和完整性 JSON 都不能代替客户端安装器。
4. 退出 Cove，包括托盘中的进程。若程序卡住，在任务管理器确认并结束属于这次 Cove 安装的残留进程，避免文件仍被占用。保留现有用户数据；不要删除、改名或清空默认 `userData`、`.cove`、账号设置、聊天记录或语音包。需要额外备份时，先把数据复制到自己选择的安全位置。如果检查已经提示链接或目录异常，先请维护者核实并处理目录映射，再覆盖安装；不要绕过路径安全拒绝直接运行安装器。
5. 运行刚下载的同版本安装器，沿用原来的安装范围和安装位置进行覆盖安装。当前默认 NSIS 配置会识别原安装、替换程序文件，并保留默认用户数据。不要先执行带“清除数据”的卸载或重置操作。
6. 按 Windows SmartScreen、UAC 和安全软件的正常流程核对官方来源及权限。无法确认来源或系统拒绝执行时，保留提示并联系维护者；不要为了修复关闭杀毒软件或系统保护。
7. 安装结束后重新启动 Cove，确认版本正确、账号和设置仍在；对于已发布清单的新版本，再运行安装文件检查。2.0.2 可以按上述方法覆盖安装，但不会因此获得不存在的在线完整性清单。

这是对当前安装器配置和源码行为的说明。本次验证没有运行真实安装器，也没有破坏真实安装来演示修复。

## 清单与发布约定

安装目录随附 `resources/cove-integrity.json`，发布附件为 `Cove-Integrity-<version>-win32-x64.json`。两份 JSON 字节相同，格式为：

```json
{
  "schemaVersion": 1,
  "version": "<精确发布版本>",
  "platform": "win32",
  "arch": "x64",
  "files": [
    { "path": "resources/app.asar", "size": 123, "sha256": "<64位小写十六进制>" }
  ]
}
```

`path` 是相对安装根目录的 POSIX 路径。清单覆盖 Electron 运行时、`Cove.exe`、`app.asar`、本地原生包和程序 helpers，包括 NSIS 的 `resources/elevate.exe`。清单本身不参与自哈希；安装时产生的卸载器、快捷方式和用户运行数据不在版本清单中。生成器拒绝越界路径、Windows 保留名称、符号链接、junction、硬链接及大小写重复路径，并通过已审核的 payload 位置防止数据混入。

本地随包清单不能自行证明来源。在线检查须先从官方 GitHub HTTPS Release API 取得精确附件的 `digest`，验证下载的清单后才能据其检查程序文件。发布工作流上传原来的五个附件和新的完整性清单，并核对官方 API 的 SHA-256 digest；云镜像脚本仍支持只有五个附件的历史版本，有新清单时才增加该附件的哈希校验、上传和公开 HEAD 检查。

## 打包 hook 的维护边界

桌面端固定使用 **electron-builder 26.15.3**，不使用根工作区旧版 Builder 的源码来推断此行为。已核对该版本 `app-builder-lib` 的实际实现：

- `out/platformPackager.js` 的 `doSignAfterPack` 等待 `signApp` 后执行并等待 `afterSign`；常规 Windows 构建即使没有证书也会进入该 hook。
- 默认 NSIS 的 `out/targets/nsis/nsisUtil.js` 在 `AppPackageHelper.packArch` 中先执行 `elevateHelper.copy`，再调用 `buildAppPackage` 归档。`CopyElevateHelper.copy` 会复制并按原配置签名 `resources/elevate.exe`，并按 `appOutDir` 缓存 Promise。
- 本项目的 `afterSign` 在检查写入路径后，提前等待**同一个 target 的同一个缓存 helper**，再生成清单。随后 NSIS 归档复用该 Promise，不会重新复制或签名这个文件。`app-update.yml` 已在 `PublishManager` 的 `afterPack` 阶段写入；卸载器在安装时另行写入，不属于这份 payload。
- 如果禁用整个签名阶段、设置 `signAndEditExecutable:false` 或直接使用 `prepackaged`，Builder 可能不执行 `afterSign`。正式发布必须使用正常 Windows x64 NSIS 构建，并要求本次构建生成的清单附件存在；不能拿历史输出凑齐附件。

上述缓存对象属于 Builder 内部 API。升级 Builder、Electron、NSIS 配置、签名流程或新增资源时，必须重新核对 hook 顺序、后续 payload 写入及允许的文件名，并更新 fixture。不能仅把缺失文件从清单排除来让检查通过。

当前默认 NSIS 的同版本覆盖行为也已核对：`templates/nsis/multiUser.nsh` 沿用原安装路径；`include/installUtil.nsh` 给旧卸载器传递 `--updated` 和 `/KEEP_APP_DATA`；`uninstaller.nsh` 默认不删除 APPDATA。若以后启用自定义安装/卸载脚本或修改数据清理选项，应重新验证本说明中的数据保留结论。

隔离验证使用临时 Electron 风格目录和合成 PE 头，不操作真实安装。清单 fixture 可运行 `node apps/desktop/tests/installation-integrity-manifest.test.cjs`；完整功能测试入口为 `npm run test:installation-integrity -w cove-client`。
