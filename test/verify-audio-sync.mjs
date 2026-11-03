/*
 * verify-audio-sync.mjs —— 「声音与画面同源同步」的行为与接线守卫。
 *
 * 口径（2026-11-03 用户定稿）：
 *   **声音只有一个开关 = 画面在不在播。** 画面在播 ⇒ 按用户音量出声；画面停 ⇒ 静音。
 *   音量不得读焦点、不得读可见性。
 *
 * 为什么值得一条守卫（这是两次真机反馈换来的）：
 *   · 第一版：遮挡代理（满屏+失焦 ⇒ 暂停）—— 叠个小窗就把**看得见的**壁纸定格，被撤。
 *   · 第二版：失焦即静音（muteOnBlur）—— 小窗浮在上面时**视频还在播**、声音却被掐掉，被撤。
 *   · 现在：两者都不许回来。任何"焦点/可见性 ⇒ 音量"的门都会重新制造上面两种体感，
 *     所以这里同时钉三件事：音量来源单一、暂停判定按类型分档提速、以及设置里不许再长出
 *     一个"失焦静音"开关。
 *
 * 手法：在 node:vm 里装**真源码** `src/client-audio-playback.js`（桩提供 free names），
 * 以及从 `src/client.js` 里抽出的 `hiddenPauseDebounceMs()` 真函数。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
let passed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`PASS | ${name}`); }
  catch (err) { console.error(`FAIL | ${name}: ${err && err.message}`); process.exitCode = 1; }
};

const AUDIO_SRC = read('src', 'client-audio-playback.js');
const CLIENT_SRC = read('src', 'client.js');
const SCHEMA_SRC = read('lib', 'settings-schema.js');

function makeSandbox(opts = {}) {
  const state = { volume: 0.2, focused: opts.focused !== false, playCalls: 0, pauseCalls: 0, liveVolumeCalls: [], scenePlay: 0, scenePause: 0 };
  const videoEl = {
    volume: 1, muted: false, paused: true, ended: false, error: null, dataset: {},
    play() { state.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { state.pauseCalls++; this.paused = true; },
  };
  const audioAttrs = new Map();
  const sceneEl = {
    volume: 1, muted: false, paused: true, loop: false, preload: '', src: '',
    play() { state.scenePlay++; this.paused = false; return Promise.resolve(); },
    pause() { state.scenePause++; this.paused = true; },
    setAttribute(k, v) { audioAttrs.set(k, String(v)); },
    getAttribute(k) { return audioAttrs.has(k) ? audioAttrs.get(k) : null; },
    removeAttribute(k) { audioAttrs.delete(k); }, load() {}, remove() {},
  };
  const liveFrame = { contentWindow: { __wp: { setVolume: (v) => state.liveVolumeCalls.push(v) } } };
  const layer = { querySelectorAll: () => [videoEl], querySelector: (sel) => (sel === 'iframe.we-live-iframe' ? liveFrame : null) };
  const sandbox = {
    selection: { videoAudioEnabled: true, videoVolume: 0.2, type: opts.type || 'video', ...(opts.selection || {}) },
    document: {
      hasFocus: () => state.focused,
      getElementById: (id) => (id === 'dsh-wallpaper-engine-layer' ? layer : null),
      createElement: () => sceneEl,
      body: { appendChild() {} },
      addEventListener() {},
    },
    LAYER_ID: 'dsh-wallpaper-engine-layer',
    weAudioVolume: () => (sandbox.selection.videoAudioEnabled === false ? 0 : state.volume),
    liveApplied: { frame: null, playing: null, volume: null, fit: null },
    applyLiveControls: () => {},
    watchVideoState: () => {},
    syncVideoState: () => {},
    playRefusalBlocks: () => false,
    isEffectivelyPlaying: () => opts.playing !== false,
    console,
  };
  sandbox.globalThis = sandbox;
  const code = AUDIO_SRC + '\n;({ weApplyAudio, applyAudioToVisibleNow, applyVideoPlayback, syncSceneAudio,'
    + ' __setGate: (g) => { rotationAudioGate = g; } });';
  const api = vm.runInNewContext(code, sandbox, { filename: 'client-audio-playback.js' });
  return { api, sandbox, state, videoEl, sceneEl, liveFrame };
}

/** 从 client.js 抽出真 `hiddenPauseDebounceMs()`（连同两个常量），在沙箱里跑。 */
function evalDebounce(type) {
  const fn = CLIENT_SRC.match(/function hiddenPauseDebounceMs\(\) \{[\s\S]*?\n\}/);
  const c1 = CLIENT_SRC.match(/const HIDDEN_PAUSE_DEBOUNCE_MS = (\d+);/);
  const c2 = CLIENT_SRC.match(/const HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS = (\d+);/);
  assert.ok(fn && c1 && c2, '在 client.js 里找不到 hiddenPauseDebounceMs / 两个常量');
  const src = `const HIDDEN_PAUSE_DEBOUNCE_MS = ${c1[1]}; const HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS = ${c2[1]};`
    + `\n${fn[0]}\n;hiddenPauseDebounceMs();`;
  return vm.runInNewContext(src, { selection: { type } });
}

