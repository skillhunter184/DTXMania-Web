// 譜面の編集の中身(レーン・座標・モデル・操作・履歴・セッション・下書き)のテスト。画面は editview / editor のテスト。
import { test, assert, assertEq, assertNear, assertDeepEq, fetchBytes } from './runner.js';
import { parseDTX, replayRandom, tempoAt } from '../js/core/dtx.js';
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
  opSetBpm, gcBpmKeys, opBarLength, barOverflow, opInsertMeasure, opDeleteMeasure, measureDeleteSummary,
  copyClip, opPaste, opDuplicate, opNudge, opHeader, opSetWav, wavDefinitions, freeWavNumber, opShiftBgm, newChartText,
} from '../js/edit/ops.js';
import { EditHistory } from '../js/edit/history.js';
import { EditSession } from '../js/edit/session.js';
import { saveDraft, loadDraft, deleteDraft, listDrafts, draftKey } from '../js/edit/drafts.js';
import { EditorPlayer } from '../js/edit/editplayer.js';
import { loadSidecar, suspectsOf, suspectOrder } from '../js/edit/sidecar.js';
import { ZipArchive } from '../js/core/zip.js';

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
  // 線の tick が割り切れない小節でも、次の線へ進み(同じ tick に留まらない)、14 本目のあとは次の小節の頭
  const walk = (geo, m, d, dir) => {
    const out = [];
    let c = { measure: m, tick: dir > 0 ? 0 : 0 };
    if (dir < 0) c = { measure: m + 1, tick: 0 };
    for (let i = 0; i < 40; i++) {
      c = geo.step(c.measure, c.tick, d, dir);
      if (c.measure !== m) break;
      out.push(c.tick);
    }
    return { ticks: out, end: c };
  };
  const f = walk(g2, 0, 16, 1);
  assertEq(f.ticks.length, 13, f.ticks.join());
  assert(f.ticks.every((tk, i) => tk === Math.floor((384 * (i + 1)) / 14)), f.ticks.join());
  assertDeepEq(f.end, { measure: 1, tick: 0 });
  assertEq(walk(g2, 0, 16, -1).ticks.reverse().join(), [0, ...f.ticks].join(), '戻りも同じ線');
  const g3 = new MeasureGeometry(parseDTX('#00002: 0.75\n#00011: 01\n').tempoMap);
  const f3 = walk(g3, 0, 12, 1);
  assertEq(f3.ticks.join(), [1, 2, 3, 4, 5, 6, 7, 8].map((k) => Math.floor((384 * k) / 9)).join());
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
  // 999 小節より先へ動かすと、999 小節の最後の tick で止まる(断らない)
  const late = model('#99912: 01\n');
  const lc = late.chips[0];
  const lateMoved = opMove(late, [lc.key], { du: 50, dcol: 0 });
  const mc = new EditModel(lateMoved.doc).chips[0];
  assertEq(`${mc.measure}:${mc.tick}`, '999:383');
  // 塗りは分岐の中のチップとぶつかるセルを飛ばす(塗り全体は捨てない)
  const br = model('#RANDOM 1\n#IF 1\n#00112: 0001\n#ENDIF\n');
  const painted = opPaint(br, [0, 192].map((tick) => ({ measure: 1, tick, channel: 0x12, value: '02' })));
  assertEq(new EditModel(painted.doc).chips.filter((c) => !c.locked && c.channel === 0x12).map((c) => c.tick).join(), '0');
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

// ---- BPM・小節長・小節の挿入 / 削除・貼り付け・複製(P2) ----
const ops2 = (text, rolls = []) => new EditModel(DtxDoc.fromText(text), { rolls });
const bpmAtMeasure = (doc, m, tick = 0) => {
  const c = parseDTX(doc.text);
  return tempoAt(c, (m + 1) * 384 + tick).bpm;
};

