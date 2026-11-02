# 资源占用优化：调研、改造与验收

> 本文回答一个问题：**「装上壁纸插件后系统占用显著升高」这件事，能按 dynapaper 的做法改到什么程度？**
> 结论、证据、已实施项与未实施项都在这里；实测数字的原始记录见 [`MEASUREMENTS.md`](./MEASUREMENTS.md)。
>
> 写作口径（本仓 ADR-0017）：**会漂的数值不抄**，一律给复算方式或指向唯一真源。

## 0. 结论（先看这段）

1. **可行，但收益不来自"照搬 dynapaper 的写法"**。dynapaper 的收益主体是「不可见即零开销 + 事件驱动 + 动态排程 + 活动计数」；本插件里前三条**各有一半已经在做**，缺的是最后一环：**"看不见"这个信号在 Windows/Electron 侧根本没有被采到**。
2. **改造前实测（单屏 / AMD 核显 / 1080p30 视频壁纸 / 玻璃默认）**：窗口被顶置不透明窗**完全盖住**时，渲染进程仍占 **63% 单核**、GPU 进程 **43% 单核**——与"可见"档几乎一样；而**最小化**时两者都掉到 ≈0。也就是说：**它不是"没有省电逻辑"，而是省电逻辑拿不到遮挡信号**（宿主的遮挡 hub 只有 X11 适配器；Chromium 的窗口遮挡跟踪在本壳不把"被覆盖"判成 `hidden`）。
3. **本轮已落地**：遮挡代理（`pauseOnCovered`）、客户端三处轮询按状态启停、宿主三处 IO/定时器治理。全部改动都有机检判据或可复算的观测点，`verify` 100 步 / `smoke` 6 步全绿。
4. **玻璃降级：机制已落地，但默认关**（新设置 `glassMotionMode`，取值 auto / full，默认 full；设置里一键可开、立即生效无需重启）。不默认开的原因是**归因还没坐实**：微基准在 1080p/60fps 下两套配方没有可测差异，而真机 A/B 需要重启宿主才能切玻璃行 —— 在没有对照之前动默认观感，等于拿用户的界面做实验。判据与方法见 §6.1 / §7（B3、C4）。

## 1. 两个项目的资源模型不是一回事

| 维度 | dynapaper（Rust / Win32） | dsh-wallpaper-engine（Electron 渲染进程 + Node 宿主） |
|---|---|---|
| 画面落点 | WorkerW 桌面层（图标之下），DWM 直接合成 | 页面内全屏 `<video>` / WebGL iframe，与整个对话 UI 一起合成 |
| 解码 | Media Foundation 硬解，交换链零拷贝直写后缓冲 | Chromium 媒体管线；滤镜 identity 时已回落 `none`（`src/effects.js` 的 `--we-media-filter`） |
| 不可见时 | 覆盖率 ≥98% / 熄屏 / 锁屏 / 电池节能 ⇒ 停解码，功耗≈0 | `document.hidden`（最小化有效）+ 失焦/电池档；**"被覆盖"没有信号**（本轮补代理） |
| 帧调度 | 合成节拍 + PTS 门控 + 无新帧指数退避 | `requestVideoFrameCallback` 天然按呈现帧回调；但仍有若干常驻 `setInterval`/rAF |
| 主线程成本 | 只有一个消息循环，空闲 1500ms 等待 | React 对话 UI + 玻璃合成 + 插件定时器共享一个渲染主线程 |
| 度量 | `scripts/bench.ps1` 四相位 + `activity(Ns)` 计数器 | **改造前没有**（本轮补 `perf-bench.ps1` + 客户端 `activity` 行） |

一句话：**同一份"省电"意图，dynapaper 靠操作系统事件驱动，本插件只能靠 Web 侧能自证的代理信号。** 这条差异决定了可转移性（§4）。

## 2. 实测：改造前的开销

机位与配置：单显示器（1920×1080 @125%，CSS 视口 1536×864）、AMD Radeon 核显、16 逻辑核、Windows 11、DSH 桌面壳、壁纸 `1080-example.mp4`（1920×1080 / 30fps / 59.7s）、玻璃默认（`blur=9`～`16`）、窗口 1295×823。原始 JSON 在 `.test-cache/perf/`，复算命令见 §8。

