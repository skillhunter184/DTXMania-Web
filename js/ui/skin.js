// ハイウェイのスキン(vid2dtx preview.py のレイアウト定数を移植。レーンの並びは GITADORA と同じ)。
// 座標系は 1920x1080。元のスキンの枠(drum_bg2.png の上のスピーカーと下の SPEED パネル)は使わず、その分ハイウェイを
// 画面の上端から下端まで伸ばしている(判定ラインとパッド列は画面下に寄せる)。
//
// 絵はスキンの画像で描く。スキンは決まった名前の画像 6 枚の組(ドラム 4 枚・ギター / ベース 2 枚。書式は skins/README.md)で、既定のスキン skins/default/ を
// 同梱する。設定で手元のフォルダか、読み込んだ画像のスキンに替えられ、足りない画像は既定のスキンで補う
// (元実装に無い追加)。既定のスキンも読めないときだけ、単色の図形で描く(移植元と同じ扱い: docs/spec/vid2dtx-edit.md §1.4)。

import { ZipArchive } from '../core/zip.js';

/** 同梱の既定のスキン(index.html からの相対パス)。 */
export const DEFAULT_SKIN_BASE = 'skins/default/';
/** 以前の設定(スキン画像を使う)で読んでいた手元のスキン。設定の移行先。 */
export const LEGACY_SKIN_BASE = 'assets/skin/DrumGame/';

export const CANVAS_W = 1920;
export const CANVAS_H = 1080;
export const LANE_X0 = 539; // レーン帯の左端
export const LANE_W = 778; // レーン帯の幅
export const PAD_H = 89; // パッド列の高さ(pads.png の 1 段分)
export const PADS_Y = CANVAS_H - PAD_H - 6; // パッド列の上端(985)
export const JUDGE_Y = PADS_Y - 10; // 判定ライン(975)
export const LANE_Y0 = 0; // 可視ハイウェイの上端
export const LANE_Y1 = PADS_Y + 85; // 可視ハイウェイの下端(判定ラインを過ぎたチップはパッド列の下へ消える)

/** 表示列の並び(標準 GITADORA 配置)。RD チップは CY 列に描く。 */
export const COLUMN_ORDER = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY'];
/** レーン番号(0=LC..9=RD)→ 表示列番号(0..8)。 */
export const LANE_TO_COLUMN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8];
/** レーン番号順の名前(チップの画像の並び)。 */
const LANES = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'];

/** 表示列ごとの x 範囲(lane_a.png の区切り線から計測。レーン帯内の相対座標)。 */
export const COLUMN_SLOT = {
  LC: [1, 104], HH: [104, 181], LP: [181, 258], SD: [258, 344], HT: [344, 422],
  BD: [422, 520], LT: [520, 595], FT: [595, 672], CY: [672, 776],
};

/**
 * レーン帯の区切り線の中心 x(lane_a.png から計測。レーン帯内の相対座標)。LC|HH・HT|BD・FT|CY は二重線。
 * 線は 3px で、中央 1px が白・両脇が灰、どちらも半透明(lane_a.png の画素そのまま)。
 */
export const LANE_LINES = [1, 102, 107, 181, 258, 344, 419, 425, 520, 595, 670, 675, 776];
const LANE_LINE_CORE = 'rgba(255,255,255,0.502)';
const LANE_LINE_EDGE = 'rgba(163,163,163,0.502)';

/**
 * パッド列の画像(pads.png、等倍で 780×189)の各パッドの [x, 幅]。幅はそのまま画面での大きさ(論理 px)になり、
 * パッドは COLUMN_SLOT の列の中央に置く。元のスキンでは drum_icons.png のパッドと判定ラインを使うが
 * (docs/spec/vid2dtx-edit.md §1.4)、パッド・点灯したパッド・判定ラインを 1 枚に並べたこの形に替えている。
 */
export const PAD_SRC = {
  LC: [0, 93], HH: [95, 66], LP: [163, 73], SD: [238, 82], HT: [322, 71],
  BD: [395, 97], LT: [494, 73], FT: [569, 70], CY: [641, 91],
};
export const PAD_ROW_GRAY = [0, 89];
export const PAD_ROW_LIT = [89, 178];
/** 判定ライン(pads.png の最下段)の [x, y, 幅, 高さ]。縦の中央を JUDGE_Y に合わせて描く。 */
export const JUDGE_SRC = [0, 178, 780, 11];

/** レーンフラッシュ等に使う色(RGB 成分)。 */
export const LANE_RGB = {
  LC: [236, 146, 188], HH: [146, 193, 236], LP: [236, 146, 187], SD: [236, 228, 146],
  BD: [187, 174, 238], HT: [151, 236, 145], LT: [236, 145, 149], FT: [209, 146, 236],
  CY: [145, 193, 235], RD: [145, 193, 235],
};

/** DTXManiaAI の演奏画面 Prefab から取ったパネル位置(左上原点・1920x1080)。 */
export const PANELS = {
  songInfo: { x: 1432, y: 186, w: 444, h: 139 }, // 高さは元の 140 から縦横比を揃えた
  movieFrame: { x: 1433, y: 509, w: 442, h: 270 },
  scoreDetailed: { x: 177, y: 610, w: 248, h: 264 }, // 高さは元の 221 から縦横比を揃えた
  trainingMenu: { x: 1400, y: 340, w: 500, h: 700 },
};

