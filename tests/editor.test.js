// 譜面の編集画面(js/edit/editor.js)の結合テスト。index.html の #screen-edit をこのページに差し込み、
// マウス・タッチ・キーの合成イベントで操作して、文書と曲パックへの重ね合わせ・下書きを見る。
import { test, assert, assertEq, fetchBytes } from './runner.js';
import { SongPackage } from '../js/core/song.js';
import { Skin, columnCenterX, JUDGE_Y, CANVAS_H } from '../js/ui/skin.js';
import { EditSession } from '../js/edit/session.js';
import { EditorScreen } from '../js/edit/editor.js';
import { loadDraft, deleteDraft } from '../js/edit/drafts.js';
import { previewWidth } from '../js/edit/preview.js';
import { COMPACT_BELOW } from '../js/edit/view.js';
import { bgmAnchorMs, VIDEO_MIN_W, VIDEO_HEAD_H } from '../js/edit/video.js';
import { opShiftBgm } from '../js/edit/ops.js';
import { EditorPlayer } from '../js/edit/editplayer.js';
import { PLAYER_STATE } from '../js/game/player.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeAudio() {
  return {
    ctx: null, buffers: new Map(), failed: [], outputLatencySec: 0, played: [],
    async loadChartSounds() { return this.buffers; },
    hasBuffer() { return false; }, play() { return null; }, playBuffer() { return null; }, synthBuffer() { return null; },
    stopAll() {}, stopVoice() {}, audibleCtxAt() { return null; },
  };
}

/** 編集画面を開く。終わったら done() で片付ける。files: 譜面のパスの後ろに付ける名前 → 中身(確信度のファイルなど)。 */
async function openEditor(text = null, files = {}) {
  const html = await (await fetch('../index.html')).text();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const sec = document.importNode(parsed.getElementById('screen-edit'), true);
  // 画面の大きさは app.css で決まるので、テストの間だけ読む
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '../css/app.css';
  await new Promise((resolve) => { css.onload = css.onerror = resolve; document.head.appendChild(css); });
  document.body.appendChild(sec);
  const pkg = await SongPackage.fromZip((await fetchBytes('fixtures/pack_sjis.zip')).buffer, 'editor-test.zip');
  const song = pkg.songs[0];
  const chartRef = song.charts[0];
  if (text) pkg.setOverride(chartRef.path, new TextEncoder().encode(text));
  for (const [suffix, body] of Object.entries(files)) pkg.setOverride(chartRef.path + suffix, new TextEncoder().encode(body));
  const originalBytes = await pkg.readBytes(chartRef.path);
  const calls = [];
  const app = {
    config: { editGuide: 16 }, saveConfig() {}, audio: fakeAudio(), _editHintShown: true,
    closeEditor: async () => calls.push('close'), startTestPlay: async (s, ms) => calls.push(['test', ms]),
    exportEditedZip: async () => calls.push('zip'), requestWakeLock() {}, releaseWakeLock() {},
  };
  const session = new EditSession({ pkg, song, chartRef, originalBytes });
  const ed = new EditorScreen(app, session, new Skin(), {});
  await ed.open();
  // 小節 001〜002 が見えるように(1 小節 200 論理 px、再生位置は 1.2)
  ed.view.zoom = 0.5;
  ed.view.uHead = 1.2;
  ed.onResize();
  const cv = sec.querySelector('#edit-canvas');
  const geo = () => ed.model.geometry;
  const at = (col, m, tick) => ed.view.toClient(columnCenterX(col), ed.view.y(geo().u(m, tick)));
  const ptr = (type, p, o = {}) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: o.id || 7, pointerType: o.type || 'mouse', clientX: p.x, clientY: p.y, bubbles: true,
    button: o.button ?? (type === 'pointermove' ? -1 : 0), buttons: type === 'pointerup' ? 0 : o.button === 2 ? 2 : 1,
    altKey: !!o.alt, shiftKey: !!o.shift, ctrlKey: !!o.ctrl,
  }));
  const click = async (p, o) => { ptr('pointerdown', p, o); await sleep(5); ptr('pointerup', p, o); await sleep(5); };
  const key = (code, o = {}) => {
    const e = new KeyboardEvent('keydown', { code, key: o.key || '', ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, bubbles: true, cancelable: true });
    (o.target || window).dispatchEvent(e);
    return e;
  };
  const chips = (ch) => ed.model.chips.filter((c) => c.channel === ch).map((c) => `${c.measure}:${c.tick}`);
  /** 小節番号の欄の (小節, tick) の位置。 */
  const gutter = (m, tick) => ed.view.toClient((ed.view.view.gutter[0] + ed.view.view.gutter[1]) / 2, ed.view.y(geo().u(m, tick)));
  /** 開いているメニューの、文言が text で始まるボタンを押す。 */
  const menu = async (text) => {
    const b = [...sec.querySelectorAll('#edit-pop button')].find((x) => x.textContent.replace(/^✓ /, '').startsWith(text));
    assert(b, 'menu item ' + text + ' in: ' + sec.querySelector('#edit-pop').textContent);
    b.click();
    await sleep(5);
  };
  const dialog = () => sec.querySelector('#edit-dialog');
  /** ダイアログの value のボタンを押す(Enter は既定のボタン = OK。合成のキーでは押せないので押す)。 */
  const dialogButton = async (value) => {
    const b = dialog().querySelector(`button[value="${value}"]`);
    assert(b && dialog().open, 'dialog button ' + value);
    b.click(); // 送信でダイアログが終わる(close イベントは待たない。js/edit/dialogs.js)
    await sleep(5);
    assert(!dialog().open, 'dialog closed by ' + value);
  };
  const cleanup = async () => {
    sec.remove();
    css.remove();
    await deleteDraft(pkg, chartRef.path);
  };
  const done = async () => {
    if (dialog().open) dialog().close();
    await ed.close();
    await cleanup();
  };
  return { ed, sec, pkg, chartRef, app, calls, at, ptr, click, key, chips, gutter, menu, dialog, dialogButton, done, cleanup, session, geo };
}

const CHART = '#TITLE: e\r\n#BPM: 120\r\n#WAV01: bd.wav\r\n#WAV02: sd.wav\r\n#00113: 01000100\r\n#00112: 00020002\r\n#00111: 03030303\r\n#00216: 05\r\n';

test('editor: mouse place / click-delete / drag-move (one step each), Alt+click switches HH type, Shift+click adds RD, right-drag erases', async () => {
  const h = await openEditor(CHART);
  const { ed, at, click, ptr, chips, session } = h;
  try {
    // 置く(HT 1:192)
    await click(at(4, 1, 192));
    assertEq(chips(0x14).join(), '1:192');
    assertEq(session.history.index, 1);
    // チップを押して離すと消す
    await click(at(4, 1, 192));
    assertEq(chips(0x14).length, 0);
    // ドラッグで動かす(BD 1:0 → LT 1:96)
    const from = at(5, 1, 0);
    const to = at(6, 1, 96);
    ptr('pointerdown', from);
    for (let i = 1; i <= 6; i++) { ptr('pointermove', { x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 }); await sleep(2); }
    ptr('pointerup', to);
    await sleep(5);
    assertEq(chips(0x15).join(), '1:96');
    assertEq(chips(0x13).join(), '1:192');
    assertEq(session.history.entries.map((e) => e.label).join(), ',edit.opPlace,edit.opDelete,edit.opMove');
    // Alt+クリックで HHC → HHO
    await click(at(1, 1, 0), { alt: true });
    assertEq(chips(0x18).join(), '1:0');
    // Shift+クリックで CY の横に RD
    await click(at(8, 2, 0), { shift: true });
    assertEq(chips(0x19).join(), '2:0');
    assertEq(chips(0x16).join(), '2:0', 'CY は残る');
    // 右ドラッグで HHC 3 つを消す(1 手)
    const before = session.history.index;
    const a = at(1, 1, 96);
    const b = at(1, 1, 288);
    ptr('pointerdown', a, { button: 2 });
    for (let i = 1; i <= 8; i++) { ptr('pointermove', { x: a.x, y: a.y + ((b.y - a.y) * i) / 8 }, { button: 2 }); await sleep(2); }
    ptr('pointerup', b, { button: 2 });
    await sleep(5);
    assertEq(chips(0x11).length, 0);
    assertEq(session.history.index, before + 1);
    // 書き換えたのは触った組だけ(#TITLE などは元のバイト列)
    const out = new TextDecoder().decode(session.outputBytes().bytes);
    assert(out.startsWith('#TITLE: e\r\n#BPM: 120\r\n#WAV01: bd.wav\r\n#WAV02: sd.wav\r\n'), out);
    assert(!out.includes('#00111'), 'HHC の行が無くなった');
  } finally {
    await h.done();
  }
});

