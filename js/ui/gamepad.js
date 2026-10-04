// ギターコントローラ(ゲームパッド)の入力(Gamepad API)。ギター / ベースの演奏で、ボタン・軸の向き・ハットの向きを
// R G B Y P / PICK / WAIL / START に割り当てて読む。設定の割り当て欄(js/ui/keypanel.js)の「押して追加」もここで待つ。
//
// 元実装(docs/spec/gb-config.md §1.5): NX は DirectInput のボタン・X/Y/Z 軸の向き(|値| > 500/1000)・POV の 8 方向を
// どれも押す / 離すの入力にし、ピックとウェイリングは押した瞬間(入力ごとの時刻)、ネックは押している間を読む。
// ストラムの上下を両方ピックにするには両方を割り当てる。DTXManiaAI は Gamepad.current の名前付きボタン 16 個だけで、
// 軸は読まず、時刻はフレーム。Web 版で決めたこと(docs/spec/guitar-bass.md):
//   ・ブラウザはゲームパッドの変化を知らせない(イベントが無い)ので navigator.getGamepads() を 4 ms ごとに読む
//     (Chrome / Firefox が機器を読む間隔と同じ)。1 台も無い間は 250 ms ごとに確かめるだけ
//   ・時刻は gamepad.timestamp(ブラウザがその状態を読んだ時刻。performance.now と同じ時間軸)。おかしな値なら読んだ時刻
//   ・軸は NX と同じく 0.5 を越えたら押す。戻りは 0.35 を切ったら(本アプリの追加。Rock Band のチルトのちらつき対策)
//   ・ハット(ストラムバー・十字キー)は Chrome / Firefox が軸 1 本に載せ、中央を範囲外の値にするので、向きに直して読む。
//     上 / 下 / 左 / 右 の 4 つにし、斜めは両方に数える(NX は 45° ずつ 8 方向)
//   ・1 つの割り当てを、つながっているゲームパッド全部に使う(電子ドラムの MIDI と同じ。NX は機器ごとの ID を持つ)
//   ・START(演奏開始・停止)は本アプリの追加(ギターを持ったまま始められるように)
//   ・同じ取得の中では、ネックの変化 → ピック → ウェイリング → START の順に渡す(押さえとピックが同時に届いたら押さえが先)

import { t } from '../i18n.js';

/** GuitarInput に渡す押さえの名前の頭('g' + 番号 + ':' + 符号)。 */
export const PAD_HOLDER_PREFIX = 'g';

/** 割り当ての行(ギター / ベースの 7 ボタン + START)。 */
export const PAD_BUTTON_NAMES = ['R', 'G', 'B', 'Y', 'P', 'PICK', 'WAIL', 'START'];
export const PAD_PICK = 5;
export const PAD_WAIL = 6;
export const PAD_START = 7;
/** 読む間隔(ms)。ゲームパッドがある間 / 無い間。 */
export const PAD_POLL_MS = 4;
export const PAD_IDLE_MS = 250;
/** 軸を押した扱いにする値と、離した扱いに戻す値。 */
export const PAD_AXIS_ON = 0.5;
export const PAD_AXIS_OFF = 0.35;
/** ハットの軸の値がこれを越えたら中央(Chrome / Firefox は中央を ±1 の外の値にする)。 */
const HAT_RANGE = 1.01;
/** gamepad.timestamp を使うのは今からこの ms 以内のときだけ(Safari は秒で返すので使えない)。 */
const TIMESTAMP_SPAN_MS = 1000;

/**
 * 既定の割り当て(本アプリで決めたもの)。Xbox 360 の Guitar Hero / Rock Band ギター(XInput。ブラウザでは標準の配置の
 * ゲームパッドとして見える)の配置: フレットは手前から緑 A(0)・赤 B(1)・黄 Y(3)・青 X(2)・オレンジ LB(4) を、
 * ネックの並びの順に R G B Y P へ。ピックはストラムの上下(十字キーの上 12・下 13)、ウェイリングはチルト(右スティックの
 * 縦。上へ傾けると負)とスターパワーのボタン(Back 8)、START は Start(9)。実機では確かめていない。ほかのギター
 * (PS3 / PS4 / コナミのコントローラなど)はボタンの番号がまちまちなので「押して追加」で割り当てる。
 */
