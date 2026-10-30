# 原生帧节奏候选与场景验证（2026-10-30）

本次承接 `frame-pacing-20261030.md`，在独立 `codex/native-pacing-fix` 分支进行，不改编码、码率、画质、自适应策略或 GPU credit 条件。原用户测试分支 `9176dd3` 保留。

## 仪器与场景

设计见 `../architecture/native-frame-pacing.md`。同源 helper 的 timeout/poll 构建都通过 332 项 CPU self-test；报告携带实际选中模式、源码和二进制 SHA256。实际主屏 2560×1600@240Hz，1080 高档位保留宽高比，轨道是 1728×1080。

全产品测试使用实际 App、200 条测试聊天、隔离双客户端/本机 SFU，静音合成音轨、统计面板开启。四个名义 48 秒阶段：持续高动态、保持主窗口可见时切两个小测试窗口、两个不透明测试窗口遮挡主窗口并切换、恢复主窗口。切换过程保留在连续 LOW 窗口里；另取每阶段后 15 个快照，并校验历史跨度没有跨过阶段边界。实际时长以记录为准。rAF 只证明源绘制计数，不能当作物理扫描帧率。

## 发现并排除的评测干扰

- `pacing-timeout-query-a-sz21dl`、`pacing-timeout-query-b-8zFehs`：接收画面颜色/序列校验失败。实际截图显示浏览器覆盖了受控源；两轮均无效，资源清理通过。
- `pacing-timeout-query-c-CB4rVQ`：193 个样本、四阶段，内容校验通过，但末尾编码分辨率降至 384×240，整体验收失败。23926 个传输帧全部归还，清理通过。
- 更重要的是，延长场景使结果 JSON 增至 16,895,388 字节，而旧短时工具每秒同步序列化并重写完整结果。`mainStages.save.totalMs` 四阶段中位分别 15.736、41.603、64.631、91.329ms，末尾最大 108.915ms。主进程本身负责纹理导入和 credit 回传，不能把这些长阻塞归因于产品后台策略。
- 上述受干扰轮次最慢交付事件是 noSlot，GPU wait 约 1–2ms；它证明等待路径，不能单独证明是谁延迟了释放。已要求长场景测量期间只保留有界内存样本，结束/失败后才写完整结果，再重新建立基线。

所有失败数据保留在本分支 `runtime/fps-validation-full-ui-20261029/`，不计为性能提升或 1080p120 验收。原先真实用户会话里 acquire timeout 平均 11.4ms 的证据来自另一条独立观察路径，不由本次长场景保存行为产生。

## 无完整结果保存干扰的对照

下表是各阶段末 15 个、历史边界已校验的滚动原生 LOW 快照中位数。它们互相重叠，不是独立实验的置信区间；初始带宽收敛曾降低编码分辨率，三轮整体 1080p120 验收都未通过。不能只凭下面原生数值声称观看体验已达标。

| helper / 后台策略 | 高动态可见 | 切窗口且主窗可见 | 遮挡主窗并切换 | 恢复主窗 |
| --- | ---: | ---: | ---: | ---: |
| timeout/query，原策略 `clean-9kAquJ` | 54.16 | 37.91 | 34.61 | 33.09 |
| 同 helper，仅采集期间取消后台节流 `active-ghFBzU` | 55.52 | 29.03 | 36.01 | 40.06 |
| poll/query，原策略 `b-AV4AFA` | 52.46 | 56.90 | 71.82 | 81.03 |
| poll/fence，原策略 `ojzQbo` | 50.20 | 88.50 | 86.72 | 85.22 |
| poll/fence，GPU 快照 `b-n4qLrM` | 77.23 | 80.47 | 77.68 | 98.53 |

后台活动策略没有显示稳定收益，不启用为默认行为。poll/query 后三个阶段 helper 为约 120.05 / 119.68 / 119.92fps，进入编码器与编码约 117–119fps；但单轮结果受启动收敛和负载变化影响，仍须与 fence、后续重复场景核对，不能把全部差异归因于 acquire 参数。

fence 与 GPU 快照实际对照也都完成 193 个样本并通过资源清理，仍因启动阶段编码自适应降分辨率未通过整轮档位约束。快照没有一致优于原 Generator，因此仍显式 opt-in；活动 lease 同样默认关闭。选用的默认原生候选是 poll + Auto completion + 原 Generator。Auto 在本机实际选择 fence；不支持的设备只有 CPU 注入式 fallback 覆盖，尚无第二种 GPU 的实机验收。

另一次 `pacing-poll-query-clean-lAQAMh` 因显示诊断面板契约未成立而在采样前停止，不计性能结果。它在媒体启动后的 GPU 信息中证实 RTX4060 / ANGLE D3D11、硬件加速和 GPU 合成已启用；创建窗口前的 `disabled_software` 状态不能当作实际软件回退结论。`video_encode: enabled` 也不单独证明某条 AV1 流使用硬件编码器。后续保留有界失败上下文，并恢复与原基线相同的 GPU 信息采样控制。

## 纹理所有权解耦试验

显式 `gpu-snapshot` 候选使用私有 OffscreenCanvas 绘制并构造 canvas 自有 VideoFrame，维持一次写入加一个最新原生待处理输入。没有 Canvas track、TrackProcessor、CPU copyTo、额外 consumer 或本机纹理池扩容。原始时间戳保留；原生回调在快照建立后结束，GPU 槽位仍必须等待 Electron `allReferencesReleased` 等全部条件。

