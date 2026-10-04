// ギター / ベース: 譜面の読み込み・楽器別の曲のまとめ・成績の式・演奏(GuitarPlayer)。
import { test, assert, assertEq, assertNear, assertDeepEq } from './runner.js';
import {
  parseDTX, parseDTXHeader, requiredWavIds, GB_CHANNEL, INSTRUMENT, instrumentOfChannel, gbPart,
} from '../js/core/dtx.js';
import { stripInstrumentTag, normalizeTitle, mergeInstrumentSongs, chartHasInstrument, instrumentMask } from '../js/core/instmerge.js';
import {
  gbScoreDelta, wailingBonus, fretsMatch, findPickTarget, autoPickHits, isAutoChip, gbScoreRevise, gbAchievementRevise,
  gbAchievementRate, GbStats, GB_GAUGE_DELTA,
} from '../js/game/gbjudge.js';
import { GuitarPlayer, GB_SCROLL_BASE_PX_PER_MS, PICK_SETTLE_MS } from '../js/game/gbplayer.js';
import { Player, PLAYER_STATE, SCROLL_BASE_PX_PER_MS, buildAccompaniment } from '../js/game/player.js';
import { TrainingSettings, GB_AUTO_PICK, GB_AUTO_WAIL } from '../js/game/training.js';
import { JUDGE } from '../js/game/hitranges.js';
import { GAUGE_INITIAL } from '../js/game/judge.js';
import { GuitarInput, GB_TOUCH_OPEN } from '../js/ui/gbinput.js';

// ---- 譜面 ----

test('gb parse: channel → part / bits table (3 lanes, +Y, +P, +Y+P)', () => {
  const g = (ch) => GB_CHANNEL[ch];
  assertDeepEq(g(0x20), { part: 1, bits: 0 }, 'guitar OPEN');
  assertDeepEq(g(0x21), { part: 1, bits: 1 }, 'B');
  assertDeepEq(g(0x24), { part: 1, bits: 4 }, 'R');
  assertDeepEq(g(0x27), { part: 1, bits: 7 }, 'RGB');
  assertDeepEq(g(0x93), { part: 1, bits: 16 }, 'Y');
  assertDeepEq(g(0x9a), { part: 1, bits: 23 }, 'RGBY');
  assertDeepEq(g(0x9b), { part: 1, bits: 32 }, 'P');
  assertDeepEq(g(0xa9), { part: 1, bits: 37 }, 'RBP (0xA9 は 0x9F の続き)');
  assertDeepEq(g(0xac), { part: 1, bits: 48 }, 'YP');
  assertDeepEq(g(0xd3), { part: 1, bits: 55 }, 'RGBYP');
  assertDeepEq(g(0xa0), { part: 2, bits: 0 }, 'bass OPEN');
  assertDeepEq(g(0xa7), { part: 2, bits: 7 });
  assertDeepEq(g(0xc5), { part: 2, bits: 16 });
  assertDeepEq(g(0xc6), { part: 2, bits: 17 });
  assertDeepEq(g(0xc8), { part: 2, bits: 18 }, '0xC7 は飛ばす');
  assertDeepEq(g(0xce), { part: 2, bits: 32 });
  assertDeepEq(g(0xda), { part: 2, bits: 34 }, '0xD0-0xD9 は飛ばす');
  assertDeepEq(g(0xe1), { part: 2, bits: 48 });
  assertDeepEq(g(0xe8), { part: 2, bits: 55 });
  for (const ch of [0x28, 0x2c, 0x2d, 0xa8, 0xba, 0xbb, 0x2f, 0xc7, 0xe0, 0x11]) assertEq(g(ch), undefined, 'not a chip: ' + ch.toString(16));
  assertEq(Object.keys(GB_CHANNEL).length, 64, '32 patterns × 2 parts');
  assertEq(instrumentOfChannel(0x28), INSTRUMENT.GUITAR);
  assertEq(instrumentOfChannel(0x2d), INSTRUMENT.BASS);
  assertEq(instrumentOfChannel(0x33), INSTRUMENT.DRUMS);
  assertEq(instrumentOfChannel(0xba), -1);
});

test('gb parse: notes, open, wailing, long notes, duration, wav ids', () => {
  // BPM 120: 小節 0 頭 = 2000ms、4 分 = 500ms
  const c = parseDTX([
    '#BPM: 120',
    '#WAV01: r.wav', '#WAV02: gb.wav', '#WAV03: open.wav', '#WAV04: b1.wav', '#WAV05: nochip.wav', '#WAV06: wail.wav', '#WAV07: bgm.wav',
    '#00001: 07',
    '#00024: 01000000', // R 2000(ロングノート 2000-3000)
    '#00123: 02000300', // GB 4000、GB 5000
    '#00120: 00030000', // OPEN 4500
    '#0002C: 01000100', // LN 2000 → 3000
    '#00028: 00000100', // ウェイリング 3000
    '#001BA: 05', // 空ピック音 4000
    '#0012F: 06', // ウェイリング音 4000
    '#000A4: 04', // ベース R 2000
    '#000C5: 0004', // ベース Y 3000
  ].join('\n'));
  const g = c.guitar;
  assertEq(g.notes.length, 4);
  assertDeepEq(g.notes.map((n) => [n.timeMs, n.bits, n.wavId]), [[2000, 4, '01'], [4000, 3, '02'], [4500, 0, '03'], [5000, 3, '03']]);
  assertEq(g.notes[2].open, true);
  assertEq(g.notes[0].lnEndMs, 3000, 'R の LN の終端');
  assertEq(g.notes[1].lnEndMs, -1);
  assertDeepEq(g.wailing.map((w) => w.timeMs), [3000]);
  assertDeepEq(g.noChipEvents.map((e) => [e.timeMs, e.wavId]), [[4000, '05']]);
  assertDeepEq(c.wailSoundEvents.map((e) => [e.timeMs, e.wavId]), [[4000, '06']]);
  assertEq(g.hasYP, false);
  assertEq(c.bass.notes.length, 2);
  assertEq(c.bass.hasYP, true);
  assertEq(c.bass.notes[1].bits, 16);
  assertEq(c.noteMask, 6, 'guitar + bass, no drums');
  assertEq(c.notes.length, 0);
  assertEq(c.durationMs, 5000, 'last guitar chip');
  const ids = requiredWavIds(c);
  for (const id of ['07', '01', '02', '03', '04', '05', '06']) assert(ids.includes(id), 'wav ' + id);
  assertEq(gbPart(c, INSTRUMENT.BASS), c.bass);
  assertEq(gbPart(c, INSTRUMENT.DRUMS), null);
});