export const GB_PAD_DEFAULTS = [
  ['b0'], // R(緑)
  ['b1'], // G(赤)
  ['b3'], // B(黄)
  ['b2'], // Y(青)
  ['b4'], // P(オレンジ)
  ['b12', 'b13'], // PICK(ストラムの上・下)
  ['a3-', 'b8'], // WAIL(チルト・スターパワー)
  ['b9'], // START
];

const CODE_RE = /^(?:b(\d{1,2})|a(\d{1,2})([+-])|h(\d{1,2})([udlr]))$/;
/** ハットの向き(0 = 上から時計回りに 45° ずつ)のうち、上 / 右 / 下 / 左 に数えるもの(斜めは両方)。 */
const HAT_DIRS = { u: [7, 0, 1], r: [1, 2, 3], d: [3, 4, 5], l: [5, 6, 7] };
const HAT_ARROW = { u: '↑', d: '↓', l: '←', r: '→' };

/**
 * 入力の符号: 'b<i>' ボタン i / 'a<i>+' 'a<i>-' 軸 i の向き / 'h<i>u|d|l|r' 軸 i に載ったハットの向き。
 * 読めなければ null。
 */
export function parsePadCode(code) {
  const m = typeof code === 'string' ? CODE_RE.exec(code) : null;
  if (!m) return null;
  if (m[1] !== undefined) return { kind: 'b', index: Number(m[1]), dir: '' };
  if (m[2] !== undefined) return { kind: 'a', index: Number(m[2]), dir: m[3] };
  return { kind: 'h', index: Number(m[4]), dir: m[5] };
}

export function isPadCode(code) {
  return parsePadCode(code) !== null;
}

/** 画面に出す名前(B3 / 軸3− / ハット9↑)。 */
export function padCodeLabel(code) {
  const p = parsePadCode(code);
  if (!p) return String(code || '');
  if (p.kind === 'b') return t('pad.labelButton', { n: p.index });
  if (p.kind === 'a') return t('pad.labelAxis', { n: p.index, dir: p.dir === '+' ? '+' : '−' });
  return t('pad.labelHat', { n: p.index, dir: HAT_ARROW[p.dir] });
}

/** ハットの軸の値 → 向き 0..7(上から時計回り)。中央・範囲外は -1。 */
export function hatDirection(v) {
  if (!Number.isFinite(v) || Math.abs(v) > HAT_RANGE) return -1;
  return Math.round((v + 1) * 3.5) % 8;
}

/**
 * 符号の押されている状態。軸は前の状態 was で、押すとき PAD_AXIS_ON・離すとき PAD_AXIS_OFF を使う。
 * ±1 の外の値の軸(中央のハット)は軸の向きとしては押していない扱い。
 */
export function codePressed(pad, p, was) {
  if (!pad || !p) return false;
  if (p.kind === 'b') {
    const b = pad.buttons && pad.buttons[p.index];
    return !!(b && (typeof b === 'object' ? b.pressed : b > 0.5));
  }
  const v = pad.axes ? pad.axes[p.index] : undefined;
  if (!Number.isFinite(v)) return false;
  if (p.kind === 'h') return HAT_DIRS[p.dir].indexOf(hatDirection(v)) >= 0;
  if (Math.abs(v) > HAT_RANGE) return false;
  const s = p.dir === '+' ? v : -v;
  return s > (was ? PAD_AXIS_OFF : PAD_AXIS_ON);
}

/** 押した瞬間の時刻。gamepad.timestamp が今から 1 秒以内ならそれ(今より後にはしない)、無理なら now。 */
export function padTimeStamp(pad, now) {
  const ts = pad ? pad.timestamp : NaN;
  if (Number.isFinite(ts) && Math.abs(now - ts) < TIMESTAMP_SPAN_MS) return Math.min(ts, now);
  return now;
}

