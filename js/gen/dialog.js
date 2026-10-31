// ホームの「動画・音声から作る」のダイアログ(本アプリの追加。vid2dtx の GUI の生成の部分に当たる。docs/spec/vid2dtx-gen.md §7)。
// ファイルを選び(動画なら配置を確かめる絵を出す)、作る間は進み具合を出し(やめられる)、できたら編集画面で開くか ZIP を保存する。
// - Enter は「作る」(Space は BD のキーなので決定に使わない)、Esc は作っている間なら「やめる」、ほかは閉じる

import { t } from '../i18n.js';
import { downloadBlob } from '../edit/save.js';
import { layoutFor } from './layout.js';
import { openVideo, closeVideo, seekFrame, canScanFrames } from './frames.js';
import { kindOfFile, titleOf, generateFromVideo, generateFromAudio, buildZip, GenCancelled } from './generate.js';

const $ = (id) => document.getElementById(id);

/** 段 → 文言のキー。 */
const STAGE_KEY = {
  open: 'gen.stageOpen', frames: 'gen.stageFrames', audio: 'gen.stageAudio', stft: 'gen.stageStft', hpss: 'gen.stageHpss',
  nmf: 'gen.stageNmf', model: 'gen.stageModel', chart: 'gen.stageChart', zip: 'gen.stageZip',
};

/** 段ごとの進み具合の範囲(全体の 0〜1)。 */
const STAGES = {
  video: { open: [0, 0.01], frames: [0.01, 0.9], audio: [0.9, 0.95], chart: [0.95, 1] },
  audio: { audio: [0, 0.1], stft: [0.1, 0.2], hpss: [0.2, 0.5], nmf: [0.5, 0.92], model: [0.5, 0.92], chart: [0.92, 1] },
};

/** 進み具合の全体の割合(0〜1)。 */
export function overallProgress(kind, stage, frac) {
  const r = (STAGES[kind] || {})[stage];
  if (!r) return null;
  return r[0] + (r[1] - r[0]) * Math.max(0, Math.min(1, frac || 0));
}

/** 配置の確かめの絵: 動画のコマに、チップを探す範囲・レーンの帯・判定ラインを重ねる。 */
export function drawLayoutPreview(ctx, img, cfg) {
  const { width: W, height: H } = ctx.canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (img) ctx.drawImage(img, 0, 0, W, H);
  const sx = W / cfg.width;
  const sy = H / cfg.height;
  ctx.save();
  ctx.lineWidth = 1;
  cfg.lanes.forEach((l, i) => {
    ctx.fillStyle = i % 2 ? 'rgba(80, 200, 255, 0.18)' : 'rgba(255, 200, 80, 0.18)';
    ctx.fillRect(l.x0 * sx, cfg.scanY0 * sy, (l.x1 - l.x0) * sx, (cfg.scanY1 - cfg.scanY0) * sy);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(9, Math.round(11 * Math.min(1, W / 640)))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(l.name, ((l.x0 + l.x1) / 2) * sx, cfg.scanY0 * sy - 3);
  });
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.strokeRect(cfg.fieldX0 * sx, cfg.scanY0 * sy, (cfg.fieldX1 - cfg.fieldX0) * sx, (cfg.scanY1 - cfg.scanY0) * sy);
  ctx.strokeStyle = '#ffd34a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cfg.fieldX0 * sx, cfg.judgeY * sy);
  ctx.lineTo(cfg.fieldX1 * sx, cfg.judgeY * sy);
  ctx.stroke();
  ctx.restore();
}

export class GenDialog {
  /**
   * @param {{onOpen: (zip: Blob, name: string, chartPath: string) => Promise<boolean>}} o
   *   onOpen: できた曲フォルダの ZIP を曲パックとして開き、譜面を編集画面で開く(開けたら true)
   */
  constructor(o) {
    this.onOpen = o.onOpen;
    this.dlg = $('gen-dialog');
    this.file = null;
    this.kind = null;
    this.running = null;
    this.result = null;
    this.frame = null; // 確かめの絵のコマ(canvas)
    this._bind();
  }

