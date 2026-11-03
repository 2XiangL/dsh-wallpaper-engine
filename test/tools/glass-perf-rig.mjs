/**
 * glass-perf-rig.mjs —— **真浏览器里量"玻璃配方"成本的吞吐对照装置**（手动工具，不进
 * `npm run verify` 链；装置形状与 `fx-perf-rig.mjs` 同源）。
 *
 * 回答的问题：**逐面 `backdrop-filter` 到底吃掉多少合成吞吐？换成近不透明纯色能拿回多少？**
 *
 * ## 为什么按"吞吐"而不是"帧间隔"量
 *
 * 第一版按 rAF 帧间隔量，结论是"两套配方都是 16.7ms、没有差异" —— 那**不是玻璃不贵**，
 * 而是**装置没牙**：有 vsync 时只要 GPU 有余量，贵的那一档也照样 60fps，差值被帧率上限
 * 吃掉了。所以本装置关掉帧率上限（`--disable-frame-rate-limit --disable-gpu-vsync`），
 * 让"每帧成本"直接变成"每秒能画多少帧"：**成本越低，帧数越高**。三档配方给出的是
 * 一条曲线（full → light → off），比两点 A/B 更能说明"钱花在哪一层"。
 *
 * ## 三档配方
 *
 * | id | backdrop-filter | 底色 | 对应实现 |
 * |---|---|---|---|
 * | `full`  | `blur(16px) saturate(1.8) brightness(1.04)` | 22% 白釉 | **现状**（`packages/glass/src/glass-css.js` 的气泡/输入卡载体） |
 * | `light` | `none` | 92% 近不透明 | 改造后「动壁纸降级」（Phase 3 配方） |
 * | `off`   | `none` | 100% 不透明 | 玻璃整行停用（成本下界） |
 *
 * `full` 的表达式是从 CSS 抄来的；改 `glass-css.js` 的载体必须同步这里，
 * `--check-css` 会做一次粗对齐（抄错了量的是别的系统）。
 *
 * ## 局限（结论必须连这句一起读）
 *   · 无头浏览器 / 不同驱动下合成路径与真机不同 ⇒ **只作相对对照**；输出打印 GPU 串，
 *     SwiftShader 会自动标 `software`，那种结果只能看方向。
 *   · 只含"壁纸 + 玻璃面"的合成，不含对话 UI 的 React 渲染。
 *   · 真机绝对值用 `test/tools/perf-bench.ps1` 按相位复测。
 *
 * ## 用法
 * ```bash
 * node test/tools/glass-perf-rig.mjs                      # 3 档 × 2 背景，每块 3s
 * node test/tools/glass-perf-rig.mjs --surfaces 12 --blocks 2
 * node test/tools/glass-perf-rig.mjs --check-css          # 顺带核对配方与 CSS 是否漂移
 * ```
 *
 * ## 退出码
 * `0` = 拿到结果且主判据通过（light 相对 full 吞吐 ≥ 阈值、静态对照组不劣化）
 * `1` = 拿到结果但判据不通过（**不给假绿**）
 * `2` = 前置缺失（找不到 Chromium 系浏览器 / `--check-css` 漂移）
 * `3` = 装置自身失败（页面报错 / 超时）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// ── 判据常量（与 docs/perf/RESOURCE-OPTIMIZATION.md 的 B1 条一致）────────────
const THROUGHPUT_IMPROVE_MIN = 0.20; // light 相对 full 的帧率至少提升 20%
const CONTROL_REGRESS_MAX = 0.05;    // 静态背景对照组帧率劣化上限 5%
const N_MIN = 60;                    // 每块最少帧数

// ── 三档配方 ────────────────────────────────────────────────────────────────
const RECIPES = {
  full: { backdrop: 'blur(16px) saturate(1.8) brightness(1.04)', tint: 'rgba(255,255,255,0.22)' },
  light: { backdrop: 'none', tint: 'rgba(24,28,34,0.92)' },
  off: { backdrop: 'none', tint: 'rgb(24,28,34)' },
};

const argv = process.argv.slice(2);
function argNum(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
const SURFACES = Math.max(1, Math.min(24, argNum('surfaces', 7)));
const BLOCKS = Math.max(1, Math.min(6, argNum('blocks', 2)));
const BLOCK_MS = Math.max(800, argNum('block-ms', 3000));
const CHECK_CSS = argv.includes('--check-css');

if (CHECK_CSS) {
  const cssPath = join(REPO, 'packages', 'glass', 'src', 'glass-css.js');
  if (!existsSync(cssPath)) {
    console.error(`[check-css] 找不到 ${cssPath}`);
    process.exit(2);
  }
  const css = readFileSync(cssPath, 'utf8');
  const want = ['saturate(var(--we-saturate, 1.8))', 'brightness(var(--we-glass-brightness, 1.04))'];
  const missing = want.filter((w) => !css.includes(w));
  if (missing.length) {
    console.error('[check-css] 载体表达式漂移：glass-css.js 里找不到 ' + missing.join(' / ')
      + '\n  请先把 RECIPES.full 改成 CSS 现行表达式再跑装置。');
    process.exit(2);
  }
  // 反向 tripwire：第三批把 `contrast(1.01)` 从所有载体上摘掉了（数学上 ≤1.3/255 的近似恒等
  // 段，少一段全区域颜色矩阵）。若有人把它加回来而没同步 RECIPES.full，这里必须红 —— 否则
  // 装置量的是"比真机少一段"的配方，给出偏乐观的吞吐。
  if (/\bcontrast\(\s*1\.01\s*\)/.test(css)) {
    console.error('[check-css] glass-css.js 里又出现了 contrast(1.01)：载体配方已变，'
      + '请同步 RECIPES.full 与本判据后再跑装置。');
    process.exit(2);
  }
  console.error('[check-css] 粗对齐通过（saturate/brightness 两项仍在，contrast 段已摘除）。');
}

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chromium 系浏览器，装置退出（不给出假绿）');
  process.exit(2);
}

const PORT = 8796;
const cssFor = (r) => `
  body[data-recipe="${r}"] .bubble::before{
    background:${RECIPES[r].tint};
    -webkit-backdrop-filter:${RECIPES[r].backdrop};backdrop-filter:${RECIPES[r].backdrop};
  }
  body[data-recipe="${r}"] .composer::before{
    background:${RECIPES[r].tint};
    -webkit-backdrop-filter:${RECIPES[r].backdrop};backdrop-filter:${RECIPES[r].backdrop};
  }`;
const RECIPE_CSS = Object.keys(RECIPES).map(cssFor).join('\n');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>glass-perf</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0b0f14}
  #wall{position:fixed;inset:0;z-index:0;display:block;width:100%;height:100%}
  /* 聊天列：与真实界面同构 —— 若干气泡 + 一个输入卡，视口底部堆叠 */
  #chat{position:fixed;inset:0;z-index:1;display:flex;flex-direction:column;
        justify-content:flex-end;gap:14px;padding:0 12% 32px;box-sizing:border-box}
  .bubble{position:relative;height:var(--bh,86px);border-radius:18px}
  .bubble::before,.composer::before{content:"";position:absolute;inset:0;border-radius:inherit;
        border:1px solid rgba(255,255,255,.28)}
  .composer{position:relative;height:96px;border-radius:22px}
  ${RECIPE_CSS}
