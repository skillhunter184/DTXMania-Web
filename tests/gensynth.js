// 動画・音声から譜面を作るテスト(tests/gen.test.js・tests/genaudio.test.js)の合成のプレー動画。DTXMania の GITADORA 風スキンの
// 配置(js/gen/layout.js)で、チップと小節線・拍線が落ちてくるコマを作る(第三者の動画は使わない)。テストは無い(読むだけのモジュール)。
import { assertDeepEq } from './runner.js';

export const BEAT = 0.4; // 150 BPM
export const T0 = 1.0; // 小節 0 の頭が判定ラインを通る動画の時刻
export const BARS = [4, 4, 4, 3, 4, 4, 4]; // 小節ごとの拍の数(小節 3 は 3/4)
export const BAR_START = BARS.reduce((a, b) => (a.push(a[a.length - 1] + b), a), [0]);

/** 合成の譜面: [小節, tick, レーン]。16 分・8 分・3 連・32 分・小節長の変化を含む。 */
export function demoChips() {
  const out = [];
  for (const t of [0, 96, 192, 288]) out.push([1, t, t % 192 ? 'SD' : 'BD']);
  for (let t = 0; t < 384; t += 48) out.push([1, t, 'HH']);
  for (let t = 0; t < 384; t += 24) out.push([2, t, 'HH']);
  out.push([2, 0, 'BD'], [2, 72, 'BD'], [2, 96, 'SD'], [2, 256, 'HT'], [2, 320, 'LT'], [2, 352, 'FT']);
  out.push([3, 0, 'CY'], [3, 0, 'BD'], [3, 128, 'SD'], [3, 192, 'HH'], [3, 256, 'BD']);
  for (let t = 288; t < 384; t += 12) out.push([4, t, 'SD']);
  out.push([4, 0, 'LC'], [4, 96, 'FT'], [4, 144, 'FT'], [4, 192, 'RD'], [4, 240, 'RD']);
  for (const t of [0, 96, 192, 288]) out.push([5, t, 'LP']);
  out.push([5, 0, 'BD'], [5, 0, 'CY'], [5, 128, 'HH'], [5, 136, 'SD']); // 136 は 12/16 の格子の外(6 tick 遅い)
  return out;
}

export function chipTime(m, tick) {
  return T0 + (BAR_START[m] + (tick / 384) * BARS[m]) * BEAT;
}

/**
 * フィールドの範囲のコマを合成する scan(analyzeVideo に渡す)。
 * @param {{cfg: object, fps: number, speed: number, duration: number, keep?: (i: number) => boolean, lag?: number[][]}} o
 *   keep: 読むコマ(間引き)、lag: [始め, 長さ] の間は 1 コマ前の絵を出す(録画のコマ落ち)
 */
export function synthScan(o) {
  const { cfg, fps, speed } = o;
  const chips = demoChips().map(([m, tick, lane]) => ({ t: chipTime(m, tick), lane: cfg.lanes.find((l) => l.name === lane) }))
    .filter((c) => c.lane); // 配置に無いレーン(GITADORA の RD)は描かない
  const lines = [];
  for (let b = 0; b <= BAR_START[BAR_START.length - 1]; b++) lines.push({ t: T0 + b * BEAT, bright: BAR_START.includes(b) });
  const w = cfg.fieldX1 - cfg.fieldX0;
  const h = cfg.scanY1 - cfg.scanY0;
  const chipH = Math.max(4, Math.round(8 * cfg.scale));
  return async (roi, onFrame) => {
    assertDeepEq(roi, { x: cfg.fieldX0, y: cfg.scanY0, w, h });
    const data = new Uint8ClampedArray(w * h * 4);
    const u32 = new Uint32Array(data.buffer);
    const bg = new Uint32Array(new Uint8Array([10, 10, 20, 255]).buffer)[0];
    const put = (x0, x1, yc, thick, rgb) => {
      const top = Math.round(yc - cfg.scanY0) - (thick >> 1);
      const px = new Uint32Array(new Uint8Array([rgb[0], rgb[1], rgb[2], 255]).buffer)[0];
      for (let y = Math.max(0, top); y < Math.min(h, top + thick); y++) u32.fill(px, y * w + x0, y * w + x1);
    };
    const n = Math.floor(o.duration * fps);
    for (let i = 0; i < n; i++) {
      if (o.keep && !o.keep(i)) continue;
      let c = i;
      for (const [a, len] of o.lag || []) if (i >= a && i < a + len) c = i - 1;
      const tc = c / fps;
      u32.fill(bg);
      for (const ch of chips) {
        const y = cfg.judgeY - speed * (ch.t - tc);
        if (y < cfg.scanY0 - 20 || y > cfg.scanY1 + 20) continue;
        put(ch.lane.x0 - cfg.fieldX0, ch.lane.x1 - cfg.fieldX0, y, chipH, ch.lane.white ? [240, 240, 250] : [255, 70, 40]);
      }
      for (const ln of lines) {
        const y = cfg.judgeY - speed * (ln.t - tc);
        if (y < cfg.scanY0 - 5 || y > cfg.scanY1 + 5) continue;
        put(0, w, y, 2, ln.bright ? [190, 190, 190] : [110, 110, 110]);
      }
      onFrame(data, i / fps);
    }
  };
}

