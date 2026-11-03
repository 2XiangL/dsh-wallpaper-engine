/*
 * verify-audio-sync.mjs —— 「声音与画面同源同步」+「暂停/恢复带音量渐变」的行为与接线守卫。
 *
 * 口径（2026-11-03 用户定稿）：
 *   1) **声音只有一个开关 = 画面在不在播。** 画面在播 ⇒ 按用户音量出声；画面停 ⇒ 静音。
 *      音量不得读焦点、不得读可见性（两次真机反馈否掉了两版"猜"的方案，见文件末注释）。
 *   2) 停/起两端都带**渐变**（渐弱 320ms 后 pause、起播从 0 渐入），因为硬切会有"啪"的一声。
 *      渐变必须可取消（起播打断渐弱）、必须带硬兜底（页面隐藏时定时器被节流到 ≥1s，
 *      不能因为节流就不停），且不得留下定时器。
 *
 * 手法：node:vm 装**真源码** src/client-audio-playback.js，配**假时钟**（setTimeout/clearTimeout/
 * Date.now）驱动渐变；断言看每一步的 volume 序列与 pause 时机。
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
const checkAsync = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS | ${name}`); }
  catch (err) { console.error(`FAIL | ${name}: ${err && err.message}`); process.exitCode = 1; }
};
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

const AUDIO_SRC = read('src', 'client-audio-playback.js');
const CLIENT_SRC = read('src', 'client.js');
const SCHEMA_SRC = read('lib', 'settings-schema.js');

/** 假时钟：advance(ms) 按时间顺序跑到期回调；pending() 暴露未清定时器数。 */
function makeClock() {
  let now = 0; let seq = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { at: now + Math.max(0, Number(ms) | 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
        if (!pick) break;
        timers.delete(pick[0]);
        now = pick[1].at;
        try { pick[1].fn(); } catch { /* ignore */ }
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function makeSandbox(opts = {}) {
  const clock = makeClock();
  const state = { volume: opts.volume != null ? opts.volume : 0.2, playCalls: 0, pauseCalls: 0, liveVolumeCalls: [], scenePlay: 0, scenePause: 0 };
  const volumeTrace = [];
  const videoEl = {
    muted: false, paused: true, ended: false, error: null, dataset: {},
    play() { state.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { state.pauseCalls++; this.paused = true; },
  };
  // 记录每次 volume 写入的序列（渐变判据只看这个）
  let vol = opts.startVolume != null ? opts.startVolume : 0.2;
  Object.defineProperty(videoEl, 'volume', {
    get: () => vol,
    set: (v) => { vol = Number(v); volumeTrace.push(Number(v)); },
  });
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
    selection: { videoAudioEnabled: true, videoVolume: state.volume, type: opts.type || 'video', ...(opts.selection || {}) },
    document: {
      hasFocus: () => opts.focused !== false,
      hidden: Boolean(opts.hidden),
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
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    console,
  };
  sandbox.globalThis = sandbox;
  const code = AUDIO_SRC + '\n;({ weApplyAudio, applyAudioToVisibleNow, applyVideoPlayback, syncSceneAudio,'
    + ' __setGate: (g) => { rotationAudioGate = g; }, __fadeCount: () => audioFades.size });';
  const api = vm.runInNewContext(code, sandbox, { filename: 'client-audio-playback.js' });
  return { api, sandbox, state, videoEl, sceneEl, clock, volumeTrace };
}

function evalDebounce(type) {
  const fn = CLIENT_SRC.match(/function hiddenPauseDebounceMs\(\) \{[\s\S]*?\n\}/);
  const c1 = CLIENT_SRC.match(/const HIDDEN_PAUSE_DEBOUNCE_MS = (\d+);/);
  const c2 = CLIENT_SRC.match(/const HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS = (\d+);/);
  assert.ok(fn && c1 && c2, '在 client.js 里找不到 hiddenPauseDebounceMs / 两个常量');
  return vm.runInNewContext(
    `const HIDDEN_PAUSE_DEBOUNCE_MS = ${c1[1]}; const HIDDEN_PAUSE_DEBOUNCE_VIDEO_MS = ${c2[1]};`
    + `\n${fn[0]}\n;hiddenPauseDebounceMs();`, { selection: { type } });
}

// ── A. 同步纪律：音量只由「用户音量 × 总开关 × 轮换闸」决定 ─────────────────
check('失焦不影响音量：hasFocus=false 时 weApplyAudio 仍写真实音量', () => {
  const a = makeSandbox({ focused: false });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0.2);
  assert.equal(a.videoEl.muted, false);
});
check('负对照：总开关关闭 ⇒ 音量恒 0（用户意图，与焦点无关）', () => {
  const a = makeSandbox({ selection: { videoAudioEnabled: false } });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0);
  assert.equal(a.videoEl.muted, true);
});
check('轮换音频闸仍是唯一允许"画面在播但静音"的来源', () => {
  const a = makeSandbox();
  a.api.__setGate({ node: a.videoEl, released: false });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0);
  a.api.__setGate({ node: a.videoEl, released: true });
  a.api.weApplyAudio(a.videoEl);
  assert.equal(a.videoEl.volume, 0.2);
});

// ── B. 暂停：先渐弱、再 pause（不是硬切，也不是把音量清零冒充暂停）──────────
check('暂停是**渐弱后**才 pause：t=0 不暂停，320ms 后音量归零并 pause()', () => {
  const a = makeSandbox({ playing: false, startVolume: 0.2 });
  a.api.applyVideoPlayback(a.videoEl);
  assert.equal(a.state.pauseCalls, 0, '起点不该立刻 pause（否则就是硬切）');
  a.clock.advance(400);
  assert.equal(a.state.pauseCalls, 1, '渐变结束后必须真的 pause()');
  assert.ok(a.videoEl.volume <= 0.001, '暂停时音量必须已到 0，实际 ' + a.videoEl.volume);
  assert.equal(a.api.__fadeCount(), 0, '渐变结束后不许残留定时器');
});
check('渐弱是单调下降的（不是一次性跳变）', () => {
  const a = makeSandbox({ playing: false, startVolume: 0.2 });
  a.api.applyVideoPlayback(a.videoEl);
  a.clock.advance(400);
  const seq = a.volumeTrace.filter((v) => v >= 0 && v <= 1);
  assert.ok(seq.length >= 4, '渐变至少要有 4 个采样点，实际 ' + seq.length);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1] + 1e-9, '音量必须单调不升：' + seq.join(','));
  assert.ok(seq[seq.length - 1] <= 0.001, '最后必须到 0');
});
check('音量本来就≈0 ⇒ 立即 pause，不起定时器（没有"渐弱 0"这种空转）', () => {
  const a = makeSandbox({ playing: false, startVolume: 0 });
  a.api.applyVideoPlayback(a.videoEl);
  assert.equal(a.state.pauseCalls, 1);
  assert.equal(a.clock.pending(), 0);
});
check('硬兜底：步进被节流也不会永不停（推进到 guard 到期即收尾）', () => {
  const a = makeSandbox({ playing: false, startVolume: 0.2 });
  a.api.applyVideoPlayback(a.videoEl);
  a.clock.advance(1200);
  assert.equal(a.state.pauseCalls, 1, 'guard 到点必须收尾并 pause');
  assert.ok(a.videoEl.volume <= 0.001);
  assert.equal(a.api.__fadeCount(), 0);
});
await checkAsync('渐弱过程中起播 ⇒ 取消渐弱、不 pause、音量回到目标值', async () => {
  const a = makeSandbox({ playing: false, startVolume: 0.2 });
  a.api.applyVideoPlayback(a.videoEl);
  a.clock.advance(100);                       // 渐弱进行中
  a.sandbox.isEffectivelyPlaying = () => true;
  a.api.applyVideoPlayback(a.videoEl);        // 判定翻回在播（用户点了播放）
  await flushMicrotasks();
  a.clock.advance(400);
  assert.equal(a.state.pauseCalls, 0, '起播打断后不许再 pause');
  assert.ok(a.videoEl.volume > 0.19, '音量必须回到目标值，实际 ' + a.videoEl.volume);
  assert.equal(a.api.__fadeCount(), 0);
});

