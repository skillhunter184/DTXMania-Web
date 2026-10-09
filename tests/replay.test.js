// 演奏の記録とリプレイ(js/game/replay.js)・ゴーストノーツの描画・メニューの「リプレイ」。
import { test, assert, assertEq, assertNear, assertDeepEq } from './runner.js';
import { Player, PLAYER_STATE, SCROLL_BASE_PX_PER_MS } from '../js/game/player.js';
import { GuitarPlayer, PICK_SETTLE_MS } from '../js/game/gbplayer.js';
import { Take, cloneStats } from '../js/game/replay.js';
import { PlayStats } from '../js/game/judge.js';
import { JUDGE } from '../js/game/hitranges.js';
import { TrainingSettings } from '../js/game/training.js';
import { parseDTX, INSTRUMENT } from '../js/core/dtx.js';
import { TrainingMenu, MENU_COMMAND, ITEM } from '../js/ui/menu.js';
import { Renderer, GHOST_FILL, GHOST_STROKE } from '../js/ui/renderer.js';
import { GuitarRenderer } from '../js/ui/gbrenderer.js';
import { Skin, JUDGE_Y, columnRange, gbChipX, GB_JUDGE_Y, GB_CHIP_W } from '../js/ui/skin.js';

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
    playBuffer(buf, opts) { const v = { ...opts, src: null }; this.played.push(v); return v; },
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

/** 偽の時計を目標の実時間(ms)まで進め、1 フレーム回す。 */
function stepTo(audio, player, ms) {
  audio.advance(ms - audio.ctx.currentTime * 1000);
  player.update(audio.ctx.currentTime * 1000, null);
}

async function makeDrum(text, setup) {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  if (setup) setup(settings);
  const player = new Player({ audio, settings, config: {} });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX(text));
  return { audio, settings, player };
}

/** 成績の見える値(リプレイで同じになるべきもの)。 */
function statsOf(st) {
  return { counts: st.counts, countsIncAuto: st.countsIncAuto, combo: st.combo, maxCombo: st.maxCombo, score: st.score, gauge: st.gauge, early: st.earlyCount, late: st.lateCount };
}

// BPM 120: SD 2000 / 2500 / 3000 / 3500、BD 2000
const DRUM_CHART = '#BPM: 120\n#00012: 01010101\n#00013: 01\n';

/**
 * ドラムの 1 回の通し: BD を 10ms 早く(Perfect)・SD を 10ms 遅く(Perfect)・60ms 早く(Great)・1 つ見逃し(Miss)・
 * HT の空打ち・100ms 遅く(OK)。曲末まで進めて待機に戻す。
 */
function playDrumRun(audio, player) {
  player.command('startStop');
  player.update(0, null);
  assertEq(player.state, PLAYER_STATE.PLAYING);
  stepTo(audio, player, 1990);
  player.hit(5, 1990);
  stepTo(audio, player, 2010);
  player.hit(3, 2010);
  stepTo(audio, player, 2440);
  player.hit(3, 2440);
  stepTo(audio, player, 3130); // 3000 は見逃し(3117 を過ぎて Miss)
  stepTo(audio, player, 3300);
  player.hit(4, 3300); // HT にチップは無い(空打ち)
  stepTo(audio, player, 3600);
  player.hit(3, 3600);
  stepTo(audio, player, 3600 + 2100); // 曲末 + 2000 を過ぎて待機へ
  assertEq(player.state, PLAYER_STATE.STANDBY);
}

test('replay: Take keeps the event order, drops unheard scheduled sounds, sorts sounds and ghosts', () => {
  const st = new PlayStats(10, 0);
  st.judge(JUDGE.PERFECT, {}, 0);
  const take = new Take(1000, st, { frets: [true] });
  st.judge(JUDGE.MISS, {}, 0);
  assertEq(take.stats0.counts[4], 0, 'stats0 is a copy');
  assertEq(typeof take.stats0.achievement, 'function', 'the copy keeps the class methods');
  take.event({ kind: 'a' }, 1500);
  take.event({ kind: 'b' }, 1490); // 打鍵の時刻がフレームより前
  take.event({ kind: 'c' }, 900); // 始めより前
  assertDeepEq(take.events.map((e) => e.timeMs), [1500, 1500, 1500], 'never earlier than the previous event');
  take.sound({ id: 'x' }, 1700, true);
  take.sound({ id: 'y' }, 1200, false);
  take.sound({ id: 'z' }, 1800, true);
  take.dropScheduledFrom(1750);
  assertDeepEq(take.sounds.map((s) => s.id), ['x', 'y'], 'scheduled sounds from 1750 are dropped');
  take.ghost({ timeMs: 1600 });
  take.ghost({ timeMs: 1100 });
  take.reach(1650);
  assertEq(take.endMs, 1650);
  take.finish(st, { auto: false });
  assertDeepEq(take.sounds.map((s) => s.id), ['y'], 'scheduled sounds after the end are dropped, the rest sorted');
  assertDeepEq(take.ghosts.map((g) => g.timeMs), [1100, 1600]);
  assertEq(take.stats1.counts[4], 1, 'stats1 is the end state');
  assertEq(new Take(0, st).empty, true);
  const c = cloneStats(st);
  c.counts[0] = 99;
  assertEq(st.counts[0], 1, 'arrays are copied');
});

