/** 客户端的音频 / 播放桥助手（从 `src/client.js` 按族搬出，函数体逐字未改）。
 *
 * 契约：
 *   1) 本文件不 import —— 构建期由 scripts/build-client.mjs 内联在正文之前，与正文同处一个扁平作用域；
 *      函数体引用的 selection / clampNum / layerEl 等自由名由正文与其它内联模块提供。
 *   2) 搬移只改了"声明住哪"：本段文本与拆前 src/client.js 逐字节相同。
 *   3) 顶层状态（rotationAudioGate、sceneAudioEl、LAYER_KEY_FIELDS）初始化式只有字面量，
 *      两个 `let` 的赋值点都在本文件内；LAYER_KEY_FIELDS 只被层 key 比对读取。
 *   4) 音频闸的开关时机由正文的轮换流程决定：本文件只提供判定与写入函数，不在顶层执行动作。
 */
// 把期望音量写到元素上。muted 与 volume 必须成对设置：只设 volume=0 时部分
// 浏览器仍会在 seek/换源后出声，而只设 muted 会让音量滑块看起来没生效。
// 轮换音频闸生效期间，闸内（= 正在淡入的新层）元素一律按 0 处理，见下方
// openRotationAudioGate。
/*
 * ── 音频与画面的同步纪律（2026-11-03 定稿）──────────────────────────────────
 *
 * **声音只有一个开关：画面在不在播。** `weApplyAudio` 只读 `weAudioVolume()`（用户音量 ×
 * 总开关）与轮换音频闸 —— **不读焦点、不读可见性**。
 *
 * 曾经试过"失焦即静音"（muteOnBlur）：切走立刻静音、画面继续。真机反馈否掉了它 ——
 * 一个**未最大化的小窗**浮在 DSH 上时，视频明明还在播，声音却被掐掉，听感就是"卡了一下"。
 * 用户要的是**同步**而不是"声音更早停"：画面在播 ⇒ 出声，画面停 ⇒ 静音。
 *
 * 于是"另一窗口最大化后还响几秒"这件事改由**暂停判定自己变快**来解（见 client.js 的
 * `hiddenPauseDebounceMs`：视频壁纸的隐藏防抖 1200ms → 250ms，因为视频 pause 是廉价的，
 * 1.2s 那条防抖本来是给"实时渲染页拆页冷重载"用的）。声音随画面一起停，且更早停。
 */
function weApplyAudio(video) {
  if (!video) return;
  // 显式设定（换源/用户改音量/恢复）优先于任何进行中的渐变：先撤渐变再写值，
  // 否则渐变的下一次 tick 会把刚写进去的音量又拉回自己的曲线上。
  cancelAudioFade(video);
  const v = isAudioGated(video) ? 0 : weAudioVolume();
  try {
    video.volume = v;
    video.muted = v <= 0;
  } catch { /* ignore */ }
}

/**
 * 立刻把"当前应有的音量"刷到在屏媒体上 —— **不等 emit**。
 * 播放判定变化的瞬间（隐藏/恢复、播放/暂停）由 client.js 的 onOcclusionChange 调它，
 * 让音量**与画面同步**落地：画面在播 ⇒ 按设置出声，画面停 ⇒ 0。不掺焦点/可见性判断 ——
 * 音量只由「用户音量 × 总开关 × 轮换音频闸」决定。
 * 幂等：值没变时写同样的 volume/muted 没有副作用。
 */
function applyAudioToVisibleNow() {
  try {
    const layer = (typeof document !== "undefined" && typeof document.getElementById === "function")
      ? document.getElementById(LAYER_ID) : null;
    if (layer && typeof layer.querySelectorAll === "function") {
      for (const el of layerMediaEls(layer)) weApplyAudio(el);
    }
    if (sceneAudioEl) {
      weApplyAudio(sceneAudioEl);
      // 与画面同步：音量 > 0 就播、= 0 就停（自动播放被拦就等用户点）。
      if (weAudioVolume() > 0) {
        const p = sceneAudioEl.play();
        if (p && typeof p.catch === "function") p.catch(() => { /* 等用户手势 */ });
      } else {
        try { sceneAudioEl.pause(); } catch { /* ignore */ }
      }
    }
    const live = layer ? liveFrameOf(layer) : null;
    if (live) {
      const vol = weAudioVolume();
      if (setLiveVolumeNow(live, vol)) liveApplied.volume = vol;
    }
  } catch { /* 音频刷新失败不影响播放判定 */ }
}

