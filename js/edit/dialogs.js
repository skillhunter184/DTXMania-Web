// 譜面の編集画面のダイアログ(<dialog>。Enter = 決定、Esc = 取り消し。Space は BD なので決定に使わない)。

import { t } from '../i18n.js';

/**
 * ダイアログを開き、閉じ方(ボタン・Enter・Esc・外を押す)ごとの value で終わる。
 * close イベントは待たない(Chromium は描画のときに届けるので、隠れたタブでは届かない)。送信・取り消しで直接終える。
 * @param {HTMLDialogElement} dlg
 * @param {HTMLFormElement} form method="dialog" のフォーム(dlg の中)
 * @param {{cancelValue?: string, check?: (value: string) => boolean, focus?: HTMLElement}} o
 *   check: 押したボタンの value で閉じてよいか(false なら開いたまま。入力の確かめ)
 * @returns {Promise<string>}
 */
function runDialog(dlg, form, { cancelValue = 'cancel', check = null, focus = null } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('keydown', noSpace, true);
      dlg.removeEventListener('keyup', noSpace, true);
      dlg.onclick = null;
      dlg.onpointerdown = null;
      if (dlg.open) dlg.close(v);
      resolve(v);
    };
    const onClose = () => finish(dlg.returnValue || cancelValue); // ほかから閉じられた
    const onCancel = (e) => {
      e.preventDefault();
      finish(cancelValue); // Esc
    };
    // Space(BD のキー)で選んでいるボタンを押させない(CLAUDE.md)
    const noSpace = (e) => {
      if (e.code === 'Space' && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (e.submitter && e.submitter.value) || 'ok'; // Enter は最初のボタン(決定)
      if (check && !check(v)) return;
      finish(v);
    });
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('keydown', noSpace, true);
    dlg.addEventListener('keyup', noSpace, true);
    // 外(背景)を押したら取り消し(ダイアログの余白を押しても閉じないよう、位置で見る)。押し始めも外のときだけ
    // (タップで開いたとき、そのタップのあとから来る click が背景に当たって閉じないように)
    const outside = (e) => {
      const r = dlg.getBoundingClientRect();
      return e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    };
    let pressOut = false;
    dlg.onpointerdown = (e) => { pressOut = outside(e); };
    dlg.onclick = (e) => {
      if (pressOut && outside(e)) finish(cancelValue);
      pressOut = false;
    };
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    const f = focus || form.querySelector('button');
    if (f) {
      f.focus();
      if (f.select) f.select();
    }
  });
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

/**
 * ボタンを並べたダイアログ。押したボタンの value を返す(Esc・外を押したら cancelValue)。
 * @param {HTMLDialogElement} dlg
 * @param {{title?: string, message: string, extra?: string, buttons: {label: string, value: string, primary?: boolean, danger?: boolean}[], cancelValue?: string}} o
 * @returns {Promise<string>}
 */
export function choiceDialog(dlg, o) {
  dlg.innerHTML = '';
  const form = el('form', { method: 'dialog' });
  if (o.title) form.append(el('h3', { textContent: o.title }));
  form.append(el('p', { textContent: o.message }));
  if (o.extra) form.append(el('p', { className: 'note warn', textContent: o.extra }));
  const row = el('div', { className: 'btn-row' });
  let primary = null;
  for (const b of o.buttons) {
    const btn = el('button', { type: 'submit', value: b.value, textContent: b.label, className: 'btn small' + (b.primary ? '' : ' secondary') + (b.danger ? ' danger' : '') });
    row.append(btn);
    if (b.primary) primary = btn;
  }
  form.append(row);
  dlg.append(form);
  return runDialog(dlg, form, { cancelValue: o.cancelValue ?? 'cancel', focus: primary });
}

