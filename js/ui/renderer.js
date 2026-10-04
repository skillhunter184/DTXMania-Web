// 演奏画面の描画(vid2dtx preview.py の合成順を Canvas に移植し、判定・コンボ・パネル類を加えたもの)。
// 論理座標は 1920x1080。横画面は全体を、縦画面(スマホ)はハイウェイ部分だけを切り出して拡大表示する。

import {
  CANVAS_W, CANVAS_H, LANE_X0, LANE_W, LANE_Y0, LANE_Y1, JUDGE_Y, PADS_Y,
  COLUMN_ORDER, LANE_TO_COLUMN, COLUMN_SLOT, LANE_RGB, PANELS, columnCenterX, columnRange, columnAtX,
} from './skin.js';
import { LANE_NAMES } from '../core/dtx.js';
import { JUDGE } from '../game/hitranges.js';
import { GAUGE_DANGER } from '../game/judge.js';
import { PLAYER_STATE } from '../game/player.js';
import { t } from '../i18n.js';

const JUDGE_TEXT = ['PERFECT', 'GREAT', 'GOOD', 'OK', 'MISS'];
const JUDGE_COLOR = ['rgb(255,242,77)', 'rgb(102,255,128)', 'rgb(102,204,255)', 'rgb(204,128,255)', 'rgb(255,102,102)'];
export const FONT = '"Segoe UI", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif';
const PORTRAIT_MARGIN = 80;

// 演出の下敷き(元実装に無い追加)。新しい Renderer の最初の数フレームは、演奏中に出る演出を本番と同じ関数で
// 静止部分 base の下(全面の黒塗りの後、base を貼る前)に描く。base に覆われるので画面は変わらない。
// Chrome は初めて使う描き方の GPU シェーダをそれを描いたフレームで作るので、ページを開いて最初の曲の最初の打撃で
// 25〜39 ms(シェーダのキャッシュが冷えているとき。Skia Graphite では起動のたびに 0.15〜0.3 秒)止まっていた。
// それを待機中に済ませる。1 回だけ描く・rAF の外で描く・作業用キャンバスに描いて読み戻す、では効かなかった(実測)。
// 年齢はファイアの半径・判定文字の伸縮の各段を通すもの(レーンごとに 21 ms ずらして広く通す)。
// 演出の描き方を足したら _drawWarm にも足すこと。
const WARM_AGES = [1, 3, 10, 30, 120, 200, 205, 209, 245, 280];