test('editor: keys (Ctrl+Z / Ctrl+Y, [ ], - +, PageUp, Esc stays, Space does nothing, T test-plays)', async () => {
  const h = await openEditor(CHART);
  const { ed, at, click, key, chips, session, calls } = h;
  try {
    await click(at(4, 1, 0));
    assertEq(chips(0x14).length, 1);
    key('KeyZ', { ctrl: true });
    assertEq(chips(0x14).length, 0);
    key('KeyY', { ctrl: true });
    assertEq(chips(0x14).length, 1);
    key('KeyZ', { ctrl: true, shift: true });
    assertEq(session.history.index, 1, 'Ctrl+Shift+Z もやり直す(もう先が無い)');
    assertEq(ed.view.guide, 16);
    key('BracketLeft', { key: '[' });
    assertEq(ed.view.guide, 12, '[ で粗く');
    key('BracketRight', { key: ']' });
    key('BracketRight', { key: ']' });
    assertEq(ed.view.guide, 24, '] で細かく');
    // 記号は e.key で見る(JIS 配列の [ は US の ] の位置)。IME の入力中('Process')だけ e.code から読む
    key('BracketRight', { key: '[' });
    assertEq(ed.view.guide, 16, 'JIS の [');
    key('BracketRight', { key: 'Process' });
    assertEq(ed.view.guide, 24, 'IME 入力中の ]');
    const z = ed.view.zoom;
    key('Equal', { key: '=' });
    assert(ed.view.zoom > z, '+ で拡大');
    key('Minus', { key: '-' });
    assertEq(ed.view.zoom, z);
    ed.view.uHead = 0.25;
    key('PageUp');
    assertEq(ed.view.uHead, 1, 'PageUp で次の小節の頭');
    const esc = key('Escape');
    assert(esc.defaultPrevented && !h.sec.hidden, 'Esc では画面を出ない');
    const sp = key('Space', { key: ' ' });
    assert(sp.defaultPrevented, 'Space は何もしない(スクロールもしない)');
    key('KeyT', { key: 't' });
    await sleep(5);
    assert(calls.some((c) => Array.isArray(c) && c[0] === 'test'), 'T でテストプレイ');
  } finally {
    await h.done();
  }
});

test('editor: touch tap places and deletes (with an undo toast), one-finger drag on a chip only scrolls', async () => {
  const h = await openEditor(CHART);
  const { ed, at, ptr, chips, session } = h;
  try {
    const t = { type: 'touch', id: 3 };
    const p = at(4, 1, 192);
    ptr('pointerdown', p, t);
    await sleep(30);
    ptr('pointerup', p, t);
    await sleep(5);
    assertEq(chips(0x14).join(), '1:192');
    ptr('pointerdown', p, t);
    await sleep(30);
    ptr('pointerup', p, t);
    await sleep(5);
    assertEq(chips(0x14).length, 0);
    assert(h.sec.querySelector('#edit-toast').textContent.includes('元に戻す'), 'undo button in the toast');
    const idx = session.history.index;
    const u0 = ed.view.uHead;
    const q = at(5, 1, 0);
    ptr('pointerdown', q, t);
    for (let i = 1; i <= 8; i++) { await sleep(4); ptr('pointermove', { x: q.x, y: q.y + i * 12 }, t); }
    ptr('pointerup', { x: q.x, y: q.y + 96 }, t);
    await sleep(5);
    assertEq(session.history.index, idx, '文書は変わらない');
    assert(ed.view.uHead > u0, '下へなぞると後ろ(未来)が来る');
  } finally {
    await h.done();
  }
});

test('editor: close commits the overlay and writes a draft; MIDI pads audition and flash the column', async () => {
  const h = await openEditor(CHART);
  const { ed, at, click, pkg, chartRef } = h;
  let closed = false;
  try {
    ed.onPadHit(3, performance.now(), 'midi');
    assert(ed.view.state.flash.has(3), 'SD の列が光る');
    await click(at(3, 1, 0));
    await ed.close();
    closed = true;
    const chart = await pkg.loadChart(chartRef.path);
    assert(chart.notes.some((n) => n.channel === 0x12 && n.measure === 1 && n.tick === 0), 'the list / test play see the edit');
    const d = await loadDraft(pkg, chartRef.path);
    assert(d && d.bytes.length > 0, 'draft written');
  } finally {
    if (closed) await h.cleanup();
    else await h.done();
  }
});

test('editor: select mode — click / Shift / band select, drag moves the selection, ↑↓ nudge (coalesced), ←→ change column, Delete, Esc', async () => {
  const h = await openEditor(CHART);
  const { ed, at, click, ptr, key, chips, session } = h;
  try {
    key('KeyS', { key: 's' });
    assertEq(ed.mode, 'select');
    assertEq(h.sec.querySelector('#edit-mode [data-mode="select"]').getAttribute('aria-pressed'), 'true');
    // クリックで選ぶ(文書は変わらない)、Shift で足す、何もないところで外す
    await click(at(5, 1, 0));
    assertEq(session.selection.size, 1);
    assertEq(session.history.index, 0);
    await click(at(5, 1, 192), { shift: true });
    assertEq(session.selection.size, 2);
    await click(at(4, 1, 96));
    assertEq(session.selection.size, 0);
    // 範囲選択(LC の列の空いたところから HH の列へ): HHC の 4 つ
    const a = at(0, 1, 330);
    const b = at(1, 0, 360);
    ptr('pointerdown', a);
    for (let i = 1; i <= 6; i++) { ptr('pointermove', { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }); await sleep(2); }
    assert(ed.view.state.band, '範囲の枠を描く');
    ptr('pointerup', b);
    await sleep(5);
    assertEq(session.selection.size, 4, '範囲で選ぶ');
    assert(!ed.view.state.band);
    // 選んだものの上からドラッグで全部動かす(1 手)
    const from = at(1, 1, 0);
    const to = at(1, 1, 48);
    ptr('pointerdown', from);
    for (let i = 1; i <= 6; i++) { ptr('pointermove', { x: from.x, y: from.y + ((to.y - from.y) * i) / 6 }); await sleep(2); }
    ptr('pointerup', to);
    await sleep(5);
    assertEq(chips(0x11).join(), '1:48,1:144,1:240,1:336');
    assertEq(session.history.index, 1);
    assertEq(session.selection.size, 4, '動かしたものを選んだまま');
    // ↑ で 1 ガイド(1/16 = 24 tick)、Alt+↑ で 1 tick。続けて押すと 1 手
    key('ArrowUp', { key: 'ArrowUp' });
    assertEq(chips(0x11).join(), '1:72,1:168,1:264,1:360');
    key('ArrowUp', { key: 'ArrowUp', alt: true });
    assertEq(chips(0x11).join(), '1:73,1:169,1:265,1:361');
    assertEq(session.history.index, 2, '微調整は 1 手にまとめる');
    // → で隣の列(LP)へ
    key('ArrowRight', { key: 'ArrowRight' });
    assertEq(chips(0x11).length, 0);
    assertEq(chips(0x1b).length, 4);
    // Delete で消す
    key('Delete', { key: 'Delete' });
    assertEq(chips(0x1b).length, 0);
    // Esc で選択を外す
    await click(at(5, 1, 0));
    assertEq(session.selection.size, 1);
    key('Escape', { key: 'Escape' });
    assertEq(session.selection.size, 0);
    // E でペンに戻る(選択は残る)
    await click(at(5, 1, 0));
    key('KeyE', { key: 'e' });
    assertEq(ed.mode, 'pen');
    assertEq(session.selection.size, 1, 'ペンにしても選択は残る');
    // ペンで書くと選択は外れる
    await click(at(4, 1, 0));
    assertEq(session.selection.size, 0);
  } finally {
    await h.done();
  }
});

