// 動画から譜面を作る 2 段目: コマごとの検出を、判定ラインを通る出来事(チップ・線)にまとめる(vid2dtx/track.py の移植。
// docs/spec/vid2dtx-gen.md §3)。
// チップは一定の速さ v で落ちるので、時刻 t・高さ y の検出の r = t + (judgeY − y) / v は判定ラインを通る時刻になる。
// 同じチップの検出は r がそろうので、レーンごとに r の塊を探せばコマより細かい精度でチップが分かる。
// - 同じコマの近い行の組(白い芯で上下 2 本に割れたバー・リングの弧・ペダルの絵)は mergePx の内で 1 つにまとめる
// - 録画のコマ落ち(同じコマを繰り返し、後で 1 コマ飛ばす)は、動くもの全部のコマごとのスクロール量を「本来の 1 歩の何倍か」で
//   数え、その累計(中身の上のコマの番号)で塊を作り直す
// (追加) コマを間引いて読んだとき(速く読む。step = 読んだコマの間)は、速さの見積もりを step コマ離れたコマの組で行い、
// コマ落ちの補正はしない(続いたコマが要るので)。step = 1 なら元のとおり。

import { rint, median, lineFit, argmax } from './num.js';

export const CLUSTER_GAP = 0.028; // s。r の並びにこれより大きい間があれば塊を分ける
export const MIN_FRAMES = 5; // チップはこれだけのコマに映っていること
// コマ落ち(frameSteps): 動くもの STEP_MIN_OBJ 個以上のうち STEP_AGREE が STEP_TOL 歩の内で 0 歩 / 2 歩動いたコマ
export const STEP_MIN_OBJ = 3;
export const STEP_AGREE = 0.8;
export const STEP_TOL = 0.15;

/**
 * 動かない検出を除く(track.drop_static)。曲名のカットインなどの止まった絵は同じ y に何コマも出て、その r の漂いが
 * 本物のチップの塊をつないでしまう。スクロールするチップは 1 コマに 10〜20 px 動くので、前のコマと次のコマの両方の
 * 同じ y(±tol)に検出があるものは止まっている。
 * @returns {number[]} 残す添字
 */
export function dropStatic(f, y, tol = 3) {
  const bins = new Set();
  for (let i = 0; i < f.length; i++) bins.add(f[i] * 100000 + rint(y[i] / tol));
  const has = (fr, b) => bins.has(fr * 100000 + b - 1) || bins.has(fr * 100000 + b) || bins.has(fr * 100000 + b + 1);
  const keep = [];
  for (let i = 0; i < f.length; i++) {
    const b = rint(y[i] / tol);
    if (!(has(f[i] - 1, b) && has(f[i] + 1, b))) keep.push(i);
  }
  return keep;
}

/** コマごとに、mergePx より近い行の組を 1 つの塊にする(重み付きの平均の y)。結果はコマ・y の順。 */
export function mergeBlobs(f, y, w, mergePx) {
  const order = [...f.keys()].sort((a, b) => f[a] - f[b] || y[a] - y[b] || a - b);
  const outF = [];
  const outY = [];
  let i = 0;
  while (i < order.length) {
    let j = i + 1;
    while (j < order.length && f[order[j]] === f[order[i]] && y[order[j]] - y[order[j - 1]] <= mergePx) j++;
    let sw = 0;
    let sy = 0;
    for (let k = i; k < j; k++) {
      sw += w[order[k]];
      sy += w[order[k]] * y[order[k]];
    }
    outF.push(f[order[i]]);
    outY.push(sy / sw);
    i = j;
  }
  return { f: outF, y: outY };
}

function byFrame(f, y) {
  const m = new Map();
  for (let i = 0; i < f.length; i++) {
    let a = m.get(f[i]);
    if (!a) m.set(f[i], (a = []));
    a.push(y[i]);
  }
  return m;
}

/**
 * 下向きの速さ(px/s)を、コマの間の動きの最頻値で見積もる(track.estimate_speed)。割れた線の片割れに近い方を選ぶと
 * 半分の速さになるので、近い組を全部ヒストグラムに入れて山を取る。足りなければ null。
 * @param {number} [step] 読んだコマの間(追加。1 なら元のとおり隣のコマと比べる)
 */
