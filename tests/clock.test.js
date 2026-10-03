import { test, assert, assertEq, assertNear } from './runner.js';
import { AudioEngine } from '../js/core/audio.js';
import { Player, PLAYER_STATE } from '../js/game/player.js';
import { TrainingSettings } from '../js/game/training.js';
import { parseDTX } from '../js/core/dtx.js';

// Chrome に似せた音の時計(perf = performance.now の ms。ctx 時刻は perf / 1000 と同じ軸に置く)。
// - 音の処理は quantumMs ごと。currentTime はその区切りでしか進まず、出力より 1 区切り先を処理している
// - getOutputTimestamp は最後の区切りの時刻と、そのとき聞こえていた ctx 時刻(= その時刻 − 本当の出力遅延)の組
// - baseLatency + outputLatency はブラウザの推定で、本当の遅れと違ってよい
// - stall(true) の間は音の処理が止まる(currentTime も組も止まる)。止まりが明けると元の直線に戻る(Chrome の実測と同じ)
function chromeLikeClock({ trueLatMs = 42.7, estLatMs = 50, quantumMs = 10 } = {}) {
  let perf = 1000;
  let frozen = null;
  const cb = () => (frozen !== null ? frozen : Math.floor(perf / quantumMs) * quantumMs);
  const ctx = {
    state: 'running',
    get currentTime() { return (cb() + quantumMs) / 1000; },
    baseLatency: 0,
    outputLatency: estLatMs / 1000,
    getOutputTimestamp() {
      const t = cb();
      return { contextTime: (t - trueLatMs) / 1000, performanceTime: t };
    },
  };
  return {
    ctx,
    trueLatMs,
    get perf() { return perf; },
    advance(ms) { perf += ms; },
    stall(on) { frozen = on ? cb() : null; },
    /** 聞こえている ctx 時刻が sec になる瞬間まで進める。 */
    advanceToHeard(sec) { perf = sec * 1000 + trueLatMs; },
  };
}

/** Player が使う所だけの音のエンジン。時計の部分は AudioEngine の本物(audibleCtxAt)を使う。 */
function fakeAudio(clock, userLatencyMs = 0) {
  return {
    ctx: clock.ctx,
    useOutputTimestamp: true,
    userLatencyMs,
    get outputLatencySec() { return this.ctx.baseLatency + this.ctx.outputLatency + this.userLatencyMs / 1000; },
    audibleCtxAt: AudioEngine.prototype.audibleCtxAt,
    buffers: new Map(),
    played: [],
    async loadChartSounds() { return this.buffers; },
    hasBuffer(id) { return this.buffers.has(id); },
    play(id, opts) { this.played.push({ id, ...opts }); return { src: null }; },
    playBuffer(buf, opts) { this.played.push(opts); return { src: null }; },
    stopVoice() {},
    stopAll() {},
    synthBuffer(lane) { return { lane }; },
  };
}

/** performance.now を時計の perf に差し替えて fn を走らせる。 */
async function withPerf(clock, fn) {
  const orig = performance.now;
  performance.now = () => clock.perf;
  try {
    await fn();
  } finally {
    performance.now = orig;
  }
}

// BGM(01 = 小節 0 頭 = 2000 ms)、SD と BD(どちらも 2000 ms)。SD は AUTO にして音を予約させる
const CHART = '#BPM: 120\n#WAV01: sd.wav\n#WAV02: bgm.wav\n#00001: 02\n#00012: 01\n#00013: 01\n';

async function makePlayer(clock, userLatencyMs = 0) {
  const audio = fakeAudio(clock, userLatencyMs);
  audio.buffers.set('01', { duration: 1 });
  audio.buffers.set('02', { duration: 10 });
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  settings.autoLanes[3] = true;
  const player = new Player({ audio, settings, config: {} });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX(CHART));
  return { audio, settings, player };
}

