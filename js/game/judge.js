// スコア・コンボ・ゲージ・達成率(DTXManiaAI PerformanceResult.cs / PerformanceStage.cs の Judge 系の移植)。
// 判定 index: 0=Perfect 1=Great 2=Good 3=Ok 4=Miss

import { JUDGE } from './hitranges.js';

export const GAUGE_MAX = 1.0;
export const GAUGE_INITIAL = 2 / 3;
export const GAUGE_FAIL = -0.1;
export const GAUGE_DANGER = 0.3;
export const GAUGE_DELTA = [0.005, 0.001, 0.0, -0.017, -0.041];
export const DAMAGE_FACTOR = [0.25, 0.5, 0.75]; // Easy / Normal / Hard(Miss のみに掛かる)
export const SCORE_MAX = 9999999;

const f32 = Math.fround;

/**
 * 1 チップぶんのスコア増分(PerformanceResult.ScoreDelta。float32 演算・切り捨て)。
 * combo / perfectCount はこのチップを含めた値。
 */
export function scoreDelta(judge, combo, perfectCount, totalNotes, currentScore, bonusChipCount) {
  if (totalNotes <= 0 || judge < 0 || judge > 2) return 0;
  if (judge === 0 && combo >= totalNotes && perfectCount >= totalNotes) return Math.trunc(f32(1000000 - currentScore));
  const base = f32(f32(1000000 - f32(500 * bonusChipCount)) / f32(1275 + f32(50 * f32(totalNotes - 50))));
  let delta;
  if (judge === 0) delta = combo < totalNotes ? base : 0;
  else if (judge === 1) delta = f32(base * 0.5);
  else delta = f32(base * f32(0.2)); // 0.2f(float32 定数)との積
  if (combo < 50) delta = f32(delta * combo);
  else if (combo !== totalNotes && perfectCount !== totalNotes) delta = f32(delta * 50);
  return Math.trunc(delta);
}

/** 達成率(%)。P%×0.85 + G%×0.35 + MaxCombo%×0.15。 */
export function achievementRate(counts, maxCombo, total, allLanesAuto = false) {
  if (total <= 0) return 0;
  const comboRate = allLanesAuto ? 0 : (100 * maxCombo) / total;
  return ((100 * counts[0]) / total) * 0.85 + ((100 * counts[1]) / total) * 0.35 + comboRate * 0.15;
}

/**
 * レーン別 AUTO による達成率の補正係数(PerformanceResult.AutoLaneRevise。NX の演算子優先順位の癖も再現)。
 * BD だけ AUTO(LP 手動・LBD フラグ無し)→ 0.5、LP だけ AUTO または LBD フラグ → 0.5、それ以外 1.0。
 */
export function autoLaneRevise(laneAuto, lbdAuto = false, allLanesAuto = false) {
  if (!laneAuto || allLanesAuto) return 1.0;
  const bd = !!laneAuto[5];
  const lp = !!laneAuto[2];
  if (bd && !lp && !lbdAuto) return 0.5;
  if ((!bd && lp) || lbdAuto) return 0.5;
  return 1.0;
}

export function rankOf(rate, total) {
  if (total <= 0) return '-';
  if (rate >= 95) return 'SS';
  if (rate >= 80) return 'S';
  if (rate >= 73) return 'A';
  if (rate >= 63) return 'B';
  if (rate >= 53) return 'C';
  if (rate >= 45) return 'D';
  return 'E';
}

/** 演奏成績。ResetPlayStats / Judge / AutoJudge / ループ折り返しのリセット規則を持つ。 */
export class PlayStats {
  constructor(totalNotes = 0, bonusChipCount = 0) {
    this.totalNotes = totalNotes;
    this.bonusChipCount = bonusChipCount;
    this.damageLevel = 1; // 0 Easy / 1 Normal / 2 Hard
    this.reset();
  }

