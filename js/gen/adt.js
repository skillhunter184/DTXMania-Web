// 曲の音からドラムの打点を拾う(本アプリの追加。音から譜面を作る js/gen/audio2dtx.js の下回り。docs/spec/vid2dtx-gen.md §6)。
// vid2dtx の audio2dtx はドラムの分離(htdemucs)・採譜(ADTOF)・拍の追跡(Beat This)・キットの分離(MDX23C)と、GITADORA の
// 譜面で学習した重みを使う。学習した重みは著作物から作ったもので公開のリポジトリに入れられず、モデルもブラウザで動かせないので、
// ここは学習を使わない信号処理で置き換える(精度はそのぶん落ちる。下書きとして手直しする前提):
// 1. 短時間フーリエ変換(44100 Hz・2048 点・刻み 441 = 10 ms。ADTOF と同じ毎秒 100 コマ)
// 2. 調波・打楽器の分離(HPSS。時間方向と周波数方向の中央値のフィルタで、打楽器の側の柔らかいマスク)
// 3. 打楽器の側を対数の帯域(低い所は 1 bin ずつ、上は 1/6 オクターブ)にまとめ、決まった型(キック・スネア・タム・金物)から
//    始める半適応の NMF(KL)で分ける
// 4. 打点の候補は js/gen/audio2dtx.js の pickOnsets(キック・スネアは成分の活性の峰、金物は高い帯域の立ち上がり)
// 帯域ごとの立ち上がりの強さ(stemflux.FluxEnv の代わり)・ハイハットの余韻の比・シンバルの左右・タムの音高も、ここで測る。

import { percentile, yieldToUi, GenCancelled } from './num.js';

export const ADT = {
  sr: 44100,
  nfft: 2048,
  hop: 441, // 10 ms(100 fps)
  hpssT: 17, // 時間方向の中央値の幅(コマ。170 ms)
  hpssF: 17, // 周波数方向の中央値の幅(bin。365 Hz)
  nmfIter: 40,
  nmfFixed: 20, // はじめのこの回数は型を動かさない
  nmfAdapt: 0.3, // そのあと型を学んだ形へ寄せる割合
  free: 0, // 型の外の成分の数(手元の 3 曲で 0 / 2 / 4 を比べて 0 が一番よかった。付けると金物やスネアの音を取られる)
};

/**
 * コマ i の時刻は i / fps + FRAME_T0。ハン窓の活性・立ち上がりは、打点が窓の 3/4 の所に来たときに半分に届くので、窓の頭から 3/4 で数える
 * (合成の打点で、窓の真ん中で数えるとキック・スネア・ハイハットとも 10〜13 ms 早く出た)。
 */
export const FRAME_T0 = (0.75 * ADT.nfft) / ADT.sr;

/** 成分の名前(型の順)。MT は金物(ハイハット + シンバル)。 */
export const COMPONENTS = ['KD', 'SD', 'TT', 'MT'];

// 帯域(Hz)。立ち上がりの強さ・余韻を測る(audio2dtx.BANDS と同じ範囲)
export const BANDS = {
  kick: [30, 150], snare: [150, 8000], toms: [60, 500], hh: [4000, 16000], cymbals: [2500, 16000],
};

// ---- FFT(長さ 2 の冪。表を作り置く) ----

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

