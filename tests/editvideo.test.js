// 譜面の編集のプレー動画(js/edit/video.js・videosync.js・videoalign.js)の決まった計算のテスト。
// 合わせ方は本物の <video> の代わりに、Chrome の振る舞い(seek の遅れ・play の遅れ・止まっている動画は seek した時刻を含むコマを出す・
// 見えるコマは currentTime より少し遅れる)をまねた模型で回す。編集画面に組み込んだ所は tests/editor.test.js の 'editor video:'。
import { test, assert, assertEq, assertNear } from './runner.js';
import {
  formatOffset, offsetStep, normCrop, shownAspect, fitCrop, sharePanes, stageLayout, bgmAnchorMs, looksVideo, fileKey,
  VIDEO_MIN_W, VIDEO_CANVAS_MIN, VIDEO_MAX_SHARE,
} from '../js/edit/video.js';
import {
  VideoSync, SYNC, driftControl, picUpdate, picKey, picUse, leadEma, mediaAdvance, median, estimateFps,
} from '../js/edit/videosync.js';
import { onsetEnvelope, fft, crossCorrelate, peakOf, findOffset, refineLag, ALIGN } from '../js/edit/videoalign.js';
import { previewWidth, PREVIEW_MIN_W } from '../js/edit/preview.js';
import { COMPACT_BELOW } from '../js/edit/view.js';
import { parseDTX } from '../js/core/dtx.js';

// ---- 見出し・ずれ・切り出し ----

test('editvideo: offset text and steps (1 frame, Shift 10 frames, Alt 1 ms)', () => {
  assertEq(formatOffset(1563.04), '+1563.0 ms');
  assertEq(formatOffset(-16.66), '−16.7 ms');
  assertEq(formatOffset(0), '+0.0 ms');
  assertEq(formatOffset(NaN), '—');
  assertNear(offsetStep(100, 1, {}, 60), 116.667, 1e-9, '1 コマ');
  assertNear(offsetStep(100, -1, { shiftKey: true }, 60), -66.667, 1e-9, '10 コマ');
  assertEq(offsetStep(100, 1, { altKey: true }, 60), 101, 'Alt は 1 ms');
  assertNear(offsetStep(0, 1, {}, 30), 33.333, 1e-9, '30 fps の 1 コマ');
  assert(looksVideo({ name: 'a.MP4', type: '' }) && looksVideo({ name: 'x', type: 'video/webm' }) && !looksVideo({ name: 'a.zip', type: 'application/zip' }));
  assertEq(fileKey({ name: 'a.mp4', size: 12 }), 'a.mp4|12');
});

test('editvideo: crop rectangle — normalized, the cropped area fills the box (contain), aspect follows the crop', () => {
  assertEq(normCrop(null), null);
  assertEq(normCrop({ x: 0, y: 0, w: 1, h: 1 }), null, '全体は切り出さない');
  assertEq(normCrop({ x: 0.5, y: 0.5, w: 0.01, h: 0.5 }), null, '小さすぎる');
  const c = normCrop({ x: 0.9, y: -1, w: 0.5, h: 2 });
  assertNear(c.x, 0.9, 1e-12);
  assertNear(c.w, 0.1, 1e-12, '右端で切る');
  assertEq(c.y, 0);
  assertEq(c.h, 1);
  assertNear(shownAspect(1280, 720, null), 16 / 9, 1e-12);
  assertNear(shownAspect(1280, 720, { x: 0.25, y: 0, w: 0.5, h: 1 }), 640 / 720, 1e-12);
  assertEq(shownAspect(0, 720, null), null);
  // 全体: 640x360 の箱に 1280x720 → 640x360(余白なし)
  let b = fitCrop(640, 400, 1280, 720, null);
  assertNear(b.width, 640, 1e-9);
  assertNear(b.height, 360, 1e-9);
  assertNear(b.top, 20, 1e-9, '縦の真ん中');
  // 横の真ん中の半分を切り出す: 切り出した 640x720 が 400x450 の箱いっぱい(高さで決まる)
  b = fitCrop(400, 450, 1280, 720, { x: 0.25, y: 0, w: 0.5, h: 1 });
  const s = 450 / 720;
  assertNear(b.height, 450, 1e-9);
  assertNear(b.width, 1280 * s, 1e-9);
  assertNear(b.cw, 640 * s, 1e-9);
  assertNear(b.left + 0.25 * b.width, b.cx, 1e-9, '切り出した範囲の左端が見える所の左端');
  assertNear(b.cx, (400 - 640 * s) / 2, 1e-9, '横の真ん中');
});