test('replay: drums — a run is recorded with ghosts at the hit times and replays to the same stats', async () => {
  const { audio, player, settings } = await makeDrum(DRUM_CHART);
  await withClock(audio, async () => {
    assertEq(player.canReplay, false, 'nothing to replay before playing');
    playDrumRun(audio, player);
    const final = statsOf(player.stats);
    assertDeepEq(final.counts, [2, 1, 0, 1, 1]);
    const take = player.lastTake;
    assert(take, 'the run is kept');
    assertEq(take.startMs, 0);
    assert(take.endMs >= 5500, 'the take ends where the song ended');
    // ゴースト: 叩いた時刻(判定タイミング調整 0 なので叩いた譜面時刻)・当たったチップのレーン・判定
    assertDeepEq(take.ghosts.map((g) => [Math.round(g.timeMs), g.lane, g.judge]),
      [[1990, 5, JUDGE.PERFECT], [2010, 3, JUDGE.PERFECT], [2440, 3, JUDGE.GREAT], [3300, 4, -1], [3600, 3, JUDGE.OK]]);
    assertEq(take.sounds.length, 5, 'one sound per hit (4 chips and the empty hit)');
    assertEq(player.canReplay, true);

    // リプレイ: 開始待ち → テイクの頭から、成績はテイクの始め(まっさら)から
    const t0 = audio.ctx.currentTime * 1000;
    audio.played.length = 0;
    player.command('replay');
    assert(player.replay, 'replaying');
    assertEq(player.state, PLAYER_STATE.START_IN);
    assertEq(player.stats.total, 0);
    player.update(t0, null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertEq(player.stateText(), 'REPLAY');
    assertEq(player.ghosts, take.ghosts, 'ghosts are drawn while replaying');
    // 記録した打鍵の音を、叩いた譜面時刻に予約する(BD の 1990 は先読みの 200 ms に入ってから)
    stepTo(audio, player, t0 + 1800);
    const bd = audio.played.find((p) => p.key === 'synth5');
    assert(bd, 'the BD hit sound is scheduled');
    assertNear(player.songAt(bd.when * 1000), 1990, 0.01, 'at the time it was hit');
    // 実際の打鍵はリプレイ中は使わない
    player.hit(3, t0 + 1800);
    assertEq(player.stats.total, 0, 'hits are ignored while replaying');
    stepTo(audio, player, t0 + 2100);
    assertDeepEq(player.stats.counts, [2, 0, 0, 0, 0], 'BD and SD at 2000 are re-applied');
    assertEq(player.judged[0] && player.judged[1], true);
    assertEq(player.judgeStr[3].judge, JUDGE.PERFECT, 'judge text is shown again');
    assertNear(player.judgeStr[3].lagMs, 10, 0.5);
    stepTo(audio, player, t0 + 3200);
    assertEq(player.stats.counts[4], 1, 'the miss comes back');
    stepTo(audio, player, t0 + 6000);
    assertEq(player.replay, null, 'the replay ends at the end of the take');
    assertEq(player.state, PLAYER_STATE.STANDBY);
    assertDeepEq(statsOf(player.stats), final, 'same stats as the run');
    assertEq(player.lastTake, take, 'watching does not replace the take');
    assertEq(settings.autoPlay, false);
  });
  player.dispose();
});

test('replay: drums — the same stats at another play speed; stop / restart / seek while paused', async () => {
  const { audio, player, settings } = await makeDrum(DRUM_CHART);
  await withClock(audio, async () => {
    playDrumRun(audio, player);
    const final = statsOf(player.stats);
    // x0.5 で見る: 譜面 2100 は実時間 4200
    settings.playSpeed = 10;
    let t0 = audio.ctx.currentTime * 1000;
    player.command('replay');
    player.update(t0, null);
    assertEq(player.ratio, 0.5);
    stepTo(audio, player, t0 + 4200);
    assertNear(player.songMs, 2100, 1);
    assertDeepEq(player.stats.counts, [2, 0, 0, 0, 0]);
    // 一時停止してシーク: その位置までの出来事を当て直す(成績は数え直さない)
    player.command('pauseResume');
    assertEq(player.state, PLAYER_STATE.PAUSED);
    assertEq(player.seekTo(3400), true);
    assertDeepEq(player.stats.counts, [2, 1, 0, 0, 1], 'stats at 3400');
    assertDeepEq(player.judged.slice(0, 5), [true, true, true, true, false], 'the 3500 chip is still ahead');
    assertEq(player.seekTo(-500), true);
    assertEq(Math.round(player.songMs), 0, 'seeking is limited to the take');
    assertEq(player.stats.total, 0);
    player.seekTo(3400);
    t0 = audio.ctx.currentTime * 1000;
    player.command('pauseResume');
    assertEq(player.state, PLAYER_STATE.PLAYING);
    stepTo(audio, player, t0 + 2 * 300);
    assertEq(player.stats.counts[3], 1, 'the OK hit at 3600 after resuming');
    // 頭から(リスタート)→ 止める(演奏開始・停止)と、成績は通しの終わりのものに戻る
    player.command('restart');
    assert(player.replay, 'restart replays again from the top');
    assertEq(player.stats.total, 0);
    player.update(audio.ctx.currentTime * 1000, null);
    player.command('startStop');
    assertEq(player.replay, null);
    assertEq(player.state, PLAYER_STATE.STANDBY, 'stop does not start a run');
    assertDeepEq(statsOf(player.stats), final);
    // 「リプレイ」は待機中だけ(演奏中は何もしない)
    settings.playSpeed = 20;
    player.command('startStop');
    player.update(audio.ctx.currentTime * 1000, null);
    assertEq(player.canReplay, false);
    player.command('replay');
    assertEq(player.replay, null, 'no replay while playing');
  });
  player.dispose();
});

test('replay: loop laps and pause-seek recounts make separate takes; gauge carries into the next lap', async () => {
  const { audio, player, settings } = await makeDrum('#BPM: 120\n#00012: 01010101\n#00112: 01010101\n');
  await withClock(audio, async () => {
    settings.loop = true;
    settings.loopBeginMs = 2000;
    settings.loopEndMs = 4000;
    player.update(0, null); // 待機位置がループの開始位置へ
    player.command('startStop');
    player.update(0, null); // 実時間 0 = 譜面 2000 から
    assertEq(player.state, PLAYER_STATE.PLAYING);
    player.hit(3, 0); // SD 2000
    stepTo(audio, player, 2010); // 譜面 4010 で折り返し(実時間 2010 = 譜面 2000)
    const lap1 = player.lastTake;
    assert(lap1, 'the first lap is a take');
    assertEq(lap1.startMs, 2000);
    assertEq(lap1.endMs, 4000);
    assertEq(lap1.ghosts.length, 1);
    const gaugeAfterLap1 = player.stats.gauge;
    stepTo(audio, player, 2510);
    player.hit(3, 2510); // 2 周目の 2500
    stepTo(audio, player, 3010);
    player.hit(3, 3010); // 3000
    player.command('startStop'); // 2 周目の途中で止める
    const lap2 = player.lastTake;
    assert(lap2 !== lap1, 'the stopped lap replaces it');
    assertEq(lap2.startMs, 2000);
    assertEq(lap2.ghosts.length, 2);
    assertEq(lap2.stats0.gauge, gaugeAfterLap1, 'the take starts with the gauge carried over');
    const final = statsOf(player.stats);
    player.command('replay');
    player.update(audio.ctx.currentTime * 1000, null);
    assertNear(player.songMs, 2000, 1, 'the replay starts at the loop start');
    assertNear(player.stats.gauge, gaugeAfterLap1, 1e-12);
    stepTo(audio, player, audio.ctx.currentTime * 1000 + 3100);
    assertEq(player.replay, null, 'ends where the lap was stopped (no loop wrap in a replay)');
    assertDeepEq(statsOf(player.stats), final);

    // 一時停止中にシークして再開(数え直し)すると、そこでテイクを区切る
    settings.loop = false;
    player.update(audio.ctx.currentTime * 1000, null);
    player.command('restart');
    let t0 = audio.ctx.currentTime * 1000;
    player.update(t0, null);
    stepTo(audio, player, t0 + 2000);
    player.hit(3, t0 + 2000);
    player.command('pauseResume');
    player.seekTo(4000);
    t0 = audio.ctx.currentTime * 1000;
    player.command('pauseResume');
    assertEq(player.lastTake.ghosts.length, 1, 'the part before the seek is its own take');
    assertEq(player.lastTake.startMs, 0);
    stepTo(audio, player, t0 + 10);
    player.hit(3, t0 + 10);
    player.command('startStop');
    assertEq(player.lastTake.startMs, 4000, 'the part after the recount');
    assertDeepEq(player.lastTake.ghosts.map((g) => Math.round(g.timeMs)), [4010]);
    // 何も起きなかった通しは残さない
    const kept = player.lastTake;
    player.command('startStop');
    player.update(audio.ctx.currentTime * 1000, null);
    player.command('startStop');
    assertEq(player.lastTake, kept, 'an empty run keeps the previous take');
  });
  player.dispose();
});

test('replay: AUTO chip sounds rescheduled by a pause are recorded once; AUTO lanes replay with the take flags', async () => {
  const { audio, player, settings } = await makeDrum(DRUM_CHART, (s) => { s.autoLanes[3] = true; });
  await withClock(audio, async () => {
    player.command('startStop');
    player.update(0, null);
    stepTo(audio, player, 1900); // SD 2000 は先読みで予約済み
    player.command('pauseResume');
    player.command('pauseResume'); // 予約を止めて予約し直す
    const t0 = audio.ctx.currentTime * 1000; // 譜面 1900
    stepTo(audio, player, t0 + 120); // SD 2000 は AUTO で判定
    player.hit(5, t0 + 120); // BD 2000 を 20 ms 遅れで
    stepTo(audio, player, t0 + 1700); // 残りの SD も AUTO
    player.command('startStop');
    const take = player.lastTake;
    const sd2000 = take.sounds.filter((s) => s.note && s.note.lane === 3 && s.note.timeMs === 2000);
    assertEq(sd2000.length, 1, 'the SD at 2000 is recorded once');
    assert(take.flags.laneAuto[3], 'AUTO lanes are kept with the take');
    const final = statsOf(player.stats);
    settings.autoLanes[3] = false; // 見る前に設定を変えても記録のとおり
    player.command('replay');
    player.update(audio.ctx.currentTime * 1000, null);
    assertEq(player.laneAuto[3], true, 'the take flags are used while replaying');
    stepTo(audio, player, audio.ctx.currentTime * 1000 + 6000);
    assertDeepEq(statsOf(player.stats), final);
    assertEq(player.laneAuto[3], false, 'the settings come back after the replay');
  });
  player.dispose();
});

// R(2000) GB(2500) OPEN(3000) R-LN(3500-4500)、ウェイリング 2500
const GB_CHART = [
  '#BPM: 120',
  '#WAV01: r.wav', '#WAV02: gb.wav', '#WAV03: open.wav', '#WAV04: ln.wav',
  '#00024: 01000004',
  '#00023: 00020000',
  '#00020: 00000300',
  '#0002C: 00000001',
  '#0012C: 00010000',
  '#00028: 00020000',
].join('\n');

test('replay: guitar — picks, chords, an empty pick, wailing and a long note replay to the same stats', async () => {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  const player = new GuitarPlayer({ audio, settings, config: {}, inst: INSTRUMENT.GUITAR });
  const chart = parseDTX(GB_CHART);
  for (const id of chart.wavDefs.keys()) audio.buffers.set(id, { duration: 1 });
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  await withClock(audio, async (perf) => {
    player.command('startStop');
    player.update(0, null);
    stepTo(audio, player, 2010);
    player.fret(0, true, perf());
    player.pick(perf()); // R: Perfect +10
    player.fret(0, false, perf());
    stepTo(audio, player, 2495);
    player.fret(1, true, perf());
    player.pick(perf());
    audio.advance(10);
    player.fret(2, true, perf()); // 和音の B を後から → ピックの時刻で Perfect
    player.wail(perf()); // ウェイリング
    player.fret(1, false, perf());
    player.fret(2, false, perf());
    stepTo(audio, player, 3000);
    player.fret(2, true, perf());
    player.pick(perf()); // OPEN に B を押さえて → 空ピック
    stepTo(audio, player, 3000 + PICK_SETTLE_MS.key + 1);
    player.fret(2, false, perf());
    player.pick(perf()); // OPEN
    stepTo(audio, player, 3500);
    player.fret(0, true, perf());
    player.pick(perf()); // ロングノート
    stepTo(audio, player, 3700);
    stepTo(audio, player, 3900); // 加点
    stepTo(audio, player, 4000);
    player.fret(0, false, perf()); // 途中で離す
    stepTo(audio, player, 4100);
    assertEq(player.holdIndex, -1, 'released');
    stepTo(audio, player, 4500 + 2100);
    assertEq(player.state, PLAYER_STATE.STANDBY);
    const final = statsOf(player.stats);
    assert(final.score > 0 && final.counts[0] >= 3, 'the run scored');
    const take = player.lastTake;
    assertDeepEq(final.counts, [4, 0, 0, 0, 0]);
    assertDeepEq(take.ghosts.map((g) => [Math.round(g.timeMs), g.bits, g.judge]), [
      [2010, 4, JUDGE.PERFECT], [2495, 3, JUDGE.PERFECT], [3000, 1, -1], [3031, 0, JUDGE.PERFECT], [3500, 4, JUDGE.PERFECT],
    ], 'ghosts: time, held buttons (R=4, G+B=3, B=1, OPEN=0) and judge');
    assertEq(take.events.filter((e) => e.kind === 'tick').length, 3, 'long-note ticks (3666 / 3833 / 4000) are recorded');
    assert(take.events.some((e) => e.kind === 'release'), 'the early release is recorded');
    assert(take.events.some((e) => e.kind === 'wail'), 'the wailing is recorded');
    assert(take.events.some((e) => e.kind === 'fullCombo'), 'the full-combo bonus at the song end is recorded');

    // リプレイ
    player.command('replay');
    const t0 = audio.ctx.currentTime * 1000;
    player.update(t0, null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    audio.stopped.length = 0; // 演奏の音を止めた記録は見ない
    stepTo(audio, player, t0 + 2600);
    assertEq(player.wailHit[0], true, 'the wailing chip is gone again');
    assertEq(player.stats.counts[0], 2);
    player.fret(4, true, t0 + 2600); // 実際のボタンはリプレイに混ぜない
    assertEq(player.fretHeld[4], false);
    stepTo(audio, player, t0 + 3010);
    assertEq(player.fretHeld[2], true, 'the held B button is shown');
    stepTo(audio, player, t0 + 3800);
    assertEq(player.holdIndex, 3, 'the long note is held');
    assertEq(player.fretHeld[0], true);
    stepTo(audio, player, t0 + 4100);
    assertEq(player.holdIndex, -1, 'released at the recorded time');
    assert(audio.stopped.some((s) => s.v.id === '04'), 'the long-note sound is stopped');
    stepTo(audio, player, t0 + 6700);
    assertEq(player.replay, null);
    assertDeepEq(statsOf(player.stats), final, 'same stats as the run');
    assertEq(player.fretHeld[4], true, 'the button pressed during the replay is held after it');
  });
  player.dispose();
});

test('replay: menu row starts and stops the replay, disabled without a take', () => {
  const s = new TrainingSettings();
  let can = false;
  const sounds = { decide: 0, cancel: 0 };
  const m = new TrainingMenu(s, {
    sound: { cursor() {}, decide: () => sounds.decide++, cancel: () => sounds.cancel++ },
    canReplay: () => can,
  });
  m.setChart(parseDTX('#BPM: 120\n#00013: 01\n'));
  const row = m.items.indexOf(ITEM.REPLAY);
  assertEq(row, m.items.indexOf(ITEM.PAUSE) + 1, 'after Pause');
  assertEq(m.isAction(row), true);
  assertEq(m.itemName(row), 'リプレイ');
  assertEq(m.isDisabled(row), true, 'nothing to replay');
  m.cursor = row;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.NONE);
  assertEq(sounds.cancel, 1);
  can = true;
  assertEq(m.isDisabled(row), false);
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.REPLAY);
  can = false;
  m.replaying = true;
  assertEq(m.itemName(row), 'リプレイ停止');
  assertEq(m.isDisabled(row), false, 'stoppable while replaying');
  const gb = new TrainingMenu(s, { instrument: INSTRUMENT.GUITAR });
  assertEq(gb.items.indexOf(ITEM.REPLAY), gb.items.indexOf(ITEM.PAUSE) + 1);
});

