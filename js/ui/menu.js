// トレーニングメニュー(DTXManiaAI TrainingMenu.cs 移植)。DOM で描き、キーボードとタッチの両方で操作する。
//
// 操作: ↑↓ = 項目選択 / ←→ = 設定切替(Ctrl 併用で x10、押しっぱなしでリピート)/ Enter = 決定 /
//       Esc = サブメニューから戻る・終了。決定は Enter のみ(Space は BD の既定キーと衝突するため)。
// タッチ: 行をタップで選択、値の行は ◀ ▶ ボタン(長押しでリピート)、動作の行はタップで実行。

import {
  TrainingSettings, LOOP_UNIT, NOTE_OFFSET_MIN, NOTE_OFFSET_MAX, JUDGE_OFFSET_MIN, JUDGE_OFFSET_MAX,
  START_WAIT_MIN, START_WAIT_MAX, START_WAIT_STEP, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX,
  stepLoopBegin, stepLoopEnd, stepLoopTime, formatLoopTime, formatSignedMs, buildMeasureTimes,
} from '../game/training.js';
import { LANE_COUNT, LANE_NAMES, INSTRUMENT } from '../core/dtx.js';
import { t } from '../i18n.js';

export const MENU_COMMAND = { NONE: 'none', START_STOP: 'startStop', RESTART: 'restart', PAUSE_RESUME: 'pauseResume', QUIT: 'quit' };

// 「ドラム音量」「BGM 音量」「現在位置」は本アプリの追加項目(元実装には無い)。
// 音量は演奏中でも耳で合わせられるように、位置は停止中に譜面を前後に送って確認するために置いている。
// ギター / ベースの演奏では「ドラム音量」が弾くパートの音量になり、「リバース」(NX GuitarReverse / BassReverse)が加わる
// (元実装はギター / ベースのトレーニングを持たない。項目の並びはドラムに合わせ、リバースは音量の後ろに置いた)。
const ITEM = {
  AUTO: 0, AUTO_DETAIL: 1, NOTE_OFFSET: 2, JUDGE_OFFSET: 3, HI_SPEED: 4, PLAY_SPEED: 5, START_WAIT: 6,
  DRUM_VOLUME: 7, BGM_VOLUME: 8,
  LOOP: 9, LOOP_UNIT: 10, LOOP_END: 11, LOOP_BEGIN: 12, POSITION: 13,
  START_STOP: 14, RESTART: 15, PAUSE: 16, QUIT: 17,
  REVERSE: 18,
};
// 項目名の文言のキー(js/i18n.js。ITEM の番号の順)。演奏開始 / 一時停止は状態で、音量は楽器で変わるので itemName で選ぶ
const ITEM_NAMES = [
  'menu.autoPlay', 'menu.autoDetail', 'menu.noteOffset', 'menu.judgeOffset', 'menu.hiSpeed',
  'menu.playSpeed', 'menu.startWait', 'menu.drumVolume', 'menu.bgmVolume', 'menu.loop', 'menu.loopUnit',
  'menu.loopEnd', 'menu.loopBegin', 'menu.position', 'menu.start', 'menu.restart', 'menu.pause', 'menu.quit',
  'menu.reverse',
];
/** メイン画面の項目の並び(ドラムは元実装の順のまま)。 */
const DRUM_ITEMS = [
  ITEM.AUTO, ITEM.AUTO_DETAIL, ITEM.NOTE_OFFSET, ITEM.JUDGE_OFFSET, ITEM.HI_SPEED, ITEM.PLAY_SPEED, ITEM.START_WAIT,
  ITEM.DRUM_VOLUME, ITEM.BGM_VOLUME, ITEM.LOOP, ITEM.LOOP_UNIT, ITEM.LOOP_END, ITEM.LOOP_BEGIN, ITEM.POSITION,
  ITEM.START_STOP, ITEM.RESTART, ITEM.PAUSE, ITEM.QUIT,
];
const GB_ITEMS = [
  ITEM.AUTO, ITEM.AUTO_DETAIL, ITEM.NOTE_OFFSET, ITEM.JUDGE_OFFSET, ITEM.HI_SPEED, ITEM.PLAY_SPEED, ITEM.START_WAIT,
  ITEM.DRUM_VOLUME, ITEM.BGM_VOLUME, ITEM.REVERSE, ITEM.LOOP, ITEM.LOOP_UNIT, ITEM.LOOP_END, ITEM.LOOP_BEGIN, ITEM.POSITION,
  ITEM.START_STOP, ITEM.RESTART, ITEM.PAUSE, ITEM.QUIT,
];
/** 自動演奏詳細のボタン名(ギター / ベース。js/game/training.js の gbAutoLanes の並び)。 */
const GB_AUTO_NAMES = ['R', 'G', 'B', 'Y', 'P', 'PICK', 'WAIL'];

