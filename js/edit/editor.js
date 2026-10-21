// 譜面の編集画面(#screen-edit)。描画は js/edit/view.js、編集の操作は js/edit/ops.js、履歴は js/edit/session.js。
//
// 操作は DTXCreator の編集モード(docs/spec/dtxcreator-edit.md §4)と vid2dtx のプレビュー(docs/spec/vid2dtx-edit.md §4)を
// 合わせたもの。違うところは docs/spec/chart-editor.md の一覧。ここでは:
// - マウス / ペン: 空いたところを押すと置く(そのままドラッグで同じ列に塗る)。チップを押して離すと消す、ドラッグで動かす。
//   Alt+クリックで列のもう一方の種類、Shift+クリックで LP / CY の列に相方を並べる。右クリック / 右ドラッグで消す
// - タッチ: タップで置く / 消す、1 本指のドラッグはスクロール、長押しで持ち上げて動かす(動かさずに離すとメニュー)、2 本指で拡大縮小
// - 選択モード(DTXCreator の選択モード §5): クリック / 範囲で選び、ドラッグで動かす。右クリック / 長押しでメニュー
//   (切り取り・コピー・貼り付け・削除・すべて選択・レーン / 小節の中を選択・小節長・小節の挿入 / 削除)
// - BPM レーン(広い配置)を押すと BPM、小節番号の欄を右クリック / 長押しすると小節のメニュー
// - キー: Ctrl+Z / Ctrl+Y・Ctrl+S・Ctrl+X / C / V / D / A・Delete・[ ]・- +・PageUp / PageDown・Home / End・↑↓←→・
//   E / S・R・P・T・M・N・?・Esc(画面からは出ない)
// Space は BD の既定のキーなので何もしない(CLAUDE.md)。

import { posToMs, msToPos, requiredWavIds, TICKS_PER_MEASURE } from '../core/dtx.js';
import { AudioEngine } from '../core/audio.js';
import { HitRanges } from '../game/hitranges.js';
import { PLAYER_STATE } from '../game/player.js';
import { t } from '../i18n.js';
import { MAX_MEASURE } from './dtxdoc.js';
import { GUIDES, ZOOMS, nearestZoom, posOf } from './geometry.js';
import { COLUMN_TYPES, TYPE_OF, channelsConflict, otherType, channelName, laneOfChannel, padChannel } from './lanes.js';
import {
  EditError, opPlace, opPaint, opDelete, opErase, opMove, opSetType, opSetValue, opAddPartner, moveTargets, moveBpmTargets,
  clampMove, opNudge, copyClip, opPaste, opDuplicate, opSetBpm, opBarLength, barOverflow, opInsertMeasure, opDeleteMeasure,
  measureDeleteSummary, formatBpm, opSetWav, freeWavNumber,
} from './ops.js';
import { EditPanel, PANEL_DOCK_MIN, PANEL_DOCK_W } from './panel.js';
import { PreviewRenderer, previewWidth, PREVIEW_MIN_W } from './preview.js';
import { EditView, HEADER_CSS, COMPACT_BELOW } from './view.js';
import { TouchGestures, G } from './gestures.js';
import { EditorPlayer } from './editplayer.js';
import { saveDraft, deleteDraft } from './drafts.js';
import { downloadBytes, canShareFile, shareFile, baseName, canSaveAs, saveAsFile, writeHandle } from './save.js';
import { confirmDialog, bpmDialog, barDialog } from './dialogs.js';
import { loadSidecar, suspectsOf, suspectOrder } from './sidecar.js';

const $ = (id) => document.getElementById(id);

/** EditError の code → 文言のキー(i18n のテストが文言を見つけられるよう、キーはそのまま書く)。 */
const ERR = {
  measureLimit: 'edit.measureLimit',
  locked: 'edit.lockedCell',
  leadIn: 'edit.measureLimit',
  bpmRange: 'edit.bpmRange',
  bpmBase: 'edit.errBpmBase',
  bpmKeys: 'edit.errBpmKeys',
  barLocked: 'edit.errBarLocked',
  barRange: 'edit.barRange',
  measureLocked: 'edit.errMeasureLocked',
  levelRange: 'edit.errLevelRange',
  wavRedefined: 'edit.wavRedefined',
  wavVolumeRange: 'edit.wavNumberRange',
  wavPanRange: 'edit.wavNumberRange',
  bgmShiftRange: 'edit.errBgmShift',
};

/** 操作の名前(元に戻す・やり直すのお知らせ)。 */
const OP = {
  place: 'edit.opPlace',
  delete: 'edit.opDelete',
  move: 'edit.opMove',
  type: 'edit.opType',
  sound: 'edit.opSound',
  cut: 'edit.cut',
  paste: 'edit.paste',
  duplicate: 'edit.duplicate',
  nudge: 'edit.opNudge',
  bpm: 'edit.bpmTitle',
  bar: 'edit.barTitle',
  insertMeasure: 'edit.insertMeasure',
  deleteMeasure: 'edit.deleteMeasure',
};

const PREVIEW_VOLUME = 0.9;
const STEP_CHORD_MS = 60; // 叩いて入力: この間に叩いたものは同じセルに置く(和音)
const DRAFT_DEBOUNCE_MS = 1500;
const SPEEDS = [10, 15, 20, 25, 30]; // 再生速度(playSpeed。20 = x1.0。DTXCreator の x0.5〜x1.5)

/** 文字のショートカット(e.code で見る。キーボードの配列・IME に左右されない)。 */
const LETTER_OF_CODE = { KeyE: 'e', KeyS: 's', KeyP: 'p', KeyT: 't', KeyM: 'm', KeyR: 'r', KeyN: 'n', KeyV: 'v' };
/** 記号のショートカットの e.code(IME が入力中で e.key が 'Process' のときだけ使う。JIS 配列では [ ] の位置が違うので、ふだんは e.key)。 */
const SYMBOL_OF_CODE = { BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '+', NumpadSubtract: '-', NumpadAdd: '+' };

