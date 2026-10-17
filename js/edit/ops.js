// 譜面の編集の操作。どれも EditModel(と引数)から新しい DtxDoc を作って返す(文書は変えない)。
// 変えた (小節, チャンネル) の組だけを doc.withGroups に渡すので、ほかの行はバイト列ごと残る(js/edit/dtxdoc.js)。
// 失敗は EditError(code) で知らせる(文言は js/edit/editor.js が code から引く)。
//
// 置き方の規則(docs/spec/chart-editor.md):
// - ぶつかるのは同じセルの同じチャンネルと HHC↔HHO だけ(js/edit/lanes.js)。置くと、ぶつかるチップは消える
//   (DTXCreator の置き換え。vid2dtx は置かずに終わる)。同じチャンネル・同じ値のチップがあれば何もしない
// - #IF の中で表示している分岐のチップとぶつかるなら置かない(EditError('locked'))
// - 999 小節より後ろには書かない(EditError('measureLimit'))

import { TICKS_PER_MEASURE, toBase36, tryParseBpm, parseHex } from '../core/dtx.js';
import { groupKey, MAX_MEASURE, formatBarLength } from './dtxdoc.js';
import { chipKey } from './model.js';
import { COLUMN_TYPES, COLUMN_COUNT, channelsConflict, otherType, laneOfChannel, isEditableChannel } from './lanes.js';

export class EditError extends Error {
  /**
   * @param {string} code 例 'measureLimit' / 'locked'
   * @param {object} [vars]
   */
  constructor(code, vars = {}) {
    super(code);
    this.code = code;
    this.vars = vars;
  }
}

/** 組ごとの書き換えをまとめる(変えた組だけを最後に withGroups へ渡す)。 */
export class GroupEdit {
  constructor(doc) {
    this.doc = doc;
    /** @type {Map<number, {measure:number, channel:number, items:{tick:number, value:string, removed:boolean, added:boolean}[], dirty:boolean}>} */
    this.groups = new Map();
  }

  _g(measure, channel) {
    const k = groupKey(measure, channel);
    let g = this.groups.get(k);
    if (!g) {
      g = { measure, channel, items: this.doc.chipsOf(measure, channel).map((c) => ({ tick: c.tick, value: c.value, removed: false, added: false })), dirty: false };
      this.groups.set(k, g);
    }
    return g;
  }

  /**
   * 名前の n 番目(元の文書で同じ tick・値の何個目か)の元のチップを消す。消せたら true。
   * n は元の文書の並びなので、この編集で先に消したものも数える(×2 の 2 つを続けて消せるように)。
   */
  remove(c) {
    const g = this._g(c.measure, c.channel);
    let seen = 0;
    for (const it of g.items) {
      if (it.added || it.tick !== c.tick || it.value !== c.value) continue;
      if (seen === c.n) {
        if (it.removed) return false;
        it.removed = true;
        g.dirty = true;
        return true;
      }
      seen++;
    }
    return false;
  }

  /**
   * (measure, tick) の channel とぶつかるチップをすべて消す(足したものも)。消した数。
   * 消したドラムのチップのボーナスの印も消す(置き換えたチップのボーナスを、あとから置くチップが引き継がないように)。
   */
  removeConflicts(measure, tick, channel) {
    let n = 0;
    const lanes = new Set();
    for (const ch of channel === 0x11 || channel === 0x18 ? [0x11, 0x18] : [channel]) {
      const g = this._g(measure, ch);
      for (const it of g.items) {
        if (it.removed || it.tick !== tick) continue;
        it.removed = true;
        g.dirty = true;
        n++;
        if (isEditableChannel(ch)) lanes.add(laneOfChannel(ch));
      }
    }
    for (const lane of lanes) this.dropBonus(measure, tick, lane);
    return n;
  }

  /** (measure, tick) のレーン lane のボーナスの印を消す。そのセルにそのレーンのチップが残っていれば消さない(LP と LBD は同じレーン)。 */
  dropBonus(measure, tick, lane) {
    for (const ch of LANE_CHANNELS[lane] || []) {
      if (this._g(measure, ch).items.some((it) => !it.removed && it.tick === tick)) return;
    }
    const v = toBase36(lane + 1);
    for (const ch of BONUS_CHANNELS) {
      const g = this._g(measure, ch);
      for (const it of g.items) {
        if (it.removed || it.tick !== tick || it.value !== v) continue;
        it.removed = true;
        g.dirty = true;
      }
    }
  }

  /** (measure, tick) に channel・value のチップがあるか(消したものは数えない)。 */
  has(measure, tick, channel, value = null) {
    const g = this._g(measure, channel);
    return g.items.some((it) => !it.removed && it.tick === tick && (value === null || it.value === value));
  }

  add(measure, tick, channel, value) {
    if (measure < 0 || measure > MAX_MEASURE) throw new EditError('measureLimit');
    const g = this._g(measure, channel);
    g.items.push({ tick, value, removed: false, added: true });
    g.dirty = true;
  }

