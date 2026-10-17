// 譜面の編集の「元に戻す / やり直す」。DtxDoc をそのまま積む(行は変更できない値なので、1 手は行の参照の配列 1 本ぶん)。
//
// DTXCreator は操作ごとの取り消しの記録(セル・トランザクション)を積み、選択も 1 手に数え、保存した時点を覚えない
// (docs/spec/dtxcreator-edit.md §7)。本アプリは(変更)文書の写しを積むので、取り消しの漏れ(§11 Q4〜Q9)が起きない。
// 選択は 1 手に数えず、手ごとに覚えて戻す。元の文書・書き出した文書と同じものに戻れば「変更なし」になる。

export class EditHistory {
  /**
   * @param {import('./dtxdoc.js').DtxDoc} originalDoc
   * @param {{maxSteps?: number, maxLineRefs?: number}} [opts] 古い手から捨てる(手の数・行の参照の合計)
   */
  constructor(originalDoc, opts = {}) {
    this.maxSteps = opts.maxSteps || 300;
    this.maxLineRefs = opts.maxLineRefs || 2000000;
    this.originalDoc = originalDoc;
    this.exportedDoc = null;
    this.reset(originalDoc);
  }

  /** 履歴を消して doc から始め直す。 */
  reset(doc) {
    /**
     * select = 手の後の選択(その手の文書での名前)、selectBefore = 手が触ったチップの、手の前の文書での名前
     * @type {{doc:any, label:string, select:string[], selectBefore:string[], focusU:number|null, coalesceKey:string|null, at:number}[]}
     */
    this.entries = [{ doc, label: '', select: [], selectBefore: [], focusU: null, coalesceKey: null, at: 0 }];
    this.index = 0;
    this._coalesceOpen = false;
  }

  get doc() {
    return this.entries[this.index].doc;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.entries.length - 1;
  }

  /** 次に戻す手の名前。 */
  get label() {
    return this.entries[this.index].label;
  }

  /** 元の文書から変わっているか(同じ文書に戻れば false)。 */
  get modified() {
    return this.doc !== this.originalDoc;
  }

  /** ファイルにしていない変更があるか(元の文書か、最後に書き出した文書なら false)。 */
  get unexported() {
    return this.doc !== this.originalDoc && this.doc !== this.exportedDoc;
  }

  markExported() {
    this.exportedDoc = this.doc;
  }

  /**
   * 1 手積む(やり直しの手は消える)。同じ文書なら積まない。coalesceKey が前の手と同じで 1 秒以内(closeCoalesce するまで)
   * なら前の手を置き換える(↑↓ の微調整の繰り返しを 1 手にまとめる)。
   * @returns {boolean} 積んだら true
   */
  push(doc, { label = '', select = [], selectBefore = [], focusU = null, coalesceKey = null, now = Date.now() } = {}) {
    if (doc === this.doc) return false;
    const top = this.entries[this.index];
    if (coalesceKey && this.index > 0 && top.coalesceKey === coalesceKey && this._coalesceOpen && now - top.at <= 1000) {
      this.entries[this.index] = { ...top, doc, select, focusU, at: now };
      this.entries.length = this.index + 1;
      if (doc === this.entries[this.index - 1].doc) {
        // 前の手に戻った(微調整で元の位置へ)
        this.entries.length = this.index;
        this.index--;
      }
      return true;
    }
    this.entries.length = this.index + 1;
    this.entries.push({ doc, label, select, selectBefore, focusU, coalesceKey, at: now });
    this.index++;
    this._coalesceOpen = !!coalesceKey;
    this._evict();
    return true;
  }

  /** まとめるのをやめる(次の手は同じ coalesceKey でも新しい手)。 */
  closeCoalesce() {
    this._coalesceOpen = false;
  }

  /** @returns {{doc, select:string[], focusU:number|null, label:string}|null} */
  undo() {
    if (!this.canUndo) return null;
    const undone = this.entries[this.index];
    this.index--;
    this._coalesceOpen = false;
    // 戻した手が触ったチップを選び直す(selectBefore は戻した後の文書での名前)
    return { doc: this.entries[this.index].doc, select: undone.selectBefore || [], focusU: undone.focusU, label: undone.label };
  }

  /** @returns {{doc, select:string[], focusU:number|null, label:string}|null} */
  redo() {
    if (!this.canRedo) return null;
    this.index++;
    this._coalesceOpen = false;
    const e = this.entries[this.index];
    return { doc: e.doc, select: e.select, focusU: e.focusU, label: e.label };
  }

  _evict() {
    let refs = 0;
    for (const e of this.entries) refs += e.doc.lines.length;
    while (this.entries.length > 1 && (this.entries.length > this.maxSteps + 1 || refs > this.maxLineRefs) && this.index > 0) {
      refs -= this.entries[0].doc.lines.length;
      this.entries.shift();
      this.index--;
    }
  }
}
