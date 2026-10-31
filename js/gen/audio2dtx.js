// 曲の音から譜面を作る(vid2dtx/audio2dtx.py の移植。実験的。docs/spec/vid2dtx-gen.md §6)。
// 打点を拾う所(ドラムの分離・採譜・拍の追跡)は学習を使わない信号処理(js/gen/adt.js)に置き換えた。そのあとの
// テンポのコムフィット・小節の位相(スネアのバックビート)・量子化・ドラマーの規則(両手は 2 つまで・ハイハットの開閉・
// LC / CY の左右・速いキックの連打を左右の足へ・32 分のスネアの 2 打目・グルーヴの型のハイハット)・確信度は移す。
// 学習した重みに頼る所(8 クラスのヘッドのハイハット / LP / ライド・奏法のイディオムのモデル)は移さない(元の重みは GITADORA の
// 譜面で学習したもので公開できない)。元が重み無しで動くときの規則(v4)を使う。
// (変更) タムは拾わない(信号処理では誤検出がほとんどで、手で足す方が早い)。

import { rint, lineFit, argmax, bincount, yieldToUi, GenCancelled } from './num.js';
import { analyzeAudio, activationScale, refinePeak, halfRiseTime, BandEnv, FRAME_T0 } from './adt.js';
import { quantize } from './emit.js';

// ---- 打点の候補(adt.js の活性・帯域から) ----

export const PICK = {
  // 相対の立ち上がり (a − 直前の底) / (直前の底 + c·尺度) の峰。手元の 3 曲(DTXMania / GITADORA のプレー動画の音)で決めた
  KD: { c: 0.2, pre: 5, thr: 1.0 },
  SD: { c: 0.4, pre: 12, thr: 1.0 },
  // 金物: 7 kHz より上の立ち上がり(z)。スネアの帯域の立ち上がりの rho 倍に届かないものはスネアの漏れとして捨てる
  MT: { band: [7000, 16000], thr: 2.5, rho: 0.3 },
  // シンバル: 金物の打点のうち、250〜600 ms 後の一番低い所が、打つ前の一番低い所の cyLift 倍より高く、打つ前からの上がりが
  // 0〜80 ms の上がりの cyRing 倍以上のもの(3 曲で 0.05〜0.3 / 1.2〜3 を比べて決めた)
  cyRing: 0.05,
  cyLift: 1.2,
  // スネアはスネアの帯域の立ち上がり(z)がこれ以上のときだけ(audio2dtx.VERIFY_Z と同じ裏付け)
  sdBump: 1.0,
};

/**
 * 相対の立ち上がりの峰(コマ)。間は 3 コマより空ける。
 * @returns {{t: number, rr: number}[]}
 */
export function relativePeaks(sig, fps, { c, pre, thr }) {
  const sc = activationScale(sig);
  const out = [];
  let last = -10;
  for (let i = 2; i < sig.length - 2; i++) {
    const v = sig[i];
    if (!(v > sig[i - 1] && v >= sig[i + 1] && v >= sig[i - 2] && v >= sig[i + 2])) continue;
    let lo = v;
    for (let j = Math.max(0, i - pre); j < i - 1; j++) lo = Math.min(lo, sig[j]);
    const rr = (v - lo) / (lo + c * sc);
    if (rr < thr) continue;
    if (i - last <= 3) {
      last = i;
      continue;
    }
    out.push({ t: halfRiseTime(sig, i, lo, fps), rr });
    last = i;
  }
  return out;
}

/** z の峰(BandEnv の flux)。@returns {{t: number, z: number}[]} */
function fluxPeaks(env, thr) {
  const f = env.flux;
  const out = [];
  let last = -10;
  for (let i = 2; i < f.length - 2; i++) {
    const v = f[i] / env.scale;
    if (v < thr) continue;
    if (!(f[i] > f[i - 1] && f[i] >= f[i + 1] && f[i] >= f[i - 2] && f[i] >= f[i + 2])) continue;
    if (i - last <= 3) {
      last = i;
      continue;
    }
    // flux[i] はコマ i − 1 と i の間の立ち上がり
    out.push({ t: (refinePeak(f, i) - 0.5) / env.fps + FRAME_T0, z: v });
    last = i;
  }
  return out;
}