test('editor: copy / paste at the playhead, Ctrl+D duplicates, Ctrl+A selects all; the context menu inserts and deletes bars (confirm, Space never confirms)', async () => {
  const h = await openEditor(CHART);
  const { ed, at, click, ptr, key, chips, session, menu, dialog, dialogButton, gutter, geo, app } = h;
  try {
    key('KeyS', { key: 's' });
    await click(at(5, 1, 0));
    key('KeyC', { ctrl: true });
    assert(app.editClipboard && app.editClipboard.items.length === 1, 'クリップボードはページに 1 つ');
    ed._hover = null; // マウスがレーンの外: 再生位置に貼る
    ed.view.uHead = geo().u(2, 0);
    key('KeyV', { ctrl: true });
    assertEq(chips(0x13).join(), '1:0,1:192,2:0');
    assertEq(session.selection.size, 1, '貼ったものを選ぶ');
    key('KeyD', { ctrl: true });
    assertEq(chips(0x13).join(), '1:0,1:192,2:0,3:0', '後ろの小節に複製');
    key('KeyA', { ctrl: true });
    assertEq(session.selection.size, ed.model.chips.length);
    // 右クリックのメニュー → 小節の挿入(小節 1 から後ろが 1 つ後ろへ)
    await click(at(4, 1, 96));
    const p = at(4, 1, 96);
    ptr('pointerdown', p, { button: 2 });
    ptr('pointerup', p, { button: 2 });
    assert(!h.sec.querySelector('#edit-pop').hidden, 'メニューが出る');
    await menu('小節の挿入');
    assertEq(chips(0x13).join(), '2:0,2:192,3:0,4:0');
    key('KeyZ', { ctrl: true });
    assertEq(chips(0x13).join(), '1:0,1:192,2:0,3:0');
    // 小節番号の欄の右クリック → 小節の削除(消えるものがあるので確かめる)
    const g = gutter(1, 100);
    ptr('pointerdown', g, { button: 2 });
    ptr('pointerup', g, { button: 2 });
    await menu('小節の削除');
    await sleep(5);
    assert(dialog().open, '確かめのダイアログ');
    assert(dialog().textContent.includes('小節 001'), dialog().textContent);
    const ok = dialog().querySelector('button[value="ok"]');
    const sp = key('Space', { key: ' ', target: ok });
    assert(sp.defaultPrevented && dialog().open, 'Space(BD)では決定しない');
    await dialogButton('ok');
    assertEq(chips(0x13).join(), '1:0,2:0', '小節 1 が消えて詰まる');
    assertEq(chips(0x16).join(), '1:0', 'CY 2:0 → 1:0');
  } finally {
    await h.done();
  }
});

test('editor: BPM here (dialog, ch 08 + #BPMzz) and bar length (dialog, this bar only)', async () => {
  const h = await openEditor(CHART);
  const { ed, ptr, menu, dialog, dialogButton, gutter, session } = h;
  try {
    const g = gutter(2, 0);
    ptr('pointerdown', g, { button: 2 });
    ptr('pointerup', g, { button: 2 });
    await menu('ここに BPM');
    await sleep(5);
    assert(dialog().open);
    const input = dialog().querySelector('input');
    assertEq(input.value, '120', '今の BPM が入っている');
    input.value = '150';
    await dialogButton('ok');
    const marks = ed.model.bpmMarks;
    assertEq(marks.length, 1);
    assertEq(marks[0].bpm, 150);
    const out = new TextDecoder().decode(session.outputBytes().bytes);
    assert(out.includes('#BPM01: 150\r\n') && out.includes('#00208: 01\r\n'), out);
    // 範囲の外の BPM は OK を押させない
    ptr('pointerdown', g, { button: 2 });
    ptr('pointerup', g, { button: 2 });
    await menu('ここに BPM');
    await sleep(5);
    dialog().querySelector('input').value = '0';
    dialog().querySelector('button[value="ok"]').click();
    await sleep(5);
    assert(dialog().open, '0 では閉じない');
    await dialogButton('cancel');
    // 小節長
    const g1 = gutter(1, 100);
    ptr('pointerdown', g1, { button: 2 });
    ptr('pointerup', g1, { button: 2 });
    await menu('小節長');
    await sleep(5);
    const v = dialog().querySelector('input.num');
    v.value = '0.75';
    v.dispatchEvent(new Event('input'));
    await dialogButton('ok');
    assertEq(ed.model.geometry.len(1), 0.75);
    assertEq(ed.model.geometry.len(2), 1, 'この小節だけ');
    const out2 = new TextDecoder().decode(session.outputBytes().bytes);
    assert(out2.includes('#00102: 0.75\r\n'), out2);
  } finally {
    await h.done();
  }
});

test('editor: touch select mode — tap toggles, a drag that starts on a selected chip moves it, other drags scroll', async () => {
  const h = await openEditor(CHART);
  const { ed, at, ptr, key, chips, session } = h;
  try {
    key('KeyS', { key: 's' });
    const t = { type: 'touch', id: 4 };
    const p = at(5, 1, 0);
    ptr('pointerdown', p, t);
    await sleep(20);
    ptr('pointerup', p, t);
    await sleep(5);
    assertEq(session.selection.size, 1, 'タップで選ぶ');
    const to = at(5, 1, 96);
    ptr('pointerdown', p, t);
    for (let i = 1; i <= 6; i++) { await sleep(4); ptr('pointermove', { x: p.x, y: p.y + ((to.y - p.y) * i) / 6 }, t); }
    ptr('pointerup', to, t);
    await sleep(5);
    assertEq(chips(0x13).join(), '1:96,1:192', '選んだチップの上からは動かす');
    const idx = session.history.index;
    const u0 = ed.view.uHead;
    const q = at(3, 1, 0);
    ptr('pointerdown', q, t);
    for (let i = 1; i <= 8; i++) { await sleep(4); ptr('pointermove', { x: q.x, y: q.y + i * 12 }, t); }
    ptr('pointerup', { x: q.x, y: q.y + 96 }, t);
    await sleep(5);
    assertEq(session.history.index, idx, 'ほかはスクロール');
    assert(ed.view.uHead > u0);
  } finally {
    await h.done();
  }
});

test('editor: vid2dtx confidence sidecar — frames on low-confidence chips, N / 次の要確認 visits them lowest first', async () => {
  const conf = JSON.stringify({ chips: [
    { m: 1, tick: 0, ch: 19, conf: 0.3, why: 'weak onset' },
    { m: 1, tick: 192, ch: 19, conf: 0.5 },
    { m: 1, tick: 96, ch: 17, conf: 0.9 },
  ] });
  const h = await openEditor(CHART, { '.conf.json': conf });
  const { ed, key, session, geo } = h;
  try {
    await sleep(30);
    assert(!h.sec.querySelector('#edit-suspect').hidden, '確信度のファイルがあるときだけボタンを出す');
    assertEq(ed._suspectMap().size, 2, '0.7 未満の 2 つ');
    key('KeyN', { key: 'n' });
    assertEq(ed.view.uHead, geo().u(1, 0));
    assert(h.sec.querySelector('#edit-toast').textContent.includes('要確認 1/2'), h.sec.querySelector('#edit-toast').textContent);
    assert(h.sec.querySelector('#edit-toast').textContent.includes('weak onset'));
    assertEq([...session.selection].length, 1);
    key('KeyN', { key: 'n' });
    assertEq(ed.view.uHead, geo().u(1, 192));
    key('KeyN', { key: 'n' });
    assertEq(ed.view.uHead, geo().u(1, 0), '最後まで行ったら最初へ');
  } finally {
    await h.done();
  }
});

test('editor: choosing Shift-JIS saves with the normal toast; a click that did not start on the backdrop keeps a dialog open; bar insert undo restores the loop', async () => {
  const h = await openEditor(CHART);
  const { ed, session, ptr, menu, dialog, dialogButton, gutter } = h;
  try {
    // ASCII の譜面で Shift-JIS を選んで保存: UTF-8 のお知らせは出さない
    ed._setEncoding({ encoding: 'shift_jis', bom: false });
    const out = session.outputBytes();
    assertEq(`${out.encoding}/${out.bom}`, 'shift_jis/false');
    const realDownload = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {}; // テストではダウンロードしない
    try {
      await ed.saveDtx();
    } finally {
      HTMLAnchorElement.prototype.click = realDownload;
    }
    const toast = h.sec.querySelector('#edit-toast').textContent;
    assert(toast.startsWith('保存しました'), toast);
    // タップで開いたダイアログに、そのタップの click が背景に来ても閉じない(押し始めが背景のときだけ取り消し)
    const g = gutter(1, 0);
    ptr('pointerdown', g, { button: 2 });
    ptr('pointerup', g, { button: 2 });
    await menu('ここに BPM');
    await sleep(5);
    assert(dialog().open);
    const r = dialog().getBoundingClientRect();
    const outside = { clientX: Math.max(1, r.left - 20), clientY: r.top + 5, bubbles: true };
    dialog().dispatchEvent(new MouseEvent('click', outside));
    assert(dialog().open, 'click だけでは閉じない');
    dialog().dispatchEvent(new PointerEvent('pointerdown', outside));
    dialog().dispatchEvent(new MouseEvent('click', outside));
    await sleep(5);
    assert(!dialog().open, '背景を押して離すと取り消し');
    // 小節の挿入でずらしたループは、元に戻すと戻る
    const lp = { beginPos: 384 * 3, endPos: 384 * 4, endAtEnd: false };
    session.loopPos = lp;
    ed.insertMeasure(1);
    assertEq(session.loopPos.beginPos, 384 * 4);
    ed.undo();
    assertEq(session.loopPos, lp, '元に戻すとループも戻る');
    ed.redo();
    assertEq(session.loopPos.beginPos, 384 * 4, 'やり直すとまたずれる');
    void dialogButton;
  } finally {
    await h.done();
  }
});

