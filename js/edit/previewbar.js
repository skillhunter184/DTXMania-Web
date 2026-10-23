// 譜面の編集画面の「判定ラインの位置」と「プレビューのハイスピード」(本アプリの追加)。演奏画面のプレビューの上端に細い帯を重ね、
// プレー動画(js/edit/video.js)と見比べるために、判定ラインの高さとチップの速さを細かく合わせる。
// - 判定ラインの位置: 編集画面の再生位置の線とプレビューの判定ラインを一緒に動かす(場所の高さに対する割合。config.editJudgeY。
//   既定は 75 %)。動画に判定ラインの印を付けていれば(動画ごと。video.js の judgeV)、その高さに合わせて付いていく(▲ ▼ はその印を直す)
// - プレビューのハイスピード: 編集画面だけの値(config.editHiSpeed。既定はトレーニングの設定の値)。トレーニングの 0.1 刻みより細かく
//   (0.05、Shift で 0.5、Alt で 0.01)

import { t } from '../i18n.js';
import { numberDialog } from './dialogs.js';
import { HEADER_CSS } from './view.js';

const $ = (id) => document.getElementById(id);

/** 判定ラインの位置の既定(場所の高さに対する割合。前から同じ)。 */
export const JUDGE_FRAC_DEFAULT = 0.75;
/** 判定ラインの位置の範囲。 */
export const JUDGE_FRAC_MIN = 0.05;
export const JUDGE_FRAC_MAX = 0.98;
/** ハイスピードの範囲(トレーニングと同じ x0.1〜x200)。 */
export const HS_MIN = 0.1;
export const HS_MAX = 200;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 判定ラインの位置の下限(場所の高さ h で決まる。編集画面の上の列名の帯・プレビューの帯の下に隠れないように)。 */
export function judgeFracMin(h) {
  return h > 0 ? Math.max(JUDGE_FRAC_MIN, (HEADER_CSS + 6) / h) : JUDGE_FRAC_MIN;
}

/** ▲ ▼ の 1 回の動き(CSS px): 2 px、Shift で 20 px、Alt で 0.5 px。 */
export function judgeStepPx(mods = {}) {
  return mods.altKey ? 0.5 : mods.shiftKey ? 20 : 2;
}

/** − ＋ の 1 回のハイスピードの変化: 0.05、Shift で 0.5、Alt で 0.01(0.01 に丸めて範囲に収める)。 */
export function hiSpeedStep(cur, dir, mods = {}) {
  const step = mods.altKey ? 0.01 : mods.shiftKey ? 0.5 : 0.05;
  return clamp(Math.round((cur + dir * step) * 100) / 100, HS_MIN, HS_MAX);
}

/** 判定ラインの位置の表示('75.0 %')。 */
export function formatJudge(frac) {
  return `${(Math.round(frac * 1000) / 10).toFixed(1)} %`;
}

export class PreviewBar {
  /** @param {import('./editor.js').EditorScreen} ed */
  constructor(ed) {
    this.ed = ed;
    this.root = $('edit-preview-bar');
    this._sig = '';
  }

  get config() {
    return this.ed.config;
  }

  open() {
    const ed = this.ed;
    // 押したらキーが譜面に届くようにする(メニュー・ダイアログを開くボタンはそちらに任せる)
    const btn = (id, fn, refocus = true) => {
      const b = $(id);
      ed._on(b, 'click', (e) => {
        b.blur();
        fn(e);
        if (refocus) ed.canvas.focus({ preventScroll: true });
      });
    };
    btn('edit-judge-up', (e) => this.nudgeJudge(-judgeStepPx(e)));
    btn('edit-judge-down', (e) => this.nudgeJudge(judgeStepPx(e)));
    btn('edit-judge-val', () => this.askJudge(), false);
    btn('edit-hs-down', (e) => this.setHiSpeed(hiSpeedStep(this.hiSpeed(), -1, e)));
    btn('edit-hs-up', (e) => this.setHiSpeed(hiSpeedStep(this.hiSpeed(), 1, e)));
    btn('edit-hs-val', () => this.askHiSpeed(), false);
    btn('edit-pbar-more', () => this.menu(), false);
    // 帯の上のホイールは譜面を送る(プレビューと同じ)
    ed._on(this.root, 'wheel', (e) => ed._wheel(e), { passive: false });
    ed._on(this.root, 'contextmenu', (e) => e.preventDefault());
    this._sig = '';
  }

