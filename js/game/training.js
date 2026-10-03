// トレーニングモード専用設定(DTXManiaAI TrainingSettings.cs 移植)。
// 通常演奏の設定とは別に持ち、localStorage の 'dojo.training' へ保存する。
// ループ位置(開始/終了)は譜面ごとの値なので保存しない。

import { buildMeasureTimes, measureIndexAt, LANE_COUNT } from '../core/dtx.js';
import { t } from '../i18n.js';

export const LOOP_UNIT = { MEASURE: 0, SECOND: 1 };

export const NOTE_OFFSET_MIN = -999, NOTE_OFFSET_MAX = 999;
export const JUDGE_OFFSET_MIN = -99, JUDGE_OFFSET_MAX = 99;
export const START_WAIT_MIN = 0, START_WAIT_MAX = 5000, START_WAIT_STEP = 100;
export const LOOP_SECOND_STEP_MS = 500;
// ハイスピードは 0.1 刻みで持つ(= 倍率 × 10)。元実装は 0.5 刻みの整数
// (docs/spec/nx-docs.md:346「ハイスピード (x0.5 steps)」)だが、0.5 では粗すぎるので細かくした。
export const SCROLL_SPEED_MIN = 1, SCROLL_SPEED_MAX = 2000; // x0.1 〜 x200.0
export const PLAY_SPEED_MIN = 5, PLAY_SPEED_MAX = 40;
export const AUTO_LANE_COUNT = 11; // 0-9 がレーン、10 が LBD(NX 互換で 11 桁保つ)
export const AUTO_LANE_LBD = 10;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class TrainingSettings {
  constructor() {
    /** 自動演奏(全レーン)。 */
    this.autoPlay = false;
    /** レーン別 AUTO。 */
    this.autoLanes = new Array(AUTO_LANE_COUNT).fill(false);
    /** ノーツ表示調整(±ms)。正の値でノーツが遅く流れる。判定には影響しない。 */
    this.noteOffsetMs = 0;
    /** 判定タイミング調整(±ms)。 */
    this.judgeOffsetMs = 0;
    /** ハイスピード(表示倍率 = 値 × 0.5)。 */
    this.scrollSpeedTenth = 10; // x1.0
    /** 演奏速度(値 / 20 が倍率。5〜40 = x0.25〜x2.00)。 */
    this.playSpeed = 20;
    /** 演奏開始待ち時間(ms)。 */
    this.startWaitMs = 1000;
    /** ループ演奏。 */
    this.loop = false;
    this.loopUnit = LOOP_UNIT.MEASURE;
    /** ループ開始/終了位置(ms、譜面時刻)。保存しない。 */
    this.loopBeginMs = 0;
    this.loopEndMs = 0;
  }

  get loopRangeValid() {
    return this.loopEndMs > this.loopBeginMs;
  }
  get playSpeedRatio() {
    return this.playSpeed / 20;
  }
  get hiSpeedRatio() {
    return this.scrollSpeedTenth * 0.1;
  }

  clamp() {
    this.noteOffsetMs = clamp(this.noteOffsetMs | 0, NOTE_OFFSET_MIN, NOTE_OFFSET_MAX);
    this.judgeOffsetMs = clamp(this.judgeOffsetMs | 0, JUDGE_OFFSET_MIN, JUDGE_OFFSET_MAX);
    this.scrollSpeedTenth = clamp(this.scrollSpeedTenth | 0, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX);
    this.playSpeed = clamp(this.playSpeed | 0, PLAY_SPEED_MIN, PLAY_SPEED_MAX);
    this.startWaitMs = clamp(this.startWaitMs | 0, START_WAIT_MIN, START_WAIT_MAX);
    this.startWaitMs = Math.floor(this.startWaitMs / START_WAIT_STEP) * START_WAIT_STEP;
    if (this.loopUnit !== LOOP_UNIT.MEASURE && this.loopUnit !== LOOP_UNIT.SECOND) this.loopUnit = LOOP_UNIT.MEASURE;
    this.autoPlay = !!this.autoPlay;
    this.loop = !!this.loop;
    if (!Array.isArray(this.autoLanes) || this.autoLanes.length !== AUTO_LANE_COUNT) {
      const a = new Array(AUTO_LANE_COUNT).fill(false);
      if (Array.isArray(this.autoLanes)) for (let i = 0; i < Math.min(a.length, this.autoLanes.length); i++) a[i] = !!this.autoLanes[i];
      this.autoLanes = a;
    }
    return this;
  }

  autoLanesToString() {
    return this.autoLanes.map((b) => (b ? '1' : '0')).join('');
  }
  autoLanesFromString(s) {
    if (!s) return;
    for (let i = 0; i < this.autoLanes.length && i < s.length; i++) this.autoLanes[i] = s[i] !== '0';
  }

  /** 保存用(ループ位置は含めない)。 */
  toJSON() {
    return {
      autoPlay: this.autoPlay,
      autoLanes: this.autoLanesToString(),
      noteOffsetMs: this.noteOffsetMs,
      judgeOffsetMs: this.judgeOffsetMs,
      scrollSpeedTenth: this.scrollSpeedTenth,
      playSpeed: this.playSpeed,
      startWaitMs: this.startWaitMs,
      loop: this.loop,
      loopUnit: this.loopUnit,
    };
  }

  static fromJSON(obj) {
    const s = new TrainingSettings();
    if (obj && typeof obj === 'object') {
      if ('autoPlay' in obj) s.autoPlay = !!obj.autoPlay;
      if (typeof obj.autoLanes === 'string') s.autoLanesFromString(obj.autoLanes);
      for (const k of ['noteOffsetMs', 'judgeOffsetMs', 'scrollSpeedTenth', 'playSpeed', 'startWaitMs', 'loopUnit']) {
        if (Number.isFinite(obj[k])) s[k] = obj[k];
      }
      // 0.5 刻みで保存されていた頃の設定を引き継ぐ(x0.5 の整数 → 0.1 刻み = ×5)
      if (!Number.isFinite(obj.scrollSpeedTenth) && Number.isFinite(obj.scrollSpeed)) {
        s.scrollSpeedTenth = obj.scrollSpeed * 5;
      }
      if ('loop' in obj) s.loop = !!obj.loop;
    }
    return s.clamp();
  }

  static load(storage = globalThis.localStorage) {
    try {
      const raw = storage && storage.getItem('dojo.training');
      return TrainingSettings.fromJSON(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return new TrainingSettings();
    }
  }

  save(storage = globalThis.localStorage) {
    try {
      storage && storage.setItem('dojo.training', JSON.stringify(this.toJSON()));
    } catch (e) {
      /* ignore */
    }
  }
}

export { buildMeasureTimes, measureIndexAt };

/**
 * ループ位置を delta 段ぶん動かした時刻を返す。
 * 小節単位: 小節頭へスナップして ±1 小節(小節の途中での「−」はまずその小節頭へ寄せる)。
 * 秒単位: LOOP_SECOND_STEP_MS 刻み。どちらも 0〜durationMs に収める。
 */
export function stepLoopTime(currentMs, delta, unit, measureTimes, durationMs) {
  const maxMs = Math.max(0, durationMs);
  if (unit === LOOP_UNIT.MEASURE && measureTimes && measureTimes.length > 0) {
    let idx = measureIndexAt(measureTimes, currentMs);
    if (delta < 0 && currentMs > measureTimes[idx]) delta++;
    idx = clamp(idx + delta, 0, measureTimes.length - 1);
    return clamp(measureTimes[idx], 0, maxMs);
  }
  return clamp(currentMs + LOOP_SECOND_STEP_MS * delta, 0, maxMs);
}

/** ループ終了位置を動かす。開始位置と同じか手前になるなら「開始位置の 1 段うしろ」へ。それも無理なら現在値。 */
export function stepLoopEnd(currentEndMs, beginMs, delta, unit, measureTimes, durationMs) {
  let v = stepLoopTime(currentEndMs, delta, unit, measureTimes, durationMs);
  if (v <= beginMs) v = stepLoopTime(beginMs, 1, unit, measureTimes, durationMs);
  return v > beginMs ? v : currentEndMs;
}

/** ループ開始位置を動かす。終了位置と同じか後ろになるなら「終了位置の 1 段手前」へ。それも無理なら現在値。 */
export function stepLoopBegin(currentBeginMs, endMs, delta, unit, measureTimes, durationMs) {
  let v = stepLoopTime(currentBeginMs, delta, unit, measureTimes, durationMs);
  if (v >= endMs) v = stepLoopTime(endMs, -1, unit, measureTimes, durationMs);
  return v < endMs ? v : currentBeginMs;
}

/** ループ位置の表示文字列("012 小節" / "24.5 s")。 */
export function formatLoopTime(timeMs, unit, measureTimes) {
  if (unit === LOOP_UNIT.MEASURE && measureTimes && measureTimes.length > 0) {
    return t('menu.measure', { n: String(measureIndexAt(measureTimes, timeMs)).padStart(3, '0') });
  }
  return (timeMs / 1000).toFixed(1) + ' s';
}

export function formatSignedMs(v) {
  return (v > 0 ? '+' : '') + v + ' ms';
}
