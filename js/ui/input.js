// 入力: キーボード(レーン割当)とタッチ/マウス(レーン列のヒット判定)。
// ヒット時刻は event.timeStamp(performance.now() と同じ時間軸)で渡し、player 側で演奏時刻へ変換する。

export const LANE_KEY_DEFAULTS = [
  ['KeyA'], // LC
  ['KeyS'], // HH
  ['KeyW'], // LP
  ['KeyD'], // SD
  ['KeyF'], // HT
  ['Space'], // BD
  ['KeyJ'], // LT
  ['KeyK'], // FT
  ['KeyL'], // CY
  ['Semicolon'], // RD
];

const KEY_TO_CODE = {
  ' ': 'Space', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight',
  '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote', Spacebar: 'Space',
};

/**
 * KeyboardEvent → code。code が空(一部のソフトキーボードや自動操作)なら key から推定する。
 * @param {KeyboardEvent} e
 */
export function eventCode(e) {
  if (e.code) return e.code;
  const k = e.key || '';
  if (KEY_TO_CODE[k]) return KEY_TO_CODE[k];
  if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  return k; // ArrowDown / Enter / Escape / F1 などはそのまま code と同じ綴り
}

/** KeyboardEvent.code の表示名。 */
export function keyLabel(code) {
  if (!code) return '';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = { Space: 'Space', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' };
  return map[code] || code.replace(/^Numpad/, 'Num');
}

export class DrumInput {
  /**
   * @param {{onHit:(lane:number, timeStampMs:number, source:string)=>void, onKey?:(code:string, down:boolean, ev:KeyboardEvent)=>boolean}} hooks
   */
  constructor(hooks) {
    this.onHit = hooks.onHit;
    this.onKey = hooks.onKey || null;
    /** @type {string[][]} lane → codes */
    this.bindings = [];
    /** @type {Map<string, number>} code → lane(1 レーンに複数キーを割り当てても打鍵ごとの照合は 1 回) */
    this._codeToLane = new Map();
    this.setBindings(LANE_KEY_DEFAULTS);
    this.enabled = true;
    this._down = new Set();
    this._keydown = (e) => this._onKeyDown(e);
    this._keyup = (e) => this._onKeyUp(e);
    this._blur = () => this._down.clear();
    /** タッチのヒット判定関数(clientX, clientY → lane または -1)。 */
    this.hitTest = null;
    this._pointerTarget = null;
    this._pointerdown = (e) => this._onPointerDown(e);
  }

  attach(pointerTarget) {
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    window.addEventListener('blur', this._blur);
    if (pointerTarget) {
      this._pointerTarget = pointerTarget;
      pointerTarget.addEventListener('pointerdown', this._pointerdown);
    }
  }

  detach() {
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    window.removeEventListener('blur', this._blur);
    if (this._pointerTarget) this._pointerTarget.removeEventListener('pointerdown', this._pointerdown);
    this._pointerTarget = null;
  }

  setBindings(bindings) {
    this.bindings = bindings.map((a) => (a || []).slice());
    this._codeToLane.clear();
    // 同じ code が複数レーンにあるときは若いレーンが勝つ(設定 UI 側で重複しないようにしてある)
    for (let lane = 0; lane < this.bindings.length; lane++) {
      for (const code of this.bindings[lane]) if (!this._codeToLane.has(code)) this._codeToLane.set(code, lane);
    }
  }

  laneOfCode(code) {
    const lane = this._codeToLane.get(code);
    return lane === undefined ? -1 : lane;
  }

  _onKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    const code = eventCode(e);
    if (this.onKey && this.onKey(code, true, e)) {
      e.preventDefault();
      return;
    }
    if (!this.enabled) return;
    if (e.repeat || this._down.has(code)) {
      if (this.laneOfCode(code) >= 0) e.preventDefault();
      return;
    }
    const lane = this.laneOfCode(code);
    if (lane < 0) return;
    this._down.add(code);
    e.preventDefault();
    this.onHit(lane, e.timeStamp || performance.now(), 'key');
  }

  _onKeyUp(e) {
    const code = eventCode(e);
    this._down.delete(code);
    if (this.onKey) this.onKey(code, false, e);
  }

  _onPointerDown(e) {
    if (!this.enabled || !this.hitTest) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const lane = this.hitTest(e.clientX, e.clientY);
    if (lane < 0) return;
    e.preventDefault();
    this.onHit(lane, e.timeStamp || performance.now(), 'touch');
  }
}
