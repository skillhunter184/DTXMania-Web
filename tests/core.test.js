import { test, assert, assertEq, assertNear, assertDeepEq, fetchBytes } from './runner.js';
import { decodeText } from '../js/core/encoding.js';
import { ZipArchive, inflateRawSync, crc32 } from '../js/core/zip.js';
import { decodeXA } from '../js/core/xa.js';
import { parseDTX, parseDTXHeader, requiredWavIds, buildMeasureTimes, measureIndexAt, LANE_NAMES } from '../js/core/dtx.js';
import { parseSetDef } from '../js/core/setdef.js';
import { SongPackage, joinPath } from '../js/core/song.js';
import { decodeWav } from '../js/core/wav.js';

// ---- encoding ----
test('encoding: Shift-JIS without BOM', () => {
  // "絵空事" in cp932: 8A47 8BF3 8E96
  const b = new Uint8Array([0x23, 0x54, 0x3a, 0x20, 0x8a, 0x47, 0x8b, 0xf3, 0x8e, 0x96]);
  assertEq(decodeText(b), '#T: 絵空事');
});
test('encoding: UTF-16 LE BOM', () => {
  const b = new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x42, 0x30]); // '#' + 'あ'
  assertEq(decodeText(b), '#あ');
});
test('encoding: UTF-8 BOM and plain UTF-8', () => {
  const enc = new TextEncoder();
  assertEq(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('道場')])), '道場');
  assertEq(decodeText(enc.encode('道場テスト 譜面')), '道場テスト 譜面');
});