export function estimateSpeed(f, y, fps, step = 1) {
  if (!f.length) return null;
  const mb = mergeBlobs(f, y, f.map(() => 1), 8);
  const frames = byFrame(mb.f, mb.y);
  const diffs = [];
  for (const [fi, ys] of frames) {
    const nxt = frames.get(fi + step);
    if (!nxt) continue;
    for (const yy of ys) {
      for (const yn of nxt) {
        const d = (yn - yy) / step;
        if (d > 1 && d < 90) diffs.push(d);
      }
    }
  }
  if (diffs.length < 30) return null;
  // np.histogram(bins=arange(1.0, 90.5, 0.5)): 1.0〜90.0 の 0.5 刻み(最後の箱は右端を含む)
  const nb = 178;
  const hist = new Array(nb).fill(0);
  for (const d of diffs) {
    let b = Math.floor((d - 1) / 0.5);
    if (b === nb && d <= 90) b = nb - 1;
    if (b >= 0 && b < nb) hist[b]++;
  }
  const peak = argmax(hist);
  const c = 1 + peak * 0.5 + 0.25;
  return median(diffs.filter((d) => Math.abs(d - c) <= 1.5)) * fps;
}

/**
 * r の塊を判定ラインを通る出来事にする(track.cluster_events)。y を t の直線で当てはめ、傾きが v の ±20 % で、
 * 外れの rms が rmsMax 以下の塊だけを残す(rmsMax は 1 コマの歩みに比例: 録画の刻みの揺れ・画面の切り替わりのがたつき)。
 * @returns {{t: number, n: number, rms: number, slope: number, yFirst: number}[]}
 */
export function clusterEvents(f, y, v, judgeY, fps, gap = CLUSTER_GAP, minFrames = MIN_FRAMES) {
  const n = f.length;
  const ts = f.map((x) => x / fps);
  const r = ts.map((t, i) => t + (judgeY - y[i]) / v);
  const rmsMax = Math.max(6, (0.3 * v) / fps);
  const order = [...r.keys()].sort((a, b) => r[a] - r[b]);
  const events = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && r[order[i]] - r[order[i - 1]] <= gap) continue;
    const idx = order.slice(start, i);
    start = i;
    const uf = new Set(idx.map((k) => f[k]));
    if (uf.size < minFrames) continue;
    const ti = idx.map((k) => ts[k]);
    const yi = idx.map((k) => y[k]);
    let tmin = Infinity;
    let tmax = -Infinity;
    for (const t of ti) {
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    if (!(tmax - tmin > 0)) continue;
    const fit = lineFit(ti, yi);
    if (!fit) continue;
    const slope = fit.a;
    if (!(slope >= 0.8 * v && slope <= 1.2 * v)) continue;
    let sq = 0;
    for (let k = 0; k < ti.length; k++) {
      const e = slope * ti[k] + fit.b - yi[k];
      sq += e * e;
    }
    const rms = Math.sqrt(sq / ti.length);
    if (rms > rmsMax) continue;
    events.push({ t: (judgeY - fit.b) / slope, n: uf.size, rms, slope, yFirst: Math.min(...yi) });
  }
  return events;
}

/** よく映った塊(minN コマ以上)の傾きの中央値 = 本当のスクロールの速さ(track.refine_speed)。 */
export function refineSpeed(blobbed, v0, judgeY, fps, minN = 12) {
  const slopes = [];
  for (const b of blobbed) {
    for (const ev of clusterEvents(b.f, b.y, v0, judgeY, fps)) if (ev.n >= minN) slopes.push(ev.slope);
  }
  return slopes.length ? median(slopes) : v0;
}

/**
 * コマごとのスクロール量を、本来の 1 歩(v / fps)の何倍かで数える(track.frame_steps)。
 * 動くもの(groups の塊。レーンのチップ・線)の前のコマからの動きは、そのコマの同じ組の塊との差のうち 0 以上で一番小さいもの。
 * 動くものが 0 歩(繰り返し)/ 2 歩(飛ばし)でそろい、前後の一番近い見えたコマもきれいに動いているときだけ 0 / 2 にし、
 * ほかは 1(30 fps の録画の 0.5 / 1.5 歩の刻みや、演奏の始まりのがたつきはそのまま)。
 * @returns {Int32Array}
 */