test('editops2: BPM changes write ch 08 + #BPMzz (reused by value, #IF-aware allocation), keep ch 03 for integers, header BPM at 000:000', () => {
  const m = ops2('#TITLE: t\n#BPM: 120\n#00111: 01\n');
  const r = opSetBpm(m, { measure: 1, tick: 192, bpm: 150 });
  // 定義はヘッダの #BPM の後ろ(データ行より前)、新しい組は同じ小節のチャンネルの順(08 は 11 の前)
  assertEq(r.doc.text, '#TITLE: t\n#BPM: 120\n#BPM01: 150\n#00108: 0001\n#00111: 01\n');
  assertEq(bpmAtMeasure(r.doc, 1, 192), 150);
  // 同じ値は番号を使い回す / 120 と 120.0001 は別
  const m2 = new EditModel(r.doc);
  const r2 = opSetBpm(m2, { measure: 2, tick: 0, bpm: 150 });
  assert(!r2.doc.text.includes('#BPM02'), 'reused #BPM01');
  assert(r2.doc.text.includes('#00208: 01'));
  const r3 = opSetBpm(m2, { measure: 2, tick: 0, bpm: 150.0001 });
  assert(r3.doc.text.includes('#BPM02: 150.0001'), r3.doc.text);
  // 2 回定義された番号・#IF の中の番号は使わない
  const dup = ops2('#BPM: 120\n#BPM01: 150\n#BPM01: 150\n#IF 1\n#BPM02: 99\n#ENDIF\n#00111: 01\n');
  const r4 = opSetBpm(dup, { measure: 1, tick: 0, bpm: 150 });
  assert(r4.doc.text.includes('#BPM03: 150') && r4.doc.text.includes('#00108: 03'), r4.doc.text);
  // ch 03 の印は整数(1〜255)なら ch 03 のまま、そうでなければ ch 08
  const c3 = ops2('#BPM: 120\n#00103: 78\n#00111: 01\n');
  const mark = c3.bpmMarks[0];
  assertEq(mark.bpm, 120);
  assert(opSetBpm(c3, { measure: 1, tick: 0, bpm: 140 }).doc.text.includes('#00103: 8C'));
  const r5 = opSetBpm(c3, { measure: 1, tick: 0, bpm: 140.5 });
  assert(!r5.doc.text.includes('#00103') && r5.doc.text.includes('#00108: 01') && r5.doc.text.includes('#BPM01: 140.5'), r5.doc.text);
  // #BASEBPM: 定義は差分。曲の BPM(#BPM)は差分にしない
  const base = ops2('#BPM: 120\n#BASEBPM: 100\n#00111: 01\n');
  assert(throwsCode(() => opSetBpm(base, { measure: 1, tick: 0, bpm: 90 }), 'bpmBase'));
  assert(opSetBpm(base, { measure: 1, tick: 0, bpm: 150 }).doc.text.includes('#BPM01: 50'));
  assertEq(opSetBpm(base, { measure: 0, tick: 0, bpm: 130, header: true }).doc.text, '#BPM: 130\n#BASEBPM: 100\n#00111: 01\n');
  assert(throwsCode(() => opSetBpm(m, { measure: 1, tick: 0, bpm: 1000.5 }), 'bpmRange'));
  // 足して使わなくなった #BPMzz は書き出すときに消す(元からある定義は残す)
  const dm = new EditModel(r.doc);
  const del = opDelete(dm, [dm.bpmMarks[0].key]);
  assertEq(gcBpmKeys(del.doc, m.doc).text, '#TITLE: t\n#BPM: 120\n#00111: 01\n');
  const keepOrig = ops2('#BPM: 120\n#BPM01: 150\n#00111: 01\n');
  assertEq(gcBpmKeys(keepOrig.doc, keepOrig.doc).text, keepOrig.doc.text);
});

test('editops2: bar length (this bar only writes the return line; from-here stops at the next change; keep beats vs stretch; refusal with #IF)', () => {
  const m = ops2('#00111: 01000100\n#00113: 00000001\n#00211: 01\n#00402: 0.5\n');
  const one = opBarLength(m, { measure: 1, value: 0.75, scope: 'one', keepBeats: true });
  assertEq(one.removed, 1, 'BD 1:288 → 384 はみ出す');
  // 00102 は同じ小節の 11 の前、00202(戻す行)は 00113 の後ろ(00113 は空になって消える)
  assertEq(one.doc.text, '#00102: 0.75\n#00111: 010001\n#00202: 1\n#00211: 01\n#00402: 0.5\n');
  // 拍の位置: 1:192(3 拍目)は 0.75 小節の 256 tick = 3 拍目のまま
  const c = parseDTX(one.doc.text);
  const hh = c.notes.filter((n) => n.channel === 0x11 && n.measure === 1).map((n) => n.timeMs);
  assertDeepEq(hh, [4000, 5000], '120 BPM: 4000 + 2 拍(1000 ms)');
  const from = opBarLength(m, { measure: 1, value: 0.75, scope: 'from', keepBeats: false });
  assertEq(from.doc.text, '#00102: 0.75\n#00111: 01000100\n#00113: 00000001\n#00211: 01\n#00402: 0.5\n', 'stretch keeps ticks; until bar 004');
  assertEq(barOverflow(m, { measure: 1, value: 0.75 }), 1);
  // 同じ値の行は残す(差分を小さく)
  const same = ops2('#00102: 0.75\n#00202: 0.750\n#00211: 01\n');
  assertEq(opBarLength(same, { measure: 2, value: 0.75 }).doc, same.doc, '変わらなければ同じ文書');
  // #IF の中の ch 02 が関わるなら変えない
  const locked = ops2('#IF 1\n#00302: 0.5\n#ENDIF\n#00111: 01\n');
  assert(throwsCode(() => opBarLength(locked, { measure: 1, value: 0.75 }), 'barLocked'));
  assert(throwsCode(() => opBarLength(m, { measure: 1, value: 0 }), 'barRange'));
});

