// 譜面の編集の「動画」を、動画の音と譜面の音(BGM・SE・チップ)の重なりで合わせる(本アプリの追加。js/edit/video.js が使う)。
// DTXMania のプレー動画の音には譜面の BGM がそのまま入っているので、音の立ち上がり(onset)の強さの並びを相互相関し、
// 一番重なる「動画の時刻 − 譜面の時刻」を探す(vid2dtx の avsync.py と同じ立ち上がりの強さ。あちらは ±200 ms の探しだが、
// ここは動画の頭の前置き(曲選び・読み込みの画面)も分からないので全部のずらしを FFT で見る)。
// 確かめ(しきい値を決めた Python の試作。絵空事のプレー動画 1280x720 60 fps と曲パックの bgm_d.ogg のファイルそのもの、8 kHz):
// 峰の高さ ÷ 2 番目の峰の高さ(峰の ±60 ms の外)は 3.4(動画の頭 40 秒だけ 1.6・後ろ 40 秒だけ 2.2)、ほかの曲の BGM では 1.03〜1.21。
// 峰の高さの z はほかの曲でも 20 を越えて見分けられなかった。よって比 ALIGN.ratioMin で決める。細かい所は 1 ms の刻みの包絡で峰の前後を
// 見て放物線で補う(bgm_d.ogg の頭は動画の 3757.03 ms、波形の相関の 3757.13 ms と 0.1 ms の内)。アプリで譜面から作った音での値は
// docs/spec/chart-editor.md §9.3(BGM の比 2.88)。

/** 合わせ方の数値。 */
export const ALIGN = {
  sr: 8000, // 読む音の標本化の速さ(Hz)
  hop: 40, // 包絡の刻み(標本。5 ms)
  win: 80, // 包絡の窓(標本。10 ms)
  fineHop: 8, // 細かい所の刻み(1 ms)
  fineWin: 16,
  sepMs: 60, // 2 番目の峰はこれより離れた所から探す
  ratioMin: 1.4, // 峰の高さ ÷ 2 番目の峰の高さ(平均から)がこれ以上なら合わせる
  maxBytes: 1.5e9, // これより大きい動画は読まない(ArrayBuffer に丸ごと読むため)
  autoMaxBytes: 400e6, // 初めて使う動画をひとりでに合わせるのはこれまで
};

/** 音の立ち上がりの強さの並び(窓の RMS の対数の正の差。平均 0・標準偏差 1 にそろえる)。 */
export function onsetEnvelope(pcm, hop = ALIGN.hop, win = ALIGN.win) {
  const n = pcm.length >= win ? Math.floor((pcm.length - win) / hop) + 1 : 0;
  const out = new Float32Array(Math.max(1, n));
  if (n < 2) return out;
  // 二乗の累積和で窓の和を出す(倍精度)
  const cum = new Float64Array(pcm.length + 1);
  for (let i = 0; i < pcm.length; i++) cum[i + 1] = cum[i] + pcm[i] * pcm[i];
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = i * hop;
    const e = Math.log(Math.sqrt(Math.max(0, cum[a + win] - cum[a]) / win) + 1e-6);
    const d = i ? Math.max(0, e - prev) : 0;
    prev = e;
    out[i] = d;
    sum += d;
  }
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    out[i] -= mean;
    sq += out[i] * out[i];
  }
  const sd = Math.sqrt(sq / n);
  if (sd > 0) for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** その場の FFT(長さは 2 の冪。inverse なら逆変換で 1/n も掛ける)。 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * 相互相関 c[k] = Σ a[i + k]·b[i](k = lo … a.length − 1、lo = −(b.length − 1))。
 * @returns {{c: Float64Array, lo: number}}
 */
export function crossCorrelate(a, b) {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  // A · conj(B)
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const m = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = m;
  }
  fft(ar, ai, true);
  const lo = -(b.length - 1);
  const c = new Float64Array(a.length + b.length - 1);
  for (let k = lo; k < a.length; k++) c[k - lo] = ar[(k + n) % n];
  return { c, lo };
}

/** 相関の峰: 一番高い所と、その ±sep の外の 2 番目の高さとの比(平均から)。 */
export function peakOf(c, sep) {
  let best = 0;
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    sum += c[i];
    if (c[i] > c[best]) best = i;
  }
  const mean = sum / c.length;
  let second = -Infinity;
  for (let i = 0; i < c.length; i++) if (Math.abs(i - best) > sep && c[i] > second) second = c[i];
  const top = c[best] - mean;
  const sub = second - mean;
  return { index: best, ratio: sub > 0 ? top / sub : top > 0 ? Infinity : 0 };
}

/** 細かい所: 1 ms の刻みの包絡で lagMs の前後 ±span ms を直に見て、峰を放物線で補う(ms)。 */
export function refineLag(video, ref, lagMs, sr = ALIGN.sr, span = 7) {
  const hop = ALIGN.fineHop;
  const ev = onsetEnvelope(video, hop, ALIGN.fineWin);
  const er = onsetEnvelope(ref, hop, ALIGN.fineWin);
  const stepMs = (hop * 1000) / sr;
  const l0 = Math.round(lagMs / stepMs);
  const vals = new Map();
  let best = null;
  for (let L = l0 - span; L <= l0 + span; L++) {
    const i0 = Math.max(0, -L);
    const i1 = Math.min(er.length, ev.length - L);
    if (i1 <= i0) continue;
    let s = 0;
    for (let i = i0; i < i1; i++) s += ev[i + L] * er[i];
    vals.set(L, s);
    if (best === null || s > vals.get(best)) best = L;
  }
  if (best === null) return lagMs;
  const a = vals.get(best - 1);
  const b = vals.get(best);
  const c = vals.get(best + 1);
  let d = 0;
  if (a !== undefined && c !== undefined && a - 2 * b + c < 0) d = (0.5 * (a - c)) / (a - 2 * b + c);
  return (best + d) * stepMs;
}

