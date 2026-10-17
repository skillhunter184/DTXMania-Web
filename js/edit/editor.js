// 譜面の編集画面(#screen-edit)。描画は js/edit/view.js、編集の操作は js/edit/ops.js、履歴は js/edit/session.js。
//
// 操作は DTXCreator の編集モード(docs/spec/dtxcreator-edit.md §4)と vid2dtx のプレビュー(docs/spec/vid2dtx-edit.md §4)を
// 合わせたもの。違うところは docs/spec/chart-editor.md の一覧。ここでは:
// - マウス / ペン: 空いたところを押すと置く(そのままドラッグで同じ列に塗る)。チップを押して離すと消す、ドラッグで動かす。
//   Alt+クリックで列のもう一方の種類、Shift+クリックで LP / CY の列に相方を並べる。右クリック / 右ドラッグで消す
// - タッチ: タップで置く / 消す、1 本指のドラッグはスクロール、長押しで持ち上げて動かす(動かさずに離すとメニュー)、2 本指で拡大縮小
// - キー: Ctrl+Z / Ctrl+Y・Ctrl+S・[ ]・- +・PageUp / PageDown・Home / End・↑↓・R・P・T・M・?・Esc(画面からは出ない)
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
  EditError, opPlace, opPaint, opDelete, opErase, opMove, opSetType, opSetValue, opAddPartner, moveTargets, clampMove,
} from './ops.js';
import { EditView, HEADER_CSS } from './view.js';
import { TouchGestures, G } from './gestures.js';
import { EditorPlayer } from './editplayer.js';
import { saveDraft, deleteDraft } from './drafts.js';
import { downloadBytes, canShareFile, shareFile, baseName } from './save.js';
import { confirmDialog } from './dialogs.js';

const $ = (id) => document.getElementById(id);

/** EditError の code → 文言のキー(i18n のテストが文言を見つけられるよう、キーはそのまま書く)。 */
const ERR = {
  measureLimit: 'edit.measureLimit',
  locked: 'edit.lockedCell',
  leadIn: 'edit.measureLimit',
};

/** 操作の名前(元に戻す・やり直すのお知らせ)。 */
const OP = {
  place: 'edit.opPlace',
  delete: 'edit.opDelete',
  move: 'edit.opMove',
  type: 'edit.opType',
  sound: 'edit.opSound',
};

const PREVIEW_VOLUME = 0.9;
const DRAFT_DEBOUNCE_MS = 1500;
const SPEEDS = [10, 15, 20, 25, 30]; // 再生速度(playSpeed。20 = x1.0。DTXCreator の x0.5〜x1.5)

