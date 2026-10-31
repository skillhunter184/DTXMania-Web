// 音から譜面の打点のモデル(本アプリの追加。docs/spec/vid2dtx-gen.md §6.1)。小さな CRNN(畳み込み 4 段 + 双方向 GRU)で、
// コマ(100 fps)ごとにキック・スネア・タム・ハイハット・シンバルの打点らしさ(0〜1)を出す。
// 重み(js/gen/adtweights.js)は tools/adt/ で E-GMD(Magenta、CC BY 4.0)のドラムと合成の伴奏から学習したもの。
// 入力の作り方とモデルの形は tools/adt/common.py と同じ計算(変えるときは両方を揃え、export.py で書き出し直す)。

import { ADT_MODEL_HEADER, ADT_MODEL_WEIGHTS } from './adtweights.js';

let loaded = null;

/** 重みを読む(base64 → Float32Array。1 回だけ)。@returns {{h: object, w: Float32Array}} */
export function loadModel() {
  if (loaded) return loaded;
  const bin = atob(ADT_MODEL_WEIGHTS);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const dv = new DataView(u8.buffer);
  const w = new Float32Array(u8.length / 4);
  for (let i = 0; i < w.length; i++) w[i] = dv.getFloat32(4 * i, true);
  loaded = { h: ADT_MODEL_HEADER, w };
  return loaded;
}

/** モデルのクラスの順(KD・SD・TT・HH・CY)。 */
export const MODEL_CLASSES = ADT_MODEL_HEADER.classes;

/** クラスごとの打点のしきい値(書き出したときの値。手元の 3 曲で決めた)。 */
export const MODEL_THR = ADT_MODEL_HEADER.thr;

/**
 * 入力: 振幅のスペクトログラム(js/gen/adt.js の stftMag。大きさは gain 倍して数える)を対数の帯域にまとめ log(1 + x)。
 * @returns {Float32Array} feat[t·B + b]
 */
export function modelInput(mag, T, F, gain) {
  const { h } = loadModel();
  const B = h.bands.length;
  const out = new Float32Array(T * B);
  for (let t = 0; t < T; t++) {
    const row = t * F;
    for (let b = 0; b < B; b++) {
      const [k0, ws] = h.bands[b];
      let s = 0;
      for (let j = 0; j < ws.length; j++) s += ws[j] * mag[row + k0 + j];
      out[t * B + b] = Math.log1p(gain * s);
    }
  }
  return out;
}

/**
 * 3×3 の畳み込み(0 埋め)+ ReLU。入出力は [チャンネル][行(時間) + 2][列(周波数) + 2] の縁を 0 にした並び。
 * 縁も計算してから 0 に戻す(内側だけを長い 1 本の繰り返しで回すため)。
 */
function conv3x3(x, cin, rows, cols, w, wOff, bOff, cout) {
  const W = cols + 2;
  const plane = (rows + 2) * W;
  const y = new Float32Array(cout * plane);
  const j0 = W + 1;
  const j1 = (rows + 1) * W - 1;
  for (let co = 0; co < cout; co++) {
    const yo = co * plane;
    const bias = w[bOff + co];
    for (let j = j0; j < j1; j++) y[yo + j] = bias;
    for (let ci = 0; ci < cin; ci++) {
      const xo = ci * plane;
      const ko = wOff + (co * cin + ci) * 9;
      const k0 = w[ko]; const k1 = w[ko + 1]; const k2 = w[ko + 2];
      const k3 = w[ko + 3]; const k4 = w[ko + 4]; const k5 = w[ko + 5];
      const k6 = w[ko + 6]; const k7 = w[ko + 7]; const k8 = w[ko + 8];
      // 9 つの重みを 1 回の繰り返しで(出力を読み書きする回数を減らす)
      for (let j = j0, a = xo + j0 - W - 1; j < j1; j++, a++) {
        const b = a + W;
        const c = b + W;
        y[yo + j] += k0 * x[a] + k1 * x[a + 1] + k2 * x[a + 2] + k3 * x[b] + k4 * x[b + 1] + k5 * x[b + 2]
          + k6 * x[c] + k7 * x[c + 1] + k8 * x[c + 2];
      }
    }
    for (let j = j0; j < j1; j++) if (y[yo + j] < 0) y[yo + j] = 0;
    for (let r = 1; r <= rows; r++) {
      y[yo + r * W] = 0;
      y[yo + r * W + W - 1] = 0;
    }
  }
  return y;
}