/** はい / いいえ。 */
export async function confirmDialog(dlg, message, { ok = t('edit.ok'), cancel = t('edit.cancel'), danger = false, extra = '' } = {}) {
  const v = await choiceDialog(dlg, {
    message, extra,
    buttons: [{ label: ok, value: 'ok', primary: true, danger }, { label: cancel, value: 'cancel' }],
  });
  return v === 'ok';
}

/**
 * 下書きの続きを開くか。'resume' / 'original'(下書きを消して元の譜面)/ 'cancel'。
 * @param {{savedAt:number}} draft
 * @param {boolean} baseChanged 元の譜面が下書きを作ったときと変わっている
 */
export function resumeDialog(dlg, draft, baseChanged) {
  const date = new Date(draft.savedAt || Date.now()).toLocaleString();
  return choiceDialog(dlg, {
    message: t('edit.draftFound', { date }),
    extra: baseChanged ? t('edit.draftBaseChanged') : '',
    buttons: [
      { label: t('edit.draftResume'), value: 'resume', primary: true },
      { label: t('edit.draftOriginal'), value: 'original' },
    ],
    cancelValue: 'resume', // 閉じただけなら続きを開く(下書きは消さない)
  });
}

/** 数を読む('.' と ','。読めなければ NaN)。 */
function readNumber(s) {
  const v = String(s).trim().replace(',', '.');
  return v === '' ? NaN : Number(v);
}

/**
 * BPM のダイアログ(DTXCreator の「数値入力」。0.0001〜1000、小数 4 桁まで)。
 * @param {{bpm: number, canDelete?: boolean, headerOption?: boolean}} o headerOption: 「曲の BPM (#BPM) を変える」を出す
 * @returns {Promise<{action: 'ok'|'delete'|'cancel', bpm?: number, header?: boolean}>}
 */
export async function bpmDialog(dlg, o) {
  dlg.innerHTML = '';
  const form = el('form', { method: 'dialog' });
  form.append(el('h3', { textContent: t('edit.bpmTitle') }), el('p', { textContent: t('edit.bpmPrompt') }));
  const input = el('input', { type: 'text', inputMode: 'decimal', value: String(Math.round(o.bpm * 1e4) / 1e4), className: 'num' });
  input.setAttribute('aria-label', 'BPM');
  form.append(input);
  let header = null;
  if (o.headerOption) {
    header = el('input', { type: 'checkbox', checked: true });
    form.append(el('label', { className: 'check' }, [header, ' ' + t('edit.bpmHeader')]));
  }
  const err = el('p', { className: 'note warn', hidden: true, textContent: t('edit.bpmRange') });
  form.append(err);
  const row = el('div', { className: 'btn-row' }, [el('button', { type: 'submit', value: 'ok', className: 'btn small', textContent: t('edit.ok') })]);
  if (o.canDelete) row.append(el('button', { type: 'submit', value: 'delete', className: 'btn small secondary danger', textContent: t('edit.delete') }));
  row.append(el('button', { type: 'submit', value: 'cancel', className: 'btn small secondary', textContent: t('edit.cancel') }));
  form.append(row);
  dlg.append(form);
  const v = await runDialog(dlg, form, {
    focus: input,
    check: (value) => {
      if (value !== 'ok') return true;
      const n = readNumber(input.value);
      if (n >= 0.0001 && n <= 1000) return true;
      err.hidden = false;
      input.focus();
      input.select();
      return false;
    },
  });
  if (v === 'ok') return { action: 'ok', bpm: Math.round(readNumber(input.value) * 1e4) / 1e4, header: header ? header.checked : false };
  return { action: v === 'delete' ? 'delete' : 'cancel' };
}

/** 小節長の選択肢(拍子)。 */
const BAR_PRESETS = [['4/4', 1], ['3/4', 0.75], ['2/4', 0.5], ['5/4', 1.25], ['6/8', 0.75], ['7/8', 0.875], ['12/8', 1.5]];

