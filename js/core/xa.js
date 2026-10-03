// SPDX-License-Identifier: LGPL-2.1-or-later
// DTXMania の ".xa"(KWD1 / bjXA ADPCM)デコーダ。
// vid2dtx/xa.py(DTXManiaCX XaDecoder.cs 移植・コーパス検証済み)と同じ整数セマンティクスで実装する:
// int16 の折り返し、算術右シフト、ゲイン項の 0 方向切り捨て除算。
//
// 復号の手順は libbjxa(Copyright (C) 2018-2019 Dridi Boukelmoune。GPL-3.0-or-later か LGPL-2.1-or-later を選べる)
// と同じで、その系統の実装を移植して書いたので、このファイルだけ LGPL-2.1-or-later とする(他は MIT。
// 全文は LICENSES/LGPL-2.1.txt、経緯は THIRD_PARTY_NOTICES.md)。
//
// ヘッダ(32 バイト・リトルエンディアン):
//   0: magic 'KWD1' (0x3144574B)  4: データ長  8: サンプル数  12: サンプルレート(u16)
//   14: ビット数(4/6/8)  15: チャンネル数(1/2)  16: ループ位置(未使用)  20..27: 各chの直前2サンプル

const MAGIC = 0x3144574b;
const BLOCK = 32;
const GAIN = [
  [0, 0],
  [240, 0],
  [460, -208],
  [392, -220],
  [488, -240],
];

function i16(v) {
  return (v << 16) >> 16;
}

/** 1 チャンネルブロック(プロファイル byte を除いた部分)を 32 個の int16 に展開する。 */
function inflateBlock(src, off, bits, out) {
  let n = 0;
  if (bits === 4) {
    for (let i = 0; i < 16; i++) {
      const b = src[off + i];
      out[n++] = i16((b & 0xf0) << 8);
      out[n++] = i16((b & 0x0f) << 12);
    }
  } else if (bits === 6) {
    for (let i = 0; i < 24; i += 3) {
      const packed = (src[off + i] << 16) | (src[off + i + 1] << 8) | src[off + i + 2];
      out[n++] = i16((packed & 0x00fc0000) >> 8);
      out[n++] = i16((packed & 0x0003f000) >> 2);
      out[n++] = i16((packed & 0x00000fc0) << 4);
      out[n++] = i16((packed & 0x0000003f) << 10);
    }
  } else {
    for (let i = 0; i < 32; i++) out[n++] = i16(src[off + i] << 8);
  }
}

/** bjXA ファイルか(先頭 4 バイトのマジックで判定)。 */
export function isXA(bytes) {
  if (bytes.length < 32) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(0, true) === MAGIC;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{sampleRate: number, channels: number, length: number, channelData: Float32Array[]}}
 */
export function decodeXA(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 32) throw new Error('xa: too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== MAGIC) throw new Error('xa: bad magic');
  const dataLen = v.getUint32(4, true);
  const nSamples = v.getUint32(8, true);
  const rate = v.getUint16(12, true);
  const bits = bytes[14];
  const channels = bytes[15];
  if ((channels !== 1 && channels !== 2) || (bits !== 4 && bits !== 6 && bits !== 8)) {
    throw new Error('xa: unsupported bits=' + bits + ' ch=' + channels);
  }
  const state = [
    [v.getInt16(20, true), v.getInt16(22, true)],
    [v.getInt16(24, true), v.getInt16(26, true)],
  ];
  const perCh = bits * 4 + 1;
  const blockSize = perCh * channels;
  if (dataLen % blockSize !== 0 || bytes.length < 32 + dataLen) throw new Error('xa: data length mismatch');
  const nBlocks = dataLen / blockSize;
  // ヘッダのサンプル数はデータ量と整合していること(壊れたファイルで巨大確保をしない。libbjxa IsValid と同じ条件)
  const maxSamples = nBlocks * BLOCK;
  if (rate === 0 || nBlocks === 0 || nSamples === 0) throw new Error('xa: empty stream');
  if (nSamples > maxSamples || maxSamples - nSamples >= BLOCK) throw new Error('xa: sample count mismatch');

  const channelData = [];
  for (let c = 0; c < channels; c++) channelData.push(new Float32Array(nSamples));
  const vals = new Int32Array(BLOCK);
  let off = 32;
  let written = 0;
  for (let b = 0; b < nBlocks && written < nSamples; b++) {
    const frames = Math.min(BLOCK, nSamples - written);
    for (let ch = 0; ch < channels; ch++) {
      const profile = bytes[off];
      inflateBlock(bytes, off + 1, bits, vals);
      off += perCh;
      const factor = profile >> 4;
      const rng = profile & 0x0f;
      if (factor >= GAIN.length) throw new Error('xa: bad gain factor ' + factor);
      const g0 = GAIN[factor][0];
      const g1 = GAIN[factor][1];
      let p0 = state[ch][0];
      let p1 = state[ch][1];
      const out = channelData[ch];
      for (let i = 0; i < frames; i++) {
        const gain = p0 * g0 + p1 * g1;
        let s = (vals[i] >> rng) + Math.trunc(gain / 256);
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        p1 = p0;
        p0 = s;
        out[written + i] = s / 32768;
      }
      state[ch][0] = p0;
      state[ch][1] = p1;
    }
    written += frames;
  }
  return { sampleRate: rate, channels, length: nSamples, channelData };
}