  /** 書き換えた文書。チップが元と同じになった組は書き直さない(行をそのまま残す)。 */
  apply() {
    const changes = new Map();
    for (const [k, g] of this.groups) {
      if (!g.dirty) continue;
      const next = g.items.filter((it) => !it.removed).map(({ tick, value }) => ({ tick, value }));
      if (sameChips(this.doc.chipsOf(g.measure, g.channel), next)) continue;
      changes.set(k, next);
    }
    return changes.size ? this.doc.withGroups(changes) : this.doc;
  }

  /** apply した後の文書で、足したチップの名前(同じ tick・値の何個目か)。 */
  keyAfter(doc, measure, tick, channel, value) {
    const list = doc.chipsOf(measure, channel);
    let n = -1;
    for (const c of list) if (c.tick === tick && c.value === value) n++;
    return chipKey(measure, channel, tick, value, Math.max(0, n));
  }
}

/** 2 つのチップの並びが同じか(値は文字列全体で比べる。小節長の '0.75' と '0.5' のように長い値もあるので)。 */
function sameChips(a, b) {
  if (a.length !== b.length) return false;
  const key = (c) => c.tick + '.' + c.value;
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.every((v, i) => v === y[i]);
}

/** (measure, tick) に表示している分岐の #IF の中の BPM の印があるか。 */
function lockedBpmAt(model, measure, tick) {
  return model.bpmMarks.some((b) => b.locked && b.active && b.measure === measure && b.tick === tick);
}

/** 表示している分岐の #IF の中のチップが (measure, tick) で channel とぶつかるか。 */
function lockedConflict(model, column, measure, tick, channel) {
  return model.cellChips(column, measure, tick).some((c) => c.locked && c.active && channelsConflict(c.channel, channel));
}

function columnOfChannel(channel) {
  return COLUMN_TYPES.findIndex((t) => t.includes(channel));
}

function checkCell(model, measure, tick, channel) {
  if (measure < 0 || measure > MAX_MEASURE) throw new EditError('measureLimit');
  if (lockedConflict(model, columnOfChannel(channel), measure, tick, channel)) throw new EditError('locked');
}

// ---- 置く・消す ----

/**
 * 1 個置く。同じセルの同じチャンネル・同じ値のチップがあれば何もしない(同じ文書を返す)。
 * ぶつかるチップ(同じチャンネルの別の値、HHC↔HHO)は消して置き換える。
 * @returns {{doc, select: string[], replaced: number}}
 */
export function opPlace(model, { measure, tick, channel, value }) {
  checkCell(model, measure, tick, channel);
  const e = new GroupEdit(model.doc);
  if (e.has(measure, tick, channel, value) && !(channel === 0x11 || channel === 0x18 ? e.has(measure, tick, channel === 0x11 ? 0x18 : 0x11) : false)) {
    return { doc: model.doc, select: [chipKey(measure, channel, tick, value, 0)], replaced: 0 };
  }
  const replaced = e.removeConflicts(measure, tick, channel);
  e.add(measure, tick, channel, value);
  const doc = e.apply();
  return { doc, select: [e.keyAfter(doc, measure, tick, channel, value)], replaced };
}

/**
 * 塗る(ドラッグで続けて置く。1 手)。同じチャンネルのチップがすでにあるセル・分岐の中のチップとぶつかるセルは飛ばす
 * (1 つのセルのために塗り全体を捨てない)。
 * @param {{measure:number, tick:number, channel:number, value:string}[]} cells
 */
export function opPaint(model, cells) {
  const e = new GroupEdit(model.doc);
  const added = [];
  for (const c of cells) {
    if (c.measure < 0 || c.measure > MAX_MEASURE) throw new EditError('measureLimit');
    if (lockedConflict(model, columnOfChannel(c.channel), c.measure, c.tick, c.channel)) continue;
    if (e.has(c.measure, c.tick, c.channel)) continue;
    e.removeConflicts(c.measure, c.tick, c.channel);
    e.add(c.measure, c.tick, c.channel, c.value);
    added.push(c);
  }
  const doc = e.apply();
  return { doc, select: added.map((c) => e.keyAfter(doc, c.measure, c.tick, c.channel, c.value)) };
}

/**
 * 消す(名前で。#IF の中・知らない名前は飛ばす)。BPM の印も消せる。ボーナスの印(0x4C〜0x4F)はチップと一緒に消す。
 */
export function opDelete(model, keys) {
  const e = new GroupEdit(model.doc);
  for (const k of keys) {
    const c = model.chip(k) || model.bpmMark(k);
    if (!c) continue;
    e.remove(c);
    if (c.bonus) for (const b of bonusMarks(model.doc, c)) e.remove(b);
  }
  return { doc: e.apply(), select: [] };
}

const BONUS_CHANNELS = [0x4c, 0x4d, 0x4e, 0x4f];
/** レーン → そのレーンのチャンネル(HH は HHC と HHO、LP は LP と LBD)。 */
const LANE_CHANNELS = [];
for (const ch of COLUMN_TYPES.flat()) (LANE_CHANNELS[laneOfChannel(ch)] ||= []).push(ch);

