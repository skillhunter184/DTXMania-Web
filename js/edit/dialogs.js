// 譜面の編集画面のダイアログ(<dialog>。Enter = 決定、Esc = 取り消し。Space は BD なので決定に使わない)。

import { t } from '../i18n.js';

/**
 * ボタンを並べたダイアログ。押したボタンの value を返す(Esc・外を押したら cancelValue)。
 * @param {HTMLDialogElement} dlg
 * @param {{title?: string, message: string, extra?: string, buttons: {label: string, value: string, primary?: boolean, danger?: boolean}[], cancelValue?: string}} o
 * @returns {Promise<string>}
 */
export function choiceDialog(dlg, o) {
  return new Promise((resolve) => {
    dlg.innerHTML = '';
    const form = document.createElement('form');
    form.method = 'dialog';
    if (o.title) {
      const h = document.createElement('h3');
      h.textContent = o.title;
      form.appendChild(h);
    }
    const p = document.createElement('p');
    p.textContent = o.message;
    form.appendChild(p);
    if (o.extra) {
      const e = document.createElement('p');
      e.className = 'note warn';
      e.textContent = o.extra;
      form.appendChild(e);
    }
    const row = document.createElement('div');
    row.className = 'btn-row';
    let primary = null;
    for (const b of o.buttons) {
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.value = b.value;
      btn.textContent = b.label;
      btn.className = 'btn small' + (b.primary ? '' : ' secondary') + (b.danger ? ' danger' : '');
      row.appendChild(btn);
      if (b.primary) primary = btn;
    }
    form.appendChild(row);
    dlg.appendChild(form);
    const cancelValue = o.cancelValue ?? 'cancel';
    const done = () => {
      dlg.removeEventListener('close', done);
      resolve(dlg.returnValue || cancelValue);
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', done);
    // 外(背景)を押したら取り消し
    dlg.onclick = (e) => { if (e.target === dlg) dlg.close(cancelValue); };
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    (primary || row.querySelector('button')).focus();
  });
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
