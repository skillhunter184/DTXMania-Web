// 判定ウィンドウと打ち分け(DTXManiaAI HitRanges.cs / DrumGroups.cs = NX STHitRanges / CStagePerfDrumsScreen 移植)。

/** 判定 index。0=Perfect 1=Great 2=Good 3=Ok(NX Poor) 4=Miss */
export const JUDGE = { PERFECT: 0, GREAT: 1, GOOD: 2, OK: 3, MISS: 4 };
export const JUDGE_NAMES = ['Perfect', 'Great', 'Good', 'Ok', 'Miss'];

export class HitRanges {
  constructor(perfect = 34, great = 67, good = 84, ok = 117) {
    this.perfectMs = perfect;
    this.greatMs = great;
    this.goodMs = good;
    this.okMs = ok;
  }
  /** NX 既定の DTX 判定幅(34/67/84/117)。 */
  static get default() {
    return new HitRanges(34, 67, 84, 117);
  }
  /** 判定時刻差(絶対値 ms)→ 判定 index。小さい順に最初に収まった窓を採る。 */
  judge(absDeltaMs) {
    if (absDeltaMs <= this.perfectMs) return JUDGE.PERFECT;
    if (absDeltaMs <= this.greatMs) return JUDGE.GREAT;
    if (absDeltaMs <= this.goodMs) return JUDGE.GOOD;
    if (absDeltaMs <= this.okMs) return JUDGE.OK;
    return JUDGE.MISS;
  }
  /** チップ探索に使う最大窓(NX も Poor 窓までを探索対象にする)。 */
  get searchWindowMs() {
    return Math.max(this.perfectMs, this.greatMs, this.goodMs, this.okMs);
  }
}

/** LP レーンに統合されている LBD の元チャンネル。 */
export const LEFT_BASS_DRUM_CHANNEL = 0x1c;

/**
 * 演奏開始時の実効グループ値(NX 準拠の自動降格)。
 * 譜面に LC チップが無ければ HH グループを共通側へ、RD チップが無ければ CY=共通。
 */
export function applyChartDowngrade(chartHasLC, chartHasRD, groups) {
  const g = { ...groups };
  if (!chartHasLC && (g.hhGroup === 0 || g.hhGroup === 2)) g.hhGroup = 3;
  if (!chartHasRD && g.cyGroup === 0) g.cyGroup = 1;
  return g;
}

/**
 * パッド(キーを割り当てたレーン)で検索するレーン集合。配列順は NX のチップ配列順。
 * HHGroup: 0=全部打ち分け 1=HHのみ 2=LCのみ 3=全部共通 / FT・CYGroup: 0=打ち分け 1=共通 /
 * BDGroup: 0=打ち分け 1=BDとLP 2=左右ペダルのみ 3=どっちもBD
 */
export function searchLanes(pad, { hhGroup = 0, ftGroup = 0, cyGroup = 0, bdGroup = 0 } = {}) {
  switch (pad) {
    case 0: return hhGroup === 1 || hhGroup === 3 ? [1, 0] : [0];
    case 1: return hhGroup === 1 || hhGroup === 3 ? [1, 0] : [1];
    case 6: return ftGroup === 1 ? [6, 7] : [6];
    case 7: return ftGroup === 1 ? [7, 6] : [7];
    case 8: return cyGroup === 1 ? [8, 9] : [8];
    case 9: return cyGroup === 1 ? [8, 9] : [9];
    case 5: return bdGroup === 1 || bdGroup === 3 ? [5, 2] : [5];
    case 2: return bdGroup === 3 ? [2, 5] : [2];
    default: return [pad];
  }
}

/** 同一時刻に複数レーンの候補があるとき 1 打で全部ヒットさせるか(LC/CY/RD パッドは先着 1 個のみ)。 */
export function tieHitsAll(pad) {
  return pad !== 0 && pad !== 8 && pad !== 9;
}