/** チップに付いたボーナスの印(同じ位置で、値がチップのレーン + 1。dtx.js の BONUS_VALUE_TO_LANE)。 */
function bonusMarks(doc, chip) {
  const v = toBase36(laneOfChannel(chip.channel) + 1);
  const out = [];
  for (const ch of BONUS_CHANNELS) {
    const seen = new Map();
    for (const c of doc.chipsOf(chip.measure, ch)) {
      const k = c.tick + '.' + c.value;
      const n = seen.get(k) || 0;
      seen.set(k, n + 1);
      if (c.tick === chip.tick && c.value === v) out.push({ measure: chip.measure, channel: ch, tick: c.tick, value: c.value, n });
    }
  }
  return out;
}

/** 消しゴム(右ドラッグ。1 手)。opDelete と同じ。 */
export function opErase(model, keys) {
  return opDelete(model, keys);
}

/**
 * LP / CY の列のチップの横に、もう一方の種類(LBD / RD)を同じセルに置く(本アプリの追加)。
 * @param {{pens: Map<number, string>}} opts
 */
export function opAddPartner(model, key, { pens }) {
  const c = model.chip(key);
  if (!c) return { doc: model.doc, select: [] };
  const partner = otherType(c.channel);
  if (partner === null || channelsConflict(partner, c.channel)) return { doc: model.doc, select: [key] };
  checkCell(model, c.measure, c.tick, partner);
  const e = new GroupEdit(model.doc);
  if (e.has(c.measure, c.tick, partner)) return { doc: model.doc, select: [key] };
  const value = (pens && pens.get(partner)) || c.value;
  e.add(c.measure, c.tick, partner, value);
  const doc = e.apply();
  return { doc, select: [e.keyAfter(doc, c.measure, c.tick, partner, value)] };
}

/**
 * 種類を切り替える(HHC↔HHO・LP↔LBD・CY↔RD。DTXCreator の表裏反転)。
 * (変更) 値は切り替えた先のペンの音にする(DTXCreator は番号を残すので、クローズの音のままオープンになる)。keepValue で残す。
 */
export function opSetType(model, keys, { pens, keepValue = false } = {}) {
  const e = new GroupEdit(model.doc);
  const moved = [];
  for (const k of keys) {
    const c = model.chip(k);
    if (!c) continue;
    const ch = otherType(c.channel);
    if (ch === null) continue;
    checkCell(model, c.measure, c.tick, ch);
    const value = keepValue || !pens || !pens.has(ch) ? c.value : pens.get(ch);
    e.remove(c);
    e.removeConflicts(c.measure, c.tick, ch);
    e.add(c.measure, c.tick, ch, value);
    // CY↔RD はレーンが変わるので、ボーナスの印の値(レーン + 1)も付け替える
    if (c.bonus && laneOfChannel(ch) !== laneOfChannel(c.channel)) {
      for (const b of bonusMarks(model.doc, c)) {
        if (e.remove(b)) e.add(c.measure, c.tick, b.channel, toBase36(laneOfChannel(ch) + 1));
      }
    }
    moved.push({ measure: c.measure, tick: c.tick, channel: ch, value });
  }
  const doc = e.apply();
  return { doc, select: moved.map((m) => e.keyAfter(doc, m.measure, m.tick, m.channel, m.value)) };
}

/** 値(#WAV の番号)を変える。 */
export function opSetValue(model, keys, value) {
  const e = new GroupEdit(model.doc);
  const out = [];
  for (const k of keys) {
    const c = model.chip(k);
    if (!c || c.value === value) continue;
    e.remove(c);
    e.add(c.measure, c.tick, c.channel, value);
    out.push(c);
  }
  const doc = e.apply();
  return { doc, select: out.map((c) => e.keyAfter(doc, c.measure, c.tick, c.channel, value)) };
}

// ---- 動かす ----

/** u の位置のセル(tick は四捨五入。384 になれば次の小節の頭)。 */
function cellAtU(geo, u) {
  let { measure, tickF } = geo.locate(u);
  let tick = Math.round(tickF);
  if (tick >= TICKS_PER_MEASURE) {
    measure++;
    tick = 0;
  }
  return { measure, tick: Math.max(0, tick) };
}

/**
 * 動かす量をブロックごと寄せる(どれかのチップがリードインより前・999 小節より後ろ・列の外へ出ないように。
 * DTXCreator は出られないチップだけ置いていく。docs/spec/dtxcreator-edit.md §11 Q14)。BPM の印は u だけ動く。
 * @returns {{du:number, dcol:number}}
 */
