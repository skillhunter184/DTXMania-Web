// 依存無しの ZIP 読み込み。
// - Blob(File)を丸ごとメモリへ載せず、末尾のセントラルディレクトリだけ読んで一覧を作り、
//   エントリは必要になったときに blob.slice() で取り出す(動画入りの大きな曲パックでも軽い)
// - 圧縮方式は無圧縮(0)と Deflate(8)。展開は DecompressionStream('deflate-raw') を使い、
//   無い環境では同梱の純 JS inflate にフォールバックする
// - ファイル名は UTF-8 フラグ(bit 11)があれば UTF-8、無ければ Shift-JIS / UTF-8 を推定
// - ZIP64(エントリ数 65535 超・4GB 超)の EOCD にも対応

import { decodeText } from './encoding.js';
import { t } from '../i18n.js';

const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

let crcTable = null;
function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

/** CRC-32(ZIP と同じ多項式)。 */
export function crc32(bytes) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 純 JS inflate(RFC 1951)。DecompressionStream が無い環境向けのフォールバック ----
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
let fixedLit = null;
let fixedDist = null;

function buildHuffman(lengths, n) {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

/**
 * raw deflate ストリームを展開する(同期・純 JS)。
 * @param {Uint8Array} src
 * @param {number} [expectedSize] 出力サイズのヒント
 * @returns {Uint8Array}
 */
export function inflateRawSync(src, expectedSize) {
  let out = new Uint8Array(Math.max(1024, expectedSize || src.length * 4));
  let outLen = 0;
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  function bits(n) {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('inflate: unexpected end of data');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  }
  function ensure(n) {
    if (outLen + n > out.length) {
      const nb = new Uint8Array(Math.max(out.length * 2, outLen + n));
      nb.set(out.subarray(0, outLen));
      out = nb;
    }
  }
  function decodeSym(h) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid Huffman code');
  }
  function codes(lc, dc) {
    for (;;) {
      let sym = decodeSym(lc);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new Error('inflate: invalid length symbol');
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decodeSym(dc);
        if (ds >= 30) throw new Error('inflate: invalid distance symbol');
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > outLen) throw new Error('inflate: distance too far back');
        ensure(len);
        for (let i = 0; i < len; i++) {
          out[outLen] = out[outLen - dist];
          outLen++;
        }
      }
    }
  }

  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // 無圧縮ブロック: バイト境界へ戻す
      pos -= bitCnt >>> 3;
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('inflate: truncated stored block');
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('inflate: truncated stored block');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        for (let i = 0; i < 144; i++) l[i] = 8;
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        for (let i = 280; i < 288; i++) l[i] = 8;
        fixedLit = buildHuffman(l, 288);
        fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
      }
      codes(fixedLit, fixedDist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
      const lencode = buildHuffman(cl, 19);
      const ll = new Uint8Array(nlen + ndist);
      let idx = 0;
      while (idx < nlen + ndist) {
        const sym = decodeSym(lencode);
        if (sym < 16) {
          ll[idx++] = sym;
        } else {
          let len = 0;
          let rep;
          if (sym === 16) {
            if (idx === 0) throw new Error('inflate: repeat with no previous length');
            len = ll[idx - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) {
            rep = 3 + bits(3);
          } else {
            rep = 11 + bits(7);
          }
          if (idx + rep > nlen + ndist) throw new Error('inflate: too many lengths');
          while (rep--) ll[idx++] = len;
        }
      }
      const lc = buildHuffman(ll.subarray(0, nlen), nlen);
      const dc = buildHuffman(ll.subarray(nlen), ndist);
      codes(lc, dc);
    } else {
      throw new Error('inflate: invalid block type');
    }
  } while (!last);
  return out.subarray(0, outLen);
}

/** DecompressionStream があればそれで、無ければ純 JS で展開する。 */
export async function inflateRaw(data, expectedSize) {
  if (typeof DecompressionStream === 'function') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([data]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      // 'deflate-raw' 非対応などはフォールバックへ
    }
  }
  return inflateRawSync(data, expectedSize);
}

/**
 * @typedef {Object} ZipEntry
 * @property {string} name 展開後のパス(区切りは '/')
 * @property {number} size 展開後サイズ
 * @property {number} compressedSize
 * @property {number} method 0=stored / 8=deflate
 * @property {number} crc
 * @property {number} localOffset ローカルヘッダ位置
 * @property {boolean} isDir
 * @property {boolean} utf8 ファイル名が UTF-8 フラグ付きだったか
 */

export class ZipArchive {
  /**
   * 直接は使わず {@link ZipArchive.open} を使う。
   * @param {Blob} blob
   */
  constructor(blob) {
    this.blob = blob;
    this.size = blob.size;
    /** @type {ZipEntry[]} */
    this.entries = [];
  }

