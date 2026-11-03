<#
perf-bench.ps1 —— **真机相位基准装置**（手动工具，不进 `npm run verify` 链）。schema `dsh-we-perf-bench/2`。

回答的问题：**装上这套插件之后，DSH 到底多花了多少 CPU / GPU / 内存 / 显存 / 磁盘 I/O？停掉壁纸又剩多少？**
单元守卫证明"贵操作变少了"，这个装置量的是**进程真的花掉的资源**。

## 为什么按相位量

同一个应用在不同状态下的成本差一到两个数量级（可见播放 / 被遮挡 / 最小化）。只报一个
平均数等于什么都没说。相位是**可脚本复现**的，且每个相位都把"到底进没进这个状态"落成
可复核字段（见 §状态断言）：一次 `ShowWindow` 被忽略、一次 `SetForegroundWindow` 被前台锁
拒绝，就会把整个相位量成假的 —— 上一版就踩过（窗口 84% 时测"遮挡暂停"）。

| 相位 | 怎么造 | 回答什么 |
|---|---|---|
| `visible` | 还原并置前主窗（`ForceForeground` 重试 3 次） | 可见播放时的真实成本（最重要的一档） |
| `covered` | 最大化 + 置顶不透明窗盖满虚拟屏 + 抢焦点 | 整窗被遮挡时策略是否真的把开销打到 0 |
| `minimized` | `ShowWindow(SW_MINIMIZE)` | 最小化档（Chromium 对两者的节流路径不同） |
| `partial-cover` | 最大化 + 盖住下 60% 高度 + 抢焦点 | **"部分可见"到底省不省**（`pauseOnCovered` 要求 ≥98%，这里必然是"不暂停"） |
| `unfocused-visible` | 最大化 + 置前主窗 + 16×16 抢焦点小窗 | 可见但非前台；也是 `covered` 的**装置对照**（把遮挡窗自身的合成成本扣掉） |

## 五维计量口径（每条都有它自己的坑，写在下面）

1. **CPU（进程级 + 线程级）**：进程用 `Process.TotalProcessorTime` 差分；**线程级用 .NET
   `Process.Threads`**，不用 WMI 的 `PerfProc_Thread` —— 实测那一族单次查询 1.9 s（raw）/
   4.0 s（formatted），因为它枚举的是全系统 ~4000 个线程，`IDProcess=` 过滤并不能加速。
   主线程判据 = **最早创建**的那个线程（`StartTime` 与进程 `StartTime` 差 ≤250ms；本机
   6/6 进程成立），`idx==0` 只作旁证，绝不单用（provider 枚举顺序不是契约）。
   线程在相位内可能新建/退出 ⇒ 除逐线程差分外还报 `cpu_thread_residual_ms = 进程差 − Σ线程差`，
   残差大就意味着"有线程没被观测到"，不许静默丢掉。
2. **GPU 3D**：`GPUEngine` 的 **raw** 类（`UtilizationPercentage` 是瞬时值，raw 的
   `RunningTime` 是累计 100ns，自己算差分），`engtype_3D` **与 `High Priority 3D` 都算**
   （Chromium 的合成器可能落在高优先级引擎上），按 pid 锚定 `^pid_(\d+)_`（禁止 `like`：
   `pid_12` 会吃 `pid_123`），跨 luid 求和，均值按实际采样间隔**时间加权**。
3. **显存**：`GPUProcessMemory` 的 `DedicatedUsage / SharedUsage / TotalCommitted / LocalUsage`，
   `^pid_(\d+)_luid_(.+)$` 解析、同 pid **多 luid 求和**、`TotalCommitted` 只报不推导
   （本机 28/33 实例 ≠ dedicated+shared）。**禁止把逐进程显存加总成"总显存占用"**：进程间共享
   重复计算（实测 Σ进程 1623.9 MB > 适配器 1404.3 MB），iGPU 上它就是系统内存。
4. **内存**：头号口径是 `WorkingSetPrivate`（私有无共享页 = 可归因）；`WorkingSet64` 保留作
   连续性对照并标注 `double_counts_shared=true`（本机树被共享页高估 ≈300 MB，且跨构建不可比）。
   `PrivateBytes`（提交）作泄漏副指标 —— 工作集会被系统静默 trim，提交不会。
5. **磁盘 I/O**：`PerfRawData_PerfProc_Process` 的 `IOReadBytesPersec / IOWriteBytesPersec`
   —— 注意 **Raw 类里这些名字是累计字节，不是速率**（已实测单调递增）。口径必须照实说：
   它是**进程所有句柄的逻辑 I/O**，含页缓存命中、含管道/socket（Chromium 的 mojo IPC），
   **不含 mmap/分页**；因此**无法**用它区分"真磁盘"与"页缓存"，renderer 的生命周期写入
   以 IPC 为主（实测 4.61 GB 而物理盘空闲）。只作同机 A/B 的相对量。
   另报系统级 `PerfDisk_PhysicalDisk`（不计入任何进程，标 `system_wide=true`）作为反证：
   若 Σ进程读很大而系统级读≈0，就说明那是缓存/IPC 而不是磁盘。

## 状态断言（每个相位都落成事实，不合格标 valid=false）

- `GET /wallpaper-engine/settings` 快照 sha256：相位内必须不变（挡住轮播/人为改动）。
- `GET /wallpaper-engine/glass-row-state`：玻璃行是否启用（停了玻璃的数没有意义）。
- `GET /wallpaper-engine/inventory` + `settings.id`：壁纸类型（video / image / scene）。
- diag JSONL 窗口（`~/.dsh-wallpaper-engine/diag/http.jsonl` 尾部 256 KB）：抽
  `play-state · playing=… hold=… hidden=… focus=…` 与 `onscreen … leaf=VIDEO|IMG`。
  ⚠️ `beat` 每 60 s 一行、`activity` 只在"诊断详读"打开时才写 ⇒ 断言**不能依赖**它们。
- 窗口几何：最大化后 `rect_area / work_area ≥ 0.98`（`pauseOnCovered` 的前提）；
  前台是否真是主窗（`ForceForeground` 重试后仍不是 ⇒ `valid=false`）。

## 用法

```powershell
# 基线：可见 60s + 遮挡 30s + 最小化 20s
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label baseline-video

# 只看可见档，3 次重复（自动报 CV，B1 判据要求 ≤15%）
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label after -Phases visible -Repeat 3

# 部分遮挡 / 可见但非前台
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label probe -Phases partial-cover,unfocused-visible

# 指定根进程 / 结果目录
pwsh -NoProfile -File test/tools/perf-bench.ps1 -RootPid 8492 -OutDir D:\perf
```

**会短暂覆盖/最小化 DSH 窗口**（结束时 `finally` 必定还原）。不要在演示/开会时跑。

输出：`<OutDir>\<Label>-<yyyyMMdd-HHmmss>.json`（逐相位样本、断言与聚合）与终端 Markdown 表。
默认 `OutDir = <repo>/.test-cache/perf`（`.gitignore` 已排除）。