</style></head>
<body data-recipe="full">
<canvas id="wall"></canvas>
<div id="chat"></div>
<script>
const SURFACES = ${SURFACES};
const RECIPES = ${JSON.stringify(Object.keys(RECIPES))};
const MODES = ['animated', 'static'];
const BLOCK_MS = ${BLOCK_MS};

const chat = document.getElementById('chat');
for (let i = 0; i < SURFACES; i++) {
  const d = document.createElement('div');
  d.className = 'bubble';
  d.style.setProperty('--bh', (70 + ((i * 17) % 40)) + 'px');
  chat.appendChild(d);
}
const composer = document.createElement('div');
composer.className = 'composer';
chat.appendChild(composer);

const canvas = document.getElementById('wall');
const ctx = canvas.getContext('2d', { alpha: false });
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}
resize();
addEventListener('resize', resize);

let tick = 0;
function drawWall() {
  if (!ctx) return;
  tick += 1;
  const w = canvas.width, h = canvas.height;
  const g = ctx.createLinearGradient(0, 0, w, h);
  const p = (tick % 240) / 240;
  g.addColorStop(0, 'hsl(' + Math.round(200 + p * 90) + ',70%,22%)');
  g.addColorStop(1, 'hsl(' + Math.round(300 + p * 70) + ',65%,14%)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  const r = Math.min(w, h) * 0.22;
  ctx.beginPath();
  ctx.arc(w * (0.2 + 0.6 * p), h * 0.4, r, 0, Math.PI * 2);
  ctx.fill();
}

// 一块 = 固定配方 + 固定背景模式下，跑固定墙钟时长，数"画了多少帧"
function runBlock(recipe, mode) {
  return new Promise((done) => {
    document.body.dataset.recipe = recipe;
    const animated = mode === 'animated';
    if (!animated) drawWall();
    const t0 = performance.now();
    let last = t0, frames = 0, warm = 0;
    const times = [];
    function tickFn(ts) {
      if (animated) drawWall();
      if (ts - last > 0) times.push(ts - last);
      last = ts;
      frames += 1;
      if (warm < 20) { warm += 1; }            // 前 20 帧丢弃（着色器/首帧）
      if (performance.now() - t0 < BLOCK_MS) { requestAnimationFrame(tickFn); return; }
      const elapsed = performance.now() - t0;
      const valid = times.slice(20);
      const a = valid.slice().sort((p, q) => p - q);
      const pick = (q) => a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0;
      let s = 0; for (const v of a) s += v;
      done({
        mode, recipe,
        fps: (frames - 20) / (elapsed / 1000),
        n: a.length,
        mean: s / Math.max(1, a.length),
        p50: pick(0.5), p95: pick(0.95),
      });
    }
    requestAnimationFrame(tickFn);
  });
}

function report(payload) {
  try { fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); }
  catch (e) { /* 回传失败 = 装置侧超时兜底 */ }
}

