// 譜面の編集の土台: DTX のテキストを行の列として持ち、変えたところだけを書き直す文書。
//
// vid2dtx(preview.py の save。docs/spec/vid2dtx-edit.md §5)はドラムの行を全部消して末尾に作り直すが、本アプリは
// (変更) 変えた (小節, チャンネル) の行だけを書き直し、ほかの行はバイト列ごと元のまま残す(コメント・行の並び・
// 分割数・文字コード・改行も変えない)。書き直す行は、元の行のうち最初の位置に置く。
//
// - 行の読み方は js/core/dtx.js の parseDTX と同じ(splitHeader / isDataLine / 小節 3 桁の 10 進 / チャンネル 16 進 2 桁 /
//   ':' 以降を ';' で切り空白と '_' を除く / tick = floor(384 i / N))
// - #IF 〜 #ENDIF の中の行は触らない(どの分岐が選ばれるかは演奏ごとに変わるので、編集の対象にしない)
// - 文書は変更できない値として扱う。編集の操作は新しい DtxDoc を返す(元に戻す・やり直しは文書を積むだけ)

import { TICKS_PER_MEASURE, splitHeader, isDataLine, stripComment } from '../core/dtx.js';
import { decodeTextInfo, encodeText } from '../core/encoding.js';

/** 書ける小節番号の上限(本アプリの parseDTX は 10 進 3 桁しか読まない。NX の 36 進の百の位は書かない)。 */
export const MAX_MEASURE = 999;

/** (小節, チャンネル) のキー。小節の順・同じ小節ならチャンネルの順に並ぶ。 */
export function groupKey(measure, channel) {
  return measure * 256 + channel;
}

export function keyMeasure(key) {
  return Math.floor(key / 256);
}

export function keyChannel(key) {
  return key % 256;
}

const HEX = '0123456789ABCDEF';
function hex2(ch) {
  return HEX[(ch >> 4) & 15] + HEX[ch & 15];
}

function pad3(m) {
  return String(m).padStart(3, '0');
}