/** 音量の刻み(%)。←→ で 5、Ctrl 併用で 50。 */
const VOLUME_STEP = 5;

/** NX tRepeatKey: 1 回目即時 → 200ms 後に 2 回目 → 以降 30ms 間隔。 */
class RepeatKey {
  constructor() {
    this.stage = 0;
    this.at = 0;
  }
  update(pressing, nowMs, fire) {
    if (!pressing) {
      this.stage = 0;
      return;
    }
    if (this.stage === 0) {
      fire();
      this.stage = 1;
      this.at = nowMs;
    } else if (this.stage === 1) {
      if (nowMs - this.at > 200) {
        fire();
        this.at = nowMs;
        this.stage = 2;
      }
    } else if (nowMs - this.at > 30) {
      fire();
      this.at = nowMs;
    }
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// refresh は描画のたびに呼ばれる(演奏中は毎フレーム、停止中は 60 fps 前後)ので、DOM へは値が変わったときだけ書く。同じ文字列でも textContent を
// 代入するとテキストノードが作り直され、同じ値の hidden の代入も属性の変更になるので、メニュー全体の
// スタイル再計算・レイアウト・ペイント・ラスタが毎フレーム走っていた(360 Hz で CPU 約 0.5 コア)。
// 比べる相手は今の DOM(JS 側に控えを持たないので、外から書き換えられても食い違わない)。
// textContent で比べる(innerText はレイアウトを強制する)。クラスは classList.toggle(name, force) のままにする
// (同じ状態なら何も書かない。add / remove や className への代入は値が同じでも属性を書き直す)。
// 元実装(docs/spec/training-menu.md §5.3)も SetActive は値が変わったときだけ呼び、§5.5 / §9 の毎フレームの
// Text.text / color の代入も UGUI の setter が同じ値なら何もしないので、見える結果は元実装と同じ。
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const setHidden = (el, v) => { v = !!v; if (el.hidden !== v) el.hidden = v; };

export class TrainingMenu {
  /**
   * @param {TrainingSettings} settings
   * @param {{sound?: {cursor:()=>void, decide:()=>void, cancel:()=>void}, onPlaySpeedStep?: (delta:number)=>void, onChange?: ()=>void,
   *   instrument?: number}} hooks instrument は弾く楽器(INSTRUMENT。省略でドラム)
   */
  constructor(settings, hooks = {}) {
    this.s = settings;
    this.instrument = hooks.instrument === undefined ? INSTRUMENT.DRUMS : hooks.instrument;
    this.gb = this.instrument !== INSTRUMENT.DRUMS;
    /** メイン画面の項目(ITEM の番号の並び)。 */
    this.items = this.gb ? GB_ITEMS : DRUM_ITEMS;
    /** 自動演奏詳細の行の名前(ドラムは LBD を除く 10 レーン、ギター / ベースは 7 ボタン)。 */
    this.autoNames = this.gb ? GB_AUTO_NAMES : LANE_NAMES.slice(0, LANE_COUNT);
    this.sound = hooks.sound || { cursor() {}, decide() {}, cancel() {} };
    this.onPlaySpeedStep = hooks.onPlaySpeedStep || null;
    this.onChange = hooks.onChange || null;
    /** 現在の演奏位置(ms)を返す。 */
    this.getPositionMs = hooks.getPositionMs || null;
    /** 停止中のシーク。動かせたら true を返す。 */
    this.onSeek = hooks.onSeek || null;
    /** シークできる状態か(演奏中は不可)。 */
    this.canSeek = hooks.canSeek || null;
    /** 音量(0-100)を返す。kind は 'chip'(ドラム) / 'bgm'。 */
    this.getVolume = hooks.getVolume || null;
    /** 音量を step % ぶん動かす。変わったら true。 */
    this.onVolumeStep = hooks.onVolumeStep || null;
    this.page = 'main';
    this.cursor = 0;
    this.chart = null;
    this.measureTimes = [0];
    this.playing = false;
    this.paused = false;
    this.stateText = '';
    this.root = null;
    this.rows = [];
    this._held = new Set();
    this._ctrl = false;
    this._repeat = { ArrowUp: new RepeatKey(), ArrowDown: new RepeatKey(), ArrowLeft: new RepeatKey(), ArrowRight: new RepeatKey() };
    this._pendingCommand = MENU_COMMAND.NONE;
    this._lastCursorSound = -Infinity;
    this._holdStops = [];
  }

  get durationMs() {
    return this.chart ? this.chart.durationMs : 0;
  }
  get itemCount() {
    return this.page === 'main' ? this.items.length : this.autoNames.length + 2;
  }

  /** 自動演奏詳細の「すべて」「戻る」の行。 */
  get _autoAll() {
    return this.autoNames.length;
  }
  get _autoBack() {
    return this.autoNames.length + 1;
  }

  /** 自動演奏詳細の AUTO の配列(設定の中の配列そのもの)。 */
  get _autoFlags() {
    return this.gb ? this.s.gbAutoLanes : this.s.autoLanes;
  }

  /** メイン画面の行 i の項目(ITEM の番号)。 */
  _item(i) {
    return this.items[i];
  }

  /** 譜面を差し替える(小節位置の一覧を作り直す)。 */
  setChart(chart) {
    this.chart = chart;
    this.measureTimes = buildMeasureTimes(chart);
  }

  // ---- DOM ----
  build(container) {
    const root = document.createElement('div');
    root.className = 'tmenu';
    root.innerHTML = `
      <div class="tmenu-header">TRAINING</div>
      <div class="tmenu-state"></div>
      <ul class="tmenu-rows"></ul>
      <div class="tmenu-footer">${t('menu.footer')}</div>`;
    container.appendChild(root);
    this.root = root;
    this.header = root.querySelector('.tmenu-header');
    this.state = root.querySelector('.tmenu-state');
    this.list = root.querySelector('.tmenu-rows');
    this.rows = [];
    const rowCount = Math.max(this.items.length, this.autoNames.length + 2);
    for (let i = 0; i < rowCount; i++) {
      const li = document.createElement('li');
      li.className = 'tmenu-row';
      li.innerHTML = `<span class="tmenu-name"></span><button class="tmenu-btn tmenu-left" aria-label="${t('menu.decrease')}">◀</button><span class="tmenu-value"></span><button class="tmenu-btn tmenu-right" aria-label="${t('menu.increase')}">▶</button>`;
      const row = { li, name: li.querySelector('.tmenu-name'), value: li.querySelector('.tmenu-value'), left: li.querySelector('.tmenu-left'), right: li.querySelector('.tmenu-right') };
      // タップ確定(click)で反応する: 指を置いただけ・スクロール中には動作しない
      li.addEventListener('click', (e) => {
        if (e.target.closest('.tmenu-btn')) return;
        this._tapRow(i);
      });
      this._bindHold(row.left, () => { this.cursor = i; this.changeValue(-this.stepAmount); this.refresh(); });
      this._bindHold(row.right, () => { this.cursor = i; this.changeValue(+this.stepAmount); this.refresh(); });
      this.list.appendChild(li);
      this.rows.push(row);
    }
    this.refresh();
    return root;
  }

  /** ボタン長押しでリピート(タッチ用)。1 ボタンにつき 1 ポインタだけ受け付け、破棄時にタイマーを止める。 */
  _bindHold(btn, fn) {
    let timer = null;
    let interval = null;
    let activeId = null;
    const stop = (e) => {
      if (e && e.pointerId !== undefined && activeId !== null && e.pointerId !== activeId) return;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      timer = interval = null;
      activeId = null;
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (activeId !== null) return;
      activeId = e.pointerId;
      try { btn.setPointerCapture && btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      fn();
      timer = setTimeout(() => { interval = setInterval(fn, 60); }, 300);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) btn.addEventListener(ev, stop);
    this._holdStops.push(() => stop());
  }

  /** 行のタップ: 値の行は選択のみ(◀ ▶ で変更)、動作・サブメニュー入口・レーン別 AUTO の行は即実行。 */
  _tapRow(i) {
    if (i >= this.itemCount) return;
    this.cursor = i;
    const immediate = this.page === 'auto' || this.isAction(i) || this._item(i) === ITEM.AUTO_DETAIL;
    if (immediate) this._pendingCommand = this.decide();
    else this._playCursor();
    this.refresh();
  }

  destroy() {
    for (const stop of this._holdStops) stop();
    this._holdStops = [];
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
  }

  // ---- 入力 ----
  /** keydown/keyup を渡す(code = KeyboardEvent.code)。処理したら true。 */
  keyDown(code, ctrl, nowMs) {
    if (code === 'ControlLeft' || code === 'ControlRight') { this._ctrl = true; return false; }
    this._ctrl = ctrl;
    if (code in this._repeat) {
      if (!this._held.has(code)) {
        this._held.add(code);
        this.update(nowMs); // 1 回目は即時
      }
      return true;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      this._pendingCommand = this.decide();
      this.refresh();
      return true;
    }
    if (code === 'Escape') {
      if (this.page === 'auto') this.backToMain();
      else {
        this.sound.cancel();
        this._pendingCommand = MENU_COMMAND.QUIT;
      }
      this.refresh();
      return true;
    }
    return false;
  }

  keyUp(code) {
    if (code === 'ControlLeft' || code === 'ControlRight') this._ctrl = false;
    this._held.delete(code);
    // 離した瞬間にリピート段階も戻す(次のフレームを待たずに押し直せるように)
    if (code in this._repeat) this._repeat[code].stage = 0;
  }

  /** 全キー離し(フォーカス喪失時など)。 */
  releaseAll() {
    this._held.clear();
    this._ctrl = false;
    for (const k in this._repeat) this._repeat[k].stage = 0;
    for (const stop of this._holdStops) stop();
  }

  /** 毎フレーム呼ぶ(矢印キーのリピート)。 */
  update(nowMs) {
    this._repeat.ArrowUp.update(this._held.has('ArrowUp'), nowMs, () => this.moveCursor(-1));
    this._repeat.ArrowDown.update(this._held.has('ArrowDown'), nowMs, () => this.moveCursor(+1));
    this._repeat.ArrowLeft.update(this._held.has('ArrowLeft'), nowMs, () => this.changeValue(-this.stepAmount));
    this._repeat.ArrowRight.update(this._held.has('ArrowRight'), nowMs, () => this.changeValue(+this.stepAmount));
  }

  /** 溜まっている指示を取り出す(1 フレーム 1 回)。 */
  takeCommand() {
    const c = this._pendingCommand;
    this._pendingCommand = MENU_COMMAND.NONE;
    return c;
  }

  get stepAmount() {
    return this._ctrl ? 10 : 1;
  }

  _playCursor() {
    const now = performance.now();
    if (now - this._lastCursorSound < 60) return;
    this._lastCursorSound = now;
    this.sound.cursor();
  }

  moveCursor(delta) {
    const n = this.itemCount;
    this.cursor = (this.cursor + delta + n) % n;
    this._playCursor();
    this.refresh();
  }

  decide() {
    if (this.page === 'auto') {
      if (this.cursor === this._autoBack) this.backToMain();
      else this.changeValue(+1);
      return MENU_COMMAND.NONE;
    }
    switch (this._item(this.cursor)) {
      case ITEM.AUTO_DETAIL:
        this.page = 'auto';
        this.cursor = 0;
        this.sound.decide();
        return MENU_COMMAND.NONE;
      case ITEM.START_STOP:
        this.sound.decide();
        return MENU_COMMAND.START_STOP;
      case ITEM.RESTART:
        this.sound.decide();
        return MENU_COMMAND.RESTART;
      case ITEM.PAUSE:
        // 待機中でも決定音は鳴らし、指示は演奏側が無視する(元実装と同じ)
        this.sound.decide();
        return MENU_COMMAND.PAUSE_RESUME;
      case ITEM.QUIT:
        this.sound.cancel();
        return MENU_COMMAND.QUIT;
      default:
        this.changeValue(+1);
        return MENU_COMMAND.NONE;
    }
  }

  backToMain() {
    this.page = 'main';
    this.cursor = this.items.indexOf(ITEM.AUTO_DETAIL);
    this.sound.cancel();
  }

  changeValue(delta) {
    if (delta === 0) return;
    const s = this.s;
    if (this.page === 'auto') {
      if (this.cursor === this._autoBack) return;
      const flags = this._autoFlags;
      const n = this.autoNames.length;
      if (this.cursor === this._autoAll) {
        let allOn = true;
        for (let i = 0; i < n; i++) if (!flags[i]) { allOn = false; break; }
        for (let i = 0; i < n; i++) flags[i] = !allOn;
      } else {
        flags[this.cursor] = !flags[this.cursor];
      }
      this._changed();
      return;
    }
    const item = this._item(this.cursor);
    switch (item) {
      case ITEM.AUTO: s.autoPlay = !s.autoPlay; break;
      case ITEM.AUTO_DETAIL: return; // サブメニューは Enter でのみ開く(←→ のリピートで LC を連打しないため)
      case ITEM.NOTE_OFFSET: s.noteOffsetMs = clamp(s.noteOffsetMs + delta, NOTE_OFFSET_MIN, NOTE_OFFSET_MAX); break;
      case ITEM.JUDGE_OFFSET: s.judgeOffsetMs = clamp(s.judgeOffsetMs + delta, JUDGE_OFFSET_MIN, JUDGE_OFFSET_MAX); break;
      case ITEM.HI_SPEED: // 0.1 刻み(Ctrl で 1.0)。ギター / ベースは別に持つ
        if (this.gb) s.gbScrollSpeedTenth = clamp(s.gbScrollSpeedTenth + delta, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX);
        else s.scrollSpeedTenth = clamp(s.scrollSpeedTenth + delta, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX);
        break;
      case ITEM.PLAY_SPEED:
        if (this.onPlaySpeedStep) this.onPlaySpeedStep(delta);
        break;
      case ITEM.START_WAIT: s.startWaitMs = clamp(s.startWaitMs + delta * START_WAIT_STEP, START_WAIT_MIN, START_WAIT_MAX); break;
      case ITEM.DRUM_VOLUME: case ITEM.BGM_VOLUME: {
        // 音量はトレーニング設定ではなくアプリ設定なので、training.save() を呼ぶ _changed() は通さない
        if (!this.onVolumeStep) return;
        if (!this.onVolumeStep(item === ITEM.BGM_VOLUME ? 'bgm' : 'chip', delta * VOLUME_STEP)) return;
        this._playCursor();
        this.refresh();
        return;
      }
      case ITEM.REVERSE: s.gbReverse = !s.gbReverse; break;
      case ITEM.LOOP: s.loop = !s.loop; break;
      case ITEM.LOOP_UNIT: s.loopUnit = s.loopUnit === LOOP_UNIT.MEASURE ? LOOP_UNIT.SECOND : LOOP_UNIT.MEASURE; break;
      case ITEM.LOOP_END: {
        const v = stepLoopEnd(s.loopEndMs, s.loopBeginMs, delta, s.loopUnit, this.measureTimes, this.durationMs);
        if (v === s.loopEndMs) return;
        s.loopEndMs = v;
        break;
      }
      case ITEM.LOOP_BEGIN: {
        const v = stepLoopBegin(s.loopBeginMs, s.loopEndMs, delta, s.loopUnit, this.measureTimes, this.durationMs);
        if (v === s.loopBeginMs) return;
        s.loopBeginMs = v;
        break;
      }
      case ITEM.POSITION: {
        // 設定ではなく演奏位置そのものを動かすので、training.save() は呼ばない
        if (!this.onSeek || this.isDisabled(this.cursor)) return;
        const cur = this.positionMs;
        const v = stepLoopTime(cur, delta, s.loopUnit, this.measureTimes, this.seekMaxMs);
        if (v === cur || !this.onSeek(v)) return;
        this._playCursor();
        this.refresh();
        return;
      }
      default: return;
    }
    this._changed();
  }

  _changed() {
    this._playCursor();
    if (this.onChange) this.onChange();
    this.refresh();
  }

  // ---- 表示 ----
  isAction(i) {
    if (this.page === 'auto') return i === this._autoBack;
    const item = this._item(i);
    return item === ITEM.START_STOP || item === ITEM.RESTART || item === ITEM.PAUSE || item === ITEM.QUIT;
  }

  isDisabled(i) {
    if (this.page === 'auto') return false;
    switch (this._item(i)) {
      case ITEM.LOOP_UNIT: case ITEM.LOOP_END: case ITEM.LOOP_BEGIN: return !this.s.loop;
      case ITEM.PAUSE: return !this.playing;
      case ITEM.POSITION: return !this.canSeek || !this.canSeek();
      default: return false;
    }
  }

  /** 現在の演奏位置(ms)。フックが無ければ 0。 */
  get positionMs() {
    return this.getPositionMs ? this.getPositionMs() : 0;
  }

  /** シークの上限(最終ノートより後ろの小節も見られるように、最後の小節頭とどちらか遅い方)。 */
  get seekMaxMs() {
    const lastMeasure = this.measureTimes.length ? this.measureTimes[this.measureTimes.length - 1] : 0;
    return Math.max(this.durationMs, lastMeasure);
  }

  hasValueButtons(i) {
    if (this.page === 'auto') return i !== this._autoBack;
    return !this.isAction(i) && this._item(i) !== ITEM.AUTO_DETAIL;
  }

  itemName(i) {
    if (this.page === 'auto') {
      if (i === this._autoBack) return t('menu.back');
      if (i === this._autoAll) return t('menu.all');
      return this.autoNames[i];
    }
    const item = this._item(i);
    if (item === ITEM.START_STOP) return t(this.playing ? 'menu.stop' : 'menu.start');
    if (item === ITEM.PAUSE) return t(this.paused ? 'menu.resume' : 'menu.pause');
    if (item === ITEM.DRUM_VOLUME && this.gb) return t(this.instrument === INSTRUMENT.BASS ? 'menu.bassVolume' : 'menu.guitarVolume');
    return t(ITEM_NAMES[item]);
  }

  itemValue(i) {
    const s = this.s;
    if (this.page === 'auto') {
      if (i === this._autoBack || i === this._autoAll) return '';
      return this._autoFlags[i] ? 'AUTO' : t('menu.manual');
    }
    switch (this._item(i)) {
      case ITEM.AUTO: return s.autoPlay ? 'ON' : 'OFF';
      case ITEM.AUTO_DETAIL: return this.autoLaneSummary();
      case ITEM.NOTE_OFFSET: return formatSignedMs(s.noteOffsetMs);
      case ITEM.JUDGE_OFFSET: return formatSignedMs(s.judgeOffsetMs);
      case ITEM.HI_SPEED: return 'x' + (this.gb ? s.gbHiSpeedRatio : s.hiSpeedRatio).toFixed(1);
      case ITEM.PLAY_SPEED: return 'x' + s.playSpeedRatio.toFixed(2);
      case ITEM.START_WAIT: return (s.startWaitMs / 1000).toFixed(1) + ' s';
      case ITEM.DRUM_VOLUME: return (this.getVolume ? this.getVolume('chip') : 0) + ' %';
      case ITEM.BGM_VOLUME: return (this.getVolume ? this.getVolume('bgm') : 0) + ' %';
      case ITEM.REVERSE: return s.gbReverse ? 'ON' : 'OFF';
      case ITEM.LOOP: return !s.loop ? 'OFF' : s.loopRangeValid ? 'ON' : t('menu.loopInvalid');
      case ITEM.LOOP_UNIT: return t(s.loopUnit === LOOP_UNIT.MEASURE ? 'menu.unitMeasure' : 'menu.unitSecond');
      case ITEM.LOOP_END: return formatLoopTime(s.loopEndMs, s.loopUnit, this.measureTimes);
      case ITEM.LOOP_BEGIN: return formatLoopTime(s.loopBeginMs, s.loopUnit, this.measureTimes);
      case ITEM.POSITION: return formatLoopTime(this.positionMs, s.loopUnit, this.measureTimes);
      default: return '';
    }
  }

  autoLaneSummary() {
    const flags = this._autoFlags;
    const count = this.autoNames.length;
    let n = 0;
    for (let i = 0; i < count; i++) if (flags[i]) n++;
    if (n === 0) return t('menu.none');
    if (n === count) return t('menu.all');
    return t(this.gb ? 'menu.buttons' : 'menu.lanes', { n });
  }

  refresh() {
    if (!this.root) return;
    setText(this.header, this.page === 'main' ? 'TRAINING' : t('menu.autoHeader'));
    setText(this.state, this.stateText);
    const count = this.itemCount;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const used = i < count;
      setHidden(row.li, !used);
      if (!used) continue;
      const sel = i === this.cursor;
      setText(row.name, (sel ? '> ' : '') + this.itemName(i));
      setText(row.value, this.itemValue(i));
      row.li.classList.toggle('selected', sel);
      row.li.classList.toggle('action', this.isAction(i));
      row.li.classList.toggle('disabled', !sel && this.isDisabled(i));
      const btns = this.hasValueButtons(i);
      setHidden(row.left, !btns);
      setHidden(row.right, !btns);
    }
  }
}