export function clampMove(model, keys, du, dcol) {
  const chips = keys.map((k) => model.chip(k)).filter(Boolean);
  const bpms = keys.map((k) => model.bpmMark(k)).filter(Boolean);
  if (!chips.length && !bpms.length) return { du: 0, dcol: 0 };
  const geo = model.geometry;
  let uMin = Infinity;
  let uMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;
  for (const c of [...chips, ...bpms]) {
    uMin = Math.min(uMin, c.u);
    uMax = Math.max(uMax, c.u);
  }
  for (const c of chips) {
    cMin = Math.min(cMin, c.column);
    cMax = Math.max(cMax, c.column);
  }
  // 終わりは 999 小節の最後の tick まで(その少し先まで許すと、丸めで 1000 小節の頭になって移動ごと断られる)
  const uLast = geo.u(MAX_MEASURE, TICKS_PER_MEASURE - 1);
  if (uMin + du < 0) du = -uMin;
  if (uMax + du > uLast) du = uLast - uMax;
  if (!chips.length) dcol = 0;
  else {
    if (cMin + dcol < 0) dcol = -cMin;
    if (cMax + dcol > COLUMN_COUNT - 1) dcol = COLUMN_COUNT - 1 - cMax;
  }
  return { du, dcol };
}

/**
 * 動かした先(ドラッグ中の描画にも使う)。列を移ったチップは移った先の列の今の種類と、そのペンの音になる
 * ((変更) DTXCreator は番号を残す。keepValue で残す)。元の列に戻れば元のチャンネルに戻る。
 * @returns {{chip, measure:number, tick:number, channel:number, value:string, u:number, column:number}[]}
 */
export function moveTargets(model, keys, { du, dcol, pens, activeTypes, keepValue = false }) {
  const geo = model.geometry;
  const out = [];
  for (const k of keys) {
    const c = model.chip(k);
    if (!c) continue;
    const { measure, tick } = cellAtU(geo, c.u + du);
    const column = c.column + dcol;
    const channel = column === c.column ? c.channel : COLUMN_TYPES[column][(activeTypes && activeTypes[column]) || 0];
    const value = column === c.column || keepValue || !pens || !pens.has(channel) ? c.value : pens.get(channel);
    out.push({ chip: c, measure, tick, channel, value, u: geo.u(measure, tick), column });
  }
  return out;
}

/** BPM の印を動かした先。 */
export function moveBpmTargets(model, keys, du) {
  const geo = model.geometry;
  const out = [];
  for (const k of keys) {
    const b = model.bpmMark(k);
    if (!b) continue;
    const { measure, tick } = cellAtU(geo, b.u + du);
    out.push({ mark: b, measure, tick, u: geo.u(measure, tick) });
  }
  return out;
}

/**
 * 動かす(1 手)。元を消し、行き先でぶつかる動かしていないチップを消して置く(動かしたチップが勝つ。DTXCreator §5.5)。
 * 動かすチップ同士が同じセルでぶつかったら、元の位置が行き先にいちばん近いものを残す。BPM の印は u だけ動き、
 * 行き先の BPM の印は消す。ボーナスの印はチップについていく。
 * @returns {{doc, select: string[], removed: number}}
 */
export function opMove(model, keys, opts) {
  const { du, dcol } = clampMove(model, keys, opts.du, opts.dcol);
  const targets = moveTargets(model, keys, { ...opts, du, dcol });
  const bpmTargets = moveBpmTargets(model, keys, du);
  if ((!targets.length && !bpmTargets.length) || (du === 0 && dcol === 0)) return { doc: model.doc, select: keys.slice(), removed: 0 };
  const e = new GroupEdit(model.doc);
  for (const t of targets) e.remove(t.chip);
  for (const t of bpmTargets) e.remove(t.mark);
  // 動かすチップ同士のぶつかり
  const byCell = new Map();
  let removed = 0;
  for (const t of targets) {
    const k = `${t.measure}.${t.tick}.${t.channel === 0x18 ? 0x11 : t.channel}`;
    const prev = byCell.get(k);
    if (!prev) {
      byCell.set(k, t);
      continue;
    }
    removed++;
    if (Math.abs(t.chip.u + du - t.u) < Math.abs(prev.chip.u + du - prev.u)) byCell.set(k, t);
  }
  const kept = [...byCell.values()];
  for (const t of kept) {
    if (t.measure > MAX_MEASURE) throw new EditError('measureLimit');
    if (lockedConflict(model, t.column, t.measure, t.tick, t.channel)) throw new EditError('locked');
  }
  // ぶつかって残らなかったチップのボーナスの印も消す
  const keptSet = new Set(kept);
  for (const t of targets) if (!keptSet.has(t) && t.chip.bonus) for (const b of bonusMarks(model.doc, t.chip)) e.remove(b);
  const bpmCell = new Map();
  for (const t of bpmTargets) {
    if (t.measure > MAX_MEASURE) throw new EditError('measureLimit');
    if (lockedBpmAt(model, t.measure, t.tick)) throw new EditError('locked');
    bpmCell.set(`${t.measure}.${t.tick}`, t); // 同じセルなら後のもの
  }
  for (const t of kept) removed += e.removeConflicts(t.measure, t.tick, t.channel);
  for (const t of bpmCell.values()) for (const ch of [0x03, 0x08]) removed += e.removeConflicts(t.measure, t.tick, ch);
  for (const t of kept) {
    e.add(t.measure, t.tick, t.channel, t.value);
    if (t.chip.bonus) {
      const v = toBase36(laneOfChannel(t.channel) + 1);
      for (const b of bonusMarks(model.doc, t.chip)) {
        e.remove(b);
        e.add(t.measure, t.tick, b.channel, v);
      }
    }
  }
  for (const t of bpmCell.values()) e.add(t.measure, t.tick, t.mark.channel, t.mark.value);
  const doc = e.apply();
  const select = kept.map((t) => e.keyAfter(doc, t.measure, t.tick, t.channel, t.value))
    .concat([...bpmCell.values()].map((t) => e.keyAfter(doc, t.measure, t.tick, t.mark.channel, t.mark.value)));
  return { doc, select, removed };
}

