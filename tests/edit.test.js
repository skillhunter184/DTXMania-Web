// 譜面の編集(js/edit/)のテスト。
import { test, assert, assertEq, assertNear, assertDeepEq, fetchBytes } from './runner.js';
import { parseDTX, posToMs, msToPos, tempoAt, replayRandom } from '../js/core/dtx.js';
import { decodeText, encodeShiftJis, encodeText } from '../js/core/encoding.js';
import { ZipArchive, crc32 } from '../js/core/zip.js';
import { SongPackage } from '../js/core/song.js';
import {
  DtxDoc, groupKey, minimalDivision, renderGroupLines, parseObjectLine, formatBarLength,
} from '../js/edit/dtxdoc.js';

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sjis = (s) => encodeShiftJis(s);
const noteSig = (chart) => chart.notes.map((n) => `${n.measure}:${n.tick}:${n.channel.toString(16)}:${n.wavId}`).join(' ');

// ---- dtxdoc: 行の読み書き ----
test('dtxdoc: unchanged documents write back byte-identical (Shift-JIS CRLF, UTF-16LE BOM, UTF-8 without trailing newline)', async () => {
  const features = await fetchBytes('fixtures/demo_features.dtx');
  const cases = [
    sjis('; 譜面\r\n#TITLE: 絵空事\r\n#00113: 01\r\n'),
    encodeText('#TITLE: あ\r\n#00111: 0101\r\n', 'utf-16le', true).bytes,
    new TextEncoder().encode('#TITLE: 道場\n#00111: 01'),
    features,
  ];
  for (const bytes of cases) {
    const doc = DtxDoc.fromBytes(bytes);
    assertEq(doc.text, decodeText(bytes), 'text');
    const out = doc.toBytes();
    assert(sameBytes(out.bytes, bytes), 'bytes identical (' + doc.info.encoding + ')');
    assertEq(out.changedEncoding, false);
  }
  const u16 = DtxDoc.fromBytes(cases[1]);
  assertDeepEq(u16.info, { encoding: 'utf-16le', bom: true, eol: '\r\n' });
  assertEq(DtxDoc.fromBytes(cases[2]).info.eol, '\n');
});

test('dtxdoc: parseObjectLine follows parseDTX (space before colon, comments, underscores, 5 cells, lowercase ids, ch02)', () => {
  assertDeepEq(parseObjectLine('00111 : 01_02 ;c'), { measure: 1, channel: 0x11, chips: [{ tick: 0, value: '01' }, { tick: 192, value: '02' }] });
  assertDeepEq(parseObjectLine('0021a: 0a0000000b').chips, [{ tick: 0, value: '0A' }, { tick: 307, value: '0B' }]);
  assertDeepEq(parseObjectLine('00302: 0.75'), { measure: 3, channel: 2, chips: [{ tick: 0, value: '0.75' }] });
  assertEq(parseObjectLine('00111 0101'), null, 'no colon: parseDTX ignores the line');
  assertEq(parseObjectLine('0012X: 01'), null, 'bad channel');
  assertEq(parseObjectLine('WAV01: a.wav'), null);
  assertDeepEq(parseObjectLine('00111:').chips, []);
});

test('dtxdoc: minimalDivision / renderGroupLines write the shortest exact line and split same-tick chips', () => {
  assertEq(minimalDivision([0]), 1);
  assertEq(minimalDivision([0, 96, 192, 288]), 4);
  assertEq(minimalDivision([0, 76, 153, 230, 307]), 5, '5 分割はそのまま 5 セル');
  assertEq(minimalDivision([0, 128, 256]), 3);
  assertEq(minimalDivision([5]), 65, 'tick 5 だけなら floor(384/65) = 5');
  assertDeepEq(renderGroupLines(1, 0x13, [{ tick: 0, value: '01' }, { tick: 192, value: '02' }]), ['#00113: 0102']);
  assertDeepEq(renderGroupLines(12, 0x1a, [{ tick: 96, value: 'ZZ' }]), ['#0121A: 00ZZ0000']);
  assertDeepEq(renderGroupLines(0, 0x11, [{ tick: 0, value: '01' }, { tick: 0, value: '02' }]), ['#00011: 01', '#00011: 02']);
  assertDeepEq(renderGroupLines(2, 0x02, [{ tick: 0, value: '0.75' }]), ['#00202: 0.75']);
  assertDeepEq(renderGroupLines(2, 0x13, []), []);
  assertEq(formatBarLength(0.75), '0.75');
  assertEq(formatBarLength(1), '1');
  assertEq(formatBarLength(1 / 3), '0.333333');
  // 書いた行を parseDTX で読み直すと同じ tick になる(384 の約数でない分割)
  const ticks = [0, 76, 153, 230, 307];
  const line = renderGroupLines(0, 0x13, ticks.map((tick) => ({ tick, value: '01' })))[0];
  assertDeepEq(parseDTX(line).notes.map((n) => n.tick), ticks);
});