/** その場の複素 FFT(順変換)。 */
export function fftInPlace(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 1; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = i + k;
        const b = a + half;
        const wr = cos[w];
        const wi = sin[w];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/**
 * 振幅のスペクトログラム(Hann の窓。2 コマを 1 回の複素 FFT でまとめて計算する)。
 * @returns {{mag: Float32Array, T: number, F: number}} mag[t·F + k]
 */
export function stftMag(x, nfft = ADT.nfft, hop = ADT.hop) {
  const F = nfft / 2 + 1;
  const T = x.length >= nfft ? Math.floor((x.length - nfft) / hop) + 1 : 0;
  const mag = new Float32Array(T * F);
  const win = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let t = 0; t < T; t += 2) {
    const a = t * hop;
    const two = t + 1 < T;
    const b = (t + 1) * hop;
    for (let i = 0; i < nfft; i++) {
      re[i] = x[a + i] * win[i];
      im[i] = two ? x[b + i] * win[i] : 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < F; k++) {
      const kr = re[k];
      const ki = im[k];
      const nr = re[(nfft - k) % nfft];
      const ni = im[(nfft - k) % nfft];
      // A = (X[k] + conj X[n-k]) / 2、B = (X[k] − conj X[n-k]) / 2i
      const ar = (kr + nr) / 2;
      const ai = (ki - ni) / 2;
      mag[t * F + k] = Math.sqrt(ar * ar + ai * ai);
      if (two) {
        const br = (ki + ni) / 2;
        const bi = -(kr - nr) / 2;
        mag[(t + 1) * F + k] = Math.sqrt(br * br + bi * bi);
      }
    }
  }
  return { mag, T, F };
}

// ---- 中央値のフィルタ(並べた窓に出し入れする) ----

/** src を stride おきに n 個読む並びに幅 w の中央値のフィルタを掛け、dst に書く(端は窓を詰める)。 */
function runningMedian(src, off, stride, n, w, dst) {
  const half = w >> 1;
  const win = [];
  const insert = (v) => {
    let lo = 0;
    let hi = win.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m] < v) lo = m + 1;
      else hi = m;
    }
    win.splice(lo, 0, v);
  };
  const remove = (v) => {
    let lo = 0;
    let hi = win.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m] < v) lo = m + 1;
      else hi = m;
    }
    win.splice(lo, 1);
  };
  for (let i = 0; i < Math.min(half, n); i++) insert(src[off + i * stride]);
  for (let i = 0; i < n; i++) {
    const add = i + half;
    if (add < n) insert(src[off + add * stride]);
    const del = i - half - 1;
    if (del >= 0) remove(src[off + del * stride]);
    const L = win.length;
    dst[off + i * stride] = L % 2 ? win[(L - 1) >> 1] : (win[L / 2 - 1] + win[L / 2]) / 2;
  }
}

/**
 * 打楽器の側(HPSS の柔らかいマスク P² / (H² + P²) を掛けた振幅)。
 * @returns {Promise<Float32Array>}
 */
export async function percussive(mag, T, F, opts = {}) {
  const kT = opts.kT || ADT.hpssT;
  const kF = opts.kF || ADT.hpssF;
  const H = new Float32Array(T * F);
  const P = new Float32Array(T * F);
  for (let k = 0; k < F; k++) {
    runningMedian(mag, k, F, T, kT, H);
    if (opts.tick && k % 64 === 63) await opts.tick();
  }
  for (let t = 0; t < T; t++) {
    runningMedian(mag, t * F, 1, F, kF, P);
    if (opts.tick && t % 2000 === 1999) await opts.tick();
  }
  const out = new Float32Array(T * F);
  for (let i = 0; i < T * F; i++) {
    const p = P[i] * P[i];
    const h = H[i] * H[i];
    out[i] = mag[i] * (p / (p + h + 1e-12));
  }
  return out;
}

// ---- 対数の帯域 ----

/** bin の帯域への割り当て(低い所は 1 bin ずつ、9 bin(約 190 Hz)より上は 1/6 オクターブ)。 */
export function bandEdges(F) {
  const edges = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let j = 1; ; j++) {
    const e = Math.round(9 * 2 ** (j / 6));
    if (e >= F) break;
    if (e > edges[edges.length - 1]) edges.push(e);
  }
  edges.push(F);
  return edges;
}

/** 帯域の真ん中の周波数(Hz)。 */
export function bandCenters(edges, sr = ADT.sr, nfft = ADT.nfft) {
  const hz = (b) => (b * sr) / nfft;
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push(Math.sqrt(Math.max(1, hz(edges[i])) * hz(edges[i + 1] - 1 + 1)));
  return out;
}

/** 振幅を帯域ごとに足す。@returns {Float32Array} v[b·T + t] */
export function toBands(mag, T, F, edges) {
  const B = edges.length - 1;
  const v = new Float32Array(B * T);
  for (let t = 0; t < T; t++) {
    const row = t * F;
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += mag[row + k];
      v[b * T + t] = s;
    }
  }
  return v;
}