/** 周波数の向きに 3 つずつの最大(端の余りは捨てる)。出力の列は floor(cols / 3) → keep 列。 */
function poolF(x, ch, rows, cols, keep) {
  const W = cols + 2;
  const W2 = keep + 2;
  const y = new Float32Array(ch * (rows + 2) * W2);
  for (let c = 0; c < ch; c++) {
    for (let r = 1; r <= rows; r++) {
      const xi = (c * (rows + 2) + r) * W + 1;
      const yi = (c * (rows + 2) + r) * W2 + 1;
      for (let f = 0; f < keep; f++) {
        const a = x[xi + 3 * f];
        const b = x[xi + 3 * f + 1];
        const d = x[xi + 3 * f + 2];
        y[yi + f] = a > b ? (a > d ? a : d) : b > d ? b : d;
      }
    }
  }
  return y;
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

/** 双方向 GRU の片方(PyTorch の GRU と同じ式。ゲートの順は r・z・n)。出力 out[t·2H + side·H + i] に書く。 */
function gruDir(seq, T, I, H, w, d, reverse, out, side) {
  const wih = d.weight_ih;
  const whh = d.weight_hh;
  const bih = d.bias_ih;
  const bhh = d.bias_hh;
  // 入力の側はまとめて先に(T × 3H)
  const gi = new Float32Array(T * 3 * H);
  for (let t = 0; t < T; t++) {
    const xo = t * I;
    const go = t * 3 * H;
    for (let g = 0; g < 3 * H; g++) {
      let s = w[bih + g];
      const wo = wih + g * I;
      for (let i = 0; i < I; i++) s += w[wo + i] * seq[xo + i];
      gi[go + g] = s;
    }
  }
  let hPrev = new Float32Array(H);
  const gh = new Float32Array(3 * H);
  for (let step = 0; step < T; step++) {
    const t = reverse ? T - 1 - step : step;
    for (let g = 0; g < 3 * H; g++) {
      let s = w[bhh + g];
      const wo = whh + g * H;
      for (let i = 0; i < H; i++) s += w[wo + i] * hPrev[i];
      gh[g] = s;
    }
    const go = t * 3 * H;
    const hNew = new Float32Array(H);
    for (let i = 0; i < H; i++) {
      const r = sigmoid(gi[go + i] + gh[i]);
      const z = sigmoid(gi[go + H + i] + gh[H + i]);
      const n = Math.tanh(gi[go + 2 * H + i] + r * gh[2 * H + i]);
      hNew[i] = (1 - z) * n + z * hPrev[i];
      out[t * 2 * H + side * H + i] = hNew[i];
    }
    hPrev = hNew;
  }
}

/**
 * モデルを回す。
 * @param {Float32Array} feat modelInput の出力(T × B)
 * @param {{tick?: (frac: number) => Promise<void>, chunk?: number}} [opts]
 * @returns {Promise<Float32Array>} prob[t·5 + k](MODEL_CLASSES の順)
 */
export async function runModel(feat, T, opts = {}) {
  const { h, w } = loadModel();
  const B = h.bands.length;
  const [a, b] = h.inBN;
  const [f1, f2] = h.pool;
  const convs = h.convs;
  const C2 = convs[3].cout;
  const I = C2 * f2;
  const seq = new Float32Array(T * I);
  const CH = opts.chunk || 512;
  const HALO = 4; // 畳み込み 4 段の時間の向きの広がり
  for (let s0 = 0; s0 < T; s0 += CH) {
    const s1 = Math.min(T, s0 + CH);
    const r0 = Math.max(0, s0 - HALO);
    const r1 = Math.min(T, s1 + HALO);
    const rows = r1 - r0;
    // 入力の BatchNorm のあとに 0 埋め(PyTorch と同じ順)
    let x = new Float32Array((rows + 2) * (B + 2));
    for (let r = 0; r < rows; r++) {
      for (let f = 0; f < B; f++) x[(r + 1) * (B + 2) + f + 1] = feat[(r0 + r) * B + f] * a + b;
    }
    x = conv3x3(x, 1, rows, B, w, convs[0].w, convs[0].b, convs[0].cout);
    x = conv3x3(x, convs[1].cin, rows, B, w, convs[1].w, convs[1].b, convs[1].cout);
    x = poolF(x, convs[1].cout, rows, B, f1);
    x = conv3x3(x, convs[2].cin, rows, f1, w, convs[2].w, convs[2].b, convs[2].cout);
    x = conv3x3(x, convs[3].cin, rows, f1, w, convs[3].w, convs[3].b, convs[3].cout);
    x = poolF(x, C2, rows, f1, f2);
    const W2 = f2 + 2;
    for (let t = s0; t < s1; t++) {
      const r = t - r0 + 1;
      for (let c = 0; c < C2; c++) {
        const xi = (c * (rows + 2) + r) * W2 + 1;
        for (let f = 0; f < f2; f++) seq[t * I + c * f2 + f] = x[xi + f];
      }
    }
    if (opts.tick) await opts.tick((0.7 * s1) / T);
  }
  const H = h.gru.hidden;
  const hid = new Float32Array(T * 2 * H);
  gruDir(seq, T, I, H, w, h.gru.dirs[0], false, hid, 0);
  if (opts.tick) await opts.tick(0.85);
  gruDir(seq, T, I, H, w, h.gru.dirs[1], true, hid, 1);
  const K = h.classes.length;
  const prob = new Float32Array(T * K);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < K; k++) {
      let s = w[h.out.b + k];
      const wo = h.out.w + k * 2 * H;
      for (let i = 0; i < 2 * H; i++) s += w[wo + i] * hid[t * 2 * H + i];
      prob[t * K + k] = sigmoid(s);
    }
  }
  if (opts.tick) await opts.tick(1);
  return prob;
}

