/*
 * verify-audio-focus-mute.mjs —— 「失焦静音」（muteOnBlur）的行为与接线守卫。
 *
 * 判据来历（真机反馈）：另一个窗口最大化盖住 DSH 时，壁纸音乐还会响好几秒才停。
 * 根因不是我们的防抖（1.2s），而是"被遮挡"的唯一信号来自 Chromium 的窗口遮挡跟踪 ——
 * 真机实测 2s 到 >20s 不等，甚至不报。而 `blur` 是同一瞬间就有的确定事件。
 * 于是拆成两件事：**声音跟焦点走（立即）**，**视觉暂停仍走原判定（document.hidden + 防抖）**。
 *
 * 为什么值得一条守卫：
 *   · 这条闸只允许影响**应用音量**。一旦有人把它写进 `occlusionReason()`，它就会变成
 *     "失焦即暂停" —— 那正是上一版遮挡代理被撤掉的原因（叠个小窗就把看得见的壁纸定格）。
 *   · 默认值 `true` 是行为变更：关掉开关必须立刻回到"音频照常"，否则用户无法自救。
 *   · 焦点恢复必须把真实音量写回去（含轮换音频闸的优先级），否则一次失焦就永久静音。
 *
 * 手法：在 node:vm 里装**真源码** `src/client-audio-playback.js`，用桩提供 free names
 * （selection / weAudioVolume / liveApplied / applyLiveControls…），断言跑真函数。
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

/** 建一个可手动改焦点状态的沙箱，装真 `client-audio-playback.js`，返回它的内部函数。 */
function makeSandbox(opts = {}) {
  const state = { focused: opts.focused !== false, volume: 0.2, liveVolumeCalls: [], audioPlay: 0, audioPause: 0 };
  const mediaEl = () => {
    const attrs = new Map();
    return {
      volume: 1, muted: false, paused: false, loop: false, preload: '', src: '',
      play() { state.audioPlay++; return Promise.resolve(); },
      pause() { state.audioPause++; },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      load() {},
      remove() {},
    };
  };
  const videoEl = mediaEl();
  const layer = {
    querySelectorAll: () => [videoEl],
    querySelector: (sel) => (sel === 'iframe.we-live-iframe' ? frame : null),
  };
  const frame = { contentWindow: { __wp: { setVolume: (v) => state.liveVolumeCalls.push(v) } } };
  const audioEl = mediaEl();
  const sandbox = {
    selection: { muteOnBlur: opts.muteOnBlur, videoAudioEnabled: true, videoVolume: 0.2, type: opts.type || 'video' },
    document: {
      hasFocus: () => state.focused,
      getElementById: (id) => (id === 'dsh-wallpaper-engine-layer' ? layer : null),
      createElement: () => audioEl,
      body: { appendChild() {} },
      addEventListener() {},
    },
    LAYER_ID: 'dsh-wallpaper-engine-layer',
    // client.js 里的真实实现（本文件只引用，不重定义）——这里按同一语义给桩。
    weAudioVolume: () => (sandbox.selection.videoAudioEnabled === false ? 0 : state.volume),
    liveApplied: { frame: null, playing: null, volume: null, fit: null },
    applyLiveControls: () => {},
    watchVideoState: () => {},
    syncVideoState: () => {},
    playRefusalBlocks: () => false,
    isEffectivelyPlaying: () => true,
    console,
  };
  sandbox.globalThis = sandbox;
  const code = AUDIO_SRC + '\n;({ weApplyAudio, weAudioGatedByFocus, applyAudioToVisibleNow, syncSceneAudio, weAudioVolume,'
    + ' __setGate: (g) => { rotationAudioGate = g; }, __sceneAudioEl: () => sceneAudioEl });';
  const api = vm.runInNewContext(code, sandbox, { filename: 'client-audio-playback.js' });
  return { api, sandbox, state, videoEl, layer, frame, audioEl };
}

// ── 1. 闸本身的语义 ────────────────────────────────────────────────────────
check('失焦 + muteOnBlur 默认(未显式关) ⇒ 闸成立；聚焦 ⇒ 不成立', () => {
  const a = makeSandbox({ focused: false });
  assert.equal(a.api.weAudioGatedByFocus(), true);
  a.state.focused = true;
  assert.equal(a.api.weAudioGatedByFocus(), false);
});
check('负对照：muteOnBlur === false 时失焦也不静音（用户可自救）', () => {
  const a = makeSandbox({ focused: false, muteOnBlur: false });
  assert.equal(a.api.weAudioGatedByFocus(), false);
});
check('负对照：没有 document.hasFocus 的环境（精简 DOM / 测试台）一律不静音', () => {
  const a = makeSandbox({ focused: false });
  a.sandbox.document.hasFocus = undefined;
  assert.equal(a.api.weAudioGatedByFocus(), false);
});

