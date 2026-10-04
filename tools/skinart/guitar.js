// 既定のスキン(skins/default/)のギター / ベースの絵(gb_chips.png・gb_neck.png)。tools/make_skin.py が
// tools/skinart/render.html で画像にする(アプリはこのコードを読まず、画像だけを使う)。このリポジトリで描いた独自のデザイン。
// 座標はすべて論理 px(1920×1080 の画面での px)で、表示の倍率は呼ぶ側の変換に任せる。枠の大きさと置き場所は
// js/ui/skin.js の GB_CHIPS_SRC / GB_NECK_SRC と GB_*(パネルの左端からの位置)。
//
//   チップ        角の丸い棒。上が明るく下へ濃くなる地に照りと縁(ドラムのチップと同じ作り)
//   ロングノート  チップより細い縦の帯(縦に一様。アプリが半透明で縦に伸ばす)
//   OPEN          5 レーンにわたる橙の棒。レーンの境目に小さな刻み
//   ウェイリング  水色の札に白い上向きの山形 2 つ(ネックを上げる合図)
//   ボタン列      金属の板に丸いボタン 5 つ(縁・色の付いた頭・下に R G B Y P の字)。点灯版は頭が光る
//   下の枠        ピックアップ(各レーンにポールピース)とブリッジ(各レーンにサドル)、ウェイリングの列の下にピック
//   パネルの地    黒いレーン、明るい芯の区切り線、中央の細いガイド、水色がかったウェイリングの列、両脇の金属の縁

import { shade, roundRectPath, drawJudgeArt } from './chips.js';
import {
  GB_PANEL, GB_LANE_X, GB_LANE_PITCH, GB_WAIL_COL, GB_HITBAR, GB_LANE_RGB, GB_OPEN_RGB, GB_WAIL_RGB, gbLaneCenterX,
} from '../../js/ui/skin.js';

/** レーンの色(R G B Y P)・OPEN・ウェイリング。DTXManiaAI の CUSTOM の配色(アプリの演出の色 GB_LANE_RGB などと同じ)。 */
const GB_ART_COLOR = GB_LANE_RGB;
const OPEN_COLOR = GB_OPEN_RGB;
const WAIL_COLOR = GB_WAIL_RGB;
const LETTERS = ['R', 'G', 'B', 'Y', 'P'];

const PANEL_W = 415.5; // パネルの絵の幅(画像の枠は 416。右端の 0.5 px は空ける)
const relX = (x) => x - GB_PANEL.x; // 画面の x → パネルの左端からの x
const SEP = (i) => relX(GB_LANE_X + GB_LANE_PITCH * i); // 区切り線の左端
const WAIL0 = relX(GB_WAIL_COL[0]);
const WAIL1 = relX(GB_WAIL_COL[1]);
const WAIL_CX = (WAIL0 + WAIL1) / 2;
const FONT = '"Segoe UI", "Noto Sans JP", sans-serif';

function rgba(c, a = 1) {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

function clipRect(g, w, h) {
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
}

/** 金属の板(縦のグラデーション)。 */
function metalPlate(g, x, y, w, h, top, bottom) {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, rgba(top));
  gr.addColorStop(1, rgba(bottom));
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

// ---- チップ ----

/** 棒 1 本(チップ・OPEN)を (0, 0)-(w, h) に描く。 */
function drawBar(g, c, w, h) {
  const r = Math.min(h * 0.3, w / 2);
  const body = g.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, shade(c, 0.55));
  body.addColorStop(0.42, shade(c, 0.06));
  body.addColorStop(1, shade(c, -0.42));
  roundRectPath(g, 0, 0, w, h, r);
  g.fillStyle = body;
  g.fill();
  // 上半分の照り
  const gloss = g.createLinearGradient(0, 0, w, 0);
  gloss.addColorStop(0, 'rgba(255,255,255,0.14)');
  gloss.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  gloss.addColorStop(1, 'rgba(255,255,255,0.14)');
  roundRectPath(g, 1.5, 1, w - 3, h * 0.4, r * 0.7);
  g.fillStyle = gloss;
  g.fill();
  // 上の縁の光・下の縁の影
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fillRect(r * 0.6, 0.5, w - r * 1.2, 1);
  g.fillStyle = shade(c, -0.62, 0.6);
  g.fillRect(r * 0.6, h - 1.6, w - r * 1.2, 1);
  // 輪郭
  roundRectPath(g, 0.5, 0.5, w - 1, h - 1, r - 0.5);
  g.lineWidth = 1;
  g.strokeStyle = shade(c, -0.5, 0.85);
  g.stroke();
}