test('gb parse: long-note pairing rules', () => {
  // 区間内(終端の位置を含む)にチップがあれば捨てる
  let c = parseDTX('#BPM: 120\n#00024: 01010000\n#0002C: 01000100\n');
  assertEq(c.guitar.notes.filter((n) => n.lnEndMs >= 0).length, 0, 'chip inside the span → dropped');
  c = parseDTX('#BPM: 120\n#00024: 01000100\n#0002C: 01000100\n');
  assertEq(c.guitar.notes[0].lnEndMs, -1, 'chip at the end position → dropped');
  // OPEN は始端になれない(同じ位置に OPEN しか無ければ次の制御チップを始端として読み直す)
  c = parseDTX('#BPM: 120\n#00020: 01000000\n#00024: 00010000\n#0002C: 01010001\n');
  assertEq(c.guitar.notes[0].lnEndMs, -1, 'OPEN is never an LN start');
  assertEq(c.guitar.notes[1].lnEndMs, 3500, 'next control chip became the start');
  // 終端は LN の長さぶん曲の長さを伸ばす
  c = parseDTX('#BPM: 120\n#000A1: 01\n#0002D: 01\n#0012D: 01\n');
  assertEq(c.bass.notes[0].lnEndMs, 4000);
  assertEq(c.durationMs, 4000);
});

test('gb parse: header note mask and levels per instrument', () => {
  const h = parseDTXHeader('#TITLE: x\n#GLEVEL: 74\n#BLEVEL: 650\n#00093: 01\n#000A8: 01\n#00013: 00\n');
  assertEq(h.level[1], 74);
  assertEq(h.level[2], 65);
  assertEq(h.levelDec[2], 0);
  assertEq(h.noteMask, 6, 'guitar chip + bass wailing; the empty drum line does not count');
  assertEq(parseDTXHeader('#00011: 01\n').noteMask, 1);
});

// ---- 楽器別の曲のまとめ ----

test('instmerge: strip instrument tags like DTXManiaAI', () => {
  assertEq(stripInstrumentTag('完全感覚Dreamer (Drum)'), '完全感覚Dreamer');
  assertEq(stripInstrumentTag('曲名 (Guitar)'), '曲名');
  assertEq(stripInstrumentTag('曲名 【ベース】'), '曲名');
  assertEq(stripInstrumentTag('[Guitar] 曲名'), '曲名');
  assertEq(stripInstrumentTag('曲名 - Bass'), '曲名');
  assertEq(stripInstrumentTag('曲名 -GUITAR-'), '曲名');
  assertEq(stripInstrumentTag('曲名_dr'), '曲名');
  assertEq(stripInstrumentTag('曲名 (Drum only)'), '曲名', 'bracket containing drum');
  assertEq(stripInstrumentTag('曲名 (G)'), '曲名', 'single letter in brackets');
  assertEq(stripInstrumentTag('Plan B'), 'Plan B', 'b outside brackets is not a tag');
  assertEq(stripInstrumentTag('Drum Solo'), 'Drum Solo');
  assertEq(stripInstrumentTag('(Drum)'), '(Drum)', 'a title made only of a tag is kept');
  assertEq(normalizeTitle('  A  B (Bass) '), 'a b');
});

