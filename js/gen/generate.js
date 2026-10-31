// 動画・音声から譜面を作って、曲フォルダの ZIP にする(本アプリの追加。vid2dtx の GUI の「譜面を生成」「音声から生成」に当たる。
// docs/spec/vid2dtx-gen.md §7)。できる曲フォルダ(<曲名>/):
//   generated.dtx            譜面(Shift-JIS。書けない文字があれば UTF-8)
//   bgm.wav / 元の音のファイル  BGM。動画からは動画の音を小節 0 の頭から切り出した WAV。音からは、元のファイルが DTXMania で
//                            鳴らせる形(ogg / mp3 / wav)ならそのまま(BGM のチップを曲の頭に置く)、ほかは WAV にする
//   kit_*.wav                ドラムの音(本アプリの合成音。js/gen/kit.js)
//   generated.dtx.conf.json  確信度(音から作ったときだけ。編集画面が枠を付けて「次の要確認」で回る。js/edit/sidecar.js)
// ファイルはブラウザの中で読むだけで、どこにも送らない。

import { rint, GenCancelled, yieldToUi } from './num.js';
import { openVideo, closeVideo, scanFrames } from './frames.js';
import { analyzeVideo, bgmStartOf, videoChips } from './video2dtx.js';
import { bpmText } from './emit.js';
import { audioToChart, audioBpmText } from './audio2dtx.js';
import { ADT } from './adt.js';
import { AVSYNC } from './avsync.js';
import { KIT, kitWavs, encodeWav, chartText } from './kit.js';
import { encodeText } from '../core/encoding.js';
import { ZipWriter } from '../core/zip.js';

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|avi)$/i;
const AUDIO_EXT = /\.(ogg|oga|mp3|wav|m4a|aac|flac|opus|weba)$/i;
/** そのまま BGM にできる音(DTXMania が鳴らせる形)。 */
const KEEP_EXT = /\.(ogg|mp3|wav)$/i;
export const BGM_SR = 44100;
export const CHART_NAME = 'generated.dtx';

/** ファイルの種類('video' / 'audio' / null)。 */
export function kindOfFile(f) {
  if (!f) return null;
  const type = typeof f.type === 'string' ? f.type : '';
  if (type.startsWith('video/') || VIDEO_EXT.test(f.name || '')) return 'video';
  if (type.startsWith('audio/') || AUDIO_EXT.test(f.name || '')) return 'audio';
  return null;
}

/** 曲名の既定(ファイル名の拡張子を除いたもの)。 */
export function titleOf(f) {
  return ((f && f.name) || '').replace(/\.[^.]*$/, '').trim() || 'generated';
}

/** 曲フォルダの名前(ファイル名に使えない文字を _ に。長すぎれば切る)。 */
export function folderName(title) {
  const s = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 64);
  return s || 'generated';
}

/** そのまま BGM に使える音のファイルか。 */
export function keepsOriginal(f) {
  return KEEP_EXT.test((f && f.name) || '');
}

/**
 * ファイルの音を読む(sr Hz の左右。1 本の音なら同じものを 2 つ)。音が無い・読めなければ null。
 * @param {Blob} file
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number}|null>}
 */
export async function decodeStereo(file, sr = BGM_SR) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx(2, 1, sr);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const left = buf.getChannelData(0);
    return { left, right: buf.numberOfChannels > 1 ? buf.getChannelData(1) : left, sampleRate: buf.sampleRate };
  } catch (e) {
    return null;
  }
}

/** 左右の音を start 秒から切り出す(負なら頭に無音を足す)。 */
export function cutFrom(left, right, sr, start) {
  const s = rint(start * sr);
  const out = [left, right].map((ch) => {
    if (s >= 0) return ch.slice(Math.min(s, ch.length));
    const o = new Float32Array(ch.length - s);
    o.set(ch, -s);
    return o;
  });
  return out;
}

