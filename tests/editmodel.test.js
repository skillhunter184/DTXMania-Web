// 譜面の編集の中身(レーン・座標・モデル・操作・履歴・セッション・下書き)のテスト。画面は editview / editor のテスト。
import { test, assert, assertEq, assertNear, assertDeepEq, fetchBytes } from './runner.js';
import { parseDTX, replayRandom } from '../js/core/dtx.js';
import { encodeShiftJis, decodeText } from '../js/core/encoding.js';
import { SongPackage } from '../js/core/song.js';
import { DtxDoc } from '../js/edit/dtxdoc.js';
import { MeasureGeometry, GUIDES, nearestZoom } from '../js/edit/geometry.js';
import {
  COLUMN_TYPES, COLUMN_OF, TYPE_OF, conflicts, channelsConflict, otherType, defaultPens, defaultActiveTypes, freeWavId, padChannel,
} from '../js/edit/lanes.js';
import { EditModel } from '../js/edit/model.js';
import {
  EditError, opPlace, opPaint, opDelete, opMove, opSetType, opAddPartner, opSetValue, clampMove,
} from '../js/edit/ops.js';
import { EditHistory } from '../js/edit/history.js';
import { EditSession } from '../js/edit/session.js';
import { saveDraft, loadDraft, deleteDraft, listDrafts, draftKey } from '../js/edit/drafts.js';
import { EditorPlayer } from '../js/edit/editplayer.js';

const model = (text, rolls = []) => new EditModel(DtxDoc.fromText(text), { rolls });
const notes = (doc) => parseDTX(doc.text).notes.map((n) => `${n.measure}:${n.tick}:${n.channel.toString(16)}:${n.wavId}`).sort().join(' ');
const throwsCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EditError && e.code === code;
  }
  return false;
};

// 小節 001: BD 0/192、SD 96/288、HHC 4 つ、HHO 288(HHC と同じセル)。小節 002: CY と RD が同じセル、ボーナスの SD、
// BPM 150(ch 03)。隠しチップ(0x33)。
const CH1 = [
  '#TITLE: t', '#BPM: 120',
  '#WAV01: bd.wav\t;BD', '#WAV02: sd.wav\t;Snare', '#WAV03: hh.wav\t;Hi-Hat Close', '#WAV05: crash.wav', '#WAV06: ride.wav\t;Ride',
  '#00113: 01000100', '#00112: 00020002', '#00111: 03030303', '#00118: 00000004', '#00133: 07',
  '#00216: 05', '#00219: 06', '#00212: 02', '#0024F: 04', '#00203: 96', '',
].join('\n');

// ---- geometry ----
test('editgeo: u <-> (measure, tick) with bar lengths, nearest snap, steps, lead-in', () => {
  const c = parseDTX('#BPM: 120\n#00202: 0.75\n#00402: 1\n#00511: 01\n');
  const g = new MeasureGeometry(c.tempoMap);
  assertDeepEq([g.len(0), g.len(1), g.len(2), g.len(3), g.len(4), g.len(-1)], [1, 1, 0.75, 0.75, 1, 1]);
  assertDeepEq([g.start(3), g.start(4), g.start(5), g.start(-1)], [2.75, 3.5, 4.5, -1]);
  const loc = g.locate(3.0);
  assertEq(loc.measure, 3);
  assertNear(loc.tickF, 128, 1e-9);
  assertNear(g.u(3, 128), 3.0, 1e-12);
  assertEq(g.measureAt(-0.5), -1);
  // 1/16 の吸着: L = 1 は 24 tick、L = 0.75 は 32 tick。小節の終わりに近い端は次の小節の頭
  assertDeepEq(g.snap(0.53, 16), { measure: 0, tick: 192 });
  assertDeepEq(g.snap(2.75 + 0.70, 16), { measure: 3, tick: 352 });
  assertDeepEq(g.snap(2.75 + 0.74, 16), { measure: 4, tick: 0 });
  assertDeepEq(g.snap(0.5 / 16, 16), { measure: 0, tick: 24 }, '同点は後ろの線');
  assertDeepEq(g.snap(0.5, 0), { measure: 0, tick: 192 }, 'フリー');
  assertEq(g.snap(-0.5, 16), null, 'リードイン');
  // 1/4 の線は parseDTX の拍線と同じ(0.75 小節で 0 / 128 / 256)
  assertDeepEq([0, 0.25, 0.5].map((o) => g.snap(2 + o, 4).tick), [0, 128, 256]);
  // 次 / 前のガイド線
  assertDeepEq(g.step(0, 0, 16, 1), { measure: 0, tick: 24 });
  assertDeepEq(g.step(0, 0, 16, -1), { measure: -1, tick: 360 });
  assertDeepEq(g.step(-1, 0, 16, -1), { measure: -1, tick: 0 });
  assertDeepEq(g.step(3, 352, 16, 1), { measure: 4, tick: 0 });
  assertDeepEq(g.step(4, 0, 16, -1), { measure: 3, tick: 352 });
  assertDeepEq(g.step(0, 383, 0, 1), { measure: 1, tick: 0 });
  assert(GUIDES.includes(16) && nearestZoom(0.9) === 1 && nearestZoom(3) === 2.8);
  // 7/8(0.875)の 1/16 は 14 等分
  const g2 = new MeasureGeometry(parseDTX('#00002: 0.875\n#00011: 01\n').tempoMap);
  assertEq(g2.snap(1 / 16, 16).tick, Math.floor(384 / 14));
});