/**
 * 動画の音 video と譜面の音の候補 refs(同じ標本化の速さ。譜面の時刻 0 から)で、動画の時刻 − 譜面の時刻(ms)を探す。
 * 候補ごとに峰の比を出し、一番はっきりした候補で決める。比が ALIGN.ratioMin に届かなければ ok = false。
 * @param {Float32Array} video
 * @param {{name: string, pcm: Float32Array}[]} refs
 * @returns {{ok: boolean, offsetMs: number, ratio: number, ref: string, tried: {name: string, ratio: number, offsetMs: number}[]}}
 */
export function findOffset(video, refs, sr = ALIGN.sr) {
  const hopMs = (ALIGN.hop * 1000) / sr;
  const ev = onsetEnvelope(video);
  const tried = [];
  let best = null;
  for (const r of refs) {
    if (!r.pcm || r.pcm.length < ALIGN.win * 4) continue;
    const er = onsetEnvelope(r.pcm);
    const { c, lo } = crossCorrelate(ev, er);
    const pk = peakOf(c, Math.round(ALIGN.sepMs / hopMs));
    const coarseMs = (pk.index + lo) * hopMs;
    const t = { name: r.name, ratio: pk.ratio, offsetMs: coarseMs, pcm: r.pcm };
    tried.push(t);
    if (!best || t.ratio > best.ratio) best = t;
  }
  const out = tried.map(({ name, ratio, offsetMs }) => ({ name, ratio, offsetMs }));
  if (!best) return { ok: false, offsetMs: NaN, ratio: 0, ref: '', tried: out };
  const ok = best.ratio >= ALIGN.ratioMin;
  const offsetMs = ok ? refineLag(video, best.pcm, best.offsetMs, sr) : best.offsetMs;
  return { ok, offsetMs, ratio: best.ratio, ref: best.name, tried: out };
}

/** 複数の通り道の音を 1 本にまとめる(平均)。 */
function mono(buf) {
  const n = buf.length;
  const out = new Float32Array(n);
  const chs = buf.numberOfChannels;
  for (let ch = 0; ch < chs; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (chs > 1) for (let i = 0; i < n; i++) out[i] /= chs;
  return out;
}

/**
 * 動画のファイルの音を読む(sr Hz・1 本)。丸ごと ArrayBuffer に読んで decodeAudioData に渡す(Chrome は mp4 / webm の AAC・Opus を読める)。
 * 音の通り道が無い・読めなければ例外。
 * @param {Blob} file
 */
export async function decodeFileAudio(file, sr = ALIGN.sr) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext がありません');
  const bytes = await file.arrayBuffer();
  const ctx = new Ctx(1, 1, sr);
  const buf = await ctx.decodeAudioData(bytes);
  return mono(buf);
}

/**
 * 譜面の音を sr Hz・1 本で作る(OfflineAudioContext で、読んである音源を譜面の時刻に置く。音量は #VOLUME、パンは無視)。
 * 候補は「BGM」(ch 01)・「BGM と SE」(ch 61〜 の伴奏の分割も)・「BGM と SE とギター / ベースのチップ」・「全部」(ドラムのチップの音も。
 * ドラムを叩いた音が動画に入っていれば効く)。
 * 音の無い候補は出さない。
 * @param {any} chart
 * @param {Map<string, AudioBuffer|null>} buffers
 * @param {(chart: any, id: string) => {volume: number}} gainOf
 */
export async function renderChartAudio(chart, buffers, gainOf, sr = ALIGN.sr) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext がありません');
  // 鳴る物だけ(空ピックの音の切り替え(noChipEvents)・隠れたチップ(hiddenNotes)は、それだけでは鳴らない)
  const gb = [chart.guitar, chart.bass].filter(Boolean).flatMap((p) => p.notes || []);
  const groups = [
    ['bgm', chart.bgmEvents || []],
    ['se', chart.seEvents || []],
    ['gb', gb],
    ['chips', chart.notes || []],
  ];
  const evs = (names) => groups.filter(([g]) => names.includes(g)).flatMap(([, list]) => list).filter((e) => buffers.get(e.wavId));
  // ギター / ベースをチップに分けた譜面は BGM に入っていないので、その候補も作る(ドラムのチップと混ぜると峰がぼけるので別に)
  const sets = [
    ['bgm', evs(['bgm'])],
    ['bgm+se', evs(['bgm', 'se'])],
    ['bgm+se+gb', evs(['bgm', 'se', 'gb'])],
    ['all', evs(['bgm', 'se', 'gb', 'chips'])],
  ];
  const out = [];
  const seen = new Set();
  for (const [name, list] of sets) {
    if (!list.length || seen.has(list.length)) continue; // 前の候補と同じ(足す物が無い)なら作らない
    seen.add(list.length);
    let endS = 0;
    for (const e of list) endS = Math.max(endS, e.timeMs / 1000 + buffers.get(e.wavId).duration);
    const len = Math.max(1, Math.ceil((endS + 0.5) * sr));
    const ctx = new Ctx(1, len, sr);
    for (const e of list) {
      const src = ctx.createBufferSource();
      src.buffer = buffers.get(e.wavId);
      const g = ctx.createGain();
      g.gain.value = gainOf ? gainOf(chart, e.wavId).volume : 1;
      src.connect(g).connect(ctx.destination);
      src.start(Math.max(0, e.timeMs / 1000));
    }
    const buf = await ctx.startRendering();
    out.push({ name, pcm: mono(buf) });
  }
  return out;
}
