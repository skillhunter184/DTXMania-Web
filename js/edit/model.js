// 譜面の編集のモデル: DtxDoc 1 つから作る読み取り専用の見方(チップの一覧・列ごとの索引・時刻)。
// 文書が変わったら作り直す(EditSession が文書ごとに 1 つ持つ)。編集の操作は js/edit/ops.js。

import { parseDTX, replayRandom, parseHex, TICKS_PER_MEASURE } from '../core/dtx.js';
import { MAX_MEASURE } from './dtxdoc.js';
import { MeasureGeometry, posOf } from './geometry.js';
import { COLUMN_COUNT, COLUMN_OF, TYPE_OF, COLUMN_TYPES, isEditableChannel } from './lanes.js';

/** 値が #WAV の番号でないチャンネル(小節長・BPM・フィルイン・拍線の制御)。 */
// #WAV の番号でないチャンネル(小節長・BPM・フィルイン・小節線の表示、BGA / 動画(#BMP / #AVI の番号)、ボーナスの印(レーン + 1)、小節線・拍線)
const NON_WAV_CHANNELS = new Set([0x02, 0x03, 0x08, 0x53, 0xc1, 0xc2, 0x04, 0x07, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x60, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51]);
const CH_BGM = 0x01;
/** 編集画面に何かの形で出すチャンネル(BGM・小節長・BPM・フィルイン・ボーナスの印)。 */
const SHOWN_OTHER = new Set([0x01, 0x02, 0x03, 0x08, 0x53, 0x4c, 0x4d, 0x4e, 0x4f]);
const CH_BPM = 0x03;
const CH_BPM_EX = 0x08;
const CH_FILL = 0x53;

/**
 * @typedef {Object} EditChip
 * @property {string} key 文書の中での名前 `${measure}.${channel}.${tick}.${value}.${n}`(n は同じ tick・値の何個目か)
 * @property {number} measure
 * @property {number} tick
 * @property {number} channel
 * @property {string} value
 * @property {number} n
 * @property {number} column 0..8
 * @property {number} type 列の中の種類(0 / 1)
 * @property {number} u 縦の位置(geometry.js)
 * @property {number} pos リードイン込みの tick
 * @property {boolean} locked #IF の中(編集できない)
 * @property {boolean} active #IF の中なら、表示している分岐か
 * @property {boolean} bonus ボーナスチップ(0x4C〜0x4F)の印
 * @property {number} dup 同じ tick・値・チャンネルのチップの数(2 以上なら ×n)
 * @property {number} half 同じセルに列のもう一方の種類もあるとき 1(左)/ 2(右)、無ければ 0
 */

export function chipKey(measure, channel, tick, value, n) {
  return `${measure}.${channel}.${tick}.${value}.${n}`;
}

