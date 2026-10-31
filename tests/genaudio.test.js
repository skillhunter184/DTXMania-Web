// 動画・音声から譜面を作る(js/gen/)の、音から作る所と曲フォルダの書き出しのテスト。曲もプレー動画も合成する
// (第三者の音・動画は使わない)。動画を読む所は tests/gen.test.js。
import { test, assert, assertEq, assertNear } from './runner.js';
import { layoutFor } from '../js/gen/layout.js';
import { encodeWav } from '../js/gen/kit.js';
import { parseDTX } from '../js/core/dtx.js';
import { decodeWav } from '../js/core/wav.js';
import { decodeText } from '../js/core/encoding.js';
import { buildKitSounds } from '../js/core/synth.js';
import { SongPackage } from '../js/core/song.js';
import { loadSidecar } from '../js/edit/sidecar.js';
import { beatCandidates, combFit, measurePhase, audioToChart, audioBpmText, splitTomLanes } from '../js/gen/audio2dtx.js';
import { stftMag } from '../js/gen/adt.js';
import { modelInput, runModel, inputGain, modelPeaks, MODEL_CLASSES } from '../js/gen/adtmodel.js';
import { generateFromAudio, generateFromVideo, buildZip, kindOfFile, folderName } from '../js/gen/generate.js';
import { overallProgress } from '../js/gen/dialog.js';
import { synthScan, demoChips, chipTime } from './gensynth.js';

test('gen: file kinds, folder names, progress', () => {
  assertEq(kindOfFile({ name: 'a.MP4', type: '' }), 'video');
  assertEq(kindOfFile({ name: 'a.bin', type: 'audio/ogg' }), 'audio');
  assertEq(kindOfFile({ name: 'a.flac', type: '' }), 'audio');
  assertEq(kindOfFile({ name: 'a.zip', type: 'application/zip' }), null);
  assertEq(folderName('a/b:c*?'), 'a_b_c__');
  assertEq(folderName('  '), 'generated');
  assertEq(folderName('曲名. '), '曲名');
  assertEq(overallProgress('video', 'frames', 0), 0.01);
  assertNear(overallProgress('video', 'frames', 1), 0.9, 1e-12);
  assertNear(overallProgress('audio', 'nmf', 0.5), 0.71, 1e-12);
  assertEq(overallProgress('audio', 'frames', 0.5), null);
});

/** 合成の曲: 150 BPM・4/4 の 8 ビート(キック 1・3 拍と 2 拍の裏、スネア 2・4 拍、閉じたハイハットの 8 分、4 小節ごとのクラッシュ)と、低いベースと和音。 */
function synthSong({ bars = 24, lead = 1.3, bpm = 150, sr = 44100 } = {}) {
  const kit = buildKitSounds();
  const beat = 60 / bpm;
  const n = Math.ceil((lead + bars * 4 * beat + 2) * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const hits = [];
  const put = (kind, t, gain, pan = 0) => {
    const d = kit[kind];
    const a = Math.round(t * sr);
    for (let i = 0; i < d.length && a + i < n; i++) {
      L[a + i] += d[i] * gain * (1 - Math.max(0, pan));
      R[a + i] += d[i] * gain * (1 + Math.min(0, pan));
    }
    hits.push({ kind, t });
  };
  for (let b = 0; b < bars; b++) {
    const t0 = lead + b * 4 * beat;
    put('BD', t0, 1);
    put('BD', t0 + 1.5 * beat, 0.8);
    put('BD', t0 + 2 * beat, 1);
    put('SD', t0 + beat, 1);
    put('SD', t0 + 3 * beat, 1);
    for (let e = 0; e < 8; e++) if (!(b % 4 === 0 && e === 0)) put('HHC', t0 + (e * beat) / 2, 0.7);
    if (b % 4 === 0) put('CY', t0, 0.8, 0.5);
  }
  // 伴奏: ベース(小節ごとに音を替える)と鋸波の和音
  const roots = [55, 65.4, 73.4, 49];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const b = Math.max(0, Math.floor((t - lead) / (4 * beat)));
    const f = roots[b % 4];
    const s = 0.12 * Math.sin(2 * Math.PI * f * t) + 0.03 * (((t * f * 4) % 1) * 2 - 1) + 0.02 * (((t * f * 5) % 1) * 2 - 1);
    L[i] += s;
    R[i] += s;
  }
  return { L, R, sr, hits, beat, lead };
}

