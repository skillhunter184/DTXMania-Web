// ギター / ベースの成績(スコア・コンボ・ゲージ・達成率)と、押さえ方の照合・チップの探し方。
// NX CStagePerfCommonScreen(tProcessChipHit / tHandleInput_GuitarBass / DoWailingFromQueue)・CActPerfCommonScore・
// CActPerfCommonGauge・CScoreIni、DTXManiaAI GuitarPerformanceStage / PerformanceResult の移植。docs/spec/guitar-bass.md。
// 判定 index はドラムと同じ 0=Perfect 1=Great 2=Good 3=Ok(NX Poor) 4=Miss。

import { JUDGE } from './hitranges.js';
import { GAUGE_MAX, GAUGE_INITIAL, GAUGE_FAIL, GAUGE_DANGER, DAMAGE_FACTOR, SCORE_MAX } from './judge.js';
import { GB_LANE_BITS, GB_BITS_MASK } from '../core/dtx.js';
import { GB_AUTO_PICK } from './training.js';

const f32 = Math.fround;

/**
 * ギター / ベースのゲージの増減(NX fDamageGaugeDelta のギター・ベース列。ドラムの XG 用の上書き
 * [0.005, 0.001, 0, -0.017, -0.041] はドラム列だけで、ギター / ベースは XG でもこの値)。Miss にだけ DAMAGE_FACTOR が掛かる。
 */
export const GB_GAUGE_DELTA = [0.006, 0.003, 0.0, -0.030, -0.050];

/** ウェイリングの予約の幅(ピックの時刻 ± この ms のウェイリングチップ)と、成立の幅(チップの時刻からこの ms 以内に Wail)。 */
export const WAIL_RESERVE_MS = 140;
export const WAIL_ACCEPT_MS = 1000;

/** ロングノートを押さえ続けたときの加点(長さを 6 等分した区切りごとに 100 点、最大 5 回。NX 5389-5405)。 */
export const LN_TICK_SCORE = 100;
export const LN_TICK_MAX = 5;

/**
 * 1 チップぶんのスコア増分(NX XG のギター / ベース。float32・切り捨て)。ドラムの scoreDelta と同じ式で、違いは
 * ボーナスチップの控除が無いこと、全 Perfect の補正にロングノートの加点 lnBonus を足すこと、補正に使う Perfect 数
 * (AUTO 込み)と ×50 を外す Perfect 数(AUTO 抜き)が別なこと。
 * (変更) 補正は DTXManiaAI・本アプリのドラムと同じく掛け算の前に返す。NX はチップ数 50 未満の譜面で補正にもコンボ数を掛け、
 * 全 Perfect が 1,000,000 にならない。
 * @param {number} combo このチップを含めたコンボ
 * @param {number} perfectIncAuto このチップを含めた Perfect 数(AUTO 込み)
 * @param {number} perfectExclAuto 同(AUTO 抜き)
 * @param {number} trueScore 今のスコア(端数込み)
 */
export function gbScoreDelta(judge, combo, perfectIncAuto, perfectExclAuto, totalNotes, trueScore, lnBonus = 0) {
  if (totalNotes <= 0 || judge < 0 || judge > 2) return 0;
  if (judge === JUDGE.PERFECT && combo >= totalNotes && perfectIncAuto >= totalNotes) {
    return Math.trunc(f32(f32(1000000 - f32(trueScore)) + f32(lnBonus)));
  }
  const base = f32(1000000 / f32(1275 + f32(50 * f32(totalNotes - 50))));
  let delta;
  if (judge === JUDGE.PERFECT) delta = combo < totalNotes ? base : 0;
  else if (judge === JUDGE.GREAT) delta = f32(base * 0.5);
  else delta = f32(base * f32(0.2));
  if (combo < 50) delta = f32(delta * combo);
  else if (combo !== totalNotes && perfectExclAuto !== totalNotes) delta = f32(delta * 50);
  return Math.trunc(delta);
}

/** ウェイリングの加点(NX XG: コンボが 500 を超えたら 50000、それまではコンボ × 100)。 */
export function wailingBonus(combo) {
  return combo > 500 ? 50000 : combo * 100;
}

/** ネックの 5 ボタンとピックが全部 AUTO か(NX bAllGuitarsAreAutoPlay。ウェイリングは見ない)。 */
export function allGbAuto(autoLanes) {
  for (let i = 0; i <= GB_AUTO_PICK; i++) if (!autoLanes[i]) return false;
  return true;
}