  close() {
    this.root.hidden = true;
  }

  // ---- 判定ラインの位置 ----

  /**
   * 今の判定ラインの位置(場所の高さ h に対する割合)。動画に判定ラインの印があり動画を出していればその高さ(video: true)、
   * 無ければ設定の値、それも無ければ既定(custom: false。プレビューは前のとおり、ハイウェイが収まる範囲でそろえる)。
   */
  judgeFrac(h) {
    const vy = this.ed.video.judgeStageY();
    if (Number.isFinite(vy) && h > 0) return { frac: clamp(vy / h, JUDGE_FRAC_MIN, JUDGE_FRAC_MAX), custom: true, video: true };
    const c = this.config.editJudgeY;
    if (Number.isFinite(c)) return { frac: clamp(c, judgeFracMin(h), JUDGE_FRAC_MAX), custom: true, video: false };
    return { frac: JUDGE_FRAC_DEFAULT, custom: false, video: false };
  }

  /** 判定ラインを px だけ動かす(正 = 下へ)。動画に合わせていれば動画の印を直す。 */
  nudgeJudge(px) {
    const ed = this.ed;
    const h = $('edit-stage').clientHeight;
    if (!(h > 0)) return;
    if (Number.isFinite(ed.video.judgeStageY())) ed.video.nudgeJudge(px);
    else {
      // 見えている線から動かす(線は画面の画素に丸めてあるので、丸める前の割合から動かすと 1 回の動きが 1 px ぶれることがある)
      const v = ed.view;
      const cur = v.headY > 0 && v.s > 0 ? (v.headY * v.s) / h : this.judgeFrac(h).frac;
      this.setJudgeFrac(cur + px / h);
    }
  }

  /** 判定ラインの位置を割合にする(動画に合わせていれば、その高さに動画の印を置き直す)。 */
  setJudgeFrac(frac) {
    const ed = this.ed;
    const h = $('edit-stage').clientHeight;
    const f = clamp(frac, judgeFracMin(h), JUDGE_FRAC_MAX);
    if (Number.isFinite(ed.video.judgeStageY())) ed.video.setJudgeStageY(f * h);
    else {
      this.config.editJudgeY = Math.round(f * 1e6) / 1e6; // 0.5 px の動きが丸めで消えない細かさ
      ed.app.saveConfig();
    }
    ed.onResize();
  }

  /** 判定ラインを既定に戻す(動画の印も外す)。 */
  resetJudge() {
    this.ed.video.clearJudge();
    delete this.config.editJudgeY;
    this.ed.app.saveConfig();
    this.ed.onResize();
  }

  async askJudge() {
    const ed = this.ed;
    const h = $('edit-stage').clientHeight;
    const r = await numberDialog($('edit-dialog'), {
      title: t('edit.judgeTitle'), prompt: t('edit.judgePrompt'),
      value: Math.round(this.judgeFrac(h).frac * 1000) / 10, min: Math.ceil(judgeFracMin(h) * 1000) / 10, max: JUDGE_FRAC_MAX * 100,
    });
    if (r.action === 'ok' && !ed._closed) this.setJudgeFrac(r.value / 100);
    ed.canvas.focus({ preventScroll: true });
  }

  // ---- ハイスピード ----

