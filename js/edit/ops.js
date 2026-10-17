// 譜面の編集の操作。どれも EditModel(と引数)から新しい DtxDoc を作って返す(文書は変えない)。
// 変えた (小節, チャンネル) の組だけを doc.withGroups に渡すので、ほかの行はバイト列ごと残る(js/edit/dtxdoc.js)。
// 失敗は EditError(code) で知らせる(文言は js/edit/editor.js が code から引く)。
//
// 置き方の規則(docs/spec/chart-editor.md):
// - ぶつかるのは同じセルの同じチャンネルと HHC↔HHO だけ(js/edit/lanes.js)。置くと、ぶつかるチップは消える
//   (DTXCreator の置き換え。vid2dtx は置かずに終わる)。同じチャンネル・同じ値のチップがあれば何もしない
// - #IF の中で表示している分岐のチップとぶつかるなら置かない(EditError('locked'))
// - 999 小節より後ろには書かない(EditError('measureLimit'))

import { TICKS_PER_MEASURE } from '../core/dtx.js';
import { groupKey, MAX_MEASURE } from './dtxdoc.js';
import { chipKey } from './model.js';
import { COLUMN_TYPES, COLUMN_COUNT, channelsConflict, otherType } from './lanes.js';

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

  /** 名前の n 番目(同じ tick・値の何個目か)の元のチップを消す。消せたら true。 */
  remove(c) {
    const g = this._g(c.measure, c.channel);
    let seen = 0;
    for (const it of g.items) {
      if (it.added || it.removed || it.tick !== c.tick || it.value !== c.value) continue;
      if (seen === c.n) {
        it.removed = true;
        g.dirty = true;
        return true;
      }
      seen++;
    }
    return false;
  }

  /** (measure, tick) の channel とぶつかるチップをすべて消す(足したものも)。消した数。 */
  removeConflicts(measure, tick, channel) {
    let n = 0;
    for (const ch of channel === 0x11 || channel === 0x18 ? [0x11, 0x18] : [channel]) {
      const g = this._g(measure, ch);
      for (const it of g.items) {
        if (it.removed || it.tick !== tick) continue;
        it.removed = true;
        g.dirty = true;
        n++;
      }
    }
    return n;
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

function sameChips(a, b) {
  if (a.length !== b.length) return false;
  const key = (c) => c.tick * 4096 + c.value.charCodeAt(0) * 64 + c.value.charCodeAt(1);
  const x = a.map(key).sort((p, q) => p - q);
  const y = b.map(key).sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
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
 * 塗る(ドラッグで続けて置く。1 手)。同じチャンネルのチップがすでにあるセルは飛ばす。
 * @param {{measure:number, tick:number, channel:number, value:string}[]} cells
 */
export function opPaint(model, cells) {
  const e = new GroupEdit(model.doc);
  const added = [];
  for (const c of cells) {
    checkCell(model, c.measure, c.tick, c.channel);
    if (e.has(c.measure, c.tick, c.channel)) continue;
    e.removeConflicts(c.measure, c.tick, c.channel);
    e.add(c.measure, c.tick, c.channel, c.value);
    added.push(c);
  }
  const doc = e.apply();
  return { doc, select: added.map((c) => e.keyAfter(doc, c.measure, c.tick, c.channel, c.value)) };
}

/** 消す(名前で。#IF の中・知らない名前は飛ばす)。 */
export function opDelete(model, keys) {
  const e = new GroupEdit(model.doc);
  for (const k of keys) {
    const c = model.chip(k);
    if (c) e.remove(c);
  }
  return { doc: e.apply(), select: [] };
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

/**
 * 動かす量をブロックごと寄せる(どれかのチップがリードインより前・999 小節より後ろ・列の外へ出ないように。
 * DTXCreator は出られないチップだけ置いていく。docs/spec/dtxcreator-edit.md §11 Q14)。
 * @returns {{du:number, dcol:number}}
 */
export function clampMove(model, keys, du, dcol) {
  const chips = keys.map((k) => model.chip(k)).filter(Boolean);
  if (!chips.length) return { du: 0, dcol: 0 };
  const geo = model.geometry;
  let uMin = Infinity;
  let uMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;
  for (const c of chips) {
    uMin = Math.min(uMin, c.u);
    uMax = Math.max(uMax, c.u);
    cMin = Math.min(cMin, c.column);
    cMax = Math.max(cMax, c.column);
  }
  const uEnd = geo.start(MAX_MEASURE + 1);
  if (uMin + du < 0) du = -uMin;
  if (uMax + du >= uEnd) du = uEnd - 1e-6 - uMax;
  if (cMin + dcol < 0) dcol = -cMin;
  if (cMax + dcol > COLUMN_COUNT - 1) dcol = COLUMN_COUNT - 1 - cMax;
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
    let { measure, tickF } = geo.locate(c.u + du);
    let tick = Math.round(tickF);
    if (tick >= TICKS_PER_MEASURE) {
      measure++;
      tick = 0;
    }
    if (tick < 0) tick = 0;
    const column = c.column + dcol;
    const channel = column === c.column ? c.channel : COLUMN_TYPES[column][(activeTypes && activeTypes[column]) || 0];
    const value = column === c.column || keepValue || !pens || !pens.has(channel) ? c.value : pens.get(channel);
    out.push({ chip: c, measure, tick, channel, value, u: geo.u(measure, tick), column });
  }
  return out;
}

/**
 * 動かす(1 手)。元を消し、行き先でぶつかる動かしていないチップを消して置く(動かしたチップが勝つ。DTXCreator §5.5)。
 * 動かすチップ同士が同じセルでぶつかったら、元の位置が行き先にいちばん近いものを残す。
 * @returns {{doc, select: string[], removed: number}}
 */
export function opMove(model, keys, opts) {
  const { du, dcol } = clampMove(model, keys, opts.du, opts.dcol);
  const targets = moveTargets(model, keys, { ...opts, du, dcol });
  if (!targets.length || (du === 0 && dcol === 0)) return { doc: model.doc, select: keys.slice(), removed: 0 };
  const e = new GroupEdit(model.doc);
  for (const t of targets) e.remove(t.chip);
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
  for (const t of kept) removed += e.removeConflicts(t.measure, t.tick, t.channel);
  for (const t of kept) e.add(t.measure, t.tick, t.channel, t.value);
  const doc = e.apply();
  return { doc, select: kept.map((t) => e.keyAfter(doc, t.measure, t.tick, t.channel, t.value)), removed };
}
