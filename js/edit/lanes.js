// 譜面の編集のレーン: 演奏画面と同じ 9 列(LC HH LP SD HT BD LT FT CY)と、列ごとのチップの種類。
//
// DTXCreator は HH を 1 レーンに表(HHC 11)/ 裏(HHO 18)で置き、LP(1B)・LB(1C)・CY(16)・RD(19)を別のレーンにする
// (docs/spec/dtxcreator-edit.md §1.5・§1.7)。本アプリは演奏画面と同じ絵にするため(変更) 9 列にまとめ、HH・LP・CY の列に
// 2 種類のチップを持たせる(DTXCreator の表 / 裏を 3 列へ広げたもの)。ぶつかるのは同じチャンネルと HHC↔HHO だけで、
// LP と LBD、CY と RD は同じ位置に並べて置ける(NX / DTXCreator は別のレーンなので、消さずに残す)。

import { LANE_NAMES, CHANNEL_NAMES, parseBase36, toBase36 } from '../core/dtx.js';

/** 列 → チャンネル(先頭が既定の種類)。 */
export const COLUMN_TYPES = [[0x1a], [0x11, 0x18], [0x1b, 0x1c], [0x12], [0x14], [0x13], [0x15], [0x17], [0x16, 0x19]];

export const COLUMN_COUNT = COLUMN_TYPES.length;

/** チャンネル → 列。 */
export const COLUMN_OF = (() => {
  const m = new Map();
  COLUMN_TYPES.forEach((types, col) => types.forEach((ch) => m.set(ch, col)));
  return m;
})();

/** チャンネル → 列の中の種類(0 = 既定、1 = もう一方)。 */
export const TYPE_OF = (() => {
  const m = new Map();
  COLUMN_TYPES.forEach((types) => types.forEach((ch, i) => m.set(ch, i)));
  return m;
})();

/** 2 つ目の種類のチップに付ける印(チップの右端)。 */
export const TYPE_BADGE = { 0x18: 'O', 0x1c: 'LB', 0x19: 'R' };

/** 編集できるチャンネル(ドラムの可視チップ 12 種)。 */
export function isEditableChannel(ch) {
  return COLUMN_OF.has(ch);
}

/** チャンネルの名前(HHC / HHO / LBD など)。 */
export function channelName(ch) {
  return CHANNEL_NAMES[ch] || ch.toString(16).toUpperCase();
}

/** チャンネル → 演奏画面のレーン名(スキンのチップの絵の名前。HHO は HH、LBD は LP、RD は RD)。 */
export function spriteLane(ch) {
  const lane = { 0x1a: 0, 0x11: 1, 0x18: 1, 0x1b: 2, 0x1c: 2, 0x12: 3, 0x14: 4, 0x13: 5, 0x15: 6, 0x17: 7, 0x16: 8, 0x19: 9 }[ch];
  return lane === undefined ? null : LANE_NAMES[lane];
}

/** 演奏画面のレーン番号(0..9。合成音・音のバッファ選びに使う)。 */
export function laneOfChannel(ch) {
  const lane = { 0x1a: 0, 0x11: 1, 0x18: 1, 0x1b: 2, 0x1c: 2, 0x12: 3, 0x14: 4, 0x13: 5, 0x15: 6, 0x17: 7, 0x16: 8, 0x19: 9 }[ch];
  return lane === undefined ? -1 : lane;
}

/** 同じセルに置けない組か(同じチャンネル、または HHC と HHO)。 */
export function channelsConflict(a, b) {
  return a === b || (a === 0x11 && b === 0x18) || (a === 0x18 && b === 0x11);
}

/** チップ同士がぶつかるか({measure, tick, channel})。 */
export function conflicts(a, b) {
  return a.measure === b.measure && a.tick === b.tick && channelsConflict(a.channel, b.channel);
}

/** 列の中のもう一方の種類のチャンネル(1 種類しかない列は null)。 */
export function otherType(ch) {
  const col = COLUMN_OF.get(ch);
  if (col === undefined) return null;
  const types = COLUMN_TYPES[col];
  return types.length < 2 ? null : types[1 - TYPE_OF.get(ch)];
}

/**
 * #WAV のラベル(行末の ; の後ろ)かファイル名から、チャンネルに合いそうな音を探す言葉(本アプリの追加)。
 * 譜面にまだそのチャンネルのチップが無いときの、ペンの音の候補に使う。
 */
