import { test, assert, assertEq, assertNear, assertDeepEq } from './runner.js';
import { scoreDelta, PlayStats, achievementRate, rankOf, GAUGE_INITIAL, autoLaneRevise } from '../js/game/judge.js';
import { HitRanges, searchLanes, tieHitsAll, applyChartDowngrade, JUDGE } from '../js/game/hitranges.js';
import { TrainingSettings, stepLoopTime, stepLoopBegin, stepLoopEnd, formatLoopTime, LOOP_UNIT } from '../js/game/training.js';
import { parseDTX } from '../js/core/dtx.js';
import { Player, PLAYER_STATE, SCROLL_BASE_PX_PER_MS } from '../js/game/player.js';

// ---- hit ranges / groups ----
test('hitranges: judge windows and search window', () => {
  const r = HitRanges.default;
  assertEq(r.judge(0), JUDGE.PERFECT);
  assertEq(r.judge(34), JUDGE.PERFECT);
  assertEq(r.judge(35), JUDGE.GREAT);
  assertEq(r.judge(67), JUDGE.GREAT);
  assertEq(r.judge(84), JUDGE.GOOD);
  assertEq(r.judge(117), JUDGE.OK);
  assertEq(r.judge(118), JUDGE.MISS);
  assertEq(r.searchWindowMs, 117);
});
test('groups: search lanes and tie rules', () => {
  assertDeepEq(searchLanes(0, { hhGroup: 0 }), [0]);
  assertDeepEq(searchLanes(0, { hhGroup: 3 }), [1, 0]);
  assertDeepEq(searchLanes(9, { cyGroup: 1 }), [8, 9]);
  assertDeepEq(searchLanes(5, { bdGroup: 1 }), [5, 2]);
  assertDeepEq(searchLanes(2, { bdGroup: 1 }), [2]);
  assertDeepEq(searchLanes(2, { bdGroup: 3 }), [2, 5]);
  assertEq(tieHitsAll(0), false);
  assertEq(tieHitsAll(3), true);
  const g = applyChartDowngrade(false, false, { hhGroup: 0, ftGroup: 0, cyGroup: 0, bdGroup: 0 });
  assertEq(g.hhGroup, 3);
  assertEq(g.cyGroup, 1);
});