// ── 音量渐变（暂停时渐弱、恢复时渐入）─────────────────────────────────────
// 为什么要自己写：<video> 没有"淡出"API。把媒体接进 Web Audio 用 GainNode 虽然能做出
// 采样级精确的渐变，但 createMediaElementSource 只能对同一元素调一次、接错一步就是整条
// 静音（且 AudioContext 可能因为自动播放策略处于 suspended）—— 为 0.3s 的渐变不值这个风险。
//
// 用定时器写就必须认一件事：**页面隐藏时 Chromium 会节流定时器**（后台页 ≥1s 对齐），
// 而"暂停"恰恰多发生在隐藏时 ⇒ 渐变会被拉长。所以每个渐变都带一道**硬兜底**：
// AUDIO_FADE_GUARD_MS 到点直接收尾（置 0 + 回调），保证"不会因为节流而不停"。
const AUDIO_FADE_MS = 320;
const AUDIO_FADE_STEP_MS = 24;
const AUDIO_FADE_GUARD_MS = 1200;
const audioFades = new Map(); // el -> { timer, guard }
/** 撤掉某个元素上正在进行的渐变（返回是否真的撤掉了）。 */
function cancelAudioFade(el) {
  const f = el ? audioFades.get(el) : null;
  if (!f) return false;
  audioFades.delete(el);
  try { clearTimeout(f.timer); } catch { /* ignore */ }
  try { clearTimeout(f.guard); } catch { /* ignore */ }
  return true;
}
/** 把元素音量线性渐变到 target；到达后回调 done（被取消则不回调）。 */
function fadeAudioTo(el, target, done) {
  if (!el) return;
  cancelAudioFade(el);
  const from = Number(el.volume) || 0;
  const to = Math.max(0, Math.min(1, Number(target) || 0));
  const finish = () => {
    try { el.volume = to; el.muted = to <= 0.001; } catch { /* ignore */ }
    if (typeof done === "function") { try { done(); } catch { /* ignore */ } }
  };
  if (Math.abs(from - to) < 0.01) { finish(); return; }
  const t0 = Date.now();
  const entry = { timer: 0, guard: 0, to };
  audioFades.set(el, entry);
  const step = () => {
    if (audioFades.get(el) !== entry) return;   // 已被取消/被新的渐变取代
    const k = Math.min(1, (Date.now() - t0) / AUDIO_FADE_MS);
    const v = from + (to - from) * k;
    try { el.volume = v; el.muted = v <= 0.001; } catch { /* ignore */ }
    if (k >= 1) { audioFades.delete(el); finish(); return; }
    entry.timer = setTimeout(step, AUDIO_FADE_STEP_MS);
  };
  entry.guard = setTimeout(() => {
    if (audioFades.get(el) !== entry) return;
    audioFades.delete(el);
    finish();
  }, AUDIO_FADE_GUARD_MS);
  step();
}
/** 渐弱到 0 再暂停（音量本来就≈0 就直接暂停，不起定时器）。 */
function fadeOutAndPause(el) {
  if (!el) return;
  if ((Number(el.volume) || 0) <= 0.01) { try { el.pause(); } catch { /* ignore */ } return; }
  // 已经在渐弱（目标同为 0）就不要再发起：`applyVideoPlayback` 每次 emit 都会被调，
  // 反复重启动会把 320ms 的窗口无限重置 ⇒ 渐弱永远到不了终点、也就永远不 pause。
  const running = audioFades.get(el);
  if (running && running.to === 0) return;
  fadeAudioTo(el, 0, () => { try { el.pause(); } catch { /* ignore */ } });
}