test('editor P3: side panel (toggle, chip / bar / info / sound tabs), header edit is one step, sound properties via the panel', async () => {
  const h = await openEditor(CHART);
  const { ed, session, key, click, at } = h;
  try {
    const side = h.sec.querySelector('#edit-side');
    assert(side.hidden, '初めは閉じている');
    h.sec.querySelector('#edit-panel').click();
    await sleep(5);
    assert(!side.hidden && ed.panel.open);
    assert(h.app.config.editPanelOpen, '開いたことを覚える');
    // チップのタブ: 選ぶと数と音の選択肢
    key('KeyS', { key: 's' });
    await click(at(5, 1, 0));
    ed.panel.refresh(true);
    assert(side.textContent.includes('1 個を選択中'), side.textContent.slice(0, 120));
    // 音を変える(パネルの選択肢)
    const sel = side.querySelector('.side-dl select');
    sel.value = '02';
    sel.dispatchEvent(new Event('change'));
    assertEq(ed.model.chips.find((c) => c.channel === 0x13 && c.measure === 1 && c.tick === 0).value, '02');
    // 小節のタブ
    ed.panel.setTab('measure');
    assert(side.textContent.includes('小節 001') || side.textContent.includes('小節 000'), side.textContent.slice(0, 120));
    // 譜面情報: 書き終えたら 1 手
    ed.panel.setTab('info');
    const idx = session.history.index;
    const title = side.querySelector('#edit-h-title');
    title.value = '新しい題名';
    title.dispatchEvent(new Event('change'));
    assertEq(ed.model.doc.header('TITLE'), '新しい題名');
    assertEq(session.history.index, idx + 1);
    assertEq(session.history.label, 'edit.opHeader');
    const lv = side.querySelector('#edit-h-dlevel');
    lv.value = '7.5';
    lv.dispatchEvent(new Event('change'));
    assertEq(session.history.index, idx + 1, '読めない #DLEVEL は書かない');
    // 音源のタブ: 一覧と、番号を選んでプロパティ
    ed.panel.setTab('sounds');
    const rows = [...side.querySelectorAll('.side-wavs tr')].slice(1).map((r) => r.firstChild.textContent);
    assertEq(rows.join(), '01,02,03,05', '定義した番号と、チップが使っている番号(定義なし)');
    side.querySelectorAll('.side-wavs tr')[2].click();
    await sleep(5);
    const props = [...side.querySelectorAll('button')].find((b) => b.textContent === 'サウンドプロパティ');
    props.click();
    await sleep(5);
    const dlg = h.dialog();
    assert(dlg.open);
    dlg.querySelectorAll('input[type=number]')[1].value = '-40';
    await h.dialogButton('ok');
    assert(ed.model.doc.text.includes('#PAN02: -40'), ed.model.doc.text);
    // 閉じる
    side.querySelector('.side-close').click();
    assert(side.hidden);
  } finally {
    await h.done();
  }
});