/** ゲームパッドの全部の入力の符号(監視と「押して追加」用。ハットの軸はハットの 4 方向、ほかの軸は ± の 2 方向)。 */
function allCodes(pad, hatAxes) {
  const out = [];
  const nb = pad.buttons ? pad.buttons.length : 0;
  for (let i = 0; i < nb; i++) out.push('b' + i);
  const na = pad.axes ? pad.axes.length : 0;
  for (let i = 0; i < na; i++) {
    if (hatAxes.has(i)) for (const d of ['u', 'd', 'l', 'r']) out.push('h' + i + d);
    else out.push('a' + i + '+', 'a' + i + '-');
  }
  return out;
}

/** 渡す順(ネック → PICK → WAIL → START)。 */
const ORDER = [0, 0, 0, 0, 0, 1, 2, 3];

export class GamepadInput {
  /**
   * @param {{
   *   getGamepads?: () => (Gamepad|null)[],
   *   onButton?: (button: number, down: boolean, timeStampMs: number, holder: string) => void,
   *   onInput?: (info: {code: string, down: boolean, button: number, index: number, id: string, timeStamp: number}) => void,
   *   onDevices?: (change: {added: string[], removed: string[]}) => void,
   * }} hooks
   *   onButton は割り当てた入力の押す / 離す(button は PAD_BUTTON_NAMES の番号。holder は入力ごとの名前で、
   *   GuitarInput が同じボタンを複数の入力で押さえたときの数え分けに使う)。onInput は設定の監視用で、
   *   watchAll の間はすべての入力、それ以外は割り当てた入力の変化を知らせる。
   */
  constructor(hooks = {}) {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    this.supported = !!hooks.getGamepads || !!(nav && typeof nav.getGamepads === 'function');
    this.getGamepads = hooks.getGamepads || (() => (nav && nav.getGamepads ? nav.getGamepads() : []));
    this.onButton = hooks.onButton || null;
    this.onInput = hooks.onInput || null;
    this.onDevices = hooks.onDevices || null;
    /** 設定を開いている間は割り当てていない入力も見る(監視・「押して追加」)。 */
    this.watchAll = false;
    /** つながっているゲームパッド [{index, id, mapping}](見つかった順ではなく番号の順)。 */
    this.devices = [];
    this.bindings = [];
    this._bound = []; // [{code, p, button}]
    this._byCode = new Map(); // 符号 → _bound の要素
    this._pads = new Map(); // 番号 → {id, held: Map(符号 → 押しているか), hatAxes: Set}
    this._capture = null; // {done}
    this._events = []; // 1 回の取得で変わった入力(使い回す。4 ms ごとに作り直さない)
    this._seen = new Set();
    this._reasons = new Set();
    this._fastTimer = 0;
    this._idleTimer = 0;
    this._listening = false;
    this._onConnect = () => this.poll();
  }

  /** 割り当て(行 → 符号の配列)。同じ符号が 2 行にあれば後の行が勝つ(キーの割り当てと同じ)。 */
  setBindings(bindings) {
    this.bindings = bindings;
    const byCode = new Map();
    bindings.forEach((codes, button) => {
      for (const code of codes || []) {
        const p = parsePadCode(code);
        if (p) byCode.set(code, { code, p, button });
      }
    });
    this._bound = [...byCode.values()];
    this._byCode = byCode;
  }

  /** 符号の行(無ければ -1)。 */
  buttonOfCode(code) {
    const b = this._byCode.get(code);
    return b ? b.button : -1;
  }

  // ---- 読む間隔 ----

  /** reason('play' / 'settings')の間、読み続ける。 */
  activate(reason) {
    this._reasons.add(reason);
    this._schedule();
  }

  deactivate(reason) {
    this._reasons.delete(reason);
    this._schedule();
  }

  get active() {
    return this._reasons.size > 0;
  }