| 相位 | 怎么造 | renderer CPU（单核 %） | GPU 进程 CPU（单核 %） | GPU 3D % | renderer 工作集 |
|---|---|---:|---:|---:|---:|
| `visible` | 窗口还原并置前、界面静止 | **53.3** | 39.6 | 9.7 | 427 MB |
| `covered` | 自建**置顶不透明窗**盖满整个虚拟屏 | **63.2** | 43.5 | 9.2 | 429 MB |
| `minimized` | `ShowWindow(SW_MINIMIZE)` | **0.8** | 0.07 | 0 | 424 MB |

三条读法：

- **`covered` ≈ `visible`（甚至更高）**：被完全盖住时一分钱没省。这是本轮最大的一笔浪费，也是 dynapaper 桌面端"大部分时间 GPU≈0"的对应缺口。
- **`minimized` ≈ 0**：`pauseOnHidden` 这条链路本身是好的 —— 说明缺口不在"暂停逻辑"，而在**触发条件**。
- **可见档 53% 单核**：折算全机 ≈3.3% CPU（16 核）。它在"界面静止、只有壁纸在动"时发生，因此是壁纸相关的可优化空间（但**具体拆分未完成**，见 §6.1）。

对照 dynapaper 自己的实测（同档 1080p30 样片、AMD 核显）：可见渲染 0.29% CPU / 14.5% GPU、遮挡后 0% / 0%。两边的差距主要在"整页合成 + 玻璃重采样"这一层，而不是解码。

## 3. 归因：钱花在哪（带证据）

| # | 项 | 证据 | 状态 |
|---|---|---|---|
| 1 | **被覆盖时不停**：无遮挡信号 | 实测 `covered` 相位（§2）；宿主 hub 只有 X11 适配器（`lib/occlusion/x11.js`）；客户端 `occlusionReason()` 原先只有 hidden/失焦/电池三档 | **本轮已补代理** |
| 2 | **媒体桥 20Hz 轮询**：`setInterval(50)` 每拍 `GET /audio-spectrum`，暂停/隐藏照打 | `src/client-media-frame.js`（改造前 `startMediaSync`） | **已改**：状态闸 + 停链 |
| 3 | **宿主同步读盘 ×20/s**：每个 `/audio-spectrum` 都经 `ensureMedia()` → `readConfig()` → `readFileSync`（无 memo） | `packages/media-bridge/lib/routes/now-playing.js`、`lib/kernel/config.js` | **已改**：mtime+size memo |
| 4 | **Windows 上遮挡轮询纯废**：1Hz `GET /occlusion` + 每拍 `postMessage`，后端恒为 `none` | `src/occlusion.js`、`packages/media-bridge/lib/routes/occlusion.js` | **已改**：1Hz→30s 停车 |
| 5 | **遮挡 hub 装载即启动**：Windows 上 30s 重试永远不成功，且 `retryTimer` 未 unref | `packages/media-bridge/lib/index.js`、`lib/occlusion/index.js` | **已改**：懒启动 + 退避 + unref |
| 6 | **媒体子进程永不空闲**：空闲停止阈值 15min，且 legacy 回落路径**根本没有**空闲逻辑（macOS/Linux 每秒 `execFile`、Windows 常驻 ffmpeg 环回采集） | `packages/media-bridge/lib/supervisor.js`、`legacy.js` | **已改**：90s + legacy 补空闲停 |
| 7 | **诊断落盘每行 open/write/close**（`appendFileSync`） | `lib/diag-trace.js` | **已改**：常驻 fd |
| 8 | **常驻 vsync rAF 探针**：只服务每 5s 一条诊断 | `src/live-layer-watch.js` 的 `startUiFpsProbe` | **已改**：只在诊断详读时跑 |
| 9 | **玻璃逐面 `backdrop-filter` 每帧重采样**：壁纸在动时每个面的 backdrop 每帧都变 | 结构性事实；`packages/glass/src/glass-css.js` 的载体规则 | **未改动**，见 §6.1 |
| 10 | 启动后 3s 的同步目录遍历爆发（7 条 `readdirSync` + 逐文件 `statSync`） | `lib/startup-sweep.js` | 只补 unref，未改形态 |

**已排除的伪问题**（避免白改）：媒体滤镜 identity 已回落 `none`；壁纸层 transform 默认回落 `none`；默认态视差/特效/头像/主题跟随全关、没有常驻无限动画；视频退役已即时 `pause()` + 清 `src`；交叉淡化期保留旧层是产品语义。

## 4. dynapaper 手法 → 本仓裁定