test('editvideo: preview and video share the room (wider one shrinks first, mins kept)', () => {
  assertEq(sharePanes(300, 200, 600, 160, 240).join(), '300,200', '入れば元の幅');
  assertEq(sharePanes(400, 400, 600, 160, 240).join(), '300,300', '同じだけ縮める');
  assertEq(sharePanes(200, 700, 600, 160, 240).join(), '200,400', '広い方から');
  assertEq(sharePanes(700, 250, 600, 160, 240).join(), '350,250');
  assertEq(sharePanes(160, 700, 400, 160, 240).join(), '160,240');
  assertEq(sharePanes(700, 700, 400, 160, 240).join(), '160,240', '真ん中で割ると動画が下限を割るので下限');
  assertEq(sharePanes(700, 700, 600, 160, 240).join(), '300,300');
});

test('editvideo: stage layout — without the video it is the preview layout of before; with it the canvas keeps the wide width, and showing never depends on the height', () => {
  // 動画を出さないときは前の決まり(js/edit/editor.js の onResize に書いていた式)と同じ
  const old = (avail, h, canDock, panelOpen) => {
    const forceCompact = !canDock && avail >= COMPACT_BELOW && avail < COMPACT_BELOW + PREVIEW_MIN_W;
    const covered = panelOpen && !canDock && !forceCompact && avail >= COMPACT_BELOW;
    const pw = forceCompact ? previewWidth(avail, h) : !covered ? previewWidth(avail, h, COMPACT_BELOW) : 0;
    const block = pw ? null : covered || (canDock && previewWidth(avail + 320, h, COMPACT_BELOW)) ? 'panel' : 'size';
    return `${forceCompact}|${pw}|${block}`;
  };
  for (const avail of [300, 500, 700, 719, 720, 800, 879, 880, 1000, 1180, 1600, 1898]) {
    for (const h of [100, 600, 950]) {
      for (const [canDock, panelOpen] of [[false, false], [false, true], [true, true]]) {
        const l = stageLayout({ avail, h, canDock, panelOpen, dockW: 320, preview: true, video: false, videoNatural: 0 });
        assertEq(`${l.compact}|${l.pw}|${l.previewBlock}`, old(avail, h, canDock, panelOpen), `avail=${avail} h=${h} dock=${canDock}`);
        assertEq(l.vw, 0);
      }
    }
  }
  // 広い窓(1920 のパネルなし): 広い配置で編集画面に COMPACT_BELOW 以上、両方を並べる
  let l = stageLayout({ avail: 1898, h: 900, canDock: false, panelOpen: false, dockW: 320, preview: true, video: true, videoNatural: 700 });
  assert(!l.compact && l.pw >= PREVIEW_MIN_W && l.vw >= VIDEO_MIN_W && 1898 - l.pw - l.vw >= COMPACT_BELOW, JSON.stringify(l));
  // 動画だけ: 元の幅(場所の 45 % までは呼ぶ側が切る)
  l = stageLayout({ avail: 1898, h: 900, canDock: false, panelOpen: false, dockW: 320, preview: false, video: true, videoNatural: 600 });
  assertEq(l.vw, 600);
  assertEq(l.pw, 0);
  // 寄せたパネルで入らない(1366 の窓): 出さずに 'panel'(閉じれば入る)
  l = stageLayout({ avail: 1024, h: 650, canDock: true, panelOpen: true, dockW: 320, preview: true, video: true, videoNatural: 500 });
  assertEq(l.vw, 0);
  assertEq(l.videoBlock, 'panel');
  assert(l.pw > 0, 'プレビューは前のまま');
  // 重ねたパネル(寄せない窓の広い配置)の下には出さない
  l = stageLayout({ avail: 1000, h: 650, canDock: false, panelOpen: true, dockW: 320, preview: false, video: true, videoNatural: 500 });
  assertEq(`${l.vw}|${l.videoBlock}`, '0|panel');
  // プレビューをしまえば入る幅なら 'preview'
  l = stageLayout({ avail: 700, h: 650, canDock: false, panelOpen: false, dockW: 320, preview: true, video: true, videoNatural: 500 });
  assertEq(`${l.vw}|${l.videoBlock}`, '0|preview');
  // 広げていくと、一度出た動画は消えない(高さによらない)
  for (const h of [120, 500, 1000]) {
    for (const preview of [false, true]) {
      let seen = false;
      for (let avail = 300; avail <= 2000; avail += 7) {
        const r = stageLayout({ avail, h, canDock: false, panelOpen: false, dockW: 320, preview, video: true, videoNatural: Math.min(Math.round(h * 0.76), Math.floor(avail * VIDEO_MAX_SHARE)) });
        if (r.vw) seen = true;
        else assert(!seen, `広げたら消えた avail=${avail} h=${h} preview=${preview}`);
        if (r.vw) {
          const keep = r.compact || avail < COMPACT_BELOW ? VIDEO_CANVAS_MIN : COMPACT_BELOW;
          assert(avail - r.pw - r.vw >= keep, `編集画面を残す avail=${avail}`);
          assert(r.vw >= VIDEO_MIN_W && (!preview || r.pw >= PREVIEW_MIN_W || r.pw === 0), JSON.stringify(r));
        }
        const r2 = stageLayout({ avail, h: h * 2, canDock: false, panelOpen: false, dockW: 320, preview, video: true, videoNatural: 300 });
        assertEq(!!r2.vw, !!r.vw, `出すかは高さによらない avail=${avail}`);
        assertEq(r2.compact, r.compact);
      }
      assert(seen);
    }
  }
});

