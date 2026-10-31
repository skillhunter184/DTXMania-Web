// 動画のコマを順に読む(本アプリの追加。vid2dtx は OpenCV で全部のコマを読む)。
// <video> を音を消して流し、requestVideoFrameCallback で出たコマごとに、フィールドの範囲を canvas に描いて画素を読む。
// - コマの時刻は rVFC の mediaTime(そのコマの表示時刻)。流す速さ rate が 1 でも、読むのが遅れたコマはブラウザが飛ばす
//   (飛んだコマは無いだけで、ほかのコマの時刻は正しい)。rate 2 なら 60 fps の動画は 1 コマおきになる
// - タブが隠れると rVFC が止まるので、そのあいだは動画も止める
// - コマの間隔(fps)は読んだコマの時刻の間から求める(estimateFramePeriod)

import { rint, median, lineFit, GenCancelled } from './num.js';

/**
 * 動画の大きさと長さを読む。
 * @param {Blob} file
 * @returns {Promise<{video: HTMLVideoElement, url: string, width: number, height: number, duration: number}>}
 */
export function openVideo(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const url = URL.createObjectURL(file);
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error('cannot open the video (unsupported format?)'));
    };
    video.addEventListener('loadedmetadata', () => {
      if (!video.videoWidth || !video.videoHeight) {
        fail();
        return;
      }
      resolve({ video, url, width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    }, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.src = url;
  });
}

/** 動画を閉じる(openVideo の結果)。 */
export function closeVideo(v) {
  if (!v) return;
  try {
    v.video.pause();
    v.video.removeAttribute('src');
    v.video.load();
  } catch (e) { /* 閉じるだけ */ }
  URL.revokeObjectURL(v.url);
}

/** そのブラウザでコマを順に読めるか。 */
export function canScanFrames() {
  return typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}

/** 止まっている動画のある時刻の絵(配置の確かめの絵)。 */
export function seekFrame(video, t) {
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = Math.max(0, Math.min(t, (video.duration || 0) - 0.05));
  });
}

/**
 * 読んだコマの時刻から、コマの間隔(秒)と位相(コマの時刻 = 番号 × 間隔 + 位相)を求める。
 * 隣どうしの間の短い方の 1 割の所の値を、整数の 1〜4 で割った候補のうち、ほとんどの間がその整数倍になる一番長いもの。
 * そのあと番号を振って直線で当てはめ直す。
 * @param {number[]} times 時刻の順
 * @returns {{period: number, phase: number}|null}
 */
export function estimateFramePeriod(times) {
  if (times.length < 3) return null;
  const d = [];
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 1e-4) d.push(times[i] - times[i - 1]);
  if (d.length < 2) return null;
  const sorted = [...d].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.1)];
  let period = base;
  for (let k = 1; k <= 4; k++) {
    const p = base / k;
    if (p < 1 / 250) break;
    // 間がほとんど全部 p の整数倍(半端な間が混じる長い p を選ぶと、そのコマの時刻が半コマずれる)
    const ok = d.filter((x) => Math.abs(x / p - rint(x / p)) < 0.08).length / d.length;
    if (ok >= 0.98) {
      period = p;
      break;
    }
  }
  // 番号を振って当てはめ直す(59.94 fps などの細かい間隔)
  const idx = times.map((t) => rint((t - times[0]) / period));
  const fit = lineFit(idx, times);
  if (fit && fit.a > 0) period = fit.a;
  const phase = median(times.map((t) => t - rint(t / period) * period));
  return { period, phase };
}

/**
 * 動画を頭から流して、出たコマごとに onFrame(画素, 時刻) を呼ぶ。終わる・やめると resolve / reject。
 * @param {HTMLVideoElement} video openVideo の video
 * @param {{x: number, y: number, w: number, h: number}} roi 読む範囲(動画の画素)
 * @param {{rate?: number, onFrame: (data: Uint8ClampedArray, mediaTime: number) => void,
 *   onProgress?: (t: number) => void, signal?: {cancelled: boolean}}} opts
 * @returns {Promise<{frames: number, presented: number}>} 読んだコマの数と、その間にブラウザが出したコマの数
 */
export function scanFrames(video, roi, opts) {
  const canvas = document.createElement('canvas');
  canvas.width = roi.w;
  canvas.height = roi.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rate = opts.rate || 1;
  return new Promise((resolve, reject) => {
    let frames = 0;
    let firstPresented = -1;
    let lastPresented = 0;
    let handle = 0;
    let finished = false;
    let lastMedia = -1;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('visibilitychange', onVis);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      if (handle) video.cancelVideoFrameCallback(handle);
      video.pause();
      if (err) reject(err);
      else resolve({ frames, presented: firstPresented < 0 ? 0 : lastPresented - firstPresented + 1 });
    };
    const onFrame = (now, meta) => {
      handle = 0;
      if (finished) return;
      if (opts.signal && opts.signal.cancelled) {
        finish(new GenCancelled());
        return;
      }
      if (meta.mediaTime > lastMedia) {
        lastMedia = meta.mediaTime;
        if (firstPresented < 0) firstPresented = meta.presentedFrames;
        lastPresented = meta.presentedFrames;
        ctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
        opts.onFrame(ctx.getImageData(0, 0, roi.w, roi.h).data, meta.mediaTime);
        frames++;
        if (opts.onProgress) opts.onProgress(meta.mediaTime);
      }
      handle = video.requestVideoFrameCallback(onFrame);
    };
    const onEnded = () => {
      // 最後のコマの rVFC が ended の後に来ることがあるので、少し待つ
      setTimeout(() => finish(), 100);
    };
    const onError = () => finish(new Error('video decode error'));
    const onVis = () => {
      if (finished) return;
      if (document.hidden) video.pause();
      else video.play().catch(() => {});
    };
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVis);
    const start = async () => {
      try {
        if (video.currentTime > 0) await seekFrame(video, 0);
        video.playbackRate = rate;
        handle = video.requestVideoFrameCallback(onFrame);
        await video.play();
      } catch (e) {
        finish(e);
      }
    };
    start();
  });
}