/** 小節長(ch 02)の値の書き方(小数 6 桁まで、末尾の 0 は落とす)。 */
export function formatBarLength(v) {
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

/**
 * tick の並びを floor(384 i / n) で表せる最小の分割数 n(元の行と同じ 3 分割・5 分割などを短く書く)。
 * どの n でも表せなければ 384(tick がそのまま添字)。
 * @param {number[]} ticks 0..383 の重複の無い整数
 */
export function minimalDivision(ticks) {
  if (!ticks.length) return 1;
  for (let n = Math.max(1, ticks.length); n <= TICKS_PER_MEASURE; n++) {
    let ok = true;
    for (const t of ticks) {
      const i = Math.ceil((t * n) / TICKS_PER_MEASURE);
      if (i >= n || Math.floor((TICKS_PER_MEASURE * i) / n) !== t) {
        ok = false;
        break;
      }
    }
    if (ok) return n;
  }
  return TICKS_PER_MEASURE;
}

/**
 * (小節, チャンネル) のチップを DTX の行にする。同じ tick に 2 つ以上あれば行を分ける(読み直しても同じチップになる)。
 * 小節長(ch 02)は最後の値の 1 行。チップが無ければ空の配列。
 * @param {number} measure
 * @param {number} channel
 * @param {{tick:number, value:string}[]} chips
 * @returns {string[]}
 */
export function renderGroupLines(measure, channel, chips) {
  if (!chips.length) return [];
  const head = '#' + pad3(measure) + hex2(channel) + ': ';
  if (channel === 0x02) return [head + chips[chips.length - 1].value];
  const layers = [];
  for (const c of [...chips].sort((a, b) => a.tick - b.tick)) {
    let layer = layers.find((l) => !l.has(c.tick));
    if (!layer) {
      layer = new Map();
      layers.push(layer);
    }
    layer.set(c.tick, c.value);
  }
  return layers.map((layer) => {
    const ticks = [...layer.keys()];
    const n = minimalDivision(ticks);
    const cells = new Array(n).fill('00');
    for (const [t, v] of layer) cells[Math.ceil((t * n) / TICKS_PER_MEASURE)] = v;
    return head + cells.join('');
  });
}

/**
 * データ行を読む(parseDataLine と同じ)。データ行でなければ null。':' が無い・チャンネルが読めないなど、
 * parseDTX が捨てる行も null(そのまま残す)。
 * @returns {{measure:number, channel:number, chips:{tick:number, value:string}[]}|null}
 */
export function parseObjectLine(body) {
  if (!isDataLine(body)) return null;
  const colon = body.indexOf(':');
  if (colon < 5) return null;
  const measure = parseInt(body.slice(0, 3), 10);
  if (!Number.isFinite(measure)) return null;
  const cc = body.slice(3, 5);
  if (!/^[0-9A-Fa-f]{2}$/.test(cc)) return null;
  const channel = parseInt(cc, 16);
  let data = body.slice(colon + 1);
  const semi = data.indexOf(';');
  if (semi !== -1) data = data.slice(0, semi);
  data = data.replace(/[ \t_]/g, '');
  const chips = [];
  if (data.length === 0) return { measure, channel, chips };
  if (channel === 0x02) {
    chips.push({ tick: 0, value: data });
    return { measure, channel, chips };
  }
  const n = Math.floor(data.length / 2);
  for (let i = 0; i < n; i++) {
    const v = data.slice(i * 2, i * 2 + 2).toUpperCase();
    if (v === '00') continue;
    chips.push({ tick: Math.floor((TICKS_PER_MEASURE * i) / n), value: v });
  }
  return { measure, channel, chips };
}

/** 1 行の読み(行の文字列ごとに一度だけ作る)。 */
function classify(text) {
  const s = text.replace(/^[ \t]+/, '');
  if (s.length < 2 || s[0] !== '#') return { kind: 'other' };
  const body = s.slice(1);
  const o = splitHeader(body);
  const up = o.cmd.toUpperCase();
  // IfStack.skipsLine と同じ順(ENDIF → IF → RANDOM。前方一致)
  if (up.startsWith('ENDIF')) return { kind: 'endif' };
  if (up.startsWith('IF')) return { kind: 'if' };
  if (up.startsWith('RANDOM')) return { kind: 'random' };
  if (isDataLine(body)) {
    const obj = parseObjectLine(body);
    return obj ? { kind: 'object', ...obj } : { kind: 'other' };
  }
  return { kind: 'header', cmd: up, rawCmd: o.cmd, param: o.param };
}

const _classCache = new Map();
function classifyCached(text) {
  let c = _classCache.get(text);
  if (!c) {
    c = classify(text);
    if (_classCache.size > 50000) _classCache.clear();
    _classCache.set(text, c);
  }
  return c;
}

/** バイト列を行に分ける(CR LF / LF / CR)。UTF-16 は 2 バイト単位で探す。 */
function splitByteLines(bytes, start, utf16) {
  const out = [];
  const step = utf16 ? 2 : 1;
  const unitAt = utf16 === 'le' ? (i) => bytes[i] | (bytes[i + 1] << 8)
    : utf16 === 'be' ? (i) => (bytes[i] << 8) | bytes[i + 1] : (i) => bytes[i];
  let lineStart = start;
  let i = start;
  const end = bytes.length - (utf16 ? (bytes.length - start) % 2 : 0);
  while (i < end) {
    const u = unitAt(i);
    if (u === 0x0d || u === 0x0a) {
      let eol = u === 0x0d ? '\r' : '\n';
      let next = i + step;
      if (u === 0x0d && next < end && unitAt(next) === 0x0a) {
        eol = '\r\n';
        next += step;
      }
      out.push({ start: lineStart, end: i, eol });
      lineStart = next;
      i = next;
    } else {
      i += step;
    }
  }
  out.push({ start: lineStart, end: bytes.length, eol: '' });
  return out;
}

function decoderFor(encoding) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return new TextDecoder(encoding);
  if (encoding === 'shift_jis') return new TextDecoder('shift_jis');
  return new TextDecoder('utf-8');
}

/**
 * @typedef {Object} DocLine
 * @property {string} text 行の文字列(改行を含まない)
 * @property {Uint8Array|null} bytes 元のファイルのバイト列(書き直した行は null)
 * @property {string} eol この行の後ろの改行('' は最終行)
 */

export class DtxDoc {
  /**
   * @param {DocLine[]} lines
   * @param {{encoding:string, bom:boolean, eol:string}} info
   */
  constructor(lines, info) {
    this.lines = lines;
    this.info = info;
    this._index = null;
  }

