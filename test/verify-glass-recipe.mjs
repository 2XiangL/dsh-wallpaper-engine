/*
 * verify-glass-recipe.mjs —— 玻璃**配方形状**与**逐面雾化门**的机检（第三批 perf）。
 *
 * 判据来源：`docs/perf/RESOURCE-OPTIMIZATION.md` 的 P1 档。
 *   P1-1 每个霜面的表达式里**不许**再有 `contrast(1.01)`：它是近似恒等的颜色矩阵
 *        （`out=(in-0.5)*1.01+0.5`，整个 0..1 区间上最大 |Δ| = 1.3/255，中灰为 0），
 *        却是每个霜面每帧的一段全区域滤镜 pass。摘掉它观感不变、成本变少。
 *   P1-3/P1-4 用户把某一面的「雾化」调到 0 时，那一面必须**真的**不读 backdrop：
 *        写入端（glass.js 的 applyGlass）产出的 token 集合，必须与消费端
 *        （glass-css.js 里 `[data-we-blur-zero-faces~="…"]` 选择器里的 token 集合）
 *        **双向相等** —— 少一个 ⇒ 那一面白付 backdrop 读取；多一个 ⇒ 死规则。
 *        卸载路径（glass-layer.js 的 disposeGlassLayer）必须撤掉这个属性。
 *
 * 为什么这几条值得一条守卫：recipe 是"看着像性能优化"的高危区 —— 表达式抄错一个函数
 * 就变成观感回归，而摘掉恒等段又会被"表达式变了"当成漂移。这里把两头都钉住：值（无恒等段）
 * 与集合（写=读）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCssComments } from './tools/css-text.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const CSS_RAW = read('packages', 'glass', 'src', 'glass-css.js');
const GLASS = read('packages', 'glass', 'src', 'glass.js');
const LAYER = read('packages', 'glass', 'src', 'glass-layer.js');

// 注释先剥掉：注释里的散文（"lose all contrast (实测…)"）不是声明，不能判成漂移。
// 用仓库的**字符串感知**实现（test/tools/css-text.mjs）：朴素块注释正则会把 content:"/*" 这类
// 字符串里的注释起始符当成注释，属被 docs 档明令禁止的形态。
const CSS = stripCssComments(CSS_RAW);

/** 判据 1：表达式里出现 `contrast(...)` 就算漂移（当前配方只有 blur/saturate/brightness）。 */
const hasIdentityContrast = (cssText) => /\bcontrast\(/.test(stripCssComments(cssText));

/** 判据 2：CSS 侧的 token 集合（`[data-we-blur-zero-faces~="x"]`）。 */
const cssTokens = (cssText) => {
  const out = new Set();
  for (const m of cssText.matchAll(/data-we-blur-zero-faces~="([a-z-]+)"/g)) out.add(m[1]);
  return out;
};

/** 判据 3：JS 写入侧的 token 集合（faceBlurZero("x", …) + capsule push）。 */
const jsTokens = (jsText) => {
  const out = new Set();
  for (const m of jsText.matchAll(/faceBlurZero\(\s*"([a-z-]+)"/g)) out.add(m[1]);
  if (/zeroFaces\.push\("capsule"\)/.test(jsText)) out.add('capsule');
  return out;
};

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));

// ── 1. 配方里没有恒等段 ────────────────────────────────────────────────────
assert.equal(hasIdentityContrast(CSS), false,
  'glass-css.js 的霜表达式里又出现了 contrast(…)：它是近似恒等段，摘掉才省一段全区域 pass。'
  + ' 若确实要加回，请同时更新 glass-perf-rig.mjs 的 RECIPES.full 与 docs/perf 的判据。');
// 正向对照：判据本身抓得住（否则上面那条可能是"永远为假"的假绿）
assert.equal(hasIdentityContrast('backdrop-filter: blur(9px) saturate(1.3) contrast(1.01);'), true,
  'negative control: 带 contrast 的表达式必须被判红');
assert.equal(hasIdentityContrast('backdrop-filter: blur(9px) saturate(1.3) brightness(1.04);'), false,
  'negative control: 现行配方（blur+saturate+brightness）必须判绿');