退出码：0 = 全部相位 `valid=true`；1 = 装置失败或有相位无效；2 = 用法错误。
#>
[CmdletBinding()]
param(
  [string]$Label = 'run',
  [string[]]$Phases = @('visible', 'covered', 'minimized'),
  [int]$Seconds = 0,                 # 0 = 按相位默认
  [int]$Warmup = 10,                 # 预热下限；状态没到就继续等（见 -WarmupMax）
  [int]$WarmupMax = 30,
  [int]$Repeat = 1,
  [int]$Interval = 1000,             # 采样间隔 ms（<250 会被拒：采样自身成本会污染）
  [int]$RootPid = 0,
  [bool]$MaximizeForCovered = $true,
  [ValidateSet('tool', 'normal')]
  [string]$CoverStyle = 'tool',
  [bool]$CoverTakeFocus = $true,
  [double]$PartialCoverFrac = 0.60,  # partial-cover 盖住的比例（按可用区高度）
  [string]$OutDir = '',
  [string]$Note = '',
  [int]$HostPort = 0,                # 0 = 自动探测（按 host 进程的监听端口 + /settings 探活）
  [switch]$NoHttp,                   # 断了 HTTP 断言（只留 diag/窗口几何）
  [switch]$NoThreads,
  [switch]$RequireForeground,   # 前台拿不到就判 invalid（默认只记事实 + 警告）                # 关掉线程级拆分（相位很短时省 2×24ms）
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot '.test-cache\perf' }

