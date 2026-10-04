// ギター / ベースの演奏画面(GuitarRenderer): 下敷き・全部の演出・タッチの列・チップの位置(既定の向きと REVERSE)。
import { test, assert, assertEq, assertNear } from './runner.js';
import { GuitarRenderer } from '../js/ui/gbrenderer.js';
import {
  Skin, DEFAULT_SKIN_BASE, GB_LANE_RGB, GB_OPEN_RGB, GB_WAIL_RGB, GB_JUDGE_Y, GB_JUDGE_Y_REVERSE, GB_WAIL_COL, GB_PANEL,
  gbLaneCenterX,
} from '../js/ui/skin.js';
import { GB_TOUCH_OPEN } from '../js/ui/gbinput.js';
import { GuitarPlayer } from '../js/game/gbplayer.js';
import { PLAYER_STATE } from '../js/game/player.js';
import { TrainingSettings } from '../js/game/training.js';
import { parseDTX, INSTRUMENT, GB_LANE_BITS } from '../js/core/dtx.js';

// 横 16:9 ちょうど / 上下に余白 / 縦画面(パネルだけの切り出し)
const SIZES = [[1920, 1080], [1317, 1016], [784, 1405]];

// BPM 120(小節 0 の頭 = 2000 ms、4 分 = 500 ms): R 2000、G 2500、OPEN 3000、ウェイリング 3500、Y+P 5000、
// R のロングノート 6000〜7000
const CHART = [
  '#BPM: 120',
  '#WAV01: a.wav',
  '#00024: 01000000',
  '#00022: 00010000',
  '#00020: 00000100',
  '#00028: 00000001',
  '#001AC: 0001',
  '#00224: 0100',
  '#0022C: 0101',
].join('\n');

function fakeAudio() {
  return {
    ctx: { get currentTime() { return 3; } },
    outputLatencySec: 0,
    buffers: new Map(),
    async loadChartSounds() { return this.buffers; },
    hasBuffer() { return false; },
    play() { return { src: null }; },
    playBuffer() { return { src: null }; },
    stopVoice() {},
    stopAll() {},
    synthBuffer(lane) { return { lane }; },
  };
}

/** ハイスピード x2.0 のギターの演奏(待機中・曲頭)。 */
async function makePlayer() {
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  settings.gbScrollSpeedTenth = 20;
  const player = new GuitarPlayer({ audio: fakeAudio(), settings, config: {}, inst: INSTRUMENT.GUITAR });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX(CHART));
  return player;
}

function makeRenderer(player, w, h, { warm = false, skin = new Skin() } = {}) {
  const canvas = document.createElement('canvas');
  const r = new GuitarRenderer(canvas, skin, player);
  if (!warm) r._warm = 0;
  r.resize(w, h, 1, 'auto', 52);
  return { r, canvas };
}

