// 譜面の編集画面(js/edit/editor.js)の結合テスト。index.html の #screen-edit をこのページに差し込み、
// マウス・タッチ・キーの合成イベントで操作して、文書と曲パックへの重ね合わせ・下書きを見る。
import { test, assert, assertEq, fetchBytes } from './runner.js';
import { SongPackage } from '../js/core/song.js';
import { Skin, columnCenterX } from '../js/ui/skin.js';
import { EditSession } from '../js/edit/session.js';
import { EditorScreen } from '../js/edit/editor.js';
import { loadDraft, deleteDraft } from '../js/edit/drafts.js';

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