  /**
   * @param {Blob|ArrayBuffer|Uint8Array} source
   */
  static async open(source) {
    let blob;
    if (source instanceof Blob) blob = source;
    else if (source instanceof ArrayBuffer) blob = new Blob([source]);
    else if (ArrayBuffer.isView(source)) blob = new Blob([source]);
    else throw new Error('ZipArchive.open: unsupported source');
    const zip = new ZipArchive(blob);
    await zip._parseCentralDirectory();
    return zip;
  }

  async _slice(start, end) {
    const s = Math.max(0, start);
    const e = Math.min(this.size, end);
    if (e <= s) return new Uint8Array(0);
    return new Uint8Array(await this.blob.slice(s, e).arrayBuffer());
  }

  async _parseCentralDirectory() {
    // EOCD は末尾 22 バイト + コメント最大 65535
    const tailStart = Math.max(0, this.size - 22 - 65535);
    const tail = await this._slice(tailStart, this.size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(t('zip.notZip'));
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let count = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOffset = tv.getUint32(eocd + 16, true);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAbs = tailStart + eocd - 20;
      const loc = await this._slice(locAbs, locAbs + 20);
      const lv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
      if (loc.length === 20 && lv.getUint32(0, true) === SIG_EOCD64_LOC) {
        const recAbs = Number(lv.getBigUint64(8, true));
        const rec = await this._slice(recAbs, recAbs + 56);
        const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        if (rec.length === 56 && rv.getUint32(0, true) === SIG_EOCD64) {
          count = Number(rv.getBigUint64(32, true));
          cdSize = Number(rv.getBigUint64(40, true));
          cdOffset = Number(rv.getBigUint64(48, true));
        }
      }
    }

    const cd = await this._slice(cdOffset, cdOffset + cdSize);
    const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || v.getUint32(p, true) !== SIG_CEN) {
        throw new Error(t('zip.badCentralDir'));
      }
      const flags = v.getUint16(p + 8, true);
      const method = v.getUint16(p + 10, true);
      const crc = v.getUint32(p + 16, true);
      let compressedSize = v.getUint32(p + 20, true);
      let size = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const extAttr = v.getUint32(p + 38, true);
      let localOffset = v.getUint32(p + 42, true);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      const utf8 = (flags & 0x800) !== 0;

      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = v.getUint16(e, true);
          const len = v.getUint16(e + 2, true);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === 0xffffffff) { size = Number(v.getBigUint64(q, true)); q += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(v.getBigUint64(q, true)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(v.getBigUint64(q, true)); q += 8; }
            break;
          }
          e += 4 + len;
        }
      }

      const name = decodeText(nameBytes, { preferUtf8: utf8 }).replace(/\\/g, '/');
      const isDir = name.endsWith('/') || ((extAttr & 0x10) !== 0 && size === 0);
      // nameBytes / time / date / extAttr は書き出し(ZipWriter.copyEntry)で元のまま使う
      this.entries.push({
        name, size, compressedSize, method, crc, localOffset, isDir, utf8, flags,
        nameBytes: nameBytes.slice(), time: v.getUint16(p + 12, true), date: v.getUint16(p + 14, true), extAttr,
        madeBy: v.getUint16(p + 4, true),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** エントリの実データ範囲(ローカルヘッダを読んで求める)。 */
  async _dataRange(entry) {
    const head = await this._slice(entry.localOffset, entry.localOffset + 30);
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || v.getUint32(0, true) !== SIG_LOC) {
      throw new Error(t('zip.badLocalHeader', { name: entry.name }));
    }
    const nameLen = v.getUint16(26, true);
    const extraLen = v.getUint16(28, true);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (end > this.size) throw new Error(t('zip.truncated', { name: entry.name }));
    return { start, end };
  }

  /**
   * エントリを展開して返す。
   * @param {ZipEntry} entry
   * @param {{verifyCrc?: boolean, forceSync?: boolean}} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async read(entry, opts = {}) {
    if (entry.flags & 0x1) throw new Error(t('zip.encrypted', { name: entry.name }));
    if (entry.method === 99) throw new Error(t('zip.aes', { name: entry.name }));
    const { start, end } = await this._dataRange(entry);
    let data;
    if (entry.method === 0) {
      data = await this._slice(start, end);
    } else if (entry.method === 8) {
      if (!opts.forceSync && typeof DecompressionStream === 'function') {
        // 圧縮データを JS ヒープに載せず、Blob のスライスをそのまま展開ストリームへ流す
        try {
          const ds = new DecompressionStream('deflate-raw');
          const stream = this.blob.slice(start, end).stream().pipeThrough(ds);
          data = new Uint8Array(await new Response(stream).arrayBuffer());
        } catch (e) {
          data = null;
        }
      }
      if (!data) data = inflateRawSync(await this._slice(start, end), entry.size);
    } else {
      throw new Error(t('zip.method', { method: entry.method, name: entry.name }));
    }
    if (opts.verifyCrc && data.length > 0 && crc32(data) !== entry.crc) {
      console.warn('ZIP: CRC が一致しません: ' + entry.name);
    }
    return data;
  }

  /** 名前(区切りは '/')で探す。大文字小文字は区別しない。 */
  find(name) {
    const key = name.replace(/\\/g, '/').toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === key) || null;
  }

  /** エントリの圧縮されたままのデータ(Blob のスライス。メモリへは載せない)。 */
  async rawData(entry) {
    const { start, end } = await this._dataRange(entry);
    return this.blob.slice(start, end);
  }
}