test('editor P3: step input (chord of hits is one step and advances one grid line; lane keys while armed), recording commits on stop', async () => {
  const h = await openEditor(CHART);
  const { ed, session, key, geo } = h;
  try {
    h.app.config.bindings = [['KeyA'], ['KeyS'], ['KeyW'], ['KeyD'], ['KeyF'], ['Space'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']];
    ed.view.uHead = geo().u(2, 96);
    h.sec.querySelector('#edit-step').click();
    assert(ed.stepArmed);
    assertEq(h.sec.querySelector('#edit-step').getAttribute('aria-pressed'), 'true');
    const idx = session.history.index;
    ed.onPadHit(3, performance.now(), 'midi'); // SD
    key('Space', { key: ' ' }); // BD(Space は BD のキー)
    await sleep(120);
    const at296 = ed.model.chips.filter((c) => c.measure === 2 && c.tick === 96).map((c) => c.channel.toString(16)).sort();
    assertEq(at296.join(), '12,13');
    assertEq(session.history.index, idx + 1, '和音は 1 手');
    assertEq(Math.round((ed.view.uHead - geo().u(2, 96)) * 384), 24, '1 ガイド(1/16)進む');
    // 割り当てていない文字のキーはいつもどおり(P は再生 / 停止のまま。S は HH のレーンなので選択のモードにならない)
    key('KeyS', { key: 's' });
    await sleep(120);
    assertEq(ed.mode, 'pen', 'S は HH');
    assert(ed.model.chips.some((c) => c.channel === 0x11 && c.measure === 2 && c.tick === 120), 'HH を置いた');
    // 録音(再生中の打鍵): 偽の再生で、叩いた時刻のセルに置き、止めたら 1 手
    const ms = 4000 + 500; // 120 BPM: 小節 001 の頭 = 4000 ms(リードイン 2000 + 小節 000)。+1 拍
    ed.player = Object.assign(Object.create(ed.player), {
      state: 'playing', chart: ed.model.chart, songAt: () => ms, realFromPerf: (x) => x, nowReal: () => Infinity, _w: () => 0, judgeOffsetMs: 0,
    });
    ed.onPadHit(4, performance.now(), 'midi'); // HT
    ed.onPadHit(4, performance.now(), 'midi'); // 同じセルの同じチャンネルは 1 つ
    assertEq((ed.view.state.pending || []).length, 1);
    const idx2 = session.history.index;
    ed._commitRecorded();
    assertEq(session.history.index, idx2 + 1);
    assertEq(session.history.label, 'edit.record');
    assert(ed.model.chips.some((c) => c.channel === 0x14 && c.measure === 1 && c.tick === 96), 'HT 1:96');
    assert(h.sec.querySelector('#edit-toast').textContent.includes('1 個を録音しました'));
    ed.player = Object.getPrototypeOf(ed.player);
    h.sec.querySelector('#edit-step').click();
    assert(!ed.stepArmed);
  } finally {
    await h.done();
  }
});

test('editor P3 review: importing sounds (pen ids avoided, same name renamed, same bytes reused, ; in the name), header edits keep the selection, lead-in hits are not recorded', async () => {
  const h = await openEditor(CHART);
  const { ed, session, key, click, at, pkg } = h;
  try {
    const dir = session.dir;
    ed.session.pens.set(0x1a, '04'); // LC のペンは 04(まだ #WAV が無い)
    const pens = new Set(ed.session.pens.values());
    await ed.importSound(new File([new Uint8Array([1, 2, 3])], 'Tom.wav'));
    const defs = () => ed.model.doc.text.split(/\r?\n/).filter((l) => l.startsWith('#WAV'));
    const added = defs().find((l) => l.includes('Tom.wav'));
    const id = added && added.slice(4, 6);
    assert(id && !pens.has(id) && !['01', '02', '03', '05'].includes(id), 'ペン・チップの番号は使わない: ' + added);
    assert(pkg.override(dir + 'Tom.wav'));
    await ed.importSound(new File([new Uint8Array([9, 9])], 'Tom.wav'));
    assert(defs().some((l) => l.includes('Tom (2).wav')), '中身の違う同じ名前は名前を変える: ' + defs().join(' / '));
    const n = defs().length;
    await ed.importSound(new File([new Uint8Array([1, 2, 3])], 'Tom.wav'));
    assert(defs()[n] && defs()[n].includes(': Tom.wav'), '同じ中身はそのファイルを使う');
    await ed.importSound(new File([new Uint8Array([4])], 'a;b.wav'));
    assert(defs().some((l) => l.includes(': a_b.wav')) && pkg.override(dir + 'a_b.wav'), '; は _');
    // 譜面情報を変えても選択は残る
    key('KeyS', { key: 's' });
    await click(at(5, 1, 0));
    assertEq(session.selection.size, 1);
    h.sec.querySelector('#edit-panel').click();
    ed.panel.setTab('info');
    const title = h.sec.querySelector('#edit-h-title');
    title.value = 'x';
    title.dispatchEvent(new Event('change'));
    assertEq(session.selection.size, 1, '選択はそのまま');
    // リードインで叩いたものは録音しない
    ed.stepArmed = true;
    const lead = 1000; // リードイン(0〜2000 ms)の中
    ed.player = Object.assign(Object.create(ed.player), {
      state: 'playing', chart: ed.model.chart, songAt: () => lead, realFromPerf: (x) => x, nowReal: () => Infinity, _w: () => 0, judgeOffsetMs: 0,
    });
    ed.onPadHit(3, performance.now(), 'midi');
    assertEq(ed._recorded.length, 0);
    ed.player = Object.getPrototypeOf(ed.player);
    ed.stepArmed = false;
  } finally {
    await h.done();
  }
});

test('editor preview: width from the height (4 割まで、狭ければ出さない、広い配置を狭い配置に落とさない)', () => {
  assertEq(previewWidth(1000, 800), 400, '幅の 4 割で頭打ち');
  assertEq(previewWidth(2000, 500), Math.floor(500 * (778 + 160) / 1080), '高さに合わせる(演奏画面の縦画面の切り出し)');
  assertEq(previewWidth(300, 800), 0, '狭い');
  assertEq(previewWidth(1000, 150), 160, '低くても最小の幅で出す(描くほうが縮める)');
  assertEq(previewWidth(1024, 650, COMPACT_BELOW), 1024 - COMPACT_BELOW, '残りを広い配置の幅より狭くしない');
  assertEq(previewWidth(800, 650, COMPACT_BELOW), 0, '残りが少なければ出さない');
  assertEq(previewWidth(700, 650, COMPACT_BELOW), 280, 'もとから狭い配置なら 4 割まで');
});

test('editor preview: the button / V toggle it beside the rail (remembered), it follows the playhead, edits and hi-speed while stopped, the wheel over it scrolls, too narrow → toast', async () => {
  const h = await openEditor(CHART);
  const { ed, sec, key, click, at, app } = h;
  try {
    const pv = sec.querySelector('#edit-preview');
    const cv = sec.querySelector('#edit-canvas');
    const stage = sec.querySelector('#edit-stage');
    const btnEl = sec.querySelector('#edit-preview-btn');
    assert(pv.hidden && !ed._previewSize, '初めは出さない');
    const w0 = parseFloat(cv.style.width);
    btnEl.click();
    await sleep(5);
    assert(app.config.editPreview, '出したことを覚える');
    const pw = previewWidth(stage.clientWidth - sec.querySelector('#edit-rail').offsetWidth, stage.clientHeight, COMPACT_BELOW);
    assert(pw > 0, 'テストの画面にはプレビューの場所がある: ' + stage.clientWidth + 'x' + stage.clientHeight);
    assert(!pv.hidden && btnEl.classList.contains('on'));
    assertEq(btnEl.getAttribute('aria-pressed'), 'true');
    assertEq(parseFloat(pv.style.width), pw);
    assertEq(parseFloat(cv.style.width), w0 - pw, '編集画面がその分狭くなる');
    assert(pv.getBoundingClientRect().left >= sec.querySelector('#edit-rail').getBoundingClientRect().right - 0.5, '右のバーの右');
    // 止まっているときは再生位置(1.2 小節目 = リードイン 2000 ms + 2400 ms)を判定ラインに
    ed._frame(performance.now());
    const p = ed.player;
    assert(ed.previewRenderer && ed.previewRenderer.canvas === pv);
    assertEq(ed.previewRenderer.cssW, pw - 1, '区切り線を除いた幅で描く');
    assert(ed.previewRenderer.skin.chipSprites !== ed.skin.chipSprites, 'チップの絵の作り置きは編集画面と別');
    {
      // 判定ラインは編集画面の再生位置の線にそろえる(ハイウェイが収まる範囲で。横長ではプレビューが高さいっぱいで動かせない)
      const r = ed.previewRenderer;
      const want = Math.max(0, Math.min(r.cssH - CANVAS_H * r.scale, ed.view.headY * ed.view.s - JUDGE_Y * r.scale));
      assert(Math.abs(r.offsetY - want) < 1e-6, `offsetY ${r.offsetY} want ${want}`);
    }
    {
      // 縦長の場所ではそろう
      const main = sec.querySelector('#edit-main');
      main.style.width = '900px';
      ed.onResize();
      ed._frame(performance.now());
      const r = ed.previewRenderer;
      const at = `judge=${r.offsetY + JUDGE_Y * r.scale} head=${ed.view.headY * ed.view.s} offsetY=${r.offsetY} ${r.cssW}x${r.cssH}`;
      assert(r.offsetY > 0 && Math.abs(r.offsetY + JUDGE_Y * r.scale - ed.view.headY * ed.view.s) < 1, at);
      main.style.width = '';
      ed.onResize();
      ed._frame(performance.now());
    }
    assertEq(Math.round(p.songMs), 4400);
    assert(p.chart === ed.model.chart);
    assert(p.notes.every((n, i) => p.judged[i] === n.timeMs < 4400), '過ぎたチップは消えている');
    // 編集はすぐ映る(HT 1:192 = 5000 ms)
    const n0 = p.notes.length;
    await click(at(4, 1, 192));
    ed._frame(performance.now());
    assert(p.chart === ed.model.chart, '譜面を差し替える');
    assertEq(p.notes.length, n0 + 1);
    const ht = p.notes.findIndex((n) => Math.round(n.timeMs) === 5000 && n.channel === 0x14);
    assert(ht >= 0 && !p.judged[ht], '置いたチップはこれから来る');
    // 再生位置を動かすと付いてくる
    ed.view.uHead = 0.5;
    ed._render();
    ed._frame(performance.now());
    assertEq(Math.round(p.songMs), 3000);
    // プレビューの上のホイールは譜面を送る(400 で 1 小節)
    pv.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    ed._frame(performance.now());
    assert(Math.abs(ed.view.uHead - 1.5) < 1e-9, String(ed.view.uHead));
    assertEq(Math.round(p.songMs), 5000);
    // ハイスピードはトレーニングの設定のもの(止まっていてもすぐ)
    app.training = { scrollSpeedTenth: 20, judgeOffsetMs: 0 };
    ed._render();
    ed._frame(performance.now());
    assert(Math.abs(p.scrollCurrentRatio - 2) < 1e-9, String(p.scrollCurrentRatio));
    // V でしまう(編集画面は元の幅)
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(pv.hidden && !app.config.editPreview && !btnEl.classList.contains('on'));
    assertEq(btnEl.getAttribute('aria-pressed'), 'false');
    assertEq(parseFloat(cv.style.width), w0);
    // Ctrl+V は貼り付け(プレビューは変わらない)
    key('KeyV', { key: 'v', ctrl: true });
    assert(pv.hidden && !app.config.editPreview);
    // 狭いときは出さずに知らせる(出すことは覚えておき、広げると出る)
    const main = sec.querySelector('#edit-main');
    main.style.width = '260px';
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(app.config.editPreview && pv.hidden && !ed._previewSize);
    assert(sec.querySelector('#edit-toast').textContent.includes('画面が狭い'), sec.querySelector('#edit-toast').textContent);
    main.style.width = '';
    ed.onResize();
    assert(!pv.hidden && ed._previewSize);
  } finally {
    await h.done();
  }
});

test('editor preview: with the side panel open the layout settles (the preview never drops the wide layout, which would undock the panel and resize the stage again)', async () => {
  const h = await openEditor(CHART);
  const { ed, sec } = h;
  try {
    const pv = sec.querySelector('#edit-preview');
    const cv = sec.querySelector('#edit-canvas');
    const stage = sec.querySelector('#edit-stage');
    const rail = sec.querySelector('#edit-rail');
    sec.querySelector('#edit-panel').click();
    await sleep(5);
    sec.querySelector('#edit-preview-btn').click();
    await sleep(5);
    const state = () => `${ed.view.layout} dock=${sec.classList.contains('panel-dock')} stage=${stage.clientWidth}x${stage.clientHeight} preview=${pv.hidden ? '-' : pv.style.width}`;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      ed.onResize();
      seen.push(state());
    }
    assert(seen.every((s) => s === seen[0]), '毎回同じ配置: ' + seen.join(' / '));
    if (stage.clientWidth - rail.offsetWidth >= COMPACT_BELOW) {
      assertEq(ed.view.layout, 'wide', seen[0]);
      assert(parseFloat(cv.style.width) >= COMPACT_BELOW, cv.style.width);
    }
    // 寄せたパネルで幅が足りない窓: 出さず、お知らせはパネルのこと(閉じれば出る)
    const main = sec.querySelector('#edit-main');
    main.style.width = '1180px';
    ed.onResize();
    ed.onResize();
    assert(sec.classList.contains('panel-dock') && ed.view.layout === 'wide' && pv.hidden, state());
    sec.querySelector('#edit-preview-btn').click();
    sec.querySelector('#edit-preview-btn').click();
    await sleep(5);
    assert(sec.querySelector('#edit-toast').textContent.includes('横のパネルを閉じると'), sec.querySelector('#edit-toast').textContent);
    // 寄せたパネルを閉じると、狭い配置を挟まずに広い配置のまま出る(拡大率も変わらない)
    const layouts = [];
    const zoom = ed.view.zoom;
    const resize = ed.view.resize;
    ed.view.resize = function (...a) {
      resize.apply(this, a);
      layouts.push(this.layout);
    };
    sec.querySelector('#edit-side .side-close').click();
    await sleep(30);
    delete ed.view.resize;
    assert(layouts.length > 0 && layouts.every((l) => l === 'wide'), layouts.join());
    assertEq(ed.view.zoom, zoom);
    assert(!sec.classList.contains('panel-dock') && !pv.hidden, state());
  } finally {
    await h.done();
  }
});

test('editor preview: a stage a little wider than the wide layout (no docked panel) goes compact so the preview fits, without flip-flopping; hiding and closing release its canvas', async () => {
  const h = await openEditor(CHART);
  const { ed, sec, key } = h;
  try {
    const pv = sec.querySelector('#edit-preview');
    const stage = sec.querySelector('#edit-stage');
    const rail = sec.querySelector('#edit-rail');
    assert(!ed.panel.open, 'パネルは閉じている');
    const main = sec.querySelector('#edit-main');
    const narrowTo = (avail) => {
      main.style.width = avail + rail.offsetWidth + 'px';
      ed.onResize();
    };
    key('KeyV', { key: 'v' });
    await sleep(5);
    const state = () => `${ed.view.layout} stage=${stage.clientWidth}x${stage.clientHeight} preview=${pv.hidden ? '-' : pv.style.width}`;
    for (const avail of [800, 760, 879]) {
      narrowTo(avail);
      const seen = [];
      for (let i = 0; i < 3; i++) {
        ed.onResize();
        seen.push(state());
      }
      assert(seen.every((s) => s === seen[0]), avail + ': 毎回同じ配置: ' + seen.join(' / '));
      assertEq(ed.view.layout, 'compact', avail + ' ' + seen[0]);
      assert(!pv.hidden && parseFloat(pv.style.width) >= 160, avail + ' ' + seen[0]);
    }
    // 狭い配置にしたからには、低くても最小の幅で出す(広い配置を失ってプレビューも無い、にしない)
    narrowTo(800);
    stage.style.bottom = Math.max(0, stage.clientHeight - 120) + 'px';
    ed.onResize();
    const low = state();
    ed.onResize();
    assertEq(state(), low, '低くても行き来しない');
    assertEq(ed.view.layout, 'compact', low);
    assert(!pv.hidden && parseFloat(pv.style.width) === 160, low);
    stage.style.bottom = '';
    // 広い配置のまま並べられる幅なら広い配置
    narrowTo(1000);
    assertEq(ed.view.layout, 'wide', state());
    assert(!pv.hidden, state());
    // しまうと静止部分の作り置きを手放す
    ed._frame(performance.now());
    assert(ed.previewRenderer && ed.previewRenderer._base, '描いたので作り置きがある');
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(pv.hidden && ed.previewRenderer._base === null);
    assertEq(ed.view.layout, 'wide', 'しまえば幅で決まる配置');
    // 閉じると手放す
    key('KeyV', { key: 'v' });
    await sleep(5);
    ed._frame(performance.now());
    const r = ed.previewRenderer;
    assert(r && r._base);
    await ed.close();
    assert(ed.previewRenderer === null && r._base === null);
  } finally {
    await h.done();
  }
});

test('editor preview: under a side panel laid over the right edge (window below the dock width) it is not shown and the toast says to close the panel; closing the panel brings it back', async () => {
  const h = await openEditor(CHART);
  const { ed, sec, key } = h;
  const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  try {
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1000 });
    const pv = sec.querySelector('#edit-preview');
    const cv = sec.querySelector('#edit-canvas');
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(!pv.hidden, 'パネルを閉じていれば出す');
    const w0 = parseFloat(cv.style.width) + parseFloat(pv.style.width);
    sec.querySelector('#edit-panel').click();
    await sleep(5);
    assert(ed.panel.open && !sec.classList.contains('panel-dock'), '寄せずに重ねる');
    assert(pv.hidden && !ed._previewSize, '重ねたパネルの下には出さない');
    assertEq(parseFloat(cv.style.width), w0, '隠れるプレビューのために編集画面を狭めない');
    key('KeyV', { key: 'v' });
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(h.app.config.editPreview && pv.hidden);
    assert(sec.querySelector('#edit-toast').textContent.includes('横のパネルを閉じると'), sec.querySelector('#edit-toast').textContent);
    // 狭い画面(パネルは下から出す)で出せないのはパネルのせいではないので「狭い」
    const main = sec.querySelector('#edit-main');
    main.style.width = '390px';
    ed.onResize();
    key('KeyV', { key: 'v' });
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(ed.view.layout === 'compact' && pv.hidden);
    assert(sec.querySelector('#edit-toast').textContent.includes('画面が狭い'), sec.querySelector('#edit-toast').textContent);
    main.style.width = '';
    ed.onResize();
    // パネルを閉じる(×)と出る
    sec.querySelector('#edit-side .side-close').click();
    await sleep(5);
    assert(!ed.panel.open && !pv.hidden && ed._previewSize);
  } finally {
    if (desc) Object.defineProperty(window, 'innerWidth', desc);
    else delete window.innerWidth;
    await h.done();
  }
});