export const PEN_KEYWORDS = {
  0x1a: /lc|crash|left/i,
  0x11: /hhc|hh|hat|close|クローズ/i,
  0x18: /hho|open|オープン/i,
  0x1b: /lp|pedal|foot|ペダル/i,
  0x1c: /lbd|kick|bd/i,
  0x12: /sd|snare|スネア/i,
  0x14: /ht|tom1|high/i,
  0x13: /bd|kick|bass|バス/i,
  0x15: /lt|tom2|low/i,
  0x17: /ft|floor|tom3/i,
  0x16: /cy|crash/i,
  0x19: /rd|ride|ライド/i,
};

/** いちばん多い値(同数なら先に数えた方。V2D の Counter.most_common と同じ)。 */
function mostCommon(counts) {
  let best = null;
  let n = 0;
  for (const [k, v] of counts) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best;
}

/**
 * チャンネルごとのペン(新しく置くチップの値)の初期値(DTXCreator のレーン割付チップをチャンネルごとにしたもの)。
 * 1. そのチャンネルでいちばん多い値(vid2dtx の lane_default。kitgen の譜面なら音量違いの番号まで同じものを選ぶ)
 * 2. (追加) #WAV のラベルかファイル名がチャンネルの言葉に合うもの(#WAV の順で最初)
 * 3. 同じ列のもう一方の種類でいちばん多い値
 * 4. 定義も使用もされていない最小の番号(音が無いので合成音で鳴る)
 * @param {Map<number, Map<string, number>>} valueCounts チャンネル → (値 → 数)
 * @param {{id: string, file: string, label: string}[]} wavs #WAV の定義(ファイルの順)
 * @param {Set<string>} used 使われている・定義されている番号
 * @returns {Map<number, string>}
 */
export function defaultPens(valueCounts, wavs, used) {
  const pens = new Map();
  const taken = new Set(used);
  for (const types of COLUMN_TYPES) {
    for (const ch of types) {
      const counts = valueCounts.get(ch);
      let v = counts && counts.size ? mostCommon(counts) : null;
      if (v === null) {
        const re = PEN_KEYWORDS[ch];
        const hit = wavs.find((w) => re.test(w.label || '') || re.test((w.file || '').replace(/^.*[\\/]/, '')));
        if (hit) v = hit.id;
      }
      if (v === null) {
        const o = otherType(ch);
        const oc = o !== null ? valueCounts.get(o) : null;
        if (oc && oc.size) v = mostCommon(oc);
      }
      if (v === null) {
        v = freeWavId(taken);
        if (v) taken.add(v);
      }
      if (v) pens.set(ch, v);
    }
  }
  return pens;
}

/** 列ごとの今の種類(0 / 1)の初期値: 列でいちばん多いチャンネル。チップが無ければ既定の種類。 */
export function defaultActiveTypes(channelCounts) {
  return COLUMN_TYPES.map((types) => {
    if (types.length < 2) return 0;
    const a = channelCounts.get(types[0]) || 0;
    const b = channelCounts.get(types[1]) || 0;
    return b > a ? 1 : 0;
  });
}

/** 使われていない最小の番号('01'〜'ZZ')。無ければ null。 */
export function freeWavId(used) {
  for (let n = 1; n < 36 * 36; n++) {
    const id = toBase36(n);
    if (!used.has(id)) return id;
  }
  return null;
}

/** 番号の大きさ(並べ替え用)。 */
export function wavIdNumber(id) {
  return parseBase36(id);
}

/**
 * 演奏のレーン(0..9。キー・タッチ・MIDI の打鍵)→ 置くチャンネル。HH と LP は列の今の種類。CY 列は、
 * キーと MIDI(RD を叩き分けられる)ならレーン 8 = CY・9 = RD、タッチ(列は 1 つ)なら列の今の種類。
 * @param {number} lane
 * @param {'midi'|'key'|'touch'} src
 * @param {number[]} activeTypes
 */
export function padChannel(lane, src, activeTypes) {
  const byType = (col) => COLUMN_TYPES[col][activeTypes[col] || 0];
  switch (lane) {
    case 0: return 0x1a;
    case 1: return byType(1);
    case 2: return byType(2);
    case 3: return 0x12;
    case 4: return 0x14;
    case 5: return 0x13;
    case 6: return 0x15;
    case 7: return 0x17;
    case 8: return src === 'touch' ? byType(8) : 0x16;
    case 9: return src === 'touch' ? byType(8) : 0x19;
    default: return null;
  }
}
