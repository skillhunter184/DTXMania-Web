// 譜面の編集の縦軸。u = DTX の小節 000 の頭から数えた 4/4 小節の数(拍に比例する。BPM では伸び縮みしない)。
//
// DTXCreator と同じく、小節の高さは小節長に比例し(192 grid × 倍率。docs/spec/dtxcreator-edit.md §1.2)、テンポでは
// 変わらない。本アプリの tick は parseDTX と同じ 1 小節 384(小節長によらない)なので、u(m, t) = U[m] + L[m]·t/384。
// 小節 −1 はリードイン(長さ 1)。
//
// ガイド間隔 d は 4/4 の全音符を d 等分(1/16 = 16。DTXCreator §4.2 と同じ選択肢)。線は小節の頭から数え直す。
// (変更) 吸着はいちばん近い線(DTXCreator は下の線へ切り捨て。本アプリのチップは時刻の中心に描くので、
// チップの下の線がいちばん近い線になる。docs/spec/dtxcreator-ui.md §1.5)。

import { TICKS_PER_MEASURE } from '../core/dtx.js';
import { MAX_MEASURE } from './dtxdoc.js';

/** ガイド間隔の選択肢(0 = フリー = 1 tick)。 */
export const GUIDES = [4, 8, 12, 16, 24, 32, 48, 64, 0];

/** 拡大率の選択肢(1 = 4/4 の 1 小節が論理 400 px)。 */
export const ZOOMS = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 2.8, 4, 5.6];

/** 4/4 の 1 小節の論理 px(拡大率 1)。 */
export const PX_PER_MEASURE = 400;

const EPS = 1e-9;
const N = MAX_MEASURE + 2; // 小節 0..1000 の頭(U[1000] は 999 小節目の終わり)

/** 小節 m の位置 pos(リードイン込みの tick)。 */
export function posOf(measure, tick) {
  return (measure + 1) * TICKS_PER_MEASURE + tick;
}

export class MeasureGeometry {
  /**
   * @param {{pos:number, barLen:number}[]} tempoMap parseDTX の chart.tempoMap(barLen を持つ区間)
   */
  constructor(tempoMap) {
    this.L = new Float64Array(N);
    this.U = new Float64Array(N + 1);
    const map = tempoMap && tempoMap.length ? tempoMap : [{ pos: 0, barLen: 1 }];
    let si = 0;
    for (let m = 0; m < N; m++) {
      const pos = (m + 1) * TICKS_PER_MEASURE;
      while (si + 1 < map.length && map[si + 1].pos <= pos) si++;
      const L = map[si].barLen > 0 ? map[si].barLen : 1;
      this.L[m] = L;
      this.U[m + 1] = this.U[m] + L;
    }
  }

  /** 小節の長さ(4/4 = 1)。−1(リードイン)は 1、範囲の外は端の値。 */
  len(m) {
    if (m < 0) return 1;
    return this.L[Math.min(m, N - 1)];
  }

  /** 小節の頭の u。 */
  start(m) {
    if (m < 0) return m === -1 ? -1 : -1 + m + 1;
    if (m <= N) return this.U[m];
    return this.U[N] + (m - N) * this.L[N - 1];
  }

  /** (小節, tick) の u。tick は小数でもよい。 */
  u(measure, tick) {
    return this.start(measure) + (this.len(measure) * tick) / TICKS_PER_MEASURE;
  }

  /** 位置 pos の u。 */
  uOfPos(pos) {
    const m = Math.floor(pos / TICKS_PER_MEASURE) - 1;
    return this.u(m, pos - (m + 1) * TICKS_PER_MEASURE);
  }

  /** u を含む小節(U[m] <= u の最大の m。u < 0 は −1。999 より後ろも外挿して返す)。 */
  measureAt(u) {
    if (u < 0) return -1;
    if (u >= this.U[N]) return N + Math.floor((u - this.U[N]) / this.L[N - 1] + EPS);
    let lo = 0;
    let hi = N - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.U[mid] <= u + EPS) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }

  /** u → {measure, tickF}(tickF は小数の tick)。 */
  locate(u) {
    const m = this.measureAt(u);
    return { measure: m, tickF: (TICKS_PER_MEASURE * (u - this.start(m))) / this.len(m) };
  }

  /** u → 位置 pos(小数)。 */
  posOfU(u) {
    const { measure, tickF } = this.locate(u);
    return posOf(measure, tickF);
  }

  /**
   * いちばん近いガイド線のセル {measure, tick}。リードインは null。
   * tick は parseDTX と同じ floor(384·i/N) の形(384·k/(d·L) の切り捨て)。小節の終わりに近い短いセルは次の小節の頭。
   * @param {number} u
   * @param {number} d ガイド間隔(GUIDES。0 = フリー)
   */
  snap(u, d) {
    const m = this.measureAt(u);
    if (m < 0) return null;
    const off = u - this.start(m);
    const Lm = this.len(m);
    if (!d) {
      const t = Math.round((off / Lm) * TICKS_PER_MEASURE);
      return t >= TICKS_PER_MEASURE ? { measure: m + 1, tick: 0 } : { measure: m, tick: Math.max(0, t) };
    }
    const k = Math.floor(off * d + 0.5); // 同点は後ろの線
    if (k / d >= Lm - EPS || Lm - off < Math.abs(off - k / d)) return { measure: m + 1, tick: 0 };
    return { measure: m, tick: guideTick(Math.max(0, k), d, Lm) };
  }

  /**
   * (measure, tick) から次(dir = 1)/ 前(dir = −1)のガイド線のセル。リードインの頭(−1, 0)より前へは行かない。
   * @returns {{measure:number, tick:number}}
   */
  step(measure, tick, d, dir) {
    if (!d) {
      let t = tick + dir;
      let m = measure;
      if (t >= TICKS_PER_MEASURE) { m++; t = 0; }
      else if (t < 0) { m--; t = TICKS_PER_MEASURE - 1; }
      return m < -1 ? { measure: -1, tick: 0 } : { measure: m, tick: t };
    }
    const Lm = this.len(measure);
    const off = (Lm * tick) / TICKS_PER_MEASURE;
    if (dir > 0) {
      // tick より後ろの最初のガイド線(線の tick は切り捨てなので、線の上にいても「次」が同じ tick にならないよう tick + 1 から探す)
      const k = Math.ceil(((tick + 1) * d * Lm) / TICKS_PER_MEASURE - EPS);
      if (k / d >= Lm - EPS) return { measure: measure + 1, tick: 0 };
      return { measure, tick: guideTick(k, d, Lm) };
    }
    const k = Math.ceil(off * d - EPS) - 1;
    if (k >= 0) return { measure, tick: guideTick(k, d, Lm) };
    if (measure <= -1) return { measure: -1, tick: 0 };
    const pm = measure - 1;
    const Lp = this.len(pm);
    const last = Math.ceil(Lp * d - EPS) - 1;
    return { measure: pm, tick: guideTick(Math.max(0, last), d, Lp) };
  }
}

/** 小節長 L の小節の k 本目のガイド線の tick(parseDTX の floor(384·i/N) と同じ切り捨て)。 */
export function guideTick(k, d, L) {
  return Math.floor((TICKS_PER_MEASURE * k) / (d * L) + EPS);
}

/** 拡大率の一覧の中でいちばん近いもの。 */
export function nearestZoom(z) {
  let best = ZOOMS[0];
  for (const v of ZOOMS) if (Math.abs(Math.log(v / z)) < Math.abs(Math.log(best / z))) best = v;
  return best;
}
