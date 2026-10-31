// 譜面の生成(js/gen/)で使う数値の小道具。vid2dtx は numpy で書いてあるので、結果がずれないよう numpy と同じ決まりで計算する
// (丸めは偶数への丸め、中央値は真ん中 2 つの平均、百分位は線形補間、標準偏差は母標準偏差)。

/** 偶数への丸め(Python の round・np.round。0.5 ちょうどは偶数の側)。 */
export function rint(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** 中央値(np.median。空なら NaN)。 */
export function median(a) {
  const n = a.length;
  if (!n) return NaN;
  const s = Float64Array.from(a).sort();
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 百分位(np.percentile の既定 = 線形補間)。q は 0〜100。 */
export function percentile(a, q) {
  const n = a.length;
  if (!n) return NaN;
  const s = Float64Array.from(a).sort();
  const pos = ((n - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : NaN;
}

/** 母標準偏差(np.std)。 */
export function std(a) {
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return a.length ? Math.sqrt(s / a.length) : NaN;
}

/** 一番大きい要素の添字(np.argmax。同じなら前)。 */
export function argmax(a) {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
  return best;
}

/** 一番小さい要素の添字(np.argmin。同じなら前)。 */
export function argmin(a) {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < a[best]) best = i;
  return best;
}

/** 0 以上の整数の数え上げ(np.bincount)。 */
export function bincount(a, minlength = 0) {
  let n = minlength;
  for (const v of a) n = Math.max(n, v + 1);
  const out = new Array(n).fill(0);
  for (const v of a) out[v]++;
  return out;
}

/**
 * 直線 y = a·x + b の最小二乗(np.linalg.lstsq に [x, 1] を渡したのと同じ)。点が 1 つ以下・x が全部同じなら null。
 * @returns {{a: number, b: number}|null}
 */
export function lineFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (!(sxx > 0)) return null;
  const a = sxy / sxx;
  return { a, b: my - a * mx };
}

/** 長い計算の途中で画面に戻る(進み具合を出し、やめるボタンを効かせる)。 */
export function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** やめたときに投げる例外(呼び出し側は name で見分ける)。 */
export class GenCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'GenCancelled';
  }
}