| dynapaper 手法 | 裁定 | 落点 |
|---|---|---|
| 不可见即零开销 | **部分可转移**（完整遮挡/最小化可得；部分遮挡无信号） | 遮挡代理 `pauseOnCovered` + 通知宿主停轮询 |
| 事件驱动而非固定轮询 | **可转移（本轮主体）** | 媒体桥停链、遮挡停车、探针按需 |
| 一次性定时器 + 动态排程 | **可转移** | hub 指数退避；媒体 idle 一次性判定 |
| `activity(Ns)` 计数器 | **可转移（已做）** | 客户端 60s `activity` 行 + `perf-bench.ps1` 相位采样 |
| 四相位基准 + 相对基线 | **可转移（已做）** | `test/tools/perf-bench.ps1` |
| 日志常驻句柄 | **可转移（已做）** | `lib/diag-trace.js` |
| PTS 门控 / 无新帧退避 | **已在等价层实现**（rVFC 按呈现帧回调） | 不改 |
| 覆盖率 ≥98% / 700ms 防抖 | **不可照搬**：本仓"暂停"= 拆页冷重载（实测黑屏 ~2s），现用 1200ms 是正确取舍 | 不改阈值 |
| 工作集 trim / EcoQoS / BelowNormal / `SetCoalescableTimer` / 交换链 / 零拷贝 | **不可转移**（无 Web/Node API；对 Electron 主进程降优先级会拖慢 UI） | 明确不做 |
| 退役播放器保留 10s | **反向**：Web 侧应立即释放（已是现状） | 不改 |

## 5. 本轮已实施

### 5.1 遮挡代理 `pauseOnCovered`（默认开）

**问题**：被其它窗口盖住时完全不省电（§2）。

**为什么不能直接用现成的**：宿主的遮挡 hub 只有 X11 适配器；Chromium 的窗口遮挡跟踪在本壳**不把覆盖判成 `hidden`**（用顶置不透明窗盖满整屏，渲染进程仍占六成单核）。桌面壳的 `pauseOnBlur` 又因"失焦时壁纸多半仍整块可见"被默认关掉。

**做法**：用三个**能自证**的条件合成保守代理 —— ① `screen.isExtended === false`（单屏 ⇒ 抢走焦点的窗口只可能压在本窗之上）；② 本窗铺满可用区 ≥98%（侧边并排天然排除）；③ 失焦**持续** ≥1.5s（拖动/切窗的瞬时抢焦点不触发）。三条同时成立才判"被覆盖"，任一不成立立即恢复；**多显示器一律不判**（另一个 App 可能在另一块屏上、本窗仍整块可见）。

判定并入 `occlusionReason()` **单一判定源**，因此视频 `pause()` 与实时渲染页 `pause()` 都走既有 effective 播放态管线，不需要第二条通路。设置项与「最小化/切页时暂停」并列在「系统 → 省电」，默认开。

**边界**：只对满屏窗口生效（本机窗口 1295×823 / 可用区 1536×864 ≈ 84%，代理**不会**触发 —— 这是正确行为，不是缺陷）。用户把窗口最大化后即可生效。

### 5.2 客户端轮询按状态启停

- **媒体桥**（`/audio-spectrum` 20Hz + `/now-playing`）：常驻 `setInterval(50)` → **自调度链 + 状态闸**；暂停 / 隐藏 / 不在播直接**停链**，由 1s 看护心跳 `reconcileMediaSync()` 复活（≤1s 延迟，不新增周期 —— 新增周期会与 smoke 夹具"按 ms 认定时器"的定位法打架）。
- **遮挡轮询**：快照 `backend:'none'` 连续 3 拍后 **1Hz → 30s 停车**；看到真后端立刻回 1Hz（hub 每 30s 重试适配器，这是唯一的自动恢复路径）。
- **UI 帧率探针**：只在「诊断详读」开着时跑（它是一条常驻 vsync rAF 链，唯一消费者是每 5s 一条诊断行）；关诊断时 `ui=` 如实报 `-`。

### 5.3 宿主 IO / 定时器 / 子进程

- `readConfig()` 加 **mtime+size memo**（写路径显式失效；对外返回浅拷贝）—— 消掉 20 次/秒的同步读盘。
- 诊断落盘改**常驻 fd**（每行一次 `write`），带轮转、并行实例抢先轮转、外部删除三种自愈（三种形态都有判据钉住）。
- 遮挡 hub **懒启动**（首个 `/occlusion` 请求才连 X11）、重试**指数退避**（30s→5min 封顶）、`retryTimer` 补 `unref`（此前 Windows 上它是一个"永远存在的 30s 未 unref 定时器"）。
- 媒体子进程空闲阈值 **15min → 90s**；**legacy 回落路径补空闲停**（1s 轮询 + 音频采集一起停，被访问时自愈重起）。
- 启动清扫定时器补 `unref`。

