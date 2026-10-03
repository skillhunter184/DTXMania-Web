// Web MIDI 入力(電子ドラム)。DTXManiaAI Input/MidiInput.cs(NX CInputMIDI / CInputManager の移植)を
// Web MIDI API に置き換えたもの。割り当ての純ロジックは js/ui/midibind.js。仕様は docs/spec/nx-docs.md §7:
//   ・見つかった入力デバイスを全部開いて全部から受ける(1 台に絞らない)
//   ・ノートオン(0x9n、チャンネル不問)かつベロシティ != 0 だけを打鍵にする(ベロシティ 0 はノートオフ)
//   ・ベロシティがしきい値「以下」なら捨てる(ノート別しきい値、無ければレーン別の下限)
//   ・同じレーンへの打鍵が 1 フレーム(約 16 ms)の中に重なったら 1 打にまとめる
//   ・ベロシティは音量に使わない(NX も使わない)
//
// 元実装との違い:
//   ・元実装は winmm のコールバックをフレーム先頭でまとめて読み、判定はフレーム時刻で行う。こちらは
//     MIDIMessageEvent.timeStamp(performance.now と同じ時間軸)をそのまま打鍵時刻にする。キーボードの
//     event.timeStamp と同じ扱いで、判定はフレームの刻みに依らない(Player.hit の説明を参照)。
//   ・そのため「1 フレーム以内は 1 打」はフレームの境界ではなく、そのレーンで最後に通した打鍵からの時間で切る
//     (MIDI_MERGE_MS)。1 打で同じレーンの 2 ノートが届くパッド(ヘッドとリム等)や二度鳴りを 1 打にする役目は同じ。
//   ・抜き差しは Web MIDI の statechange で拾う(元実装は設定画面の MIDI Device 行で開き直す)。
//     他のアプリが使っていて開けなかった機器のために「開き直す」(rescan)も残す。

import { LANE_COUNT } from './keybind.js';
import { NO_THRESHOLD, defaultVelocityMin, effectiveThreshold, passesThreshold } from './midibind.js';

/** 同じレーンへの打鍵を 1 打にまとめる幅(ms)。元実装の 1 フレーム(60 fps)に合わせる。叩いて登録の集計幅も同じ。 */
export const MIDI_MERGE_MS = 16;

/** 打鍵モニタに残す数(元実装 MidiInput.RecentHitCount)。 */
export const RECENT_HIT_COUNT = 6;

/** このブラウザで Web MIDI が使えるか(Safari は非対応)。 */
export function midiSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

/**
 * MIDI メッセージ 1 個をノートオンとして読む(NX tメッセージからMIDI信号のみ受信 と同じ判定)。
 * ノートオン以外とベロシティ 0(ランニングステータスのノートオフ)は null。
 * @param {ArrayLike<number>} data
 */
export function parseNoteOn(data) {
  if (!data || data.length < 3) return null;
  if ((data[0] & 0xf0) !== 0x90) return null;
  const velocity = data[2] & 0x7f;
  if (velocity === 0) return null;
  return { note: data[1] & 0x7f, velocity, channel: data[0] & 0x0f };
}

/** 打鍵時刻。届かない / 時間軸がおかしい値(1 秒以上ずれる)なら今の時刻で代用する。 */
function sanitizeTimeStamp(ts) {
  const now = performance.now();
  return typeof ts === 'number' && ts > 0 && Math.abs(ts - now) < 1000 ? ts : now;
}

export class MidiInput {
  /**
   * @param {{
   *   onHit?:(lane:number, timeStampMs:number, velocity:number, note:number)=>void,
   *   onNote?:(info:object)=>void,
   *   onDevices?:(change:{added:string[], removed:string[]})=>void,
   * }} hooks
   *   onHit は判定に流す打鍵(しきい値を通り、まとめた後)。onNote は届いたノートオン全部(モニタ用)。
   *   onDevices はデバイスの増減・開閉と接続状態(state)の変化。
   */
  constructor(hooks = {}) {
    this.onHit = hooks.onHit || null;
    this.onNote = hooks.onNote || null;
    this.onDevices = hooks.onDevices || null;
    /** @type {'off'|'unsupported'|'requesting'|'ready'|'denied'|'error'} */
    this.state = midiSupported() ? 'off' : 'unsupported';
    this.error = '';
    this.access = null;
    /**
     * 見つかった入力デバイス(元実装 MidiInput.Devices)。開けなかったものも含む。
     * @type {{id:string, name:string, opened:boolean, failed:boolean, hitCount:number, lastNote:number, lastVelocity:number}[]}
     */
    this.devices = [];
    /** 直近の打鍵(新しいものが先頭。元実装 RecentHits)。 */
    this.recentHits = [];
    this._noteMap = new Map(); // note → {lane, threshold}
    this._velocityMin = defaultVelocityMin();
    this._lastLaneHit = new Array(LANE_COUNT).fill(-Infinity);
    this._capture = null;
    this._ports = new Map(); // id → MIDIInput(ハンドラを張ったもの)
  }

