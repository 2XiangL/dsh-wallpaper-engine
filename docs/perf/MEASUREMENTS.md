# 资源占用实测账本

> 配合 [`RESOURCE-OPTIMIZATION.md`](./RESOURCE-OPTIMIZATION.md) 读。这里只放**可复算的原始数字**：
> 每条记录 = 机位 + 配置 + 相位 + 数字 + 采集命令 + 原始 JSON 位置。
> 规矩：**没有原始 JSON 的数字不进这张表**（"看着像"的数字不写）。

## 采集方法

- 工具：`test/tools/perf-bench.ps1`（进程树相位采样）、`test/tools/glass-perf-rig.mjs`（真 Chromium 玻璃配方对照）。
- 口径：
  - CPU = `TotalProcessorTime` 前后差分 ÷ 墙钟 ÷ **单核**（`cpu_core%`；>100% 表示多线程并行）。另给全核口径便于跨机器比较。
  - 内存 = `WorkingSet64` 的**相位末值**（工作集回收是延迟发生的，均值会掩盖它）。
  - GPU = `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` 的 `engtype_3D` 按 pid 精确切分、采样期均值。
  - 每相位先 `-Warmup` 秒预热（着色器编译 / 首帧 JIT / 遮挡跟踪 2–3s 收敛窗）。
  - 相位状态必须落成可复核字段：`main_iconic_start/end`、`fg_is_main`、`cover_style` —— 一次 `ShowWindow` 被忽略就会把整相位量成假的。
  - 采集期间**不要并发跑其它重活**（本表第一条记录就踩过：同一次运行里我在写文件，visible 档读数被抬到 109% 单核）。
- 原始 JSON 落在 `.test-cache/perf/`（`*.gitignore` 已排除），按 `label-timestamp.json` 存。

## 记录

### 2026-11-03 · 改造前基线（`baseline-clean2`）

| 项 | 值 |
|---|---|
| 机位 | Intel/AMD 平台，16 逻辑核，Windows 11 |
| GPU | AMD Radeon (TM) Graphics（核显，驱动见 `Win32_VideoController`） |
| 显示 | 单显示器 1920×1080 @125% 缩放 ⇒ CSS 视口 1536×864；`screen.isExtended=false` |
| 宿主 | DSH 桌面壳（Electron），profile `desktop` |
| 壁纸 | 视频 `1080-example.mp4`（1920×1080 / 30fps / 59.7s / 32.2MB），`fpsCap=0` |
| 插件 | `dsh-plugin-wallpaper-engine@1.4.0`（改造前），玻璃默认（`blur=9`，`sidebarGlass=on`），`pauseOnHidden=on`、`pauseOnBlur=off`、`pauseOnBattery=off` |
| 窗口 | 1295×823 CSS（浮窗，非最大化） |
| 命令 | `pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label baseline-clean2 -Phases visible,covered,minimized -Warmup 10 -CoverStyle normal` |

| 相位 | 构造 | renderer CPU 单核% | GPU 进程 CPU 单核% | GPU 3D % | renderer WS | 状态字段 |
|---|---|---:|---:|---:|---:|---|
| visible | 还原+置前，界面静止 | 53.29 | 39.62 | 9.72 | 427.3 MB | `fg_is_main=true` |
| covered | 置顶不透明窗盖满虚拟屏（普通顶层窗形态） | 63.20 | 43.48 | 9.21 | 428.5 MB | `fg_is_main=false`、`iconic=false` |
| minimized | `SW_MINIMIZE` | 0.81 | 0.07 | 0.00 | 424.4 MB | `iconic_start=true` |

读法：**covered ≈ visible**（被完全盖住一分钱没省）而 **minimized ≈ 0**（暂停链路本身有效）⇒ 缺口是"遮挡信号没有被采到"，不是"没有省电逻辑"。

### 2026-11-03 · 遮挡窗形态对照（`cover-normal-probe`）