/**
 * 小節長のダイアログ(DTXCreator の「小節長変更」に、拍子の選択肢・範囲・はみ出すチップの数を足したもの)。
 * @param {{measure: number, value: number, overflow: (o: {value:number, scope:string, keepBeats:boolean}) => number}} o
 * @returns {Promise<{action: 'ok'|'cancel', value?: number, scope?: string, keepBeats?: boolean}>}
 */
export async function barDialog(dlg, o) {
  dlg.innerHTML = '';
  const form = el('form', { method: 'dialog' });
  form.append(el('h3', { textContent: t('edit.barTitle') }));
  form.append(el('p', { textContent: t('edit.barMeasure') + ': ' + String(o.measure).padStart(3, '0') }));
  const preset = el('select');
  preset.setAttribute('aria-label', t('edit.barBeats'));
  for (const [label, v] of BAR_PRESETS) preset.append(el('option', { value: String(v), textContent: label }));
  const input = el('input', { type: 'text', inputMode: 'decimal', value: String(Math.round(o.value * 1e6) / 1e6), className: 'num' });
  input.setAttribute('aria-label', t('edit.barValue'));
  const match = BAR_PRESETS.find(([, v]) => Math.abs(v - o.value) < 1e-9);
  if (match) preset.value = String(match[1]);
  else {
    preset.prepend(el('option', { value: '', textContent: '—' }));
    preset.value = '';
  }
  form.append(el('div', { className: 'row' }, [
    el('label', {}, [t('edit.barBeats') + ' ', preset]),
    el('label', {}, [t('edit.barValue') + ' ', input]),
  ]));
  const radio = (name, value, label, checked) => {
    const r = el('input', { type: 'radio', name, value, checked });
    r.onchange = () => update();
    return el('label', { className: 'check' }, [r, ' ' + label]);
  };
  form.append(el('div', { className: 'row' }, [radio('scope', 'one', t('edit.barScopeOne'), true), radio('scope', 'from', t('edit.barScopeFrom'), false)]));
  form.append(el('div', { className: 'row' }, [radio('beats', 'keep', t('edit.barKeepBeats'), true), radio('beats', 'stretch', t('edit.barStretch'), false)]));
  const note = el('p', { className: 'note warn', hidden: true });
  form.append(note);
  const ok = el('button', { type: 'submit', value: 'ok', className: 'btn small', textContent: t('edit.ok') });
  form.append(el('div', { className: 'btn-row' }, [ok, el('button', { type: 'submit', value: 'cancel', className: 'btn small secondary', textContent: t('edit.cancel') })]));
  dlg.append(form);
  const read = () => ({
    value: readNumber(input.value),
    scope: form.querySelector('input[name=scope]:checked').value,
    keepBeats: form.querySelector('input[name=beats]:checked').value === 'keep',
  });
  const valid = (r) => r.value >= 0.01 && r.value <= 16;
  function update() {
    const r = read();
    if (!valid(r)) {
      note.textContent = t('edit.barRange');
      note.hidden = false;
      ok.disabled = true;
      return;
    }
    ok.disabled = false;
    const n = o.overflow(r);
    note.textContent = n ? t('edit.barOverflow', { n }) : '';
    note.hidden = !n;
  }
  preset.onchange = () => {
    if (preset.value) input.value = preset.value;
    update();
  };
  input.oninput = () => update();
  update();
  const v = await runDialog(dlg, form, { focus: input, check: (value) => value !== 'ok' || valid(read()) });
  return v === 'ok' ? { action: 'ok', ...read() } : { action: 'cancel' };
}

/**
 * サウンドプロパティ(DTXCreator の「サウンドプロパティ」。ラベル・ファイル・音量 0〜100・位置 -100〜100・BGM として使う)。
 * @param {{id: string, file: string, label: string, volume: number, pan: number, bgm: boolean}} o
 * @returns {Promise<{action: 'ok'|'cancel', file?: string, label?: string, volume?: number, pan?: number, bgm?: boolean}>}
 */
