// 譜面の編集画面の描画と当たり判定。
//
// x は演奏画面と同じ論理座標(1920 幅。LANE_X0 = 539、COLUMN_SLOT の列)で、列の絵(スキンのチップ・レーン帯・色)も
// 演奏画面と同じ。縦は u(js/edit/geometry.js)で、未来が上。再生位置の線(playhead)は画面の高さの 75 % に固定し、
// 譜面の方を動かす。DTXCreator の譜面(小節番号・ガイド線・拍線・小節線・BPM レーン。docs/spec/dtxcreator-ui.md §1.6)を
// 演奏画面の見た目で描いたもの。文字の大きさ・線の太さ・当たりの幅は CSS px で決めて倍率で割る(小さい画面でも読める)。

import { LANE_X0, LANE_W, LANE_RGB, columnRange, columnAtX } from '../ui/skin.js';
import { FONT } from '../ui/renderer.js';
import { formatBarLength } from './dtxdoc.js';
import { PX_PER_MEASURE } from './geometry.js';
import { lowerBoundU } from './model.js';
import { COLUMN_COUNT, COLUMN_TYPES, TYPE_BADGE, channelName, spriteLane } from './lanes.js';
import { t } from '../i18n.js';

/** 横の表示範囲(論理 px)。広い画面は BPM レーン・小節番号の欄・レーン帯・右の余白、狭い画面は小節番号の欄とレーン帯。 */
export const VIEWS = {
  wide: { x: 359, w: 1044, bpm: [363, 443], gutter: [447, 535] },
  compact: { x: 451, w: 876, bpm: null, gutter: [451, 535] },
};
/** これより狭いキャンバス(CSS px)は狭い配置。 */
export const COMPACT_BELOW = 720;
/** 上の列名の帯の高さ(CSS px)。 */
export const HEADER_CSS = 30;
/** 当たりの遊び(CSS px)。 */
export const HIT_TOL_CSS = { mouse: 5, pen: 5, touch: 14 };

const COL_GUIDE = 'rgb(40,40,40)';
const COL_BEAT = 'rgb(70,70,70)';
const COL_MEASURE = 'rgb(200,200,200)';
const COL_PLAYHEAD = 'rgb(255,214,64)';
const COL_GHOST = { add: '#00ff88', delete: '#ff5050', replace: '#ffb000', locked: '#888888' };

