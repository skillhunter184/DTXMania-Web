// 譜面の編集画面の横のパネル(本アプリの追加)。DTXCreator の右側の一覧(WAV のリスト・譜面情報のタブ)を、タッチでも
// 使える形にまとめたもの。タブは チップ(選んだチップ・列ごとのペン)/ 小節(再生位置の小節)/ 譜面情報(#TITLE など)/
// 音源(#WAV)。広い窓(1100 CSS px 以上)では右に寄せ、それより狭い広い配置では右から重ね、狭い配置では下から出す。
// 中身は文書・選択・再生位置の小節・タブが変わったときだけ作り直す(入力欄に書いている間は作り直さない)。

import { t } from '../i18n.js';
import { levelText, posToMs } from '../core/dtx.js';
import { COLUMN_TYPES, COLUMN_COUNT, channelName, otherType, wavIdNumber } from './lanes.js';
import {
  INFO_FIELDS, opHeader, opSetWav, opSetValue, opShiftBgm, wavDefinitions, measureDeleteSummary,
} from './ops.js';
import { posOf } from './geometry.js';
import { barLengthLabel, formatBpmShort } from './view.js';
import { soundDialog, numberDialog } from './dialogs.js';
import { baseName } from './save.js';

const $ = (id) => document.getElementById(id);

/** 譜面情報の欄の名前の文言(i18n のテストが見つけられるようキーはそのまま書く)。 */
const FIELD_KEYS = {
  TITLE: 'edit.hTitle', ARTIST: 'edit.hArtist', COMMENT: 'edit.hComment', GENRE: 'edit.hGenre', BPM: 'edit.hBpm',
  DLEVEL: 'edit.hDlevel', PREVIEW: 'edit.hPreview', PREIMAGE: 'edit.hPreimage', STAGEFILE: 'edit.hStagefile', BACKGROUND: 'edit.hBackground',
};

const TABS = [['chips', 'edit.tabChips'], ['measure', 'edit.tabMeasure'], ['info', 'edit.tabInfo'], ['sounds', 'edit.tabSounds']];

/** パネルを右に寄せる窓の幅(CSS px)。 */
export const PANEL_DOCK_MIN = 1100;