/** 論理座標 (x, y) の画素の [r, g, b](横 1920x1080 の等倍)。 */
function pixelAt(canvas, x, y) {
  return Array.from(canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3));
}

function assertColor(actual, expected, tol, msg) {
  assert(actual.every((v, i) => Math.abs(v - expected[i]) <= tol), `${msg}: expected≈${expected} actual=${actual}`);
}

/** 色 base に rgba(...) の文字列の色を重ねた色。 */
function blend(base, rgba) {
  const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number);
  return base.map((v, i) => Math.round(v * (1 - a) + [r, g, b][i] * a));
}

function fakeReplayTake(ghosts) {
  return { ghosts, startMs: 0, endMs: 10000, events: [], sounds: [], flags: null };
}

test('replay: ghost notes are drawn at the hit time in the judge color (drums and guitar)', async () => {
  const silent = { ctx: { get currentTime() { return 3; } }, outputLatencySec: 0, buffers: new Map(), async loadChartSounds() {}, hasBuffer() { return false; },
    play() { return { src: null }; }, playBuffer() { return { src: null }; }, stopVoice() {}, stopAll() {}, synthBuffer() { return {}; } };
  // ドラム: LT(6)に 600 ms 先の Great のゴースト(LT にチップは無い。拍線は 500 ms ごとなので避ける)
  const settings = new TrainingSettings();
  const player = new Player({ audio: silent, settings, config: {} });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX(DRUM_CHART));
  player.state = PLAYER_STATE.PLAYING;
  player._anchorReal = 3000; // 偽の音の時計は ctx 3 秒 = 実時間 3000 ms
  player._anchorSong = 1000;
  const canvas = document.createElement('canvas');
  const r = new Renderer(canvas, new Skin(), player);
  r._warm = 0;
  r.resize(1920, 1080, 1, 'landscape', 52);
  const [x0, x1] = columnRange(6);
  const cx = (x0 + x1) / 2;
  const y = JUDGE_Y - 600 * SCROLL_BASE_PX_PER_MS;
  r.draw(0);
  const base = pixelAt(canvas, cx, y);
  const baseEdge = pixelAt(canvas, cx, y - 6.5);
  const baseAbove = pixelAt(canvas, cx, y - 12);
  player.replay = { take: fakeReplayTake([{ timeMs: 1600, lane: 6, judge: JUDGE.GREAT }]), ei: 0, si: 0 };
  r.draw(0);
  assertColor(pixelAt(canvas, cx, y), blend(base, GHOST_FILL[JUDGE.GREAT + 1]), 3, 'ghost fill at the hit time');
  assertColor(pixelAt(canvas, cx, y - 6.5), blend(blend(baseEdge, GHOST_FILL[JUDGE.GREAT + 1]), GHOST_STROKE[JUDGE.GREAT + 1]), 6, 'Great outline');
  assertColor(pixelAt(canvas, cx, y - 12), baseAbove, 1, 'nothing above the ghost');
  player.dispose();

  // ギター(既定の向き = 判定ラインが上でチップは下から): G+B の空ピック(灰色)を 400 ms 先に
  const gs = new TrainingSettings();
  gs.gbScrollSpeedTenth = 20;
  const gp = new GuitarPlayer({ audio: silent, settings: gs, config: {}, inst: INSTRUMENT.GUITAR });
  await gp.load({ resolve() { return null; }, readBytes() {} }, parseDTX(GB_CHART));
  gp.state = PLAYER_STATE.PLAYING;
  gp._anchorReal = 3000;
  gp._anchorSong = 0;
  const gc = document.createElement('canvas');
  const gr = new GuitarRenderer(gc, new Skin(), gp);
  gr._warm = 0;
  gr.resize(1920, 1080, 1, 'landscape', 52);
  const gy = GB_JUDGE_Y + 400 * gp.pixelsPerMs + 1.5;
  const at = (lane) => pixelAt(gc, gbChipX(lane) + GB_CHIP_W / 2, gy);
  gr.draw(0);
  const before = [0, 1, 2].map(at);
  gp.replay = { take: fakeReplayTake([{ timeMs: 400, bits: 3, judge: -1 }]), ei: 0, si: 0 };
  gr.draw(0);
  for (const lane of [1, 2]) assertColor(at(lane), blend(before[lane], GHOST_FILL[0]), 3, 'gray ghost on lane ' + lane);
  assertColor(at(0), before[0], 1, 'no ghost on R');
  gp.dispose();
});