/**
 * 打点の候補(audio2dtx の det: [(時刻, 種類)])と確信度の元。
 * @returns {{det: {t: number, cls: string, s: number}[], hh2: BandEnv}}
 */
export function pickOnsets(a) {
  const det = [];
  for (const p of relativePeaks(a.act.KD, a.fps, PICK.KD)) det.push({ t: p.t, cls: 'KD', s: p.rr / (2 * PICK.KD.thr) });
  for (const p of relativePeaks(a.act.SD, a.fps, PICK.SD)) {
    if (a.env.snare.bump(p.t) < PICK.sdBump) continue;
    det.push({ t: p.t, cls: 'SD', s: p.rr / (2.5 * PICK.SD.thr) });
  }
  const hh2 = new BandEnv(a.P, a.T, a.F, PICK.MT.band);
  for (const p of fluxPeaks(hh2, PICK.MT.thr)) {
    if (hh2.bump(p.t) < PICK.MT.rho * a.env.snare.bump(p.t)) continue;
    // 打つ前より高い音が長く残ればシンバル(ハイハットはすぐ前の高さへ戻る。後ろで鳴り続ける曲の高い音は打つ前にもある)
    // 前と後ろは一番低い所(ほかの打点の音を数えない)
    const before = hh2.minPower(p.t - 0.12, p.t - 0.02);
    const early = hh2.meanPower(p.t, p.t + 0.08);
    const late = hh2.minPower(p.t + 0.25, p.t + 0.6);
    const ring = (late - before) / (early - before + 1e-12);
    det.push({ t: p.t, cls: ring >= PICK.cyRing && late > PICK.cyLift * before ? 'CY' : 'HH', s: p.z / (2 * PICK.MT.thr) });
  }
  det.sort((x, y) => x.t - y.t);
  return { det, hh2 };
}

// ---- テンポ ----

export const GRID_SPAN = 0.06; // テンポのコムは拍の ±6 % を探す
export const GRID_TOL = 0.12; // 16 分の 0.12 の内なら格子の上
// 格子は 16 分と 8 分 3 連(拍の 12 分の 1 の単位)
export const GRID_POS = [0, 3, 4, 6, 8, 9];
export const GATE_TOL = 0.2; // (追加) 格子に乗っているとみなす幅(16 分の割合)
// (追加) 拍の長さの見当(Beat This の代わり): 打点の並びの自己相関に、BPM の対数の正規分布の重み(中心 BPM_PRIOR、幅 BPM_SIGMA オクターブ)
export const BPM_PRIOR = 150;
export const BPM_SIGMA = 0.5;

/**
 * 拍の長さの候補(秒。良い順)。キック・スネアを 1、金物を 0.5 にした打点の並び(100 fps)の自己相関の峰に、BPM の重みを掛けた順。
 * 峰の前後は放物線で補う。
 */
export function beatCandidates(det, fps = 100, max = 6) {
  if (!det.length) return [0.5];
  const n = Math.ceil(det[det.length - 1].t * fps) + 4;
  const env = new Float64Array(n);
  for (const d of det) {
    const i = Math.round(d.t * fps);
    const w = d.cls === 'KD' || d.cls === 'SD' ? 1 : 0.5;
    for (let k = -1; k <= 1; k++) if (i + k >= 0 && i + k < n) env[i + k] += w * (k ? 0.5 : 1);
  }
  const lo = Math.floor(fps * 0.24);
  const hi = Math.ceil(fps * 1.0);
  const acf = new Float64Array(hi + 2);
  for (let L = lo - 1; L <= hi + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
    acf[L] = s / Math.max(1, n - L);
  }
  const cands = [];
  for (let L = lo; L <= hi; L++) {
    if (!(acf[L] >= acf[L - 1] && acf[L] >= acf[L + 1])) continue;
    const bpm = (60 * fps) / L;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / BPM_PRIOR) / BPM_SIGMA) ** 2);
    const y0 = acf[L - 1];
    const y1 = acf[L];
    const y2 = acf[L + 1];
    const d = y0 - 2 * y1 + y2;
    cands.push({ beat: (d < 0 ? L + (0.5 * (y0 - y2)) / d : L) / fps, score: acf[L] * prior, prior });
  }
  cands.sort((x, y) => y.score - x.score);
  return cands.length ? cands.slice(0, max) : [{ beat: 0.5, score: 0, prior: 1 }];
}