// ── 1. 音量来源单一：焦点不影响音量 ────────────────────────────────────────
check('失焦不影响音量：hasFocus=false 时 weApplyAudio 仍写真实音量（同步，而不是"失焦即静音"）', () => {
  const a = makeSandbox({ focused: false });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0.2, '失焦必须保持出声（画面还在播）');
  assert.equal(a.videoEl.muted, false);
});
check('负对照：总开关关闭 ⇒ 音量恒 0（这条与焦点无关，是用户意图）', () => {
  const a = makeSandbox({ focused: true, selection: { videoAudioEnabled: false } });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0);
  assert.equal(a.videoEl.muted, true);
});
check('轮换音频闸仍是唯一允许"画面在播但静音"的来源（渐变期新层）', () => {
  const a = makeSandbox({ focused: true });
  a.api.__setGate({ node: a.videoEl, released: false });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0, '闸内必须压到 0');
  a.api.__setGate({ node: a.videoEl, released: true });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0.2, '放闸后必须恢复');
});

// ── 2. 同步的落地点：播放态就是唯一的启停判据 ──────────────────────────────
check('画面在播 ⇒ play()、音量按设置（声音跟着画面出）', () => {
  const a = makeSandbox({ playing: true });
  a.api.applyVideoPlayback(a.videoEl);
  assert.equal(a.state.playCalls, 1, '在播时应 play()');
  assert.equal(a.videoEl.volume, 0.2, '音量必须是用户设置');
});
check('画面停 ⇒ pause()（声音随画面一起停，而不是靠"把音量偷偷置 0"）', () => {
  const a = makeSandbox({ playing: false });
  a.api.applyVideoPlayback(a.videoEl);
  assert.equal(a.state.pauseCalls, 1, '暂停时必须真的 pause()');
  assert.equal(a.videoEl.muted, false, '不得用 muted 冒充暂停：元素状态要真实（否则 UI/回写会骗人）');
  assert.equal(a.videoEl.volume, 0.2, '音量保持用户设置，静音来自 pause 而不是把音量清零');
});
check('applyAudioToVisibleNow：只按音量决定实时渲染页与场景 BGM 的启停', () => {
  const a = makeSandbox({ focused: false });
  a.api.applyAudioToVisibleNow();
  assert.deepEqual(a.state.liveVolumeCalls, [0.2], '失焦也必须保持实时页音量（同步）');
});

// ── 3. 按类型分档的隐藏防抖（让"画面与声音"一起更早停）────────────────────
check('隐藏防抖分档：视频壁纸 250ms，实时/网页壁纸仍 1200ms（后者防拆页冷重载）', () => {
  assert.equal(evalDebounce('video'), 250);
  assert.equal(evalDebounce('scene'), 1200);
  assert.equal(evalDebounce('web'), 1200);
  assert.equal(evalDebounce('image'), 1200);
});
check('定时器真的用了分档函数（不是把 250 写在常量里、却仍用 1200 排程）', () => {
  assert.match(CLIENT_SRC, /\}, hiddenPauseDebounceMs\(\)\);/, 'setTimeout 必须用 hiddenPauseDebounceMs()');
});

// ── 4. 接线与"别再长回来" ──────────────────────────────────────────────────
check('判定变化时先刷音频再 emit（同一 tick 内同步，不留给下一轮媒体同步）', () => {
  const i = CLIENT_SRC.indexOf('const onOcclusionChange = () => {');
  assert.ok(i > 0, '找不到 onOcclusionChange');
  const block = CLIENT_SRC.slice(i, i + 420);
  const a = block.indexOf('applyAudioToVisibleNow()');
  const e = block.indexOf('emit();');
  assert.ok(a > 0 && e > a, '必须先 applyAudioToVisibleNow 再 emit');
});
check('负对照：设置里不许再出现"失焦静音"键（那是被否掉的第二版方案）', () => {
  assert.equal(/muteOnBlur\s*:/.test(SCHEMA_SRC), false, 'schema 里又出现了 muteOnBlur —— 会重新制造"小窗悬浮时声音被掐掉"');
});
check('负对照：音量函数不得读焦点/可见性（单一来源纪律）', () => {
  const i = AUDIO_SRC.indexOf('function weApplyAudio(');
  const j = AUDIO_SRC.indexOf('\n}', i);
  const body = AUDIO_SRC.slice(i, j);
  assert.equal(/hasFocus|visibilityState|document\.hidden/.test(body), false, 'weApplyAudio 里出现了焦点/可见性判断：同步纪律被破坏');
});

console.log(`\nAUDIO SYNC CHECKS PASSED (${passed})`);
if (process.exitCode) process.exit(process.exitCode);