/** 決まった型(帯域の重み。和を 1 にする)。真ん中の周波数 fc の、対数の周波数でのガウスの山の和。 */
export function templates(centers) {
  const bump = (f, fc, oct) => Math.exp(-0.5 * (Math.log2(f / fc) / oct) ** 2);
  const shapes = {
    KD: (f) => bump(f, 60, 0.55) + 0.08 * bump(f, 3000, 0.8),
    SD: (f) => 0.5 * bump(f, 200, 0.45) + bump(f, 3000, 1.3),
    TT: (f) => bump(f, 130, 0.55) + 0.1 * bump(f, 1500, 1),
    MT: (f) => bump(f, 10000, 1.0) + 0.25 * bump(f, 4000, 0.8),
  };
  return COMPONENTS.map((name) => {
    const w = centers.map((f) => shapes[name](f) + 1e-4);
    const s = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / s);
  });
}

/**
 * 半適応の NMF(KL の乗法の更新)。V[b·T + t] ≈ Σ_k W[k][b]·H[k·T + t]。型の成分(COMPONENTS)ははじめ固定し、
 * そのあと学んだ形へ ADT.nmfAdapt だけ寄せる。自由な成分は乱数(種を決めてある)から学ぶ。
 * @returns {Promise<{W: Float64Array[], H: Float32Array, K: number}>}
 */
export async function nmf(V, B, T, init, opts = {}) {
  const nFree = opts.free === undefined ? ADT.free : opts.free;
  const iters = opts.iter || ADT.nmfIter;
  const fixed = opts.fixed === undefined ? ADT.nmfFixed : opts.fixed;
  const adapt = opts.adapt === undefined ? ADT.nmfAdapt : opts.adapt;
  const nD = init.length;
  const K = nD + nFree;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const W = [];
  for (let k = 0; k < nD; k++) W.push(Float64Array.from(init[k]));
  for (let k = 0; k < nFree; k++) {
    const w = new Float64Array(B).map(() => 0.5 + rnd());
    const s = w.reduce((a, b) => a + b, 0);
    W.push(w.map((x) => x / s));
  }
  // 平均の大きさから始める
  let mean = 0;
  for (let i = 0; i < V.length; i++) mean += V[i];
  mean /= Math.max(1, V.length);
  const H = new Float32Array(K * T);
  for (let i = 0; i < H.length; i++) H[i] = (mean / K) * (0.5 + rnd());
  const R = new Float32Array(B * T); // V / WH
  const recon = () => {
    for (let b = 0; b < B; b++) {
      const row = b * T;
      for (let t = 0; t < T; t++) {
        let s = 1e-9;
        for (let k = 0; k < K; k++) s += W[k][b] * H[k * T + t];
        R[row + t] = V[row + t] / s;
      }
    }
  };
  for (let it = 0; it < iters; it++) {
    recon();
    // H ← H ⊙ (Wᵀ R) / (Wᵀ 1)。W の列の和は 1 なので分母は 1
    for (let k = 0; k < K; k++) {
      const w = W[k];
      const hk = k * T;
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let b = 0; b < B; b++) s += w[b] * R[b * T + t];
        H[hk + t] *= s;
      }
    }
    if (it >= fixed || nFree) {
      recon();
      // W ← W ⊙ (R Hᵀ) / (1 Hᵀ)
      for (let k = 0; k < K; k++) {
        if (k < nD && it < fixed) continue;
        const hk = k * T;
        let hs = 1e-12;
        for (let t = 0; t < T; t++) hs += H[hk + t];
        const w = W[k];
        const nw = new Float64Array(B);
        for (let b = 0; b < B; b++) {
          let s = 0;
          const row = b * T;
          for (let t = 0; t < T; t++) s += R[row + t] * H[hk + t];
          nw[b] = (w[b] * s) / hs;
        }
        let sum = 0;
        for (let b = 0; b < B; b++) sum += nw[b];
        for (let b = 0; b < B; b++) nw[b] /= sum || 1;
        if (k < nD) for (let b = 0; b < B; b++) nw[b] = (1 - adapt) * init[k][b] + adapt * nw[b];
        // 列の和を 1 に保ち、大きさは H へ
        let s2 = 0;
        for (let b = 0; b < B; b++) s2 += nw[b];
        for (let t = 0; t < T; t++) H[hk + t] *= s2;
        for (let b = 0; b < B; b++) w[b] = nw[b] / s2;
      }
    }
    if (opts.tick) await opts.tick(it / iters);
  }
  return { W, H, K };
}