$PhaseSeconds = @{
  'visible'          = 60
  'covered'          = 30
  'minimized'        = 20
  'partial-cover'    = 30
  'unfocused-visible' = 30
}
# `pwsh -File x.ps1 -Phases visible,covered` 会把整串当成一个字符串，自己拆一次。
$Phases = @($Phases | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($p in $Phases) {
  if (-not $PhaseSeconds.ContainsKey($p)) {
    Write-Error "未知相位：$p（可选：$($PhaseSeconds.Keys -join ', ')）"
    exit 2
  }
}
if ($Interval -lt 250) { Write-Error '(-Interval <250ms) 采样自身的成本会污染读数，拒绝执行'; exit 2 }

# ── Win32：遮挡窗 / 抢焦点窗 / 可用区（纯 Win32，不依赖 WinForms）──────────
if (-not ('WeBench' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WeBench
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowExW(
        int exStyle, string cls, string name, int style, int x, int y, int w, int h,
        IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassW(ref WNDCLASS wc);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] private static extern bool SystemParametersInfo(uint action, uint param, ref RECT data, uint winIni);

    /// <summary>把窗口强行拉到前台（前台锁的标准绕法：挂到当前前台线程的输入队列上再 Set）。</summary>
    public static bool ForceForeground(IntPtr h)
    {
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint me = GetCurrentThreadId();
        bool ok = false;
        try {
            AttachThreadInput(me, fgThread, true);
            // 前台锁：非前台进程的 SetForegroundWindow 会被静默拒绝。先模拟一次 ALT 轻敲，
            // 让本线程拿到"最近有输入"的资格，再 Set —— 否则整个 visible 相位会在
            // "窗口没到前台"的状态下被量（甚至被 Chromium 判 hidden ⇒ 壁纸暂停 ⇒ 读数归零）。
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            ok = SetForegroundWindow(h);
        } finally { AttachThreadInput(me, fgThread, false); }
        return ok;
    }

    public const int SW_RESTORE = 9;
    public const int SW_MINIMIZE = 6;
    public const int SW_SHOW = 5;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    private const int WS_POPUP = unchecked((int)0x80000000);
    private const int WS_VISIBLE = 0x10000000;
    private const int WS_EX_TOPMOST = 0x00000008;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const uint PM_REMOVE = 0x0001;
    private const uint SPI_GETWORKAREA = 0x0030;

    private static IntPtr _cover = IntPtr.Zero;
    private static bool _classReady;

    /// <summary>最大可见顶层窗口（按面积）：DSH 主窗通常就是它。</summary>
    public static IntPtr FindMainWindow(int[] pids)
    {
        IntPtr best = IntPtr.Zero; long bestArea = 0;
        EnumWindows((h, l) =>
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (Array.IndexOf(pids, (int)pid) < 0) return true;
            if (!IsWindowVisible(h)) return true;
            RECT r; if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static string RectOf(IntPtr hWnd)
    {
        RECT r; if (!GetWindowRect(hWnd, out r)) return "";
        return string.Format("{0},{1} {2}x{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    /// <summary>可用区（去掉任务栏的工作区）。最大化判定与 partial-cover 的几何都用它。</summary>
    public static string WorkArea()
    {
        RECT r = new RECT();
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, ref r, 0)) return "";
        return string.Format("{0},{1} {2}x{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    /// <summary>
    /// 建一块置顶黑窗盖住指定矩形（默认整虚拟屏）。
    /// `normal=true` 时是普通顶层窗、否则工具窗；`takeFocus` 决定是否抢焦点 ——
    /// Chromium 的窗口遮挡跟踪与 pauseOnCovered 都看"焦点是否离开"，两种形态**语义不同**，
    /// 所以做成可选项并在报告里标出来，不要拿一种形态的结论去套另一种。
    /// </summary>
    public static void ShowCover(bool normal, bool takeFocus)
    {
        ShowCoverRect(normal, takeFocus,
            GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
    }

    public static void ShowCoverRect(bool normal, bool takeFocus, int x, int y, int w, int h)
    {
        if (_cover != IntPtr.Zero) HideCover();
        if (!_classReady)
        {
            WNDCLASS wc = new WNDCLASS();
            _wcProc = new WndProcDelegate(DefWinProc);
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wcProc);
            wc.hbrBackground = (IntPtr)4; // BLACK_BRUSH（stock object）
            wc.lpszClassName = "WeBenchCoverWnd";
            RegisterClassW(ref wc);       // 已注册过会失败，忽略
            _classReady = true;
        }
        int exStyle = WS_EX_TOPMOST | (takeFocus ? 0 : WS_EX_NOACTIVATE) | (normal ? 0 : WS_EX_TOOLWINDOW);
        _cover = CreateWindowExW(exStyle,
            "WeBenchCoverWnd", "we-perf-cover", WS_POPUP | WS_VISIBLE, x, y, w, h,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        ShowWindow(_cover, SW_SHOW);
        if (takeFocus) ForceForeground(_cover);
        Pump();
    }

    public static IntPtr CoverHandle() { return _cover; }

    public static void HideCover()
    {
        if (_cover == IntPtr.Zero) return;
        DestroyWindow(_cover);
        _cover = IntPtr.Zero;
        Pump();
    }

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
    private static WndProcDelegate _wcProc;

    private static IntPtr DefWinProc(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp)
    {
        return DefWindowProc(hWnd, msg, wp, lp);
    }

    /// <summary>抽干消息队列：遮挡窗要活着就必须有人泵消息（采样循环里调）。</summary>
    public static void Pump()
    {
        MSG msg;
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }
}
'@
}

# ── 时钟：百分比的分母必须只包住"读计数器"，不能把 300ms 的 WMI 查询算进去 ──
$script:SwFreq = [System.Diagnostics.Stopwatch]::Frequency
function NowTicks { [System.Diagnostics.Stopwatch]::GetTimestamp() }
function TicksToMs([long]$ticks) { $ticks * 1000.0 / $script:SwFreq }

# 逐属性求和：跳过 $null / 非数值（某个进程没被观测到时该列就是 $null），
# 且空集合返回 0 —— `Measure-Object -Sum` 在空输入下返回的 Sum 是 $null，
# StrictMode 下再取 `.Sum` 会抛"找不到属性"，把整相位吞成"失败"。
function SumOf {
  param($Items, [string]$Prop)
  $sum = 0.0
  foreach ($it in @($Items)) {
    if ($null -eq $it) { continue }
    $v = $it.$Prop
    if ($null -eq $v) { continue }
    if ($v -is [ValueType]) { $sum += [double]$v }
  }
  return $sum
}

# ── 进程树（每相位重解析：子进程会生会死，一次解析管全程会把新进程算丢）──────
function Get-ProcessRows {
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Select-Object ProcessId, ParentProcessId, CommandLine
}

function Get-RoleOf([string]$cmd, [int]$parentPid, [int]$rootPid) {
  if ($parentPid -eq $rootPid) {
    if ($cmd -match '--type=gpu-process') { return 'gpu' }
    if ($cmd -match '--type=renderer') { return 'renderer' }
    if ($cmd -match '--type=utility') {
      $sub = ''
      $m = [regex]::Match($cmd, '--utility-sub-type=([A-Za-z0-9._-]+)')
      if ($m.Success) { $sub = $m.Groups[1].Value }
      switch -Regex ($sub) {
        'audio'   { return 'utility:audio' }
        'network' { return 'utility:network' }
        default   { return if ($sub) { "utility:$sub" } else { 'utility' } }
      }
    }
    if ($cmd -match 'dsh-desktop-host') { return 'host' }
    return 'main'
  }
  if ($cmd -match 'ffmpeg|media-bridge|we-audio-tap') { return 'plugin-child' }
  if ($cmd -match 'server\.mjs|mcp\\server|runner\.js|dist\\media') { return 'plugin-child' }
  return 'other'
}

function Resolve-DshTree {
  param([int]$Root)
  $rows = @(Get-ProcessRows)
  if (-not $rows.Count) { throw '找不到 "DeepSeek Harness.exe" 进程：DSH 没在跑？' }

  $byId = @{}
  foreach ($r in $rows) { $byId[[int]$r.ProcessId] = $r }

  if ($Root -le 0) {
    $cands = @($rows | Where-Object { -not $byId.ContainsKey([int]$_.ParentProcessId) })
    if ($cands.Count -ne 1) {
      throw "DSH 根进程不唯一（$($cands.ProcessId -join ',')）：可能装了两份，请用 -RootPid 指定"
    }
    $Root = [int]$cands[0].ProcessId
  }
  if (-not $byId.ContainsKey($Root)) { throw "RootPid=$Root 不在 DSH 进程集合里" }

  $tree = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($Root)
  $seen = New-Object System.Collections.Generic.HashSet[int]
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if (-not $seen.Add($id)) { continue }
    $row = $byId[$id]
    if (-not $row) { continue }
    $cmd = [string]$row.CommandLine
    $role = if ($id -eq $Root) { 'main' } else { Get-RoleOf $cmd ([int]$row.ParentProcessId) $Root }
    $tree.Add([pscustomobject]@{ Pid = $id; Role = $role; CommandLine = $cmd })
    foreach ($c in $rows) { if ([int]$c.ParentProcessId -eq $id) { $queue.Enqueue([int]$c.ProcessId) } }
  }
  return [pscustomobject]@{ RootPid = $Root; Members = $tree.ToArray() }
}

# ── 采样器 ─────────────────────────────────────────────────────────────────
# 每次采样都要跑的三件便宜事：.NET 进程计数（18ms）、GPUEngine raw 3D（34ms）、
# GPUProcessMemory（19ms）。**不许**把 PerfProc_Thread / FormattedData_PerfProc_Process /
# FormattedData_GPUEngine 放进循环（实测 1.9s / 0.37s / 0.32s 一次）。
function Get-GpuRaw {
  param([int[]]$Pids)
  $want = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $Pids) { [void]$want.Add($p) }
  $map = @{}
  try {
    $eng = Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine `
      -Filter "Name LIKE '%engtype_3D%'" -ErrorAction Stop
  } catch { return $map }
  foreach ($e in $eng) {
    $name = [string]$e.Name
    $m = [regex]::Match($name, '^pid_(\d+)_luid_(.+?)_eng_(\d+)_engtype_(3D|High Priority 3D)$')
    if (-not $m.Success) { continue }
    $pid2 = [int]$m.Groups[1].Value
    if (-not $want.Contains($pid2)) { continue }
    $rt = 0.0
    try { $rt = [double]$e.RunningTime } catch { $rt = 0.0 }
    if (-not $map.ContainsKey($pid2)) { $map[$pid2] = [pscustomobject]@{ Run = 0.0; RunHp = 0.0 } }
    if ($m.Groups[4].Value -eq 'High Priority 3D') { $map[$pid2].RunHp += $rt } else { $map[$pid2].Run += $rt }
  }
  return $map
}

# RunningTime 单位 100ns ⇒ 区间利用率 = 100 * (Δrun / 10000) / Δ墙钟ms
function Measure-GpuPct {
  param([hashtable]$Cur, [hashtable]$Prev, [double]$WallMs)
  $pct = @{}
  if ($WallMs -le 0) { return $pct }
  foreach ($k in $Cur.Keys) {
    $c = $Cur[$k]
    $d3 = 0.0; $dhp = 0.0
    if ($Prev.ContainsKey($k)) {
      $d3 = $c.Run - $Prev[$k].Run
      $dhp = $c.RunHp - $Prev[$k].RunHp
    }
    if ($d3 -lt 0) { $d3 = 0 }
    if ($dhp -lt 0) { $dhp = 0 }
    $pct[$k] = [pscustomobject]@{
      pct_3d = [math]::Round(100.0 * ($d3 / 10000.0) / $WallMs, 2)
      pct_hp = [math]::Round(100.0 * ($dhp / 10000.0) / $WallMs, 2)
      run    = $c.Run
      runHp  = $c.RunHp
    }
  }
  return $pct
}

function Get-GpuMemByPid {
  param([int[]]$Pids)
  $want = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $Pids) { [void]$want.Add($p) }
  $map = @{}
  try {
    $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop
  } catch { return $map }
  foreach ($e in $mem) {
    $m = [regex]::Match([string]$e.Name, '^pid_(\d+)_luid_(.+)$')
    if (-not $m.Success) { continue }
    $pid2 = [int]$m.Groups[1].Value
    if (-not $want.Contains($pid2)) { continue }
    if (-not $map.ContainsKey($pid2)) {
      $map[$pid2] = [pscustomobject]@{ Dedicated = 0.0; Shared = 0.0; Total = 0.0; Local = 0.0; Luids = @{} }
    }
    $r = $map[$pid2]
    $r.Dedicated += [double]$e.DedicatedUsage
    $r.Shared += [double]$e.SharedUsage
    $r.Total += [double]$e.TotalCommitted
    $r.Local += [double]$e.LocalUsage
    $r.Luids[$m.Groups[2].Value] = [double]$e.TotalCommitted
  }
  return $map
}

function Get-ThreadSnap {
  param([int[]]$Pids)
  $rows = @{}
  $procStart = @{}
  try { $procs = @(Get-Process -Id $Pids -ErrorAction SilentlyContinue) } catch { return [pscustomobject]@{ Rows = $rows; ProcStart = $procStart } }
  foreach ($proc in $procs) {
    $p = [int]$proc.Id
    try { $procStart[$p] = $proc.StartTime } catch { $procStart[$p] = $null }
    try { $threads = @($proc.Threads) } catch { continue }
    foreach ($th in $threads) {
      $cpu = $null
      try { $cpu = $th.TotalProcessorTime.TotalMilliseconds } catch { continue }
      $st = $null
      try { $st = $th.StartTime } catch { $st = $null }
      $tid = [int]$th.Id
      $rows["$p/$tid"] = [pscustomobject]@{ Pid = $p; Tid = $tid; CpuMs = [double]$cpu; Start = $st }
    }
  }
  return [pscustomobject]@{ Rows = $rows; ProcStart = $procStart }
}

function Get-MainThread {
  param($Snap, [int]$ProcId)
  $c = @($Snap.Rows.Values | Where-Object { $_.Pid -eq $ProcId })
  if (-not $c.Count) { return $null }
  $withStart = @($c | Where-Object { $null -ne $_.Start } | Sort-Object { $_.Start })
  if ($withStart.Count) {
    $m = $withStart[0]
    $ps = $Snap.ProcStart[$ProcId]
    $src = 'earliest_starttime'
    if ($null -ne $ps -and [math]::Abs(($m.Start - $ps).TotalMilliseconds) -le 250) { $src = 'starttime' }
    return [pscustomobject]@{ Tid = $m.Tid; Source = $src }
  }
  $m = (@($c | Sort-Object { -$_.CpuMs }))[0]
  return [pscustomobject]@{ Tid = $m.Tid; Source = 'highest_cpu' }
}

function Get-ThreadSplit {
  # ⚠️ 参数名别用 $A/$B 之外的短名做循环变量：PowerShell 变量**大小写不敏感**，
  # `$b = $B.Rows[...]` 会把入参 $B 覆写成线程行，下一轮就"找不到属性 Rows"。
  param($SnapA, $SnapB, [int[]]$Pids)
  $out = @{}
  foreach ($p in $Pids) {
    $keys = @($SnapB.Rows.Keys | Where-Object { $_.StartsWith("$p/") })
    $sumNew = 0.0
    $sumGone = 0.0
    $n = 0
    $parts = @()
    foreach ($k in $keys) {
      $cur = $SnapB.Rows[$k]
      if ($SnapA.Rows.ContainsKey($k)) {
        $prev = $SnapA.Rows[$k]
        $d = $cur.CpuMs - $prev.CpuMs
        if ($d -lt 0) { $d = 0 }
        $sumNew += $d
        $n += 1
        $parts += [pscustomobject]@{ tid = $cur.Tid; cpu_ms = [math]::Round($d, 1); start = $cur.Start }
      } else {
        # 全生命周期都落在窗口内（上限），或快照漏看
        $sumNew += $cur.CpuMs
        $n += 1
        $parts += [pscustomobject]@{ tid = $cur.Tid; cpu_ms = [math]::Round($cur.CpuMs, 1); start = $cur.Start }
      }
    }
    foreach ($k in $SnapA.Rows.Keys) {
      if (-not $k.StartsWith("$p/")) { continue }
      if (-not $SnapB.Rows.ContainsKey($k)) { $sumGone += 0.0 }  # 死亡线程的最后一段无法恢复，靠 residual 兜
    }
    $main = Get-MainThread -Snap $SnapB -ProcId $p
    $mainMs = 0.0
    if ($main) {
      $mk = "$p/$($main.Tid)"
      if ($SnapB.Rows.ContainsKey($mk) -and $SnapA.Rows.ContainsKey($mk)) {
        $mainMs = $SnapB.Rows[$mk].CpuMs - $SnapA.Rows[$mk].CpuMs
        if ($mainMs -lt 0) { $mainMs = 0 }
      } elseif ($SnapB.Rows.ContainsKey($mk)) {
        $mainMs = $SnapB.Rows[$mk].CpuMs
      }
    }
    $out[$p] = [pscustomobject]@{
      SumMs = $sumNew; Count = $n; MainMs = $mainMs; MainTid = if ($main) { $main.Tid } else { 0 }
      MainSource = if ($main) { $main.Source } else { '' }
      Top = @($parts | Sort-Object { -$_.cpu_ms } | Select-Object -First 5)
    }
  }
  return $out
}

function Get-ProcRawSnap {
  param([int[]]$Pids)
  $want = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $Pids) { [void]$want.Add($p) }
  $map = @{}
  try {
    $rows = Get-CimInstance Win32_PerfRawData_PerfProc_Process -ErrorAction Stop
  } catch { return $map }
  foreach ($e in $rows) {
    $p = [int]$e.IDProcess
    if (-not $want.Contains($p)) { continue }
    $map[$p] = [pscustomobject]@{
      ReadBytes  = [double]$e.IOReadBytesPersec      # Raw 类里这是累计字节，不是速率
      WriteBytes = [double]$e.IOWriteBytesPersec
      OtherBytes = [double]$e.IOOtherBytesPersec
      ReadOps    = [double]$e.IOReadOperationsPersec
      WsPrivate  = [double]$e.WorkingSetPrivate
      Private    = [double]$e.PrivateBytes
      Threads    = [int]$e.ThreadCount
    }
  }
  return $map
}

# ── 状态断言：宿主 HTTP + diag JSONL + 窗口几何 ─────────────────────────────
function Get-DataDir {
  if ($env:DSH_WE_DATA_DIR) { return $env:DSH_WE_DATA_DIR }
  return (Join-Path $env:USERPROFILE '.dsh-wallpaper-engine')
}

function Resolve-HostPort {
  param([int]$HostPid, [int]$Explicit)
  if ($Explicit -gt 0) { return $Explicit }
  if ($HostPid -le 0) { return 0 }
  $cands = @()
  try { $cands = @(Get-NetTCPConnection -OwningProcess $HostPid -State Listen -ErrorAction SilentlyContinue) } catch { return 0 }
  foreach ($c in $cands) {
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/wallpaper-engine/settings" -f $c.LocalPort) -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200 -and $r.Content -match '"settings"') { return [int]$c.LocalPort }
    } catch { }
  }
  return 0
}

function Get-HostState {
  param([int]$Port)
  $st = [pscustomobject]@{
    ok = $false; settings_sha256 = ''; wallpaper_kind = ''; wallpaper_id = ''
    glass_row = ''; glass_enabled = $null; fps_cap = $null; motion_mode = ''
  }
  if ($Port -le 0) { return $st }
  $base = "http://127.0.0.1:$Port/wallpaper-engine"
  try {
    $r = Invoke-WebRequest -Uri "$base/settings" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($r.Content)
      $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
      $st.settings_sha256 = ($sha | ForEach-Object { $_.ToString('x2') }) -join ''
      $j = $r.Content | ConvertFrom-Json
      $st.wallpaper_id = [string]$j.settings.id
      if ($null -ne $j.settings.fpsCap) { $st.fps_cap = $j.settings.fpsCap }
      if ($null -ne $j.settings.glassMotionMode) { $st.motion_mode = [string]$j.settings.glassMotionMode }
      $st.ok = $true
    }
  } catch { }
  try {
    $r = Invoke-WebRequest -Uri "$base/glass-row-state" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
      $j = $r.Content | ConvertFrom-Json
      $st.glass_row = [string]$j.row
      $st.glass_enabled = [bool]$j.enabled
    }
  } catch { }
  if ($st.wallpaper_id) {
    try {
      $r = Invoke-WebRequest -Uri "$base/inventory" -TimeoutSec 5 -UseBasicParsing
      if ($r.StatusCode -eq 200) {
        $j = $r.Content | ConvertFrom-Json
        $hit = @($j.wallpapers | Where-Object { [string]$_.id -eq $st.wallpaper_id }) | Select-Object -First 1
        if ($hit) { $st.wallpaper_kind = [string]$hit.type }
      }
    } catch { }
  }
  return $st
}

function Read-DiagWindow {
  param([string]$Path, [long]$FromMs, [long]$ToMs)
  $out = [pscustomobject]@{ lines = 0; play_state = $null; last_playing = $null; hold = ''; hidden = $null; focus = $null; leaf = ''; beat = 0 }
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $out }
  try {
    $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  } catch { return $out }
  try {
    $len = $fs.Length
    $take = [Math]::Min(262144, $len)
    $fs.Position = $len - $take
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $txt = $sr.ReadToEnd()
  } finally { $fs.Dispose() }
  foreach ($line in ($txt -split "`n")) {
    if (-not $line.Trim()) { continue }
    if ($line.IndexOf('"t"') -lt 0) { continue }
    try { $o = $line | ConvertFrom-Json } catch { continue }
    if ($null -eq $o.t) { continue }
    $t = [long]$o.t
    if ($t -lt $FromMs -or $t -gt $ToMs) { continue }
    $out.lines += 1
    $msg = [string]$o.msg
    if ($msg -match 'play-state') {
      $out.play_state = $msg
      if ($msg -match 'playing=(true|false)') { $out.last_playing = ($Matches[1] -eq 'true') }
      if ($msg -match 'hold=(\S+)') { $out.hold = $Matches[1] } else { $out.hold = '' }
      if ($msg -match 'hidden=(\d)') { $out.hidden = [int]$Matches[1] }
      if ($msg -match 'focus=(\d)') { $out.focus = [int]$Matches[1] }
    }
    if ($msg -match 'onscreen') {
      if ($msg -match 'leaf=(VIDEO|IMG|CANVAS)') { $out.leaf = $Matches[1] }
    }
    if ($msg -match '\bbeat\b') { $out.beat += 1 }
  }
  return $out
}

function Get-RectParts([string]$rect) {
  $m = [regex]::Match([string]$rect, '^(-?\d+),(-?\d+) (\d+)x(\d+)$')
  if (-not $m.Success) { return $null }
  return [pscustomobject]@{
    x = [int]$m.Groups[1].Value; y = [int]$m.Groups[2].Value
    w = [int]$m.Groups[3].Value; h = [int]$m.Groups[4].Value
  }
}

# ── 单个相位 ───────────────────────────────────────────────────────────────
function Invoke-Phase {
  param([string]$Name, [int]$Root, [object[]]$Members, [int]$Dur, [int]$Warm,
        [string]$CoverStyle = 'tool', [int]$Port = 0, $HostBefore = $null)

  $pids = @($Members | ForEach-Object { [int]$_.Pid })
  $mainPid = (($Members | Where-Object { $_.Role -eq 'main' } | Select-Object -First 1).Pid)
  $mainHwnd = [IntPtr]::Zero
  if ($mainPid) { $mainHwnd = [WeBench]::FindMainWindow(@([int]$mainPid)) }
  $workArea = Get-RectParts ([WeBench]::WorkArea())

  $restore = $false
  $coverAreaFrac = 0.0
  $fgAttemptOk = $null
  $coverFocusOk = $null
  $invalid = New-Object System.Collections.Generic.List[string]
  $softWarn = New-Object System.Collections.Generic.List[string]
  switch ($Name) {
    'visible' {
      if ($mainHwnd -ne [IntPtr]::Zero) {
        [void][WeBench]::ShowWindow($mainHwnd, [WeBench]::SW_RESTORE)
        $fgAttemptOk = $false
        for ($i = 0; $i -lt 6; $i++) {
          if ([WeBench]::ForceForeground($mainHwnd)) { $fgAttemptOk = $true; break }
          Start-Sleep -Milliseconds 120
        }
        $restore = $true
      }
    }
    'covered' {
      if ($mainHwnd -ne [IntPtr]::Zero) {
        $winCmd = if ($MaximizeForCovered) { 3 } else { [WeBench]::SW_RESTORE }
        [void][WeBench]::ShowWindow($mainHwnd, $winCmd)
        Start-Sleep -Milliseconds 300
        $restore = $true
      }
      [WeBench]::ShowCover(($CoverStyle -eq 'normal'), $false)
      # 遮挡窗能不能抢到焦点决定了 Chromium 的 hidden 与 pauseOnCovered 这两条路走不走得通 ——
      # 不记下来，"遮挡相没暂停"到底是策略失效还是装置没摆成功就分不清（本轮真踩到）。
      if ($CoverTakeFocus) { $coverFocusOk = [WeBench]::ForceForeground([WeBench]::CoverHandle()) }
      $coverAreaFrac = 1.0
    }
    'minimized' {
      if ($mainHwnd -ne [IntPtr]::Zero) { [void][WeBench]::ShowWindow($mainHwnd, [WeBench]::SW_MINIMIZE) }
      $restore = $true
    }
    'partial-cover' {
      if ($mainHwnd -ne [IntPtr]::Zero) {
        [void][WeBench]::ShowWindow($mainHwnd, 3)   # SW_MAXIMIZE
        Start-Sleep -Milliseconds 300
        $restore = $true
      }
      $wa = if ($workArea) { $workArea } else { Get-RectParts ([WeBench]::RectOf($mainHwnd)) }
      if (-not $wa) { throw 'partial-cover: 取不到可用区/窗口矩形' }
      $cw = [int]$wa.w
      $ch = [int][Math]::Round($wa.h * $PartialCoverFrac)
      [WeBench]::ShowCoverRect(($CoverStyle -eq 'normal'), $false, [int]$wa.x, [int]$wa.y, $cw, $ch)
      if ($CoverTakeFocus) { $coverFocusOk = [WeBench]::ForceForeground([WeBench]::CoverHandle()) }
      $coverAreaFrac = [double]$PartialCoverFrac
    }
    'unfocused-visible' {
      if ($mainHwnd -ne [IntPtr]::Zero) {
        [void][WeBench]::ShowWindow($mainHwnd, 3)
        for ($i = 0; $i -lt 3; $i++) {
          if ([WeBench]::ForceForeground($mainHwnd)) { break }
          Start-Sleep -Milliseconds 120
        }
        $restore = $true
      }
      Start-Sleep -Milliseconds 250
      # 16×16 的置顶抢焦点窗：装置自身的合成成本≈0（这是 covered 的对照）
      [WeBench]::ShowCoverRect($false, $true, 0, 0, 16, 16)
      $coverAreaFrac = 0.0
    }
  }

  try {
    $iconicStart = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::IsIconic($mainHwnd) } else { $false }
    $fgStart = [WeBench]::Foreground()
    $phaseStartMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

    # 预热：先等"状态到位"（防抖/遮挡跟踪要 1.5–3s），再补足到 Warmup 下限
    $warmStart = Get-Date
    $converged = $false
    while (((Get-Date) - $warmStart).TotalSeconds -lt $WarmupMax) {
      [WeBench]::Pump()
      Start-Sleep -Milliseconds 150
      $elapsed = ((Get-Date) - $warmStart).TotalSeconds
      if ($elapsed -ge $Warm) {
        # visible / unfocused-visible：状态不需要"翻转"，等满预热下限即可（等信号会白等到上限）。
        if ($Name -ne 'minimized' -and $Name -ne 'covered') { $converged = $true; break }
        $dw = Read-DiagWindow -Path $diagPath -FromMs ($phaseStartMs - 2000) -ToMs ([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
        $got = if ($null -ne $dw.last_playing) { $dw.last_playing } else { $null }
        if ($Name -eq 'minimized') { if ($got -eq $false) { $converged = $true; break } }
        else { if ($got -ne $null -and $dw.hold) { $converged = $true; break } }
      }
    }
    $convergeMs = [int](((Get-Date) - $warmStart).TotalMilliseconds)

    # ── 边界快照（贵，只取两次）─────────────────────────────────────────────
    $thr0 = $null; $raw0 = $null; $mem0 = $null
    $procCpu0 = @{}; $procWs0 = @{}
    $tRead0 = NowTicks
    try { $procs = @(Get-Process -Id $pids -ErrorAction SilentlyContinue) } catch { $procs = @() }
    foreach ($proc in $procs) {
      $p = [int]$proc.Id
      $procCpu0[$p] = $proc.TotalProcessorTime.TotalMilliseconds
      $procWs0[$p] = $proc.WorkingSet64
    }
    if (-not $NoThreads) { $thr0 = Get-ThreadSnap -Pids $pids }
    $raw0 = Get-ProcRawSnap -Pids $pids
    $mem0 = Get-GpuMemByPid -Pids $pids
    # GPU 利用率是**差分**量：边界先取一次累计值当基线（首样本的 Δ 从这一刻开始算）
    $prevGpuRaw = Get-GpuRaw -Pids $pids
    $tRead0End = NowTicks

    # ── 采样循环（每拍三件便宜事，duty ≈7%）────────────────────────────────
    $samples = New-Object System.Collections.Generic.List[object]
    $gpuAcc = @{}
    $memMax = @{}
    $sampleCosts = New-Object System.Collections.Generic.List[double]
    $periods = New-Object System.Collections.Generic.List[double]
    $wallStart = NowTicks
    $lastTick = $wallStart
    while ((((NowTicks) - $wallStart) * 1000.0 / $SwFreq) -lt ($Dur * 1000)) {
      [WeBench]::Pump()
      $s0 = NowTicks
      $dtMs = (($s0 - $lastTick) * 1000.0 / $SwFreq)
      $gRawNow = Get-GpuRaw -Pids $pids
      $g = Measure-GpuPct -Cur $gRawNow -Prev $prevGpuRaw -WallMs ([Math]::Max(1.0, $dtMs))
      $prevGpuRaw = $gRawNow
      $mem = Get-GpuMemByPid -Pids $pids
      foreach ($k in $mem.Keys) {
        $tot = $mem[$k].Total
        if (-not $memMax.ContainsKey($k) -or $tot -gt $memMax[$k]) { $memMax[$k] = $tot }
      }
      $proc = @{}
      try { $ps = @(Get-Process -Id $pids -ErrorAction SilentlyContinue) } catch { $ps = @() }
      foreach ($x in $ps) { $proc[[int]$x.Id] = $x }
      $samples.Add([pscustomobject]@{ T = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Gpu = $g; Mem = $mem; Proc = $proc })
      foreach ($k in $g.Keys) {
        if (-not $gpuAcc.ContainsKey($k)) { $gpuAcc[$k] = [pscustomobject]@{ wsum = 0.0; w = 0.0; max = 0.0 } }
        $gpuAcc[$k].wsum += $g[$k].pct_3d * $dtMs
        $gpuAcc[$k].w += $dtMs
        if ($g[$k].pct_3d -gt $gpuAcc[$k].max) { $gpuAcc[$k].max = $g[$k].pct_3d }
      }
      $s1 = NowTicks
      $cost = (($s1 - $s0) * 1000.0 / $SwFreq)
      $sampleCosts.Add($cost)
      $periods.Add((($s1 - $lastTick) * 1000.0 / $SwFreq))
      $lastTick = $s1
      $sleep = $Interval - $cost
      if ($sleep -lt 50) { $sleep = 50 }
      Start-Sleep -Milliseconds ([int]$sleep)
    }
    $wallEnd = NowTicks
    $wallMs = ($wallEnd - $wallStart) * 1000.0 / $SwFreq

    # ── 结束边界快照 ───────────────────────────────────────────────────────
    $thr1 = $null; $raw1 = $null; $mem1 = $null
    try { $procs1 = @(Get-Process -Id $pids -ErrorAction SilentlyContinue) } catch { $procs1 = @() }
    $procCpu1 = @{}; $procWs1 = @{}
    foreach ($proc in $procs1) {
      $p = [int]$proc.Id
      $procCpu1[$p] = $proc.TotalProcessorTime.TotalMilliseconds
      $procWs1[$p] = $proc.WorkingSet64
    }
    if (-not $NoThreads) { $thr1 = Get-ThreadSnap -Pids $pids }
    $raw1 = Get-ProcRawSnap -Pids $pids
    $mem1 = Get-GpuMemByPid -Pids $pids
    $tRead1 = NowTicks
    $wallReadMs = ($tRead1 - $tRead0) * 1000.0 / $SwFreq

    $cores = [Environment]::ProcessorCount
    if ($wallReadMs -le 0) { $wallReadMs = 1 }
    $threadSplit = @{}
    if ($thr0 -and $thr1) { $threadSplit = Get-ThreadSplit -SnapA $thr0 -SnapB $thr1 -Pids $pids }

    $rows = @()
    foreach ($m in $Members) {
      $p = [int]$m.Pid
      $hasCpu = $procCpu0.ContainsKey($p) -and $procCpu1.ContainsKey($p)
      $d = 0.0
      if ($hasCpu) {
        $d = [double]$procCpu1[$p] - [double]$procCpu0[$p]
        if ($d -lt 0) { $d = 0 }
      }
      $gAvg = 0.0; $gMax = 0.0
      if ($gpuAcc.ContainsKey($p)) {
        $acc = $gpuAcc[$p]
        $gAvg = if ($acc.w -gt 0) { $acc.wsum / $acc.w } else { 0.0 }
        $gMax = $acc.max
      }
      $vramTotal = 0.0; $vramDed = 0.0; $vramShared = 0.0; $vramLocal = 0.0
      $luids = @{}
      if ($mem1.ContainsKey($p)) {
        $vramTotal = $mem1[$p].Total; $vramDed = $mem1[$p].Dedicated
        $vramShared = $mem1[$p].Shared; $vramLocal = $mem1[$p].Local
        $luids = $mem1[$p].Luids
      }
      $ioRead = 0.0; $ioWrite = 0.0; $ioOther = 0.0
      $wsPriv = $null; $privBytes = $null
      if ($raw0.ContainsKey($p) -and $raw1.ContainsKey($p)) {
        $ioRead = [Math]::Max(0.0, $raw1[$p].ReadBytes - $raw0[$p].ReadBytes)
        $ioWrite = [Math]::Max(0.0, $raw1[$p].WriteBytes - $raw0[$p].WriteBytes)
        $ioOther = [Math]::Max(0.0, $raw1[$p].OtherBytes - $raw0[$p].OtherBytes)
        $wsPriv = $raw1[$p].WsPrivate
        $privBytes = $raw1[$p].Private
      }
      $split = if ($threadSplit.ContainsKey($p)) { $threadSplit[$p] } else { $null }
      $residual = $null
      if ($split) { $residual = [math]::Round($d - $split.SumMs, 1) }
      $ws = if ($procWs1.ContainsKey($p)) { [double]$procWs1[$p] } else { 0.0 }
      $rows += [pscustomobject]@{
        pid              = $p
        role             = $m.Role
        cpu_ms           = [math]::Round($d, 1)
        cpu_pct_all      = [math]::Round($d / $wallReadMs / $cores * 100, 3)
        cpu_pct_core     = [math]::Round($d / $wallReadMs * 100, 2)
        cpu_main_ms      = if ($split) { [math]::Round($split.MainMs, 1) } else { $null }
        cpu_main_pct_core = if ($split) { [math]::Round($split.MainMs / $wallReadMs * 100, 2) } else { $null }
        cpu_workers_ms   = if ($split) { [math]::Round([Math]::Max(0.0, $split.SumMs - $split.MainMs), 1) } else { $null }
        cpu_threads_n    = if ($split) { $split.Count } else { $null }
        cpu_thread_residual_ms = $residual
        main_tid         = if ($split) { $split.MainTid } else { $null }
        main_source      = if ($split) { $split.MainSource } else { '' }
        ws_mb_end        = [math]::Round($ws / 1MB, 1)
        ws_private_mb_end = if ($null -ne $wsPriv) { [math]::Round($wsPriv / 1MB, 1) } else { $null }
        private_bytes_mb_end = if ($null -ne $privBytes) { [math]::Round($privBytes / 1MB, 1) } else { $null }
        vram_total_mb_end = [math]::Round($vramTotal / 1MB, 1)
        vram_dedicated_mb_end = [math]::Round($vramDed / 1MB, 1)
        vram_shared_mb_end = [math]::Round($vramShared / 1MB, 1)
        vram_max_mb      = if ($memMax.ContainsKey($p)) { [math]::Round($memMax[$p] / 1MB, 1) } else { $null }
        gpu_3d_avg       = [math]::Round($gAvg, 2)
        gpu_3d_max       = [math]::Round($gMax, 2)
        io_read_mb       = [math]::Round($ioRead / 1MB, 2)
        io_write_mb      = [math]::Round($ioWrite / 1MB, 2)
        io_other_mb      = [math]::Round($ioOther / 1MB, 2)
        threads_top      = if ($split) { @($split.Top) } else { @() }
      }
    }

    # ── 断言 ──────────────────────────────────────────────────────────────
    $rect = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::RectOf($mainHwnd) } else { '' }
    $rp = Get-RectParts $rect
    $maxFrac = 0.0
    if ($rp -and $workArea -and $workArea.w -gt 0 -and $workArea.h -gt 0) {
      $maxFrac = [Math]::Round(([double]$rp.w * $rp.h) / ([double]$workArea.w * $workArea.h), 3)
    }
    $iconicEnd = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::IsIconic($mainHwnd) } else { $false }
    $fgEnd = [WeBench]::Foreground()
    $hostAfter = if ($Port -gt 0) { Get-HostState -Port $Port } else { $null }
    $phaseEndMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $dw = Read-DiagWindow -Path $diagPath -FromMs ($phaseStartMs - 1000) -ToMs ($phaseEndMs + 500)

    # 前台看**起点**：构造后立刻取的那一帧才是"我们摆出来的状态"；相位末尾用户可能已经点走了。
    if ($Name -eq 'visible' -and $fgStart -ne $mainHwnd) {
      # ALT 轻敲之后仍拿不到前台 ⇒ 这一相位的读数不可信（壁纸可能正被 hidden 暂停）。
      $invalid.Add('foreground_not_acquired')
    }
    # 最大化：IsZoomed 是唯一 DPI 无关的直接判据；rect/可用区比值只作信息（本机会被 DPI 虚拟化）。
    $zoomed = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::IsZoomed($mainHwnd) } else { $false }
    if (($Name -eq 'covered' -or $Name -eq 'partial-cover') -and -not $zoomed) { $invalid.Add('window_not_maximized') }
    if ($Name -eq 'minimized' -and -not $iconicEnd) { $invalid.Add('not_iconic') }
    if ($hostBefore -and $hostAfter -and $hostBefore.settings_sha256 -and $hostAfter.settings_sha256 -and $hostBefore.settings_sha256 -ne $hostAfter.settings_sha256) {
      $invalid.Add('settings_changed_mid_phase')
    }
    # visible 相位必须确认"壁纸真的在播"：被别的窗口盖住时 Chromium 会判 hidden ⇒
    # pauseOnHidden 把播放停掉 ⇒ 量出来的是"暂停态"（实测踩过：整批读数掉到 0.18 单核%）。
    if ($Name -eq 'visible' -and $dw.last_playing -eq $false) { $invalid.Add('playback_not_running') }
    if ($samples.Count -lt 3) { $invalid.Add('too_few_samples') }
    $avgCost = if ($sampleCosts.Count) { ($sampleCosts | Measure-Object -Average).Average } else { 0 }
    if ($avgCost -gt ($Interval * 0.5)) { $invalid.Add('sample_cost_over_budget') }

    $rec = [pscustomobject]@{
      phase        = $Name
      valid        = ($invalid.Count -eq 0)
      invalid_reasons = @($invalid)
      warnings     = @($softWarn)
      converged    = $converged
      converge_ms  = $convergeMs
      seconds      = $Dur
      warmup_s     = $Warm
      samples      = $samples.Count
      interval_ms  = $Interval
      wall_ms      = [math]::Round($wallReadMs, 0)
      cores        = $cores
      sample_cost_ms = [pscustomobject]@{
        avg = [math]::Round($avgCost, 1)
        max = if ($sampleCosts.Count) { [math]::Round(($sampleCosts | Measure-Object -Maximum).Maximum, 1) } else { 0 }
        duty_cycle = [math]::Round($avgCost / $Interval, 3)
      }
      construct    = [pscustomobject]@{
        cover_style = if ($Name -eq 'covered' -or $Name -eq 'partial-cover' -or $Name -eq 'unfocused-visible') { $CoverStyle } else { '' }
        cover_area_frac = [math]::Round($coverAreaFrac, 2)
        cover_takes_focus = [bool]$CoverTakeFocus
        fg_forced_ok = $fgAttemptOk
        cover_focus_ok = $coverFocusOk
        partial_frac = $PartialCoverFrac
        maximized_area_frac = $maxFrac
      }
      window       = [pscustomobject]@{
        rect_start = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::RectOf($mainHwnd) } else { '' }
        rect_end = $rect
        iconic_start = $iconicStart
        iconic_end = $iconicEnd
        zoomed_end = $zoomed
        fg_is_main_start = ($fgStart -eq $mainHwnd)
        fg_is_main_end = ($fgEnd -eq $mainHwnd)
      }
      host         = if ($hostAfter) { $hostAfter } else { $null }
      diag         = $dw
      rows         = $rows
    }
    return $rec
  }
  finally {
    [WeBench]::HideCover()
    if ($restore -and $mainHwnd -ne [IntPtr]::Zero) {
      [void][WeBench]::ShowWindow($mainHwnd, [WeBench]::SW_RESTORE)
      [void][WeBench]::ForceForeground($mainHwnd)
    }
  }
}

# ── 主流程 ─────────────────────────────────────────────────────────────────
$tree = Resolve-DshTree -Root $RootPid
$root = [int]$tree.RootPid
$hostMember = $tree.Members | Where-Object { $_.Role -eq 'host' } | Select-Object -First 1
$hostPid = if ($hostMember) { [int]$hostMember.Pid } else { 0 }
$port = if ($NoHttp) { 0 } else { Resolve-HostPort -HostPid $hostPid -Explicit $HostPort }
$diagPath = Join-Path (Join-Path (Get-DataDir) 'diag') 'http.jsonl'

Write-Host "DSH 根进程 $root，树内 $($tree.Members.Count) 个进程，host pid=$hostPid，HTTP 端口=$port"
$tree.Members | ForEach-Object {
  Write-Host ("  {0,7}  {1,-18} {2}" -f $_.Pid, $_.Role, ($_.CommandLine.Substring(0, [Math]::Min(100, $_.CommandLine.Length))))
}
if (-not (Test-Path -LiteralPath $diagPath)) { Write-Warning "找不到 diag 文件：$diagPath（状态断言会缺 play-state）" }

if ($DryRun) {
  foreach ($ph in $Phases) {
    $d = if ($Seconds -gt 0) { $Seconds } else { [int]$PhaseSeconds[$ph] }
    Write-Host "would run phase $ph for ${d}s (warmup ${Warmup}s..${WarmupMax}s)"
  }
  exit 0
}

$hostBefore = if ($port -gt 0) { Get-HostState -Port $port } else { $null }
$gpuAdapters = @()
try {
  $gpuAdapters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{ name = $_.Name; dedicated_mb = [math]::Round([double]$_.DedicatedUsage / 1MB, 1);
                                        shared_mb = [math]::Round([double]$_.SharedUsage / 1MB, 1);
                                        total_committed_mb = [math]::Round([double]$_.TotalCommitted / 1MB, 1) } })
} catch { }