// ---- プレー動画(js/edit/video.js) ----

/** 動画の好み(localStorage の dojo.editVideo)をテストの間だけ退避する(開発中のアプリと同じ origin なので)。 */
function keepVideoPrefs() {
  const k = 'dojo.editVideo';
  const before = localStorage.getItem(k);
  localStorage.removeItem(k);
  return () => {
    if (before === null) localStorage.removeItem(k);
    else localStorage.setItem(k, before);
  };
}

const BGM_CHART = '#TITLE: v\r\n#BPM: 120\r\n#WAV01: bd.wav\r\n#WAV09: bgm.wav\r\n#BGMWAV: 09\r\n#00101: 0009\r\n#00113: 01000100\r\n';

test('editor video: the button / B show it beside the preview (remembered per chart), empty pane offers a file, the wheel over it scrolls, Ctrl+B does nothing, close hides it', async () => {
  const restore = keepVideoPrefs();
  const h = await openEditor(CHART);
  const { ed, sec, key } = h;
  try {
    const pane = sec.querySelector('#edit-video');
    const btnEl = sec.querySelector('#edit-video-btn');
    const cv = sec.querySelector('#edit-canvas');
    assert(pane.hidden && !ed.video.want, '初めは出さない');
    const w0 = parseFloat(cv.style.width);
    btnEl.click();
    await sleep(5);
    assert(ed.video.want && !pane.hidden && btnEl.classList.contains('on'), '出す');
    assertEq(btnEl.getAttribute('aria-pressed'), 'true');
    const pw = parseFloat(pane.style.width);
    assert(pw >= VIDEO_MIN_W, 'pane ' + pw);
    assertEq(parseFloat(cv.style.width), w0 - pw, '編集画面がその分狭くなる');
    assert(sec.querySelector('#edit-video-msg').textContent.includes('プレー動画を選ぶ'), '選ぶ案内');
    assert([...sec.querySelectorAll('#edit-video-msg button')].some((b) => b.textContent.includes('ファイルを選ぶ')), '選ぶボタン');
    assert(sec.querySelector('#edit-video-back').disabled && sec.querySelector('#edit-video-align').disabled, '動画が無ければずれは触れない');
    const prefs = JSON.parse(localStorage.getItem('dojo.editVideo'));
    assert(prefs.charts[ed.video.key].shown === true, '譜面ごとに覚える');
    // プレビューも出すと、右のバー・プレビュー・動画の順に並び、編集画面は広い配置のまま
    key('KeyV', { key: 'v' });
    await sleep(5);
    const pv = sec.querySelector('#edit-preview');
    const rail = sec.querySelector('#edit-rail');
    if (!pv.hidden) {
      assert(pv.getBoundingClientRect().right <= pane.getBoundingClientRect().left + 0.5, 'プレビューの右に動画');
      assert(rail.getBoundingClientRect().right <= pv.getBoundingClientRect().left + 0.5);
      const avail = sec.querySelector('#edit-stage').clientWidth - rail.offsetWidth;
      if (avail >= COMPACT_BELOW + 160 + VIDEO_MIN_W) assert(ed.view.layout === 'wide' && parseFloat(cv.style.width) >= COMPACT_BELOW, ed.view.layout + ' ' + cv.style.width);
    }
    key('KeyV', { key: 'v' });
    await sleep(5);
    // 上でのホイールは譜面を送る
    const u0 = ed.view.uHead;
    pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    ed._frame(performance.now());
    assert(Math.abs(ed.view.uHead - (u0 + 1)) < 1e-9, String(ed.view.uHead));
    // Ctrl+B は何もしない、B でしまう(覚える)
    key('KeyB', { key: 'b', ctrl: true });
    assert(ed.video.want);
    key('KeyB', { key: 'b' });
    await sleep(5);
    assert(!ed.video.want && pane.hidden && !btnEl.classList.contains('on'));
    assertEq(parseFloat(cv.style.width), w0);
    assertEq(JSON.parse(localStorage.getItem('dojo.editVideo')).charts[ed.video.key].shown, false);
    // 見出しの × でもしまう
    key('KeyB', { key: 'b' });
    await sleep(5);
    sec.querySelector('#edit-video-close').click();
    await sleep(5);
    assert(!ed.video.want && pane.hidden);
    // 狭い画面では出さずに知らせる(出すことは覚えておき、広げると出る)
    const main = sec.querySelector('#edit-main');
    main.style.width = '500px';
    key('KeyB', { key: 'b' });
    await sleep(5);
    assert(ed.video.want && pane.hidden);
    assert(sec.querySelector('#edit-toast').textContent.includes('画面が狭い'), sec.querySelector('#edit-toast').textContent);
    main.style.width = '';
    ed.onResize();
    assert(!pane.hidden, '広げると出る');
    await ed.close();
    assert(pane.hidden, '閉じるとしまう');
  } finally {
    await h.done();
    restore();
  }
});

