// 設定の「キー割り当て」の 1 欄(js/main.js から切り出した。ドラムの 10 レーンとギター / ベースの 7 ボタンで同じ部品を使う)。
// 1 レーン = 1 行のチップ列。キー名を押すと差し替え、× で 1 個外す、＋ 追加で足す。
// タブ停止点は 1 行 1 個だけにして(ローミング tabindex)、行内は ←→、レーン間は ↑↓ で移動する。
// 割り当ての規則(重複させない・取り上げ・スワップ・空レーンは未割り当て)は js/ui/keybind.js。

import { keyLabel, eventCode } from './input.js';
import {
  MAX_KEYS_PER_LANE, addKey, replaceKey, removeKey, clearLane, resetLane, defaultBindings,
  isAssignableCode, isModifierCode, laneKeysText,
} from './keybind.js';
import { t } from '../i18n.js';

// 状態表示の文言は「今の言語で作り直す関数」で持ち、言語を切り替えたら作り直す(文字列も受け付ける)
const msg = (key, vars) => () => t(key, vars);
const textOf = (m) => (typeof m === 'function' ? m() : m || '');

export class KeyBindPanel {
  /**
   * @param {{
   *   list: HTMLElement, statusText: HTMLElement, undoButton: HTMLButtonElement, resetAllButton: HTMLButtonElement,
   *   names: string[], defaults: string[][],
   *   getBindings: () => string[][], setBindings: (next: string[][]) => void,
   *   onChange?: () => void, beforeAssign?: () => void,
   * }} opts
   *   names / defaults はレーン(ボタン)ごとの表示名と既定のキー。setBindings は保存まで行う。
   *   onChange は割り当てが変わったあと(操作方法の表示の更新など)、beforeAssign は待ち受けを始める前
   *   (ほかの欄の待ち受けや電子ドラムの「叩いて追加」を畳む)に呼ぶ。
   */
  constructor(opts) {
    this.list = opts.list;
    this.statusText = opts.statusText;
    this.undoButton = opts.undoButton;
    this.resetAllButton = opts.resetAllButton;
    this.names = opts.names;
    this.defaults = opts.defaults;
    this.getBindings = opts.getBindings;
    this.setBindings = opts.setBindings;
    this.onChange = opts.onChange || null;
    this.beforeAssign = opts.beforeAssign || null;
    this._assign = null; // キー割り当ての待ち受け {lane, mode, index, finish}
    this._undo = null; // 直前の bindings(1 段だけの「元に戻す」)
    this._undoLane = null; // その操作をしたレーン(undo 後にフォーカスを戻す先)
    this._pos = new Array(this.names.length).fill(0); // 行ごとのカーソル位置(ローミング tabindex)
    this._status = ''; // 状態表示(言語の切り替えで作り直す)
  }

  get laneCount() {
    return this.names.length;
  }

  /** 待ち受け中か。 */
  get assigning() {
    return !!this._assign;
  }

  /** 行を作ってハンドラを張る。repaired は起動時に直したレーン(知らせる)。 */
  build(repaired = []) {
    const list = this.list;
    list.textContent = '';
    for (let lane = 0; lane < this.laneCount; lane++) {
      const row = document.createElement('div');
      row.className = 'key-row';
      row.dataset.lane = String(lane);
      row.setAttribute('role', 'group');
      const name = document.createElement('span');
      name.className = 'key-lane';
      name.setAttribute('aria-hidden', 'true');
      name.textContent = this.names[lane];
      const chips = document.createElement('div');
      chips.className = 'chips';
      row.appendChild(name);
      row.appendChild(chips);
      list.appendChild(row);
    }
    // マウスで押したときもカーソル位置を合わせる(再描画後のフォーカス復帰に使う)
    list.addEventListener('focusin', (e) => {
      const row = e.target.closest ? e.target.closest('.key-row') : null;
      if (!row || !list.contains(row)) return;
      const lane = Number(row.dataset.lane);
      const i = this._items(lane).indexOf(e.target);
      if (i >= 0 && i !== this._pos[lane]) { this._pos[lane] = i; this._applyTabIndex(lane); }
    });
    list.addEventListener('keydown', (e) => this._onListKey(e));
    this.undoButton.onclick = () => this.undo();
    this.resetAllButton.onclick = () => {
      this.cancelAssign();
      const before = this._snapshot();
      this._commit(defaultBindings(this.defaults), msg('keys.resetAllDone'), before);
      this.renderAll();
      this.resetAllButton.focus({ preventScroll: true });
    };
    this.renderAll();
    const bad = repaired.map((l) => this.names[l]);
    this.setStatus(bad.length ? msg('keys.repaired', { lanes: bad.join(' / ') }) : '');
  }