$run = [pscustomobject]@{
  schema   = 'dsh-we-perf-bench/2'
  label    = $Label
  note     = $Note
  machine  = [pscustomobject]@{
    host        = $env:COMPUTERNAME
    os          = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    cores       = [Environment]::ProcessorCount
    ps          = $PSVersionTable.PSVersion.ToString()
    generated   = (Get-Date).ToString('o')
    work_area   = [WeBench]::WorkArea()
    gpu_adapters = $gpuAdapters
    diag_file   = $diagPath
  }
  root_pid = $root
  host     = $hostBefore
  members  = $tree.Members
  phases   = @()
  warnings = @()
}
$hadAny = $false
$anyInvalid = $false
for ($r = 1; $r -le $Repeat; $r++) {
  foreach ($ph in $Phases) {
    $dur = if ($Seconds -gt 0) { $Seconds } else { [int]$PhaseSeconds[$ph] }
    Write-Host "`n── 相位 $ph（第 $r/$Repeat 轮，采样 ${dur}s，预热 ${Warmup}s..${WarmupMax}s）──"
    try {
      $live = Resolve-DshTree -Root $root
      $res = Invoke-Phase -Name $ph -Root $root -Members $live.Members -Dur $dur -Warm $Warmup `
        -CoverStyle $CoverStyle -Port $port -HostBefore $hostBefore
      $res | Add-Member -NotePropertyName run -NotePropertyValue $r -Force
      $run.phases += $res
      $hadAny = $true
      if (-not $res.valid) { $anyInvalid = $true }
      $agg = $res.rows | Group-Object role | ForEach-Object {
        $items = @($_.Group)
        [pscustomobject]@{
          role      = $_.Name
          cpu_core  = [math]::Round((SumOf $items 'cpu_pct_core'), 2)
          cpu_main  = [math]::Round((SumOf $items 'cpu_main_pct_core'), 2)
          cpu_ms    = [math]::Round((SumOf $items 'cpu_ms'), 0)
          ws_priv   = [math]::Round((SumOf $items 'ws_private_mb_end'), 1)
          vram_mb   = [math]::Round((SumOf $items 'vram_total_mb_end'), 1)
          gpu_3d    = [math]::Round((SumOf $items 'gpu_3d_avg'), 2)
          io_read   = [math]::Round((SumOf $items 'io_read_mb'), 2)
          io_write  = [math]::Round((SumOf $items 'io_write_mb'), 2)
        }
      } | Sort-Object role
      $res | Add-Member -NotePropertyName aggregate -NotePropertyValue $agg -Force
      $agg | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
      if (-not $res.valid) { Write-Warning ("相位 {0} 无效：{1}" -f $ph, ($res.invalid_reasons -join ', ')) }
    } catch {
      $where = ($_.ScriptStackTrace -split "`n" | Select-Object -First 3) -join ' <- '
      Write-Warning "相位 $ph 失败：$($_.Exception.Message)  @ $where"
      $run.warnings += "phase $ph failed: $($_.Exception.Message) @ $where"
    }
  }
}