### 5.4 可观测性与基准

- `test/tools/perf-bench.ps1`：按 DSH 进程树分角色取 CPU 差分 / 工作集 / GPU 3D 占用，相位 `visible` / `covered` / `minimized`，并把"遮挡/最小化到底生效没"落成**可复核字段**（iconic / foreground / cover_style）—— 一次 `ShowWindow` 被忽略就会把整相位量成假的。
- `test/tools/glass-perf-rig.mjs`：真 Chromium 里的玻璃配方对照装置（三档 full/light/off + 静态背景对照组 + `--check-css` 防抄漂）。
- 客户端 60s `activity` 行：`mediaSync` / `occlPoll` / `occlPark` / `hidden` / `playing` / `reason`，事后可与性能相位对账。

### 5.5 玻璃降级门（`glassMotionMode`，默认 `full`）

- **主包**在 `applyEffects` 里算「壁纸这一帧会不会变」（`wallpaperMotionOn()`：`selection.playing` ∧ `isEffectivelyPlaying()` ∧ 类型是 video / scene-live / web-live），命中才挂 `body[data-we-wallpaper-motion="on"]`，与其它 body 钩子成对摘除。
- **玻璃包 CSS** 只在这道门下把**消息气泡族**摘霜并抬到近不透明底（`color-mix(in srgb, var(--we-glass-color) 92%, transparent)`）：输入卡与侧栏面不动（保视觉锚点），带 `:not([role="tooltip"])` 豁免（宿主 Tooltip 从来不吃插件霜釉），`!important` 压过基础规则更高的属性选择器权重。
- **开关**在「外观 → 玻璃 UI」，文案写明默认关与原因；`full` 时主包根本不挂门属性、CSS 规则整块不匹配 ⇒ 与改造前同观感。
- **雾化 = 0 时真的关掉霜**（`data-we-blur-zero`，玻璃层按**全局** `blur` 判定）：此前即使 `blur(0px)`，载体表达式仍带着 `saturate/brightness/contrast`，Chromium 照样为该面读一遍 backdrop 并建 render surface —— "零模糊"不等于零成本。各面自带模糊键（`sidebarBlur` / `settingsWindowBlur` …）的面不在此门内，按自己的值画。

## 6. 未实施 + 理由

### 6.1 玻璃降级：为什么默认关（**下一批第一项 = 真机 A/B**）

机制已经落地（§5.5），但它**默认关**：

1. **微基准没能坐实收益**：1080p、7 个气泡 + 输入卡、AMD 核显下，**有 vsync 时两套配方都是 16.7ms**（没有差异，GPU 有余量）；关掉帧率上限量吞吐得到 full 1724fps / light 1946fps（+12.9%），但同一次测量里"off"反而只有 1580fps —— 说明那个口径量的是主线程调度而不是光栅成本，**不可作为决策依据**（判据 B3 因此判"未达标 / 口径不可靠"）。
2. **真机 A/B 需要重启宿主**（玻璃行开关要改 profile 清单），一次运行没法完成；而"停用玻璃行"的对照正是把可见档 53% 拆成「视频/合成」与「玻璃」两块的最小实验。
3. 所以这一项只**提供开关**、不动默认观感：用户可在设置里一键打开（立即生效、无需重启），但"默认开"必须等 A/B 说话。

**下一批的执行顺序**：真机 A/B 拿到拆分 → 若玻璃占比 ≥1/3，把默认改成 `auto` 并用 `verify-readability` / `verify-glass-compositing` / `verify-softrender` 三条护栏复核 → 否则保持 `full` 并考虑删掉这条机制。

### 6.2 表面管理器的滚动路径削减（**评估后不做**）

原计划：滚动时跳过 `enabled === false` 候选的几何测量。评估后放弃 —— `weSurfaceCandidates()` 在默认聊天界面返回 **0～1 个**候选（右栏面板展开才多一个，设置窗/声明面属一次性），空集时那个循环本来就是空转；而为"跳过"改动会动到候选**认领时序**（首个可认领面出现时必须立刻测），收益不抵风险。真要动主线程，优先项是 §6.1 的玻璃，不是这条。

### 6.3 4K→目标分辨率转码