// ---- ギター / ベースの画面(js/ui/gbrenderer.js) ----
// NX のギターの画面(720p)の座標を 1.5 倍し、レーンとウェイリングの列のまとまり(NX x 86..325、中央 205.5)の中央を
// ドラムのレーン帯の中央 928 に合わせた: X = 1.5 × NX の x + 620、Y = 1.5 × NX の y。弾くのは 1 パートだけなので
// ギターとベースは同じ配置(NX は 2 パートを左右に並べ、ベースの x は不規則にずれている。それは使わない)。
// NX の寸法の出どころは docs/spec/gb-screen.md §1(この配置は §6 の案)。

/** レーンのパネル(NX 277×678 at (67, 42))。幅は NX の 415.5 の端数を切り上げた画像の幅。 */
export const GB_PANEL = { x: 720.5, y: 63, w: 416, h: 1017 };
/** 最初のレーンの区切り線の左端(NX 86)。区切り線は 3 px(NX 2 px)、レーン i の内側は GB_LANE_X + 3 + GB_LANE_PITCH × i から 55.5 px。 */
export const GB_LANE_X = 749;
export const GB_LANE_PITCH = 58.5; // NX 39
/** チップの見える大きさ(NX のチップは 38×10 の枠の左 37 列。レーンの内側をちょうど埋める)。 */
export const GB_CHIP_W = 55.5;
export const GB_CHIP_H = 15;
/** OPEN(NX 196×10 の枠の下 9 行が見える)。左端は最初のチップと同じ、上端はチップの中心 − 1.5、高さ 13.5。 */
export const GB_OPEN = { x: 752, w: 294, top: -1.5, h: 13.5 };
/** 小節線(NX 193×2)。上端が小節の位置。 */
export const GB_BAR = { x: 752, w: 289.5, h: 3 };
/** ウェイリングの列(NX 283..325)とウェイリングチップ(NX 54×68 at x 287。縦の中心を位置に合わせる)。 */
export const GB_WAIL_COL = [1044.5, 1107.5];
export const GB_WAIL_CHIP = { x: 1050.5, w: 81, h: 102 };
/** 判定ライン(NX hit-bar 252×6 at x 80)。上端は判定位置 − 1.5(既定の向き)/ 判定位置(REVERSE)。 */
export const GB_HITBAR = { x: 740, w: 378, h: 9 };
/** 判定位置(NX 154 / REVERSE 611)。チップの中心は判定位置 + 1.5 ± 距離。 */
export const GB_JUDGE_Y = 231;
export const GB_JUDGE_Y_REVERSE = 916.5;
/** 上のボタン列(レーンの上の帯 63..156 を覆う)と下の枠(NX 670..720)。どちらも向きで動かない(NX)。 */
export const GB_TOP = { y: 63, h: 93 };
export const GB_BOTTOM = { y: 1005, h: 75 };
/** チップが見える範囲(上のボタン列の下端から下の枠の上端まで。NX と同じく両方の向きで同じ)。 */
export const GB_VIEW_Y0 = 156;
export const GB_VIEW_Y1 = 1005;

/** レーンの色(DTXManiaAI の CUSTOM の配色)。R G B Y P、OPEN、ウェイリング。 */
export const GB_LANE_RGB = [[242, 77, 77], [89, 230, 102], [89, 140, 255], [242, 217, 64], [217, 102, 242]];
export const GB_OPEN_RGB = [230, 140, 51];
export const GB_WAIL_RGB = [102, 230, 230];

/** レーン i(0..4 = R..P)のチップの左端。 */
export function gbChipX(i) {
  return GB_LANE_X + 3 + GB_LANE_PITCH * i;
}

/** レーン i の中心 x(ファイア・ボタン)。 */
export function gbLaneCenterX(i) {
  return gbChipX(i) + GB_CHIP_W / 2;
}

/** 絶対 x → レーン番号(区切り線を含めた列。範囲外は -1)。 */
export function gbLaneAtX(x) {
  const i = Math.floor((x - GB_LANE_X) / GB_LANE_PITCH);
  return i >= 0 && i < 5 ? i : -1;
}

/**
 * ボタン lane(0..4 = R..P)を描く列(左から何本目)。LEFT(NX bLeft)なら左右を入れ替え、R G B Y P → P Y B G R。
 * 入れ替えは自分自身の逆なので、列 → ボタンにも使う。gbChipX / gbLaneCenterX / gbLaneAtX は列で数える。
 */
export function gbSlot(lane, left) {
  return left ? 4 - lane : lane;
}

// ---- スキンの画像の決まり(skins/README.md) ----
// 部品ごとに、探す名前と、その名前の画像の配置を持つ。配置の数は「基準の幅 w の画像」の画素で、実際の画像が
// k 倍の幅なら全部を k 倍して使う(高解像度の画像をそのまま置ける)。名前は前から順に探し、見つかった名前の配置で読む。
// 2 番目以降は以前の手元のスキン(DrumGame)の名前と配置で、そのフォルダをそのまま指定できるように残している。

