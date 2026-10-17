// テキストの文字コード判定とデコード。
// DTX / set.def / box.def は基本 Shift-JIS(cp932)だが、DTXCreator 031 以降は UTF-16 LE(BOM 付き)で
// 書き出すことがあり、手書きの UTF-8(BOM 有無)も存在する。ZIP 内のファイル名も同様に
// UTF-8 フラグ(bit 11)が無ければ Shift-JIS とみなすが、稀に UTF-8 のことがあるので推定する。

// ひらがな・カタカナ・漢字・全角記号/半角カナ・和文記号
const JP_RE = /[\u3040-\u30FF\u4E00-\u9FFF\uFF01-\uFF9F\u3000-\u303F]/g;
// 置換文字・制御文字・C1 制御文字(誤ったデコードで出やすい)
const BAD_RE = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0080-\u009F]/g;

function count(re, s) {
  const m = s.match(re);
  return m ? m.length : 0;
}

function tryDecode(label, bytes, fatal) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch (e) {
    return null;
  }
}

/** 日本語らしさのスコア(大きいほど自然)。 */
function score(s) {
  return count(JP_RE, s) - 4 * count(BAD_RE, s);
}

/** バイト列が ASCII のみか。 */
export function isAscii(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return false;
  return true;
}

/**
 * BOM があればそれに従い、無ければ Shift-JIS / UTF-8 を推定してデコードする。
 * @param {Uint8Array} bytes
 * @param {{preferUtf8?: boolean}} [opts] ZIP の UTF-8 フラグなど、UTF-8 が確定しているとき true
 * @returns {string}
 */
export function decodeText(bytes, opts = {}) {
  return decodeTextInfo(bytes, opts).text;
}

/**
 * decodeText と同じ判定で、どの文字コードと読んだかも返す(譜面の編集で、保存するときに同じ文字コードへ戻すため)。
 * encoding は 'utf-16le' / 'utf-16be' / 'utf-8'(bom が true なら BOM 付き)/ 'shift_jis'。ASCII だけのファイルは
 * 'ascii'(どの文字コードとしても同じなので、保存するときに日本語が入れば Shift-JIS にする)。
 * @param {Uint8Array} bytes
 * @param {{preferUtf8?: boolean}} [opts]
 * @returns {{text: string, encoding: string, bom: boolean}}
 */
export function decodeTextInfo(bytes, opts = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', bom: true };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', bom: true };
  }
  if (isAscii(bytes)) return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'ascii', bom: false };
  const utf8Info = (text) => ({ text, encoding: 'utf-8', bom: false });
  const sjisInfo = (text) => ({ text, encoding: 'shift_jis', bom: false });
  if (opts.preferUtf8) {
    const u = tryDecode('utf-8', bytes, true);
    if (u !== null) return utf8Info(u);
  }
  const sjis = tryDecode('shift_jis', bytes, false);
  const utf8 = tryDecode('utf-8', bytes, true);
  if (sjis === null && utf8 === null) return utf8Info(new TextDecoder('utf-8').decode(bytes));
  if (sjis === null) return utf8Info(utf8);
  if (utf8 === null) return sjisInfo(sjis);
  // 両方成立: Shift-JIS の実文は厳密な UTF-8 としてまず通らない(0x81-0x9F の先頭バイトが不正)ので
  // UTF-8 を優先する。ただし UTF-8 側に制御文字が混じり Shift-JIS の方が自然なら Shift-JIS。
  const su = score(utf8);
  if (su >= 0 || su >= score(sjis)) return utf8Info(utf8);
  return sjisInfo(sjis);
}

// ---- 書き出し(譜面の編集の保存) ----
// ブラウザの TextEncoder は UTF-8 しか書けないので、Shift-JIS(cp932)は TextDecoder の表を逆に引いて作る。
// 逆引きは WHATWG Encoding の Shift_JIS エンコーダと同じ: 同じ文字に複数の符号がある(NEC 選定 IBM 拡張と IBM 拡張)
// ときは、先頭バイト 0xED〜0xEF を飛ばして最初の符号を使う。

let _sjisTable = null;

// JIS X 0208 の対応表(macOS の IME など)で入る文字を cp932 の同じ符号へ寄せる(WHATWG の表は cp932 の側だけを持つ)。
// 読み直すと cp932 の側の文字(〜 → ～ など)になる
const SJIS_COMPAT = new Map([
  [0x301c, 0x8160], // 〜 WAVE DASH → ～
  [0x2016, 0x8161], // ‖ → ∥
  [0x2212, 0x817c], // − MINUS SIGN → －
  [0x00a2, 0x8191], // ¢ → ￠
  [0x00a3, 0x8192], // £ → ￡
  [0x00ac, 0x81ca], // ¬ → ￢
  [0x2014, 0x815c], // — EM DASH → ―
]);

function sjisTable() {
  if (_sjisTable) return _sjisTable;
  const table = new Map();
  const dec = new TextDecoder('shift_jis');
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    if (lead >= 0xed && lead <= 0xef) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead;
      pair[1] = trail;
      const s = dec.decode(pair);
      if (s.length !== 1 || s === '�') continue;
      const code = s.charCodeAt(0);
      if (!table.has(code)) table.set(code, (lead << 8) | trail);
    }
  }
  _sjisTable = table;
  return table;
}

/**
 * 文字列を Shift-JIS(cp932)にする。書けない文字があれば null(呼び出し側で UTF-8 などに替える)。
 * @param {string} text
 * @returns {Uint8Array|null}
 */
export function encodeShiftJis(text) {
  const table = sjisTable();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) out[n++] = c;
    else if (c === 0xa5) out[n++] = 0x5c; // WHATWG と同じ(円記号 → 0x5C、オーバーライン → 0x7E)
    else if (c === 0x203e) out[n++] = 0x7e;
    else if (c >= 0xff61 && c <= 0xff9f) out[n++] = c - 0xff61 + 0xa1; // 半角カナ
    else {
      const v = table.has(c) ? table.get(c) : SJIS_COMPAT.get(c);
      if (v === undefined) return null;
      out[n++] = v >> 8;
      out[n++] = v & 0xff;
    }
  }
  return out.slice(0, n);
}

/**
 * 文字列を指定の文字コードのバイト列にする(decodeTextInfo の encoding / bom)。Shift-JIS で書けない文字があれば
 * UTF-8(BOM 付き)に替える。
 * @param {string} text
 * @param {string} encoding
 * @param {boolean} [bom]
 * @returns {{bytes: Uint8Array, encoding: string, bom: boolean}}
 */
export function encodeText(text, encoding, bom = false) {
  if (encoding === 'shift_jis' || encoding === 'ascii') {
    const b = encodeShiftJis(text);
    if (b) return { bytes: b, encoding: isAscii(b) && encoding === 'ascii' ? 'ascii' : 'shift_jis', bom: false };
    encoding = 'utf-8';
    bom = true;
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const le = encoding === 'utf-16le';
    const head = bom ? 2 : 0;
    const out = new Uint8Array(head + text.length * 2);
    if (bom) { out[0] = le ? 0xff : 0xfe; out[1] = le ? 0xfe : 0xff; }
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[head + i * 2] = le ? c & 0xff : c >> 8;
      out[head + i * 2 + 1] = le ? c >> 8 : c & 0xff;
    }
    return { bytes: out, encoding, bom };
  }
  const body = new TextEncoder().encode(text);
  if (!bom) return { bytes: body, encoding: 'utf-8', bom: false };
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return { bytes: out, encoding: 'utf-8', bom: true };
}

/** 行分割(CRLF / LF / CR 混在可)。 */
export function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}