/** 選んだものを du だけ動かす(↑↓ の微調整。値は残す)。 */
export function opNudge(model, keys, { du }) {
  return opMove(model, keys, { du, dcol: 0, keepValue: true });
}

// ---- コピー・貼り付け・複製 ----

/**
 * 選んだものをクリップボードの形にする。du は選んだもののいちばん前からの u の差、BPM の印は BPM の値で持つ
 * ((変更) DTXCreator は #BPMzz の番号のまま貼るので、別の譜面では別のテンポになる)。
 * @returns {{items: {du:number, column:number, channel:number, value:string}[], bpm: {du:number, bpm:number}[], span:number}|null}
 */
export function copyClip(model, keys) {
  const chips = keys.map((k) => model.chip(k)).filter(Boolean);
  const bpms = keys.map((k) => model.bpmMark(k)).filter((b) => b && b.bpm !== null);
  if (!chips.length && !bpms.length) return null;
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const c of [...chips, ...bpms]) {
    u0 = Math.min(u0, c.u);
    u1 = Math.max(u1, c.u);
  }
  return {
    items: chips.map((c) => ({ du: c.u - u0, column: c.column, channel: c.channel, value: c.value })),
    bpm: bpms.map((b) => ({ du: b.u - u0, bpm: b.bpm })),
    span: u1 - u0,
  };
}

/**
 * 貼る(u0 から。列とチャンネルはそのまま。貼ったチップが勝つ)。BPM は値で貼り、番号を取り直す。
 * @param {(doc) => import('./model.js').EditModel} modelOf BPM を足したあとの文書のモデル(履歴のモデルを使い回すため)
 */
export function opPaste(model, clip, { u0, modelOf }) {
  if (!clip) return { doc: model.doc, select: [] };
  const geo = model.geometry;
  let m = model;
  const select = [];
  for (const b of clip.bpm || []) {
    const cell = cellAtU(geo, u0 + b.du);
    const r = opSetBpm(m, { measure: cell.measure, tick: cell.tick, bpm: b.bpm });
    m = modelOf(r.doc);
    select.push(...r.select);
  }
  const e = new GroupEdit(m.doc);
  const placed = [];
  for (const it of clip.items) {
    const cell = cellAtU(geo, u0 + it.du);
    checkCell(m, cell.measure, cell.tick, it.channel);
    e.removeConflicts(cell.measure, cell.tick, it.channel);
    e.add(cell.measure, cell.tick, it.channel, it.value);
    placed.push({ ...cell, channel: it.channel, value: it.value });
  }
  const doc = e.apply();
  // BPM の印の名前は、チップを書いたあとも同じ(チャンネルが違うので組が変わらない)
  return { doc, select: select.concat(placed.map((p) => e.keyAfter(doc, p.measure, p.tick, p.channel, p.value))) };
}

/**
 * 選んだものを、選んだ小節の数だけ後ろへ写す(本アプリの追加)。小節の中の tick はそのまま(小節長が違っても拍の頭は揃う)。
 */
export function opDuplicate(model, keys) {
  const chips = keys.map((k) => model.chip(k)).filter(Boolean);
  const bpms = keys.map((k) => model.bpmMark(k)).filter(Boolean);
  const all = [...chips, ...bpms];
  if (!all.length) return { doc: model.doc, select: [] };
  let mMin = Infinity;
  let mMax = -Infinity;
  for (const c of all) {
    mMin = Math.min(mMin, c.measure);
    mMax = Math.max(mMax, c.measure);
  }
  const dm = mMax - mMin + 1;
  if (mMax + dm > MAX_MEASURE) throw new EditError('measureLimit');
  const e = new GroupEdit(model.doc);
  const placed = [];
  for (const c of chips) {
    checkCell(model, c.measure + dm, c.tick, c.channel);
    e.removeConflicts(c.measure + dm, c.tick, c.channel);
    e.add(c.measure + dm, c.tick, c.channel, c.value);
    placed.push({ measure: c.measure + dm, tick: c.tick, channel: c.channel, value: c.value });
  }
  for (const b of bpms) {
    if (lockedBpmAt(model, b.measure + dm, b.tick)) throw new EditError('locked');
    for (const ch of [0x03, 0x08]) e.removeConflicts(b.measure + dm, b.tick, ch);
    e.add(b.measure + dm, b.tick, b.channel, b.value);
    placed.push({ measure: b.measure + dm, tick: b.tick, channel: b.channel, value: b.value });
  }
  const doc = e.apply();
  return { doc, select: placed.map((p) => e.keyAfter(doc, p.measure, p.tick, p.channel, p.value)), focusMeasure: mMin + dm };
}

