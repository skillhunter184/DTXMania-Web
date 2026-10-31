// 動画から譜面を作るときの、プレー動画の画面の配置(vid2dtx/config.py の移植。docs/spec/vid2dtx-gen.md §1)。
// 配置ごとに、レーンの帯の x・チップの行を探す縦の範囲・判定ライン・チップと小節線の色のしきい値を持つ。
// 座標は元の解像度(dtxmania-720 は 1280x720、gitadora-1080 は 1920x1080)のもので、ほかの大きさの動画には scaleLayout で
// 合わせる(本アプリの追加。vid2dtx は元の解像度の動画だけを扱う。縦の比で拡大し、横は真ん中をそろえる)。

/** 配置の一覧(名前 → 元の解像度の配置)。 */
export const LAYOUTS = {
  // DTXManiaNX の GITADORA 風スキン 1280x720(絵空事の 688/688 で確かめた配置)
  'dtxmania-720': {
    name: 'dtxmania-720',
    width: 1280,
    height: 720,
    fieldX0: 295, fieldX1: 855,
    scanY0: 60, scanY1: 480,
    judgeY: 560,
    lanes: [
      { name: 'LC', x0: 297, x1: 363 },
      { name: 'HH', x0: 366, x1: 416, white: true },
      { name: 'LP', x0: 419, x1: 468 },
      { name: 'SD', x0: 469, x1: 527 },
      { name: 'HT', x0: 528, x1: 580 },
      { name: 'BD', x0: 581, x1: 643 },
      { name: 'LT', x0: 644, x1: 698 },
      { name: 'FT', x0: 699, x1: 751 },
      { name: 'CY', x0: 752, x1: 813 },
      { name: 'RD', x0: 815, x1: 855 },
    ],
    coreVMin: 170, coreSMin: 60,
    coreWhiteSMax: 70, coreWhiteVMin: 200,
    coreRowFrac: 0.55,
    lineSMax: 70, lineVMin: 90, lineVMax: 235, lineRowFrac: 0.8,
    linesAre: 'beats',
    mergePx: 14,
  },
  // GITADORA のアーケードの録画 1920x1080(ノーツはドラムの絵だが、真ん中の明るい横の芯で見る)
  'gitadora-1080': {
    name: 'gitadora-1080',
    width: 1920,
    height: 1080,
    fieldX0: 537, fieldX1: 1315,
    scanY0: 40, scanY1: 880,
    judgeY: 943,
    lanes: [
      { name: 'LC', x0: 540, x1: 641 },
      { name: 'HH', x0: 643, x1: 718 },
      { name: 'LP', x0: 720, x1: 797 },
      { name: 'SD', x0: 798, x1: 883 },
      { name: 'HT', x0: 885, x1: 957 },
      { name: 'BD', x0: 958, x1: 1060 },
      { name: 'LT', x0: 1062, x1: 1140 },
      { name: 'FT', x0: 1142, x1: 1216 },
      { name: 'CY', x0: 1218, x1: 1315 },
    ],
    coreVMin: 150, coreSMin: 80,
    coreWhiteSMax: 0, coreWhiteVMin: 255, // 白いチップは無い
    coreRowFrac: 0.5,
    lineSMax: 70, lineVMin: 90, lineVMax: 235, lineRowFrac: 0.7,
    linesAre: 'beats', // 暗い拍線と明るい小節線
    // 大きい BD のチップは 2 本の縞が 17 px 離れる。同じレーンで一番近いチップ(TRIΔXIS MASTER、1215 px/s)は 41 px
    mergePx: 20,
  },
};

/** 解像度から配置を選ぶ(config.autodetect: 高さ 1000 以上なら GITADORA)。 */
export function autoLayoutName(width, height) {
  return height >= 1000 ? 'gitadora-1080' : 'dtxmania-720';
}

/**
 * 配置を動画の大きさに合わせる(座標は整数に丸める。しきい値はそのまま)。元の解像度ならそのままの写し。
 * @param {object} base LAYOUTS の要素
 * @param {number} width 動画の幅
 * @param {number} height 動画の高さ
 */
export function scaleLayout(base, width, height) {
  const s = height / base.height;
  const same = width === base.width && height === base.height;
  const x = (v) => (same ? v : Math.round((v - base.width / 2) * s + width / 2));
  const y = (v) => (same ? v : Math.round(v * s));
  const out = {
    ...base,
    width, height, scale: s,
    fieldX0: Math.max(0, x(base.fieldX0)), fieldX1: Math.min(width, x(base.fieldX1)),
    scanY0: Math.max(0, y(base.scanY0)), scanY1: Math.min(height, y(base.scanY1)),
    judgeY: same ? base.judgeY : base.judgeY * s,
    mergePx: base.mergePx * s,
    lanes: base.lanes.map((l) => ({ ...l, x0: x(l.x0), x1: x(l.x1) })),
  };
  return out;
}

/** 動画の大きさから使う配置(name が 'auto' なら解像度で選ぶ)。 */
export function layoutFor(name, width, height) {
  const key = !name || name === 'auto' ? autoLayoutName(width, height) : name;
  const base = LAYOUTS[key];
  if (!base) throw new Error('unknown layout: ' + name);
  return scaleLayout(base, width, height);
}
