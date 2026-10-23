// 譜面の編集の「動画」を譜面の時刻に合わせる(本アプリの追加。js/edit/video.js が使う)。
// SoundVoltexAnalyze の譜面の編集の動画(tool/sim/js/voxeditvideo.js。同 docs/譜面シミュレータ.md §17.7.2)の合わせ方のうち、
// 「動画の秒 = 譜面の時刻 + ずれ」で写す動画に要る所を移したもの。表で写す動画(SDVX の vidchart)の picture_steps のならし・
// 小節の手の写しは移していない。数値の根拠はあちらの測り(ヘッドレス Chrome)。
// - 止まっているとき: 的(動画の秒)に一番近いコマを出す。Chrome は止まっている動画を seek するとその時刻を含むコマ
//   (pts ≤ 時刻 < 次のコマの pts)を出すので、的 + 半コマへ seek する。最後の seek の後に見えたコマ(requestVideoFrameCallback の
//   mediaTime)が的から半コマの内なら seek しない。seek 中は待ち、seeked の後に最後の的だけを追う
// - 再生中: playbackRate = 編集の速さ。ずれが 12 ms(見えるコマのずれ P が分かれば 6 ms)を越えたら ±2 % 寄せ、30 ms を越えたら
//   ずれに比例して寄せ(本アプリの追加。SYNC.midS)、60〜300 ms 遅れれば 15 % 速めて追い付き、0.5 秒まで先なら止めて待ち、
//   それより離れれば止めて先へ seek して待つ(流したまま seek すると H.264 は seeked の後もしばらく遅れて進み、seek し直しをくり返した)
// - 始め: 編集の時計は再生の頭で音が聞こえ始めるまで開始位置で止まっている(EditorPlayer.videoClock)。その残りが動画の play の
//   遅れになったら流す。遅れは見えたコマで測る(play の直後の currentTime は 1 コマ進んでから 40〜70 ms 止まるので測れない)。
//   測った遅れと P はページで覚える(ブラウザ・機械の性質なので、譜面・動画を替えても同じ)
// - <video> の preservesPitch を切る(muted。真のままだと Chrome は速さを替えるたびに 23〜28 ms 止まった)
// - 終わった(ended)動画には play を呼ばない(頭へ戻る)。データが長さより前で切れていれば、流して着いた所を終わりにする
// 本アプリの追加: 30 ms を越えたずれは比例して寄せる(SYNC.midS)・コマの速さを見えたコマの間で測る(estimateFps。あちらは手元の
// ファイルを 60 fps とみる)・動画の頭より前から流すときは頭に着く前に流し始める・止めて待つ間 / play の後の待ちの間に的が大きく飛んだら
// (待ち始めた所から時計どおりに進んだ所と 0.5 秒より離れたら)待つのをやめる

/** 合わせ方の数値(秒・ms)。 */
export const SYNC = {
  fps: 60, // コマの長さが分からないときの見込み(見えたコマの間で測る。estimateFps)
  seekS: 0.060, // 再生中、ずれがこれを越えたら seek(遅れが catchMaxS までなら速めて追い付く・先が holdMaxS までなら止めて待つ)
  nudgeS: 0.012, // 再生中、これを越えたら速さを寄せる(これ未満で戻す)
  releaseS: 0.005, // 寄せ始めたら、ずれがこれより小さくなるまで寄せ続ける(境で速さを替え続けない)
  nudge: 0.02, // 寄せる量(±2 %)
  // (追加。SoundVoltexAnalyze に無い)ずれが midS を越えたら、ずれに比例して寄せる(midTauS 秒で寄せ切る速さ。上限は catchUp)。
  // ヘッドレス Chrome 155 で、ページで初めての「seek して止めて待ってから流す」は見込みの遅れ(100 ms)が実際(34 ms)より長く、
  // 動画が 60 ms ほど先になり、止めて待っても流し直した直後に 1 コマ進むので +55 ms のまま、±2 % では 2.5 秒残った [計測]
  midS: 0.03,
  midTauS: 0.4,
  picTauS: 4, // 見えるコマのずれ P の平均の時定数(秒。Chrome は絵を少しずつ遅らせて 2〜3 コマ飛ばすのをくり返すので長く取る)
  picMinS: 0.5, // P を使い始めるのに要る測りの長さ(秒)
  picMaxS: 2 / 60, // P の範囲(±2 コマ)
  picStaleMs: 100, // 最後に見えたコマからこれより経っていれば測りに入れない
  picNudgeS: 0.006, // P が分かっているときの寄せ始め・寄せ終わり(currentTime は滑らかなので狭くできる)
  picReleaseS: 0.002,
  catchMaxS: 0.3, // 再生中に動画がこれまで遅れたら seek せず速めて追い付く
  catchUp: 0.15,
  holdMaxS: 0.5, // 再生中に動画が的より先でもこれまでなら seek し直さず、止めて的が追い付くのを待つ
  holdMaxMs: 1500, // 止めて待つ上限
  rateEps: 0.002, // playbackRate をこれより小さくは替えない
  rateMin: 0.0625, // playbackRate の範囲(Chrome の下限)
  rateMax: 4,
  stallMaxMs: 1000, // 再生中に読み込みを待っている(readyState < 3)間はずれを数えない上限
  seekLeadS: 0.12, // 再生中の seek の遅れの見込み(最初の値。seek を頼んでから seeked までを測って寄せる)
  seekPadS: 0.08, // 再生中の seek は遅れの見込みよりこれだけ先へ(先に着いて止めて待つ)
  seekStartS: 0.1, // seek して止めて待った後の play の遅れの見込み(最初の値)
  startLeadS: 0.06, // play を呼んでから絵が動き出すまでの見込み(最初の値)
  startLeadMinS: 0.03, // play の遅れの見込みの下限・上限(1 回の測りで崩さない)
  startLeadMaxS: 0.15,
  seekStartMaxS: 0.2,
  latAlpha: 0.5, // 測った遅れを見込みに寄せる割合
  latWinMs: [200, 330], // play の後、遅れを測るコマ(rVFC の now − play を呼んだ時刻 ms。動き出しの揺れの後)
  latMinN: 2,
  leadMin: 0, leadMax: 0.5,
  awaitMaxMs: 1500, // 動き出すのを待つ上限
  startWaitMs: 400, // 再生の始め: 編集の時計が動き出すまで待つ上限(残りが読めないとき)
  seekStuckMs: 2500, // seeked が来ないときに待つのをやめる
  endedSeekMs: 100, // 再生中に動画が終わっているときに的へ seek し直す間
  moveS: 0.5 / 60, // seek・play の後、絵が動き出したとみなす進み(半コマ)
  settleS: 4 / 60, // rVFC が無いとき: seek の後の play で、ずれを数え始めるまで待つ進み
  nearTolS: 2e-5, // 止まっているとき、見えているコマが的から半コマ + これまでなら一番近いコマとみる(mediaTime は µs の丸め)
};

