// 動画・音声から譜面を作る(js/gen/)のテスト。プレー動画は本物の代わりに、DTXMania の GITADORA 風スキンの配置で
// チップと小節線・拍線が落ちてくるコマを合成して流す(第三者の動画は使わない)。音も合成する。
import { test, assert, assertEq, assertNear, assertDeepEq } from './runner.js';
import { rint, median, percentile, lineFit } from '../js/gen/num.js';
import { LAYOUTS, layoutFor, autoLayoutName } from '../js/gen/layout.js';
import { FrameDetector } from '../js/gen/detect.js';
import { dropStatic, mergeBlobs, effectiveFrames } from '../js/gen/track.js';
import { snapTick, bpmText, measureMarks, layoutBars, quantize, bisectRight } from '../js/gen/emit.js';
import { estimateFramePeriod } from '../js/gen/frames.js';
import { analyzeVideo, bgmStartOf, videoChips } from '../js/gen/video2dtx.js';
import { correlateOffsetMs, AVSYNC } from '../js/gen/avsync.js';
import { KIT, kitWavs, encodeWav, renderChannelLine, chartText } from '../js/gen/kit.js';
import { parseDTX, posToMs, LEAD_IN_TICKS } from '../js/core/dtx.js';
import { decodeWav } from '../js/core/wav.js';
import { T0, demoChips, chipTime, synthScan } from './gensynth.js';

// ---- 数値の小道具 ----

test('gen: numpy-compatible rounding, median, percentile, line fit', () => {
  assertDeepEq([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4, 2.6].map(rint), [0, 2, 2, -0, -2, -2, 2, 3]);
  assertEq(median([3, 1, 2]), 2);
  assertEq(median([4, 1, 2, 3]), 2.5);
  assertNear(percentile([1, 2, 3, 4, 5], 20), 1.8, 1e-12);
  assertNear(percentile([10, 20], 90), 19, 1e-12);
  const f = lineFit([0, 1, 2, 3], [1, 3, 5, 7]);
  assertNear(f.a, 2, 1e-12);
  assertNear(f.b, 1, 1e-12);
  assertEq(lineFit([1, 1], [0, 1]), null, 'x が同じ');
  assertEq(bisectRight([0, 8, 16], 8), 2);
  assertEq(bisectRight([0, 8, 16], 7.9), 1);
});

test('gen: layouts — auto by height, scaled to another size keeps the lanes centered', () => {
  assertEq(autoLayoutName(1280, 720), 'dtxmania-720');
  assertEq(autoLayoutName(1920, 1080), 'gitadora-1080');
  const a = layoutFor('dtxmania-720', 1280, 720);
  assertEq(a.fieldX0, 295);
  assertEq(a.lanes[1].name, 'HH');
  assert(a.lanes[1].white);
  // 1920x1080 の DTXMania の録画: 1.5 倍
  const b = layoutFor('dtxmania-720', 1920, 1080);
  assertEq(b.fieldX0, Math.round(295 * 1.5));
  assertEq(b.judgeY, 840);
  assertNear(b.mergePx, 21, 1e-12);
  // 4:3 の動画(960x720)は横の真ん中をそろえる
  const c = layoutFor('dtxmania-720', 960, 720);
  assertEq(c.lanes[0].x0, 297 - 160);
  assertEq(c.judgeY, 560);
});

// ---- 段ごと ----

test('gen detect: chip core rows per lane (colored and white) and full-width gray lines with their brightness', () => {
  const cfg = layoutFor('dtxmania-720', 1280, 720);
  const det = new FrameDetector(cfg);
  const w = det.width;
  const h = det.rows;
  const data = new Uint8ClampedArray(w * h * 4);
  const fill = (x0, x1, y0, y1, rgb) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 4;
        data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
      }
    }
  };
  fill(0, w, 0, h, [10, 10, 20]);
  const lx = (name) => cfg.lanes.find((l) => l.name === name);
  const sd = lx('SD');
  fill(sd.x0 - cfg.fieldX0, sd.x1 - cfg.fieldX0, 100, 108, [255, 200, 40]); // 黄色のスネア: S 215・V 255
  const hh = lx('HH');
  fill(hh.x0 - cfg.fieldX0, hh.x1 - cfg.fieldX0, 200, 208, [240, 240, 250]); // 白銀のハイハット
  fill(hh.x0 - cfg.fieldX0, hh.x1 - cfg.fieldX0, 300, 308, [255, 60, 60]); // HH の帯の有彩色は数えない
  const bd = lx('BD');
  fill(bd.x0 - cfg.fieldX0, bd.x0 - cfg.fieldX0 + 20, 250, 258, [80, 80, 255]); // 帯の 55 % に足りない
  fill(0, w, 350, 352, [150, 150, 150]); // 線(2 行)
  fill(0, w, 360, 361, [150, 150, 150]); // 間が 8 行あれば別の線
  det.detect(data, 7);
  const rows = det.chips.f.map((f, i) => [f, cfg.lanes[det.chips.lane[i]].name, det.chips.y[i], det.chips.h[i]]);
  rows.sort((a, b) => a[2] - b[2]);
  assertDeepEq(rows, [[7, 'SD', 60 + 103.5, 8], [7, 'HH', 60 + 203.5, 8]]);
  assertDeepEq(det.lines.y, [60 + 350.5, 60 + 360]);
  assertNear(det.lines.v[0], 150, 1e-9);
  assertEq(det.frames, 8);
});