/** 1 本にして半分の速さにする(音と絵のずれを測る包絡用。AVSYNC.sr)。 */
export function monoHalf(left, right) {
  const n = Math.floor(left.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[2 * i] + left[2 * i + 1] + right[2 * i] + right[2 * i + 1]) / 4;
  return out;
}

/** 1/2 に間引く(BGM_SR → ADT.sr ではなく、ADT.sr が BGM_SR と同じならそのまま)。 */
function toAnalysisRate(ch, sr) {
  if (sr === ADT.sr) return ch;
  throw new Error(`unexpected sample rate ${sr}`);
}

/** 曲フォルダのファイルを ZIP にする。@param {{path: string, bytes: Uint8Array}[]} files */
export function buildZip(files) {
  const w = new ZipWriter();
  for (const f of files) w.addFile(f.path, f.bytes);
  return w.finish();
}

function chartBytes(text) {
  return encodeText(text, 'shift_jis').bytes;
}

function kitFiles(folder) {
  return kitWavs().map((k) => ({ path: `${folder}/${k.path}`, bytes: k.bytes }));
}

/**
 * プレー動画から曲フォルダを作る。
 * @param {File|Blob} file
 * @param {{title?: string, layout?: string, rate?: number, offsetMs?: number|'auto', measureOffset?: number|null}} opts
 * @param {{onProgress?: (stage: string, frac: number) => void, log?: (s: string) => void, signal?: {cancelled: boolean},
 *   open?: Function, scan?: Function, decode?: Function}} [hooks] open / scan / decode はテストで差し替える
 * @returns {Promise<{files: {path: string, bytes: Uint8Array}[], folder: string, chartPath: string, title: string, summary: object}>}
 */
export async function generateFromVideo(file, opts = {}, hooks = {}) {
  const progress = hooks.onProgress || (() => {});
  const log = hooks.log || (() => {});
  const signal = hooks.signal || { cancelled: false };
  const title = opts.title || titleOf(file);
  const folder = folderName(title);
  progress('open', 0);
  const v = hooks.open ? await hooks.open(file) : await openVideo(file);
  let result;
  try {
    const scan = hooks.scan || ((roi, onFrame) => scanFrames(v.video, roi, {
      rate: opts.rate || 1, onFrame, signal, onProgress: (t) => progress('frames', v.duration ? t / v.duration : 0),
    }));
    result = await analyzeVideo({
      width: v.width, height: v.height, layout: opts.layout || 'auto', measureOffset: opts.measureOffset || null, log, scan,
    });
  } finally {
    if (!hooks.open) closeVideo(v);
  }
  if (signal.cancelled) throw new GenCancelled();
  progress('audio', 0);
  await yieldToUi();
  const audio = hooks.decode ? await hooks.decode(file) : await decodeStereo(file);
  if (signal.cancelled) throw new GenCancelled();
  const { grid } = result;
  const files = [];
  let bgm = null;
  let sync = null;
  if (audio) {
    sync = bgmStartOf(grid, audio.sampleRate === 2 * AVSYNC.sr ? monoHalf(audio.left, audio.right) : null,
      opts.offsetMs === undefined ? 'auto' : opts.offsetMs, log);
    const [l, r] = cutFrom(audio.left, audio.right, audio.sampleRate, sync.bgmStart);
    files.push({ path: `${folder}/bgm.wav`, bytes: encodeWav([l, r], audio.sampleRate) });
    bgm = { file: 'bgm.wav', m: 0, tick: 0 };
    log(`bgm.wav cut from video t=${sync.bgmStart.toFixed(3)}s`);
  } else {
    log('WARNING: the video has no readable audio; the chart has no BGM');
  }
  progress('chart', 0);
  const chips = videoChips(grid.placed);
  const span = Math.max(...grid.allTs) - grid.gridOrigin;
  const text = chartText({
    title, comment: 'auto-generated from play video', bpm: bpmText(grid.bpm, span), chips, barRatios: grid.barRatios, bgm,
    creator: 'vid2dtx',
  });
  files.unshift({ path: `${folder}/${CHART_NAME}`, bytes: chartBytes(text) });
  files.push(...kitFiles(folder));
  log(`wrote ${CHART_NAME} (${chips.length} chips)`);
  return {
    files, folder, chartPath: `${folder}/${CHART_NAME}`, title,
    summary: {
      kind: 'video', chips: chips.length, bpm: grid.bpm, layout: result.cfg.name, frames: result.frames, fps: result.fps,
      measureOffset: grid.measureOffset, offsetMs: sync ? sync.offsetMs : null, offsetMeasured: sync ? sync.measured : false, bgm: !!bgm,
    },
  };
}

