// 動画から譜面を作る 3 段目: 小節の格子を当てはめてチップを小節・tick に置く(vid2dtx/emit.py の移植。docs/spec/vid2dtx-gen.md §4)。
// 拍線の出来事に半拍の格子 t = t0 + h·half を最小二乗で当てはめる(= BPM。7/8 などの小節は線が 8 分ごとに引かれるので半拍で数える)。
// 明るい線(小節線)を 1 本ずつ小節の頭にするので、3/4・7/8 などの小節長の変化もそのまま #mmm02 になる(明るい線が抜けた所は 4/4 で埋める)。
// チップは小節の中の tick(384 / 小節)にする。吸着先は 12 の倍数(32 分)と 16 の倍数(24 分 = 3 連)を合わせた格子。
// 測りの揺れでは説明できないほど格子から外れたチップ(アーケードの譜面のわざと数 tick 遅いフィルなど)は一番近い 1/384 に残す。
// 音から作る譜面(js/gen/audio2dtx.js)も snapTick・quantize を使う。

import { rint, median, percentile, lineFit, bincount, argmax, mean, std } from './num.js';

export const HB_TICKS = 48; // 半拍の tick(4/4 の小節で 384)
export const BAR_HB = 8; // 4/4 の小節の半拍の数
// 小節線は、どの拍線よりもこれだけ明るい(V)ときだけ 1 本ずつ信じる。足りなければ多数決の位相だけを使う
export const LINE_V_GAP = 10;
// 12/16 の格子から max(OFFGRID_MS, OFFGRID_SIGMA × 譜面全体の格子からの散らばり, OFFGRID_RMS × そのチップの追跡の rms / 速さ)
// より外れたチップは、譜面の格子外のチップとして一番近い 1/384 に残す(rms の項は揺れる追跡(ペダルの絵など)を格子に置く)
export const OFFGRID_MS = 5;
export const OFFGRID_SIGMA = 4;
export const OFFGRID_RMS = 3;
// #BPM: 整数 / 小数 2 桁は、測った速さとの曲全体のずれがこれ未満のときだけ(BGM は録画の速さのまま)
export const BPM_DRIFT_MS = 1;
// (変更) 最初のチップの小節を数えるときの余裕(半拍の単位。12 の格子の半分 = 6 tick)。小節の頭のチップが測りの揺れで
// わずかに早く出ても(吸着すると次の小節の 0 になる)、前の小節のチップと数えない(vid2dtx は 1e-6 だけで、空の小節が 1 つ増えた)
export const FIRST_SNAP_HB = 6 / HB_TICKS;

const pmod = (a, n) => ((a % n) + n) % n;