/** チップ(lane 0..4)を (0, 0)-(w, h) に描く(w=56, h=15)。 */
export function drawGbChipArt(g, lane, w, h) {
  g.save();
  clipRect(g, w, h);
  drawBar(g, GB_ART_COLOR[lane], w, h);
  g.restore();
}

/** ロングノートの胴(縦に一様)。チップより細い帯で、中央が明るく両脇に細い光の線。 */
export function drawGbBodyArt(g, lane, w, h) {
  const c = GB_ART_COLOR[lane];
  const x0 = 8;
  const x1 = w - 8;
  g.save();
  clipRect(g, w, h);
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  gr.addColorStop(0, shade(c, -0.25));
  gr.addColorStop(0.5, shade(c, 0.5));
  gr.addColorStop(1, shade(c, -0.25));
  g.fillStyle = gr;
  g.fillRect(x0, 0, x1 - x0, h);
  g.fillStyle = shade(c, 0.7);
  g.fillRect(x0, 0, 1.5, h);
  g.fillRect(x1 - 1.5, 0, 1.5, h);
  g.restore();
}

/** OPEN の棒(w=294, h=14)。レーンの境目(区切り線の中心)の上下に小さな刻み。 */
export function drawGbOpenArt(g, w, h) {
  g.save();
  clipRect(g, w, h);
  drawBar(g, OPEN_COLOR, w, h);
  g.fillStyle = shade(OPEN_COLOR, -0.55, 0.75);
  const x0 = relX(GB_LANE_X + 3); // 棒の左端(最初のチップの左端)
  for (let i = 1; i <= 4; i++) {
    const x = SEP(i) + 1.5 - x0;
    g.fillRect(x - 1, 1, 2, 3);
    g.fillRect(x - 1, h - 4, 2, 3);
  }
  g.restore();
}

/** 上向きの山形(中心 cx, 頂点 y、幅 w、高さ h、線の太さ t)のパス。 */
function chevronPath(g, cx, y, w, h, t) {
  g.beginPath();
  g.moveTo(cx, y);
  g.lineTo(cx + w / 2, y + h);
  g.lineTo(cx + w / 2 - t, y + h + t * 0.2);
  g.lineTo(cx, y + t * 1.1);
  g.lineTo(cx - w / 2 + t, y + h + t * 0.2);
  g.lineTo(cx - w / 2, y + h);
  g.closePath();
}