if (-not $hadAny) { Write-Error '没有任何相位拿到样本'; exit 1 }

# 还原自检：跑完必须把用户的桌面还回去
$restoreOk = $true
$restoreErr = @()
try {
  $mainLeft = [WeBench]::FindMainWindow(@(($tree.Members | Where-Object { $_.Role -eq 'main' }).Pid))
  if ($mainLeft -ne [IntPtr]::Zero -and [WeBench]::IsIconic($mainLeft)) { $restoreOk = $false; $restoreErr += 'main_still_iconic' }
} catch { }
$run | Add-Member -NotePropertyName restore -NotePropertyValue ([pscustomobject]@{ ok = $restoreOk; errors = @($restoreErr) }) -Force

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$jsonPath = Join-Path $OutDir ("{0}-{1}.json" -f $Label, $stamp)
$json = $run | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# Markdown 摘要（直接可贴进 docs/perf/MEASUREMENTS.md）
Write-Host "`n## $Label（$($run.machine.generated)）"
Write-Host ''
Write-Host '| 相位 | 角色 | CPU 主线程%(单核) | CPU 工作线程%(单核) | GPU 3D% | 显存 MB | 私有 WS MB | I/O 读/写 MB |'
Write-Host '|---|---|---:|---:|---:|---:|---:|---:|'
foreach ($p in $run.phases) {
  if (-not $p.PSObject.Properties['aggregate']) { continue }
  foreach ($a in $p.aggregate) {
    $w = if ($null -ne $a.cpu_main) { $a.cpu_main } else { '-' }
    $workers = if ($null -ne $a.cpu_main) { [math]::Round($a.cpu_core - $a.cpu_main, 2) } else { '-' }
    Write-Host ("| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7}/{8} |" -f `
      $p.phase, $a.role, $w, $workers, $a.gpu_3d, $a.vram_mb, $a.ws_priv, $a.io_read, $a.io_write)
  }
}
Write-Host ''
Write-Host '| 相位 | 有效 | samples | 采样成本 ms(占空比) | 姿态 iconic/fg | 最大化占比 | diag playing/hold | 壁纸 |'
Write-Host '|---|---|---:|---:|---|---:|---|---|'
foreach ($p in $run.phases) {
  $pose = "{0}/{1}" -f $p.window.iconic_end, $p.window.fg_is_main_end
  $hold = if ($p.diag.hold) { $p.diag.hold } else { '-' }
  $kind = if ($p.host) { $p.host.wallpaper_kind } else { '-' }
  Write-Host ("| {0} | {1} | {2} | {3} ({4}) | {5} | {6} | {7}/{8} | {9} |" -f `
    $p.phase, $p.valid, $p.samples, $p.sample_cost_ms.avg, $p.sample_cost_ms.duty_cycle, `
    $pose, $p.construct.maximized_area_frac, $p.diag.last_playing, $hold, $kind)
}
Write-Host "`n结果已写入：$jsonPath"
if ($anyInvalid) { exit 1 }
exit 0