// ---- BPM ----

/** BPM の書き方(小数 4 桁まで、末尾の 0 を落とす。指数は使わない)。 */
export function formatBpm(v) {
  return (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

const BPM_CMD = /^BPM([0-9A-Z]{2})$/;

/** 値 v の #BPMzz(#IF の外で 1 回だけ定義されたもの)の zz。無ければ null。値は書いた文字列で比べる。 */
function bpmKeyFor(doc, v) {
  const want = formatBpm(v);
  const { headers, headerCounts, ifCmds } = doc.index;
  for (const h of headers) {
    const m = BPM_CMD.exec(h.cmd);
    if (!m || m[1] === '00' || headerCounts.get(h.cmd) !== 1 || ifCmds.has(h.cmd)) continue;
    const d = tryParseBpm(h.param);
    if (Number.isFinite(d) && formatBpm(d) === want) return m[1];
  }
  return null;
}

/**
 * 使われていない最小の #BPMzz の zz(#IF の中の定義も避ける)。定義の無い番号を指す ch 08 のチップがあれば、その番号も避ける
 * (定義を足すと、そのチップのテンポまで変わってしまう)。
 */
function freeBpmKey(doc) {
  const { allCmds, ifCmds } = doc.index;
  const used = usedBpmKeys(doc);
  for (let n = 1; n < 36 * 36; n++) {
    const zz = toBase36(n);
    if (!allCmds.has('BPM' + zz) && !ifCmds.has('BPM' + zz) && !used.has(zz)) return zz;
  }
  return null;
}

/** ch 08 のチップが指している番号(#IF の中も)。 */
function usedBpmKeys(doc) {
  const used = new Set();
  for (const g of doc.index.groups.values()) if (g.channel === 0x08) for (const c of g.chips) used.add(c.value);
  for (const l of doc.locked(() => 0)) if (l.channel === 0x08) for (const c of l.chips) used.add(c.value);
  return used;
}

/**
 * (measure, tick) の BPM を bpm にする(そこの BPM の印は置き換える)。DTXCreator と同じく新しい印は ch 08 と #BPMzz
 * (同じ値の定義があれば使い回す)。(変更) 元が ch 03 で、値が 1〜255 の整数なら ch 03 のまま(DTXCreator は読むときに
 * すべて ch 08 に替える)。header: 小節 000 の頭に印が無ければ、#BPM(曲の BPM。#BASEBPM を引かない)を書き換える。
 */
export function opSetBpm(model, { measure, tick, bpm, header = false }) {
  if (!(bpm >= 0.0001 && bpm <= 1000)) throw new EditError('bpmRange');
  if (measure < 0 || measure > MAX_MEASURE) throw new EditError('measureLimit');
  let doc = model.doc;
  const here = model.bpmMarks.filter((b) => b.measure === measure && b.tick === tick);
  if (here.some((b) => b.locked && b.active)) throw new EditError('locked');
  const existing = here.filter((b) => !b.locked);
  if (header && measure === 0 && tick === 0 && !existing.length) {
    return { doc: doc.withHeader('BPM', formatBpm(bpm)), select: [] };
  }
  const base = model.chart.baseBpm || 0;
  const zv = Math.round((bpm - base) * 1e4) / 1e4;
  if (!(zv > 0)) throw new EditError('bpmBase', { base: formatBpm(base) });
  let channel = 0x08;
  let value;
  if (existing.some((b) => b.channel === 0x03) && Number.isInteger(zv) && zv >= 1 && zv <= 255) {
    channel = 0x03;
    value = zv.toString(16).toUpperCase().padStart(2, '0');
  } else {
    let zz = bpmKeyFor(doc, zv);
    if (!zz) {
      zz = freeBpmKey(doc);
      if (!zz) throw new EditError('bpmKeys');
      doc = doc.withInsertedHeaders(['#BPM' + zz + ': ' + formatBpm(zv)], 'BPM');
    }
    value = zz;
  }
  const e = new GroupEdit(doc);
  for (const b of existing) e.remove(b);
  e.add(measure, tick, channel, value);
  const out = e.apply();
  return { doc: out, select: [e.keyAfter(out, measure, tick, channel, value)] };
}

/**
 * 書き出す前に、この編集で足して使われなくなった #BPMzz の行を消す(元の譜面にあった定義は消さない)。
 * (追加) DTXCreator は使わない定義も書き続ける。
 */
export function gcBpmKeys(doc, originalDoc) {
  const orig = originalDoc.index.allCmds;
  const used = usedBpmKeys(doc);
  const edits = new Map();
  for (const h of doc.index.headers) {
    const m = BPM_CMD.exec(h.cmd);
    if (!m || m[1] === '00' || orig.has(h.cmd) || used.has(m[1])) continue;
    edits.set(h.idx, null);
  }
  return edits.size ? doc.withLines(edits) : doc;
}

// ---- 小節長 ----

/** ch 02 の値の読み方(parseDTX と同じ。読めない・0 以下は 1)。 */
function barValue(s) {
  let v = Number(s);
  if (!Number.isFinite(v)) v = Number(String(s).replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

const sameLen = (a, b) => formatBarLength(a) === formatBarLength(b);

/**
 * 小節 0..endMeasure の小節長が desired(k) になるよう ch 02 の行を直す(差分を小さく)。小節長は次の指定まで続くので、
 * 前の小節と同じなら行は要らない(同じ値の行が元からあれば残す)。違えば書く(同じ値の行が元からあれば残す)。
 * 前と同じに戻す行も書く(DTXCreator §3.6)。
 * @param {GroupEdit} edit
 * @param {(k:number) => number} desired
 */
export function normalizeBarLengths(edit, desired, endMeasure) {
  let prev = 1;
  for (let k = 0; k <= endMeasure; k++) {
    const want = desired(k);
    const g = edit._g(k, 0x02);
    const live = g.items.filter((it) => !it.removed);
    const last = live.length ? live[live.length - 1] : null;
    const keep = last && sameLen(barValue(last.value), want);
    if (sameLen(want, prev)) {
      if (live.length && !keep) {
        for (const it of live) it.removed = true;
        g.dirty = true;
      }
    } else if (!keep) {
      for (const it of live) it.removed = true;
      g.items.push({ tick: 0, value: formatBarLength(want), removed: false, added: true });
      g.dirty = true;
    }
    prev = want;
  }
}

/** 小節長を変える範囲の終わり(scope 'from' は次に小節長を書いた小節の前まで)。 */
function barEnd(doc, m, scope) {
  if (scope !== 'from') return m;
  for (let k = m + 1; k <= MAX_MEASURE; k++) if (doc.chipsOf(k, 0x02).length) return k - 1;
  return MAX_MEASURE;
}

/**
 * 小節長を変える(1 手)。scope 'one' = この小節だけ(次の小節に元の長さを書き戻す)、'from' = 次の指定の前まで。
 * keepBeats: 拍の位置を保つ(DTXCreator と同じくチップの拍の位置は変えず、はみ出したチップは消す。どのチャンネルも)。
 * false なら小節に合わせて伸縮する(tick はそのまま。本アプリの追加)。
 * #IF の中の ch 02 が関わる・拍を保つのに #IF の中の行を動かすことになるときは変えない(EditError('barLocked'))。
 * @returns {{doc, removed:number, select:[]}}
 */
export function opBarLength(model, { measure, value, scope = 'one', keepBeats = true }) {
  if (!(value >= 0.01 && value <= 16)) throw new EditError('barRange');
  if (measure < 0 || measure > MAX_MEASURE) throw new EditError('measureLimit');
  const doc = model.doc;
  const geo = model.geometry;
  const m = measure;
  const end = barEnd(doc, m, scope);
  const desired = (k) => (k >= m && k <= end ? value : geo.len(k));
  const lastData = Math.min(MAX_MEASURE, Math.max(doc.index.maxMeasure, m) + 1);
  const walkEnd = Math.min(MAX_MEASURE, Math.max(lastData, Math.min(end, MAX_MEASURE - 1) + 1));
  const locked = doc.locked(() => 0);
  if (locked.some((l) => l.channel === 0x02 && l.measure <= walkEnd)) throw new EditError('barLocked');
  if (keepBeats && locked.some((l) => l.measure >= m && l.measure <= end)) throw new EditError('barLocked');
  const e = new GroupEdit(doc);
  let removed = 0;
  if (keepBeats) {
    for (const g of doc.index.groups.values()) {
      if (g.channel === 0x02 || g.measure < m || g.measure > end) continue;
      const Lo = geo.len(g.measure);
      const Ln = desired(g.measure);
      if (sameLen(Lo, Ln)) continue;
      const ge = e._g(g.measure, g.channel);
      const seen = new Map(); // `${新しい tick}.${値}` → 元の tick(違う tick が丸めで重なったら 1 つにする)
      for (const it of ge.items) {
        if (it.removed) continue;
        const nt = Math.round((it.tick * Lo) / Ln);
        ge.dirty = true;
        if (nt >= TICKS_PER_MEASURE) {
          it.removed = true;
          if (isEditableChannel(g.channel)) removed++;
          continue;
        }
        const k = nt + '.' + it.value;
        if (seen.has(k) && seen.get(k) !== it.tick) {
          it.removed = true;
          continue;
        }
        seen.set(k, it.tick);
        it.tick = nt;
      }
    }
  }
  normalizeBarLengths(e, desired, walkEnd);
  return { doc: e.apply(), removed, select: [] };
}

/** opBarLength で消えるドラムのチップの数(ダイアログに出す)。 */
export function barOverflow(model, { measure, value, scope = 'one', keepBeats = true }) {
  if (!keepBeats || !(value > 0)) return 0;
  const geo = model.geometry;
  const end = barEnd(model.doc, measure, scope);
  let n = 0;
  for (const c of model.chips) {
    if (c.locked || c.measure < measure || c.measure > end) continue;
    if (Math.round((c.tick * geo.len(c.measure)) / value) >= TICKS_PER_MEASURE) n++;
  }
  return n;
}

// ---- 小節の挿入・削除 ----

/**
 * #IF の中に小節長(ch 02)の行があれば、小節の挿入・削除をしない。小節の長さを書き直すとき、表示している分岐の長さを
 * #IF の外に書いてしまい、ほかの分岐の長さが変わるため(opBarLength の barLocked と同じ考え)。
 */
function checkBarsUnlocked(model) {
  if (model.doc.locked(() => 0).some((l) => l.channel === 0x02)) throw new EditError('measureLocked');
}

/**
 * 小節 m の前に空の小節を挿す(m 以降は 1 つ後ろへ。#IF の中の行も)。(変更) DTXCreator は長さ 1・テンポ無しで挿すが、
 * 押した小節と同じ長さにし、押した小節の頭の BPM の印も写す(3/4 やテンポの変わった所に挿しても拍子とテンポが変わらない)。
 */
export function opInsertMeasure(model, m) {
  if (m < 0 || m > MAX_MEASURE) throw new EditError('measureLimit');
  checkBarsUnlocked(model);
  const geo = model.geometry;
  let doc;
  try {
    doc = model.doc.withMeasureShift(m, 1);
  } catch (err) {
    if (err instanceof RangeError) throw new EditError('measureLimit');
    throw err;
  }
  const e = new GroupEdit(doc);
  for (const b of model.bpmMarks) if (!b.locked && b.measure === m && b.tick === 0) e.add(m, 0, b.channel, b.value);
  const end = Math.min(MAX_MEASURE, Math.max(doc.index.maxMeasure, m + 1) + 1);
  normalizeBarLengths(e, (k) => (k < m ? geo.len(k) : k === m ? geo.len(m) : geo.len(k - 1)), end);
  return { doc: e.apply(), select: [] };
}

/** 小節 m を消して詰めるときに消えるもの(確かめのダイアログ)。 */
export function measureDeleteSummary(model, m) {
  const out = { drums: 0, bgm: 0, tempo: 0, other: 0, lockedLines: 0, carriedBpm: null };
  for (const g of model.doc.index.groups.values()) {
    if (g.measure !== m || g.channel === 0x02) continue;
    const n = g.chips.length;
    if (isEditableChannel(g.channel)) out.drums += n;
    else if (g.channel === 0x01) out.bgm += n;
    else if (g.channel === 0x03 || g.channel === 0x08) out.tempo += n;
    else out.other += n;
  }
  out.lockedLines = model.doc.locked(() => 0).filter((l) => l.measure === m).length;
  const bpms = model.bpmMarks.filter((b) => !b.locked && b.measure === m);
  const nextHas = model.bpmMarks.some((b) => (!b.locked || b.active) && b.measure === m + 1 && b.tick === 0);
  if (bpms.length && !nextHas) out.carriedBpm = bpms[bpms.length - 1].bpm;
  return out;
}

/**
 * 小節 m を消して詰める(1 手)。(変更) 消す小節の最後の BPM の変化は次の小節の頭へ移し(次の小節の頭に印が無ければ)、
 * 後ろの小節の長さも保つ(DTXCreator は消した小節のテンポと長さの影響がそのまま後ろに出る)。
 */
export function opDeleteMeasure(model, m) {
  if (m < 0 || m > MAX_MEASURE) throw new EditError('measureLimit');
  checkBarsUnlocked(model);
  const geo = model.geometry;
  const doc = model.doc.withMeasureShift(m, -1);
  const e = new GroupEdit(doc);
  const bpms = model.bpmMarks.filter((b) => !b.locked && b.measure === m);
  const nextHas = model.bpmMarks.some((b) => (!b.locked || b.active) && b.measure === m + 1 && b.tick === 0);
  if (bpms.length && !nextHas) {
    const last = bpms[bpms.length - 1];
    e.add(m, 0, last.channel, last.value);
  }
  const end = Math.min(MAX_MEASURE, Math.max(doc.index.maxMeasure, m) + 1);
  normalizeBarLengths(e, (k) => (k < m ? geo.len(k) : geo.len(k + 1)), end);
  return { doc: e.apply(), select: [] };
}

/** BPM の印の値(BPM)。ch 03 は 16 進 + #BASEBPM、ch 08 は #BPMzz + #BASEBPM。 */
export function bpmOfMark(chart, channel, value) {
  const base = chart.baseBpm || 0;
  if (channel === 0x03) return base + parseHex(value);
  return chart.bpmDefs.has(value) ? base + chart.bpmDefs.get(value) : null;
}