test('instmerge: merge split drum / guitar / bass blocks of one folder into one song', () => {
  const ch = (path, levels, noteMask, title = '完全感覚Dreamer') => ({ label: 'MASTER', path, header: { title, levels, levelDecs: [0, 0, 0], noteMask } });
  const songs = [
    { title: '完全感覚Dreamer (Drum)', dir: 'a/', charts: [ch('a/dm.dtx', [70, 0, 0], 1)] },
    { title: '完全感覚Dreamer (Guitar)', dir: 'a/', charts: [ch('a/gt.dtx', [0, 74, 0], 2)] },
    { title: '完全感覚Dreamer (Bass)', dir: 'a/', charts: [ch('a/ba.dtx', [0, 0, 73], 4)] },
    { title: '完全感覚Dreamer (Bass)', dir: 'b/', charts: [ch('b/ba.dtx', [0, 0, 73], 4)] }, // 別のフォルダ
    { title: 'Other', dir: 'a/', charts: [ch('a/o.dtx', [50, 0, 0], 1, 'Other')] },
    { title: 'Other 2', dir: 'a/', charts: [ch('a/o2.dtx', [50, 0, 0], 1, 'Other')] }, // 楽器が重なる → まとめない
  ];
  const out = mergeInstrumentSongs(songs);
  assertEq(out.length, 4);
  assertEq(out[0].title, '完全感覚Dreamer');
  assertDeepEq(out[0].charts.map((c) => c.path), ['a/dm.dtx', 'a/gt.dtx', 'a/ba.dtx']);
  assertEq(instrumentMask(out[0]), 7);
  assertEq(out[1].dir, 'b/');
  assertEq(out[2].title, 'Other');
  assertEq(out[3].title, 'Other 2');
  // 題名の添え字で合わなくても DTX の #TITLE が同じならまとめ、その題名を使う
  const out2 = mergeInstrumentSongs([
    { title: 'Song DR ver', dir: 'c/', charts: [ch('c/d.dtx', [60, 0, 0], 1, 'Song')] },
    { title: 'Song GT ver', dir: 'c/', charts: [ch('c/g.dtx', [0, 60, 0], 2, 'Song')] },
  ]);
  assertEq(out2.length, 1);
  assertEq(out2[0].title, 'Song');
  assertEq(chartHasInstrument({ levels: [0, 0, 0], levelDecs: [0, 0, 5], noteMask: 0 }, 2), true, 'level decimal counts');
  assertEq(chartHasInstrument({ levels: [0, 0, 0], levelDecs: [0, 0, 0], noteMask: 2 }, 1), true, 'chips count');
});

// ---- 成績の式 ----

test('gb score: all-Perfect reaches 1,000,000 + LN bonus; float32 table values', () => {
  const base = Math.fround(1000000 / Math.fround(1275 + Math.fround(50 * Math.fround(537 - 50))));
  assertNear(base, 39.024391, 1e-5, 'gt_mst base');
  assertEq(gbScoreDelta(JUDGE.PERFECT, 60, 60, 60, 537, 0, 0), 1951);
  assertEq(gbScoreDelta(JUDGE.GREAT, 60, 0, 0, 537, 0, 0), 975);
  assertEq(gbScoreDelta(JUDGE.GOOD, 60, 0, 0, 537, 0, 0), 390);
  assertEq(gbScoreDelta(JUDGE.OK, 60, 0, 0, 537, 0, 0), 0);
  for (const total of [30, 50, 501, 537]) {
    const st = new GbStats(total);
    for (let i = 0; i < total; i++) {
      if (i === 10) st.lnTick(); // ロングノートの加点は全 Perfect の補正に足される
      st.judge(JUDGE.PERFECT, {});
    }
    assertEq(st.score, 1000100, 'total=' + total);
  }
  assertEq(wailingBonus(1), 100);
  assertEq(wailingBonus(500), 50000);
  assertEq(wailingBonus(501), 50000);
  assertDeepEq(GB_GAUGE_DELTA, [0.006, 0.003, 0, -0.030, -0.050]);
});

test('gb score: AUTO revise, achievement revise, rate', () => {
  const lanes = (s) => s.split('').map((c) => c === '1'); // R G B Y P PICK WAIL
  assertEq(gbScoreRevise(lanes('0000000')), 1);
  assertEq(gbScoreRevise(lanes('0000010')), 0.5, 'auto pick');
  assertEq(gbScoreRevise(lanes('1000000')), 0.5, 'one neck lane');
  assertEq(gbScoreRevise(lanes('1100010')), 0.25);
  assertEq(gbScoreRevise(lanes('0000001')), 1, 'wail does not count');
  assertEq(gbScoreRevise(lanes('1111110')), 0, 'all auto without AutoAddGage');
  assertEq(gbScoreRevise(lanes('1111110'), true), 1);
  assertNear(gbAchievementRevise(lanes('1000000')), 1 / Math.SQRT2, 1e-12);
  assertNear(gbAchievementRevise(lanes('1111100')), 1 / Math.sqrt(6), 1e-12);
  assertEq(gbAchievementRevise(lanes('0000010')), 0.5);
  assertEq(gbAchievementRevise(lanes('1111110')), 1);
  assertNear(gbAchievementRate([10, 0, 0, 0, 0], 10, 10), 100, 1e-9);
  assertEq(gbAchievementRate([0, 0, 0, 0, 0], 10, 10), 0, 'no manual judgement → no combo term');
});

test('gb judge helpers: fret match, pick target (past priority), auto pick, auto chip', () => {
  assertEq(fretsMatch(4, 4, 0), true);
  assertEq(fretsMatch(4, 6, 0), false, 'extra fret fails (no anchoring)');
  assertEq(fretsMatch(0, 0, 0), true, 'OPEN with nothing held');
  assertEq(fretsMatch(0, 2, 0), false, 'OPEN with a fret held');
  assertEq(fretsMatch(6, 4, 2), true, 'AUTO G is masked');
  const notes = [{ timeMs: 1000 }, { timeMs: 1100 }, { timeMs: 1300 }];
  assertEq(findPickTarget(notes, [false, false, false], 1090, 117), 0, 'past chip within the window wins over a nearer future one');
  assertEq(findPickTarget(notes, [true, false, false], 1090, 117), 1, 'judged chips are skipped');
  assertEq(findPickTarget(notes, [true, true, false], 1200, 117), 2);
  assertEq(findPickTarget(notes, [true, true, false], 1150, 117), -1, 'future chip outside the window');
  assertEq(findPickTarget(notes, [false, false, false], 1200, 117), 1, 'nearest past chip');
  const auto = (s) => s.split('').map((c) => c === '1');
  assertEq(autoPickHits(4, 0, auto('1000010')), true, 'chip lanes = auto lanes');
  assertEq(autoPickHits(6, 2, auto('1000010')), true, 'manual G held');
  assertEq(autoPickHits(6, 0, auto('1000010')), false, 'manual G missing');
  assertEq(autoPickHits(4, 2, auto('0000010')), false, 'wrong fret');
  assertEq(autoPickHits(0, 0, auto('0000010')), true, 'OPEN nothing held');
  assertEq(isAutoChip({ bits: 4, open: false }, auto('1000010')), true);
  assertEq(isAutoChip({ bits: 6, open: false }, auto('1000010')), false);
  assertEq(isAutoChip({ bits: 4, open: false }, auto('1000000')), false, 'manual pick → never AUTO');
  assertEq(isAutoChip({ bits: 0, open: true }, auto('1111010')), false, 'OPEN needs all five');
  assertEq(isAutoChip({ bits: 0, open: true }, auto('1111110')), true);
});

