// 既定のスキン(skins/default/)のチップと判定ラインの絵。tools/make_skin.py が tools/skinart/render.html で
// 画像にする(アプリはこのコードを読まず、画像だけを使う)。このリポジトリで描いた独自のデザイン。

// ---- 色 ----

/** レーンの色(チップ・パッドの縁)。RD は CY と同じ。色分けはレーンを見分けるためのもので、DTX の慣習に合わせる。 */
export const LANE_ART_COLOR = {
  LC: [255, 58, 150], HH: [44, 150, 255], LP: [255, 92, 176], SD: [255, 206, 32], BD: [150, 104, 255],
  HT: [40, 210, 80], LT: [255, 62, 62], FT: [255, 150, 30], CY: [44, 150, 255], RD: [44, 150, 255],
};

/** 色 c を白(t > 0)か黒(t < 0)へ |t| だけ寄せた CSS 色。 */
export function shade(c, t, a = 1) {
  const to = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  const ch = (v) => Math.round(v + (to - v) * k);
  return `rgba(${ch(c[0])},${ch(c[1])},${ch(c[2])},${a})`;
}

/** 角の丸い長方形のパス(半径は辺の半分まで)。 */
export function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

// ---- チップ ----
// 角の丸い横長の棒。上が明るく下へ濃くなる地に、上半分の照り・上の縁の細い光・下の縁の影を重ねる。

/**
 * チップ 1 個を (0, 0)-(w, h) いっぱいに描く。w, h は表示の画素数(呼ぶ側で変換を掛けない)。
 */
export function drawChipArt(g, laneName, w, h) {
  const c = LANE_ART_COLOR[laneName] || LANE_ART_COLOR.CY;
  const r = Math.min(h * 0.34, w / 2);
  const line = Math.max(1, h / 15); // 縁の線の太さ(高さ 15px で 1px)
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();

  // 地
  const body = g.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, shade(c, 0.5));
  body.addColorStop(0.45, shade(c, 0.05));
  body.addColorStop(1, shade(c, -0.38));
  roundRectPath(g, 0, 0, w, h, r);
  g.fillStyle = body;
  g.fill();

  // 上半分の照り(両端は少し控えめ)
  const gloss = g.createLinearGradient(0, 0, w, 0);
  gloss.addColorStop(0, 'rgba(255,255,255,0.16)');
  gloss.addColorStop(0.5, 'rgba(255,255,255,0.42)');
  gloss.addColorStop(1, 'rgba(255,255,255,0.16)');
  roundRectPath(g, line * 1.5, line, w - line * 3, h * 0.42, r * 0.8);
  g.fillStyle = gloss;
  g.fill();

  // 上の縁の光と下の縁の影
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fillRect(r * 0.6, line * 0.5, w - r * 1.2, line);
  g.fillStyle = shade(c, -0.6, 0.55);
  g.fillRect(r * 0.6, h - line * 1.5, w - r * 1.2, line);

  // 輪郭
  roundRectPath(g, line / 2, line / 2, w - line, h - line, r - line / 2);
  g.lineWidth = line;
  g.strokeStyle = shade(c, -0.45, 0.8);
  g.stroke();
  g.restore();
}

// ---- 判定ライン ----
// 明るい芯の線と、その上下に広がる琥珀色のにじみ。両端は丸める。

/** 判定ラインを (0, 0)-(w, h) に描く(w=780, h=11 の論理 px。表示の倍率は呼ぶ側の変換に任せる)。 */
export function drawJudgeArt(g, w, h) {
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();

  const halo = g.createLinearGradient(0, 0, 0, h);
  halo.addColorStop(0, 'rgba(255,170,30,0.12)');
  halo.addColorStop(0.3, 'rgba(255,184,48,0.55)');
  halo.addColorStop(0.5, 'rgba(255,214,110,0.95)');
  halo.addColorStop(0.7, 'rgba(255,184,48,0.55)');
  halo.addColorStop(1, 'rgba(255,170,30,0.12)');
  roundRectPath(g, 0, 0, w, h, h / 2);
  g.fillStyle = halo;
  g.fill();

  // 芯(中央が白く、両端へ向かって金色)
  const coreH = Math.max(1.5, h * 0.24);
  const core = g.createLinearGradient(0, 0, w, 0);
  core.addColorStop(0, 'rgba(255,214,90,0.9)');
  core.addColorStop(0.12, 'rgba(255,246,206,1)');
  core.addColorStop(0.88, 'rgba(255,246,206,1)');
  core.addColorStop(1, 'rgba(255,214,90,0.9)');
  roundRectPath(g, h * 0.3, (h - coreH) / 2, w - h * 0.6, coreH, coreH / 2);
  g.fillStyle = core;
  g.fill();
  g.restore();
}
