import { test, assert, assertEq, assertDeepEq } from './runner.js';
import {
  MAX_NOTES_PER_LANE, NO_THRESHOLD, MIDI_PRESETS, defaultMidiNotes, defaultVelocityMin, defaultLaneNotes,
  normalizeMidiNotes, normalizeVelocityMin, findNote, addNote, removeNote, clearLaneNotes, resetLaneNotes,
  stepThreshold, setNoteThreshold, effectiveThreshold, passesThreshold, presetNotesForLane, applyPreset,
  findPreset, matchDevicePreset, autoPreset, laneNotesText,
} from '../js/ui/midibind.js';
import { MidiInput, MIDI_MERGE_MS, RECENT_HIT_COUNT, parseNoteOn } from '../js/ui/midi.js';

// レーン: 0 LC / 1 HH / 2 LP / 3 SD / 4 HT / 5 BD / 6 LT / 7 FT / 8 CY / 9 RD
const notesOf = (notes) => notes.map((lane) => lane.map((b) => b.note));

test('midibind: GM defaults and velocity minimums (docs/spec/nx-docs.md §7)', () => {
  assertDeepEq(notesOf(defaultMidiNotes()), [
    [49], [42, 46], [44], [38, 40, 37], [48, 50], [36, 35], [45, 47], [43, 41], [57, 55], [51, 59, 53],
  ]);
  for (const lane of defaultMidiNotes()) for (const b of lane) assertEq(b.threshold, NO_THRESHOLD);
  assertDeepEq(defaultVelocityMin(), [0, 20, 0, 0, 0, 0, 0, 0, 0, 0], 'HH だけ 20(クロストーク対策)');
  const all = notesOf(defaultMidiNotes()).flat();
  assertEq(new Set(all).size, all.length, '1 ノートが 2 レーンに載らない');
  // 返す配列は毎回新しい(書き換えても既定が汚れない)
  const a = defaultMidiNotes();
  a[0].push({ note: 1, threshold: -1 });
  assertDeepEq(notesOf(defaultMidiNotes())[0], [49]);
  assertDeepEq(defaultLaneNotes(1), [42, 46]);
});