// 霜载体必须还带着两段承载观感的函数（防止"为了省 pass 把 saturate 也摘了"）
// `@supports (-webkit-backdrop-filter: blur(1px))` 的条件不是声明，先把这类头删掉再普查。
const CSS_DECL = CSS.replace(/@supports[^{]*\{/g, '');
const frostDecls = [...CSS_DECL.matchAll(/-webkit-backdrop-filter:\s*([^;]+);/g)].map((m) => m[1].trim());
const realFrost = frostDecls.filter((d) => !/^none\b/.test(d));
assert.ok(realFrost.length >= 10, `真霜表达式数量异常（${realFrost.length}），配方普查可能失效`);
for (const decl of realFrost) {
  assert.match(decl, /\bblur\(/, `霜表达式缺 blur：${decl}`);
}
// `saturate` 是"湿玻璃"观感的承载项 —— 允许个别面本来就只放 blur（declared 面的既有配方是
// `blur(var(--we-blur, 14px))`），但不许整片被摘掉。
const withSaturate = realFrost.filter((d) => /\bsaturate\(/.test(d));
assert.ok(withSaturate.length >= 10,
  `带 saturate 的霜表达式只剩 ${withSaturate.length} 条：观感承载项被整片摘掉了？`);

// ── 2. 逐面雾化门：写侧集合 == 读侧集合 ─────────────────────────────────────
const writeTokens = jsTokens(GLASS);
const readTokens = cssTokens(CSS);
assert.ok(writeTokens.size >= 7, `写入侧 token 太少（${writeTokens.size}）：applyGlass 的逐面门可能被整块删了`);
const missingInCss = setDiff(writeTokens, readTokens);
const deadInCss = setDiff(readTokens, writeTokens);
assert.deepEqual(missingInCss, [],
  `这些面在 JS 侧会写"雾化=0"，但样式表里没有对应规则 ⇒ 它们仍会每帧读一遍 backdrop：${missingInCss.join(', ')}`);
assert.deepEqual(deadInCss, [],
  `样式表里有这些 token 规则，但没有任何代码会写出它们 ⇒ 死规则：${deadInCss.join(', ')}`);
// 负对照：集合比较本身有牙（漏一个必须被抓到）
assert.deepEqual(setDiff(new Set(['a', 'b']), new Set(['a'])), ['b'], 'negative control: 漏 token 必须被判出');
assert.equal(jsTokens('const x = 0;').size, 0, 'negative control: 没有 faceBlurZero 时集合为空');

// 每个 token 的规则都必须把两种前缀都置 none（漏 -webkit- ⇒ Safari/旧壳仍有霜）
for (const token of readTokens) {
  const at = CSS.indexOf(`data-we-blur-zero-faces~="${token}"`);
  assert.ok(at > 0, `token ${token} 的规则不见了`);
  const braceEnd = CSS.indexOf('}', at);
  const block = CSS.slice(at, braceEnd);
  assert.match(block, /-webkit-backdrop-filter:\s*none\s*!important/, `${token} 的规则缺 -webkit- 归零`);
  assert.match(block, /backdrop-filter:\s*none\s*!important/, `${token} 的规则缺标准属性归零`);
}

// ── 3. 卸载路径必须撤属性（否则"插件没了，门还挂着"）──────────────────────────
assert.match(LAYER, /removeAttribute\("data-we-blur-zero-faces"\)/,
  'disposeGlassLayer 没有撤 data-we-blur-zero-faces：卸载/禁用后会残留一个没人维护的 token 列表');

// ── 4. 唯一判定源：applyGlass 必须用 glassValue 解析有效值 ──────────────────
// 直接读自己的键会在"跟随档（inherit）+ 全局 0"时漏挂门 —— 侧栏 0 却不关霜。
assert.match(GLASS, /const v = Number\(glassValue\(surface, "blur", ownValue, fallbackValue\)\);/,
  'faceBlurZero 必须经 glassValue 解析有效值（跟随档的 0 来自全局键）');
assert.equal(/const v = Number\(ownValue\)/.test(GLASS), false,
  'faceBlurZero 改回直读本面键 ⇒ 跟随档会漏挂门');

console.log(`PASS | 玻璃配方无恒等段（${realFrost.length} 条真霜表达式）、逐面雾化门写读一致（${writeTokens.size} 个 token）、卸载撤属性`);