/** AUTO のネックのボタンのビット(NX nAutoMask のうちチップに現れる R G B Y P)。 */
export function gbAutoMask(autoLanes) {
  let m = 0;
  for (let i = 0; i < GB_LANE_BITS.length; i++) if (autoLanes[i]) m |= GB_LANE_BITS[i];
  return m;
}

/**
 * スコアの AUTO 補正(NX CActPerfCommonScore.Add の rev)。全 AUTO でなければ、ピックが AUTO で 1/2、ネックのどれかが
 * AUTO でさらに 1/2。全 AUTO は AutoAddGage が無ければ 0。チップ・ロングノート・ウェイリングの加点すべてに掛かる。
 */
export function gbScoreRevise(autoLanes, autoAddGage = false) {
  if (allGbAuto(autoLanes)) return autoAddGage ? 1 : 0;
  let r = 1;
  if (autoLanes[GB_AUTO_PICK]) r /= 2;
  for (let i = 0; i < GB_LANE_BITS.length; i++) {
    if (autoLanes[i]) { r /= 2; break; }
  }
  return r;
}

/**
 * 達成率の AUTO 補正(NX CScoreIni.dbCalcReviseValForDrGtBsAutoLanes。スコアの rev とは別の式)。
 * 全 AUTO なら 1。それ以外はピックが AUTO で 1/2、AUTO のネックのボタン数 n で 1/√(n+1)。ウェイリングは見ない。
 */
export function gbAchievementRevise(autoLanes) {
  if (allGbAuto(autoLanes)) return 1;
  let r = 1;
  if (autoLanes[GB_AUTO_PICK]) r /= 2;
  let n = 0;
  for (let i = 0; i < GB_LANE_BITS.length; i++) if (autoLanes[i]) n++;
  return r / Math.sqrt(n + 1);
}

/**
 * 押さえ方がチップと合っているか(NX 5455: (chip & ~autoMask & 0x3F) == (pressed & ~autoMask & 0x3F))。
 * AUTO のボタンは比べない。押さえすぎも外れ(上位のボタンを押していれば下は無視、のような扱いは無い)。
 */
export function fretsMatch(chipBits, pressedBits, autoMask) {
  const m = ~autoMask & GB_BITS_MASK;
  return (chipBits & m) === (pressedBits & m);
}

/**
 * ピックで狙うチップ(NX r指定時刻に一番近いChip の「過去優先」。DTXManiaAI HandlePick)。
 * 窓(ms、譜面時刻差)の中に過去(時刻 ≤ inputMs)の未判定チップがあれば距離に関係なくいちばん新しい過去のチップ、
 * 無ければ窓の中の最初の未来のチップ。どちらも無ければ -1。notes は時刻順。
 */
export function findPickTarget(notes, judged, inputMs, windowMs) {
  let past = -1;
  for (let i = 0; i < notes.length; i++) {
    if (judged[i]) continue;
    const dt = notes[i].timeMs - inputMs;
    if (dt <= 0) {
      if (-dt <= windowMs) past = i; // 時刻順に見ているので、最後に残ったものがいちばん近い過去のチップ
    } else {
      if (past >= 0) return past;
      return dt <= windowMs ? i : -1;
    }
  }
  return past;
}

/**
 * AUTO ピックでバーを通過したチップの成否(NX 4373-4388)。チップの構成ボタンが AUTO のボタンの集合とちょうど同じなら
 * 押さえ方を見ずに成功(「この条件を加えないと、同時に非 auto レーンを押下している時に NG となってしまう」)。
 * それ以外は手動のボタンそれぞれで「チップにある ⇔ 押している」なら成功。OPEN は手動のボタンを何も押していなければ成功。
 */
export function autoPickHits(chipBits, pressedBits, autoLanes) {
  let sameAsAutoSet = true;
  for (let i = 0; i < GB_LANE_BITS.length; i++) {
    if (((chipBits & GB_LANE_BITS[i]) !== 0) !== !!autoLanes[i]) { sameAsAutoSet = false; break; }
  }
  if (sameAsAutoSet) return true;
  for (let i = 0; i < GB_LANE_BITS.length; i++) {
    if (autoLanes[i]) continue;
    const bit = GB_LANE_BITS[i];
    if (((chipBits & bit) !== 0) !== ((pressedBits & bit) !== 0)) return false;
  }
  return true;
}

/**
 * チップが AUTO チップか(NX bCheckAutoPlay)。ピックが AUTO で、チップの構成ボタンが全部 AUTO のとき。
 * OPEN はネックの 5 ボタンが全部 AUTO のときだけ。
 */