/** ウェイリングチップ(w=81, h=102)。ウェイリングの列(枠の x 0〜57。列の中央は枠の x 25.5)の中央に札を置く。 */
export function drawGbWailArt(g, w, h) {
  const c = WAIL_COLOR;
  const cx = WAIL_CX - relX(1050.5); // 枠の左端は画面の 1050.5
  const bw = 46;
  const bh = 76;
  const y0 = (h - bh) / 2;
  g.save();
  clipRect(g, w, h);
  // 外側の光
  const glow = g.createRadialGradient(cx, h / 2, bw * 0.3, cx, h / 2, bh * 0.62);
  glow.addColorStop(0, rgba(c, 0.35));
  glow.addColorStop(1, rgba(c, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);
  // 札
  const body = g.createLinearGradient(0, y0, 0, y0 + bh);
  body.addColorStop(0, shade(c, 0.45));
  body.addColorStop(0.5, shade(c, 0));
  body.addColorStop(1, shade(c, -0.45));
  roundRectPath(g, cx - bw / 2, y0, bw, bh, 9);
  g.fillStyle = body;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = shade(c, -0.6, 0.9);
  g.stroke();
  roundRectPath(g, cx - bw / 2 + 3, y0 + 3, bw - 6, bh * 0.36, 6);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fill();
  // 山形 2 つ
  for (const [y, a] of [[y0 + 12, 1], [y0 + 38, 0.8]]) {
    chevronPath(g, cx, y, 30, 18, 7);
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.fill();
    g.lineWidth = 1.2;
    g.strokeStyle = shade(c, -0.6, 0.7);
    g.stroke();
  }
  // 右上のきらめき(枠の右の張り出し)
  const sx = cx + bw / 2 + 12;
  const sy = y0 + 6;
  g.fillStyle = 'rgba(235,255,255,0.9)';
  g.beginPath();
  g.moveTo(sx, sy - 9);
  g.lineTo(sx + 2.2, sy - 2.2);
  g.lineTo(sx + 9, sy);
  g.lineTo(sx + 2.2, sy + 2.2);
  g.lineTo(sx, sy + 9);
  g.lineTo(sx - 2.2, sy + 2.2);
  g.lineTo(sx - 9, sy);
  g.lineTo(sx - 2.2, sy - 2.2);
  g.closePath();
  g.fill();
  g.restore();
}

// ---- ネック(ボタン列・下の枠・判定ライン・パネルの地) ----

/** 上のボタン列(w=416, h=93)。lit なら全部のボタンが光った版(アプリはレーンの列の幅で切って重ねる)。 */
export function drawGbTopArt(g, lit, w, h) {
  g.save();
  clipRect(g, PANEL_W, h);
  metalPlate(g, 0, 0, PANEL_W, h, [54, 58, 68], [24, 26, 31]);
  // 上の縁の照りと、レーンに面した下の縁
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.fillRect(0, 0, PANEL_W, 1.5);
  g.fillStyle = 'rgb(96,102,116)';
  g.fillRect(0, h - 2.5, PANEL_W, 1.5);
  g.fillStyle = 'rgb(10,10,12)';
  g.fillRect(0, h - 1, PANEL_W, 1);
  // 両端のねじ
  for (const x of [14, PANEL_W - 14]) {
    for (const y of [16, h - 18]) screw(g, x, y);
  }
  const cy = 42;
  for (let i = 0; i < 5; i++) knob(g, GB_ART_COLOR[i], relX(gbLaneCenterX(i)), cy, LETTERS[i], lit, h);
  // ウェイリングの列の上: 上向きの山形と WAIL の字
  chevronPath(g, WAIL_CX, cy - 16, 26, 14, 5.5);
  g.fillStyle = rgba(WAIL_COLOR, 0.75);
  g.fill();
  chevronPath(g, WAIL_CX, cy + 2, 26, 14, 5.5);
  g.fillStyle = rgba(WAIL_COLOR, 0.45);
  g.fill();
  g.font = `bold 11px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(190,200,210,0.75)';
  g.fillText('WAIL', WAIL_CX, h - 15);
  g.restore();
}

function screw(g, x, y) {
  const gr = g.createRadialGradient(x - 1, y - 1, 0.5, x, y, 4);
  gr.addColorStop(0, 'rgb(170,176,188)');
  gr.addColorStop(1, 'rgb(70,74,84)');
  g.beginPath();
  g.arc(x, y, 3.6, 0, Math.PI * 2);
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = 'rgba(30,32,38,0.9)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 2.4, y + 0.6);
  g.lineTo(x + 2.4, y - 0.6);
  g.stroke();
}

/** ボタン 1 つ(中心 cx, cy)。縁の金属の輪・色の付いた頭・照り・下の字。 */
function knob(g, c, cx, cy, letter, lit, h) {
  if (lit) {
    const glow = g.createRadialGradient(cx, cy, 10, cx, cy, 28);
    glow.addColorStop(0, rgba(c, 0.75));
    glow.addColorStop(1, rgba(c, 0));
    g.fillStyle = glow;
    g.fillRect(cx - 29, cy - 29, 58, 58);
  }
  // 縁(左上が明るい金属の輪)
  const ring = g.createLinearGradient(cx - 21, cy - 21, cx + 21, cy + 21);
  ring.addColorStop(0, 'rgb(186,192,204)');
  ring.addColorStop(0.5, 'rgb(98,104,116)');
  ring.addColorStop(1, 'rgb(40,43,50)');
  g.beginPath();
  g.arc(cx, cy, 21, 0, Math.PI * 2);
  g.fillStyle = ring;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, 18, 0, Math.PI * 2);
  g.fillStyle = 'rgb(16,17,20)';
  g.fill();
  // 頭
  const cap = g.createRadialGradient(cx - 4, cy - 5, 1, cx, cy, 16.5);
  if (lit) {
    cap.addColorStop(0, 'rgb(255,255,255)');
    cap.addColorStop(0.35, shade(c, 0.45));
    cap.addColorStop(1, shade(c, -0.05));
  } else {
    cap.addColorStop(0, shade(c, -0.2));
    cap.addColorStop(1, shade(c, -0.68));
  }
  g.beginPath();
  g.arc(cx, cy, 16.5, 0, Math.PI * 2);
  g.fillStyle = cap;
  g.fill();
  // 照り
  g.beginPath();
  g.ellipse(cx - 4, cy - 7, 8, 4.5, -0.35, 0, Math.PI * 2);
  g.fillStyle = `rgba(255,255,255,${lit ? 0.55 : 0.2})`;
  g.fill();
  // 字
  g.font = `bold 14px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = lit ? 'rgb(255,255,255)' : shade(c, 0.15, 0.9);
  g.fillText(letter, cx, h - 15);
}

/** 下の枠(w=416, h=75)。lit ならピックとポールピースが光った版(ピックの瞬間に重ねる)。 */
export function drawGbBottomArt(g, lit, w, h) {
  g.save();
  clipRect(g, PANEL_W, h);
  metalPlate(g, 0, 0, PANEL_W, h, [26, 28, 33], [48, 52, 61]);
  // レーンに面した上の縁
  g.fillStyle = 'rgb(10,10,12)';
  g.fillRect(0, 0, PANEL_W, 1);
  g.fillStyle = 'rgb(96,102,116)';
  g.fillRect(0, 1, PANEL_W, 1.5);
  for (const x of [14, PANEL_W - 14]) screw(g, x, h - 14);

  const x0 = SEP(0) + 4;
  const x1 = SEP(5) - 1;
  // ピックアップ(黒い箱に各レーン 2 つずつのポールピース)
  roundRectPath(g, x0, 12, x1 - x0, 24, 5);
  g.fillStyle = 'rgb(14,15,18)';
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgb(112,118,132)';
  g.stroke();
  for (let i = 0; i < 5; i++) {
    const cx = relX(gbLaneCenterX(i));
    const c = GB_ART_COLOR[i];
    for (const y of [19, 29]) {
      if (lit) {
        const glow = g.createRadialGradient(cx, y, 0, cx, y, 9);
        glow.addColorStop(0, rgba(c, 0.8));
        glow.addColorStop(1, rgba(c, 0));
        g.fillStyle = glow;
        g.fillRect(cx - 9, y - 9, 18, 18);
      }
      const pole = g.createRadialGradient(cx - 1, y - 1, 0.3, cx, y, 3.6);
      pole.addColorStop(0, lit ? 'rgb(255,255,255)' : 'rgb(214,218,226)');
      pole.addColorStop(1, lit ? shade(c, 0.2) : 'rgb(96,100,110)');
      g.beginPath();
      g.arc(cx, y, 3.4, 0, Math.PI * 2);
      g.fillStyle = pole;
      g.fill();
    }
  }
  // ブリッジ(各レーンにサドル)
  metalPlate(g, x0, 46, x1 - x0, 12, [120, 126, 140], [60, 64, 74]);
  for (let i = 0; i < 5; i++) {
    const cx = relX(gbLaneCenterX(i));
    metalPlate(g, cx - 7, 44, 14, 8, [222, 226, 234], [130, 136, 148]);
  }
  // ピック(ウェイリングの列の下)
  const px = WAIL_CX;
  const py = h / 2 - 2;
  if (lit) {
    const glow = g.createRadialGradient(px, py, 4, px, py, 34);
    glow.addColorStop(0, 'rgba(255,236,190,0.85)');
    glow.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = glow;
    g.fillRect(px - 34, py - 34, 68, 68);
  }
  pickPath(g, px, py, 34, 38);
  const pick = g.createLinearGradient(px - 17, py - 19, px + 17, py + 19);
  if (lit) {
    pick.addColorStop(0, 'rgb(255,252,240)');
    pick.addColorStop(1, 'rgb(255,214,140)');
  } else {
    pick.addColorStop(0, 'rgb(214,206,190)');
    pick.addColorStop(1, 'rgb(128,118,104)');
  }
  g.fillStyle = pick;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = lit ? 'rgb(200,140,60)' : 'rgb(60,56,50)';
  g.stroke();
  pickPath(g, px, py - 2, 18, 20);
  g.strokeStyle = lit ? 'rgba(200,140,60,0.8)' : 'rgba(80,74,64,0.7)';
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

/** ピックの形(上が広く下が尖った丸い三角。中心 cx, cy、幅 w、高さ h)。 */
function pickPath(g, cx, cy, w, h) {
  const top = cy - h / 2;
  g.beginPath();
  g.moveTo(cx, cy + h / 2);
  g.bezierCurveTo(cx - w * 0.2, cy + h * 0.3, cx - w * 0.56, cy - h * 0.05, cx - w * 0.47, top + h * 0.12);
  g.bezierCurveTo(cx - w * 0.38, top - h * 0.04, cx + w * 0.38, top - h * 0.04, cx + w * 0.47, top + h * 0.12);
  g.bezierCurveTo(cx + w * 0.56, cy - h * 0.05, cx + w * 0.2, cy + h * 0.3, cx, cy + h / 2);
  g.closePath();
}

/** 判定ライン(w=378, h=9)。ドラムの判定ラインと同じ絵。 */
export function drawGbHitBarArt(g, w = GB_HITBAR.w, h = GB_HITBAR.h) {
  drawJudgeArt(g, w, h);
}

/** パネルの地(w=416, h は任意。縦に一様)。 */
export function drawGbStripArt(g, w, h) {
  g.save();
  clipRect(g, PANEL_W, h);
  // 両脇の金属の縁
  for (const [a, b] of [[0, SEP(0)], [WAIL1, PANEL_W]]) {
    const gr = g.createLinearGradient(a, 0, b, 0);
    gr.addColorStop(0, 'rgb(22,24,28)');
    gr.addColorStop(0.5, 'rgb(46,50,58)');
    gr.addColorStop(1, 'rgb(20,22,26)');
    g.fillStyle = gr;
    g.fillRect(a, 0, b - a, h);
  }
  g.fillStyle = 'rgba(150,158,176,0.55)';
  g.fillRect(SEP(0) - 3, 0, 1, h);
  g.fillRect(WAIL1 + 2, 0, 1, h);
  // レーン
  g.fillStyle = 'rgb(6,6,8)';
  g.fillRect(SEP(0), 0, WAIL0 - SEP(0), h);
  // レーンの中央のガイド(細い線と、両脇のかすかな明るみ)
  for (let i = 0; i < 5; i++) {
    const cx = relX(gbLaneCenterX(i));
    const gr = g.createLinearGradient(cx - 8, 0, cx + 8, 0);
    gr.addColorStop(0, 'rgba(40,42,48,0)');
    gr.addColorStop(0.5, 'rgba(40,42,48,0.6)');
    gr.addColorStop(1, 'rgba(40,42,48,0)');
    g.fillStyle = gr;
    g.fillRect(cx - 8, 0, 16, h);
    g.fillStyle = 'rgb(44,46,52)';
    g.fillRect(cx - 0.5, 0, 1, h);
  }
  // ウェイリングの列(水色がかった暗い地)
  const wg = g.createLinearGradient(WAIL0, 0, WAIL1, 0);
  wg.addColorStop(0, 'rgb(8,18,20)');
  wg.addColorStop(0.5, 'rgb(12,26,29)');
  wg.addColorStop(1, 'rgb(8,18,20)');
  g.fillStyle = wg;
  g.fillRect(WAIL0, 0, WAIL1 - WAIL0, h);
  // 区切り線(3 px: 暗い縁・明るい芯・暗い縁)
  for (let i = 0; i <= 5; i++) {
    const x = SEP(i);
    g.fillStyle = 'rgb(40,42,48)';
    g.fillRect(x, 0, 3, h);
    g.fillStyle = 'rgb(104,108,120)';
    g.fillRect(x + 1, 0, 1, h);
  }
  g.restore();
}