/**
 * 拍の長さの候補ごとに、格子の位置(GRID_POS)の GRID_TOL の内に入る打点の割合と、一番よい拍の位相(秒)(audio2dtx.grid_share)。
 * 許す幅は長さに比例するので、短い候補が得をしない。
 */
export function gridShare(ts, periods, pos, nb = 192) {
  const w = rint((GRID_TOL * nb) / 4);
  const share = new Float64Array(periods.length);
  const phase = new Float64Array(periods.length);
  const cnt = new Float64Array(nb);
  const box = new Float64Array(nb);
  for (let p = 0; p < periods.length; p++) {
    cnt.fill(0);
    for (const t of ts) {
      const u = ((t / periods[p]) % 1 + 1) % 1;
      cnt[Math.min(Math.floor(u * nb), nb - 1)]++;
    }
    for (let i = 0; i < nb; i++) {
      let s = 0;
      for (let k = -w; k <= w; k++) s += cnt[(i + k + nb) % nb];
      box[i] = s;
    }
    let bj = 0;
    let bv = -1;
    for (let j = 0; j < nb; j++) {
      let s = 0;
      for (const q of pos) s += box[(j + (q * nb) / 12) % nb];
      if (s > bv) {
        bv = s;
        bj = j;
      }
    }
    share[p] = bv / ts.length;
    phase[p] = ((bj + 0.5) / nb) * periods[p];
  }
  return { share, phase };
}

/**
 * 16 分の格子を打点に当てはめる(audio2dtx.fit_measure_grid のコムの部分)。拍の見当の ±6 % で、16 分か 8 分 3 連の格子に乗る
 * 打点の割合が一番多い長さを粗くから細かく探し、16 分の位相を直線の格子だけで決め(3 連は拍の 3 分の 1 で繰り返すので位相が
 * あいまい)、格子に乗った打点で最小二乗し直す。
 * @returns {{T16: number, ph: number, onGrid: number, rmsMs: number}}
 */
export function combFit(ts, tBeat) {
  const cands = [];
  for (let i = 0; i <= 3000; i++) cands.push(tBeat * (1 - GRID_SPAN + (2 * GRID_SPAN * i) / 3000));
  const share = new Float64Array(cands.length);
  for (let i = 0; i < cands.length; i += 200) share.set(gridShare(ts, cands.slice(i, i + 200), GRID_POS).share, i);
  const i = argmax(share);
  const a = cands[Math.max(i - 1, 0)];
  const b = cands[Math.min(i + 1, cands.length - 1)];
  const fine = [];
  for (let k = 0; k <= 200; k++) fine.push(a + ((b - a) * k) / 200);
  const j = argmax(gridShare(ts, fine, GRID_POS, 384).share);
  let T16 = fine[j] / 4;
  let ph = gridShare(ts, [fine[j]], [0, 3, 6, 9], 384).phase[0];
  ph -= T16 * rint(ph / T16);
  let inl = [];
  for (let it = 0; it < 3; it++) {
    const ks = [];
    const xs = [];
    inl = [];
    for (const t of ts) {
      const k = rint((t - ph) / T16);
      if (Math.abs(t - (ph + k * T16)) < 0.02) {
        ks.push(k);
        xs.push(t);
        inl.push(t);
      }
    }
    const fit = lineFit(ks, xs);
    if (!fit) break;
    T16 = fit.a;
    ph = fit.b;
  }
  const res = inl.map((t) => t - (ph + rint((t - ph) / T16) * T16));
  const m = res.reduce((s, v) => s + v, 0) / Math.max(1, res.length);
  const rms = Math.sqrt(res.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, res.length));
  return { T16, ph, onGrid: inl.length, rmsMs: rms * 1000 };
}