// ---- 書き出し(譜面の編集で、編集した譜面を入れた ZIP を作る) ----

/** Date → MS-DOS の時刻と日付。 */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const U32 = 0xffffffff;

/**
 * ZIP を組み立てる。元の ZIP のエントリは圧縮されたまま写し(展開も再圧縮もしない)、新しいファイルは無圧縮で入れる。
 * 中身は Blob の部品として持つので、大きな曲パックでもメモリへ載せない。4 GB を超える位置・大きさは ZIP64 で書く。
 */
export class ZipWriter {
  constructor() {
    this._parts = []; // Blob の部品(Uint8Array / Blob)
    this._central = []; // セントラルディレクトリのレコード(Uint8Array)
    this._offset = 0;
    this.count = 0;
  }

  _push(part) {
    this._parts.push(part);
    this._offset += part instanceof Blob ? part.size : part.length;
  }

  /**
   * @param {{nameBytes: Uint8Array, utf8: boolean, method: number, crc: number, compressedSize: number, size: number,
   *   time: number, date: number, extAttr?: number, madeBy?: number}} e
   * @param {Blob|Uint8Array} data 圧縮されたままのデータ
   */
  _add(e, data) {
    const offset = this._offset;
    const big = e.compressedSize >= U32 || e.size >= U32;
    const bigOffset = offset >= U32;
    const flags = e.utf8 ? 0x800 : 0; // 暗号化・データ記述子のビットは立てない(大きさはヘッダに書く)
    const version = big || bigOffset ? 45 : 20;

    // ローカルヘッダ(ZIP64 なら大きさを extra に書く)
    const locExtra = big ? 20 : 0;
    const loc = new Uint8Array(30 + e.nameBytes.length + locExtra);
    const lv = new DataView(loc.buffer);
    lv.setUint32(0, SIG_LOC, true);
    lv.setUint16(4, version, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.time, true);
    lv.setUint16(12, e.date, true);
    lv.setUint32(14, e.crc >>> 0, true);
    lv.setUint32(18, big ? U32 : e.compressedSize, true);
    lv.setUint32(22, big ? U32 : e.size, true);
    lv.setUint16(26, e.nameBytes.length, true);
    lv.setUint16(28, locExtra, true);
    loc.set(e.nameBytes, 30);
    if (big) {
      const x = 30 + e.nameBytes.length;
      lv.setUint16(x, 0x0001, true);
      lv.setUint16(x + 2, 16, true);
      lv.setBigUint64(x + 4, BigInt(e.size), true);
      lv.setBigUint64(x + 12, BigInt(e.compressedSize), true);
    }
    this._push(loc);
    this._push(data);

    // セントラルディレクトリ
    const z64 = [];
    if (big) z64.push(e.size, e.compressedSize);
    if (bigOffset) z64.push(offset);
    const cenExtra = z64.length ? 4 + 8 * z64.length : 0;
    const cen = new Uint8Array(46 + e.nameBytes.length + cenExtra);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, SIG_CEN, true);
    // 作成元(上位バイトが OS。外部属性の読み方が変わる)は元のエントリのまま
    cv.setUint16(4, e.madeBy !== undefined ? e.madeBy : version, true);
    cv.setUint16(6, version, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc >>> 0, true);
    cv.setUint32(20, big ? U32 : e.compressedSize, true);
    cv.setUint32(24, big ? U32 : e.size, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, cenExtra, true);
    cv.setUint32(38, (e.extAttr || 0) >>> 0, true);
    cv.setUint32(42, bigOffset ? U32 : offset, true);
    cen.set(e.nameBytes, 46);
    if (cenExtra) {
      const x = 46 + e.nameBytes.length;
      cv.setUint16(x, 0x0001, true);
      cv.setUint16(x + 2, 8 * z64.length, true);
      z64.forEach((n, i) => cv.setBigUint64(x + 4 + 8 * i, BigInt(n), true));
    }
    this._central.push(cen);
    this.count++;
  }

  /**
   * 元の ZIP のエントリを圧縮されたまま写す(名前のバイト列・時刻・属性も元のまま)。
   * @param {ZipArchive} zip
   * @param {ZipEntry} entry
   */
  async copyEntry(zip, entry) {
    if (entry.flags & 0x1) throw new Error(t('zip.encrypted', { name: entry.name }));
    const data = await zip.rawData(entry);
    this._add({
      nameBytes: entry.nameBytes || new TextEncoder().encode(entry.name),
      utf8: entry.nameBytes ? entry.utf8 : true,
      method: entry.method, crc: entry.crc, compressedSize: entry.compressedSize, size: entry.size,
      time: entry.time || 0, date: entry.date || 0x21, extAttr: entry.extAttr || 0, madeBy: entry.madeBy,
    }, data);
  }

  /**
   * ファイルを無圧縮で入れる。名前は UTF-8(フラグ付き)。nameBytes を渡すとそのバイト列を使う(元の ZIP の名前を保つ)。
   * @param {string} name
   * @param {Uint8Array} bytes
   * @param {{nameBytes?: Uint8Array, utf8?: boolean, date?: Date, extAttr?: number}} [opts]
   */
  addFile(name, bytes, opts = {}) {
    const { time, date } = dosDateTime(opts.date || new Date());
    const nameBytes = opts.nameBytes || new TextEncoder().encode(name);
    this._add({
      nameBytes, utf8: opts.nameBytes ? !!opts.utf8 : true, method: 0, crc: crc32(bytes),
      compressedSize: bytes.length, size: bytes.length, time, date, extAttr: opts.extAttr || 0,
    }, bytes);
  }

  /**
   * CRC と大きさが分かっているデータ(フォルダから選んだ File など)を無圧縮で入れる。中身はメモリへ載せない。
   * @param {string} name
   * @param {Blob} blob
   * @param {number} crc
   * @param {{date?: Date}} [opts]
   */
  addBlob(name, blob, crc, opts = {}) {
    const { time, date } = dosDateTime(opts.date || new Date());
    this._add({
      nameBytes: new TextEncoder().encode(name), utf8: true, method: 0, crc,
      compressedSize: blob.size, size: blob.size, time, date, extAttr: 0,
    }, blob);
  }

  /** @returns {Blob} */
  finish() {
    const cdOffset = this._offset;
    let cdSize = 0;
    for (const c of this._central) cdSize += c.length;
    const parts = this._parts.concat(this._central);
    const needs64 = this.count >= 0xffff || cdOffset >= U32 || cdSize >= U32;
    if (needs64) {
      const rec = new Uint8Array(56 + 20);
      const rv = new DataView(rec.buffer);
      rv.setUint32(0, SIG_EOCD64, true);
      rv.setBigUint64(4, 44n, true);
      rv.setUint16(12, 45, true);
      rv.setUint16(14, 45, true);
      rv.setBigUint64(24, BigInt(this.count), true);
      rv.setBigUint64(32, BigInt(this.count), true);
      rv.setBigUint64(40, BigInt(cdSize), true);
      rv.setBigUint64(48, BigInt(cdOffset), true);
      rv.setUint32(56, SIG_EOCD64_LOC, true);
      rv.setBigUint64(56 + 8, BigInt(cdOffset + cdSize), true);
      rv.setUint32(56 + 16, 1, true);
      parts.push(rec);
    }
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, Math.min(this.count, 0xffff), true);
    ev.setUint16(10, Math.min(this.count, 0xffff), true);
    ev.setUint32(12, Math.min(cdSize, U32), true);
    ev.setUint32(16, Math.min(cdOffset, U32), true);
    parts.push(eocd);
    return new Blob(parts, { type: 'application/zip' });
  }
}

/**
 * フォルダ選択(input webkitdirectory)やドラッグ&ドロップで得た File の集合を、
 * ZipArchive と同じ形(entries / read)で扱う。
 */
export class FileSetArchive {
  /**
   * @param {File[]} files
   * @param {string} [rootName] 先頭から取り除くパス(選択フォルダ名)
   */
  constructor(files, rootName = '') {
    this.entries = [];
    this._files = new Map();
    for (const f of files) {
      let name = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      if (rootName && name.startsWith(rootName + '/')) name = name.slice(rootName.length + 1);
      const entry = { name, size: f.size, compressedSize: f.size, method: 0, crc: 0, localOffset: 0, isDir: false, utf8: true, flags: 0 };
      this.entries.push(entry);
      this._files.set(entry, f);
    }
  }

  async read(entry) {
    const f = this._files.get(entry);
    if (!f) throw new Error('file not found: ' + entry.name);
    return new Uint8Array(await f.arrayBuffer());
  }

  /** エントリの File(ZIP に書き出すとき、中身をメモリへ載せずに渡す)。 */
  fileOf(entry) {
    return this._files.get(entry) || null;
  }

  find(name) {
    const key = name.replace(/\\/g, '/').toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === key) || null;
  }
}