// ---- score ----
test('score: all-Perfect chart reaches exactly 1,000,000', () => {
  for (const total of [10, 50, 100, 688]) {
    const st = new PlayStats(total, 0);
    for (let i = 0; i < total; i++) st.judge(JUDGE.PERFECT, { bonus: false }, 0);
    assertEq(st.score, 1000000, 'total=' + total);
    assertEq(st.combo, total);
    assertEq(st.maxCombo, total);
  }
});
test('score: scoreDelta formula (float32, combo cap 50)', () => {
  // total 100: base = 1000000 / (1275 + 50*50) = 264.55...
  const base = Math.fround(1000000 / 3775);
  assertEq(scoreDelta(0, 1, 1, 100, 0, 0), Math.trunc(base));
  assertEq(scoreDelta(0, 10, 10, 100, 0, 0), Math.trunc(Math.fround(base * 10)));
  assertEq(scoreDelta(0, 60, 60, 100, 0, 0), Math.trunc(Math.fround(base * 50)));
  assertEq(scoreDelta(1, 60, 0, 100, 0, 0), Math.trunc(Math.fround(Math.fround(base * 0.5) * 50)));
  assertEq(scoreDelta(2, 3, 0, 100, 0, 0), Math.trunc(Math.fround(Math.fround(base * Math.fround(0.2)) * 3)));
  // 0.2f との積: 212 ノート・コンボ 3 の Good は 64(倍精度 0.2 だと 63 になる)
  assertEq(scoreDelta(2, 3, 0, 212, 0, 0), 64);
  assertEq(scoreDelta(3, 3, 0, 100, 0, 0), 0);
  assertEq(scoreDelta(0, 100, 100, 100, 999000, 0), 1000);
});
test('stats: gauge, combo break, counts, rates, loop reset', () => {
  const st = new PlayStats(100, 0);
  assertNear(st.gauge, GAUGE_INITIAL, 1e-9);
  st.judge(JUDGE.PERFECT, {}, -5);
  st.judge(JUDGE.GREAT, {}, 10);
  st.judge(JUDGE.OK, {}, 100);
  assertEq(st.combo, 0);
  assertEq(st.maxCombo, 2);
  assertEq(st.earlyCount, 1);
  assertEq(st.lateCount, 2);
  assertNear(st.gauge, GAUGE_INITIAL + 0.005 + 0.001 - 0.017, 1e-9);
  st.judge(JUDGE.MISS, {}, 200);
  assertNear(st.gauge, GAUGE_INITIAL + 0.005 + 0.001 - 0.017 - 0.041 * 0.5, 1e-9);
  assertEq(st.ratePercent(st.counts[0]), '25%');
  const gaugeBefore = st.gauge;
  st.resetForLoop();
  assertEq(st.score, 0);
  assertEq(st.combo, 0);
  assertEq(st.counts[4], 0);
  assertEq(st.gauge, gaugeBefore, 'gauge kept on loop');
  assertEq(st.countsIncAuto[0], 1, 'countsIncAuto kept on loop');
  st.reset();
  assertNear(st.gauge, GAUGE_INITIAL, 1e-9);
});
test('stats: bonus +500 on Perfect/Great only; auto judge counts', () => {
  const st = new PlayStats(100, 1);
  st.judge(JUDGE.GOOD, { bonus: true }, 0);
  const s1 = st.score;
  const st2 = new PlayStats(100, 1);
  st2.judge(JUDGE.PERFECT, { bonus: true }, 0);
  assert(st2.score >= s1 + 500, 'bonus applied on perfect');
  const st3 = new PlayStats(100, 0);
  st3.autoJudge({ bonus: false }, { allLanesAuto: false, autoAddGage: false });
  assertEq(st3.counts[0], 0);
  assertEq(st3.countsIncAuto[0], 1);
  assertEq(st3.combo, 0);
});
test('achievement and rank', () => {
  assertNear(achievementRate([100, 0, 0, 0, 0], 100, 100), 100, 1e-9);
  assertNear(achievementRate([50, 50, 0, 0, 0], 100, 100), 42.5 + 17.5 + 15, 1e-9);
  assertEq(rankOf(95, 100), 'SS');
  assertEq(rankOf(79.9, 100), 'A');
  assertEq(rankOf(10, 0), '-');
  // レーン別 AUTO の補正: BD だけ AUTO → 0.5、LP だけ → 0.5、両方 → 1.0、LBD フラグ → 0.5
  const lanes = (...on) => { const a = new Array(10).fill(false); for (const i of on) a[i] = true; return a; };
  assertEq(autoLaneRevise(lanes(5)), 0.5);
  assertEq(autoLaneRevise(lanes(2)), 0.5);
  assertEq(autoLaneRevise(lanes(2, 5)), 1.0);
  assertEq(autoLaneRevise(lanes(3)), 1.0);
  assertEq(autoLaneRevise(lanes(), true), 0.5);
  assertEq(autoLaneRevise(lanes(5), false, true), 1.0);
  const st = new PlayStats(100, 0);
  for (let i = 0; i < 100; i++) st.judge(JUDGE.PERFECT, {}, 0);
  assertNear(st.achievement(false, lanes(5), false), 50, 1e-9);
});

