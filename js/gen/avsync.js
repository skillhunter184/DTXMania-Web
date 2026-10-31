// 録画の音と絵のずれを測る(vid2dtx/avsync.py の移植。docs/spec/vid2dtx-gen.md §5)。
// 譜面は動画の絵から、BGM は動画の音から作るので、録画の中の音と絵のずれは、そのまま譜面と曲のずれになる(スマホの録画などで
// 30 ms を超えることもある)。チップの時刻と音の立ち上がりの強さの並びの相互相関を取れば、そのずれが直に測れる。
// 峰が +30 ms なら音が絵より 30 ms 遅れている(補わないとチップが 30 ms 早く聞こえる)。
// (変更) 包絡の差 flux[i] は刻み i と i+1 の間(時刻 (i+1)·hop)の立ち上がりなので、その時刻で引く。vid2dtx は i·hop で引くので
// 峰が 1 刻み(5 ms)早く出て、絵空事のプレー動画(元の譜面から分かる本当のずれ −0.8 ms)で −8 ms と測った。
// vid2dtx は ffmpeg の切り出しの位置の誤差も補うために、書き出した bgm.ogg で測り直して切り直す(閉ループ)。本アプリは復号した
// 音を標本の単位で切るので、その測り直しは要らない(しない)。

import { median, argmax } from './num.js';

export const AVSYNC = {
  sr: 22050, // 包絡を作る音の標本化の速さ
  hop: 110, // 包絡の刻み(標本。5 ms)
  searchMs: 200, // ずれを探す範囲(±)
  minConfidence: 1.6, // 峰の高さ ÷ 中央値がこれ未満なら測れなかったことにする
};

/** 音の立ち上がりの強さ(hop ごとの RMS の差の正の部分を標準偏差で割ったもの。avsync.onset_envelope)。 */
export function energyFlux(pcm, hop = AVSYNC.hop) {
  const n = Math.floor(pcm.length / hop);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += pcm[j] * pcm[j];
    energy[i] = Math.sqrt(s / hop);
  }
  const flux = new Float64Array(Math.max(0, n - 1));
  let sum = 0;
  for (let i = 0; i < flux.length; i++) {
    flux[i] = Math.max(0, energy[i + 1] - energy[i]);
    sum += flux[i];
  }
  const m = flux.length ? sum / flux.length : 0;
  let sq = 0;
  for (const v of flux) sq += (v - m) * (v - m);
  const sd = flux.length ? Math.sqrt(sq / flux.length) : 0;
  for (let i = 0; i < flux.length; i++) flux[i] /= sd + 1e-9;
  return flux;
}

/**
 * 音の立ち上がりが times(秒)からどれだけ遅れているか(ms。avsync.correlate_offset_ms)。正なら立ち上がりが後
 * (= 補わないとチップが早く聞こえる)。はっきりした峰が無ければ ms は null。
 * @param {Float32Array} pcm AVSYNC.sr の 1 本の音
 * @param {number[]} times
 * @returns {{ms: number|null, confidence: number}}
 */
export function correlateOffsetMs(pcm, times, opts = {}) {
  const sr = opts.sr || AVSYNC.sr;
  const hop = opts.hop || AVSYNC.hop;
  const searchMs = opts.searchMs || AVSYNC.searchMs;
  const minConf = opts.minConfidence || AVSYNC.minConfidence;
  const flux = energyFlux(pcm, hop);
  if (!flux.length || !times.length) return { ms: null, confidence: 0 };
  const dt = hop / sr;
  const score = (lag) => {
    let s = 0;
    let n = 0;
    for (const t of times) {
      const i = Math.round((t + lag) / dt) - 1;
      if (i >= 0 && i < flux.length) {
        s += flux[i];
        n++;
      }
    }
    return n ? s / n : 0;
  };
  const coarse = [];
  for (let ms = -searchMs; ms <= searchMs; ms += 5) coarse.push(ms / 1000);
  const s = coarse.map(score);
  const base = median(s);
  const pk = argmax(s);
  const confidence = s[pk] / (base + 1e-9);
  if (confidence < minConf) return { ms: null, confidence };
  // 峰の山の重心(argmax は立ち上がりの平らな所と尖りの間で揺れる。山の重心は落ち着く)
  const fine = [];
  for (let k = 0; k <= 50; k++) fine.push(coarse[pk] - 0.025 + k * 0.001);
  const sf = fine.map(score);
  const top = Math.max(...sf);
  let sw = 0;
  let swl = 0;
  for (let i = 0; i < fine.length; i++) {
    const w = Math.max(sf[i] - (base + 0.5 * (top - base)), 0);
    sw += w;
    swl += w * fine[i];
  }
  const best = sw > 0 ? swl / sw : fine[argmax(sf)];
  return { ms: best * 1000, confidence };
}