  /** 成績を全部リセット(ResetPlayStats)。 */
  reset() {
    this.counts = [0, 0, 0, 0, 0];
    this.countsIncAuto = [0, 0, 0, 0, 0];
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.gauge = GAUGE_INITIAL;
    this.earlyCount = 0;
    this.lateCount = 0;
    this.lastJudge = -1;
    this.lastLagMs = 0;
  }

  /** ループ折り返しのリセット(ゲージと countsIncAuto は残す)。 */
  resetForLoop() {
    this.counts = [0, 0, 0, 0, 0];
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
  }

  get total() {
    return this.counts[0] + this.counts[1] + this.counts[2] + this.counts[3] + this.counts[4];
  }

  gaugeDeltaFor(j) {
    let d = GAUGE_DELTA[j];
    if (j === JUDGE.MISS) d *= DAMAGE_FACTOR[Math.max(0, Math.min(2, this.damageLevel))];
    return d;
  }

  get isDanger() {
    return this.gauge <= GAUGE_DANGER;
  }

  get isFailed() {
    return this.gauge <= GAUGE_FAIL;
  }

  /**
   * 手動ヒット・ミス・全レーン AUTO の判定(PerformanceStage.Judge)。
   * @param {number} j 判定 index
   * @param {{bonus:boolean}} note
   * @param {number} lagMs 正=遅い / 負=早い
   * @param {{auto?:boolean}} [opts] auto: 全レーン AUTO による判定(早い/遅いを数えない)
   */
  judge(j, note, lagMs = 0, opts = {}) {
    this.counts[j]++;
    this.countsIncAuto[j]++;
    this.lastJudge = j;
    this.lastLagMs = lagMs;
    if (!opts.auto) {
      if (lagMs > 0) this.lateCount++;
      else this.earlyCount++;
    }
    if (j === JUDGE.PERFECT || j === JUDGE.GREAT || j === JUDGE.GOOD) {
      this.combo++;
      if (note && note.bonus && j !== JUDGE.GOOD) this.score += 500;
      this.score += scoreDelta(j, this.combo, this.counts[0], this.totalNotes, this.score, this.bonusChipCount);
      this.score = Math.max(0, Math.min(SCORE_MAX, this.score));
    } else {
      this.combo = 0;
    }
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.gauge = Math.min(GAUGE_MAX, this.gauge + this.gaugeDeltaFor(j));
  }

  /**
   * レーン別 AUTO の判定(AutoJudge)。counts には入れず countsIncAuto のみ。
   * @param {{bonus:boolean}} note
   * @param {{allLanesAuto?:boolean, autoAddGage?:boolean}} opts
   */
  autoJudge(note, opts = {}) {
    this.countsIncAuto[0]++;
    if (note && note.bonus && (!opts.allLanesAuto || opts.autoAddGage)) {
      this.score = Math.min(SCORE_MAX, this.score + 500);
    }
    if (opts.allLanesAuto) {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }
    if (opts.autoAddGage) {
      this.score += scoreDelta(0, this.combo, this.countsIncAuto[0], this.totalNotes, this.score, this.bonusChipCount);
      this.score = Math.max(0, Math.min(SCORE_MAX, this.score));
      this.gauge = Math.min(GAUGE_MAX, this.gauge + 0.005);
    }
  }

  /** score_detailed 用の割合(%)文字列。 */
  ratePercent(count) {
    const t = this.total;
    if (t <= 0) return '0%';
    return Math.round((100 * count) / t) + '%';
  }

  achievement(allLanesAuto = false, laneAuto = null, lbdAuto = false) {
    return achievementRate(this.counts, this.maxCombo, this.totalNotes, allLanesAuto) * autoLaneRevise(laneAuto, lbdAuto, allLanesAuto);
  }

  get fullCombo() {
    return this.counts[3] === 0 && this.counts[4] === 0 && this.totalNotes > 0 && this.total > 0;
  }
}
