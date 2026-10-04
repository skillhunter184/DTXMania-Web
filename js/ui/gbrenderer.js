// ギター / ベースの演奏画面(NX CStagePerfGuitarScreen の 1 パートぶんを、ドラムの Renderer の HUD に載せたもの)。
// 配置は js/ui/skin.js の GB_*(NX の座標 × 1.5 をドラムのレーン帯の中央に寄せたもの)。描き方(描画順・チップ・ロングノート・
// レーンフラッシュ・チップファイア・ウェイリングの柱・+100・判定文字)の出どころは docs/spec/gb-screen.md(§6 がこの画面の案)。
// 既定の向きは NX と同じく判定ラインが上で、チップが下から上がってくる。REVERSE(player.reverse)で判定ラインが下・チップが降る。
// LEFT(player.left。NX bLeft)はボタンを描く列を左右反転する(チップ・ロングノート・レーンフラッシュ・弦・チップファイア・
// 上のボタン列。色はボタンのまま)。OPEN・ウェイリング・小節線・パネル・判定ライン・判定文字はそのまま(NX と同じ)。
// 下の枠はポールピースの所だけ入れ替える(ピックで光るポールピースがボタンの色なので。NX は下の枠を光らせない)。
// タッチは見えている列のボタンを押す。キーはボタンに付いたまま(NX と同じ)。
// 成績のパネル・ゲージ・進捗バー・コンボ・状態表示はドラムと共通(置き場所だけ変える)。
//
// 元実装に無い追加: 押さえているボタンを上のボタン列で点ける(NX は押した状態を描かない)、ピックで下の枠のピックの絵を光らせる、
// BAD(Light OFF の空ピック)を Miss の色の「BAD」で出す(NX は BAD の絵が無く何も出さない)。

import { Renderer, FONT, lowerBound } from './renderer.js';
import {
  CANVAS_H, PANELS, GB_PANEL, GB_LANE_X, GB_LANE_PITCH, GB_CHIP_W, GB_CHIP_H, GB_OPEN, GB_BAR, GB_WAIL_COL, GB_WAIL_CHIP, GB_JUDGE_Y,
  GB_JUDGE_Y_REVERSE, GB_VIEW_Y0, GB_VIEW_Y1, GB_LANE_RGB, GB_WAIL_RGB, gbChipX, gbLaneCenterX, gbLaneAtX, gbSlot,
} from './skin.js';
import { GB_LANE_BITS, GB_LANE_COUNT, GB_BITS_MASK } from '../core/dtx.js';
import { GB_TOUCH_OPEN } from './gbinput.js';

const FLUSH_MS = 70; // レーンフラッシュが離してから消えるまで(NX CCounter(0, 70, 1 ms))
const FLUSH_ALPHA = 0.55; // その濃さ(判定ラインの側。NX の絵は α165 だが色が暗い。DTXManiaAI の CUSTOM と同じ 0.55)
const FIRE_MS = 224; // チップファイア(NX tStart(28, 56, 8 ms))
const PILLAR_MS = 600; // ウェイリングの柱(NX CCounter(0, 300, 2 ms))
const BONUS_MS = 500; // ロングノートの +100(NX CCounter(0, 500, 1 ms))
const PICK_FLASH_MS = 150; // ピックの絵が光っている時間(元実装に無い追加)
const AUTO_NEAR_MS = 800; // AUTO のボタンを先に光らせるチップを探す範囲(NX ± 800 ms・過去優先)
const AHEAD_PX = 900; // チップを描く先の距離(NX は 600 px(720p)先まで処理する)
const BEHIND_PX = 120; // 判定ラインを過ぎたチップを描く距離(見える範囲の端まで)
/** 判定文字の中心(NX の位置 P-A: 絵の中心 x 183・y 300(REVERSE 450))と、ドラムの文字に対する倍率。 */
const JUDGE_CX = 894.5;
const JUDGE_DY = 219; // 判定位置からの縦の距離(既定の向き。REVERSE は −241.5)
const JUDGE_DY_REVERSE = -241.5;
const JUDGE_K = 1.5;
/** 小節番号の左端(パネルの右 + 6。ドラムの LANE_X0 + LANE_W + 6 と同じ置き方。NX はパネルの左に出す)。 */
const MEASURE_X = 1142;
/** レーン 5 本のまとまりの中央 x と、パネル(ウェイリングの列を含む)の中央 x。 */
const LANES_CX = (GB_LANE_X + GB_LANE_X + GB_LANE_PITCH * 5 + 3) / 2;
const PANEL_CX = 928;
/** 縦画面で切り出す範囲: 進捗バー(パネルの左 − 78)から小節番号・+100 まで。 */
const PORTRAIT_VIEW = { x: 600, w: 620 };
/** ゲージと進捗バーの縦の範囲(チップが見える範囲の内側)。 */
const BAR_Y = 180;
const BAR_H = 800;