// ── 轮换音频闸：BGM 等上一张完全退场后再起播 ─────────────────────────────
// 交叉渐变期间两层同时挂在 DOM 上，且旧层刻意保持播放（真交叉淡化）。若新层
// 立刻带音量起播，两层 BGM 会重叠整整 1.8s。这里在提交瞬间把**新层**所有音源
// 压到 0（<video>/<audio> 走 weApplyAudio 的闸判定，live iframe 走
// __wp.setVolume(0)，场景包 BGM 走 rotationAudioHold 只准备不播），等这次渐变
// 对应的旧层被移除（渐变结束）后再恢复：旧层音频在其可见期内照常出声，新层
// 音频严格晚于旧层退场。若用户在渐变中改音量，恢复时读的是最新值。
let rotationAudioGate = null; // { node, outgoing, released }
function rotationAudioHoldActive() {
  return Boolean(rotationAudioGate && !rotationAudioGate.released);
}
// 元素是否落在「正在淡入的新层」里（闸内 → 音量按 0）。
function isAudioGated(el) {
  const gate = rotationAudioGate;
  if (!gate || gate.released || !el || !gate.node) return false;
  try { return gate.node === el || (typeof gate.node.contains === "function" && gate.node.contains(el)); } catch { return false; }
}
function layerMediaEls(node) {
  if (!node || typeof node.querySelectorAll !== "function") return [];
  try { return Array.prototype.slice.call(node.querySelectorAll("video, audio")); } catch { return []; }
}
function muteNodeAudio(node) {
  for (const el of layerMediaEls(node)) {
    try { el.volume = 0; el.muted = true; } catch { /* ignore */ }
  }
}
function liveFrameOf(node) {
  try {
    return (node && typeof node.querySelector === "function") ? node.querySelector("iframe.we-live-iframe") : null;
  } catch { return null; }
}
function setLiveVolumeNow(frame, volume) {
  if (!frame) return false;
  try {
    const wp = frame.contentWindow && frame.contentWindow.__wp;
    if (!wp || typeof wp.setVolume !== "function") return false;
    wp.setVolume(volume);
    liveApplied.volume = volume; // 同步缓存：心跳 tick 不会再把旧值刷回去
    return true;
  } catch { return false; }
}
// 恢复（= 旧层已退场）：新层音源按当前设置出声，场景包 BGM 此刻才起播。
function restoreNodeAudio(node) {
  // isConnected 只在**明确**为 false（已被替换/移除）时跳过：测试 mock 无此属性。
  if (node && node.isConnected !== false) {
    for (const el of layerMediaEls(node)) weApplyAudio(el);
    const live = liveFrameOf(node);
    if (live) { liveApplied.volume = null; applyLiveControls(live); }
  }
  // 场景包 BGM 的元素挂在 body 上（不在层内），它由 hold 标记压住 → 这里放行。
  try { syncSceneAudio(selection); } catch { /* ignore */ }
}
// 这次渐变的旧层退场了 → 放行新层音频。outgoingNode 不匹配说明闸属于别的
// 渐变（快速连切），交给对应那次。
function releaseRotationAudioGateFor(outgoingNode) {
  const gate = rotationAudioGate;
  if (!gate || gate.released) return;
  if (gate.outgoing !== outgoingNode) return;
  gate.released = true;
  rotationAudioGate = null;
  restoreNodeAudio(gate.node);
}
// 强制放行（手动切换 / 卸载）：不再等渐变，闸内层若已不在 DOM 上则只清闸。
function releaseRotationAudioGate() {
  const gate = rotationAudioGate;
  if (!gate) return;
  gate.released = true;
  rotationAudioGate = null;
  restoreNodeAudio(gate.node);
}