test('editops2: insert / delete a bar (later chips move by one bar, length and opening tempo carried, summary)', () => {
  const src = '#BPM: 120\n#BPM01: 150\n#00211: 01\n#00202: 0.75\n#00208: 01\n#00311: 02\n';
  const m = ops2(src);
  const ins = opInsertMeasure(m, 2);
  // 新しい 002 は押した小節(0.75、頭で 150 BPM)と同じ。元の 002 は 003 へ
  assert(ins.doc.text.includes('#00302: 0.75') && ins.doc.text.includes('#00202: 0.75'), ins.doc.text);
  assert(ins.doc.text.includes('#00208: 01') && ins.doc.text.includes('#00308: 01'), 'tempo copied');
  const before = parseDTX(m.doc.text).notes.find((n) => n.wavId === '02').timeMs;
  const after = parseDTX(ins.doc.text).notes.find((n) => n.wavId === '02').timeMs;
  assertEq(after - before, 1200, '0.75 小節 @150 BPM = 1200 ms 後ろへ');
  // 消す: 小節 002 の BPM(150)は次の小節の頭へ、後ろの小節の長さも保つ
  const sum = measureDeleteSummary(m, 2);
  assertDeepEq(sum, { drums: 1, bgm: 0, tempo: 1, other: 0, lockedLines: 0, carriedBpm: 150 });
  const del = opDeleteMeasure(m, 2);
  assertEq(del.doc.text, '#BPM: 120\n#BPM01: 150\n#00202: 0.75\n#00208: 01\n#00211: 02\n');
  assertEq(bpmAtMeasure(del.doc, 2), 150);
  // 999 を超える挿入はしない
  assert(throwsCode(() => opInsertMeasure(ops2('#99911: 01\n'), 5), 'measureLimit'));
});

test('editops2: copy / paste keeps beat offsets across bar lengths, pasted chips win, BPM pasted by value; duplicate is bar-relative; nudge', () => {
  const m = ops2('#BPM: 120\n#BPM01: 140\n#00111: 0101\n#00112: 0001\n#00108: 01\n#00302: 0.75\n#00313: 01\n');
  const keys = m.chips.filter((c) => c.measure === 1).map((c) => c.key).concat(m.bpmMarks.map((b) => b.key));
  const clip = copyClip(m, keys);
  assertEq(clip.items.length, 3);
  assertEq(clip.bpm.length, 1);
  assertEq(clip.bpm[0].bpm, 140);
  const geo = m.geometry;
  const r = opPaste(m, clip, { u0: geo.u(3, 0), modelOf: (d) => new EditModel(d) });
  // 0.75 小節に貼っても拍(0.5 小節 = 2 拍)の位置: 384·0.5/0.75 = 256
  assert(r.doc.text.includes('#00311: 010001') && r.doc.text.includes('#00312: 000001'), r.doc.text);
  assert(r.doc.text.includes('#00313: 01'), 'BD stays (different channel)');
  assert(r.doc.text.includes('#00308: 01') && !r.doc.text.includes('#BPM02'), 'BPM 140 reuses #BPM01');
  assertEq(r.select.length, 4);
  // 複製: 選んだ小節の数だけ後ろへ(tick はそのまま)
  const d = opDuplicate(m, m.chips.filter((c) => c.measure === 1).map((c) => c.key));
  assert(d.doc.text.includes('#00211: 0101') && d.doc.text.includes('#00212: 0001'), d.doc.text);
  // 微調整(1 ガイド = 1/16 小節)
  const sd = m.chips.find((c) => c.channel === 0x12);
  const n = opNudge(m, [sd.key], { du: 1 / 16 });
  assertDeepEq(parseDTX(n.doc.text).notes.filter((x) => x.channel === 0x12).map((x) => x.tick), [216]);
  // 選んだ BPM の印も動く
  const bm = opMove(m, [m.bpmMarks[0].key], { du: 0.25, dcol: 0 });
  assert(bm.doc.text.includes('#00108: 00010000'), bm.doc.text);
});