/** 1 文字のショートカット(キーボードの配列・IME に左右されないよう e.code で見る)。 */
const KEY_OF_CODE = {
  KeyE: 'e', KeyP: 'p', KeyT: 't', KeyM: 'm', KeyR: 'r', KeyN: 'n',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '+', NumpadSubtract: '-', NumpadAdd: '+', Slash: '/',
};

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
    this.touch = new TouchGestures(this._touchHandlers());
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
    this._syncButtons();
    this._showBanners();
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
    await this.flushDraft();
    await this.session.commit();
    if (this.player) this.player.dispose();
    this.player = null;
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
    if (s.modified && !s.sameAsOriginal) await saveDraft(s.pkg, s.path, s.draftValue());
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
    this._on(document, 'pointerdown', (e) => { const pop = $('edit-pop'); if (!pop.hidden && !pop.contains(e.target)) this._closePop(); }, true);
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
    this._on($('edit-guide'), 'change', () => this._setGuide(Number($('edit-guide').value)));
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
  }

  _unbindDom() {
    for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    this._listeners = [];
  }

  onResize() {
    const stage = $('edit-stage');
    const rail = $('edit-rail');
    const w = Math.max(1, stage.clientWidth - (rail ? rail.offsetWidth : 0));
    const h = Math.max(1, stage.clientHeight);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    const before = this.view.layout;
    this.view.resize(w, h, window.devicePixelRatio || 1);
    this.root.classList.toggle('compact', this.view.layout === 'compact');
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
      if (p.state === PLAYER_STATE.STANDBY) this._syncButtons();
    }
    if (this._fling) more = this._stepFling(now) || more;
    if (this._autoScroll) more = this._stepAutoScroll(now) || more;
    const st = this.view.state;
    for (const until of st.flash.values()) if (until > now) more = true;
    if (this._dirty || more) {
      this._dirty = false;
      this._fillState();
      this.view.draw(now);
      this._updateRail();
      this._updateStatus();
    }
    if (more) this._raf = requestAnimationFrame((n) => this._frame(n));
  }

  _fillState() {
    const st = this.view.state;
    const s = this.session;
    st.model = this.model;
    st.activeTypes = s.activeTypes;
    st.pens = s.pens;
    st.selection = this.mode === 'select' || (this._drag && this._drag.type === 'move') ? s.selection : new Set();
    st.showIds = !!this.config.editShowIds;
    const lp = s.loopPos;
    const geo = this.model.geometry;
    st.loop = lp ? { u0: geo.uOfPos(lp.beginPos), u1: lp.endAtEnd ? null : geo.uOfPos(lp.endPos) } : null;
    if (st.loop && st.loop.u1 === null) st.loop.u1 = geo.uOfPos(msToPos(this.model.chart, this.model.chart.durationMs));
  }

  _updateRail() {
    const thumb = $('edit-rail-thumb');
    if (!thumb) return;
    const m = this.model;
    const total = m.geometry.start(m.endMeasure + 1) + 1;
    const f = Math.max(0, Math.min(1, (this.view.uHead + 1) / total));
    const pct = ((1 - f) * 100).toFixed(2) + '%';
    if (thumb.style.top !== pct) thumb.style.top = pct;
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
    const info = this._soundInfo || '';
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
   * 操作の結果を 1 手にする。EditError はお知らせにして false。
   * @param {() => {doc, select?: string[]}} fn
   * @param {{label: string, selectBefore?: string[], focusU?: number, coalesceKey?: string, quiet?: boolean}} opts
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
    const changed = this.session.apply(r, { label: opts.label, selectBefore: opts.selectBefore, focusU: opts.focusU, coalesceKey: opts.coalesceKey });
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
    const r = this.session.history.undo();
    if (!r) return;
    this._afterHistory(r, 'edit.undone');
  }

  redo() {
    const r = this.session.history.redo();
    if (!r) return;
    this._afterHistory(r, 'edit.redone');
  }

  _afterHistory(r, key) {
    this.session.selection = new Set(r.select || []);
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
        type: 'paint', pointerId: e.pointerId, pointerType: e.pointerType, col: tg.col, ch: tg.ch, value,
        cells: [{ measure: tg.cell.measure, tick: tg.cell.tick, channel: tg.ch, value }], lastSound: performance.now(), mods,
      };
      this._previewSound(tg.ch, value);
      this._updatePaintPreview();
      this._setGhost(null);
    }
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
      this._setGhost(this._target(hit, e.pointerType, this._mods(e)));
      return;
    }
    if (d.pointerId !== e.pointerId) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    this._dragMove(e.clientX, e.clientY, this._mods(e));
    this._checkAutoScroll(e.clientY);
  }

  _dragMove(clientX, clientY, mods) {
    const d = this._drag;
    if (!d) return;
    const hit = this.view.hit(clientX, clientY);
    if (d.type === 'chipPress') {
      const slop = G.SLOP_CSS[d.pointerType] || 4;
      if (Math.hypot(clientX - d.x0, clientY - d.y0) <= slop) return;
      d.type = 'move';
      d.keys = [d.chip.key];
      this.session.selection = new Set(d.keys);
    }
    if (d.type === 'move') {
      this._updateMovePreview(hit, mods);
      return;
    }
    if (d.type === 'paint') {
      const geo = this.model.geometry;
      const cell = geo.snap(hit.u, this._snapGuide(mods.free));
      if (!cell || cell.measure > MAX_MEASURE) return;
      const last = d.cells[d.cells.length - 1];
      if (last.measure === cell.measure && last.tick === cell.tick) return;
      // 飛ばしたセルも埋める(速く動かしても途切れない)
      const dir = geo.u(cell.measure, cell.tick) > geo.u(last.measure, last.tick) ? 1 : -1;
      let cur = { measure: last.measure, tick: last.tick };
      const g = this._snapGuide(mods.free);
      for (let i = 0; i < 512; i++) {
        cur = geo.step(cur.measure, cur.tick, g, dir);
        if (cur.measure < 0 || cur.measure > MAX_MEASURE) break;
        const passed = dir > 0 ? geo.u(cur.measure, cur.tick) > geo.u(cell.measure, cell.tick) + 1e-9 : geo.u(cur.measure, cur.tick) < geo.u(cell.measure, cell.tick) - 1e-9;
        if (passed) break;
        if (!d.cells.some((c) => c.measure === cur.measure && c.tick === cur.tick)) {
          const tg = this._target({ region: 'lanes', column: d.col, u: geo.u(cur.measure, cur.tick), half: 0 }, d.pointerType, { free: true });
          if (tg.kind !== 'locked' && tg.kind !== 'limit') {
            d.cells.push({ measure: cur.measure, tick: cur.tick, channel: d.ch, value: d.value });
            const now = performance.now();
            if (now - d.lastSound >= G.PAINT_SOUND_MS) {
              d.lastSound = now;
              this._previewSound(d.ch, d.value);
            }
          }
        }
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
    if (cancelled) {
      this._render();
      return;
    }
    if (d.type === 'chipPress') {
      const c = d.chip;
      if (d.mods.alt) this._setTypes([c.key], d.mods.shift);
      else if (d.mods.shift) this._addPartner(c.key);
      else this._commit(() => opDelete(this.model, [c.key]), { label: OP.delete, focusU: c.u });
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
    const hit = this.view.hit(e.clientX, e.clientY);
    this._setGhost(this._target(hit, e.pointerType, this._mods(e)));
    this._render();
  }

  _cancelDrag() {
    if (this._drag) {
      try { this.canvas.releasePointerCapture(this._drag.pointerId); } catch (err) { /* 解放済み */ }
    }
    this._drag = null;
    this._autoScroll = null;
    const st = this.view.state;
    st.paint = null;
    st.preview = null;
    st.erase = null;
    st.ghost = null;
    this._render();
  }

  _startErase(e, hit) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
    this._drag = { type: 'erase', pointerId: e.pointerId, pointerType: e.pointerType, keys: new Set() };
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

  /** 動かしている先の描画(元を隠し、行き先に描き、行き先で消えるチップに × を付ける)。 */
  _updateMovePreview(hit, mods) {
    const d = this._drag;
    const m = this.model;
    const geo = m.geometry;
    const anchor = m.chip(d.keys[0]);
    if (!anchor) return;
    const cell = geo.snap(hit.u, this._snapGuide(mods.free));
    const du = cell ? geo.u(cell.measure, cell.tick) - anchor.u : 0;
    let col = hit.region === 'lanes' ? hit.column : d.lastCol ?? anchor.column;
    d.lastCol = col;
    const clamped = clampMove(m, d.keys, du, col - anchor.column);
    d.du = clamped.du;
    d.dcol = clamped.dcol;
    const s = this.session;
    const targets = moveTargets(m, d.keys, { du: d.du, dcol: d.dcol, pens: s.pens, activeTypes: s.activeTypes, keepValue: mods.alt });
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
    };
    this._render();
  }

  _finishMove(d, alt) {
    const s = this.session;
    if (!d.du && !d.dcol) {
      this._render();
      return;
    }
    const anchor = this.model.chip(d.keys[0]);
    const r = this._commit(() => opMove(this.model, d.keys, { du: d.du, dcol: d.dcol, pens: s.pens, activeTypes: s.activeTypes, keepValue: alt }),
      { label: OP.move, selectBefore: d.keys, focusU: anchor ? anchor.u : undefined });
    if (r && r.removed) this._toast(t('edit.removedConflicts', { n: r.removed }));
  }

  _setTypes(keys, keepValue = false) {
    const s = this.session;
    const chips = keys.map((k) => this.model.chip(k)).filter((c) => c && otherType(c.channel) !== null);
    if (!chips.length) return;
    this._commit(() => opSetType(this.model, keys, { pens: s.pens, keepValue }), { label: OP.type, selectBefore: keys, focusU: chips[0].u });
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
    if (this._hover) this._setGhost(this._target(this.view.hit(this._hover.clientX, this._hover.clientY), this._hover.pointerType, this._hover.mods));
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
    this._autoScroll = { v: Math.min(3, Math.max(-3, v)), last: performance.now() };
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
    const dt = Math.min(50, now - a.last) / 1000;
    a.last = now;
    this.view.uHead += a.v * dt;
    this._clampHead();
    if (d.lastX !== undefined) this._dragMove(d.lastX, d.lastY, d.mods || {});
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
        const hit = this.view.hit(p.clientX, p.clientY);
        if (hit.region === 'lanes') this._setGhost(this._target(hit, 'touch'));
      },
      tap: (p) => this._tap(p),
      longPress: (p) => this._longPress(p),
      liftMove: (p) => {
        if (!this._drag || this._drag.type !== 'move') return;
        this._drag.lastX = p.clientX;
        this._drag.lastY = p.clientY;
        this._updateMovePreview(this.view.hit(p.clientX, p.clientY), {});
        this._checkAutoScroll(p.clientY);
      },
      liftEnd: (p, moved) => {
        const d = this._drag;
        this._drag = null;
        this._autoScroll = null;
        this.view.state.preview = null;
        this._setGhost(null);
        if (!d) return;
        if (d.type === 'menu') return;
        if (moved && d.type === 'move') this._finishMove(d, false);
        else if (d.chip) this._chipMenu(d.chip, p.clientX, p.clientY);
        this._render();
      },
      scroll: (dy) => {
        this.follow = false;
        this.view.uHead += dy / (this.view.s * this.view.ppu);
        this._clampHead();
        this._syncButtons();
        this._render();
      },
      scrollEnd: (v) => this._startFling(v),
      pinch: ({ scale, cy, dy }) => {
        this.follow = false;
        this._zoomAt(this.view.zoom * scale, cy, false);
        this.view.uHead += dy / (this.view.s * this.view.ppu);
        this._clampHead();
        this._render();
      },
      pinchEnd: () => this._saveZoom(),
      cancel: () => {
        this._drag = null;
        this.view.state.preview = null;
        this._setGhost(null);
      },
    };
  }

  _tap(p) {
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
    const tg = this._target(hit, 'touch');
    if (tg.kind === 'chip') {
      const r = this._commit(() => opDelete(this.model, [tg.chip.key]), { label: OP.delete, focusU: tg.chip.u });
      if (r) this._toast(t('edit.deleted'), { label: t('common.undo'), run: () => this.undo() });
    } else if (tg.kind === 'empty' || tg.kind === 'replace') {
      const value = this._pen(tg.ch);
      const r = this._commit(() => opPlace(this.model, { measure: tg.cell.measure, tick: tg.cell.tick, channel: tg.ch, value }), { label: OP.place, focusU: tg.u });
      if (r) this._previewSound(tg.ch, value);
      this.session.selection = new Set();
    } else if (tg.kind === 'locked') this._toast(t('edit.lockedCell'));
    else if (tg.kind === 'limit') this._toast(t('edit.measureLimit'));
  }

  _longPress(p) {
    const hit = this.view.hit(p.clientX, p.clientY);
    this._setGhost(null);
    if (hit.region === 'header' && hit.column >= 0) {
      this._drag = { type: 'menu' };
      this._penMenu(hit.column, p.clientX, p.clientY);
      return;
    }
    if (hit.region !== 'lanes') return;
    const tg = this._target(hit, 'touch');
    if (tg.kind === 'chip') {
      // 持ち上げる(動かせば移動、動かさずに離せばメニュー)
      this._drag = { type: 'move', pointerId: p.pointerId, pointerType: 'touch', keys: [tg.chip.key], chip: tg.chip, mods: {} };
      this.session.selection = new Set([tg.chip.key]);
      this.view.state.preview = { hide: new Set(), removeKeys: new Set(), targets: [{ column: tg.chip.column, u: tg.chip.u, channel: tg.chip.channel, value: tg.chip.value }] };
      if (navigator.vibrate) navigator.vibrate(15);
      this._render();
      return;
    }
    if (tg.cell) {
      this._drag = { type: 'menu' };
      const u = this.model.geometry.u(tg.cell.measure, tg.cell.tick);
      this._popover([
        { label: t('edit.playHere'), run: () => { this.view.uHead = u; this.play(); } },
        { label: t('edit.testHere'), run: () => this.testPlay(u) },
      ], p.clientX, p.clientY);
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
    if (this._hover) this._setGhost(this._target(this.view.hit(this._hover.clientX, this._hover.clientY), this._hover.pointerType, this._hover.mods));
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
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
    if (e.isComposing) return;
    const dlg = $('edit-dialog');
    if (dlg.open) return;
    if (!$('edit-help').hidden) {
      if (e.code === 'Escape' || e.key === '?' || e.code === 'Enter') { e.preventDefault(); this._toggleHelp(false); }
      return;
    }
    const pop = $('edit-pop');
    if (!pop.hidden) {
      if (e.code === 'Escape') { e.preventDefault(); this._closePop(); }
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    let key = KEY_OF_CODE[e.code];
    if (!key && e.key && e.key.length === 1) key = e.key.toLowerCase();
    if (e.code === 'Slash' && e.shiftKey) key = '?';
    if (e.key === '?') key = '?';
    if (ctrl && !e.altKey) {
      if (e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
      if (e.code === 'KeyS') { e.preventDefault(); this.saveDtx(); return; }
      return;
    }
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
        const geo = this.model.geometry;
        const cell = geo.snap(this.view.uHead, 0) || { measure: -1, tick: Math.round((this.view.uHead + 1) * TICKS_PER_MEASURE) };
        const next = geo.step(cell.measure, cell.tick, this.view.guide, e.code === 'ArrowUp' ? 1 : -1);
        this._moveHead(geo.u(next.measure, next.tick));
        return;
      }
      default:
        break;
    }
    if (e.altKey) {
      if (e.key === 'Alt') e.preventDefault();
      return;
    }
    switch (key) {
      case 'e':
        e.preventDefault();
        this.mode = 'pen';
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
        const keys = this._hoverOrSelection();
        if (keys.length) this._setTypes(keys, e.shiftKey);
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
      case '=':
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
    // Alt / Ctrl を押した・離したら影を描き直す(もう一方の種類・フリー)
    if (this._hover && (e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift')) {
      this._hover.mods = this._mods(e);
      this._setGhost(this._target(this.view.hit(this._hover.clientX, this._hover.clientY), this._hover.pointerType, this._hover.mods));
    }
  }

  /** R の対象: 選んでいるチップ、無ければマウスで指しているチップ。 */
  _hoverOrSelection() {
    const sel = [...this.session.selection].filter((k) => this.model.chip(k));
    if (sel.length) return sel;
    if (!this._hover) return [];
    const tg = this._target(this.view.hit(this._hover.clientX, this._hover.clientY), this._hover.pointerType, {});
    return tg.kind === 'chip' ? [tg.chip.key] : [];
  }

  _moveHead(u) {
    this.follow = false;
    if (this.player && this.player.state !== PLAYER_STATE.STANDBY) this._stopPlay();
    this.view.uHead = u;
    this._clampHead();
    this._syncButtons();
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
    const chart = this.model.chart;
    const ids = requiredWavIds(chart);
    const audio = this.app.audio;
    if (keepVoices && ids.every((id) => audio.buffers.has(id))) return;
    const doc = this.model.doc;
    this._soundInfo = t('load.sounds', { done: 0, total: ids.length });
    this._render();
    try {
      await audio.loadChartSounds(this.session.pkg, chart, (done, total) => {
        this._soundInfo = t('load.sounds', { done, total });
        this._render();
      }, { keepVoices });
    } catch (e) {
      console.warn('音源の読み込みに失敗:', e);
    }
    if (this._closed) return;
    this._soundInfo = audio.failed.length ? t('load.soundsFailed', { n: audio.failed.length }) : '';
    this._loadedFor = doc;
    if (this.player && this.player.state === PLAYER_STATE.STANDBY) this._playerDoc = null; // BGM の長さで止まる位置が変わる
    this._render();
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
    s.autoPlay = c.editDrumSound !== false;
    s.playSpeed = SPEEDS.includes(c.editSpeed) ? c.editSpeed : 20;
  }

  togglePlay() {
    if (this.player && this.player.state !== PLAYER_STATE.STANDBY) this._stopPlay();
    else this.play();
  }

  /** 再生位置から鳴らす(DTXCreator の「現在の位置から再生」)。 */
  play() {
    const p = this.player;
    if (!p || this._closed) return;
    this._closePop();
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
    this.app.releaseWakeLock();
    this._syncButtons();
    this._render();
  }

  /** 打鍵(キー・MIDI・タッチ)。今は試し聞きと列の光だけ(叩いて入力は使わない)。 */
  onPadHit(lane, ts, src) {
    void ts;
    const ch = padChannel(lane, src, this.session.activeTypes);
    if (ch === null) return;
    this._previewSound(ch, this._pen(ch));
    const col = COLUMN_TYPES.findIndex((tt) => tt.includes(ch));
    if (col >= 0) {
      this.view.state.flash.set(col, performance.now() + 150);
      this._render();
    }
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

  /** .dtx をダウンロードする(Ctrl+S)。 */
  saveDtx() {
    const s = this.session;
    const r = s.outputBytes();
    downloadBytes(r.bytes, baseName(s.path));
    s.history.markExported();
    this._toast(r.changedEncoding ? t('edit.savedUtf8') : t('edit.saved', { name: baseName(s.path) }), null, r.changedEncoding ? 8000 : 3000);
    this._syncButtons();
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
    const items = [
      { label: t('edit.saveDtx'), run: () => this.saveDtx() },
      { label: t('edit.saveZipPack'), run: () => this.app.exportEditedZip() },
    ];
    if (canShareFile(bytes, baseName(s.path))) items.push({ label: t('edit.share'), run: () => this._share() });
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
    items.push({ label: t('edit.help'), run: () => this._toggleHelp(true) });
    items.push({ sep: true });
    items.push({ label: t('edit.discard'), danger: true, disabled: !s.modified, run: () => this._discard() });
    const r = $('edit-more').getBoundingClientRect();
    this._popover(items, r.right, r.bottom, { alignRight: true });
  }

  _toggleOption(key) {
    const c = this.config;
    const def = key === 'editDrumSound' || key === 'editPreviewSound';
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
    items.push({ label: t('edit.opDelete'), danger: true, run: () => this._commit(() => opDelete(this.model, [chip.key]), { label: OP.delete, focusU: chip.u }) });
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
      ['[ / ]', t('edit.helpGuide')],
      ['- / +', t('edit.helpZoom')],
      ['PageUp / PageDown', t('edit.helpMeasure')],
      ['Home / End', t('edit.helpEnds')],
      ['↑ / ↓', t('edit.helpCursor')],
      ['P / Shift+P', t('edit.playStop') + ' / ' + t('edit.playTop')],
      ['T', t('edit.testPlay')],
      ['M', t('edit.metronome')],
      ['R', t('edit.typeFlip')],
      ['Alt', t('edit.helpAltClick')],
      ['Shift', t('edit.helpShiftClick')],
      [t('edit.rightClick'), t('edit.helpRightClick')],
      ['Ctrl', t('edit.helpCtrlDrag')],
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