test('editor video: a file — frame / Shift / Alt offset steps and a typed offset, kept per file from the BGM start (moving the BGM moves the video), align without sounds says so, closing revokes the URL and reopening keeps the file, detach hides', async () => {
  const restore = keepVideoPrefs();
  const h = await openEditor(BGM_CHART);
  const { ed, sec, key } = h;
  const revoked = [];
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked.push(u); revoke.call(URL, u); };
  let ed2 = null;
  try {
    key('KeyB', { key: 'b' });
    await sleep(5);
    // 再生できない中身(形式のエラーになる)でも、ずれは触れる
    const f = new File([new Uint8Array(64)], 'play.mp4', { type: 'video/mp4' });
    ed.video.useFile(f);
    await sleep(5);
    const url = ed.video.url;
    assert(url && url.startsWith('blob:'), 'object URL');
    assertEq(sec.querySelector('#edit-video-src').textContent, 'play.mp4');
    assertEq(sec.querySelector('#edit-video-off').textContent, '+0.0 ms');
    for (let i = 0; i < 40 && !ed.video.err; i++) await sleep(25);
    assert(ed.video.err, '読めない動画はエラー');
    assert(sec.querySelector('#edit-video-msg').textContent.includes('動画を読めません'), sec.querySelector('#edit-video-msg').textContent);
    const off = () => ed.video.offsetMs();
    sec.querySelector('#edit-video-fwd').click();
    assert(Math.abs(off() - 1000 / 60) < 1e-3, '1 コマ ' + off());
    sec.querySelector('#edit-video-back').dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    assert(Math.abs(off() - (1000 / 60 - 10000 / 60)) < 1e-3, '10 コマ ' + off());
    sec.querySelector('#edit-video-fwd').dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
    assert(Math.abs(off() - (1000 / 60 - 10000 / 60 + 1)) < 1e-3, '1 ms ' + off());
    // 値を押すと数で入れる
    sec.querySelector('#edit-video-off').click();
    await sleep(5);
    const dlg = h.dialog();
    assert(dlg.open, 'ダイアログ');
    dlg.querySelector('input').value = '1563.5';
    await h.dialogButton('ok');
    await sleep(5);
    assert(Math.abs(off() - 1563.5) < 1e-9, String(off()));
    assertEq(sec.querySelector('#edit-video-off').textContent, '+1563.5 ms');
    // 覚えているのは BGM の頭の動画の時刻(BGM を動かすと、ずれ(譜面の時刻との差)はその分だけ変わる)
    const a0 = bgmAnchorMs(ed.model.chart);
    assert(a0 > 0, 'BGM がある');
    ed._commit(() => opShiftBgm(ed.model, 250), { label: 'edit.bgmShift', keepSel: true });
    const a1 = bgmAnchorMs(ed.model.chart);
    assert(a1 > a0 + 200, 'BGM が動いた ' + a0 + ' → ' + a1);
    assert(Math.abs(off() - (1563.5 - (a1 - a0))) < 1e-6, 'BGM と一緒に動く ' + off());
    const p = JSON.parse(localStorage.getItem('dojo.editVideo')).charts[ed.video.key];
    assertEq(p.cur, 'play.mp4|64');
    assert(Math.abs(p.files['play.mp4|64'].syncMs - (1563.5 + a0)) < 1e-6, '動画ごとに BGM の頭の時刻を覚える');
    // 譜面の音が読めていなければ合わせられない
    await ed.video.alignByAudio();
    assert(sec.querySelector('#edit-toast').textContent.includes('譜面の音(BGM など)を読めていない'), sec.querySelector('#edit-toast').textContent);
    // 閉じると URL を捨て、開き直すと同じファイル(このページだけ覚える)
    await ed.close();
    assert(revoked.includes(url), 'object URL を捨てる');
    assert(!sec.querySelector('#edit-video-el').hasAttribute('src'), 'src を外す');
    ed2 = new EditorScreen(h.app, h.session, ed.skin, {});
    await ed2.open();
    assert(ed2.video.file === f && ed2.video.want && !sec.querySelector('#edit-video').hidden, '同じファイルで開く');
    assert(Math.abs(ed2.video.offsetMs() - (1563.5 - (a1 - a0))) < 1e-6);
    // 外すとしまう(ずれは動画ごとに残す)
    ed2.video.detach();
    await sleep(5);
    assert(!ed2.video.file && !ed2.video.want && sec.querySelector('#edit-video').hidden);
    assert(sec.querySelector('#edit-toast').textContent.includes('外しました'));
    const p2 = JSON.parse(localStorage.getItem('dojo.editVideo')).charts[ed2.video.key];
    assertEq(p2.cur, null);
    assert(p2.files['play.mp4|64'], 'ずれは残す');
  } finally {
    URL.revokeObjectURL = revoke;
    if (ed2) await ed2.close();
    else await ed.close();
    await h.cleanup();
    restore();
  }
});

test('editor video: crop — drag a rectangle (Enter applies, Esc cancels, 全体 removes it), the pane width follows the cropped aspect', async () => {
  const restore = keepVideoPrefs();
  const h = await openEditor(CHART);
  const { ed, sec, key } = h;
  try {
    key('KeyB', { key: 'b' });
    await sleep(5);
    ed.video.useFile(new File([new Uint8Array(64)], 'wide.mp4', { type: 'video/mp4' }));
    for (let i = 0; i < 40 && !ed.video.err; i++) await sleep(25);
    // 大きさだけ分かった動画にする(読めない中身なので、合わせ方は止まったまま)
    ed.video.err = null;
    ed.video.sync.meta = { dur: 60, vw: 1280, vh: 720 };
    ed.onResize();
    ed._frame(performance.now());
    const pane = sec.querySelector('#edit-video');
    const body = sec.querySelector('#edit-video-body');
    const stage = sec.querySelector('#edit-stage');
    const avail = stage.clientWidth - sec.querySelector('#edit-rail').offsetWidth;
    const exp = (asp) => Math.max(VIDEO_MIN_W, Math.min(Math.round((stage.clientHeight - VIDEO_HEAD_H) * asp) + 1, Math.floor(avail * 0.45)));
    const wFull = parseFloat(pane.style.width);
    assertEq(wFull, exp(16 / 9), '横長はそのままの縦横比(場所の 45 % まで)');
    sec.querySelector('#edit-video-crop').click();
    await sleep(5);
    const cropper = sec.querySelector('#edit-video-cropper');
    assert(!cropper.hidden, '切り出しを始める');
    const box = ed.video._box;
    const r = body.getBoundingClientRect();
    const pt = (fx, fy) => ({ clientX: r.left + box.left + fx * box.width, clientY: r.top + box.top + fy * box.height });
    const ptr = (type, p) => cropper.dispatchEvent(new PointerEvent(type, { pointerId: 3, bubbles: true, ...p }));
    ptr('pointerdown', pt(0.25, 0));
    ptr('pointermove', pt(0.5, 0.5));
    ptr('pointermove', pt(0.7, 1));
    ptr('pointerup', pt(0.7, 1));
    // Esc でやめる
    key('Escape');
    await sleep(5);
    assert(cropper.hidden && !ed.video._filePrefs(false).crop, 'やめれば変えない');
    sec.querySelector('#edit-video-crop').click();
    await sleep(5);
    ptr('pointerdown', pt(0.25, 0));
    ptr('pointermove', pt(0.7, 1));
    ptr('pointerup', pt(0.7, 1));
    key('Enter');
    await sleep(5);
    const c = ed.video._filePrefs(false).crop;
    assert(c && Math.abs(c.x - 0.25) < 0.01 && Math.abs(c.w - 0.45) < 0.01 && c.y < 0.01 && c.h > 0.99, JSON.stringify(c));
    assert(cropper.hidden);
    assertEq(parseFloat(pane.style.width), exp((1280 * c.w) / (720 * c.h)), '切り出した縦横比で枠の幅');
    // 切り出した範囲が枠いっぱい(横か縦のどちらかが枠の大きさ)
    const v = sec.querySelector('#edit-video-el');
    const vw = parseFloat(v.style.width);
    const vh = parseFloat(v.style.height);
    assert(Math.abs(vw * c.w - body.clientWidth) < 1 || Math.abs(vh * c.h - body.clientHeight) < 1, `${vw}x${vh} in ${body.clientWidth}x${body.clientHeight}`);
    // 押しただけ(小さすぎる)では前の囲みのまま、「全体」で外す
    sec.querySelector('#edit-video-crop').click();
    await sleep(5);
    ptr('pointerdown', pt(0.5, 0.5));
    ptr('pointerup', pt(0.5, 0.5));
    assert(ed.video._crop.draft && Math.abs(ed.video._crop.draft.x - c.x) < 1e-9, '前の囲み');
    cropper.querySelector('button[data-act="full"]').click();
    await sleep(5);
    assert(!ed.video._filePrefs(false).crop && cropper.hidden, '全体');
    assertEq(parseFloat(pane.style.width), wFull);
    // 切り出しの間に枠が隠れたら切り出しをやめ、Enter・Esc は取らない
    sec.querySelector('#edit-video-crop').click();
    await sleep(5);
    assert(ed.video._crop);
    sec.querySelector('#edit-main').style.width = '500px';
    ed.onResize();
    assert(sec.querySelector('#edit-video').hidden && !ed.video._crop, '隠れたらやめる');
    const e = key('Enter');
    assert(!e.defaultPrevented, 'Enter は取らない');
    sec.querySelector('#edit-main').style.width = '';
    ed.onResize();
  } finally {
    if (ed.video.file) ed.video.detach();
    await h.done();
    restore();
  }
});

