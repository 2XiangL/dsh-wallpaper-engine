# 资源占用优化：调研、改造与验收

> 本文回答一个问题：**「装上壁纸插件后系统占用显著升高」这件事，能按 dynapaper 的做法改到什么程度？**
> 结论、证据、已实施项与未实施项都在这里；实测数字的原始记录见 [`MEASUREMENTS.md`](./MEASUREMENTS.md)。
>
> 写作口径（本仓 ADR-0017）：**会漂的数值不抄**，一律给复算方式或指向唯一真源。

## 0. 结论（先看这段）

1. **可行，但收益不来自"照搬 dynapaper 的写法"**。dynapaper 的收益主体是「不可见即零开销 + 事件驱动 + 动态排程 + 活动计数」；本插件里前三条**各有一半已经在做**，缺的是最后一环：**"看不见"这个信号在 Windows/Electron 侧根本没有被采到**。
2. **改造前实测（单屏 / AMD 核显 / 1080p30 视频壁纸 / 玻璃默认）**：窗口被顶置不透明窗**完全盖住**时，渲染进程仍占 **63% 单核**、GPU 进程 **43% 单核**——与"可见"档几乎一样；而**最小化**时两者都掉到 ≈0。也就是说：**它不是"没有省电逻辑"，而是省电逻辑拿不到遮挡信号**（宿主的遮挡 hub 只有 X11 适配器；Chromium 的窗口遮挡跟踪在本壳不把"被覆盖"判成 `hidden`）。
3. **本轮已落地**：遮挡代理（`pauseOnCovered`）、客户端三处轮询按状态启停、宿主三处 IO/定时器治理。全部改动都有机检判据或可复算的观测点，`verify` 100 步 / `smoke` 6 步全绿。
4. **第三批（其后追加）**：逐线程采样把可见档拆成「主线程 37.4 / 工作线程 16.6 单核%」，
   并证明插件在视频档下**没有按帧运行的 JS**（成本是 Blink 的合成/重绘）⇒ 只能靠
   "少做几步 / 换低频烘焙 / 看不见时停"三条路压。本批已落地"少做几步"里**可证无观感变化**的那半：
   摘掉 `contrast(1.01)` 恒等段、逐面「雾化=0」真关闭，并修掉三处宿主/客户端重复开销与两处泄漏；
   换来的是**每一帧都省**（视频壁纸下每面每帧都在付）。详见 §10。
5. **玻璃降级：机制已落地，但默认关**（新设置 `glassMotionMode`，取值 auto / full，默认 full；设置里一键可开、立即生效无需重启）。不默认开的原因是**归因还没坐实**：微基准在 1080p/60fps 下两套配方没有可测差异，而真机 A/B 需要重启宿主才能切玻璃行 —— 在没有对照之前动默认观感，等于拿用户的界面做实验。判据与方法见 §6.1 / §7（B3、C4）。

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

### 5.1 遮挡代理 `pauseOnCovered`（**已撤除**，见本节末）

**问题**：被其它窗口盖住时完全不省电（§2）。

**为什么不能直接用现成的**：宿主的遮挡 hub 只有 X11 适配器；Chromium 的窗口遮挡跟踪在本壳**不把覆盖判成 `hidden`**（用顶置不透明窗盖满整屏，渲染进程仍占六成单核）。桌面壳的 `pauseOnBlur` 又因"失焦时壁纸多半仍整块可见"被默认关掉。

**做法**：用三个**能自证**的条件合成保守代理 —— ① `screen.isExtended === false`（单屏 ⇒ 抢走焦点的窗口只可能压在本窗之上）；② 本窗铺满可用区 ≥98%（侧边并排天然排除）；③ 失焦**持续** ≥1.5s（拖动/切窗的瞬时抢焦点不触发）。三条同时成立才判"被覆盖"，任一不成立立即恢复；**多显示器一律不判**（另一个 App 可能在另一块屏上、本窗仍整块可见）。

判定并入 `occlusionReason()` **单一判定源**，因此视频 `pause()` 与实时渲染页 `pause()` 都走既有 effective 播放态管线，不需要第二条通路。设置项与「最小化/切页时暂停」并列在「系统 → 省电」，默认开。

**边界**：只对满屏窗口生效（本机窗口 1295×823 / 可用区 1536×864 ≈ 84%，代理**不会**触发 —— 这是正确行为，不是缺陷）。用户把窗口最大化后即可生效。

**⚠️ 2026-11-03 撤除**：真机反馈这条代理会**误判** —— DSH 全屏（或最大化）时，
只要在上面叠一个**小窗**（例如任务管理器），本窗就会失焦而仍然铺满可用区 ⇒ 三个条件成立 ⇒
壁纸停住，而实际 95% 的画面还看得见。"把看得见的壁纸定格"当省电，用户体感就是 bug。
因此整条代理（代码 / 设置项 `pauseOnCovered` / 界面行 / 相关判据）已删除，回到**最原始的实现**：