// ---- lanes ----
test('editlanes: columns, types, conflicts, pen defaults, pad channels', () => {
  assertEq(COLUMN_TYPES.flat().length, 12);
  assertDeepEq([COLUMN_OF.get(0x18), TYPE_OF.get(0x18), COLUMN_OF.get(0x1c), COLUMN_OF.get(0x19), TYPE_OF.get(0x19)], [1, 1, 2, 8, 1]);
  assert(channelsConflict(0x11, 0x18) && channelsConflict(0x12, 0x12));
  assert(!channelsConflict(0x16, 0x19) && !channelsConflict(0x1b, 0x1c), 'LP+LBD・CY+RD は並べて置ける');
  assert(conflicts({ measure: 1, tick: 0, channel: 0x11 }, { measure: 1, tick: 0, channel: 0x18 }));
  assert(!conflicts({ measure: 1, tick: 0, channel: 0x11 }, { measure: 1, tick: 1, channel: 0x18 }));
  assertEq(otherType(0x16), 0x19);
  assertEq(otherType(0x12), null);
  const counts = new Map([[0x13, new Map([['0A', 1], ['0B', 3]])], [0x16, new Map([['05', 2]])]]);
  const wavs = [{ id: '01', file: 'kick.wav', label: '' }, { id: '02', file: 'Snare1.ogg', label: '' }, { id: '03', file: 'x.wav', label: 'Ride' }];
  const pens = defaultPens(counts, wavs, new Set(['01', '02', '03', '05', '0A', '0B']));
  assertEq(pens.get(0x13), '0B', 'いちばん多い値');
  assertEq(pens.get(0x12), '02', 'ファイル名の言葉');
  assertEq(pens.get(0x19), '03', 'ラベルの言葉');
  assertEq(pens.get(0x1c), '01', 'LBD は kick');
  // 空いている番号は列の順(LC → HHC → HHO → LP …)に小さい方から取る
  assertDeepEq([pens.get(0x1a), pens.get(0x11), pens.get(0x18), pens.get(0x1b), pens.get(0x14), pens.get(0x15)], ['04', '06', '07', '08', '09', '0C']);
  assertEq(freeWavId(new Set(['01', '02'])), '03');
  assertDeepEq(defaultActiveTypes(new Map([[0x18, 3], [0x11, 1], [0x19, 1]])), [0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const active = [0, 1, 0, 0, 0, 0, 0, 0, 1];
  assertDeepEq([padChannel(1, 'key', active), padChannel(8, 'midi', active), padChannel(9, 'midi', active), padChannel(8, 'touch', active)], [0x18, 0x16, 0x19, 0x19]);
});

// ---- model ----
test('editmodel: chips, split halves, bonus, hidden, BPM marks, pens and active types', () => {
  const m = model(CH1);
  assertEq(m.chips.length, 12);
  const at = (ch, measure, tick) => m.chips.find((c) => c.channel === ch && c.measure === measure && c.tick === tick);
  assertEq(at(0x11, 1, 288).half, 1, 'HHC と HHO が同じセル');
  assertEq(at(0x18, 1, 288).half, 2);
  assertEq(at(0x11, 1, 0).half, 0);
  assertEq(at(0x16, 2, 0).half, 1, 'CY と RD');
  assertEq(at(0x19, 2, 0).half, 2);
  assert(at(0x12, 2, 0).bonus && !at(0x12, 1, 96).bonus, 'ボーナスの印');
  assertDeepEq(m.hidden.map((h) => [h.measure, h.tick, h.column]), [[1, 0, 5]]);
  assertDeepEq(m.bpmMarks.map((b) => [b.measure, b.tick, b.channel, b.bpm]), [[2, 0, 3, 150]]);
  assertEq(m.chip(at(0x13, 1, 192).key), at(0x13, 1, 192));
  assertEq(m.byColumn[1].length, 5);
  // 列 1 の u = 1.5 に近いチップ(HHC 1:192)
  const g = m.geometry;
  assertEq(m.chipAt(1, g.u(1, 190), 0.05).tick, 192);
  assertEq(m.chipAt(1, g.u(1, 288), 0.05, 2).channel, 0x18, '右半分は HHO');
  assertEq(m.cellChips(8, 2, 0).length, 2);
  const s = new EditSession({ pkg: null, song: null, chartRef: { path: 'a/b.dtx' }, originalBytes: encodeShiftJis(CH1) });
  assertDeepEq([...s.pens].sort((a, b) => a[0] - b[0]).map(([ch, v]) => ch.toString(16) + '=' + v),
    ['11=03', '12=02', '13=01', '14=09', '15=0A', '16=05', '17=0B', '18=04', '19=06', '1a=05', '1b=08', '1c=01']);
  assertDeepEq(s.activeTypes, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertEq(m.wavList.length, 5);
  assertEq(m.wavList[2].label, 'Hi-Hat Close');
});

test('editmodel: #IF chips are locked; the shown branch follows the replayed rolls', () => {
  const src = '#RANDOM 2\n#IF 1\n#00113: 01\n#ENDIF\n#IF 2\n#00112: 02\n#ENDIF\n#00111: 03\n';
  const first = model(src);
  const lock = first.chips.filter((c) => c.locked);
  assertDeepEq(lock.map((c) => [c.channel, c.active]), [[0x12, false], [0x13, true]]);
  assertDeepEq(lock.filter((c) => c.active).map((c) => c.channel), [0x13], '分岐 1');
  const played = model(src, [0.7]);
  assertDeepEq(played.chips.filter((c) => c.locked && c.active).map((c) => c.channel), [0x12], '演奏していた分岐 2');
  assertEq(first.chip(lock[0].key), null, '#IF の中は名前で引けない');
  // 表示している分岐のチップとぶつかる置き方はしない。違うチャンネルなら置ける
  assert(throwsCode(() => opPlace(first, { measure: 1, tick: 0, channel: 0x13, value: '09' }), 'locked'));
  const r = opPlace(first, { measure: 1, tick: 0, channel: 0x12, value: '09' });
  // 新しい行は #IF の外(キーがすぐ下の #IF の外の組 00111 の後ろ)
  assert(r.doc.text.endsWith('#ENDIF\n#00111: 03\n#00112: 09\n'), 'new line outside the block: ' + JSON.stringify(r.doc.text));
});

// ---- ops ----
test('editops: place (new group in place, HHC→HHO replace, LP+LBD coexist, identical = same doc, measure limit)', () => {
  const m = model(CH1);
  const sd = opPlace(m, { measure: 1, tick: 0, channel: 0x12, value: '02' });
  assert(sd.doc.text.includes('#00112: 02020002\n'), sd.doc.text);
  assertEq(sd.doc.text.replace('#00112: 02020002', '#00112: 00020002'), m.doc.text, 'only the SD line changed');
  assertEq(sd.select.length, 1);
  const hho = opPlace(m, { measure: 1, tick: 0, channel: 0x18, value: '04' });
  assertEq(hho.replaced, 1);
  assert(hho.doc.text.includes('#00111: 00030303') && hho.doc.text.includes('#00118: 04000004'), hho.doc.text);
  const lbd = opPlace(m, { measure: 1, tick: 0, channel: 0x1c, value: '01' });
  const both = opPlace(new EditModel(lbd.doc), { measure: 1, tick: 0, channel: 0x1b, value: '08' });
  assert(both.doc.text.includes('#0011C: 01') && both.doc.text.includes('#0011B: 08'), 'LP と LBD は並ぶ');
  assertEq(opPlace(m, { measure: 1, tick: 0, channel: 0x13, value: '01' }).doc, m.doc, '同じチップ');
  assert(throwsCode(() => opPlace(m, { measure: 1000, tick: 0, channel: 0x13, value: '01' }), 'measureLimit'));
  // 置いた結果を parseDTX で読むと 1 個増えている
  assertEq(parseDTX(sd.doc.text).notes.length, parseDTX(m.doc.text).notes.length + 1);
});

test('editops: delete by key (one of two duplicates), paint is one doc, set value', () => {
  const m = model('#00113: 01\n#00113: 01\n#00112: 02\n');
  const dups = m.chips.filter((c) => c.channel === 0x13);
  assertDeepEq(dups.map((c) => [c.n, c.dup]), [[0, 2], [1, 2]]);
  const d = opDelete(m, [dups[1].key]);
  assertEq(d.doc.text, '#00113: 01\n#00112: 02\n');
  const p = opPaint(m, [0, 96, 192].map((tick) => ({ measure: 3, tick, channel: 0x12, value: '02' })));
  // 新しい組はキーがすぐ下の組(00113)の後ろ
  assertEq(p.doc.text, '#00113: 01\n#00113: 01\n#00312: 02020200\n#00112: 02\n');
  assertEq(p.select.length, 3);
  const v = opSetValue(m, [m.chips.find((c) => c.channel === 0x12).key], '0Z');
  assert(v.doc.text.includes('#00112: 0Z'));
});

test('editops: move (beat kept across bar lengths, block clamp, cross-column re-voicing, moved wins, partners survive)', () => {
  const m = model('#WAV01: bd.wav\n#00102: 1\n#00202: 0.75\n#00111: 0001\n#00113: 00000001\n#00112: 00000100\n#00216: 05\n#00219: 0006\n#00311: 03\n#00318: 04\n');
  const pens = new Map([[0x14, '0H'], [0x12, '02'], [0x16, '05'], [0x19, '06']]);
  const active = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const bd = m.chips.find((c) => c.channel === 0x13); // 1:288
  const r1 = opMove(m, [bd.key], { du: 0.25, dcol: 0, pens, activeTypes: active });
  assert(r1.doc.text.includes('#00213: 01'), '1:288 + 1 拍 = 2:0 ' + r1.doc.text);
  const sd = m.chips.find((c) => c.channel === 0x12); // 1:192 (u 1.5)
  const r2 = opMove(m, [sd.key], { du: 0.75, dcol: 0, pens, activeTypes: active });
  const moved = new EditModel(r2.doc).chips.find((c) => c.channel === 0x12);
  assertDeepEq([moved.measure, moved.tick], [2, 128], '0.75 小節の中でも拍の位置');
  // ブロックで寄せる: 小節 001 の頭より前(リードイン)へは出ない
  assertDeepEq(clampMove(m, [sd.key], -10, 0), { du: -sd.u, dcol: 0 });
  assertDeepEq(clampMove(m, [sd.key], 0, 9), { du: 0, dcol: 5 });
  // 列を移ると移った先の今の種類とペンの音。keepValue なら値を残す
  const r3 = opMove(m, [sd.key], { du: 0, dcol: 1, pens, activeTypes: active });
  assert(r3.doc.text.includes('#00114: 000H') && !r3.doc.text.includes('#00112'), r3.doc.text);
  const r4 = opMove(m, [sd.key], { du: 0, dcol: 1, pens, activeTypes: active, keepValue: true });
  assert(r4.doc.text.includes('#00114: 0001'), r4.doc.text);
  // HHC(1:192)を HHC と HHO のある 3:0 へ: どちらも消える(動かした方が勝つ)
  const hh = m.chips.find((c) => c.channel === 0x11 && c.measure === 1);
  const r5 = opMove(m, [hh.key], { du: 2.75 - 1.5, dcol: 0, pens, activeTypes: active });
  assertEq(r5.removed, 2, '3:0 の HHC と HHO');
  // RD を CY のセルへ動かしても CY は残る
  const rd = m.chips.find((c) => c.channel === 0x19);
  const r6 = opMove(m, [rd.key], { du: -0.375, dcol: 0, pens, activeTypes: active });
  assertEq(r6.removed, 0);
  assert(r6.doc.text.includes('#00216: 05') && r6.doc.text.includes('#00219: 06'), r6.doc.text);
  assertEq(opMove(m, [rd.key], { du: 0, dcol: 0, pens, activeTypes: active }).doc, m.doc, '動かさなければ同じ文書');
});

test('editops: switch type takes the pen (keepValue keeps it), add partner beside LP / CY', () => {
  const m = model(CH1);
  const pens = new Map([[0x18, '04'], [0x11, '03'], [0x1c, '01'], [0x19, '06']]);
  const hhc = m.chips.find((c) => c.channel === 0x11 && c.tick === 0);
  const r = opSetType(m, [hhc.key], { pens });
  assert(r.doc.text.includes('#00111: 00030303') && r.doc.text.includes('#00118: 04000004'), r.doc.text);
  const keep = opSetType(m, [hhc.key], { pens, keepValue: true });
  assert(keep.doc.text.includes('#00118: 03000004'), keep.doc.text);
  const cy = m.chips.find((c) => c.channel === 0x16);
  assertEq(opAddPartner(m, cy.key, { pens }).doc, m.doc, 'RD はもうある');
  const lp = opPlace(m, { measure: 3, tick: 0, channel: 0x1b, value: '08' });
  const lm = new EditModel(lp.doc);
  const p = opAddPartner(lm, lm.chips.find((c) => c.channel === 0x1b).key, { pens });
  assert(p.doc.text.includes('#0031C: 01'), p.doc.text);
});

// ---- history ----
test('edithistory: undo / redo identity, modified / unexported, coalescing, eviction, selection', () => {
  const d0 = DtxDoc.fromText('#00111: 01\n');
  const d1 = d0.withHeader('TITLE', 'a');
  const d2 = d1.withHeader('TITLE', 'b');
  const d3 = d2.withHeader('TITLE', 'c');
  const h = new EditHistory(d0);
  assertEq(h.push(d0), false, '同じ文書は積まない');
  h.push(d1, { label: 'x', select: ['k1'], selectBefore: ['k0'] });
  h.push(d2, { label: 'y' });
  assert(h.modified && h.unexported);
  assertDeepEq(h.undo(), { doc: d1, select: [], focusU: null, label: 'y' });
  const u = h.undo();
  assertEq(u.doc, d0);
  assertDeepEq(u.select, ['k0'], '戻した手が触ったチップを選び直す');
  assert(!h.modified && !h.canUndo && h.canRedo);
  assertEq(h.redo().doc, d1);
  h.markExported();
  assert(h.modified && !h.unexported);
  h.push(d3);
  assert(!h.canRedo, 'やり直しの手は消える');
  // まとめる
  const c = new EditHistory(d0);
  c.push(d1, { coalesceKey: 'n', now: 1000 });
  c.push(d2, { coalesceKey: 'n', now: 1500 });
  assertEq(c.index, 1);
  assertEq(c.doc, d2);
  c.push(d3, { coalesceKey: 'n', now: 3000 });
  assertEq(c.index, 2, '1 秒より後は新しい手');
  const back = new EditHistory(d0);
  back.push(d1, { coalesceKey: 'n', now: 0 });
  back.push(d0, { coalesceKey: 'n', now: 10 });
  assertEq(back.index, 0, '微調整で元に戻ったら手を消す');
  // 古い手から捨てる
  const e = new EditHistory(d0, { maxSteps: 2 });
  e.push(d1);
  e.push(d2);
  e.push(d3);
  assertEq(e.entries.length, 3);
  e.undo();
  e.undo();
  assert(!e.canUndo && e.doc === d1 && e.modified);
});

// ---- dtxdoc の追加 ----
test('dtxdoc: header counts / #IF commands, locked(random) follows IfStack (nested), withLines', () => {
  const doc = DtxDoc.fromText('#WAV01: a\n#WAV01: b\n#RANDOM 1\n#IF 1\n#BPM02: 140\n#00111: 01\n#IF 2\n#00112: 01\n#ENDIF\n#ENDIF\n#BPM01: 120\n');
  const ix = doc.index;
  assertEq(ix.headerCounts.get('WAV01'), 2);
  assertEq(ix.headerCounts.get('BPM01'), 1);
  assert(ix.allCmds.has('WAV01') && ix.ifCmds.has('BPM02') && !ix.allCmds.has('BPM02'));
  assertDeepEq(doc.locked(replayRandom([])).map((l) => [l.channel, l.active]), [[0x11, true], [0x12, false]]);
  const w = doc.withLines(new Map([[0, '#WAV01: c'], [1, null]]), [{ after: -1, texts: ['; top'] }, { after: 10, texts: ['#BPM03: 90'] }]);
  assertEq(w.text, '; top\n#WAV01: c\n#RANDOM 1\n#IF 1\n#BPM02: 140\n#00111: 01\n#IF 2\n#00112: 01\n#ENDIF\n#ENDIF\n#BPM01: 120\n#BPM03: 90\n');
  // 文字コードを替えて書く
  const sj = DtxDoc.fromBytes(new TextEncoder().encode('#TITLE: 題名\n'));
  const out = sj.toBytes({ encoding: 'shift_jis' });
  assert(out.ok && out.changedEncoding && out.encoding === 'shift_jis');
  assertEq(decodeText(out.bytes), '#TITLE: 題名\n');
  assertEq(DtxDoc.fromText('#TITLE: 😀\n', { encoding: 'utf-8' }).toBytes({ encoding: 'shift_jis' }).ok, false);
});

// ---- session / song / drafts ----
test('editsession: commit overlays the package (and removes it when back to the original), refreshHeader, drafts', async () => {
  const pkg = await SongPackage.fromZip((await fetchBytes('fixtures/pack_sjis.zip')).buffer, 'pack-test.zip');
  const song = pkg.songs.find((s) => s.charts.some((c) => c.path === '道場テスト/譜面.dtx'));
  const chartRef = song.charts.find((c) => c.path === '道場テスト/譜面.dtx');
  const originalBytes = await pkg.readOriginalBytes(chartRef.path);
  const s = new EditSession({ pkg, song, chartRef, originalBytes });
  assert(!s.modified && s.sameAsOriginal);
  const before = (await pkg.loadChart(chartRef.path)).notes.length;
  const r = opPlace(s.model, { measure: 20, tick: 0, channel: 0x12, value: '01' });
  assert(s.apply(r, { label: 'place' }));
  assert(s.modified && s.unexported && s.selection.size === 1);
  await s.commit();
  assertEq((await pkg.loadChart(chartRef.path)).notes.length, before + 1, 'test play / the list see the edit');
  assert(pkg.override(chartRef.path), 'overlay set');
  assertEq((await pkg.readOriginalBytes(chartRef.path)).length, originalBytes.length, 'readOriginalBytes ignores the overlay');
  // 下書き
  const key = draftKey(pkg, chartRef.path);
  assert(key.startsWith('draft:pack-test.zip|'));
  assert(await saveDraft(pkg, chartRef.path, s.draftValue()));
  const d = await loadDraft(pkg, chartRef.path);
  assertEq(decodeText(d.bytes), decodeText(s.outputBytes().bytes));
  assert((await listDrafts(pkg)).some((x) => x.path === chartRef.path));
  const resumed = new EditSession({ pkg, song, chartRef, originalBytes, draft: d });
  assert(resumed.modified && resumed.history.canUndo, '下書きは元の譜面の 1 手上');
  assertEq(resumed.doc.text, decodeText(s.outputBytes().bytes));
  await deleteDraft(pkg, chartRef.path);
  assertEq(await loadDraft(pkg, chartRef.path), null);
  // 元に戻すと重ねたものを外す
  s.history.undo();
  await s.commit();
  assertEq(pkg.override(chartRef.path), null);
  // refreshHeader: 重ねた譜面の題名が一覧に出る
  pkg.setOverride(chartRef.path, encodeShiftJis('#TITLE: 直した題名\r\n#00112: 01\r\n'));
  await pkg.refreshHeader(chartRef.path);
  assertEq(chartRef.header.title, '直した題名');
  pkg.setOverride(chartRef.path, null);
});

// ---- 編集画面の再生(EditorPlayer) ----
function fakeAudioClock() {
  let t = 0;
  return {
    ctx: { get currentTime() { return t; } }, outputLatencySec: 0, buffers: new Map(), played: [],
    advance(ms) { t += ms / 1000; },
    async loadChartSounds() { return this.buffers; },
    hasBuffer(id) { return this.buffers.has(id); },
    play(id, opts) { this.played.push({ id, ...opts }); return { src: null }; },
    playBuffer(buf, opts) { this.played.push(opts); return { src: null }; },
    stopVoice() {}, stopAll() {}, synthBuffer(lane) { return { lane }; },
  };
}

test('editplayer: private settings (dojo.training untouched), all AUTO, plays past the last chip until the range end, stops BGM-only charts, setChart keeps loaded sounds', async () => {
  const audio = fakeAudioClock();
  const before = localStorage.getItem('dojo.training');
  const p = new EditorPlayer({ audio, config: {} });
  assert(p.settings.autoPlay && p.settings.startWaitMs === 0 && !p.settings.loop);
  const chart = parseDTX('#BPM: 120\n#WAV01: sd.wav\n#00012: 01\n');
  audio.buffers.set('01', { duration: 0.2 });
  p.setChart({ resolve() { return null; } }, chart);
  p.setRange({ startMaxMs: posToMsSafe(chart, 384 * 10), stopAtMs: 6000 });
  const perf = () => audio.ctx.currentTime * 1000;
  const orig = performance.now;
  performance.now = perf;
  try {
    p.startTrainingAt(1500);
    p.update(perf());
    assertEq(p.state, 'playing');
    audio.advance(700);
    p.update(perf());
    assert(audio.played.some((x) => x.id === '01'), 'SD scheduled by AUTO');
    audio.advance(4000); // 譜面の最後(2000ms)は過ぎたが、範囲の終わり(6000 + 2000)より前
    p.update(perf());
    assertEq(p.state, 'playing', 'keeps playing past the last chip');
    audio.advance(4000);
    p.update(perf());
    assertEq(p.state, 'standby', 'stops after the range end');
    // チップの無い(BGM だけの)譜面も止まる
    const bgmOnly = parseDTX('#BPM: 120\n#WAV0B: bgm.ogg\n#00001: 0B\n');
    p.setChart({ resolve() { return null; } }, bgmOnly);
    p.setRange({ startMaxMs: 10000, stopAtMs: 3000 });
    p.startTrainingAt(0);
    p.update(perf());
    audio.advance(5500);
    p.update(perf());
    assertEq(p.state, 'standby', 'BGM-only chart stops');
    assertEq(audio.buffers.get('01').duration, 0.2, 'setChart does not reload sounds');
  } finally {
    performance.now = orig;
  }
  assertEq(localStorage.getItem('dojo.training'), before, 'dojo.training untouched');
});

function posToMsSafe(chart, pos) {
  return (625 * pos) / chart.bpm;
}
