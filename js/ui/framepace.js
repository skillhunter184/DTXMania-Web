// 描画の間引き(元実装に無い追加)。停止中(待機・一時停止)の演奏画面は 60 fps 前後で描く。
// 画面の更新の速さを rAF の間隔から測り、k 回の更新に 1 回だけ描く(SoundVoltexAnalyze の譜面シミュレータの
// frameDivisor と同じ考え方。あちらのリポジトリの docs/譜面シミュレータ.md §7.13)。描く速さは画面の Hz を整数で
// 割った値なので、ちょうど 60 にはならない(144 Hz → 72、165 Hz → 55、90 Hz → 45)。
// 演奏中は間引かない(間引くと時計が滑らかでもチップの 1 フレームの移動が k 倍になり、見た目が粗くなる)。

/** 停止中の描画の目安(fps)。画面の Hz を割って、これに比で最も近くする。 */
export const IDLE_DRAW_FPS = 60;

/** 測りに使う直近の間隔の数と、測り直す間隔(rAF の回数)。 */
const WINDOW = 90;
const REESTIMATE_EVERY = 30;

/**
 * 画面の更新の速さ(Hz)。0 < d < 100 ms の間隔だけを使い、間隔の中央値 m で各間隔が何回ぶんの更新かを
 * 数えて(round(d / m)、最低 1)、全体の長さを割る。rAF の時刻は 0.1〜1 ms に丸められるので、1000 / 中央値 だと
 * 360 Hz が 357(0.1 ms 刻み)や 333(1 ms 刻み)に出る。測れないとき(間隔が 8 個未満)は 0。
 * @param {number[]} dts
 */
export function estimateHz(dts) {
  const v = dts.filter((d) => d > 0 && d < 100);
  if (v.length < 8) return 0;
  const sorted = [...v].sort((a, b) => a - b);
  const m = sorted[sorted.length >> 1];
  let total = 0;
  let n = 0;
  for (const d of v) {
    total += d;
    n += Math.max(1, Math.round(d / m));
  }
  return (n / total) * 1000;
}

/**
 * 何回の更新に 1 回描くか。hz / k が capFps に比で最も近い k(|log(hz / k / capFps)| が最小)。
 * 四捨五入(round(hz / capFps))にしないのは、比が 1.5 ちょうどの所で測りの揺れにより k が行き来するため(SVA と同じ)。
 * capFps が 0 か、hz が測れていない・capFps 以下なら 1(毎回描く)。360 Hz → 6、240 → 4、144 → 2、120 → 2、60 → 1。
 */
export function frameDivisor(hz, capFps) {
  if (!(capFps > 0) || !(hz > capFps)) return 1;
  let best = 1;
  let bestErr = Infinity;
  for (let k = 1; k <= 16; k++) {
    const err = Math.abs(Math.log(hz / k / capFps));
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  return best;
}

export class FramePacer {
  constructor() {
    this.dts = [];
    this.hz = 0;
    this._lastRaw = 0;
    this._lastDrawn = -Infinity;
    this._ticks = 0;
  }

  /** rAF ごとに、描くかどうかに関わらず呼ぶ(t は rAF の時刻)。 */
  tick(t) {
    if (this._lastRaw > 0) {
      const d = t - this._lastRaw;
      // 同じ描画更新の中の rAF(d = 0)と、タブが隠れていた間(d ≥ 100)は測りに入れない
      if (d > 0 && d < 100) {
        this.dts.push(d);
        if (this.dts.length > WINDOW) this.dts.shift();
      }
    }
    this._lastRaw = t;
    this._ticks++;
    if (this.hz === 0 || this._ticks % REESTIMATE_EVERY === 0) this.hz = estimateHz(this.dts);
  }

  /**
   * このフレームを描くか(capFps は上限。0 = 毎回描く)。止めるかどうかは回数ではなく時間で見る:
   * 前に描いてから (k − 0.5) 回ぶんの更新が経つまで描かない(回数で数えると、1 回の更新を超えたフレームで間隔が延びる)。
   */
  shouldDraw(t, capFps) {
    const k = frameDivisor(this.hz, capFps);
    if (k > 1 && t - this._lastDrawn < ((k - 0.5) * 1000) / this.hz) return false;
    this._lastDrawn = t;
    return true;
  }

  /** 次のフレームは必ず描く(キャンバスの大きさを変えると中身が消えるので、resize の後など)。 */
  forceNext() {
    this._lastDrawn = -Infinity;
  }
}