test('gb stats: counts, combo through AUTO, bad, loop reset, full-combo bonus', () => {
  const st = new GbStats(4);
  st.judge(JUDGE.PERFECT, { auto: true, rev: 0.5 });
  assertEq(st.counts[0], 0, 'AUTO chips are not in counts');
  assertEq(st.countsIncAuto[0], 1);
  assertEq(st.combo, 1, 'combo advances on AUTO chips');
  assertNear(st.gauge, GAUGE_INITIAL, 1e-12, 'AUTO chips do not move the gauge');
  st.judge(JUDGE.GREAT, { lagMs: 20, rev: 0.5 });
  assertEq(st.lateCount, 1);
  assertEq(st.counts[1], 1);
  assertNear(st.gauge, GAUGE_INITIAL + 0.003, 1e-12);
  st.bad();
  assertEq(st.combo, 0, 'BAD breaks the combo');
  assertEq(st.total, 1, 'BAD is not counted');
  assertNear(st.gauge, GAUGE_INITIAL + 0.003 - 0.025, 1e-12, 'BAD = Miss damage × Normal');
  assertEq(st.maxCombo, 2);
  const g = st.gauge;
  st.resetForLoop();
  assertEq(st.combo, 0);
  assertEq(st.counts[1], 0);
  assertEq(st.countsIncAuto[0], 1, 'IncAuto counts survive the loop');
  assertEq(st.gauge, g, 'gauge survives the loop');
  const fc = new GbStats(3);
  for (let i = 0; i < 3; i++) fc.judge(JUDGE.PERFECT, {});
  assertEq(fc.fullComboBonus(), 30000);
  const fc2 = new GbStats(2);
  fc2.judge(JUDGE.PERFECT, {});
  fc2.judge(JUDGE.GOOD, {});
  assertEq(fc2.fullComboBonus(), 15000);
  const nofc = new GbStats(2);
  nofc.judge(JUDGE.OK, {});
  assertEq(nofc.fullComboBonus(), 0);
});

// ---- 演奏 ----

function fakeAudio() {
  let t = 0;
  return {
    ctx: { get currentTime() { return t; } },
    outputLatencySec: 0,
    buffers: new Map(),
    played: [],
    stopped: [],
    advance(ms) { t += ms / 1000; },
    async loadChartSounds() { return this.buffers; },
    hasBuffer(id) { return this.buffers.has(id); },
    play(id, opts) { const v = { id, ...opts, src: null }; this.played.push(v); return v; },
    playBuffer(buf, opts) { this.played.push(opts); return { src: null }; },
    stopVoice(v, at) { this.stopped.push({ v, at }); },
    stopAll() {},
    synthBuffer(lane) { return { lane }; },
  };
}

/** performance.now を音の時計に合わせて fn を走らせる(perf ms = ctx 秒 × 1000)。 */
async function withClock(audio, fn) {
  const orig = performance.now;
  performance.now = () => audio.ctx.currentTime * 1000;
  try {
    await fn(() => audio.ctx.currentTime * 1000);
  } finally {
    performance.now = orig;
  }
}

async function makeGb(text, inst = INSTRUMENT.GUITAR, setup) {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  if (setup) setup(settings);
  const player = new GuitarPlayer({ audio, settings, config: {}, inst });
  const chart = parseDTX(text);
  for (const id of chart.wavDefs.keys()) audio.buffers.set(id, { duration: 1 });
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  return { audio, settings, player, chart };
}

// R(2000) GB(2500) OPEN(3000) R-LN(3500-4500)、ウェイリング 2500、ドラム BD 2000 と ベース 3000(伴奏)
const GB_CHART = [
  '#BPM: 120',
  '#WAV01: r.wav', '#WAV02: gb.wav', '#WAV03: open.wav', '#WAV04: ln.wav', '#WAV05: bd.wav', '#WAV06: ba.wav',
  '#00024: 01000004',
  '#00023: 00020000',
  '#00020: 00000300',
  '#0002C: 00000001',
  '#0012C: 00010000',
  '#00028: 00020000',
  '#00013: 05',
  '#000A1: 0006',
].join('\n');