test('dtxdoc: withGroups rewrites only the changed group in place, keeps every other line byte-identical', () => {
  const src = '; 譜面のテスト\r\n#TITLE: 絵空事\r\n#BPM: 120\r\n#WAV01: bd.wav\t;BD\r\n\r\n#00113: 01000100 ; bd\r\n#00112: 00010001\r\n#00213: 01\r\n';
  const bytes = sjis(src);
  const doc = DtxDoc.fromBytes(bytes);
  assertDeepEq(doc.chipsOf(1, 0x13), [{ tick: 0, value: '01' }, { tick: 192, value: '01' }]);
  const next = doc.withGroups(new Map([[groupKey(1, 0x13), [{ tick: 0, value: '01' }, { tick: 96, value: '02' }]]]));
  assert(next !== doc && doc.chipsOf(1, 0x13).length === 2, 'original document is unchanged');
  assertEq(next.text, src.replace('#00113: 01000100 ; bd', '#00113: 01020000'));
  const out = next.toBytes();
  assertEq(out.encoding, 'shift_jis');
  assertEq(decodeText(out.bytes), next.text);
  // 書き直していない行は元のバイト列のまま(Shift-JIS のコメントとタイトル)
  assert(sameBytes(out.bytes.subarray(0, sjis('; 譜面のテスト\r\n#TITLE: 絵空事\r\n').length), sjis('; 譜面のテスト\r\n#TITLE: 絵空事\r\n')));
  assertEq(noteSig(parseDTX(next.text)), '1:0:13:01 1:96:13:02 1:96:12:01 1:288:12:01 2:0:13:01');
});

test('dtxdoc: new groups go next to the neighbouring key, removed groups disappear, several lines of one group merge', () => {
  const doc = DtxDoc.fromText('#TITLE: t\n#00111: 01\n#00113: 01\n#00313: 01\n#00313: 0001\n');
  const next = doc.withGroups(new Map([
    [groupKey(1, 0x12), [{ tick: 0, value: '05' }]], // 00111 と 00113 の間
    [groupKey(2, 0x13), [{ tick: 0, value: '06' }]], // 00113 と 00313 の間
    [groupKey(5, 0x16), [{ tick: 192, value: '07' }]], // 最後のデータ行の後ろ
    [groupKey(1, 0x11), []], // 消す
    [groupKey(3, 0x13), [{ tick: 0, value: '01' }, { tick: 192, value: '01' }, { tick: 288, value: '02' }]], // 2 行を 1 行に
  ]));
  assertEq(next.text, '#TITLE: t\n#00112: 05\n#00113: 01\n#00213: 06\n#00313: 01000102\n#00516: 0007\n');
  // データ行が無い文書は末尾(最後の改行の前)に足す
  const empty = DtxDoc.fromText('#TITLE: t\r\n#BPM: 120\r\n');
  assertEq(empty.withGroups(new Map([[groupKey(1, 0x13), [{ tick: 0, value: '01' }]]])).text, '#TITLE: t\r\n#BPM: 120\r\n#00113: 01\r\n');
  // 末尾に改行の無い文書
  const noEol = DtxDoc.fromText('#00111: 01');
  assertEq(noEol.withGroups(new Map([[groupKey(2, 0x11), [{ tick: 0, value: '02' }]]])).text, '#00111: 01\r\n#00211: 02', '既定の改行は文書の多い方(無ければ CRLF)');
});

test('dtxdoc: lines inside #IF blocks are locked (not grouped, kept verbatim) and new lines never land inside a block', () => {
  const src = '#00113: 01\n#RANDOM 2\n#IF 1\n#00113: 0002\n#00213: 01\n#ENDIF\n#00313: 01\n';
  const doc = DtxDoc.fromText(src);
  assertEq(doc.index.lockedObjects, 2);
  assertDeepEq(doc.chipsOf(1, 0x13), [{ tick: 0, value: '01' }], '#IF の中の 00113 は組に入らない');
  assertDeepEq(doc.chipsOf(2, 0x13), []);
  const next = doc.withGroups(new Map([[groupKey(1, 0x13), [{ tick: 96, value: '01' }]], [groupKey(2, 0x13), [{ tick: 0, value: '09' }]]]));
  assertEq(next.text, '#00113: 00010000\n#00213: 09\n#RANDOM 2\n#IF 1\n#00113: 0002\n#00213: 01\n#ENDIF\n#00313: 01\n');
});

