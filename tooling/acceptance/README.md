# Windows 验收包工具

此目录只生成本地便携测试包，不安装、不签名、不发布。正式 Electron
入口不变。最终打包要求工作区干净，并在结束前复查提交与工作区，防止
混入另一轮改动。最终产物必须在共享包已从同一提交构建后生成。

```powershell
# 前置探测：物理复制现有依赖与运行时，只验证原生模块；不是可交付包
node tooling/package-acceptance-windows.cjs --prepare-only
# 源码冻结、共享包构建完成后：编译、隐藏冒烟、ZIP、文件清单和 SHA-256
node tooling/package-acceptance-windows.cjs
```

所有输出位于 `runtime/acceptance-20261023/artifacts/`。每次前置探测创建
独立 `_prepare-*` 短目录；最终目录使用提交短号，不覆盖旧产物。

- 桌面：物理复制 Electron 44，独立 EXE、产品名和 appId。验收入口先将
  `appData`、`userData`、`sessionData`、临时目录、日志和崩溃目录移到包内，
  再使用已有 `network-lab` 分支禁用自动更新及安装修复。默认服务为
  `http://127.0.0.1:33991`，请求只允许本机或私有 IPv4/localhost。
- 服务端：物理复制本机已验证、签名有效的 Node 24.11.1 / ABI 137，配套
  SQLite、mediasoup worker、FFmpeg 及生产依赖，不使用 Electron 29 托盘，
  不重建借用依赖。Node 许可证来自其官方 GitHub 标签。
- 默认 HTTP 与媒体均只监听回环，媒体端口 41990。手机 LAN 验收必须显式
  将 Server 配置 `listenHost` 改为 `0.0.0.0`、`announceAddress` 改为电脑
  的私有 IPv4。工具不修改防火墙。测试服务端关闭服务器口令门禁，仍需
  创建独立测试账号；不要导入正式配置、数据库或凭据。
- `--acceptance-runtime-check` 仅验证打包 Electron、目录隔离和主进程依赖，
  不开窗口或采集。`--acceptance-smoke` 是隐藏的真实构建页面冒烟，禁用
  网络与采集。二者不代表真实麦克风、屏幕共享或远控验收。
- 最终 ZIP 不包含探测产生的 profile。清单记录源码提交、运行时、版本与
  依赖，`file-hashes.json` 记录包内文件，ZIP 旁提供 SHA-256。

回滚：关闭本轮测试进程，继续使用原正式应用；便携包和包内数据可单独
归档或删除。此包无卸载器，也不能作为正式版安装升级。

实现依据：[Electron 手工打包](https://www.electronjs.org/docs/latest/tutorial/application-distribution)、
[Electron app 路径 API](https://www.electronjs.org/docs/latest/api/app)、
[Node 24.11.1 官方运行时](https://nodejs.org/en/blog/release/v24.11.1)。
