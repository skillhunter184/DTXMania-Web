// 設定パネルの「電子ドラム(MIDI)」節。DTXManiaAI の CONFIG > MIDI Setup(GITADORA コナステの MIDI 設定画面の
// 移植)と MIDI Velocity ページを 1 つにまとめた Web 版。純ロジックは js/ui/midibind.js、入力は js/ui/midi.js。
//
// 元実装の行との対応(docs/spec/nx-docs.md §7 の MIDI Setup の画面):
//   MIDI Device(Enter で開き直す)    → 「電子ドラムを使う / 開き直す」ボタンとデバイス一覧
//   Preset(AUTO = 機器名で選ぶ)      → プリセットの選択 +「適用」(Apply Preset)
//   レーン行(Enter で叩いて追加登録)  → 各レーンの「＋ 叩いて追加」
//   ノート行(←→ でノート別しきい値、Delete で外す) → ノートのチップ(押すとしきい値の行が開く / × で外す)
//   MIDI Velocity(レーン別の下限)     → 各レーンの「下限」
//   打鍵モニタ                          → デバイス一覧の打鍵数・最後のノートと「入力:」の行
// Web 版の追加: 届いた打鍵の行き先レーンを光らせる(GITADORA が叩いたパッドを光らせるのと同じ役割)、
// モニタにしきい値で捨てた打鍵を「(弱)」と出す、1 段の「元に戻す」、レーン単位の「既定」「解除」。

import { LANE_NAMES } from '../core/dtx.js';
import { LANE_COUNT } from './keybind.js';
import {
  MAX_NOTES_PER_LANE, NO_THRESHOLD, MAX_VELOCITY, MIDI_PRESETS, addNote, removeNote, clearLaneNotes, resetLaneNotes,
  stepThreshold, setNoteThreshold, applyPreset, autoPreset, defaultMidiNotes, defaultVelocityMin, defaultLaneNotes,
  laneNotesText, noteName,
} from './midibind.js';

const $ = (id) => document.getElementById(id);

function button(cls, text, fk) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  if (fk) b.dataset.fk = fk; // 描き直したあとにフォーカスを戻す目印
  return b;
}

function copyNotes(notes) {
  return notes.map((lane) => lane.map((b) => ({ note: b.note, threshold: b.threshold })));
}

function noteText(note) {
  const n = noteName(note);
  return n ? `${note}(${n})` : String(note);
}

export class MidiPanel {
  /**
   * @param {{config:object, midi:import('./midi.js').MidiInput, onChange:()=>void, beforeCapture:()=>void,
   *          visible:()=>boolean}} opts
   *   onChange は config.midiNotes / midiVelocityMin を書き換えたあと(保存と MidiInput への反映)。
   *   beforeCapture は叩いて登録を始める前(キーボードの割り当て待ちを畳む)。
   */
  constructor(opts) {
    this.config = opts.config;
    this.midi = opts.midi;
    this.onChange = opts.onChange;
    this.beforeCapture = opts.beforeCapture || (() => {});
    this.visible = opts.visible || (() => true);
    this._capture = null; // 叩いて登録の待ち受け {lane, finish}
    this._undo = null; // 直前の {notes, velocityMin, lane}(1 段だけの「元に戻す」)
    this._edit = null; // しきい値の行を開いているノート {lane, note}
    this._preset = 'auto';
    this._dirty = false;
  }