test('clock: audibleCtxAt extends the getOutputTimestamp pair and rejects unusable pairs', () => {
  const c = chromeLikeClock({ trueLatMs: 40 });
  const eng = new AudioEngine();
  eng.ctx = c.ctx;
  eng.useOutputTimestamp = true;
  c.advance(3.3); // 処理の区切りの途中
  const p = c.perf;
  assertNear(eng.audibleCtxAt(p, p), (p - 40) / 1000, 1e-9, 'extended to perfMs');
  assertNear(eng.audibleCtxAt(p - 5, p), (p - 45) / 1000, 1e-9, 'a past perfMs maps to the past (not clamped)');

  eng.useOutputTimestamp = false;
  assertEq(eng.audibleCtxAt(p, p), null, 'browser not trusted');
  eng.useOutputTimestamp = true;
  c.ctx.state = 'suspended';
  assertEq(eng.audibleCtxAt(p, p), null, 'suspended (extending would run ahead of the stopped sound)');
  c.ctx.state = 'running';

  const real = c.ctx.getOutputTimestamp;
  const withPair = (pair) => {
    c.ctx.getOutputTimestamp = () => pair;
    try {
      return eng.audibleCtxAt(p, p);
    } finally {
      c.ctx.getOutputTimestamp = real;
    }
  };
  const ct = c.ctx.currentTime;
  assertEq(withPair({ contextTime: 0, performanceTime: 0 }), null, 'no pair yet');
  assertEq(withPair({ contextTime: ct - 0.2, performanceTime: p - 150 }), null, 'stale pair (output device stopped)');
  assertEq(withPair({ contextTime: ct + 0.4, performanceTime: p - 5 }), null, 'negative latency (first pair after start-up)');
  // Firefox 型: 呼んだときの currentTime と performance.now からそれぞれ出力遅延を引いて作る → 測った遅れが約 0
  assertEq(withPair({ contextTime: ct - 0.04, performanceTime: p - 40 }), null, 'pair synthesized from currentTime');
  assertEq(withPair({ contextTime: ct - 0.6, performanceTime: p }), null, 'latency over 500 ms');
  c.ctx.getOutputTimestamp = undefined;
  assertEq(eng.audibleCtxAt(p, p), null, 'API missing');
});