test('editvideo: the offset is kept from the first BGM chip (lead-in measure included)', () => {
  const chart = parseDTX('#BPM: 120\n#WAV09: bgm.wav\n#BGMWAV: 09\n#00101: 0009\n#00111: 01\n');
  // リードイン 2000 ms + 小節 001 の半ば(2000 + 1000)
  assertNear(bgmAnchorMs(chart), 2000 + 2000 + 1000, 1e-9);
  assertEq(bgmAnchorMs(parseDTX('#BPM: 120\n#00111: 01\n')), 0, 'BGM が無ければ 0');
  assertEq(bgmAnchorMs(null), 0);
});

// ---- 合わせ方の決まった計算(SoundVoltexAnalyze と同じ) ----

test('editvideo: drift control (catch up 60–300 ms behind, seek beyond, ±2 % nudge with hysteresis)', () => {
  assertEq(driftControl(-0.1, 1, 0).rate, 1.15, '遅れは速めて追い付く');
  assert(driftControl(-0.4, 1, 0).seek, '大きく遅れたら seek');
  assert(driftControl(0.07, 1, 0).seek, '先(止めて待つかは呼ぶ側)');
  assertEq(driftControl(0.02, 1, 0).rate, 0.98, '先なら遅く');
  assertEq(driftControl(-0.02, 1, 0).rate, 1.02);
  assertNear(driftControl(0.04, 1, 0).rate, 0.9, 1e-12, '30 ms を越えたらずれに比例(0.4 秒で寄せ切る速さ)');
  assertNear(driftControl(-0.05, 1, 0).rate, 1.125, 1e-12);
  assertNear(driftControl(0.059, 2, 0).rate, 2 * (1 - 0.059 / 0.4), 1e-12, '編集の速さに掛ける');
  assertEq(driftControl(0.008, 1, 0).rate, 1, '12 ms の内は寄せない');
  assertEq(driftControl(0.008, 1, -1).rate, 0.98, '寄せ始めたら 5 ms まで続ける');
  assertEq(driftControl(0.004, 1, -1).rate, 1);
  assertEq(driftControl(0.008, 1, 0, { nudgeS: 0.006, releaseS: 0.002 }).rate, 0.98, '見えるコマが分かれば狭い幅');
  assert(driftControl(NaN, 1, 0).seek);
});