test('gb player: load, accompaniment, scroll base', async () => {
  const { player, chart } = await makeGb(GB_CHART);
  assertEq(player.notes, chart.guitar.notes);
  assertEq(player.notes.length, 4);
  assertEq(player.state, PLAYER_STATE.STANDBY);
  assertDeepEq(player.accomp.map((e) => [e.timeMs, e.wavId, e.mono]), [[2000, '05', null], [3000, '06', 'bass']], 'drums + bass are accompaniment');
  assertEq(GB_SCROLL_BASE_PX_PER_MS, SCROLL_BASE_PX_PER_MS / 2);
  assertNear(player.pixelsPerMs, GB_SCROLL_BASE_PX_PER_MS * 2, 1e-12, 'default x2.0');
  assertDeepEq(buildAccompaniment(chart, INSTRUMENT.DRUMS).map((e) => e.mono), ['guitar', 'guitar', 'guitar', 'bass', 'guitar'], 'drum mode plays guitar and bass chips');
});

test('gb player: pick with matching frets, wrong frets, settle window, open, miss', async () => {
  const { audio, player } = await makeGb(GB_CHART);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    // R(2000) を R を押さえて 10ms 遅れでピック → Perfect
    audio.advance(2010);
    player.update(perf(), null);
    player.fret(0, true, perf());
    player.pick(perf());
    assertEq(player.stats.counts[0], 1, 'perfect');
    assertNear(player.stats.lastLagMs, 10, 1.5);
    assert(audio.played.some((p) => p.id === '01' && p.bus === 'chip'), 'chip sound on the chip bus');
    assertEq(player.wailQueue.length, 0, 'no wailing chip near 2000');
    player.fret(0, false, perf());
    // GB(2500): G だけ押さえてピック → 待つ → 窓の中で B を足すとピックの時刻で判定
    audio.advance(2495 - 2010);
    player.update(perf(), null);
    player.fret(1, true, perf());
    player.pick(perf());
    assert(player.pendingPick, 'waits for the chord');
    audio.advance(PICK_SETTLE_MS.key - 10);
    player.fret(2, true, perf());
    assertEq(player.pendingPick, null);
    assertEq(player.stats.counts[0], 2, 'judged at the pick time (5ms early) → perfect');
    assertNear(player.stats.lastLagMs, -5, 1.5);
    assertEq(player.wailQueue.length, 1, 'wailing chip at 2500 reserved');
    // ウェイリングで加点(コンボ 2 × 100)
    const before = player.stats.score;
    player.wail(perf());
    assertEq(player.stats.score - before, 200);
    assertEq(player.wailDone[0], true);
    player.fret(1, false, perf());
    player.fret(2, false, perf());
    // OPEN(3000): B を押さえたまま → 外れ(空ピック、Light ON なので BAD なし)
    audio.advance(3000 - perf());
    player.update(perf(), null);
    player.fret(2, true, perf());
    player.pick(perf());
    audio.advance(PICK_SETTLE_MS.key + 1);
    player.update(perf(), null);
    assertEq(player.pendingPick, null, 'resolved after the window');
    assertEq(player.stats.combo, 2, 'Light ON: empty pick keeps the combo');
    assertEq(player.judged[2], false, 'the OPEN chip is still waiting');
    player.fret(2, false, perf());
    player.pick(perf());
    assertEq(player.stats.counts[0] + player.stats.counts[1], 3, 'OPEN hit with nothing held');
    // R-LN(3500) は放置 → Miss
    audio.advance(3500 + 118 - perf());
    player.update(perf(), null);
    assertEq(player.stats.counts[4], 1, 'miss after the Poor window');
    assertEq(player.stats.combo, 0);
  });
  player.dispose();
});

test('gb player: Light OFF turns an empty pick into BAD', async () => {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  const player = new GuitarPlayer({ audio, settings, config: { light: false }, inst: INSTRUMENT.GUITAR });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX(GB_CHART));
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    audio.advance(2000);
    player.update(perf(), null);
    player.fret(0, true, perf());
    player.pick(perf());
    assertEq(player.stats.combo, 1);
    player.fret(1, true, perf()); // R + G → R のチップは当たったあと。次のピックは空
    player.pick(perf());
    audio.advance(PICK_SETTLE_MS.key + 1);
    player.update(perf(), null);
    assertEq(player.stats.combo, 0, 'BAD breaks the combo');
    assertEq(player.gbJudge.bad, true);
    assertEq(player.stats.total, 1, 'BAD is not counted');
  });
  player.dispose();
});

test('gb player: long-note hold ticks, early release stops the sound', async () => {
  const { audio, player } = await makeGb(GB_CHART);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    player.jumpTo(3400, true);
    audio.advance(100);
    player.update(perf(), null);
    assertNear(player.songMs, 3500, 1);
    player.fret(0, true, perf());
    player.pick(perf());
    assertEq(player.holdIndex, 3, 'hold started');
    // 1000ms の LN を 6 等分: 3666, 3833, 4000, 4166, 4333 で加点
    for (let t = 3510; t <= 4400; t += 10) {
      audio.advance(10);
      player.update(perf(), null);
    }
    assertEq(player.holdSegment, 5, 'five ticks');
    assertEq(player.stats.lnBonus, 500);
    audio.advance(150);
    player.update(perf(), null);
    assertEq(player.holdIndex, -1, 'released at the end');
  });
  player.dispose();
  // 早く離すと保持が解けて音が止まる
  const r = await makeGb(GB_CHART);
  await withClock(r.audio, async (perf) => {
    r.player.command('startStop');
    r.player.update(perf(), null);
    r.player.jumpTo(3400, true);
    r.audio.advance(100);
    r.player.update(perf(), null);
    r.player.fret(0, true, perf());
    r.player.pick(perf());
    r.audio.advance(200);
    r.player.update(perf(), null);
    r.player.fret(0, false, perf());
    const stops = r.audio.stopped.length;
    r.audio.advance(10);
    r.player.update(perf(), null);
    assertEq(r.player.holdIndex, -1, 'released early');
    assert(r.audio.stopped.length > stops, 'sound stopped');
  });
  r.player.dispose();
});

