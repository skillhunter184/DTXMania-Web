// 同じフォルダにドラム用とギター / ベース用の譜面が別ファイル(set.def の別ブロックか、個別の .dtx)で置かれている曲を、
// 曲の一覧で 1 項目にまとめる(DTXManiaAI Song/SongInstrumentMerge.cs の移植。NX はブロック / ファイルごとに別項目のまま)。
//
// 典型例(GITADORA 系の配布形式の set.def):
//   #TITLE 曲名 (Drum)    #L1FILE dm_bsc.dtx …   ← #DLEVEL のみ
//   #TITLE 曲名 (Guitar)  #L1FILE gt_bsc.dtx …   ← #GLEVEL のみ
//   #TITLE 曲名 (Bass)    #L1FILE ba_bsc.dtx …   ← #BLEVEL のみ
//
// まとめる条件(すべて): 同じフォルダ / 楽器の内訳が重ならない / 楽器名の添え字を除いた題名が同じ(大小・空白の差は無視)
// か DTX の #TITLE 同士が同じ。最初に現れた曲が残り(題名は添え字を除いたもの)、吸収した曲の譜面をその後ろに足す。
// 譜面ごとに楽器が分かる(header.noteMask / levels)ので、一覧は楽器ごとの行に分けて出す(js/main.js)。

/** 楽器のビット(bit0 ドラム / bit1 ギター / bit2 ベース。js/core/dtx.js の noteMask と同じ)。 */
export const INSTRUMENT_BITS = { DRUMS: 1, GUITAR: 2, BASS: 4 };

/**
 * 譜面がその楽器の譜面を持つか(DTXManiaAI SongScore.HasChart: レベルの整数部か小数部が付いている、またはチップがある)。
 * @param {{levels?: number[], levelDecs?: number[], noteMask?: number}} header
 * @param {number} inst 0 ドラム / 1 ギター / 2 ベース
 */
export function chartHasInstrument(header, inst) {
  if (!header) return false;
  const lv = header.levels ? header.levels[inst] : 0;
  const dec = header.levelDecs ? header.levelDecs[inst] : 0;
  return lv > 0 || dec > 0 || !!((header.noteMask || 0) & (1 << inst));
}

/** 曲(譜面の組)の楽器の内訳。 */
export function instrumentMask(song) {
  let mask = 0;
  for (const c of song.charts || []) {
    for (let i = 0; i < 3; i++) if (chartHasInstrument(c.header, i)) mask |= 1 << i;
  }
  return mask;
}

// ---- 題名の添え字 ----

// 添え字として認める語(小文字化・空白と . - _ を除いたあとに完全一致)
const EXACT_TAGS = new Set([
  'drum', 'drums', 'dr', 'dm', 'drummania',
  'guitar', 'guitars', 'gt', 'gtr', 'guitarfreaks',
  'bass', 'bs', 'ba',
  'gf', 'df', 'gb', 'g&b', 'gt&bs', 'gt/bs', 'guitar&bass', 'guitar/bass', 'guitarbass',
  'ドラム', 'ドラムス', 'ギター', 'ベース', 'ギター&ベース', 'ギター/ベース', 'ギターベース',
]);
// 括弧の中なら 1 文字の略記や「〜 only」のような語も認める
const LOOSE_TAG_PARTS = ['drum', 'guitar', 'bass', 'ドラム', 'ギター', 'ベース'];
const BRACKET_ONLY_TAGS = new Set(['d', 'g', 'b']);
const BRACKET_OPEN = ['(', '[', '{', '<', '（', '［', '【', '〈', '《', '「', '『', '＜', '〔'];
const BRACKET_CLOSE = [')', ']', '}', '>', '）', '］', '】', '〉', '》', '」', '』', '＞', '〕'];
// 添え字と本体の区切り
const SEPARATORS = new Set([' ', '\t', '　', '-', '_', '/', '~', '～', ':', '：', '－', '・', '|', '｜']);

function trimEndSep(s) {
  let e = s.length;
  while (e > 0 && SEPARATORS.has(s[e - 1])) e--;
  return s.slice(0, e);
}

function trimStartSep(s) {
  let b = 0;
  while (b < s.length && SEPARATORS.has(s[b])) b++;
  return s.slice(b);
}

function isInstrumentTag(s, inBracket) {
  if (!s) return false;
  const k = s.toLowerCase().replace(/[\s　.\-_]/g, '');
  if (!k) return false;
  if (EXACT_TAGS.has(k)) return true;
  if (!inBracket) return false;
  if (BRACKET_ONLY_TAGS.has(k)) return true;
  return LOOSE_TAG_PARTS.some((p) => k.includes(p));
}