test('editvideo: picture offset average, rate keys, play-latency EMA, rate polyline, median, fps estimate', () => {
  let o = null;
  for (let i = 0; i < 10; i++) o = picUpdate(o, 0.01, 0.05, 4);
  assertNear(o.avg, 0.01, 1e-12);
  assertNear(o.w, 0.5, 1e-12);
  assertNear(picUse(o, 0.5, 2 / 60), 0.01, 1e-12, '0.5 秒で使い始める');
  assertEq(Number.isNaN(picUse(picUpdate(null, 0.01, 0.1, 4), 0.5, 2 / 60)), true, 'まだ使わない');
  for (let i = 0; i < 400; i++) o = picUpdate(o, 0.02, 0.05, 4);
  assert(o.w === 4 && Math.abs(o.avg - 0.02) < 0.001, '4 秒の指数移動平均: ' + JSON.stringify(o));
  assertNear(picUse({ avg: 1, w: 9 }, 0.5, 2 / 60), 2 / 60, 1e-12, '±2 コマに収める');
  assertEq(picKey(1), '1.00');
  assertEq(picKey(0.98), '1.00');
  assertEq(picKey(0.74), '0.75');
  assertEq(picKey(NaN), '1.00');
  assertNear(leadEma(0.06, 0.02, 0.03, 0.15, 0.5), 0.045, 1e-12, '下限で切ってから半分寄せる');
  assertNear(leadEma(NaN, 0.5, 0.03, 0.15, 0.5), 0.15, 1e-12);
  assertNear(leadEma(0.1, NaN, 0.03, 0.15, 0.5), 0.1, 1e-12);
  assertNear(mediaAdvance([[0, 1], [100, 2]], 200), 0.3, 1e-12, '速さの折れ線');
  assertNear(mediaAdvance([[0, 1.5]], 100), 0.15, 1e-12);
  assertEq(median([3, 1, 2]), 2);
  assertEq(median([4, 1, 3, 2]), 2.5);
  assert(Number.isNaN(median([])));
  const gaps = (fps, n) => Array.from({ length: n }, () => 1 / fps);
  assertEq(estimateFps(gaps(60, 20)), 60, '60 と 59.94 は近い方');
  assertEq(estimateFps(gaps(59.94, 20)), 59.94);
  assertEq(estimateFps(gaps(30, 20)), 30);
  assertEq(estimateFps(gaps(23.976, 20)), 23.976);
  assert(Number.isNaN(estimateFps(gaps(60, 5))), '足りなければ分からない');
  assertEq(estimateFps([...gaps(60, 20), 2 / 60, 3 / 60]), 60, '飛ばしたコマは数えない');
  // 60 Hz の画面で 60 fps を ×1.5 で流すと 1 コマおきに飛ばして見せる(間は 1/60 と 2/60 が半々、2/60 が多くても)
  const mix = (a, b) => [...Array.from({ length: a }, () => 1 / 60), ...Array.from({ length: b }, () => 2 / 60)];
  assertEq(estimateFps(mix(60, 60)), 60, '半々');
  assertEq(estimateFps(mix(30, 90)), 60, '飛ばした方が多い');
  // ms の刻みの webm(16 / 17 / 17 ms)
  assertEq(estimateFps(Array.from({ length: 60 }, (_, i) => (i % 3 ? 0.017 : 0.016))), 60, 'ms の刻み');
  assert(Number.isNaN(estimateFps(gaps(37, 30))), 'よくある速さに寄らなければ使わない');
  assertEq(estimateFps([...gaps(60, 117), 0.003, 0.003, 0.003]), 60, '1 割の所より短い間は数えない');
});

// ---- 合わせ方(模型の <video>) ----

/**
 * Chrome の <video> の模型(js/edit/videosync.js が使う所だけ): seek は seekMs で着き、止まっている動画は seek した時刻を含むコマを出す。
 * play は playLatMs の後に動き出す(currentTime はそれまで止まる)。流しているときに見えるコマは currentTime の decodeLagMs 前のコマ。
 * 終わりに着くと止まって ended。終わった動画に play を呼ぶと頭へ戻る。
 */
class FakeVideo {
  constructor({ dur = 120, fps = 60, t0 = 1 / 60, seekMs = 30, playLatMs = 45, decodeLagMs = 8 } = {}) {
    Object.assign(this, { duration: dur, fps, t0, seekMs, playLatMs, decodeLagMs });
    this.now = 0;
    this._ct = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.readyState = 4;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.videoWidth = 1280;
    this.videoHeight = 720;
    this.error = null;
    this._seek = null;
    this._moveAt = 0;
    this._cbs = [];
    this._id = 0;
    this._L = {};
    this._shown = NaN;
    this._frames = 0;
    this.plays = 0;
    this.playsWhileEnded = 0;
  }

  addEventListener(type, fn) { (this._L[type] || (this._L[type] = [])).push(fn); }
  removeEventListener(type, fn) { this._L[type] = (this._L[type] || []).filter((f) => f !== fn); }
  _fire(type) { for (const fn of this._L[type] || []) fn({ type }); }

  get currentTime() { return this._ct; }
  set currentTime(t) {
    this.seeking = true;
    this.ended = false;
    this._seek = { t: Math.max(0, Math.min(this.duration, t)), at: this.now + this.seekMs };
  }

  play() {
    this.plays++;
    if (this.ended) {
      this.playsWhileEnded++;
      this._ct = 0;
      this.ended = false;
    }
    if (this.paused) {
      this.paused = false;
      this._moveAt = this.now + this.playLatMs;
    }
    return Promise.resolve();
  }

  pause() { this.paused = true; }

  requestVideoFrameCallback(cb) {
    this._cbs.push([++this._id, cb]);
    return this._id;
  }

  cancelVideoFrameCallback(id) { this._cbs = this._cbs.filter(([i]) => i !== id); }

  /** t を含むコマの pts。 */
  frameAt(t) {
    const fr = 1 / this.fps;
    if (t < this.t0) return this.t0;
    return this.t0 + Math.floor((t - this.t0) / fr + 1e-9) * fr;
  }

  _present(now, t) {
    const f = this.frameAt(t);
    if (f === this._shown) return;
    this._shown = f;
    this._frames++;
    const cbs = this._cbs;
    this._cbs = [];
    for (const [, cb] of cbs) cb(now, { mediaTime: f, presentedFrames: this._frames });
  }