  /**
   * 割り当てを差し替える。
   * @param {{note:number, threshold:number}[][]} notes レーン → ノート
   * @param {number[]} velocityMin レーン別の下限
   */
  setBindings(notes, velocityMin) {
    this._noteMap.clear();
    // 同じノートが複数レーンにあるときは若いレーンが勝つ(設定 UI 側で重複しないようにしてある)
    for (let lane = 0; lane < notes.length; lane++) {
      for (const b of notes[lane] || []) if (!this._noteMap.has(b.note)) this._noteMap.set(b.note, { lane, threshold: b.threshold });
    }
    this._velocityMin = velocityMin.slice();
  }

  /** ノートが割り当てられたレーン(無ければ -1)。 */
  laneOfNote(note) {
    const b = this._noteMap.get(note);
    return b ? b.lane : -1;
  }

  /**
   * ノートとベロシティから行き先を決める。
   * @returns {{lane:number, threshold:number, accepted:boolean}} lane=-1 は未割り当て
   */
  classify(note, velocity) {
    const b = this._noteMap.get(note);
    if (!b) return { lane: -1, threshold: NO_THRESHOLD, accepted: false };
    const threshold = effectiveThreshold(b, this._velocityMin[b.lane] || 0);
    return { lane: b.lane, threshold, accepted: passesThreshold(velocity, threshold) };
  }

  get openCount() {
    return this.devices.filter((d) => d.opened).length;
  }

  /**
   * MIDI の使用許可を求めてデバイスを開く。既に許可済みなら開き直す(rescan)。
   * Chrome は初回に許可を尋ねるので、ユーザー操作(ボタン)から呼ぶ。
   * @returns {Promise<boolean>} 使える状態になったら true
   */
  async connect() {
    if (!midiSupported()) {
      this.state = 'unsupported';
      this._notify();
      return false;
    }
    if (this.access) {
      this.rescan();
      return true;
    }
    if (this._connecting) return this._connecting;
    this.state = 'requesting';
    this.error = '';
    this._notify();
    this._connecting = (async () => {
      try {
        const access = await navigator.requestMIDIAccess({ sysex: false });
        this.access = access;
        access.onstatechange = (e) => { if (e.port && e.port.type === 'input') this.rescan(); };
        this.state = 'ready';
        this.rescan();
        return true;
      } catch (e) {
        const name = e && e.name;
        this.state = name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error';
        this.error = (e && e.message) || String(e);
        this._notify();
        return false;
      } finally {
        this._connecting = null;
      }
    })();
    return this._connecting;
  }

  /**
   * 今つながっている入力を全部開いて一覧を作り直す(元実装 MidiInput.Rescan)。
   * 打鍵数などはデバイスの id ごとに引き継ぐ。
   */
  rescan() {
    if (!this.access) return;
    const before = new Map(this.devices.map((d) => [d.id, d]));
    const next = [];
    const seen = new Set();
    // forEach で集める。iPad 向けの Web MIDI 付きブラウザアプリ(Web MIDI Browser)の互換実装は
    // values() が for...of で回せない独自のイテレータを返す。forEach は標準の MIDIInputMap にもある
    const inputs = [];
    this.access.inputs.forEach((input) => inputs.push(input));
    for (const input of inputs) {
      if (input.state === 'disconnected') continue;
      seen.add(input.id);
      const d = before.get(input.id) || {
        id: input.id, name: input.name || 'MIDI In', opened: false, failed: false, hitCount: 0, lastNote: -1, lastVelocity: 0,
      };
      d.name = input.name || d.name;
      if (this._ports.get(input.id) !== input) {
        input.onmidimessage = (e) => this.handleMessage(e.data, e.timeStamp, input.id);
        this._ports.set(input.id, input);
      }
      d.opened = input.connection === 'open';
      if (!d.opened && !d.opening) {
        // 他のアプリ(DTXMania 本体や DAW)が専有していると開けない。理由は一覧に出す
        d.opening = true;
        input.open().then(() => {
          d.opening = false;
          d.failed = false;
          d.opened = input.connection === 'open';
          this._notify();
        }, () => {
          d.opening = false;
          d.failed = true;
          d.opened = false;
          this._notify();
        });
      }
      next.push(d);
    }
    for (const id of [...this._ports.keys()]) {
      if (seen.has(id)) continue;
      this._ports.get(id).onmidimessage = null;
      this._ports.delete(id);
    }
    const added = next.filter((d) => !before.has(d.id)).map((d) => d.name);
    const removed = this.devices.filter((d) => !seen.has(d.id)).map((d) => d.name);
    this.devices = next;
    this._notify({ added, removed });
  }