// ---- training settings ----
test('training: loop stepping in measure/second units with non-overlap clamp', () => {
  const times = [0, 2000, 4000, 6000, 8000];
  const dur = 9000;
  assertEq(stepLoopTime(0, 1, LOOP_UNIT.MEASURE, times, dur), 2000);
  assertEq(stepLoopTime(2500, -1, LOOP_UNIT.MEASURE, times, dur), 2000, 'mid-measure minus snaps to head');
  assertEq(stepLoopTime(2000, -1, LOOP_UNIT.MEASURE, times, dur), 0);
  assertEq(stepLoopTime(8000, 5, LOOP_UNIT.MEASURE, times, dur), 8000);
  assertEq(stepLoopTime(1000, 1, LOOP_UNIT.SECOND, times, dur), 1500);
  assertEq(stepLoopTime(8800, 1, LOOP_UNIT.SECOND, times, dur), 9000);
  // end cannot reach begin
  assertEq(stepLoopEnd(4000, 2000, -1, LOOP_UNIT.MEASURE, times, dur), 4000, 'end stays one step after begin');
  assertEq(stepLoopEnd(6000, 2000, -1, LOOP_UNIT.MEASURE, times, dur), 4000);
  assertEq(stepLoopBegin(2000, 4000, 1, LOOP_UNIT.MEASURE, times, dur), 2000, 'begin stays one step before end');
  assertEq(stepLoopBegin(0, 4000, 1, LOOP_UNIT.MEASURE, times, dur), 2000);
  assertEq(formatLoopTime(2500, LOOP_UNIT.MEASURE, times), '001 小節');
  assertEq(formatLoopTime(2500, LOOP_UNIT.SECOND, times), '2.5 s');
});
test('training: settings clamp and JSON round trip', () => {
  const s = TrainingSettings.fromJSON({ noteOffsetMs: 5000, judgeOffsetMs: -200, scrollSpeedTenth: 0, playSpeed: 41, startWaitMs: 1234, loop: 1, loopUnit: 7, autoLanes: '10100000001' });
  assertEq(s.noteOffsetMs, 999);
  assertEq(s.judgeOffsetMs, -99);
  assertEq(s.scrollSpeedTenth, 1);
  assertEq(s.playSpeed, 40);
  assertEq(s.startWaitMs, 1200);
  assertEq(s.loop, true);
  assertEq(s.loopUnit, LOOP_UNIT.MEASURE);
  assertEq(s.autoLanes[0], true);
  assertEq(s.autoLanes[1], false);
  assertEq(s.autoLanes[10], true);
  const j = JSON.parse(JSON.stringify(s));
  assertEq(j.autoLanes, '10100000001');
  assertEq('loopBeginMs' in j, false, 'loop positions are not saved');
});

// ---- player (headless: fake audio engine) ----
function fakeAudio(latencySec = 0) {
  let t = 0;
  return {
    ctx: { get currentTime() { return t; } },
    outputLatencySec: latencySec,
    buffers: new Map(),
    get now() { return t; },
    played: [],
    advance(ms) { t += ms / 1000; },
    async loadChartSounds() { return this.buffers; },
    hasBuffer(id) { return this.buffers.has(id); },
    play(id, opts) { this.played.push({ id, ...opts }); return { src: null }; },
    playBuffer(buf, opts) { this.played.push(opts); return { src: null }; },
    stopVoice() {},
    stopAll() {},
    synthBuffer(lane) { return { lane }; },
  };
}

test('player: output latency — chip sounds are scheduled at realAt(S) and in-time hits read lag 0', async () => {
  const audio = fakeAudio(0.1);
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  settings.autoLanes[3] = true; // SD を AUTO にして音がスケジュールされるようにする
  const player = new Player({ audio, settings, config: {} });
  const chart = parseDTX('#BPM: 120\n#WAV01: sd.wav\n#00012: 01\n#00013: 01\n');
  audio.buffers.set('01', { duration: 1 });
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    player.command('startStop');
    player.update(perf(), null); // START IN 0 → PLAYING(開始位置の音を頭から鳴らすため、開始は遅延ぶん先)
    // 譜面 2000ms(SD, AUTO)の音は「聞こえる瞬間に曲時計が 2000 を指す」ctx 時刻に予約される
    audio.advance(1900);
    player.update(perf(), null);
    const sd = audio.played.find((p) => p.id === '01');
    assert(sd, 'SD scheduled');
    // start 時刻 when の音は ctx = when + 0.1 で聞こえ、そのとき realMs = when*1000 → songMs は 2000
    assertNear(player.songAt(sd.when * 1000), 2000, 0.001, 'song clock reads S when the sound is heard');
    assertNear(sd.when, 2.0, 0.001, 'scheduled at realAt(S)/1000 without adding latency again');
    // その音が聞こえる瞬間(ctx = when + 0.1)に BD(2000ms)を叩くとズレ 0
    audio.advance((sd.when + 0.1) * 1000 - perf());
    player.update(perf(), null);
    player.hit(5, perf());
    assertEq(player.stats.counts[0], 1, 'perfect');
    assertNear(player.stats.lastLagMs, 0, 1.5, 'lag ~0 when hitting in time with the sound');
  } finally {
    performance.now = origPerfNow;
  }
});

function makePlayer(dtxText) {
  const audio = fakeAudio();
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  const player = new Player({ audio, settings, config: {} });
  const chart = parseDTX(dtxText);
  return { audio, settings, player, chart };
}