export function isAutoChip(note, autoLanes) {
  if (!autoLanes[GB_AUTO_PICK]) return false;
  if (note.open) {
    for (let i = 0; i < GB_LANE_BITS.length; i++) if (!autoLanes[i]) return false;
    return true;
  }
  return (note.bits & ~gbAutoMask(autoLanes) & GB_BITS_MASK) === 0;
}

/**
 * 達成率(%)(NX CScoreIni.tCalculatePlayingSkill の XG)。counts は AUTO 抜き。
 * 手動の判定が 1 つも無いうち(全 AUTO を含む)はコンボの項を 0 にする(NX は「N == AUTO チップ + 未判定」で判定する)。
 */
export function gbAchievementRate(counts, maxCombo, total, revise = 1) {
  if (total <= 0) return 0;
  const judged = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  const comboRate = judged === 0 ? 0 : (100 * maxCombo) / total;
  return (((100 * counts[0]) / total) * 0.85 + ((100 * counts[1]) / total) * 0.35 + comboRate * 0.15) * revise;
}

/**
 * ギター / ベース 1 パートの成績。ドラムの PlayStats と同じ持ち方(counts = AUTO 抜き、countsIncAuto = AUTO 込み)。
 * スコアは NX と同じく端数(AUTO 補正の 1/2・1/4)を持ったまま足し、表示で切り捨てる。
 * (変更) 足すたびに 0〜SCORE_MAX に収める(ドラムの PlayStats・DTXManiaAI と同じ)。NX は収めないので、チップが 25 個未満の
 * 譜面では 1 チップの点が負になり、スコアが負になる。
 */
export class GbStats {
  constructor(totalNotes = 0) {
    this.totalNotes = totalNotes;
    this.damageLevel = 1; // 0 Easy / 1 Normal / 2 Hard
    this.reset();
  }

  reset() {
    this.counts = [0, 0, 0, 0, 0];
    this.countsIncAuto = [0, 0, 0, 0, 0];
    this.combo = 0;
    this.maxCombo = 0;
    this.trueScore = 0;
    this.lnBonus = 0; // ロングノートの加点の合計(AUTO 補正の前。全 Perfect の補正に足す)
    this.lapPerfects = 0; // この回(リセット・ループ折り返し・数え直しの後)の Perfect の数(AUTO 込み)
    this.lapJudged = 0; // この回に判定したチップの数(AUTO 込み)
    this.gauge = GAUGE_INITIAL;
    this.earlyCount = 0;
    this.lateCount = 0;
    this.lastJudge = -1;
    this.lastLagMs = 0;
  }

  /**
   * ループ折り返し(NX CStagePerfGuitarScreen 311-327: AUTO 抜きの数・コンボ・最大コンボ・スコア・早い / 遅いを戻す。
   * AUTO 込みの数とゲージは残す)。ロングノートの加点の合計は折り返しの曲内ジャンプで戻る(NX tJumpInSong。GuitarPlayer.jumpTo)。
   */
  resetForLoop() {
    this.counts = [0, 0, 0, 0, 0];
    this.lapPerfects = 0;
    this.lapJudged = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.trueScore = 0;
    this.earlyCount = 0;
    this.lateCount = 0;
  }

  /** 表示するスコア(端数を切り捨てて 0〜SCORE_MAX)。 */
  get score() {
    return Math.max(0, Math.min(SCORE_MAX, Math.trunc(this.trueScore)));
  }

  /** AUTO 抜きの判定数の合計。 */
  get total() {
    return this.counts[0] + this.counts[1] + this.counts[2] + this.counts[3] + this.counts[4];
  }

  get totalIncAuto() {
    const c = this.countsIncAuto;
    return c[0] + c[1] + c[2] + c[3] + c[4];
  }

  get isDanger() {
    return this.gauge <= GAUGE_DANGER;
  }

  get isFailed() {
    return this.gauge <= GAUGE_FAIL;
  }

  gaugeDeltaFor(j) {
    let d = GB_GAUGE_DELTA[j];
    if (j === JUDGE.MISS) d *= DAMAGE_FACTOR[Math.max(0, Math.min(2, this.damageLevel))];
    return d;
  }

  _gauge(j) {
    this.gauge = Math.min(GAUGE_MAX, this.gauge + this.gaugeDeltaFor(j));
  }