- `pauseOnHidden`（默认开）：`document.hidden` 持续 ≥1.2s 才暂停（瞬时抖动不触发冷重载）；
- `pauseOnBlur` / `pauseOnBattery`（默认关）：桌面目标下失焦时壁纸多半仍整块可见，故不默认开。

代价要说清楚：§2 的 `covered` 相位（"被完全盖住却不省电"）**重新变成缺口** —— 这一块改由
宿主侧的**真实**电源/会话事件（锁屏 / 挂起）来补，而不是靠几何+焦点的猜测。旧配置里的
`pauseOnCovered` 键在消毒时按未知键丢弃，不报错。

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
| A7 | 全链绿：`npm run verify`（101 步）/ `smoke`（6）/ `verify:docs`（6） | CI 同款命令 |
| A8 | 玻璃配方形状：无 `contrast(...)` 恒等段；逐面雾化 token 写侧==读侧；卸载撤属性 | `verify-glass-recipe` |

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
# v2：五个相位 + 五维口径；新相位 partial-cover / unfocused-visible 见文件头
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label before -Phases visible,covered,minimized -Warmup 10
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label probe -Phases partial-cover,unfocused-visible -Warmup 10

# 玻璃配方对照（真 Chromium，手动工具，不进 verify 链）
node test/tools/glass-perf-rig.mjs --blocks 2 --check-css
```


## 8.1 改了客户端/宿主代码之后怎么让它生效

插件由宿主按 profile 里的 node_modules 加载，**行级开关只热应用"启用/停用"，不会重新取字节** ⇒
改了 `lib/**`、`packages/*/lib/**` 之后必须：

```powershell
node .test-cache/install-batch3.mjs   # 把工作区已构建产物写进 profile（带 .we-backup-* 回滚点）
# 然后重启 DSH（关掉窗口再打开；宿主与页面都会重新求值）
```

`glass-perf-rig.mjs` 是独立装置，不需要重启。

1. **重启后补 A/B**（唯一还缺的一刀）：同一台机、同一套 v2 量具，`visible` ×3 取中位，与
   §10.4 的 `p1-before` 对照；同时补测 `covered`（看 `cover_focus_ok`）。
2. **P2 spike**（半天）：`glass-perf-rig` 加"真视频背景 + baked 档"，吞吐提升 <10% 就放弃；
   通过再实现 canvas 镜像版（只对两块侧栏，输入卡不动）。
3. **P4**（半天，含一次重启）：宿主 `powerMonitor` 能力探测 + 锁屏/挂起并入 `occlusionReason()`。
4. **P3**（观感取舍，待拍板）：`auto-all` 扩面；默认仍 `full`。
5. 4K 分辨率上限转码（独立批次，维持 §6.3）。

## 10. 第三批（本轮）：还能往哪压，以及为什么只能这么压

### 10.1 归因结论（本轮新证据，替代上一轮的猜测）

1. **逐线程采样**（`perf-bench.ps1` v2）：视频壁纸 + 玻璃 auto 的 `visible` 档，renderer 主线程
   **37.4 单核%**、工作线程 16.6；`minimized` 掉到 **0.99 / 0.53**。⇒ 成本压在主线程，
   且随"暂停"整块消失（不是摊在解码/合成后台线程上）。
2. **静态审计（四路独立）**：桌面壳是 Electron（UA 不含 `Edg/` ⇒ 原生 `<video>`），
   视频档下插件**没有任何按视频帧运行的 JS**（0 处 `timeupdate`、无每帧 DOM 写、rVFC 只在
   Edge 镜像画布与场景抓帧两条死路上）；玻璃包里 **138 处 `backdrop-filter` 里只有 17 条是真霜规则**
   （其余是 `none` 覆盖、注释、`-webkit-` 双写）⇒ 上一轮"表达式很长"的直觉被高估了约 8 倍。
   （上面三个数字的唯一真源 = [`MEASUREMENTS.md`](./MEASUREMENTS.md) 的 `p1-before` 记录；这里只给结论。）
3. ⇒ 主线程那一段是 **Blink 的 paint / layerize / commit**：每个霜面每帧重采一次 backdrop 的后果。
   因此"再压"只有三条路，别无第四条：
   **① 同一观感下每面每帧少做几步；② 把大块静态面的 backdrop 换成低频烘焙；③ 看不见时彻底停。**

### 10.2 本批已落地（都在分支上，判据随链）

| 项 | 改了什么 | 为什么观感不变 | 判据 |
|---|---|---|---|
| P1-1 | 17 条真霜规则 + 宿主 `--dsw-mask-blur` 通道摘掉 `contrast(1.01)` | `out=(in-0.5)*1.01+0.5`：0..1 区间最大 \|Δ\| = 1.3/255，中灰为 0 | `verify-glass-recipe` + `glass-perf-rig --check-css` 的反向 tripwire |
| P1-3/4 | 逐面「雾化 = 0」真关闭（`data-we-blur-zero-faces`） | 0 就是"这面不要霜"，与既有全局门同语义；有效值经 `glassValue` 解析（跟随档不会漏挂） | 写侧 token 集合 == 读侧 token 集合（双向）+ 卸载成对撤属性 |
| P5-1 | `audioReactiveHidden` 改 **WeakSet** | 语义等价（只做 `has()`，遍历的是当前层列表） | 注释里"旧对象会被回收"原本是错的：Set 强引用把它钉住 |
| P5-2 | `gpuFramePins` 加 TTL 清扫 + 上限 64 | 纯缓存 | 表大小有上界 |
| P6-1 | **修回归**：内置媒体后端空闲睡死后由读路径 `wake()` 懒唤醒 | 恢复"下次被访问自动拉起"的原设计 | `verify-media-bridge` |
| P6-2 | `detectFfmpegSource` 记忆化 | 设备列表运行期不变；`DSH_WE_MEDIA_REDETECT=1` 可强探 | 每次睡醒不再付 5s 同步 `spawnSync` |
| P6-3 | diag 目录 `mkdirSync` 记忆化（外部删目录时自愈） | 纯 IO | `verify-logging` / `verify-host-diag` |
| P6-4 | `serveBytes` 的 `existsSync + statSync` 合成一次 `statSync` | 目录语义与旧路径一致（stat 成功、流打开才失败） | `verify-json-response` |
| 量具 | `perf-bench.ps1` 升到 schema /2（五维 + 状态断言 + 修 5 处会静默量错的口径） | —— | 见 `MEASUREMENTS.md` 的"采集方法" |
| 撤除 | **遮挡代理 `pauseOnCovered` 整条删除**（代码 / 设置 / 界面行 / 词表 / 预设 / 判据） | 回到"最原始实现"：只认 `document.hidden` + 可选失焦/电池 | 用户真机反馈：全屏时叠一个小窗就误暂停 ⇒ §5.1 末 |

### 10.3 已判定但**刻意未做**（附理由，免得下一轮重走）

- **P2 把侧栏底板的 backdrop 换成"烘焙副本"**：等价性**已证**（`[data-we-surface-root]` 是
  `z-index:-1`，宿主整个 UI 帧在其上 ⇒ 底板背景只含「壁纸 + 均匀 scrim + fx canvas」，
  均匀 alpha 与 blur 可交换）；实现不必用 ffmpeg/第二个解码器 —— `ctx.filter='blur()'; drawImage(video)`
  到 480×270 canvas（`drawImage` 复用已解码帧），每 200–500ms 一次，成本 ≈0.2–0.5ms/次。
  **未做**的原因：①它要镜像 `objectFit/flip/layerPosition/layerScale/parallax/wallpaperOpacity/wallpaperBlur/fpsCap`
  八项状态，非过渡档还要回退 live；②输入卡 `::before` **不等价**（sticky 输入卡底下会滚过消息行，
  见 `docs/DSH-UI-INTERFACES.md`），只对两块侧栏成立；③必须先有 rig 吞吐判据（<10% 就放弃），
  否则又是一次"改了但证不出"。
- **P3 `glassMotionMode=auto-all`**（动壁纸时把输入卡/侧栏/工具卡一起降级）：机制已在（`data-we-wallpaper-motion`），
  只差枚举扩面 + 新设置值。**这是观感取舍**（动壁纸时侧栏也变近不透明），默认不动，等你点头。
- **P4 锁屏 / 挂起 / 空闲暂停**：宿主侧押 `powerMonitor`（Electron 能力探测，不可用则整条不启用）。
  收益是"人不在时归零"，但需要一次重启才能验证。
- **4K→目标分辨率转码 / Windows 原生窗口枚举**：维持 §6.3 / §6.4 的裁定（收益面窄，改动面大）。

### 10.4 已知未解释（不要当成已解决）

- `covered` 相位这一轮**没有记到任何 `play-state` 转换行**，而 `partial-cover` 记到了
  `窗口被覆盖(pauseOnCovered)`。v2 已补 `cover_focus_ok`（遮挡窗是否真抢到焦点）来区分
  "策略失效"与"装置没摆成功"，复测一次即可定性。
- **配方瘦身的实测**：改造后 `visible` 6 次（两批各 3×）主线程中位 ≈19.3、区间 17.1–24.9 单核%，
  对比改造前单次 37.38；GPU 3D 16.76 → 13.8–14.6。方向与量级都指向"每帧少一段全区域滤镜"有效，
  但 before 侧只有 1 次且明显受首轮热机影响 ⇒ 精确百分比仍缺受控对照（见下条）。
- 本批的 **A/B 尚未闭环**：量具换了、口径也换了（进程总 → 主线程/工作线程分开），
  与上一轮 26.22 那类数字**不可相减**。正确做法是"同一套 v2 量具、同一台机、重启前后各一轮"
  —— 代码已装进 profile（`.we-backup-* ` 可回滚），下一次重启即可补这一刀。
