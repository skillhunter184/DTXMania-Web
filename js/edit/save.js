// 譜面の編集の保存(ブラウザなのでファイルを直接は上書きできない。ダウンロード・共有で渡す)。

/** バイト列をファイルとしてダウンロードさせる(iOS がテキストとして開かず、.txt を足されないよう octet-stream)。 */
export function downloadBytes(bytes, name) {
  downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), name);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐ手放すと、ダウンロードが始まる前に URL が消えるブラウザがある
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** ファイルの共有(AirDrop・ファイル App など。iPad / スマホ)ができるか。 */
export function canShareFile(bytes, name) {
  try {
    if (!navigator.canShare || !navigator.share) return false;
    return navigator.canShare({ files: [new File([bytes], name, { type: 'application/octet-stream' })] });
  } catch (e) {
    return false;
  }
}

/** ファイルを共有する。共有を閉じた(取り消した)ときは false。 */
export async function shareFile(bytes, name) {
  try {
    await navigator.share({ files: [new File([bytes], name, { type: 'application/octet-stream' })] });
    return true;
  } catch (e) {
    return false;
  }
}

/** 名前を付けて保存ができるか(Chromium の File System Access。本アプリの追加)。 */
export function canSaveAs() {
  return typeof window.showSaveFilePicker === 'function';
}

/** 保存先を選んで書く。選ぶのをやめたら null。書いたファイルの handle を返す(次の Ctrl+S はそこへ上書きする)。 */
export async function saveAsFile(bytes, suggestedName) {
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'DTX', accept: { 'application/octet-stream': ['.dtx'] } }] });
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
  await writeHandle(handle, bytes);
  return handle;
}

/** handle のファイルへ上書きする(書けなければ例外。呼ぶ側はダウンロードに切り替える)。 */
export async function writeHandle(handle, bytes) {
  const w = await handle.createWritable();
  try {
    await w.write(bytes);
  } catch (e) {
    await w.abort(); // 書きかけのものでファイルを置き換えない(close で確定する)
    throw e;
  }
  await w.close();
}

/** パスのファイル名。 */
export function baseName(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** ZIP の名前(元の名前を上書きしないよう _edited を付ける)。 */
export function editedZipName(name) {
  const stem = (name || 'songs').replace(/\.zip$/i, '');
  return `${stem}_edited.zip`;
}