/** 二分探索(Python の bisect.bisect_right)。 */
export function bisectRight(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < a[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 小節の中の 12(2 連系)+ 16(3 連系)の格子に吸着する。384 を返すことがある(次の小節の 0。呼び出し側で繰り上げる)。 */
export function snapTick(tick) {
  let best = 0;
  let bestErr = Infinity;
  for (const base of [12, 16]) {
    const s = base * rint(tick / base);
    const err = Math.abs(s - tick);
    if (err < bestErr) {
      best = s;
      bestErr = err;
    }
  }
  return best || 0;
}

/**
 * 線の出来事に半拍の格子を最小二乗で当てはめる(emit.fit_beats)。線 i は t0 + h[i]·half(h は整数。時刻の順)。
 * @returns {{t0: number, half: number, h: number[], bright: number[], residRms: number, residMax: number}}
 */
export function fitBeats(lines) {
  if (lines.length < 8) throw new Error(`only ${lines.length} line events detected; cannot fit a grid`);
  const srt = [...lines].sort((a, b) => a.t - b.t);
  const ts = srt.map((e) => e.t);
  const d = ts.slice(1).map((t, i) => t - ts[i]);
  const med = median(d);
  const tb0 = median(d.filter((x) => x > 0.6 * med && x < 1.5 * med));
  // 番号は隣との差を順に足して付ける(全体を丸めると周期の誤差が積もり、折り返した傾きに落ちる)
  let h = [0];
  for (const di of d) h.push(h[h.length - 1] + Math.max(1, rint((2 * di) / tb0)));
  let t0 = 0;
  let half = tb0 / 2;
  for (let it = 0; it < 3; it++) {
    const fit = lineFit(h, ts);
    half = fit.a;
    t0 = fit.b;
    h = ts.map((t) => rint((t - t0) / half));
  }
  const resid = ts.map((t, i) => t - (t0 + h[i] * half));
  return {
    t0, half, h, bright: srt.map((e) => e.vMean || 0),
    residRms: std(resid), residMax: Math.max(...resid.map(Math.abs)),
  };
}

/**
 * 明るい線から小節の頭(半拍の番号)を出す(emit.measure_marks)。明るい線は全部小節の頭なので 3/4・7/8 もそのまま出る。
 * 4/4 の小節がまるごと抜けた所(見えなかった明るい線)は 4/4 で埋める。明るい線と暗い線がきれいに分かれなければ
 * 多数決の位相だけを使う(全部 4/4)。
 * @returns {{starts: number[], warn: string[]}}
 */
export function measureMarks(h, bright) {
  const warn = [];
  const thresh = (percentile(bright, 20) + percentile(bright, 90)) / 2;
  const sel = bright.map((b) => b > thresh);
  const nSel = sel.filter(Boolean).length;
  if (!nSel || nSel === sel.length) {
    warn.push('no measure lines told apart from beat lines; 4/4 from the first line');
    return { starts: [0], warn };
  }
  let lo = Infinity;
  let hi = -Infinity;
  bright.forEach((b, i) => {
    if (sel[i]) lo = Math.min(lo, b);
    else hi = Math.max(hi, b);
  });
  const hs = h.filter((_, i) => sel[i]);
  if (lo - hi < LINE_V_GAP) {
    const phases = hs.map((x) => pmod(x, BAR_HB));
    const counts = bincount(phases, BAR_HB);
    const phase = argmax(counts);
    warn.push(`measure lines barely brighter than beat lines (gap ${Math.round(lo - hi)}); 4/4 throughout, `
      + `measure phase from ${Math.round((counts[phase] / phases.length) * 100)}% of the bright lines`);
    return { starts: [phase], warn };
  }
  const marks = [...new Set(hs)].sort((a, b) => a - b);
  const starts = [marks[0]];
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (b - a > BAR_HB && pmod(b - a, BAR_HB)) {
      warn.push(`${(b - a) / 2} beats between measure lines at beat ${a / 2}; filled with 4/4 and a ${pmod(b - a, BAR_HB) / 2}-beat bar`);
    }
    for (let s = a + BAR_HB; s < b; s += BAR_HB) starts.push(s);
    starts.push(b);
  }
  return { starts, warn };
}

/**
 * 譜面の小節 0 から最後のチップの先までの小節の頭(半拍の番号。emit.layout_bars)。最初の小節線の前・最後の後の小節は 4/4。
 * 動画の小節 0 は最初の線(h = 0)以降で最初に始まる小節。measureOffset はそれを譜面の何小節目にするか(null / 0 なら最初の
 * チップが小節 1 以降に来るよう)。
 * @returns {{starts: number[], firstM: number, measureOffset: number}}
 */
export function layoutBars(marks, firstHb, lastHb, measureOffset) {
  let starts = [...marks];
  const lead = [];
  let s = starts[0];
  while (s > Math.min(0, firstHb)) {
    s -= BAR_HB;
    lead.push(s);
  }
  starts = lead.reverse().concat(starts);
  // 余りの小節を 1 つ(チップが最後の小節の終わりに吸着することがある)
  while (starts.length < 2 || starts[starts.length - 2] <= Math.max(lastHb, 0)) starts.push(starts[starts.length - 1] + BAR_HB);
  const v0 = starts.findIndex((x) => x >= 0);
  const firstM = bisectRight(starts, firstHb + FIRST_SNAP_HB) - 1 - v0;
  if (!measureOffset) measureOffset = Math.max(0, 1 - firstM);
  if (firstM + measureOffset < 0) {
    throw new Error(`measure offset ${measureOffset} puts the first chip before measure 0; use at least ${-firstM}`);
  }
  let m0 = v0 - measureOffset;
  if (m0 < 0) {
    const pre = [];
    for (let i = -m0; i >= 1; i--) pre.push(starts[0] - BAR_HB * i);
    starts = pre.concat(starts);
    m0 = 0;
  }
  return { starts: starts.slice(m0), firstM, measureOffset };
}

/**
 * レーンの出来事を、半拍の番号 starts で始まる小節の (小節, tick) に置く(emit.quantize_bars)。譜面の小節 m は
 * starts[m]〜starts[m+1]。12/16 の格子に吸着し、はっきり外れたもの(OFFGRID_*)は一番近い tick に残す。位置は小節の
 * 1/384 の整数(DTXMania は小節の長さによらず 384·i/n を切り捨てるので、7/8 の小節も 7 等分でなく 384 の格子に丸めて書く)。
 * offGridMs は格子の外に残す下限(既定 OFFGRID_MS。コマを間引いて読んだときは広げる)。
 * @returns {{placed: Object<string, {m: number, tick: number}[]>, errMs: number[], offGrid: string[]}}
 */
export function quantizeBars(events, t0, half, starts, speed, offGridMs = OFFGRID_MS) {
  const rows = [];
  for (const [lane, evs] of Object.entries(events)) {
    for (const e of evs) {
      const hc = (e.t - t0) / half;
      const m = bisectRight(starts, hc + 1e-6) - 1;
      const raw = (hc - starts[m]) * HB_TICKS;
      rows.push({ lane, m, raw, snap: snapTick(raw), rms: e.rms || 0 });
    }
  }
  const placed = {};
  for (const lane of Object.keys(events)) placed[lane] = [];
  if (!rows.length) return { placed, errMs: [], offGrid: [] };
  const msTick = (half / HB_TICKS) * 1000;
  const err = rows.map((r) => (r.snap - r.raw) * msTick);
  const me = median(err);
  const spread = 1.4826 * median(err.map((e) => Math.abs(e - me)));
  const errMs = [];
  const offGrid = [];
  rows.forEach((r, i) => {
    let { m } = r;
    let tick = r.snap;
    const limit = Math.max(offGridMs, OFFGRID_SIGMA * spread, (OFFGRID_RMS * r.rms) / speed * 1000);
    if (Math.abs(err[i]) > limit) {
      tick = rint(r.raw) || 0;
      offGrid.push(`${r.lane}@${m}:${tick}`);
    }
    errMs.push(Math.abs(tick - r.raw) * msTick);
    let total = (starts[m + 1] - starts[m]) * HB_TICKS;
    if (tick >= total) {
      m += 1;
      tick = 0;
      total = (starts[m + 1] - starts[m]) * HB_TICKS;
    }
    placed[r.lane].push({ m, tick: rint((tick * 384) / total) || 0 });
  });
  return { placed, errMs, offGrid };
}

/**
 * 一定の長さの小節(t_m0 + m·tMeas)に置く(emit.quantize。音から作る譜面が使う)。measureOffset だけ小節の番号をずらす。
 * @returns {{placed: Object<string, {m: number, tick: number}[]>, errMs: number[]}}
 */
export function quantize(events, tM0, tMeas, measureOffset) {
  const placed = {};
  const errMs = [];
  for (const [lane, evs] of Object.entries(events)) {
    placed[lane] = evs.map((e) => {
      const mf = (e.t - tM0) / tMeas;
      let m = Math.floor(mf + 1e-9);
      const raw = (mf - m) * 384;
      let tick = snapTick(raw);
      errMs.push((Math.abs(tick - raw) / 384) * tMeas * 1000);
      if (tick >= 384) {
        m += 1;
        tick = 0;
      }
      return { m: m + measureOffset, tick };
    });
  }
  return { placed, errMs };
}

/** #BPM の値: 整数 / 小数 2 桁 / 小数 3 桁のうち、測った速さとの span 秒のずれが BPM_DRIFT_MS 未満の一番丸いもの(emit.bpm_text)。 */
export function bpmText(bpm, spanS) {
  for (const nd of [0, 2]) {
    const val = Math.round(bpm * 10 ** nd) / 10 ** nd;
    if ((Math.abs(val - bpm) / bpm) * spanS * 1000 < BPM_DRIFT_MS) return val;
  }
  return Math.round(bpm * 1000) / 1000;
}

/**
 * 動画の出来事(js/gen/track.js の trackEvents)から、小節とチップの置き場所を決める(emit.main の格子の部分)。
 * @param {{lanes: Object<string, object[]>, lines: object[], speed: number}} data
 * @param {{measureOffset?: number|null, offGridMs?: number, log?: (s: string) => void}} [opts]
 * @returns {{placed: Object<string, {m:number, tick:number}[]>, starts: number[], t0: number, half: number,
 *   gridOrigin: number, bpm: number, barRatios: number[], allTs: number[], measureOffset: number, firstM: number}}
 */
export function placeVideoChips(data, opts = {}) {
  const log = opts.log || (() => {});
  const fb = fitBeats(data.lines);
  log(`beat grid: T=${(2 * fb.half).toFixed(6)}s BPM ${(30 / fb.half).toFixed(3)}, residual rms=${(1000 * fb.residRms).toFixed(1)}ms `
    + `max=${(1000 * fb.residMax).toFixed(1)}ms over ${fb.h.length} lines`);
  const mm = measureMarks(fb.h, fb.bright);
  for (const w of mm.warn) log('WARNING: ' + w);
  const allTs = Object.values(data.lanes).flatMap((evs) => evs.map((e) => e.t));
  if (!allTs.length) throw new Error('no chip events detected; nothing to emit (check the lane layout)');
  const tMin = Math.min(...allTs);
  const tMax = Math.max(...allTs);
  const lb = layoutBars(mm.starts, (tMin - fb.t0) / fb.half, (tMax - fb.t0) / fb.half, opts.measureOffset);
  log(`first chip in video-measure ${lb.firstM}, measure_offset=${lb.measureOffset}`);
  const { starts } = lb;
  const barRatios = starts.slice(1).map((b, i) => (b - starts[i]) / BAR_HB);
  const odd = barRatios.map((r, m) => (r !== 1 ? `${m}:${r}` : '')).filter(Boolean);
  if (odd.length) log(`bar lengths (measure:ratio, 4/4 elsewhere): ${odd.join(' ')}`);
  const q = quantizeBars(data.lanes, fb.t0, fb.half, starts, data.speed, opts.offGridMs || OFFGRID_MS);
  if (q.errMs.length) {
    log(`quantize error: mean=${mean(q.errMs).toFixed(1)}ms p95=${percentile(q.errMs, 95).toFixed(1)}ms `
      + `max=${Math.max(...q.errMs).toFixed(1)}ms`);
  }
  if (q.offGrid.length) log(`${q.offGrid.length} off-grid chips kept at 1/384: ${q.offGrid.join(' ')}`);
  return {
    placed: q.placed, starts, t0: fb.t0, half: fb.half, gridOrigin: fb.t0 + starts[0] * fb.half, bpm: 30 / fb.half,
    barRatios, allTs, measureOffset: lb.measureOffset, firstM: lb.firstM,
  };
}