test('editops2: bonus marks follow their chip on move and delete', () => {
  // 0x4F の値 04 = SD(レーン 3)のボーナス
  const m = ops2('#00112: 01\n#0014F: 04\n');
  const sd = m.chips.find((c) => c.channel === 0x12);
  assert(sd.bonus);
  const mv = opMove(m, [sd.key], { du: 0.25, dcol: 1, pens: new Map([[0x14, '07']]), activeTypes: [0, 0, 0, 0, 0, 0, 0, 0, 0] });
  assertEq(mv.doc.text, '#00114: 00070000\n#0014F: 00050000\n', 'HT のボーナス(05)になってついていく');
  assertEq(opDelete(m, [sd.key]).doc.text, '');
});

test('sidecar: the vid2dtx confidence file marks chips below 0.7 (moved chips lose it), visited lowest first; broken files are ignored', async () => {
  const files = new Map([
    ['a.dtx.conf.json', JSON.stringify({ chips: [
      { m: 1, tick: 0, ch: 19, conf: 0.2, why: 'x' }, { m: 1, tick: 192, ch: 19, conf: 0.5, origin_s: 1.5 },
      { m: 1, tick: 96, ch: 17, conf: 0.95 }, { m: 'bad', tick: 0, ch: 19, conf: 0.1 },
    ] })],
    ['b.dtx.conf.json', '{ not json'],
  ]);
  const pkg = { entry: (p) => (files.has(p) ? { name: p } : null), readBytes: async (e) => new TextEncoder().encode(files.get(e.name)) };
  const sc = await loadSidecar(pkg, 'a.dtx');
  assertEq(sc.size, 3);
  assertEq(sc.get('1.0.19').why, 'x');
  assertEq(await loadSidecar(pkg, 'b.dtx'), null);
  assertEq(await loadSidecar(pkg, 'c.dtx'), null);
  const m = model('#00113: 01000100\n#00111: 00030000\n');
  const sus = suspectsOf(m, sc);
  assertEq(sus.size, 2);
  assertEq(suspectOrder(m, sus).map((x) => `${x.chip.tick}:${x.conf}`).join(), '0:0.2,192:0.5');
  const moved = model(opMove(m, [m.chips.find((c) => c.channel === 0x13 && c.tick === 0).key], { du: 0.125, dcol: 0 }).doc.text);
  assertEq(suspectsOf(moved, sc).size, 1, '動かしたチップは枠が外れる');
});

test('song: exportZip({onlyDir}) writes only that song folder (edited chart included, other folders left out)', async () => {
  const src = (await fetchBytes('fixtures/pack_sjis.zip')).buffer;
  const pkg = await SongPackage.fromZip(src, 'pack.zip');
  const path = '道場テスト/譜面.dtx';
  pkg.setOverride(path, encodeShiftJis('#TITLE: 編集\r\n#00113: 01\r\n'));
  pkg.setOverride('ほか/x.dtx', encodeShiftJis('#TITLE: ほか\r\n'));
  const out = await ZipArchive.open(await pkg.exportZip({ onlyDir: '道場テスト/' }));
  assert(out.entries.length > 1);
  assert(out.entries.every((e) => e.name.startsWith('道場テスト/')), out.entries.map((e) => e.name).join());
  assertEq(decodeText(await out.read(out.find(path))), '#TITLE: 編集\r\n#00113: 01\r\n');
  const all = await ZipArchive.open(await pkg.exportZip());
  assert(all.find('ほか/x.dtx'), '曲パック全体には入る');
});