test('clock: getOutputTimestamp is trusted only on Chromium', () => {
  const t = AudioEngine.trustsOutputTimestamp;
  assertEq(t('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'), true, 'Chrome');
  assertEq(t('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'), true, 'Edge');
  assertEq(t('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'), true, 'Android Chrome');
  assertEq(t('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36'), true, 'headless Chrome');
  assertEq(t('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'), false, 'Firefox');
  assertEq(t('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), false, 'Safari');
  assertEq(t('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1'), false, 'Chrome on iOS (WebKit)');
  assertEq(t(''), false);
});

test('clock: the song clock advances every frame at 360 Hz (the currentTime clock moves in ~10 ms steps)', async () => {
  const clock = chromeLikeClock();
  const { audio, player } = await makePlayer(clock);
  await withPerf(clock, () => {
    player.command('startStop');
    player.update(clock.perf, null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    const run = () => {
      let prev = player.songMs;
      let stalls = 0;
      let maxErr = 0;
      for (let i = 0; i < 360; i++) {
        clock.advance(1000 / 360);
        const s = player.songMs;
        if (s === prev) stalls++;
        maxErr = Math.max(maxErr, Math.abs(s - prev - 1000 / 360));
        prev = s;
      }
      return { stalls, maxErr };
    };
    const smooth = run();
    assertEq(smooth.stalls, 0, 'no frame repeats the previous position');
    assertNear(smooth.maxErr, 0, 1e-6, 'each frame advances by the frame interval');
    // 組を使わない(推定の式)と、7 割のフレームで止まる
    audio.useOutputTimestamp = false;
    const stair = run();
    assert(stair.stalls > 200, 'the currentTime clock stalls on most frames: ' + stair.stalls);
  });
});

for (const [estLatMs, trueLatMs] of [[50, 42.7], [10, 150], [0, 40]]) {
  test(`clock: estimated ${estLatMs} / true ${trueLatMs} ms — anchored at currentTime, sounds land on the beat, in-time hits read 0`, async () => {
    const clock = chromeLikeClock({ estLatMs, trueLatMs });
    const { audio, player } = await makePlayer(clock);
    await withPerf(clock, () => {
      player.startTrainingAt(2000); // BGM と SD/BD がちょうど開始位置にある
      player.update(clock.perf, null);
      assertEq(player.state, PLAYER_STATE.PLAYING);
      const ctAtStart = clock.ctx.currentTime;
      assertNear(player._anchorReal, ctAtStart * 1000, 1e-9, 'start anchor = currentTime');
      const bgm = audio.played.find((x) => x.id === '02');
      assert(bgm, 'BGM scheduled');
      assertNear(bgm.when, ctAtStart, 1e-9, 'the BGM at the start position starts now (head not cut)');
      const sd = audio.played.find((x) => x.id === '01');
      assert(sd, 'SD scheduled');
      assert(sd.when >= ctAtStart - 1e-9 && sd.when <= ctAtStart + 0.2 + 1e-9, 'scheduled within 200 ms of currentTime');
      // その音が聞こえる瞬間に、曲の時計は 2000 を指し、BD を叩くとずれ 0
      clock.advanceToHeard(sd.when);
      player.update(clock.perf, null);
      assertNear(player.songMs, 2000, 0.01, 'song clock reads the note time when its sound is heard');
      player.hit(5, clock.perf);
      assertEq(player.stats.counts[0], 1, 'perfect');
      assertNear(player.stats.lastLagMs, 0, 0.01, 'lag 0 when hitting with the sound');
      // 一時停止 → 再開のアンカーも currentTime
      player.togglePause();
      clock.advance(500);
      player.togglePause();
      assertNear(player._anchorReal, clock.ctx.currentTime * 1000, 1e-9, 'resume anchor = currentTime');
      // 演奏中、毎フレーム予約される音は currentTime から 200 ms 先までに収まる
      const before = audio.played.length;
      for (let i = 0; i < 2000; i++) {
        clock.advance(1000 / 360);
        const n = audio.played.length;
        player.update(clock.perf, null);
        for (const x of audio.played.slice(n)) {
          const ct = clock.ctx.currentTime;
          assert(x.when === undefined || x.when <= ct + 0.2 + 1e-9, 'not scheduled too far ahead');
        }
      }
      assert(audio.played.length >= before, 'kept scheduling');
    });
  });
}

test('clock: a key event timestamped before the last clock read is not pulled forward', async () => {
  const clock = chromeLikeClock();
  const { player } = await makePlayer(clock);
  await withPerf(clock, () => {
    player.startTrainingAt(1500);
    player.update(clock.perf, null);
    // BD(2000 ms)が聞こえる瞬間の 3 ms 後にフレームが時計を読み、その後で 5 ms 前の打鍵が届く
    const heardPerf = clock.perf + (2000 - player.songMs);
    clock.advance(heardPerf + 3 - clock.perf);
    player.update(clock.perf, null);
    player.hit(5, clock.perf - 5);
    assertNear(player.stats.lastLagMs, -2, 0.01, 'judged at the key time (2 ms early), not at the frame read');
  });
});

test('clock: user latency keeps its sign — +20 ms makes the song clock read 20 ms behind the sound', async () => {
  const clock = chromeLikeClock({ estLatMs: 42.7, trueLatMs: 42.7 });
  const { audio, player } = await makePlayer(clock, 20);
  await withPerf(clock, () => {
    player.startTrainingAt(1500);
    player.update(clock.perf, null);
    let sd = null;
    for (let i = 0; i < 400 && !sd; i++) { // 予約されたら止める(聞こえる瞬間を未来に残す)
      clock.advance(1000 / 360);
      player.update(clock.perf, null);
      sd = audio.played.find((x) => x.id === '01');
    }
    assert(sd, 'SD scheduled');
    assert(sd.when * 1000 + clock.trueLatMs > clock.perf, 'heard in the future');
    clock.advanceToHeard(sd.when);
    assertNear(player.songMs, 2000 - 20, 0.01, 'new clock');
    // 推定の式でも同じ向き(量子化の 10 ms の揺れの範囲で)
    audio.useOutputTimestamp = false;
    assertNear(player.realFromPerf(clock.perf), sd.when * 1000 - 20, 10.01, 'fallback clock');
  });
});

test('clock: falls back to currentTime − estimated latency, and small backward steps of the frame clock are held', async () => {
  const clock = chromeLikeClock({ estLatMs: 50, trueLatMs: 42.7 });
  const { audio, player } = await makePlayer(clock);
  await withPerf(clock, () => {
    audio.useOutputTimestamp = false;
    clock.advance(5);
    assertNear(player.realFromPerf(clock.perf), (clock.ctx.currentTime - 0.05) * 1000, 1e-9, 'fallback = currentTime − estimate');
    // 組の時計(perf − 42.7)から推定の式(区切り + 10 − 50)へ切り替わると 2.3 ms 戻る → 前の値で止める
    audio.useOutputTimestamp = true;
    const a = player.nowReal();
    audio.useOutputTimestamp = false;
    const b = player.nowReal();
    assertEq(b, a, 'held instead of going back');
    clock.advance(10);
    assert(player.nowReal() > a, 'moves on once the clock passes the held value');
    // realFromPerf は止めない
    assert(player.realFromPerf(clock.perf - 20) < a, 'conversion of past timestamps is not held');
  });
});

// ---- レビューで足したもの(先読みの量・後退止めの範囲・速度変更) ----

const DENSE = `#BPM: 120\n#WAV01: sd.wav\n#00012: ${'01'.repeat(8)}\n#00112: ${'01'.repeat(8)}\n`;

async function makeDense(clock, userLatencyMs = 0) {
  const audio = fakeAudio(clock, userLatencyMs);
  audio.buffers.set('01', { duration: 1 });
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  settings.autoLanes[3] = true;
  const player = new Player({ audio, settings, config: {} });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX(DENSE));
  return { audio, player };
}

/** 60 Hz で ms ぶん演奏し、その間に予約された SD の音と、予約した瞬間の currentTime を返す。 */
function playFrames(clock, audio, player, ms) {
  const out = [];
  for (let t = 0; t < ms; t += 1000 / 60) {
    clock.advance(1000 / 60);
    const n = audio.played.length;
    player.update(clock.perf, null);
    for (const x of audio.played.slice(n)) if (x.id === '01') out.push({ when: x.when, ct: clock.ctx.currentTime });
  }
  return out;
}

for (const [label, est, tru, user] of [['true latency 250 ms (estimate 0)', 0, 250, 0], ['user latency −300 ms', 42.7, 42.7, -300]]) {
  test(`clock: ${label} — every AUTO chip is scheduled with a time, never cut or played immediately`, async () => {
    const clock = chromeLikeClock({ estLatMs: est, trueLatMs: tru });
    const { audio, player } = await makeDense(clock, user);
    await withPerf(clock, () => {
      player.startTrainingAt(1500);
      player.update(clock.perf, null);
      const sds = playFrames(clock, audio, player, 3000);
      assert(sds.length >= 10, 'SD chips played: ' + sds.length);
      for (const x of sds) {
        assert(x.when !== undefined, 'scheduled with a time (not the immediate path)');
        assert(x.when >= x.ct - 1e-9, `scheduled ahead of currentTime (when ${x.when.toFixed(4)} < ct ${x.ct.toFixed(4)})`);
      }
    });
  });
}

test('clock: a play speed change keeps the song position continuous', async () => {
  const clock = chromeLikeClock();
  const { audio, player } = await makeDense(clock);
  await withPerf(clock, () => {
    player.startTrainingAt(1500);
    player.update(clock.perf, null);
    playFrames(clock, audio, player, 500);
    const before = player.songMs;
    player.playSpeedStep(+1);
    assertNear(player.songMs, before, 0.01, 'no jump at the speed change');
    clock.advance(100);
    assertNear(player.songMs, before + 100 * player.ratio, 0.01, 'advances at the new speed');
  });
});

test('clock: a large step on the same clock (user latency +20 ms) is not held', async () => {
  const clock = chromeLikeClock();
  const { audio, player } = await makeDense(clock);
  await withPerf(clock, () => {
    clock.advance(3);
    const a = player.nowReal();
    audio.userLatencyMs = 20;
    assertNear(player.nowReal(), a - 20, 1e-6, 'goes back by 20 ms at once');
  });
});

test('clock: when the audio output stalls, the clock stops instead of running ahead and jumping back', async () => {
  const clock = chromeLikeClock({ estLatMs: 50, trueLatMs: 42.7 });
  const { player } = await makeDense(clock);
  await withPerf(clock, () => {
    clock.advance(3);
    let prev = player.nowReal();
    const step = (n) => {
      for (let i = 0; i < n; i++) {
        clock.advance(1000 / 360);
        const v = player.nowReal();
        assert(v >= prev - 1e-9, `never goes back (${prev.toFixed(2)} → ${v.toFixed(2)})`);
        prev = v;
      }
    };
    step(30);
    clock.stall(true);
    step(108); // 300 ms 止まる
    clock.stall(false);
    step(30);
    assertNear(prev, clock.perf - 42.7, 1e-6, 'back on the pair clock after the stall');
  });
});

test('clock: after switching between the pair clock and the estimate, a backward step is held until caught up', async () => {
  // 推定 20 ms・本当 42.7 ms: 推定の式は組の時計より 20〜30 ms 先にある(ctx の resume 直後と同じ形)
  const clock = chromeLikeClock({ estLatMs: 20, trueLatMs: 42.7 });
  const { audio, player } = await makeDense(clock);
  await withPerf(clock, () => {
    let prev = -Infinity;
    const read = () => {
      const v = player.nowReal();
      assert(v >= prev - 1e-9, `never goes back (${prev.toFixed(2)} → ${v.toFixed(2)})`);
      prev = v;
    };
    for (const usePair of [true, false, true, false, true]) {
      audio.useOutputTimestamp = usePair;
      for (let i = 0; i < 40; i++) {
        clock.advance(1000 / 360);
        read();
      }
    }
    assertNear(prev, clock.perf - 42.7, 1e-6, 'caught up and back on the pair clock');
  });
});