/** キーのショートカットの文字('e' / '[' / '?' など。無ければ null)。 */
function shortcutKey(e) {
  if (LETTER_OF_CODE[e.code]) return LETTER_OF_CODE[e.code];
  if (e.key === 'Process' || e.keyCode === 229) return e.code === 'Slash' && e.shiftKey ? '?' : SYMBOL_OF_CODE[e.code] || null;
  if (e.key === '=') return '+';
  return e.key && e.key.length === 1 && '[]-+?'.includes(e.key) ? e.key : null;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function msClock(ms) {
  const v = Math.max(0, ms) / 1000;
  const m = Math.floor(v / 60);
  return `${m}:${(v - m * 60).toFixed(3).padStart(6, '0')}`;
}

export class EditorScreen {
  /**
   * @param {any} app App(js/main.js)
   * @param {import('./session.js').EditSession} session
   * @param {import('../ui/skin.js').Skin} skin
   * @param {{atMs?: number}} [opts]
   */
  constructor(app, session, skin, opts = {}) {
    this.app = app;
    this.session = session;
    this.skin = skin;
    this.opts = opts;
    this.root = $('screen-edit');
    this.canvas = $('edit-canvas');
    this.view = new EditView(this.canvas, skin);
    this.mode = 'pen';
    this.follow = true;
    this._listeners = [];
    this._raf = 0;
    this._dirty = true;
    this._drag = null; // マウス / ペンの身振り
    this._hover = null; // 最後に指していたところ {clientX, clientY, pointerType, alt}
    this._fling = null; // {v(u/ms), last}
    this._autoScroll = null;
    this._toastTimer = 0;
    this._draftTimer = 0;
    this._soundTimer = 0;
    this._loadedFor = null;
    this.player = null;
    this._playerDoc = null;
    this._loopRange = null; // 小節を繰り返し再生している範囲 {m0, m1, beginMs, endMs}
    this.sidecar = null; // vid2dtx の確信度(js/edit/sidecar.js)
    this._suspectCache = null; // {doc, map}
    this._lastSuspect = null; // 最後に回った要確認 {conf, u}
    this.touch = new TouchGestures(this._touchHandlers());
    this.panel = new EditPanel(this);
    this.previewRenderer = null; // 演奏画面のプレビュー(js/edit/preview.js)
    this._previewSize = null; // {w, h}(CSS px)。出していなければ null
    this._previewUntil = 0; // 止めたあと、プレビューの演出(ファイア・判定の文字)が消えるまで描く
    this._previewBlock = null; // 出すはずのプレビューを出せないわけ('panel' / 'size')。お知らせの文言
    this.stepArmed = false; // 叩いて入力
    this._chord = null; // 叩いて入力の和音 {cell, cells, timer}
    this._recorded = []; // 再生中に録音したチップ(止めたときに 1 手)
    this._wavVoice = null; // 音源のタブで試聴している音
    this._closed = false;
  }

  get model() {
    return this.session.model;
  }

  get config() {
    return this.app.config;
  }

  get guide() {
    return this.view.guide;
  }

  // ---- 開く・閉じる ----

  async open() {
    const s = this.session;
    const c = this.config;
    $('edit-title').textContent = (s.song ? s.song.title : '') + (s.chartRef.label ? '  [' + s.chartRef.label + ']' : '');
    this.root.hidden = false;
    this._buildGuideSelect();
    this._bindDom();
    $('edit-side').hidden = !c.editPanelOpen;
    $('edit-panel').classList.toggle('on', !!c.editPanelOpen);
    this.panel.layout();
    this.onResize();
    const v = s.view;
    const g = GUIDES.includes(c.editGuide) ? c.editGuide : 16;
    this.view.guide = v && GUIDES.includes(v.guide) ? v.guide : g;
    $('edit-guide').value = String(this.view.guide);
    // 拡大率は配置(広い / 狭い)ごと。前に開いたときと配置が同じならそのときの拡大率、違えば配置ごとに覚えた値、
    // それも無ければタッチは 1/16 のセルが指で押せる大きさ(約 24 CSS px)
    const z = c.editZoom && c.editZoom[this.view.layout];
    const touchZoom = nearestZoom(document.body.classList.contains('touch') ? 0.96 / this.view.s : 1);
    this.view.zoom = v && v.layout === this.view.layout && ZOOMS.includes(v.zoom) ? v.zoom : ZOOMS.includes(z) ? z : touchZoom;
    if (Number.isFinite(this.opts.atMs)) this.view.uHead = this._uOfMs(this.opts.atMs);
    else if (v && Number.isFinite(v.uHead)) this.view.uHead = v.uHead;
    else this.view.uHead = 0;
    this._clampHead();
    this._syncTypes();
    this._setMode(v && v.mode === 'select' ? 'select' : 'pen');
    this._syncButtons();
    this._showBanners();
    $('edit-suspect').hidden = true;
    loadSidecar(s.pkg, s.path).then((sc) => {
      if (this._closed) return;
      this.sidecar = sc;
      $('edit-suspect').hidden = !sc;
      this._render();
    });
    if (!this.app._editHintShown) {
      this.app._editHintShown = true;
      this._toast(t(document.body.classList.contains('touch') ? 'edit.hintTouch' : 'edit.hintMouse'), null, 6000);
    }
    this.player = new EditorPlayer({ audio: this.app.audio, config: this._playerConfig() });
    this._applyPlayOptions();
    this._render();
    this.canvas.focus({ preventScroll: true });
    this._loadSounds(false);
  }

  /**
   * 閉じる(曲の一覧かテストプレイへ)。下書きを書き、曲パックに重ねる。確かめずに閉じる(変更は重ねたものと下書きに残る)。
   * @param {{toTest?: boolean}} [opts]
   */
  async close(opts = {}) {
    if (this._closed) return;
    this._closed = true;
    this._stopPlay();
    this._cancelDrag();
    this._closePop();
    this.touch.reset();
    this._saveView();
    this._unbindDom();
    cancelAnimationFrame(this._raf);
    clearTimeout(this._toastTimer);
    clearTimeout(this._soundTimer);
    // お知らせを消す(次に開いた画面に残り、「元に戻す」が閉じたこの画面の譜面に効かないように)
    const toast = $('edit-toast');
    toast.hidden = true;
    toast.innerHTML = '';
    if (this._wavVoice) this.app.audio.stopVoice(this._wavVoice);
    this._wavVoice = null;
    this._wavPending = null;
    this._wavTok = (this._wavTok || 0) + 1;
    this._stopStep(); // 録音しかけのチップを 1 手にする・叩いて入力の和音を閉じる
    this.app.releaseWakeLock();
    await this.flushDraft();
    await this.session.commit();
    if (this.player) this.player.dispose();
    this.player = null;
    if (this.previewRenderer) this.previewRenderer._releaseBase();
    this.previewRenderer = null;
    this.root.hidden = true;
    void opts;
  }

  _saveView() {
    this.session.view = { uHead: this.view.uHead, zoom: this.view.zoom, guide: this.view.guide, mode: this.mode, layout: this.view.layout };
  }

  /** 下書きをすぐ書く(閉じる・テストプレイ・タブが隠れたとき)。 */
  async flushDraft() {
    clearTimeout(this._draftTimer);
    this._draftTimer = 0;
    const s = this.session;
    this._saveView();
    // 残すのは、ファイル(フォルダへ上書きしたもの・元の譜面)と違うとき。新しい難易度は、フォルダへ書くまで残す
    // (曲パックに重ねただけなので、ページを開き直すと下書きにしか無い)
    const out = s.outputBytes().bytes;
    const keep = s.diskBytes ? !sameBytes(out, s.diskBytes) : s.isNew || (s.modified && !s.sameAsOriginal);
    if (keep) await saveDraft(s.pkg, s.path, s.draftValue());
    else await deleteDraft(s.pkg, s.path);
  }

  _scheduleDraft() {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => { this.flushDraft(); }, DRAFT_DEBOUNCE_MS);
  }

  // ---- DOM ----

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _bindDom() {
    const cv = this.canvas;
    this._on(cv, 'pointerdown', (e) => this._pointerDown(e));
    this._on(cv, 'pointermove', (e) => this._pointerMove(e));
    this._on(cv, 'pointerup', (e) => this._pointerUp(e, false));
    this._on(cv, 'pointercancel', (e) => this._pointerUp(e, true));
    this._on(cv, 'lostpointercapture', (e) => { if (this._drag && this._drag.pointerId === e.pointerId) this._pointerUp(e, true); });
    this._on(cv, 'pointerleave', (e) => { if (e.pointerType !== 'touch' && !this._drag) { this._hover = null; this._setGhost(null); } });
    this._on(cv, 'contextmenu', (e) => e.preventDefault());
    this._on(cv, 'wheel', (e) => this._wheel(e), { passive: false });
    this._on(window, 'keydown', (e) => this._keyDown(e), true);
    this._on(window, 'keyup', (e) => this._keyUp(e), true);
    this._on(document, 'visibilitychange', () => { if (document.hidden) { this._stopPlay(); this.flushDraft(); } });
    this._on(window, 'pagehide', () => { this.flushDraft(); });
    // メニューの外を押したら閉じる。譜面を押して閉じたときは、その押しで書かない(閉じるだけ)
    this._on(document, 'pointerdown', (e) => {
      const pop = $('edit-pop');
      if (pop.hidden || pop.contains(e.target)) return;
      this._closePop();
      if (e.target === this.canvas) e.stopPropagation();
    }, true);
    const btn = (id, fn) => {
      const b = $(id);
      this._on(b, 'click', (e) => { b.blur(); fn(e); });
    };
    btn('edit-back', () => this.app.closeEditor());
    btn('edit-undo', () => this.undo());
    btn('edit-redo', () => this.redo());
    btn('edit-save', () => this.saveDtx());
    btn('edit-more', () => this._moreMenu());
    btn('edit-zoom-in', () => this._zoomStep(1));
    btn('edit-zoom-out', () => this._zoomStep(-1));
    btn('edit-play', () => this.togglePlay());
    btn('edit-follow', () => { this.follow = true; this._syncButtons(); });
    btn('edit-test', () => this.testPlay());
    btn('edit-suspect', () => this.nextSuspect());
    btn('edit-panel', () => this.panel.toggle());
    btn('edit-preview-btn', () => this._togglePreview());
    // プレビューの上でのホイールは譜面を送る(プレビューは押しても何もしない)
    const pv = $('edit-preview');
    this._on(pv, 'wheel', (e) => this._wheel(e), { passive: false });
    this._on(pv, 'contextmenu', (e) => e.preventDefault());
    btn('edit-step', () => this._toggleStep());
    for (const b of document.querySelectorAll('#edit-mode button')) {
      this._on(b, 'click', () => { b.blur(); this._setMode(b.dataset.mode); });
    }
    this._on($('edit-guide'), 'change', () => {
      this._setGuide(Number($('edit-guide').value));
      // 選んだら譜面へ戻す(選択欄にフォーカスが残るとショートカットが効かない)
      this.canvas.focus({ preventScroll: true });
    });
    for (const seg of document.querySelectorAll('#edit-types .seg')) {
      const col = Number(seg.dataset.col);
      seg.querySelectorAll('button').forEach((b, i) => {
        this._on(b, 'click', () => { b.blur(); this._setActiveType(col, i); });
      });
    }
    // 右の位置のバー(つまみをドラッグ / バーを押してその位置へ)
    const rail = $('edit-rail');
    const railMove = (e) => {
      const r = rail.getBoundingClientRect();
      const f = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
      const m = this.model;
      this.follow = false;
      this.view.uHead = -1 + f * (m.geometry.start(m.endMeasure + 1) + 1);
      this._clampHead();
      this._render();
    };
    this._on(rail, 'pointerdown', (e) => { e.preventDefault(); try { rail.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ } this._railDrag = true; railMove(e); });
    this._on(rail, 'pointermove', (e) => { if (this._railDrag) railMove(e); });
    this._on(rail, 'pointerup', () => { this._railDrag = false; });
    this._on(rail, 'pointercancel', () => { this._railDrag = false; });
    // 譜面の場所の大きさが変わったら(お知らせの帯・状態の行の文字・ツールバーの折り返し)キャンバスを合わせる
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => { if (!this._closed) this.onResize(); });
      this._ro.observe($('edit-stage'));
    }
  }

  _unbindDom() {
    for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    this._listeners = [];
    if (this._ro) this._ro.disconnect();
    this._ro = null;
  }

  onResize() {
    const stage = $('edit-stage');
    const rail = $('edit-rail');
    const railW = rail ? rail.offsetWidth : 0;
    const h = Math.max(1, stage.clientHeight);
    // 演奏画面のプレビュー(出すなら右に。狭すぎれば出さない)。配置は場所の幅と横のパネルだけで決め、高さやプレビューの幅には
    // よらせない(よらせると、狭い配置のツールバーの段・横のパネルの寄せ方で場所の大きさが変わり、配置が毎フレーム入れ替わる)。
    // 広い配置ならそれを狭い配置に落とすほどは取らない。ただし、横のパネルを寄せない窓で広い配置のままでは並べられない幅
    // (COMPACT_BELOW + PREVIEW_MIN_W 未満)なら、狭い配置にして並べる(それより狭い窓では出るのに、広げると消えないように。
    // 狭い配置にしたからには、低い窓でも出す)。
    // 広い配置で横のパネルを右から重ねているときは、プレビューがその下に隠れるので出さない(パネルを閉じると出る)
    const pv = $('edit-preview');
    const on = !!this.config.editPreview;
    const canDock = this.panel.open && window.innerWidth >= PANEL_DOCK_MIN;
    // 場所の幅は、これから決める寄せ方でのもの(パネルの寄せ方のクラスは下の panel.layout() で変わるので、今の場所を測ると、
    // 寄せたパネルを閉じた直後などに一度だけ別の配置になり、拡大率も入れ替わる)
    const stageW = $('edit-main').clientWidth - (canDock ? PANEL_DOCK_W : 0);
    const avail = stageW - railW;
    const forceCompact = on && !canDock && avail >= COMPACT_BELOW && avail < COMPACT_BELOW + PREVIEW_MIN_W;
    const covered = this.panel.open && !canDock && !forceCompact && avail >= COMPACT_BELOW;
    let pw = 0;
    if (forceCompact) pw = previewWidth(avail, h);
    else if (on && !covered) pw = previewWidth(avail, h, COMPACT_BELOW);
    // 出せないわけ(お知らせ用)。パネルが隠しているか、パネルを閉じれば出る幅になるなら 'panel'、ほかは 'size'
    this._previewBlock = !on || pw ? null : covered || (canDock && previewWidth(avail + PANEL_DOCK_W, h, COMPACT_BELOW)) ? 'panel' : 'size';
    pv.hidden = !pw;
    // 描く大きさは左の区切り線(1px。box-sizing: border-box で幅に含まれる)を除いたもの
    this._previewSize = pw ? { w: pw - 1, h } : null;
    if (pw) {
      pv.style.width = pw + 'px';
      pv.style.height = h + 'px';
    } else if (this.previewRenderer) {
      this.previewRenderer._releaseBase(); // しまったら静止部分の作り置きをすぐ手放す(iOS のキャンバスの総量の上限)
    }
    const pvBtn = $('edit-preview-btn');
    pvBtn.classList.toggle('on', !!this.config.editPreview);
    pvBtn.setAttribute('aria-pressed', String(!!this.config.editPreview));
    const w = Math.max(1, avail - pw);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    const before = this.view.layout;
    this.view.resize(w, h, window.devicePixelRatio || 1, forceCompact ? 'compact' : null);
    if (pw && this.previewRenderer) this._resizePreview();
    this.root.classList.toggle('compact', this.view.layout === 'compact');
    this.panel.layout();
    if (before !== this.view.layout) {
      // 向きを変えて配置が替わったら、その配置の拡大率にする(再生位置の u は変えない)
      const z = this.config.editZoom && this.config.editZoom[this.view.layout];
      this.view.zoom = ZOOMS.includes(z) ? z : nearestZoom(document.body.classList.contains('touch') ? 0.96 / this.view.s : 1);
    }
    this._render();
  }

  _buildGuideSelect() {
    const sel = $('edit-guide');
    sel.innerHTML = '';
    for (const d of GUIDES) {
      const o = document.createElement('option');
      o.value = String(d);
      o.textContent = d ? `1/${d}` : t('edit.snapFree');
      sel.appendChild(o);
    }
  }

  // ---- 描画 ----

  /** 次のフレームで描く。 */
  _render() {
    this._dirty = true;
    if (!this._raf && !this._closed) this._raf = requestAnimationFrame((now) => this._frame(now));
  }

  _frame(now) {
    this._raf = 0;
    if (this._closed) return;
    let more = false;
    const p = this.player;
    if (p && p.chart && p.state !== PLAYER_STATE.STANDBY) {
      p.update(now);
      if (this.follow) this.view.uHead = this._uOfMs(p.songMs);
      more = true;
      this._previewUntil = now + 600;
      if (p.state === PLAYER_STATE.STANDBY) {
        // 最後まで鳴って止まった
        this.app.releaseWakeLock();
        this._commitRecorded();
        this._syncButtons();
      }
    }
    if (this._fling) more = this._stepFling(now) || more;
    if (this._autoScroll) more = this._stepAutoScroll(now) || more;
    const st = this.view.state;
    for (const until of st.flash.values()) if (until > now) more = true;
    if (this._previewSize && now < this._previewUntil) more = true;
    if (this._dirty || more) {
      this._dirty = false;
      this._fillState();
      this.view.draw(now);
      this._drawPreview(now);
      this._updateRail();
      this._updateStatus();
      this.panel.refresh();
    }
    if (more) this._raf = requestAnimationFrame((n) => this._frame(n));
  }

  _fillState() {
    const st = this.view.state;
    const s = this.session;
    st.model = this.model;
    st.activeTypes = s.activeTypes;
    st.pens = s.pens;
    // 選択はどちらのモードでも見せる(ペンのモードでも R・Delete が選択に効くので)。ペンで書くと選択は外れる
    st.selection = s.selection;
    st.showIds = !!this.config.editShowIds;
    st.otherBranches = !!this.config.editOtherBranches;
    st.suspects = this.sidecar && this.config.editConfidence !== false ? this._suspectMap() : null;
    const lp = s.loopPos;
    const geo = this.model.geometry;
    const lr = this._loopRange;
    if (lr) st.loop = { u0: geo.start(lr.m0), u1: geo.start(lr.m1 + 1) };
    else st.loop = lp ? { u0: geo.uOfPos(lp.beginPos), u1: lp.endAtEnd ? null : geo.uOfPos(lp.endPos) } : null;
    if (st.loop && st.loop.u1 === null) st.loop.u1 = geo.uOfPos(msToPos(this.model.chart, this.model.chart.durationMs));
  }

  /** 今の譜面の要確認のチップ(文書ごとに作り置く)。 */
  _suspectMap() {
    const doc = this.model.doc;
    if (!this._suspectCache || this._suspectCache.doc !== doc) this._suspectCache = { doc, map: suspectsOf(this.model, this.sidecar) };
    return this._suspectCache.map;
  }

  /**
   * 演奏画面のプレビューを描く。止まっているときは、編集画面の再生位置を判定ラインに合わせ、文書が変わっていれば譜面を
   * 差し替える(再生中は差し替えない。編集画面の再生と同じ)。ハイスピードはトレーニングの設定のもの。
   */
  _drawPreview(now) {
    const p = this.player;
    const size = this._previewSize;
    if (!p || !size) return;
    if (!this.previewRenderer || this.previewRenderer.player !== p) {
      this.previewRenderer = new PreviewRenderer($('edit-preview'), this.skin, p);
      this._resizePreview();
    }
    if (p.state === PLAYER_STATE.STANDBY) {
      const before = this._playerDoc;
      this._preparePlayer();
      this._applyPlayOptions();
      p.applySettings();
      p.scrollCurrentRatio = p.scrollRatioSetting; // 止まっているときは、ハイスピードを変えたらすぐその速さで
      const ms = Math.max(0, posToMs(this.model.chart, this.model.geometry.posOfU(Math.max(-1, this.view.uHead))));
      // 譜面を差し替えたら叩いた印を作り直す(同じ位置でも)
      if (before !== this._playerDoc) p.enterStandby(false, ms);
      else p.seekTo(ms);
    }
    this.previewRenderer.draw(now);
  }

  /** プレビューの大きさ(判定ラインは編集画面の再生位置の線にそろえる。どちらのキャンバスも場所の上端から)。 */
  _resizePreview() {
    const { w, h } = this._previewSize;
    this.previewRenderer.resize(w, h, Math.min(2, window.devicePixelRatio || 1), this.view.headY * this.view.s);
  }

  /** 演奏画面のプレビューを出す / しまう(V。出すかは覚える)。 */
  _togglePreview() {
    const c = this.config;
    c.editPreview = !c.editPreview;
    this.app.saveConfig();
    this.onResize();
    if (c.editPreview && !this._previewSize) this._toast(t(this._previewBlock === 'panel' ? 'edit.previewPanel' : 'edit.previewNarrow'));
    this._render();
  }

  _updateRail() {
    const thumb = $('edit-rail-thumb');
    if (!thumb) return;
    const m = this.model;
    const total = m.geometry.start(m.endMeasure + 1) + 1;
    const f = Math.max(0, Math.min(1, (this.view.uHead + 1) / total));
    const pct = ((1 - f) * 100).toFixed(2) + '%';
    if (thumb.style.top !== pct) thumb.style.top = pct;
    this._drawRailMap(total);
  }

  /** 右のバーにチップの密度を描く(どこに譜面があるかが分かるように。本アプリの追加)。文書か大きさが変わったときだけ。 */
  _drawRailMap(total) {
    const rail = $('edit-rail');
    let cv = $('edit-rail-map');
    if (!rail) return;
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'edit-rail-map';
      cv.setAttribute('aria-hidden', 'true');
      rail.prepend(cv);
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rail.clientWidth * dpr));
    const hh = Math.max(1, Math.round(rail.clientHeight * dpr));
    const doc = this.model.doc;
    if (this._railMapFor && this._railMapFor.doc === doc && this._railMapFor.w === w && this._railMapFor.h === hh) return;
    this._railMapFor = { doc, w, h: hh };
    if (cv.width !== w) cv.width = w;
    if (cv.height !== hh) cv.height = hh;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, hh);
    const bins = new Float32Array(hh);
    for (const c of this.model.chips) {
      if (c.locked && !c.active) continue;
      const y = Math.floor((1 - (c.u + 1) / total) * (hh - 1));
      if (y >= 0 && y < hh) bins[y]++;
    }
    let max = 0;
    for (const v of bins) max = Math.max(max, v);
    if (!max) return;
    g.fillStyle = 'rgba(102, 217, 255, 0.55)';
    for (let y = 0; y < hh; y++) {
      if (!bins[y]) continue;
      const len = Math.max(1, Math.round((w - 2) * Math.min(1, Math.sqrt(bins[y] / max))));
      g.fillRect((w - len) / 2, y, len, 1);
    }
  }

  _updateStatus() {
    const m = this.model;
    const geo = m.geometry;
    const cell = geo.snap(this.view.uHead, 0);
    let pos = t('edit.leadIn');
    if (cell) {
      const { beat } = m.beatOf(cell.measure, cell.tick);
      pos = t('edit.posBeat', { m: String(cell.measure).padStart(3, '0'), b: beat, t: cell.tick });
    }
    const p = geo.posOfU(this.view.uHead);
    const ms = posToMs(m.chart, p);
    const bpm = m.bpmAtPos(p);
    const text = `${pos}   ${msClock(ms)}   BPM ${Math.round(bpm * 100) / 100}`;
    const el = $('edit-pos');
    if (el.textContent !== text) el.textContent = text;
    const n = this._selKeys().length;
    const info = [n ? t('edit.selCount', { n }) : '', this._soundInfo || ''].filter(Boolean).join('   ');
    const ie = $('edit-info');
    if (ie.textContent !== info) ie.textContent = info;
  }

  _uOfMs(ms) {
    const chart = this.model.chart;
    return this.model.geometry.uOfPos(msToPos(chart, ms));
  }

  _clampHead() {
    const m = this.model;
    const max = m.geometry.start(m.endMeasure + 1);
    this.view.uHead = Math.max(-1, Math.min(max, this.view.uHead));
  }

  _syncButtons() {
    const h = this.session.history;
    $('edit-undo').disabled = !h.canUndo;
    $('edit-redo').disabled = !h.canRedo;
    $('edit-dirty').hidden = !this.session.modified;
    const playing = !!(this.player && this.player.state !== PLAYER_STATE.STANDBY);
    const play = $('edit-play');
    play.textContent = playing ? '■' : '▶';
    play.classList.toggle('on', playing);
    $('edit-follow').hidden = !(playing && !this.follow);
    const step = $('edit-step');
    step.setAttribute('aria-pressed', String(!!this.stepArmed));
    step.classList.toggle('on', !!this.stepArmed);
    step.classList.toggle('rec', !!this.stepArmed && playing);
    const label = this.stepArmed && playing ? t('edit.record') : t('edit.stepInput');
    if (step.textContent !== label) step.textContent = label;
  }

  _syncTypes() {
    for (const seg of document.querySelectorAll('#edit-types .seg')) {
      const col = Number(seg.dataset.col);
      seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(this.session.activeTypes[col] === i)));
    }
  }

  _showBanners() {
    const m = this.model;
    const notes = [];
    if (m.doc.index.lockedObjects > 0) notes.push(t(this.session.rolls.length ? 'edit.lockedNotePlayed' : 'edit.lockedNoteFirst'));
    if (m.chart.noteMask & 6) notes.push(t('edit.gbNote'));
    const info = m.doc.info;
    if (info.encoding === 'utf-8' && !info.bom) notes.push(t('edit.utf8NoBom'));
    const b = $('edit-banner');
    b.innerHTML = '';
    b.hidden = !notes.length;
    if (!notes.length) return;
    const text = document.createElement('span');
    text.textContent = notes.join(' / ');
    const x = document.createElement('button');
    x.className = 'pb';
    x.textContent = '×';
    x.title = t('edit.close');
    x.onclick = () => { b.hidden = true; this.onResize(); };
    b.append(text, x);
  }

  // ---- 文書を変える ----

  /**
   * 操作の結果を 1 手にする。EditError はお知らせにして null。
   * 選択は操作の結果にするが、ペンのモードで書いたとき(keepSel でないとき)は外す(書くたびに枠が付かないように)。
   * selectBefore(元に戻したときの選択)は、渡さなければ今の選択。
   * @param {() => {doc, select?: string[]}} fn
   * @param {{label: string, selectBefore?: string[], focusU?: number, coalesceKey?: string, keepSel?: boolean}} opts
   */
  _commit(fn, opts) {
    let r;
    try {
      r = fn();
    } catch (e) {
      if (e instanceof EditError) {
        this._toast(t(ERR[e.code] || 'edit.measureLimit', e.vars));
        return null;
      }
      throw e;
    }
    const selectBefore = opts.selectBefore || [...this.session.selection];
    const changed = this.session.apply(r, { label: opts.label, selectBefore, focusU: opts.focusU, coalesceKey: opts.coalesceKey });
    if (this.mode === 'pen' && !opts.keepSel) this.session.selection = new Set();
    else if (opts.keepSel && r.select && !r.select.length) {
      // 何も選ばない操作(譜面情報・音源・BGM をずらす)は、今の選択を残す(無くなったものは外す)
      this.session.selection = new Set(selectBefore.filter((k) => this.model.kindOf(k)));
    }
    if (changed) {
      this._afterDocChange();
      this._scheduleDraft();
    }
    this._render();
    return changed ? r : null;
  }

  _afterDocChange() {
    this._syncButtons();
    if (this.player && this.player.state !== PLAYER_STATE.STANDBY) this._toast(t('edit.beforeEdit'));
    // 新しい番号の音を読む
    clearTimeout(this._soundTimer);
    this._soundTimer = setTimeout(() => this._loadSounds(true), 300);
  }

  undo() {
    if (this._closed) return;
    const h = this.session.history;
    const top = h.entries[h.index];
    const r = h.undo();
    if (!r) return;
    // 小節の挿入 / 削除でずらしたループを戻す(そのあと演奏画面でループを決め直していれば触らない)
    const ls = top.loopShift;
    if (ls && this.session.loopPos === ls.after) this.session.loopPos = ls.before;
    this._afterHistory(r, 'edit.undone');
  }

  redo() {
    if (this._closed) return;
    const h = this.session.history;
    const r = h.redo();
    if (!r) return;
    const ls = h.entries[h.index].loopShift;
    if (ls && this.session.loopPos === ls.before) this.session.loopPos = ls.after;
    this._afterHistory(r, 'edit.redone');
  }

  _afterHistory(r, key) {
    // ペンのモードでは、戻した操作の選択は付けない(ペンで書いても選択しないのと同じ)
    this.session.selection = new Set(this.mode === 'pen' ? [] : r.select || []);
    this._afterDocChange();
    this._scheduleDraft();
    if (r.label) this._toast(t(key, { what: t(r.label) }));
    // 戻した変更が画面の外なら、そこへ送る(本アプリの追加)
    if (Number.isFinite(r.focusU)) {
      const { lo, hi } = this.view.uRange;
      if (r.focusU < lo || r.focusU > hi) {
        this.follow = false;
        this.view.uHead = r.focusU;
        this._clampHead();
      }
    }
    this._render();
  }

  // ---- 置く場所 ----

  /** 今の種類のチャンネル(alt でもう一方)。 */
  _channel(col, alt) {
    const types = COLUMN_TYPES[col];
    const at = this.session.activeTypes[col] || 0;
    return types.length < 2 ? types[0] : types[alt ? 1 - at : at];
  }

  _snapGuide(free) {
    return free ? 0 : this.view.guide;
  }

  /**
   * 押したところで何が起きるか(影と同じ規則。docs/spec/chart-editor.md「置く場所の決め方」)。
   * @returns {{kind: 'none'|'chip'|'empty'|'replace'|'locked'|'limit', col?:number, ch?:number, cell?, chip?, half?:number, u?:number}}
   */
  _target(hit, pointerType, { alt = false, free = false } = {}) {
    if (!hit || hit.region !== 'lanes') return { kind: 'none' };
    const m = this.model;
    const geo = m.geometry;
    const col = hit.column;
    const ch = this._channel(col, alt);
    const c = m.chipAt(col, hit.u, this.view.tolU(pointerType), hit.half);
    if (c) return { kind: 'chip', col, ch, chip: c, u: c.u, half: c.half };
    const cell = geo.snap(hit.u, this._snapGuide(free));
    if (!cell) return { kind: 'none' };
    const u = geo.u(cell.measure, cell.tick);
    if (cell.measure > MAX_MEASURE) return { kind: 'limit', col, ch, cell, u };
    const chips = m.cellChips(col, cell.measure, cell.tick);
    if (chips.some((x) => x.locked && x.active && channelsConflict(x.channel, ch))) return { kind: 'locked', col, ch, cell, u };
    const same = chips.find((x) => !x.locked && x.channel === ch);
    if (same) return { kind: 'chip', col, ch, chip: same, cell, u: same.u, half: same.half };
    if (chips.some((x) => !x.locked && channelsConflict(x.channel, ch))) return { kind: 'replace', col, ch, cell, u };
    const partner = chips.some((x) => !x.locked && x.channel !== ch);
    return { kind: 'empty', col, ch, cell, u, half: partner ? TYPE_OF.get(ch) + 1 : 0 };
  }

  _setGhost(tg) {
    const st = this.view.state;
    let gh = null;
    if (tg && tg.kind !== 'none' && tg.kind !== 'limit') {
      const kind = tg.kind === 'chip' ? 'delete' : tg.kind === 'empty' ? 'add' : tg.kind;
      gh = { column: tg.col, u: tg.u, channel: tg.kind === 'chip' ? tg.chip.channel : tg.ch, kind, half: tg.half || 0 };
    }
    const prev = st.ghost;
    if (JSON.stringify(prev) === JSON.stringify(gh)) return;
    st.ghost = gh;
    this._render();
  }

  _pen(ch) {
    return this.session.pens.get(ch) || '01';
  }

  /** ペン / 選択のモード(E / S。(変更) DTXCreator の Ctrl+Space は IME の切り替えなので使わない)。選択は残す。 */
  _setMode(mode) {
    if (mode !== 'pen' && mode !== 'select') return;
    this.mode = mode;
    for (const b of document.querySelectorAll('#edit-mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    this._hoverGhost();
    this._render();
  }

  /** マウスで指しているところの影を描き直す(選択のモードでは影を出さない)。 */
  _hoverGhost() {
    const h = this._hover;
    if (!h || this.mode !== 'pen') {
      this._setGhost(null);
      return;
    }
    this._setGhost(this._target(this.view.hit(h.clientX, h.clientY), h.pointerType, h.mods));
  }

  /** 選んでいるもののうち今の譜面にあるもの(チップと BPM の印の名前)。 */
  _selKeys() {
    const m = this.model;
    return [...this.session.selection].filter((k) => m.kindOf(k));
  }

  /** 押したところのチップか BPM の印の名前(選択のモード。無ければ null)。 */
  _keyAt(hit, pointerType) {
    if (hit.region === 'lanes') {
      const c = this.model.chipAt(hit.column, hit.u, this.view.tolU(pointerType), hit.half);
      return c ? c.key : null;
    }
    if (hit.region === 'bpm') {
      const b = this._bpmAt(hit.u, pointerType);
      return b && !b.locked ? b.key : null;
    }
    return null;
  }

  /** u に近い BPM の印(分岐の中で表示していないものは除く)。 */
  _bpmAt(u, pointerType) {
    const tol = this.view.bpmTolU(pointerType);
    let best = null;
    for (const b of this.model.bpmMarks) {
      if (b.locked && !b.active) continue;
      const d = Math.abs(b.u - u);
      if (d <= tol && (!best || d < Math.abs(best.u - u))) best = b;
    }
    return best;
  }

  /** 選んだものの中でいちばん前の u(元に戻したときに送る先)。 */
  _focusOf(keys) {
    const m = this.model;
    let u = Infinity;
    for (const k of keys) {
      const x = m.chip(k) || m.bpmMark(k);
      if (x) u = Math.min(u, x.u);
    }
    return Number.isFinite(u) ? u : undefined;
  }

  // ---- マウス / ペン ----

  _mods(e) {
    return { alt: e.altKey, shift: e.shiftKey, free: e.ctrlKey || e.metaKey };
  }

  _pointerDown(e) {
    if (e.pointerType === 'touch') {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
      this._stopFling();
      this.touch.down(e);
      return;
    }
    if (e.pointerType === 'pen') this.touch.notePen();
    this.canvas.focus({ preventScroll: true });
    this._closePop();
    this._stopFling();
    if (this._drag) return;
    const hit = this.view.hit(e.clientX, e.clientY);
    const mods = this._mods(e);
    if (e.button === 2) {
      e.preventDefault();
      if (hit.region === 'header' && hit.column >= 0) {
        this._penMenu(hit.column, e.clientX, e.clientY);
        return;
      }
      if (hit.region === 'gutter') {
        this._measureMenu(hit, e.clientX, e.clientY);
        return;
      }
      if (this.mode === 'select') {
        // 選択のモードはメニュー(選んでいないチップの上なら、先にそれだけを選ぶ)
        const key = this._keyAt(hit, e.pointerType);
        if (key && !this.session.selection.has(key)) this.session.selection = new Set([key]);
        this._render();
        this._contextMenu(e.clientX, e.clientY, hit);
        return;
      }
      if (hit.region === 'bpm') {
        const b = this._bpmAt(hit.u, e.pointerType);
        if (b && b.locked) this._toast(t('edit.lockedCell'));
        else if (b) this._commit(() => opDelete(this.model, [b.key]), { label: OP.bpm, focusU: b.u });
        return;
      }
      this._startErase(e, hit);
      return;
    }
    if (e.button !== 0) return;
    if (hit.region === 'header') {
      if (hit.column >= 0) this._headerClick(hit.column, e.clientX, e.clientY);
      return;
    }
    if (hit.region === 'gutter') {
      this._gutterClick(hit);
      return;
    }
    if (this.mode === 'select' && (hit.region === 'lanes' || hit.region === 'bpm')) {
      this._selectPress(e, hit, mods);
      return;
    }
    if (hit.region === 'bpm') {
      // 押して離したら BPM のダイアログ(押したときに開くと、離したときのクリックがダイアログに届く)
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
      this._drag = { type: 'bpmClick', pointerId: e.pointerId, pointerType: e.pointerType, u: hit.u, mods };
      return;
    }
    if (hit.region !== 'lanes') return;
    const tg = this._target(hit, e.pointerType, mods);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
    if (tg.kind === 'chip') {
      this._drag = { type: 'chipPress', pointerId: e.pointerId, pointerType: e.pointerType, x0: e.clientX, y0: e.clientY, chip: tg.chip, mods };
      return;
    }
    if (tg.kind === 'locked') { this._toast(t('edit.lockedCell')); return; }
    if (tg.kind === 'limit') { this._toast(t('edit.measureLimit')); return; }
    if (tg.kind === 'empty' || tg.kind === 'replace') {
      const value = this._pen(tg.ch);
      this._drag = {
        type: 'paint', pointerId: e.pointerId, pointerType: e.pointerType, x0: e.clientX, y0: e.clientY, col: tg.col, ch: tg.ch, value,
        cells: [{ measure: tg.cell.measure, tick: tg.cell.tick, channel: tg.ch, value }], lastSound: performance.now(), mods,
      };
      this._previewSound(tg.ch, value);
      this._updatePaintPreview();
      this._setGhost(null);
    }
  }

  /**
   * 選択のモードで押した(DTXCreator の選択モード §5.2)。チップ / BPM の印の上なら選び(Shift で足す、Ctrl / ⌘ で入れ替え)、
   * そのままドラッグすると選んだものを動かす。何もないところからは範囲選択。
   */
  _selectPress(e, hit, mods) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
    const key = this._keyAt(hit, e.pointerType);
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, x0: e.clientX, y0: e.clientY, mods };
    if (!key) {
      if (hit.region === 'lanes') {
        const c = this.model.chipAt(hit.column, hit.u, this.view.tolU(e.pointerType), hit.half);
        if (!c && this.model.cellChips(hit.column, ...this._cellOf(hit.u)).some((x) => x.locked)) this._toast(t('edit.lockedCell'));
      }
      const keep = mods.shift || mods.free;
      this._drag = { ...base, type: 'band', u0: hit.u, lx0: hit.x, keep: keep ? new Set(this.session.selection) : new Set(), moved: false };
      return;
    }
    const s = this.session;
    const was = s.selection.has(key);
    if (!mods.alt) {
      const sel = new Set(s.selection);
      if (mods.free) {
        if (was) sel.delete(key);
        else sel.add(key);
      } else if (mods.shift) sel.add(key);
      else if (!was) {
        sel.clear();
        sel.add(key);
      }
      s.selection = sel;
    }
    this._drag = { ...base, type: 'selPress', key, was };
    this._render();
  }

  /** u のセル(ガイドに合わせる)の [小節, tick]。リードインは [-1, 0]。 */
  _cellOf(u) {
    const c = this.model.geometry.snap(u, this.view.guide);
    return c ? [c.measure, c.tick] : [-1, 0];
  }

  _pointerMove(e) {
    if (e.pointerType === 'touch') {
      this.touch.move(e);
      return;
    }
    if (e.pointerType === 'pen') this.touch.notePen();
    this._hover = { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType, mods: this._mods(e) };
    const d = this._drag;
    if (!d) {
      const hit = this.view.hit(e.clientX, e.clientY);
      this.canvas.style.cursor = hit.region === 'bpm' || hit.region === 'gutter' || hit.region === 'header' ? 'pointer' : '';
      this._hoverGhost();
      return;
    }
    if (d.pointerId !== e.pointerId) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.liveMods = this._mods(e);
    this._dragMove(e.clientX, e.clientY, d.liveMods);
    // 端での自動スクロールは、本当にドラッグしてから(押しただけの手ぶれで塗り・消しが走らないように)
    if (!d.dragged && Number.isFinite(d.x0)) d.dragged = Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > (G.SLOP_CSS[d.pointerType] || 4);
    if (d.type === 'move' || d.dragged) this._checkAutoScroll(e.clientY);
  }

  _dragMove(clientX, clientY, mods) {
    const d = this._drag;
    if (!d) return;
    const hit = this.view.hit(clientX, clientY);
    const slop = G.SLOP_CSS[d.pointerType] || 4;
    if (d.type === 'chipPress') {
      if (Math.hypot(clientX - d.x0, clientY - d.y0) <= slop) return;
      d.type = 'move';
      d.anchor = d.chip.key;
      d.keys = [d.chip.key];
    }
    if (d.type === 'selPress') {
      if (Math.hypot(clientX - d.x0, clientY - d.y0) <= slop) return;
      if (d.mods.alt || !this.session.selection.has(d.key)) return; // Ctrl で外したチップは動かさない
      d.type = 'move';
      d.anchor = d.key;
      d.keys = this._selKeys();
    }
    if (d.type === 'band') {
      if (!d.moved && Math.hypot(clientX - d.x0, clientY - d.y0) <= slop) return;
      d.moved = true;
      this._updateBand(clientX, clientY);
      return;
    }
    if (d.type === 'bpmClick') return;
    if (d.type === 'move') {
      this._updateMovePreview(hit, mods);
      return;
    }
    if (d.type === 'paint') {
      // 押したところから少し動かすまでは塗らない(手ぶれで隣のセルに書かない)
      if (!d.painting) {
        if (Math.hypot(clientX - d.x0, clientY - d.y0) <= slop) return;
        d.painting = true;
      }
      const geo = this.model.geometry;
      const g = this._snapGuide(mods.free);
      const cell = geo.snap(hit.u, g);
      if (!cell || cell.measure > MAX_MEASURE) return;
      const last = d.cells[d.cells.length - 1];
      if (last.measure === cell.measure && last.tick === cell.tick) return;
      const add = (c) => {
        if (d.cells.some((x) => x.measure === c.measure && x.tick === c.tick)) return;
        // 分岐の中のチップ(塗っているチャンネルとぶつかるもの)があるセルは飛ばす
        if (this.model.cellChips(d.col, c.measure, c.tick).some((x) => x.locked && x.active && channelsConflict(x.channel, d.ch))) return;
        d.cells.push({ measure: c.measure, tick: c.tick, channel: d.ch, value: d.value });
        const now = performance.now();
        if (now - d.lastSound >= G.PAINT_SOUND_MS) {
          d.lastSound = now;
          this._previewSound(d.ch, d.value);
        }
      };
      if (!g) {
        // フリー(Ctrl)では 1 tick ごとに埋めない。指しているセルだけを、前に置いたところから少し離れたら置く
        const px = Math.abs(geo.u(cell.measure, cell.tick) - geo.u(last.measure, last.tick)) * this.view.ppu * this.view.s;
        if (px >= slop * 2) add(cell);
        this._updatePaintPreview();
        return;
      }
      // 飛ばしたセルも埋める(速く動かしても途切れない)
      const dir = geo.u(cell.measure, cell.tick) > geo.u(last.measure, last.tick) ? 1 : -1;
      let cur = { measure: last.measure, tick: last.tick };
      for (let i = 0; i < 512; i++) {
        cur = geo.step(cur.measure, cur.tick, g, dir);
        if (cur.measure < 0 || cur.measure > MAX_MEASURE) break;
        const passed = dir > 0 ? geo.u(cur.measure, cur.tick) > geo.u(cell.measure, cell.tick) + 1e-9 : geo.u(cur.measure, cur.tick) < geo.u(cell.measure, cell.tick) - 1e-9;
        if (passed) break;
        add(cur);
        if (cur.measure === cell.measure && cur.tick === cell.tick) break;
      }
      this._updatePaintPreview();
      return;
    }
    if (d.type === 'erase') {
      this._eraseAt(hit, d.pointerType);
    }
  }

  _pointerUp(e, cancelled) {
    if (e.pointerType === 'touch') {
      this.touch.up(e, cancelled);
      return;
    }
    const d = this._drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this._drag = null;
    this._autoScroll = null;
    const st = this.view.state;
    st.paint = null;
    st.preview = null;
    st.erase = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 解放済み */ }
    st.band = null;
    if (cancelled) {
      if (d.type === 'band') this.session.selection = d.keep;
      this._render();
      return;
    }
    if (d.type === 'chipPress') {
      const c = d.chip;
      if (d.mods.alt) this._setTypes([c.key], d.mods.shift);
      else if (d.mods.shift) this._addPartner(c.key);
      else this._commit(() => opDelete(this.model, [c.key]), { label: OP.delete, focusU: c.u });
    } else if (d.type === 'selPress') {
      this._selectClick(d);
    } else if (d.type === 'band') {
      if (!d.moved) this.session.selection = d.keep; // 何もないところのクリック: 選択を外す(Shift / Ctrl なら残す)
    } else if (d.type === 'bpmClick') {
      this._bpmClick(d.u, d.pointerType, d.mods.free);
    } else if (d.type === 'move') {
      this._finishMove(d, e.altKey);
    } else if (d.type === 'paint') {
      const first = d.cells[0];
      if (d.cells.length === 1) this._commit(() => opPlace(this.model, first), { label: OP.place, focusU: this.model.geometry.u(first.measure, first.tick) });
      else this._commit(() => opPaint(this.model, d.cells), { label: OP.place, focusU: this.model.geometry.u(first.measure, first.tick) });
      this.session.selection = new Set();
    } else if (d.type === 'erase') {
      if (d.keys.size) this._commit(() => opErase(this.model, [...d.keys]), { label: OP.delete });
    }
    this._hover = { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType, mods: this._mods(e) };
    this._hoverGhost();
    this._render();
  }

  /** 選択のモードで動かさずに離した。 */
  _selectClick(d) {
    const s = this.session;
    if (d.mods.alt) {
      // Alt+クリック: 種類の切り替え(選んでいるチップなら選んだもの全部)
      const keys = s.selection.has(d.key) ? this._selKeys() : [d.key];
      this._setTypes(keys.filter((k) => this.model.chip(k)), d.mods.shift, true);
      return;
    }
    if (!d.mods.free && !d.mods.shift && d.was) s.selection = new Set([d.key]); // 選んでいたものを押して離した: それだけにする
    // チップを 1 つだけ選んだら、その列のペンをそのチップの音にする(スポイト。本アプリの追加)
    const c = this.model.chip(d.key);
    if (c && s.selection.size === 1 && s.selection.has(c.key)) {
      s.pens.set(c.channel, c.value);
      this._previewSound(c.channel, c.value);
      this._scheduleDraft();
    }
    this._render();
  }

  /** 範囲選択の枠を指の / マウスの位置まで広げ、枠に入るものを選ぶ(始めた位置は u で覚える。自動スクロールしてもずれない)。 */
  _updateBand(clientX, clientY) {
    const d = this._drag;
    const v = this.view;
    const p = v.toLogical(clientX, clientY);
    const band = { x0: d.lx0, y0: v.y(d.u0), x1: p.x, y1: p.y };
    v.state.band = band;
    const r = v.bandRange(band);
    const m = this.model;
    const sel = new Set(d.keep);
    if (r.col1 >= r.col0) for (const c of m.chipsInRect(r.col0, r.col1, r.u0, r.u1)) sel.add(c.key);
    if (r.bpm) for (const b of m.bpmMarks) if (!b.locked && b.u >= r.u0 && b.u <= r.u1) sel.add(b.key);
    this.session.selection = sel;
    this._render();
  }

  _cancelDrag() {
    const d = this._drag;
    if (d) {
      try { this.canvas.releasePointerCapture(d.pointerId); } catch (err) { /* 解放済み */ }
      if (d.type === 'band' && d.keep) this.session.selection = d.restore || d.keep;
    }
    this._drag = null;
    this._autoScroll = null;
    const st = this.view.state;
    st.paint = null;
    st.preview = null;
    st.erase = null;
    st.ghost = null;
    st.band = null;
    this._render();
  }

  _startErase(e, hit) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
    this._drag = { type: 'erase', pointerId: e.pointerId, pointerType: e.pointerType, x0: e.clientX, y0: e.clientY, keys: new Set() };
    this.view.state.erase = this._drag.keys;
    this._eraseAt(hit, e.pointerType);
  }

  _eraseAt(hit, pointerType) {
    const d = this._drag;
    if (!d || hit.region !== 'lanes') return;
    const tg = this._target(hit, pointerType, {});
    if (tg.kind === 'chip' && !d.keys.has(tg.chip.key)) {
      d.keys.add(tg.chip.key);
      this._render();
    }
  }

  _updatePaintPreview() {
    const d = this._drag;
    const geo = this.model.geometry;
    this.view.state.paint = d.cells.map((c) => ({ column: d.col, u: geo.u(c.measure, c.tick), channel: c.channel, value: c.value }));
    this._render();
  }

  /**
   * 動かしている先の描画(元を隠し、行き先に描き、行き先で消えるチップに × を付ける)。つかんだもの(anchor)を
   * ガイドに合わせ、ほかは同じだけ動かす。BPM の印は縦にだけ動く。
   */
  _updateMovePreview(hit, mods) {
    const d = this._drag;
    const m = this.model;
    const geo = m.geometry;
    const anchorChip = m.chip(d.anchor);
    const anchor = anchorChip || m.bpmMark(d.anchor);
    if (!anchor) return;
    const cell = geo.snap(hit.u, this._snapGuide(mods.free));
    const du = cell ? geo.u(cell.measure, cell.tick) - anchor.u : 0;
    if (anchorChip && hit.region === 'lanes') d.lastDcol = hit.column - anchorChip.column;
    const clamped = clampMove(m, d.keys, du, d.lastDcol || 0);
    d.du = clamped.du;
    d.dcol = clamped.dcol;
    const s = this.session;
    const targets = moveTargets(m, d.keys, { du: d.du, dcol: d.dcol, pens: s.pens, activeTypes: s.activeTypes, keepValue: mods.alt });
    const bpmTargets = moveBpmTargets(m, d.keys, d.du);
    const moving = new Set(d.keys);
    const removeKeys = new Set();
    for (const tgt of targets) {
      for (const c of m.cellChips(tgt.column, tgt.measure, tgt.tick)) {
        if (!c.locked && !moving.has(c.key) && channelsConflict(c.channel, tgt.channel)) removeKeys.add(c.key);
      }
    }
    this.view.state.preview = {
      hide: moving, removeKeys,
      targets: targets.map((tg) => ({ column: tg.column, u: tg.u, channel: tg.channel, value: tg.value, half: 0 })),
      bpm: bpmTargets.map((b) => ({ u: b.u, bpm: b.mark.bpm, channel: b.mark.channel })),
    };
    this._render();
  }

  _finishMove(d, alt) {
    const s = this.session;
    if (!d.du && !d.dcol) {
      this._render();
      return;
    }
    const m = this.model;
    const anchor = m.chip(d.anchor) || m.bpmMark(d.anchor);
    // 元に戻したときの選択: 選択のモードは動かしたもの、ペンのモードは今の選択(ペンは選択を変えない)
    const selectBefore = this.mode === 'select' ? d.keys : [...s.selection];
    const r = this._commit(() => opMove(this.model, d.keys, { du: d.du, dcol: d.dcol, pens: s.pens, activeTypes: s.activeTypes, keepValue: alt }),
      { label: OP.move, selectBefore, focusU: anchor ? anchor.u : undefined });
    if (r && r.removed) this._toast(t('edit.removedConflicts', { n: r.removed }));
  }

  /** 種類を切り替える。fromSel: 選んだものに対して(結果を選んだままにする)。 */
  _setTypes(keys, keepValue = false, fromSel = false) {
    const s = this.session;
    const chips = keys.map((k) => this.model.chip(k)).filter((c) => c && otherType(c.channel) !== null);
    if (!chips.length) return;
    this._commit(() => opSetType(this.model, keys, { pens: s.pens, keepValue }), { label: OP.type, focusU: chips[0].u, keepSel: fromSel });
  }

  _addPartner(key) {
    const c = this.model.chip(key);
    if (!c || otherType(c.channel) === null || channelsConflict(c.channel, otherType(c.channel))) return;
    const r = this._commit(() => opAddPartner(this.model, key, { pens: this.session.pens }), { label: OP.place, focusU: c.u });
    if (r) this._previewSound(otherType(c.channel), this._pen(otherType(c.channel)));
  }

  _headerClick(col, clientX, clientY) {
    if (COLUMN_TYPES[col].length > 1) this._setActiveType(col, 1 - (this.session.activeTypes[col] || 0));
    else this._penMenu(col, clientX, clientY);
  }

  _gutterClick(hit) {
    const geo = this.model.geometry;
    const m = geo.measureAt(hit.u);
    this.follow = false;
    this.view.uHead = geo.start(Math.max(-1, m));
    this._clampHead();
    this._render();
  }

  _setActiveType(col, i) {
    if (COLUMN_TYPES[col].length < 2) return;
    this.session.activeTypes[col] = i;
    this._syncTypes();
    this._hoverGhost();
    this._render();
    this._scheduleDraft();
  }

  // ---- 自動スクロール・慣性 ----

  _checkAutoScroll(clientY) {
    const r = this.canvas.getBoundingClientRect();
    const top = r.top + HEADER_CSS;
    const zone = G.AUTOSCROLL_CSS;
    let v = 0; // u / 秒(上へ = 未来へ +)
    if (clientY < top + zone) v = ((top + zone - clientY) / zone) ** 2 * 3;
    else if (clientY > r.bottom - zone) v = -(((clientY - (r.bottom - zone)) / zone) ** 2) * 3;
    if (!v) {
      this._autoScroll = null;
      return;
    }
    // 動かしている間は速さだけ変える(時計を毎回やり直すと、指やマウスが動いている間スクロールが止まる)
    const nv = Math.min(3, Math.max(-3, v));
    if (this._autoScroll) this._autoScroll.v = nv;
    else this._autoScroll = { v: nv, last: performance.now() };
    this.follow = false;
    this._render();
  }

  _stepAutoScroll(now) {
    const a = this._autoScroll;
    const d = this._drag;
    if (!a || !d) {
      this._autoScroll = null;
      return false;
    }
    const dt = Math.max(0, Math.min(50, now - a.last)) / 1000;
    a.last = Math.max(a.last, now);
    this.view.uHead += a.v * dt;
    this._clampHead();
    if (d.lastX !== undefined) this._dragMove(d.lastX, d.lastY, d.liveMods || d.mods || {});
    this._dirty = true;
    return true;
  }

  _startFling(vCssPerMs) {
    if (Math.abs(vCssPerMs) < G.FLING_MIN_CSS_PER_MS) return;
    this._fling = { v: vCssPerMs / (this.view.s * this.view.ppu), last: performance.now() };
    this._render();
  }

  _stepFling(now) {
    const f = this._fling;
    const dt = Math.min(50, now - f.last);
    f.last = now;
    this.view.uHead += f.v * dt;
    f.v *= G.FLING_FRICTION ** (dt / 16.7);
    this._clampHead();
    this._dirty = true;
    if (Math.abs(f.v) * 1000 < 0.05) {
      this._fling = null;
      return false;
    }
    return true;
  }

  _stopFling() {
    this._fling = null;
  }

  // ---- タッチ ----

  _touchHandlers() {
    return {
      press: (p) => {
        if (this._penBusy) return;
        const hit = this.view.hit(p.clientX, p.clientY);
        if (hit.region === 'lanes' && this.mode === 'pen') this._setGhost(this._target(hit, 'touch'));
      },
      tap: (p) => this._tap(p),
      longPress: (p) => this._longPress(p),
      // 選択のモードで、選んだチップの上から動かしたら移動(それ以外はスクロール)
      dragStart: (p) => {
        if (this.mode !== 'select' || this._penBusy) return false;
        const key = this._keyAt(this.view.hit(p.clientX, p.clientY), 'touch');
        if (!key || !this.session.selection.has(key)) return false;
        this._setGhost(null);
        this._drag = { type: 'move', pointerId: p.pointerId, pointerType: 'touch', anchor: key, keys: this._selKeys(), mods: {} };
        return true;
      },
      liftMove: (p) => {
        const d = this._drag;
        if (!d || (d.type !== 'move' && d.type !== 'band')) return;
        d.lastX = p.clientX;
        d.lastY = p.clientY;
        if (d.type === 'band') {
          d.moved = true;
          this._updateBand(p.clientX, p.clientY);
        } else this._updateMovePreview(this.view.hit(p.clientX, p.clientY), {});
        this._checkAutoScroll(p.clientY);
      },
      liftEnd: (p, moved) => {
        const d = this._drag;
        this._drag = null;
        this._autoScroll = null;
        this.view.state.preview = null;
        this.view.state.band = null;
        this._setGhost(null);
        if (!d) return;
        if (d.type === 'menu') return;
        const hit = this.view.hit(p.clientX, p.clientY);
        if (d.type === 'band') {
          if (!moved) this._contextMenu(p.clientX, p.clientY, hit);
        } else if (moved && d.type === 'move') this._finishMove(d, false);
        else if (this.mode === 'select') this._contextMenu(p.clientX, p.clientY, hit);
        else if (d.chip) this._chipMenu(d.chip, p.clientX, p.clientY);
        this._render();
      },
      scroll: (dy) => {
        if (this._penBusy) return; // ペンで書いている間は手のひらで動かさない
        this.follow = false;
        this.view.uHead += dy / (this.view.s * this.view.ppu);
        this._clampHead();
        this._syncButtons();
        this._render();
      },
      scrollEnd: (v) => { if (!this._penBusy) this._startFling(v); },
      pinch: ({ scale, cy, dy }) => {
        if (this._penBusy) return;
        this.follow = false;
        this._zoomAt(this.view.zoom * scale, cy, false);
        this.view.uHead += dy / (this.view.s * this.view.ppu);
        this._clampHead();
        this._render();
      },
      pinchEnd: () => this._saveZoom(),
      cancel: () => {
        const d = this._drag;
        if (d && d.pointerType && d.pointerType !== 'touch') return; // マウス / ペンの身振りは消さない
        if (d && d.type === 'band') this.session.selection = d.restore || d.keep;
        this._drag = null;
        this._autoScroll = null;
        this.view.state.preview = null;
        this.view.state.band = null;
        this._setGhost(null);
        this._render();
      },
    };
  }

  /** マウス / ペンで操作している途中か(指の身振りで横取りしない。iPad で Pencil を使っている間の手のひら)。 */
  get _penBusy() {
    const d = this._drag;
    return !!(d && d.pointerType && d.pointerType !== 'touch');
  }

  _tap(p) {
    if (this._penBusy) return;
    this._setGhost(null);
    this._closePop();
    const hit = this.view.hit(p.clientX, p.clientY);
    if (hit.region === 'header') {
      if (hit.column >= 0) this._headerClick(hit.column, p.clientX, p.clientY);
      return;
    }
    if (hit.region === 'gutter') {
      this._gutterClick(hit);
      return;
    }
    if (this.mode === 'select') {
      // タップでそのチップを選ぶ / 外す、何もないところで選択を外す
      const key = this._keyAt(hit, 'touch');
      const sel = new Set(this.session.selection);
      if (!key) sel.clear();
      else if (sel.has(key)) sel.delete(key);
      else sel.add(key);
      this.session.selection = sel;
      const c = key && sel.has(key) && sel.size === 1 ? this.model.chip(key) : null;
      if (c) {
        this.session.pens.set(c.channel, c.value);
        this._previewSound(c.channel, c.value);
      }
      this._render();
      return;
    }
    if (hit.region === 'bpm') {
      this._bpmClick(hit.u, 'touch', false);
      return;
    }
    const tg = this._target(hit, 'touch');
    if (tg.kind === 'chip') {
      const r = this._commit(() => opDelete(this.model, [tg.chip.key]), { label: OP.delete, focusU: tg.chip.u });
      if (r) {
        // 「元に戻す」はこの削除がいちばん新しい手のときだけ(あとで置いたものを戻さない)
        const h = this.session.history;
        const entry = h.entries[h.index];
        this._toast(t('edit.deleted'), { label: t('common.undo'), run: () => { if (h.entries[h.index] === entry) this.undo(); } });
      }
    } else if (tg.kind === 'empty' || tg.kind === 'replace') {
      const value = this._pen(tg.ch);
      const r = this._commit(() => opPlace(this.model, { measure: tg.cell.measure, tick: tg.cell.tick, channel: tg.ch, value }), { label: OP.place, focusU: tg.u });
      if (r) this._previewSound(tg.ch, value);
      this.session.selection = new Set();
    } else if (tg.kind === 'locked') this._toast(t('edit.lockedCell'));
    else if (tg.kind === 'limit') this._toast(t('edit.measureLimit'));
  }

  _longPress(p) {
    if (this._penBusy) return;
    const hit = this.view.hit(p.clientX, p.clientY);
    this._setGhost(null);
    const vibrate = () => { if (navigator.vibrate) navigator.vibrate(15); };
    if (hit.region === 'header' && hit.column >= 0) {
      this._drag = { type: 'menu', pointerId: p.pointerId, pointerType: 'touch' };
      this._penMenu(hit.column, p.clientX, p.clientY);
      return;
    }
    if (hit.region === 'gutter') {
      this._drag = { type: 'menu', pointerId: p.pointerId, pointerType: 'touch' };
      vibrate();
      this._measureMenu(hit, p.clientX, p.clientY);
      return;
    }
    if (hit.region === 'bpm' && this.mode === 'pen') {
      this._drag = { type: 'menu', pointerId: p.pointerId, pointerType: 'touch' };
      vibrate();
      this._bpmClick(hit.u, 'touch', false);
      return;
    }
    if (this.mode === 'select' && (hit.region === 'lanes' || hit.region === 'bpm')) {
      vibrate();
      const key = this._keyAt(hit, 'touch');
      if (key) {
        // 持ち上げる(選んでいなければそれだけを選ぶ。動かせば選んだものを移動、動かさずに離せばメニュー)
        if (!this.session.selection.has(key)) this.session.selection = new Set([key]);
        this._drag = { type: 'move', pointerId: p.pointerId, pointerType: 'touch', anchor: key, keys: this._selKeys(), mods: {} };
      } else {
        // 長押しから動かすと範囲選択、動かさずに離すとメニュー
        // keep: 範囲で選ぶときの土台(空 = 置き換え)、restore: やめたときに戻す選択(長押しのメニューは今の選択に効く)
        this._drag = { type: 'band', pointerId: p.pointerId, pointerType: 'touch', x0: p.clientX, y0: p.clientY, u0: hit.u, lx0: hit.x, keep: new Set(), restore: new Set(this.session.selection), moved: false, mods: {} };
      }
      this._render();
      return;
    }
    if (hit.region !== 'lanes') return;
    const tg = this._target(hit, 'touch');
    if (tg.kind === 'chip') {
      // 持ち上げる(動かせば移動、動かさずに離せばメニュー)
      this._drag = { type: 'move', pointerId: p.pointerId, pointerType: 'touch', anchor: tg.chip.key, keys: [tg.chip.key], chip: tg.chip, mods: {} };
      this.view.state.preview = { hide: new Set(), removeKeys: new Set(), targets: [{ column: tg.chip.column, u: tg.chip.u, channel: tg.chip.channel, value: tg.chip.value }] };
      vibrate();
      this._render();
      return;
    }
    if (tg.cell) {
      this._drag = { type: 'menu', pointerId: p.pointerId, pointerType: 'touch' };
      vibrate();
      this._contextMenu(p.clientX, p.clientY, hit);
    }
  }

  // ---- ホイール・拡大 ----

  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const { y } = this.view.toLogical(e.clientX, e.clientY);
      this._zoomAt(this.view.zoom * 1.0015 ** -e.deltaY, y * this.view.s + this.canvas.getBoundingClientRect().top, true);
      return;
    }
    const k = e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? this.view.H * this.view.s : 1;
    this.follow = false;
    this._stopFling();
    this.view.uHead += (-e.deltaY * k) / 400;
    this._clampHead();
    this._syncButtons();
    this._render();
    this._hoverGhost();
  }

  /** 拡大率を変える(clientY の位置の u を動かさない)。 */
  _zoomAt(zoom, clientY, save) {
    const z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], zoom));
    const r = this.canvas.getBoundingClientRect();
    const y = (clientY - r.top) / this.view.s;
    const uA = this.view.uAt(y);
    this.view.zoom = z;
    this.view.uHead = uA - (this.view.headY - y) / this.view.ppu;
    this._clampHead();
    if (save) this._saveZoom();
    this._render();
  }

  _zoomStep(dir) {
    const i = ZOOMS.indexOf(nearestZoom(this.view.zoom));
    const z = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    const r = this.canvas.getBoundingClientRect();
    this._zoomAt(z, r.top + this.view.headY * this.view.s, true);
  }

  _saveZoom() {
    const c = this.config;
    c.editZoom = { ...(c.editZoom || {}), [this.view.layout]: nearestZoom(this.view.zoom) };
    this.app.saveConfig();
  }

  _setGuide(d) {
    if (!GUIDES.includes(d)) return;
    this.view.guide = d;
    $('edit-guide').value = String(d);
    this.config.editGuide = d;
    this.app.saveConfig();
    this._render();
  }

  _guideStep(dir) {
    // [ = 粗く(1/64 → 1/4)、] = 細かく(1/4 → フリー)。DTXCreator の F3 / F4 と同じ並び
    const i = GUIDES.indexOf(this.view.guide);
    this._setGuide(GUIDES[Math.max(0, Math.min(GUIDES.length - 1, i + dir))]);
  }

  // ---- キー ----

  _keyDown(e) {
    if (this.root.hidden) return;
    const tgt = e.target;
    if (tgt && tgt.tagName === 'SELECT' && this.stepArmed && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && this._laneOfCode(e.code) >= 0) {
      // 叩いて入力の間は、パネルの選択欄にフォーカスがあってもレーンのキーは譜面へ(Space で選択欄が開かないように)
      e.preventDefault();
      tgt.blur();
      this.canvas.focus({ preventScroll: true });
      if (!e.repeat) this.onPadHit(this._laneOfCode(e.code), e.timeStamp || performance.now(), 'key');
      return;
    }
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
    if (e.isComposing) return;
    // Space は BD のキーなので、選んでいるボタン(ダイアログ・メニューの決定も)を押させない(CLAUDE.md。決定は Enter)
    if (e.code === 'Space' && tgt && tgt.tagName === 'BUTTON') e.preventDefault();
    const dlg = $('edit-dialog');
    if (dlg.open) return;
    if (!$('edit-help').hidden) {
      if (e.code === 'Escape' || e.key === '?' || e.code === 'Enter') { e.preventDefault(); this._toggleHelp(false); }
      return;
    }
    const pop = $('edit-pop');
    if (!pop.hidden) {
      if (e.code === 'Escape') { e.preventDefault(); this._closePop(); }
      else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { e.preventDefault(); this._popFocus(e.code === 'ArrowDown' ? 1 : -1); }
      else if (e.code === 'Space') e.preventDefault();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey) {
      switch (e.code) {
        case 'KeyZ': e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return;
        case 'KeyY': e.preventDefault(); this.redo(); return;
        case 'KeyS': e.preventDefault(); if (e.shiftKey) this.saveAs(); else this.saveDtx(); return;
        case 'KeyX': e.preventDefault(); this.cut(); return;
        case 'KeyC': e.preventDefault(); this.copy(); return;
        case 'KeyV': e.preventDefault(); this.paste(); return;
        case 'KeyD': e.preventDefault(); this.duplicate(); return;
        case 'KeyA': e.preventDefault(); this.selectAll(); return;
        default: return;
      }
    }
    // 叩いて入力のときは、レーンに割り当てたキー(設定のキー割り当て)が先(Space の BD も)。割り当てていないキーはいつもどおり
    if (this.stepArmed && !e.altKey) {
      const lane = this._laneOfCode(e.code);
      if (lane >= 0) {
        e.preventDefault();
        if (!e.repeat) this.onPadHit(lane, e.timeStamp || performance.now(), 'key');
        return;
      }
    }
    const hasSel = this._selKeys().length > 0;
    switch (e.code) {
      case 'Escape':
        e.preventDefault();
        if (this._drag) this._cancelDrag();
        else if (this.session.selection.size) { this.session.selection = new Set(); this._render(); }
        return;
      case 'Space':
      case 'F1':
        e.preventDefault();
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.deleteSelection();
        return;
      case 'Enter':
      case 'NumpadEnter': {
        // BPM の印を 1 つだけ選んでいれば、その BPM を変える
        const keys = this._selKeys();
        const b = keys.length === 1 ? this.model.bpmMark(keys[0]) : null;
        if (b) {
          e.preventDefault();
          this.editBpm(b);
        }
        return;
      }
      case 'PageUp':
      case 'PageDown': {
        e.preventDefault();
        const geo = this.model.geometry;
        const m = geo.measureAt(this.view.uHead + 1e-9);
        const at = geo.start(m);
        const next = e.code === 'PageUp' ? m + 1 : this.view.uHead > at + 1e-6 ? m : m - 1;
        this._moveHead(geo.start(Math.max(-1, next)));
        return;
      }
      case 'Home':
        e.preventDefault();
        this._moveHead(0);
        return;
      case 'End': {
        e.preventDefault();
        const m = this.model;
        this._moveHead(m.geometry.start(Math.max(0, m.doc.index.maxMeasure) + 1));
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dir = e.code === 'ArrowUp' ? 1 : -1;
        // 選んでいれば選んだものを 1 ガイド(Alt で 1 tick)動かす。無ければ再生位置を 1 ガイド
        if (hasSel) {
          this._nudge(dir, e.altKey);
          return;
        }
        const geo = this.model.geometry;
        const cell = geo.snap(this.view.uHead, 0) || { measure: -1, tick: Math.round((this.view.uHead + 1) * TICKS_PER_MEASURE) };
        const next = geo.step(cell.measure, cell.tick, this.view.guide, dir);
        this._moveHead(geo.u(next.measure, next.tick));
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        if (e.altKey) return; // Alt+← はブラウザの「戻る」
        e.preventDefault();
        if (hasSel) this._shiftColumns(e.code === 'ArrowRight' ? 1 : -1);
        return;
      default:
        break;
    }
    if (e.altKey) {
      if (e.key === 'Alt') e.preventDefault();
      return;
    }
    switch (shortcutKey(e)) {
      case 'e':
        e.preventDefault();
        this._setMode('pen');
        return;
      case 's':
        e.preventDefault();
        this._setMode('select');
        return;
      case 'n':
        e.preventDefault();
        this.nextSuspect();
        return;
      case 'v':
        e.preventDefault();
        this._togglePreview();
        return;
      case 'p':
        e.preventDefault();
        if (e.shiftKey) this.playFromTop();
        else this.togglePlay();
        return;
      case 't':
        e.preventDefault();
        this.testPlay();
        return;
      case 'm':
        e.preventDefault();
        this._toggleOption('editMetronome');
        return;
      case 'r': {
        e.preventDefault();
        // 選んでいるチップ、無ければマウスで指しているチップ
        const sel = this._selKeys().filter((k) => this.model.chip(k));
        if (sel.length) this._setTypes(sel, e.shiftKey, true);
        else {
          const keys = this._hoverChip();
          if (keys.length) this._setTypes(keys, e.shiftKey);
        }
        return;
      }
      case '[':
        e.preventDefault();
        this._guideStep(-1);
        return;
      case ']':
        e.preventDefault();
        this._guideStep(1);
        return;
      case '-':
        e.preventDefault();
        this._zoomStep(-1);
        return;
      case '+':
        e.preventDefault();
        this._zoomStep(1);
        return;
      case '?':
        e.preventDefault();
        this._toggleHelp(true);
        return;
      default:
        break;
    }
    if (e.key === 'Alt') e.preventDefault(); // Windows の Firefox がメニューバーへ移らないように
  }

  _keyUp(e) {
    if (this.root.hidden) return;
    if (e.key === 'Alt') e.preventDefault();
    if (e.code === 'Space' && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
    // Alt / Ctrl を押した・離したら影を描き直す(もう一方の種類・フリー)
    if (this._hover && (e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift')) {
      this._hover.mods = this._mods(e);
      this._hoverGhost();
    }
  }

  /** マウスで指しているチップ(R の対象)。 */
  _hoverChip() {
    if (!this._hover) return [];
    const tg = this._target(this.view.hit(this._hover.clientX, this._hover.clientY), this._hover.pointerType, {});
    return tg.kind === 'chip' ? [tg.chip.key] : [];
  }

  /** メニューの中を ↑↓ で動く。 */
  _popFocus(dir) {
    const btns = [...$('edit-pop').querySelectorAll('button:not(:disabled)')];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement);
    const j = i < 0 ? (dir > 0 ? 0 : btns.length - 1) : (i + dir + btns.length) % btns.length;
    btns[j].focus({ preventScroll: true });
  }

  _moveHead(u) {
    this.follow = false;
    if (this.player && this.player.state !== PLAYER_STATE.STANDBY) this._stopPlay();
    this.view.uHead = u;
    this._clampHead();
    this._syncButtons();
    this._render();
  }

  // ---- 選択・クリップボード(DTXCreator の選択モードとクリップボード。docs/spec/dtxcreator-edit.md §5・§6) ----

  /** 選んだものを消す(Delete / Backspace)。 */
  deleteSelection() {
    const keys = this._selKeys();
    if (!keys.length) return;
    this._commit(() => opDelete(this.model, keys), { label: OP.delete, selectBefore: keys, focusU: this._focusOf(keys) });
  }

  /** 選んだものをコピーする(クリップボードはページの中で 1 つ。別の譜面にも貼れる。DTXCreator と同じ)。 */
  copy() {
    const keys = this._selKeys();
    if (!keys.length) return false;
    const clip = copyClip(this.model, keys);
    if (!clip) return false;
    this.app.editClipboard = clip;
    return true;
  }

  /** 切り取り(コピーして消す。1 手)。 */
  cut() {
    if (!this.copy()) return;
    const keys = this._selKeys();
    this._commit(() => opDelete(this.model, keys), { label: OP.cut, selectBefore: keys, focusU: this._focusOf(keys) });
  }

  /**
   * 貼り付け。貼る位置は、メニューから: メニューを開いたセル、キーから: マウスで指しているセル(レーンの上なら)、
   * 無ければ再生位置(どれもガイドに合わせる)。(変更) DTXCreator はメニューの左上の位置に貼る(§11 Q15)。
   */
  paste(atU) {
    const clip = this.app.editClipboard;
    if (!clip) return;
    let u = atU;
    if (!Number.isFinite(u) && this._hover) {
      const hit = this.view.hit(this._hover.clientX, this._hover.clientY);
      if (hit.region === 'lanes') u = hit.u;
    }
    if (!Number.isFinite(u)) u = this.view.uHead;
    const geo = this.model.geometry;
    const cell = geo.snap(Math.max(0, u), this._snapGuide(false)) || { measure: 0, tick: 0 };
    const u0 = geo.u(cell.measure, cell.tick);
    const r = this._commit(() => opPaste(this.model, clip, { u0, modelOf: (d) => this.session.modelOf(d) }), { label: OP.paste, focusU: u0, keepSel: true });
    if (r) this._reveal(u0);
  }

  /** 選んだものを、選んだ小節の数だけ後ろへ写す(Ctrl+D。本アプリの追加)。 */
  duplicate() {
    const keys = this._selKeys();
    if (!keys.length) return;
    const m = this.model;
    let m0 = Infinity;
    let m1 = -Infinity;
    for (const k of keys) {
      const x = m.chip(k) || m.bpmMark(k);
      m0 = Math.min(m0, x.measure);
      m1 = Math.max(m1, x.measure);
    }
    const focusU = m.geometry.start(Math.min(MAX_MEASURE, m1 + 1));
    const r = this._commit(() => opDuplicate(this.model, keys), { label: OP.duplicate, selectBefore: keys, focusU, keepSel: true });
    if (r) this._reveal(m.geometry.start(Math.min(MAX_MEASURE, m0 + (m1 - m0 + 1))));
  }

  /** すべて選択(選択のモードにする)。 */
  selectAll() {
    const m = this.model;
    this._selectKeys(m.chips.filter((c) => !c.locked).map((c) => c.key).concat(m.bpmMarks.filter((b) => !b.locked).map((b) => b.key)));
  }

  /** レーン(列)の中をすべて選択。 */
  selectLane(col) {
    this._selectKeys((this.model.byColumn[col] || []).filter((c) => !c.locked).map((c) => c.key));
  }

  /** 小節の中をすべて選択(BPM の印も)。 */
  selectMeasure(measure) {
    const m = this.model;
    this._selectKeys(m.chips.filter((c) => !c.locked && c.measure === measure).map((c) => c.key)
      .concat(m.bpmMarks.filter((b) => !b.locked && b.measure === measure).map((b) => b.key)));
  }

  _selectKeys(keys) {
    this.session.selection = new Set(keys);
    this._setMode('select');
  }

  /** 同じ音(#WAV の番号)のチップをすべて選ぶ(DTXCreator の検索の一部。本アプリはこれだけ)。 */
  selectByValue(id) {
    this._selectKeys(this.model.chips.filter((c) => !c.locked && c.value === id).map((c) => c.key));
  }

  /** チップと同じ音のチップをすべて選ぶ。 */
  selectSameSound(key) {
    const c = this.model.chip(key);
    if (c) this.selectByValue(c.value);
  }

  /**
   * 音源を試聴する(鳴っていれば止める。長い BGM も止められるように)。チップがまだ使っていない番号(読み込んでいない)は、
   * ここで読んで鳴らす。
   */
  async previewWav(id) {
    const audio = this.app.audio;
    // 鳴り終わった音は「鳴っている」に数えない(押すたびに止める / 鳴らすが入れ替わらないように)
    if (this._wavVoice && audio.allVoices && !audio.allVoices.has(this._wavVoice)) this._wavVoice = null;
    if (this._wavPending === id) {
      // 読んでいる間にもう一度押した: やめる
      this._wavPending = null;
      this._wavTok = (this._wavTok || 0) + 1;
      return;
    }
    if (this._wavVoice) {
      audio.stopVoice(this._wavVoice);
      const same = this._wavVoice.key === id;
      this._wavVoice = null;
      if (same) return;
    }
    const tok = (this._wavTok = (this._wavTok || 0) + 1);
    this._wavPending = id;
    await audio.ensureContext();
    if (this._closed || tok !== this._wavTok) return;
    const chart = this.model.chart;
    const { volume, pan } = AudioEngine.gainPan(chart, id);
    const opts = { volume: volume * PREVIEW_VOLUME, pan, bus: 'chip', key: id };
    if (audio.hasBuffer(id) && (!audio.bufferFiles || audio.bufferFiles.get(id) === (chart.wavDefs.get(id) || ''))) {
      this._wavPending = null;
      this._wavVoice = audio.play(id, opts);
      return;
    }
    const file = this.model.wavFile(id);
    const ent = file ? this.session.pkg.resolve(chart.dir, file) : null;
    let buf = null;
    try {
      if (ent) buf = await audio.decode(await this.session.pkg.readBytes(ent), ent.name);
    } catch (e) {
      console.warn('音源を読めません:', file, e);
    }
    if (this._closed || tok !== this._wavTok) return;
    this._wavPending = null;
    if (!buf) {
      this._toast(t('edit.wavFailed', { file: file || id }));
      return;
    }
    this._wavVoice = audio.playBuffer(buf, opts);
  }

  /**
   * 音源を足す(本アプリの追加。DTXCreator はフォルダのファイルを選ぶ)。ファイルを曲のフォルダに入れ(曲パックに重ねる。
   * 同じ名前で中身の違うファイルがあれば名前を変える)、空いている番号に #WAV を書く。音は ZIP の書き出し・フォルダへの
   * 上書き保存で一緒に書く(下書きには入らない)。
   */
  async importSound(file) {
    const s = this.session;
    const pkg = s.pkg;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (this._closed) return;
    // ペンの番号も避ける(まだ #WAV の無いペンの番号に音が付くと、その列に置くチップの音が変わる)
    const id = freeWavNumber(this.model, this.session.pens.values());
    if (!id) {
      this._toast(t('edit.wavFull'));
      return;
    }
    const raw = file.name.replace(/[\\/:*?"<>|;\r\n]/g, '_').trim() || 'sound.wav';
    const dot = raw.lastIndexOf('.');
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    const ext = dot > 0 ? raw.slice(dot) : '';
    let name = raw;
    for (let i = 2; i < 1000; i++) {
      const ent = pkg.entry(s.dir + name);
      if (!ent) break;
      const cur = await pkg.readBytes(ent).catch(() => null);
      if (cur && sameBytes(cur, bytes)) break; // 同じ中身のファイルはそのまま使う
      name = `${stem} (${i})${ext}`;
    }
    if (!pkg.entry(s.dir + name)) pkg.setOverride(s.dir + name, bytes);
    const r = this._commit(() => opSetWav(this.model, id, { file: name, label: stem }), { label: 'edit.opWav', keepSel: true, selectBefore: this._selKeys() });
    if (r) {
      this.panel._soundSel = id;
      this._toast(t('edit.wavAdded', { file: name, id }));
    }
  }

  /** 選んだものを 1 ガイド(fine: 1 tick)動かす(↑↓。続けて押すと 1 秒の間は 1 手にまとめる)。値はそのまま。 */
  _nudge(dir, fine) {
    const keys = this._selKeys();
    if (!keys.length) return;
    const m = this.model;
    const geo = m.geometry;
    let a = null;
    for (const k of keys) {
      const x = m.chip(k) || m.bpmMark(k);
      if (x && (!a || x.u < a.u)) a = x;
    }
    const next = geo.step(a.measure, a.tick, fine ? 0 : this.view.guide, dir);
    const du = geo.u(next.measure, next.tick) - a.u;
    if (!du) return;
    const r = this._commit(() => opNudge(this.model, keys, { du }), { label: OP.nudge, selectBefore: keys, focusU: a.u, coalesceKey: 'nudge', keepSel: true });
    if (r) {
      if (r.removed) this._toast(t('edit.removedConflicts', { n: r.removed }));
      this._reveal(a.u + du);
    }
  }

  /** 選んだチップを隣の列へ(←→。移った列の今の種類とペンの音になる)。 */
  _shiftColumns(dir) {
    const keys = this._selKeys();
    if (!keys.some((k) => this.model.chip(k))) return;
    const s = this.session;
    const r = this._commit(() => opMove(this.model, keys, { du: 0, dcol: dir, pens: s.pens, activeTypes: s.activeTypes }),
      { label: OP.move, selectBefore: keys, focusU: this._focusOf(keys), coalesceKey: 'column', keepSel: true });
    if (r && r.removed) this._toast(t('edit.removedConflicts', { n: r.removed }));
  }

  /** u が画面の外なら、そこへ送る。 */
  _reveal(u) {
    const { lo, hi } = this.view.uRange;
    if (u >= lo && u <= hi) return;
    this.follow = false;
    this.view.uHead = u;
    this._clampHead();
    this._render();
  }

  // ---- BPM(DTXCreator の BPM レーン。docs/spec/dtxcreator-edit.md §4.5) ----

  /** BPM レーンを押した: 印の上ならその BPM、無ければガイドに合わせたセルに新しい BPM。 */
  _bpmClick(u, pointerType, free) {
    const b = this._bpmAt(u, pointerType);
    if (b) this.editBpm(b);
    else this._bpmAtCell(u, free);
  }

  /** u のセルの BPM(そこに印があればそれを変える)。 */
  _bpmAtCell(u, free = false) {
    const m = this.model;
    const cell = m.geometry.snap(Math.max(0, u), this._snapGuide(free));
    if (!cell) return;
    if (cell.measure > MAX_MEASURE) {
      this._toast(t('edit.measureLimit'));
      return;
    }
    const mark = m.bpmMarks.find((b) => b.measure === cell.measure && b.tick === cell.tick && (!b.locked || b.active));
    if (mark) this.editBpm(mark);
    else this._bpmDialog(cell.measure, cell.tick, null);
  }

  /** BPM の印を変える / 消す。 */
  editBpm(mark) {
    if (mark.locked) {
      this._toast(t('edit.lockedCell'));
      return;
    }
    this._bpmDialog(mark.measure, mark.tick, mark);
  }

  async _bpmDialog(measure, tick, mark) {
    const m = this.model;
    const cur = mark && mark.bpm !== null ? mark.bpm : m.bpmAtPos(posOf(measure, tick));
    const r = await bpmDialog($('edit-dialog'), { bpm: cur, canDelete: !!mark, headerOption: measure === 0 && tick === 0 && !mark });
    this.canvas.focus({ preventScroll: true });
    if (this._closed) return;
    const focusU = this.model.geometry.u(measure, tick);
    if (r.action === 'delete' && mark) this._commit(() => opDelete(this.model, [mark.key]), { label: OP.bpm, focusU });
    else if (r.action === 'ok') this._commit(() => opSetBpm(this.model, { measure, tick, bpm: r.bpm, header: r.header }), { label: OP.bpm, focusU });
  }

  // ---- 小節(DTXCreator の小節長変更・小節の挿入 / 削除。docs/spec/dtxcreator-edit.md §8) ----

  /** 小節長のダイアログ。 */
  async barLength(measure) {
    if (measure < 0 || measure > MAX_MEASURE) return;
    const m = this.model;
    const r = await barDialog($('edit-dialog'), {
      measure, value: m.geometry.len(measure),
      overflow: (o) => barOverflow(this.model, { measure, ...o }),
    });
    this.canvas.focus({ preventScroll: true });
    if (r.action !== 'ok' || this._closed) return;
    const res = this._commit(() => opBarLength(this.model, { measure, value: r.value, scope: r.scope, keepBeats: r.keepBeats }),
      { label: OP.bar, focusU: this.model.geometry.start(measure) });
    if (res && res.removed) this._toast(t('edit.barRemoved', { n: res.removed }));
  }

  /** 小節 measure の前に空の小節を挿す(押した小節から後ろが 1 小節ずつ後ろへ)。 */
  insertMeasure(measure) {
    if (measure < 0) return;
    const r = this._commit(() => opInsertMeasure(this.model, measure), { label: OP.insertMeasure, focusU: this.model.geometry.start(measure) });
    if (r) this._shiftLoop(measure, 1);
  }

  /** 小節 measure を消して詰める(消えるものがあれば、種類ごとの数を見せて確かめる)。 */
  async deleteMeasure(measure) {
    const m = this.model;
    if (measure < 0) return;
    if (measure > m.doc.index.maxMeasure) {
      this._toast(t('edit.nothingToDelete'));
      return;
    }
    // 先に作ってみる(できないなら確かめる前に知らせる)。ダイアログの間は譜面を変えられないので、作ったものをそのまま使う
    let result;
    try {
      result = opDeleteMeasure(m, measure);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      this._toast(t(ERR[e.code] || 'edit.measureLimit', e.vars));
      return;
    }
    const sum = measureDeleteSummary(m, measure);
    if (sum.drums + sum.bgm + sum.tempo + sum.other + sum.lockedLines > 0) {
      const extra = [];
      if (sum.bgm) extra.push(t('edit.deleteMeasureBgm'));
      if (sum.carriedBpm !== null && sum.carriedBpm !== undefined) extra.push(t('edit.bpmCarry', { bpm: formatBpm(sum.carriedBpm) }));
      const ok = await confirmDialog($('edit-dialog'), t('edit.deleteMeasureConfirm', {
        m: String(measure).padStart(3, '0'), d: sum.drums, b: sum.bgm, t: sum.tempo, o: sum.other, k: sum.lockedLines,
      }), { ok: t('edit.deleteMeasure'), danger: true, extra: extra.join(' ') });
      this.canvas.focus({ preventScroll: true });
      if (!ok || this._closed) return;
    }
    const r = this._commit(() => (this.model === m ? result : opDeleteMeasure(this.model, measure)), { label: OP.deleteMeasure, focusU: m.geometry.start(measure) });
    if (r) this._shiftLoop(measure, -1);
  }

  /**
   * 小節を挿す / 消したとき、演奏画面から持ってきたループの位置もずらす。元に戻す / やり直すで戻せるよう、
   * ずらす前とあとを今の手に書いておく(undo / redo が見る)。
   */
  _shiftLoop(measure, delta) {
    const lp = this.session.loopPos;
    if (!lp) return;
    const at = posOf(measure, 0);
    const T = TICKS_PER_MEASURE;
    const f = (p) => {
      if (delta > 0) return p >= at ? p + T : p;
      if (p >= at + T) return p - T;
      return p >= at ? at : p; // 消した小節の中 → その小節の頭
    };
    const after = { ...lp, beginPos: f(lp.beginPos), endPos: lp.endAtEnd ? lp.endPos : f(lp.endPos) };
    this.session.loopPos = after;
    const h = this.session.history;
    h.entries[h.index].loopShift = { before: lp, after };
  }

  // ---- メニュー(右クリック・長押し) ----

  /** 小節の操作(小節番号の欄・メニュー)。 */
  _measureItems(measure, u) {
    return [
      { label: t('edit.bpmHere'), run: () => this._bpmAtCell(u) },
      { label: t('edit.barLength'), run: () => this.barLength(measure) },
      { label: t('edit.insertMeasure'), run: () => this.insertMeasure(measure) },
      { label: t('edit.deleteMeasure'), danger: true, run: () => this.deleteMeasure(measure) },
    ];
  }

  /** 選択のモードの右クリック・長押しのメニュー(docs/spec/chart-editor.md「メニュー」)。 */
  _contextMenu(x, y, hit) {
    const m = this.model;
    const geo = m.geometry;
    const keys = this._selKeys();
    const has = keys.length > 0;
    const u = hit && Number.isFinite(hit.u) ? Math.max(0, hit.u) : Math.max(0, this.view.uHead);
    const measure = Math.max(0, Math.min(MAX_MEASURE, geo.measureAt(u)));
    const cell = geo.snap(u, this._snapGuide(false));
    const cellU = cell ? geo.u(cell.measure, cell.tick) : u;
    const items = [
      { label: t('edit.cut'), disabled: !has, run: () => this.cut() },
      { label: t('edit.copy'), disabled: !has, run: () => this.copy() },
      { label: t('edit.paste'), disabled: !this.app.editClipboard, run: () => this.paste(u) },
      { label: t('edit.delete'), disabled: !has, danger: true, run: () => this.deleteSelection() },
      { label: t('edit.duplicate'), disabled: !has, run: () => this.duplicate() },
      { sep: true },
      { label: t('edit.selectAll'), run: () => this.selectAll() },
    ];
    if (hit && hit.region === 'lanes' && hit.column >= 0) {
      items.push({ label: t('edit.selectLane', { lane: channelName(this._channel(hit.column, false)) }), run: () => this.selectLane(hit.column) });
    }
    items.push({ label: t('edit.selectMeasure', { m: String(measure).padStart(3, '0') }), run: () => this.selectMeasure(measure) });
    const chips = keys.filter((k) => m.chip(k));
    const flippable = chips.filter((k) => otherType(m.chip(k).channel) !== null);
    items.push({ sep: true });
    items.push({ label: t('edit.typeFlip') + ' (R)', disabled: !flippable.length, run: () => this._setTypes(flippable, false, true) });
    if (chips.length === 1) {
      const c = m.chip(chips[0]);
      const other = otherType(c.channel);
      if (other !== null && !channelsConflict(c.channel, other)) items.push({ label: t('edit.addPartner', { type: channelName(other) }), run: () => this._addPartner(c.key) });
    }
    if (chips.length === 1) items.push({ label: t('edit.selectSameSound'), run: () => this.selectSameSound(chips[0]) });
    items.push({ sep: true }, ...this._measureItems(measure, u), { sep: true });
    items.push({ label: t('edit.playHere'), run: () => { this.view.uHead = cellU; this.play(); } });
    items.push({ label: t('edit.testHere'), run: () => this.testPlay(cellU) });
    if (has) {
      const ms = keys.map((k) => (m.chip(k) || m.bpmMark(k)).measure);
      items.push({ label: t('edit.loopSelection'), run: () => this.loopMeasures(Math.min(...ms), Math.max(...ms)) });
    } else items.push({ label: t('edit.loopMeasure'), run: () => this.loopMeasures(measure, measure) });
    this._popover(items, x, y);
  }

  /** 小節番号の欄の右クリック・長押しのメニュー。 */
  _measureMenu(hit, x, y) {
    const geo = this.model.geometry;
    const measure = geo.measureAt(hit.u);
    if (measure < 0 || measure > MAX_MEASURE) return;
    const head = geo.start(measure);
    this._popover([
      { label: `${t('edit.barMeasure')} ${String(measure).padStart(3, '0')}`, heading: true },
      ...this._measureItems(measure, Math.max(head, hit.u)),
      { sep: true },
      { label: t('edit.selectMeasure', { m: String(measure).padStart(3, '0') }), run: () => this.selectMeasure(measure) },
      { label: t('edit.playHere'), run: () => { this.view.uHead = head; this.play(); } },
      { label: t('edit.loopMeasure'), run: () => this.loopMeasures(measure, measure) },
    ], x, y);
  }

  // ---- vid2dtx の確信度(docs/spec/vid2dtx-edit.md §8) ----

  /** 次の要確認のチップへ(確信度の低い順に回る。最後まで行ったら最初へ。vid2dtx の goto_next_suspect)。 */
  nextSuspect() {
    if (!this.sidecar) return;
    const m = this.model;
    const order = suspectOrder(m, this._suspectMap());
    if (!order.length) {
      this._toast(t('edit.noSuspect'));
      return;
    }
    const last = this._lastSuspect;
    let i = last ? order.findIndex((x) => x.conf > last.conf || (x.conf === last.conf && x.chip.u > last.u + 1e-9)) : 0;
    if (i < 0) i = 0;
    const { chip, conf } = order[i];
    this._lastSuspect = { conf, u: chip.u };
    this._moveHead(chip.u);
    this.session.selection = new Set([chip.key]); // R・Delete ですぐ直せるように
    const s = this.sidecar.get(`${chip.measure}.${chip.tick}.${chip.channel}`);
    this._toast(t('edit.suspectStatus', { i: i + 1, n: order.length, c: conf.toFixed(2) }) + (s && s.why ? '  ' + s.why : ''), null, 5000);
    this._render();
  }

  // ---- 音 ----

  _playerConfig() {
    const c = this.config;
    return {
      chipVolume: 1.0, autoChipVolume: 0.8, hhGroup: c.hhGroup, ftGroup: c.ftGroup, cyGroup: c.cyGroup, bdGroup: c.bdGroup,
      hitRanges: HitRanges.default, pedalHitRanges: HitRanges.default,
    };
  }

  /** 置いたチップの音(DTXCreator の PlaySoundOnWAVChipAllocated。既定 ON)。 */
  _previewSound(channel, value) {
    if (this.config.editPreviewSound === false) return;
    const audio = this.app.audio;
    if (!audio.ctx) return;
    const chart = this.model.chart;
    const { volume, pan } = AudioEngine.gainPan(chart, value);
    if (audio.hasBuffer(value)) audio.play(value, { volume: volume * PREVIEW_VOLUME, pan, bus: 'chip' });
    else {
      const lane = laneOfChannel(channel);
      const buf = lane >= 0 ? audio.synthBuffer(lane) : null;
      if (buf) audio.playBuffer(buf, { volume: PREVIEW_VOLUME, key: 'synth' + lane, bus: 'chip' });
    }
  }

  /** 譜面が使う音を読む(新しい番号のファイルだけ復号する)。 */
  async _loadSounds(keepVoices) {
    if (this._closed) return;
    // 読み込み中にまた頼まれたら、終わってから 1 回だけ読み直す(長い BGM を並べて何度も復号しない)
    if (this._soundLoading) {
      this._soundAgain = true;
      return;
    }
    const chart = this.model.chart;
    const ids = requiredWavIds(chart);
    const audio = this.app.audio;
    // 足りない番号・#WAV のファイルを変えた番号があるときだけ読む(読んだことのあるファイルは復号し直さない)
    const files = audio.bufferFiles;
    if (keepVoices && ids.every((id) => audio.buffers.has(id) && (!files || files.get(id) === (chart.wavDefs.get(id) || '')))) return;
    const doc = this.model.doc;
    this._soundLoading = true;
    this._soundInfo = t('load.sounds', { done: 0, total: ids.length });
    this._render();
    try {
      await audio.loadChartSounds(this.session.pkg, chart, (done, total) => {
        if (this._closed) return;
        this._soundInfo = t('load.sounds', { done, total });
        this._render();
      }, { keepVoices });
    } catch (e) {
      console.warn('音源の読み込みに失敗:', e);
    } finally {
      this._soundLoading = false;
    }
    if (this._closed) return;
    this._soundInfo = audio.failed.length ? t('load.soundsFailed', { n: audio.failed.length }) : '';
    this._loadedFor = doc;
    if (this.player && this.player.state === PLAYER_STATE.STANDBY) this._playerDoc = null; // BGM の長さで止まる位置が変わる
    this._render();
    if (this._soundAgain) {
      this._soundAgain = false;
      this._loadSounds(true);
    }
  }

  /** 鳴らすときの譜面と範囲(文書が変わっていれば差し替える。演奏中には差し替えない)。 */
  _preparePlayer() {
    const p = this.player;
    const m = this.model;
    if (this._playerDoc === m.doc) return;
    const chart = m.chart;
    p.setChart(this.session.pkg, chart);
    const audio = this.app.audio;
    let bgmEnd = 0;
    for (const ev of chart.bgmEvents) {
      const b = audio.buffers.get(ev.wavId);
      if (b) bgmEnd = Math.max(bgmEnd, ev.timeMs + b.duration * 1000);
    }
    const lastData = posToMs(chart, posOf(Math.max(0, m.doc.index.maxMeasure) + 1, 0));
    p.setRange({ startMaxMs: posToMs(chart, posOf(m.endMeasure + 1, 0)), stopAtMs: Math.max(chart.durationMs, lastData, bgmEnd) });
    this._playerDoc = m.doc;
  }

  _applyPlayOptions() {
    const p = this.player;
    if (!p) return;
    const c = this.config;
    const s = p.settings;
    s.metronomeVolume = c.editMetronome ? 60 : 0;
    // ハイスピードはトレーニングの設定のもの(プレビューを演奏画面と同じ速さで流す。読むだけで保存はしない)
    if (this.app.training) s.scrollSpeedTenth = this.app.training.scrollSpeedTenth;
    s.autoPlay = c.editDrumSound !== false;
    s.playSpeed = SPEEDS.includes(c.editSpeed) ? c.editSpeed : 20;
    // 録音(叩いて入力)の時刻は演奏と同じく判定タイミング調整を足す(トレーニングの設定から読むだけ。保存はしない)
    s.judgeOffsetMs = this.app.training ? this.app.training.judgeOffsetMs | 0 : 0;
    const lr = this._loopRange;
    s.loop = !!lr;
    if (lr) {
      s.loopBeginMs = lr.beginMs;
      s.loopEndMs = lr.endMs;
    }
  }

  togglePlay() {
    if (this.player && this.player.state !== PLAYER_STATE.STANDBY) this._stopPlay();
    else this.play();
  }

  /**
   * 小節 m0〜m1 を繰り返し鳴らす(本アプリの追加。演奏画面のループと同じく、折り返すと 1 小節前から)。止めると繰り返しも終わる。
   */
  loopMeasures(m0, m1) {
    const p = this.player;
    if (!p || this._closed) return;
    this._stopPlay();
    this._closePop();
    this._preparePlayer();
    const chart = this.model.chart;
    const beginMs = posToMs(chart, posOf(m0, 0));
    const endMs = posToMs(chart, posOf(m1 + 1, 0));
    if (!(endMs > beginMs)) return;
    this._loopRange = { m0, m1, beginMs, endMs };
    this._applyPlayOptions();
    this.follow = true;
    p.startTrainingAt(beginMs);
    this.app.requestWakeLock();
    this._syncButtons();
    this._render();
  }

  /** 再生位置から鳴らす(DTXCreator の「現在の位置から再生」)。 */
  play() {
    const p = this.player;
    if (!p || this._closed) return;
    this._closePop();
    this._loopRange = null;
    this._preparePlayer();
    this._applyPlayOptions();
    const geo = this.model.geometry;
    const ms = Math.max(0, posToMs(this.model.chart, geo.posOfU(Math.max(-1, this.view.uHead))));
    this.follow = true;
    p.startTrainingAt(ms);
    this.app.requestWakeLock();
    this._syncButtons();
    this._render();
  }

  /** 先頭(リードイン)から鳴らす。 */
  playFromTop() {
    this.view.uHead = -1;
    this.play();
  }

  _stopPlay() {
    const p = this.player;
    if (!p || p.state === PLAYER_STATE.STANDBY) return;
    // (変更) 止めた位置にとどまる(演奏画面の停止は開始位置へ戻る。DTXCreator の「現在の位置」と同じ考え)
    p.enterStandby(false, p.songMs);
    this._commitRecorded();
    if (this._loopRange) {
      this._loopRange = null;
      this._applyPlayOptions();
    }
    this.app.releaseWakeLock();
    this._syncButtons();
    this._render();
  }

  /**
   * 打鍵(キー・MIDI・タッチ)。いつもは試し聞きと列の光だけ。「叩いて入力」のときは、止まっていれば再生位置に置き、
   * 再生中なら録音する(本アプリの追加。docs/spec/chart-editor.md「叩いて入力」)。
   */
  onPadHit(lane, ts, src) {
    const ch = padChannel(lane, src, this.session.activeTypes);
    if (ch === null) return;
    const value = this._pen(ch);
    this._previewSound(ch, value);
    const col = COLUMN_TYPES.findIndex((tt) => tt.includes(ch));
    if (col >= 0) {
      this.view.state.flash.set(col, performance.now() + 150);
      this._render();
    }
    if (!this.stepArmed || this._closed) return;
    const p = this.player;
    if (p && p.state === PLAYER_STATE.PLAYING) this._recordHit(ch, value, Number.isFinite(ts) ? ts : performance.now());
    else if (!p || p.state === PLAYER_STATE.STANDBY) this._stepHit(ch, value);
  }

  /** 「叩いて入力」を入れる / 切る(切ると、録音しかけのチップと和音を 1 手にする)。 */
  _toggleStep(on = !this.stepArmed) {
    if (!on) this._stopStep();
    this.stepArmed = on;
    this._syncButtons();
    this._toast(t(on ? 'edit.stepOn' : 'edit.stepOff'));
  }

  /** キーのコードのレーン(設定のキー割り当て。無ければ -1)。 */
  _laneOfCode(code) {
    const b = this.config.bindings || [];
    for (let lane = 0; lane < b.length; lane++) if (b[lane] && b[lane].includes(code)) return lane;
    return -1;
  }

  /**
   * 止まっているときの打鍵: 再生位置のセル(ガイドに合わせる)にペンの音で置く。続けて 60 ms の間に叩いたものは同じセルに
   * 置いて 1 手(和音)。閉じたら 1 ガイド進む(⋯ の「叩いたら進む」)。同じチャンネルのチップがあれば鳴らすだけ。
   */
  _stepHit(ch, value) {
    const geo = this.model.geometry;
    if (!this._chord) {
      const cell = geo.snap(Math.max(0, this.view.uHead), this._snapGuide(false)) || { measure: 0, tick: 0 };
      if (cell.measure > MAX_MEASURE) {
        this._toast(t('edit.measureLimit'));
        return;
      }
      this._chord = { cell, cells: [], timer: setTimeout(() => this._closeChord(), STEP_CHORD_MS) };
    }
    const c = this._chord;
    if (!c.cells.some((x) => x.channel === ch)) c.cells.push({ measure: c.cell.measure, tick: c.cell.tick, channel: ch, value });
    this.view.state.pending = c.cells.map((x) => ({ column: COLUMN_TYPES.findIndex((tt) => tt.includes(x.channel)), u: geo.u(x.measure, x.tick), channel: x.channel }));
    this._render();
  }

  _closeChord() {
    const c = this._chord;
    if (!c) return;
    this._chord = null;
    clearTimeout(c.timer);
    if (!this._recorded.length) this.view.state.pending = null;
    if (!c.cells.length) return;
    const geo = this.model.geometry;
    this._commit(() => opPaint(this.model, c.cells), { label: OP.place, focusU: geo.u(c.cell.measure, c.cell.tick) });
    if (this.config.editStepAdvance !== false && !this._closed) {
      const next = geo.step(c.cell.measure, c.cell.tick, this.view.guide || 16, 1);
      this.follow = false;
      this.view.uHead = geo.u(next.measure, next.tick);
      this._clampHead();
    }
    this._render();
  }

  /** 再生中の打鍵: 叩いた譜面時刻(演奏の判定と同じ式)のセルに録音する。止めたときに 1 手。 */
  _recordHit(ch, value, ts) {
    const p = this.player;
    const songIn = p.songAt(Math.min(p.realFromPerf(ts), p.nowReal())) + p._w(p.judgeOffsetMs);
    const geo = this.model.geometry;
    const u = geo.uOfPos(msToPos(p.chart, songIn));
    const d = this._snapGuide(false);
    if (u < -0.5 / (d || TICKS_PER_MEASURE)) return; // リードインで叩いたものは置かない(小節 000 の頭に寄せない)
    const cell = geo.snap(Math.max(0, u), d);
    if (!cell || cell.measure > MAX_MEASURE) return;
    if (this._recorded.some((x) => x.measure === cell.measure && x.tick === cell.tick && x.channel === ch)) return;
    this._recorded.push({ measure: cell.measure, tick: cell.tick, channel: ch, value });
    this.view.state.pending = this._recorded.map((x) => ({ column: COLUMN_TYPES.findIndex((tt) => tt.includes(x.channel)), u: geo.u(x.measure, x.tick), channel: x.channel }));
    this._render();
  }

  /** 録音したチップを 1 手にする(止めたとき)。 */
  _commitRecorded() {
    const cells = this._recorded;
    this._recorded = [];
    if (!this._chord) this.view.state.pending = null;
    if (!cells.length) return;
    const r = this._commit(() => opPaint(this.model, cells), { label: 'edit.record', focusU: this.model.geometry.u(cells[0].measure, cells[0].tick) });
    if (r) this._toast(t('edit.recorded', { n: r.select.length }));
  }

  /** 叩いて入力の途中のものを片付ける(和音を閉じ、録音を 1 手にする)。 */
  _stopStep() {
    this._closeChord();
    this._commitRecorded();
  }

  // ---- テストプレイ・保存 ----

  /** 再生位置の 1 小節前から、本物の演奏画面で演奏する(戻ると止めた位置に来る)。 */
  async testPlay(u = this.view.uHead) {
    const m = this.model;
    const geo = m.geometry;
    const measure = Math.max(0, geo.measureAt(Math.max(0, u)) - 1);
    const startAtMs = posToMs(m.chart, posOf(measure, 0));
    await this.app.startTestPlay(this.session, startAtMs);
  }

  /**
   * 保存(Ctrl+S)。「名前を付けて保存」で選んだファイルがあればそこへ上書き、無ければ .dtx をダウンロードする。
   */
  async saveDtx() {
    const s = this.session;
    if (!s.fileHandle && s.pkg.writable) {
      // 上書きは 1 つずつ(続けて押しても、あとの方が新しい中身を書く)
      this._saveQ = (this._saveQ || Promise.resolve()).then(() => this.saveInPlace());
      await this._saveQ;
      return;
    }
    const doc = s.doc;
    const r = s.outputBytes();
    let name = baseName(s.path);
    if (s.fileHandle) {
      try {
        await writeHandle(s.fileHandle, r.bytes);
        name = s.fileHandle.name || name;
      } catch (e) {
        // 選んだファイルに書けなかった(動かした・消した・許可を取り消した)。ダウンロードにして、そう知らせる
        console.warn('選んだファイルに上書きできません(ダウンロードにします):', e);
        const picked = s.fileHandle.name || name;
        s.fileHandle = null;
        downloadBytes(r.bytes, name);
        s.history.markExported(doc);
        this._toast(t('edit.overwriteFailed', { file: picked, name }), null, 8000);
        this._syncButtons();
        return;
      }
    } else downloadBytes(r.bytes, name);
    this._saved(r, name, doc);
  }

  /** .dtx をダウンロードする(上書きできる曲パックでも、ファイルとして欲しいとき)。 */
  downloadDtx() {
    const s = this.session;
    const doc = s.doc;
    const r = s.outputBytes();
    const name = baseName(s.path);
    downloadBytes(r.bytes, name);
    this._saved(r, name, doc);
  }

  /**
   * 「フォルダを開く(上書き保存できる)」で開いた曲パックの譜面を、そのフォルダのファイルへ上書きする(本アプリの追加)。
   * この画面で初めて上書きする前に、元のファイルを <名前>.bak に写す(.bak が既にあれば触らない。vid2dtx と同じ)。
   * 足した音源(曲パックに重ねたファイル)も書く。書けなければダウンロードにして知らせる。
   */
  async saveInPlace() {
    const s = this.session;
    const arch = s.pkg.zip;
    const doc = s.doc;
    const r = s.outputBytes();
    const name = baseName(s.path);
    try {
      if (!(await arch.ensureWritable())) throw new Error('permission denied');
      if (!s.isNew && !s._bakDone) {
        const bak = s.path + '.bak';
        if (!arch.has(bak)) await arch.writeFile(bak, s.originalBytes);
        s._bakDone = true;
      }
      for (const f of s.pkg.addedFiles()) {
        if (!/\.(dtx|gda|g2d|bms|bme)$/i.test(f.path) && !arch.has(f.path)) s.pkg.adoptWritten(f.path, await arch.writeFile(f.path, f.bytes));
      }
      // 書いたファイルを曲パックの中身にする(新しい難易度も、重ねたものを外したあと一覧・演奏から読める)
      s.pkg.adoptWritten(s.path, await arch.writeFile(s.path, r.bytes));
      s.diskBytes = r.bytes;
      await deleteDraft(s.pkg, s.path); // ファイルにしたので下書きは要らない
    } catch (e) {
      console.warn('フォルダへ上書きできません(ダウンロードにします):', e);
      downloadBytes(r.bytes, name);
      s.history.markExported(doc);
      this._toast(t('edit.overwriteFailed', { file: name, name }), null, 8000);
      this._syncButtons();
      return;
    }
    if (this._closed) return;
    s.history.markExported(doc);
    const ch = s.encodingChoice;
    const fellBack = r.changedEncoding && r.encoding === 'utf-8' && !(ch && ch.encoding === 'utf-8');
    this._toast(fellBack ? t('edit.savedUtf8') : t('edit.savedInPlace', { name }), null, fellBack ? 8000 : 3000);
    this._syncButtons();
  }

  /** 名前を付けて保存(Ctrl+Shift+S。Chromium だけ。ほかのブラウザはダウンロード)。次の Ctrl+S は同じファイルへ上書きする。 */
  async saveAs() {
    if (!canSaveAs()) {
      await this.saveDtx();
      return;
    }
    const s = this.session;
    const doc = s.doc;
    const r = s.outputBytes();
    let h;
    try {
      h = await saveAsFile(r.bytes, baseName(s.path));
    } catch (e) {
      console.warn('名前を付けて保存できません:', e);
      this._toast(t('edit.saveFailed'));
      return;
    }
    if (!h) return;
    s.fileHandle = h;
    this._saved(r, h.name || baseName(s.path), doc);
  }

  _saved(r, name, doc) {
    this.session.history.markExported(doc);
    // Shift-JIS で書けずに UTF-8 になったときだけ知らせる(文字コードを選んで変えたときは普通の「保存しました」)
    const ch = this.session.encodingChoice;
    const fellBack = r.changedEncoding && r.encoding === 'utf-8' && !(ch && ch.encoding === 'utf-8');
    this._toast(fellBack ? t('edit.savedUtf8') : t('edit.saved', { name }), null, fellBack ? 8000 : 3000);
    this._syncButtons();
  }

  /** 書き出す文字コード(⋯ の「文字コード」)。Shift-JIS で書けない文字があれば変えない。 */
  _setEncoding(choice) {
    const s = this.session;
    const prev = s.encodingChoice;
    s.encodingChoice = choice;
    if (!s.outputBytes().ok) {
      s.encodingChoice = prev;
      this._toast(t('edit.encFailed'));
    }
  }

  async _share() {
    const s = this.session;
    const bytes = s.outputBytes().bytes;
    if (await shareFile(bytes, baseName(s.path))) s.history.markExported();
  }

  async _discard() {
    const ok = await confirmDialog($('edit-dialog'), t('edit.discardConfirm'), { ok: t('edit.discardOk'), danger: true });
    if (!ok) return;
    const s = this.session;
    s.history.reset(s.originalDoc);
    s.selection = new Set();
    await deleteDraft(s.pkg, s.path);
    this._afterDocChange();
    this._render();
  }

  // ---- メニュー・お知らせ ----

  _moreMenu() {
    const c = this.config;
    const s = this.session;
    const bytes = s.outputBytes().bytes;
    const items = s.pkg.writable
      ? [{ label: t('edit.saveInPlace'), run: () => this.saveDtx() }, { label: t('edit.saveDtx'), run: () => this.downloadDtx() }]
      : [{ label: t('edit.saveDtx'), run: () => this.saveDtx() }];
    if (canSaveAs()) items.push({ label: t('edit.saveAs'), run: () => this.saveAs() });
    if (canShareFile(bytes, baseName(s.path))) items.push({ label: t('edit.share'), run: () => this._share() });
    const fromFolder = !(s.pkg.zip && s.pkg.zip.blob);
    const zip = (onlyDir) => {
      if (fromFolder) this._toast(t('edit.folderZipNote'), null, 5000); // フォルダの曲パックは全部のファイルを読み直す
      this.app.exportEditedZip({ onlyDir });
    };
    if (s.dir) items.push({ label: t('edit.saveZipSong'), run: () => zip(s.dir) });
    items.push({ label: t('edit.saveZipPack'), run: () => zip('') });
    // 文字コード((追加) DTXCreator は Shift-JIS だけ。UTF-8 は BOM 付きで書く。NX が見分けられるので)
    const enc = s.encodingChoice ? s.encodingChoice.encoding : null;
    const info = s.originalDoc.info;
    items.push({ label: t('edit.encoding'), heading: true });
    items.push({ label: `${t('edit.encKeep')} (${info.encoding === 'shift_jis' || info.encoding === 'ascii' ? 'Shift-JIS' : info.encoding.toUpperCase()}${info.bom ? ' BOM' : ''})`, checked: !enc, run: () => this._setEncoding(null) });
    items.push({ label: t('edit.encSjis'), checked: enc === 'shift_jis', run: () => this._setEncoding({ encoding: 'shift_jis', bom: false }) });
    items.push({ label: t('edit.encUtf8'), checked: enc === 'utf-8', run: () => this._setEncoding({ encoding: 'utf-8', bom: true }) });
    items.push({ sep: true });
    items.push({ label: t('edit.playTop'), run: () => this.playFromTop() });
    items.push({ label: t('edit.metronome'), checked: !!c.editMetronome, run: () => this._toggleOption('editMetronome') });
    items.push({ label: t('edit.drumSound'), checked: c.editDrumSound !== false, run: () => this._toggleOption('editDrumSound') });
    for (const sp of SPEEDS) {
      items.push({ label: `${t('edit.speed')} x${(sp / 20).toFixed(2)}`, checked: (SPEEDS.includes(c.editSpeed) ? c.editSpeed : 20) === sp, run: () => { c.editSpeed = sp; this.app.saveConfig(); this._applyPlayOptions(); } });
    }
    items.push({ sep: true });
    items.push({ label: t('edit.showIds'), checked: !!c.editShowIds, run: () => this._toggleOption('editShowIds') });
    items.push({ label: t('edit.previewSound'), checked: c.editPreviewSound !== false, run: () => this._toggleOption('editPreviewSound') });
    if (this.sidecar) items.push({ label: t('edit.confidence'), checked: c.editConfidence !== false, run: () => this._toggleOption('editConfidence') });
    if (this.model.doc.index.lockedObjects) items.push({ label: t('edit.otherBranches'), checked: !!c.editOtherBranches, run: () => this._toggleOption('editOtherBranches') });
    items.push({ label: t('edit.stepAdvance'), checked: c.editStepAdvance !== false, run: () => this._toggleOption('editStepAdvance') });
    items.push({ label: t('edit.help'), run: () => this._toggleHelp(true) });
    items.push({ sep: true });
    items.push({ label: t('edit.discard'), danger: true, disabled: !s.modified, run: () => this._discard() });
    const r = $('edit-more').getBoundingClientRect();
    this._popover(items, r.right, r.bottom, { alignRight: true });
  }

  _toggleOption(key) {
    const c = this.config;
    const def = key === 'editDrumSound' || key === 'editPreviewSound' || key === 'editConfidence' || key === 'editStepAdvance';
    const cur = def ? c[key] !== false : !!c[key];
    c[key] = !cur;
    this.app.saveConfig();
    this._applyPlayOptions();
    if (key === 'editMetronome') this._toast(t('edit.metronome') + (c[key] ? ' ON' : ' OFF'));
    this._render();
  }

  /** チップのメニュー(タッチの長押し)。 */
  _chipMenu(chip, x, y) {
    const items = [];
    const other = otherType(chip.channel);
    if (other !== null) items.push({ label: t('edit.typeFlip') + ` (${channelName(other)})`, run: () => this._setTypes([chip.key]) });
    if (other !== null && !channelsConflict(chip.channel, other)) {
      items.push({ label: t('edit.addPartner', { type: channelName(other) }), run: () => this._addPartner(chip.key) });
    }
    items.push({ label: t('edit.pen') + '…', run: () => this._soundMenu(chip.channel, x, y, chip) });
    items.push({
      label: t('edit.copy'),
      run: () => {
        const clip = copyClip(this.model, [chip.key]);
        if (clip) this.app.editClipboard = clip;
      },
    });
    items.push({ label: t('edit.modeSelect'), run: () => this._selectKeys([chip.key]) });
    items.push({ label: t('edit.delete'), danger: true, run: () => this._commit(() => opDelete(this.model, [chip.key]), { label: OP.delete, focusU: chip.u }) });
    this._popover(items, x, y);
  }

  /** 列の音(ペン)を選ぶ。chip を渡すとそのチップの音も変える。 */
  _penMenu(col, x, y) {
    const ch = this._channel(col, false);
    this._soundMenu(ch, x, y, null);
  }

  _soundMenu(ch, x, y, chip) {
    const m = this.model;
    const counts = m.valueCounts.get(ch) || new Map();
    const pen = this.session.pens.get(ch);
    const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    for (const w of m.wavList) if (!ids.includes(w.id)) ids.push(w.id);
    if (pen && !ids.includes(pen)) ids.unshift(pen);
    const items = [{ label: `${channelName(ch)} — ${t('edit.pen')}`, heading: true }];
    for (const id of ids.slice(0, 40)) {
      const file = m.wavFile(id);
      const n = counts.get(id);
      items.push({
        label: `${id}  ${file ? baseName(file.replace(/\\/g, '/')) : '?'}${n ? ' ×' + n : ''}`,
        checked: id === pen,
        run: () => {
          this.session.pens.set(ch, id);
          this._previewSound(ch, id);
          if (chip) this._commit(() => opSetValue(this.model, [chip.key], id), { label: OP.sound, focusU: chip.u });
          this._scheduleDraft();
          this._render();
        },
      });
    }
    this._popover(items, x, y);
  }

  /**
   * ポップオーバー(メニュー)。items: {label, run, checked?, disabled?, danger?, sep?, heading?}
   */
  _popover(items, clientX, clientY, { alignRight = false } = {}) {
    const pop = $('edit-pop');
    pop.innerHTML = '';
    for (const it of items) {
      if (it.sep) {
        pop.appendChild(document.createElement('hr'));
        continue;
      }
      if (it.heading) {
        const h = document.createElement('div');
        h.className = 'pop-head';
        h.textContent = it.label;
        pop.appendChild(h);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (it.checked ? '✓ ' : '') + it.label;
      b.disabled = !!it.disabled;
      if (it.danger) b.classList.add('danger');
      b.onclick = () => {
        this._closePop();
        it.run();
      };
      pop.appendChild(b);
    }
    pop.hidden = false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, alignRight ? clientX - w : clientX - w / 2));
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, clientY + 6));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    const first = pop.querySelector('button:not(:disabled)');
    if (first && !document.body.classList.contains('touch')) first.focus({ preventScroll: true });
  }

  _closePop() {
    const pop = $('edit-pop');
    if (pop.hidden) return;
    pop.hidden = true;
    pop.innerHTML = '';
    this.canvas.focus({ preventScroll: true });
  }

  /**
   * お知らせ(3 秒で消える)。action = {label, run}(元に戻すなど)。
   */
  _toast(text, action = null, ms = 3000) {
    const el = $('edit-toast');
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small secondary';
      b.textContent = action.label;
      b.onclick = () => {
        el.hidden = true;
        action.run();
      };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  _toggleHelp(show) {
    const el = $('edit-help');
    if (!show) {
      el.hidden = true;
      this.canvas.focus({ preventScroll: true });
      return;
    }
    const rows = [
      ['Ctrl+Z / Ctrl+Y', t('common.undo') + ' / ' + t('edit.redo')],
      ['Ctrl+S', t('edit.saveDtx')],
      ['Ctrl+Shift+S', t('edit.saveAs')],
      ['E / S', t('edit.modePen') + ' / ' + t('edit.modeSelect')],
      ['[ / ]', t('edit.helpGuide')],
      ['- / +', t('edit.helpZoom')],
      ['PageUp / PageDown', t('edit.helpMeasure')],
      ['Home / End', t('edit.helpEnds')],
      ['↑ / ↓', t('edit.helpCursor')],
      ['↑ / ↓  Alt+↑ / ↓', t('edit.helpNudge')],
      ['← / →', t('edit.helpColumn')],
      ['Ctrl+X / C / V', t('edit.cut') + ' / ' + t('edit.copy') + ' / ' + t('edit.paste')],
      ['Ctrl+D', t('edit.duplicate')],
      ['Ctrl+A', t('edit.selectAll')],
      ['Delete', t('edit.delete')],
      ['P / Shift+P', t('edit.playStop') + ' / ' + t('edit.playTop')],
      ['T', t('edit.testPlay')],
      ['M', t('edit.metronome')],
      ['R', t('edit.typeFlip')],
      ['N', t('edit.nextSuspect')],
      [t('edit.stepInput'), t('edit.helpStep')],
      ['V', t('edit.preview')],
      ['Alt', t('edit.helpAltClick')],
      ['Shift', t('edit.helpShiftClick')],
      [t('edit.rightClick'), t('edit.helpRightClick')],
      ['Ctrl', t('edit.helpCtrlDrag')],
      [t('edit.modeSelect'), t('edit.helpBand')],
      ['Esc', t('edit.helpEsc')],
    ];
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'box';
    const h = document.createElement('h3');
    h.textContent = t('edit.help');
    box.appendChild(h);
    const tbl = document.createElement('table');
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const a = document.createElement('th');
      a.textContent = k;
      const b = document.createElement('td');
      b.textContent = v;
      tr.append(a, b);
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn small';
    close.textContent = t('edit.close');
    close.onclick = () => this._toggleHelp(false);
    box.appendChild(close);
    el.appendChild(box);
    el.hidden = false;
    el.onclick = (e) => { if (e.target === el) this._toggleHelp(false); };
    close.focus();
  }
}