/**
 * 小節の位相(16 分の何番目が小節の頭か)。audio2dtx は拍の追跡の小節の頭の多数決のあと、スネアのバックビートで直す。
 * (変更) 小節の頭の見当は、キック(1)とシンバル(2)・強さに比例した金物(0.5 × 強さ)の 16 分の位置ごとの数(小節の頭にクラッシュと
 * キックが来やすい)。
 * はっきりしたスネアのバックビート(8 分の位置 q と q+8 の 16 分)があれば、拍はそれで決め(q − 4 が小節の頭か 3 拍目)、
 * 1 拍目と 3 拍目はキック・シンバルの数で選ぶ。
 * @returns {{phase: number, why: string}}
 */
export function measurePhase(det, ph, T16) {
  const idx = (t) => rint((t - ph) / T16);
  const near = (t) => Math.abs((t - ph) / T16 - idx(t)) < 0.25;
  const down = new Array(16).fill(0);
  for (const d of det) {
    if (!near(d.t)) continue;
    const p = ((idx(d.t) % 16) + 16) % 16;
    if (d.cls === 'KD') down[p] += 1;
    else if (d.cls === 'CY') down[p] += 2;
    // 強い金物(シンバルと分けきれなかったクラッシュ)も。8 分のハイハットは 1 拍目と 3 拍目に同じだけ入るので比べ方を変えない
    else if (d.cls === 'HH' && d.s !== undefined) down[p] += 0.5 * Math.min(2, d.s);
  }
  // 拍の頭(4 の倍数)の中で一番多い所
  let phase = 0;
  for (let p = 0; p < 16; p++) if (down[p] + 0.5 * down[(p + 8) % 16] > down[phase] + 0.5 * down[(phase + 8) % 16]) phase = p;
  let why = `downbeat votes ${down.join(',')}`;
  const sd16 = new Array(16).fill(0);
  for (const d of det) if (d.cls === 'SD' && near(d.t)) sd16[((idx(d.t) % 16) + 16) % 16]++;
  const sd8 = sd16.slice(0, 8).map((v, i) => v + sd16[i + 8]);
  const q = argmax(sd8);
  const [lo, hi] = [sd16[q], sd16[q + 8]].sort((x, y) => x - y);
  const rest = Math.max(...sd8.filter((_, i) => i !== q));
  if (sd8[q] >= 20 && sd8[q] >= 3 * rest && lo >= 0.5 * hi) {
    const c = (((q - 4) % 8) + 8) % 8;
    const score = (p) => down[p] + down[(p + 4) % 16] * 0.25;
    phase = score(c) >= score(c + 8) ? c : c + 8;
    why += `; snare backbeat on 16ths ${q}+${q + 8}`;
  }
  return { phase, why };
}

// ---- ドラマーの規則(audio2dtx.drummer_model の重み無しの道) ----

export const HAND_CLASSES = new Set(['SD', 'TT', 'HH', 'CY']);
const DROP_PRIO = { TT: 0, CY: 1, HH: 2, SD: 3 };
export const RING_OPEN = 0.25; // ハイハットの帯域の余韻の比: 開 / 閉
export const DAMP_LP = 0.6; // 足で閉じると開いたハイハットの音が切れる
export const SYNTH_CONF = 0.35; // 足したチップはいつも要確認
export const LBD_RUN_GAP = 0.14; // 速いキックの連打(間がこれ以下)は左右の足で交互に
export const LBD_PAIR_GAP = 0.09; // 2 つだけの組はこれ以下のときだけ
export const Z_SD2 = 1.5; // 32 分の 2 打目のスネアの立ち上がり
const CLASS_LANE = { KD: 'BD', SD: 'SD', TT: 'HT', HH: 'HHO', CY: 'CY' };