  /** 時刻 now まで進める。 */
  tick(now) {
    const dt = now - this.now;
    this.now = now;
    if (this._seek && now >= this._seek.at) {
      this._ct = this._seek.t;
      this._seek = null;
      this.seeking = false;
      this._present(now, this._ct);
      this._fire('seeked');
    }
    if (!this.paused && !this.seeking && now > this._moveAt) {
      const run = Math.min(dt, now - this._moveAt);
      this._ct += (run * this.playbackRate) / 1000;
      if (this._ct >= this.duration) {
        this._ct = this.duration;
        this.paused = true;
        this.ended = true;
        this._fire('ended');
      }
      this._present(now, Math.max(0, this._ct - (this.decodeLagMs * this.playbackRate) / 1000));
    }
  }
}

/** 模型と VideoSync を組む(時計は模型の時刻)。 */
function rig(opts) {
  const v = new FakeVideo(opts);
  const s = new VideoSync(v, { now: () => v.now });
  s.start();
  v._fire('loadedmetadata');
  return { v, s };
}

/** 止まったまま的 tg に合わせ、seek が終わるまで回す。 */
function settle(v, s, tg, t0) {
  let now = t0;
  for (let i = 0; i < 100; i++) {
    now += 1000 / 120;
    v.tick(now);
    s.sync(now, { playing: false, tg, hold: NaN, rate: 1, fps: 60 });
    if (!s.seeking && i > 8) break;
  }
  return now;
}

test('editvideo sync: stopped — seeks to target + half a frame so the nearest frame shows, never overlaps seeks, does not reseek when already right', () => {
  VideoSync.leads = { start: NaN, seekStart: NaN };
  VideoSync.pics = new Map();
  const { v, s } = rig();
  assertEq(v.preservesPitch, false, 'preservesPitch を切る');
  let now = 0;
  const fr = 1 / 60;
  for (const tg of [5, 5.0001, 5.009, 5.0084, 12.345, 0, 0.004, 119.999, 200]) {
    now = settle(v, s, tg, now);
    const want = Math.min(Math.max(tg, 0), v.duration - 0.001);
    const p = s.presented;
    if (tg <= v.t0) assertEq(p, v.t0, '頭より前は最初のコマ');
    else if (tg >= v.duration - 2 * fr) assert(p >= v.duration - 2 * fr - 1e-9, `終わりの近くは最後のコマ ${tg} → ${p}`);
    else assert(Math.abs(want - p) <= fr / 2 + 1e-9, `一番近いコマ ${tg} → ${p}`);
  }
  assert(s.out, '長さより後は動画の外');
  // もう合っていれば seek しない
  const n = s.stats.stopSeeks;
  now = settle(v, s, 200, now);
  now = settle(v, s, 7.5, now);
  const n2 = s.stats.stopSeeks;
  now = settle(v, s, 7.5 + 0.003, now);
  assertEq(s.stats.stopSeeks, n2, '半コマの内の動きでは seek しない');
  assert(n2 > n);
  // seek 中は次の seek を頼まない(続けて動かしても seek は重ならない)
  const seeks0 = s.stats.stopSeeks;
  for (let i = 0; i < 10; i++) {
    now += 2;
    v.tick(now);
    s.sync(now, { playing: false, tg: 20 + i * 0.1, hold: NaN, rate: 1, fps: 60 });
  }
  assert(s.stats.stopSeeks - seeks0 <= 1, '重ならない: ' + (s.stats.stopSeeks - seeks0));
  now = settle(v, s, 21, now);
  assert(Math.abs(s.presented - 21) <= fr / 2 + 1e-9, '最後の的だけを追う');
  s.dispose();
});

/**
 * 編集の時計(開始位置 startS から、hold ms の後に rate で動く)で playMs だけ流し、毎フレームのずれを返す。
 * jumpAt(ms)・jumpBy(秒): その時刻に時計を戻す(区間の折り返し)。
 */
function runPlay(v, s, { startS, holdMs = 40, rate = 1, playMs = 4000, now0, jumpAt = -1, jumpBy = 0 }) {
  let now = settle(v, s, startS, now0);
  const t0 = now;
  const rows = [];
  let base = startS;
  let anchor = t0 + holdMs;
  for (; now < t0 + playMs;) {
    now += 1000 / 120;
    if (jumpAt > 0 && now - t0 >= jumpAt && base === startS) {
      base = startS + ((now - anchor) * rate) / 1000 - jumpBy;
      anchor = now;
    }
    const hold = Math.max(0, anchor - now);
    const tg = base + (Math.max(0, now - anchor) * rate) / 1000;
    v.tick(now);
    s.sync(now, { playing: true, tg, hold, rate, fps: 60 });
    rows.push({ t: now - t0, tg, ct: v.currentTime, pres: s.presented, paused: v.paused });
  }
  // 止める
  for (let i = 0; i < 20; i++) {
    now += 1000 / 120;
    v.tick(now);
    s.sync(now, { playing: false, tg: rows[rows.length - 1].tg, hold: NaN, rate, fps: 60 });
  }
  return { rows, now };
}

