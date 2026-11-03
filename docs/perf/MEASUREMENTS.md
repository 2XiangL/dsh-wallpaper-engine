# 资源占用实测账本

> 配合 [`RESOURCE-OPTIMIZATION.md`](./RESOURCE-OPTIMIZATION.md) 读。这里只放**可复算的原始数字**：
> 每条记录 = 机位 + 配置 + 相位 + 数字 + 采集命令 + 原始 JSON 位置。
> 规矩：**没有原始 JSON 的数字不进这张表**（"看着像"的数字不写）。

## 采集方法

- 工具：`test/tools/perf-bench.ps1`（进程树相位采样，schema `dsh-we-perf-bench/2`）、`test/tools/glass-perf-rig.mjs`（真 Chromium 玻璃配方对照）。
- 口径（**v2 起是五维**；v1 的三维口径见下方各条的历史记录，跨版本不要直接相减）：
  - **CPU（进程）** = `Process.TotalProcessorTime` 前后差分 ÷ 墙钟 ÷ 单核（`cpu_pct_core`）。墙钟只包住"读计数器"那一段（Stopwatch），不把采样自身的 WMI 开销算进分母 —— v1 曾把 300ms 的 `GPUEngine` 查询算进去，使 CPU% 系统性低估 1.6–2.3%。
  - **CPU（线程）** = .NET `Process.Threads` 的 `TotalProcessorTime` 差分；**主线程 = 最早创建且与进程 `StartTime` 差 ≤250ms 的那个线程**（`idx==0` 只作旁证）。另报 `cpu_thread_residual_ms = 进程差 − Σ线程差`：残差大就是"有线程没被观测到"，不静默丢。**不要**用 WMI 的 `PerfProc_Thread`：实测单次 1.9s(raw) / 4.0s(formatted)，它枚举全系统线程。
  - **内存** = `WorkingSetPrivate`（私有 WS）为头号口径（可归因、跨构建可比）；`WorkingSet64` 保留但标 `double_counts_shared`（本机树内共享页被重复计 ≈300MB）。
  - **显存** = `GPUProcessMemory` 的 `TotalCommitted`（同 pid 多 luid 求和，`^pid_(\d+)_` 整数锚定）。⚠️ **进程间重叠，不能加总成"总显存"**；iGPU 上它就是系统内存。`TotalCommitted ≠ dedicated+shared`（本机 28/33 实例如此）⇒ 只报不推导。
  - **磁盘 I/O** = `PerfRawData_PerfProc_Process` 的 `IOReadBytesPersec/IOWriteBytesPersec` —— 注意 **Raw 类里这些名字是累计字节**。它是**进程所有句柄的逻辑 I/O**：含页缓存命中、含管道/socket（Chromium 的 mojo IPC）、不含 mmap/分页。**无法**用它区分真磁盘与页缓存，只能做同机 A/B 相对量（实测 renderer 生命周期写 4.6GB 而物理盘空闲 ⇒ 那是 IPC）。
  - **GPU 3D** = `GPUEngine` 的 **raw** `RunningTime` 差分（`engtype_3D` **与** `High Priority 3D` 都计入），按 pid 锚定、时间加权求均值。
  - 每相位先预热（着色器编译 / 首帧 JIT / 遮挡跟踪收敛窗）；v2 是"等状态信号 + 上限"（`converge_ms` 入账），不是盲等。
  - 相位状态落成可复核字段：`iconic_*` / `zoomed_end`（DPI 无关的最大化判据）/ `fg_is_main_*` / `fg_forced_ok` / `cover_focus_ok` / `cover_area_frac`，外加 diag JSONL 窗口里的 `play-state`（`playing=` / `hold=`）与 `onscreen`（`leaf=VIDEO|IMG`）。⚠️ `beat` 每 60s 一行、`activity` **只在"诊断详读"打开时才写** ⇒ 断言不依赖它们。
  - 采集期间**不要并发跑其它重活**（v1 第一条记录就踩过：同一次运行里我在写文件，visible 被抬到 109% 单核）。
- 原始 JSON 落在 `.test-cache/perf/`（`.gitignore` 已排除），按 `label-timestamp.json` 存。

## 记录

> ⚠️ **2026-11-03 之后的可比性**：表中 `covered` / `partial-cover` 两档的"暂停"读数是**撤除遮挡代理之前**
> 的结果（代理 = 单屏 + 满屏 + 失焦 ≥1.5s）。代理已删 ⇒ 这两档今后量到的是"不暂停"（与 visible 同量级）。
> 需要"看不见时归零"的证据时，改看 `minimized`（`pauseOnHidden` 仍是原实现）与后续的锁屏/挂起档。

### 2026-11-03 13:36 / 13:40 · 配方瘦身**之后**（`p1-after` / `p1-after-b`，各 3×60s）

同一个量具（schema /2）、同一台机、同一张视频壁纸；两次运行间隔 4 分钟，用于看"同一构建下 3 次重复"的
离散度（B1 要求的可复算性自检）。命令：`-Phases visible -Seconds 60 -Warmup 10 -Repeat 3`。