function songWav(song) {
  return new File([encodeWav([song.L, song.R], song.sr)], 'song.wav', { type: 'audio/wav' });
}

test('gen audio: tempo candidates, comb fit and measure phase (snare backbeat) on onset lists', () => {
  const beat = 0.4;
  const det = [];
  for (let b = 0; b < 32; b++) {
    const t0 = 0.73 + b * 4 * beat;
    det.push({ t: t0, cls: 'KD' }, { t: t0 + 2 * beat, cls: 'KD' }, { t: t0 + beat + 0.003, cls: 'SD' }, { t: t0 + 3 * beat - 0.002, cls: 'SD' });
    for (let e = 0; e < 8; e++) det.push({ t: t0 + (e * beat) / 2 + (e % 3) * 0.002, cls: 'HH' });
    if (b % 4 === 0) det.push({ t: t0, cls: 'CY' });
  }
  det.sort((a, b) => a.t - b.t);
  const cands = beatCandidates(det);
  assert(cands.some((c) => Math.abs(c.beat - beat) < 0.02), 'the beat is a candidate');
  const fit = combFit(det.filter((d) => d.cls === 'KD' || d.cls === 'SD').map((d) => d.t), beat);
  assertNear(4 * fit.T16, beat, 0.001);
  const mp = measurePhase(det, fit.ph, fit.T16);
  const head = fit.ph + mp.phase * fit.T16;
  const rel = ((((head - 0.73) / (4 * beat)) % 1) + 1) % 1;
  assert(rel < 0.01 || rel > 0.99, `measure head ${head} (${mp.why})`);
  assertEq(audioBpmText(150.012), 150);
  assertEq(audioBpmText(177.33), 177.33);
});

/**
 * tools/adt/export.py の check_signal と同じ決まった音(0.25 秒ごとにキック風・スネア風・ハイハット風。雑音は 32 bit の
 * 線形合同法)。tests/fixtures/adt_check.json はこの音での tools/adt/common.py のモデルの値。
 */
function checkSignal(seconds = 3) {
  const sr = 44100;
  const n = Math.floor(seconds * sr);
  const noise = new Float64Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    noise[i] = (s / 4294967296) * 2 - 1;
  }
  const x = new Float64Array(n);
  for (let k = 0; k < Math.floor((seconds - 0.2) / 0.25); k++) {
    const i0 = Math.round((0.1 + 0.25 * k) * sr);
    for (let i = i0; i < n; i++) {
      const u = (i - i0) / sr;
      if (k % 3 === 0) x[i] += 0.8 * Math.sin(2 * Math.PI * 60 * u) * Math.exp(-u / 0.08);
      else if (k % 3 === 1) x[i] += (0.5 * noise[i] + 0.4 * Math.sin(2 * Math.PI * 200 * u)) * Math.exp(-u / 0.06);
      else x[i] += 0.3 * (noise[i] - noise[i - 1]) * Math.exp(-u / 0.02);
    }
  }
  return Float32Array.from(x);
}

