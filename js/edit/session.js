// 譜面 1 つぶんの編集の状態(文書の履歴・ペン・列の種類・表示位置・選択)。編集画面を閉じても、曲パックを
// 開き直すまで App が持ち続ける(戻ってきたら元に戻すの履歴も続く。本アプリの追加)。

import { crc32 } from '../core/zip.js';
import { DtxDoc } from './dtxdoc.js';
import { EditModel } from './model.js';
import { EditHistory } from './history.js';
import { defaultPens, defaultActiveTypes } from './lanes.js';
import { gcBpmKeys } from './ops.js';

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class EditSession {
  /**
   * @param {{pkg, song, chartRef, originalBytes: Uint8Array, draft?: import('./drafts.js').Draft|null, rolls?: number[], isNew?: boolean}} o
   * isNew: 元の ZIP に無い(新しく作った)譜面
   */
  constructor(o) {
    this.pkg = o.pkg;
    this.song = o.song;
    this.chartRef = o.chartRef;
    this.path = o.chartRef.path;
    this.dir = dirOf(this.path);
    this.isNew = !!o.isNew;
    this.originalBytes = o.originalBytes;
    this.originalDoc = DtxDoc.fromBytes(o.originalBytes);
    this.history = new EditHistory(this.originalDoc);
    // #RANDOM の乱数: 演奏から来たときはその演奏の分岐、無ければ下書きのとき、無ければ分岐 1(下書きの [] は「無い」)
    this.rolls = (o.rolls && o.rolls.length ? o.rolls : (o.draft && o.draft.rolls) || []).slice();
    this._models = new WeakMap();
    this._out = null;
    const draft = o.draft || null;
    if (draft) this.history.push(DtxDoc.fromBytes(draft.bytes), { label: '' });
    const model = this.model;
    /** @type {Map<number, string>} チャンネル → 新しく置くチップの値 */
    this.pens = draft && Array.isArray(draft.pens) && draft.pens.length
      ? new Map(draft.pens)
      : defaultPens(model.valueCounts, model.wavList, model.usedIds);
    /** @type {number[]} 列ごとの今の種類(0 / 1) */
    this.activeTypes = draft && Array.isArray(draft.activeTypes) && draft.activeTypes.length === 9
      ? draft.activeTypes.slice()
      : defaultActiveTypes(model.channelCounts);
    /** @type {{uHead:number, zoom:number, guide:number, mode:string}|null} 編集画面が書く */
    this.view = (draft && draft.view) || null;
    /** @type {{beginPos:number, endPos:number, endAtEnd:boolean}|null} テストプレイのループ */
    this.loopPos = null;
    /** @type {Set<string>} 選択しているチップの名前 */
    this.selection = new Set();
    /** @type {{encoding:string, bom:boolean}|null} 保存の文字コード(null = 元のまま) */
    this.encodingChoice = null;
  }

  get doc() {
    return this.history.doc;
  }

  /** 今の文書のモデル(文書ごとに作り置く)。 */
  get model() {
    return this.modelOf(this.doc);
  }

  modelOf(doc) {
    let m = this._models.get(doc);
    if (!m) {
      m = new EditModel(doc, { rolls: this.rolls, path: this.path, dir: this.dir });
      this._models.set(doc, m);
    }
    return m;
  }

  get modified() {
    return this.history.modified;
  }

  get unexported() {
    return this.history.unexported;
  }

  /** 表示とテストプレイの分岐(演奏画面から入り直したとき)。 */
  setRolls(rolls) {
    this.rolls = (rolls || []).slice();
    this._models = new WeakMap();
  }

  /**
   * 操作の結果を 1 手として積む。選択は結果の select にする。
   * @param {{doc, select?: string[]}} result
   * @param {{label?: string, selectBefore?: string[], focusU?: number|null, coalesceKey?: string|null}} [opts]
   * @returns {boolean} 文書が変わったら true
   */
  apply(result, opts = {}) {
    const changed = this.history.push(result.doc, { label: opts.label || '', select: result.select || [], selectBefore: opts.selectBefore || [], focusU: opts.focusU ?? null, coalesceKey: opts.coalesceKey || null });
    if (changed || result.select) this.selection = new Set(result.select || []);
    return changed;
  }

  /** 書き出すバイト列(文書ごとに作り置く)。 */
  outputBytes() {
    const doc = this.doc;
    if (this._out && this._out.doc === doc && this._out.choice === this.encodingChoice) return this._out.result;
    const result = doc === this.originalDoc && !this.encodingChoice
      ? { ok: true, bytes: this.originalBytes, encoding: doc.info.encoding, bom: doc.info.bom, changedEncoding: false }
      : gcBpmKeys(doc, this.originalDoc).toBytes(this.encodingChoice || {});
    this._out = { doc, choice: this.encodingChoice, result };
    return result;
  }

  /** 書き出すバイト列が元の譜面と同じか。 */
  get sameAsOriginal() {
    return sameBytes(this.outputBytes().bytes, this.originalBytes);
  }

  /** 曲パックに重ねる(曲の一覧・テストプレイ・ZIP の書き出しが読む)。元と同じなら重ねたものを外す。 */
  async commit() {
    if (!this.isNew && this.sameAsOriginal) this.pkg.setOverride(this.path, null);
    else this.pkg.setOverride(this.path, this.outputBytes().bytes);
    await this.pkg.refreshHeader(this.path);
  }

  /** 下書きに書くもの。 */
  draftValue() {
    return {
      path: this.path,
      bytes: this.outputBytes().bytes,
      baseCrc: crc32(this.originalBytes),
      title: (this.song && this.song.title) || '',
      label: (this.chartRef && this.chartRef.label) || '',
      view: this.view,
      pens: [...this.pens],
      activeTypes: this.activeTypes.slice(),
      rolls: this.rolls.slice(),
    };
  }
}