/**
 * 量子化したチップに規則を当てる。chips: [{m, tick, cls}]、conf: Map(キー → 確信度)。
 * @returns {{m: number, tick: number, cls: string, kind: string, conf: number, why: string}[]}
 */
export function drummerModel(chips, conf, a, hh, tOf, log = () => {}) {
  const key = (m, tick, cls) => `${m}.${tick}.${cls}`;
  // R1: 1 つの tick の手は 2 つまで(元の譜面は破らない)
  const byPos = new Map();
  for (const c of chips) {
    const k = `${c.m}.${c.tick}`;
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k).push(c);
  }
  const dropped = new Set();
  for (const cs of byPos.values()) {
    const hands = cs.filter((c) => HAND_CLASSES.has(c.cls));
    if (hands.length <= 2) continue;
    hands.sort((x, y) => conf.get(key(x.m, x.tick, x.cls)) - conf.get(key(y.m, y.tick, y.cls)) || DROP_PRIO[x.cls] - DROP_PRIO[y.cls]);
    for (const c of hands.slice(0, hands.length - 2)) dropped.add(c);
  }
  if (dropped.size) log(`drummer: two-hands rule dropped ${dropped.size} chips`);
  const out = [];
  const hatPos = new Map();
  const hhTimes = chips.filter((c) => c.cls === 'HH').map((c) => tOf(c.m, c.tick)).sort((x, y) => x - y);
  const nextHat = (t) => {
    for (const u of hhTimes) if (u > t + 0.02) return u;
    return Infinity;
  };
  for (const c of chips) {
    if (dropped.has(c)) continue;
    let kind = CLASS_LANE[c.cls];
    let why = '';
    const t = tOf(c.m, c.tick);
    if (c.cls === 'HH') {
      // 開 / 閉: ハイハットの帯域の余韻(次のハイハットの手前まで)
      const r = hh.ringRatio(t, nextHat(t) - 0.01);
      kind = r >= RING_OPEN ? 'HHO' : 'HHC';
      hatPos.set(`${c.m}.${c.tick}`, kind);
      why = `ring ${r.toFixed(2)}`;
    } else if (c.cls === 'CY') {
      const b = a.balance(t);
      if (b < 0) kind = 'LC';
      why = `stereo ${b.toFixed(2)}`;
    }
    out.push({ m: c.m, tick: c.tick, cls: c.cls, kind, conf: conf.get(key(c.m, c.tick, c.cls)), why });
  }
  // R3: グルーヴ(1 小節に裏の 8 分の開いたハイハットが 2 つ以上)の小節は、拍ごとにハイハットを踏む / 叩く
  const off8 = new Map();
  for (const [k, kind] of hatPos) {
    const [m, tick] = k.split('.').map(Number);
    if (kind === 'HHO' && tick % 96 === 48) off8.set(m, (off8.get(m) || 0) + 1);
  }
  let nSynth = 0;
  for (const [m, n] of [...off8].sort((x, y) => x[0] - y[0])) {
    if (n < 2) continue;
    for (const tick of [0, 96, 192, 288]) {
      if (hatPos.has(`${m}.${tick}`)) continue;
      const t = tOf(m, tick);
      if (a.env.hh.bump(t) < 0.5) continue;
      const kind = hh.dampRatio(t) < DAMP_LP ? 'LP' : 'HHO';
      out.push({ m, tick, cls: 'HH', kind, conf: SYNTH_CONF, why: 'synthesized (groove template)' });
      hatPos.set(`${m}.${tick}`, kind);
      nSynth++;
    }
  }
  if (nSynth) log(`drummer: ${nSynth} hat chips synthesized from groove measures (low confidence)`);
  return out;
}