test('editops2 review: bar length change on a bar with its own ch 02, ×2 duplicates removed together, coalescing only for the same selection', () => {
  // 0.75 → 0.5(先頭 2 文字が同じ値でも書き換える)
  const m = ops2('#00502: 0.75\n#00602: 1\n#00512: 010101\n');
  const r = opBarLength(m, { measure: 5, value: 0.5, scope: 'one', keepBeats: true });
  assert(r.doc.text.includes('#00502: 0.5\n'), r.doc.text);
  assertEq(r.removed, 1);
  assertEq(new EditModel(r.doc).geometry.len(5), 0.5);
  // 同じ行が 2 つ(×2)を両方消す・両方動かす・両方の種類を変える
  const d = ops2('#00113: 01\n#00113: 01\n#00116: 01\n#00116: 01\n');
  const bd = d.chips.filter((c) => c.channel === 0x13).map((c) => c.key);
  assertEq(bd.length, 2);
  assertEq(new EditModel(opDelete(d, bd).doc).chips.filter((c) => c.channel === 0x13).length, 0, '×2 を両方消す');
  const mv = new EditModel(opMove(d, bd, { du: 0.25, dcol: 0, keepValue: true }).doc);
  assertEq(mv.chips.filter((c) => c.channel === 0x13).map((c) => c.tick).join(), '96', '元のセルに残らない(動かした 2 つは 1 つにまとまる)');
  const cy = d.chips.filter((c) => c.channel === 0x16).map((c) => c.key);
  const flipped = new EditModel(opSetType(d, cy, { keepValue: true }).doc);
  assertEq(flipped.chips.filter((c) => c.channel === 0x16).length, 0, 'CY が残らない');
  // 微調整のまとめ: 前の手の結果の選択のまま続けたときだけ
  const h = new EditHistory(d.doc);
  const d1 = DtxDoc.fromText('#00113: 02\n');
  const d2 = DtxDoc.fromText('#00113: 03\n');
  const d3 = DtxDoc.fromText('#00113: 04\n');
  h.push(d1, { coalesceKey: 'nudge', select: ['a'], selectBefore: ['x'], now: 0 });
  h.push(d2, { coalesceKey: 'nudge', select: ['b'], selectBefore: ['a'], now: 100 });
  assertEq(h.index, 1, '同じ選択のまま: まとめる');
  h.push(d3, { coalesceKey: 'nudge', select: ['c'], selectBefore: ['z'], now: 200 });
  assertEq(h.index, 2, '選び直した: 別の手');
});

test('editops2 review: bonus marks never move to a chip that replaces a bonus chip; CY↔RD re-values the mark', () => {
  // SD 1:0 はボーナス、1:96 はボーナスでない。1:96 を 1:0 へ動かすと、動かしたチップはボーナスにならない
  const m = ops2('#00112: 01010000\n#0014F: 04\n');
  const plain = m.chips.find((c) => c.channel === 0x12 && c.tick === 96);
  const r = opMove(m, [plain.key], { du: -0.25, dcol: 0, keepValue: true });
  const c = parseDTX(r.doc.text);
  assertEq(c.notes.filter((n) => n.channel === 0x12).length, 1);
  assertEq(c.notes.filter((n) => n.bonus).length, 0, '置き換えたチップのボーナスを引き継がない');
  assertEq(c.bonusChipCount, 0, '印も消える');
  // 両方ボーナスなら、印は 1 つだけ
  const both = ops2('#00112: 01010000\n#0014F: 04040000\n');
  const b96 = both.chips.find((x) => x.channel === 0x12 && x.tick === 96);
  const c2 = parseDTX(opMove(both, [b96.key], { du: -0.25, dcol: 0, keepValue: true }).doc.text);
  assertEq(`${c2.notes.filter((n) => n.bonus).length}/${c2.bonusChipCount}`, '1/1');
  // CY(レーン 8、値 09)のボーナスを RD にすると、印は 0A(レーン 9)
  const cy = ops2('#00116: 01\n#0014F: 09\n');
  const t = parseDTX(opSetType(cy, [cy.chips[0].key], { keepValue: true }).doc.text);
  assertEq(t.notes.filter((n) => n.bonus && n.channel === 0x19).length, 1, 'RD のボーナス');
});