  /** 今の言語で作り直す。 */
  relocalize() {
    this.renderAll();
    this.setStatus(this._status);
  }

  _snapshot() {
    return this.getBindings().map((a) => a.slice());
  }

  _row(lane) {
    return this.list.querySelector('.key-row[data-lane="' + lane + '"]');
  }

  /**
   * 行内のカーソル対象ボタン(DOM 順)。
   * 「中止」は待ち受け中だけ現れて消えるので対象から外す。含めると、中止を押した拍子に
   * カーソルが 1 つ手前(= レーンを空にする「解除」)へ滑ってしまう。
   */
  _items(lane) {
    const row = this._row(lane);
    return row ? Array.from(row.querySelectorAll('button:not(.chip-cancel)')) : [];
  }

  /** 行のタブ停止点をカーソル位置の 1 個だけにする。 */
  _applyTabIndex(lane) {
    const items = this._items(lane);
    if (!items.length) return;
    const pos = Math.max(0, Math.min(this._pos[lane], items.length - 1));
    this._pos[lane] = pos;
    items.forEach((b, i) => { b.tabIndex = i === pos ? 0 : -1; });
  }

  _focus(lane, pos) {
    const items = this._items(lane);
    if (!items.length) return;
    this._pos[lane] = Math.max(0, Math.min(pos, items.length - 1));
    this._applyTabIndex(lane);
    items[this._pos[lane]].focus({ preventScroll: true });
  }

  _focusEl(lane, el) {
    const i = el ? this._items(lane).indexOf(el) : -1;
    if (i >= 0) this._focus(lane, i);
  }

  /** 1 レーン分だけ描き直す(変化した行以外のフォーカスとハンドラを壊さない)。 */
  render(lane) {
    const row = this._row(lane);
    if (!row) return;
    const chips = row.querySelector('.chips');
    const hadFocus = row.contains(document.activeElement);
    const codes = this.getBindings()[lane]; // 毎回読み直す(差し替え前の配列を掴まない)
    const cap = this._assign && this._assign.lane === lane ? this._assign : null;
    const name = this.names[lane];
    row.setAttribute('aria-label', t('keys.rowLabel', { lane: name }));
    chips.textContent = '';

    codes.forEach((code, i) => {
      const capturing = !!cap && cap.mode === 'replace' && cap.index === i;
      const chip = document.createElement('span');
      chip.className = 'chip';
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'chip-key' + (capturing ? ' listening' : '');
      key.textContent = capturing ? '⌨' : keyLabel(code);
      key.setAttribute('aria-label', t(capturing ? 'keys.chipCapturing' : 'keys.chip', { lane: name, key: keyLabel(code) }));
      key.onclick = () => this.startAssign(lane, 'replace', i);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.textContent = '×';
      del.title = t('common.remove');
      del.setAttribute('aria-label', t('keys.removeLabel', { lane: name, key: keyLabel(code) }));
      del.onclick = () => this.removeAt(lane, i);
      chip.appendChild(key);
      chip.appendChild(del);
      chips.appendChild(chip);
    });
    if (!codes.length) {
      const none = document.createElement('span');
      none.className = 'chip-empty';
      none.textContent = t('common.none');
      chips.appendChild(none);
    }

    const adding = !!cap && cap.mode === 'add';
    const full = codes.length >= MAX_KEYS_PER_LANE;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip-add' + (adding ? ' listening' : '') + (full && !adding ? ' is-full' : '');
    add.textContent = t(adding ? 'keys.waiting' : 'keys.add');
    if (full && !adding) add.setAttribute('aria-disabled', 'true');
    add.setAttribute('aria-label', full
      ? t('keys.fullLabel', { lane: name, max: MAX_KEYS_PER_LANE })
      : t('keys.addLabel', { lane: name, n: codes.length, max: MAX_KEYS_PER_LANE }));
    add.onclick = () => this.startAssign(lane, 'add', -1);
    chips.appendChild(add);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'chip-lane-cmd';
    reset.textContent = t('common.default');
    reset.setAttribute('aria-label', t('assign.resetLabel', { lane: name, list: laneKeysText(this.defaults[lane]) }));
    reset.onclick = () => this.resetLane(lane);
    chips.appendChild(reset);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip-lane-cmd';
    clear.textContent = t('common.clear');
    clear.setAttribute('aria-label', t('keys.clearLabel', { lane: name }));
    clear.onclick = () => this.clearLane(lane);
    chips.appendChild(clear);

    if (cap) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chip-cancel';
      cancel.textContent = t('common.cancel');
      cancel.tabIndex = 0; // _items の対象外なので自前で持たせる
      cancel.onclick = () => this.cancelAssign(msg('common.canceled'));
      chips.appendChild(cancel);
    }