export function frameSteps(groups, nFrames, v, fps) {
  const step = v / fps;
  const perFrame = Array.from({ length: nFrames }, () => []);
  for (const g of groups) {
    const frames = byFrame(g.f, g.y);
    for (const [fi, ys] of frames) {
      const prev = frames.get(fi - 1);
      if (!prev || fi >= nFrames) continue;
      for (const yy of ys) {
        let best = Infinity;
        for (const p of prev) {
          const d = yy - p;
          if (d >= -3 && d <= 3.6 * step && d < best) best = d;
        }
        if (best !== Infinity) perFrame[fi].push(best);
      }
    }
  }
  const whole = new Int32Array(nFrames).fill(-1);
  const agree = new Uint8Array(nFrames);
  const seen = new Uint8Array(nFrames);
  for (let fi = 0; fi < nFrames; fi++) {
    const ds = perFrame[fi];
    if (ds.length < STEP_MIN_OBJ) continue;
    seen[fi] = 1;
    const u = ds.map((d) => d / step);
    const med = median(u);
    const rr = rint(med);
    if ((rr === 0 || rr === 1 || rr === 2) && Math.abs(med - rr) < STEP_TOL) {
      whole[fi] = rr;
      agree[fi] = u.filter((x) => Math.abs(x - rr) < STEP_TOL).length / u.length >= STEP_AGREE ? 1 : 0;
    }
  }
  const steadySide = (fi, dir) => {
    for (let j = fi + dir; j !== fi + 4 * dir; j += dir) {
      if (j >= 0 && j < nFrames && seen[j]) return whole[j] >= 0;
    }
    return true;
  };
  const k = new Int32Array(nFrames).fill(1);
  for (let fi = 0; fi < nFrames; fi++) {
    if ((whole[fi] === 0 || whole[fi] === 2) && agree[fi] && steadySide(fi, -1) && steadySide(fi, 1)) k[fi] = whole[fi];
  }
  if (nFrames) k[0] = 0;
  return k;
}

/**
 * コマの番号 → 中身の上のコマの番号(スクロールの歩みの累計。track.effective_frames)。
 * 0 歩が 3 コマ以上続くのは止まった画面(演奏の前・一時停止)で、コマ落ちではないので 1 歩と数える。
 * @returns {Float64Array}
 */
export function effectiveFrames(k0) {
  const k = Int32Array.from(k0);
  let i = 0;
  while (i < k.length) {
    let j = i;
    while (j < k.length && k[j] === 0) j++;
    if (j - i >= 3) for (let x = i; x < j; x++) k[x] = 1;
    i = Math.max(j, i + 1);
  }
  if (k.length) k[0] = 0;
  const out = new Float64Array(k.length);
  let s = 0;
  for (let x = 0; x < k.length; x++) {
    s += k[x];
    out[x] = s;
  }
  return out;
}

function pick(arr, idx) {
  return idx.map((i) => arr[i]);
}

/**
 * 検出(js/gen/detect.js の FrameDetector の chips / lines)を出来事にする(track.main)。
 * @param {{chips: {f:number[], lane:number[], y:number[], h:number[]}, lines: {f:number[], y:number[], v:number[]}}} det
 * @param {object} cfg 配置
 * @param {number} fps
 * @param {number} nFrames 読んだコマの番号の上限 + 1
 * @param {{step?: number, log?: (s: string) => void}} [opts]
 * @returns {{fps: number, speed: number, judgeY: number, lanes: Object<string, object[]>, lines: object[], stutter: number}}
 */