(async () => {
  try {
    const out = { gpu: '', software: false, surfaces: SURFACES, blocks: [] };
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      out.software = /swiftshader|software|llvmpipe/i.test(out.gpu);
    } catch (e) { out.gpu = 'unavailable'; }

    for (let b = 0; b < ${BLOCKS}; b++) {
      for (const mode of MODES) {
        for (const recipe of RECIPES) {
          out.blocks.push({ block: b, ...(await runBlock(recipe, mode)) });
        }
      }
    }
    report(out);
  } catch (e) {
    report({ error: String((e && e.stack) || e) });
  }
})();
</script>
</body></html>`;

let resolveResult = null;
const resultPromise = new Promise((res) => { resolveResult = res; });

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(204); res.end();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { error: 'bad json: ' + body.slice(0, 200) }; }
      if (resolveResult) resolveResult(parsed);
    });
    return;
  }
  if (req.url.startsWith('/favicon')) { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

// ⚠️ 必须先监听再启浏览器（同 fx-perf-rig 的踩坑记录：否则装置静默超时）
await new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(PORT, '127.0.0.1', res);
});

const profile = join(tmpdir(), 'glass-perf-' + Date.now());
const child = spawn(browser, [
  '--headless=new',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--use-mock-keychain',
  '--disable-extensions', '--disable-crashpad',
  '--window-size=1920,1080',
  // 关掉帧率上限：让"每帧成本"直接体现为"每秒能画多少帧"（有 vsync 时贵的那档也能跑满 60，
  // 差值被吃掉 —— 第一版装置就是这么得出"没有差异"的假结论的）。
  '--disable-frame-rate-limit', '--disable-gpu-vsync',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  // ⚠️ 刻意**不**加 --disable-gpu（要量的是合成成本）
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

const timeoutMs = 180000;
const timeout = new Promise((_, rej) => {
  setTimeout(() => rej(new Error(`超时（${timeoutMs / 1000}s 内没收到页面回传）`)), timeoutMs);
});

const median = (xs) => {
  const a = xs.slice().sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

try {
  const r = await Promise.race([resultPromise, timeout]);
  if (r.error) throw new Error('页面报错: ' + r.error);

  const agg = (mode, recipe, key) => median(r.blocks.filter((b) => b.mode === mode && b.recipe === recipe).map((b) => b[key]));
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const nMin = Math.min(...r.blocks.map((b) => b.n));

  console.log('── 玻璃配方吞吐对照（帧率上限已关，帧率越高 = 每帧越便宜）──');
  console.log(`  浏览器 GPU 串 : ${r.gpu}${r.software ? '   ⚠️ 软件光栅（只看方向，绝对值不可比）' : ''}`);
  console.log(`  玻璃面数      : ${r.surfaces}（+1 输入卡）  块数: ${BLOCKS}×2 背景×3 配方  最短块帧数: ${nMin}`);
  console.log('');
  console.log('  背景      配方    fps       p50        p95');
  for (const mode of ['animated', 'static']) {
    for (const recipe of Object.keys(RECIPES)) {
      console.log(`  ${mode.padEnd(9)} ${recipe.padEnd(6)} ${f(agg(mode, recipe, 'fps'), 1).padStart(6)}  ${f(agg(mode, recipe, 'p50')).padStart(8)}ms ${f(agg(mode, recipe, 'p95')).padStart(8)}ms`);
    }
  }
  const fullFps = agg('animated', 'full', 'fps');
  const lightFps = agg('animated', 'light', 'fps');
  const offFps = agg('animated', 'off', 'fps');
  const fullStatic = agg('static', 'full', 'fps');
  const lightStatic = agg('static', 'light', 'fps');
  const improve = fullFps > 0 ? (lightFps - fullFps) / fullFps : 0;
  const ctrlRegress = fullStatic > 0 ? (fullStatic - lightStatic) / fullStatic : 0;
  console.log('');
  console.log(`  动背景 light 相对 full 吞吐 : ${(improve * 100).toFixed(1)}%  （判据 ≥ ${(THROUGHPUT_IMPROVE_MIN * 100).toFixed(0)}%）`);
  console.log(`  静背景 full→light 吞吐损失  : ${(ctrlRegress * 100).toFixed(1)}%  （判据 ≤ ${(CONTROL_REGRESS_MAX * 100).toFixed(0)}%）`);
  console.log(`  full 与 off 的差距（玻璃总成本下界）: ${((offFps / Math.max(1, fullFps) - 1) * 100).toFixed(1)}% 吞吐`);

  const enough = nMin >= N_MIN;
  const pass = enough && improve >= THROUGHPUT_IMPROVE_MIN && ctrlRegress <= CONTROL_REGRESS_MAX;
  if (!enough) console.log(`  ⚠️ 最短块只有 ${nMin} 帧（< ${N_MIN}）：样本不足，判为未通过`);
  console.log(`  结论：${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error('装置失败: ' + e.message);
  process.exitCode = 3;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
}