// ---- 打点の候補 ----

/**
 * 活性の峰(±2 コマで一番高く、前の 5 コマの底からの立ち上がりが rise 以上、高さが thr 以上)。間は 3 コマより空ける。
 * @returns {{fr: number, a: number, rise: number}[]}
 */
export function activationPeaks(a, thr, rise) {
  const out = [];
  let last = -10;
  for (let i = 2; i < a.length - 2; i++) {
    const v = a[i];
    if (v < thr) continue;
    if (!(v > a[i - 1] && v >= a[i + 1] && v >= a[i - 2] && v >= a[i + 2])) continue;
    let lo = v;
    for (let j = Math.max(0, i - 5); j < i; j++) lo = Math.min(lo, a[j]);
    if (v - lo < rise) continue;
    if (i - last <= 3) {
      if (v > out[out.length - 1].a) out[out.length - 1] = { fr: i, a: v, rise: v - lo };
      last = i;
      continue;
    }
    out.push({ fr: i, a: v, rise: v - lo });
    last = i;
  }
  return out;
}

/**
 * 活性の峰の打点の時刻(秒): 峰の手前で、直前の底から峰までの半分を越えた所(コマの間は直線で補う)。長い窓の活性は
 * 打点が窓に入ってから出るまで上がり続けるので、峰より半分の所の方が打点の時刻に近い。
 */
export function halfRiseTime(a, i, lo, fps) {
  const half = lo + 0.5 * (a[i] - lo);
  let j = i;
  while (j > 0 && a[j - 1] >= half) j--;
  const x = j > 0 && a[j] > a[j - 1] ? j - 1 + (half - a[j - 1]) / (a[j] - a[j - 1]) : j;
  return x / fps + FRAME_T0;
}

/** 峰の時刻を放物線で補う(コマの刻みより細かく)。@returns {number} コマ(小数) */
export function refinePeak(a, i) {
  if (i <= 0 || i >= a.length - 1) return i;
  const y0 = a[i - 1];
  const y1 = a[i];
  const y2 = a[i + 1];
  const d = y0 - 2 * y1 + y2;
  return d < 0 ? i + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : i;
}

/**
 * 帯域の立ち上がりの強さ(stemflux.FluxEnv の打楽器の側の版)。flux[t] = Σ_k max(0, |P[t,k]| − |P[t−1,k]|)。
 */