  /**
   * MIDI メッセージ 1 個(onmidimessage の中身。テストからも直接呼ぶ)。
   * @param {ArrayLike<number>} data
   * @param {number} timeStamp performance.now 時間軸
   * @param {string} [deviceId]
   */
  handleMessage(data, timeStamp, deviceId) {
    const m = parseNoteOn(data);
    if (!m) return;
    const ts = sanitizeTimeStamp(timeStamp);
    const deviceIndex = this.devices.findIndex((d) => d.id === deviceId);
    if (deviceIndex >= 0) {
      const d = this.devices[deviceIndex];
      d.hitCount++;
      d.lastNote = m.note;
      d.lastVelocity = m.velocity;
    }
    this.recentHits.unshift({ device: deviceIndex, note: m.note, velocity: m.velocity, time: ts });
    if (this.recentHits.length > RECENT_HIT_COUNT) this.recentHits.length = RECENT_HIT_COUNT;

    const c = this.classify(m.note, m.velocity);
    let merged = false;
    if (this._capture) {
      this._gather(m);
    } else if (c.accepted) {
      // 同じレーンの打鍵がまとめ幅の中に重なったら 1 打にする(元実装はフレーム内で 1 打)。
      // 届く順が前後しても(複数デバイス)同じ扱いにするため差の絶対値で見る
      if (Math.abs(ts - this._lastLaneHit[c.lane]) < MIDI_MERGE_MS) {
        merged = true;
      } else {
        this._lastLaneHit[c.lane] = ts;
        if (this.onHit) this.onHit(c.lane, ts, m.velocity, m.note);
      }
    }
    if (this.onNote) this.onNote({ device: deviceIndex, note: m.note, velocity: m.velocity, lane: c.lane, accepted: c.accepted, merged, timeStamp: ts });
  }

  // ---- 叩いて登録(元実装 ConfigStage の MIDI ページのキャプチャ) ----

  get capturing() {
    return !!this._capture;
  }

  /**
   * 次に叩かれたパッドのノートを返す待ち受けを始める。待ち受け中の打鍵は判定(onHit)に流さない。
   * 1 打で複数ノートが届く(クロストーク / リムつきパッド)ことがあるので、最初の打鍵から MIDI_MERGE_MS の間に
   * 届いたうちいちばん強いノートを採る(元実装 StrongestHitNote。あちらは 1 フレームぶん)。
   * velocityMin 以下の打鍵は数えない(登録先レーンの下限。弱いクロストークを拾わない)。
   * @param {number} velocityMin
   * @param {(note:number, velocity:number)=>void} done
   */
  startCapture(velocityMin, done) {
    this.cancelCapture();
    this._capture = { velocityMin, done, best: null, timer: 0 };
  }

  cancelCapture() {
    const c = this._capture;
    if (!c) return;
    clearTimeout(c.timer);
    this._capture = null;
  }

  _gather(m) {
    const c = this._capture;
    if (!passesThreshold(m.velocity, c.velocityMin)) return;
    if (!c.best || m.velocity > c.best.velocity) c.best = { note: m.note, velocity: m.velocity };
    if (!c.timer) c.timer = setTimeout(() => this._finishCapture(), MIDI_MERGE_MS);
  }

  _finishCapture() {
    const c = this._capture;
    if (!c) return;
    clearTimeout(c.timer);
    this._capture = null;
    if (c.best) c.done(c.best.note, c.best.velocity);
  }

  _notify(change) {
    if (this.onDevices) this.onDevices(change || { added: [], removed: [] });
  }
}