function pixels(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 論理座標 (x, y) の画素の [r, g, b]。 */
function pixelAt(r, canvas, x, y) {
  const px = Math.floor(r.offsetX + (x - r.view.x) * r.scale);
  const py = Math.floor(r.offsetY + (y - r.view.y) * r.scale);
  return Array.from(canvas.getContext('2d').getImageData(px, py, 1, 1).data.slice(0, 3));
}

function assertColor(actual, expected, tol, msg) {
  const ok = actual.every((v, i) => Math.abs(v - expected[i]) <= tol);
  assert(ok, `${msg}: expected≈${expected} actual=${actual}`);
}

/** console.warn を数えながら fn を走らせる(下敷きの失敗は catch で握りつぶされ、警告にしか出ない)。 */
function countWarns(fn) {
  const warn = console.warn;
  let n = 0;
  console.warn = (...a) => { n++; warn(...a); };
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return n;
}

test('gb renderer: the effect underlay of the first frames is hidden by the static layer', () => {
  for (const reverse of [false, true]) {
    const player = { chart: null, reverse };
    for (const [w, h] of SIZES) {
      const a = makeRenderer(player, w, h, { warm: true });
      const b = makeRenderer(player, w, h);
      const frames = a.r._warm;
      assert(frames > 0, 'warm frames scheduled');
      a.r.draw(0);
      b.r.draw(0);
      assert(samePixels(pixels(a.canvas), pixels(b.canvas)), `${w}x${h} reverse=${reverse}: first frame identical with and without the underlay`);
      const warns = countWarns(() => { for (let i = 1; i <= frames; i++) a.r.draw(0); });
      assertEq(warns, 0, 'the underlay did not fail');
      assertEq(a.r._warm, 0, 'underlay finished');
      assertEq(a.r._base.getContext('2d').getContextAttributes().alpha, false, 'static layer rebuilt opaque after the underlay');
      b.r.draw(0);
      assert(samePixels(pixels(a.canvas), pixels(b.canvas)), `${w}x${h}: identical after the underlay`);
    }
  }
});

test('gb renderer: draws frames with every effect active (3 sizes, normal and reverse, plain and default skin)', async () => {
  const player = await makePlayer();
  const s = player.settings;
  s.loop = true;
  s.loopBeginMs = 5500;
  s.loopEndMs = 6800;
  player.applySettings();
  player.state = PLAYER_STATE.PLAYING;
  player._anchorReal = 3000; // 偽の音の時計は ctx 3 秒 = 実時間 3000 ms
  player._anchorSong = 6100;
  const ln = player.notes.findIndex((n) => n.lnEndMs >= 0);
  player.judged[ln] = true;
  player.holdIndex = ln; // ロングノートを押さえている(胴は判定ラインに留まる)
  const now = 10000;
  player.fretHeld[0] = true;
  player.fretAt[0] = now - 300;
  player.fretAt[1] = now - 50;
  player.fretUpAt[1] = now - 20; // 離して消えかけ
  for (let i = 0; i < 5; i++) player.fireAt[i] = now - 10 - i * 30;
  player.gbJudge = { at: now - 40, judge: 1, lagMs: 12, auto: false, bad: false };
  player.wailAt = now - 200;
  player.lnTickAt = now - 100;
  player.pickAt = now - 50;
  player.stats.combo = 123;
  player.comboJumpAt = now - 60;
  player.showStatus('PLAY SPEED x1.00');
  player.statusUntil = now + 1000;
  const skins = [new Skin(), await Skin.load(null, { defaultBase: '../' + DEFAULT_SKIN_BASE })];
  for (const skin of skins) {
    for (const reverse of [false, true]) {
      player.reverse = reverse;
      for (const [w, h] of SIZES) {
        const { r } = makeRenderer(player, w, h, { warm: true, skin });
        assertEq(countWarns(() => {
          for (let i = 0; i < 12; i++) r.draw(now + i);
          player.gbJudge.bad = true; // Light OFF の空ピック
          r.draw(now + 20);
          player.gbJudge.bad = false;
          player.state = PLAYER_STATE.PAUSED; // 状態表示
          r.draw(now + 21);
          player.state = PLAYER_STATE.PLAYING;
        }), 0, `${w}x${h} reverse=${reverse}: no warnings`);
        assertEq(r._warm, 0);
      }
    }
  }
});

test('gb renderer: touch columns map to lanes 0..4, elsewhere on the highway to an open pick', async () => {
  const player = await makePlayer();
  for (const [w, h] of [[1920, 1080], [784, 1405]]) {
    const { r } = makeRenderer(player, w, h);
    // 論理座標 → クライアント座標(キャンバスは文書に無いので左上が 0, 0)
    const client = (x, y) => [r.offsetX + (x - r.view.x) * r.scale, r.offsetY + (y - r.view.y) * r.scale];
    for (let i = 0; i < 5; i++) {
      for (const y of [GB_PANEL.y, 600, 1070]) assertEq(r.hitTestLane(...client(gbLaneCenterX(i), y)), i, `${w}x${h}: lane ${i} at y ${y}`);
    }
    assertEq(r.hitTestLane(...client((GB_WAIL_COL[0] + GB_WAIL_COL[1]) / 2, 600)), GB_TOUCH_OPEN, 'wailing column');
    assertEq(r.hitTestLane(...client(GB_PANEL.x + 10, 600)), GB_TOUCH_OPEN, 'beside the neck (left rail)');
    assertEq(r.hitTestLane(...client(660, 400)), GB_TOUCH_OPEN, 'gauge');
    assertEq(r.hitTestLane(...client(gbLaneCenterX(2), 10)), -1, 'above the highway');
  }
  const { r } = makeRenderer(player, 1920, 1080);
  assertEq(r.hitTestLane(300, 600), GB_TOUCH_OPEN, 'landscape: the left of the screen');
});

test('gb renderer: chips, OPEN, wailing chip and long-note bodies are drawn where expected (normal and reverse)', async () => {
  const player = await makePlayer();
  const ppm = player.pixelsPerMs;
  assertNear(ppm, 0.268125, 1e-9, 'x2.0 = drum base speed');
  const R = GB_LANE_RGB[0];
  const G = GB_LANE_RGB[1];
  for (const reverse of [false, true]) {
    player.reverse = reverse;
    const JL = reverse ? GB_JUDGE_Y_REVERSE : GB_JUDGE_Y;
    const yc = (t, song) => (reverse ? JL + 1.5 - (t - song) * ppm : JL + 1.5 + (t - song) * ppm);
    const { r, canvas } = makeRenderer(player, 1920, 1080);
    const tag = reverse ? 'reverse' : 'normal';

    player.seekTo(1500);
    r.draw(0);
    assertColor(pixelAt(r, canvas, gbLaneCenterX(0), yc(2000, 1500)), R, 0, `${tag}: R chip`);
    assertColor(pixelAt(r, canvas, gbLaneCenterX(1), yc(2500, 1500)), G, 0, `${tag}: G chip`);
    assert(pixelAt(r, canvas, gbLaneCenterX(1), yc(2000, 1500)).join() !== G.join(), `${tag}: nothing in the G lane at the R chip`);
    // OPEN は 5 レーンにわたり、上端がチップの中心 − 1.5
    for (const i of [0, 2, 4]) assertColor(pixelAt(r, canvas, gbLaneCenterX(i), yc(3000, 1500) + 5), GB_OPEN_RGB, 0, `${tag}: OPEN over lane ${i}`);
    // ウェイリングチップ(中心は判定位置 ± 距離。+1.5 なし)。待機中の文字にかからない右上寄りを見る
    const wy = reverse ? JL - 2000 * ppm : JL + 2000 * ppm;
    assertColor(pixelAt(r, canvas, GB_WAIL_COL[0] + 48, wy - 30), GB_WAIL_RGB, 0, `${tag}: wailing chip`);
    // 反対の向きの位置には描かない
    const mirror = reverse ? GB_JUDGE_Y + 1.5 + 500 * ppm : GB_JUDGE_Y_REVERSE + 1.5 - 500 * ppm;
    assert(pixelAt(r, canvas, gbLaneCenterX(0), mirror).join() !== R.join(), `${tag}: no chip at the mirrored position`);

    // ロングノート(6000〜7000): 胴は頭の中心から終端まで α128
    player.seekTo(5000);
    const ln = player.notes.findIndex((n) => n.lnEndMs >= 0);
    r.draw(0);
    const mid = (yc(6000, 5000) + yc(7000, 5000)) / 2;
    const half = R.map((v) => v * 128 / 255);
    assertColor(pixelAt(r, canvas, gbLaneCenterX(0), yc(6000, 5000)), R, 0, `${tag}: LN head`);
    assertColor(pixelAt(r, canvas, gbLaneCenterX(0), mid), half, 2, `${tag}: LN body at α128`);
    // 押さえている間は頭を描かず、胴を判定ラインから終端まで描く
    player.judged[ln] = true;
    player.holdIndex = ln;
    r.draw(0);
    const near = reverse ? JL + 1.5 - 30 : JL + 1.5 + 30;
    assertColor(pixelAt(r, canvas, gbLaneCenterX(0), near), half, 2, `${tag}: held body pinned to the judge line`);
    // 離した(取り逃した)胴は α64 で動き続ける
    player.holdIndex = -1;
    r.draw(0);
    assertColor(pixelAt(r, canvas, gbLaneCenterX(0), mid), R.map((v) => v * 64 / 255), 2, `${tag}: released body at α64`);
    player.judged[ln] = false;
  }
  player.reverse = false;
});

test('gb renderer: AUTO lanes light ahead of the nearest chip; a released fret fades over 70 ms', async () => {
  const player = await makePlayer();
  const { r } = makeRenderer(player, 1920, 1080);
  player.autoMask = GB_LANE_BITS[0] | GB_LANE_BITS[1]; // R と G が AUTO
  const now = 5000;
  assertEq(r._laneLight(player, 1500, now).join(), '0,-1,-1,-1,-1', 'R chip 500 ms ahead lights R only');
  assertEq(r._laneLight(player, 1000, now + 100).join(), '-1,-1,-1,-1,-1', 'nothing within 800 ms (R faded after 70 ms)');
  assertEq(r._laneLight(player, 2300, now + 200).join(), '0,-1,-1,-1,-1', 'the unjudged R chip 300 ms past wins over the nearer G chip');
  player.judged[0] = true;
  assertEq(r._laneLight(player, 2300, now + 300).join(), '-1,0,-1,-1,-1', 'then the G chip');
  player.judged[0] = false;
  player.autoMask = 0;
  player.fretHeld[3] = true;
  player.fretAt[3] = now;
  assertEq(r._laneLight(player, 0, now + 400)[3], 0, 'held');
  player.fretHeld[3] = false;
  player.fretUpAt[3] = now + 410;
  assertEq(r._laneLight(player, 0, now + 440)[3], 30, 'fading 30 ms after the release');
  assertEq(r._laneLight(player, 0, now + 500)[3], -1, 'gone after 70 ms');
});

test('gb renderer: seek bar side and static layer follow the direction', async () => {
  const player = await makePlayer();
  const { r } = makeRenderer(player, 1280, 720);
  assertEq(r.seekBarAtBottom, true, 'judge line at the top → seek bar at the bottom');
  r.draw(0);
  const base = r._base;
  r.draw(0);
  assertEq(r._base, base, 'kept while nothing changes');
  player.reverse = true;
  assertEq(r.seekBarAtBottom, false);
  r.draw(0);
  assert(r._base !== base, 'rebuilt for reverse (judge line moves)');
  assertEq(base.width, 0, 'old pixels released');
  player.reverse = false;
});