test('editops2 review: BPM numbers avoid dangling ch 08 references; locked BPM marks and #IF bar lengths are respected', () => {
  // 定義の無い 01 を指す ch 08 がある: 新しい定義は 02
  const dang = ops2('#BPM: 120\n#00508: 01\n#00111: 01\n');
  const r = opSetBpm(dang, { measure: 1, tick: 0, bpm: 200 });
  assert(r.doc.text.includes('#BPM02: 200'), r.doc.text);
  assert(!r.doc.text.includes('#BPM01:'), 'bar 005 のテンポは変わらない');
  // 表示している分岐の BPM の印へは動かさない・複製しない
  const lk = ops2('#BPM: 120\n#BPM01: 150\n#BPM02: 90\n#00208: 01\n#RANDOM 1\n#IF 1\n#00308: 02\n#ENDIF\n');
  const mark = lk.bpmMarks.find((b) => !b.locked);
  assert(throwsCode(() => opMove(lk, [mark.key], { du: 1, dcol: 0 }), 'locked'));
  assert(throwsCode(() => opDuplicate(lk, [mark.key]), 'locked'));
  // #IF の中に小節長があれば、小節の挿入・削除はしない(ほかの分岐の長さを変えないため)
  const bl = ops2('#RANDOM 2\n#IF 1\n#00302: 0.75\n#ENDIF\n#00111: 01\n#00811: 01\n');
  assert(throwsCode(() => opInsertMeasure(bl, 6), 'measureLocked'));
  assert(throwsCode(() => opDeleteMeasure(bl, 6), 'measureLocked'));
});

test('editops3: header fields (rewrite every occurrence, remove when empty, BPM / DLEVEL checks), new chart template', () => {
  const m = ops2('#TITLE: 古い\n#ARTIST: a\n#BPM: 120\n#DLEVEL: 50\n#00111: 01\n');
  assertEq(opHeader(m, 'TITLE', '新しい; 曲').doc.text, '#TITLE: 新しい  曲\n#ARTIST: a\n#BPM: 120\n#DLEVEL: 50\n#00111: 01\n', '; はコメントになるので空白に');
  assertEq(opHeader(m, 'ARTIST', '  ').doc.text, '#TITLE: 古い\n#BPM: 120\n#DLEVEL: 50\n#00111: 01\n', '空 = 行を消す');
  assertEq(opHeader(m, 'GENRE', 'Rock').doc.text, '#TITLE: 古い\n#ARTIST: a\n#BPM: 120\n#DLEVEL: 50\n#GENRE: Rock\n#00111: 01\n', '無ければヘッダの最後に足す');
  assertEq(opHeader(m, 'TITLE', '古い').doc, m.doc, '同じなら同じ文書');
  assertEq(opHeader(m, 'BPM', '145.50').doc.text.split('\n')[2], '#BPM: 145.5');
  assert(throwsCode(() => opHeader(m, 'BPM', ''), 'bpmRange'));
  assert(throwsCode(() => opHeader(m, 'DLEVEL', '7.5'), 'levelRange'));
  assertEq(opHeader(m, 'DLEVEL', '075').doc.text.split('\n')[3], '#DLEVEL: 75');
  // 新しい難易度: #IF の外のヘッダと BGM / 小節長 / BPM の行だけ。#DLEVEL は消す
  const src = DtxDoc.fromText('#TITLE: t\n#DLEVEL: 50\n#WAV01: bgm.ogg\n#BPM01: 150\n#00101: 01\n#00102: 0.75\n#00108: 01\n#00112: 01\n#RANDOM 2\n#IF 1\n#00213: 01\n#ENDIF\n');
  assertEq(newChartText(src), '; Created by DTXMania Web\r\n#TITLE: t\r\n#WAV01: bgm.ogg\r\n#BPM01: 150\r\n#00101: 01\r\n#00102: 0.75\r\n#00108: 01\r\n');
});