test('gb player: AUTO pick hits with the right frets, forced miss otherwise; auto play is a demo', async () => {
  const { audio, player } = await makeGb(GB_CHART, INSTRUMENT.GUITAR, (s) => { s.gbAutoLanes[GB_AUTO_PICK] = true; });
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    player.fret(0, true, perf());
    audio.advance(2001);
    player.update(perf(), null);
    assertEq(player.stats.counts[0], 1, 'R held → hit (not an AUTO chip: neck is manual)');
    player.pick(perf());
    assertEq(player.stats.total, 1, 'pick key is ignored under AUTO pick');
    audio.advance(500);
    player.update(perf(), null);
    assertEq(player.stats.counts[4], 1, 'GB chip with only R held → forced miss');
    assertEq(player.scoreRev, 0.5);
  });
  player.dispose();
  const d = await makeGb(GB_CHART, INSTRUMENT.GUITAR, (s) => { s.autoPlay = true; });
  await withClock(d.audio, async (perf) => {
    d.player.command('startStop');
    d.player.update(perf(), null);
    d.audio.advance(4600);
    d.player.update(perf(), null);
    assertEq(d.player.stats.counts[0], 4, 'demo judges everything Perfect and counts it');
    assertEq(d.player.stats.combo, 4);
    assertEq(d.player.wailDone[0], true, 'auto wailing consumed');
  });
  d.player.dispose();
});

test('gb player: AUTO wailing gives no bonus; loop wrap resets stats like NX', async () => {
  const { audio, player, settings } = await makeGb(GB_CHART, INSTRUMENT.GUITAR, (s) => { s.gbAutoLanes[GB_AUTO_WAIL] = true; });
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    audio.advance(2500);
    player.update(perf(), null);
    player.fret(1, true, perf());
    player.fret(2, true, perf());
    player.pick(perf());
    const sc = player.stats.score;
    player.update(perf(), null);
    assertEq(player.wailDone[0], true, 'auto wailing consumed the reservation');
    assertEq(player.stats.score, sc, 'no bonus for AUTO wailing');
    // ループ: 2000〜3200 を回ると成績(スコア・コンボ・判定数)は戻り、ゲージは残る
    settings.loop = true;
    settings.loopBeginMs = 2000;
    settings.loopEndMs = 3200;
    player.applySettings();
    const gauge = player.stats.gauge;
    audio.advance(800);
    player.update(perf(), null);
    assertEq(player.stats.combo, 0);
    assertEq(player.stats.total, 0);
    assertEq(player.stats.gauge, gauge);
    assertEq(player.judged[1], false, 'chips after the loop start are pickable again');
    assertEq(player.wailDone[0], false, 'wailing chip restored');
  });
  player.dispose();
});

test('drum player: guitar and bass chips of a combined chart are accompaniment (mono per part)', async () => {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  const player = new Player({ audio, settings, config: {} });
  const chart = parseDTX('#BPM: 120\n#WAV01: g1.wav\n#WAV02: g2.wav\n#WAV03: sd.wav\n#00021: 0102\n#00012: 03\n');
  for (const id of ['01', '02', '03']) audio.buffers.set(id, { duration: 1 });
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    audio.advance(2900); // 先読み 200ms で 3000 の音まで予約される
    player.update(perf(), null);
    const g = audio.played.filter((p) => p.id === '01' || p.id === '02');
    assertEq(g.length, 2, 'both guitar chips scheduled');
    assert(g.every((p) => p.bus === 'bgm'), 'on the BGM bus');
    assertNear(g[1].when, 3.0, 0.01, 'second chip at 3000ms');
    assert(audio.stopped.some((s) => s.v === g[0] && Math.abs(s.at - g[1].when) < 1e-9), 'previous guitar voice stopped when the next starts');
  });
  player.dispose();
});