test('dtxdoc: withHeader rewrites every occurrence (keeps comments), inserts before the first data line, removes', () => {
  const doc = DtxDoc.fromText('; c\n#TITLE: a\n#WAV01: bd.wav ;Kick\n#00113: 01\n#TITLE: b\n');
  assertEq(doc.header('title'), 'b', 'parseDTX と同じく最後の行');
  const t = doc.withHeader('TITLE', '新しい題名');
  assertEq(t.text, '; c\n#TITLE: 新しい題名\n#WAV01: bd.wav ;Kick\n#00113: 01\n#TITLE: 新しい題名\n');
  assertEq(doc.withHeader('WAV01', 'kick.ogg').text, '; c\n#TITLE: a\n#WAV01: kick.ogg\t;Kick\n#00113: 01\n#TITLE: b\n');
  assertEq(doc.withHeader('ARTIST', 'x;y').text, '; c\n#TITLE: a\n#WAV01: bd.wav ;Kick\n#ARTIST: x y\n#00113: 01\n#TITLE: b\n', '; はコメントになるので空白に');
  assertEq(doc.withHeader('TITLE', null).text, '; c\n#WAV01: bd.wav ;Kick\n#00113: 01\n');
  assertEq(DtxDoc.fromText('#00113: 01\n').withHeader('BPM', '150').text, '#BPM: 150\n#00113: 01\n');
  // parseDTX が読む
  assertEq(parseDTX(t.text).title, '新しい題名');
});

test('dtxdoc: withMeasureShift inserts and deletes measures (also inside #IF), and refuses measures above 999', () => {
  const doc = DtxDoc.fromText('#00011: 01\n#00102: 0.75\n#00111: 01 ;x\n#IF 1\n#00211: 02\n#ENDIF\n#00311: 03\n');
  assertEq(doc.withMeasureShift(1, 2).text, '#00011: 01\n#00302: 0.75\n#00311: 01 ;x\n#IF 1\n#00411: 02\n#ENDIF\n#00511: 03\n');
  assertEq(doc.withMeasureShift(1, -2).text, '#00011: 01\n#IF 1\n#ENDIF\n#00111: 03\n');
  let threw = false;
  try { DtxDoc.fromText('#99911: 01\n').withMeasureShift(0, 1); } catch (e) { threw = e instanceof RangeError; }
  assert(threw, 'RangeError');
});

test('dtxdoc: a header Shift-JIS cannot hold switches the whole file to UTF-8 with BOM', () => {
  const bytes = sjis('#TITLE: 絵空事\r\n#00113: 01\r\n');
  const doc = DtxDoc.fromBytes(bytes).withHeader('ARTIST', '🎵 Band');
  const out = doc.toBytes();
  assertEq(out.changedEncoding, true);
  assertEq(out.encoding, 'utf-8');
  assertEq(out.bytes[0], 0xef);
  assertEq(decodeText(out.bytes), '#TITLE: 絵空事\r\n#ARTIST: 🎵 Band\r\n#00113: 01\r\n');
  // ASCII だけのファイルに日本語を足すと Shift-JIS
  const ascii = DtxDoc.fromBytes(new TextEncoder().encode('#BPM: 120\n')).withHeader('TITLE', '題名').toBytes();
  assertEq(ascii.encoding, 'shift_jis');
  assertEq(decodeText(ascii.bytes), '#BPM: 120\n#TITLE: 題名\n');
});

test('dtxdoc: a rewritten document always ends with a newline (DTXCreator drops an unterminated last line)', () => {
  const doc = DtxDoc.fromBytes(new TextEncoder().encode('#TITLE: a\n#00111: 01'));
  assertEq(decodeText(doc.toBytes().bytes), '#TITLE: a\n#00111: 01', 'untouched: byte-identical');
  const next = doc.withHeader('TITLE', 'b');
  assertEq(decodeText(next.toBytes().bytes), '#TITLE: b\n#00111: 01\n');
});