// ── 2. 真把音量写下去，并且恢复得回来 ───────────────────────────────────────
check('失焦 ⇒ weApplyAudio 写 volume=0/muted=true；聚焦后写回真实音量', () => {
  const a = makeSandbox({ focused: false });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0, '失焦必须静音');
  assert.equal(a.videoEl.muted, true, 'muted 必须成对设置（只写 volume=0 在换源后可能仍出声）');
  a.state.focused = true;
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0.2, '恢复时必须写回真实音量');
  assert.equal(a.videoEl.muted, false);
});
check('轮换音频闸优先于焦点闸：渐变期新层即便聚焦也保持 0', () => {
  const a = makeSandbox({ focused: true });
  a.api.__setGate({ node: a.videoEl, released: false });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0, '闸内元素必须仍被压到 0');
});

// ── 3. 立即刷新入口：媒体 + 实时渲染页都刷到 ────────────────────────────────
check('applyAudioToVisibleNow：失焦时把层内媒体与实时渲染页音量同时刷到 0', () => {
  const a = makeSandbox({ focused: false });
  a.api.applyAudioToVisibleNow();
  assert.equal(a.videoEl.volume, 0, '层内 <video> 要静音');
  assert.deepEqual(a.state.liveVolumeCalls, [0], '实时渲染页要走 __wp.setVolume(0)');
});
check('applyAudioToVisibleNow：聚焦后恢复（媒体 + 实时渲染页）', () => {
  const a = makeSandbox({ focused: true });
  a.api.applyAudioToVisibleNow();
  assert.equal(a.videoEl.volume, 0.2);
  assert.deepEqual(a.state.liveVolumeCalls, [0.2]);
});
check('总开关关闭（videoAudioEnabled=false）⇒ 音量恒 0，与焦点无关', () => {
  const a = makeSandbox({ focused: true });
  a.sandbox.selection.videoAudioEnabled = false;
  a.api.applyAudioToVisibleNow();
  assert.equal(a.videoEl.volume, 0);
});
check('场景包 BGM：静音期间顺带暂停（别白解码），聚焦后重新起播', () => {
  const a = makeSandbox({ focused: false, type: 'scene' });
  a.sandbox.selection.sceneAudioUrl = '/scene-audio/x.mp3';
  a.sandbox.selection.sceneVideo = false;
  a.sandbox.selection.sceneLiveActive = false;
  a.api.syncSceneAudio(a.sandbox.selection);
  const pausedAfterMute = a.state.audioPause;
  a.state.focused = true;
  a.api.applyAudioToVisibleNow();
  assert.ok(pausedAfterMute >= 1, '静音时应暂停 BGM 元素');
  assert.ok(a.state.audioPlay >= 1, '聚焦后应重新 play()');
});

// ── 4. 接线：单一判定源纪律 + 事件链顺序 + 默认值 ───────────────────────────
check('muteOnBlur 不得进入 occlusionReason()（否则就变成"失焦即暂停"，重蹈遮挡代理）', () => {
  const start = CLIENT_SRC.indexOf('function occlusionReason()');
  assert.ok(start > 0, '找不到 occlusionReason');
  const end = CLIENT_SRC.indexOf('function occlusionActive()', start);
  const body = CLIENT_SRC.slice(start, end);
  assert.equal(/muteOnBlur/.test(body), false, 'occlusionReason() 里出现了 muteOnBlur：音频闸不许影响播放判定');
  assert.equal(/applyAudioToVisibleNow/.test(body), false, 'occlusionReason() 里出现了音频刷新：判定源必须保持纯读');
});
check('焦点/可见性事件必须先刷音频再 emit（视觉暂停的 1.2s 防抖不该拖住声音）', () => {
  const i = CLIENT_SRC.indexOf('const onOcclusionChange = () => {');
  assert.ok(i > 0, '找不到 onOcclusionChange');
  const block = CLIENT_SRC.slice(i, i + 400);
  const audioAt = block.indexOf('applyAudioToVisibleNow()');
  const emitAt = block.indexOf('emit();');
  assert.ok(audioAt > 0, 'onOcclusionChange 没有调 applyAudioToVisibleNow');
  assert.ok(emitAt > audioAt, '必须先刷音频再 emit（顺序反了就会先走 1.2s 防抖路径）');
});
check('默认值 true + 校验器 boolTrue（默认静音是行为变更，必须在两处都写明）', () => {
  assert.match(SCHEMA_SRC, /muteOnBlur:\s*true,/, 'DEFAULTS 里 muteOnBlur 默认必须是 true');
  assert.match(SCHEMA_SRC, /muteOnBlur:\s*\{\s*kind:\s*'boolTrue'\s*\}/, '校验器必须是 boolTrue（否则旧配置读成 undefined ⇒ 静默失效）');
});

console.log(`\nAUDIO FOCUS-MUTE CHECKS PASSED (${passed})`);
if (process.exitCode) process.exit(process.exitCode);