/** 速いキックの連打を 1 つおきに左のバスドラム(LBD)へ(audio2dtx.assign_kick_feet)。動かした数。 */
export function assignKickFeet(chips, tOf) {
  const kicks = chips.filter((c) => c.kind === 'BD').map((c) => ({ t: tOf(c.m, c.tick), c })).sort((x, y) => x.t - y.t);
  const lp = new Set(chips.filter((c) => c.kind === 'LP').map((c) => `${c.m}.${c.tick}`));
  const runs = [];
  let run = [];
  for (const k of kicks) {
    if (run.length && k.t - run[run.length - 1].t > LBD_RUN_GAP + 1e-6) {
      runs.push(run);
      run = [];
    }
    run.push(k);
  }
  runs.push(run);
  let moved = 0;
  for (const r of runs) {
    if (r.length < 2 || (r.length === 2 && r[1].t - r[0].t > LBD_PAIR_GAP + 1e-6)) continue;
    let left = false;
    for (const { c } of r) {
      if (left && lp.has(`${c.m}.${c.tick}`)) left = false; // 左足はハイハットのペダル
      if (left) {
        c.kind = 'LBD';
        moved++;
      }
      left = !left;
    }
  }
  return moved;
}

// ---- 全体 ----

/**
 * 曲の音から譜面のチップまで。
 * @param {Float32Array} left js/gen/adt.js の ADT.sr の左
 * @param {Float32Array} right 右
 * @param {{log?: (s: string) => void, onProgress?: (stage: string, frac: number) => void, signal?: {cancelled: boolean},
 *   keepStart?: boolean}} [opts] keepStart: 曲の音の頭を譜面の小節 0 の中に置く(元のファイルを BGM にそのまま使う)
 * @returns {Promise<{chips: object[], bpm: number, tMeas: number, gridOrigin: number, measureOffset: number, conf: object[], stats: object}>}
 */