test('gen audio: the onset model gives the same values as tools/adt (PyTorch) on a fixed sound', async () => {
  const ref = await (await fetch('fixtures/adt_check.json')).json();
  const x = checkSignal();
  const { mag, T, F } = stftMag(x);
  assertEq(T, ref.T);
  const prob = await runModel(modelInput(mag, T, F, inputGain(x)), T, { chunk: 100 });
  let md = 0;
  for (let i = 0; i < prob.length; i++) {
    assert(prob[i] >= 0 && prob[i] <= 1, 'probability ' + prob[i]);
    md = Math.max(md, Math.abs(prob[i] - ref.prob[i]));
  }
  assert(md < 2e-3, 'max difference ' + md);
  assertEq(MODEL_CLASSES.join(','), 'KD,SD,TT,HH,CY');
  // 峰は放物線で補った時刻(窓の真ん中で数える)
  const k = MODEL_CLASSES.indexOf('KD');
  for (const p of modelPeaks(prob, T, k, 0.5)) assert(p.t > 0 && p.t < 3 && p.p >= 0.5);
});

test('gen audio: toms are split into HT / LT / FT by the pitch modes of the song', () => {
  // 3 つの山(90・118・150 Hz)は低い順に FT・LT・HT。音高の測れないものは入らない
  const toms = [];
  const pitch = new Map();
  [90, 118, 150].forEach((f, j) => {
    for (let i = 0; i < 10; i++) {
      const c = { t: toms.length };
      toms.push(c);
      pitch.set(c.t, f * 2 ** (((i % 3) - 1) * 0.02));
    }
  });
  toms.push({ t: 99 });
  const lanes = splitTomLanes(toms, (t) => (pitch.has(t) ? pitch.get(t) : null));
  assertEq(lanes.size, 30);
  assertEq([0, 10, 20].map((i) => lanes.get(toms[i])).join(','), 'FT,LT,HT');
  // 2 つのタムのキット(100・140 Hz)は 3 つめのレーンを作らず、音域の近い FT と HT
  const two = [];
  for (let i = 0; i < 12; i++) two.push({ t: i, f: i % 2 ? 140 : 100 });
  const l2 = splitTomLanes(two, (t) => two[t].f);
  assertEq([l2.get(two[0]), l2.get(two[1])].join(','), 'FT,HT');
});

test('gen audio: a synthetic 8-beat song gives the BPM, the measure grid and most kicks / snares / hats', async () => {
  const song = synthSong();
  const r = await audioToChart(song.L, song.R, { keepStart: true });
  assertNear(r.bpm, 150, 0.05);
  // 元の音をそのまま BGM にする: 曲の頭は小節 0 か 1 の中(最初のチップが小節 1 以降に来るように小節を足すので)
  assert(r.gridOrigin <= 0 && r.gridOrigin > -2 * r.tMeas, '曲の頭 ' + r.gridOrigin);
  const tOf = (c) => r.gridOrigin + (c.m + c.tick / 384) * r.tMeas;
  const near = (kinds, t) => r.chips.some((c) => kinds.includes(c.kind) && Math.abs(tOf(c) - t) < 0.03);
  const rate = (kind, kinds) => {
    const hs = song.hits.filter((h) => h.kind === kind);
    return hs.filter((h) => near(kinds, h.t)).length / hs.length;
  };
  assert(rate('BD', ['BD', 'LBD']) >= 0.9, 'kick ' + rate('BD', ['BD', 'LBD']));
  assert(rate('SD', ['SD']) >= 0.9, 'snare ' + rate('SD', ['SD']));
  assert(rate('HHC', ['HHC', 'HHO', 'LP']) >= 0.7, 'hat ' + rate('HHC', ['HHC', 'HHO', 'LP']));
  // 小節の頭(キック + クラッシュ)が tick 0 に来る
  const heads = r.chips.filter((c) => (c.kind === 'BD' || c.kind === 'LBD') && c.tick === 0).length;
  assert(heads >= 20, 'kicks on the measure head ' + heads);
  const extra = r.chips.filter((c) => !song.hits.some((h) => Math.abs(h.t - tOf(c)) < 0.03)).length;
  assert(extra <= r.chips.length * 0.1, 'extras ' + extra + ' / ' + r.chips.length);
});

