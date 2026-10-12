// ギター / ベースの入力: キーボード(ネックの R G B Y P は押している間だけ、ピックとウェイリングは押した瞬間)と
// タッチ(レーンの列を押す = そのボタンを押さえてピック、レーンの外を押す = 何も足さずにピック)。
// 時刻は event.timeStamp(performance.now() と同じ時間軸)で渡し、player 側で演奏時刻へ変換する(ドラムの js/ui/input.js と同じ)。
// 既定のキーは NX のギターと同じ(R〜P = F1〜F5 / Pick = ] と :。US の配列の名前では ] と ')。割り当てたキーはアプリのホットキー(F1 の AUTO 切替)
// より先に取り、ブラウザの既定の動作(F1 のヘルプ・F3 の検索・F5 の再読み込み)も止める。NX のウェイリングの右 Ctrl は、
// Ctrl を押したまま F4 を押すとブラウザがタブを閉じる(ページからは止められない)ので使わず、/ にする。

import { eventCode } from './input.js';

/** ボタン番号(ネックの 5 個 + ピック + ウェイリング)。ネックは js/core/dtx.js の GB_LANE_BITS と同じ並び。 */
export const GB_BUTTON = { R: 0, G: 1, B: 2, Y: 3, P: 4, PICK: 5, WAIL: 6 };
export const GB_BUTTON_COUNT = 7;
export const GB_BUTTON_NAMES = ['R', 'G', 'B', 'Y', 'P', 'PICK', 'WAIL'];

/**
 * 既定のキー(NX のギターの既定。docs/spec/gb-config.md §1.2)。ネックは F1〜F5、ピックは ] と :(code は場所で決まり、
 * JIS では [ と : のキー、US では ] と ' のキー。NX は ] をキャンセルにも使うので重複を除いて : だけになるが、Web 版には
 * キャンセルが無いので DTXManiaAI と同じく両方)、ウェイリングは /(NX は右 Ctrl。上の注記)。ドラムの割り当て
 * (config.bindings)とは別に持ち、ギターとベースで共有する。
 */
export const GB_KEY_DEFAULTS = [
  ['F1'], // R
  ['F2'], // G
  ['F3'], // B
  ['F4'], // Y
  ['F5'], // P
  ['BracketRight', 'Quote'], // PICK
  ['Slash'], // WAIL
];

/** テンキーの並び(NX のベースの既定。設定の「テンキーの並びにする」。ピックは . と Enter、ウェイリングは 0)。 */
export const GB_KEY_NUMPAD = [
  ['Numpad1'], // R
  ['Numpad2'], // G
  ['Numpad3'], // B
  ['Numpad4'], // Y
  ['Numpad5'], // P
  ['NumpadDecimal', 'NumpadEnter'], // PICK
  ['Numpad0'], // WAIL
];

/**
 * ホームポジションの並び(本アプリの以前の既定。設定の「A S D F G の並びにする」)。左手でネックを A S D F G、
 * 右手で J / K を交互に押してピック、L でウェイリング。
 */
export const GB_KEY_HOME = [
  ['KeyA'], // R
  ['KeyS'], // G
  ['KeyD'], // B
  ['KeyF'], // Y
  ['KeyG'], // P
  ['KeyJ', 'KeyK'], // PICK
  ['KeyL'], // WAIL
];

/**
 * 既定を NX の並びに変える前(設定の版 2 より前)に保存した割り当てが、以前の既定(GB_KEY_HOME)のままなら今の既定に替える。
 * 一度だけ(版 2 以降の保存は、A S D F G の並びを選び直したものなのでそのまま)。手で変えた割り当てには触らない。
 * @param {number} savedRev 保存されていた設定の版(config.configRev)
 * @returns {{bindings: string[][], migrated: boolean}}
 */
export function migrateGbBindings(bindings, savedRev) {
  if (Number(savedRev) >= 2) return { bindings, migrated: false };
  const same = Array.isArray(bindings) && bindings.length === GB_KEY_HOME.length
    && GB_KEY_HOME.every((codes, i) => Array.isArray(bindings[i]) && bindings[i].join(',') === codes.join(','));
  if (!same) return { bindings, migrated: false };
  return { bindings: GB_KEY_DEFAULTS.map((a) => a.slice()), migrated: true };
}