test('midibind: normalizeMidiNotes repairs lane by lane', () => {
  const norm = (raw) => normalizeMidiNotes(raw);
  assertDeepEq(norm(defaultMidiNotes()).notes, defaultMidiNotes(), '正常な設定は素通し');
  assertDeepEq(norm(defaultMidiNotes()).repaired, []);
  assertDeepEq(norm(undefined).notes, defaultMidiNotes());
  assertDeepEq(norm(undefined).repaired, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // 空レーンは意図的な未割り当て(None)。埋め戻さない
  const none = defaultMidiNotes();
  none[9] = [];
  assertDeepEq(norm(none).notes[9], []);
  assertDeepEq(norm(none).repaired, []);

  // 読めない値は落とし、しきい値の範囲外は「レーンに従う」に倒す
  const dirty = defaultMidiNotes();
  dirty[3] = [{ note: 38, threshold: 12 }, { note: 38, threshold: 3 }, { note: 200 }, { note: 1.5 }, 'x', null, { note: 40, threshold: 999 }];
  assertDeepEq(norm(dirty).notes[3], [{ note: 38, threshold: 12 }, { note: 40, threshold: NO_THRESHOLD }]);

  // 中身はあったのに全部読めなかったレーンは壊れている扱い。ただし他レーンの生きている設定からは奪わない
  const broken = defaultMidiNotes();
  broken[0] = [{ note: 42 }]; // LC がユーザー操作で HH の 42 を持っている → HH(1)と重なる
  broken[1] = ['junk'];
  const r = norm(broken);
  assertDeepEq(notesOf(r.notes)[0], [42], '若いレーンが勝つ');
  assertDeepEq(notesOf(r.notes)[1], [46], '奪えない 42 は飛ばして既定の残りで埋める');
  assertDeepEq(r.repaired, [1]);

  // レーン間の重複は若いレーンが勝つ(壊れていない同士)
  const dup = defaultMidiNotes();
  dup[9] = [{ note: 49 }, { note: 51 }];
  assertDeepEq(notesOf(norm(dup).notes)[9], [51]);

  // 上限 12
  const many = defaultMidiNotes();
  many[0] = [];
  for (let n = 60; n < 80; n++) many[0].push({ note: n });
  assertEq(norm(many).notes[0].length, MAX_NOTES_PER_LANE);

  // 冪等
  const once = norm(broken);
  const twice = norm(once.notes);
  assertDeepEq(twice.notes, once.notes);
  assertDeepEq(twice.repaired, []);

  assertDeepEq(normalizeVelocityMin([5, 'x', -1, 128, 127, 3.5]), [5, 20, 0, 0, 127, 0, 0, 0, 0, 0], '読めない値はそのレーンの既定');
  assertDeepEq(normalizeVelocityMin(undefined), defaultVelocityMin());
});

test('midibind: add (hit to register) appends, steals from other lanes, keeps per-note threshold when re-hit', () => {
  let n = defaultMidiNotes();
  const r1 = addNote(n, 3, 22);
  assertEq(r1.ok, true);
  assertDeepEq(notesOf(r1.notes)[3], [38, 40, 37, 22], '末尾に足す');
  assertDeepEq(notesOf(n)[3], [38, 40, 37], '元の配列は書き換えない');

  // 他レーンのノートは取り上げる(しきい値は引き継がない = 元実装 AssignBinding と同じ)
  n = setNoteThreshold(defaultMidiNotes(), 0, 49, 30).notes;
  const r2 = addNote(n, 8, 49);
  assertEq(r2.ok, true);
  assertEq(r2.stolenFrom, 0);
  assertEq(r2.stolenEmptied, true, 'LC は 49 しか持っていない');
  assertDeepEq(r2.notes[0], [], '空になっても既定で埋めない');
  assertDeepEq(r2.notes[8][2], { note: 49, threshold: NO_THRESHOLD });
  assertEq(findNote(r2.notes, 49).lane, 8);

  // 同じレーンにあるノートを叩き直しても何も変えない(ノート別しきい値が消えない。22:133)
  n = setNoteThreshold(defaultMidiNotes(), 1, 46, 33).notes;
  const again = addNote(n, 1, 46);
  assertEq(again.ok, false);
  assertEq(again.reason, 'already');
  assertEq(again.notes[1][1].threshold, 33);

  assertEq(addNote(n, 0, 128).reason, 'invalid');
  let full = clearLaneNotes(defaultMidiNotes(), 0).notes;
  for (let k = 0; k < MAX_NOTES_PER_LANE; k++) full = addNote(full, 0, 60 + k).notes;
  assertEq(addNote(full, 0, 100).reason, 'full');
});

test('midibind: remove / clear / reset lane', () => {
  const n = defaultMidiNotes();
  const r = removeNote(n, 1, 46);
  assertEq(r.ok, true);
  assertDeepEq(notesOf(r.notes)[1], [42]);
  assertEq(removeNote(r.notes, 1, 42).emptied, true);
  assertEq(removeNote(n, 1, 38).ok, false, '別レーンのノートは外さない');
  assertDeepEq(clearLaneNotes(n, 4).notes[4], []);

  // レーンだけ既定に戻す。既定ノートを他レーンが持っていれば取り上げる
  let m = addNote(defaultMidiNotes(), 0, 42).notes; // LC が HH の 42 を取った → HH = [46]
  m = removeNote(m, 1, 46).notes; // HH = []
  m = addNote(m, 2, 46).notes; // LP = [44, 46]
  const back = resetLaneNotes(m, 1);
  assertDeepEq(notesOf(back.notes)[1], [42, 46]);
  assertDeepEq(back.stolenFrom, [0, 2]);
  assertDeepEq(back.stolenEmptied, [], 'LC には 49、LP には 44 が残る');
  assertDeepEq(notesOf(back.notes)[0], [49]);
  assertDeepEq(notesOf(back.notes)[2], [44]);
  assertEq(laneNotesText(back.notes[1]), '42 / 46');
  assertEq(laneNotesText([]), 'なし');
  assertEq(laneNotesText(defaultLaneNotes(5)), '36 / 35');
});

test('midibind: per-note threshold steps like the original (unset → lane min, 0 → unset)', () => {
  // 「レーンに従う」から上げるとレーンの下限から動かす(HH の 20 が黙って 0 にならない。22:134)
  assertEq(stepThreshold(NO_THRESHOLD, 1, 20), 21);
  assertEq(stepThreshold(NO_THRESHOLD, 10, 20), 30);
  assertEq(stepThreshold(NO_THRESHOLD, 1, 0), 1);
  assertEq(stepThreshold(NO_THRESHOLD, -1, 20), NO_THRESHOLD, '下げても -1 のまま');
  assertEq(stepThreshold(0, -1, 20), NO_THRESHOLD, '0 の次はレーン設定に戻る');
  assertEq(stepThreshold(5, -10, 20), NO_THRESHOLD);
  assertEq(stepThreshold(125, 10, 0), 127);
  assertEq(stepThreshold(NO_THRESHOLD, 1, 127), 127);

  assertEq(effectiveThreshold({ note: 42, threshold: NO_THRESHOLD }, 20), 20);
  assertEq(effectiveThreshold({ note: 42, threshold: 0 }, 20), 0, '個別の 0 は素通し(レーンの 20 より優先)');
  // NX と同じく「しきい値以下」を捨てる
  assertEq(passesThreshold(20, 20), false);
  assertEq(passesThreshold(21, 20), true);
  assertEq(passesThreshold(1, 0), true);

  const n = setNoteThreshold(defaultMidiNotes(), 3, 40, 12);
  assertEq(n.ok, true);
  assertDeepEq(n.notes[3][1], { note: 40, threshold: 12 });
  assertEq(setNoteThreshold(defaultMidiNotes(), 3, 42, 12).ok, false, '別レーンのノートは触らない');
});

test('midibind: GITADORA presets — table shape, lane mapping, apply empties RD', () => {
  assertDeepEq(MIDI_PRESETS.map((p) => p.name),
    ['DEFAULT', 'MIDI DRUM', 'TD-1', 'DTX DRUMS', 'DTX Drums', 'DTX drums', 'Yamaha DTX700-1']);
  for (const p of MIDI_PRESETS) {
    assertEq(p.pads.length, 9, p.name);
    const all = p.pads.flat();
    assertEq(new Set(all).size, all.length, p.name + ': 1 打で 2 レーン鳴らない');
    for (const pad of p.pads) assert(pad.length >= 1 && pad.length <= 10, p.name + ': GITADORA は 1 パッド 10 枠');
  }
  // パッド順 HT LT SD FT LC CY HH LP BD → レーン
  const td1 = findPreset('TD-1');
  assertDeepEq([0, 1, 2, 3, 4, 5, 6, 7, 8].map((l) => presetNotesForLane(td1, l)),
    [[49], [46], [44], [38], [48], [36], [45], [43], [51]]);
  assertEq(presetNotesForLane(td1, 9), null, 'RD は GITADORA に無い');

  const before = setNoteThreshold(defaultMidiNotes(), 1, 42, 40).notes;
  const r = applyPreset(before, findPreset('DTX drums'));
  assertDeepEq(notesOf(r.notes), [
    [49, 59], [42, 46, 78, 79, 86], [35, 44], [38], [48], [36], [47], [43], [51, 52, 53], [],
  ]);
  assertEq(r.notes[1][0].threshold, NO_THRESHOLD, 'しきい値は書かない(GITADORA は全部 8 = 既定)');
  const all = notesOf(r.notes).flat();
  assertEq(new Set(all).size, all.length);
  assertDeepEq(notesOf(before)[9], [51, 59, 53], '元の配列は書き換えない');
});

test('midibind: preset lookup and device-name matching (exact case first)', () => {
  assertEq(findPreset('DTX drums').name, 'DTX drums', '大小文字違いの別物を掴まない');
  assertEq(findPreset('DTX DRUMS').name, 'DTX DRUMS');
  assertEq(findPreset('dtx drums').name, 'DTX DRUMS', '完全一致が無ければ大小文字を無視して最初のもの');
  assertEq(findPreset('nope'), null);

  assertEq(matchDevicePreset('TD-1').name, 'TD-1');
  assertEq(matchDevicePreset('2- TD-1').name, 'TD-1', '名前に含まれていれば当たる');
  assertEq(matchDevicePreset('DTX drums').name, 'DTX drums');
  assertEq(matchDevicePreset('DTX Drums').name, 'DTX Drums');
  assertEq(matchDevicePreset('DTX DRUMS').name, 'DTX DRUMS');
  assertEq(matchDevicePreset('dtx drums').name, 'DTX drums', '大小文字を無視した 2 周目で同点ならノートの多いほう');
  assertEq(matchDevicePreset('Yamaha DTX700-1').name, 'Yamaha DTX700-1');
  assertEq(matchDevicePreset('USB MIDI DRUM KIT').name, 'MIDI DRUM');
  assertEq(matchDevicePreset('DEFAULT'), null, 'DEFAULT は受け皿なので照合しない');
  assertEq(matchDevicePreset('USB MIDI Interface'), null);
  assertEq(matchDevicePreset(''), null);

  assertEq(autoPreset([]).name, 'DEFAULT');
  assertEq(autoPreset(['loopMIDI Port', 'TD-1']).name, 'TD-1');
});

// ---- 入力(Web MIDI のメッセージを直接流す) ----

function makeInput() {
  const hits = [];
  const notes = [];
  const midi = new MidiInput({
    onHit: (lane, ts, velocity, note) => hits.push({ lane, ts, velocity, note }),
    onNote: (info) => notes.push(info),
  });
  midi.setBindings(defaultMidiNotes(), defaultVelocityMin());
  return { midi, hits, notes };
}

test('midi: only note-on with velocity != 0 is a hit (any channel)', () => {
  assertDeepEq(parseNoteOn([0x99, 38, 100]), { note: 38, velocity: 100, channel: 9 });
  assertEq(parseNoteOn([0x90, 38, 0]), null, 'ベロシティ 0 のノートオンはノートオフ');
  assertEq(parseNoteOn([0x80, 38, 64]), null, 'ノートオフ');
  assertEq(parseNoteOn([0xb9, 4, 90]), null, 'コントロールチェンジ(ハイハットの開き具合など)');
  assertEq(parseNoteOn([0xa9, 46, 90]), null, 'ポリフォニックキープレッシャー(チョーク)');
  assertEq(parseNoteOn([0x99, 38]), null);

  const { midi, hits, notes } = makeInput();
  const t = performance.now();
  midi.handleMessage([0x99, 38, 100], t);
  midi.handleMessage([0x90, 36, 80], t + 1); // チャンネル 1 でも受ける
  midi.handleMessage([0x99, 38, 0], t + 2);
  midi.handleMessage([0x89, 38, 0], t + 3);
  assertDeepEq(hits.map((h) => h.lane), [3, 5]);
  assertEq(hits[0].ts, t, '打鍵時刻は MIDIMessageEvent.timeStamp をそのまま使う');
  assertEq(notes.length, 2, 'モニタにはノートオンだけ');

  // 割り当ての無いノートは鳴らさないが、モニタには「--」として届く
  midi.handleMessage([0x99, 22, 90], t + 50);
  assertEq(hits.length, 2);
  assertEq(notes[2].lane, -1);
});

test('midi: velocity at or below the threshold is dropped (lane min, per-note override)', () => {
  const { midi, hits, notes } = makeInput();
  const t = performance.now();
  midi.handleMessage([0x99, 42, 20], t); // HH の下限 20 ちょうど → 捨てる
  assertEq(hits.length, 0);
  assertEq(notes[0].lane, 1);
  assertEq(notes[0].accepted, false);
  midi.handleMessage([0x99, 42, 21], t + 100);
  assertEq(hits.length, 1);

  // ノート別しきい値はレーンの下限より優先(低くも高くもできる)
  let n = setNoteThreshold(defaultMidiNotes(), 1, 46, 5).notes;
  n = setNoteThreshold(n, 3, 38, 60).notes;
  midi.setBindings(n, defaultVelocityMin());
  midi.handleMessage([0x99, 46, 6], t + 200);
  assertEq(hits.length, 2, 'HH の 46 は 5 を超えれば通る');
  midi.handleMessage([0x99, 38, 60], t + 300);
  assertEq(hits.length, 2, 'SD の 38 は 60 以下を捨てる');
  midi.handleMessage([0x99, 40, 10], t + 400);
  assertEq(hits.length, 3, '同じ SD でも 40 はレーンの下限(0)に従う');

  // レーンの下限を変えると効く
  const vmin = defaultVelocityMin();
  vmin[5] = 50;
  midi.setBindings(defaultMidiNotes(), vmin);
  midi.handleMessage([0x99, 36, 50], t + 500);
  assertEq(hits.length, 3);
  assertEq(midi.classify(36, 51).accepted, true);
});

test('midi: hits on the same lane within one frame merge into one', () => {
  const { midi, hits, notes } = makeInput();
  const t = performance.now();
  midi.handleMessage([0x99, 38, 90], t);
  midi.handleMessage([0x99, 40, 70], t + 3); // 同じ SD の別ノート(ヘッドとリム)→ 1 打
  midi.handleMessage([0x99, 38, 40], t + MIDI_MERGE_MS - 1); // 二度鳴り → 1 打
  midi.handleMessage([0x99, 36, 90], t + 4); // 別レーンは別の打鍵
  assertDeepEq(hits.map((h) => h.lane), [3, 5]);
  assertEq(notes.filter((x) => x.merged).length, 2, 'まとめた打鍵もモニタには出す');
  midi.handleMessage([0x99, 38, 90], t + MIDI_MERGE_MS); // 最初の打鍵から 1 フレーム後は別の打鍵
  assertDeepEq(hits.map((h) => h.lane), [3, 5, 3]);
  // 届く順が前後しても(複数デバイス)同じ扱い
  midi.handleMessage([0x99, 38, 90], t + MIDI_MERGE_MS - 5);
  assertEq(hits.length, 3);
});

test('midi: monitor keeps recent hits and per-device counters', () => {
  const { midi } = makeInput();
  midi.devices = [{ id: 'a', name: 'TD-1', opened: true, failed: false, hitCount: 0, lastNote: -1, lastVelocity: 0 }];
  const t = performance.now();
  for (let i = 0; i < RECENT_HIT_COUNT + 2; i++) midi.handleMessage([0x99, 40 + i, 50 + i], t + i * 100, 'a');
  assertEq(midi.recentHits.length, RECENT_HIT_COUNT);
  assertEq(midi.recentHits[0].note, 40 + RECENT_HIT_COUNT + 1, '新しいものが先頭');
  assertEq(midi.recentHits[0].device, 0);
  assertEq(midi.devices[0].hitCount, RECENT_HIT_COUNT + 2);
  assertEq(midi.devices[0].lastNote, 40 + RECENT_HIT_COUNT + 1);
  assertEq(midi.devices[0].lastVelocity, 50 + RECENT_HIT_COUNT + 1);
  midi.handleMessage([0x99, 38, 90], 0); // timeStamp が無くても今の時刻で受ける
  assert(Math.abs(midi.recentHits[0].time - performance.now()) < 1000);
});

test('midi: capture takes the strongest note above the lane minimum and does not reach the judge', () => {
  const { midi, hits } = makeInput();
  let got = null;
  midi.startCapture(20, (note, velocity) => { got = { note, velocity }; });
  assertEq(midi.capturing, true);
  const t = performance.now();
  midi.handleMessage([0x99, 46, 15], t); // 下限 20 以下のクロストークは数えない
  midi.handleMessage([0x99, 38, 60], t + 1);
  midi.handleMessage([0x99, 40, 90], t + 2);
  midi.handleMessage([0x99, 37, 70], t + 3);
  midi._finishCapture();
  assertDeepEq(got, { note: 40, velocity: 90 });
  assertEq(midi.capturing, false);
  assertEq(hits.length, 0, '待ち受け中の打鍵は判定に流さない');

  // 弱い打鍵しか来なければ登録しない
  got = null;
  midi.startCapture(20, (note) => { got = note; });
  midi.handleMessage([0x99, 46, 10], t + 100);
  midi._finishCapture();
  assertEq(got, null);

  // 中止したら何も返さない
  midi.startCapture(0, (note) => { got = note; });
  midi.handleMessage([0x99, 38, 90], t + 200);
  midi.cancelCapture();
  midi._finishCapture();
  assertEq(got, null);
  midi.handleMessage([0x99, 38, 90], t + 300);
  assertEq(hits.length, 1, '待ち受けが終われば判定に戻る');
});

test('midi: rescan works with the standard input map and the iOS shim map (forEach only)', () => {
  const fakeInput = (id) => ({ id, name: 'Pad ' + id, state: 'connected', connection: 'open', onmidimessage: null });
  // Web MIDI Browser(mizuhiki/WebMIDIAPIShimForiOS)の _createMIDIPortMap と同じ形: values() は next() だけの独自イテレータ
  const shimMap = (list) => {
    const values = { i: 0, next() { return this.i < list.length ? { value: list[this.i++], done: false } : { value: undefined, done: true }; } };
    return { size: list.length, forEach(cb) { list.forEach((p) => cb(p)); }, values() { values.i = 0; return values; } };
  };
  const cases = [
    ['Map', (list) => new Map(list.map((p) => [p.id, p]))],
    ['shim', shimMap],
  ];
  for (const [label, makeMap] of cases) {
    const { midi, hits } = makeInput();
    const a = fakeInput('a');
    const b = fakeInput('b');
    midi.access = { inputs: makeMap([a, b]) };
    midi.rescan();
    assertDeepEq(midi.devices.map((d) => d.id), ['a', 'b'], label);
    assert(midi.devices.every((d) => d.opened), label + ': 開いている');
    b.onmidimessage({ data: [0x99, 38, 100], timeStamp: performance.now() });
    assertEq(hits.length, 1, label + ': 打鍵が届く');
    assertEq(midi.devices[1].hitCount, 1, label);
  }
});

test('midi: setBindings resolves duplicate notes to the younger lane', () => {
  const { midi } = makeInput();
  const n = defaultMidiNotes();
  n[9].push({ note: 49, threshold: -1 }); // LC の 49 が RD にも(UI では起きないが、壊れた設定に備える)
  midi.setBindings(n, defaultVelocityMin());
  assertEq(midi.laneOfNote(49), 0);
  assertEq(midi.laneOfNote(51), 9);
  assertEq(midi.laneOfNote(100), -1);
});