/**
 * ドラムの演奏画面。ギター / ベースの画面(js/ui/gbrenderer.js の GuitarRenderer)はこれを継ぎ、静止部分・演奏面・
 * 下敷きと、HUD の置き場所(_hudAnchors など)だけを差し替える(成績のパネル・ゲージ・進捗バー・コンボは共通)。
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./skin.js').Skin} skin
   * @param {import('../game/player.js').Player} player
   */
  constructor(canvas, skin, player) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.skin = skin;
    this.player = player;
    this.showLag = true;
    this.mode = 'landscape';
    this.view = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this._base = null;
    this._baseKey = '';
    this._warm = WARM_AGES.length; // 残りの下敷きのフレーム数
    this.songInfo = { title: '', artist: '', level: '', jacket: null };
  }

  /**
   * 表示サイズを設定する。mode は 'landscape' / 'portrait' / 'auto'。
   * topInset は上部のボタン列の高さ(CSS px。縦画面でハイウェイをその下に寄せる)。
   */
  resize(cssW, cssH, dpr = 1, mode = 'auto', topInset = 52) {
    this.cssW = cssW;
    this.cssH = cssH;
    const aspect = cssW / Math.max(1, cssH);
    this.mode = mode === 'auto' ? (aspect < 1.2 ? 'portrait' : 'landscape') : mode;
    if (this.mode === 'portrait') {
      const { x: vx, w: vw } = this._portraitView();
      this.view = { x: vx, y: 0, w: vw, h: CANVAS_H };
    } else {
      this.view = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
    }
    this.scale = Math.min(cssW / this.view.w, cssH / this.view.h);
    this.offsetX = (cssW - this.view.w * this.scale) / 2;
    this.offsetY = (cssH - this.view.h * this.scale) / 2;
    // 縦画面では上寄せにして、下の余白をメニュー(ボトムシート)に使う
    if (this.mode === 'portrait') this.offsetY = Math.min(this.offsetY, topInset);
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.dpr = dpr;
    this._releaseBase();
  }

  /** 静止部分の作り置きを捨てる。古い画素はすぐ手放す(キャンバスと同じ大きさなので、iOS のキャンバスの総量の上限に効く)。 */
  _releaseBase() {
    if (this._base) this._base.width = this._base.height = 0;
    this._base = null;
  }

  /** CSS ピクセル → 論理座標。 */
  toLogical(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = (clientX - r.left - this.offsetX) / this.scale + this.view.x;
    const y = (clientY - r.top - this.offsetY) / this.scale + this.view.y;
    return { x, y };
  }

  /** タッチのヒット判定: ハイウェイ内(上端〜画面下)の列 → レーン番号(RD は CY 列に統合)。 */
  hitTestLane(clientX, clientY) {
    const { x, y } = this.toLogical(clientX, clientY);
    if (y < LANE_Y0 - 20) return -1;
    const col = columnAtX(x);
    if (col < 0) return -1;
    return col; // 列 0..8 = レーン 0..8(CY 列は CY レーン。RD は CYGroup 共通で拾う)
  }

  _setTransform(g) {
    const s = this.scale * this.dpr;
    g.setTransform(s, 0, 0, s, (this.offsetX - this.view.x * this.scale) * this.dpr, (this.offsetY - this.view.y * this.scale) * this.dpr);
  }

  /**
   * 静止部分(レーン帯・判定ライン・パッド・パネルの枠)を、本体のキャンバスと同じ大きさ・同じ変換で一度だけ描いておき、
   * 毎フレーム等倍で (0, 0) に貼る(移植元の vid2dtx も静止部分は表示サイズで一度だけ作る。docs/spec/vid2dtx-edit.md §2.2)。
   * 以前は論理 1920x1080 で作って毎フレーム拡大していた。GPU 描画では差が無いが、ソフトウェア描画(GPU 無効・
   * ブロックリスト・リモートデスクトップ)では拡大の補間が 1 フレームの大半を占め、4K で 60 fps を保てなかった
   * (実測 36〜48 fps → 60 fps。上限なしでは約 45 → 123 fps)。
   * 下敷きのフレームの間は alpha:true で作る。不透明と分かっている画像で全面を描くと、Chrome はそれより前の描画
   * (下敷き)を捨てるため。下敷きが終わったら不透明で作り直す(ソフトウェア描画では貼るのが速い)。
   */
  _ensureBase() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const opaque = this._warm <= 0;
    const key = [W, H, this.scale, this.dpr, this.offsetX, this.offsetY, this.view.x, opaque, this._baseKeyExtra()].join('|');
    if (this._base && this._baseKey === key) return this._base;
    this._releaseBase();
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { alpha: !opaque });
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    this._setTransform(g);
    this._drawStatic(g);
    this._base = c;
    this._baseKey = key;
    return c;
  }

  /** 静止部分の作り置きを作り直す条件(大きさ以外。ギター / ベースは判定ラインの向き)。 */
  _baseKeyExtra() {
    return '';
  }

  /** 静止部分の中身(論理座標の変換を掛けた g に描く)。 */
  _drawStatic(g) {
    const skin = this.skin;
    g.drawImage(skin.laneStrip(), LANE_X0, LANE_Y0);
    skin.drawJudge(g);
    skin.drawPads(g, this.scale * this.dpr);
    skin.drawScorePanel(g);
    skin.drawSongPanel(g);
  }

  /** 縦画面で切り出す横の範囲(論理座標)。 */
  _portraitView() {
    return { x: LANE_X0 - PORTRAIT_MARGIN, w: LANE_W + PORTRAIT_MARGIN * 2 };
  }

  draw(perfNow) {
    const g = this.ctx;
    const p = this.player;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const base = this._ensureBase();
    if (this._warm > 0) this._drawWarm(g); // base の下に隠れる(WARM_AGES の注記)
    g.drawImage(base, 0, 0);
    this._setTransform(g);
    if (!p.chart) return;
    this._drawPlayfield(g, perfNow);
    this._drawHud(g, perfNow);
  }

  /** 演奏面(レーンフラッシュ・小節線・チップ・パッド・ファイア・判定文字)。 */
  _drawPlayfield(g, perfNow) {
    const p = this.player;
    const drawMs = p.drawMs;
    const ppm = p.pixelsPerMs;
    const ratio = p.ratio;
    const yOf = (t) => JUDGE_Y - ((t - drawMs) / ratio) * ppm;

    // レーンフラッシュ
    for (let lane = 0; lane < 10; lane++) {
      const remain = p.laneFlashUntil[lane] - perfNow;
      if (remain > 0) this._drawLaneFlash(g, lane, remain);
    }

    // 小節線・拍線(クリップはハイウェイ範囲。判定ラインを過ぎたチップも下端まで描き、パッド列の下へ消える)
    g.save();
    this._clipHighway(g);
    g.font = `20px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const bars = p.chart.barLines;
    const tLo = drawMs - ((LANE_Y1 - JUDGE_Y) / ppm) * ratio;
    const tHi = drawMs + ((JUDGE_Y - (LANE_Y0 - 40)) / ppm) * ratio;
    let bi = lowerBound(bars, tLo);
    for (; bi < bars.length && bars[bi].timeMs <= tHi; bi++) {
      const b = bars[bi];
      if (!b.visible) continue;
      const y = yOf(b.timeMs);
      if (y < LANE_Y0 || y > LANE_Y1) continue;
      g.fillStyle = b.isBeat ? 'rgb(70,70,70)' : 'rgb(200,200,200)';
      g.fillRect(LANE_X0, Math.round(y) - (b.isBeat ? 0 : 1), LANE_W, b.isBeat ? 1 : 2);
      if (!b.isBeat && b.measure >= 0) {
        g.fillStyle = 'rgb(220,220,220)';
        g.fillText(String(b.measure).padStart(3, '0'), LANE_X0 + LANE_W + 6, y);
      }
    }

    // ループ線
    if (p.loopBeginMs >= 0) this._drawLoopLine(g, yOf(p.loopBeginMs), 'rgba(102,255,128,0.85)', 'Begin loop');
    if (p.loopEndMs >= 0) this._drawLoopLine(g, yOf(p.loopEndMs), 'rgba(255,115,115,0.85)', 'End loop');

    // チップ(遠いものから描き、近いものが上に乗る)
    const notes = p.notes;
    const nLo = drawMs - ((LANE_Y1 - JUDGE_Y) / ppm) * ratio;
    const nHi = drawMs + ((JUDGE_Y - (LANE_Y0 - 30)) / ppm) * ratio;
    const iStart = lowerBound(notes, nLo);
    let iEnd = iStart;
    while (iEnd < notes.length && notes[iEnd].timeMs <= nHi) iEnd++;
    for (let i = iEnd - 1; i >= iStart; i--) {
      if (p.judged[i]) continue;
      const n = notes[i];
      this._drawChip(g, n.lane, yOf(n.timeMs), n.bonus);
    }
    g.restore();

    // パッド列をチップの上に重ねる
    this.skin.drawPads(g, this.scale * this.dpr);

    // パッドの点灯(ヒット後 ~108ms、少し沈む)
    for (let lane = 0; lane < 10; lane++) this._drawPadLit(g, lane, perfNow - p.padHitAt[lane]);

    // チップファイア(簡易: 判定ライン上の光)
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let lane = 0; lane < 10; lane++) this._drawFire(g, lane, perfNow - p.fireAt[lane]);
    g.restore();

    // 判定文字(レーンごと・クラシックアニメ 300ms)
    for (let lane = 0; lane < 10; lane++) {
      const js = p.judgeStr[lane];
      if (js.judge >= 0) this._drawJudge(g, lane, js.judge, perfNow - js.at, js.auto, js.lagMs, this.showLag);
    }
  }

  /** コンボ・状態表示・ステータス行・成績(ドラムとギター / ベースで共通。置き場所は _hudAnchors などで変える)。 */
  _drawHud(g, perfNow) {
    const p = this.player;
    const stats = p.stats;
    if (stats.combo >= 2) this._drawCombo(g, stats.combo, this._comboJump(perfNow - p.comboJumpAt));

    const a = this._hudAnchors();
    // 状態表示(待機・開始待ち・一時停止)
    if (p.state !== PLAYER_STATE.PLAYING) {
      const cx = a.cx;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `bold 64px ${FONT}`;
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.fillStyle = p.state === PLAYER_STATE.PAUSED ? 'rgb(255,200,120)' : 'rgb(255,230,140)';
      const text = p.stateText();
      g.strokeText(text, cx, a.stateY);
      g.fillText(text, cx, a.stateY);
      if (p.state === PLAYER_STATE.STANDBY) {
        g.font = `24px ${FONT}`;
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 3;
        const hint = t(this.mode === 'portrait' ? 'play.hintPortrait' : 'play.hintLandscape');
        g.strokeText(hint, cx, a.stateY + 50);
        g.fillText(hint, cx, a.stateY + 50);
      }
    }

    // ステータス行(PLAY SPEED など)。ハイウェイは画面上端からなので、上のボタン列と
    // 縦画面の成績表示(_drawCompactHud)の下に出す
    if (p.statusText && perfNow < p.statusUntil) {
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.font = `bold 26px ${FONT}`;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.fillStyle = 'rgb(255,230,140)';
      g.strokeText(p.statusText, a.statusX, a.statusY);
      g.fillText(p.statusText, a.statusX, a.statusY);
    }

    if (this.mode === 'portrait') this._drawCompactHud(g);
    else this._drawPanels(g);
  }

  /** 状態表示の中心 x と縦位置(案内はその 50 下)、ステータス行の左端と縦位置。 */
  _hudAnchors() {
    return { cx: LANE_X0 + LANE_W / 2, stateY: 520, statusX: LANE_X0 + 12, statusY: 160 };
  }

  /** コンボの跳ね(t はコンボが増えてからの経過 ms。上へ負)。 */
  _comboJump(t) {
    return t >= 0 && t < 180 ? -15 * 1.5 * Math.sin((Math.PI * t) / 180) : 0;
  }

  /** コンボの数の中心(ラベルはその 60 下)。 */
  _comboCenter() {
    // 横画面はハイウェイ左の空き列(スコアと同じ縦線上)に置き、チップに重ねない。
    // 縦画面はハイウェイ両脇に 80px しか余白が無いので、従来どおり中央上部に置く
    const x = this.mode === 'portrait'
      ? LANE_X0 + LANE_W / 2
      : PANELS.scoreDetailed.x + PANELS.scoreDetailed.w / 2;
    return { x, y: 330 };
  }

  /** 横画面のゲージと曲進捗バーの [x, y, 幅, 高さ](flip は進捗バーを上から下へ伸ばす)。 */
  _sideBars() {
    const gy = LANE_Y0 + 140;
    const gh = JUDGE_Y - LANE_Y0 - 200;
    return { gauge: [LANE_X0 - 42, gy, 22, gh], progress: [LANE_X0 - 78, gy, 14, gh], flip: false };
  }

  /** 縦画面の成績表示の左上と幅、ゲージと曲進捗バー(splitSpeed なら速さを別の行にする)。 */
  _compactLayout() {
    // 縦画面はハイウェイ内右端にゲージ、その右の余白に進捗バー
    // (小節番号を LANE_X0 + LANE_W + 6 から左詰めで描くので、3 桁ぶん空けた先に置く)
    const gy = LANE_Y0 + 140;
    const gh = JUDGE_Y - LANE_Y0 - 200;
    return {
      x: LANE_X0 + 8, y: 16, w: LANE_W - 20,
      gauge: [LANE_X0 + LANE_W - 30, gy, 18, gh], progress: [LANE_X0 + LANE_W + 52, gy, 12, gh], flip: false,
    };
  }

  /** ループ線を引く横の範囲と、描く縦の範囲。 */
  _loopSpan() {
    return { x: LANE_X0, w: LANE_W, y0: LANE_Y0 - 10, y1: LANE_Y1 + 10 };
  }

  // ---- 演出(本番の draw と下敷きの _drawWarm が同じ関数で描く) ----

  /** ハイウェイの範囲でクリップする(小節線・チップ用。呼ぶ側で save / restore)。 */
  _clipHighway(g) {
    g.beginPath();
    g.rect(LANE_X0 - 4, LANE_Y0 - 40, LANE_W + 160, LANE_Y1 - (LANE_Y0 - 40));
    g.clip();
  }

  /** チップ 1 個(ボーナスチップは枠付き)。 */
  _drawChip(g, lane, y, bonus) {
    const [x0, x1] = columnRange(LANE_TO_COLUMN[lane]);
    const w = x1 - x0 - 4;
    const cx = (x0 + x1) / 2;
    this.skin.drawBar(g, LANE_NAMES[lane], cx, y, w, 15, this.scale * this.dpr);
    if (bonus) {
      g.strokeStyle = 'rgba(255,230,80,0.9)';
      g.lineWidth = 2;
      g.strokeRect(cx - w / 2 - 3, y - 10, w + 6, 20);
    }
  }

  /** レーンフラッシュ。remain は消えるまでの残り(ms、> 0)。 */
  _drawLaneFlash(g, lane, remain) {
    const a = Math.min(1, remain / 120) * 0.5;
    const [x0, x1] = columnRange(LANE_TO_COLUMN[lane]);
    const [r, gg, b] = LANE_RGB[LANE_NAMES[lane]];
    g.fillStyle = `rgba(${r},${gg},${b},${a})`;
    g.fillRect(x0, LANE_Y0, x1 - x0, JUDGE_Y - LANE_Y0);
  }

  /** パッドの点灯。t はヒットからの経過(ms)。 */
  _drawPadLit(g, lane, t) {
    if (t < 0 || t > 130) return;
    const alpha = Math.max(0, Math.min(1, (6 - t / 18) / 6));
    if (alpha <= 0) return;
    const off = (t <= 37.5 ? 0.4 * t : Math.max(0, 15 - 0.2 * (t - 37.5))) * 1.5;
    const [x0, x1] = columnRange(LANE_TO_COLUMN[lane]);
    g.globalAlpha = alpha;
    this.skin.drawPadLit(g, x0, x1, PADS_Y + off, this.scale * this.dpr);
    g.globalAlpha = 1;
  }

  /** チップファイア。t は発火からの経過(ms)。'lighter' の合成は呼ぶ側で掛ける。 */
  _drawFire(g, lane, t) {
    if (t < 0 || t > 210) return;
    const s = Math.max(0, 0.4 + 0.8 * Math.cos((t / 150) * (Math.PI / 2)));
    const rad = 70 * s;
    // 画面で半径 2 px 未満の光は描かない(見えない。元実装に無い省略)。消える間際の 1 px 未満の半径では
    // Skia が別の描き方に切り替わり、初めてのときにシェーダを作って止まる(Graphite では約 100 ms)
    if (rad * this.scale * this.dpr < 2) return;
    const cx = columnCenterX(LANE_TO_COLUMN[lane]);
    const [r, gg, b] = LANE_RGB[LANE_NAMES[lane]];
    const grad = g.createRadialGradient(cx, JUDGE_Y, 0, cx, JUDGE_Y, rad);
    grad.addColorStop(0, `rgba(255,255,255,${0.9 * s})`);
    grad.addColorStop(0.4, `rgba(${r},${gg},${b},${0.6 * s})`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, JUDGE_Y, rad, 0, Math.PI * 2);
    g.fill();
  }

  /** 判定文字とずれ(クラシックアニメ 300ms)。t は判定からの経過(ms)。 */
  _drawJudge(g, lane, judge, t, auto, lagMs, showLag) {
    this._drawJudgeAt(g, columnCenterX(LANE_TO_COLUMN[lane]), JUDGE_Y - 150, judge, t, auto, lagMs, showLag);
  }

  /**
   * 判定文字を中心 (cx, cy) に描く。k は文字の倍率、label は判定の名前の代わりに出す文字(ギター / ベースの BAD)。
   */
  _drawJudgeAt(g, cx, cy, judge, t, auto, lagMs, showLag, k = 1, label = '') {
    if (t < 0 || t > 300) return;
    const bad = judge === JUDGE.OK || judge === JUDGE.MISS;
    let sx = 1;
    let sy = 1;
    if (!bad) {
      if (t < 50) { sx = 1 + (1 - t / 50); sy = t / 50; }
      else if (t >= 240) sy = 1 - (t - 240) / 60;
    } else {
      if (t < 50) sy = t / 50;
      else if (t >= 200) { sx = sy = 1 - (t - 200) / 100; }
    }
    sx = Math.max(0, sx);
    sy = Math.max(0, sy);
    if (sx <= 0 || sy <= 0) return;
    g.save();
    g.translate(cx, cy);
    g.scale(sx, sy);
    g.font = `italic bold ${30 * k}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 4 * k;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.fillStyle = JUDGE_COLOR[judge];
    const text = label || (auto ? 'AUTO' : JUDGE_TEXT[judge]);
    g.strokeText(text, 0, 0);
    g.fillText(text, 0, 0);
    g.restore();
    if (showLag && !auto && judge !== JUDGE.MISS) {
      const lag = Math.max(-999, Math.min(999, Math.round(lagMs)));
      g.font = `bold ${20 * k}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = lag < 0 ? 'rgb(120,180,255)' : 'rgb(255,140,120)';
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.lineWidth = 3 * k;
      const s = (lag > 0 ? '+' : '') + lag;
      g.strokeText(s, cx, cy + 28 * k);
      g.fillText(s, cx, cy + 28 * k);
    }
  }

  /** コンボ。置き場所は _comboCenter。 */
  _drawCombo(g, combo, jump) {
    const { x: cx, y } = this._comboCenter();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.fillStyle = 'rgb(255,240,160)';
    g.font = `bold 86px ${FONT}`;
    g.strokeText(String(combo), cx, y + jump);
    g.fillText(String(combo), cx, y + jump);
    g.font = `bold 28px ${FONT}`;
    g.fillStyle = 'rgb(255,255,255)';
    g.strokeText('COMBO', cx, y + 60 + jump);
    g.fillText('COMBO', cx, y + 60 + jump);
  }

  /** 演出の下敷きを 1 フレームぶん描く(WARM_AGES の注記)。失敗しても演奏は止めない。 */
  _drawWarm(g) {
    const age = WARM_AGES[WARM_AGES.length - this._warm];
    this._warm--;
    g.save();
    try {
      this._setTransform(g);
      this._warmEffects(g, age);
    } catch (e) {
      this._warm = 0;
      console.warn('演出の下敷きに失敗:', e);
    } finally {
      g.restore();
      // 演出の関数の中(判定文字の save / restore の間)で投げた場合も、静止部分は単位行列・不透明・通常の合成で貼る
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
  }

  /** 下敷きの中身: 演奏中に出る演出を、年齢 age(ms)を元にずらして全部描く(呼ぶ側で変換を掛け、失敗を拾う)。 */
  _warmEffects(g, age) {
    for (let lane = 0; lane < 10; lane++) {
      const t = age + lane * 21;
      this._drawLaneFlash(g, lane, 120 - (t % 120));
      this._drawPadLit(g, lane, t % 130);
      this._drawJudge(g, lane, lane % 5, t % 300, lane >= 5 && lane % 2 === 1, lane * 7 - 30, true);
    }
    g.save();
    try {
      g.globalCompositeOperation = 'lighter';
      for (let lane = 0; lane < 10; lane++) this._drawFire(g, lane, (age + lane * 21) % 210);
    } finally {
      g.restore();
    }
    this._drawCombo(g, 1234567890, 0);
    this._drawLoopLine(g, JUDGE_Y - 300, 'rgba(102,255,128,0.85)', 'Begin loop');
    // ハイウェイのクリップの下端にかかる小節番号とチップ(初めて切られるフレームで止まっていた)
    g.save();
    try {
      this._clipHighway(g);
      g.font = `20px ${FONT}`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillStyle = 'rgb(220,220,220)';
      g.fillText('000', LANE_X0 + LANE_W + 6, LANE_Y1 - 3);
      for (let lane = 0; lane < 10; lane++) this._drawChip(g, lane, LANE_Y1 - 3, lane === 0);
    } finally {
      g.restore();
    }
  }

  _drawLoopLine(g, y, color, label) {
    const s = this._loopSpan();
    if (y < s.y0 || y > s.y1) return;
    g.fillStyle = color;
    g.fillRect(s.x, Math.round(y) - 1, s.w, 3);
    g.fillRect(s.x, Math.round(y) + 5, s.w, 3);
    g.font = `bold 18px ${FONT}`;
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(label, s.x + s.w - 6, y - 4); // ハイウェイ内に収める(縦画面でも切れない)
  }

  /** 横画面: score_detailed / song_info / スコア / ゲージ。 */
  _drawPanels(g) {
    const p = this.player;
    const st = p.stats;
    const sd = PANELS.scoreDetailed;
    const sp = this.skin.scorePanel; // スキンの画像の配置(数を載せる位置)
    const { x: px, y: py } = panelMapper(sp.src, sd);
    g.font = `bold 18px ${FONT}`;
    g.textAlign = 'right';
    [...st.counts, st.maxCombo].forEach((count, i) => {
      // 数は行の線の切れ目に、率は右の下がった線の上に載せる
      g.textBaseline = 'middle';
      g.fillStyle = 'rgb(255,255,255)';
      g.fillText(String(count), px(sp.countRight), py(sp.rows[i]));
      g.textBaseline = 'alphabetic';
      g.fillStyle = 'rgb(200,200,200)';
      g.fillText(st.ratePercent(count), px(sp.rateRight), py(sp.rows[i] + sp.rateDrop) - 2);
    });
    // Fast / Slow(早い / 遅い打撃の数。Miss は遅い側に数える: docs/spec/judge-score.md)
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillStyle = 'rgb(255,255,255)';
    g.fillText(String(st.earlyCount), px(sp.fastX), py(sp.fastSlowY));
    g.fillText(String(st.lateCount), px(sp.slowX), py(sp.fastSlowY));

    // スコア・達成率(score_detailed の上)
    g.textAlign = 'left';
    g.font = `bold 30px ${FONT}`;
    g.fillStyle = 'rgb(255,255,255)';
    g.fillText('SCORE ' + String(st.score).padStart(7, '0'), sd.x, sd.y - 52);
    g.font = `22px ${FONT}`;
    g.fillStyle = 'rgb(200,220,255)';
    g.fillText(t('play.achievement') + ' ' + this._achievement().toFixed(2) + '%', sd.x, sd.y - 20);

    // ハイスピード・演奏速度(score_detailed の下)
    g.font = `bold 26px ${FONT}`;
    g.fillStyle = 'rgb(230,230,240)';
    g.fillText('SPEED ' + this._hiSpeedText(), sd.x, sd.y + sd.h + 36);
    if (p.ratio !== 1) g.fillText('PLAY ' + this._playSpeedText(), sd.x, sd.y + sd.h + 70);

    // ゲージ(ハイウェイ左)と、その隣の曲進捗バー
    const bars = this._sideBars();
    this._drawGauge(g, ...bars.gauge);
    this._drawProgress(g, ...bars.progress, bars.flip);

    // song_info
    const si = PANELS.songInfo;
    const info = this.songInfo;
    if (info.jacket) {
      const song = this.skin.songPanel;
      const m = panelMapper(song.src, si);
      const [jx, jy, jw, jh] = song.jacket;
      g.drawImage(info.jacket, m.x(jx), m.y(jy), jw * m.k, jh * m.k);
    }
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgb(255,255,255)';
    g.font = `bold 24px ${FONT}`;
    fitText(g, info.title, si.x + 125, si.y + 52, si.w - 140);
    g.font = `18px ${FONT}`;
    g.fillStyle = 'rgb(220,220,220)';
    fitText(g, info.artist, si.x + 125, si.y + 82, si.w - 140);
    g.fillStyle = 'rgb(200,220,255)';
    g.fillText(info.level + '   BPM ' + this._bpmText(), si.x + 125, si.y + 112);
  }

  /** 縦画面: ハイウェイ内に小さく成績を出す。 */
  _drawCompactHud(g) {
    const p = this.player;
    const st = p.stats;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.font = `bold 26px ${FONT}`;
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.fillStyle = 'rgb(255,255,255)';
    const L = this._compactLayout();
    const x = L.x;
    let y = L.y;
    const line = (text, color = 'rgb(255,255,255)') => {
      g.fillStyle = color;
      g.strokeText(text, x, y);
      g.fillText(text, x, y);
      y += 30;
    };
    line('SCORE ' + String(st.score).padStart(7, '0'));
    g.font = `20px ${FONT}`;
    line(`P ${st.counts[0]}  G ${st.counts[1]}  Gd ${st.counts[2]}  Ok ${st.counts[3]}  Miss ${st.counts[4]}  Max ${st.maxCombo}`, 'rgb(230,230,230)');
    const speed = 'SPEED ' + this._hiSpeedText() + (p.ratio !== 1 ? '  PLAY ' + this._playSpeedText() : '');
    const rate = t('play.achievement') + ' ' + this._achievement().toFixed(2) + '%   BPM ' + this._bpmText();
    // 切り出しの狭い画面(ギター / ベースの縦画面)は速さをいつも次の行へ(幅で決めると演奏中に行数が変わって表示が跳ねる)
    if (L.splitSpeed) {
      line(rate, 'rgb(200,220,255)');
      line(speed, 'rgb(200,220,255)');
    } else {
      line(rate + '   ' + speed, 'rgb(200,220,255)');
    }
    fitText(g, this.songInfo.title, x, y, L.w);
    this._drawGauge(g, ...L.gauge);
    this._drawProgress(g, ...L.progress, L.flip);
  }

  /**
   * 曲の進捗バー(縦。ゲージと同じく下から上へ伸びる = 下が曲頭・上が曲末)。
   * チップが上から降ってくるのと向きが揃うので、まだ叩いていない部分が常に上側になる。
   * flip なら上から下へ伸ばす(ギター / ベースの既定の向きはチップが下から上がってくるので、それに揃える)。
   * ループが有効なときは区間を帯で塗り、開始 / 終了位置をハイウェイのループ線と同じ色の線で引く。
   */
  _drawProgress(g, x, y, w, h, flip = false) {
    const p = this.player;
    const dur = Math.max(1, p.chart.durationMs);
    const frac = (ms) => Math.max(0, Math.min(1, ms / dur));
    const yOf = flip ? (ms) => y + h * frac(ms) : (ms) => y + h * (1 - frac(ms));
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(x, y, w, h);

    const hasLoop = p.loopEndMs >= 0 && p.loopEndMs > p.loopBeginMs;
    if (hasLoop) {
      const lo = Math.max(0, p.loopBeginMs);
      const e = yOf(flip ? lo : p.loopEndMs);
      g.fillStyle = 'rgba(102,217,255,0.28)';
      g.fillRect(x, e, w, Math.max(1, yOf(flip ? p.loopEndMs : lo) - e));
    }

    // 経過(曲頭 = 下端(flip なら上端)から現在位置まで)
    const now = yOf(p.songMs);
    g.fillStyle = 'rgba(255,217,102,0.85)';
    if (flip) g.fillRect(x, y, w, Math.max(0, now - y));
    else g.fillRect(x, now, w, Math.max(0, y + h - now));

    if (hasLoop) {
      // ハイウェイのループ線と同じ配色(緑 = 開始、赤 = 終了)
      g.fillStyle = 'rgba(102,255,128,0.9)';
      g.fillRect(x - 4, Math.round(yOf(Math.max(0, p.loopBeginMs))) - 1, w + 8, 3);
      g.fillStyle = 'rgba(255,115,115,0.9)';
      g.fillRect(x - 4, Math.round(yOf(p.loopEndMs)) - 1, w + 8, 3);
    }

    // 現在位置(黄色の伸びた先端。黄色に埋もれないよう白で引く)
    g.fillStyle = 'rgb(255,255,255)';
    g.fillRect(x - 5, Math.round(now) - 1, w + 10, 3);
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 1;
    g.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  }

  _drawGauge(g, x, y, w, h) {
    const st = this.player.stats;
    const v = Math.max(0, Math.min(1, st.gauge));
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x - 3, y - 3, w + 6, h + 6);
    let color;
    if (st.gauge <= GAUGE_DANGER) {
      const a = 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 1000 * 8));
      color = `rgba(255,64,64,${a})`;
    } else if (st.gauge >= 0.5) color = 'rgb(77,230,128)';
    else color = 'rgb(242,204,64)';
    g.fillStyle = color;
    g.fillRect(x, y + h * (1 - v), w, h * v);
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 1;
    g.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  }

  /** 達成率(レーン別 AUTO の補正込み)。 */
  _achievement() {
    const p = this.player;
    const lbd = !!(p.settings && p.settings.autoLanes && p.settings.autoLanes[10]);
    return p.stats.achievement(p.allLanesAuto, p.laneAuto, lbd);
  }

  _hiSpeedText() {
    return 'x' + this.player.settings.hiSpeedRatio.toFixed(1);
  }

  _playSpeedText() {
    return 'x' + this.player.ratio.toFixed(2);
  }

  _bpmText() {
    const p = this.player;
    const changes = p.chart.bpmChanges;
    const song = p.songMs;
    let bpm = changes.length ? changes[0].bpm : p.chart.bpm;
    for (const c of changes) {
      if (c.timeMs <= song) bpm = c.bpm;
      else break;
    }
    const v = bpm * p.ratio;
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  }
}

/** パネル画像の画素 → 論理座標の変換(Skin.drawScorePanel / drawSongPanel で描いたときの位置)。 */
function panelMapper(src, rect) {
  const k = rect.w / src[2];
  return { k, x: (x) => rect.x + (x - src[0]) * k, y: (y) => rect.y + (y - src[1]) * k };
}

/** timeMs >= t となる最初の添字(時刻順の配列)。 */
export function lowerBound(list, t) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timeMs < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const fitCache = new Map();

/** 幅に収まるよう末尾を '…' で切って描く。結果は (文字列, フォント, 幅) ごとに記憶する。 */
function fitText(g, text, x, y, maxW) {
  if (!text) return;
  const key = g.font + '|' + maxW + '|' + text;
  let s = fitCache.get(key);
  if (s === undefined) {
    const chars = Array.from(text); // サロゲートペアを壊さない
    if (g.measureText(text).width <= maxW) {
      s = text;
    } else {
      let lo = 0;
      let hi = chars.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (g.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid;
        else hi = mid - 1;
      }
      s = chars.slice(0, Math.max(1, lo)).join('') + '…';
    }
    if (fitCache.size > 200) fitCache.clear();
    fitCache.set(key, s);
  }
  g.fillText(s, x, y);
}