同一份壁纸与窗口，只把遮挡窗从"工具窗（`WS_EX_TOOLWINDOW`）"换成"普通顶层窗"（`-CoverStyle normal`）：

| 遮挡窗形态 | renderer CPU 单核% | GPU 3D % |
|---|---:|---:|
| 工具窗 | 48.6 | 7.21 |
| 普通顶层窗 | 55.3 | 7.44 |

⇒ 两种形态都**没有**触发暂停：本壳的 Chromium 遮挡跟踪不把"被覆盖"判成 `document.hidden`。这条否定了"用现成信号就够了"的捷径，也是遮挡代理存在的理由。

### 2026-11-03 · 玻璃配方微基准（`glass-perf-rig`，改造前配方 vs 候选配方）

机位同上；无头 Chromium（`--headless=new`，GPU 串 `ANGLE (AMD, AMD Radeon (TM) Graphics ..., D3D11)`，**非** SwiftShader）；7 个气泡面 + 1 个输入卡；每块 3s、2 轮交替。

| 背景 | 配方 | fps | p50 | p95 |
|---|---|---:|---:|---:|
| 动画 | full（`blur(16px) saturate(1.8) brightness(1.04) contrast(1.01)`） | 1724.1 | 0.50ms | 0.85ms |
| 动画 | light（`backdrop-filter:none` + 92% 近不透明） | 1946.2 | 0.45ms | 0.80ms |
| 动画 | off（100% 不透明） | 1579.6 | 0.50ms | 0.85ms |
| 静态 | full | 39.0 | 23.70ms | 25.60ms |
| 静态 | light | 38.5 | 23.35ms | 25.30ms |
| 静态 | off | 38.6 | 23.60ms | 25.50ms |

**判读（重要）**：有 vsync 时限帧时两套配方**都是 16.7ms、无可测差异**（第一版装置就是这个结论）；关掉帧率上限后 `light` 比 `full` 高 12.9%，但 `off` 反而最低 —— 说明这个口径量的是**主线程调度**而不是光栅成本，**不能作为决策依据**。结论：玻璃的归因必须靠真机 A/B（停用玻璃行），见主文档 §6.1。

### 2026-11-03 · 可见档成本拆分尝试（失败，记录以免重走）

目的：把 `visible` 的 53% 拆成"动壁纸"与"基础合成"。做法：最大化 DSH 窗口 → 自建小窗抢焦点 → 期望 `pauseOnCovered` 生效、壁纸暂停。

结果：两次尝试都没抢到焦点（`SetForegroundWindow` 被前台锁拒绝；补 `AttachThreadInput` 的补丁未编译通过），读数反而从 30.5% 升到 42.2%（抢来的置顶小窗本身增加了合成）。**判为失败实验**，不再投入；改用"停用玻璃行"的 A/B（需要重启宿主），步骤写进主文档 §9。

### 2026-11-03 11:55 · 改造后 + **玻璃子包已装**（`after-glass-v1`）

同一台机器、同一张 1080p30 视频壁纸、同一套相位（本轮的 covered 用"最大化 + 遮挡窗抢焦点"，
即真实形态；`pauseOnCovered` 与 `pauseOnHidden` 两条都在场）。

| 相位 | 构造 | renderer CPU 单核% | GPU 进程 CPU 单核% | GPU 3D % | renderer WS |
|---|---|---:|---:|---:|---:|
| visible | 还原+置前，界面静止 | 34.46 | 33.98 | 12.60 | 509.7 MB |
| covered | 最大化 + 顶置不透明窗（抢焦点） | 19.65 | 27.23 | 12.67 | 506.7 MB |
| minimized | `SW_MINIMIZE` | 1.52 | 0.00 | 0.00 | 404.6 MB |