export async function soundDialog(dlg, o) {
  dlg.innerHTML = '';
  const form = el('form', { method: 'dialog' });
  form.append(el('h3', { textContent: t('edit.soundProps') + ' — ' + o.id }));
  const text = (label, value) => {
    const input = el('input', { type: 'text', value: value || '', spellcheck: false });
    form.append(el('label', { className: 'field' }, [label + ' ', input]));
    return input;
  };
  const label = text(t('edit.wavLabel'), o.label);
  const file = text(t('edit.wavFile'), o.file);
  const num = (lab, value, min, max) => {
    const input = el('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: '1', className: 'num' });
    form.append(el('label', { className: 'field' }, [`${lab} (${min}〜${max}) `, input]));
    return input;
  };
  const volume = num(t('edit.wavVolume'), o.volume, 0, 100);
  const pan = num(t('edit.wavPan'), o.pan, -100, 100);
  const bgm = el('input', { type: 'checkbox', checked: !!o.bgm });
  form.append(el('label', { className: 'check' }, [bgm, ' ' + t('edit.soundIsBgm')]));
  const err = el('p', { className: 'note warn', hidden: true });
  form.append(err);
  form.append(el('div', { className: 'btn-row' }, [
    el('button', { type: 'submit', value: 'ok', className: 'btn small', textContent: t('edit.ok') }),
    el('button', { type: 'submit', value: 'cancel', className: 'btn small secondary', textContent: t('edit.cancel') }),
  ]));
  dlg.append(form);
  const int = (input, min, max) => {
    const v = readNumber(input.value);
    return Number.isInteger(v) && v >= min && v <= max ? v : NaN;
  };
  const v = await runDialog(dlg, form, {
    focus: label,
    check: (value) => {
      if (value !== 'ok') return true;
      const bad = Number.isNaN(int(volume, 0, 100)) ? volume : Number.isNaN(int(pan, -100, 100)) ? pan : null;
      if (!bad) return true;
      err.textContent = t('edit.wavNumberRange');
      err.hidden = false;
      bad.focus();
      return false;
    },
  });
  if (v !== 'ok') return { action: 'cancel' };
  return { action: 'ok', file: file.value.trim(), label: label.value.trim(), volume: int(volume, 0, 100), pan: int(pan, -100, 100), bgm: bgm.checked };
}

/**
 * 数を 1 つ聞く(BGM をずらすなど)。
 * @param {{title: string, prompt: string, value: number, min: number, max: number, integer?: boolean}} o
 * @returns {Promise<{action: 'ok'|'cancel', value?: number}>}
 */
export async function numberDialog(dlg, o) {
  dlg.innerHTML = '';
  const form = el('form', { method: 'dialog' });
  form.append(el('h3', { textContent: o.title }), el('p', { textContent: o.prompt }));
  const input = el('input', { type: 'text', inputMode: 'decimal', value: String(o.value), className: 'num' });
  input.setAttribute('aria-label', o.title);
  form.append(input);
  const err = el('p', { className: 'note warn', hidden: true, textContent: t('edit.numberRange', { min: o.min, max: o.max }) });
  form.append(err);
  form.append(el('div', { className: 'btn-row' }, [
    el('button', { type: 'submit', value: 'ok', className: 'btn small', textContent: t('edit.ok') }),
    el('button', { type: 'submit', value: 'cancel', className: 'btn small secondary', textContent: t('edit.cancel') }),
  ]));
  dlg.append(form);
  const read = () => {
    const n = readNumber(input.value);
    if (!(n >= o.min && n <= o.max)) return NaN;
    return o.integer ? (Number.isInteger(n) ? n : NaN) : n;
  };
  const v = await runDialog(dlg, form, {
    focus: input,
    check: (value) => {
      if (value !== 'ok' || !Number.isNaN(read())) return true;
      err.hidden = false;
      input.focus();
      input.select();
      return false;
    },
  });
  return v === 'ok' ? { action: 'ok', value: read() } : { action: 'cancel' };
}