test('player: standby → start → judge hits by timing; miss detection; song end', async () => {
  // BPM 120: 小節 0 頭 = 2000ms、SD 4 分打ち(2000, 2500, 3000, 3500)
  const { audio, player, chart, settings } = makePlayer('#BPM: 120\n#00012: 01010101\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  assertEq(player.state, PLAYER_STATE.STANDBY);
  assertEq(player.notes.length, 4);
  const perf = () => audio.ctx.currentTime * 1000; // performance.now と同じ軸として扱う
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    // 待機中の打鍵は成績に影響しない
    player.hit(3, perf());
    assertEq(player.stats.total, 0);
    assertEq(audio.played.length, 1, 'warm-up sound');
    player.command('startStop');
    assertEq(player.state, PLAYER_STATE.START_IN);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING, 'wait 0 → playing on next update');
    assertNear(player.songMs, 0, 1);
    // 1 つ目(2000ms)を 10ms 遅れで叩く → Perfect, lag +10
    audio.advance(2010);
    player.update(perf(), null);
    player.hit(3, perf());
    assertEq(player.stats.counts[0], 1, 'perfect');
    assertNear(player.stats.lastLagMs, 10, 1.5);
    assertEq(player.judged[0], true);
    // 2 つ目(2500ms)を 70ms 早く → Good
    audio.advance(420);
    player.update(perf(), null);
    player.hit(3, perf());
    assertEq(player.stats.counts[2], 1, 'good (70ms early)');
    // 3 つ目(3000ms)は放置 → 3000+117 を過ぎたらミス
    audio.advance(3100 - 2430);
    player.update(perf(), null);
    assertEq(player.stats.counts[4], 0, 'not yet miss at 3100');
    audio.advance(30);
    player.update(perf(), null);
    assertEq(player.stats.counts[4], 1, 'miss after window');
    assertEq(player.stats.combo, 0);
    // 4 つ目(3500ms)を 100ms 遅れ → Ok
    audio.advance(3600 - 3130);
    player.update(perf(), null);
    player.hit(3, perf());
    assertEq(player.stats.counts[3], 1, 'ok');
    // 空打ち: 成績は変わらない
    player.hit(5, perf());
    assertEq(player.stats.total, 4);
    // 曲末: durationMs(3500) + 2000 を過ぎると待機へ(成績は残る)
    audio.advance(2000);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.STANDBY);
    assertEq(player.stats.total, 4, 'stats kept');
    // リスタートで成績リセット
    settings.startWaitMs = 500;
    player.command('restart');
    assertEq(player.state, PLAYER_STATE.START_IN);
    assertEq(player.stats.total, 0);
    assertEq(player.stateText().startsWith('START IN'), true);
    audio.advance(600);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: play speed scales judge window and clock; auto play judges everything', async () => {
  const { audio, player, chart, settings } = makePlayer('#BPM: 120\n#00013: 01010101\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    settings.playSpeed = 10; // x0.5
    settings.autoPlay = true;
    player.command('startStop');
    player.update(perf(), null);
    assertEq(player.ratio, 0.5);
    // 実時間 4000ms で譜面 2000ms
    audio.advance(4000);
    player.update(perf(), null);
    assertNear(player.songMs, 2000, 1);
    assertEq(player.stats.counts[0], 1, 'auto judged first chip at its time');
    audio.advance(3000);
    player.update(perf(), null);
    assertEq(player.stats.counts[0], 4, 'all auto judged');
    assertEq(player.stats.combo, 4);
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: loop turnaround resets counts/score but keeps gauge; wait re-enters START IN', async () => {
  const { audio, player, chart, settings } = makePlayer('#BPM: 120\n#00013: 01010101\n#00113: 01010101\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    settings.loop = true;
    settings.loopBeginMs = 2000;
    settings.loopEndMs = 4000;
    settings.startWaitMs = 300;
    player.update(perf(), null); // standby follows loop begin
    assertEq(player.startMs, 2000);
    assertEq(player.judged[0], false, 'chip exactly at loop begin stays hittable');
    player.command('startStop');
    audio.advance(400);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertNear(player.songMs, 2000, 1, 'song starts at loop begin when the wait expires (no catch-up)');
    // 2000 のチップは放置(ミス)、2500 を叩く
    audio.advance(500);
    player.update(perf(), null);
    assertEq(player.stats.counts[4], 1, 'first chip missed');
    player.hit(5, perf());
    assertEq(player.stats.counts[0], 1, 'second chip perfect');
    const gauge = player.stats.gauge;
    // 4000 を超えると折り返し → START IN
    audio.advance(1600);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.START_IN);
    assertEq(player.startMs, 2000);
    assertEq(player.stats.counts[0], 0, 'counts reset on loop');
    assertEq(player.stats.counts[4], 0, 'miss count reset on loop');
    assertEq(player.stats.gauge, gauge, 'gauge kept on loop');
    assertEq(player.judged[1], false, 'chips after loop begin re-armed');
    audio.advance(400);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
  } finally {
    performance.now = origPerfNow;
  }
});