test('gen track: static detections are dropped, same-frame fragments merge, frozen runs are not stutter', () => {
  // y=100 にずっと止まっているものと、動くもの
  const f = [0, 1, 2, 3, 1, 2, 3];
  const y = [100, 100, 100, 100, 50, 62, 74];
  assertDeepEq(dropStatic(f, y), [0, 3, 4, 5, 6], '両隣のコマに同じ y があるものだけ落とす');
  const mb = mergeBlobs([5, 5, 5, 6], [100, 110, 140, 50], [8, 2, 4, 1], 14);
  assertDeepEq(mb.f, [5, 5, 6]);
  assertNear(mb.y[0], 102, 1e-12, '重み付きの平均');
  assertDeepEq([...effectiveFrames(Int32Array.from([0, 1, 0, 2, 1, 0, 0, 0, 1]))], [0, 1, 1, 3, 4, 5, 6, 7, 8]);
});

test('gen emit: 12/16 snap, #BPM rounding, measure marks with a 3/4 bar and a missing bright line, layout offset', () => {
  assertEq(snapTick(5), 0);
  assertEq(snapTick(122), 120, '12 の倍数');
  assertEq(snapTick(126), 128, '16 の倍数(3 連)');
  assertEq(snapTick(380), 384, '次の小節の頭');
  assertEq(bpmText(150.00001, 120), 150);
  assertEq(bpmText(177.0512, 100), 177.05);
  assertEq(bpmText(138.0163, 300), 138.016);
  // 明るい線: 0, 8, 16, 22(3/4), 38(4/4 が 1 つ抜けた)
  const h = [];
  const bright = [];
  for (let k = 0; k <= 40; k += 2) {
    h.push(k);
    bright.push([0, 8, 16, 22, 38].includes(k) ? 200 : 110);
  }
  const mm = measureMarks(h, bright);
  assertDeepEq(mm.starts, [0, 8, 16, 22, 30, 38]);
  // 明るい線と暗い線が近いと 4/4 の位相だけ
  const mm2 = measureMarks(h, bright.map((b) => (b > 150 ? 115 : 110)));
  assertDeepEq(mm2.starts, [0]);
  assert(mm2.warn.length === 1);
  // 最初のチップが動画の小節 1 → そのまま、小節番号を 3 にずらす
  let lb = layoutBars([0, 8, 16], 9, 20, null);
  assertEq(lb.measureOffset, 0);
  assertDeepEq(lb.starts.slice(0, 4), [0, 8, 16, 24]);
  lb = layoutBars([0, 8, 16], 9, 20, 3);
  assertDeepEq(lb.starts.slice(0, 5), [-24, -16, -8, 0, 8], '前に 4/4 の小節を 3 つ足す(動画の小節 0 が譜面の小節 3)');
  // 小節の頭のチップが少し早く出ても、その小節のチップと数える
  lb = layoutBars([0, 8, 16], 7.95, 20, null);
  assertEq(lb.firstM, 1);
  assertEq(lb.measureOffset, 0);
  // 最初のチップが小節 0 → 1 小節足す
  lb = layoutBars([0, 8], 2, 10, null);
  assertEq(lb.measureOffset, 1);
  assertEq(lb.starts[0], -8);
  // 一定の長さの小節(音から)
  const q = quantize({ BD: [{ t: 1.0 }, { t: 2.99 }] }, 1.0, 1.0, 1);
  assertDeepEq(q.placed.BD, [{ m: 1, tick: 0 }, { m: 3, tick: 0 }]);
});