只对 >1080p 源有效（本机壁纸是 1080p），且跨转码状态机与 `verify-transcode-state` 一族判据，收益面窄、改动面大。留作独立批次。

### 6.4 Windows 原生窗口枚举 / DWM 覆盖率

能精确判定"被覆盖"，但需要原生依赖（`EnumWindows` + `DwmGetWindowAttribute`）：要么新增二进制，要么依赖桌面壳的 `koffi`（非公开契约、官民两版不保证）。按 §6.1 的 A/B 结果再评估。

## 7. 验收标准

### A 类｜机检（随仓跑，确定性）

| 编号 | 判据 | 落在哪 |
|---|---|---|
| A1 | 暂停/隐藏时媒体桥**零请求**；恢复可见 ≤1s 内重开 | `src/client-media-frame.js` 的状态闸 + smoke 夹具 |
| A2 | 遮挡轮询在 `backend:'none'` 下 ≤3 拍停车，看到真后端回 1Hz | `verify-occlusion-client`（含 S 段形态判据） |
| A3 | UI 帧率探针只在诊断详读时注册 | `verify-scene-live` 的探针段 |
| A4 | `readConfig()` 未变更时 0 次 `readFileSync`，写后立刻可见；`cacheBaseDir` 语义不变 | `verify-cache-dir`（A6 语义面） |
| A5 | 诊断落盘 N 行只 open 1 次；轮转 / 抢先轮转 / 外部删除三种自愈 | `verify-host-diag`（B4 等） |
| A6 | 遮挡 hub 不在装载期启动；`retryTimer` 已 unref；重试间隔递增 | `verify-occlusion-hub` D3/D4（含两条新负对照） |
| A7 | 全链绿：`npm run verify`（100 步）/ `smoke`（6）/ `verify:docs`（6） | CI 同款命令 |

### B 类｜微基准（手动，结论入 `MEASUREMENTS.md`）

| 编号 | 判据 |
|---|---|
| B1 | `perf-bench.ps1` 同相位两次运行差异 ≤15%（可复算性自检） |
| B2 | `glass-perf-rig.mjs` 的**静态背景对照组**两档差异 ≤5%（证明"玻璃只对动背景加价"这条机制成立） |
| B3 | 玻璃降级若实施：动背景 throughput 提升 ≥20% 且对照组不劣化（该阈值已写在装置里，达标才 PASS） |

### C 类｜真机端到端（需重启宿主；交付后复测）

| 编号 | 判据 | 未达标处置 |
|---|---|---|
| C1 | `minimized` 相位：插件可归因 CPU ≤0.3% 单核、GPU ≤1%（**基线已满足**，防回归） | 视为回归，回滚引入项 |
| C2 | 单屏 + 窗口最大化 + 失焦 ⇒ 进入 `pauseOnCovered`，渲染进程掉到 ≤5% 单核（对比 `visible` 的 53%） | 调代理条件或判为未达标 |
| C3 | `visible` 相位：改造后相对改造前 CPU/GPU **不劣化**（±5%）——本轮改的是"不该跑的时候别跑"，不该牺牲可见档 | 回滚 |
| C4 | 无观感回归：**默认设置**下界面对照图与改造前一致（`glassMotionMode=full` ⇒ 门属性不挂、CSS 不匹配）；`auto` 档的差异只允许出现在"动壁纸时的气泡面" | 修复 |

**可归因口径**：同一进程树内 `有壁纸 − 无壁纸`；相位切换前后各丢弃 10s 预热；记录 `devicePixelRatio`、窗口尺寸、壁纸分辨率/帧率。

## 8. 复现

```powershell
# 真机相位基准（会短暂遮挡/最小化 DSH 窗口，结束自动还原）
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label before -Phases visible,covered,minimized -Warmup 10

# 玻璃配方对照（真 Chromium，手动工具，不进 verify 链）
node test/tools/glass-perf-rig.mjs --blocks 2 --check-css
```

## 9. 下一步（按序）

1. **真机 A/B 拆玻璃**（重启一次）：玻璃行停用 vs 全开，各取 `visible` 相位 3×60s，得到"玻璃占可见档成本的比例"。
2. 若 ≥1/3：把 `glassMotionMode` 默认改成 `auto`（机制已在 §5.5，无需再改代码），并用 §7 的 B3/C4 复核；否则保持 `full`。
3. 4K 分辨率上限转码（独立批次）。
4. 遮挡代理扩展到"最大化 + 窗口部分可见"的判定（需要更细的几何信号，评估原生方案）。