// ---- 停止中のシーク(譜面の確認) ----
test('player: seek while stopped moves the view silently and does not get pulled back', async () => {
  // BPM 120: 小節 0 頭 = 2000ms、1 小節 = 2000ms。SD 4 分打ち(2000, 2500, 3000, 3500)
  const { audio, player, chart, settings } = makePlayer('#BPM: 120\n#00012: 01010101\n#00212: 01\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  assertEq(player.state, PLAYER_STATE.STANDBY);
  assertEq(player.canSeek, true);
  const played = audio.played.length;

  // 待機中にシークすると表示位置が動き、音は鳴らない
  assert(player.seekTo(3000), 'seek applied');
  assertEq(Math.round(player.songMs), 3000);
  assertEq(audio.played.length, played, 'seeking is silent');
  // 通過済みのチップは判定済み、以降は未判定に戻る
  assertEq(player.judged[0], true);
  assertEq(player.judged[1], true);
  assertEq(player.judged[2], false, 'the chip at the seek position stays unjudged');

  // 毎フレームの待機位置同期に引き戻されない
  player.update(0, null);
  player.update(16, null);
  assertEq(Math.round(player.songMs), 3000, 'manual seek survives syncStandbyPosition');

  // ループ設定を動かしたときだけ待機位置へ戻す
  settings.loop = true;
  settings.loopBeginMs = 4000;
  settings.loopEndMs = 6000;
  player.update(32, null);
  assertEq(Math.round(player.songMs), 4000, 'follows the loop begin when it changes');

  // 同じ位置へのシークは false(無駄な jumpTo を避ける)
  assertEq(player.seekTo(4000), false);
  // 範囲外はクランプされる。閲覧はループ区間に縛らない
  player.seekTo(-500);
  assertEq(Math.round(player.songMs), 0, 'clamped to 0, not to the loop begin');
  player.seekTo(999999);
  assertEq(Math.round(player.songMs), Math.round(player.seekMaxMs));
  assert(player.seekMaxMs >= chart.durationMs, 'can look past the last note');
});

test('player: 演奏開始 starts from the seeked position; リスタート goes back to the top', async () => {
  const { audio, player, chart, settings } = makePlayer('#BPM: 120\n#00012: 01010101\n#00212: 01\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    player.seekTo(3000);
    player.command('startStop');
    assertEq(player.state, PLAYER_STATE.START_IN);
    assertEq(player.startMs, 3000, '演奏開始 uses the position being looked at');
    // 開始位置で judged[] が張り直されているので、始めた瞬間に MISS の山にならない
    assertEq(player.judged[0], true);
    assertEq(player.judged[2], false);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertNear(player.songMs, 3000, 60);

    player.command('restart');
    assertEq(player.startMs, 0, 'リスタート goes back to the song top');

    // ループ中は区間内へ寄せる(終了位置ちょうどだと最初のフレームで折り返してしまう)
    player.stop(); // 待機へ戻す(startStop は START_IN でも「開始」扱いになる)
    settings.loop = true;
    settings.loopBeginMs = 2000;
    settings.loopEndMs = 4000;
    player.update(perf(), null);
    player.seekTo(5000);
    assertEq(Math.round(player.songMs), 5000, 'browsing is not clamped');
    player.command('startStop');
    assertEq(player.startMs, 3999, 'starting is clamped into the loop range');
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: seeking while paused re-counts the score from there', async () => {
  const { audio, player, chart, settings } = makePlayer('#BPM: 120\n#00012: 01010101\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    player.command('startStop');
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    audio.advance(2000);
    player.update(perf(), null);
    player.hit(3, perf()); // 2000ms の SD を叩く
    assert(player.stats.total > 0, 'counted one hit');

    player.command('pauseResume');
    assertEq(player.state, PLAYER_STATE.PAUSED);
    assertEq(player.canSeek, true, 'can seek while paused');
    assert(player.seekTo(1000), '叩いた位置より手前へ巻き戻す'); // 2000ms の SD を叩き直すことになる
    assertEq(player.judged[0], false, 'the chip we already hit is armed again');
    player.command('pauseResume');
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertEq(player.stats.total, 0, 'counts are cut over so the same chip is not double counted');
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: cannot seek while playing', async () => {
  const { audio, player, chart } = makePlayer('#BPM: 120\n#00012: 01010101\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    player.command('startStop');
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertEq(player.canSeek, false);
    assertEq(player.seekTo(3000), false, 'refused while playing');
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: starting from past the last note is pulled into the playable range, not bounced to the top', async () => {
  // 末尾に空小節行がある譜面(譜面エディタがよく吐く)。小節線は最終ノートよりずっと後ろまで伸びる
  const { audio, player, chart } = makePlayer('#BPM: 120\n#00012: 01010101\n#01012: 00000000\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  assertEq(Math.round(chart.durationMs), 3500, '最終ノート');
  assert(player.seekMaxMs > chart.durationMs + 2000, '小節線は曲末判定の外まで伸びている');
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    player.seekTo(12000); // 最終ノートのはるか後ろ(確認用に見るのは自由)
    assertEq(Math.round(player.songMs), 12000);
    player.command('startStop');
    assertEq(player.startMs, 3500, '開始位置は演奏できる範囲へ寄せる');
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    // 曲末判定で即待機に落ちない(落ちると成績まで消える)
    audio.advance(100);
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING, 'does not bounce back to standby');
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: a seek during the start-in countdown does not wipe the score at the next resume', async () => {
  const { audio, player, chart } = makePlayer('#BPM: 120\n#00012: 01010101\n#00212: 01\n');
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  const perf = () => audio.ctx.currentTime * 1000;
  const origPerfNow = performance.now;
  performance.now = perf;
  try {
    player.command('startStop');
    assertEq(player.state, PLAYER_STATE.START_IN);
    assertEq(player.canSeek, true, '開始待ち中も譜面を確認できる');
    player.seekTo(3000); // SD は 2000/2500/3000/3500。3000 のチップは未判定のまま残る
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertNear(player.songMs, 3000, 60, '開始待ち中のシークが開始位置になる');
    player.hit(3, perf());
    const counted = player.stats.total;
    assert(counted > 0, 'counted a hit');
    // シークせずに一時停止 → 再開しただけなら成績は消えない
    player.command('pauseResume');
    player.command('pauseResume');
    assertEq(player.state, PLAYER_STATE.PLAYING);
    assertEq(player.stats.total, counted, 'the start-in seek must not leak into the resume');
  } finally {
    performance.now = origPerfNow;
  }
});

test('player: synth sounds are prepared while loading, and a failure does not stop loading', async () => {
  const { audio, player, chart } = makePlayer('#BPM: 120\n#00012: 01\n');
  const lanes = [];
  audio.synthBuffer = (lane) => { lanes.push(lane); return { lane }; };
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  assert(lanes.length >= 1, 'built during load (not on the first empty hit while playing)');
  const p2 = makePlayer('#BPM: 120\n#00012: 01\n');
  p2.audio.synthBuffer = () => { throw new Error('no AudioContext'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await p2.player.load({ resolve() { return null; }, readBytes() {} }, p2.chart);
  } finally {
    console.warn = warn;
  }
  assertEq(p2.player.state, PLAYER_STATE.STANDBY, 'loaded anyway');
});

// ---- 打鍵の直前にその時刻までの MISS などを確定する(判定がフレームの刻みに依らないこと) ----

/** n 個の枠のうち on の位置にチップ 01 を置いた小節の行。 */
const chipRow = (n, on) => Array.from({ length: n }, (_, i) => (on.includes(i) ? '01' : '00')).join('');
const statsOf = (p) => ({ counts: [...p.stats.counts], combo: p.stats.combo, maxCombo: p.stats.maxCombo, score: p.stats.score, gauge: p.stats.gauge });
const framesEvery = (step, from, to) => {
  const a = [];
  for (let t = from; t <= to + 1e-9; t += step) a.push(t);
  return a;
};

/** 譜面時刻で並べた打鍵({t, pad})とフレーム(譜面時刻)を時刻順に流し、成績を返す(同時刻は打鍵が先)。 */
async function playScript(dtx, { hits = [], frames = [], afterLoad } = {}) {
  const { audio, player, chart, settings } = makePlayer(dtx);
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  if (afterLoad) afterLoad(settings, player);
  const perf = () => audio.ctx.currentTime * 1000;
  const orig = performance.now;
  performance.now = perf;
  const marks = {};
  try {
    player.command('startStop');
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    const t0 = perf() - player.songMs; // 譜面時刻 0 の perf(偽の音は遅延 0)
    const events = [...hits.map((h) => ({ ...h, kind: 'hit' })), ...frames.map((t) => ({ t, kind: 'frame' }))];
    events.sort((a, b) => a.t - b.t || (a.kind === 'hit' ? -1 : 1));
    for (const e of events) {
      const d = t0 + e.t - perf();
      if (d > 0) audio.advance(d);
      if (e.kind === 'frame') {
        player.update(perf(), null);
      } else {
        player.hit(e.pad, perf());
        if (e.mark) marks[e.mark] = statsOf(player);
      }
    }
    return { ...statsOf(player), marks, played: audio.played };
  } finally {
    performance.now = orig;
  }
}

test('player: misses up to a hit are settled before the hit, so the result does not depend on the frame step', async () => {
  // BPM 120 の 16 分 = 125 ms。SD 2000(叩く)・SD 2125(叩かない → 2242 で MISS)・BD 2250(2255 で叩く)
  const dtx = `#BPM: 120\n#00012: ${chipRow(16, [0, 1])}\n#00013: ${chipRow(16, [2])}\n`;
  const hits = [{ t: 2003, pad: 3 }, { t: 2255, pad: 5 }];
  const results = [];
  for (const step of [1000 / 360, 1000 / 60, 100]) results.push(await playScript(dtx, { hits, frames: framesEvery(step, step, 2600) }));
  for (const r of results) {
    assertDeepEq(r.counts, [2, 0, 0, 0, 1]);
    assertEq(r.combo, 1, 'the MISS (2242) breaks the combo before the BD hit (2255)');
    assertEq(r.maxCombo, 1);
  }
  assertDeepEq(results[2], results[0], '100 ms frames = 360 Hz frames');
  assertDeepEq(results[1], results[0], '60 Hz frames = 360 Hz frames');
});

test('player: a hit just after an invisible chip is not swallowed by it before the next frame', async () => {
  // 64 分 = 31.25 ms。不可視 SD 2000、可視 SD 2031.25。2008 の打鍵は可視の方を取る
  // (元実装はフレームの頭で通過した不可視チップを消化してからパッドを見る)
  const dtx = `#BPM: 120\n#00032: ${chipRow(64, [0])}\n#00012: ${chipRow(64, [1])}\n`;
  for (const step of [1000 / 360, 100]) {
    const r = await playScript(dtx, { hits: [{ t: 2008, pad: 3 }], frames: framesEvery(step, step, 2400) });
    assertDeepEq(r.counts, [1, 0, 0, 0, 0], `frame step ${step.toFixed(2)} ms: visible SD hit (lag −23 ms)`);
  }
});

test('player: an AUTO-lane chip is auto-judged (not missed) when a hit arrives after a long frame gap', async () => {
  // SD 2000 は AUTO、BD 2250 を手で叩く。判定タイミング調整 +99、1990〜2400 ms はフレームが来ない(引っかかり)
  const dtx = `#BPM: 120\n#00012: ${chipRow(16, [0])}\n#00013: ${chipRow(16, [2])}\n`;
  const frames = [...framesEvery(10, 10, 1990), 2400, 2410];
  const r = await playScript(dtx, {
    hits: [{ t: 2250, pad: 5, mark: 'hit' }],
    frames,
    afterLoad: (s) => {
      s.autoLanes[3] = true;
      s.judgeOffsetMs = 99;
    },
  });
  assertEq(r.marks.hit.counts[4], 0, 'no MISS for the AUTO chip');
  assertEq(r.counts[4], 0);
});

test('player: a hit past the loop end does not settle misses (the wrap-around frame handles it)', async () => {
  // ループ 0〜2100、SD 2000(叩かない)。2100 の時点ではまだ窓の中(ずれ 100 ms)。2120 の空打ちで MISS にしない
  const dtx = `#BPM: 120\n#00012: ${chipRow(16, [0])}\n#00113: ${chipRow(16, [0])}\n`;
  const r = await playScript(dtx, {
    hits: [{ t: 2120, pad: 3, mark: 'hit' }],
    frames: [...framesEvery(10, 10, 2090), 2130],
    afterLoad: (s) => {
      s.loop = true;
      s.loopBeginMs = 0;
      s.loopEndMs = 2100;
    },
  });
  assertEq(r.marks.hit.counts[4], 0, 'no MISS from the hit past the loop end');
  assertEq(r.marks.hit.gauge, GAUGE_INITIAL, 'gauge untouched');
});

test('player: after a long frame gap, a hit does not play the passed AUTO chips at once (they are scheduled first)', async () => {
  // HH(01)を AUTO にした 16 分。1500〜2410 ms はフレームが来ず、2400 ms に SD を空打ちする
  const dtx = `#BPM: 120
#WAV01: hh.wav
#00011: ${chipRow(16, [...Array(16).keys()])}
`;
  const r = await playScript(dtx, {
    hits: [{ t: 2400, pad: 3 }],
    frames: [...framesEvery(10, 10, 1500), 2410, 2420],
    afterLoad: (s, p) => {
      s.autoLanes[1] = true;
      p.audio.buffers.set('01', { duration: 0.3 });
    },
  });
  const hh = r.played.filter((x) => x.id === '01');
  assert(hh.length >= 4, 'HH chips played: ' + hh.length);
  for (const x of hh) assert(x.when !== undefined, 'every AUTO HH is scheduled at its own time (late ones lose their head in playBuffer)');
});

test('training: hi-speed is 0.1 steps and old 0.5-step configs are carried over', () => {
  const s = new TrainingSettings();
  assertEq(s.scrollSpeedTenth, 10, '既定は x1.0');
  assertNear(s.hiSpeedRatio, 1.0, 1e-9);
  s.scrollSpeedTenth = 13;
  assertNear(s.hiSpeedRatio, 1.3, 1e-9, '0.1 刻み');

  // 0.5 刻みで保存されていた設定(x1.0 = 2、x2.5 = 5)を引き継ぐ
  assertEq(TrainingSettings.fromJSON({ scrollSpeed: 2 }).scrollSpeedTenth, 10);
  assertNear(TrainingSettings.fromJSON({ scrollSpeed: 2 }).hiSpeedRatio, 1.0, 1e-9);
  assertNear(TrainingSettings.fromJSON({ scrollSpeed: 5 }).hiSpeedRatio, 2.5, 1e-9);
  // 新しいキーがあれば旧キーは見ない
  assertEq(TrainingSettings.fromJSON({ scrollSpeedTenth: 7, scrollSpeed: 2 }).scrollSpeedTenth, 7);
  // 往復しても変わらない
  const round = TrainingSettings.fromJSON(JSON.parse(JSON.stringify(TrainingSettings.fromJSON({ scrollSpeed: 5 }))));
  assertEq(round.scrollSpeedTenth, 25);
});

test('player: x1.0 scroll speed matches DTXmaniaNX', async () => {
  // NX CChip.ComputeDistanceFromBar: (raw+1)*0.5*37.5*286/60000 → raw=1(x1.0)で 0.17875 px/ms(720p)
  assertNear(SCROLL_BASE_PX_PER_MS, 0.17875 * 1.5, 1e-9, '1080p なので 1.5 倍');
  const { player, chart, settings } = makePlayer(['#BPM: 120', '#00012: 01', ''].join(String.fromCharCode(10)));
  await player.load({ resolve() { return null; }, readBytes() {} }, chart);
  assertNear(player.pixelsPerMs, 0.268125, 1e-9, 'x1.0');
  // BPM150 の 1 小節(1600ms)が NX の 286 dot ぶん(1080p では 429)流れる
  assertNear(player.pixelsPerMs * 1600, 286 * 1.5, 1e-6);

  settings.scrollSpeedTenth = 20; // x2.0
  player.applySettings();
  player.updateScrollSpeed(0); // 初回は即座に合わせる
  assertNear(player.pixelsPerMs, 0.268125 * 2, 1e-9, 'x2.0 は倍');

  // 以降は NX と同じなめらか変化(2ms ごとに倍率 0.006 ずつ)。一気には飛ばない
  settings.scrollSpeedTenth = 5; // x0.5
  player.applySettings();
  player.updateScrollSpeed(10); // 5 歩ぶん = 0.03
  assertNear(player.pixelsPerMs, 0.268125 * (2 - 0.03), 1e-9, 'なめらかに動く');
  player.updateScrollSpeed(2000); // 目標まで届くだけ進める
  assertNear(player.pixelsPerMs, 0.268125 * 0.5, 1e-9, 'x0.5 は半分');
});