/** u の順の配列で、u >= v となる最初の添字。 */
export function lowerBoundU(list, v) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].u < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class EditModel {
  /**
   * @param {import('./dtxdoc.js').DtxDoc} doc
   * @param {{rolls?: number[], path?: string, dir?: string}} [opts]
   */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.rolls = opts.rolls || [];
    this.path = opts.path || '';
    this.dir = opts.dir || '';
    this._chart = null;
    this._geo = null;
    this._built = false;
  }

  /** parseDTX の結果(表示している分岐。path / dir 付き)。 */
  get chart() {
    if (!this._chart) {
      const c = parseDTX(this.doc.text, { random: replayRandom(this.rolls) });
      c.path = this.path;
      c.dir = this.dir;
      this._chart = c;
    }
    return this._chart;
  }

  get geometry() {
    if (!this._geo) this._geo = new MeasureGeometry(this.chart.tempoMap);
    return this._geo;
  }

  /** 表示・スクロールする最後の小節(データのある最後の小節 + 16。999 まで)。 */
  get endMeasure() {
    return Math.min(MAX_MEASURE, Math.max(this.doc.index.maxMeasure, 0) + 16);
  }

  /** 小節の長さ(4/4 = 1)。 */
  lengthOf(m) {
    return this.geometry.len(m);
  }

  // ---- チップの一覧(初めて引いたときに作る) ----

  _build() {
    if (this._built) return;
    this._built = true;
    const geo = this.geometry;
    const chart = this.chart;
    const bonusSet = new Set();
    for (const n of chart.notes) if (n.bonus) bonusSet.add(`${n.measure}.${n.tick}.${n.channel}`);

    /** @type {EditChip[]} */
    const chips = [];
    const byKey = new Map();
    const hidden = [];
    const bgm = [];
    const fills = [];
    const bpmMarks = [];
    const valueCounts = new Map(); // チャンネル → (値 → 数)(ペンの初期値)
    const channelCounts = new Map(); // チャンネル → 数(列の種類の初期値)
    const used = new Set(); // 使われている #WAV の番号
    const uses = new Map(); // #WAV の番号 → 使っているチップの数(#IF の中も。音源の一覧)
    let other = 0; // 編集画面に出さないチップの数(SE・ギター / ベース・BGA など。#IF の外)
    const use = (v) => {
      used.add(v);
      uses.set(v, (uses.get(v) || 0) + 1);
    };
    const count = (ch, v) => {
      let m = valueCounts.get(ch);
      if (!m) valueCounts.set(ch, (m = new Map()));
      m.set(v, (m.get(v) || 0) + 1);
      channelCounts.set(ch, (channelCounts.get(ch) || 0) + 1);
    };
    const baseBpm = chart.baseBpm || 0;
    const bpmOf = (ch, value) => (ch === CH_BPM ? baseBpm + parseHex(value) : chart.bpmDefs.has(value) ? baseBpm + chart.bpmDefs.get(value) : null);

    const pushChips = (measure, channel, list, locked, active) => {
      const seen = new Map(); // `${tick}.${value}` → 何個目
      const dupCount = new Map();
      for (const c of list) {
        const k = c.tick + '.' + c.value;
        dupCount.set(k, (dupCount.get(k) || 0) + 1);
      }
      for (const c of list) {
        const k = c.tick + '.' + c.value;
        const n = seen.get(k) || 0;
        seen.set(k, n + 1);
        const chip = {
          key: (locked ? 'L' : '') + chipKey(measure, channel, c.tick, c.value, n),
          measure, tick: c.tick, channel, value: c.value, n,
          column: COLUMN_OF.get(channel), type: TYPE_OF.get(channel),
          u: geo.u(measure, c.tick), pos: posOf(measure, c.tick),
          locked, active, bonus: !locked && bonusSet.has(`${measure}.${c.tick}.${channel}`),
          dup: dupCount.get(k), half: 0,
        };
        chips.push(chip);
        if (!locked) byKey.set(chip.key, chip);
        if (!locked || active) count(channel, c.value);
      }
    };

    for (const g of this.doc.index.groups.values()) {
      const { measure, channel } = g;
      if (!NON_WAV_CHANNELS.has(channel)) for (const c of g.chips) use(c.value);
      if (!isEditableChannel(channel) && !SHOWN_OTHER.has(channel) && !(channel >= 0x31 && channel <= 0x3c)) other += g.chips.length;
      if (isEditableChannel(channel)) pushChips(measure, channel, g.chips, false, true);
      else if (channel >= 0x31 && channel <= 0x3c && COLUMN_OF.has(channel - 0x20)) {
        for (const c of g.chips) hidden.push({ measure, tick: c.tick, channel, column: COLUMN_OF.get(channel - 0x20), u: geo.u(measure, c.tick) });
      } else if (channel === CH_BGM) {
        for (const c of g.chips) bgm.push({ measure, tick: c.tick, value: c.value, u: geo.u(measure, c.tick) });
      } else if (channel === CH_FILL) {
        for (const c of g.chips) fills.push({ measure, tick: c.tick, value: c.value, u: geo.u(measure, c.tick) });
      } else if (channel === CH_BPM || channel === CH_BPM_EX) {
        const seen = new Map();
        for (const c of g.chips) {
          const k = c.tick + '.' + c.value;
          const n = seen.get(k) || 0;
          seen.set(k, n + 1);
          bpmMarks.push({
            key: chipKey(measure, channel, c.tick, c.value, n), measure, tick: c.tick, channel, value: c.value, n,
            bpm: bpmOf(channel, c.value), u: geo.u(measure, c.tick), locked: false, active: true,
          });
        }
      }
    }
    this._locked = this.doc.locked(replayRandom(this.rolls));
    for (const l of this._locked) {
      if (!NON_WAV_CHANNELS.has(l.channel)) for (const c of l.chips) use(c.value);
      if (isEditableChannel(l.channel)) pushChips(l.measure, l.channel, l.chips, true, l.active);
      else if ((l.channel === CH_BPM || l.channel === CH_BPM_EX) && l.active) {
        for (const c of l.chips) {
          bpmMarks.push({ key: 'L' + chipKey(l.measure, l.channel, c.tick, c.value, 0), measure: l.measure, tick: c.tick, channel: l.channel, value: c.value, n: 0, bpm: bpmOf(l.channel, c.value), u: geo.u(l.measure, c.tick), locked: true, active: true });
        }
      }
    }
    for (const h of this.doc.index.headers) if (/^WAV[0-9A-Z]{2}$/.test(h.cmd)) used.add(h.cmd.slice(3));
    for (const cmd of this.doc.index.ifCmds) if (/^WAV[0-9A-Z]{2}$/.test(cmd)) used.add(cmd.slice(3));

    const byU = (a, b) => a.u - b.u || a.channel - b.channel;
    chips.sort(byU);
    // 同じセルに列の 2 種類があれば左右に分けて描く(LP+LBD・CY+RD。HHC+HHO はファイルにあれば)
    const cell = new Map();
    for (const c of chips) {
      if (c.locked && !c.active) continue;
      const k = `${c.column}.${c.measure}.${c.tick}`;
      let s = cell.get(k);
      if (!s) cell.set(k, (s = new Set()));
      s.add(c.type);
    }
    for (const c of chips) {
      if (COLUMN_TYPES[c.column].length < 2 || (c.locked && !c.active)) continue;
      const s = cell.get(`${c.column}.${c.measure}.${c.tick}`);
      if (s && s.size > 1) c.half = c.type + 1;
    }
    const byColumn = Array.from({ length: COLUMN_COUNT }, () => []);
    for (const c of chips) byColumn[c.column].push(c);
    hidden.sort(byU);
    bgm.sort(byU);
    fills.sort(byU);
    bpmMarks.sort(byU);

    this._chips = chips;
    this._byKey = byKey;
    this._byColumn = byColumn;
    this._hidden = hidden;
    this._bgm = bgm;
    this._fills = fills;
    this._bpmMarks = bpmMarks;
    this._valueCounts = valueCounts;
    this._channelCounts = channelCounts;
    this._used = used;
    this._uses = uses;
    this._other = other;
  }

  /** すべてのドラムのチップ(編集できるものと #IF の中のもの。u の順)。 */
  get chips() { this._build(); return this._chips; }
  /** 列ごとのチップ(u の順)。 */
  get byColumn() { this._build(); return this._byColumn; }
  get hidden() { this._build(); return this._hidden; }
  get bgm() { this._build(); return this._bgm; }
  get fills() { this._build(); return this._fills; }
  get bpmMarks() { this._build(); return this._bpmMarks; }
  get valueCounts() { this._build(); return this._valueCounts; }
  get channelCounts() { this._build(); return this._channelCounts; }
  /** 使われている・定義されている #WAV の番号。 */
  get usedIds() { this._build(); return this._used; }
  /** #WAV の番号 → 使っているチップの数。 */
  get wavUses() { this._build(); return this._uses; }
  /** 編集画面に出さないチップの数(SE・ギター / ベース・BGA など。そのまま残る)。 */
  get otherChips() { this._build(); return this._other; }

  /** 編集できるチップを名前で引く。 */
  chip(key) {
    this._build();
    return this._byKey.get(key) || null;
  }

  /** 編集できる BPM の印を名前で引く(#IF の中は null)。 */
  bpmMark(key) {
    this._build();
    if (!this._bpmByKey) this._bpmByKey = new Map(this._bpmMarks.filter((b) => !b.locked).map((b) => [b.key, b]));
    return this._bpmByKey.get(key) || null;
  }

  /** 名前がチップか BPM の印か('chip' / 'bpm' / null)。 */
  kindOf(key) {
    return this.chip(key) ? 'chip' : this.bpmMark(key) ? 'bpm' : null;
  }

  /**
   * 列 col で u に最も近い編集できるチップ(|Δu| <= tolU)。half(1 / 2)を渡すと、左右に分けたセルではその側だけ。
   * 同じ距離なら u の小さい方(描く順で上に来る方)。
   */
  chipAt(col, u, tolU, half = 0) {
    const list = this.byColumn[col];
    if (!list) return null;
    let i = lowerBoundU(list, u - tolU);
    let best = null;
    let bestD = Infinity;
    for (; i < list.length && list[i].u <= u + tolU; i++) {
      const c = list[i];
      if (c.locked) continue;
      if (half && c.half && c.half !== half) continue;
      const d = Math.abs(c.u - u);
      if (d < bestD - 1e-12) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  /** 列 col の (measure, tick) のチップ(#IF の中で表示していない分岐は除く)。 */
  cellChips(col, measure, tick) {
    const list = this.byColumn[col];
    if (!list) return [];
    const u = this.geometry.u(measure, tick);
    const out = [];
    for (let i = lowerBoundU(list, u - 1e-9); i < list.length && list[i].u <= u + 1e-9; i++) {
      const c = list[i];
      if (c.measure === measure && c.tick === tick && (!c.locked || c.active)) out.push(c);
    }
    return out;
  }

  /** 列 col0..col1 で u0..u1 にある編集できるチップ。 */
  chipsInRect(col0, col1, u0, u1) {
    const out = [];
    for (let col = Math.max(0, col0); col <= Math.min(COLUMN_COUNT - 1, col1); col++) {
      const list = this.byColumn[col];
      for (let i = lowerBoundU(list, u0); i < list.length && list[i].u <= u1; i++) if (!list[i].locked) out.push(list[i]);
    }
    return out;
  }

  /** #WAV の定義 [{id, file, label, line, redefined}](ファイルの順。#IF の外)。 */
  get wavList() {
    if (this._wavs) return this._wavs;
    const { headers, headerCounts } = this.doc.index;
    const out = [];
    for (const h of headers) {
      if (!/^WAV[0-9A-Z]{2}$/.test(h.cmd)) continue;
      const text = this.doc.lines[h.idx].text;
      const semi = text.indexOf(';');
      out.push({ id: h.cmd.slice(3), file: h.param, label: semi >= 0 ? text.slice(semi + 1).trim() : '', line: h.idx, redefined: headerCounts.get(h.cmd) > 1 });
    }
    this._wavs = out;
    return out;
  }

  /** 番号 → #WAV のファイル(最後の定義。parseDTX と同じ)。 */
  wavFile(id) {
    return this.chart.wavDefs.get(id) || '';
  }

  /** 位置 pos の BPM(テンポ表から)。 */
  bpmAtPos(pos) {
    const map = this.chart.tempoMap;
    let seg = map[0];
    for (const s of map) {
      if (s.pos <= pos) seg = s;
      else break;
    }
    return seg ? seg.bpm : this.chart.bpm;
  }

  /** (measure, tick) の位置 pos。 */
  pos(measure, tick) {
    return posOf(measure, tick);
  }

  /** 小節 m の 1 拍目からの拍(1 始まり)と tick。 */
  beatOf(measure, tick) {
    return { beat: Math.floor((this.lengthOf(measure) * tick * 4) / TICKS_PER_MEASURE + 1e-9) + 1, tick };
  }
}
