// ZIP から曲一覧を作り、譜面と音源ファイルを取り出す。
//
// ZIP 内の構成は DTXMania の曲フォルダそのまま:
//   曲フォルダ/set.def(#L1FILE..#L5FILE で難易度別 .dtx)、または .dtx 直置き
//   .dtx から参照する #WAVxx は曲フォルダ基準の相対パス(区切りは '\' が多い)
// ファイル名の大文字小文字・区切り文字・Unicode 正規化(macOS の NFD)の違いは吸収する。

import { ZipArchive, FileSetArchive, ZipWriter, crc32 } from './zip.js';
import { decodeText } from './encoding.js';
import { parseSetDef, parseBoxDef } from './setdef.js';
import { parseDTX, parseDTXHeader } from './dtx.js';
import { mergeInstrumentSongs } from './instmerge.js';
import { t } from '../i18n.js';

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function baseName(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** 比較用のキー('\' → '/'、NFC 正規化、小文字)。 */
export function normKey(s) {
  return s.replace(/\\/g, '/').normalize('NFC').toLowerCase();
}

/** 相対パスを正規化する('\' → '/'、'./' 除去、'..' 解決)。 */
export function joinPath(dir, rel) {
  const parts = (dir + rel.replace(/\\/g, '/')).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

export class SongPackage {
  /** @param {ZipArchive|FileSetArchive} zip */
  constructor(zip, name = '') {
    this.zip = zip;
    this.name = name;
    /** @type {Map<string, import('./zip.js').ZipEntry>} 正規化パス → エントリ(同名は後勝ち) */
    this.index = new Map();
    for (const e of zip.entries) {
      if (e.isDir) continue;
      this.index.set(normKey(e.name), e);
    }
    /** @type {{title:string, dir:string, genre:string, charts:{label:string, path:string, header:any}[]}[]} */
    this.songs = [];
    this._blobUrls = [];
    this._imgCache = new Map();
    /** (追加) 譜面の編集で書き換えたファイル: 正規化パス → {bytes, entry, added}(added = 元の ZIP に無いファイル) */
    this._overrides = new Map();
  }

  /**
   * (追加) 編集した譜面をパッケージに重ねる(元の ZIP は書き換えない)。以後 readBytes / loadChart / 曲の一覧はこの中身を読む。
   * 元に無いパスなら新しいファイルとして足す。bytes が null なら重ねたものを外す。
   * @param {string} path
   * @param {Uint8Array|null} bytes
   */
  setOverride(path, bytes) {
    const key = normKey(path);
    const prev = this._overrides.get(key);
    if (bytes === null) {
      if (!prev) return;
      this._overrides.delete(key);
      if (prev.added) this.index.delete(key);
      return;
    }
    let entry = this.index.get(key);
    const added = prev ? prev.added : !entry;
    if (!entry) {
      entry = { name: path.replace(/\\/g, '/'), size: bytes.length, compressedSize: bytes.length, method: 0, crc: 0, localOffset: 0, isDir: false, utf8: true, flags: 0 };
      this.index.set(key, entry);
    }
    this._overrides.set(key, { bytes, entry, added });
  }

  /** 重ねたファイルの中身(無ければ null)。 */
  override(path) {
    const o = this._overrides.get(normKey(path));
    return o ? o.bytes : null;
  }

  /** 重ねたファイルがあるか。 */
  get hasOverrides() {
    return this._overrides.size > 0;
  }

  /** 曲の一覧を作り直す(重ねた譜面の題名・レベル・新しい譜面を一覧に出す)。 */
  async rescan() {
    await this._scan();
  }

  /**
   * (追加) 重ねたファイルを入れた ZIP を作る。元の ZIP のエントリは圧縮されたまま写し(順番・名前のバイト列も同じ)、
   * 書き換えた譜面は同じ名前で無圧縮で入れ、新しいファイルは末尾に足す。フォルダから読んだときはファイルを無圧縮で入れる。
   * @returns {Promise<Blob>}
   */
  async exportZip({ onlyDir = '' } = {}) {
    const w = new ZipWriter();
    const zip = this.zip;
    const seen = new Set();
    // onlyDir: その曲のフォルダ('/' で終わる)の中だけ(パスはそのまま。中の譜面の相対パスが崩れない)
    const prefix = normKey(onlyDir);
    // 書き出している間に編集画面が重ね直しても、始めたときの中身で書く(書き出した文書の印と食い違わないように)
    const overrides = new Map(this._overrides);
    const inside = (key) => !prefix || key.startsWith(prefix);
    for (const e of zip.entries) {
      const key = normKey(e.name);
      if (!inside(key)) continue;
      const o = overrides.get(key);
      if (o && !e.isDir) {
        // 正規化して同じ名前のエントリが 2 つあれば、重ねた中身を 1 つだけ入れる(読み込みは後勝ちなので古い方を残さない)
        if (!seen.has(key)) w.addFile(e.name, o.bytes, e.nameBytes ? { nameBytes: e.nameBytes, utf8: e.utf8 } : {});
        seen.add(key);
        continue;
      }
      if (zip instanceof ZipArchive) {
        await w.copyEntry(zip, e);
      } else if (!e.isDir) {
        const f = zip.fileOf(e);
        w.addBlob(e.name, f, crc32(await zip.read(e)), { date: f && f.lastModified ? new Date(f.lastModified) : undefined });
      }
    }
    for (const [key, o] of overrides) {
      if (!seen.has(key) && o.added && inside(key)) w.addFile(o.entry.name, o.bytes);
    }
    return w.finish();
  }

  /**
   * ZIP(File / Blob / ArrayBuffer)から作る。
   * @param {Blob|ArrayBuffer|Uint8Array} source
   * @param {string} [name]
   */
  static async fromZip(source, name = '') {
    const pkg = new SongPackage(await ZipArchive.open(source), name);
    await pkg._scan();
    return pkg;
  }

  /**
   * フォルダ選択(webkitdirectory)やドロップで得た File 群から作る。
   * @param {File[]} files
   * @param {string} [name]
   */
  static async fromFiles(files, name = '') {
    const list = [...files];
    let root = '';
    if (list.length && list[0].webkitRelativePath) root = list[0].webkitRelativePath.split('/')[0];
    const pkg = new SongPackage(new FileSetArchive(list, root), name || root);
    await pkg._scan();
    return pkg;
  }

  /** パス(大文字小文字・正規化無視)でエントリを引く。 */
  entry(path) {
    return this.index.get(normKey(path)) || null;
  }

  /**
   * 曲フォルダ基準の相対パスを解決する(見つからなければ null)。
   * 見つからないときは同じ曲フォルダ配下、次に ZIP 直下の同名ファイルだけを探す(他の曲のファイルは拾わない)。
   */
  resolve(dir, rel) {
    if (!rel) return null;
    const e = this.entry(joinPath(dir, rel));
    if (e) return e;
    const bn = normKey(baseName(rel.replace(/\\/g, '/')));
    const prefix = normKey(dir);
    let atRoot = null;
    for (const [key, ent] of this.index) {
      if (baseName(key) !== bn) continue;
      if (prefix && key.startsWith(prefix)) return ent;
      if (!key.includes('/') && !atRoot) atRoot = ent;
    }
    return atRoot;
  }

  async readBytes(pathOrEntry) {
    const e = typeof pathOrEntry === 'string' ? this.entry(pathOrEntry) : pathOrEntry;
    if (!e) throw new Error(t('zip.fileMissing', { path: pathOrEntry }));
    const o = this._overrides.get(normKey(e.name));
    if (o) return o.bytes.slice(); // 呼び出し側が手放す(decodeAudioData など)ことがあるので写しを渡す
    return this.zip.read(e);
  }

  async readText(pathOrEntry) {
    return decodeText(await this.readBytes(pathOrEntry));
  }

  /** 曲一覧を作る。set.def があればそれを優先し、無ければ .dtx を個別に並べる。 */
  async _scan() {
    const dirs = new Map(); // dir → { setdef, boxdef, dtx: [] }
    // index に載っている(= entry() で引ける)エントリだけを一覧の対象にする
    for (const e of this.index.values()) {
      const lower = normKey(e.name);
      const dir = dirOf(e.name);
      if (!dirs.has(dir)) dirs.set(dir, { setdef: null, boxdef: null, dtx: [] });
      const d = dirs.get(dir);
      const bn = baseName(lower);
      if (bn === 'set.def') d.setdef = e;
      else if (bn === 'box.def') d.boxdef = e;
      else if (lower.endsWith('.dtx')) d.dtx.push(e);
    }

    const songs = [];
    for (const [dir, d] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      let genre = '';
      if (d.boxdef) {
        try { genre = parseBoxDef(await this.readText(d.boxdef)).title; } catch (e) { /* ignore */ }
      }
      const used = new Set();
      if (d.setdef) {
        let blocks = [];
        try { blocks = parseSetDef(await this.readText(d.setdef)); } catch (e) { console.warn('set.def の解析に失敗:', dir, e); }
        for (const b of blocks) {
          const charts = [];
          for (let i = 0; i < 5; i++) {
            if (!b.files[i]) continue;
            // set.def の参照は曲フォルダ内の厳密一致のみ(無い難易度は落とす)
            const ent = this.entry(joinPath(dir, b.files[i]));
            if (!ent || !normKey(ent.name).endsWith('.dtx')) continue;
            used.add(normKey(ent.name));
            charts.push({ label: b.labels[i] || '', path: ent.name, header: await this._header(ent) });
          }
          if (charts.length > 0) {
            songs.push({ title: b.title || charts[0].header.title || baseName(dir.replace(/\/$/, '')), dir, genre: b.genre || genre, charts });
          }
        }
      }
      // set.def に載っていない .dtx は個別に
      for (const ent of d.dtx.sort((a, b) => a.name.localeCompare(b.name))) {
        if (used.has(normKey(ent.name))) continue;
        const header = await this._header(ent);
        songs.push({ title: header.title || baseName(ent.name), dir, genre, charts: [{ label: '', path: ent.name, header }] });
      }
    }
    // 楽器別のファイルに分かれた同じ曲(「曲名 (Drum)」「曲名 (Guitar)」「曲名 (Bass)」)は 1 項目にまとめる
    this.songs = mergeInstrumentSongs(songs);
  }

  /**
   * 一覧に出す DTX ヘッダ。level / levelDec はドラム、levels / levelDecs は楽器ごと(0 ドラム / 1 ギター / 2 ベース)、
   * noteMask は譜面に入っている楽器(bit0 ドラム / bit1 ギター / bit2 ベース)。
   */
  async _header(entry) {
    try {
      const h = parseDTXHeader(await this.readText(entry));
      return {
        title: h.title, artist: h.artist, comment: h.comment, bpm: h.bpm, level: h.level[0], levelDec: h.levelDec[0],
        levels: h.level.slice(), levelDecs: h.levelDec.slice(), noteMask: h.noteMask,
        preimage: h.preimage, preview: h.preview, laneHasNotes: h.laneHasNotes,
      };
    } catch (e) {
      console.warn('DTX ヘッダの読み込みに失敗:', entry.name, e);
      return {
        title: '', artist: '', comment: '', bpm: 0, level: 0, levelDec: 0, levels: [0, 0, 0], levelDecs: [0, 0, 0], noteMask: 0,
        preimage: '', preview: '', laneHasNotes: [],
      };
    }
  }

  /**
   * 譜面を読み込んで解析する。
   * @param {string} path
   * @param {{random?: () => number}} [opts] #RANDOM の乱数(譜面の編集のテストプレイで、編集していた分岐を流す)
   */
  async loadChart(path, opts = {}) {
    const ent = this.entry(path);
    if (!ent) throw new Error(t('zip.chartMissing', { path }));
    const chart = parseDTX(await this.readText(ent), opts);
    chart.path = ent.name;
    chart.dir = dirOf(ent.name);
    return chart;
  }

  /** 重ねる前の元のファイルの中身(元の ZIP に無い、重ねただけのファイルは null)。 */
  async readOriginalBytes(path) {
    const key = normKey(path);
    const o = this._overrides.get(key);
    if (o && o.added) return null;
    const e = this.index.get(key);
    return e ? this.zip.read(e) : null;
  }

  /** path の譜面の一覧の表示(題名・レベルなど)を読み直す(重ねた譜面を一覧に出す。曲のまとめ方は変えない)。 */
  async refreshHeader(path) {
    const key = normKey(path);
    const e = this.index.get(key);
    if (!e) return;
    let header = null;
    for (const song of this.songs) {
      for (const c of song.charts) {
        if (normKey(c.path) !== key) continue;
        if (!header) header = await this._header(e);
        c.header = header;
      }
    }
  }

  /** 画像ファイルの Blob URL(ジャケットなど)。同じファイルは 1 つの URL を使い回す。無ければ null。 */
  async imageUrl(dir, rel) {
    const ent = this.resolve(dir, rel);
    if (!ent) return null;
    const key = normKey(ent.name);
    if (this._imgCache.has(key)) return this._imgCache.get(key);
    const lower = key;
    const type = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.gif') ? 'image/gif' : lower.endsWith('.bmp') ? 'image/bmp' : 'image/jpeg';
    const url = URL.createObjectURL(new Blob([await this.zip.read(ent)], { type }));
    this._blobUrls.push(url);
    this._imgCache.set(key, url);
    return url;
  }

  dispose() {
    for (const u of this._blobUrls) URL.revokeObjectURL(u);
    this._blobUrls = [];
    this._imgCache.clear();
  }
}