/** 末尾の括弧書き「曲名 (Drum)」。先頭から始まる括弧(本体が空)は対象外。 */
function stripTrailingBracket(t) {
  if (t.length < 3) return null;
  const ci = BRACKET_CLOSE.indexOf(t[t.length - 1]);
  if (ci < 0) return null;
  const open = t.lastIndexOf(BRACKET_OPEN[ci]);
  if (open <= 0) return null;
  if (!isInstrumentTag(t.slice(open + 1, t.length - 1), true)) return null;
  const rest = trimEndSep(t.slice(0, open));
  return rest.length ? rest : null;
}

/** 先頭の括弧書き「[Guitar] 曲名」。 */
function stripLeadingBracket(t) {
  if (t.length < 3) return null;
  const oi = BRACKET_OPEN.indexOf(t[0]);
  if (oi < 0) return null;
  const close = t.indexOf(BRACKET_CLOSE[oi]);
  if (close <= 0 || close === t.length - 1) return null;
  if (!isInstrumentTag(t.slice(1, close), true)) return null;
  const rest = trimStartSep(t.slice(close + 1));
  return rest.length ? rest : null;
}

/** 区切り文字 + 語の添え字「曲名 - Drums」「曲名 -GUITAR-」「曲名_bass」。 */
function stripTrailingToken(t) {
  const body = trimEndSep(t);
  let sep = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (SEPARATORS.has(body[i])) { sep = i; break; }
  }
  if (sep <= 0) return null;
  if (!isInstrumentTag(body.slice(sep + 1), false)) return null;
  const rest = trimEndSep(body.slice(0, sep));
  return rest.length ? rest : null;
}

/** 題名から楽器名の添え字を取り除く。大小・全角半角は保つ。取り除けなければ元の題名(前後の空白だけ除く)。 */
export function stripInstrumentTag(title) {
  if (!title) return title || '';
  let t = title.trim();
  for (;;) {
    const next = stripTrailingBracket(t) ?? stripLeadingBracket(t) ?? stripTrailingToken(t);
    if (next === null) break;
    t = next;
  }
  return t.length ? t : title.trim();
}

/** まとめるときの同一判定のキー(添え字を除き、小文字にして空白を 1 個にそろえる)。 */
export function normalizeTitle(title) {
  return stripInstrumentTag(title || '').toLowerCase().replace(/[\s　]+/g, ' ').trim();
}

/**
 * 曲の一覧のうち、楽器別に分かれた同じ曲を 1 つにまとめた新しい一覧を返す(元の曲オブジェクトは host だけ書き換える)。
 * @param {{title:string, dir:string, charts:{label:string, path:string, header:any}[]}[]} songs
 */
export function mergeInstrumentSongs(songs) {
  const hostsByKey = new Map(); // キー → host の曲の配列
  const hostMask = new Map(); // host → それまでに集めた楽器の内訳
  const merged = new Set(); // 1 度でも吸収した host
  const out = [];
  const addHost = (key, host) => {
    if (!hostsByKey.has(key)) hostsByKey.set(key, []);
    hostsByKey.get(key).push(host);
  };
  const findHost = (key, mask) => (hostsByKey.get(key) || []).find((h) => (hostMask.get(h) & mask) === 0) || null;

  for (const song of songs) {
    const mask = instrumentMask(song);
    if (!mask) {
      out.push(song); // 楽器が判らない譜面は触らない
      continue;
    }
    const folder = (song.dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const titleKey = folder + '\n' + normalizeTitle(song.title);
    const dtxTitle = song.charts.length ? song.charts[0].header.title || '' : '';
    const dtxKey = dtxTitle ? folder + '\ndtx:' + normalizeTitle(dtxTitle) : null;

    let host = findHost(titleKey, mask);
    let viaDtx = false;
    if (!host && dtxKey) {
      host = findHost(dtxKey, mask);
      viaDtx = !!host;
    }
    if (!host) {
      hostMask.set(song, mask);
      addHost(titleKey, song);
      if (dtxKey) addHost(dtxKey, song);
      out.push(song);
      continue;
    }
    // 初めて吸収するとき、題名から添え字を落とす。落とせなければ一致の根拠になった DTX の #TITLE を使う
    const stripped = stripInstrumentTag(host.title);
    if (!merged.has(host)) {
      if (stripped !== host.title) host.title = stripped;
      else if (viaDtx) host.title = dtxTitle;
      merged.add(host);
    } else if (host.title === stripped && viaDtx && host.title !== dtxTitle) {
      host.title = dtxTitle;
    }
    host.charts = host.charts.concat(song.charts);
    hostMask.set(host, hostMask.get(host) | mask);
  }
  return out;
}