  /** ファイルのバイト列から読む(文字コード・BOM・改行を覚え、行ごとに元のバイト列を持つ)。 */
  static fromBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const { encoding, bom } = decodeTextInfo(bytes);
    const utf16 = encoding === 'utf-16le' ? 'le' : encoding === 'utf-16be' ? 'be' : null;
    const start = bom ? (utf16 ? 2 : 3) : 0;
    const dec = decoderFor(encoding);
    const lines = splitByteLines(bytes, start, utf16).map(({ start: s, end, eol }) => {
      const b = bytes.slice(s, end);
      return { text: dec.decode(b), bytes: b, eol };
    });
    return new DtxDoc(lines, { encoding, bom, eol: dominantEol(lines) });
  }

  /** 文字列から作る(新しい譜面・テスト)。 */
  static fromText(text, info = {}) {
    const parts = text.split(/(\r\n|\n|\r)/);
    const lines = [];
    for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], bytes: null, eol: parts[i + 1] || '' });
    const eol = info.eol || dominantEol(lines);
    return new DtxDoc(lines, { encoding: info.encoding || 'shift_jis', bom: !!info.bom, eol });
  }

  /** 文書全体の文字列(parseDTX に渡す)。 */
  get text() {
    let s = '';
    const n = this.lines.length;
    for (let i = 0; i < n; i++) {
      const l = this.lines[i];
      s += l.text + (i < n - 1 ? l.eol || this.info.eol : '');
    }
    return s;
  }

  /**
   * ファイルのバイト列にする。元の行は元のバイト列のまま。書き直した行が元の文字コードで書けない
   * (Shift-JIS に無い文字)ときは全体を UTF-8(BOM 付き)で書き、encoding でそれを知らせる。
   * @returns {{bytes: Uint8Array, encoding: string, bom: boolean, changedEncoding: boolean}}
   */
  toBytes() {
    let { encoding, bom } = this.info;
    const parts = [];
    let changed = false;
    const enc = (s) => encodeText(s, encoding, false);
    let lines = this.lines;
    // 書き直した文書は改行で終える(DTXCreator は改行の無い最終行を読み落とす。docs/spec/dtxcreator-io.md §2.2)
    const last = lines[lines.length - 1];
    if (last && last.text !== '' && lines.some((l) => !l.bytes)) {
      lines = lines.slice(0, -1).concat([{ ...last, eol: this.info.eol }, { text: '', bytes: null, eol: '' }]);
    }
    // 書き直した行が今の文字コードで書けるか(書けなければ全体を UTF-8 にする)
    for (const l of lines) {
      if (l.bytes) continue;
      const r = enc(l.text);
      if (r.encoding !== encoding && !(encoding === 'ascii' && r.encoding === 'shift_jis')) {
        changed = true;
        break;
      }
      if (encoding === 'ascii' && r.encoding === 'shift_jis') encoding = 'shift_jis';
    }
    if (changed) {
      encoding = 'utf-8';
      bom = true;
    }
    const reuse = !changed;
    const n = lines.length;
    for (let i = 0; i < n; i++) {
      const l = lines[i];
      parts.push(reuse && l.bytes ? l.bytes : encodeText(l.text, encoding, false).bytes);
      if (i < n - 1) parts.push(encodeText(l.eol || this.info.eol, encoding, false).bytes);
    }
    if (bom) parts.unshift(encodeText('', encoding, true).bytes);
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return { bytes: out, encoding, bom, changedEncoding: changed };
  }

  /**
   * 行の索引(作り直しは文書ごとに一度)。
   * groups: (小節, チャンネル) → {measure, channel, lines: 行番号[], chips}(#IF の外の行だけ)
   * headers: #IF の外のヘッダ行 {idx, cmd, rawCmd, param}
   * lockedObjects: #IF の中のデータ行の数 / firstObject: #IF の外の最初のデータ行の行番号(無ければ -1)
   */
  get index() {
    if (this._index) return this._index;
    const groups = new Map();
    const headers = [];
    let depth = 0;
    let lockedObjects = 0;
    let firstObject = -1;
    let maxMeasure = -1;
    for (let i = 0; i < this.lines.length; i++) {
      const c = classifyCached(this.lines[i].text);
      if (c.kind === 'endif') {
        if (depth > 0) depth--;
        continue;
      }
      if (c.kind === 'if') {
        if (depth < 254) depth++;
        continue;
      }
      if (c.kind === 'object') {
        if (c.chips.length && c.measure > maxMeasure) maxMeasure = c.measure;
        if (depth > 0) {
          lockedObjects++;
          continue;
        }
        if (firstObject < 0) firstObject = i;
        const key = groupKey(c.measure, c.channel);
        let g = groups.get(key);
        if (!g) {
          g = { measure: c.measure, channel: c.channel, lines: [], chips: [] };
          groups.set(key, g);
        }
        g.lines.push(i);
        for (const chip of c.chips) g.chips.push(chip);
      } else if (c.kind === 'header' && depth === 0) {
        headers.push({ idx: i, cmd: c.cmd, rawCmd: c.rawCmd, param: c.param });
      }
    }
    this._index = { groups, headers, lockedObjects, firstObject, maxMeasure };
    return this._index;
  }

  /** (小節, チャンネル) のチップ(#IF の外)。 */
  chipsOf(measure, channel) {
    const g = this.index.groups.get(groupKey(measure, channel));
    return g ? g.chips : [];
  }

  /** ヘッダの値(#IF の外で最後に書かれたもの。parseDTX と同じ)。無ければ null。 */
  header(cmd) {
    const up = cmd.toUpperCase();
    const hs = this.index.headers;
    for (let i = hs.length - 1; i >= 0; i--) if (hs[i].cmd === up) return hs[i].param;
    return null;
  }

  /** 行を差し替えた新しい文書。 */
  _with(lines) {
    return new DtxDoc(lines, this.info);
  }

  /**
   * (小節, チャンネル) のチップをまとめて置き換える。
   * @param {Map<number, {tick:number, value:string}[]>} changes groupKey → 新しいチップ(空の配列で行を消す)
   * @returns {DtxDoc}
   */
  withGroups(changes) {
    if (!changes.size) return this;
    const { groups } = this.index;
    const replaceAt = new Map(); // 行番号 → 書き直した行(その組の最初の行)
    const drop = new Set(); // 消す行
    const fresh = []; // 元の行が無い組 [key, lines]
    for (const [key, chips] of changes) {
      const m = keyMeasure(key);
      if (m < 0 || m > MAX_MEASURE) throw new RangeError('measure out of range: ' + m);
      const rendered = renderGroupLines(m, keyChannel(key), chips);
      const g = groups.get(key);
      if (g && g.lines.length) {
        replaceAt.set(g.lines[0], rendered);
        for (const i of g.lines) drop.add(i);
      } else if (rendered.length) {
        fresh.push([key, rendered]);
      }
    }
    // 元の行が無い組の置き場所: キーがすぐ下の組の後ろ、無ければすぐ上の組の前、データ行が無ければ末尾
    const after = new Map();
    const before = new Map();
    const atEnd = [];
    if (fresh.length) {
      const keys = [...groups.entries()].filter(([, g]) => g.lines.length).map(([k, g]) => [k, g.lines]).sort((a, b) => a[0] - b[0]);
      fresh.sort((a, b) => a[0] - b[0]);
      for (const [key, rendered] of fresh) {
        let lo = null;
        let hi = null;
        for (const [k, ls] of keys) {
          if (k < key) lo = ls;
          else if (k > key && !hi) hi = ls;
        }
        if (lo) push(after, lo[lo.length - 1], rendered);
        else if (hi) push(before, hi[0], rendered);
        else atEnd.push(...rendered);
      }
    }
    const out = [];
    const newLine = (text) => ({ text, bytes: null, eol: this.info.eol });
    const n = this.lines.length;
    // 末尾に足す行は、ファイルの最後の空行(末尾の改行)の前に置く
    const tail = n > 0 && this.lines[n - 1].text === '' ? n - 1 : n;
    for (let i = 0; i < n; i++) {
      if (i === tail) for (const t of atEnd) out.push(newLine(t));
      if (before.has(i)) for (const t of before.get(i)) out.push(newLine(t));
      if (replaceAt.has(i)) for (const t of replaceAt.get(i)) out.push(newLine(t));
      if (!drop.has(i)) out.push(this.lines[i]);
      if (after.has(i)) for (const t of after.get(i)) out.push(newLine(t));
    }
    if (tail === n) for (const t of atEnd) out.push(newLine(t));
    return this._with(fixEols(out, this.info.eol));
  }

  /**
   * ヘッダを書く(#IF の外の同じコマンドの行をすべて書き直す。parseDTX は最後の行、選曲の一覧は最初のデータ行より
   * 前の行を読むので、全部を揃える)。value が null なら消す。無ければ、最初のデータ行より前のヘッダの最後に足す。
   * 行末のコメント(#WAV のラベルなど)は残す。
   * @param {string} cmd 例 'TITLE' / 'WAV0A'
   * @param {string|null} value
   * @returns {DtxDoc}
   */
  withHeader(cmd, value) {
    const up = cmd.toUpperCase();
    const hits = this.index.headers.filter((h) => h.cmd === up);
    if (value !== null) value = String(value).replace(/[\r\n;]/g, ' ').trim();
    const lines = this.lines.slice();
    if (hits.length) {
      const remove = new Set();
      for (const h of hits) {
        if (value === null) {
          remove.add(h.idx);
          continue;
        }
        const old = this.lines[h.idx];
        const lead = old.text.match(/^[ \t]*/)[0];
        const semi = old.text.indexOf(';');
        const comment = semi >= 0 ? old.text.slice(semi) : '';
        const text = lead + '#' + h.rawCmd + ': ' + value + (comment ? '\t' + comment : '');
        if (text !== old.text) lines[h.idx] = { text, bytes: null, eol: old.eol };
      }
      return this._with(fixEols(lines.filter((_, i) => !remove.has(i)), this.info.eol));
    }
    if (value === null) return this;
    return this.withInsertedHeaders(['#' + up + ': ' + value]);
  }

  /** ヘッダの行を、最初のデータ行より前のヘッダの最後(無ければ先頭)に足す。 */
  withInsertedHeaders(texts, afterCmdPrefix = null) {
    const { headers, firstObject } = this.index;
    const limit = firstObject < 0 ? Infinity : firstObject;
    let at = -1;
    for (const h of headers) {
      if (h.idx >= limit) break;
      if (afterCmdPrefix && !h.cmd.startsWith(afterCmdPrefix)) continue;
      at = h.idx;
    }
    if (at < 0 && afterCmdPrefix) return this.withInsertedHeaders(texts, null);
    const lines = this.lines.slice();
    const add = texts.map((text) => ({ text, bytes: null, eol: this.info.eol }));
    lines.splice(at + 1, 0, ...add);
    return this._with(fixEols(lines, this.info.eol));
  }

  /**
   * 小節を挿す / 消す。at 以降のデータ行(#IF の中も)の小節番号を delta ずらし、delta < 0 なら
   * [at, at - delta) の小節の行を消す。小節番号が範囲を出るなら RangeError。
   * @returns {DtxDoc}
   */
  withMeasureShift(at, delta) {
    const lines = [];
    for (const l of this.lines) {
      const c = classifyCached(l.text);
      if (c.kind !== 'object' || c.measure < at) {
        lines.push(l);
        continue;
      }
      if (delta < 0 && c.measure < at - delta) continue; // 消す小節
      const m = c.measure + delta;
      if (m < 0 || m > MAX_MEASURE) throw new RangeError('measure out of range: ' + m);
      const text = l.text.replace(/^([ \t]*#)[0-9]{3}/, (_, p) => p + pad3(m));
      lines.push({ text, bytes: null, eol: l.eol });
    }
    return this._with(fixEols(lines, this.info.eol));
  }
}

function push(map, k, arr) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(...arr);
}

/** 最終行以外に改行があるように直す(元の最終行の後ろに行を足したとき)。最終行の改行は ''。 */
function fixEols(lines, eol) {
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (i < n - 1 && !l.eol) lines[i] = { ...l, eol };
    else if (i === n - 1 && l.eol) lines[i] = { ...l, eol: '' };
  }
  return lines;
}

function dominantEol(lines) {
  const count = new Map();
  for (const l of lines) if (l.eol) count.set(l.eol, (count.get(l.eol) || 0) + 1);
  let best = '\r\n';
  let n = 0;
  for (const [k, v] of count) if (v > n) { best = k; n = v; }
  return best;
}

/** ヘッダのパラメータからコメントを除いたもの(stripComment の再公開。UI 用)。 */
export function headerValue(param) {
  return stripComment(param || '');
}