// ── 场景包内独立音频（scene-audio）────────────────────────────────────────
// 长安雪等场景把 BGM/音效以独立音频文件（mp3/ogg…）放在 scene.pkg 里，由 WE
// 运行时的音频组件播放；静帧路径**没有播放器**，不补这一步就是无声。这里用独立
// <audio> 元素补上：宿主 /scene-audio 路由抽出音频（最大者当 BGM），音量与
// 总开关复用视频壁纸同一套设置（默认 0 = 静音）。
// 与 sceneVideo 互斥：有内嵌 MP4 时视频自带音轨，避免双声道叠加。
let sceneAudioEl = null;
// 场景包 BGM 的 <audio> 拆机（禁用插件 / 切到无音频形态 / 卸载都要走这里）。
function stopSceneAudioEl() {
  if (!sceneAudioEl) return;
  try {
    sceneAudioEl.pause();
    sceneAudioEl.removeAttribute("src");
    sceneAudioEl.load();
    sceneAudioEl.remove();
  } catch { /* ignore */ }
  sceneAudioEl = null;
}
function syncSceneAudio(selLike) {
  const wantUrl = (selLike && selLike.type === "scene" && selLike.sceneAudioUrl
    && !selLike.sceneVideo
    // live 渲染心跳已过 → 包内音频由 WebWallGL 音频组件自播（音量走
    // __wp.setVolume），外置 <audio> 不启动，避免双声道叠加。
    && !selLike.sceneLiveActive)
    ? selLike.sceneAudioUrl : null;
  if (!wantUrl) {
    stopSceneAudioEl();
    return;
  }
  if (!sceneAudioEl) {
    sceneAudioEl = document.createElement("audio");
    sceneAudioEl.loop = true;
    sceneAudioEl.preload = "auto";
    sceneAudioEl.setAttribute("aria-hidden", "true");
    try { document.body.appendChild(sceneAudioEl); } catch { sceneAudioEl = null; return; }
  }
  weApplyAudio(sceneAudioEl);
  if (sceneAudioEl.getAttribute("data-src") !== wantUrl) {
    sceneAudioEl.setAttribute("data-src", wantUrl);
    sceneAudioEl.src = wantUrl;
    weApplyAudio(sceneAudioEl);
  }
  // 轮换音频闸：渐变期间新层的场景 BGM 只装好音源、不播 —— 旧层完全退场后
  // 由 releaseRotationAudioGateFor → syncSceneAudio 放行起播。
  if (rotationAudioHoldActive()) {
    try { sceneAudioEl.volume = 0; sceneAudioEl.muted = true; sceneAudioEl.pause(); } catch { /* ignore */ }
    return;
  }
  if (weAudioVolume() > 0) {
    const p = sceneAudioEl.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* 自动播放被拦：用户点音乐开时再播 */ });
  } else {
    try { sceneAudioEl.pause(); } catch { /* ignore */ }
  }
}

function applyVideoPlayback(video) {
  if (!video) return;
  watchVideoState(video);
  if (!isEffectivelyPlaying()) {
    // 暂停 = 先渐弱再 pause()（0.32s）。声音与画面仍然同步：两者一起走，只是收尾变软。
    fadeOutAndPause(video);
    syncVideoState(video);
    return;
  }
  if (!video.paused && !video.ended && !video.error) { weApplyAudio(video); syncVideoState(video); return; }
  if (playRefusalBlocks(video)) { weApplyAudio(video); syncVideoState(video); return; } // 等用户显式重试
  // 起播前先压到 0：等 play() 成功再按目标音量渐入，避免"从静音啪一下到满音量"。
  const target = isAudioGated(video) ? 0 : weAudioVolume();
  if (target > 0) { try { video.volume = 0; video.muted = true; } catch { /* ignore */ } }
  let p;
  try { p = video.play(); } catch { p = null; }
  if (!p || typeof p.then !== "function") { weApplyAudio(video); syncVideoState(video); return; }
  p.then(
    () => {
      if (video.dataset) delete video.dataset.wePlayRefused;
      fadeAudioTo(video, target);
      syncVideoState(video);
    },
    (err) => {
      // 浏览器真的拒绝了这个 play()：如实记录性质，等用户重试（不要沉默）。
      if (video.dataset) video.dataset.wePlayRefused = (err && err.name) || "1";
      syncVideoState(video);
    },
  );
}

// ── 源元数据 + 抽帧转码（抽帧转码 / 帧率上限）────────────────────────────────
// 这一族的实现住在 **`src/video-layer.js`**（探测 → 决策 → 进度轮询 → 落地/回退；
// 构建期内联回本作用域，调用点无需改动）。它拥有 `selection.mediaInfo` / `transcodeState` /
// `transcodeProgress` 三个字段的写入权；依赖清点、入口与不变量见该文件头。
function codecLabel(codec) {
  return { avc1: "H.264", hvc1: "H.265", hev1: "H.265", av01: "AV1", vp09: "VP9", mp4v: "MPEG-4" }[codec] || codec;
}

// 层 key 分段名（wantKey 的拼装顺序，见下）：重建时只报变化的那几段，避免把整条
// 带 scene 令牌的 URL 打进日志 —— 「为什么会重建（重建 = 渲染页冷启动）」必须能答。
const LAYER_KEY_FIELDS = ["type", "url", "edge", "sceneVideo", "audio", "live"];
function keySegBrief(v) {
  const t = String(v == null ? "" : v);
  return t ? (t.length > 46 ? "…" + t.slice(-44) : t) : "∅";
}
