# 原生共享帧节奏

## 边界与测量

原生屏幕路径依次为 DXGI duplication → GPU 缩放/拷贝 → GPU 完成屏障 → 三槽共享纹理 → Electron GPU 导入 → renderer writer → 现有 WebRTC。编码、码率、画质和媒体会话协议不属于本次修改范围。

原生交付时间继续使用 GPU 完成后的真实 `slot.sentAt`，1% low 继续使用最近 30 秒实际帧间隔。首帧建立基线，不计启动等待；换统计报告不重置交付基线。缺新 present 时不复制画面充数。屏幕宽高比保持原样：本机 2560×1600 的 1080 高档位是 1728×1080。

## 诊断与候选

用同一份 helper 源码分别构建原有 timeout 与非阻塞 poll acquire，并对照 query/fence 完成模式。当前候选默认是 poll + Auto：启动时优先构造 fence，只在可选接口/构造失败且设备健康时回退 query。显式 `--completion query` 和 `--completion fence` 保持原语义；运行中的 GPU 失败不会切换屏障。不能把请求 1ms 的 DXGI timeout 当作实际只花 1ms。

`ReadinessWindow` 管有界取帧等待，`selectCompletion` 管启动选择，`GpuCompletion.complete` 管实际完成屏障。构造 fence 的局部资源先全部完成再提交；失败时先清理、核对设备、再构造 query。设备移除、显式 fence 失败和运行时完成失败继续终止该原生尝试。实际选中的模式在构造成功后才进入诊断。

原有 Generator writer 仍为默认。`gpu-snapshot` 和 renderer activity lease 仅供显式对照，均未显示足够一致的收益，不自动启用。UI、编码与 SFU 协议没有新增策略。

开启既有原生 timing 诊断时，额外记录累计交付间隔直方图与每份报告最慢的至多八个间隔。七个区间为 `<1T`、`<1.1T`、`<1.25T`、`<1.5T`、`<2T`、`<4T`、其余；T 是目标帧周期。候选阈值为 gap 大于 `floor(1.1T)`。

每个示例只含捕获内相对时间、真实间隔、当前 tick 迟到、两次交付间累计 acquire/timeout/GPU wait/draw、noPresent/noSlot/missedTicks/sourcePresents 与 refresh 布尔值。阶段计时可能重叠，不能直接相加当作排他的因果分解。没有源名称、句柄、画面、账号、token、SDP 或墙钟时间。

helper 使用固定容量记录、每秒输出；main 合并五秒内所有报告的八个最慢示例，避免只保留最后一秒。重复/迟到报告不回放，换捕获清空示例。沿用 16KiB 行限制与 main 最多十分钟/120条输出的观察预算；到限只停止观察。诊断关闭时不新增逐帧时钟读数。

tail 的可选 `slotCreditWaitUs` 记录相邻真实交付间已经结算的槽位等待累计差值。期限内等到槽位时，`noSlot` 可以为零；不能据此把该间隔归因于 GPU。旧 helper 缺少该字段时保持未知，不补零。阶段时间可以重叠，不相加为独占耗时。

## 逐帧分配与释放许可

同一 session 的健康检查使用 Node `Timeout.refresh()` 续期，保持最后一帧后五秒的截止语义；退出仍清除并置空定时器。每个纹理的传输、引用和超时保护独立保留。

preload 在 listener 前注册释放许可。许可与写入并行；listener 完成时许可已到达，就直接进入原有释放屏障，不再构造一个已完成的 Promise 或额外等待一个微任务。若许可未到达，才构造等待 Promise。1500ms 超时仍从接收时开始，包含 listener 尚未完成的情况；不因许可先到就提前清除。真正槽位归还仍由 main 的完整 credit 条件与 Electron `allReferencesReleased` 决定。

## 不可改变的安全约束

- GPU query/fence 完成后才允许交付；不提前释放 shared texture credit。
- 维持三槽与现有 writer 有界队列，不靠扩大队列掩盖停顿。
- stop、owner 退出、取消、GPU 超时和旧代次隔离继续优先；不改系统定时器、进程优先级或全局 Chromium 安全设置。
- 不因采样而另开媒体 consumer、TrackProcessor 或逐帧读回。

## 验证场景

同一 native producer 中运行持续高动态源、两个测试窗口切换、publisher 可见/被遮挡，再恢复可见；包含切换时刻的长间隔。每阶段分别报告完整过渡数据与窗口完全落入该阶段的 30 秒 LOW，不能把剔除过渡后的数值当作切换稳定性。

对照固定实际尺寸、编码、帧率、音频与统计开关；核对源动画计数、实际捕获内容标记、编码/解码增量和资源清理。rAF 计数不等于物理扫描输出。后台节流与 GPU 高动态负载是待实测的独立假设，不预先认定原因。

CPU 回归覆盖统计边界、跨报告间隔、异常数值/脱敏、有界输出、旧报告与捕获取代；真实双端测试验证共享仍可用和资源回收。结果与最终默认选择写入诊断报告。