export class GuitarRenderer extends Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./skin.js').Skin} skin
   * @param {import('../game/gbplayer.js').GuitarPlayer} player
   */
  constructor(canvas, skin, player) {
    super(canvas, skin, player);
    this._litAt = new Array(GB_LANE_COUNT).fill(-1e9); // レーンを押さえていた(AUTO なら光らせた)最後の時刻
    this._lit = new Array(GB_LANE_COUNT).fill(-1);
    this._lnNotes = null; // _lnMax の記憶
    this._lnMaxMs = 0;
    this._pillar = null; // ウェイリングの柱の絵 {canvas, ds}
  }

  /** シークバーを画面の下に出すか(判定ラインが上にある既定の向きのとき。上はボタン列と判定ラインで埋まっている)。 */
  get seekBarAtBottom() {
    return !this.player.reverse;
  }

  _rev() {
    return !!this.player.reverse;
  }

  /** LEFT(ボタンの列を左右反転)。 */
  _left() {
    return !!this.player.left;
  }

  /** 判定位置(NX JL)。 */
  _judgeY() {
    return this._rev() ? GB_JUDGE_Y_REVERSE : GB_JUDGE_Y;
  }

  /** 判定ラインの上端(NX: 既定 JL − 1、REVERSE JL。720p の 1 px = 1.5)。 */
  _hitBarTop() {
    return this._rev() ? GB_JUDGE_Y_REVERSE : GB_JUDGE_Y - 1.5;
  }

  /** チップファイアの中心の縦位置(NX: 既定 JL + 1、REVERSE JL)。 */
  _fireY() {
    return this._rev() ? GB_JUDGE_Y_REVERSE : GB_JUDGE_Y + 1.5;
  }

  /**
   * タッチのヒット判定: レーンの列(パネルの高さ全部)→ その列に描いているボタン 0..4(LEFT なら列の左右が逆)、
   * ハイウェイの高さのそれ以外 → GB_TOUCH_OPEN、範囲外 → -1。
   */
  hitTestLane(clientX, clientY) {
    const { x, y } = this.toLogical(clientX, clientY);
    if (y < GB_PANEL.y - 20 || y > CANVAS_H + 20) return -1;
    const slot = gbLaneAtX(x);
    return slot >= 0 ? gbSlot(slot, this._left()) : GB_TOUCH_OPEN;
  }

  // ---- 静止部分・置き場所(Renderer の差し替え) ----

  _baseKeyExtra() {
    return (this._rev() ? 'reverse' : 'normal') + (this._left() ? '|left' : '');
  }

  _drawStatic(g) {
    const ds = this.scale * this.dpr;
    const skin = this.skin;
    skin.drawGbPanel(g);
    skin.drawGbTop(g, ds, this._left());
    skin.drawGbBottom(g, false, ds, this._left());
    skin.drawGbHitBar(g, this._hitBarTop(), ds);
    skin.drawScorePanel(g);
    skin.drawSongPanel(g);
  }

  _portraitView() {
    return PORTRAIT_VIEW;
  }

  /**
   * 状態表示・ステータス行は判定ライン・判定文字・縦画面の成績表示(チップが出てくる側の端。5 行で 150)を避ける。
   * 既定の向き: 判定ライン 231・判定文字 450(ずれ 492)・コンボ(縦画面)600 の下に状態表示 730(案内 780)、
   * ステータス行 815、成績表示 845〜995。REVERSE: 成績表示 167〜317 の下にステータス行 342・状態表示 430(案内 480)、
   * コンボ 540、判定文字 675、判定ライン 916.5。
   */
  _hudAnchors() {
    return this._rev()
      ? { cx: PANEL_CX, stateY: 430, statusX: GB_LANE_X, statusY: 342 }
      : { cx: PANEL_CX, stateY: 730, statusX: GB_LANE_X, statusY: 815 };
  }

  /** コンボの跳ね(NX: 1 回 120 ms。k を 2 ms ごとに 3 進め −15·sin(πk/180)、×1.5)。 */
  _comboJump(t) {
    return t >= 0 && t < 120 ? -15 * 1.5 * Math.sin((Math.PI * t) / 120) : 0;
  }

  /** 横画面はドラムと同じ(SCORE DETAILED の上)。縦画面はレーンの上、判定文字と状態表示の間。 */
  _comboCenter() {
    if (this.mode === 'portrait') return { x: LANES_CX, y: this._rev() ? 540 : 600 };
    return { x: PANELS.scoreDetailed.x + PANELS.scoreDetailed.w / 2, y: 330 };
  }

  /** ゲージと進捗バーはパネルの左(ドラムと同じくレーンの左端から −42 / −78)。進捗バーはチップの来る向きに揃える。 */
  _sideBars() {
    return {
      gauge: [GB_PANEL.x - 42, BAR_Y, 22, BAR_H],
      progress: [GB_PANEL.x - 78, BAR_Y, 14, BAR_H],
      flip: !this._rev(),
    };
  }

  /** 縦画面の成績表示はチップが出てくる側の端(既定の向きは下の枠の上、REVERSE はボタン列の下)。 */
  _compactLayout() {
    // 5 行(スコア・判定数・達成率と BPM・速さ・曲名)。切り出しが狭いので速さは別の行
    return {
      x: GB_LANE_X, y: this._rev() ? GB_VIEW_Y0 + 11 : GB_VIEW_Y1 - 160, w: GB_PANEL.w - 40, splitSpeed: true, ...this._sideBars(),
    };
  }

  _loopSpan() {
    return { x: GB_LANE_X, w: GB_WAIL_COL[1] - GB_LANE_X, y0: GB_VIEW_Y0 - 10, y1: GB_VIEW_Y1 + 10 };
  }

  _achievement() {
    return this.player.achievement();
  }

  _hiSpeedText() {
    return 'x' + this.player.settings.gbHiSpeedRatio.toFixed(1);
  }

  // ---- 演奏面 ----

  /**
   * NX の順: レーンフラッシュと弦 → ウェイリングの柱 → 小節線 → ループ線 → チップ → (ボタン列と枠) → 判定ライン → 判定文字
   * → (コンボ) → チップファイア → +100。ボタン列と枠は静止部分にあり、チップは見える範囲(GB_VIEW_Y0..Y1)で切るので
   * 描き直さない(NX はゲージの裏と枠でパネルの上を隠す。隠さないと REVERSE のチップがパネルの上の空きに出てくる)。
   */
  _drawPlayfield(g, perfNow) {
    const p = this.player;
    const skin = this.skin;
    const ds = this.scale * this.dpr;
    const rev = this._rev();
    const JL = this._judgeY();
    const drawMs = p.drawMs;
    const ppm = p.pixelsPerMs;
    const ratio = p.ratio;
    const songMs = drawMs + (p.noteDrawOffsetMs || 0) * ratio;
    const dist = (t) => ((t - drawMs) / ratio) * ppm;
    // 小節線の上端・ウェイリングチップの中心(NX: 判定位置 ± 距離。チップの中心はこれ + 1.5)
    const yBar = rev ? (t) => JL - dist(t) : (t) => JL + dist(t);
    const tLo = drawMs - (BEHIND_PX / ppm) * ratio;
    const tHi = drawMs + (AHEAD_PX / ppm) * ratio;

    const lit = this._laneLight(p, songMs, perfNow);
    g.save();
    this._clipLanes(g);
    for (let i = 0; i < GB_LANE_COUNT; i++) if (lit[i] >= 0) this._drawFlush(g, i, lit[i], rev);
    this._drawPillar(g, perfNow - p.wailAt, rev, ds);

    // 小節線(NX は小節線だけで拍線は描かない)と小節番号
    g.font = `20px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const bars = p.chart.barLines;
    for (let bi = lowerBound(bars, tLo); bi < bars.length && bars[bi].timeMs <= tHi; bi++) {
      const b = bars[bi];
      if (b.isBeat || !b.visible) continue;
      const y = yBar(b.timeMs);
      if (y > GB_VIEW_Y0 && y < GB_VIEW_Y1) this._drawBarLine(g, y, b.measure);
    }
    if (p.loopBeginMs >= 0) this._drawLoopLine(g, yBar(p.loopBeginMs), 'rgba(102,255,128,0.85)', 'Begin loop');
    if (p.loopEndMs >= 0) this._drawLoopLine(g, yBar(p.loopEndMs), 'rgba(255,115,115,0.85)', 'End loop');

    this._drawChips(g, p, dist, yBar, tLo, tHi, JL, rev, ds);
    this._drawWailChips(g, p, yBar, tHi, ppm, ds);
    g.restore();

    // 押さえているボタンを点ける(元実装に無い追加)・ピックの絵・判定ライン(チップの上)
    const left = this._left();
    for (let i = 0; i < GB_LANE_COUNT; i++) {
      if (lit[i] < 0) continue;
      g.globalAlpha = 1 - lit[i] / FLUSH_MS;
      skin.drawGbKnobLit(g, i, ds, left);
    }
    g.globalAlpha = 1;
    this._drawPickFlash(g, perfNow - p.pickAt, ds, left);
    skin.drawGbHitBar(g, this._hitBarTop(), ds);

    // 判定文字(1 パート 1 つ。新しい判定・BAD が前のものを置き換える)
    const j = p.gbJudge;
    if (j && j.judge >= 0) this._drawGbJudge(g, j.judge, perfNow - j.at, j.auto, j.lagMs, j.bad, rev);

    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < GB_LANE_COUNT; i++) this._drawGbFire(g, i, perfNow - p.fireAt[i]);
    g.restore();
    this._drawBonus(g, perfNow - p.lnTickAt);
  }

  /**
   * レーンごとの点灯(NX のレーンフラッシュの数え方: 押さえている間は毎フレーム 0 から数え直し、離してから 70 ms で消える)。
   * AUTO のボタンは、いちばん近い未判定のチップ(± 800 ms・過去優先)か押さえ続けているロングノートにその色があれば
   * 押さえている扱い(NX。チップが来る前から光る)。結果はレーンごとの経過 ms(0..70)、消えていれば -1。
   */
  _laneLight(p, songMs, perfNow) {
    const out = this._lit;
    const autoBits = p.auto ? GB_BITS_MASK : p.autoMask || 0;
    let want = 0;
    if (autoBits) {
      const i = this._nearestChip(p, songMs);
      if (i >= 0) want |= p.notes[i].bits;
      if (p.holdIndex >= 0 && p.notes[p.holdIndex]) want |= p.notes[p.holdIndex].bits;
      want &= autoBits;
    }
    for (let i = 0; i < GB_LANE_COUNT; i++) {
      const on = !!(p.fretHeld && p.fretHeld[i]) || (want & GB_LANE_BITS[i]) !== 0;
      if (on) this._litAt[i] = perfNow;
      // フレームの間に押して離したときも、離した時刻から消える
      const up = p.fretUpAt && p.fretUpAt[i] > p.fretAt[i] ? p.fretUpAt[i] : -Infinity;
      const ct = on ? 0 : Math.max(0, perfNow - Math.max(this._litAt[i], up));
      out[i] = ct < FLUSH_MS ? ct : -1;
    }
    return out;
  }

  /** songMs にいちばん近い未判定のチップ(± AUTO_NEAR_MS の譜面時刻・過去優先。NX r指定時刻に一番近いChip)。無ければ -1。 */
  _nearestChip(p, songMs) {
    const notes = p.notes;
    const win = AUTO_NEAR_MS * p.ratio;
    let past = -1;
    for (let i = lowerBound(notes, songMs - win); i < notes.length; i++) {
      if (p.judged[i]) continue;
      const dt = notes[i].timeMs - songMs;
      if (dt <= 0) past = i;
      else return past >= 0 ? past : dt <= win ? i : -1;
    }
    return past;
  }

  /** チップが見える範囲(上のボタン列の下端から下の枠の上端まで)で切る。右は小節番号まで。呼ぶ側で save / restore。 */
  _clipLanes(g) {
    g.beginPath();
    g.rect(GB_PANEL.x - 4, GB_VIEW_Y0, MEASURE_X + 70 - (GB_PANEL.x - 4), GB_VIEW_Y1 - GB_VIEW_Y0);
    g.clip();
  }

  /** 小節線 1 本(上端 y)と小節番号。 */
  _drawBarLine(g, y, measure) {
    const yy = Math.round(y);
    g.fillStyle = 'rgb(170,170,176)';
    g.fillRect(GB_BAR.x, yy, GB_BAR.w, 2);
    g.fillStyle = 'rgb(104,104,110)';
    g.fillRect(GB_BAR.x, yy + 2, GB_BAR.w, 1);
    if (measure >= 0) {
      g.fillStyle = 'rgb(220,220,220)';
      g.fillText(String(measure).padStart(3, '0'), MEASURE_X, y + 1.5);
    }
  }

  /**
   * チップ(NX: 時刻の早い順に描き、遅いチップが上に乗る。1 個のチップの中は R→P、各レーンの頭のすぐ後に胴)。
   * 和音は同じ高さの別々のチップ。OPEN は 5 レーンにわたる棒で、レーンのチップより少し下に描く。
   * ロングノート: 終端が判定ラインに来たら頭も胴も描かない。押さえている間は胴を判定ラインに留める。胴の透明度は
   * α128、判定後に離した・取り逃したものは α64。OPEN のロングノートは胴を描かず、頭を判定後も描く(NX)。
   */
  _drawChips(g, p, dist, yBar, tLo, tHi, JL, rev, ds) {
    const skin = this.skin;
    const notes = p.notes;
    const left = this._left();
    for (let i = lowerBound(notes, tLo - this._lnMax(notes)); i < notes.length; i++) {
      const n = notes[i];
      if (n.timeMs > tHi) break;
      const judged = p.judged[i];
      if (n.lnEndMs < 0) {
        if (judged || n.timeMs < tLo) continue;
        const yc = yBar(n.timeMs) + 1.5;
        if (n.open) skin.drawGbOpen(g, yc + GB_OPEN.top, ds);
        else {
          for (let lane = 0; lane < GB_LANE_COUNT; lane++) {
            if (n.bits & GB_LANE_BITS[lane]) skin.drawGbChip(g, lane, gbChipX(gbSlot(lane, left)), yc - GB_CHIP_H / 2, ds);
          }
        }
        continue;
      }
      const dEnd = dist(n.lnEndMs);
      if (dEnd <= 0) continue;
      const held = judged && p.holdIndex === i;
      let yc = yBar(n.timeMs) + 1.5;
      let len = dEnd - dist(n.timeMs);
      if (held) {
        yc = JL + 1.5;
        len = dEnd;
      }
      if (n.open) {
        skin.drawGbOpen(g, yc + GB_OPEN.top, ds);
        continue;
      }
      const alpha = judged && !held ? 64 / 255 : 128 / 255;
      for (let lane = 0; lane < GB_LANE_COUNT; lane++) {
        if (!(n.bits & GB_LANE_BITS[lane])) continue;
        const x = gbChipX(gbSlot(lane, left));
        if (!judged) skin.drawGbChip(g, lane, x, yc - GB_CHIP_H / 2, ds);
        g.globalAlpha = alpha;
        skin.drawGbBody(g, lane, x, rev ? yc - len : yc, len, ds);
        g.globalAlpha = 1;
      }
    }
  }

  /**
   * ウェイリングチップ(ウェイリングの列)。成立したら消え、成立しなかったものは見える範囲から流れ出るまで描く(NX は判定位置を
   * 234 px(720p)過ぎるまで描く。見える範囲の外)。高さ 102 なので、レーンのチップより判定ラインを過ぎてから長く描く。
   */
  _drawWailChips(g, p, yBar, tHi, ppm, ds) {
    const w = p.wailing || [];
    const hit = p.wailHit || p.wailDone || [];
    const tLo = p.drawMs - ((BEHIND_PX + GB_WAIL_CHIP.h) / ppm) * p.ratio;
    for (let i = lowerBound(w, tLo); i < w.length && w[i].timeMs <= tHi; i++) {
      if (!hit[i]) this.skin.drawGbWail(g, yBar(w[i].timeMs), ds);
    }
  }

  /** いちばん長いロングノートの長さ(ms)。頭が描く範囲より前にあっても胴が見えるものを拾うのに使う。 */
  _lnMax(notes) {
    if (this._lnNotes !== notes) {
      let m = 0;
      for (const n of notes) if (n.lnEndMs >= 0) m = Math.max(m, n.lnEndMs - n.timeMs);
      this._lnNotes = notes;
      this._lnMaxMs = m;
    }
    return this._lnMaxMs;
  }

  // ---- 演出(本番の draw と下敷きの _warmEffects が同じ関数で描く) ----

  /**
   * レーンフラッシュと弦。ct は数え(0..70 ms)。フラッシュは判定ラインの側が濃く遠い側へ消える縦長の帯で、離すと
   * 幅が縮みながらレーンの中央へ寄る(NX: x + 28.5·ct/70、幅 55.5·(70−ct)/70、y 150 / REVERSE 621、高さ 384)。
   * 弦はレーンの中央の光る縦線で、数えている間は薄れずに出る(NX 7_guitar line)。LEFT では両方ともボタンの列へ動く。
   */
  _drawFlush(g, lane, ct, rev) {
    const [r, gg, b] = GB_LANE_RGB[lane];
    const slot = gbSlot(lane, this._left());
    const k = (FLUSH_MS - ct) / FLUSH_MS;
    if (k > 0) {
      const y0 = rev ? 621 : 150;
      const h = 384;
      const grad = g.createLinearGradient(0, rev ? y0 + h : y0, 0, rev ? y0 : y0 + h);
      grad.addColorStop(0, `rgba(${r},${gg},${b},${FLUSH_ALPHA})`);
      grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = grad;
      g.fillRect(gbChipX(slot) + (28.5 * ct) / FLUSH_MS, y0, GB_CHIP_W * k, h);
    }
    const cx = gbLaneCenterX(slot);
    const hw = 9.75; // 弦の半幅(NX 13 px)
    const s = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
    const lr = Math.round(r + (255 - r) * 0.6);
    const lg = Math.round(gg + (255 - gg) * 0.6);
    const lb = Math.round(b + (255 - b) * 0.6);
    s.addColorStop(0, `rgba(${r},${gg},${b},0)`);
    s.addColorStop(0.32, `rgba(${r},${gg},${b},0.45)`);
    s.addColorStop(0.5, `rgba(${lr},${lg},${lb},1)`);
    s.addColorStop(0.68, `rgba(${r},${gg},${b},0.45)`);
    s.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = s;
    g.fillRect(cx - hw, GB_VIEW_Y0, hw * 2, GB_VIEW_Y1 - GB_VIEW_Y0);
  }

  /**
   * ウェイリングの柱(t は成立からの経過 ms)。NX の動き: 下から跳ね上がって少し弾み、上へ抜ける(REVERSE は上下逆)。
   * 720p の上端 top(v)、v = t / 2 = 0..300、高さ 244 を 1.5 倍する。チップの下に描く。
   */
  _drawPillar(g, t, rev, ds) {
    if (!(t >= 0 && t < PILLAR_MS)) return;
    const v = t / 2;
    let top;
    if (v < 100) top = 120 + 290 * Math.cos(((Math.PI / 2) * v) / 100);
    else if (v < 150) top = 120 + (150 - v) * Math.sin((Math.PI * ((v - 100) % 25)) / 25);
    else if (v < 200) top = 64;
    else top = 64 - (290 * (v - 200)) / 100;
    if (rev) top = 670 - top - 244;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.drawImage(this._pillarSprite(ds), 1059.5, top * 1.5, 39, 366);
    g.restore();
  }

  /** ウェイリングの柱の絵(39×366。中央が白く両端へ水色で消え、上下の端を薄くする)。表示の倍率ごとに一度だけ作る。 */
  _pillarSprite(ds) {
    if (this._pillar && this._pillar.ds === ds) return this._pillar.canvas;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(39 * ds));
    c.height = Math.max(1, Math.round(366 * ds));
    const g = c.getContext('2d');
    g.scale(c.width / 39, c.height / 366);
    const [r, gg, b] = GB_WAIL_RGB;
    const h = g.createLinearGradient(0, 0, 39, 0);
    h.addColorStop(0, `rgba(${r},${gg},${b},0)`);
    h.addColorStop(0.28, `rgba(${r},${gg},${b},0.5)`);
    h.addColorStop(0.5, 'rgba(235,255,255,0.95)');
    h.addColorStop(0.72, `rgba(${r},${gg},${b},0.5)`);
    h.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = h;
    g.fillRect(0, 0, 39, 366);
    g.globalCompositeOperation = 'destination-in';
    const v = g.createLinearGradient(0, 0, 0, 366);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(0.15, 'rgba(0,0,0,1)');
    v.addColorStop(0.85, 'rgba(0,0,0,1)');
    v.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = v;
    g.fillRect(0, 0, 39, 366);
    if (this._pillar) this._pillar.canvas.width = 0;
    this._pillar = { canvas: c, ds };
    return c;
  }

  /** ピックの絵を光らせる(t はピックからの経過 ms。元実装に無い追加)。 */
  _drawPickFlash(g, t, ds, left) {
    if (!(t >= 0 && t < PICK_FLASH_MS)) return;
    g.globalAlpha = 1 - t / PICK_FLASH_MS;
    this.skin.drawGbBottom(g, true, ds, left);
    g.globalAlpha = 1;
  }

  /**
   * 判定文字(ドラムのクラシックアニメ 300 ms を 1.5 倍の文字で。NX の絵の位置)。AUTO は「AUTO」。
   * bad は Light OFF の空ピックで、Miss の色の「BAD」を出す(元実装に無い追加。NX は絵が無く、前の判定を消すだけ)。
   */
  _drawGbJudge(g, judge, t, auto, lagMs, bad, rev) {
    const cy = rev ? GB_JUDGE_Y_REVERSE + JUDGE_DY_REVERSE : GB_JUDGE_Y + JUDGE_DY;
    this._drawJudgeAt(g, JUDGE_CX, cy, judge, t, auto, lagMs, this.showLag, JUDGE_K, bad ? 'BAD' : '');
  }

  /**
   * チップファイア(t は発火からの経過 ms)。NX の曲線: v = 28 + t/8(28..56)、大きさ 3·sin(πv/112)(2.12 → 3)、
   * 濃さ 1 − sin(π(v−28)/56)(1 → 0)、元の絵 80 px(720p)。'lighter' の合成は呼ぶ側で掛ける。
   * ロングノートを押さえている間は毎フレーム発火し直すので、最初の形のまま光り続ける(NX と同じ)。LEFT ではボタンの列で光る。
   */
  _drawGbFire(g, lane, t) {
    if (!(t >= 0 && t < FIRE_MS)) return;
    const v = 28 + t / 8;
    const s = 3 * Math.sin((Math.PI * v) / 112);
    const a = 1 - Math.sin((Math.PI * (v - 28)) / 56);
    if (a <= 0.004) return;
    const rad = 60 * s;
    const cx = gbLaneCenterX(gbSlot(lane, this._left()));
    const cy = this._fireY();
    const [r, gg, b] = GB_LANE_RGB[lane];
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, `rgba(255,255,255,${0.95 * a})`);
    grad.addColorStop(0.1, `rgba(${Math.round((r + 255) / 2)},${Math.round((gg + 255) / 2)},${Math.round((b + 255) / 2)},${0.8 * a})`);
    grad.addColorStop(0.28, `rgba(${r},${gg},${b},${0.38 * a})`);
    grad.addColorStop(0.6, `rgba(${r},${gg},${b},${0.07 * a})`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.fill();
  }

  /** ロングノートの加点「+100」(t は加点からの経過 ms)。NX: パネルの右上から 500 ms で 30 px 上がって消える。 */
  _drawBonus(g, t) {
    if (!(t >= 0 && t < BONUS_MS)) return;
    const y = 67.5 - (30 * t) / BONUS_MS;
    g.font = `italic bold 40px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.fillStyle = 'rgb(255,226,110)';
    g.strokeText('+100', 1119.5, y);
    g.fillText('+100', 1119.5, y);
  }

  /** 下敷きの中身(Renderer._drawWarm の注記)。ギター / ベースの演出の描き方を全部通す。 */
  _warmEffects(g, age) {
    const skin = this.skin;
    const ds = this.scale * this.dpr;
    g.save();
    try {
      this._clipLanes(g);
      for (let i = 0; i < GB_LANE_COUNT; i++) {
        const t = age + i * 21;
        this._drawFlush(g, i, t % FLUSH_MS, i % 2 === 1);
        // 見える範囲の端にかかるチップと胴(α128 / 64)
        skin.drawGbChip(g, i, gbChipX(i), GB_VIEW_Y1 - 8, ds);
        g.globalAlpha = i % 2 ? 64 / 255 : 128 / 255;
        skin.drawGbBody(g, i, gbChipX(i), GB_VIEW_Y0 - 20, 60 + i * 7, ds);
        g.globalAlpha = 1;
      }
      skin.drawGbOpen(g, GB_VIEW_Y0 - 5, ds);
      skin.drawGbWail(g, GB_VIEW_Y1, ds);
      this._drawPillar(g, (age * 2) % PILLAR_MS, age % 2 === 1, ds);
      g.font = `20px ${FONT}`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      this._drawBarLine(g, GB_VIEW_Y1 - 2, 0);
      this._drawLoopLine(g, 600, 'rgba(102,255,128,0.85)', 'Begin loop');
    } finally {
      g.restore();
    }
    // ボタンの点灯版は両方の並び(LEFT は演奏中にメニューで切り替えられる)を作っておく
    for (let i = 0; i < GB_LANE_COUNT; i++) {
      g.globalAlpha = 1 - ((age + i * 21) % FLUSH_MS) / FLUSH_MS;
      skin.drawGbKnobLit(g, i, ds, i % 2 === 1);
    }
    g.globalAlpha = 1;
    this._drawPickFlash(g, age % PICK_FLASH_MS, ds, age % 2 === 1); // 両方の並びを作っておく
    skin.drawGbHitBar(g, this._hitBarTop(), ds);
    for (let k = 0; k < 7; k++) {
      // Perfect..Miss・AUTO・BAD(ずれの数字あり)
      this._drawGbJudge(g, k % 5, (age + k * 37) % 300, k === 5, k * 9 - 30, k === 6, k % 2 === 1);
    }
    g.save();
    try {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < GB_LANE_COUNT; i++) this._drawGbFire(g, i, (age + i * 21) % FIRE_MS);
    } finally {
      g.restore();
    }
    this._drawBonus(g, age % BONUS_MS);
    this._drawCombo(g, 1234567890, 0);
  }
}