test('gb input: frets are held while any of their keys is down; pick and wail are edges; touch picks', () => {
  const ev = [];
  const input = new GuitarInput({
    onFret: (lane, down) => ev.push(['fret', lane, down]),
    onPick: (ts, source) => ev.push(['pick', source]),
    onWail: () => ev.push(['wail']),
  });
  input.setBindings([['KeyA', 'KeyQ'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['KeyJ', 'KeyK'], ['KeyL']]);
  const key = (type, code, repeat = false) => input[type === 'down' ? '_onKeyDown' : '_onKeyUp']({ code, repeat, timeStamp: 1, target: null, preventDefault() {} });
  key('down', 'KeyA');
  key('down', 'KeyQ'); // 同じボタンの 2 つ目のキー: 状態は変わらない
  key('up', 'KeyA');
  assertEq(input.isFretDown(0), true, 'still held by Q');
  key('up', 'KeyQ');
  key('down', 'KeyJ');
  key('down', 'KeyJ', true); // OS のキーリピートはピックにしない
  key('down', 'KeyK');
  key('up', 'KeyJ');
  key('down', 'KeyL');
  assertDeepEq(ev, [['fret', 0, true], ['fret', 0, false], ['pick', 'key'], ['pick', 'key'], ['wail']]);
  // タッチ: レーンを押すと押さえてからピック、離すと離す。レーンの外は何も押さえずにピック
  ev.length = 0;
  input.hitTest = (x) => (x < 100 ? 2 : x < 200 ? GB_TOUCH_OPEN : -1);
  const ptr = (type, x, id) => input[type === 'down' ? '_onPointerDown' : '_onPointerUp']({ clientX: x, clientY: 0, pointerId: id, pointerType: 'touch', button: 0, timeStamp: 5, preventDefault() {} });
  ptr('down', 50, 1);
  ptr('down', 150, 2);
  ptr('down', 250, 3); // 当たらない
  ptr('up', 50, 1);
  ptr('up', 150, 2);
  assertDeepEq(ev, [['fret', 2, true], ['pick', 'touch'], ['pick', 'touch'], ['fret', 2, false]]);
  input.releaseAll(0);
});

test('gb player: a pick waiting for its chord near the end of the window is not lost to miss detection', async () => {
  const { audio, player } = await makeGb(GB_CHART);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    // GB(2500) を 110ms 遅れでピック(G だけ)→ 10ms 後のフレームは窓(117ms)の外だが、待っている間は Miss にしない
    player.jumpTo(2400, true);
    audio.advance(210);
    player.update(perf(), null);
    player.fret(1, true, perf());
    player.pick(perf());
    assert(player.pendingPick, 'waiting');
    audio.advance(10);
    player.update(perf(), null);
    assertEq(player.judged[1], false, 'not missed while the pick waits');
    player.fret(2, true, perf());
    assertEq(player.stats.counts[3], 1, 'judged Ok(Poor) at the pick time (110ms late)');
    assertEq(player.stats.counts[4], 0);
  });
  player.dispose();
});

// ---- レビューで見つかったこと ----

test('gb parse: strict channel hex and integer levels (like NX int.TryParse)', () => {
  const c = parseDTX('#BPM: 120\n#00022: 01\n#0012X: 02\n#00322: 01\n');
  assertDeepEq(c.guitar.notes.map((n) => n.timeMs), [2000, 8000], "'2X' is not read as channel 02 (bar length)");
  const h = parseDTXHeader('#DLEVEL 50\n#GLEVEL 74.5\n#BLEVEL 7x\n#00013: 01\n');
  assertDeepEq(h.level, [50, 0, 0], 'non-integer levels are ignored');
  assertEq(parseDTXHeader('#GLEVEL +74\n').level[1], 74);
});

test('gb player: releasing a held LN under AUTO pick stops only that LN (not the next scheduled chip)', async () => {
  // R-LN 2000-3000、G 3062.5(終端のすぐ後。終端と同じ位置のチップは LN を取り消すので少しずらす)。AUTO ピック・ネックは手動。
  // 小節 0 を 32 分割して、G は 17 番目(2000 + 17 × 62.5)
  const g = '00'.repeat(17) + '02' + '00'.repeat(14);
  const { audio, player } = await makeGb('#BPM: 120\n#WAV01: r.wav\n#WAV02: g.wav\n#00024: 01000000\n#00022: ' + g + '\n#0002C: 01000100\n', INSTRUMENT.GUITAR,
    (s) => { s.gbAutoLanes[GB_AUTO_PICK] = true; });
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    player.fret(0, true, perf());
    audio.advance(2001);
    player.update(perf(), null);
    assertEq(player.holdIndex, 0, 'LN held');
    const rVoice = audio.played.find((p) => p.id === '01');
    audio.advance(2870 - 2001);
    player.update(perf(), null); // G(3062.5)の音は先読み 200 ms でこの時点で予約される
    const gVoice = audio.played.find((p) => p.id === '02');
    assert(gVoice, 'G scheduled ahead');
    // 終端の Poor の窓(117 ms)より前に離す
    player.fret(0, false, perf());
    player.fret(1, true, perf());
    audio.advance(5);
    player.update(perf(), null);
    assertEq(player.holdIndex, -1, 'released');
    assert(audio.stopped.some((s) => s.v === rVoice && s.at === undefined), 'the LN voice is stopped now');
    assert(!audio.stopped.some((s) => s.v === gVoice), 'the scheduled G voice is not stopped');
  });
  player.dispose();
});

test('gb stats: the all-Perfect correction and the full-combo bonus count only this lap', () => {
  const st = new GbStats(100);
  for (let i = 0; i < 100; i++) st.judge(JUDGE.PERFECT, {});
  assertEq(st.score, 1000000);
  st.resetForLoop();
  for (let i = 0; i < 100; i++) st.judge(i < 10 ? JUDGE.GREAT : JUDGE.PERFECT, {});
  const fresh = new GbStats(100);
  for (let i = 0; i < 100; i++) fresh.judge(i < 10 ? JUDGE.GREAT : JUDGE.PERFECT, {});
  assertEq(st.score, fresh.score, 'lap 2 scores like a fresh run (no spurious 1,000,000)');
  assert(st.score < 1000000);
  assertEq(st.lapJudged, 100);
  st.resetForLoop();
  assertEq(st.lapJudged, 0);
});

