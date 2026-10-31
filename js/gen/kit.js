// 動画・音声から作った譜面のチャンネル・音源の決まりと、書き出すファイル(DTX の本文・ドラムの音・BGM の WAV)。
// チャンネル・#WAV の番号・音量・パンは vid2dtx(emit.LANE_CHANNEL・audio2dtx.EXTRA_LANES)と同じ。音源のファイルは
// (変更) 本アプリの合成音(js/core/synth.js の buildKitSounds)を WAV にしたもの(vid2dtx は手元の曲パックの ogg を指す)。

import { buildKitSounds, SYNTH_SAMPLE_RATE } from '../core/synth.js';
import { toBase36 } from '../core/dtx.js';

/** 種類 → {ch, wav, label, vol, pan}。並びは #WAV の行の順(vid2dtx の LANE_CHANNEL の後に EXTRA_LANES)。 */
export const KIT = {
  LC: { ch: 0x1a, wav: 5, label: 'Left Crash', vol: 80, pan: -30 },
  HHO: { ch: 0x18, wav: 3, label: 'Hi-Hat Open', vol: 70, pan: -30 },
  LP: { ch: 0x1b, wav: 4, label: 'Hi-Hat Pedal', vol: 50, pan: -30 },
  SD: { ch: 0x12, wav: 2, label: 'Snare', vol: 90, pan: -10 },
  HT: { ch: 0x14, wav: 7, label: 'High Tom', vol: 90, pan: 0 },
  BD: { ch: 0x13, wav: 1, label: 'Bass Drum', vol: 100, pan: 0 },
  LT: { ch: 0x15, wav: 8, label: 'Low Tom', vol: 90, pan: 20 },
  FT: { ch: 0x17, wav: 9, label: 'Floor Tom', vol: 90, pan: 40 },
  CY: { ch: 0x16, wav: 6, label: 'Right Crash', vol: 80, pan: 30 },
  RD: { ch: 0x19, wav: 10, label: 'Ride', vol: 80, pan: 50 },
  HHC: { ch: 0x11, wav: 12, label: 'Hi-Hat Close', vol: 60, pan: -30 },
  LBD: { ch: 0x1c, wav: 13, label: 'Left Bass Drum', vol: 100, pan: 0 },
};
export const BGM_ID = 11;
/** 合成音のファイル名(vid2dtx の kitgen の kit_<種類>.wav と同じ形。中身の md5 は付けない)。 */
export const kitFile = (kind) => `kit_${kind}.wav`;

/**
 * Float32 の波形を 16 bit PCM の WAV にする。
 * @param {Float32Array[]} channels 通り道ごとの波形(長さは同じ)
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate) {
  const nch = channels.length;
  const n = nch ? channels[0].length : 0;
  const bytes = new Uint8Array(44 + n * nch * 2);
  const v = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * nch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nch * 2, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(p, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      p += 2;
    }
  }
  return bytes;
}

/** 合成のドラムの音を WAV にする。@returns {{path: string, bytes: Uint8Array}[]} */
export function kitWavs() {
  const sounds = buildKitSounds();
  return Object.keys(KIT).map((kind) => ({ path: kitFile(kind), bytes: encodeWav([sounds[kind]], SYNTH_SAMPLE_RATE) }));
}

/** 小節の番号(10 進 3 桁。本アプリの読み込みは 999 まで)。 */
function measureStr(m) {
  if (!(m >= 0 && m <= 999)) throw new Error(`measure ${m} outside 000..999`);
  return String(m).padStart(3, '0');
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** ある小節のチップ([tick, #WAV の番号])の #mmmCC の行(emit.render_channel_line。同じ tick は後のもの)。 */
export function renderChannelLine(measure, channel, ticksChips) {
  let g = 384;
  for (const [t] of ticksChips) g = gcd(g, t);
  const n = 384 / g;
  const cells = new Array(n).fill('00');
  for (const [t, chip] of ticksChips) cells[t / g] = toBase36(chip);
  return `#${measureStr(measure)}${channel.toString(16).toUpperCase().padStart(2, '0')}: ${cells.join('')}`;
}

/**
 * 譜面の本文(emit.main / audio2dtx.emit_outputs の書き方)。
 * @param {{title: string, comment: string, bpm: number|string, chips: {m: number, tick: number, kind: string}[],
 *   barRatios?: number[], bgm?: {file: string, m: number, tick: number}|null, creator?: string}} o
 * @returns {string} 改行は CRLF
 */
export function chartText(o) {
  const out = [`; Created by DTXMania Web (${o.creator || 'vid2dtx'})`, '',
    `#TITLE: ${o.title}`,
    `#COMMENT: ${o.comment}`,
    `#BPM: ${o.bpm}`,
    '#DLEVEL: 50', ''];
  for (const [kind, k] of Object.entries(KIT)) {
    out.push(`#WAV${toBase36(k.wav)}: ${kitFile(kind)}\t;${k.label}`);
    out.push(`#VOLUME${toBase36(k.wav)}: ${k.vol}`);
    if (k.pan) out.push(`#PAN${toBase36(k.wav)}: ${k.pan}`);
  }
  if (o.bgm) {
    out.push(`#WAV${toBase36(BGM_ID)}: ${o.bgm.file}\t;BGM`, `#BGMWAV: ${toBase36(BGM_ID)}`, '');
    out.push(renderChannelLine(o.bgm.m, 0x01, [[o.bgm.tick, BGM_ID]]));
  } else {
    out.push('');
  }
  // 小節長: DTXMania は次の #mmm02 まで同じ長さを保つので、4/4 へ戻るのも書く
  let cur = 1;
  (o.barRatios || []).forEach((ratio, m) => {
    if (ratio !== cur) {
      out.push(`#${measureStr(m)}02: ${ratio}`);
      cur = ratio;
    }
  });
  const byMc = new Map();
  for (const c of o.chips) {
    const k = KIT[c.kind];
    const key = c.m * 256 + k.ch;
    if (!byMc.has(key)) byMc.set(key, []);
    byMc.get(key).push([c.tick, k.wav]);
  }
  for (const key of [...byMc.keys()].sort((a, b) => a - b)) {
    out.push(renderChannelLine(Math.floor(key / 256), key % 256, byMc.get(key)));
  }
  out.push('');
  return out.join('\r\n') + '\r\n';
}
