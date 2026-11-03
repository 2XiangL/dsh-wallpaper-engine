<#
perf-bench.ps1 —— **真机相位基准装置**（手动工具，不进 `npm run verify` 链）。

回答的问题：**装上这套插件之后，DSH 到底多花了多少 CPU / GPU / 内存？停掉壁纸又剩多少？**
单元守卫证明"贵操作变少了"，这个装置量的是**进程真的花掉的时间与显存/内存**。

## 为什么按相位量

同一个应用在不同状态下的成本差一到两个数量级（可见播放 / 被遮挡 / 最小化）。只报一个
平均数等于什么都没说：dynapaper 的基准（`scripts/bench.ps1`）也是按相位分别取样的。
本装置提供三种**可脚本复现**的相位：

| 相位 | 怎么造 | 回答什么 |
|---|---|---|
| `visible` | 还原并置前主窗，界面静止 | 可见播放时的真实成本（最重要的一档） |
| `covered` | 自建置顶无边框黑窗盖住整个虚拟屏 | 整窗被遮挡时策略是否真的把开销打到 0 |
| `minimized` | `ShowWindow(SW_MINIMIZE)` | 最小化档（与遮挡档分开算：Chromium 对两者的节流路径不同） |

"无壁纸 / 静态图 / 视频 / 场景"四档**不在本脚本的自动化范围**：那要改插件设置，属人操作。
先按目标档位摆好壁纸，再用 `-Label` 标记这一次运行（例如 `-Label video` / `-Label image`）。
可归因口径 = 同一进程树内「有壁纸 − 无壁纸」，见 docs/perf/MEASUREMENTS.md。

## 计量口径

- **进程树**：从 DSH 根进程（无 `--type=` 且父进程不是 DSH 的那个）递归取子孙，
  按 `--type=` 与命令行分角色：`gpu` / `renderer` / `utility` / `host`(=dsh-desktop-host) /
  `plugin-child`(媒体中间件 / ffmpeg / 插件子服务)。**只算这棵树**，不把用户其它 Electron 应用算进来。
- **CPU**：`TotalProcessorTime` 前后差分 ⇒ `Δms / (Δwall × 逻辑核) × 100`，同时给原始 `cpu_ms`
  （低负载相位里只有毫秒数有意义）。另给"占单核百分比"（`Δms / Δwall × 100`）便于跨机器比较。
- **内存**：`WorkingSet64` 的**相位末值**（工作集回收是延迟发生的，取均值会掩盖它）。
- **GPU**：`Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` 按 `engtype_3D` 求和、
  按 `pid_<n>_` 精确切 pid（**不能用 like `*pid_12*`**：会把 `pid_123` 算进 `pid_12`）。这是
  该进程的瞬时占用，采样期间每秒取一次、报均值。
- **预热**：每相位先等 `-Warmup` 秒再开始采样（着色器编译 / 首帧 JIT / 遮挡跟踪的 2–3s 纠正窗都
  落在预热里，混进来会污染结论）。

## 用法

```powershell
# 基线：可见 60s + 遮挡 20s + 最小化 20s
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label baseline-video

# 只看可见档，3 次重复
pwsh -NoProfile -File test/tools/perf-bench.ps1 -Label after -Phases visible -Repeat 3

# 指定根进程 / 结果目录
pwsh -NoProfile -File test/tools/perf-bench.ps1 -RootPid 17936 -OutDir D:\perf
```

**会短暂覆盖/最小化 DSH 窗口**（遮挡档与最小化档各若干秒，结束时必定还原）。不要在
正在用机 / 开会演示时跑。脚本在 `finally` 里还原窗口并销毁遮挡窗；被 Ctrl+C 打断也走 `finally`。

输出：`<OutDir>\<Label>-<yyyyMMdd-HHmmss>.json`（逐秒样本 + 聚合）与终端上的 Markdown 表。
默认 `OutDir = <repo>/.test-cache/perf`（`.test-cache/` 已在 .gitignore 里）。