  _bind() {
    const d = this.dlg;
    $('gen-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.setFile(f);
    });
    for (const r of d.querySelectorAll('input[name="gen-kind"]')) r.addEventListener('change', () => this._sync());
    $('gen-layout').addEventListener('change', () => this._drawPreview());
    $('gen-start').addEventListener('click', () => this.start());
    $('gen-close').addEventListener('click', () => {
      if (this.running) this.running.cancelled = true;
      else this.close();
    });
    $('gen-save').addEventListener('click', () => {
      if (this.result) downloadBlob(this.result.zip, this.result.zipName);
    });
    $('gen-open').addEventListener('click', async () => {
      if (!this.result) return;
      const r = this.result;
      const ok = await this.onOpen(r.zip, r.zipName, r.chartPath);
      if (ok) this.close();
    });
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (this.running) this.running.cancelled = true;
      else this.close();
    });
    // Space(BD のキー)で選んでいるボタンを押させない。Enter は「作る」
    const noSpace = (e) => {
      if (e.code === 'Space' && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
    };
    d.addEventListener('keydown', noSpace, true);
    d.addEventListener('keyup', noSpace, true);
    $('gen-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.running && !this.result && this.file) this.start();
    });
    // ダイアログの上にファイルを落としても選べる
    d.addEventListener('dragover', (e) => e.preventDefault());
    d.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && !this.running) this.setFile(f);
    });
  }

  open() {
    this.result = null;
    this._showResult(null);
    $('gen-log').textContent = '';
    $('gen-log-box').hidden = true;
    $('gen-progress').hidden = true;
    $('gen-offset').placeholder = t('gen.auto');
    $('gen-measure').placeholder = t('gen.auto');
    this._sync();
    if (!this.dlg.open) this.dlg.showModal();
  }

  close() {
    if (this.dlg.open) this.dlg.close();
  }

  /** ファイルを選ぶ(動画なら配置を確かめる絵を読む)。 */
  async setFile(f) {
    const kind = kindOfFile(f);
    if (!kind) {
      this._error(t('gen.badFile', { name: f.name }));
      return;
    }
    this.file = f;
    this.kind = kind;
    this.result = null;
    this._showResult(null);
    $('gen-file-name').textContent = f.name;
    $('gen-name').value = titleOf(f);
    const video = this.dlg.querySelector('input[name="gen-kind"][value="video"]');
    const audio = this.dlg.querySelector('input[name="gen-kind"][value="audio"]');
    video.disabled = kind !== 'video' || !canScanFrames();
    if (video.disabled) audio.checked = true;
    else video.checked = true;
    this.frame = null;
    this.videoSize = null;
    this._sync();
    if (kind === 'video') await this._loadPreview(f);
  }

  async _loadPreview(f) {
    let v = null;
    try {
      v = await openVideo(f);
      if (this.file !== f) return;
      await seekFrame(v.video, (v.duration || 0) * 0.35);
      const c = document.createElement('canvas');
      c.width = v.width;
      c.height = v.height;
      c.getContext('2d').drawImage(v.video, 0, 0);
      if (this.file !== f) return;
      this.frame = c;
      this.videoSize = { width: v.width, height: v.height, duration: v.duration };
      this._drawPreview();
    } catch (e) {
      if (this.file === f) $('gen-preview-note').textContent = t('gen.previewFailed');
    } finally {
      closeVideo(v);
    }
  }

  _drawPreview() {
    const canvas = $('gen-preview');
    const note = $('gen-preview-note');
    if (!this.videoSize) {
      canvas.hidden = true;
      return;
    }
    const { width, height } = this.videoSize;
    const cfg = layoutFor($('gen-layout').value, width, height);
    canvas.hidden = false;
    const w = Math.min(560, Math.max(240, (canvas.parentElement && canvas.parentElement.clientWidth) || 480));
    canvas.width = w;
    canvas.height = Math.round((w * height) / width);
    drawLayoutPreview(canvas.getContext('2d'), this.frame, cfg);
    note.textContent = t('gen.previewNote', { layout: t(LAYOUT_KEY[cfg.name] || 'gen.layoutDtx'), w: width, h: height });
  }

  _mode() {
    const r = this.dlg.querySelector('input[name="gen-kind"]:checked');
    return r ? r.value : 'video';
  }

  _sync() {
    const mode = this._mode();
    const busy = !!this.running;
    $('gen-video-opts').hidden = mode !== 'video';
    $('gen-audio-note').hidden = mode !== 'audio';
    $('gen-start').disabled = busy || !this.file;
    $('gen-start').hidden = !!this.result;
    $('gen-close').textContent = busy ? t('gen.stop') : t('gen.close');
    for (const el of this.dlg.querySelectorAll('input, select')) {
      if (el.name === 'gen-kind' && el.value === 'video' && (this.kind !== 'video' || !canScanFrames())) el.disabled = true;
      else el.disabled = busy;
    }
    $('gen-pick').classList.toggle('disabled', busy);
    $('gen-video-note').hidden = mode !== 'video' || canScanFrames();
  }

  _error(msg) {
    const el = $('gen-result');
    el.hidden = false;
    el.className = 'status error';
    el.textContent = msg;
  }

  _showResult(text) {
    const el = $('gen-result');
    el.hidden = !text;
    el.className = 'status';
    el.textContent = text || '';
    $('gen-open').hidden = !this.result;
    $('gen-save').hidden = !this.result;
  }

  async start() {
    if (this.running || !this.file) return;
    const mode = this._mode();
    const file = this.file;
    const signal = { cancelled: false };
    this.running = signal;
    this.result = null;
    this._showResult(null);
    const logEl = $('gen-log');
    logEl.textContent = '';
    $('gen-log-box').hidden = false;
    $('gen-progress').hidden = false;
    const bar = $('gen-bar');
    const stageEl = $('gen-stage');
    bar.value = 0;
    this._sync();
    const log = (s) => {
      logEl.textContent += s + '\n';
    };
    const onProgress = (stage, frac) => {
      const p = overallProgress(mode, stage, frac);
      if (p !== null) bar.value = Math.round(p * 100);
      if (STAGE_KEY[stage]) stageEl.textContent = t(STAGE_KEY[stage], { pct: Math.round((frac || 0) * 100) });
    };
    const offRaw = $('gen-offset').value.trim();
    const mRaw = $('gen-measure').value.trim();
    const opts = {
      title: $('gen-name').value.trim() || titleOf(file),
      layout: $('gen-layout').value,
      rate: Number($('gen-rate').value) || 1,
      offsetMs: offRaw === '' ? 'auto' : Number(offRaw) || 0,
      measureOffset: mRaw === '' ? null : Math.max(0, Math.round(Number(mRaw)) || 0),
    };
    const t0 = performance.now();
    try {
      const r = mode === 'video'
        ? await generateFromVideo(file, opts, { onProgress, log, signal })
        : await generateFromAudio(file, opts, { onProgress, log, signal });
      bar.value = 100;
      stageEl.textContent = t(STAGE_KEY.zip);
      const zip = buildZip(r.files);
      const s = r.summary;
      this.result = { zip, zipName: `${r.folder}.zip`, chartPath: r.chartPath };
      const secs = Math.round((performance.now() - t0) / 1000);
      const bpm = Math.round(s.bpm * 1000) / 1000;
      this._showResult(s.kind === 'video'
        ? t('gen.doneVideo', {
          n: s.chips, bpm, secs,
          off: s.offsetMs === null ? '—' : `${s.offsetMs >= 0 ? '+' : ''}${Math.round(s.offsetMs)}`,
        })
        : t('gen.doneAudio', { n: s.chips, low: s.low, bpm, secs }));
      stageEl.textContent = '';
    } catch (e) {
      if (e instanceof GenCancelled || (e && e.name === 'GenCancelled')) {
        this._error(t('gen.cancelled'));
      } else {
        console.error(e);
        this._error(t('gen.failed', { msg: e && e.message ? e.message : e }));
      }
      stageEl.textContent = '';
    } finally {
      this.running = null;
      this._sync();
    }
  }
}

const LAYOUT_KEY = { 'dtxmania-720': 'gen.layoutDtx', 'gitadora-1080': 'gen.layoutGita' };
