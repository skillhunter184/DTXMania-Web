// 動画から譜面を作る 1 段目: コマごとの検出(vid2dtx/detect.py の移植。docs/spec/vid2dtx-gen.md §2)。
// コマごとに、レーンの帯の中で明るいチップの画素が帯の幅の大半を占める行(チップの芯)と、フィールドの全幅にわたる灰色の行
// (小節線・拍線)を探し、続いた行を 1 つにまとめて記録する。色は OpenCV の HSV(8 bit: S・V は 0〜255)で判定する。
// - 有彩色のチップ: S >= coreSMin かつ V >= coreVMin。白銀のチップ(HH): S <= coreWhiteSMax かつ V >= coreWhiteVMin
// - 線: S <= lineSMax かつ lineVMin <= V <= lineVMax
// 色相の中央値(元は記録だけして使っていない)は記録しない。

/**
 * 1 コマの検出器。detect に渡す画素はフィールドの範囲(x: fieldX0〜fieldX1、y: scanY0〜scanY1)を切り出した RGBA。
 * 結果は chips(コマ・レーン・行の中心 y・行の数)と lines(コマ・y・灰色の画素の V の平均)に足していく。
 */
export class FrameDetector {
  /** @param {object} cfg js/gen/layout.js の配置(動画の大きさに合わせたもの) */
  constructor(cfg) {
    this.cfg = cfg;
    this.width = cfg.fieldX1 - cfg.fieldX0;
    this.rows = cfg.scanY1 - cfg.scanY0;
    this.nLanes = cfg.lanes.length;
    // 列 → レーン(-1 は帯の外)。帯は重ならないが、丸めで重なれば前のレーン
    this.laneOf = new Int16Array(this.width).fill(-1);
    this.need = new Float64Array(this.nLanes);
    this.white = new Uint8Array(this.nLanes);
    cfg.lanes.forEach((l, i) => {
      const a = Math.max(0, l.x0 - cfg.fieldX0);
      const b = Math.min(this.width, l.x1 - cfg.fieldX0);
      for (let x = a; x < b; x++) if (this.laneOf[x] < 0) this.laneOf[x] = i;
      this.need[i] = cfg.coreRowFrac * (l.x1 - l.x0);
      this.white[i] = l.white ? 1 : 0;
    });
    this.lineNeed = cfg.lineRowFrac * this.width;
    // S = round(255·d / V) と比べるのを掛け算にする: S >= T ⇔ 510·d >= (2T − 1)·V、S <= T ⇔ 510·d < (2T + 1)·V
    this.kColor = 2 * cfg.coreSMin - 1;
    this.kWhite = 2 * cfg.coreWhiteSMax + 1;
    this.kGray = 2 * cfg.lineSMax + 1;
    this.chips = { f: [], lane: [], y: [], h: [] };
    this.lines = { f: [], y: [], v: [] };
    this.frames = 0;
    this._cnt = new Int32Array(this.nLanes);
    this._runStart = new Int32Array(this.nLanes);
    this._runPrev = new Int32Array(this.nLanes);
    this._grayN = new Float64Array(this.rows);
    this._grayV = new Float64Array(this.rows);
  }

  /**
   * @param {Uint8ClampedArray|Uint8Array} data RGBA(1 行 = width 画素)
   * @param {number} frame コマの番号
   */
  detect(data, frame) {
    const { width, rows, nLanes, laneOf, need, white, cfg } = this;
    const { kColor, kWhite, kGray } = this;
    const cvMin = cfg.coreVMin;
    const wvMin = cfg.coreWhiteVMin;
    const lvMin = cfg.lineVMin;
    const lvMax = cfg.lineVMax;
    const cnt = this._cnt;
    const runStart = this._runStart;
    const runPrev = this._runPrev;
    runStart.fill(-1);
    let lineStart = -1;
    let linePrev = -1;
    const y0 = cfg.scanY0;
    const closeChip = (li) => {
      const r0 = runStart[li];
      const r1 = runPrev[li];
      this.chips.f.push(frame);
      this.chips.lane.push(li);
      this.chips.y.push((r0 + r1) / 2 + y0);
      this.chips.h.push(r1 - r0 + 1);
    };
    const closeLine = () => {
      let n = 0;
      let v = 0;
      for (let r = lineStart; r <= linePrev; r++) {
        n += this._grayN[r];
        v += this._grayV[r];
      }
      this.lines.f.push(frame);
      this.lines.y.push((lineStart + linePrev) / 2 + y0);
      this.lines.v.push(n ? v / n : 0);
    };
    for (let r = 0; r < rows; r++) {
      cnt.fill(0);
      let gn = 0;
      let gv = 0;
      let p = r * width * 4;
      for (let x = 0; x < width; x++, p += 4) {
        const R = data[p];
        const G = data[p + 1];
        const B = data[p + 2];
        const v = R > G ? (R > B ? R : B) : G > B ? G : B;
        const mn = R < G ? (R < B ? R : B) : G < B ? G : B;
        const d = (v - mn) * 510;
        if (v >= lvMin && v <= lvMax && d < kGray * v) {
          gn++;
          gv += v;
        }
        const li = laneOf[x];
        if (li < 0) continue;
        if (white[li]) {
          if (v >= wvMin && d < kWhite * v) cnt[li]++;
        } else if (v >= cvMin && d >= kColor * v) {
          cnt[li]++;
        }
      }
      this._grayN[r] = gn;
      this._grayV[r] = gv;
      // 続いた行(間が 2 行まで)を 1 つにまとめる(detect.group_rows)
      for (let li = 0; li < nLanes; li++) {
        if (cnt[li] < need[li]) continue;
        if (runStart[li] >= 0 && r - runPrev[li] > 2) {
          closeChip(li);
          runStart[li] = -1;
        }
        if (runStart[li] < 0) runStart[li] = r;
        runPrev[li] = r;
      }
      if (gn >= this.lineNeed) {
        if (lineStart >= 0 && r - linePrev > 2) {
          closeLine();
          lineStart = -1;
        }
        if (lineStart < 0) lineStart = r;
        linePrev = r;
      }
    }
    for (let li = 0; li < nLanes; li++) if (runStart[li] >= 0) closeChip(li);
    if (lineStart >= 0) closeLine();
    this.frames = Math.max(this.frames, frame + 1);
  }
}