test('gen audio: the old signal processing (detector dsp) still makes the chart of the synthetic song', async () => {
  const song = synthSong({ bars: 12 });
  const r = await audioToChart(song.L, song.R, { detector: 'dsp' });
  assertNear(r.bpm, 150, 0.05);
  const tOf = (c) => r.gridOrigin + (c.m + c.tick / 384) * r.tMeas;
  const kicks = song.hits.filter((h) => h.kind === 'BD');
  const found = kicks.filter((h) => r.chips.some((c) => (c.kind === 'BD' || c.kind === 'LBD') && Math.abs(tOf(c) - h.t) < 0.03));
  assert(found.length >= 0.9 * kicks.length, 'kick ' + found.length + ' / ' + kicks.length);
});

test('gen audio: the song folder — wav kept as the BGM at the song start, confidence file read by the editor', async () => {
  const song = synthSong({ bars: 12 });
  const r = await generateFromAudio(songWav(song), { title: '合成の曲' });
  assertEq(r.folder, '合成の曲');
  assertEq(r.chartPath, '合成の曲/generated.dtx');
  const names = r.files.map((f) => f.path);
  assert(names.includes('合成の曲/song.wav'), 'wav はそのまま');
  assert(names.includes('合成の曲/generated.dtx.conf.json'));
  assert(names.includes('合成の曲/kit_BD.wav'));
  const pkg = await SongPackage.fromZip(buildZip(r.files), 'gen.zip');
  assertEq(pkg.songs.length, 1);
  assertEq(pkg.songs[0].title, '合成の曲');
  const chart = await pkg.loadChart(r.chartPath);
  assertEq(chart.wavDefs.get('0B'), 'song.wav');
  // 譜面の時刻で、最初のキック − BGM の頭 = 合成の曲の最初のキックの時刻
  const bgmMs = chart.bgmEvents[0].timeMs;
  const firstKick = chart.notes.find((n) => n.channel === 0x13 || n.channel === 0x1c);
  assertNear((firstKick.timeMs - bgmMs) / 1000, song.lead, 0.012);
  const side = await loadSidecar(pkg, r.chartPath);
  assert(side && side.size > 10, 'sidecar');
  assert(Number.isFinite(side.values().next().value.conf));
});

test('gen video: the song folder — BGM cut at measure 0 with the measured A/V offset, chart and kit', async () => {
  const cfg = layoutFor('dtxmania-720', 1280, 720);
  // 動画の音: チップの時刻から 30 ms 遅れて鳴る(録画の音のずれ)
  const sr = 44100;
  const n = Math.ceil(12.5 * sr);
  const L = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const [m, tick] of demoChips()) {
    const a = Math.round((chipTime(m, tick) + 0.03) * sr);
    for (let k = 0; k < 3000 && a + k < n; k++) L[a + k] += rnd() * Math.exp(-k / 600) * 0.5;
  }
  const r = await generateFromVideo(new File([new Uint8Array(8)], 'プレー動画.mp4', { type: 'video/mp4' }), {}, {
    open: async () => ({ width: 1280, height: 720, duration: 12.5 }),
    scan: synthScan({ cfg, fps: 60, speed: 700, duration: 12.5 }),
    decode: async () => ({ left: L, right: L, sampleRate: sr }),
  });
  assertEq(r.title, 'プレー動画');
  assertNear(r.summary.offsetMs, 30, 4);
  const bgm = decodeWav(r.files.find((f) => f.path.endsWith('/bgm.wav')).bytes);
  // 小節 0 の頭(1.0 s)+ 30 ms から切り出す
  assertNear(bgm.length / sr, 12.5 - 1.03, 0.006);
  const chart = parseDTX(decodeText(r.files[0].bytes));
  assertEq(chart.notes.length, demoChips().length);
  assertEq(chart.bpm, 150);
  assertEq(chart.wavDefs.get('0B'), 'bgm.wav');
});