退出码：0 = 至少一个相位拿到了完整样本；1 = 装置失败（进程树/采样异常）；2 = 用法错误。
#>
[CmdletBinding()]
param(
  [string]$Label = 'run',
  [string[]]$Phases = @('visible', 'covered', 'minimized'),
  [int]$Seconds = 0,                 # 0 = 按相位默认（visible 60s，其余 20s）
  [int]$Warmup = 10,
  [int]$Repeat = 1,
  [int]$Interval = 1000,             # 采样间隔 ms
  [int]$RootPid = 0,
  # covered 相位默认先把窗口**最大化**：遮挡代理（pauseOnCovered）要求窗口铺满可用区 ≥98%，
  # 不最大化就永远不会触发，量到的是"没暂停"的旧行为。
  [bool]$MaximizeForCovered = $true,
  [ValidateSet('tool', 'normal')]
  [string]$CoverStyle = 'tool',
  # 遮挡窗是否**抢焦点**。真实场景里盖住 DSH 的是别的应用 ⇒ 焦点必然离开；只有焦点离开，
  # pauseOnCovered 才可能成立。默认开（要测"不抢焦点"的旧行为时传 -CoverTakeFocus:$false）。
  [bool]$CoverTakeFocus = $true,
  [string]$OutDir = '',
  [string]$Note = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── 仓库根（本脚本在 test/tools/ 下）────────────────────────────────────────
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot '.test-cache\perf' }

