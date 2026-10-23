// 譜面の編集画面の「動画」(本アプリの追加。DTXCreator・vid2dtx に無い)。DTXMania などのプレー動画を演奏画面のプレビューの右に並べ、
// 止まっていれば再生位置、再生中は鳴っている所に合わせて流す。SoundVoltexAnalyze の譜面の編集の動画(tool/sim/js/voxeditvideo.js。
// 同 docs/譜面シミュレータ.md §17.7.2)を移したもの。合わせ方は js/edit/videosync.js、音で合わせるのは js/edit/videoalign.js。
// - 動画の秒 = (譜面の時刻 + ずれ) / 1000。ずれは BGM の頭(最初の BGM チップ)を基準に覚える(BGM を動かす・頭の小節を足す・BPM を
//   変えても、動画は BGM の音と一緒に動く。プレー動画の音は BGM そのものなので)。BGM が無い譜面は譜面の時刻 0 が基準
// - 動画の元は手元のファイル(選ぶ・ドロップ)。ファイルはこのページに残し(開き直しても選び直さない)、Chromium で選んだ・ドロップした
//   ファイルはハンドルを IndexedDB に残して、ページを読み直しても「前の動画を開く」で開ける(読む許可はブラウザが聞く)
// - 初めて使う動画は、動画の音と譜面の BGM の重なりでずれを合わせる(♪ でいつでも)。◀ ▶ で 1 コマ(Shift で 10 コマ、Alt で 1 ms)
// - 横長の動画は ✂ でレーンの範囲を切り出せる(動画ごとに覚える)
// - 音は出さない(muted。鳴るのは編集画面の曲だけ)。上でのホイールは譜面を送る。判定・叩いて入力には何も流さない
// 譜面ごとの好み(localStorage の dojo.editVideo): charts[譜面] = {shown, cur(使っている動画), files[名前|大きさ] = {syncMs, crop, fps, vw, vh}}

import { t } from '../i18n.js';
import { loadJSON, saveJSON, idbGet, idbSet, idbDelete } from '../core/storage.js';
import { normKey } from '../core/song.js';
import { posToMs } from '../core/dtx.js';
import { AudioEngine } from '../core/audio.js';
import { packId } from './drafts.js';
import { numberDialog } from './dialogs.js';
import { previewWidth, PREVIEW_MIN_W } from './preview.js';
import { COMPACT_BELOW } from './view.js';
import { VideoSync, SYNC } from './videosync.js';
import { ALIGN, decodeFileAudio, renderChartAudio, findOffset } from './videoalign.js';

const $ = (id) => document.getElementById(id);

/** 動画の枠の幅の下限(CSS px。左の区切り線を含む)。 */
export const VIDEO_MIN_W = 240;
/** 編集画面の場所の幅に対する、動画の枠の幅の上限(横長の動画)。 */
export const VIDEO_MAX_SHARE = 0.45;
/** 狭い配置で動画を並べるとき、編集画面に残す幅(CSS px)。 */
export const VIDEO_CANVAS_MIN = 400;
/** 見出しの高さ(CSS px。css/app.css の #edit-video .vd-head と揃える)。 */
export const VIDEO_HEAD_H = 34;
/** 動画を選んでいない枠の幅(選ぶボタンと説明が収まる)。 */
const EMPTY_W = 320;
/** これより狭い枠では ♪ ✂ を出さない(元のメニューから使える)。 */
const NARROW_W = 300;
const PREFS_KEY = 'editVideo';
const MAX_CHARTS = 300;
const MAX_FILES = 8;
const HANDLE_PREFIX = 'videoHandle:';
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
/** 横長の動画を読んでから、切り出しの案内を見出しの下に出しておく時間(ms)。 */
const CROP_TIP_MS = 8000;
/** 切り出しの最小の大きさ(動画の幅・高さに対する割合)。 */
const CROP_MIN = 0.03;

/** 譜面の鍵 → {file, handle}(このページだけ。編集画面を開き直しても・テストプレイから戻っても選び直さない)。 */
const PAGE_FILES = new Map();
/** ひとりでに音で合わせた(試した)譜面と動画(`譜面の鍵|名前|大きさ`。このページで 1 回だけ。合わなかった動画で開くたびに試さない)。 */
const ALIGN_TRIED = new Set();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 譜面の鍵(曲パックと譜面のパス。下書きと同じ見分け)。 */
export function videoKey(pkg, path) {
  return `${packId(pkg)}:${normKey(path)}`;
}

/** 動画のファイルの鍵(名前と大きさ。ずれ・切り出しを覚える)。 */
export function fileKey(f) {
  return `${f.name}|${f.size}`;
}

/** 動画らしいファイルか(種類か拡張子)。 */
export function looksVideo(f) {
  return !!f && ((typeof f.type === 'string' && f.type.startsWith('video/')) || VIDEO_EXT.test(f.name || ''));
}