暂停证据（同一轮 diag）：
```
11:54:39  play-state · playing=true  hidden=0 focus=0 window-blur
11:54:42  play-state · playing=false hold=窗口被覆盖(pauseOnCovered) hidden=0 focus=0
11:55:10  play-state · playing=true  hidden=0 focus=1 window-focus
11:55:12  play-state · playing=false hold=标签页隐藏(pauseOnHidden) hidden=1
```
⇒ 遮挡代理在真实形态下**按设计生效**（1.5s 防抖后暂停、回焦点恢复）；最小化走另一条既有的 pauseOnHidden。

### 三组数据怎么比（重要，别直接相减）

| # | 时间 | 构建 | 玻璃 | visible | covered | minimized |
|---|---|---|---:|---:|---:|---:|
| A | 00:10 | **npm 1.4.0**（改造前；玻璃 CSS 内联在主包） | 有 | 53.29 | 63.20 | 0.81 |
| B | 11:30 | 分支构建（本分支把玻璃抽成独立子包） | **无**（子包未装） | 5.93 | 2.89 | 0.30 |
| C | 11:55 | 分支构建 | **有**（子包已装） | 34.46 | 19.65 | 1.52 |

- **B ↔ C 是干净的对照**（同构建、同机、同壁纸，只差玻璃）：可见档 **5.93 → 34.46 单核%**、
  GPU 进程 **8.98 → 33.98**、GPU 3D **4.93 → 12.60**、renderer 工作集 **294.6 → 509.7 MB**。
  即：**液态玻璃这套逐面 `backdrop-filter` 在这台机器上约值 0.28 个核 + 0.22 个 GPU 进程核 + 215 MB 内存**。
  这正是 `glassMotionMode=auto` 要削的那一块。
- **A ↔ C 方向上有改善但不算受控对照**：A 是改造前的旧构建（玻璃内联、且没有本轮的省电改造），
  C 是分支构建；两者之间还差着"玻璃出户 + 本轮改动"，而且 A 那轮的 covered 用的是**不抢焦点**的
  遮挡窗（Chromium 不会判 hidden、代理也不会触发），所以 A 的 63.20 里混着装置自身的失真。
  公平的 A/B 需要把旧构建换回来、用同一版装置再跑一遍（待办）。
- **一条对上一轮结论的更正**：本轮遮挡窗**抢焦点**之后，Chromium 自己就把页面判成了 `hidden`
  （`tab-hidden` 出现在 blur 之后 53ms）⇒ **真实应用盖住 DSH 时，暂停由 pauseOnHidden 兜住**；
  `pauseOnCovered` 是它漏判时的兜底（不抢焦点的工具窗、遮挡跟踪的 2–3s 竞态），本轮实测确实触发。

### 2026-11-03 12:07 · 改造后 + 玻璃 + `glassMotionMode=auto`（`after-glass-auto`）

把「动壁纸时降级气泡玻璃」打开后同一相位的对照（同机、同壁纸 1080p30、同玻璃参数 blur=9）：

| 相位 | 构造 | renderer CPU 单核% | GPU 进程 CPU 单核% | GPU 3D % | renderer WS |
|---|---|---:|---:|---:|---:|
| visible | 还原+置前，界面静止 | 26.22 | 28.85 | 11.38 | 346.4 MB |

对照 `full`（11:55 的 C 组，34.46 / 33.98 / 12.60 / 509.7 MB）：
**渲染 −24%、GPU 进程 −15%、工作集 −163 MB**。差异只来自「壁纸在动时消息气泡族摘霜 + 近不透明底」
（输入卡与侧栏面不动）；静态图片或暂停时自动回到原配方。

⚠️ 可比性：两次测量之间客户端重启过一次 ⇒ 可见玻璃面的数量（对话滚动位置）不完全一致，
不是严格受控；量级可信、小数位不可当精确值。

### 待补（下一批）

- 玻璃行停用 vs 全开的真机 A/B（`visible` 相位，3×60s，取中位）。
- 改造后的同相位复测（`visible` / `covered` / `minimized`），与上面的基线表逐格对照。
- `pauseOnCovered` 生效验证：单屏 + 最大化 + 失焦 ⇒ 渲染进程应从 ~53% 掉到 ≤5% 单核。