export class BandEnv {
  constructor(P, T, F, band, sr = ADT.sr, nfft = ADT.nfft, hop = ADT.hop) {
    const k0 = Math.max(1, Math.round((band[0] * nfft) / sr));
    const k1 = Math.min(F - 1, Math.round((band[1] * nfft) / sr));
    this.flux = new Float32Array(T);
    this.power = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      let s = 0;
      let p = 0;
      for (let k = k0; k <= k1; k++) {
        const v = P[t * F + k];
        p += v * v;
        if (t) s += Math.max(0, v - P[(t - 1) * F + k]);
      }
      this.flux[t] = s;
      this.power[t] = p;
    }
    let m = 0;
    for (const v of this.flux) m += v;
    m /= Math.max(1, T);
    let sq = 0;
    for (const v of this.flux) sq += (v - m) * (v - m);
    this.scale = Math.sqrt(sq / Math.max(1, T)) + 1e-9;
    this.fps = sr / hop;
  }

  frame(t) {
    return Math.round((t - FRAME_T0) * this.fps);
  }

  /** 立ち上がりの際立ち(z):その付近の一番高い所 − 直前の底(FluxEnv.bump)。 */
  bump(t) {
    const fr = this.frame(t);
    let hi = -Infinity;
    for (let i = Math.max(0, fr - 2); i < Math.min(this.flux.length, fr + 3); i++) hi = Math.max(hi, this.flux[i]);
    if (hi === -Infinity) return 0;
    let lo = Infinity;
    for (let i = Math.max(0, fr - 5); i < Math.max(1, fr - 1); i++) lo = Math.min(lo, this.flux[i]);
    if (lo === Infinity) lo = 0;
    return (hi - lo) / this.scale;
  }

  /** その付近の立ち上がりの強さ(z。FluxEnv.level)。 */
  level(t) {
    const fr = this.frame(t);
    let hi = 0;
    for (let i = Math.max(0, fr - 2); i < Math.min(this.flux.length, fr + 3); i++) hi = Math.max(hi, this.flux[i]);
    return hi / this.scale;
  }

  /** [a, b) 秒の平均の強さ(帯域の振幅の二乗の和)。 */
  meanPower(a, b) {
    const i0 = Math.max(0, Math.round((a - FRAME_T0) * this.fps));
    const i1 = Math.min(this.power.length, Math.max(i0 + 1, Math.round((b - FRAME_T0) * this.fps)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += this.power[i];
    return i1 > i0 ? s / (i1 - i0) : 0;
  }

  /** [a, b) 秒の一番低い強さ(続けて鳴る音は低くならない。間を空けて叩く音は合間で下がる)。 */
  minPower(a, b) {
    const i0 = Math.max(0, Math.round((a - FRAME_T0) * this.fps));
    const i1 = Math.min(this.power.length, Math.max(i0 + 1, Math.round((b - FRAME_T0) * this.fps)));
    let m = Infinity;
    for (let i = i0; i < i1; i++) m = Math.min(m, this.power[i]);
    return m === Infinity ? 0 : m;
  }

  /**
   * 打点の後の余韻の比(stemflux.ring_ratio: 100〜250 ms ÷ 0〜60 ms の RMS)。開いたハイハットは 0.25 を越えて鳴り続ける。
   * (変更) 後ろは平均でなく一番低い所(分けた音ではないので、次の打点の音を余韻と数えない)。
   */
  ringRatio(t, until = Infinity) {
    const early = this.meanPower(t, t + 0.06);
    const end = Math.min(t + 0.25, until);
    if (end - (t + 0.1) < 0.03) return 0;
    const late = this.minPower(t + 0.1, end);
    return Math.sqrt(late) / (Math.sqrt(early) + 1e-9);
  }

  /** 打点の前後の比(stemflux.damp_ratio: 後 60〜180 ms ÷ 前 150〜30 ms)。足で閉じると開いたハイハットの音が切れる(0.6 未満)。 */
  dampRatio(t) {
    const before = this.meanPower(t - 0.15, t - 0.03);
    const after = this.meanPower(t + 0.06, t + 0.18);
    if (!(before > 0)) return 1;
    return Math.sqrt(after) / Math.sqrt(before);
  }
}

/**
 * 高い音の左右の偏り(stemflux.stereo_balance の代わり: 2500 Hz の 2 次の高域通過のあと、t から win 秒の RMS の (R − L) / (R + L))。
 * @returns {(t: number) => number}
 */
export function stereoBalance(left, right, sr = ADT.sr, fc = 2500, win = 0.06) {
  const hp = (x) => {
    // RBJ のバイカッド(Q = 0.707)
    const w0 = (2 * Math.PI * fc) / sr;
    const al = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cs = Math.cos(w0);
    const a0 = 1 + al;
    const b0 = (1 + cs) / 2 / a0;
    const b1 = -(1 + cs) / a0;
    const b2 = b0;
    const a1 = (-2 * cs) / a0;
    const a2 = (1 - al) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
      y[i] = v;
    }
    return y;
  };
  const l = hp(left);
  const r = hp(right);
  return (t) => {
    const i0 = Math.max(0, Math.floor(t * sr));
    const i1 = Math.min(l.length, i0 + Math.floor(win * sr));
    if (i1 <= i0) return 0;
    let el = 0;
    let er = 0;
    for (let i = i0; i < i1; i++) {
      el += l[i] * l[i];
      er += r[i] * r[i];
    }
    el = Math.sqrt(el / (i1 - i0));
    er = Math.sqrt(er / (i1 - i0));
    return (er - el) / (er + el + 1e-9);
  };
}

