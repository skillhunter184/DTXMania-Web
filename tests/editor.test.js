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

/** 編集画面を開く。終わったら done() で片付ける。 */
async function openEditor(text = null) {
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
    const e = new KeyboardEvent('keydown', { code, key: o.key || '', ctrlKey: !!o.ctrl, shiftKey: !!o.shift, bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    return e;
  };
  const chips = (ch) => ed.model.chips.filter((c) => c.channel === ch).map((c) => `${c.measure}:${c.tick}`);
  const cleanup = async () => {
    sec.remove();
    css.remove();
    await deleteDraft(pkg, chartRef.path);
  };
  const done = async () => {
    await ed.close();
    await cleanup();
  };
  return { ed, sec, pkg, chartRef, app, calls, at, ptr, click, key, chips, done, cleanup, session };
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
    key('BracketLeft');
    assertEq(ed.view.guide, 12, '[ で粗く');
    key('BracketRight');
    key('BracketRight');
    assertEq(ed.view.guide, 24, '] で細かく');
    const z = ed.view.zoom;
    key('Equal');
    assert(ed.view.zoom > z, '+ で拡大');
    key('Minus');
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
