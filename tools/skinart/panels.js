// 既定のスキン(skins/default/)の SCORE DETAILED / SONG INFO パネルの絵。tools/make_skin.py が tools/skinart/render.html で
// 画像にする(アプリはこのコードを読まず、画像だけを使う)。このリポジトリで描いた独自のデザイン。
//
// 座標は標準のパネル画像の等倍(score_panel.png 248×264 / song_panel.png 444×139)。Renderer は数や曲名を決まった場所に
// 重ねるので(js/ui/skin.js の SCORE_STD / SONG_STD)、行・枠はそこに数が載るように置く。細かい寸法を整数で書けるよう、
// 中では 1 論理 px を UNIT 単位に分けて描く。見出しと項目名の文字はシステムフォント。

import { roundRectPath } from './chips.js';

const FONT = '"Segoe UI", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif';
const UNIT = 5; // 1 論理 px あたりの単位

const FRAME = '#aab3c1';
const BODY_TOP = '#2c313a';
const BODY_BOTTOM = '#20242b';
const HEADER = '#373d48';
const TITLE = '#eef2f7';

/** 判定ごとの色(項目名と、見出しの下の帯)。 */
const JUDGE_COLORS = ['#ffdf4a', '#4fe06c', '#5cb6ff', '#c88cff', '#ff6b6b'];

/** 見出しの下の帯(判定の色を左から並べる)。 */
function accentStrip(g, x, y, w, h) {
  const gr = g.createLinearGradient(x, 0, x + w, 0);
  JUDGE_COLORS.forEach((c, i) => gr.addColorStop(i / (JUDGE_COLORS.length - 1), c));
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

/** 角の丸い本体と見出しの帯。見出しの文字は左寄せ。 */
function panelBody(g, x, y, w, h, r, headerH, title, titleSize) {
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, BODY_TOP);
  body.addColorStop(1, BODY_BOTTOM);
  roundRectPath(g, x, y, w, h, r);
  g.fillStyle = body;
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = HEADER;
  g.fillRect(x, y, w, headerH);
  accentStrip(g, x, y + headerH, w, Math.max(6, headerH * 0.07));
  g.restore();
  g.font = `bold ${titleSize}px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = TITLE;
  g.fillText(title, x + r, y + headerH / 2 + 2);
  roundRectPath(g, x, y, w, h, r);
  g.lineWidth = 6;
  g.strokeStyle = FRAME;
  g.stroke();
}

// ---- SCORE DETAILED(248×264) ----

/** js/ui/skin.js の SCORE_STD(論理 px)を単位に直したもの。 */
const SCORE = {
  rows: [58, 85, 112, 139, 166, 193].map((v) => v * UNIT),
  countRight: 152 * UNIT,
  fastSlowY: 228 * UNIT,
};
const ROW_LABELS = ['Perfect', 'Great', 'Good', 'Ok', 'Miss', 'Max Combo'];
const ROW_X = 40; // 行の帯の左端
const ROW_W = 1160;
const ROW_H = 104;

/** 行の帯と、左端の色の印・項目名。 */
function scoreRow(g, y, label, color, x = ROW_X) {
  g.fillStyle = color;
  roundRectPath(g, x, y - ROW_H / 2, 18, ROW_H, 9);
  g.fill();
  g.font = `bold 62px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(label, x + 44, y + 2);
}

function rowBand(g, y) {
  g.fillStyle = 'rgba(255,255,255,0.06)';
  roundRectPath(g, ROW_X, y - ROW_H / 2, ROW_W, ROW_H, 18);
  g.fill();
}

/** SCORE DETAILED パネルを (0, 0)-(248, 264) に描く。 */
export function drawScorePanelArt(g) {
  g.save();
  g.scale(1 / UNIT, 1 / UNIT);
  panelBody(g, 4, 4, 248 * UNIT - 8, 264 * UNIT - 8, 44, 160, 'SCORE DETAILED', 76);
  SCORE.rows.forEach((y, i) => {
    rowBand(g, y);
    scoreRow(g, y, ROW_LABELS[i], i < JUDGE_COLORS.length ? JUDGE_COLORS[i] : '#dfe4ea');
    // 数(右端 countRight)と率(右端 rateRight)の間の仕切り
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fillRect(SCORE.countRight + 44, y - 34, 3, 68);
  });
  // Fast / Slow(数は Renderer が fastX / slowX を中心に描く)
  rowBand(g, SCORE.fastSlowY);
  scoreRow(g, SCORE.fastSlowY, 'Fast', '#3aa0ff');
  scoreRow(g, SCORE.fastSlowY, 'Slow', '#ff5a5a', ROW_X + 556);
  g.restore();
}

// ---- SONG INFO(444×139) ----

/** js/ui/skin.js の SONG_STD のジャケットの枠(論理 px)を単位に直したもの。 */
const JACKET = [10, 30, 100, 100].map((v) => v * UNIT);

/** SONG INFO パネルを (0, 0)-(444, 139) に描く。 */
export function drawSongPanelArt(g) {
  g.save();
  g.scale(1 / UNIT, 1 / UNIT);
  panelBody(g, 4, 4, 444 * UNIT - 8, 139 * UNIT - 8, 48, 104, 'SONG INFO', 62);
  // ジャケットの枠(ジャケットが無いときは円盤の印)
  const [jx, jy, jw, jh] = JACKET;
  roundRectPath(g, jx - 12, jy - 12, jw + 24, jh + 24, 16);
  g.fillStyle = '#0e1014';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#8d96a5';
  g.stroke();
  const cx = jx + jw / 2;
  const cy = jy + jh / 2;
  g.beginPath();
  g.arc(cx, cy, Math.min(jw, jh) * 0.3, 0, Math.PI * 2);
  g.lineWidth = 12;
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, Math.min(jw, jh) * 0.07, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fill();
  // 曲名(y 52)・アーティスト(82)・レベル(112)の行の間の線(文字は Renderer が x 125 から重ねる)
  g.fillStyle = 'rgba(255,255,255,0.1)';
  for (const y of [67, 97]) g.fillRect(125 * UNIT, y * UNIT, 309 * UNIT, 3);
  g.restore();
}