// ---- zip ----
let pack;
test('zip: parse central directory (sjis names, utf8 flag, data descriptor)', async () => {
  pack = await ZipArchive.open((await fetchBytes('fixtures/pack_sjis.zip')).buffer);
  const names = pack.entries.map((e) => e.name);
  assert(names.includes('道場テスト/譜面.dtx'), 'sjis name: ' + names.join(','));
  assert(names.includes('utf8名前/readme.txt'), 'utf8 name: ' + names.join(','));
  const exp = JSON.parse(new TextDecoder().decode(await fetchBytes('fixtures/pack_sjis.json')));
  const dtx = pack.find('道場テスト/譜面.dtx');
  assertEq(dtx.size, exp.dtx_len, 'dtx size');
  assertEq(dtx.crc, exp.dtx_crc, 'dtx crc');
  const wav = pack.find('道場テスト/Sounds/Kick.wav');
  assertEq(wav.size, exp.wav_len, 'wav size');
});
test('zip: read deflate entry via DecompressionStream and pure-JS inflate', async () => {
  const exp = JSON.parse(new TextDecoder().decode(await fetchBytes('fixtures/pack_sjis.json')));
  const tiny = await fetchBytes('fixtures/tiny.wav');
  const e = pack.find('道場テスト/Sounds/Kick.wav');
  const a = await pack.read(e, { verifyCrc: true });
  const b = await pack.read(e, { forceSync: true });
  assertEq(a.length, tiny.length);
  assertEq(b.length, tiny.length);
  for (let i = 0; i < tiny.length; i++) {
    if (a[i] !== tiny[i]) throw new Error('stream inflate mismatch at ' + i);
    if (b[i] !== tiny[i]) throw new Error('sync inflate mismatch at ' + i);
  }
  const dtxBytes = await pack.read(pack.find('道場テスト/譜面.dtx'), { forceSync: true });
  assertEq(crc32(dtxBytes), exp.dtx_crc, 'crc after sync inflate');
  const xaBytes = await pack.read(pack.find('道場テスト/Sounds/Snare.xa'), { forceSync: true });
  assertEq(xaBytes.length, exp.xa_len);
  const stored = await pack.read(pack.find('utf8名前/readme.txt'));
  assertEq(decodeText(stored, { preferUtf8: true }), 'utf-8 名前のエントリ');
});
test('zip: inflateRawSync handles stored blocks', () => {
  // raw deflate stored block: BFINAL=1, BTYPE=00 → byte 0x01, LEN=5, NLEN=~5, "hello"
  const src = new Uint8Array([0x01, 0x05, 0x00, 0xfa, 0xff, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  assertEq(new TextDecoder().decode(inflateRawSync(src)), 'hello');
});

// ---- xa ----
test('xa: decode matches the Python reference of tools/make_fixtures.py (4/6/8 bit, stereo; rate/channels/samples/first64/sha256)', async () => {
  const refs = JSON.parse(new TextDecoder().decode(await fetchBytes('fixtures/xa_refs.json')));
  for (const ref of refs) {
    const bytes = await fetchBytes('fixtures/' + ref.file);
    const d = decodeXA(bytes);
    assertEq(d.sampleRate, ref.rate, ref.file + ' rate');
    assertEq(d.channels, ref.channels, ref.file + ' channels');
    assertEq(d.length, ref.samples, ref.file + ' samples');
    const i16 = new Int16Array(d.length * d.channels);
    for (let i = 0; i < d.length; i++) for (let c = 0; c < d.channels; c++) i16[i * d.channels + c] = Math.round(d.channelData[c][i] * 32768);
    for (let i = 0; i < 64; i++) assertEq(i16[i], ref.first64[i], ref.file + ' sample ' + i);
    const digest = await crypto.subtle.digest('SHA-256', i16.buffer);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    assertEq(hex, ref.sha256_int16, ref.file + ' sha256');
  }
});

// ---- wav ----
test('wav: decode tiny 16-bit mono', async () => {
  const d = decodeWav(await fetchBytes('fixtures/tiny.wav'));
  assertEq(d.sampleRate, 44100);
  assertEq(d.channels, 1);
  assertEq(d.length, 100);
  assertNear(d.channelData[0][1], 0.5 * Math.sin((2 * Math.PI * 440) / 44100), 0.001);
});

// ---- dtx (ParityTests T1-T4 移植) ----
test('dtx T1: ch03 is hex, BPM = BASEBPM(0) + value', () => {
  const c = parseDTX('#TITLE: t1\n#BPM: 130\n#00111: 0101\n#00103: 78\n');
  assertEq(c.notes.length, 2);
  assertNear(c.notes[0].timeMs, 3692, 2, 'note0');
  assertNear(c.notes[1].timeMs, 4692, 2, 'note1');
  assertEq(c.bpm, 130);
  assertEq(c.title, 't1');
});
test('dtx T2: #BASEBPM added to ch03', () => {
  const c = parseDTX('#BPM: 130\n#BASEBPM: 100\n#00103: 3C\n#00111: 0001\n');
  assertEq(c.baseBpm, 100);
  assertNear(c.notes[0].timeMs, 4442, 2);
});
test('dtx T3: ch08 (#BPMxx) + BASEBPM', () => {
  const c = parseDTX('#BPM: 120\n#BASEBPM: 50\n#BPM01: 200\n#00108: 01\n#00111: 0001\n');
  assertNear(c.notes[0].timeMs, 4480, 2);
});
test('dtx T4: #RANDOM/#IF/#ENDIF', () => {
  const c = parseDTX([
    '#BPM: 120', '#RANDOM 1', '#IF1', '#00111: 01', '#ENDIF', '#IF 2', '#00112: 01', '#BPM: 999', '#RANDOM 5',
    '#IF 1', '#00113: 01', '#ENDIF', '#00114: 01', '#ENDIF', '#ENDIF', '#00115: 01', '',
  ].join('\n'), { random: () => 0 });
  assertEq(c.notes.length, 2, 'notes');
  assertEq(c.notes[0].lane, 1);
  assertEq(c.notes[1].lane, 6);
  assertEq(c.bpm, 120);
});
test('dtx: lead-in, measure/tick, wav defs with comments, volume/pan clamp, level', () => {
  const c = parseDTX('#TITLE: x\n#BPM: 120\n#DLEVEL: 850\n#WAV0A: kick.ogg\t;Bass\n#VOLUME0A: 150\n#PAN0A: -200\n#00013: 0A000A00\n#00112: 000B\n');
  assertEq(c.wavDefs.get('0A'), 'kick.ogg');
  assertEq(c.wavVolumes.get('0A'), 100);
  assertEq(c.wavPans.get('0A'), -100);
  assertEq(c.level[0], 85);
  assertEq(c.levelDec[0], 0);
  // 小節 0 頭 = 384tick 後 = 625*384/120 = 2000ms
  assertEq(c.notes[0].timeMs, 2000);
  assertEq(c.notes[0].measure, 0);
  assertEq(c.notes[0].tick, 0);
  assertEq(c.notes[1].timeMs, 3000);
  assertEq(c.notes[1].tick, 192);
  assertEq(c.notes[2].measure, 1);
  assertEq(c.notes[2].tick, 192);
  assertEq(c.notes[2].lane, 3);
  assertEq(c.durationMs, c.notes[2].timeMs);
  assertDeepEq(requiredWavIds(c), ['0A', '0B']);
});
test('dtx: bar/beat lines, bar length, C1 shift, C2 visibility (demo_features.dtx)', async () => {
  const c = parseDTX(decodeText(await fetchBytes('fixtures/demo_features.dtx')));
  const bars = c.barLines.filter((b) => !b.isBeat);
  const beats = (m) => c.barLines.filter((b) => b.isBeat && b.measure === m);
  assertEq(bars[0].measure, -1, 'lead-in bar');
  assertEq(bars[1].timeMs, 2000, 'measure 0 at 2000ms');
  assertEq(beats(0).length, 3, 'measure 0: 3 beat lines');
  assertEq(beats(2).length, 2, 'measure 2 (0.75): 2 beat lines');
  assertEq(beats(3).length, 7, 'measure 3 (2.0): 7 beat lines');
  assertEq(beats(4).length, 2, 'measure 4 (C1 shift 1/2): 2 beat lines');
  assert(beats(5).every((b) => !b.visible) && !bars.find((b) => b.measure === 5).visible, 'measure 5 hidden');
  assert(beats(6).every((b) => !b.visible), 'measure 6 hidden');
  assert(bars.find((b) => b.measure === 7).visible, 'measure 7 visible again');
  // 小節 3 は長さ 2.0 → 小節 4 の頭は小節 3 の頭 + 4000ms
  const m3 = bars.find((b) => b.measure === 3).timeMs;
  const m4 = bars.find((b) => b.measure === 4).timeMs;
  assertEq(m4 - m3, 4000);
  assert(c.fillInEvents.length >= 2, 'fill-in events');
  const times = buildMeasureTimes(c);
  assertEq(times[0], 0);
  assertEq(times[1], 2000);
  assertEq(measureIndexAt(times, 2500), 1);
  assertEq(measureIndexAt(times, 1999), 0);
});
test('dtx: hidden chips, bonus chips, SE, BGM, cheer', () => {
  const c = parseDTX('#BPM: 120\n#00001: 01\n#00013: 02\n#00033: 03\n#0004C: 06\n#00061: 04\n#0001F: 05\n');
  assertEq(c.notes.length, 1);
  assertEq(c.hiddenNotes.length, 1);
  assertEq(c.hiddenNotes[0].channel, 0x13);
  assertEq(c.hiddenNotes[0].hidden, true);
  assertEq(c.notes[0].bonus, true, 'bonus mark on BD');
  assertEq(c.bonusChipCount, 1);
  assertEq(c.bgmEvents.length, 1);
  assertEq(c.bgmEvents[0].timeMs, 2000);
  assertEq(c.seEvents.length, 1);
  assertEq(c.cheerEvents.length, 1);
  assertDeepEq(requiredWavIds(c), ['01', '02', '03', '04', '05']);
});
test('dtx: "_" separators ignored, ":" after whitespace stripped, xa header validation', async () => {
  const c = parseDTX('#BPM: 120\n#WAV01 :snare.wav\n#TITLE : foo\n#00011: 01_02_03\n');
  assertEq(c.wavDefs.get('01'), 'snare.wav');
  assertEq(c.title, 'foo');
  assertEq(c.notes.length, 3);
  assertEq(c.notes[1].tick, 128);
  assertEq(c.notes[2].wavId, '03');
  // 壊れた XA ヘッダ(サンプル数がデータ量と不整合)は巨大確保せずに拒否する
  const good = await fetchBytes('fixtures/Bass.xa');
  const bad = good.slice();
  new DataView(bad.buffer).setUint32(8, 1e9, true);
  let threw = false;
  try { decodeXA(bad); } catch (e) { threw = true; }
  assertEq(threw, true, 'corrupt sample count rejected');
});

test('dtx: header-only parse stops at body, detects lanes', () => {
  const h = parseDTXHeader('#TITLE: a\n#ARTIST: b\n#BPM: 150,5\n#DLEVEL85\n#00013: 0101\n#TITLE: ignored\n#00112: 01\n');
  assertEq(h.title, 'a');
  assertEq(h.bpm, 150.5);
  assertEq(h.level[0], 85);
  assertEq(h.laneHasNotes[5], true);
  assertEq(h.laneHasNotes[3], true);
  assertEq(h.laneHasNotes[0], false);
});

// ---- setdef ----
test('setdef: labels, defaults, multiple blocks', () => {
  const blocks = parseSetDef('#TITLE: 曲A\n#L1LABEL: BASIC\n#L1FILE: bsc.dtx\n#L3FILE: ext.dtx\n#L4LABEL: X\n\n#TITLE 曲B ;comment\n#L2FILE: adv.dtx\n');
  assertEq(blocks.length, 2);
  assertEq(blocks[0].title, '曲A');
  assertEq(blocks[0].labels[0], 'BASIC');
  assertEq(blocks[0].files[2], 'ext.dtx');
  assertEq(blocks[0].labels[2], 'EXPERT');
  assertEq(blocks[0].labels[3], '', 'label without file is dropped');
  assertEq(blocks[1].title, '曲B');
  assertEq(blocks[1].labels[1], 'REGULAR');
});

// ---- song package ----
test('song: joinPath normalizes backslashes and dots', () => {
  assertEq(joinPath('a/b/', 'c\\d.xa'), 'a/b/c/d.xa');
  assertEq(joinPath('a/b/', '..\\x.wav'), 'a/x.wav');
  assertEq(joinPath('', './y.ogg'), 'y.ogg');
});
test('song: package scan from pack_sjis.zip (UTF-16 set.def, sjis dtx)', async () => {
  const pkg = await SongPackage.fromZip((await fetchBytes('fixtures/pack_sjis.zip')).buffer, 'pack');
  assertEq(pkg.songs.length, 1, 'songs: ' + JSON.stringify(pkg.songs.map((s) => s.title)));
  const s = pkg.songs[0];
  assertEq(s.title, 'テストセット');
  assertEq(s.charts.length, 1);
  assertEq(s.charts[0].label, 'BASIC');
  assertEq(s.charts[0].path, '道場テスト/譜面.dtx');
  assertEq(s.charts[0].header.title, 'テスト曲');
  const chart = await pkg.loadChart(s.charts[0].path);
  assertEq(chart.notes.length, 6);
  assertEq(chart.wavDefs.get('02'), 'Sounds\\Kick.wav');
  const kick = pkg.resolve(chart.dir, chart.wavDefs.get('02'));
  assertEq(kick.name, '道場テスト/Sounds/Kick.wav');
  const snare = pkg.resolve(chart.dir, 'sounds/SNARE.XA');
  assertEq(snare.name, '道場テスト/Sounds/Snare.xa', 'case-insensitive');
  assertEq(pkg.resolve(chart.dir, 'nothing.wav'), null);
  assertEq(pkg.resolve(chart.dir, 'Kick.wav').name, '道場テスト/Sounds/Kick.wav', 'same-folder subtree rescue');
  assertEq(pkg.resolve('utf8名前/', 'Kick.wav'), null, 'never borrows from another song folder');
  const xa = decodeXA(await pkg.readBytes(snare));
  assertEq(xa.sampleRate, 44100);
});
