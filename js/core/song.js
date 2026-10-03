// ZIP から曲一覧を作り、譜面と音源ファイルを取り出す。
//
// ZIP 内の構成は DTXMania の曲フォルダそのまま:
//   曲フォルダ/set.def(#L1FILE..#L5FILE で難易度別 .dtx)、または .dtx 直置き
//   .dtx から参照する #WAVxx は曲フォルダ基準の相対パス(区切りは '\' が多い)
// ファイル名の大文字小文字・区切り文字・Unicode 正規化(macOS の NFD)の違いは吸収する。

import { ZipArchive, FileSetArchive } from './zip.js';
import { decodeText } from './encoding.js';
import { parseSetDef, parseBoxDef } from './setdef.js';
import { parseDTX, parseDTXHeader } from './dtx.js';
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
    this.songs = songs;
  }

  async _header(entry) {
    try {
      const h = parseDTXHeader(await this.readText(entry));
      return { title: h.title, artist: h.artist, comment: h.comment, bpm: h.bpm, level: h.level[0], levelDec: h.levelDec[0], preimage: h.preimage, preview: h.preview, laneHasNotes: h.laneHasNotes };
    } catch (e) {
      console.warn('DTX ヘッダの読み込みに失敗:', entry.name, e);
      return { title: '', artist: '', comment: '', bpm: 0, level: 0, levelDec: 0, preimage: '', preview: '', laneHasNotes: [] };
    }
  }

  /** 譜面を読み込んで解析する。 */
  async loadChart(path) {
    const ent = this.entry(path);
    if (!ent) throw new Error(t('zip.chartMissing', { path }));
    const chart = parseDTX(await this.readText(ent));
    chart.path = ent.name;
    chart.dir = dirOf(ent.name);
    return chart;
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
