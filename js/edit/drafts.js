// 譜面の編集の下書き(IndexedDB。本アプリの追加)。
// DTXCreator にも vid2dtx にも自動保存は無いが、iPad の Safari は beforeunload を出さず、裏に回したタブを閉じることがある
// (ダウンロードしたファイルをファイル App に保存しに行っている間など)ので、編集を下書きに残す。
// キーは曲パック(名前と大きさ)と譜面のパスで分け、lastZip / skinFiles とは別にする。

import { idbGet, idbSet, idbDelete, idbKeys } from '../core/storage.js';
import { normKey } from '../core/song.js';

const PREFIX = 'draft:';
/** 残す下書きの数(古いものから消す)。 */
export const MAX_DRAFTS = 30;

/** 曲パックの見分け(同じ名前・同じ大きさの ZIP、同じ名前・同じファイル数のフォルダ)。 */
export function packId(pkg) {
  const zip = pkg.zip;
  return `${pkg.name || ''}|${zip && zip.blob ? zip.blob.size : 'dir' + (zip ? zip.entries.length : 0)}`;
}

export function draftKey(pkg, path) {
  return `${PREFIX}${packId(pkg)}:${normKey(path)}`;
}

/**
 * @typedef {Object} Draft
 * @property {number} v
 * @property {string} path
 * @property {Uint8Array} bytes 書き出すバイト列
 * @property {number} baseCrc 元の譜面の CRC(元が変わっていたら知らせる)
 * @property {number} savedAt
 * @property {string} title
 * @property {string} label
 * @property {object|null} view
 * @property {[number, string][]} pens
 * @property {number[]} activeTypes
 * @property {number[]} rolls
 */

/** @returns {Promise<boolean>} */
export async function saveDraft(pkg, path, value) {
  const ok = await idbSet(draftKey(pkg, path), { ...value, v: 1, path, savedAt: Date.now() });
  if (ok) pruneDrafts(MAX_DRAFTS);
  return ok;
}

/** @returns {Promise<Draft|null>} */
export async function loadDraft(pkg, path) {
  const d = await idbGet(draftKey(pkg, path));
  return isDraft(d) ? d : null;
}

export function deleteDraft(pkg, path) {
  return idbDelete(draftKey(pkg, path));
}

/** この曲パックの下書き(新しい順)。 */
export async function listDrafts(pkg) {
  const keys = await idbKeys(`${PREFIX}${packId(pkg)}:`);
  const out = [];
  for (const k of keys) {
    const d = await idbGet(k);
    if (isDraft(d)) out.push(d);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** 下書きを max 個まで残し、古いものから消す。 */
export async function pruneDrafts(max = MAX_DRAFTS) {
  const keys = await idbKeys(PREFIX);
  if (keys.length <= max) return;
  const items = [];
  for (const k of keys) {
    const d = await idbGet(k);
    items.push({ k, at: d && d.savedAt ? d.savedAt : 0 });
  }
  items.sort((a, b) => b.at - a.at);
  for (const it of items.slice(max)) await idbDelete(it.k);
}

function isDraft(d) {
  return !!(d && d.v === 1 && d.bytes && d.bytes.length !== undefined && typeof d.path === 'string');
}