/**
 * 左利き用の並び(本アプリの追加。設定の「左利き用の並びにする」)。ホームポジションの並びをキーボードの中央(G と H の間)で
 * 鏡に映したもの:
 * 右手でネックを ; L K J H(LEFT で右端に描かれる R が右端のキー)、左手で F / D を交互に押してピック、S でウェイリング。
 * LEFT はボタンを描く列を入れ替えるだけでキーは変えない(NX と同じ)ので、左手でピックするときはこの並びにする。
 */
export const GB_KEY_LEFTY = [
  ['Semicolon'], // R
  ['KeyL'], // G
  ['KeyK'], // B
  ['KeyJ'], // Y
  ['KeyH'], // P
  ['KeyF', 'KeyD'], // PICK
  ['KeyS'], // WAIL
];

/** タッチのヒット判定の結果: レーンの外(ハイウェイの中)= 何も押さえずにピック。 */
export const GB_TOUCH_OPEN = -2;

export class GuitarInput {
  /**
   * @param {{
   *   onFret: (lane:number, down:boolean, timeStampMs:number, source:string) => void,
   *   onPick: (timeStampMs:number, source:string) => void,
   *   onWail: (timeStampMs:number, source:string) => void,
   *   onKey?: (code:string, down:boolean, ev:KeyboardEvent) => boolean,
   * }} hooks
   *   onFret はネックのボタンの押下状態が変わったときだけ呼ぶ(同じボタンに複数のキーや指が載っていても 1 回)。
   */
  constructor(hooks) {
    this.onFret = hooks.onFret;
    this.onPick = hooks.onPick;
    this.onWail = hooks.onWail;
    this.onKey = hooks.onKey || null;
    this.bindings = [];
    this._codeToButton = new Map();
    this.setBindings(GB_KEY_DEFAULTS);
    this.enabled = true;
    this._down = new Set(); // 押している割り当てキー(code)
    this._holders = Array.from({ length: 5 }, () => new Set()); // ネックのボタンを押さえているもの(キーの code か 'p' + pointerId)
    this._pointers = new Map(); // pointerId → 押さえたネックのボタン(レーンの外なら -1)
    /** タッチのヒット判定関数(clientX, clientY → ネックのボタン 0..4、GB_TOUCH_OPEN、または -1)。 */
    this.hitTest = null;
    this._pointerTarget = null;
    this._keydown = (e) => this._onKeyDown(e);
    this._keyup = (e) => this._onKeyUp(e);
    this._blur = () => this.releaseAll(performance.now());
    this._pointerdown = (e) => this._onPointerDown(e);
    this._pointerup = (e) => this._onPointerUp(e);
  }

  attach(pointerTarget) {
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    window.addEventListener('blur', this._blur);
    if (pointerTarget) {
      this._pointerTarget = pointerTarget;
      pointerTarget.addEventListener('pointerdown', this._pointerdown);
      // 指をレーンの外へ滑らせても、離すまでは押さえたままにする(pointerleave では離さない)
      for (const ev of ['pointerup', 'pointercancel']) pointerTarget.addEventListener(ev, this._pointerup);
    }
  }

  detach() {
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    window.removeEventListener('blur', this._blur);
    if (this._pointerTarget) {
      this._pointerTarget.removeEventListener('pointerdown', this._pointerdown);
      for (const ev of ['pointerup', 'pointercancel']) this._pointerTarget.removeEventListener(ev, this._pointerup);
    }
    this._pointerTarget = null;
    this._down.clear();
    this._pointers.clear();
    for (const h of this._holders) h.clear();
  }

  /** @param {string[][]} bindings ボタン → KeyboardEvent.code の一覧(GB_BUTTON の順) */
  setBindings(bindings) {
    this.bindings = bindings.map((a) => (a || []).slice());
    this._codeToButton.clear();
    // 同じ code が複数のボタンにあるときは若いボタンが勝つ(設定 UI 側で重複しないようにしてある)
    for (let b = 0; b < this.bindings.length; b++) {
      for (const code of this.bindings[b]) if (!this._codeToButton.has(code)) this._codeToButton.set(code, b);
    }
  }

  buttonOfCode(code) {
    const b = this._codeToButton.get(code);
    return b === undefined ? -1 : b;
  }

  /** ネックのボタンが押されているか(キーボードかタッチのどちらかで)。 */
  isFretDown(lane) {
    return this._holders[lane].size > 0;
  }