test('gen kit: channel lines, chart text parses back (chips, bar length, BGM), WAVs decode', () => {
  assertEq(renderChannelLine(3, 0x13, [[0, 1], [192, 1]]), '#00313: 0101');
  assertEq(renderChannelLine(12, 0x12, [[288, 2], [300, 2]]), '#01212: ' + '00'.repeat(24) + '0202' + '00'.repeat(6));
  const text = chartText({
    title: 'テスト曲', comment: 'auto', bpm: 150, barRatios: [1, 1, 0.75, 1],
    chips: [{ m: 1, tick: 0, kind: 'BD' }, { m: 1, tick: 96, kind: 'HHC' }, { m: 2, tick: 128, kind: 'SD' }, { m: 3, tick: 0, kind: 'LBD' }],
    bgm: { file: 'bgm.wav', m: 0, tick: 0 },
  });
  assert(text.includes('#00202: 0.75') && text.includes('#00302: 1'), '4/4 へ戻る行も書く');
  const chart = parseDTX(text);
  assertEq(chart.bpm, 150);
  assertEq(chart.notes.length, 4);
  assertDeepEq(chart.notes.map((n) => [n.measure, n.tick, n.channel]), [[1, 0, 0x13], [1, 96, 0x11], [2, 128, 0x12], [3, 0, 0x1c]]);
  assertEq(chart.bgmEvents.length, 1);
  assertEq(chart.wavDefs.get('0B'), 'bgm.wav');
  assertEq(chart.wavDefs.get('01'), 'kit_BD.wav');
  // 小節 2 は 3/4: 小節 3 の頭は 4 + 4 + 3 = 11 拍目(150 BPM で 4400 ms。時刻はリードインの 1 小節の後から)
  assertNear(chart.notes[3].timeMs - posToMs(chart, LEAD_IN_TICKS), 4400, 0.01);
  const wavs = kitWavs();
  assertEq(wavs.length, Object.keys(KIT).length);
  for (const w of wavs) {
    const d = decodeWav(w.bytes);
    assertEq(d.channels, 1);
    assert(d.length > 1000, w.path);
  }
  const st = decodeWav(encodeWav([new Float32Array([0, 0.5, -1]), new Float32Array([1, -0.5, 0])], 22050));
  assertEq(st.sampleRate, 22050);
  assertNear(st.channelData[0][1], 0.5, 1e-4);
  assertNear(st.channelData[0][2], -1, 1e-9);
  assertNear(st.channelData[1][0], 32767 / 32768, 1e-9);
});

test('gen frames: frame period and phase from frame times (60 fps, every other frame, 59.94 fps with drops)', () => {
  let ts = Array.from({ length: 300 }, (_, i) => i / 60 + 0.004);
  let fp = estimateFramePeriod(ts);
  assertNear(1 / fp.period, 60, 1e-6);
  assertNear(fp.phase, 0.004, 1e-9);
  ts = Array.from({ length: 300 }, (_, i) => (2 * i) / 60);
  fp = estimateFramePeriod(ts);
  assertNear(1 / fp.period, 30, 1e-6, '1 コマおきは 30 fps として数える');
  const idx = [];
  for (let i = 0, k = 0; i < 400; i++) {
    k += i % 7 === 3 ? 2 : 1;
    idx.push(k);
  }
  fp = estimateFramePeriod(idx.map((k) => k * (1001 / 60000)));
  assertNear(1 / fp.period, 59.94, 1e-3);
  // 2 と 3 コマおきが混ざる(読むのが遅い)
  ts = [];
  for (let i = 0, k = 0; i < 300; i++) {
    ts.push(k / 60);
    k += i % 2 ? 3 : 2;
  }
  fp = estimateFramePeriod(ts);
  assertNear(1 / fp.period, 60, 1e-6);
});

// ---- 合成のプレー動画(tests/gensynth.js) ----

function expectedVideoChips() {
  return demoChips().map(([m, tick, lane]) => `${lane}@${m}:${tick}`).sort();
}

function placedList(placed) {
  return Object.entries(placed).flatMap(([lane, list]) => list.map((p) => `${lane}@${p.m}:${p.tick}`)).sort();
}

async function runSynth(o) {
  const cfg = layoutFor(o.layout, o.width, o.height);
  const log = [];
  const r = await analyzeVideo({
    width: o.width, height: o.height, layout: o.layout, measureOffset: o.measureOffset, log: (s) => log.push(s),
    scan: synthScan({ cfg, fps: o.fps, speed: o.speed, duration: o.duration, keep: o.keep, lag: o.lag }),
  });
  r.log = log.join('\n');
  return r;
}