  build() {
    const list = $('midi-list');
    list.textContent = '';
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const name = LANE_NAMES[lane];
      const row = document.createElement('div');
      row.className = 'key-row midi-row';
      row.dataset.lane = String(lane);
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', name + ' の MIDI 割り当て');
      const label = document.createElement('span');
      label.className = 'key-lane';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = name;
      // レーン別の下限(元実装の MIDI Velocity ページ)。描き直しでは作り直さない(入力途中を壊さないため)
      const vmin = document.createElement('label');
      vmin.className = 'midi-vmin';
      vmin.title = 'このレーンの MIDI ベロシティの下限。これ以下の強さの打鍵は捨てる(0〜127。クロストーク対策。既定は HH だけ 20)';
      vmin.append('下限 ');
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(MAX_VELOCITY);
      input.step = '1';
      input.setAttribute('aria-label', name + ' のベロシティ下限');
      input.onchange = () => this.setVelocityMin(lane, input.value);
      vmin.appendChild(input);
      const chips = document.createElement('div');
      chips.className = 'chips';
      row.append(label, vmin, chips);
      list.appendChild(row);
    }
    $('btn-midi-connect').onclick = () => this.connect();
    $('midi-preset').onchange = () => { this._preset = $('midi-preset').value; };
    $('btn-midi-apply').onclick = () => this.applyPresetSelected();
    $('midi-undo').onclick = () => this.undo();
    $('btn-midi-default').onclick = () => this.resetAll();
    this.renderAll();
    this.renderDevices();
    this.renderMonitor();
  }

  /** 見えていない間に溜まった変化(打鍵数・デバイス)を描き直す。 */
  refresh() {
    if (!this._dirty) return;
    this._dirty = false;
    this.renderDevices();
    this.renderMonitor();
  }

  _row(lane) {
    return $('midi-list').querySelector('.midi-row[data-lane="' + lane + '"]');
  }

  setStatus(text) {
    $('midi-status-text').textContent = text || '';
    $('midi-undo').hidden = !this._undo;
  }

  /**
   * MIDI の割り当てを差し替えて保存する。差し替える前の状態を「元に戻す」に積む。
   * @param {{notes?:object[][], velocityMin?:number[]}} next
   */
  commit(next, text, lane) {
    const c = this.config;
    this._undo = { notes: copyNotes(c.midiNotes), velocityMin: c.midiVelocityMin.slice(), lane: lane === undefined ? null : lane };
    if (next.notes) c.midiNotes = next.notes;
    if (next.velocityMin) c.midiVelocityMin = next.velocityMin;
    if (this._edit && !c.midiNotes[this._edit.lane].some((b) => b.note === this._edit.note)) this._edit = null;
    this.onChange();
    this.setStatus(text);
    this.renderMonitor(); // モニタの行き先は今の割り当てで引き直す
  }

  undo() {
    const u = this._undo;
    if (!u) return;
    const hadFocus = document.activeElement === $('midi-undo'); // 「元に戻す」自身が消えるので先に逃がす先を決める
    this.cancelCapture();
    this._undo = null;
    this.config.midiNotes = u.notes;
    this.config.midiVelocityMin = u.velocityMin;
    if (this._edit && !u.notes[this._edit.lane].some((b) => b.note === this._edit.note)) this._edit = null;
    this.onChange();
    this.renderAll();
    this.renderMonitor();
    if (hadFocus) {
      const row = u.lane === null ? null : this._row(u.lane);
      const target = row ? row.querySelector('[data-fk="add"]') : $('btn-midi-default');
      if (target) target.focus({ preventScroll: true });
    }
    this.setStatus('元に戻しました');
  }

  // ---- 描画 ----

  renderAll() {
    for (let lane = 0; lane < LANE_COUNT; lane++) this.renderLane(lane);
  }

  /** 1 レーン分だけ描き直す(フォーカスは data-fk で同じ役目のボタンへ戻す)。 */
  renderLane(lane) {
    const row = this._row(lane);
    if (!row) return;
    const chips = row.querySelector('.chips');
    const active = document.activeElement;
    const focusKey = active && row.contains(active) && active.dataset ? active.dataset.fk : null;
    const list = this.config.midiNotes[lane];
    const laneMin = this.config.midiVelocityMin[lane];
    const name = LANE_NAMES[lane];
    const capturing = !!this._capture && this._capture.lane === lane;
    const edit = this._edit && this._edit.lane === lane ? this._edit : null;
    chips.textContent = '';

    for (const b of list) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.note = String(b.note);
      const own = b.threshold !== NO_THRESHOLD;
      const open = !!edit && edit.note === b.note;
      const key = button('chip-key' + (open ? ' open' : ''), own ? `${b.note} >${b.threshold}` : String(b.note), 'note:' + b.note);
      key.title = (noteName(b.note) ? noteName(b.note) + '。' : '') + 'このノートだけのしきい値を変える';
      key.setAttribute('aria-expanded', open ? 'true' : 'false');
      key.setAttribute('aria-label', `${name} のノート ${noteText(b.note)}。` + (own ? `しきい値 ${b.threshold}。` : '') + '押すとしきい値を変更');
      key.onclick = () => this.toggleEdit(lane, b.note);
      const del = button('chip-del', '×', 'del:' + b.note);
      del.title = '外す';
      del.setAttribute('aria-label', `${name} からノート ${b.note} を外す`);
      del.onclick = () => this.removeNoteAt(lane, b.note);
      chip.append(key, del);
      chips.appendChild(chip);
    }
    if (!list.length) {
      const none = document.createElement('span');
      none.className = 'chip-empty';
      none.textContent = 'なし';
      chips.appendChild(none);
    }

    const full = list.length >= MAX_NOTES_PER_LANE;
    const add = button('chip-add' + (capturing ? ' listening' : '') + (full && !capturing ? ' is-full' : ''),
      capturing ? '🥁 叩いてください' : '＋ 叩いて追加', 'add');
    if (full && !capturing) add.setAttribute('aria-disabled', 'true');
    add.setAttribute('aria-label', capturing
      ? `${name} に登録するパッドを叩いてください`
      : full ? `${name} は上限の ${MAX_NOTES_PER_LANE} ノートです` : `${name} にパッドを叩いて追加 (${list.length}/${MAX_NOTES_PER_LANE})`);
    add.onclick = () => this.startCapture(lane);
    const reset = button('chip-lane-cmd', '既定', 'reset');
    reset.setAttribute('aria-label', `${name} を既定(${laneNotesText(defaultLaneNotes(lane))})に戻す`);
    reset.title = `GM ドラムマップの ${laneNotesText(defaultLaneNotes(lane))} に戻す`;
    reset.onclick = () => this.resetLane(lane);
    const clear = button('chip-lane-cmd', '解除', 'clear');
    clear.setAttribute('aria-label', `${name} の MIDI をすべて外す`);
    clear.onclick = () => this.clearLane(lane);
    chips.append(add, reset, clear);
    if (capturing) {
      const cancel = button('chip-cancel', '中止', 'cancel');
      cancel.onclick = () => this.cancelCapture('中止しました');
      chips.appendChild(cancel);
    }

    if (edit) {
      const b = list.find((x) => x.note === edit.note);
      if (b) chips.appendChild(this._detail(lane, b, laneMin));
    }

    const vmin = row.querySelector('.midi-vmin input');
    if (vmin && document.activeElement !== vmin) vmin.value = String(laneMin);

    if (focusKey) {
      // 押したボタンが消えたとき(「レーンの下限に戻す」など)は同じノートのチップ、それも無ければ「＋ 叩いて追加」へ
      const note = focusKey.indexOf(':') >= 0 ? focusKey.slice(focusKey.indexOf(':') + 1) : '';
      const target = chips.querySelector('[data-fk="' + focusKey + '"]')
        || (note && chips.querySelector('[data-fk="note:' + note + '"]'))
        || chips.querySelector('[data-fk="add"]');
      if (target) target.focus({ preventScroll: true });
    }
  }

  /** ノート別しきい値の行(元実装のノート行の ←→)。 */
  _detail(lane, b, laneMin) {
    const box = document.createElement('div');
    box.className = 'midi-detail';
    const title = document.createElement('span');
    title.textContent = `ノート ${noteText(b.note)} のしきい値`;
    const down = button('midi-step', '−', 'th-:' + b.note);
    down.setAttribute('aria-label', 'しきい値を下げる(Ctrl で 10)');
    down.onclick = (e) => this.stepThresholdAt(lane, b.note, e.ctrlKey ? -10 : -1);
    const value = document.createElement('output');
    value.className = 'midi-th';
    value.textContent = b.threshold === NO_THRESHOLD ? `> ${laneMin}(レーンの下限)` : `> ${b.threshold}`;
    const up = button('midi-step', '＋', 'th+:' + b.note);
    up.setAttribute('aria-label', 'しきい値を上げる(Ctrl で 10)');
    up.onclick = (e) => this.stepThresholdAt(lane, b.note, e.ctrlKey ? 10 : 1);
    box.append(title, down, value, up);
    if (b.threshold !== NO_THRESHOLD) {
      const back = button('chip-lane-cmd', 'レーンの下限に戻す', 'th0:' + b.note);
      back.onclick = () => this.setThresholdAt(lane, b.note, NO_THRESHOLD);
      box.appendChild(back);
    }
    const hint = document.createElement('span');
    hint.className = 'note';
    hint.textContent = 'この強さ以下の打鍵を捨てる。Ctrl+クリックで 10 ずつ。0 より下げるとレーンの下限に従う';
    box.appendChild(hint);
    return box;
  }

  /** 接続状態・デバイス一覧・プリセットの AUTO 表示(元実装の MIDI Device / Preset 行とモニタの上段)。 */
  renderDevices() {
    if (!this.visible()) { this._dirty = true; return; }
    const m = this.midi;
    const btn = $('btn-midi-connect');
    const st = $('midi-state');
    btn.hidden = m.state === 'unsupported';
    btn.disabled = m.state === 'requesting';
    let text = '';
    switch (m.state) {
      case 'unsupported':
        // Web MIDI は HTTPS か localhost でしか出てこない。serve.bat で LAN のアドレスから開くと Chrome でも無い。
        // iPhone / iPad はどのブラウザも WebKit で非対応。Web MIDI を差し込むブラウザアプリなら出てくる
        text = (globalThis.isSecureContext === false
          ? 'http の LAN アドレス(localhost 以外)で開いたページでは Web MIDI を使えません(HTTPS か localhost に限られる)。PC なら http://localhost:… で開いてください。'
          : 'このブラウザは Web MIDI に対応していません。PC の Chrome / Edge / Firefox で開いてください(Safari は非対応)。')
          + 'iPhone / iPad は Safari も Chrome も非対応なので、Web MIDI 付きのブラウザアプリ(Web MIDI Browser など)で開いてください。';
        break;
      case 'off':
        btn.textContent = '電子ドラムを使う';
        text = '未接続。押すとブラウザが MIDI 機器の使用許可を尋ねます。';
        break;
      case 'requesting':
        btn.textContent = '接続中…';
        text = 'ブラウザが MIDI 機器の使用許可を尋ねていたら「許可」を押してください。';
        break;
      case 'denied':
        btn.textContent = 'もう一度試す';
        text = 'MIDI 機器の使用が許可されていません。アドレスバー左のサイト設定で MIDI を許可してから押してください。';
        break;
      case 'error':
        btn.textContent = 'もう一度試す';
        text = 'MIDI を開けませんでした: ' + m.error;
        break;
      default: {
        btn.textContent = '開き直す';
        const found = m.devices.length;
        text = found
          ? `${m.openCount} / ${found} 台を開いています。`
          : 'MIDI 機器が見つかりません。電子ドラムをつないで電源を入れてください(つなげば自動で開きます)。';
        break;
      }
    }
    st.textContent = text;

    const ul = $('midi-devices');
    ul.textContent = '';
    m.devices.forEach((d, i) => {
      const li = document.createElement('li');
      li.className = d.opened ? '' : 'closed';
      li.textContent = `[${i + 1}] ${d.name}`
        + (d.opened ? '' : d.failed ? '(開けません。DTXMania などほかのアプリが使っていないか確認してください)' : '(開いています…)')
        + `   打鍵 ${d.hitCount}`
        + (d.lastNote < 0 ? '' : `   最後 note ${d.lastNote} vel ${d.lastVelocity}`);
      ul.appendChild(li);
    });

    // プリセットの選択肢(AUTO はつながっている機器の名前から選ぶ。元実装の Preset 行)
    const sel = $('midi-preset');
    if (sel.options.length !== MIDI_PRESETS.length + 1) {
      sel.textContent = '';
      sel.appendChild(new Option('AUTO', 'auto'));
      MIDI_PRESETS.forEach((p, i) => sel.appendChild(new Option(p.name, String(i))));
      sel.value = this._preset;
    }
    sel.options[0].textContent = `AUTO(${autoPreset(m.devices.map((d) => d.name)).name})`;
  }

  /** 打鍵モニタの「入力:」の行(元実装 RefreshMidiMonitor の下段。行き先は今の割り当てで引き直す)。 */
  renderMonitor() {
    if (!this.visible()) { this._dirty = true; return; }
    const el = $('midi-monitor');
    const hits = this.midi.recentHits;
    if (!hits.length) {
      el.textContent = '入力: (まだ届いていません)';
      return;
    }
    el.textContent = '入力: ' + hits.map((h) => {
      const c = this.midi.classify(h.note, h.velocity);
      const to = c.lane < 0 ? '--' : LANE_NAMES[c.lane] + (c.accepted ? '' : '(弱)');
      return `note ${h.note} v${h.velocity} →${to}`;
    }).join('   ');
  }

  /** MidiInput に届いたノートオン(モニタの更新と行き先レーンを光らせる)。 */
  onNote(info) {
    if (!this.visible()) { this._dirty = true; return; }
    this.renderDevices();
    this.renderMonitor();
    if (info.lane < 0 || !info.accepted) return;
    const row = this._row(info.lane);
    if (!row) return;
    row.classList.remove('row-hit');
    void row.offsetWidth; // アニメーションを頭から
    row.classList.add('row-hit');
    const chip = row.querySelector('.chip[data-note="' + info.note + '"]');
    if (chip) {
      chip.classList.remove('chip-hit');
      void chip.offsetWidth;
      chip.classList.add('chip-hit');
    }
  }

  /** 他レーンから取り上げたなどで変わった行を 1 秒だけ光らせる(キーボードの割り当てと同じ)。 */
  flashLane(lane) {
    const row = this._row(lane);
    if (!row) return;
    row.classList.remove('row-changed');
    void row.offsetWidth;
    row.classList.add('row-changed');
    setTimeout(() => row.classList.remove('row-changed'), 1000);
  }

  // ---- 操作 ----

  /** MIDI の使用許可を求めて開く(開いていれば開き直す)。 */
  async connect() {
    const ok = await this.midi.connect();
    if (ok && !this.config.midiEnabled) {
      this.config.midiEnabled = true; // 次回からは起動時に開く(許可済みならダイアログは出ない)
      this.onChange();
    }
    this.renderDevices();
    return ok;
  }

  /** 叩いて登録の待ち受けを始める(元実装の MIDI ページのレーン行 Enter)。 */
  async startCapture(lane) {
    this.cancelCapture();
    this.beforeCapture();
    const name = LANE_NAMES[lane];
    if (this.config.midiNotes[lane].length >= MAX_NOTES_PER_LANE) {
      this.setStatus(`${name} は上限の ${MAX_NOTES_PER_LANE} ノートです。× でどれか外してください。`);
      return;
    }
    if (this.midi.state !== 'ready') {
      this.setStatus('MIDI 機器を開いています…');
      if (!(await this.connect())) {
        this.setStatus('MIDI 機器を開けないため登録できません(上の表示を確認してください)。');
        return;
      }
    }

    const onKey = (e) => {
      if (e.key !== 'Escape' && e.code !== 'Escape') return; // 待ち受け中に効くキーは Esc だけ(元実装も MIDI ページは Esc のみ)
      e.preventDefault();
      e.stopPropagation();
      this.cancelCapture('中止しました');
    };
    const onOutside = (e) => { if (!$('midi-list').contains(e.target)) this.cancelCapture('中止しました'); };
    const onVisibility = () => { if (document.hidden) this.cancelCapture('中止しました'); };
    const timer = setTimeout(() => this.cancelCapture('時間切れで中止しました'), 30000);
    const finish = () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
      this.renderLane(lane);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onOutside, true);
    document.addEventListener('visibilitychange', onVisibility);
    this._capture = { lane, finish };
    this.midi.startCapture(this.config.midiVelocityMin[lane], (note, velocity) => this.applyCapture(note, velocity));
    this.renderLane(lane);
    this.setStatus(`${name} に登録するパッドを叩いてください(Esc で中止。1 打で複数のノートが届いたらいちばん強いものを登録します)`);
  }

  cancelCapture(reason) {
    const a = this._capture;
    if (!a) return;
    this._capture = null;
    this.midi.cancelCapture();
    a.finish();
    if (reason) this.setStatus(reason);
  }

  /** 待ち受け中に叩かれたノートを登録する。 */
  applyCapture(note, velocity) {
    const a = this._capture;
    if (!a) return;
    const lane = a.lane;
    const name = LANE_NAMES[lane];
    const r = addNote(this.config.midiNotes, lane, note);
    if (!r.ok) {
      this.cancelCapture(r.reason === 'already'
        ? `ノート ${noteText(note)} は ${name} に登録済みです(v${velocity} で届きました)`
        : r.reason === 'full' ? `${name} は上限の ${MAX_NOTES_PER_LANE} ノートです。` : `ノート ${note} は登録できません。`);
      return;
    }
    const other = r.stolenFrom;
    let text = `${name} にノート ${noteText(note)} を登録しました(v${velocity}、${r.notes[lane].length}/${MAX_NOTES_PER_LANE})`;
    if (other !== null) {
      text += `。${LANE_NAMES[other]} から移しました`;
      if (r.stolenEmptied) text += `(${LANE_NAMES[other]} は割り当てなしになりました)`;
    }
    this.commit({ notes: r.notes }, text, lane);
    this.cancelCapture(); // finish() が lane を描き直す
    if (other !== null) { this.renderLane(other); this.flashLane(other); }
    const add = this._row(lane).querySelector('[data-fk="add"]');
    if (add) add.focus({ preventScroll: true }); // 続けてもう 1 個登録できるように
  }

  removeNoteAt(lane, note) {
    this.cancelCapture();
    const r = removeNote(this.config.midiNotes, lane, note);
    if (!r.ok) return;
    const name = LANE_NAMES[lane];
    this.commit({ notes: r.notes }, r.emptied
      ? `${name} からノート ${note} を外しました。${name} は MIDI の割り当てなしです(既定には戻りません)。`
      : `${name} からノート ${note} を外しました`, lane);
    this.renderLane(lane);
  }

  resetLane(lane) {
    this.cancelCapture();
    const r = resetLaneNotes(this.config.midiNotes, lane);
    const name = LANE_NAMES[lane];
    let text = `${name} を既定(${laneNotesText(r.notes[lane])})に戻しました`;
    const stolen = r.stolenFrom.filter((l) => l !== lane);
    if (stolen.length) text += `。${stolen.map((l) => LANE_NAMES[l]).join(' / ')} から取り上げました`;
    const emptied = r.stolenEmptied.filter((l) => l !== lane);
    if (emptied.length) text += `(${emptied.map((l) => LANE_NAMES[l]).join(' / ')} は割り当てなしになりました)`;
    this.commit({ notes: r.notes }, text, lane);
    this.renderLane(lane);
    for (const l of stolen) { this.renderLane(l); this.flashLane(l); }
  }

  clearLane(lane) {
    this.cancelCapture();
    const r = clearLaneNotes(this.config.midiNotes, lane);
    this.commit({ notes: r.notes }, `${LANE_NAMES[lane]} の MIDI をすべて外しました(既定には戻りません)`, lane);
    this.renderLane(lane);
  }

  resetAll() {
    this.cancelCapture();
    this.commit({ notes: defaultMidiNotes(), velocityMin: defaultVelocityMin() },
      '全レーンを既定(GM ドラムマップ。下限は HH だけ 20)に戻しました');
    this.renderAll();
  }

  /** 選んでいるプリセットを流し込む(元実装の Apply Preset)。 */
  applyPresetSelected() {
    this.cancelCapture();
    const p = this._preset === 'auto'
      ? autoPreset(this.midi.devices.map((d) => d.name))
      : MIDI_PRESETS[Number(this._preset)] || MIDI_PRESETS[0];
    const r = applyPreset(this.config.midiNotes, p);
    this.commit({ notes: r.notes },
      `プリセット「${p.name}」を適用しました。キーボードの割り当てはそのままです。`
      + 'RD は空になります(RD のチップは打ち分けの CY グループを「共通」にすると CY のパッドで叩けます)。');
    this.renderAll();
    for (let lane = 0; lane < LANE_COUNT; lane++) this.flashLane(lane);
  }

  setVelocityMin(lane, raw) {
    const v = Math.round(Number(raw));
    const prev = this.config.midiVelocityMin[lane];
    if (raw === '' || !Number.isFinite(v)) { this.renderLane(lane); return; } // 空欄は元の値に戻す
    const clamped = Math.max(0, Math.min(MAX_VELOCITY, v));
    if (clamped === prev) { this.renderLane(lane); return; }
    const next = this.config.midiVelocityMin.slice();
    next[lane] = clamped;
    this.commit({ velocityMin: next }, `${LANE_NAMES[lane]} の下限を ${clamped} にしました(${clamped} 以下の強さの打鍵を捨てます)`, lane);
    const input = this._row(lane).querySelector('.midi-vmin input');
    if (input) input.value = String(clamped);
    this.renderLane(lane); // 開いているしきい値の行の「(レーンの下限)」も変わる
  }

  toggleEdit(lane, note) {
    const prev = this._edit;
    this._edit = prev && prev.lane === lane && prev.note === note ? null : { lane, note };
    if (prev && prev.lane !== lane) this.renderLane(prev.lane);
    this.renderLane(lane);
  }

  stepThresholdAt(lane, note, dir) {
    const b = this.config.midiNotes[lane].find((x) => x.note === note);
    if (!b) return;
    this.setThresholdAt(lane, note, stepThreshold(b.threshold, dir, this.config.midiVelocityMin[lane]));
  }

  setThresholdAt(lane, note, threshold) {
    const b = this.config.midiNotes[lane].find((x) => x.note === note);
    if (!b || b.threshold === threshold) return;
    const r = setNoteThreshold(this.config.midiNotes, lane, note, threshold);
    if (!r.ok) return;
    this.commit({ notes: r.notes }, threshold === NO_THRESHOLD
      ? `ノート ${note} はレーンの下限(${this.config.midiVelocityMin[lane]})に従います`
      : `ノート ${note} は強さ ${threshold} 以下を捨てます`, lane);
    this.renderLane(lane);
  }
}