/**
 * 曲の音(動画の音でもよい)から曲フォルダを作る(実験的)。
 * @param {File|Blob} file
 * @param {{title?: string}} opts
 * @param {{onProgress?: (stage: string, frac: number) => void, log?: (s: string) => void, signal?: {cancelled: boolean},
 *   decode?: Function}} [hooks]
 */
export async function generateFromAudio(file, opts = {}, hooks = {}) {
  const progress = hooks.onProgress || (() => {});
  const log = hooks.log || (() => {});
  const signal = hooks.signal || { cancelled: false };
  const title = opts.title || titleOf(file);
  const folder = folderName(title);
  progress('audio', 0);
  await yieldToUi();
  const audio = hooks.decode ? await hooks.decode(file) : await decodeStereo(file);
  if (!audio) throw new Error('cannot read the audio of the file');
  if (signal.cancelled) throw new GenCancelled();
  const keep = kindOfFile(file) === 'audio' && keepsOriginal(file);
  const left = toAnalysisRate(audio.left, audio.sampleRate);
  const right = toAnalysisRate(audio.right, audio.sampleRate);
  const r = await audioToChart(left, right, { log, signal, onProgress: (stage, f) => progress(stage, f), keepStart: keep });
  progress('chart', 0);
  const files = [];
  let bgm;
  if (keep) {
    const name = (file.name || 'bgm.ogg').replace(/^.*[\\/]/, '');
    files.push({ path: `${folder}/${name}`, bytes: new Uint8Array(await file.arrayBuffer()) });
    const tick = rint((-r.gridOrigin / r.tMeas) * 384);
    bgm = { file: name, m: Math.floor(tick / 384), tick: tick % 384 };
    log(`BGM: ${name} as is, starting at measure 0 tick ${bgm.tick}`);
  } else {
    const [l, rr] = cutFrom(audio.left, audio.right, audio.sampleRate, r.gridOrigin);
    files.push({ path: `${folder}/bgm.wav`, bytes: encodeWav([l, rr], audio.sampleRate) });
    bgm = { file: 'bgm.wav', m: 0, tick: 0 };
    log(`bgm.wav cut from the audio at t=${r.gridOrigin.toFixed(3)}s`);
  }
  const text = chartText({
    title, comment: 'auto-transcribed from audio (draft)', bpm: audioBpmText(r.bpm), chips: r.chips, bgm, creator: 'audio2dtx',
  });
  files.unshift({ path: `${folder}/${CHART_NAME}`, bytes: chartBytes(text) });
  // 確信度(audio2dtx と同じ形。origin_s は元の音の時刻での小節 0)
  const conf = {
    version: 1, origin_s: r.gridOrigin, t_meas: r.tMeas,
    chips: r.chips.map((c) => ({ m: c.m, tick: c.tick, ch: KIT[c.kind].ch, conf: c.conf, why: c.why })),
  };
  files.push({ path: `${folder}/${CHART_NAME}.conf.json`, bytes: new TextEncoder().encode(JSON.stringify(conf)) });
  files.push(...kitFiles(folder));
  log(`wrote ${CHART_NAME} (${r.chips.length} chips, low-confidence ${r.stats.low})`);
  return {
    files, folder, chartPath: `${folder}/${CHART_NAME}`, title,
    summary: { kind: 'audio', chips: r.chips.length, bpm: r.bpm, low: r.stats.low, keptBgm: keep, bgm: true },
  };
}

export { GenCancelled };