/** 標準のチップ画像(chips.png、等倍で 128×240): レーン番号順に 24px 間隔で縦に並べ、各行の [4, 4, 120, 16] がチップ。 */
const CHIP_STD = Object.fromEntries(LANES.map((n, i) => [n, [4, 4 + 24 * i, 120, 16]]));
/** 以前のチップ画像(drum_chips_hd.webp、2000×667): 横に 1 列。RD は CY と同じ絵。 */
const CHIP_LEGACY = {
  LC: [9, 308, 245, 48], HH: [260, 308, 191, 48], LP: [457, 308, 198, 48], SD: [662, 308, 217, 48],
  BD: [886, 308, 229, 48], HT: [1122, 308, 205, 48], LT: [1335, 308, 203, 48], FT: [1545, 308, 200, 48],
  CY: [1752, 308, 239, 48], RD: [1752, 308, 239, 48],
};

/**
 * SCORE DETAILED パネル。src は画像内のパネルの範囲 [x, y, 幅, 高さ](これを PANELS.scoreDetailed に縮めて描く)。
 * 数は Renderer が重ねる: 判定ごとの数は右端 countRight・縦の中央 rows[i]、率は右端 rateRight・下端 rows[i] + rateDrop、
 * Fast / Slow の数は fastX / slowX を中心に fastSlowY に置く(Fast / Slow の数の表示は元のパネルに無い追加)。
 */
const SCORE_STD = {
  src: [0, 0, 248, 264], rows: [58, 85, 112, 139, 166, 193], countRight: 152, rateRight: 229, rateDrop: 8,
  fastSlowY: 228, fastX: 88, slowX: 207,
};
const SCORE_LEGACY = {
  src: [44, 32, 1237, 1317], rows: [318, 455, 591, 727, 864, 1000], countRight: 805, rateRight: 1186, rateDrop: 38,
  fastSlowY: 1167, fastX: 481, slowX: 1077,
};
/** SONG INFO パネル。jacket はジャケットを入れる枠の内側 [x, y, 幅, 高さ]。曲名などの文字は Renderer が決まった位置に描く。 */
const SONG_STD = { src: [0, 0, 444, 139], jacket: [10, 30, 100, 100] };
const SONG_LEGACY = { src: [12, 22, 1978, 619], jacket: [58, 155, 449, 443] };
/** パッド列: 等倍の配置そのまま。 */
const PADS_STD = { pads: PAD_SRC, gray: PAD_ROW_GRAY, lit: PAD_ROW_LIT, judge: JUDGE_SRC };

/**
 * ギター / ベースのチップの画像(gb_chips.png、等倍で 320×180)。各枠の [x, y, 幅, 高さ]。周りの 4px は空ける。
 * chips / bodies はレーン順(R G B Y P)。チップは 55.5×15、OPEN は 294×13.5 に縮めて描き、ロングノートの胴は縦に伸ばす
 * (胴の絵は縦に一様にする)。ウェイリングチップは等倍。
 */
export const GB_CHIPS_SRC = {
  chips: [0, 1, 2, 3, 4].map((i) => [4 + 64 * i, 4, 56, 15]),
  bodies: [0, 1, 2, 3, 4].map((i) => [4 + 64 * i, 27, 56, 15]),
  open: [4, 50, 294, 14],
  wail: [4, 72, 81, 102],
};
/**
 * ギター / ベースのネックの画像(gb_neck.png、等倍で 424×408)。上のボタン列(消灯・全部点灯)、下の枠(通常・ピック点灯)、
 * 判定ライン、レーンのパネルの地(縦に一様な帯。パネルの高さに伸ばす)。ボタン列・枠・帯はパネルの左端に合わせて描く。
 */
export const GB_NECK_SRC = {
  top: [4, 4, 416, 93], topLit: [4, 101, 416, 93],
  bottom: [4, 198, 416, 75], bottomLit: [4, 277, 416, 75],
  hitBar: [4, 356, 378, 9], strip: [4, 369, 416, 32],
};

/**
 * 部品 → 候補 [{names, w, h, layout}]。w×h は配置の基準の大きさ(画像の縦横比がこれと違えば警告する)。
 * 名前の 1 つ目が標準の名前で、足りない画像として知らせるときにも使う。
 */
export const SKIN_PARTS = {
  chips: [
    { names: ['chips.png'], w: 128, h: 240, layout: { chips: CHIP_STD } },
    { names: ['drum_chips_hd.webp'], w: 2000, h: 667, layout: { chips: CHIP_LEGACY } },
  ],
  pads: [{ names: ['pads.png', 'drum_pads.png'], w: 780, h: 189, layout: PADS_STD }],
  scorePanel: [
    { names: ['score_panel.png'], w: 248, h: 264, layout: SCORE_STD },
    { names: ['score_detailed_hd.png'], w: 1314, h: 1414, layout: SCORE_LEGACY },
  ],
  songPanel: [
    { names: ['song_panel.png'], w: 444, h: 139, layout: SONG_STD },
    { names: ['song_info_hd.webp'], w: 2000, h: 683, layout: SONG_LEGACY },
  ],
  gbChips: [{ names: ['gb_chips.png'], w: 320, h: 180, layout: GB_CHIPS_SRC }],
  gbNeck: [{ names: ['gb_neck.png'], w: 424, h: 408, layout: GB_NECK_SRC }],
};

/** 配置の数を全部 k 倍する(入れ子の配列・オブジェクトも)。 */
function scaleLayout(v, k) {
  if (typeof v === 'number') return v * k;
  if (Array.isArray(v)) return v.map((x) => scaleLayout(x, k));
  return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, scaleLayout(x, k)]));
}