| 批次 | 序 | renderer 主线程% | renderer 工作线程% | renderer 私有 WS | GPU 3D% | GPU 进程显存 |
|---|---:|---:|---:|---:|---:|---:|
| p1-after | 1 | 24.88 | 13.02 | 517.6 MB | 14.63 | 246.4 MB |
| p1-after | 2 | 21.62 | 13.93 | 485.1 MB | 14.26 | 245.4 MB |
| p1-after | 3 | 18.66 | 12.23 | 462.8 MB | 13.81 | 243.1 MB |
| p1-after-b | 1 | 19.47 | 13.11 | 499.4 MB | — | — |
| p1-after-b | 2 | 19.04 | 13.14 | 466.0 MB | — | — |
| p1-after-b | 3 | 17.14 | 11.62 | 460.5 MB | — | — |

**怎么读（重要，别当成干净 A/B）**：

- 与 `p1-before` 的单次 37.38 相比，主线程降幅很大（中位 ≈19.3，区间 17.1–24.9）；GPU 3D 也从 16.76
  降到 13.8–14.6。**方向与量级都指向"每帧少一段全区域滤镜"确实省**。
- 但两侧不对称：before 侧只有 **1 次**，而且**第一次跑就偏高**（同一批里 24.88 → 18.66 单调下降，
  两次批次都呈现"首轮偏高"）⇒ 37.38 里混着热机/会话状态，不能把 37.38→19.3 直接读成"−48%"。
- 另一处不可比：GPU 进程显存从 180.4 升到 243–246 MB（重启后玻璃面数量/会话内容不同），
  所以这三档的量不能互相抵扣。
- 结论只到这一句：**改造后无回归、且很可能显著改善；精确百分比要"同协议各 3×2 轮 + 首轮丢弃"的
  受控对照**（需把旧包换回去再重启一次，见 RESOURCE-OPTIMIZATION §10.4）。

### 2026-11-03 13:19 · 五维基线（`p1-before`）：本批改造**之前**的五个相位

运行中的 DSH 此刻装的仍是**改造前**的玻璃包（工作区已改、profile 未换 ⇒ 这一轮是"before"档），
壁纸 = 视频 `1080-example.mp4`、`glassMotionMode=auto`、`blur=9`、`leftSidebarGlass/sidebarGlass` 均开。
命令：`pwsh -NoProfile -File test/tools/perf-bench.ps1 -Phases visible,covered,minimized,partial-cover,unfocused-visible -Label p1-before -Warmup 10`

| 相位 | renderer 主线程% | renderer 工作线程% | renderer 私有 WS | GPU 进程 主线程% | GPU 进程 工作线程% | GPU 3D% | GPU 进程显存 | GPU 进程私有 WS | host 私有 WS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| visible | **37.38** | 16.63 | 592.3 MB | 17.56 | 18.43 | 16.76 | 180.4 MB | 60.8 MB | 229.6 MB |
| covered | 31.70 | 10.70 | 623.9 MB | 16.03 | 18.44 | 16.81 | 195.7 MB | 61.4 MB | 228.3 MB |
| minimized | **0.99** | 0.53 | 324.9 MB | 0 | 0 | 0 | 171.6 MB | 59.5 MB | 169.4 MB |
| partial-cover | 23.81 | 11.24 | 334.9 MB | 13.13 | 14.90 | 18.45 | 202.5 MB | 60.9 MB | 169.3 MB |
| unfocused-visible | 21.82 | 12.03 | 335.5 MB | 12.69 | 14.33 | 16.96 | 203.8 MB | 60.9 MB | 157.6 MB |

状态事实（同一轮 diag/窗口字段）：`minimized` = `hold=标签页隐藏(pauseOnHidden)`、playing=false；
`partial-cover` = `hold=窗口被覆盖(pauseOnCovered)`、playing=false；`unfocused-visible` = playing=true（无 hold）；
`covered` 这一轮**没有记到任何 play-state 转换行**（见下面的"未解释"）。

五条读法：

1. **renderer 的开销压在主线程上**（visible 37.4 vs 工作线程 16.6）—— 与本批静态审计的结论一致：
   插件在这条路径上**没有任何按视频帧运行的 JS**（0 处 `timeupdate`、无每帧 DOM 写），
   主线程那段是 Blink 的 paint/layerize/commit（玻璃面逐帧重采样 backdrop 的后果）。
2. **暂停链路有效**：minimized 掉到 0.99 单核%、GPU 3D 归零，且私有 WS 从 592 → 325 MB。
   即"播放态比暂停态多 ≈267 MB"，那部分是视频解码池 + 玻璃 render surface 池。
3. **`pauseOnCovered` 在"部分遮挡"下也会触发**：它的条件是「单屏 + 本窗铺满可用区 ≥98% + 失焦 ≥1.5s」，
   与**真实覆盖率无关** ⇒ 最大化窗口被盖住 60% 时照样暂停。这既是省电（看不见的那部分不画），
   也是一条产品语义风险（用户以为壁纸在动，其实停着）——是否收紧留给下一批决定。
4. **covered 与 partial-cover 的差**不能当成"遮挡成本"：两者装置不同（covered 是整屏遮挡窗、
   partial 是 60% 遮挡窗），且 covered 这轮没记到 hold 行 ⇒ 那一档要么没触发暂停、要么暂停发生在
   diag 窗口之外。v2 已补 `cover_focus_ok`（遮挡窗是否真抢到焦点）用来区分"策略失效"与"装置没摆成功"。
5. **I/O 数只作相对量**：visible 的 renderer 写 167 MB/60s、GPU 进程读 166 MB/60s —— 这是视频数据
   在 Chromium 内部的 mojo/IPC 传输，**不是磁盘**（口径见"采集方法"）。

未解释/待补：`covered` 缺 hold 行；系统级 `PerfDisk` 反证尚未接入 v2（下一版）。


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