export class EditView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../ui/skin.js').Skin} skin
   */
  constructor(canvas, skin) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.skin = skin;
    this.layout = 'wide';
    this.view = VIEWS.wide;
    this.s = 1; // CSS px / 論理 px
    this.dpr = 1;
    this.offX = 0;
    this.cssW = 1;
    this.cssH = 1;
    this.H = 1; // 論理の高さ
    this.headY = 0;
    this.uHead = 0;
    this.zoom = 1;
    this.guide = 16;
    /** 描くもの(編集画面が毎回入れる)。 */
    this.state = {
      model: null, // EditModel
      activeTypes: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      pens: new Map(),
      selection: new Set(),
      ghost: null, // {column, u, channel, kind, half}
      preview: null, // {hide:Set<key>, targets:[{column, u, channel, value, half}], removeKeys:Set<key>}
      erase: null, // Set<key>(消す予定。薄く)
      paint: null, // [{column, u, channel, value}]
      band: null, // {x0, y0, x1, y1}(論理)
      showIds: false,
      loop: null, // {u0, u1}
      flash: new Map(), // 列 → 光らせる終わりの時刻(performance.now)
      suspects: null, // Map<key, conf>(vid2dtx の確信度)
    };
  }

  /** CSS px の大きさを論理 px に。 */
  css(px) {
    return px / this.s;
  }

  get ppu() {
    return PX_PER_MEASURE * this.zoom;
  }

  get headerH() {
    return this.css(HEADER_CSS);
  }

  /**
   * @param {number} cssW キャンバスの CSS 幅
   * @param {number} cssH
   * @param {number} dpr
   */
  resize(cssW, cssH, dpr = 1) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(2, dpr || 1);
    this.layout = this.cssW >= COMPACT_BELOW ? 'wide' : 'compact';
    this.view = VIEWS[this.layout];
    this.s = Math.min(this.cssW / this.view.w, 1);
    this.offX = (this.cssW - this.view.w * this.s) / 2;
    this.H = this.cssH / this.s;
    this.headY = Math.round(0.75 * this.H);
    const bw = Math.round(this.cssW * this.dpr);
    const bh = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
  }

  /** u → 論理 y。 */
  y(u) {
    return this.headY - (u - this.uHead) * this.ppu;
  }

  /** 論理 y → u。 */
  uAt(y) {
    return this.uHead + (this.headY - y) / this.ppu;
  }

  /** 見えている u の範囲。 */
  get uRange() {
    return { lo: this.uAt(this.H), hi: this.uAt(0) };
  }

  /** クライアント座標 → 論理座標。 */
  toLogical(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.offX) / this.s + this.view.x, y: (clientY - r.top) / this.s };
  }

  /** 論理座標 → クライアント座標(ポップオーバーの位置)。 */
  toClient(x, y) {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + this.offX + (x - this.view.x) * this.s, y: r.top + y * this.s };
  }

  /** チップの高さ(論理 px。拡大率 1 以上で演奏画面と同じ 15)。 */
  get chipH() {
    return Math.max(8, Math.min(15, Math.round(this.ppu / 27)));
  }

  /**
   * 当たり判定。region は 'header' / 'bpm' / 'gutter' / 'lanes' / null。lanes では column と half(列の左半分 1・右半分 2)。
   * @returns {{region: string|null, x:number, y:number, u:number, column:number, half:number}}
   */
  hit(clientX, clientY) {
    const { x, y } = this.toLogical(clientX, clientY);
    const u = this.uAt(y);
    const out = { region: null, x, y, u, column: -1, half: 0 };
    const col = columnAtX(x);
    if (y < this.headerH) {
      out.region = 'header';
      out.column = col;
      return out;
    }
    const v = this.view;
    if (v.bpm && x >= v.bpm[0] && x < v.bpm[1]) out.region = 'bpm';
    else if (x >= v.gutter[0] && x < v.gutter[1]) out.region = 'gutter';
    else if (col >= 0) {
      out.region = 'lanes';
      out.column = col;
      const [x0, x1] = columnRange(col);
      out.half = x < (x0 + x1) / 2 ? 1 : 2;
    }
    return out;
  }

  /** 当たりの遊び(u)。チップの半分の高さ + 入力の種類ごとの遊び。 */
  tolU(pointerType) {
    return (this.chipH / 2 + this.css(HIT_TOL_CSS[pointerType] || 5)) / this.ppu;
  }

  // ---- 描画 ----

  draw(perfNow = 0) {
    const g = this.g;
    const st = this.state;
    const m = st.model;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const k = this.s * this.dpr;
    g.setTransform(k, 0, 0, k, (this.offX - this.view.x * this.s) * this.dpr, 0);
    if (!m) return;
    const geo = m.geometry;
    const { lo, hi } = this.uRange;
    const v = this.view;
    const xL = v.bpm ? v.bpm[0] : v.gutter[0];
    const xR = LANE_X0 + LANE_W;

    // レーン帯・BPM レーン・小節番号の欄の地
    g.drawImage(this.skin.laneStrip(), LANE_X0, 0, LANE_W, this.H);
    g.fillStyle = 'rgba(255,255,255,0.03)';
    g.fillRect(v.gutter[0], 0, v.gutter[1] - v.gutter[0], this.H);
    if (v.bpm) {
      g.fillStyle = 'rgba(160,160,160,0.10)';
      g.fillRect(v.bpm[0], 0, v.bpm[1] - v.bpm[0], this.H);
    }
    // 列の光(打鍵の試し聞き)
    for (const [col, until] of st.flash) {
      const remain = until - perfNow;
      if (remain <= 0) continue;
      const [x0, x1] = columnRange(col);
      const rgbv = LANE_RGB[spriteLane(COLUMN_TYPES[col][0])] || LANE_RGB.CY;
      g.fillStyle = `rgba(${rgbv[0]},${rgbv[1]},${rgbv[2]},${0.25 * Math.min(1, remain / 150)})`;
      g.fillRect(x0, 0, x1 - x0, this.H);
    }

    // リードイン(小節 −1)と 999 小節より後ろ
    {
      const y0 = this.y(0);
      const y1 = this.y(-1);
      if (y1 > 0 && y0 < this.H) {
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(xL, y0, xR - xL, y1 - y0);
        g.fillStyle = 'rgba(220,220,220,0.6)';
        g.font = `${this.css(11)}px ${FONT}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(t('edit.leadIn'), (LANE_X0 + xR) / 2, Math.min(this.H - this.css(10), Math.max(this.headerH + this.css(10), (y0 + y1) / 2)));
      }
      const yEnd = this.y(geo.start(1000));
      if (yEnd > 0) {
        g.fillStyle = 'rgba(255,0,0,0.12)';
        g.fillRect(xL, 0, xR - xL, Math.min(this.H, yEnd));
      }
    }

    // ガイド線・拍線・小節線・小節番号
    const mLo = Math.max(-1, geo.measureAt(lo) - 1);
    const mHi = Math.min(1000, geo.measureAt(hi) + 1);
    const line = this.css(1);
    const d = this.guide;
    const showGuide = d > 0 && (this.ppu / d) * this.s >= 5;
    for (let mm = mLo; mm <= mHi; mm++) {
      const L = geo.len(mm);
      const u0 = geo.start(mm);
      if (showGuide) {
        g.fillStyle = COL_GUIDE;
        for (let kk = 1; kk / d < L - 1e-9; kk++) {
          const yy = this.y(u0 + kk / d);
          if (yy < 0 || yy > this.H) continue;
          g.fillRect(LANE_X0, yy - line / 2, LANE_W, line);
        }
      }
      g.fillStyle = COL_BEAT;
      for (let j = 1; j / 4 < L - 1e-9; j++) {
        const yy = this.y(u0 + j / 4);
        if (yy < 0 || yy > this.H) continue;
        g.fillRect(LANE_X0, yy - line / 2, LANE_W, line);
      }
      const ym = this.y(u0);
      if (ym < -this.css(20) || ym > this.H + this.css(20)) continue;
      g.fillStyle = COL_MEASURE;
      g.fillRect(xL, ym - line, xR - xL, line * 2);
      if (mm < 0) continue;
      g.textAlign = 'right';
      g.textBaseline = 'bottom';
      g.font = `bold ${this.css(13)}px ${FONT}`;
      g.fillStyle = 'rgb(220,220,220)';
      g.fillText(String(mm).padStart(3, '0'), v.gutter[1] - this.css(4), ym - this.css(2));
      if (Math.abs(L - geo.len(mm - 1)) > 1e-9) {
        g.font = `${this.css(11)}px ${FONT}`;
        g.fillStyle = 'rgb(255,200,120)';
        g.textBaseline = 'top';
        g.fillText(barLengthLabel(L), v.gutter[1] - this.css(4), ym + this.css(2));
      }
    }

    // ループの範囲
    if (st.loop) {
      for (const [u, color] of [[st.loop.u0, 'rgba(102,255,128,0.85)'], [st.loop.u1, 'rgba(255,115,115,0.85)']]) {
        const yy = this.y(u);
        if (yy < 0 || yy > this.H) continue;
        g.fillStyle = color;
        g.fillRect(LANE_X0, yy - this.css(1.5), LANE_W, this.css(3));
      }
    }

    // BGM・フィルインの印(小節番号の欄)
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = `${this.css(11)}px ${FONT}`;
    for (const b of m.bgm) {
      const yy = this.y(b.u);
      if (yy < 0 || yy > this.H) continue;
      g.fillStyle = 'rgb(160,220,255)';
      g.fillText('♪', v.gutter[0] + this.css(2), yy);
    }
    for (const f of m.fills) {
      const yy = this.y(f.u);
      if (yy < 0 || yy > this.H) continue;
      g.fillStyle = 'rgba(255,230,80,0.9)';
      g.fillRect(v.gutter[0] + this.css(14), yy - this.css(1), this.css(8), this.css(2));
    }

    // 隠しチップ(点線の枠)
    const ch = this.chipH;
    g.save();
    g.setLineDash([this.css(3), this.css(3)]);
    g.lineWidth = this.css(1.5);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let i = lowerBoundU(m.hidden, lo - 1); i < m.hidden.length && m.hidden[i].u <= hi + 1; i++) {
      const h = m.hidden[i];
      const [x0, x1] = columnRange(h.column);
      g.strokeRect(x0 + 2, this.y(h.u) - ch / 2, x1 - x0 - 4, ch);
    }
    g.restore();

    // チップ(遅いものから描き、近いものを上に)
    const hide = st.preview ? st.preview.hide : null;
    const removeKeys = st.preview ? st.preview.removeKeys : null;
    const pad = (ch / 2 + this.css(2)) / this.ppu;
    for (let col = 0; col < COLUMN_COUNT; col++) {
      const list = m.byColumn[col];
      const i0 = lowerBoundU(list, lo - pad);
      const i1 = lowerBoundU(list, hi + pad);
      for (let i = i1 - 1; i >= i0; i--) {
        const c = list[i];
        if (c.locked && !c.active) continue;
        if (hide && hide.has(c.key)) continue;
        if (c.n > 0) continue; // 重なった同じチップは 1 つだけ描き、×n を付ける
        const alpha = st.erase && st.erase.has(c.key) ? 0.25 : c.locked ? 0.45 : 1;
        this._chip(c.column, c.u, c.channel, c.half, alpha);
        const y = this.y(c.u);
        const [x0, x1] = this._chipX(c.column, c.half);
        if (c.locked) this._hatch(x0, y - ch / 2, x1 - x0, ch);
        if (c.bonus) this._frame(x0, y - ch / 2, x1 - x0, ch, 'rgba(255,230,80,0.9)', this.css(2));
        if (st.selection.has(c.key)) {
          g.fillStyle = 'rgba(255,255,255,0.15)';
          g.fillRect(x0, y - ch / 2, x1 - x0, ch);
          this._frame(x0, y - ch / 2, x1 - x0, ch, '#fff', this.css(2));
        }
        if (st.suspects && st.suspects.has(c.key)) {
          const cf = st.suspects.get(c.key);
          this._frame(x0 - this.css(3), y - ch / 2 - this.css(3), x1 - x0 + this.css(6), ch + this.css(6), cf < 0.4 ? 'rgb(255,0,0)' : 'rgb(255,150,0)', this.css(2));
        }
        if (removeKeys && removeKeys.has(c.key)) this._cross(x0, y - ch / 2, x1 - x0, ch);
        if (c.dup > 1) this._badge(`×${c.dup}`, x0, y, '#fff');
        if (!m.chart.wavDefs.has(c.value)) this._badge('?', x1 - this.css(14), y, 'rgb(255,200,120)');
        else if (st.showIds) this._badge(c.value, x0 + this.css(2), y, '#fff');
      }
    }
    // 塗りの途中・動かしている先
    if (st.paint) for (const p of st.paint) this._chip(p.column, p.u, p.channel, p.half || 0, 1);
    if (st.preview) {
      for (const p of st.preview.targets) {
        this._chip(p.column, p.u, p.channel, p.half || 0, 0.85);
        const [x0, x1] = this._chipX(p.column, p.half || 0);
        this._frame(x0, this.y(p.u) - ch / 2, x1 - x0, ch, 'rgb(102,217,255)', this.css(2));
      }
    }
    // 置く位置の影
    if (st.ghost) {
      const gh = st.ghost;
      g.save();
      if (gh.kind === 'add' || gh.kind === 'replace') {
        g.globalAlpha = 0.4;
        this._chip(gh.column, gh.u, gh.channel, gh.half || 0, 1);
        g.globalAlpha = 1;
      }
      const [x0, x1] = this._chipX(gh.column, gh.half || 0);
      this._frame(x0, this.y(gh.u) - ch / 2 - this.css(1), x1 - x0, ch + this.css(2), COL_GHOST[gh.kind] || COL_GHOST.add, this.css(2));
      g.restore();
    }
    // 範囲選択の枠
    if (st.band) {
      const b = st.band;
      const x = Math.min(b.x0, b.x1);
      const y = Math.min(b.y0, b.y1);
      g.fillStyle = 'rgba(55,55,255,0.31)';
      g.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      this._frame(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0), 'lightblue', this.css(1));
    }

    // BPM の印
    g.font = `${this.css(11)}px ${FONT}`;
    g.textBaseline = 'middle';
    for (const b of m.bpmMarks) {
      const yy = this.y(b.u);
      if (yy < -20 || yy > this.H + 20) continue;
      const text = b.bpm === null ? '?' : formatBpmShort(b.bpm);
      const sel = st.selection.has(b.key);
      if (v.bpm) {
        const ph = this.css(18);
        g.fillStyle = b.locked ? 'rgba(160,160,160,0.3)' : sel ? 'rgba(255,255,255,0.85)' : 'rgba(160,160,160,0.6)';
        roundRect(g, v.bpm[0] + this.css(2), yy - ph / 2, v.bpm[1] - v.bpm[0] - this.css(4), ph, this.css(4));
        g.fill();
        if (b.channel === 0x03) {
          g.save();
          g.setLineDash([this.css(2), this.css(2)]);
          g.strokeStyle = '#fff';
          g.lineWidth = this.css(1);
          g.stroke();
          g.restore();
        }
        g.fillStyle = sel ? '#000' : '#fff';
        g.textAlign = 'center';
        g.fillText(text, (v.bpm[0] + v.bpm[1]) / 2, yy);
      } else {
        g.fillStyle = 'rgb(200,200,200)';
        g.textAlign = 'left';
        g.fillText('♩' + text, v.gutter[0] + this.css(2), yy + this.css(10));
      }
    }

    // 再生位置
    g.fillStyle = COL_PLAYHEAD;
    g.fillRect(xL, this.headY - this.css(1.5), xR - xL, this.css(3));
    g.font = `${this.css(12)}px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('▶', v.gutter[0] + this.css(1), this.headY);

    // 上の列名の帯(DTXCreator のレーン名の帯)
    const hh = this.headerH;
    const grad = g.createLinearGradient(0, 0, 0, hh);
    grad.addColorStop(0, 'rgba(0,0,100,0.95)');
    grad.addColorStop(1, 'rgba(0,0,60,0.75)');
    g.fillStyle = grad;
    g.fillRect(xL, 0, xR - xL, hh);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let col = 0; col < COLUMN_COUNT; col++) {
      const chn = COLUMN_TYPES[col][st.activeTypes[col] || 0];
      const [x0, x1] = columnRange(col);
      g.font = `bold ${this.css(11)}px ${FONT}`;
      g.fillStyle = COLUMN_TYPES[col].length > 1 ? 'rgb(255,230,150)' : 'rgb(220,220,220)';
      g.fillText(channelName(chn), (x0 + x1) / 2, hh * 0.36);
      g.font = `${this.css(10)}px ${FONT}`;
      g.fillStyle = 'rgb(170,170,200)';
      g.fillText(st.pens.get(chn) || '--', (x0 + x1) / 2, hh * 0.78);
    }
    g.font = `${this.css(10)}px ${FONT}`;
    g.fillStyle = 'rgb(170,170,200)';
    g.fillText('BPM', v.bpm ? (v.bpm[0] + v.bpm[1]) / 2 : v.gutter[0] + this.css(14), hh / 2);
  }

  /** チップの x 範囲(左右に分けたセルなら半分)。 */
  _chipX(column, half) {
    const [x0, x1] = columnRange(column);
    const w = x1 - x0 - 4;
    const left = x0 + 2;
    if (!half) return [left, left + w];
    const hw = (w - 2) / 2;
    return half === 1 ? [left, left + hw] : [left + hw + 2, left + w];
  }

  /** チップ 1 つ(スキンの絵。2 つ目の種類は両端を暗くして右端に印)。 */
  _chip(column, u, channel, half, alpha) {
    const g = this.g;
    const y = this.y(u);
    if (y < -20 || y > this.H + 20) return;
    const ch = this.chipH;
    const [x0, x1] = this._chipX(column, half);
    const lane = spriteLane(channel) || 'CY';
    const [cx0, cx1] = columnRange(column);
    const full = cx1 - cx0 - 4;
    const sprite = this.skin._chipSprite(lane, full, ch, this.s * this.dpr);
    g.save();
    g.globalAlpha *= alpha;
    g.drawImage(sprite, x0, y - ch / 2, x1 - x0, ch);
    const badge = TYPE_BADGE[channel];
    if (badge) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      const e = Math.min(10, (x1 - x0) / 4);
      g.fillRect(x0, y - ch / 2, e, ch);
      g.fillRect(x1 - e, y - ch / 2, e, ch);
      g.font = `bold ${this.css(10)}px ${FONT}`;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.lineWidth = this.css(3);
      g.strokeStyle = '#000';
      g.strokeText(badge, x1 - this.css(1), y);
      g.fillStyle = '#fff';
      g.fillText(badge, x1 - this.css(1), y);
    }
    g.restore();
  }

  _frame(x, y, w, h, color, lw) {
    const g = this.g;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.strokeRect(x - lw / 2, y - lw / 2, w + lw, h + lw);
  }

  _hatch(x, y, w, h) {
    const g = this.g;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = this.css(1.5);
    for (let xx = x - h; xx < x + w; xx += this.css(6)) {
      g.beginPath();
      g.moveTo(xx, y + h);
      g.lineTo(xx + h, y);
      g.stroke();
    }
    g.restore();
  }

  _cross(x, y, w, h) {
    const g = this.g;
    g.save();
    g.strokeStyle = 'rgb(255,80,80)';
    g.lineWidth = this.css(2);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(h, this.css(8));
    g.beginPath();
    g.moveTo(cx - r, cy - r);
    g.lineTo(cx + r, cy + r);
    g.moveTo(cx + r, cy - r);
    g.lineTo(cx - r, cy + r);
    g.stroke();
    g.restore();
  }

  _badge(text, x, y, color) {
    const g = this.g;
    g.save();
    g.font = `bold ${this.css(10)}px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.lineWidth = this.css(3);
    g.strokeStyle = '#000';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.restore();
  }
}

/** 小節長の印: 4 / 8 / 16 分の何拍で書けるなら n/d、無理なら ×倍率。 */
export function barLengthLabel(L) {
  for (const d of [4, 8, 16]) {
    const n = L * d;
    if (Math.abs(n - Math.round(n)) < 1e-6) return `${Math.round(n)}/${d}`;
  }
  return '×' + formatBarLength(L);
}

/** BPM の表示(小数 2 桁まで)。 */
export function formatBpmShort(v) {
  return String(Math.round(v * 100) / 100);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
