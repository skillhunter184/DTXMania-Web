// 譜面の編集画面の「演奏画面のプレビュー」(本アプリの追加。DTXCreator は外部のビューアで確かめる)。
// 演奏画面の描画(js/ui/renderer.js の Renderer)をそのまま使い、縦画面と同じくレーン帯と小節番号の範囲を切り出して編集画面の右に並べる。
// 動かすのは編集画面の再生(EditorPlayer)。止まっているときは編集画面の再生位置を判定ラインに合わせ、再生中はそのまま流れる。
// 成績のパネル・ゲージ・コンボ・状態の文字は描かない(譜面の見え方だけ)。

import { Renderer, PORTRAIT_MARGIN } from '../ui/renderer.js';
import { LANE_X0, LANE_W, CANVAS_H, JUDGE_Y } from '../ui/skin.js';

/** プレビューの幅と高さの比(演奏画面の縦画面の切り出しと同じ範囲)。 */
export const PREVIEW_ASPECT = (LANE_W + PORTRAIT_MARGIN * 2) / CANVAS_H;
/** 編集画面の場所の幅に対するプレビューの幅の上限。 */
export const PREVIEW_MAX_SHARE = 0.4;
/** これより狭くなるなら出さない(CSS px)。 */
export const PREVIEW_MIN_W = 160;

/**
 * プレビューの幅(CSS px)。場所の幅の 4 割までで、その上限が PREVIEW_MIN_W に届かなければ 0(出さない)。
 * keepW: 場所がこの幅以上あれば、残りをこの幅より狭くしない(編集画面の広い配置を狭い配置に落とさない。落とすと横のパネルの
 * 寄せ方とツールバーの段が変わって場所の大きさが変わり、出す / 出さないが毎フレーム入れ替わる)。
 * 高さは幅を詰める(高さに合わせる)だけで、出すかどうかには使わない(低い窓でも最小の幅で出し、描くほうが高さに合わせて縮める。
 * 高さで決めると、広げたら消えるといった食い違いが出る)。
 * @param {number} stageW
 * @param {number} stageH
 * @param {number} [keepW]
 */
export function previewWidth(stageW, stageH, keepW = 0) {
  let max = Math.floor(stageW * PREVIEW_MAX_SHARE);
  if (stageW >= keepW) max = Math.min(max, stageW - keepW);
  if (max < PREVIEW_MIN_W) return 0;
  return Math.max(PREVIEW_MIN_W, Math.min(max, Math.floor(stageH * PREVIEW_ASPECT)));
}

/**
 * プレビュー用のスキン。チップの絵の作り置き(レーンごとに 1 つ。大きさが変われば作り直す)を編集画面の描画と分ける。
 * 同じフレームで別の大きさを頼み合うと、毎フレーム全部を作り直してしまう。単色の図形のパッド列も同じ(画像のパッド列は共有)。
 * @param {import('../ui/skin.js').Skin} skin
 */
function ownSprites(skin) {
  const s = Object.create(skin);
  s.chipSprites = {};
  if (!skin.images.pads) s.pads = null;
  return s;
}

export class PreviewRenderer extends Renderer {
  constructor(canvas, skin, player) {
    super(canvas, ownSprites(skin), player);
    // 演出の下敷き(ページを開いてすぐの演奏の引っかかり対策)は演奏画面だけでよい
    this._warm = 0;
  }

  /**
   * 演奏画面の縦画面と同じ範囲を切り出す(mode は portrait 固定)。縦の位置は、演奏画面は上に寄せる(下をメニューに使う)が、
   * ここでは判定ラインを judgeY(CSS px。編集画面の再生位置の線)にそろえる(ハイウェイが収まる範囲で)。exact なら必ずそろえる
   * (判定ラインの位置を変えたとき。ハイウェイの上やパッドが切れてもよい。js/edit/previewbar.js)。
   */
  resize(cssW, cssH, dpr = 1, judgeY = null, exact = false) {
    super.resize(cssW, cssH, dpr, 'portrait', 0);
    const room = cssH - CANVAS_H * this.scale;
    if (Number.isFinite(judgeY) && exact) this.offsetY = judgeY - JUDGE_Y * this.scale;
    else if (Number.isFinite(judgeY) && room > 0) this.offsetY = Math.max(0, Math.min(room, judgeY - JUDGE_Y * this.scale));
  }

  /** 静止部分はレーン帯・判定ライン・パッドだけ(成績・曲のパネルは描かない)。 */
  _drawStatic(g) {
    const skin = this.skin;
    g.drawImage(skin.laneStrip(), LANE_X0, 0);
    skin.drawJudge(g);
    skin.drawPads(g, this.scale * this.dpr);
  }

  /** 成績・コンボ・状態の文字は描かない。 */
  _drawHud() {}

  /** 判定の文字は AUTO で叩いたものだけ(ドラムの音を切って再生すると、チップは MISS になるので出さない)。 */
  _drawJudge(g, lane, judge, t, auto, lagMs, showLag) {
    if (auto) super._drawJudge(g, lane, judge, t, auto, lagMs, showLag);
  }
}