test('editops3: sound definitions (#WAV / #VOLUME / #PAN / #BGMWAV, label, aliases, redefined ids are read-only), free number, BGM shift', () => {
  const m = ops2('#WAV01: bd.wav\t;BD\n#VOLUME01: 80\n#WAV02: sd.wav\n#00113: 01\n#00112: 02\n');
  const defs = wavDefinitions(m.doc);
  assertDeepEq([defs.get('01').file, defs.get('01').label, defs.get('01').volume, defs.get('01').pan], ['bd.wav', 'BD', 80, null]);
  // 音量 100 は行を消す、位置・BGM は足す(その番号の定義の後ろ)
  const r = opSetWav(m, '01', { volume: 100, pan: -30, bgm: true });
  assertEq(r.doc.text, '#WAV01: bd.wav\t;BD\n#PAN01: -30\n#BGMWAV: 01\n#WAV02: sd.wav\n#00113: 01\n#00112: 02\n');
  // ファイルとラベル
  assertEq(opSetWav(m, '02', { file: 'snare.wav', label: 'SD' }).doc.text.split('\n')[2], '#WAV02: snare.wav\t;SD');
  // 新しい番号は音源の定義の最後に足す
  assertEq(opSetWav(m, '03', { file: 'ht.wav', volume: 50 }).doc.text, '#WAV01: bd.wav\t;BD\n#VOLUME01: 80\n#WAV02: sd.wav\n#WAV03: ht.wav\n#VOLUME03: 50\n#00113: 01\n#00112: 02\n');
  // ファイルを空にすると定義ごと消す
  assertEq(opSetWav(m, '01', { file: '' }).doc.text, '#WAV02: sd.wav\n#00113: 01\n#00112: 02\n');
  // #WAVVOL を使うファイルはそのまま #WAVVOL
  const alias = ops2('#WAV01: a.wav\n#WAVVOL01: 70\n#WAV02: b.wav\n');
  assertEq(opSetWav(alias, '02', { volume: 40 }).doc.text, '#WAV01: a.wav\n#WAVVOL01: 70\n#WAV02: b.wav\n#WAVVOL02: 40\n');
  assert(throwsCode(() => opSetWav(m, '01', { volume: 101 }), 'wavVolumeRange'));
  // 何度も定義された番号は変えない
  const red = ops2('#WAV01: a.wav\n#WAV01: b.wav\n');
  assert(wavDefinitions(red.doc).get('01').redefined);
  assert(throwsCode(() => opSetWav(red, '01', { file: 'c.wav' }), 'wavRedefined'));
  assertEq(freeWavNumber(m), '03');
  // BGM をずらす: 120 BPM で 1 拍 500 ms = 96 tick
  const b = ops2('#BPM: 120\n#WAV0A: bgm.ogg\n#00101: 0A\n');
  assertEq(opShiftBgm(b, 500).doc.text, '#BPM: 120\n#WAV0A: bgm.ogg\n#00101: 000A0000\n');
  assert(throwsCode(() => opShiftBgm(b, -3000), 'bgmShiftRange'), 'リードインより前には出さない');
  // 使用数・編集画面に出さないチップの数
  const u = ops2('#00113: 0101\n#00101: 01\n#00161: 02\n#0014F: 06\n');
  assertEq(u.wavUses.get('01'), 3);
  assertEq(u.wavUses.get('06') || 0, 0, 'ボーナスの印は音源の番号ではない');
  assertEq(u.otherChips, 1, 'SE の 1 個');
});

/** File System Access のフォルダのハンドルの代わり(テスト用。path → バイト列)。 */
function fakeDir(files) {
  const mkfile = (name, bytes) => ({
    kind: 'file', name, bytes,
    async getFile() { return new File([this.bytes], name); },
    async createWritable() {
      const self = this;
      let buf = null;
      return { async write(b) { buf = new Uint8Array(b); }, async close() { self.bytes = buf; }, async abort() { buf = null; } };
    },
  });
  const mkdir = (name) => ({
    kind: 'directory', name, children: new Map(),
    async *entries() { for (const e of this.children) yield e; },
    async getDirectoryHandle(n, o = {}) {
      let c = this.children.get(n);
      if (!c && o.create) this.children.set(n, (c = mkdir(n)));
      if (!c) throw new DOMException('not found', 'NotFoundError');
      return c;
    },
    async getFileHandle(n, o = {}) {
      let c = this.children.get(n);
      if (!c && o.create) this.children.set(n, (c = mkfile(n, new Uint8Array())));
      if (!c) throw new DOMException('not found', 'NotFoundError');
      return c;
    },
    async queryPermission() { return 'granted'; },
  });
  const root = mkdir('pack');
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split('/');
    const name = parts.pop();
    let d = root;
    for (const p of parts) {
      if (!d.children.has(p)) d.children.set(p, mkdir(p));
      d = d.children.get(p);
    }
    d.children.set(name, mkfile(name, bytes));
  }
  return root;
}