  /** 読む間隔を今の状態に合わせる(ゲームパッドがあれば 4 ms、無ければ 250 ms、使っていなければ止める)。 */
  _schedule() {
    const on = this.active && this.supported;
    const fast = on && this.devices.length > 0;
    if (on && !this._idleTimer) this._idleTimer = setInterval(() => this.poll(), PAD_IDLE_MS);
    if (!on && this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = 0; }
    if (fast && !this._fastTimer) this._fastTimer = setInterval(() => this.poll(), PAD_POLL_MS);
    if (!fast && this._fastTimer) { clearInterval(this._fastTimer); this._fastTimer = 0; }
    if (typeof window === 'undefined') return;
    if (on && !this._listening) {
      window.addEventListener('gamepadconnected', this._onConnect);
      window.addEventListener('gamepaddisconnected', this._onConnect);
      this._listening = true;
    } else if (!on && this._listening) {
      window.removeEventListener('gamepadconnected', this._onConnect);
      window.removeEventListener('gamepaddisconnected', this._onConnect);
      this._listening = false;
    }
  }

  // ---- 読む ----

  /** ゲームパッドの今の状態を読み、変わった入力を知らせる。now は performance.now() の時刻。 */
  poll(now = performance.now()) {
    if (!this.supported) return;
    let list;
    try {
      list = this.getGamepads() || [];
    } catch (e) {
      list = []; // 権限ポリシーで止められている(SecurityError)など
    }
    const events = this._events;
    events.length = 0;
    const seen = this._seen;
    seen.clear();
    for (const pad of list) {
      if (!pad || pad.connected === false) continue;
      seen.add(pad.index);
      this._readPad(pad, now, events);
    }
    // 抜けたゲームパッド: 押していた入力を離す
    for (const [index, st] of this._pads) {
      if (seen.has(index)) continue;
      this._dropPad(index, st, now, events);
    }
    if (events.length) this._emit(events.slice());
    this._updateDevices(list);
  }

  _readPad(pad, now, events) {
    let st = this._pads.get(pad.index);
    if (st && st.id !== pad.id) {
      this._dropPad(pad.index, st, now, events); // 同じ番号に別の機器がつながった
      st = null;
    }
    if (!st) {
      st = { id: pad.id, held: new Map(), hatAxes: new Set() };
      this._pads.set(pad.index, st);
    }
    // ±1 の外の値になったことのある軸はハット(中央が範囲外)
    const axes = pad.axes || [];
    for (let i = 0; i < axes.length; i++) if (Number.isFinite(axes[i]) && Math.abs(axes[i]) > HAT_RANGE) st.hatAxes.add(i);
    const ts = padTimeStamp(pad, now);
    if (this.watchAll || this._capture) {
      for (const code of allCodes(pad, st.hatAxes)) {
        const b = this._byCode.get(code);
        this._check(st, pad, code, b ? b.p : parsePadCode(code), b ? b.button : -1, ts, events);
      }
    } else {
      for (const b of this._bound) this._check(st, pad, b.code, b.p, b.button, ts, events);
    }
  }

  /** 1 つの入力の今の状態を読み、変わっていれば events へ。初めて見た入力は今の状態を基準にする(押したまま見つかったものを押した扱いにしない)。 */
  _check(st, pad, code, p, button, ts, events) {
    const was = st.held.get(code);
    const down = codePressed(pad, p, was);
    if (was === undefined) {
      st.held.set(code, down);
      return;
    }
    if (down === was) return;
    st.held.set(code, down);
    events.push({ code, button, down, ts, index: pad.index, id: pad.id });
  }

  _dropPad(index, st, now, events) {
    for (const [code, down] of st.held) {
      if (!down) continue;
      const button = this.buttonOfCode(code);
      events.push({ code, button, down: false, ts: now, index, id: st.id });
    }
    this._pads.delete(index);
  }