/** ずれの表示('+1563.3 ms')。 */
export function formatOffset(ms) {
  if (!Number.isFinite(ms)) return '—';
  const r = Math.round(ms * 10) / 10;
  return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)} ms`;
}

/** ◀ ▶ の 1 回のずれの変化(ms): 1 コマ、Shift で 10 コマ、Alt で 1 ms。0.001 ms に丸める。 */
export function offsetStep(cur, dir, mods = {}, fps = SYNC.fps) {
  const step = mods.altKey ? 1 : (1000 / (fps > 0 ? fps : SYNC.fps)) * (mods.shiftKey ? 10 : 1);
  return Math.round((cur + dir * step) * 1000) / 1000;
}

/** 譜面の BGM の頭(最初の BGM チップの譜面の時刻 ms。無ければ 0)。ずれの基準。 */
const anchorCache = new WeakMap();
export function bgmAnchorMs(chart) {
  if (!chart) return 0;
  if (anchorCache.has(chart)) return anchorCache.get(chart);
  const ev = chart.bgmEvents && chart.bgmEvents[0];
  const ms = ev ? (Number.isFinite(ev.pos) ? posToMs(chart, ev.pos) : ev.timeMs) : 0;
  anchorCache.set(chart, ms);
  return ms;
}

/** 切り出し(動画の幅・高さに対する割合 {x, y, w, h}。null = 全体)を正しい形にする。 */
export function normCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const x = clamp(Number(c.x) || 0, 0, 1);
  const y = clamp(Number(c.y) || 0, 0, 1);
  const w = clamp(Number(c.w) || 0, 0, 1 - x);
  const h = clamp(Number(c.h) || 0, 0, 1 - y);
  if (w < CROP_MIN || h < CROP_MIN) return null;
  if (w > 0.999 && h > 0.999) return null;
  return { x, y, w, h };
}

/** 見える縦横比(幅 / 高さ。切り出しがあればその範囲)。大きさが分からなければ null。 */
export function shownAspect(vw, vh, crop) {
  if (!(vw > 0 && vh > 0)) return null;
  const c = normCrop(crop);
  return c ? (vw * c.w) / (vh * c.h) : vw / vh;
}

/**
 * 動画の要素を置く箱(枠の中の CSS px)。切り出した範囲が枠に収まる一番大きい大きさにして真ん中に置く(はみ出した所は枠が隠す)。
 * @returns {{left: number, top: number, width: number, height: number, cx: number, cy: number, cw: number, ch: number}}
 *   cx 〜: 切り出した範囲が見える所
 */
export function fitCrop(bw, bh, vw, vh, crop) {
  const c = normCrop(crop) || { x: 0, y: 0, w: 1, h: 1 };
  const cwPx = vw * c.w;
  const chPx = vh * c.h;
  const s = Math.min(bw / cwPx, bh / chPx);
  const cw = cwPx * s;
  const ch = chPx * s;
  const cx = (bw - cw) / 2;
  const cy = (bh - ch) / 2;
  return { left: cx - c.x * vw * s, top: cy - c.y * vh * s, width: vw * s, height: vh * s, cx, cy, cw, ch };
}

/**
 * 演奏画面のプレビューと動画の枠を同じ場所に収める: 合わせて room に入れば元の幅、入らなければ広い方から縮め(同じ幅なら同じだけ)、
 * 下限(ma・mb)は割らない(呼ぶ側が room ≥ ma + mb を確かめる)。
 */
export function sharePanes(a, b, room, ma, mb) {
  if (a + b <= room) return [a, b];
  let x;
  let y;
  if (2 * Math.min(a, b) >= room) {
    x = Math.floor(room / 2);
    y = room - x;
  } else if (a <= b) {
    x = a;
    y = room - a;
  } else {
    y = b;
    x = room - b;
  }
  if (x < ma) {
    x = ma;
    y = room - ma;
  }
  if (y < mb) {
    y = mb;
    x = room - mb;
  }
  return [x, y];
}

/**
 * 編集画面の場所の割り振り(右のバーの右に、演奏画面のプレビュー・動画の順)。配置(広い / 狭い)と出すかどうかは幅だけで決め、
 * 高さは幅を詰めるだけ(高さで決めると、ツールバーの段・パネルの寄せ方で場所の大きさが変わって毎フレーム入れ替わる。preview.js)。
 * - 広い配置では編集画面に COMPACT_BELOW を残す。横のパネルを寄せない窓で、広い配置のままでは並べられない幅
 *   (COMPACT_BELOW + 並べる物の最小の幅の和 未満)なら狭い配置にして並べる(それより狭い窓では出るのに、広げると消えないように)
 * - 動画を並べる狭い配置では編集画面に VIDEO_CANVAS_MIN を残す。プレビューと両方は入らなければ動画を出さない(プレビューが先)
 * - 広い配置で横のパネルを右から重ねているときは、どちらもその下に隠れるので出さない
 * @param {{avail: number, h: number, canDock: boolean, panelOpen: boolean, dockW: number, preview: boolean, video: boolean, videoNatural: number}} o
 *   avail: 右のバーを除いた幅(寄せたパネルの分は引いた後)。videoNatural: 動画の枠の元の幅(EditVideo.naturalWidth)
 * @returns {{compact: boolean, pw: number, vw: number, previewBlock: string|null, videoBlock: string|null}}
 *   compact: 狭い配置にする。block: 出したいのに出せないわけ('panel' / 'preview' / 'size')
 */
export function stageLayout(o) {
  const { avail, h, canDock, panelOpen, dockW = 0, preview, video } = o;
  const minPanes = (preview ? PREVIEW_MIN_W : 0) + (video ? VIDEO_MIN_W : 0);
  const compact = (preview || video) && !canDock && avail >= COMPACT_BELOW && avail < COMPACT_BELOW + minPanes;
  const covered = panelOpen && !canDock && !compact && avail >= COMPACT_BELOW;
  let pw = 0;
  if (compact) pw = preview ? previewWidth(avail, h) : 0;
  else if (preview && !covered) pw = previewWidth(avail, h, COMPACT_BELOW);
  const previewBlock = !preview || pw ? null : covered || (canDock && previewWidth(avail + dockW, h, COMPACT_BELOW)) ? 'panel' : 'size';
  let vw = 0;
  let videoBlock = null;
  if (video) {
    const keep = compact || avail < COMPACT_BELOW ? VIDEO_CANVAS_MIN : COMPACT_BELOW;
    const room = avail - keep;
    const nat = Math.max(VIDEO_MIN_W, o.videoNatural || VIDEO_MIN_W);
    if (covered) videoBlock = 'panel';
    else if (pw && room >= PREVIEW_MIN_W + VIDEO_MIN_W) [pw, vw] = sharePanes(pw, nat, room, PREVIEW_MIN_W, VIDEO_MIN_W);
    else if (!pw && room >= VIDEO_MIN_W) vw = Math.min(nat, room);
    else if (canDock && avail + dockW - COMPACT_BELOW >= (pw ? PREVIEW_MIN_W : 0) + VIDEO_MIN_W) videoBlock = 'panel';
    else if (pw && room >= VIDEO_MIN_W) videoBlock = 'preview';
    else videoBlock = 'size';
  }
  return { compact, pw, vw, previewBlock, videoBlock };
}

function loadPrefs() {
  const p = loadJSON(PREFS_KEY, null);
  return p && typeof p === 'object' && p.charts && typeof p.charts === 'object' ? p : { v: 1, charts: {} };
}

/** 古いものから捨てる(t の小さい順)。捨てた鍵を返す。 */
function prune(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return [];
  keys.sort((a, b) => (obj[a].t || 0) - (obj[b].t || 0));
  const out = keys.slice(0, keys.length - max);
  for (const k of out) delete obj[k];
  return out;
}

/** 音で合わせている知らせがまだ出ていれば消す(合わせるのをやめたとき)。 */
function hideAligningToast() {
  const el = $('edit-toast');
  if (el && !el.hidden && el.textContent === t('edit.videoAligning')) el.hidden = true;
}

export class EditVideo {
  /** @param {import('./editor.js').EditorScreen} ed */
  constructor(ed) {
    this.ed = ed;
    this.root = $('edit-video');
    this.body = $('edit-video-body');
    this.v = $('edit-video-el');
    this.msgEl = $('edit-video-msg');
    this.cropper = $('edit-video-cropper');
    this.fileInput = $('edit-video-file');
    this.sync = null;
    this.key = '';
    this.file = null; // 使っている動画(File)
    this.handle = null; // そのファイルのハンドル(Chromium。ページを読み直しても開けるように覚える)
    this.fkey = '';
    this.url = null; // object URL(この枠が作った物。替える・閉じるときに捨てる)
    this.want = false; // 出したい(譜面ごとに覚える)
    this.w = 0; // 置いた幅(CSS px。0 = 出していない)
    this.h = 0;
    this.fps = SYNC.fps;
    this.err = null;
    this._prefs = null;
    this._needPerm = null; // {handle, name}: 前の動画を開くには押してもらう(読む許可)
    this._alignFile = null; // 音で合わせている動画(File。別の動画に替えたら、その動画は別に合わせる)
    this._autoAlign = false;
    this._crop = null; // 切り出しの最中 {draft, drag}
    this._box = null; // 動画の要素の箱(fitCrop)
    this._headSig = '';
    this._tipUntil = 0;
    this._tipTimer = 0;
    this.lastAlign = null;
    this._closed = true;
  }

  // ---- 開く・閉じる ----

  /** 編集画面を開いたとき(_bindDom の後。DOM の出来事は編集画面の _on で付けるので、閉じると外れる)。 */
  open() {
    const ed = this.ed;
    this._closed = false;
    this._prefs = loadPrefs();
    this._setOut(false); // 前の編集画面の印を持ち越さない(枠の DOM は同じ)
    this.key = videoKey(ed.session.pkg, ed.session.path);
    const pc = this._chartPrefs(false);
    this.want = !!(pc && pc.shown);
    const v = this.v;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.controls = false;
    this.sync = new VideoSync(v, { wake: () => ed._wake(), presented: () => this._syncHead() });
    this.sync.start();
    // 押したらキーが譜面に届くようにする(メニュー・ダイアログを開くボタンはそちらに任せる)
    const btn = (id, fn, refocus = true) => {
      const b = $(id);
      ed._on(b, 'click', (e) => {
        b.blur();
        fn(e);
        if (refocus) ed.canvas.focus({ preventScroll: true });
      });
    };
    btn('edit-video-src', () => this.menu(), false);
    btn('edit-video-back', (e) => this.nudge(-1, e));
    btn('edit-video-fwd', (e) => this.nudge(1, e));
    btn('edit-video-off', () => this.askOffset(), false);
    btn('edit-video-align', () => this.alignByAudio());
    btn('edit-video-crop', () => (this._crop ? this._endCrop(true) : this.startCrop()));
    btn('edit-video-close', () => this.toggle(false));
    ed._on(v, 'loadedmetadata', () => this._onMeta());
    ed._on(v, 'error', () => this._onError());
    // 上でのホイールは譜面を送る(動画は押しても何もしない。切り出しの間は何もしない)
    ed._on(this.root, 'wheel', (e) => { if (this._crop) e.preventDefault(); else ed._wheel(e); }, { passive: false });
    ed._on(this.root, 'contextmenu', (e) => e.preventDefault());
    ed._on(this.fileInput, 'change', () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = '';
      if (f) this.useFile(f, null);
    });
    // 動画のファイルを編集画面に落としたら使う
    ed._on(ed.root, 'dragover', (e) => this._dragOver(e));
    ed._on(ed.root, 'dragleave', () => this.root.classList.remove('drag'));
    ed._on(ed.root, 'drop', (e) => this._drop(e));
    ed._on(document, 'visibilitychange', () => { if (document.hidden && this.sync) this.sync.pause(); });
    // 切り出し
    ed._on(this.cropper, 'pointerdown', (e) => this._cropDown(e));
    ed._on(this.cropper, 'pointermove', (e) => this._cropMove(e));
    ed._on(this.cropper, 'pointerup', (e) => this._cropUp(e));
    ed._on(this.cropper, 'pointercancel', (e) => this._cropUp(e));
    for (const b of this.cropper.querySelectorAll('button[data-act]')) {
      ed._on(b, 'click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'full') this._crop.draft = null;
        if (act === 'full' || act === 'ok') this._endCrop(true);
        else this._endCrop(false);
      });
    }
    const page = PAGE_FILES.get(this.key);
    if (page && page.handle && typeof page.handle.getFile === 'function') this._reloadPage(page);
    else if (page) this._use(page.file, page.handle, { restore: true });
    else {
      this._showEmpty();
      if (pc && pc.cur) this._restoreHandle();
    }
    this._syncHead();
  }

  /** 編集画面を閉じるとき(ファイルはこのページに残す)。 */
  close() {
    if (this._closed) return;
    if (this._crop) this._endCrop(false);
    this._closed = true;
    if (this.sync) this.sync.dispose();
    this.sync = null;
    const v = this.v;
    try { v.pause(); } catch (e) { /* 止まっている */ }
    if (v.hasAttribute('src')) {
      v.removeAttribute('src');
      try { v.load(); } catch (e) { /* 無くてよい */ }
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.file = null;
    this.handle = null;
    clearTimeout(this._tipTimer);
    this._tipTimer = 0;
    this._setOut(false);
    this.root.hidden = true;
    this.root.classList.remove('drag');
    this.w = 0;
  }

  // ---- 好み ----

  _chartPrefs(create) {
    const p = this._prefs || (this._prefs = loadPrefs());
    let pc = p.charts[this.key];
    if (!pc && create) pc = p.charts[this.key] = { files: {} };
    if (pc && (!pc.files || typeof pc.files !== 'object')) pc.files = {};
    return pc || null;
  }

  _filePrefs(create) {
    if (!this.fkey) return null;
    const pc = this._chartPrefs(create);
    if (!pc) return null;
    let fp = pc.files[this.fkey];
    if (!fp && create) fp = pc.files[this.fkey] = {};
    return fp || null;
  }

  _save() {
    const p = this._prefs;
    if (!p) return;
    const pc = p.charts[this.key];
    const now = Date.now();
    if (pc) {
      pc.t = now;
      const fp = pc.files && pc.files[this.fkey];
      if (fp) fp.t = now;
      if (pc.files) prune(pc.files, MAX_FILES);
    }
    // 捨てた譜面のハンドルも消す(IndexedDB に残り続けないように)
    for (const k of prune(p.charts, MAX_CHARTS)) idbDelete(HANDLE_PREFIX + k);
    saveJSON(PREFS_KEY, p);
  }

  // ---- 動画の元 ----

  /** ファイルを使う(選んだ・ドロップした)。初めて使う動画は音で合わせる。 */
  useFile(file, handle = null) {
    if (!file || this._closed) return;
    if (!looksVideo(file)) this.ed._toast(t('edit.videoNotVideo', { name: file.name }));
    this._use(file, handle);
    if (!this.want) this.toggle(true);
    else {
      this.ed.onResize();
      if (!this.w) this._toastBlock();
    }
  }

  /**
   * このページで前に使ったファイルをもう一度使う。ハンドルがあれば読み直す(テストプレイの間にファイルを書き替えていても読めるように。
   * File は選んだときの写しなので、書き替えた後は読めない)。
   */
  async _reloadPage(page) {
    this._msg(t('edit.videoLoading'));
    let f = page.file;
    try {
      f = await page.handle.getFile();
    } catch (e) { /* 読めなければ前の File */ }
    if (this._closed || this.file) return;
    this._use(f, page.handle, { restore: true });
    this.ed.onResize();
  }

  _use(file, handle, o = {}) {
    if (this._crop) this._endCrop(false);
    this.sync.reset();
    clearTimeout(this._tipTimer);
    this._tipTimer = 0;
    this._tipUntil = 0;
    const old = this.url;
    this.file = file;
    if (!this.aligning) hideAligningToast(); // 前の動画を合わせている知らせを残さない
    this.handle = handle || null;
    this._needPerm = null;
    this.fkey = fileKey(file);
    this.err = null;
    PAGE_FILES.set(this.key, { file, handle: this.handle });
    const fp = this._filePrefs(true);
    this.fps = fp.fps > 0 ? fp.fps : SYNC.fps;
    // 初めて使う動画(ずれを覚えていない)はひとりでに音で合わせる(このページで 1 回。合わせ終わる前に閉じたら、開き直したときに)
    this._autoAlign = !Number.isFinite(fp.syncMs) && file.size <= ALIGN.autoMaxBytes && !ALIGN_TRIED.has(this.key + '|' + this.fkey);
    this._chartPrefs(true).cur = this.fkey;
    this._save();
    this.url = URL.createObjectURL(file);
    this.v.src = this.url;
    if (old) URL.revokeObjectURL(old);
    this._msg(t('edit.videoLoading'));
    this._setOut(false);
    if (!o.restore) {
      // ハンドルがあれば覚える(ページを読み直しても開けるように)。無い(<input type=file>)なら前のハンドルは忘れる(別の動画を指す)
      if (this.handle) idbSet(HANDLE_PREFIX + this.key, { handle: this.handle, name: file.name, size: file.size });
      else idbDelete(HANDLE_PREFIX + this.key);
    }
    this._headSig = '';
    this._syncHead();
  }

  /** 前に使った動画のハンドルを開く(読む許可があればそのまま、無ければ「前の動画を開く」を出す)。 */
  async _restoreHandle() {
    const rec = await idbGet(HANDLE_PREFIX + this.key);
    if (this._closed || this.file || !rec || !rec.handle || typeof rec.handle.getFile !== 'function') return;
    let perm = 'prompt';
    try {
      if (typeof rec.handle.queryPermission === 'function') perm = await rec.handle.queryPermission({ mode: 'read' });
    } catch (e) { /* 聞けない */ }
    if (this._closed || this.file) return;
    if (perm === 'granted') {
      try {
        const f = await rec.handle.getFile();
        if (!this._closed && !this.file) {
          this._use(f, rec.handle, { restore: true });
          this.ed.onResize();
        }
        return;
      } catch (e) { /* 消えた・動いた: 押してもらう */ }
    }
    this._needPerm = { handle: rec.handle, name: rec.name || '' };
    this._showEmpty();
    this._syncHead();
  }

  /** 「前の動画を開く」(押したときだけ読む許可を聞ける)。 */
  async reopen() {
    const np = this._needPerm;
    if (!np) return;
    try {
      let perm = 'granted';
      if (typeof np.handle.requestPermission === 'function') perm = await np.handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return;
      const f = await np.handle.getFile();
      if (this._closed) return;
      this._use(f, np.handle, { restore: true });
      this.ed.onResize();
    } catch (e) {
      console.warn('前の動画を開けない:', e);
      this._needPerm = null;
      idbDelete(HANDLE_PREFIX + this.key);
      this._showEmpty();
      this.ed._toast(t('edit.videoReopenFail'));
    }
  }

  /** 動画のファイルを選ぶ(Chromium はハンドルも取って覚える)。 */
  async pickFile() {
    if (typeof window.showOpenFilePicker === 'function') {
      let hs = null;
      try {
        hs = await window.showOpenFilePicker({
          id: 'dtx-video',
          multiple: false,
          types: [{ description: t('edit.video'), accept: { 'video/*': ['.mp4', '.m4v', '.webm', '.mov', '.mkv'] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 選ぶのをやめた
        hs = null; // 使えない(枠の中のページなど): 下の <input> で
      }
      if (hs && hs[0]) {
        try {
          this.useFile(await hs[0].getFile(), hs[0]);
          return;
        } catch (e) { /* 下の <input> で */ }
      }
    }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  /** 動画を外す(この譜面では使わない。ずれ・切り出しは動画ごとに残す)。枠もしまう。 */
  detach() {
    PAGE_FILES.delete(this.key);
    idbDelete(HANDLE_PREFIX + this.key);
    const pc = this._chartPrefs(true);
    pc.cur = null;
    this._save();
    if (this._crop) this._endCrop(false);
    this.sync.reset();
    const v = this.v;
    if (v.hasAttribute('src')) {
      v.removeAttribute('src');
      try { v.load(); } catch (e) { /* 無くてよい */ }
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.file = null;
    this.handle = null;
    this.fkey = '';
    this._needPerm = null;
    this._setOut(false);
    this._showEmpty();
    this.toggle(false);
    this.ed._toast(t('edit.videoDetached'));
  }

  _dragOver(e) {
    const dt = e.dataTransfer;
    const items = dt && dt.items ? [...dt.items] : [];
    if (!items.some((it) => it.kind === 'file' && (!it.type || it.type.startsWith('video/')))) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
    this.root.classList.add('drag');
  }

  async _drop(e) {
    this.root.classList.remove('drag');
    const dt = e.dataTransfer;
    if (!dt) return;
    let f = null;
    let hp = null;
    // ハンドルはドロップの出来事の中で頼む(後では取れない)
    for (const it of dt.items ? [...dt.items] : []) {
      if (it.kind !== 'file') continue;
      const ff = it.getAsFile();
      if (ff && looksVideo(ff)) {
        f = ff;
        hp = typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle() : null;
        break;
      }
    }
    if (!f) f = [...(dt.files || [])].find(looksVideo) || null;
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    let handle = null;
    if (hp) {
      try {
        const h = await hp;
        if (h && h.kind === 'file') handle = h;
      } catch (err) { /* ハンドルは無くてよい */ }
    }
    this.useFile(f, handle);
  }

  // ---- 出来事 ----

  _onMeta() {
    if (this._closed) return;
    const v = this.v;
    const fp = this._filePrefs(true);
    if (fp && v.videoWidth > 0 && v.videoHeight > 0) {
      const changed = fp.vw !== v.videoWidth || fp.vh !== v.videoHeight;
      fp.vw = v.videoWidth;
      fp.vh = v.videoHeight;
      if (changed) this._save();
    }
    this.err = null;
    this._msg(null);
    if (v.videoWidth > v.videoHeight * 1.2 && !normCrop(fp && fp.crop)) {
      // 横長の動画には切り出しの案内を出し、決まった時間で消す(止まっている間は見出しを描き直さないので時計で)
      this._tipUntil = performance.now() + CROP_TIP_MS;
      clearTimeout(this._tipTimer);
      this._tipTimer = setTimeout(() => {
        this._tipTimer = 0;
        this._headSig = '';
        this._syncHead();
      }, CROP_TIP_MS + 50);
    }
    this.ed.onResize(); // 縦横比で枠の幅が決まる
    if (this._autoAlign) {
      this._autoAlign = false;
      this.alignByAudio({ auto: true });
    }
    this._headSig = '';
    this._syncHead();
  }

  _onError() {
    const v = this.v;
    if (this._closed || !this.file || !v.getAttribute('src')) return;
    const code = v.error ? v.error.code : 0;
    this.err = code || 'error';
    this._setOut(false);
    const why = t(code === 4 ? 'edit.videoErrFormat' : code === 3 ? 'edit.videoErrDecode' : code === 2 ? 'edit.videoErrNetwork' : code === 1 ? 'edit.videoErrAbort' : 'edit.videoErrOther');
    this._msg(t('edit.videoError', { why }), [[t('edit.videoChoose'), () => this.pickFile(), true]]);
    this._headSig = '';
    this._syncHead();
  }

  // ---- 置き方 ----

  /** 見える縦横比(動画が無ければ null)。読む前は覚えた大きさ、それも無ければ 16:9。 */
  _aspect() {
    if (!this.file) return null;
    const m = this.sync && this.sync.meta;
    const fp = this._filePrefs(false) || {};
    const vw = m && m.vw > 0 ? m.vw : fp.vw;
    const vh = m && m.vh > 0 ? m.vh : fp.vh;
    return shownAspect(vw, vh, this._crop ? null : fp.crop) || shownAspect(vw, vh, null) || 16 / 9;
  }

  /** 枠の元の幅(CSS px。高さいっぱいに見せる幅を、場所の幅の VIDEO_MAX_SHARE までに)。 */
  naturalWidth(avail, h) {
    const asp = this._aspect();
    let w = asp ? Math.round(Math.max(1, h - VIDEO_HEAD_H) * asp) + 1 : EMPTY_W;
    w = Math.min(w, Math.floor(avail * VIDEO_MAX_SHARE));
    return Math.max(VIDEO_MIN_W, w);
  }

  /** 枠を置く(編集画面の onResize から。w = 0 ならしまう)。 */
  place(w, h) {
    const was = this.w;
    this.w = w;
    this.h = h;
    this.root.hidden = !w;
    if (w) {
      this.root.style.width = w + 'px';
      this.root.style.height = h + 'px';
      this.root.classList.toggle('narrow', w < NARROW_W);
      this._fit();
    } else {
      if (this._crop) this._endCrop(false, false); // 隠れた枠の切り出しは続けない(Enter・Esc を取り続けないように)
      if (was && this.sync) this.sync.pause();
    }
    const b = $('edit-video-btn');
    if (b) {
      b.classList.toggle('on', this.want);
      b.setAttribute('aria-pressed', String(this.want));
    }
  }

  /** 動画の要素を枠に合わせる(切り出した範囲を枠いっぱいに。切り出しの最中は全体)。 */
  _fit() {
    const v = this.v;
    const m = this.sync && this.sync.meta;
    const bw = this.body.clientWidth;
    const bh = this.body.clientHeight;
    if (!m || !(m.vw > 0 && m.vh > 0) || !(bw > 0 && bh > 0)) {
      v.style.width = v.style.height = '0px';
      this._box = null;
      return;
    }
    const fp = this._filePrefs(false) || {};
    const box = fitCrop(bw, bh, m.vw, m.vh, this._crop ? null : fp.crop);
    v.style.left = box.left + 'px';
    v.style.top = box.top + 'px';
    v.style.width = box.width + 'px';
    v.style.height = box.height + 'px';
    this._box = box;
    if (this._crop) this._drawCrop();
  }

  /** 出す / しまう(B・ツールバーの「動画」・見出しの ×。譜面ごとに覚える)。 */
  toggle(on = !this.want) {
    const ed = this.ed;
    this.want = on;
    this._chartPrefs(true).shown = on;
    this._save();
    if (!on) {
      if (this._crop) this._endCrop(false);
      if (this.sync) this.sync.pause();
    }
    ed.onResize();
    if (on && !this.w) this._toastBlock();
    ed._render();
  }

  /** 出したいのに出せないわけを知らせる。 */
  _toastBlock() {
    const b = this.ed._videoBlock;
    this.ed._toast(t(b === 'panel' ? 'edit.videoPanel' : b === 'preview' ? 'edit.videoPreview' : 'edit.videoNarrow'));
  }

  // ---- 合わせる ----

  /** 今のずれ(動画の時刻 − 譜面の時刻 ms)。覚えているのは BGM の頭の動画の時刻(syncMs)なので、今の譜面の BGM の頭を引く。 */
  offsetMs(chart = this.ed.model.chart) {
    const fp = this._filePrefs(false);
    return fp && Number.isFinite(fp.syncMs) ? fp.syncMs - bgmAnchorMs(chart) : 0;
  }

  /** ずれを ms にする(chart: その譜面の BGM の頭を基準に。省けば今の譜面)。 */
  setOffset(ms, chart = this.ed.model.chart) {
    if (!this.file || !Number.isFinite(ms)) return;
    const fp = this._filePrefs(true);
    fp.syncMs = Math.round((ms + bgmAnchorMs(chart)) * 1000) / 1000;
    this._save();
    this._headSig = '';
    this._syncHead();
    this.ed._wake();
  }

  nudge(dir, e = {}) {
    if (!this.file) {
      this.ed._toast(t('edit.videoNone'));
      return;
    }
    this.setOffset(offsetStep(this.offsetMs(), dir, e, this.fps));
  }

  async askOffset() {
    if (!this.file) {
      this.ed._toast(t('edit.videoNone'));
      return;
    }
    const r = await numberDialog($('edit-dialog'), {
      title: t('edit.videoOffsetTitle'), prompt: t('edit.videoOffsetPrompt'),
      value: Math.round(this.offsetMs() * 10) / 10, min: -3600000, max: 3600000,
    });
    if (r.action === 'ok' && !this._closed) this.setOffset(r.value);
    this.ed.canvas.focus({ preventScroll: true });
  }

  /** 今の動画を音で合わせているか。 */
  get aligning() {
    return !!this.file && this._alignFile === this.file;
  }

  /**
   * 動画の音と譜面の音(読んである BGM・SE・チップの音)の重なりでずれを合わせる(js/edit/videoalign.js)。auto: 初めて使う動画で
   * ひとりでに(大きすぎる動画は黙ってやめる)。合わせたら、前のずれへ(初めてならずれを覚えていない形へ)戻すボタン付きで知らせる。
   * 測った譜面の BGM の頭で覚える(合わせている間に譜面を変えても、その分だけずれない)。途中で動画を替えたら、その結果は捨てる。
   */
  async alignByAudio({ auto = false } = {}) {
    const ed = this.ed;
    const file = this.file;
    if (!file) {
      ed._toast(t('edit.videoNone'));
      return;
    }
    if (this._alignFile === file) return;
    const tryKey = this.key + '|' + this.fkey;
    if (file.size > ALIGN.maxBytes) {
      if (auto) ALIGN_TRIED.add(tryKey);
      else ed._toast(t('edit.videoAlignBig'));
      return;
    }
    this._alignFile = file;
    this._headSig = '';
    this._syncHead();
    ed._toast(t('edit.videoAligning'), null, 60000);
    let res = null;
    let why = '';
    const stale = () => this._closed || this.file !== file;
    try {
      await ed._soundsReady();
      if (!stale()) {
        const chart = ed.model.chart;
        const refs = await renderChartAudio(chart, ed.app.audio.buffers, AudioEngine.gainPan);
        if (!refs.length) why = 'edit.videoAlignNoRef';
        else if (!stale()) {
          let pcm = null;
          try {
            pcm = await decodeFileAudio(file);
          } catch (e) {
            console.warn('動画の音を読めない:', e);
            why = 'edit.videoAlignDecode';
          }
          if (pcm && !stale()) {
            await new Promise((r) => setTimeout(r, 0)); // 知らせを描いてから重い計算
            res = findOffset(pcm, refs);
            if (!res.ok) why = 'edit.videoAlignWeak';
            res.chart = chart;
          }
        }
      }
    } catch (e) {
      console.warn('動画の音で合わせられない:', e);
      why = why || 'edit.videoAlignFail';
    } finally {
      if (this._alignFile === file) this._alignFile = null;
    }
    if (stale()) {
      if (!this._closed && !this.aligning) hideAligningToast();
      return;
    }
    // ひとりでに合わせたのは、終わり切ったときだけ覚える(途中で閉じたら、開き直したときにまた合わせる)
    if (auto) ALIGN_TRIED.add(tryKey);
    this.lastAlign = res ? { ok: res.ok, offsetMs: res.offsetMs, ratio: res.ratio, ref: res.ref, tried: res.tried } : null;
    if (res && res.ok) {
      const fp = this._filePrefs(true);
      const prev = fp.syncMs;
      this.setOffset(res.offsetMs, res.chart);
      const undo = {
        label: t('common.undo'),
        run: () => {
          const f = this._filePrefs(true);
          if (this.file !== file || !f) return;
          if (Number.isFinite(prev)) f.syncMs = prev;
          else delete f.syncMs;
          this._save();
          this._headSig = '';
          this._syncHead();
          ed._wake();
        },
      };
      ed._toast(t('edit.videoAligned', { off: formatOffset(this.offsetMs()) }), undo, 8000);
    } else ed._toast(t(why || 'edit.videoAlignWeak'), null, 8000);
    this._headSig = '';
    this._syncHead();
  }

  /**
   * 1 フレーム(編集画面の _frame から。描き直さないフレームでも呼ぶ)。再生中は鳴っている所、止まっていれば再生位置を的にする。
   */
  frame(now) {
    if (this._closed || !this.sync) return;
    if (this.w && this.file && !this._crop && !this.err) {
      const c = this.ed._videoClock();
      const tg = (c.ms + this.offsetMs(c.chart)) / 1000;
      this.sync.sync(now, { playing: c.playing, tg, hold: c.hold, rate: c.rate, fps: this.fps });
      // 流して測れたコマの速さを覚える(◀ ▶ の 1 コマ・止まっているときの半コマ)
      const f = this.sync.fpsSeen;
      if (f > 0 && f !== this.fps) {
        this.fps = f;
        const fp = this._filePrefs(true);
        fp.fps = f;
        this._save();
      }
      this._setOut(this.sync.out);
    }
    this._syncHead();
  }

  _setOut(out) {
    this.body.classList.toggle('out', !!out);
  }

  // ---- 見出し・知らせ ----

  _msg(text, buttons = []) {
    const el = this.msgEl;
    el.innerHTML = '';
    if (!text && !buttons.length) {
      el.hidden = true;
      return;
    }
    if (text) {
      const p = document.createElement('p');
      p.textContent = text;
      el.appendChild(p);
    }
    for (const [label, run, primary] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = primary ? 'btn small' : 'btn small secondary';
      b.textContent = label;
      b.onclick = () => {
        b.blur();
        run();
      };
      el.appendChild(b);
    }
    el.hidden = false;
  }

  _showEmpty() {
    if (this.file) return;
    const np = this._needPerm;
    if (np) this._msg(t('edit.videoNone'), [[t('edit.videoReopen', { name: np.name }), () => this.reopen(), true], [t('edit.videoChoose'), () => this.pickFile()]]);
    else this._msg(t('edit.videoEmpty'), [[t('edit.videoChoose'), () => this.pickFile(), true]]);
  }

  _syncHead() {
    if (this._closed) return;
    const has = !!this.file;
    const s = this.sync;
    const meta = s && s.meta;
    const pres = s && Number.isFinite(s.presented) ? s.presented : this.v.currentTime;
    const tip = has && meta && !this._crop && performance.now() < this._tipUntil;
    const warn = this.aligning ? t('edit.videoAligning') : this._crop ? '' : tip ? t('edit.videoCropTip') : '';
    const label = has ? this.file.name : this._needPerm ? this._needPerm.name : t('edit.videoPick');
    const off = has ? formatOffset(this.offsetMs()) : '—';
    const time = has && meta && !this.err ? t('edit.videoTime', { s: (Number(pres) || 0).toFixed(3) }) : '';
    const sig = [label, off, time, warn, has, !!meta, this.aligning, !!this._crop].join('|');
    if (sig === this._headSig) return;
    this._headSig = sig;
    const src = $('edit-video-src');
    if (src.textContent !== label) src.textContent = label;
    $('edit-video-off').textContent = off;
    $('edit-video-time').textContent = time;
    $('edit-video-warn').textContent = warn;
    for (const id of ['edit-video-back', 'edit-video-fwd', 'edit-video-off', 'edit-video-align']) $(id).disabled = !has;
    $('edit-video-align').disabled = !has || this.aligning;
    $('edit-video-crop').disabled = !has || !meta;
    $('edit-video-crop').classList.toggle('on', !!this._crop);
  }

  /** 見出しの元のボタンのメニュー。 */
  menu() {
    const ed = this.ed;
    const has = !!this.file;
    const fp = this._filePrefs(false);
    const items = [];
    if (has) items.push({ label: this.file.name, heading: true });
    items.push({ label: t('edit.videoChoose'), run: () => this.pickFile() });
    if (this._needPerm) items.push({ label: t('edit.videoReopen', { name: this._needPerm.name }), run: () => this.reopen() });
    items.push({ sep: true });
    items.push({ label: t('edit.videoAlign'), disabled: !has || this.aligning, run: () => this.alignByAudio() });
    items.push({ label: t('edit.videoOffsetItem'), disabled: !has, run: () => this.askOffset() });
    items.push({ label: t('edit.videoCrop'), disabled: !has || !(this.sync && this.sync.meta), run: () => this.startCrop() });
    if (fp && normCrop(fp.crop)) items.push({ label: t('edit.videoCropOff'), run: () => this._setCrop(null) });
    items.push({ sep: true });
    items.push({ label: t('edit.videoDetach'), danger: true, disabled: !has, run: () => this.detach() });
    const r = $('edit-video-src').getBoundingClientRect();
    ed._popover(items, r.left + r.width / 2, r.bottom);
  }

  // ---- 切り出し ----

  /** 切り出しを始める(動画の全体を見せ、ドラッグで囲む。Enter で決める・Esc でやめる)。 */
  startCrop() {
    if (!this.file || !(this.sync && this.sync.meta) || this._crop || !this.w) return;
    const fp = this._filePrefs(true);
    this._crop = { draft: normCrop(fp.crop), drag: null };
    this.sync.pause(); // 切り出しの間は合わせない(再生していても止めておく)
    this.cropper.hidden = false;
    this.body.classList.add('cropping');
    this.ed.onResize(); // 切り出しの間は動画の全体の縦横比で枠の幅を取る(囲みやすいように)
    this._headSig = '';
    this._syncHead();
  }

  _setCrop(c) {
    const fp = this._filePrefs(true);
    fp.crop = normCrop(c);
    if (!fp.crop) delete fp.crop;
    this._save();
    this._tipUntil = 0;
    clearTimeout(this._tipTimer);
    this._tipTimer = 0;
    this.ed.onResize();
    this._fit();
    this._headSig = '';
    this._syncHead();
  }

  /** 切り出しを終える(apply: 囲みを決める。relayout: 枠の幅を決め直す。onResize の中で終えるときは決め直さない)。 */
  _endCrop(apply, relayout = true) {
    const cr = this._crop;
    if (!cr) return;
    this._crop = null;
    this.cropper.hidden = true;
    this.body.classList.remove('cropping');
    if (cr.drag && cr.drag.id !== undefined) {
      try { this.cropper.releasePointerCapture(cr.drag.id); } catch (e) { /* 無くてよい */ }
    }
    if (apply) this._setCrop(cr.draft);
    else if (relayout && !this._closed) this.ed.onResize();
    else this._fit();
    this._headSig = '';
    this._syncHead();
    if (!this._closed) this.ed.canvas.focus({ preventScroll: true });
  }

  /** 切り出しの枠を描く(下書きが無ければ全体)。 */
  _drawCrop() {
    const box = this._box;
    const rect = this.cropper.querySelector('.vd-crop-rect');
    if (!box || !rect) return;
    const c = (this._crop && this._crop.draft) || { x: 0, y: 0, w: 1, h: 1 };
    rect.style.left = box.left + c.x * box.width + 'px';
    rect.style.top = box.top + c.y * box.height + 'px';
    rect.style.width = c.w * box.width + 'px';
    rect.style.height = c.h * box.height + 'px';
  }

  /** 枠の中の点 → 動画の割合(0〜1)。 */
  _cropPoint(e) {
    const r = this.body.getBoundingClientRect();
    const box = this._box;
    return {
      x: clamp((e.clientX - r.left - box.left) / box.width, 0, 1),
      y: clamp((e.clientY - r.top - box.top) / box.height, 0, 1),
    };
  }

  _cropDown(e) {
    if (!this._crop || !this._box || e.target.closest('button')) return;
    e.preventDefault();
    try { this.cropper.setPointerCapture(e.pointerId); } catch (err) { /* 無くてよい */ }
    this._crop.drag = { id: e.pointerId, p0: this._cropPoint(e), prev: this._crop.draft };
  }

  _cropMove(e) {
    const cr = this._crop;
    if (!cr || !cr.drag || cr.drag.id !== e.pointerId) return;
    const p = this._cropPoint(e);
    const a = cr.drag.p0;
    cr.draft = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
    this._drawCrop();
  }

  _cropUp(e) {
    const cr = this._crop;
    if (!cr || !cr.drag || cr.drag.id !== e.pointerId) return;
    // 小さすぎる(押しただけ)なら前の囲みのまま
    if (!normCrop(cr.draft) && cr.draft && (cr.draft.w < CROP_MIN || cr.draft.h < CROP_MIN)) cr.draft = cr.drag.prev;
    cr.drag = null;
    this._drawCrop();
  }

  /** 切り出しの最中のキー(Enter で決める・Esc でやめる)。使ったら true。 */
  onKey(e) {
    if (!this._crop || !this.w) return false;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      this._endCrop(true);
      return true;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      this._endCrop(false);
      return true;
    }
    return false;
  }

  /** 確かめ用。 */
  debug() {
    return {
      want: this.want, w: this.w, file: this.file ? this.fkey : null, offsetMs: this.offsetMs(), fps: this.fps, err: this.err,
      crop: (this._filePrefs(false) || {}).crop || null, needPerm: !!this._needPerm, aligning: this.aligning, lastAlign: this.lastAlign,
      sync: this.sync ? this.sync.debug() : null,
    };
  }
}