test('editvideo sync: playing — starts on the editor clock, stays within 20 ms after the first second without seeking; the visible frame mean lands near the target', () => {
  VideoSync.leads = { start: NaN, seekStart: NaN };
  VideoSync.pics = new Map();
  const { v, s } = rig({ playLatMs: 45, decodeLagMs: 10 });
  let now = 0;
  for (let k = 0; k < 4; k++) {
    s.resetStats();
    const r = runPlay(v, s, { startS: 10 + k * 7, holdMs: 40, now0: now });
    now = r.now;
    const after = r.rows.filter((x) => x.t > 1000);
    const maxCt = Math.max(...after.map((x) => Math.abs(x.ct - x.tg)));
    assert(maxCt < 0.02, `${k}: 1 秒より後の currentTime のずれ ${(maxCt * 1000).toFixed(1)} ms`);
    assertEq(s.stats.seeks, 0, `${k}: 流している間に seek しない`);
    assertEq(s.stats.holds, 0, `${k}: 止めて待たない`);
    if (k >= 2) {
      const pm = after.reduce((a, x) => a + (x.pres - x.tg), 0) / after.length;
      assert(Math.abs(pm) < 0.01, `${k}: 見えるコマの平均 ${(pm * 1000).toFixed(1)} ms`);
    }
    assert(v.paused, '止めたら止まる');
  }
  assert(s._startLead > SYNC.startLeadMinS - 1e-9 && s._startLead < SYNC.startLeadMaxS, '遅れを測った: ' + s._startLead);
  assert(VideoSync.leads.start === s._startLead, 'ページで覚える');
  // ×0.5・×1.5: 寄せるのは見えるコマ(模型は見えるコマが currentTime の 10 ms × 速さ前 + コマの格子の位相なので、×1.5 の currentTime は
  // 的より 20 ms ほど先になる)。見えるコマの平均が的の ±10 ms、1 つ 1 つは ±1 コマ + 10 ms の内
  for (const rate of [0.5, 1.5]) {
    s.resetStats();
    const r = runPlay(v, s, { startS: 50, holdMs: 30, rate, now0: now, playMs: 4000 });
    now = r.now;
    const after = r.rows.filter((x) => x.t > 1500);
    const pm = after.reduce((a, x) => a + (x.pres - x.tg), 0) / after.length;
    const pmax = Math.max(...after.map((x) => Math.abs(x.pres - x.tg)));
    assert(Math.abs(pm) < 0.01 && pmax < 1 / 60 + 0.01, `x${rate}: 見えるコマの平均 ${(pm * 1000).toFixed(1)} ms・最大 ${(pmax * 1000).toFixed(1)} ms`);
    assertEq(s.stats.seeks, 0);
  }
  s.dispose();
});

test('editvideo sync: a loop wrap (clock jumps back) seeks once and catches up; a target past the end is never played into (no play() on an ended video)', () => {
  VideoSync.leads = { start: NaN, seekStart: NaN };
  VideoSync.pics = new Map();
  const { v, s } = rig({ dur: 30 });
  const r = runPlay(v, s, { startS: 10, now0: 0, playMs: 5000, jumpAt: 2500, jumpBy: 2.4 });
  assertEq(s.stats.seeks, 1, '折り返しで 1 回 seek');
  const after = r.rows.filter((x) => x.t > 2500 + 1200);
  const maxCt = Math.max(...after.map((x) => Math.abs(x.ct - x.tg)));
  assert(maxCt < 0.02, `折り返しの後 ${(maxCt * 1000).toFixed(1)} ms`);
  // 終わりの近くから流す: 終わりの 2 コマは流さず、終わった動画に play を呼ばない
  const r2 = runPlay(v, s, { startS: 28.5, now0: r.now, playMs: 3000 });
  assertEq(v.playsWhileEnded, 0, '頭へ戻さない');
  const last = r2.rows[r2.rows.length - 1];
  assert(last.ct > 29.9 && s.out, '終わりで止まり、その先は動画の外: ' + last.ct);
  s.dispose();
});

test('editvideo sync: dispose removes listeners and the frame callback', () => {
  const { v, s } = rig();
  assert(Object.values(v._L).some((a) => a.length) && v._cbs.length === 1);
  s.dispose();
  assert(Object.values(v._L).every((a) => !a.length), 'リスナを外す');
  assertEq(v._cbs.length, 0, 'rVFC を外す');
});