/** 見分けるコマの速さ(見えたコマの間で測った値がこの近くなら寄せる。どれにも寄らなければ使わない)。 */
const KNOWN_FPS = [15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 144];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 再生中のずれ drift(秒。動画 − 的。正 = 動画が先)から、seek するか・速さを決める。held = 前のフレームで寄せていた向き
 * (+1 速め・−1 遅め・0 なし)。band = 寄せの幅({nudgeS, releaseS}。省けば currentTime で寄せるときの 12 ms・5 ms)。
 */
export function driftControl(drift, base, held, band = null) {
  const Q = SYNC;
  if (!Number.isFinite(drift)) return { seek: true, rate: base };
  const a = Math.abs(drift);
  if (drift < -Q.seekS && a <= Q.catchMaxS) return { seek: false, rate: base * (1 + Q.catchUp) };
  if (a > Q.seekS) return { seek: true, rate: base };
  const dir = drift > 0 ? -1 : 1;
  if (a > Q.midS) return { seek: false, rate: base * (1 + dir * Math.min(Q.catchUp, a / Q.midTauS)) };
  const nS = band && Number.isFinite(band.nudgeS) ? band.nudgeS : Q.nudgeS;
  const rS = band && Number.isFinite(band.releaseS) ? band.releaseS : Q.releaseS;
  if (a > nS || (held === dir && a > rS)) return { seek: false, rate: base * (1 + dir * Q.nudge) };
  return { seek: false, rate: base };
}

/**
 * 見えるコマのずれ P(秒。見えているコマの mediaTime − currentTime の、実時間での平均)の見込み o = {avg, w(測った長さの秒)} に、
 * 1 つの測り x を dt 秒の重みで足す。測った長さが tau に満つまでは今までの平均、満ちたら時定数 tau の指数移動平均。
 */
export function picUpdate(o, x, dt, tau) {
  if (!Number.isFinite(x) || !(dt > 0)) return o || null;
  const w0 = o && Number.isFinite(o.avg) && o.w > 0 ? o.w : 0;
  const w = Math.min(w0 + dt, tau > 0 ? tau : Infinity);
  return { avg: w0 > 0 ? o.avg + (x - o.avg) * Math.min(1, dt / w) : x, w };
}

/** P を覚える速さの鍵(寄せる前の playbackRate を 0.05 で丸める。見えるコマと currentTime の差は速さで変わる)。 */
export function picKey(rate) {
  const r = Number(rate);
  return (Number.isFinite(r) && r > 0 ? Math.round(r * 20) / 20 : 1).toFixed(2);
}

/** 使う P(秒): minS 秒ぶん測れていれば ±maxS に収めた平均、まだなら NaN(currentTime で寄せる)。 */
export function picUse(o, minS, maxS) {
  return o && Number.isFinite(o.avg) && o.w >= minS ? clamp(o.avg, -maxS, maxS) : NaN;
}

/** play の遅れの見込み cur に測った遅れ sample を寄せる(どちらも [lo, hi] に収める。1 回の測りは a の割合しか効かない)。 */
export function leadEma(cur, sample, lo, hi, a) {
  const c0 = Number.isFinite(cur) ? clamp(cur, lo, hi) : NaN;
  if (!Number.isFinite(sample)) return Number.isFinite(c0) ? c0 : lo;
  const s = clamp(sample, lo, hi);
  if (!Number.isFinite(c0)) return s;
  return c0 + (s - c0) * clamp(a, 0, 1);
}