  /**
   * キーとタッチの押さえを全部離す(フォーカスを失ったときなど。keyup / pointerup が来ないまま押しっぱなしにならないように)。
   * ギターコントローラの押さえは残す(js/ui/gamepad.js が読み続けて離したことを必ず届ける。消すと、押したままのボタンが
   * 押し直すまで離した扱いになる)。レーンが空いたときだけ知らせる。
   */
  releaseAll(timeStampMs) {
    for (let lane = 0; lane < this._holders.length; lane++) {
      const h = this._holders[lane];
      if (!h.size) continue;
      for (const code of this._down) h.delete(code);
      for (const id of this._pointers.keys()) h.delete('p' + id);
      if (!h.size) this.onFret(lane, false, timeStampMs, 'release');
    }
    this._down.clear();
    this._pointers.clear();
  }

  /**
   * ギターコントローラ(js/ui/gamepad.js)の入力。holder は入力ごとの名前で、キーやタッチと同じく押さえている数を数える
   * (ネックは押している間、PICK / WAIL は押した瞬間)。
   */
  padInput(button, down, ts, holder) {
    if (!this.enabled) return;
    if (button < 5) {
      if (down) this._hold(button, holder, ts, 'pad');
      else this._unhold(button, holder, ts, 'pad');
      return;
    }
    if (!down) return;
    if (button === GB_BUTTON.PICK) this.onPick(ts, 'pad');
    else if (button === GB_BUTTON.WAIL) this.onWail(ts, 'pad');
  }

  _hold(lane, holder, ts, source) {
    const h = this._holders[lane];
    const was = h.size > 0;
    h.add(holder);
    if (!was) this.onFret(lane, true, ts, source);
  }

  _unhold(lane, holder, ts, source) {
    const h = this._holders[lane];
    if (!h.delete(holder)) return;
    if (h.size === 0) this.onFret(lane, false, ts, source);
  }

  _onKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    const code = eventCode(e);
    // 割り当てたキーはアプリのホットキー(F1 の AUTO 切替・テンキー Enter の決定)より先に取る(NX の既定の F1・テンキー Enter)。
    // 矢印・Enter・Esc・Tab は割り当てられないので、メニューの操作はこれまでどおり onKey へ行く
    const button = this.enabled ? this.buttonOfCode(code) : -1;
    if (button < 0) {
      if (this.onKey && this.onKey(code, true, e)) e.preventDefault();
      return;
    }
    e.preventDefault(); // ブラウザの既定の動作(F1 ヘルプ・F3 検索・F5 再読み込みなど)も止める。押しっぱなしのリピートも
    if (e.repeat || this._down.has(code)) return;
    this._down.add(code);
    const ts = e.timeStamp || performance.now();
    if (button < 5) this._hold(button, code, ts, 'key');
    else if (button === GB_BUTTON.PICK) this.onPick(ts, 'key');
    else this.onWail(ts, 'key');
  }

  _onKeyUp(e) {
    const code = eventCode(e);
    if (this._down.delete(code)) {
      const button = this.buttonOfCode(code);
      if (button >= 0 && button < 5) this._unhold(button, code, e.timeStamp || performance.now(), 'key');
    }
    if (this.onKey) this.onKey(code, false, e);
  }

  _onPointerDown(e) {
    if (!this.enabled || !this.hitTest) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit === -1) return;
    e.preventDefault();
    const ts = e.timeStamp || performance.now();
    const lane = hit >= 0 && hit < 5 ? hit : -1;
    this._pointers.set(e.pointerId, lane);
    try { if (this._pointerTarget && this._pointerTarget.setPointerCapture) this._pointerTarget.setPointerCapture(e.pointerId); } catch (err) { /* 非対応でも up は拾える */ }
    // 押さえてから弾く(同じ瞬間なので、押さえたボタンがこのピックの押さえ方に入る)
    if (lane >= 0) this._hold(lane, 'p' + e.pointerId, ts, 'touch');
    this.onPick(ts, 'touch');
  }

  _onPointerUp(e) {
    if (!this._pointers.has(e.pointerId)) return;
    const lane = this._pointers.get(e.pointerId);
    this._pointers.delete(e.pointerId);
    if (lane >= 0) this._unhold(lane, 'p' + e.pointerId, e.timeStamp || performance.now(), 'touch');
  }
}