// ---- 音で合わせる ----

test('editvideo align: FFT and the cross-correlation match the direct sums', () => {
  const n = 16;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + (i % 3));
  const im = new Float64Array(n);
  const r0 = re.slice();
  fft(re, im);
  // 直の DFT と比べる
  for (let k = 0; k < n; k++) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      a += r0[i] * Math.cos((-2 * Math.PI * k * i) / n);
      b += r0[i] * Math.sin((-2 * Math.PI * k * i) / n);
    }
    assertNear(re[k], a, 1e-9, 'DFT re ' + k);
    assertNear(im[k], b, 1e-9, 'DFT im ' + k);
  }
  fft(re, im, true);
  for (let i = 0; i < n; i++) assertNear(re[i], r0[i], 1e-9, '逆変換');
  const a = [1, 2, 3, 0, -1];
  const b = [0.5, -1, 2];
  const { c, lo } = crossCorrelate(a, b);
  assertEq(lo, -2);
  for (let k = lo; k < a.length; k++) {
    let sum = 0;
    for (let i = 0; i < b.length; i++) if (i + k >= 0 && i + k < a.length) sum += a[i + k] * b[i];
    assertNear(c[k - lo], sum, 1e-9, 'lag ' + k);
  }
  const pk = peakOf(Float64Array.from([0, 1, 0, 9, 0, 0, 3, 0]), 1);
  assertEq(pk.index, 3);
  assert(pk.ratio > 2);
});

/** 決まった乱数(試験を毎回同じにする)。 */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** 打楽器らしい音(ランダムな時刻の減衰する音)を sr で作る。 */
function clicks(seed, secs, sr, rate = 6) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(secs * sr));
  let t = 0.2;
  while (t < secs - 0.3) {
    const at = Math.round(t * sr);
    const amp = 0.3 + 0.7 * r();
    const f = 200 + 1500 * r();
    for (let i = 0; i < sr * 0.12 && at + i < out.length; i++) out[at + i] += amp * Math.exp(-i / (sr * 0.02)) * Math.sin((2 * Math.PI * f * i) / sr);
    t += (0.3 + r()) / rate * 4;
  }
  return out;
}

test('editvideo align: finds the offset of a song inside a longer recording (to the ms), and refuses an unrelated one', () => {
  const sr = ALIGN.sr;
  const song = clicks(7, 40, sr);
  // 録画: 3.2 秒の前置き(別の音)+ 曲(1234.5 ms だけ遅れて始まる)+ 雑音
  const lagMs = 1234.5;
  const rec = new Float32Array(Math.round(50 * sr));
  const pre = clicks(99, 3.2, sr);
  rec.set(pre.subarray(0, Math.min(pre.length, rec.length)));
  const off = Math.round((lagMs / 1000) * sr);
  for (let i = 0; i < song.length && i + off < rec.length; i++) rec[i + off] += song[i] * 0.8;
  const noise = rng(5);
  for (let i = 0; i < rec.length; i++) rec[i] += (noise() - 0.5) * 0.02;
  const res = findOffset(rec, [{ name: 'bgm', pcm: song }]);
  assert(res.ok, 'はっきりした峰: ' + JSON.stringify(res));
  assertNear(res.offsetMs, lagMs, 1.0, '1 ms の内');
  assertEq(res.ref, 'bgm');
  // 動画の頭だけ(曲の後ろは無い)でも、曲が録画より早く始まる(負のずれ)でも
  const head = rec.subarray(0, Math.round(15 * sr));
  assertNear(findOffset(head, [{ name: 'bgm', pcm: song }]).offsetMs, lagMs, 1.5, '頭だけ');
  const late = song.subarray(Math.round(5 * sr));
  const r2 = findOffset(late, [{ name: 'bgm', pcm: song }]);
  assert(r2.ok);
  assertNear(r2.offsetMs, -5000, 1.5, '負のずれ');
  // 別の曲は合わせない
  const other = clicks(1234, 40, sr);
  const r3 = findOffset(rec, [{ name: 'bgm', pcm: other }]);
  assert(!r3.ok && r3.ratio < ALIGN.ratioMin, '別の曲: ' + r3.ratio);
  // 候補のうち一番はっきりした物で決める
  const r4 = findOffset(rec, [{ name: 'other', pcm: other }, { name: 'bgm', pcm: song }]);
  assert(r4.ok && r4.ref === 'bgm' && r4.tried.length === 2, JSON.stringify(r4.tried));
  assertNear(refineLag(rec, song, 1235, sr), lagMs, 1.0, '細かい所');
  const env = onsetEnvelope(song);
  assertEq(env.length, Math.floor((song.length - ALIGN.win) / ALIGN.hop) + 1);
});