$PhaseSeconds = @{ visible = 60; covered = 20; minimized = 20 }
# `pwsh -File x.ps1 -Phases visible,covered` 会把整串当成**一个**字符串（-File 参数绑定
# 不做逗号拆分），所以这里自己拆一次：`-Phases visible,covered` 与
# `-Phases visible -Phases covered` 两种写法都成立。
$Phases = @($Phases | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($p in $Phases) {
  if (-not $PhaseSeconds.ContainsKey($p)) {
    Write-Error "未知相位：$p（可选：$($PhaseSeconds.Keys -join ', ')）"
    exit 2
  }
}

# ── Win32 / 遮挡窗（纯 Win32，不依赖 WinForms/MTA）──────────────────────────
if (-not ('WeBench' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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

    /// <summary>把窗口强行拉到前台（前台锁的标准绕法：挂到当前前台线程的输入队列上再 Set）。</summary>
    public static bool ForceForeground(IntPtr h)
    {
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint me = GetCurrentThreadId();
        bool ok = false;
        try { AttachThreadInput(me, fgThread, true); ok = SetForegroundWindow(h); }
        finally { AttachThreadInput(me, fgThread, false); }
        return ok;
    }

    public const int SW_RESTORE = 9;
    public const int SW_MINIMIZE = 6;
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

    private static IntPtr _cover = IntPtr.Zero;
    private static bool _classReady;

    /// <summary>最大可见顶层窗口（按面积）：被 DSH 的主窗通常就是它。</summary>
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

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    /// <summary>
    /// 建一块覆盖整个虚拟屏的置顶黑窗。
    /// `normal=true` 时是**普通顶层窗**（不抢焦点、仍进 Alt+Tab 之外的工具窗属性去掉）——
    /// Chromium 的窗口遮挡跟踪（WindowOcclusionTracker）是否把这块窗算作"遮挡者"，
    /// 决定了 covered 相位能不能真的把页面判成 hidden。两种形态都能覆盖，**语义不同**，
    /// 所以做成可选项并在报告里标出来，不要拿一种形态的结论去套另一种。
    /// </summary>
    public static void ShowCover(bool normal, bool takeFocus = false)
    {
        if (_cover != IntPtr.Zero) return;
        if (!_classReady)
        {
            WNDCLASS wc = new WNDCLASS();
            wc.lpfnWndProc = (IntPtr)(-1); // 占位：下面换成真委托
            _wcProc = new WndProcDelegate(DefWinProc);
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wcProc);
            wc.hbrBackground = (IntPtr)4; // BLACK_BRUSH（stock object）
            wc.lpszClassName = "WeBenchCoverWnd";
            RegisterClassW(ref wc);       // 已注册过会失败，忽略
            _classReady = true;
        }
        int x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        int exStyle = WS_EX_TOPMOST | (takeFocus ? 0 : WS_EX_NOACTIVATE) | (normal ? 0 : WS_EX_TOOLWINDOW);
        _cover = CreateWindowExW(exStyle,
            "WeBenchCoverWnd", "we-perf-cover", WS_POPUP | WS_VISIBLE, x, y, w, h,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        ShowWindow(_cover, 5 /* SW_SHOW */);
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

    /// <summary>抽干消息队列：遮挡窗要活着就必须有人泵消息（本装置在采样循环里调）。</summary>
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

# 进程树（WMI 一次取全量，避免每进程一次查询）
function Get-ProcessSnapshotRows {
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Select-Object ProcessId, ParentProcessId, CommandLine
}

function Get-RoleOf([string]$cmd, [int]$parentPid, [int]$rootPid) {
  if ($parentPid -eq $rootPid) {
    if ($cmd -match '--type=gpu-process') { return 'gpu' }
    if ($cmd -match '--type=renderer') { return 'renderer' }
    if ($cmd -match '--type=utility') { return 'utility' }
    if ($cmd -match 'dsh-desktop-host') { return 'host' }
    return 'main'
  }
  if ($cmd -match 'ffmpeg|media-bridge|we-audio-tap') { return 'plugin-child' }
  if ($cmd -match 'server\.mjs|mcp\\server|runner\.js|dist\\media') { return 'plugin-child' }
  return 'other'
}

function Resolve-DshTree {
  param([int]$Root)
  $rows = @(Get-ProcessSnapshotRows)
  if (-not $rows.Count) { throw '找不到 "DeepSeek Harness.exe" 进程：DSH 没在跑？' }

  $byId = @{}
  foreach ($r in $rows) { $byId[[int]$r.ProcessId] = $r }

  if ($Root -le 0) {
    # 根 = 父进程不是 DSH 的那个（主进程由 explorer/快捷方式拉起；宿主进程的父是主进程）
    $rootRow = $rows | Where-Object { -not $byId.ContainsKey([int]$_.ParentProcessId) } |
      Sort-Object { [int]$_.ProcessId } | Select-Object -First 1
    if (-not $rootRow) { throw '推断不出 DSH 根进程：请用 -RootPid 指定' }
    $Root = [int]$rootRow.ProcessId
  }
  if (-not $byId.ContainsKey($Root)) { throw "RootPid=$Root 不在 DSH 进程集合里" }

  # 递归取子孙
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

function Get-GpuByPid {
  param([int[]]$Pids)
  $map = @{}
  try {
    $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop
  } catch { return $map }
  $want = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $Pids) { [void]$want.Add($p) }
  foreach ($e in $eng) {
    $name = [string]$e.Name
    if ($name -notmatch 'engtype_3D') { continue }
    $m = [regex]::Match($name, 'pid_(\d+)_')
    if (-not $m.Success) { continue }
    $pid2 = [int]$m.Groups[1].Value
    if (-not $want.Contains($pid2)) { continue }
    $v = 0.0
    try { $v = [double]$e.UtilizationPercentage } catch { $v = 0.0 }
    if (-not $map.ContainsKey($pid2)) { $map[$pid2] = 0.0 }
    $map[$pid2] = [double]$map[$pid2] + $v
  }
  return $map
}

function Sample-Once {
  param([int[]]$Pids)
  $cpu = @{}
  $ws = @{}
  foreach ($p in $Pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) {
      $cpu[$p] = $proc.TotalProcessorTime.TotalMilliseconds
      $ws[$p] = $proc.WorkingSet64
    }
  }
  return [pscustomobject]@{ T = (Get-Date); CpuMs = $cpu; Ws = $ws; Gpu = (Get-GpuByPid -Pids $Pids) }
}

function Invoke-Phase {
  param([string]$Name, [int]$Root, [object[]]$Members, [int]$Dur, [int]$Warm, [string]$CoverStyle = 'tool')

  $pids = @($Members | ForEach-Object { [int]$_.Pid })
  $mainHwnd = [IntPtr]::Zero
  $mainPid = ($Members | Where-Object { $_.Role -eq 'main' } | Select-Object -First 1).Pid
  if ($mainPid) { $mainHwnd = [WeBench]::FindMainWindow(@([int]$mainPid)) }

  $restore = $false
  switch ($Name) {
    'visible' {
      if ($mainHwnd -ne [IntPtr]::Zero) {
        [void][WeBench]::ShowWindow($mainHwnd, [WeBench]::SW_RESTORE)
        [void][WeBench]::SetForegroundWindow($mainHwnd)
        $restore = $true
      }
    }
    'covered' {
      if ($mainHwnd -ne [IntPtr]::Zero) {
        $winCmd = if ($MaximizeForCovered) { 3 } else { [WeBench]::SW_RESTORE }
        [void][WeBench]::ShowWindow($mainHwnd, $winCmd)
        $restore = $true
      }
      [WeBench]::ShowCover($CoverStyle -eq 'normal')  # 焦点由下面的 ForceForeground 处理
      if ($CoverTakeFocus) { [void][WeBench]::ForceForeground([WeBench]::CoverHandle()) }
    }
    'minimized' {
      if ($mainHwnd -ne [IntPtr]::Zero) { [void][WeBench]::ShowWindow($mainHwnd, [WeBench]::SW_MINIMIZE) }
      $restore = $true
    }
  }

  try {
    # 相位状态**要落地成可复核的事实**：遮挡/最小化的"到底生效了没"不能靠猜 ——
    # 一次 ShowWindow 被忽略（前台进程不是自己、窗口被壳层接管）就会把整个相位量成假的。
    $iconicStart = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::IsIconic($mainHwnd) } else { $false }
    $fgStart = [WeBench]::Foreground();

    # 预热：先让状态稳定（遮挡跟踪 2–3s 才收敛，着色器/JIT 也在这段里）
    $warmEnd = (Get-Date).AddSeconds($Warm)
    while ((Get-Date) -lt $warmEnd) { [WeBench]::Pump(); Start-Sleep -Milliseconds 100 }

    $cpu0 = Sample-Once -Pids $pids
    $samples = New-Object System.Collections.Generic.List[object]
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt $Dur) {
      [WeBench]::Pump()
      $s = Sample-Once -Pids $pids
      $samples.Add($s)
      Start-Sleep -Milliseconds $Interval
    }
    $cpu1 = Sample-Once -Pids $pids
    $wallMs = ((Get-Date) - $t0).TotalMilliseconds
    if ($wallMs -le 0) { $wallMs = 1 }
    $cores = [Environment]::ProcessorCount

    $rows = @()
    foreach ($m in $Members) {
      $p = [int]$m.Pid
      if (-not $cpu0.CpuMs.ContainsKey($p) -or -not $cpu1.CpuMs.ContainsKey($p)) { continue }
      $d = [double]$cpu1.CpuMs[$p] - [double]$cpu0.CpuMs[$p]
      $g = 0.0; $n = 0
      foreach ($s in $samples) { if ($s.Gpu.ContainsKey($p)) { $g += [double]$s.Gpu[$p]; $n++ } }
      $rows += [pscustomobject]@{
        pid          = $p
        role         = $m.Role
        cpu_ms       = [math]::Round($d, 1)
        cpu_pct_all  = [math]::Round($d / $wallMs / $cores * 100, 3)
        cpu_pct_core = [math]::Round($d / $wallMs * 100, 2)
        ws_mb_end    = [math]::Round([double]$cpu1.Ws[$p] / 1MB, 1)
        ws_mb_start  = [math]::Round([double]$cpu0.Ws[$p] / 1MB, 1)
        gpu_3d_avg   = [math]::Round(($(if ($n) { $g / $n } else { 0 })), 2)
      }
    }

    return [pscustomobject]@{
      phase       = $Name
      seconds     = $Dur
      warmup_s    = $Warm
      samples     = $samples.Count
      wall_ms     = [math]::Round($wallMs, 0)
      cores       = $cores
      main_window = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::RectOf($mainHwnd) } else { '' }
      main_iconic_start = $iconicStart
      main_iconic_end = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::IsIconic($mainHwnd) } else { $false }
      fg_is_main = ($fgStart -eq $mainHwnd)
      main_rect_end = if ($mainHwnd -ne [IntPtr]::Zero) { [WeBench]::RectOf($mainHwnd) } else { '' }
      cover_style = if ($Name -eq 'covered') { $CoverStyle } else { '' }
      rows        = $rows
    }
  }
  finally {
    [WeBench]::HideCover()
    if ($restore -and $mainHwnd -ne [IntPtr]::Zero) {
      [void][WeBench]::ShowWindow($mainHwnd, [WeBench]::SW_RESTORE)
      [void][WeBench]::SetForegroundWindow($mainHwnd)
    }
  }
}