test('editor video: under a side panel laid over the right edge it is not shown (toast says to close the panel); with the preview and too little room it says to hide the preview', async () => {
  const restore = keepVideoPrefs();
  const h = await openEditor(CHART);
  const { ed, sec, key } = h;
  const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  try {
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1000 });
    const pane = sec.querySelector('#edit-video');
    const main = sec.querySelector('#edit-main');
    main.style.width = '1000px';
    ed.onResize();
    key('KeyB', { key: 'b' });
    await sleep(5);
    assert(!pane.hidden, 'パネルを閉じていれば出す');
    sec.querySelector('#edit-panel').click();
    await sleep(5);
    assert(ed.panel.open && !sec.classList.contains('panel-dock') && pane.hidden, '重ねたパネルの下には出さない');
    key('KeyB', { key: 'b' });
    key('KeyB', { key: 'b' });
    await sleep(5);
    assert(sec.querySelector('#edit-toast').textContent.includes('横のパネルを閉じると、動画'), sec.querySelector('#edit-toast').textContent);
    sec.querySelector('#edit-side .side-close').click();
    await sleep(5);
    assert(!pane.hidden, 'パネルを閉じると出る');
    // プレビューと両方は入らない幅: プレビューが先で、動画はプレビューをしまえば出る
    main.style.width = '720px';
    ed.onResize();
    key('KeyV', { key: 'v' });
    await sleep(5);
    key('KeyB', { key: 'b' });
    key('KeyB', { key: 'b' });
    await sleep(5);
    assert(!sec.querySelector('#edit-preview').hidden && pane.hidden, 'プレビューが先');
    assert(sec.querySelector('#edit-toast').textContent.includes('プレビュー(V)をしまうと'), sec.querySelector('#edit-toast').textContent);
    key('KeyV', { key: 'v' });
    await sleep(5);
    assert(!pane.hidden, 'プレビューをしまうと出る');
  } finally {
    if (desc) Object.defineProperty(window, 'innerWidth', desc);
    else delete window.innerWidth;
    await h.done();
    restore();
  }
});

/** 16 bit・1 本の WAV(音だけの「動画」。<video> も decodeAudioData も読める)。 */
function wavBytes(pcm, sr) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Uint8Array(buf);
}

/** 減衰する短い音をばらばらの間隔で並べた音(決まった乱数)。 */
function clickTrack(secs, sr, seed = 3) {
  let x = seed;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const out = new Float32Array(Math.round(secs * sr));
  for (let t = 0.1; t < secs - 0.2; t += 0.12 + rnd() * 0.35) {
    const at = Math.round(t * sr);
    const f = 300 + rnd() * 1200;
    const amp = 0.3 + 0.6 * rnd();
    for (let i = 0; i < sr * 0.08 && at + i < out.length; i++) out[at + i] += amp * Math.exp(-i / (sr * 0.015)) * Math.sin((2 * Math.PI * f * i) / sr);
  }
  return out;
}

test('editor video: aligning by sound stores the video time of the BGM start (undo forgets it); the target is (chart ms + offset) / 1000 from the playhead when stopped and from the player clock when playing', async () => {
  const restore = keepVideoPrefs();
  const h = await openEditor(BGM_CHART);
  const { ed, sec, key, app } = h;
  try {
    const sr = 8000;
    const bgm = clickTrack(8, sr);
    const ab = new OfflineAudioContext(1, 1, sr).createBuffer(1, bgm.length, sr);
    ab.copyToChannel(bgm, 0);
    app.audio.buffers.set('09', ab);
    // 「動画」: 1.7 秒の前置き(別の音)の後に BGM が始まる
    const lagMs = 1700;
    const rec = new Float32Array(Math.round(11 * sr));
    rec.set(clickTrack(1.5, sr, 99));
    rec.set(bgm.subarray(0, rec.length - Math.round((lagMs / 1000) * sr)), Math.round((lagMs / 1000) * sr));
    key('KeyB', { key: 'b' });
    await sleep(5);
    ed.video.useFile(new File([wavBytes(rec, sr)], 'rec.wav', { type: 'audio/wav' }));
    for (let i = 0; i < 200 && !ed.video.lastAlign; i++) await sleep(50);
    const la = ed.video.lastAlign;
    assert(la && la.ok, '初めての動画はひとりでに音で合わせる: ' + JSON.stringify(la));
    const fp = () => JSON.parse(localStorage.getItem('dojo.editVideo')).charts[ed.video.key].files['rec.wav|' + (44 + rec.length * 2)];
    assert(Math.abs(fp().syncMs - lagMs) < 2, '覚えるのは BGM の頭の動画の時刻: ' + fp().syncMs);
    const anchor = bgmAnchorMs(ed.model.chart);
    assertEq(anchor, 5000, 'リードイン 2000 + 小節 001 の半ば');
    assert(Math.abs(ed.video.offsetMs() - (lagMs - anchor)) < 2, String(ed.video.offsetMs()));
    const toast = sec.querySelector('#edit-toast');
    assert(toast.textContent.includes('音で合わせました'), toast.textContent);
    // 止まっているとき: 再生位置の譜面の時刻 + ずれ(u = 1.5 は BGM の頭なので的は BGM の頭の動画の時刻)
    let got = null;
    ed.video.sync.sync = (now, c) => { got = c; };
    ed.view.uHead = 1.5;
    ed._frame(performance.now());
    assert(got && !got.playing && Math.abs(got.tg * 1000 - fp().syncMs) < 1e-6, JSON.stringify(got));
    // 再生中: 編集の再生の時計(EditorPlayer.videoClock)と鳴らしている譜面
    const p = ed.player;
    ed._preparePlayer();
    p.videoClock = () => ({ ms: 7000, holdMs: 12 });
    const st = p.state;
    p.state = PLAYER_STATE.PLAYING;
    try {
      ed.video.frame(performance.now());
    } finally {
      p.state = st;
      delete p.videoClock;
    }
    assert(got.playing && got.hold === 12 && Math.abs(got.tg * 1000 - (7000 + fp().syncMs - anchor)) < 1e-6, JSON.stringify(got));
    // 合わせたのを元に戻すと、ずれを覚えていない形に戻る
    const undo = toast.querySelector('button');
    assert(undo, '元に戻すボタン');
    undo.click();
    assert(!Number.isFinite(fp().syncMs) && ed.video.offsetMs() === 0, JSON.stringify(fp()));
  } finally {
    if (ed.video.file) ed.video.detach();
    await h.done();
    restore();
  }
});

test('editor video: the player clock for the video holds the start position until the first sound is heard and gives the time left', () => {
  const p = new EditorPlayer({ audio: fakeAudio() });
  const now = performance.now();
  p.state = PLAYER_STATE.PLAYING;
  p.ratio = 1;
  p._anchorSong = 3000;
  p._anchorReal = now + 40;
  let c = p.videoClock();
  assertEq(c.ms, 3000, '音が聞こえ始めるまでは開始位置');
  assert(c.holdMs > 30 && c.holdMs <= 40, String(c.holdMs));
  p._anchorReal = now - 100;
  c = p.videoClock();
  assertEq(c.holdMs, 0);
  assert(Math.abs(c.ms - p.songMs) < 2 && c.ms >= 3100 - 1, String(c.ms));
  p.state = PLAYER_STATE.STANDBY;
  assert(Number.isNaN(p.videoClock().holdMs), '止まっていれば残りは分からない');
});