test('editvideo sync: playing from before the video starts it just before the target reaches 0 (not one start latency late)', () => {
  VideoSync.leads = { start: 0.045, seekStart: NaN };
  VideoSync.pics = new Map();
  const { v, s } = rig({ playLatMs: 45, decodeLagMs: 0 });
  let now = settle(v, s, 0, 0);
  const t0 = now;
  const rows = [];
  // 的は -0.6 秒から 1 倍で進む(動画の頭より前から流す)
  for (; now < t0 + 2500;) {
    now += 1000 / 120;
    const tg = -0.6 + (now - t0) / 1000;
    v.tick(now);
    s.sync(now, { playing: true, tg, hold: 0, rate: 1, fps: 60 });
    rows.push({ tg, ct: v.currentTime });
  }
  const near = rows.filter((r) => r.tg > 0.05 && r.tg < 0.35);
  const max = Math.max(...near.map((r) => Math.abs(r.ct - r.tg)));
  assert(max < 0.015, `頭に着いた直後のずれ ${(max * 1000).toFixed(1)} ms`);
  s.dispose();
});

test('editvideo sync: a big target jump while waiting after a seek re-seeks at once (not after the 1.5 s wait)', () => {
  VideoSync.leads = { start: NaN, seekStart: NaN };
  VideoSync.pics = new Map();
  const { v, s } = rig({ dur: 60 });
  let now = settle(v, s, 10, 0);
  const t0 = now;
  let base = 10;
  let at = t0;
  let jumped = 0;
  let back = NaN;
  for (; now < t0 + 3000;) {
    now += 1000 / 120;
    const el = now - t0;
    if (!jumped && el > 1500) { base = 10 + (now - at) / 1000 + 3; at = now; jumped = 1; } // 先へ 3 秒(seek して待つ)
    else if (jumped === 1 && el > 1560) { base = 4; at = now; jumped = 2; back = now; } // 待っている間に 9 秒ほど戻る
    const tg = base + (now - at) / 1000;
    v.tick(now);
    s.sync(now, { playing: true, tg, hold: 0, rate: 1, fps: 60 });
    if (jumped === 2 && now - back > 400 && now - back < 450) assert(Math.abs(v.currentTime - tg) < 0.3, `戻った的へ seek し直す ${v.currentTime} vs ${tg}`);
  }
  s.dispose();
});

test('editvideo sync: seeks that land late (slow decoder) still settle by playing and catching up, not by seeking again and again', () => {
  VideoSync.leads = { start: NaN, seekStart: NaN };
  VideoSync.pics = new Map();
  const { v, s } = rig({ dur: 60, seekMs: 700 });
  let now = settle(v, s, 10, 0);
  const t0 = now;
  let base = 10;
  let at = t0;
  let jumped = false;
  let seeks0 = 0;
  const late = [];
  for (; now < t0 + 9000;) {
    now += 1000 / 120;
    if (!jumped && now - t0 > 1500) { base = 10 + (now - at) / 1000 + 3; at = now; jumped = true; seeks0 = s.stats.seeks; }
    const tg = base + (now - at) / 1000;
    v.tick(now);
    s.sync(now, { playing: true, tg, hold: 0, rate: 1, fps: 60 });
    if (jumped && now - at > 5000) late.push(Math.abs(v.currentTime - tg));
  }
  assert(s.stats.seeks - seeks0 <= 3, 'seek の数 ' + (s.stats.seeks - seeks0));
  assert(!v.paused && Math.max(...late) < 0.02, `流れて追い付く: ${(Math.max(...late) * 1000).toFixed(1)} ms paused=${v.paused}`);
  s.dispose();
});

test('editvideo sync: the frame rate is only learned from frames the video (not the display) spaced out', () => {
  for (const [hz, want] of [[120, 60], [60, NaN]]) {
    VideoSync.leads = { start: NaN, seekStart: NaN };
    VideoSync.pics = new Map();
    const { v, s } = rig({ dur: 60 });
    let now = settle(v, s, 5, 0);
    const t0 = now;
    for (; now < t0 + 3000;) {
      now += 1000 / hz;
      v.tick(now);
      s.sync(now, { playing: true, tg: 5 + (now - t0) / 1000, hold: 0, rate: 1, fps: 60 });
    }
    if (Number.isNaN(want)) assert(Number.isNaN(s.fpsSeen), `${hz} Hz の画面の 60 fps は測らない: ${s.fpsSeen}`);
    else assertEq(s.fpsSeen, want, `${hz} Hz`);
    s.dispose();
  }
});