  _emit(events) {
    if (!events.length) return;
    // 同じ取得の中はネック → PICK → WAIL → START(押さえとピックが同時に届いたら押さえが先)。離すのは先に
    events.sort((a, b) => {
      const ra = a.button >= 0 ? ORDER[a.button] : 9;
      const rb = b.button >= 0 ? ORDER[b.button] : 9;
      if (ra !== rb) return ra - rb;
      return (a.down ? 1 : 0) - (b.down ? 1 : 0);
    });
    const cap = this._capture;
    if (cap) {
      // 押して追加: 待ち始めてから押した最初の入力(待ち始めに押していたもの・ずっと押されているものは変化しないので来ない)。
      // 待っている間の入力は演奏へ流さない
      const ev = events.find((e) => e.down);
      if (!ev) return;
      this._capture = null;
      cap.done(ev.code, { index: ev.index, id: ev.id });
      return;
    }
    for (const ev of events) {
      if (this.onInput) this.onInput({ code: ev.code, down: ev.down, button: ev.button, index: ev.index, id: ev.id, timeStamp: ev.ts });
      if (ev.button >= 0 && this.onButton) this.onButton(ev.button, ev.down, ev.ts, PAD_HOLDER_PREFIX + ev.index + ':' + ev.code);
    }
  }

  _updateDevices(list) {
    // 変わっていなければ何も作らない(4 ms ごとに呼ばれる)
    let n = 0;
    let same = true;
    for (const pad of list) {
      if (!pad || pad.connected === false) continue;
      const d = this.devices[n++];
      if (!d || d.index !== pad.index || d.id !== pad.id) { same = false; break; }
    }
    if (same && n === this.devices.length) return;
    const next = [];
    for (const pad of list) if (pad && pad.connected !== false) next.push({ index: pad.index, id: pad.id, mapping: pad.mapping || '' });
    const key = (d) => d.index + '|' + d.id;
    const before = new Set(this.devices.map(key));
    const after = new Set(next.map(key));
    const added = next.filter((d) => !before.has(key(d))).map((d) => d.id);
    const removed = this.devices.filter((d) => !after.has(key(d))).map((d) => d.id);
    if (!added.length && !removed.length) return;
    this.devices = next;
    this._schedule(); // 1 台目が来たら 4 ms へ、最後の 1 台が抜けたら 250 ms へ
    if (this.onDevices) this.onDevices({ added, removed });
  }

  // ---- 押して追加 ----

  /**
   * 次に押した入力を 1 つ待つ(設定の割り当て欄)。待ち始めに押していた入力・押したままの入力は数えない。
   * 待っている間に届いた入力は演奏へ流さない。
   * @param {(code: string, pad: {index: number, id: string}) => void} done
   */
  startCapture(done) {
    this._capture = { done };
    // 待ち始めの状態を基準にする: 見えているゲームパッドの全部の入力を、知らせずに読み直す
    const list = (() => {
      try {
        return this.getGamepads() || [];
      } catch (e) {
        return [];
      }
    })();
    for (const pad of list) {
      if (!pad || pad.connected === false) continue;
      const st = this._pads.get(pad.index);
      if (!st || st.id !== pad.id) continue;
      for (const code of allCodes(pad, st.hatAxes)) {
        const b = this._byCode.get(code);
        st.held.set(code, codePressed(pad, b ? b.p : parsePadCode(code), st.held.get(code)));
      }
    }
  }

  cancelCapture() {
    this._capture = null;
  }

  get capturing() {
    return !!this._capture;
  }
}

/**
 * 設定の割り当て欄(KeyBindPanel)に渡す入力元。キーボードの代わりにゲームパッドの入力を待ち、符号の名前と文言を差し替える。
 * @param {GamepadInput} gamepad
 */
export function padDevice(gamepad) {
  return {
    label: padCodeLabel,
    glyph: '…',
    isAssignable: isPadCode,
    capture(onCode) {
      gamepad.startCapture((code) => onCode(code));
      return () => gamepad.cancelCapture();
    },
    // キーボードの文言のうち「キー」と書いてあるもの
    text: {
      rowLabel: 'pad.rowLabel',
      chipCapturing: 'pad.chipCapturing',
      waiting: 'pad.waiting',
      addLabel: 'pad.addLabel',
      fullLabel: 'pad.fullLabel',
      clearLabel: 'pad.clearLabel',
      fullHint: 'pad.fullHint',
      promptAdd: 'pad.promptAdd',
      promptReplace: 'pad.promptReplace',
      already: 'pad.already',
      full: 'pad.full',
      removedEmpty: 'pad.removedEmpty',
      cleared: 'pad.cleared',
      repaired: 'pad.repaired',
    },
  };
}