/**
 * 1 つのクラスの打点(±2 コマで一番高く thr 以上の峰。間は 3 コマより空け、近いものは高い方)。時刻は峰を放物線で補い、
 * コマ i の窓の真ん中 i / fps + frameC。
 * @returns {{t: number, p: number}[]}
 */
export function modelPeaks(prob, T, k, thr, fps = 100) {
  const { h } = loadModel();
  const K = h.classes.length;
  const p = (i) => prob[i * K + k];
  const at = (i) => {
    const y0 = p(i - 1);
    const y1 = p(i);
    const y2 = p(i + 1);
    const d = y0 - 2 * y1 + y2;
    const x = d < 0 ? i + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : i;
    return x / fps + h.frameC;
  };
  const out = [];
  let last = -10;
  for (let i = 2; i < T - 2; i++) {
    const v = p(i);
    if (v < thr || !(v > p(i - 1) && v >= p(i + 1) && v >= p(i - 2) && v >= p(i + 2))) continue;
    if (i - last <= 3) {
      if (out.length && v > out[out.length - 1].p) out[out.length - 1] = { t: at(i), p: v };
      last = i;
      continue;
    }
    out.push({ t: at(i), p: v });
    last = i;
  }
  return out;
}

/** 曲全体の大きさをそろえる倍率(RMS を学習のときと同じ値に)。 */
export function inputGain(mono) {
  let s = 0;
  for (let i = 0; i < mono.length; i++) s += mono[i] * mono[i];
  const rms = Math.sqrt(s / Math.max(1, mono.length));
  return loadModel().h.rmsTarget / Math.max(rms, 1e-6);
}