该方案针对外来共享纹理被下游长期持有的问题，但增加了 canvas 路径与潜在 GPU 复制/资源开销。平台可采用引用计数和延迟绘制，不能把 JS 快照完成等同于 GPU 读完，也不能把本地队列有界等同于浏览器内部 GPU 资源有界。默认仍是原 Generator，需同时检查真实写入、编码、解码、内容校验和资源回收，再决定是否采用。

## 最终默认构建复测

最终 helper 源码 SHA256 `83cff981dae11f0d50b0f91ee3ff60e3d0af7dbab814a5d188e59000ec6bbdd5`，helper SHA256 `ea26ada9ab0a54640bf03bb891da5aa14a1b9a341d9b76849da09c8a2b8dca94`。默认构建省略 acquire/completion 参数，实际报告为 poll/fence；显式 timeout/query 控制仍保留。

- `runtime/fps-validation-auto-core-20261030/auto-core-1080-MtiGgc/result.json`：真实双端 WebRTC/SFU 核心验证通过。30 秒预热后采样 12.429 秒，实际采集/编码/解码尺寸保持 1728×1080、AV1；helper 119.920、编码 119.00、解码 118.90fps。5106 帧全部归还、资源清理通过。该场景是原有移动条，不等同于下面的持续高动态全产品场景。
- `runtime/fps-validation-full-ui-20261029/pacing-final-auto-d-3cf1r5/result.json`：全产品四阶段完整采样 193 点，阶段实际时长约 49.157 / 48.849 / 48.790 / 48.892 秒。30 秒预热不同于前面 5 秒对照，不作严格因果差值。原生 LOW 稳态快照中位数 94.47 / 73.01 / 70.99 / 90.20；helper 120.00 / 119.76 / 119.86 / 119.97，编码 119.39 / 117.85 / 118.25 / 119.18，解码 119.41 / 117.78 / 118.18 / 119.25fps。画面/连续会话/资源清理通过，**整轮档位验收失败**：曾短暂编码为 1152×720。采集轨道仍是 1728×1080；没有为使检查通过而取消自适应或提高码率。
- `runtime/fps-validation-auto-core-20261030/auto-lifecycle-ST4bj3/result.json`：实际生命周期通过，7 个 native session 启动/结束，5554 帧全部归还。覆盖冻结源后重新观看、三轮 720p60↔540p120、仅终止自建 helper、用户意图下重新发布 stock。合成语音会话与接收进度保持。额外步骤实际约 9.468 秒，加上预热/12秒采样，并非长通话。DWM 在冻结源期间仍持续 present，`idleRefreshBranchObserved=false` 原样保留，不能声称实机覆盖了无 present 的 refresh 分支。

最终自动选择验证曾有三次未通过，均保留：`pacing-final-auto-boosi6` 在媒体启动前因 TCP/UDP 保留端口交集失败；`...-b-wml7uG` 被外部窗口遮挡，内容校验失败但清理通过；`...-c-*` 前台操作后共享端失焦，0 个性能样本，renderer 清理操作超时，整轮清理未通过。最后一轮使用独立的最新窗口状态激活共享端，未放宽任何原有焦点、内容或清理条件。前述失败不计通过。

测试端口分配保持 32 次上限：先取 8 次 OS 候选，再在允许的用户端口范围分散候选；每次都实际探测 loopback TCP/UDP，关闭两边 socket，并保证 SFU base+200 不越界。没有更改系统端口保留区、防火墙或 VPN。临时环境断连后先核对原命令结果再继续。

CPU 数据是源绘制、发送端、接收端及 Electron GPU 进程的总量，不能解释成单个采集器的 CPU 占用或固定节省比例。原生 LOW 是交付节奏；预览存在不完整覆盖窗口，不能据此宣称远端呈现 LOW 与原生数值相同。

## 验证与回滚

本地 CPU 回归已覆盖原生采集生命周期、writer/释放/取消、1% LOW、屏幕发布/PiP 与诊断；诊断 getter 闭包另有 4 项回归，历史配置不再总是初始值。快照队列 17 项及入口集成回归覆盖取消、超时、真正写入结束前不得关闭输出、一次性清理和旧回调。最终原生套件 441 + preload/ACK 32 项、屏幕发布/PiP 103 项、诊断 44 项，共 620 项通过；C++ 两种新构建各通过 382 项 CPU self-test。桌面生产渲染构建、桌面与 Electron 类型检查通过。独立只读审阅未发现阻塞性问题。没有实测另一种 GPU、物理换显示器或长时间真实游戏，不能承诺零回归。

当前修改不包含版本号、更新清单或发布配置。回滚到 `9176dd3` 可移除本轮改动；原测试工作树与旧二进制保留。未通过实际对照的候选不得当作可发布的性能修复。

本机开发入口为本工作树 `runtime/launch-default-pacing.ps1`，内部运行 `npm run dev -- --client --electron`，只启客户端，复用原独立测试数据与 55173 renderer 端口，启动前校验 helper/bridge。Generator 为默认，未打开快照/活动实验。正常主窗口行为沿用原实现。快速回滚优先关闭本测试客户端后使用保留的 `Cove-frame-stability-metrics/runtime/run-interactive-qualified.ps1`；源码回滚须同时选回相应已校验 helper，不能只改 TypeScript 而继续用新二进制。显式 query 可单独诊断 fence，构建 `--acquire-mode timeout` 可诊断取帧方式。正式客户端与线上服务没有更新。