// ── C. 起播：从 0 渐入 ────────────────────────────────────────────────────
await checkAsync('起播从 0 渐入：play() 之前压到 0，随后升到用户音量', async () => {
  const a = makeSandbox({ playing: true, startVolume: 0.2 });
  a.api.applyVideoPlayback(a.videoEl);
  assert.ok(a.videoEl.volume <= 0.001, 'play() 之前必须先压到 0，否则会"啪"一下');
  await flushMicrotasks();
  a.clock.advance(400);
  assert.equal(a.state.playCalls, 1);
  assert.ok(Math.abs(a.videoEl.volume - 0.2) < 0.01, '渐入结束必须回到 0.2，实际 ' + a.videoEl.volume);
  assert.equal(a.api.__fadeCount(), 0);
});

// ── D. 分档防抖 + 接线 + 反回归 ────────────────────────────────────────────
check('隐藏防抖分档：视频 250ms，实时/网页/图片 1200ms', () => {
  assert.equal(evalDebounce('video'), 250);
  assert.equal(evalDebounce('scene'), 1200);
  assert.equal(evalDebounce('web'), 1200);
  assert.equal(evalDebounce('image'), 1200);
});
check('定时器真的用了分档函数', () => {
  assert.match(CLIENT_SRC, /\}, hiddenPauseDebounceMs\(\)\);/);
});
check('判定变化时先刷音频再 emit（同一 tick 内同步）', () => {
  const i = CLIENT_SRC.indexOf('const onOcclusionChange = () => {');
  assert.ok(i > 0);
  const block = CLIENT_SRC.slice(i, i + 420);
  assert.ok(block.indexOf('applyAudioToVisibleNow()') > 0, '缺 applyAudioToVisibleNow');
  assert.ok(block.indexOf('emit();') > block.indexOf('applyAudioToVisibleNow()'), '顺序必须先刷音频再 emit');
});
check('反回归：设置里不许再出现"失焦静音"键（被否掉的第二版方案）', () => {
  assert.equal(/muteOnBlur\s*:/.test(SCHEMA_SRC), false);
});
check('反回归：weApplyAudio 不得读焦点/可见性（同步纪律的单一来源）', () => {
  const i = AUDIO_SRC.indexOf('function weApplyAudio(');
  const body = AUDIO_SRC.slice(i, AUDIO_SRC.indexOf('\n}', i));
  assert.equal(/hasFocus|visibilityState|document\.hidden/.test(body), false);
});

console.log(`\nAUDIO SYNC + FADE CHECKS PASSED (${passed})`);
if (process.exitCode) process.exit(process.exitCode);
