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
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (isAscii(bytes)) return new TextDecoder('utf-8').decode(bytes);
  if (opts.preferUtf8) {
    const u = tryDecode('utf-8', bytes, true);
    if (u !== null) return u;
  }
  const sjis = tryDecode('shift_jis', bytes, false);
  const utf8 = tryDecode('utf-8', bytes, true);
  if (sjis === null && utf8 === null) return new TextDecoder('utf-8').decode(bytes);
  if (sjis === null) return utf8;
  if (utf8 === null) return sjis;
  // 両方成立: Shift-JIS の実文は厳密な UTF-8 としてまず通らない(0x81-0x9F の先頭バイトが不正)ので
  // UTF-8 を優先する。ただし UTF-8 側に制御文字が混じり Shift-JIS の方が自然なら Shift-JIS。
  const su = score(utf8);
  if (su >= 0 || su >= score(sjis)) return utf8;
  return sjis;
}

/** 行分割(CRLF / LF / CR 混在可)。 */
export function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}