test('song: a folder opened with a directory handle can be written back (HandleArchive: .bak, new sound files, re-read after writing); the overlay follows the bytes on disk', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const root = fakeDir({ 'Song/a.dtx': enc('#TITLE: a\r\n#00113: 01\r\n'), 'Song/bd.wav': new Uint8Array([1, 2, 3]), '.hidden/x.dtx': enc('#TITLE: x\r\n') });
  const pkg = await SongPackage.fromHandle(root);
  assert(pkg.writable);
  assertEq(pkg.songs.length, 1, '. で始まるフォルダは読まない');
  const arch = pkg.zip;
  assert(await arch.ensureWritable());
  assert(!arch.has('Song/a.dtx.bak'));
  await arch.writeFile('Song/a.dtx.bak', enc('old'));
  await arch.writeFile('Song/a.dtx', enc('#TITLE: b\r\n'));
  await arch.writeFile('Song/new/tom.wav', new Uint8Array([9]));
  assert(arch.has('Song/a.dtx.bak') && arch.has('Song/new/tom.wav'));
  assertEq(new TextDecoder().decode(root.children.get('Song').children.get('a.dtx').bytes), '#TITLE: b\r\n');
  assertEq(new TextDecoder().decode(await pkg.readBytes('Song/a.dtx')), '#TITLE: b\r\n', '書いたあとも読める(File を読み直す)');
  assertDeepEq([...root.children.get('Song').children.get('new').children.get('tom.wav').bytes], [9]);
  // セッション: フォルダへ書いたあとは、そのバイト列と同じなら重ねない
  const orig = enc('#TITLE: a\r\n#00113: 01\r\n');
  const ses = new EditSession({ pkg, song: pkg.songs[0], chartRef: pkg.songs[0].charts[0], originalBytes: orig });
  ses.diskBytes = orig;
  await ses.commit();
  assertEq(pkg.override('Song/a.dtx'), null);
  ses.diskBytes = enc('#TITLE: other\r\n');
  await ses.commit();
  assert(pkg.override('Song/a.dtx'), 'ディスクと違えば重ねる');
});

test('editops3 review: new chart drops every level line; #PANEL text is not a pan; sound ids defined inside #IF are read-only; a new chart saved to the folder stays in the pack', async () => {
  const src = DtxDoc.fromText('#TITLE: t\n#DLEVEL: 50\n#GLEVEL: 40\n#BLEVEL: 30\n#GLVDEC: 5\n#00101: 01\n');
  assertEq(newChartText(src), '; Created by DTXMania Web\r\n#TITLE: t\r\n#00101: 01\r\n');
  const panel = ops2('#PANEL: 3rd stage\n#WAVEL: el.wav\n');
  assertEq(wavDefinitions(panel.doc).get('EL').pan, null, '#PANEL の文字は位置ではない');
  assertEq(opSetWav(panel, 'EL', { volume: 50 }).doc.text, '#PANEL: 3rd stage\n#WAVEL: el.wav\n#VOLUMEEL: 50\n', '#PANEL を消さない');
  const iff = ops2('#WAV01: a.wav\n#RANDOM 2\n#IF 1\n#VOLUME01: 50\n#WAV02: b.wav\n#ENDIF\n');
  assert(wavDefinitions(iff.doc).get('01').redefined, '#IF の中に #VOLUME01');
  assert(wavDefinitions(iff.doc).get('02').redefined, '#IF の中だけで定義');
  assertEq(freeWavNumber(iff), '03');
  // フォルダへ書いた新しい難易度は、重ねたものを外しても曲パックに残る
  const enc = (s) => new TextEncoder().encode(s);
  const root = fakeDir({ 'Song/a.dtx': enc('#TITLE: a\r\n#00113: 01\r\n') });
  const pkg = await SongPackage.fromHandle(root);
  const path = 'Song/a_edit.dtx';
  const tpl = enc('#TITLE: a\r\n');
  pkg.setOverride(path, tpl);
  await pkg.rescan();
  const song = pkg.songs.find((x) => x.charts.some((c) => c.path === path));
  const ses = new EditSession({ pkg, song, chartRef: song.charts.find((c) => c.path === path), originalBytes: tpl, isNew: true });
  pkg.adoptWritten(path, await pkg.zip.writeFile(path, tpl));
  ses.diskBytes = tpl;
  await ses.commit();
  assert(pkg.entry(path), '曲パックに残る');
  assertEq(new TextDecoder().decode(await pkg.readBytes(path)), '#TITLE: a\r\n');
  assert((await pkg.loadChart(path)).title === 'a');
  assertEq(draftKey(pkg, path).split(':')[1], 'pack|folder', '上書きできるフォルダの下書きのキーはファイル数を見ない');
  // 新しい難易度の下書きは「元」(作ったときの写し)を持つ
  assertDeepEq([...ses.draftValue().base], [...tpl]);
});