export async function audioToChart(left, right, opts = {}) {
  const log = opts.log || (() => {});
  const a = await analyzeAudio(left, right, { onProgress: opts.onProgress, signal: opts.signal });
  await yieldToUi();
  if (opts.signal && opts.signal.cancelled) throw new GenCancelled();
  const { det, hh2 } = pickOnsets(a);
  if (det.length < 16) throw new Error('too few drum onsets were found in the audio');
  const counts = bincount(det.map((d) => ['KD', 'SD', 'HH', 'CY'].indexOf(d.cls)), 4);
  log(`onsets: KD ${counts[0]}, SD ${counts[1]}, HH ${counts[2]}, CY ${counts[3]}`);
  // テンポ・格子(キック・スネアの打点で。金物は揺れが大きい)
  // (追加) 拍の候補ごとにコムを当て、格子に乗る割合 × BPM の重みの平方根が一番大きいもの(自己相関だけだと 3:2 を取り違える。
  // 割合は候補の長さによらない(許す幅が長さに比例する)ので、2:1 は重みで決まる)
  const core = det.filter((d) => d.cls === 'KD' || d.cls === 'SD').map((d) => d.t);
  const ts = core.length >= 16 ? core : det.map((d) => d.t);
  let fit = null;
  let tBeat = 0.5;
  for (const c of beatCandidates(det)) {
    const f = combFit(ts, c.beat);
    f.score = (f.onGrid / ts.length) * Math.sqrt(c.prior);
    if (!fit || f.score > fit.score) {
      fit = f;
      tBeat = c.beat;
    }
  }
  log(`grid: BPM ${(60 / (4 * fit.T16)).toFixed(3)} (beat guess ${(60 / tBeat).toFixed(1)}; ${fit.onGrid}/${ts.length} onsets on grid, rms ${fit.rmsMs.toFixed(1)}ms)`);
  const mp = measurePhase(det, fit.ph, fit.T16);
  log(`measure phase: 16th #${mp.phase} (${mp.why})`);
  let tM0 = fit.ph + mp.phase * fit.T16;
  const tMeas = 16 * fit.T16;
  // (追加) 16 分・8 分 3 連の格子から GATE_TOL(16 分の割合)より外れた打点は曲のほかの音として捨てる
  const beat = 4 * fit.T16;
  const kept = det.filter((d) => {
    const u = ((((d.t - fit.ph) / beat) % 1) + 1) % 1 * 12;
    return GRID_POS.concat([12]).some((p) => Math.abs(u - p) <= GATE_TOL * 3);
  });
  log(`grid gate: kept ${kept.length}/${det.length} onsets`);
  det.length = 0;
  det.push(...kept);
  // 32 分のスネアの 2 打目(1 つだけの打点の 32 分あとに、スネアの帯域のはっきりした立ち上がり)
  const sd = det.filter((d) => d.cls === 'SD').map((d) => d.t);
  let added = 0;
  for (let i = 0; i < sd.length; i++) {
    if (i + 1 < sd.length && sd[i + 1] - sd[i] < 0.06) continue;
    const t2 = sd[i] + tMeas / 32;
    if (a.env.snare.bump(t2) >= Z_SD2) {
      det.push({ t: t2, cls: 'SD', s: 0.5 });
      added++;
    }
  }
  if (added) log(`double strokes recovered: ${added}`);
  det.sort((x, y) => x.t - y.t);
  // 小節 0: 最初のチップが小節 1 に来るように。元の音を BGM にそのまま使うときは、音の頭が小節 0 の中に来るまで前へ足す
  const firstM = Math.floor((det[0].t - tM0) / tMeas);
  let measureOffset = Math.max(0, 1 - firstM);
  let gridOrigin = tM0 - measureOffset * tMeas;
  if (opts.keepStart) {
    while (gridOrigin > 0) {
      measureOffset++;
      gridOrigin -= tMeas;
    }
    // 音の頭(譜面の時刻 −gridOrigin)を 1/384 小節に合わせ、そのずれだけ格子を動かす(2 ms ほど)
    const tick = rint((-gridOrigin / tMeas) * 384);
    const shift = -gridOrigin - (tick / 384) * tMeas;
    tM0 += shift;
    gridOrigin += shift;
  }
  const events = {};
  for (const d of det) (events[d.cls] = events[d.cls] || []).push({ t: d.t, s: d.s });
  const q = quantize(events, tM0, tMeas, measureOffset);
  const tOf = (m, tick) => gridOrigin + (m + tick / 384) * tMeas;
  // 確信度(audio2dtx は採譜の活性の強さと相対の大きさ。ここは拾ったときの強さ): 0.7 未満は要確認の枠が付く
  const conf = new Map();
  const chips = [];
  for (const [cls, evs] of Object.entries(events)) {
    evs.forEach((e, i) => {
      const { m, tick } = q.placed[cls][i];
      const k = `${m}.${tick}.${cls}`;
      const c = Math.round(Math.max(0, Math.min(1, e.s)) * 1000) / 1000;
      if (conf.has(k)) {
        conf.set(k, Math.max(conf.get(k), c));
        return;
      }
      conf.set(k, c);
      chips.push({ m, tick, cls });
    });
  }
  chips.sort((x, y) => x.m - y.m || x.tick - y.tick);
  const final = drummerModel(chips, conf, a, hh2, tOf, log);
  const nLbd = assignKickFeet(final, tOf);
  if (nLbd) log(`drummer: ${nLbd} kicks of fast runs moved to the left foot (LBD)`);
  final.sort((x, y) => x.m - y.m || x.tick - y.tick);
  const bpm = 240 / tMeas;
  return {
    chips: final, bpm, tMeas, gridOrigin, measureOffset, duration: a.duration,
    stats: { onsets: det.length, chips: final.length, low: final.filter((c) => c.conf < 0.7).length, beatGuess: 60 / tBeat },
  };
}

/** #BPM の値(audio2dtx: 整数から 0.02 の内なら整数、ほかは小数 2 桁)。 */
export function audioBpmText(bpm) {
  return Math.abs(bpm - Math.round(bpm)) < 0.02 ? Math.round(bpm) : Math.round(bpm * 100) / 100;
}