# ── 主流程 ─────────────────────────────────────────────────────────────────
$tree = Resolve-DshTree -Root $RootPid
$root = [int]$tree.RootPid
Write-Host "DSH 根进程 $root，树内 $($tree.Members.Count) 个进程："
$tree.Members | ForEach-Object { Write-Host ("  {0,7}  {1,-12} {2}" -f $_.Pid, $_.Role, ($_.CommandLine.Substring(0, [Math]::Min(110, $_.CommandLine.Length)))) }

if ($DryRun) {
  foreach ($ph in $Phases) { Write-Host "would run phase $ph for $($(if ($Seconds -gt 0) { $Seconds } else { $PhaseSeconds[$ph] }))s (warmup ${Warmup}s)" }
  exit 0
}

$run = [pscustomobject]@{
  schema    = 'dsh-we-perf-bench/1'
  label     = $Label
  note      = $Note
  machine   = [pscustomobject]@{
    host      = $env:COMPUTERNAME
    os        = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    cores     = [Environment]::ProcessorCount
    ps        = $PSVersionTable.PSVersion.ToString()
    generated = (Get-Date).ToString('o')
  }
  root_pid  = $root
  members   = $tree.Members
  phases    = @()
}

$hadAny = $false
for ($r = 1; $r -le $Repeat; $r++) {
  foreach ($ph in $Phases) {
    $dur = if ($Seconds -gt 0) { $Seconds } else { [int]$PhaseSeconds[$ph] }
    Write-Host "`n── 相位 $ph（第 $r/$Repeat 轮，采样 ${dur}s，预热 ${Warmup}s）──"
    try {
      $res = Invoke-Phase -Name $ph -Root $root -Members $tree.Members -Dur $dur -Warm $Warmup -CoverStyle $CoverStyle
      $res | Add-Member -NotePropertyName run -NotePropertyValue $r -Force
      $run.phases += $res
      $hadAny = $true
      $agg = $res.rows | Group-Object role | ForEach-Object {
        [pscustomobject]@{
          role    = $_.Name
          cpu_all = [math]::Round((($_.Group | Measure-Object cpu_pct_all -Sum).Sum), 3)
          cpu_core = [math]::Round((($_.Group | Measure-Object cpu_pct_core -Sum).Sum), 2)
          cpu_ms  = [math]::Round((($_.Group | Measure-Object cpu_ms -Sum).Sum), 0)
          ws_mb   = [math]::Round((($_.Group | Measure-Object ws_mb_end -Sum).Sum), 1)
          gpu_3d  = [math]::Round((($_.Group | Measure-Object gpu_3d_avg -Sum).Sum), 2)
        }
      } | Sort-Object role
      $res | Add-Member -NotePropertyName aggregate -NotePropertyValue $agg -Force
      $agg | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
    } catch {
      Write-Warning "相位 $ph 失败：$($_.Exception.Message)"
    }
  }
}

if (-not $hadAny) { Write-Error '没有任何相位拿到样本'; exit 1 }

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$jsonPath = Join-Path $OutDir ("{0}-{1}.json" -f $Label, $stamp)
$run | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding utf8

# Markdown 摘要（直接可贴进 docs/perf/MEASUREMENTS.md）
Write-Host "`n## $Label（$($run.machine.generated)）"
Write-Host ''
Write-Host '| 相位 | 角色 | CPU %(全核) | CPU %(单核) | CPU ms | 工作集 MB | GPU 3D % |'
Write-Host '|---|---|---:|---:|---:|---:|---:|'
foreach ($p in $run.phases) {
  foreach ($a in $p.aggregate) {
    Write-Host ("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |" -f $p.phase, $a.role, $a.cpu_all, $a.cpu_core, $a.cpu_ms, $a.ws_mb, $a.gpu_3d)
  }
}
Write-Host "`n结果已写入：$jsonPath"