/** 速さの折れ線 segs = [[時刻 ms, 速さ], …] で、segs[0] の時刻から t(ms)までに進む動画の秒。 */
export function mediaAdvance(segs, t) {
  let r = 0;
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i][0];
    const b = i + 1 < segs.length ? Math.min(segs[i + 1][0], t) : t;
    if (b > a) r += (b - a) * segs[i][1];
    if (b >= t) break;
  }
  return r / 1000;
}

/** 中央値(空なら NaN)。 */
export function median(xs) {
  const a = (xs || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 見えたコマの間(秒。続けて出た 2 つのコマの mediaTime の差)からコマの速さを見積もる(本アプリの追加)。画面の Hz より速く流すと
 * (60 fps を 60 Hz で ×1.5 など)ブラウザはコマを飛ばして見せ、間は 1 コマの倍数に延びるので、短い方の 1 割の所(lo)から 1.5 倍
 * までの間だけを平均する(ms の刻みの webm の 16 / 17 ms の揺れも平均でならす)。よくある速さ(KNOWN_FPS)の 1.5 % の内で一番近い
 * ものに寄せ、どれにも寄らなければ NaN(当てにしない)。間が足りなくても NaN。画面の Hz が動画のコマより遅い(省電力の 30 Hz・
 * 60 Hz の画面の 120 fps)と、どのコマも同じだけ飛ばして間が全部 2 コマ以上になり見分けられないので、集める側(_fpsFrame)で、
 * 前のコマから画面の 1.5 フレーム以上たって出たコマの間だけを集める(画面ではなく動画がコマの間を決めているとき)。
 */
export function estimateFps(gaps, minN = 15) {
  const g = (gaps || []).filter((x) => x > 1 / 400 && x < 1 / 5).sort((a, b) => a - b);
  if (g.length < minN) return NaN;
  const lo = g[Math.floor(g.length * 0.1)];
  const near = g.filter((x) => x >= lo && x < lo * 1.5);
  const fps = near.length / near.reduce((a, x) => a + x, 0);
  let best = NaN;
  for (const k of KNOWN_FPS) if (Math.abs(fps - k) <= k * 0.015 && !(Math.abs(fps - best) <= Math.abs(fps - k))) best = k;
  return best;
}

/**
 * <video> を的に合わせる。sync(now, clock) を編集画面の毎フレーム(再生中)と、止まっているときは再生位置が動いたとき・seeked の後に呼ぶ。
 * clock = {playing, tg(的。動画の秒。範囲の外もそのまま), hold(再生の頭で編集の時計が動き出すまでの実時間 ms。分からなければ NaN),
 * rate(編集の速さ), fps(コマの速さ)}。
 */
export class VideoSync {
  /**
   * @param {HTMLVideoElement} video
   * @param {{wake?: () => void, presented?: (now: number, md: any) => void, now?: () => number}} [hooks]
   *   wake: seeked などで次の的を見たいとき(編集画面のフレームを回す)。presented: コマが見えたとき(見出しの時刻)。now: 時計(試験用)
   */
  constructor(video, hooks = {}) {
    this.v = video;
    this.hooks = hooks;
    this._now = hooks.now || (() => performance.now());
    this.disposed = false;
    this._L = [];
    this._vfc = 0;
    this.meta = null; // {dur, vw, vh, dataEnd?}(loadedmetadata の後)
    this._lead = SYNC.seekLeadS; // seek の遅れ(秒)
    // play の遅れの見込み: このページで測った値があればそこから(VideoSync.leads)。seek の後の遅れを測っていなければ、
    // 止まっていた所から流すときの遅れを使う(どちらも 25〜35 ms ほどで、初めの 100 ms は長すぎた [計測])
    const L = VideoSync.leads;
    this._startLead = Number.isFinite(L.start) ? L.start : SYNC.startLeadS;
    this._seekStartLead = Number.isFinite(L.seekStart) ? L.seekStart : Number.isFinite(L.start) ? L.start : SYNC.seekStartS;
    this._gaps = []; // 見えたコマの間(秒。estimateFps)
    this._lastMd = null;
    this._frameMs = 0; // 編集画面のフレームの間(ms。平均)
    this.fpsSeen = NaN; // 見えたコマの間で測ったコマの速さ(分からなければ NaN)
    this.reset();
  }

  /** 元を替える前に呼ぶ(合わせ方の状態を捨てる。見込みの遅れ・P は残す)。 */
  reset() {
    const v = this.v;
    try { v.pause(); } catch (e) { /* 止まっている */ }
    this.meta = null;
    this._seeking = false;
    this._seekAt = 0;
    this._seekGen = (this._seekGen || 0) + 1;
    this._presGen = -1;
    this._presAt = 0;
    this.presented = NaN; // 見えているコマの mediaTime(rVFC)
    this._await = null; // play の後、絵が動き出すのを待っている(_newAwait)
    this._reseek = false; // 止めた後に 1 回は seek する
    this._vplay = false; // 動画を流している(play を呼んだ)
    this._hold = 0; // 再生中に先に着いたので止めて的を待っている(始めた時刻。0 = 待っていない)
    this._holdSeek = false;
    this._seekPlay = false;
    this._stallAt = 0;
    this._held = 0;
    this._startAt = 0;
    this._startTg = NaN;
    this._waitTg = NaN;
    this._waitAt = 0;
    this._picLast = 0;
    this._picLock = false;
    this._lastNow = 0;
    this._lastLat = null;
    this.target = NaN;
    this.out = false;
    this._gaps = [];
    this._lastMd = null;
    this.fpsSeen = NaN;
    this.stats = VideoSync.newStats();
  }

  static newStats() {
    return { n: 0, sumAbs: 0, maxAbs: 0, seeks: 0, nudges: 0, stopSeeks: 0, holds: 0, picN: 0, picSum: 0, picMaxAbs: 0 };
  }

  /** 出来事を受け始める(preservesPitch を切り、rVFC を回す)。 */
  start() {
    const v = this.v;
    // 速さを替えるたびに止まらないように(muted なので聞こえない)
    try {
      if ('preservesPitch' in v) v.preservesPitch = false;
      else if ('mozPreservesPitch' in v) v.mozPreservesPitch = false;
      else if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = false;
    } catch (e) { /* 無くてよい */ }
    this._on(v, 'loadedmetadata', () => this._onMeta());
    this._on(v, 'durationchange', () => {
      if (this.meta && Number.isFinite(v.duration)) this.meta.dur = v.duration;
    });
    this._on(v, 'seeked', () => this._onSeeked());
    this._on(v, 'ended', () => this._onEnded());
    if (v.readyState >= 1) this._onMeta();
    this._vfcLoop();
  }

  _on(target, type, fn) {
    target.addEventListener(type, fn);
    this._L.push([target, type, fn]);
  }

  dispose() {
    this.disposed = true;
    for (const [target, type, fn] of this._L) target.removeEventListener(type, fn);
    this._L = [];
    if (this._vfc && typeof this.v.cancelVideoFrameCallback === 'function') {
      try { this.v.cancelVideoFrameCallback(this._vfc); } catch (e) { /* 無くてよい */ }
    }
    this._vfc = 0;
    try { this.v.pause(); } catch (e) { /* 止まっている */ }
  }

  _wake() {
    if (!this.disposed && this.hooks.wake) this.hooks.wake();
  }

  _onMeta() {
    const v = this.v;
    if (this.disposed) return;
    this.meta = { dur: Number.isFinite(v.duration) ? v.duration : NaN, vw: v.videoWidth || 0, vh: v.videoHeight || 0 };
    this._wake();
  }

  /** seeked: 再生中の seek なら、頼んでから着くまでを次の見込みに寄せ、止めて待つ上限をここから数える。 */
  _onSeeked() {
    if (this._seekPlay) {
      const t = this._now();
      this._lead = clamp(this._lead * 0.5 + ((t - this._seekAt) / 1000) * 0.5, SYNC.leadMin, SYNC.leadMax);
      this._seekPlay = false;
      if (this._hold) this._hold = t;
    }
    this._seeking = false;
    this._wake();
  }

  /**
   * ended(流していて終わりに着いた。seek で終わりに着いたときは来ない): 長さより前なら、そこをデータの終わりにする(データが途中で
   * 切れた mp4)。seek の後の ended の値は当てにしない(切れたファイルでは Chrome は切れ目より前へ seek しても ended にした)。
   */
  _onEnded() {
    this._vplay = false;
    const v = this.v;
    const m = this.meta;
    if (!m || !(m.dur > 0)) return;
    const ct = Number(v.currentTime);
    const fr = 1 / (this.fpsSeen > 0 ? this.fpsSeen : SYNC.fps);
    if (ct > 0 && ct < m.dur - fr / 2 && !(m.dataEnd <= ct)) m.dataEnd = ct;
    this._wake();
  }

  _vfcLoop() {
    const v = this.v;
    if (this.disposed || typeof v.requestVideoFrameCallback !== 'function') return;
    this._vfc = v.requestVideoFrameCallback((now, md) => {
      this._vfc = 0;
      if (this.disposed) return;
      this.presented = md && Number.isFinite(md.mediaTime) ? md.mediaTime : v.currentTime;
      this._presGen = this._seekGen; // 止まっている動画が seek を頼んだ後に出すコマは、その seek の着いたコマ(_frameOk)
      this._presAt = this._now();
      this._latFrame(now, md);
      this._fpsFrame(now, md);
      if (this.hooks.presented) this.hooks.presented(now, md);
      this._vfcLoop();
    });
  }

  /**
   * 流している間に続けて出たコマの間を集める(コマの速さの見積もり)。前のコマから画面の 1.5 フレーム(_frameMs。編集画面のフレームの間)
   * 以上たって出たコマだけ(それより短いと、画面がコマを飛ばして間を決めているかもしれない)。
   */
  _fpsFrame(now, md) {
    const prev = this._lastMd;
    this._lastMd = md && Number.isFinite(md.mediaTime) ? { t: md.mediaTime, n: md.presentedFrames, gen: this._seekGen, at: now } : null;
    if (!prev || !this._lastMd || prev.gen !== this._seekGen || this.v.paused) return;
    if (!(this._lastMd.n - prev.n === 1)) return; // 間に落としたコマがある
    if (!(this._frameMs > 0 && now - prev.at >= this._frameMs * 1.5)) return;
    const gap = this._lastMd.t - prev.t;
    if (!(gap > 0)) return;
    this._gaps.push(gap);
    if (this._gaps.length > 120) this._gaps.shift();
    const f = estimateFps(this._gaps);
    if (Number.isFinite(f)) this.fpsSeen = f;
  }

  /**
   * play の後を待っている間に見えたコマ: 動き出しの揺れの後(latWinMs)のコマで、play から見えるまでの遅れを測る。
   * 遅れ = (play からこのコマの rAF までに今の速さで進むはずの動画の秒 − 実際に進んだ mediaTime) / play の速さ。
   * このコマは同じ rAF で描く編集画面と同じ vsync に出るので、この遅れだけ前に play すると見えるコマが的に重なる。
   */
  _latFrame(now, md) {
    const A = this._await;
    if (!A || !A.rv || A.back || !md || !Number.isFinite(md.mediaTime) || !Number.isFinite(now)) return;
    const el = now - A.at;
    if (!(el > 0)) return;
    const dm = md.mediaTime - A.pos;
    if (dm < -SYNC.moveS) {
      A.back = true;
      return;
    }
    if (dm <= 1e-4) return;
    A.moved = true;
    if (el >= SYNC.latWinMs[0]) A.s.push((mediaAdvance(A.segs, now) - dm) / (A.rate > 0 ? A.rate : 1));
  }

  /** 待ち始めた的と時刻を覚える(_jumped)。 */
  _markWait(want, now) {
    this._waitTg = want;
    this._waitAt = now;
  }

  /**
   * (追加) 止めて待つ間・play の後の待ちの間に、的が待ち始めた所から時計どおりに進んだ所と 0.5 秒より離れたか(頭から鳴らし直した・別の
   * 区間を繰り返した)。seek が遅くて動画が遅れて着いただけ(的は時計どおり)なら離れていないので、待ち切って流し、追い付いて直す。
   */
  _jumped(want, now, base) {
    if (!Number.isFinite(this._waitTg)) return false;
    return Math.abs(want - (this._waitTg + ((now - this._waitAt) / 1000) * base)) > SYNC.holdMaxS;
  }

  _newAwait(now, kind) {
    const v = this.v;
    const r = Number(v.playbackRate) || 1;
    this._await = { at: now, pos: v.currentTime, kind, rate: r, segs: [[now, r]], s: [], rv: typeof v.requestVideoFrameCallback === 'function', moved: false, back: false };
    if (Number.isFinite(this.target)) this._markWait(Math.max(0, this.target), now);
  }

  /** 動画の終わり(秒): 長さ、データが長さより前で切れていればそこ。分からなければ Infinity。 */
  endS() {
    const m = this.meta;
    if (!m) return Infinity;
    const e = m.dur > 0 ? m.dur : Infinity;
    return m.dataEnd > 0 && m.dataEnd < e ? m.dataEnd : e;
  }

  /** 止める所の上限(秒): 終わりの少し前(データの切れ目を見つけたなら 1 コマ前)。 */
  _maxT(fr) {
    const end = this.endS();
    if (!(end < Infinity)) return Infinity;
    const m = this.meta;
    return Math.max(0, end - (m && m.dataEnd > 0 && m.dataEnd <= end ? fr : 0.001));
  }

  /** 流しているか(play を呼んでいて、止めて待っていない)。 */
  get running() {
    return this._vplay && !this._hold;
  }

  /** seek の答えを待っているか。 */
  get seeking() {
    return this._seeking || !!this.v.seeking;
  }

  /**
   * 1 フレームぶん合わせる。
   * @param {number} now performance.now()
   * @param {{playing: boolean, tg: number, hold: number, rate: number, fps: number}} c
   */
  sync(now, c) {
    const v = this.v;
    const Q = SYNC;
    // 前のフレームからの間(ms。流し始めを一番近いフレームにするのに使う。飛んだ・初めは 1/60 秒)
    const dtF = this._lastNow > 0 && now - this._lastNow > 2 && now - this._lastNow < 60 ? now - this._lastNow : 1000 / 60;
    if (this._lastNow > 0 && now - this._lastNow > 2 && now - this._lastNow < 60) this._frameMs = this._frameMs > 0 ? this._frameMs + (dtF - this._frameMs) * 0.1 : dtF;
    this._lastNow = now;
    if (this.disposed || !this.meta || v.error || !c) return;
    if (this._seeking && now - this._seekAt > Q.seekStuckMs) this._seeking = false; // seeked が来なかった
    const tg = c.tg;
    if (!Number.isFinite(tg)) return;
    this.target = tg;
    const fr = 1 / (c.fps > 0 ? c.fps : Q.fps);
    const end = this.endS();
    const out = tg < 0 || tg > end;
    this.out = out;
    const want = clamp(tg, 0, this._maxT(fr));
    const playing = !!c.playing;
    const base = clamp(Number(c.rate) || 1, Q.rateMin, Q.rateMax);
    let hold = playing ? c.hold : NaN;
    // (追加) 動画の頭より前から流している: 的が頭に着くまでの残りを始めの待ちとみて、頭に着く前に流し始める(着いてから流すと
    //   動き出しの遅れの分だけ遅れ、その後の待ち(_await)の間は寄せない)
    let preStart = false;
    if (playing && tg < 0 && end > 0) {
      const until = (-tg / base) * 1000 + (Number.isFinite(hold) ? hold : 0);
      if (until <= this._startLead * 1000 + 100) {
        preStart = true;
        hold = until;
      }
    }
    // 終わりの 2 コマは流さない(終わった動画に play を呼ぶと頭へ戻る)
    const live = playing && (!out || preStart) && !(end < Infinity && want >= end - 2 * fr);
    if (!live) {
      // 止めた: 流していた動画は止めたコマより 1 コマほど先の絵を出していることがあるので、1 回は半コマの内でも seek し直す
      if (this._vplay) {
        try { v.pause(); } catch (e) { /* 止まっている */ }
        this._vplay = false;
        this._reseek = true;
      }
      this._await = null;
      this._hold = 0;
      this._startAt = 0; // 止めている間(動画の外)は始めの待ちを数え直す
      this._seekStopped(want, fr);
      return;
    }
    // 終わった動画: play を呼ぶと頭へ戻るので呼ばない。的の所へ戻し、着いたら始めと同じく流し直す
    if (v.ended) {
      this._vplay = false;
      this._hold = 0;
      this._holdSeek = false;
      this._seekPlay = false;
      this._await = null;
      this._startAt = 0;
      if (!this._seeking && !v.seeking && now - this._seekAt >= Q.endedSeekMs) {
        this.stats.stopSeeks++;
        this._seekTo(want);
      }
      return;
    }
    // 流している間に編集の時計が止まった(頭から鳴らし直した): 止めて頭の絵に合わせ、始めと同じく流し直す
    if (this._vplay && hold > this._startLead * 1000 + 20) {
      try { v.pause(); } catch (e) { /* 止まっている */ }
      this._vplay = false;
      this._await = null;
      this._hold = 0;
      this._startAt = now;
      this._startTg = tg;
    }
    if (!this._vplay) {
      // 再生の始め: 動画は play から絵が動き出すまで遅れる(_startLead)ので、編集の時計が動き出す残りの時間がその遅れになったら流す。
      //   止まっている動画の所(currentTime。一番近いコマを出すので的から半コマほど先)が的より先なら、その分だけ遅く流す。
      //   流すのはその時刻に一番近いフレーム。残りが読めなければ、編集の時計が動き出してから流す
      if (!this._startAt) {
        this._startAt = now;
        this._startTg = tg;
      }
      const lead = this._startLead - (v.currentTime - want) / base;
      const wait = Number.isFinite(hold) ? hold > lead * 1000 + dtF / 2 : tg === this._startTg;
      if (wait && now - this._startAt < Q.startWaitMs) {
        this._seekStopped(want, fr);
        return;
      }
      if (this._seeking || v.seeking) return;
      this._vplay = true;
      this._setRate(base);
      // 止まっていたときの絵から少し動いただけなら seek しないで流す(seek は遅い。ずれは寄せて直す)。離れていれば先へ seek して待つ
      if (Math.abs(v.currentTime - want) > Q.seekS) {
        this._seekHold(want, base, now, fr);
        return;
      }
      this._newAwait(now, 'start');
      this._play();
      return;
    }
    if (this._seeking || v.seeking) return;
    // 先に着いたので止めて待っている: 的が play の遅れの分だけ手前まで来たら流し直す。(追加) 待っている間に的が大きく飛んだ
    //   (頭から鳴らし直した・別の区間を繰り返した)なら、待つのをやめて的の所へ seek し直す(待ち切ってから流して seek すると 2 秒ほど違う絵だった)
    if (this._hold) {
      if (this._jumped(want, now, base)) {
        this.stats.seeks++;
        this._seekHold(want, base, now, fr);
        return;
      }
      const lead = this._holdSeek ? this._seekStartLead : this._startLead;
      if (v.currentTime - want > (lead + dtF / 2000) * base && now - this._hold < Q.holdMaxMs) return;
      this._hold = 0;
      this._setRate(base);
      this._newAwait(now, this._holdSeek ? 'seekstart' : 'start');
      this._holdSeek = false;
      this._play();
      return;
    }
    if (v.paused || v.ended) {
      this._play();
      return;
    }
    // 読み込みを待っている(readyState < HAVE_FUTURE_DATA): ずれを数えず seek もしない(seek するとまた待つ)
    if (v.readyState < 3) {
      if (!this._stallAt) this._stallAt = now;
      if (now - this._stallAt < Q.stallMaxMs) {
        this._setRate(base);
        return;
      }
    } else this._stallAt = 0;
    // play の後: 絵が動き出して落ち着くまで待ち(その間はずれを数えず、速さも寄せない)、見えたコマで遅れを測って次の見込みにする
    const A = this._await;
    if (A) {
      const el = now - A.at;
      // 後ろへ動いた: 遅れの見込みに入れない。(追加) 的が大きく飛んだ: 待たずに下のずれで直す
      if (A.back || v.currentTime < A.pos - Q.moveS || this._jumped(want, now, base)) this._await = null;
      else if (A.rv) {
        if (!((el >= Q.latWinMs[1] && A.s.length >= Q.latMinN) || el > Q.awaitMaxMs)) {
          this._setRate(base);
          return;
        }
        const lat = A.s.length >= Q.latMinN ? median(A.s) : NaN;
        if (Number.isFinite(lat)) {
          if (A.kind === 'seekstart') {
            VideoSync.leads.seekStart = this._seekStartLead = leadEma(this._seekStartLead, lat, Q.startLeadMinS, Q.seekStartMaxS, Q.latAlpha);
          } else {
            VideoSync.leads.start = this._startLead = leadEma(this._startLead, lat, Q.startLeadMinS, Q.startLeadMaxS, Q.latAlpha);
            if (!Number.isFinite(VideoSync.leads.seekStart)) this._seekStartLead = this._startLead;
          }
        }
        this._lastLat = { kind: A.kind, n: A.s.length, lat };
        this._await = null;
      } else if (Math.abs(v.currentTime - A.pos) < (A.kind === 'seekstart' ? Q.settleS : Q.moveS)) {
        if (el > Q.awaitMaxMs) this._await = null;
        this._setRate(base);
        return;
      } else this._await = null;
    }
    // ずれ: 見えるコマのずれ P(見えるコマ − currentTime の平均)が分かれば足す(見えるコマの平均を的に合わせる)
    const cDrift = v.currentTime - want;
    const P = this._picSample(now, tg, dtF, base);
    this._picLock = Number.isFinite(P);
    const drift = this._picLock ? cDrift + P : cDrift;
    // 動画が的より先で 0.5 秒まで: seek し直さず止めて待つ
    if (drift > Q.seekS && drift <= Q.holdMaxS) {
      try { v.pause(); } catch (e) { /* 止まっている */ }
      this._hold = now;
      this._holdSeek = false;
      this._markWait(want, now);
      this.stats.holds++;
      return;
    }
    const r = driftControl(drift, base, this._held, this._picLock ? { nudgeS: Q.picNudgeS, releaseS: Q.picReleaseS } : null);
    if (r.seek) {
      this.stats.seeks++;
      this._held = 0;
      this._setRate(base);
      this._seekHold(want, base, now, fr);
      return;
    }
    if (r.rate !== base) this.stats.nudges++;
    this._held = r.rate > base ? 1 : r.rate < base ? -1 : 0;
    this._setRate(r.rate);
    const a = Math.abs(v.currentTime - want);
    this.stats.n++;
    this.stats.sumAbs += a;
    if (a > this.stats.maxAbs) this.stats.maxAbs = a;
  }

  /**
   * 落ち着いた再生のフレームで、見えるコマのずれ(見えているコマの mediaTime − currentTime)を測って今の速さの見込み(VideoSync.pics)に足し、
   * 使う P(秒。まだ使えなければ NaN)を返す。測るのは rVFC があり、最後の seek の後のコマが picStaleMs の内に来たときだけ。
   */
  _picSample(now, tg, dtF, base) {
    const Q = SYNC;
    const v = this.v;
    const key = picKey(base);
    let o = VideoSync.pics.get(key) || null;
    const p = this.presented;
    const fresh = typeof v.requestVideoFrameCallback === 'function' && this._presGen === this._seekGen && Number.isFinite(p) && now - this._presAt <= Q.picStaleMs;
    if (fresh) {
      const gap = now - this._picLast;
      const dt = (this._picLast > 0 && gap > 0 && gap <= Q.picStaleMs ? Math.min(gap, 50) : dtF) / 1000;
      this._picLast = now;
      o = picUpdate(o, p - v.currentTime, dt, Q.picTauS);
      VideoSync.pics.set(key, o);
      const e = p - tg;
      const s = this.stats;
      s.picN++;
      s.picSum += e;
      if (Math.abs(e) > s.picMaxAbs) s.picMaxAbs = Math.abs(e);
    }
    return picUse(o, Q.picMinS, Q.picMaxS);
  }

  /**
   * 再生中の seek: 動画を止め、seek の遅れの見込みと余りだけ先へ seek し、着いたら的が play の遅れの分だけ手前に来るまで止めて待ってから
   * 流す(_hold)。先へ seek する所は動画の終わりの 2 コマより前で切る(終わりに着くと ended になり、流し直す play で頭へ戻る)。
   */
  _seekHold(want, base, now, fr) {
    try { this.v.pause(); } catch (e) { /* 止まっている */ }
    this._await = null;
    let t = want + (this._lead + SYNC.seekPadS) * base;
    const end = this.endS();
    if (end < Infinity) t = Math.min(t, Math.max(want, end - 2 * fr - 0.001));
    this._seekTo(t);
    this._seekPlay = true;
    this._hold = now;
    this._holdSeek = true;
    this._markWait(want, now);
  }

  /** 止まっているとき: 見えているコマが的に一番近いコマでなければ、的 + 半コマへ seek(seek 中は待ち、seeked の後に最後の的へ)。 */
  _seekStopped(want, fr) {
    if (this._seeking || this.v.seeking) return;
    if (this._reseek) this._reseek = false;
    else if (this._frameOk(want, fr)) return;
    this.stats.stopSeeks++;
    this._seekTo(this._stopPos(want, fr));
  }

  /** 止まっているときに seek する所: 的に一番近いコマが出る所 = 的 + 半コマ(頭・終わりの手前で切る)。 */
  _stopPos(want, fr) {
    return clamp(want + fr / 2, 0, this._maxT(fr));
  }

  /**
   * 止まっているとき、見えているコマが的に一番近いコマか。最後の seek の後に出たコマ(rVFC の mediaTime)が分かれば、そのコマの pts と的の差が
   * 半コマの内か(終わりの 2 コマの内で的が最後のコマより後・頭の 1 コマの内で的がそれより前ならそのまま)。今の currentTime がこの的の seek する所と
   * 同じならもう合わせた(コマが 1/fps より長い動画など)。コマが分からない間は、最後に seek した所がこの的の seek する所から半コマの内か。
   */
  _frameOk(want, fr) {
    const v = this.v;
    const cur = Number(v.currentTime);
    const pos = this._stopPos(want, fr);
    if (Math.abs(cur - pos) < 1e-4) return true;
    const p = this.presented;
    if (this._presGen === this._seekGen && Number.isFinite(p)) {
      const d = want - p;
      if (Math.abs(d) <= fr / 2 + SYNC.nearTolS) return true;
      const end = this.endS();
      if (end < Infinity && d > 0 && want >= end - 2 * fr && p >= end - 2 * fr - 1e-4) return true;
      return d < 0 && p < fr - 1e-4;
    }
    return Math.abs(cur - pos) <= fr / 2;
  }

  _seekTo(t) {
    this._seeking = true;
    this._seekAt = this._now();
    this._seekGen++;
    try { this.v.currentTime = Math.max(0, t); } catch (e) { this._seeking = false; }
  }

  _play() {
    const v = this.v;
    if (v.ended) {
      this._vplay = false; // 終わった動画に play を呼ぶと頭へ戻る(呼ぶ側が的へ seek し直す)
      return;
    }
    let p = null;
    try {
      p = v.play();
    } catch (e) {
      p = null;
      this._vplay = false;
    }
    if (p && typeof p.catch === 'function') {
      p.catch((e) => {
        if (!this.disposed && e && e.name !== 'AbortError') {
          this._vplay = false;
          console.warn('動画を流せない:', e);
        }
      });
    }
  }

  _setRate(r) {
    const v = this.v;
    if (Math.abs(v.playbackRate - r) > SYNC.rateEps) {
      try { v.playbackRate = r; } catch (e) { /* 範囲の外 */ }
      const A = this._await;
      if (A && A.rv && A.segs) A.segs.push([this._now(), Number(v.playbackRate) || r]);
    }
  }

  /** 止める(再生と関係なく。タブが隠れたときなど)。次の sync で合わせ直す。 */
  pause() {
    try { this.v.pause(); } catch (e) { /* 止まっている */ }
    this._vplay = false;
    this._hold = 0;
    this._await = null;
  }

  /** 確かめ用。 */
  debug() {
    const v = this.v;
    const s = this.stats;
    const pics = [...VideoSync.pics.entries()].map(([k, o]) => [k, o ? Math.round(o.avg * 1e5) / 100 : null, o ? Math.round(o.w * 100) / 100 : 0]);
    return {
      target: this.target, current: v.currentTime, presented: this.presented, paused: v.paused, rate: v.playbackRate, out: this.out,
      meta: this.meta, fps: this.fpsSeen, lead: this._lead, startLead: this._startLead, seekStartLead: this._seekStartLead, lastLat: this._lastLat,
      drift: { n: s.n, avgMs: s.n ? (s.sumAbs / s.n) * 1000 : 0, maxMs: s.maxAbs * 1000, seeks: s.seeks, nudges: s.nudges, stopSeeks: s.stopSeeks, holds: s.holds },
      picture: { n: s.picN, meanMs: s.picN ? (s.picSum / s.picN) * 1000 : 0, maxMs: s.picMaxAbs * 1000, lock: this._picLock, offsets: pics },
    };
  }

  resetStats() {
    this.stats = VideoSync.newStats();
  }
}

/** このページで測った play の遅れの見込み(秒。次に作る VideoSync の始めの値)。 */
VideoSync.leads = { start: NaN, seekStart: NaN };
/** このページで測った見えるコマのずれ P(速さの鍵 picKey → {avg, w})。 */
VideoSync.pics = new Map();