/**
 * タムの基音(Hz。audio2dtx.tom_pitch の代わり): 打点の 10〜90 ms 後の打楽器の側の振幅を平均し、55〜350 Hz で
 * 一番高い山の半分以上ある山のうち一番低いもの(一番高い山は倍音のことが多い)。放物線で補う。
 */
export function tomPitch(P, T, F, t, sr = ADT.sr, nfft = ADT.nfft, hop = ADT.hop) {
  const fr0 = Math.round((t - FRAME_T0) * (sr / hop)) + 1;
  const fr1 = Math.min(T, fr0 + 8);
  if (fr1 <= fr0) return null;
  const k0 = Math.max(1, Math.floor((55 * nfft) / sr));
  const k1 = Math.min(F - 2, Math.ceil((350 * nfft) / sr));
  const s = new Float64Array(k1 + 2);
  for (let fr = fr0; fr < fr1; fr++) for (let k = k0 - 1; k <= k1 + 1; k++) s[k] += P[fr * F + k];
  let mx = 0;
  for (let k = k0; k <= k1; k++) mx = Math.max(mx, s[k]);
  if (!(mx > 0)) return null;
  for (let k = k0; k <= k1; k++) {
    if (s[k] >= 0.5 * mx && s[k] >= s[k - 1] && s[k] >= s[k + 1]) {
      const d = s[k - 1] - 2 * s[k] + s[k + 1];
      const kk = d < 0 ? k + (0.5 * (s[k - 1] - s[k + 1])) / d : k;
      return (kk * sr) / nfft;
    }
  }
  return null;
}

/**
 * 曲の音を調べる(1〜3 の段)。
 * @param {Float32Array} left ADT.sr の左
 * @param {Float32Array} right ADT.sr の右(1 本の音なら left と同じ)
 * @param {{onProgress?: (stage: string, frac: number) => void, signal?: {cancelled: boolean}}} [opts]
 * @returns {Promise<object>}
 */
export async function analyzeAudio(left, right, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const tick = async (stage, frac) => {
    progress(stage, frac);
    await yieldToUi();
    if (opts.signal && opts.signal.cancelled) throw new GenCancelled();
  };
  const n = left.length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) / 2;
  await tick('stft', 0);
  const { mag, T, F } = stftMag(mono);
  await tick('hpss', 0);
  let done = 0;
  const P = await percussive(mag, T, F, { tick: () => tick('hpss', Math.min(1, ++done / ((F + T / 2000) / 64 + T / 2000))) });
  const edges = bandEdges(F);
  const centers = bandCenters(edges);
  const B = edges.length - 1;
  const V = toBands(P, T, F, edges);
  await tick('nmf', 0);
  const init = templates(centers);
  const { W, H } = await nmf(V, B, T, init, { ...(opts.nmf || {}), tick: (f) => tick('nmf', f) });
  const act = {};
  COMPONENTS.forEach((name, k) => {
    act[name] = H.subarray(k * T, (k + 1) * T);
  });
  const env = {};
  for (const [name, band] of Object.entries(BANDS)) env[name] = new BandEnv(P, T, F, band);
  return {
    fps: ADT.sr / ADT.hop, T, F, P, act, W, centers, env,
    balance: stereoBalance(left, right),
    tomPitch: (t) => tomPitch(P, T, F, t),
    duration: n / ADT.sr,
  };
}

/** 活性の大きさの目安(峰の高さの 95 パーセンタイル)。 */
export function activationScale(a, thrFrac = 0.02) {
  let mx = 0;
  for (const v of a) mx = Math.max(mx, v);
  const peaks = activationPeaks(a, mx * thrFrac, 0).map((p) => p.a);
  return peaks.length ? percentile(peaks, 95) : mx || 1;
}