  /** 加点(AUTO 補正 rev を掛けて足す。NX actScore.Add)。 */
  addScore(delta, rev = 1) {
    this.trueScore = Math.max(0, Math.min(SCORE_MAX, this.trueScore + delta * rev));
  }

  /**
   * チップ 1 個の判定(NX tProcessChipHit のギター / ベース)。
   * @param {number} j 判定 index
   * @param {{auto?: boolean, lagMs?: number, rev?: number, autoAddGage?: boolean, demo?: boolean}} opts
   *   auto: AUTO チップ(AUTO 込みの数にだけ入れ、早い / 遅いを数えない。ゲージは autoAddGage のときだけ)。
   *   demo: 自動演奏(全部 AUTO)の判定。本アプリのドラムの自動演奏と同じく、手動の Perfect と同じに数える(早い / 遅いは数えない)。
   *   rev: スコアの AUTO 補正。コンボは AUTO でも進む(NX はギター / ベースのコンボに AUTO の条件が無い)。
   */
  judge(j, opts = {}) {
    const auto = !!opts.auto && !opts.demo;
    const lagMs = opts.lagMs || 0;
    this.countsIncAuto[j]++;
    if (!auto) this.counts[j]++;
    this.lapJudged++;
    if (j === JUDGE.PERFECT) this.lapPerfects++;
    this.lastJudge = j;
    this.lastLagMs = lagMs;
    if (!auto && !opts.demo) {
      if (lagMs > 0) this.lateCount++;
      else this.earlyCount++;
    }
    if (j === JUDGE.PERFECT || j === JUDGE.GREAT || j === JUDGE.GOOD) {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      // (変更) 全 Perfect の補正に使う AUTO 込みの Perfect 数は、この回のもの。NX は AUTO 込みの数をループで戻さないので、
      // トレーニングで 2 周目以降はフルコンボなら Perfect でなくても 1,000,000 になる(NX はトレーニングでスコアを出さない)
      const d = gbScoreDelta(j, this.combo, this.lapPerfects, this.counts[0], this.totalNotes, this.trueScore, this.lnBonus);
      this.addScore(d, opts.demo ? 1 : opts.rev === undefined ? 1 : opts.rev);
    } else {
      this.combo = 0;
    }
    if (!auto || opts.autoAddGage) this._gauge(j);
  }

  /**
   * 空ピック(押さえ方の違うピック・窓の外のピック)の BAD(NX tチップのヒット処理_Bad。Light が OFF のときだけ)。
   * コンボを切ってゲージを Miss と同じだけ減らす。判定の数・早い / 遅い・最大コンボには数えない。
   */
  bad() {
    this.combo = 0;
    this._gauge(JUDGE.MISS);
  }

  /** ロングノートの区切り 1 回の加点。 */
  lnTick(rev = 1) {
    this.lnBonus += LN_TICK_SCORE;
    this.addScore(LN_TICK_SCORE, rev);
  }

  /** ウェイリング成立の加点(今のコンボで決まる)。 */
  wail(rev = 1) {
    this.addScore(wailingBonus(this.combo), rev);
  }

  /**
   * 曲を最後まで演奏したときのフルコンボの加点(NX CStagePerfGuitarScreen 242-294: AUTO 抜きの Poor + Miss が 0 なら、
   * Perfect がチップ数と同じとき +30000、それ以外 +15000。AUTO 補正は掛けない)。allAuto なら Perfect は AUTO 込み(この回)で数える。
   * @returns {number} 足した点(0 なら足していない)
   */
  fullComboBonus(allAuto = false) {
    if (this.totalNotes <= 0 || this.counts[JUDGE.OK] + this.counts[JUDGE.MISS] !== 0) return 0;
    const perfects = allAuto ? this.lapPerfects : this.counts[0]; // AUTO 込みはこの回の数(NX は通しの数)
    const bonus = perfects >= this.totalNotes ? 30000 : 15000;
    this.addScore(bonus);
    return bonus;
  }

  /** 判定数の割合(%)の文字列。分母は AUTO 込みの判定数(NX のギターの演奏中の表示)。 */
  ratePercent(count) {
    const t = this.totalIncAuto;
    if (t <= 0) return '0%';
    return Math.round((100 * count) / t) + '%';
  }

  achievement(revise = 1) {
    return gbAchievementRate(this.counts, this.maxCombo, this.totalNotes, revise);
  }

  get fullCombo() {
    return this.counts[JUDGE.OK] === 0 && this.counts[JUDGE.MISS] === 0 && this.totalNotes > 0 && this.total > 0;
  }
}