/** 名前の拡張子を除いた小文字(読み込んだ画像は PNG 以外の形式でもよいので、名前の照合は拡張子を見ない)。 */
function stem(name) {
  const base = String(name).replace(/\\/g, '/').split('/').pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

const SKIN_STEMS = new Set(Object.values(SKIN_PARTS).flatMap((cands) => cands.flatMap((c) => c.names.map(stem))));
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;

/** スキンの画像として読み込むファイル名か(パスの付いた名前でもよい)。 */
export function isSkinFileName(name) {
  return IMAGE_EXT.test(name) && SKIN_STEMS.has(stem(name));
}

const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/**
 * 選んだファイル(画像か ZIP)からスキンの画像を集める(設定の「画像 / ZIP を選ぶ」)。ZIP は中の画像をファイル名で拾い、
 * フォルダの階層は見ない。スキンの画像でないファイルは捨てる。同じ名前(拡張子違いを含む)は後のものを使う。
 * @param {Iterable<Blob & {name: string}>} files
 * @returns {Promise<{name: string, blob: Blob}[]>}
 */
export async function collectSkinFiles(files) {
  const out = new Map();
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await ZipArchive.open(f);
      for (const e of zip.entries) {
        if (e.isDir || !isSkinFileName(e.name)) continue;
        const name = e.name.split('/').pop();
        const ext = name.split('.').pop().toLowerCase();
        out.set(stem(name), { name, blob: new Blob([await zip.read(e)], { type: MIME[ext] || '' }) });
      }
    } else if (isSkinFileName(f.name)) {
      out.set(stem(f.name), { name: f.name.replace(/\\/g, '/').split('/').pop(), blob: f });
    }
  }
  return [...out.values()];
}

/** 設定のスキンのフォルダ(index.html からの相対パスか URL)を、末尾 '/' 付きの形にそろえる。空なら以前の手元のスキン。 */
export function normalizeSkinPath(path) {
  const p = String(path || '').trim().replace(/\\/g, '/');
  if (!p) return LEGACY_SKIN_BASE;
  return p.endsWith('/') ? p : p + '/';
}

/** 表示列の中心 x(絶対座標)。 */
export function columnCenterX(col) {
  const [x0, x1] = COLUMN_SLOT[COLUMN_ORDER[col]];
  return LANE_X0 + (x0 + x1) / 2;
}

/** 表示列の x 範囲(絶対座標)。 */
export function columnRange(col) {
  const [x0, x1] = COLUMN_SLOT[COLUMN_ORDER[col]];
  return [LANE_X0 + x0, LANE_X0 + x1];
}