  /** 今のプレビューのハイスピード(編集画面の値、無ければトレーニングの設定の値)。 */
  hiSpeed() {
    const c = this.config.editHiSpeed;
    if (c > 0) return c;
    const tr = this.ed.app.training;
    return tr && tr.scrollSpeedTenth > 0 ? tr.scrollSpeedTenth / 10 : 1;
  }

  setHiSpeed(v) {
    if (!Number.isFinite(v)) return;
    this.config.editHiSpeed = clamp(Math.round(v * 100) / 100, HS_MIN, HS_MAX);
    this.ed.app.saveConfig();
    this.ed._applyPlayOptions();
    this.ed._render();
    this.refresh(true);
  }

  resetHiSpeed() {
    delete this.config.editHiSpeed;
    this.ed.app.saveConfig();
    this.ed._applyPlayOptions();
    this.ed._render();
    this.refresh(true);
  }

  async askHiSpeed() {
    const ed = this.ed;
    const r = await numberDialog($('edit-dialog'), {
      title: t('edit.hsTitle'), prompt: t('edit.hsPrompt'), value: this.hiSpeed(), min: HS_MIN, max: HS_MAX,
    });
    if (r.action === 'ok' && !ed._closed) this.setHiSpeed(r.value);
    ed.canvas.focus({ preventScroll: true });
  }

  // ---- 帯 ----

  /**
   * 帯を置く(プレビューの上端。left は場所の左からの CSS px、w = 0 ならしまう)。入りきらなければ字を詰め(narrow)、それでも入らなければ
   * − ＋ ▲ ▼ をしまう(tiny。値を押して数で入れる・⋯ は残す)。文字の幅は言語で変わるので測って決める。
   */
  place(left, w) {
    const el = this.root;
    el.hidden = !w;
    if (!w) return;
    el.style.left = left + 'px';
    el.style.width = w + 'px';
    this.refresh(true);
    el.classList.remove('narrow', 'tiny');
    if (el.scrollWidth > el.clientWidth) el.classList.add('narrow');
    if (el.scrollWidth > el.clientWidth) el.classList.add('tiny');
  }

  /** 値の表示を合わせる。 */
  refresh(force = false) {
    if (this.root.hidden) return;
    const h = $('edit-stage').clientHeight;
    const j = this.judgeFrac(h);
    const hs = this.hiSpeed();
    const own = this.config.editHiSpeed > 0;
    const sig = [j.frac.toFixed(4), j.custom, j.video, hs, own].join('|');
    if (!force && sig === this._sig) return;
    this._sig = sig;
    $('edit-judge-val').textContent = formatJudge(j.frac);
    $('edit-judge-val').classList.toggle('video', j.video);
    $('edit-hs-val').textContent = hs.toFixed(2);
    $('edit-hs-val').classList.toggle('own', own);
  }

  /** 帯の ⋯ のメニュー。 */
  menu() {
    const ed = this.ed;
    const v = ed.video;
    const items = [];
    items.push({ label: t('edit.judgeLine'), heading: true });
    if (v.file) items.push({ label: t('edit.judgeToVideo'), disabled: !v.w || !v._box, run: () => v.startJudgePick() });
    if (v.hasJudge()) items.push({ label: t('edit.judgeVideoOff'), run: () => { v.clearJudge(); ed.onResize(); } });
    items.push({ label: t('edit.judgeEnter'), run: () => this.askJudge() });
    items.push({ label: t('edit.judgeReset'), disabled: !Number.isFinite(this.config.editJudgeY) && !v.hasJudge(), run: () => this.resetJudge() });
    items.push({ label: t('edit.hiSpeed'), heading: true });
    items.push({ label: t('edit.hsEnter'), run: () => this.askHiSpeed() });
    items.push({ label: t('edit.hsReset'), disabled: !(this.config.editHiSpeed > 0), run: () => this.resetHiSpeed() });
    const r = $('edit-pbar-more').getBoundingClientRect();
    ed._popover(items, r.right, r.bottom, { alignRight: true });
  }
}