    if (hadFocus) this._focus(lane, this._pos[lane]);
    else this._applyTabIndex(lane);
  }

  renderAll() {
    for (let lane = 0; lane < this.laneCount; lane++) this.render(lane);
  }

  /** 他レーンから取り上げた / 入れ替えた行を 1 秒だけ光らせる(気付かれずに変わらないように)。 */
  _flash(lane) {
    const row = this._row(lane);
    if (!row) return;
    row.classList.remove('row-changed');
    void row.offsetWidth; // アニメーションを再start させる
    row.classList.add('row-changed');
    setTimeout(() => row.classList.remove('row-changed'), 1000);
  }

  /** 状態表示。text は文字列か、今の言語の文言を返す関数(msg)。 */
  setStatus(text) {
    this._status = text || '';
    this.statusText.textContent = textOf(text);
    // 「元に戻す」の有無はスナップショットの生死だけで決める。案内や中止のメッセージで消さない
    // (取り上げ / スワップに気付いて次の操作を始めた瞬間に復旧手段が消えてしまうため)。
    this.undoButton.hidden = !this._undo;
  }

  /** bindings を差し替えて保存する。before を渡すと「元に戻す」を出す。 */
  _commit(next, text, before, lane) {
    if (before) {
      this._undo = before;
      this._undoLane = lane === undefined ? null : lane;
    }
    this.setBindings(next);
    if (this.onChange) this.onChange();
    this.setStatus(text);
  }

  undo() {
    const prev = this._undo;
    if (!prev) return;
    const lane = this._undoLane;
    // 「元に戻す」自身が消えるので、フォーカスを body に落とさないよう先に逃がす
    const hadFocus = document.activeElement === this.undoButton;
    this.cancelAssign();
    this._undo = null;
    this._undoLane = null;
    this.setBindings(prev);
    if (this.onChange) this.onChange();
    this.renderAll();
    if (hadFocus) {
      if (lane !== null) this._focus(lane, this._pos[lane]);
      else this.resetAllButton.focus({ preventScroll: true });
    }
    this.setStatus(msg('common.undone'));
  }

  /** 欄内のキー操作(カーソル移動と Delete)。キャプチャ中はここまで来ない。 */
  _onListKey(e) {
    const row = e.target.closest ? e.target.closest('.key-row') : null;
    if (!row) return;
    const lane = Number(row.dataset.lane);
    const items = this._items(lane);
    const pos = items.indexOf(e.target);
    const code = eventCode(e);
    // Space はボタンの既定の活性化を殺す。BD の試し打ちで割り当てが暴発するのを防ぐ(実行は Enter)。
    if (code === 'Space') { e.preventDefault(); return; }
    if (code === 'ArrowLeft' || code === 'ArrowRight') {
      e.preventDefault();
      this._focus(lane, pos + (code === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (code === 'Home' || code === 'End') {
      e.preventDefault();
      this._focus(lane, code === 'Home' ? 0 : items.length - 1);
      return;
    }
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      e.preventDefault();
      const n = this.laneCount;
      const next = (lane + (code === 'ArrowUp' ? -1 : 1) + n) % n;
      this._focus(next, this._pos[next]);
      return;
    }
    if (code === 'Delete' || code === 'Backspace') {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      e.preventDefault();
      const index = Array.from(row.querySelectorAll('.chip')).indexOf(chip);
      if (index >= 0) this.removeAt(lane, index);
    }
  }

  /** キー割り当ての待ち受けを畳む(割り当ては行わない)。reason を渡すと状態表示も書き換える。 */
  cancelAssign(reason) {
    const a = this._assign;
    if (!a) return;
    this._assign = null;
    a.finish();
    if (reason) this.setStatus(reason);
  }

  /**
   * キー入力の待ち受けを始める。
   * @param {number} lane
   * @param {'add'|'replace'} mode
   * @param {number} index replace のときの位置
   */
  startAssign(lane, mode, index) {
    this.cancelAssign();
    if (this.beforeAssign) this.beforeAssign(); // ほかの欄・電子ドラムの「叩いて追加」と同時には待たない
    const name = this.names[lane];
    const codes = this.getBindings()[lane];
    if (mode === 'add' && codes.length >= MAX_KEYS_PER_LANE) {
      this.setStatus(msg('keys.fullHint', { lane: name, max: MAX_KEYS_PER_LANE }));
      return;
    }
    if (mode === 'replace' && codes[index] === undefined) return;

    const onKey = (e) => {
      const code = eventCode(e);
      if (isModifierCode(code)) return; // 修飾キー単体は押し途中なので無視
      e.preventDefault();
      e.stopPropagation(); // 待ち受け中はアプリのホットキーもブラウザの既定も通さない
      if (code === 'Escape') { this.cancelAssign(msg('common.canceled')); return; }
      if (!isAssignableCode(code)) {
        this.setStatus(msg('keys.reserved', { key: keyLabel(code) }));
        return; // 待ち受けは続ける
      }
      this._applyAssign(code);
    };
    const onOutside = (e) => { if (!this.list.contains(e.target)) this.cancelAssign(msg('common.canceled')); };
    const onVisibility = () => { if (document.hidden) this.cancelAssign(msg('common.canceled')); };
    // 安全網。無言で畳まず理由を出す(旧実装は 10 秒で無通知だった)。
    const timer = setTimeout(() => this.cancelAssign(msg('common.timeout')), 30000);
    const finish = () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onOutside, true); // pointerdown だとスクロール開始で誤爆する
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
      this.render(lane);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onOutside, true);
    document.addEventListener('visibilitychange', onVisibility);

    this._assign = { lane, mode, index, finish };
    this.render(lane);
    this.setStatus(mode === 'add'
      ? msg('keys.promptAdd', { lane: name })
      : msg('keys.promptReplace', { lane: name, key: keyLabel(codes[index]) }));
  }

  /** 待ち受け中に押されたキーを割り当てる。 */
  _applyAssign(code) {
    const a = this._assign;
    if (!a) return;
    const { lane, mode, index } = a;
    const name = this.names[lane];
    const bindings = this.getBindings();
    const before = this._snapshot();
    const old = mode === 'replace' ? bindings[lane][index] : null;
    const r = mode === 'add' ? addKey(bindings, lane, code) : replaceKey(bindings, lane, index, code);

    if (!r.ok) {
      if (r.reason === 'already') {
        this.setStatus(msg('keys.already', { key: keyLabel(code), lane: name }));
        return; // 待ち受け継続
      }
      if (r.reason === 'same') this.cancelAssign(msg('keys.same'));
      else if (r.reason === 'full') this.cancelAssign(msg('keys.full', { lane: name, max: MAX_KEYS_PER_LANE }));
      else this.cancelAssign(msg('keys.unassignable', { key: keyLabel(code) }));
      return;
    }

    const other = mode === 'add' ? r.stolenFrom : r.swappedWith;
    const names = this.names;
    const text = () => {
      let s;
      if (mode === 'add') {
        s = t('keys.added', { lane: name, key: keyLabel(code), n: r.bindings[lane].length, max: MAX_KEYS_PER_LANE });
        if (other !== null && other !== lane) {
          s += t('assign.movedFrom', { lanes: names[other] });
          if (r.stolenEmptied) s += t('assign.nowEmpty', { lanes: names[other] });
        }
      } else {
        s = t('keys.replaced', { lane: name, old: keyLabel(old), key: keyLabel(code) });
        if (other !== null && other !== lane) s += t('keys.swapped', { other: names[other], old: keyLabel(old) });
        else if (other === lane) s += t('keys.swappedInLane');
      }
      return s;
    };

    this._commit(r.bindings, text, before, lane);
    this.cancelAssign(); // finish() が lane を描き直す
    if (other !== null && other !== lane) { this.render(other); this._flash(other); }
    const row = this._row(lane);
    this._focusEl(lane, mode === 'add'
      ? row.querySelector('.chip-add') // 続けてもう 1 個足せるように
      : row.querySelectorAll('.chip-key')[index]);
  }

  removeAt(lane, index) {
    this.cancelAssign();
    const before = this._snapshot();
    const r = removeKey(this.getBindings(), lane, index);
    if (!r.ok) return;
    const name = this.names[lane];
    this._commit(r.bindings, r.emptied
      ? msg('keys.removedEmpty', { lane: name, key: keyLabel(r.removed) })
      : msg('keys.removed', { lane: name, key: keyLabel(r.removed), n: r.bindings[lane].length, max: MAX_KEYS_PER_LANE }), before, lane);
    this.render(lane);
    // 左隣のチップの「キー名」へ(そこなら Delete の連打がそのまま効く)。無ければ先頭 / ＋ 追加。
    // チップ 1 個 = キー名 + × の 2 ボタンなので、index 番目の左隣のキー名は (index - 1) * 2。
    if (index > 0) this._focus(lane, index * 2 - 2);
    else this._focusEl(lane, this._row(lane).querySelector(r.emptied ? '.chip-add' : '.chip-key'));
  }

  resetLane(lane) {
    this.cancelAssign();
    const before = this._snapshot();
    const r = resetLane(this.getBindings(), lane, this.defaults);
    const names = this.names;
    const name = names[lane];
    const stolen = r.stolenFrom.filter((l) => l !== lane);
    const emptied = r.stolenEmptied.filter((l) => l !== lane);
    const text = () => {
      let s = t('assign.resetDone', { lane: name, list: laneKeysText(r.bindings[lane]) });
      if (stolen.length) s += t('assign.takenFrom', { lanes: stolen.map((l) => names[l]).join(' / ') });
      if (emptied.length) s += t('assign.nowEmpty', { lanes: emptied.map((l) => names[l]).join(' / ') });
      return s;
    };
    this._commit(r.bindings, text, before, lane);
    this.render(lane);
    for (const l of stolen) { this.render(l); this._flash(l); }
    this._focusEl(lane, this._row(lane).querySelector('.chip-key'));
  }

  clearLane(lane) {
    this.cancelAssign();
    const before = this._snapshot();
    const r = clearLane(this.getBindings(), lane);
    this._commit(r.bindings, msg('keys.cleared', { lane: this.names[lane] }), before, lane);
    this.render(lane);
    this._focusEl(lane, this._row(lane).querySelector('.chip-add'));
  }
}