test('gb player: no full-combo bonus after a seek-and-resume recount that skipped chips', async () => {
  const { audio, player } = await makeGb('#BPM: 120\n#WAV01: r.wav\n#00024: 01010101\n');
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    audio.advance(2700);
    player.update(perf(), null); // 2000 は取り逃し、2500 も取り逃し
    assertEq(player.stats.counts[4], 2);
    player.togglePause();
    player.seekTo(2900);
    player.togglePause(); // 数え直し
    for (const t of [3000, 3500]) {
      audio.advance(t - player.songMs);
      player.update(perf(), null);
      player.fret(0, true, perf());
      player.pick(perf());
      player.fret(0, false, perf());
    }
    assertEq(player.stats.counts[0], 2);
    audio.advance(2600);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.STANDBY, 'song ended');
    assert(player.stats.score < 15000, 'no full-combo bonus: ' + player.stats.score);
  });
  player.dispose();
  // 曲頭から全部判定したときは加点する
  const r = await makeGb('#BPM: 120\n#WAV01: r.wav\n#00024: 0101\n');
  await withClock(r.audio, async (perf) => {
    r.player.command('startStop');
    r.player.update(perf(), null);
    for (const t of [2000, 3000]) {
      r.audio.advance(t - r.player.songMs);
      r.player.update(perf(), null);
      r.player.fret(0, true, perf());
      r.player.pick(perf());
      r.player.fret(0, false, perf());
    }
    const before = r.player.stats.score;
    r.audio.advance(2600);
    r.player.update(perf(), null);
    assertEq(r.player.stats.score - before, 30000, 'all Perfect → +30000');
  });
  r.player.dispose();
});

test('gb player: a fret pressed after the settle deadline does not complete the waiting pick', async () => {
  const { audio, player } = await makeGb(GB_CHART);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    player.jumpTo(2400, true);
    audio.advance(95);
    player.update(perf(), null);
    // GB(2500): G だけでピック(t0)。重いフレームで 60 ms 後にまとめて処理され、その中に t0 + 45 の B の押下がある
    const t0 = perf();
    player.fret(1, true, t0);
    player.pick(t0);
    audio.advance(60);
    player.fret(2, true, t0 + 45);
    assertEq(player.stats.counts[0], 0, 'not a hit');
    assertEq(player.judged[1], false);
  });
  player.dispose();
});

test('gb player: lifting a touch finger does not turn a wrong-lane tap into an OPEN hit', async () => {
  const { audio, player } = await makeGb(GB_CHART);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    player.jumpTo(2990, true);
    audio.advance(10);
    player.update(perf(), null);
    player.fret(0, true, perf()); // R のレーンをタップ(OPEN 3000)
    player.pick(perf(), { touch: true });
    audio.advance(35);
    player.fret(0, false, perf());
    assertEq(player.judged[2], false, 'OPEN not hit by lifting the finger');
    audio.advance(30);
    player.update(perf(), null);
    assertEq(player.stats.counts[0], 0);
  });
  player.dispose();
});

test('gb player: bass wailing does not play the guitar wailing sound (0x2F); wailed vs expired wailing chips', async () => {
  const text = '#BPM: 120\n#WAV01: b.wav\n#WAV06: wail.wav\n#000A4: 01\n#000A8: 01\n#0002F: 06\n#00024: 01\n#00028: 01\n';
  for (const inst of [INSTRUMENT.BASS, INSTRUMENT.GUITAR]) {
    const { audio, player } = await makeGb(text, inst);
    await withClock(audio, async (perf) => {
      player.command('startStop');
      player.update(perf(), null);
      audio.advance(2000);
      player.update(perf(), null);
      player.fret(0, true, perf());
      player.pick(perf());
      player.wail(perf());
      assertEq(player.wailHit[0], true);
      const wailSound = audio.played.some((p) => p.id === '06');
      assertEq(wailSound, inst === INSTRUMENT.GUITAR, 'wailing sound only for guitar (inst ' + inst + ')');
    });
    player.dispose();
  }
  // 成立しなかったウェイリングチップは 1 秒で予約できなくなるが、画面からは消さない(wailHit は false のまま)
  const { audio, player } = await makeGb(text, INSTRUMENT.GUITAR);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    audio.advance(3100);
    player.update(perf(), null);
    assertEq(player.wailDone[0], true);
    assertEq(player.wailHit[0], false);
  });
  player.dispose();
});

test('gb stats: the all-AUTO full-combo bonus counts this lap only', () => {
  const st = new GbStats(4);
  for (let i = 0; i < 4; i++) st.judge(JUDGE.PERFECT, { auto: true });
  st.resetForLoop();
  st.judge(JUDGE.GREAT, {});
  for (let i = 0; i < 3; i++) st.judge(JUDGE.PERFECT, { auto: true });
  assertEq(st.fullComboBonus(true), 15000, 'a Great this lap → +15000 even after an all-Perfect lap');
});

test('gb player: a touch chord groups fingers from the first finger; a late finger starts a new pick with all fingers', async () => {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  const player = new GuitarPlayer({ audio, settings, config: { light: false }, inst: INSTRUMENT.GUITAR });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX('#BPM: 120\n#WAV01: c.wav\n#00027: 01\n')); // RGB 2000
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(perf(), null);
    const tap = (lane) => { player.fret(lane, true, perf()); player.pick(perf(), { touch: true }); };
    audio.advance(1990);
    player.update(perf(), null);
    tap(0); // R(1990)
    audio.advance(40);
    tap(1); // G(2030): 最初の指から 40 ms → 同じピック
    audio.advance(20); // 2050: 最初の指の締め切り(50 ms)を過ぎた
    player.update(perf(), null);
    assertEq(player.gbJudge.bad, true, 'R+G is not the RGB chord → empty pick (Light OFF)');
    audio.advance(10);
    tap(2); // B(2060): 新しいピック。R G B が揃っている
    assertEq(player.stats.counts[1] + player.stats.counts[0] + player.stats.counts[2], 1, 'the late finger completes the chord with a new pick');
  });
  player.dispose();
});
