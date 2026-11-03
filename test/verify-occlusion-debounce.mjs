#!/usr/bin/env node
/**
 * verify-occlusion-debounce.mjs —— `pauseOnHidden` 的持续期防抖契约（issue #288）。
 *
 * 背景：宿主在虚拟桌面切换 / 焦点变化期间会把 `document.hidden` 瞬时误判为 true
 * （Chromium 遮挡跟踪竞态，2–3 秒后复查纠正）。旧实现照单全收 ⇒ 每次抖动都走
 * 「暂停 → 拆页 → 重建 → 重新解析整个 scene 包（实测 6.4MB / 首帧 2001ms）」。
 *
 * 本守卫只钉**源码契约**（行为面在真浏览器/真机上不可在 CI 复现）：
 *   ① 阈值为正且落在合理窗口（0.8–3s）；
 *   ② `occlusionReason()` 的 pauseOnHidden 分支只读 `hiddenHoldActive`，不直接读
 *      `document.hidden`（否则防抖被绕过、瞬时抖动又能触发暂停）；
 *   ③ apply 里挂 `visibilitychange → applyHiddenHold`，且 cleanup 里移除监听并把
 *      模块级 `hiddenHoldActive` 复位（否则禁用期间若页面隐藏，重挂会带旧态直接暂停）。
 * 每条都配一个**合成变异体**负对照（改源码文本喂同一个 detector，必须判红）。
 */
import { readFileSync } from 'node:fs';
import { createCheck } from './tools/assert-harness.mjs';
import { stripComments } from './tools/js-text.mjs';

const { check, stats } = createCheck();
const SRC = new URL('../src/client.js', import.meta.url);
const raw = readFileSync(SRC, 'utf8');
const code = stripComments(raw);

/** @returns {string[]} 违例列表（空 = 通过）。主判据与负对照共用这一份。 */
function violations(src) {
  const out = [];
  const threshold = /HIDDEN_PAUSE_DEBOUNCE_MS\s*=\s*(\d+)\s*;/.exec(src);
  if (!threshold) out.push('缺 HIDDEN_PAUSE_DEBOUNCE_MS 常量');
  else {
    const ms = Number(threshold[1]);
    if (!(ms >= 800 && ms <= 3000)) out.push('HIDDEN_PAUSE_DEBOUNCE_MS=' + ms + ' 不在 800–3000ms 窗口');
  }
  if (!/let\s+hiddenHoldActive\s*=\s*false\s*;/.test(src)) out.push('缺模块级 hiddenHoldActive 初值');
  // pauseOnHidden 分支只许读防抖后的布尔。
  if (!/if\s*\(\s*selection\.pauseOnHidden\s*&&\s*hiddenHoldActive\s*\)/.test(src)) {
    out.push('occlusionReason 的 pauseOnHidden 分支没有读 hiddenHoldActive');
  }
  const reasonBody = /function\s+occlusionReason\s*\(\s*\)\s*\{([\s\S]{0,600}?)\n\}/.exec(src);
  if (!reasonBody) out.push('定位不到 occlusionReason 函数体');
  else if (/document\.hidden/.test(reasonBody[1])) {
    out.push('occlusionReason 仍直接读 document.hidden（防抖被绕过）');
  }
  // apply 侧挂载 + 计时器。
  if (!/document\.addEventListener\(\s*["']visibilitychange["']\s*,\s*applyHiddenHold\s*\)/.test(src)) {
    out.push('apply 没有挂 visibilitychange → applyHiddenHold');
  }
  // 分档防抖（2026-11-03）：视频壁纸 pause 廉价 ⇒ 更短窗口；实时/网页档仍走通用档（防拆页冷重载）。
  const videoMs = /HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS\s*=\s*(\d+)\s*;/.exec(src);
  if (!videoMs) out.push('缺 HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS 常量');
  else {
    const v = Number(videoMs[1]);
    if (!(v >= 100 && v <= 600)) out.push('HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS=' + v + ' 不在 100–600ms 窗口');
    if (threshold && !(v < Number(threshold[1]))) out.push('视频档防抖必须短于通用档');
  }
  if (!/function\s+hiddenPauseDebounceMs\s*\(\s*\)/.test(src)) out.push('缺 hiddenPauseDebounceMs()');
  if (!/setTimeout\([\s\S]{0,240}?hiddenPauseDebounceMs\(\s*\)\s*\)/.test(src)) {
    out.push('防抖计时没有使用 hiddenPauseDebounceMs()');
  }
  // cleanup 侧移除 + 复位（模块级状态必须收）。
  if (!/document\.removeEventListener\(\s*["']visibilitychange["']\s*,\s*applyHiddenHold\s*\)/.test(src)) {
    out.push('cleanup 没有移除 visibilitychange → applyHiddenHold');
  }
  if (!/\n\s*hiddenHoldActive\s*=\s*false\s*;/.test(src)) {
    out.push('cleanup 没有把 hiddenHoldActive 复位');
  }
  return out;
}

const base = violations(code);
check('1. 源码满足防抖契约（阈值 / 只读防抖布尔 / 挂载 / 计时 / 卸载复位）', base.length === 0, base.join('；'));
check('2. 覆盖面：源码里确有 applyHiddenHold 与 hiddenHoldActive 的实际使用（防判据空转）',
  /applyHiddenHold/.test(code) && (code.match(/hiddenHoldActive/g) || []).length >= 3,
  'hiddenHoldActive 出现 ' + (code.match(/hiddenHoldActive/g) || []).length + ' 次');

// ── 负对照：合成变异体必须被同一个 detector 判红 ──────────────────────────────
{
  const direct = code.replace(
    'if (selection.pauseOnHidden && hiddenHoldActive)',
    'if (selection.pauseOnHidden && typeof document !== "undefined" && document.hidden)');
  check('NC1 把 pauseOnHidden 改回直接读 document.hidden ⇒ 判红',
    direct !== code && violations(direct).some((v) => /document\.hidden|hiddenHoldActive/.test(v)));
  const noReset = code.replace(/\n\s*hiddenHoldActive\s*=\s*false\s*;/, '\n/* reset removed */');
  check('NC2 删掉 cleanup 的 hiddenHoldActive 复位 ⇒ 判红',
    noReset !== code && violations(noReset).some((v) => /复位/.test(v)));
  const zeroWindow = code.replace('}, hiddenPauseDebounceMs());', '}, 0);');
  check('NC3 把分档计时换回写死的 0 ⇒ 判红',
    zeroWindow !== code && violations(zeroWindow).some((v) => /hiddenPauseDebounceMs|窗口|防抖/.test(v)));
  const sameWindow = code.replace(/HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS\s*=\s*(\d+)\s*;/, (m, n) => m.replace(n, '1200'));
  check('NC3b 把视频档窗口调回与通用档相同 ⇒ 判红（否则"按类型提速"退化成空话）',
    sameWindow !== code && violations(sameWindow).some((v) => /视频档防抖必须短于通用档/.test(v)));
  const noUnbind = code.replace('document.removeEventListener("visibilitychange", applyHiddenHold);', '');
  check('NC4 删掉卸载时的监听移除 ⇒ 判红',
    noUnbind !== code && violations(noUnbind).some((v) => /visibilitychange|移除/.test(v)));
}

if (stats.failed) {
  console.error('OCCLUSION DEBOUNCE CHECKS FAILED — ' + stats.failed + ' failed, ' + stats.passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('ALL OCCLUSION DEBOUNCE CHECKS PASSED (' + stats.passed + ')');
}
