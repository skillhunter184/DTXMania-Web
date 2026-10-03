// 既定のスキン(skins/default/)のパッドの絵。tools/make_skin.py が tools/skinart/render.html で画像にする
// (アプリはこのコードを読まず、画像だけを使う)。このリポジトリで描いた独自のデザイン。枠の大きさは js/ui/skin.js の PAD_SRC。
//
// 少し上から見たドラムセットの部品を図形で描く:
//   太鼓(SD HT LT FT)   打面の楕円と胴。打面の縁をレーンの色の輪で囲む
//   シンバル(LC CY)     斜めに傾いた皿とスタンド。外周をレーンの色で縁取り、溝とカップを描く
//   ハイハット(HH)      上下 2 枚の皿とスタンド
//   ペダル(LP BD)       踏み板(つま先にレーンの色の帯、滑り止めの横棒)とかかとの台
// 点灯版は打面・皿・踏み板をレーンの色で明るく塗り、内側から光らせる。

import { LANE_ART_COLOR, shade, roundRectPath } from './chips.js';

const KIND = {
  LC: 'cymbal', HH: 'hihat', LP: 'pedal', SD: 'drum', HT: 'drum', BD: 'pedal', LT: 'drum', FT: 'drum', CY: 'cymbal',
};
/** シンバルの傾き(度)。左右のシンバルは外側を下げる。 */
const TILT = { LC: -7, CY: 7, HH: 0 };

const HEAD = [216, 219, 224]; // 打面・皿・踏み板の地(消灯)
const SHELL = [104, 110, 120]; // 胴・スタンド
const DARK = [62, 66, 74];

function ellipsePath(g, cx, cy, rx, ry, rot = 0) {
  g.beginPath();
  g.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
}

/** 打面・皿などの面の塗り(消灯は灰色、点灯はレーンの色)。中心がいちばん明るい。 */
function faceFill(g, c, lit, cx, cy, r) {
  const gr = g.createRadialGradient(cx, cy - r * 0.35, r * 0.05, cx, cy, r);
  if (lit) {
    gr.addColorStop(0, shade(c, 0.85));
    gr.addColorStop(0.6, shade(c, 0.5));
    gr.addColorStop(1, shade(c, 0.2));
  } else {
    gr.addColorStop(0, shade(HEAD, 0.45));
    gr.addColorStop(0.7, shade(HEAD, 0));
    gr.addColorStop(1, shade(HEAD, -0.14));
  }
  return gr;
}

function drawDrum(g, c, lit, w, h) {
  const cx = w / 2;
  const rx = w * 0.44;
  const ry = h * 0.19;
  const top = h * 0.42; // 打面の中心
  const depth = h * 0.17; // 胴の高さ
  // 胴
  const shell = g.createLinearGradient(cx - rx, 0, cx + rx, 0);
  shell.addColorStop(0, shade(SHELL, -0.3));
  shell.addColorStop(0.35, shade(SHELL, 0.25));
  shell.addColorStop(1, shade(SHELL, -0.4));
  g.beginPath();
  g.ellipse(cx, top + depth, rx, ry, 0, 0, Math.PI);
  g.lineTo(cx - rx, top);
  g.ellipse(cx, top, rx, ry, 0, Math.PI, 0, true);
  g.closePath();
  g.fillStyle = shell;
  g.fill();
  // 胴の下寄りの帯(レーンの色を暗くしたもの。胴の丸みに沿わせる)
  g.save();
  g.clip();
  g.beginPath();
  g.ellipse(cx, top + depth * 0.72, rx, ry, 0, 0, Math.PI);
  g.lineWidth = depth * 0.32;
  g.strokeStyle = shade(c, lit ? -0.1 : -0.45, lit ? 0.9 : 0.75);
  g.stroke();
  g.restore();
  // 打面
  ellipsePath(g, cx, top, rx, ry);
  g.fillStyle = faceFill(g, c, lit, cx, top, rx);
  g.fill();
  // 縁の輪
  const ring = Math.max(2.5, h * 0.045);
  ellipsePath(g, cx, top, rx - ring / 2, ry - ring / 2);
  g.lineWidth = ring;
  g.strokeStyle = lit ? shade(c, 0.15) : shade(c, 0);
  g.stroke();
  // 打面の中心の印
  ellipsePath(g, cx, top + ry * 0.05, rx * 0.16, ry * 0.2);
  g.fillStyle = lit ? 'rgba(255,255,255,0.7)' : 'rgba(120,126,136,0.35)';
  g.fill();
}

/** シンバル 1 枚(中心 cx, cy、半径 rx, ry、傾き rot ラジアン)。 */
function drawPlate(g, c, lit, cx, cy, rx, ry, rot) {
  const thick = ry * 0.22;
  // 皿の厚み(下側)
  ellipsePath(g, cx, cy + thick, rx, ry, rot);
  g.fillStyle = shade(lit ? c : SHELL, lit ? -0.25 : -0.15);
  g.fill();
  // 皿の面
  ellipsePath(g, cx, cy, rx, ry, rot);
  g.fillStyle = faceFill(g, c, lit, cx, cy, rx);
  g.fill();
  // 溝
  g.lineWidth = Math.max(0.8, ry * 0.05);
  g.strokeStyle = lit ? 'rgba(255,255,255,0.45)' : 'rgba(90,96,108,0.35)';
  for (const k of [0.45, 0.68]) {
    ellipsePath(g, cx, cy, rx * k, ry * k, rot);
    g.stroke();
  }
  // 外周の縁取り
  const band = Math.max(2.5, ry * 0.2);
  ellipsePath(g, cx, cy, rx - band / 2, ry - band / 2, rot);
  g.lineWidth = band;
  g.strokeStyle = lit ? shade(c, 0.1) : shade(c, 0);
  g.stroke();
  // カップ
  ellipsePath(g, cx, cy - ry * 0.08, rx * 0.17, ry * 0.3, rot);
  g.fillStyle = lit ? shade(c, 0.9) : shade(HEAD, 0.5);
  g.fill();
  g.lineWidth = Math.max(0.8, ry * 0.06);
  g.strokeStyle = lit ? shade(c, 0.3) : 'rgba(110,116,128,0.6)';
  g.stroke();
}

