// RIFF/WAVE の PCM デコード(decodeAudioData が失敗したときのフォールバック)。
// PCM(1)/IEEE float(3)/WAVE_FORMAT_EXTENSIBLE(0xFFFE)、8/16/24/32 bit、任意チャンネル数に対応。

export function isWav(bytes) {
  return bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{sampleRate:number, channels:number, length:number, channelData:Float32Array[]}}
 */
export function decodeWav(bytes) {
  if (!isWav(bytes)) throw new Error('wav: not a RIFF/WAVE file');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (p + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    let len = v.getUint32(p + 4, true);
    const body = p + 8;
    if (body + len > bytes.length) len = bytes.length - body; // サイズが壊れているファイルは末尾まで
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const blockAlign = v.getUint16(body + 12, true);
      const bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && len >= 26) format = v.getUint16(body + 24, true); // SubFormat の先頭 2 バイト
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      dataStart = body;
      dataLen = len;
      if (fmt) break;
    }
    p = body + len + (len & 1);
  }
  if (!fmt || dataStart < 0) throw new Error('wav: fmt/data chunk not found');
  const { format, channels, sampleRate, bits } = fmt;
  if (channels < 1 || (format !== 1 && format !== 3)) throw new Error('wav: unsupported format ' + format);
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const channelData = [];
  for (let c = 0; c < channels; c++) channelData.push(new Float32Array(frames));
  let q = dataStart;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let s;
      if (format === 3) {
        s = bits === 64 ? v.getFloat64(q, true) : v.getFloat32(q, true);
      } else if (bits === 8) {
        s = (bytes[q] - 128) / 128;
      } else if (bits === 16) {
        s = v.getInt16(q, true) / 32768;
      } else if (bits === 24) {
        s = ((bytes[q] | (bytes[q + 1] << 8) | (bytes[q + 2] << 16)) << 8 >> 8) / 8388608;
      } else if (bits === 32) {
        s = v.getInt32(q, true) / 2147483648;
      } else {
        throw new Error('wav: unsupported bit depth ' + bits);
      }
      channelData[c][i] = s;
      q += bytesPer;
    }
  }
  return { sampleRate, channels, length: frames, channelData };
}
