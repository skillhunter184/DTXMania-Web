// プレー動画から譜面を作る(vid2dtx/cli.py の流れ: detect → track → emit。docs/spec/vid2dtx-gen.md)。
// コマを読む所(js/gen/frames.js)は差し替えられる(テストは絵を合成したコマを流す)。

import { rint, median } from './num.js';
import { layoutFor } from './layout.js';
import { FrameDetector } from './detect.js';
import { trackEvents } from './track.js';
import { placeVideoChips, OFFGRID_MS } from './emit.js';
import { estimateFramePeriod } from './frames.js';
import { correlateOffsetMs, AVSYNC } from './avsync.js';

/** 動画のレーン → 譜面の種類(js/gen/kit.js の KIT)。HH は(変更)閉のハイハット(vid2dtx は開の 18)。 */
export const VIDEO_KIND = {
  LC: 'LC', HH: 'HHC', LP: 'LP', SD: 'SD', HT: 'HT', BD: 'BD', LT: 'LT', FT: 'FT', CY: 'CY', RD: 'RD',
};

/**
 * 動画のコマを読んで、チップの置き場所まで決める。
 * @param {{width: number, height: number, layout?: string, measureOffset?: number|null,
 *   scan: (roi: {x:number, y:number, w:number, h:number}, onFrame: (data: Uint8ClampedArray, t: number) => void) => Promise<any>,
 *   log?: (s: string) => void}} o
 * @returns {Promise<{cfg: object, events: object, grid: object, fps: number, step: number, frames: number}>}
 */
export async function analyzeVideo(o) {
  const log = o.log || (() => {});
  const cfg = layoutFor(o.layout || 'auto', o.width, o.height);
  log(`layout profile: ${cfg.name} (${o.width}x${o.height})`);
  const det = new FrameDetector(cfg);
  const times = [];
  const roi = { x: cfg.fieldX0, y: cfg.scanY0, w: cfg.fieldX1 - cfg.fieldX0, h: cfg.scanY1 - cfg.scanY0 };
  await o.scan(roi, (data, t) => {
    det.detect(data, times.length);
    times.push(t);
  });
  const fp = estimateFramePeriod(times);
  if (!fp) throw new Error('too few frames were read from the video');
  const fps = 1 / fp.period;
  // 読んだ順の番号 → コマの番号
  const idx = times.map((t) => rint((t - fp.phase) / fp.period));
  const gaps = idx.slice(1).map((x, i) => x - idx[i]);
  const step = Math.max(1, rint(median(gaps)));
  const nFrames = idx.length ? idx[idx.length - 1] + 1 : 0;
  det.chips.f = det.chips.f.map((i) => idx[i]);
  det.lines.f = det.lines.f.map((i) => idx[i]);
  log(`frames: ${times.length} read, ${fps.toFixed(3)} fps${step > 1 ? `, every ${step} frames` : ''}`);
  const events = trackEvents(det, cfg, fps, nFrames, { step, log });
  // コマの番号 0 の時刻(位相)を足して動画の時刻にする
  for (const evs of Object.values(events.lanes)) for (const e of evs) e.t += fp.phase;
  for (const e of events.lines) e.t += fp.phase;
  // (追加) 間引いて読んだときは 1 つのチップのコマが少なく時刻の揺れが大きいので、格子の外に残す下限を読んだ間隔に比例して広げる
  // (画面の 60 Hz に縛られて 2〜3 コマおきに読んだ絵空事で、格子の 2〜4 tick 外に 3 個出た)
  const grid = placeVideoChips(events, { measureOffset: o.measureOffset, offGridMs: OFFGRID_MS * step, log });
  return { cfg, events, grid, fps, step, frames: times.length };
}

/**
 * 譜面の小節 0 にする動画の時刻(BGM を切り出す所)と、音と絵のずれ。offsetMs が 'auto' なら測る(emit.main)。
 * 切り出す位置を遅らせると、譜面の時刻では曲の拍が早く来る = 曲に対してチップが遅れる。
 * @param {{gridOrigin: number, allTs: number[]}} grid
 * @param {Float32Array|null} pcm22k AVSYNC.sr の 1 本の音(測るとき)
 * @param {number|'auto'} offsetMs 正ならチップを遅く
 * @returns {{bgmStart: number, offsetMs: number, measured: boolean, confidence: number}}
 */
export function bgmStartOf(grid, pcm22k, offsetMs, log = () => {}) {
  let off = 0;
  let measured = false;
  let confidence = 0;
  if (offsetMs === 'auto') {
    if (pcm22k) {
      const r = correlateOffsetMs(pcm22k, grid.allTs, { sr: AVSYNC.sr });
      confidence = r.confidence;
      if (r.ms === null) {
        log(`A/V offset: no clear onset correlation (confidence ${r.confidence.toFixed(2)}); no compensation applied`);
      } else {
        off = r.ms;
        measured = true;
        log(`A/V offset measured: audio lags video by ${off >= 0 ? '+' : ''}${off.toFixed(0)}ms (confidence ${r.confidence.toFixed(2)}); compensating`);
      }
    }
  } else {
    off = Number(offsetMs) || 0;
  }
  if (off) log(`timing offset: notes ${off >= 0 ? '+' : ''}${off.toFixed(0)}ms vs BGM`);
  return { bgmStart: grid.gridOrigin + off / 1000, offsetMs: off, measured, confidence };
}

/** 置いたチップ(レーンごと)を譜面の種類の並びにする。 */
export function videoChips(placed) {
  const out = [];
  for (const [lane, list] of Object.entries(placed)) {
    for (const p of list) out.push({ m: p.m, tick: p.tick, kind: VIDEO_KIND[lane] });
  }
  return out;
}