function h(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'aria') for (const [a, av] of Object.entries(v)) e.setAttribute('aria-' + a, av);
    else e[k] = v;
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export class EditPanel {
  /** @param {import('./editor.js').EditorScreen} ed */
  constructor(ed) {
    this.ed = ed;
    this.root = $('edit-side');
    this.tab = TABS.some(([k]) => k === ed.config.editPanelTab) ? ed.config.editPanelTab : 'chips';
    this._sig = '';
    this._soundSel = null; // 音源のタブで選んだ番号
  }

  get open() {
    return !this.root.hidden;
  }

  /** 開く / 閉じる(開いているかは設定に覚える)。 */
  toggle(open = !this.open) {
    this.root.hidden = !open;
    this.ed.config.editPanelOpen = open;
    this.ed.app.saveConfig();
    this._sig = '';
    this.layout();
    if (open) this.refresh(true);
    const b = $('edit-panel');
    if (b) b.classList.toggle('on', open);
  }

  /** 寄せるか重ねるか(窓の幅と配置で決める)。 */
  layout() {
    const scr = this.ed.root;
    const dock = this.open && this.ed.view.layout === 'wide' && window.innerWidth >= PANEL_DOCK_MIN;
    scr.classList.toggle('panel-open', this.open);
    scr.classList.toggle('panel-dock', dock);
  }

  setTab(tab) {
    this.tab = tab;
    this.ed.config.editPanelTab = tab;
    this.ed.app.saveConfig();
    this._sig = '';
    this.refresh(true);
  }

  /** 中身を作り直す(変わったときだけ。force で必ず)。 */
  refresh(force = false) {
    if (!this.open) return;
    const ed = this.ed;
    const m = ed.model;
    const sig = [this.tab, m.doc === this._doc, ed._selKeys().join(','), this.tab === 'measure' ? this._headMeasure() : '',
      this.tab === 'sounds' ? this._soundSel : '', ed.session.encodingChoice ? ed.session.encodingChoice.encoding : '',
      // チップのタブのペンの一覧は、列の種類・ペン(列名の帯・ペンのメニューで変わる)も見る
      this.tab === 'chips' ? ed.session.activeTypes.join() + ';' + [...ed.session.pens].join() : ''].join('|');
    if (!force && sig === this._sig && m.doc === this._doc) return;
    // 入力欄に書いている間は作り直さない(書いている文字が消えないように)。書き終えたら作り直す
    const act = document.activeElement;
    if (!force && act && this.root.contains(act) && (act.tagName === 'INPUT' || act.tagName === 'SELECT' || act.tagName === 'TEXTAREA')) return;
    this._sig = sig;
    this._doc = m.doc;
    const body = this.root.querySelector('.side-body');
    const scroll = body ? body.scrollTop : 0;
    this.root.innerHTML = '';
    const tabs = h('div', { class: 'side-tabs', role: 'tablist' });
    for (const [k, label] of TABS) {
      tabs.append(h('button', {
        type: 'button', textContent: t(label), role: 'tab', aria: { selected: String(this.tab === k) },
        onclick: (e) => { e.currentTarget.blur(); this.setTab(k); },
      }));
    }
    tabs.append(h('button', { type: 'button', class: 'side-close', textContent: '×', title: t('edit.close'), onclick: () => { this.toggle(false); ed.canvas.focus({ preventScroll: true }); } }));
    const content = h('div', { class: 'side-body' });
    if (this.tab === 'chips') this._chips(content);
    else if (this.tab === 'measure') this._measure(content);
    else if (this.tab === 'info') this._info(content);
    else this._sounds(content);
    this.root.append(tabs, content);
    content.scrollTop = scroll;
  }

  /** パネルのボタンを押したあと、キーが譜面に届くようにする。 */
  _done(e) {
    if (e && e.currentTarget && e.currentTarget.blur) e.currentTarget.blur();
    this.ed.canvas.focus({ preventScroll: true });
  }

  _btn(label, run, { danger = false, disabled = false } = {}) {
    return h('button', {
      type: 'button', class: 'btn small' + (danger ? ' danger' : ' secondary'), textContent: label, disabled,
      onclick: (e) => { this._done(e); run(); },
    });
  }

  /** 音源の番号の選択肢(使っている数の多い順、続けて #WAV の順)。 */
  _wavOptions(sel, current, counts) {
    const m = this.ed.model;
    const ids = [...(counts ? counts.entries() : [])].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    for (const w of m.wavList) if (!ids.includes(w.id)) ids.push(w.id);
    if (current && !ids.includes(current)) ids.unshift(current);
    for (const id of ids) {
      const file = m.wavFile(id);
      sel.append(h('option', { value: id, textContent: `${id}  ${file ? baseName(file.replace(/\\/g, '/')) : '?'}`, selected: id === current }));
    }
    return sel;
  }

  // ---- チップ ----

  _chips(c) {
    const ed = this.ed;
    const m = ed.model;
    const keys = ed._selKeys();
    const chips = keys.map((k) => m.chip(k)).filter(Boolean);
    const bpms = keys.map((k) => m.bpmMark(k)).filter(Boolean);
    if (!keys.length) {
      c.append(h('p', { class: 'note', textContent: t('edit.noSelection') }));
    } else {
      c.append(h('p', { class: 'side-head', textContent: t('edit.selCount', { n: keys.length }) }));
      if (chips.length) {
        const chans = [...new Set(chips.map((x) => x.channel))];
        const values = [...new Set(chips.map((x) => x.value))];
        const rows = h('dl', { class: 'side-dl' });
        rows.append(h('dt', { textContent: t('edit.selType') }), h('dd', {}, [chans.map(channelName).join(' / ')]));
        // 音(全部同じならその値。違えば「—」から選ぶと全部その音)
        const sel = h('select', { aria: { label: t('edit.selSound') } });
        if (values.length > 1) sel.append(h('option', { value: '', textContent: '—', selected: true }));
        const counts = new Map();
        for (const ch of chans) for (const [v, n] of m.valueCounts.get(ch) || []) counts.set(v, (counts.get(v) || 0) + n);
        this._wavOptions(sel, values.length === 1 ? values[0] : '', counts);
        sel.onchange = () => {
          const v = sel.value;
          sel.blur();
          if (!v) return;
          ed._commit(() => opSetValue(ed.model, chips.map((x) => x.key), v), { label: 'edit.opSound', keepSel: true, focusU: chips[0].u });
          ed._previewSound(chips[0].channel, v);
        };
        rows.append(h('dt', { textContent: t('edit.selSound') }), h('dd', {}, [sel]));
        if (chips.length === 1) {
          const ch = chips[0];
          const { beat } = m.beatOf(ch.measure, ch.tick);
          rows.append(h('dt', { textContent: t('edit.selPos') }), h('dd', { textContent: t('edit.posBeat', { m: String(ch.measure).padStart(3, '0'), b: beat, t: ch.tick }) }));
        }
        c.append(rows);
        const row = h('div', { class: 'side-row' });
        if (chips.some((x) => otherType(x.channel) !== null)) row.append(this._btn(t('edit.typeFlip'), () => ed._setTypes(chips.map((x) => x.key), false, true)));
        if (chips.length === 1) row.append(this._btn(t('edit.selectSameSound'), () => ed.selectSameSound(chips[0].key)));
        c.append(row);
      }
      if (bpms.length === 1) {
        const b = bpms[0];
        c.append(h('div', { class: 'side-row' }, [h('span', { textContent: 'BPM ' + (b.bpm === null ? '?' : formatBpmShort(b.bpm)) }), this._btn(t('edit.bpmTitle') + '…', () => ed.editBpm(b))]));
      }
      c.append(h('div', { class: 'side-row' }, [
        this._btn(t('edit.copy'), () => ed.copy()),
        this._btn(t('edit.cut'), () => ed.cut()),
        this._btn(t('edit.duplicate'), () => ed.duplicate()),
        this._btn(t('edit.delete'), () => ed.deleteSelection(), { danger: true }),
      ]));
    }
    // 列ごとのペン(新しく置くチップの音。DTXCreator のレーンに割り当てたチップ)
    c.append(h('h4', { textContent: t('edit.pens') }));
    const pens = h('dl', { class: 'side-dl pens' });
    for (let col = 0; col < COLUMN_COUNT; col++) {
      for (const ch of COLUMN_TYPES[col]) {
        if (COLUMN_TYPES[col].length > 1 && ch !== COLUMN_TYPES[col][ed.session.activeTypes[col] || 0] && !(m.valueCounts.get(ch) || new Map()).size) continue;
        const sel = h('select', { aria: { label: channelName(ch) } });
        this._wavOptions(sel, ed.session.pens.get(ch) || '', m.valueCounts.get(ch));
        sel.onchange = () => {
          ed.session.pens.set(ch, sel.value);
          ed._previewSound(ch, sel.value);
          ed._scheduleDraft();
          ed._render();
          sel.blur();
        };
        pens.append(h('dt', { textContent: channelName(ch) }), h('dd', {}, [sel]));
      }
    }
    c.append(pens);
  }

  // ---- 小節 ----

  /** パネルが見る小節(再生位置の小節。リードインは 000)。 */
  _headMeasure() {
    const geo = this.ed.model.geometry;
    return Math.max(0, geo.measureAt(Math.max(0, this.ed.view.uHead + 1e-9)));
  }

  _measure(c) {
    const ed = this.ed;
    const m = ed.model;
    const geo = m.geometry;
    const measure = this._headMeasure();
    const L = geo.len(measure);
    const head = geo.start(measure);
    const pos = posOf(measure, 0);
    const sum = measureDeleteSummary(m, measure);
    c.append(h('p', { class: 'side-head' }, [t('edit.measureHead', { m: String(measure).padStart(3, '0') }) + '  ',
      this._btn('◀', () => ed._moveHead(geo.start(Math.max(0, measure - 1)))),
      this._btn('▶', () => ed._moveHead(geo.start(Math.min(m.endMeasure, measure + 1))))]));
    const rows = h('dl', { class: 'side-dl' });
    rows.append(h('dt', { textContent: t('edit.measureLen') }), h('dd', {}, [`${barLengthLabel(L) || '4/4'} (×${Math.round(L * 1e6) / 1e6})  `, this._btn(t('edit.barLength'), () => ed.barLength(measure))]));
    rows.append(h('dt', { textContent: t('edit.measureBpm') }), h('dd', {}, [`${formatBpmShort(m.bpmAtPos(pos))}  `, this._btn(t('edit.bpmHere'), () => ed._bpmAtCell(head))]));
    rows.append(h('dt', { textContent: t('edit.measureTime') }), h('dd', { textContent: msText(posToMs(m.chart, pos)) }));
    rows.append(h('dt', { textContent: t('edit.measureChips') }), h('dd', { textContent: t('edit.measureCount', { d: sum.drums, b: sum.bgm }) }));
    c.append(rows);
    c.append(h('div', { class: 'side-row' }, [
      this._btn(t('edit.selectMeasure', { m: String(measure).padStart(3, '0') }), () => ed.selectMeasure(measure)),
      this._btn(t('edit.loopMeasure'), () => ed.loopMeasures(measure, measure)),
    ]));
    c.append(h('div', { class: 'side-row' }, [
      this._btn(t('edit.insertMeasure'), () => ed.insertMeasure(measure)),
      this._btn(t('edit.deleteMeasure'), () => ed.deleteMeasure(measure), { danger: true }),
    ]));
  }

  // ---- 譜面情報 ----

  _info(c) {
    const ed = this.ed;
    const m = ed.model;
    const form = h('div', { class: 'side-form' });
    for (const cmd of INFO_FIELDS) {
      const cur = m.doc.header(cmd);
      const id = 'edit-h-' + cmd.toLowerCase();
      const input = h('input', { id, type: 'text', value: cur === null ? '' : cur.trim(), inputMode: cmd === 'BPM' ? 'decimal' : cmd === 'DLEVEL' ? 'numeric' : 'text', spellcheck: false });
      // 書き終えた(Enter・欄の外)ときに 1 手(DTXCreator は欄を離れたとき)
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return; // 日本語の変換中の Enter / Esc は変換のもの
        if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); input.blur(); }
        if (e.code === 'Escape') {
          // 今の文書の値に戻す(描いたときの値ではなく。描いたあとに元に戻す・やり直すをしていても)
          e.preventDefault();
          const now = ed.model.doc.header(cmd);
          input.value = now === null ? '' : now.trim();
          input.blur();
        }
      });
      input.addEventListener('change', () => {
        const r = ed._commit(() => opHeader(ed.model, cmd, input.value), { label: 'edit.opHeader', keepSel: true, selectBefore: ed._selKeys() });
        if (!r) input.value = (ed.model.doc.header(cmd) || '').trim();
        this._sig = '';
      });
      const field = h('label', { class: 'side-field', htmlFor: id }, [h('span', { textContent: t(FIELD_KEYS[cmd]) + ` (#${cmd})` }), input]);
      if (cmd === 'DLEVEL') {
        const lv = m.chart.level[0];
        field.append(h('span', { class: 'note', textContent: t('edit.levelShown', { lv: lv ? levelText(lv, m.chart.levelDec[0]) : '—' }) }));
      }
      form.append(field);
    }
    c.append(form);
    const info = m.doc.info;
    const enc = ed.session.encodingChoice ? ed.session.encodingChoice.encoding : info.encoding;
    c.append(h('p', { class: 'note', textContent: t('edit.encodingNow', { enc: encName(enc, ed.session.encodingChoice ? ed.session.encodingChoice.bom : info.bom) }) }));
    if (m.otherChips) c.append(h('p', { class: 'note', textContent: t('edit.otherChips', { n: m.otherChips }) }));
  }

  // ---- 音源 ----

  _sounds(c) {
    const ed = this.ed;
    const m = ed.model;
    const defs = wavDefinitions(m.doc);
    const uses = m.wavUses;
    const ids = new Set([...defs.keys()].filter((id) => defs.get(id).file));
    for (const id of uses.keys()) ids.add(id);
    const list = [...ids].sort((a, b) => wavIdNumber(a) - wavIdNumber(b));
    c.append(h('div', { class: 'side-row' }, [
      this._btn(t('edit.wavAdd'), () => this._addSound()),
      this._btn(t('edit.bgmShift'), () => this._shiftBgm()),
    ]));
    const table = h('table', { class: 'side-wavs' });
    table.append(h('tr', {}, [t('edit.wavId'), t('edit.wavFile'), t('edit.wavVolume'), t('edit.wavPan'), t('edit.wavUses')].map((s) => h('th', { textContent: s }))));
    for (const id of list) {
      const d = defs.get(id);
      const file = d ? d.file : '';
      const tr = h('tr', { class: id === this._soundSel ? 'sel' : '', tabIndex: 0, onclick: () => { this._soundSel = id; this.refresh(true); } });
      tr.append(
        h('td', { textContent: id + (d && d.bgm ? ' ♪' : '') }),
        h('td', { textContent: file ? baseName(file.replace(/\\/g, '/')) + (d.label ? '  ;' + d.label : '') : t('edit.wavUndefined'), title: file, class: file ? '' : 'warn' }),
        h('td', { textContent: d && d.volume !== null ? String(d.volume) : '' }),
        h('td', { textContent: d && d.pan !== null ? String(d.pan) : '' }),
        h('td', { textContent: String(uses.get(id) || 0) }),
      );
      table.append(tr);
    }
    c.append(table);
    const id = this._soundSel && list.includes(this._soundSel) ? this._soundSel : null;
    if (id) {
      const d = defs.get(id);
      const row = h('div', { class: 'side-row' }, [
        h('strong', { textContent: id }),
        this._btn(t('edit.wavPreview'), () => ed.previewWav(id)),
        this._btn(t('edit.wavUsePen'), () => this._usePen(id)),
        this._btn(t('edit.soundProps'), () => this._editSound(id), { disabled: !!(d && d.redefined) }),
        this._btn(t('edit.selectSameSound'), () => ed.selectByValue(id)),
      ]);
      c.append(row);
      if (d && d.redefined) c.append(h('p', { class: 'note warn', textContent: t('edit.wavRedefined') }));
    } else c.append(h('p', { class: 'note', textContent: t('edit.wavPick') }));
  }

  /** 音源の番号を、選んだ列(今の種類)のペンにする。 */
  _usePen(id) {
    const ed = this.ed;
    const items = [];
    for (let col = 0; col < COLUMN_COUNT; col++) {
      const ch = COLUMN_TYPES[col][ed.session.activeTypes[col] || 0];
      items.push({ label: channelName(ch), checked: ed.session.pens.get(ch) === id, run: () => { ed.session.pens.set(ch, id); ed._scheduleDraft(); ed._render(); this.refresh(true); } });
    }
    const r = this.root.getBoundingClientRect();
    ed._popover([{ label: t('edit.wavUsePen'), heading: true }, ...items], r.left + r.width / 2, r.top + 80);
  }

  async _editSound(id) {
    const ed = this.ed;
    const d = wavDefinitions(ed.model.doc).get(id) || { file: '', label: '', volume: null, pan: null, bgm: false };
    const r = await soundDialog($('edit-dialog'), { id, file: d.file, label: d.label, volume: d.volume === null ? 100 : d.volume, pan: d.pan === null ? 0 : d.pan, bgm: d.bgm });
    ed.canvas.focus({ preventScroll: true });
    if (r.action !== 'ok' || ed._closed) return;
    ed._commit(() => opSetWav(ed.model, id, { file: r.file, label: r.label, volume: r.volume, pan: r.pan, bgm: r.bgm }), { label: 'edit.opWav', keepSel: true, selectBefore: ed._selKeys() });
    this.refresh(true);
  }

  /** 音源を足す(ファイルを選んで曲のフォルダに入れ、空いている番号に #WAV を書く)。 */
  _addSound() {
    const input = h('input', { type: 'file', accept: 'audio/*,.wav,.ogg,.mp3,.xa,.flac,.m4a' });
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (f) await this.ed.importSound(f);
      this.refresh(true);
    };
    input.click();
  }

  async _shiftBgm() {
    const ed = this.ed;
    const r = await numberDialog($('edit-dialog'), { title: t('edit.bgmShift'), prompt: t('edit.bgmShiftPrompt'), value: 0, min: -60000, max: 60000, integer: true });
    ed.canvas.focus({ preventScroll: true });
    if (r.action !== 'ok' || !r.value || ed._closed) return;
    ed._commit(() => opShiftBgm(ed.model, r.value), { label: 'edit.bgmShift', keepSel: true, selectBefore: ed._selKeys() });
  }
}

function msText(ms) {
  const v = Math.max(0, ms) / 1000;
  const mm = Math.floor(v / 60);
  return `${mm}:${(v - mm * 60).toFixed(3).padStart(6, '0')}`;
}

function encName(enc, bom) {
  const n = enc === 'shift_jis' || enc === 'ascii' ? 'Shift-JIS' : enc.toUpperCase();
  return n + (bom ? ' (BOM)' : '');
}