test('gen video: a synthetic DTXMania play video gives back every chip at its tick (3/4 bar, triplets, 32nds, off-grid)', async () => {
  const r = await runSynth({ layout: 'dtxmania-720', width: 1280, height: 720, fps: 60, speed: 700, duration: 12.5 });
  assertEq(r.cfg.name, 'dtxmania-720');
  assertEq(r.step, 1);
  assertNear(r.events.speed, 700, 1);
  assertNear(r.grid.bpm, 150, 0.01);
  assertEq(r.grid.measureOffset, 0, '最初のチップは小節 1');
  assertDeepEq(r.grid.barRatios.slice(0, 7), [1, 1, 1, 0.75, 1, 1, 1]);
  assertNear(r.grid.gridOrigin, T0, 0.002);
  assertDeepEq(placedList(r.grid.placed), expectedVideoChips());
  // 譜面の本文にして読み直すと、時刻も合う
  const chips = videoChips(r.grid.placed);
  assert(chips.every((c) => KIT[c.kind]), '種類');
  const chart = parseDTX(chartText({ title: 't', comment: 'c', bpm: bpmText(r.grid.bpm, 10), chips, barRatios: r.grid.barRatios }));
  const want = demoChips().map(([m, tick]) => (chipTime(m, tick) - T0) * 1000).sort((a, b) => a - b);
  const m0 = posToMs(chart, LEAD_IN_TICKS);
  const got = chart.notes.map((n) => n.timeMs - m0).sort((a, b) => a - b);
  assertEq(got.length, want.length);
  for (let i = 0; i < want.length; i++) assertNear(got[i], want[i], 1.5, `chip ${i}`);
});

test('gen video: a capture stutter (repeated then skipped frame) is counted, frames read sparsely still work', async () => {
  let r = await runSynth({
    layout: 'dtxmania-720', width: 1280, height: 720, fps: 60, speed: 700, duration: 12.5, lag: [[200, 1], [450, 2]],
  });
  assertEq(r.events.stutter, 4, '繰り返し 2 回と飛ばし 2 回');
  assertDeepEq(placedList(r.grid.placed), expectedVideoChips(), r.log);
  // 2 コマと 3 コマおきが混ざる(2 倍速で読んだときのよう)
  r = await runSynth({
    layout: 'dtxmania-720', width: 1280, height: 720, fps: 60, speed: 700, duration: 12.5, keep: (i) => i % 5 === 0 || i % 5 === 2,
  });
  assert(r.step === 2 || r.step === 3, 'step ' + r.step);
  assertDeepEq(placedList(r.grid.placed), expectedVideoChips(), r.log);
  // 測りの番号をずらす(難易度ごとの動画で小節番号をそろえる)
  r = await runSynth({
    layout: 'dtxmania-720', width: 1280, height: 720, fps: 60, speed: 700, duration: 12.5, measureOffset: 3, keep: (i) => i % 2 === 0,
  });
  assertEq(r.grid.measureOffset, 3);
  assertDeepEq(placedList(r.grid.placed), expectedVideoChips().map((s) => s.replace(/@(\d+):/, (_, m) => `@${+m + 3}:`)).sort());
});

test('gen video: a synthetic GITADORA arcade video (1920x1080, 30 fps, fast scroll)', async () => {
  const r = await runSynth({ layout: 'auto', width: 1920, height: 1080, fps: 30, speed: 1200, duration: 12.5 });
  assertEq(r.cfg.name, 'gitadora-1080');
  // RD のレーンが無いので RD のチップは出ない
  assertDeepEq(placedList(r.grid.placed), expectedVideoChips().filter((s) => !s.startsWith('RD@')));
});

// ---- 音と絵のずれ ----

test('gen avsync: the audio onset lag behind chip times is measured (to a few ms), none on noise', () => {
  const sr = AVSYNC.sr;
  const times = [];
  for (let i = 0; i < 40; i++) times.push(1 + i * 0.37 + (i % 3) * 0.05);
  const pcm = new Float32Array(sr * 18);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < pcm.length; i++) pcm[i] = rnd() * 0.01;
  for (const t of times) {
    const a = Math.round((t + 0.032) * sr);
    for (let k = 0; k < 2000; k++) pcm[a + k] += rnd() * Math.exp(-k / 400);
  }
  const r = correlateOffsetMs(pcm, times);
  assert(r.ms !== null, 'confidence ' + r.confidence);
  assertNear(r.ms, 32, 3);
  // 雑音だけ: 峰は立たない(チップが少ないと平均の揺れで峰が立つので、譜面くらいの数で)
  const many = Array.from({ length: 600 }, (_, i) => 0.5 + i * 0.137);
  const noise = new Float32Array(sr * 84).map(() => rnd() * 0.3);
  assertEq(correlateOffsetMs(noise, many).ms, null);
  // BGM の切り出し位置: 測ったずれだけ後ろ / 手で入れた値
  const grid = { gridOrigin: 2.5, allTs: times.map((t) => t + 0) };
  const b = bgmStartOf(grid, pcm, 'auto');
  assert(b.measured);
  assertNear(b.bgmStart, 2.5 + r.ms / 1000, 1e-9);
  assertNear(bgmStartOf(grid, null, -20).bgmStart, 2.48, 1e-9);
});