/** 絶対 x → 表示列番号(範囲外なら -1)。 */
export function columnAtX(x) {
  const rel = x - LANE_X0;
  for (let i = 0; i < COLUMN_ORDER.length; i++) {
    const [x0, x1] = COLUMN_SLOT[COLUMN_ORDER[i]];
    if (rel >= x0 && rel < x1) return i;
  }
  return -1;
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Blob の画像を読む(onload の後なら drawImage できるので、URL はすぐ手放す)。 */
async function loadBlobImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * source から部品 part の画像を探す。見つかれば {image, layout(画像の画素に合わせたもの), name}。
 * @param {{base?: string, files?: Map<string, Blob>}} source base はフォルダの URL(末尾 '/')、files は名前 → 画像
 */
async function findPart(source, part) {
  for (const cand of SKIN_PARTS[part]) {
    for (const name of cand.names) {
      let image = null;
      if (source.files) {
        const want = stem(name);
        const hit = [...source.files.entries()].find(([n]) => stem(n) === want && IMAGE_EXT.test(n));
        if (hit) image = await loadBlobImage(hit[1]);
      } else if (source.base) {
        image = await loadImage(source.base + name);
      }
      if (!image || !image.width) continue;
      const k = image.width / cand.w;
      if (Math.abs(image.height - cand.h * k) > Math.max(2, cand.h * k * 0.02)) {
        console.warn(`スキンの ${name} の大きさ ${image.width}x${image.height} が ${cand.w}x${cand.h} の比と違います(幅に合わせて読みます)`);
      }
      return { image, layout: scaleLayout(cand.layout, k), k, name };
    }
  }
  return null;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** パッドの絵の左端(レーン帯内の相対座標)。COLUMN_SLOT の列の中央に置き、レーン帯からはみ出さないよう寄せる。 */
function padX(name) {
  const [x0, x1] = COLUMN_SLOT[name];
  const w = PAD_SRC[name][1];
  return Math.max(0, Math.min(Math.floor((x0 + x1) / 2 - w / 2), LANE_W - w));
}

function rgb(c, a = 1) {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export class Skin {
  /** 画像を読まずに作ると、全部を単色の図形で描くスキンになる(テストと、既定のスキンも読めないとき)。 */
  constructor() {
    this.images = {}; // 部品(SKIN_PARTS のキー)→ 読めた画像。無い部品は単色の図形で描く
    this.layouts = {}; // 部品 → その画像の配置(画像の画素)
    this.scales = {}; // 部品 → 画像の倍率(基準の幅に対する画像の幅)
    this.missing = []; // 指定したスキンに無く、既定のスキン(か単色の図形)で補った画像の標準の名前
    this.lane = null; // laneStrip() の結果
    this.chipSprites = {}; // レーン名 → 表示の画素数に縮めたチップ(_chipSprite)
    this.pads = null; // {gray, lit, k}: パッド列(論理 1px あたり k 画素。_padRows)
    this.judge = null; // 判定ライン(画像から切り出したもの。無ければ毎回単色で描く)
    this.gbSprites = {}; // ギター / ベースの部品 → 表示の画素数で作り置いた絵(_gbSprite)
  }

  /**
   * スキンを読む。source の画像を部品ごとに探し、無い部品は既定のスキン(defaultBase)から読む。
   * @param {{base?: string, files?: Map<string, Blob>}|null} source null なら既定のスキンだけ
   * @param {{defaultBase?: string}} [opts]
   */
  static async load(source, { defaultBase = DEFAULT_SKIN_BASE } = {}) {
    const skin = new Skin();
    const parts = Object.keys(SKIN_PARTS);
    const found = await Promise.all(parts.map(async (part) => {
      const own = source ? await findPart(source, part) : null;
      return { own, got: own || (defaultBase ? await findPart({ base: defaultBase }, part) : null) };
    }));
    parts.forEach((part, i) => {
      const { own, got } = found[i];
      if (source && !own) skin.missing.push(SKIN_PARTS[part][0].names[0]);
      if (!got) return;
      skin.images[part] = got.image;
      skin.layouts[part] = got.layout;
      skin.scales[part] = got.k;
    });
    const none = parts.filter((p) => !skin.images[p]);
    if (none.length) console.warn('スキンの画像が読めない部分は単色の図形で描きます:', none.join(', '));
    if (skin.images.pads) skin._prerender();
    return skin;
  }

  /** SCORE DETAILED パネルの配置(画像の画素。画像が無ければ標準の配置を等倍で使う)。 */
  get scorePanel() {
    return this.layouts.scorePanel || SCORE_STD;
  }

  /** SONG INFO パネルの配置。 */
  get songPanel() {
    return this.layouts.songPanel || SONG_STD;
  }

  /** pads.png からパッド列と判定ラインを切り出す(画像の倍率のまま一度だけ)。 */
  _prerender() {
    const im = this.images.pads;
    const L = this.layouts.pads;
    const k = this.scales.pads;
    // パッド列を COLUMN_SLOT の各列の中央に並べ直す
    const buildPads = ([y0, y1]) => {
      const c = makeCanvas(LANE_W * k, y1 - y0);
      const g = c.getContext('2d');
      for (const name of COLUMN_ORDER) {
        const [sx, sw] = L.pads[name];
        g.drawImage(im, sx, y0, sw, y1 - y0, padX(name) * k, 0, sw, y1 - y0);
      }
      return c;
    };
    this.pads = { gray: buildPads(L.gray), lit: buildPads(L.lit), k };

    const [jx, jy, jw, jh] = L.judge;
    const judge = makeCanvas(jw, jh);
    judge.getContext('2d').drawImage(im, jx, jy, jw, jh, 0, 0, judge.width, judge.height);
    this.judge = judge;
  }

  /**
   * レーン帯(透明地に区切り線。LANE_Y0..LANE_Y1 の範囲)。移植元は lane_a.png を貼るが、中身は縦に一様な線だけなので
   * 同じ画素をここで描く(スキンに依らない)。移植元のレーンガイド(lane_assist_a.png の矢印・足跡。
   * docs/spec/vid2dtx-edit.md §1.4・§2.2)は使わない。
   */
  laneStrip() {
    if (this.lane) return this.lane;
    const h = LANE_Y1 - LANE_Y0;
    const c = makeCanvas(LANE_W, h);
    const g = c.getContext('2d');
    for (const x of LANE_LINES) {
      g.fillStyle = LANE_LINE_EDGE;
      g.fillRect(x - 1, 0, 1, h);
      g.fillRect(x + 1, 0, 1, h);
      g.fillStyle = LANE_LINE_CORE;
      g.fillRect(x, 0, 1, h);
    }
    this.lane = c;
    return c;
  }

  /** チップ(横バー)を描く。中心 (cx, y)、幅 w、高さ h(論理 px)。devScale は論理 px あたりの表示の画素数。 */
  drawBar(g, laneName, cx, y, w, h, devScale = 1) {
    g.drawImage(this._chipSprite(laneName, w, h, devScale), cx - w / 2, y - h / 2, w, h);
  }

  /**
   * チップを表示の画素数(w×h × devScale)で作った絵。画像は表示より大きいことが多く、毎フレーム縮めて描くと
   * 細いハイライトがちらつくうえ重いので、大きさが変わったときだけ高品質で縮め直す。
   */
  _chipSprite(laneName, w, h, devScale) {
    const s = this.chipSprites[laneName];
    if (s && s.w === w && s.h === h && s.devScale === devScale) return s.canvas;
    const c = makeCanvas(w * devScale, h * devScale);
    const g = c.getContext('2d');
    if (this.images.chips) {
      const [sx, sy, sw, sh] = this.layouts.chips.chips[laneName] || this.layouts.chips.chips.CY;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.images.chips, sx, sy, sw, sh, 0, 0, c.width, c.height);
    } else {
      g.fillStyle = rgb(LANE_RGB[laneName] || LANE_RGB.CY);
      g.fillRect(0, 0, c.width, c.height);
    }
    this.chipSprites[laneName] = { canvas: c, w, h, devScale };
    return c;
  }

  /** 判定ライン(縦の中央を JUDGE_Y に合わせる)。 */
  drawJudge(g) {
    const [, , jw, jh] = JUDGE_SRC;
    const y = JUDGE_Y - Math.floor(jh / 2);
    if (this.judge) {
      g.drawImage(this.judge, LANE_X0, y, jw, jh);
      return;
    }
    g.fillStyle = 'rgb(255,214,64)';
    g.fillRect(LANE_X0, JUDGE_Y - 1, jw, 3);
  }

  /** パッド列(灰色)を PADS_Y に描く。 */
  drawPads(g, devScale = 1) {
    g.drawImage(this._padRows(devScale).gray, LANE_X0, PADS_Y, LANE_W, PAD_H);
  }

  /** 表示列 x0..x1(絶対座標)の点灯したパッドを、上端 y に描く。 */
  drawPadLit(g, x0, x1, y, devScale = 1) {
    const { lit } = this._padRows(devScale);
    const kx = lit.width / LANE_W;
    g.drawImage(lit, (x0 - LANE_X0) * kx, 0, (x1 - x0) * kx, lit.height, x0, y, x1 - x0, PAD_H);
  }

  /**
   * パッド列(灰色・点灯)。画像は _prerender で画像の倍率のまま作ってある。画像が無いときの単色の図形は表示の倍率に
   * 合わせて作り(1 未満は 1 にし、0.25 刻みに切り上げる)、倍率が変わったときだけ作り直す。
   */
  _padRows(devScale) {
    if (this.images.pads) return this.pads;
    const k = Math.min(4, Math.max(1, Math.ceil(devScale * 4) / 4));
    if (this.pads && this.pads.k === k) return this.pads;
    if (this.pads) this.pads.gray.width = this.pads.lit.width = 0; // 古い画素はすぐ手放す(iOS のキャンバスの総量の上限)
    const build = (lit) => {
      const c = makeCanvas(LANE_W * k, PAD_H * k);
      const g = c.getContext('2d');
      g.scale(c.width / LANE_W, c.height / PAD_H);
      for (const name of COLUMN_ORDER) {
        const w = PAD_SRC[name][1];
        g.beginPath();
        g.ellipse(padX(name) + w / 2, PAD_H / 2, w / 2 - 3, PAD_H * 0.3, 0, 0, Math.PI * 2);
        g.fillStyle = lit ? rgb(LANE_RGB[name]) : 'rgb(150,154,162)';
        g.fill();
      }
      return c;
    };
    this.pads = { gray: build(false), lit: build(true), k };
    return this.pads;
  }

  /** SCORE DETAILED パネルを PANELS.scoreDetailed に描く。 */
  drawScorePanel(g) {
    drawPanel(g, this.images.scorePanel, this.scorePanel.src, PANELS.scoreDetailed);
  }

  /** SONG INFO パネルを PANELS.songInfo に描く。 */
  drawSongPanel(g) {
    drawPanel(g, this.images.songPanel, this.songPanel.src, PANELS.songInfo);
  }

  // ---- ギター / ベース(gb_chips.png・gb_neck.png。無ければ単色の図形) ----

  /**
   * ギター / ベースの部品を表示の画素数(w×h × devScale)で作り置いた絵。画像があればその枠(pick で配置から選ぶ)を
   * 高品質で縮め、無ければ fallback(g, w, h)(論理 px で描く)の単色の図形にする。大きさが変わったときだけ作り直す
   * (チップの _chipSprite と同じ理由: 毎フレーム画像から縮めると細い線がちらつき、重い)。
   */
  _gbSprite(key, part, pick, w, h, devScale, fallback, mirror = null) {
    const s = this.gbSprites[key];
    if (s && s.w === w && s.h === h && s.devScale === devScale) return s.canvas;
    if (s) s.canvas.width = s.canvas.height = 0; // 古い画素はすぐ手放す
    const c = makeCanvas(w * devScale, h * devScale);
    const g = c.getContext('2d');
    const img = this.images[part];
    if (img) {
      const [sx, sy, sw, sh] = pick(this.layouts[part]);
      g.imageSmoothingQuality = 'high';
      if (mirror) {
        const src = mirror(img, sx, sy, sw, sh);
        g.drawImage(src, 0, 0, src.width, src.height, 0, 0, c.width, c.height);
        src.width = src.height = 0;
      } else {
        g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      }
    } else {
      g.scale(c.width / w, c.height / h);
      fallback(g, w, h);
    }
    this.gbSprites[key] = { canvas: c, w, h, devScale };
    return c;
  }

  /** チップの頭(lane 0..4 = R..P)を左上 (x, y) に GB_CHIP_W × GB_CHIP_H で描く。 */
  drawGbChip(g, lane, x, y, devScale = 1) {
    const c = this._gbSprite('chip' + lane, 'gbChips', (L) => L.chips[lane], GB_CHIP_W, GB_CHIP_H, devScale, (sg, w, h) => {
      sg.fillStyle = rgb(GB_LANE_RGB[lane]);
      sg.fillRect(0, 0, w, h);
    });
    g.drawImage(c, x, y, GB_CHIP_W, GB_CHIP_H);
  }

  /** ロングノートの胴を左上 (x, y) から高さ h に伸ばして描く(透明度は呼ぶ側の globalAlpha)。 */
  drawGbBody(g, lane, x, y, h, devScale = 1) {
    if (!(h > 0)) return;
    const c = this._gbSprite('body' + lane, 'gbChips', (L) => L.bodies[lane], GB_CHIP_W, GB_CHIP_H, devScale, (sg, w, hh) => {
      sg.fillStyle = rgb(GB_LANE_RGB[lane]);
      sg.fillRect(0, 0, w, hh);
    });
    g.drawImage(c, x, y, GB_CHIP_W, h);
  }

  /** OPEN の棒を左上 (GB_OPEN.x, y) に描く。 */
  drawGbOpen(g, y, devScale = 1) {
    const c = this._gbSprite('open', 'gbChips', (L) => L.open, GB_OPEN.w, GB_OPEN.h, devScale, (sg, w, h) => {
      sg.fillStyle = rgb(GB_OPEN_RGB);
      sg.fillRect(0, 0, w, h);
    });
    g.drawImage(c, GB_OPEN.x, y, GB_OPEN.w, GB_OPEN.h);
  }

  /** ウェイリングチップを縦の中心 y に描く。 */
  drawGbWail(g, y, devScale = 1) {
    const { x, w, h } = GB_WAIL_CHIP;
    const c = this._gbSprite('wail', 'gbChips', (L) => L.wail, w, h, devScale, (sg) => {
      // ウェイリングの列の中に収める(枠の左端は列の左端の 6 px 右なので、枠の x 0〜57 が列の中。列の中央は枠の x 25.5)
      sg.fillStyle = rgb(GB_WAIL_RGB);
      sg.fillRect(6, 12, 40, 78);
    });
    g.drawImage(c, x, y - h / 2, w, h);
  }

  /** レーンのパネル(静止部分。帯をパネルの高さに伸ばす)。 */
  drawGbPanel(g) {
    const P = GB_PANEL;
    const img = this.images.gbNeck;
    if (img) {
      const [sx, sy, sw, sh] = this.layouts.gbNeck.strip;
      g.imageSmoothingQuality = 'high';
      // 帯の上下の端の行は隣の枠との境目なので、1 画素ずつ内側だけを使う(縦に一様な絵なので見た目は同じ)
      g.drawImage(img, sx, sy + 1, sw, sh - 2, P.x, P.y, P.w, P.h);
      g.imageSmoothingQuality = 'low';
      return;
    }
    g.fillStyle = 'rgb(26,28,33)';
    g.fillRect(P.x, P.y, P.w - 0.5, P.h);
    g.fillStyle = 'rgb(0,0,0)';
    g.fillRect(GB_LANE_X, P.y, GB_WAIL_COL[1] - GB_LANE_X, P.h);
    g.fillStyle = 'rgb(63,61,59)';
    for (let i = 0; i <= 5; i++) g.fillRect(GB_LANE_X + GB_LANE_PITCH * i, P.y, 3, P.h);
  }

  /** 上のボタン列(消灯)。left なら LEFT の並び(P Y B G R)。 */
  drawGbTop(g, devScale = 1, left = false) {
    g.drawImage(this._gbTopRow(false, devScale, left), GB_PANEL.x, GB_TOP.y, GB_PANEL.w, GB_TOP.h);
  }

  /**
   * 上のボタン列のボタン lane を点灯させる(点灯版をそのボタンの列の幅で切って重ねる。透明度は呼ぶ側)。
   * LEFT では LEFT の並びの点灯版から、ボタンの描かれている列を切る(消灯版と同じ作り方なので、重ねてもずれない)。
   */
  drawGbKnobLit(g, lane, devScale = 1, left = false) {
    const lit = this._gbTopRow(true, devScale, left);
    const kx = lit.width / GB_PANEL.w;
    const x0 = GB_LANE_X + GB_LANE_PITCH * gbSlot(lane, left);
    g.drawImage(lit, (x0 - GB_PANEL.x) * kx, 0, GB_LANE_PITCH * kx, lit.height, x0, GB_TOP.y, GB_LANE_PITCH, GB_TOP.h);
  }

  /**
   * ボタン列の絵。LEFT の並びは、スキンに LEFT 用の行が無い(NX の絵には別の行がある)ので、画像のレーン 5 列を入れ替えて作る
   * (swapLaneColumns。文字や光の向きまで鏡に映さないよう、裏返さずに列ごと並べ替える)。
   */
  _gbTopRow(lit, devScale, left = false) {
    const row = lit ? 'topLit' : 'top';
    const key = row + (left ? 'L' : '');
    return this._gbSprite(key, 'gbNeck', (L) => L[row], GB_PANEL.w, GB_TOP.h, devScale, (sg, w, h) => {
      sg.fillStyle = 'rgb(34,37,44)';
      sg.fillRect(0, 0, w, h);
      for (let i = 0; i < 5; i++) {
        sg.beginPath();
        sg.arc(gbLaneCenterX(gbSlot(i, left)) - GB_PANEL.x, h * 0.55, 19, 0, Math.PI * 2);
        sg.fillStyle = lit ? rgb(GB_LANE_RGB[i]) : 'rgb(70,74,84)';
        sg.fill();
        sg.lineWidth = 3;
        sg.strokeStyle = rgb(GB_LANE_RGB[i]);
        sg.stroke();
      }
    }, left ? swapLaneColumns : null);
  }

  /**
   * 下の枠(lit ならピックが光った版。透明度は呼ぶ側)。LEFT では各ボタンの中心 ± GB_POLE_HALF の窓だけを入れ替える
   * (既定のスキンはボタンの色のポールピースが光る。枠全体の列を入れ替えると、レーンをまたぐピックアップの箱の角が切れる)。
   */
  drawGbBottom(g, lit = false, devScale = 1, left = false) {
    const row = lit ? 'bottomLit' : 'bottom';
    const key = row + (left ? 'L' : '');
    const mirror = left ? (img, sx, sy, sw, sh) => swapLaneColumns(img, sx, sy, sw, sh, GB_POLE_HALF) : null;
    const c = this._gbSprite(key, 'gbNeck', (L) => L[row], GB_PANEL.w, GB_BOTTOM.h, devScale, (sg, w, h) => {
      sg.fillStyle = 'rgb(34,37,44)';
      sg.fillRect(0, 0, w, h);
      const cx = (GB_WAIL_COL[0] + GB_WAIL_COL[1]) / 2 - GB_PANEL.x;
      sg.beginPath();
      sg.moveTo(cx - 16, h / 2 - 14);
      sg.lineTo(cx + 16, h / 2 - 14);
      sg.lineTo(cx, h / 2 + 18);
      sg.closePath();
      sg.fillStyle = lit ? 'rgb(255,240,200)' : 'rgb(120,124,134)';
      sg.fill();
    }, mirror);
    g.drawImage(c, GB_PANEL.x, GB_BOTTOM.y, GB_PANEL.w, GB_BOTTOM.h);
  }

  /** 判定ラインを上端 y に描く。 */
  drawGbHitBar(g, y, devScale = 1) {
    const { x, w, h } = GB_HITBAR;
    const c = this._gbSprite('hitBar', 'gbNeck', (L) => L.hitBar, w, h, devScale, (sg, ww) => {
      sg.fillStyle = 'rgb(255,236,90)';
      sg.fillRect(0, 3, ww, 3);
    });
    g.drawImage(c, x, y, w, h);
  }
}

/** LEFT で下の枠を入れ替える窓の半幅(ボタンの中心から。既定のスキンのポールピースの光は半径 9)。 */
const GB_POLE_HALF = 14;

/**
 * ギター / ベースの枠の画像(パネルの左端に合わせた 416 幅。画像の画素で sx, sy, sw, sh)のレーンの部分を左右の順に
 * 入れ替えた絵(sw × sh)を返す(LEFT)。half を省くとレーン 5 列(区切り線の左端から 58.5 ずつ。パネルの左端から
 * 28.5〜321)をまるごと入れ替える(ボタン列)。half を渡すと各ボタンの中心 ± half の窓だけを入れ替え、ほかはそのまま
 * (下の枠)。境目は画像の画素で丸めた整数にし、等倍で写すので、継ぎ目に隙間も重なりもできない。透明な所のある
 * スキンでも元の並びが透けないよう、入れ替える所は空けてから写す。
 */
function swapLaneColumns(img, sx, sy, sw, sh, half) {
  const k = sw / GB_PANEL.w;
  const c = makeCanvas(sw, sh);
  const g = c.getContext('2d');
  const h = c.height;
  if (half === undefined) {
    const e = [0, 1, 2, 3, 4, 5].map((j) => Math.round((GB_LANE_X - GB_PANEL.x + GB_LANE_PITCH * j) * k));
    g.drawImage(img, sx, sy, e[0], sh, 0, 0, e[0], h);
    g.drawImage(img, sx + e[5], sy, sw - e[5], sh, e[5], 0, c.width - e[5], h);
    for (let i = 0; i < 5; i++) {
      const w = e[i + 1] - e[i];
      g.drawImage(img, sx + e[i], sy, w, sh, e[0] + e[5] - e[i + 1], 0, w, h);
    }
    return c;
  }
  const x = [0, 1, 2, 3, 4].map((i) => Math.round((gbLaneCenterX(i) - half - GB_PANEL.x) * k));
  const w = Math.round(2 * half * k);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, h);
  for (let i = 0; i < 5; i++) g.clearRect(x[i], 0, w, h);
  for (let i = 0; i < 5; i++) g.drawImage(img, sx + x[i], sy, w, sh, x[4 - i], 0, w, h);
  return c;
}

/**
 * パネル画像の src の範囲(画像の画素)を rect に縮めて描く。画像は表示より大きいことが多く、既定の縮小では細い線と
 * 文字が崩れるので高品質で縮める。画像が無ければ枠だけの単色の四角を描く。
 */
function drawPanel(g, img, src, rect) {
  if (img) {
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, src[0], src[1], src[2], src[3], rect.x, rect.y, rect.w, rect.h);
    g.imageSmoothingQuality = 'low';
    return;
  }
  g.fillStyle = 'rgb(36,40,48)';
  g.fillRect(rect.x, rect.y, rect.w, rect.h);
  g.strokeStyle = 'rgb(120,128,140)';
  g.lineWidth = 2;
  g.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
}