export function trackEvents(det, cfg, fps, nFrames, opts = {}) {
  const step = opts.step || 1;
  const log = opts.log || (() => {});
  const nLanes = cfg.lanes.length;
  if (!det.chips.f.length) throw new Error('no chip detections; check the video and the layout');
  // 止まった検出を除く(レーンごと)
  const chips = Array.from({ length: nLanes }, () => ({ f: [], y: [], h: [] }));
  for (let i = 0; i < det.chips.f.length; i++) {
    const c = chips[det.chips.lane[i]];
    c.f.push(det.chips.f[i]);
    c.y.push(det.chips.y[i]);
    c.h.push(det.chips.h[i]);
  }
  let n0 = 0;
  let n1 = 0;
  for (const c of chips) {
    n0 += c.f.length;
    const keep = dropStatic(c.f, c.y);
    c.f = pick(c.f, keep);
    c.y = pick(c.y, keep);
    c.h = pick(c.h, keep);
    n1 += c.f.length;
  }
  const lkeep = dropStatic(det.lines.f, det.lines.y);
  const lines = { f: pick(det.lines.f, lkeep), y: pick(det.lines.y, lkeep), v: pick(det.lines.v, lkeep) };
  log(`static filter: chips ${n0}->${n1}, lines ${det.lines.f.length}->${lines.f.length}`);

  let v = estimateSpeed(lines.f, lines.y, fps, step);
  if (v === null) {
    // 線が使えなければチップから
    const all = { f: [], y: [] };
    for (const c of chips) {
      all.f.push(...c.f);
      all.y.push(...c.y);
    }
    v = estimateSpeed(all.f, all.y, fps, step);
  }
  if (v === null) throw new Error('cannot estimate the scroll speed (too few detections)');
  log(`scroll speed initial: ${v.toFixed(2)} px/s`);
  const minN = Math.max(MIN_FRAMES, Math.ceil(12 / step));
  let blobbed = chips.map((c) => (c.f.length ? mergeBlobs(c.f, c.y, c.h, cfg.mergePx) : null)).filter(Boolean);
  for (let i = 0; i < 2; i++) v = refineSpeed(blobbed, v, cfg.judgeY, fps, minN);
  log(`scroll speed refined: ${v.toFixed(2)} px/s (${(v / fps).toFixed(3)} px/frame)`);

  // コマ落ち: 塊は中身の上のコマの番号で作る
  const lineBlobs = mergeBlobs(lines.f, lines.y, lines.f.map(() => 1), 6);
  let feff = null;
  let stutter = 0;
  if (step === 1) {
    const e = effectiveFrames(frameSteps([...blobbed, lineBlobs], nFrames, v, fps));
    for (let i = 0; i < e.length; i++) {
      if (e[i] !== i) {
        feff = e;
        break;
      }
    }
    if (feff) {
      for (let i = 1; i < feff.length; i++) if (feff[i] - feff[i - 1] !== 1) stutter++;
      log(`capture stutter: ${stutter} frames repeated/skipped; timing frames by their scroll steps`);
      blobbed = blobbed.map((b) => ({ f: b.f.map((x) => feff[x]), y: b.y }));
      for (let i = 0; i < 2; i++) v = refineSpeed(blobbed, v, cfg.judgeY, fps, minN);
      log(`scroll speed refined: ${v.toFixed(2)} px/s (${(v / fps).toFixed(3)} px/frame)`);
    }
  }
  const content = (fs) => (feff ? fs.map((x) => feff[x]) : fs);

  const result = { fps, speed: v, judgeY: cfg.judgeY, lanes: {}, lines: [], stutter };
  cfg.lanes.forEach((lane, li) => {
    const c = chips[li];
    if (!c.f.length) {
      result.lanes[lane.name] = [];
      return;
    }
    const mb = mergeBlobs(c.f, c.y, c.h, cfg.mergePx);
    result.lanes[lane.name] = clusterEvents(content(mb.f), mb.y, v, cfg.judgeY, fps);
    log(`  ${lane.name}: ${result.lanes[lane.name].length} events`);
  });
  // 小節線・拍線: 明るさ(V の平均)を付ける(元の行を出来事の時刻へ写して平均)
  const lev = clusterEvents(content(lineBlobs.f), lineBlobs.y, v, cfg.judgeY, fps);
  const lf = content(lines.f);
  const rRaw = lf.map((x, i) => x / fps + (cfg.judgeY - lines.y[i]) / v);
  for (const ev of lev) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < rRaw.length; i++) {
      if (Math.abs(rRaw[i] - ev.t) < 0.012) {
        s += lines.v[i];
        n++;
      }
    }
    ev.vMean = n ? s / n : 0;
  }
  result.lines = lev;
  log(`  lines: ${lev.length} events`);
  return result;
}