// ---- dtx: テンポ表(時刻 ↔ 位置) ----
test('dtx: tempoMap / posToMs / msToPos follow the parser (BPM change mid-measure, bar length, BASEBPM)', () => {
  const c = parseDTX('#BPM: 120\n#BPM01: 240\n#00102: 0.5\n#00111: 01\n#00108: 0001\n#00211: 0101\n#00302: 1\n#00311: 01\n');
  // 小節 000 頭 = 2000ms(リードイン 1 小節 120 BPM)、小節 001(0.5 小節)頭 = 4000ms、その 192 tick で 240 BPM へ
  for (const n of c.notes) assertNear(posToMs(c, n.pos), n.timeMs, 0.5, 'note ' + n.measure + ':' + n.tick);
  for (const n of c.notes) assertNear(msToPos(c, posToMs(c, n.pos)), n.pos, 1e-6, 'inverse ' + n.pos);
  assertNear(posToMs(c, 384 * 2), 4000, 1e-6, 'measure 001 start');
  assertNear(posToMs(c, 384 * 2 + 192), 4500, 1e-6, '0.5 bar at 120 BPM: 192 tick = 500 ms');
  assertNear(posToMs(c, 384 * 3), 4750, 1e-6, '240 BPM for the rest of the half bar');
  const seg = c.tempoMap.map((s) => s.pos);
  assertDeepEq(seg, [0, 768, 960, 1536], 'segments at bar-length / BPM changes');
  assertDeepEq(c.tempoMap.map((s) => [s.bpm, s.barLen]), [[120, 1], [120, 0.5], [240, 0.5], [240, 1]]);
  assertEq(tempoAt(c, 1000).bpm, 240);
  // 記録した乱数を再現する(尽きたら 0 = 分岐 1)
  const src = '#RANDOM 2\n#IF 1\n#00111: 01\n#ENDIF\n#IF 2\n#00112: 01\n#ENDIF\n#RANDOM 2\n#IF 2\n#00113: 01\n#ENDIF\n';
  const r = replayRandom([0.7]);
  assertDeepEq(parseDTX(src, { random: r }).notes.map((n) => n.channel), [0x12], '#RANDOM 2 → 0.7 → 2、次は 0 → 1');
  // テンポ表の無い譜面(データ行が無い)
  const e = parseDTX('#BPM: 150\n');
  assertNear(posToMs(e, 384), 1600, 1e-6);
  assertNear(msToPos(e, 1600), 384, 1e-6);
});

// ---- song: 編集した譜面を重ねる・ZIP に書き出す ----
test('song: setOverride feeds edited bytes to loadChart / the song list, and exportZip writes them (other entries untouched)', async () => {
  const src = (await fetchBytes('fixtures/pack_sjis.zip')).buffer;
  const pkg = await SongPackage.fromZip(src, 'pack.zip');
  const path = '道場テスト/譜面.dtx';
  const edited = encodeShiftJis('#TITLE: 編集した譜面\r\n#BPM: 150\r\n#00113: 01\r\n');
  pkg.setOverride(path, edited);
  assert(pkg.hasOverrides);
  const chart = await pkg.loadChart(path);
  assertEq(chart.title, '編集した譜面');
  await pkg.rescan();
  assert(pkg.songs.some((s) => s.charts.some((c) => c.header.title === '編集した譜面')), 'song list sees the edit');
  // 新しい譜面(元の ZIP に無いファイル)も一覧に出る
  pkg.setOverride('道場テスト/new.dtx', encodeShiftJis('#TITLE: 新しい譜面\r\n#00112: 01\r\n'));
  await pkg.rescan();
  assert(pkg.songs.some((s) => s.charts.some((c) => c.path === '道場テスト/new.dtx')), 'new chart listed');
  const out = await ZipArchive.open(await pkg.exportZip());
  const orig = await ZipArchive.open(src);
  assertEq(out.entries.length, orig.entries.length + 1);
  assertEq(decodeText(await out.read(out.find(path))), '#TITLE: 編集した譜面\r\n#BPM: 150\r\n#00113: 01\r\n');
  assertDeepEq([...out.find(path).nameBytes], [...orig.find(path).nameBytes], 'keeps the Shift-JIS name bytes');
  assertEq(decodeText(await out.read(out.find('道場テスト/new.dtx'))), '#TITLE: 新しい譜面\r\n#00112: 01\r\n');
  const wav = orig.find('道場テスト/Sounds/Kick.wav');
  assertEq(crc32(await out.read(out.find(wav.name))), wav.crc, 'other entries copied');
  // 外すと元に戻る
  pkg.setOverride(path, null);
  pkg.setOverride('道場テスト/new.dtx', null);
  assertEq(pkg.hasOverrides, false);
  assertEq(pkg.entry('道場テスト/new.dtx'), null);
  assert((await pkg.loadChart(path)).title !== '編集した譜面');
});