function drawStand(g, cx, y0, y1, w) {
  const sw = Math.max(2, w * 0.045);
  g.fillStyle = shade(SHELL, 0.1);
  g.fillRect(cx - sw / 2, y0, sw, y1 - y0);
  g.fillStyle = shade(DARK, 0);
  roundRectPath(g, cx - w * 0.16, y1 - sw * 0.6, w * 0.32, sw * 1.2, sw * 0.6);
  g.fill();
}

function drawCymbal(g, name, c, lit, w, h) {
  const cx = w / 2;
  const cy = h * 0.4;
  drawStand(g, cx, cy, h * 0.93, w);
  drawPlate(g, c, lit, cx, cy, w * 0.47, h * 0.23, ((TILT[name] || 0) * Math.PI) / 180);
}

function drawHihat(g, c, lit, w, h) {
  const cx = w / 2;
  drawStand(g, cx, h * 0.3, h * 0.93, w);
  // 下の皿(少し小さく暗い)は点灯しない
  drawPlate(g, c, false, cx, h * 0.5, w * 0.44, h * 0.15, 0);
  drawPlate(g, c, lit, cx, h * 0.34, w * 0.47, h * 0.2, 0);
}

function drawPedal(g, c, lit, w, h) {
  const cx = w / 2;
  const topY = h * 0.08;
  const botY = h * 0.8;
  const topW = w * 0.52;
  const botW = w * 0.74;
  const r = w * 0.1;
  // かかとの台
  g.fillStyle = shade(DARK, 0.05);
  roundRectPath(g, cx - w * 0.42, h * 0.76, w * 0.84, h * 0.17, w * 0.06);
  g.fill();
  // 踏み板(上が狭い台形。角を丸める)
  const board = () => {
    g.beginPath();
    g.moveTo(cx, topY);
    g.arcTo(cx + topW / 2, topY, cx + botW / 2, botY, r);
    g.arcTo(cx + botW / 2, botY, cx - botW / 2, botY, r);
    g.arcTo(cx - botW / 2, botY, cx - topW / 2, topY, r);
    g.arcTo(cx - topW / 2, topY, cx, topY, r);
    g.closePath();
  };
  board();
  const plate = g.createLinearGradient(0, topY, 0, botY);
  if (lit) {
    plate.addColorStop(0, shade(c, 0.75));
    plate.addColorStop(1, shade(c, 0.35));
  } else {
    plate.addColorStop(0, shade(HEAD, 0.3));
    plate.addColorStop(1, shade(HEAD, -0.12));
  }
  g.fillStyle = plate;
  g.fill();
  // つま先の帯
  g.save();
  board();
  g.clip();
  g.fillStyle = lit ? shade(c, 0.05) : shade(c, -0.05);
  g.fillRect(0, topY, w, h * 0.1);
  g.restore();
  // 滑り止め
  g.fillStyle = lit ? shade(c, -0.35, 0.75) : 'rgba(80,86,96,0.7)';
  const n = 4;
  for (let i = 0; i < n; i++) {
    const y = h * (0.28 + i * 0.12);
    const t = (y - topY) / (botY - topY);
    const half = (topW + (botW - topW) * t) / 2 - w * 0.1;
    roundRectPath(g, cx - half, y, half * 2, Math.max(2, h * 0.035), h * 0.02);
    g.fill();
  }
  // 輪郭
  board();
  g.lineWidth = Math.max(1.5, w * 0.025);
  g.strokeStyle = lit ? shade(c, -0.2) : 'rgba(150,156,166,0.9)';
  g.stroke();
}

/**
 * パッド 1 つを (0, 0)-(w, h) に描く(w は PAD_SRC の幅、h は PAD_H。論理 px。表示の倍率は呼ぶ側の変換に任せる)。
 * lit なら点灯版。
 */
export function drawPadArt(g, name, lit, w, h) {
  const c = LANE_ART_COLOR[name] || LANE_ART_COLOR.CY;
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
  if (lit) {
    // 内側からの光(枠の中に収める)
    const glow = g.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.6);
    glow.addColorStop(0, shade(c, 0.3, 0.55));
    glow.addColorStop(1, shade(c, 0, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
  }
  const kind = KIND[name] || 'drum';
  if (kind === 'drum') drawDrum(g, c, lit, w, h);
  else if (kind === 'cymbal') drawCymbal(g, name, c, lit, w, h);
  else if (kind === 'hihat') drawHihat(g, c, lit, w, h);
  else drawPedal(g, c, lit, w, h);
  g.restore();
}
