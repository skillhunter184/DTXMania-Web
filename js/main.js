// アプリ本体: 画面遷移(ホーム / 演奏)、設定 UI、入力とメニューの接続、描画ループ。

import { SongPackage } from './core/song.js';
import { AudioEngine } from './core/audio.js';
import { loadJSON, saveJSON, saveLastZip, loadLastZip, saveSkinFiles, loadSkinFiles } from './core/storage.js';
import { LANE_NAMES, INSTRUMENT, gbPart } from './core/dtx.js';
import { chartHasInstrument } from './core/instmerge.js';
import { TrainingSettings, LOOP_UNIT, stepLoopTime, formatLoopTime } from './game/training.js';
import { Player, PLAYER_STATE } from './game/player.js';
import { GuitarPlayer } from './game/gbplayer.js';
import { HitRanges } from './game/hitranges.js';
import { Skin, PANELS, LEGACY_SKIN_BASE, collectSkinFiles, normalizeSkinPath } from './ui/skin.js';
import { Renderer } from './ui/renderer.js';
import { GuitarRenderer } from './ui/gbrenderer.js';
import { FramePacer, IDLE_DRAW_FPS } from './ui/framepace.js';
import { TrainingMenu, MENU_COMMAND } from './ui/menu.js';
import { DrumInput, LANE_KEY_DEFAULTS } from './ui/input.js';
import { GuitarInput, GB_KEY_DEFAULTS, GB_BUTTON_NAMES } from './ui/gbinput.js';
import { defaultBindings, normalizeBindings, laneKeysText } from './ui/keybind.js';
import { KeyBindPanel } from './ui/keypanel.js';
import { MidiInput } from './ui/midi.js';
import { defaultMidiNotes, defaultVelocityMin, normalizeMidiNotes, normalizeVelocityMin } from './ui/midibind.js';
import { MidiPanel } from './ui/midipanel.js';
import { t, getLang, setLang, initialLang, applyDom } from './i18n.js';

const $ = (id) => document.getElementById(id);

// 状態表示の文言は「今の言語で作り直す関数」で持ち、言語を切り替えたら作り直す(文字列も受け付ける)。
const msg = (key, vars) => () => t(key, vars);
const textOf = (m) => (typeof m === 'function' ? m() : m || '');

const DEFAULT_CONFIG = {
  bindings: defaultBindings(),
  // ギター / ベースのキー(R G B Y P / PICK / WAIL。ドラムとは別に持ち、ギターとベースで共有する。js/ui/gbinput.js)
  gbBindings: defaultBindings(GB_KEY_DEFAULTS),
  gbVolume: 100, // 弾いているギター / ベースの音量(ドラムの chipVolume と同じく 'chip' のバス)
  gbLight: true, // 空ピック(押さえ方の違うピック)を BAD にしない(NX GuitarLight / BassLight。既定 ON)
  // 電子ドラム(MIDI)。キーボードの bindings とは別に持つ(js/ui/midibind.js の冒頭)
  midiNotes: defaultMidiNotes(),
  midiVelocityMin: defaultVelocityMin(),
  midiEnabled: false, // 一度「電子ドラムを使う」で開けたら、次からは起動時に開く
  masterVolume: 80,
  chipVolume: 100,
  bgmVolume: 100,
  latencyMs: 0,
  showLag: true,
  layout: 'auto',
  // スキン: 'default' は同梱の skins/default/、'folder' は skinPath のフォルダ、'files' は読み込んだ画像(IndexedDB)。
  // 足りない画像は既定のスキンで補う(元実装に無い追加。書式は skins/README.md)
  skin: 'default',
  skinPath: LEGACY_SKIN_BASE,
  hhGroup: 0,
  ftGroup: 0,
  cyGroup: 0,
  bdGroup: 0,
};

/** ミリ秒を m:ss.s で表す(シークバーの位置表示)。 */
function clockText(ms) {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
}

/** 楽器の表示名のキー(js/i18n.js。INSTRUMENT の番号の順)。 */
const INSTRUMENT_NAMES = ['song.drums', 'song.guitar', 'song.bass'];

/** #DLEVEL / #GLEVEL / #BLEVEL の表示(DTXMania と同じ 2 桁レベルは 1/10、3 桁は 1/100 の小数表記)。 */
function levelText(level, dec) {
  if (!level) return '';
  const v = level >= 100 ? level / 10 : level / 10 + (dec || 0) / 100;
  return v.toFixed(2);
}

class App {
  constructor() {
    // 表示言語は設定(config)とは別に dojo.lang に置く(index.html の <head> のスクリプトも読むため)
    setLang(initialLang(location.search, loadJSON('lang', null)));
    const saved = loadJSON('config', {}) || {};
    this.config = Object.assign({}, DEFAULT_CONFIG, saved);
    // 以前の「スキン画像(assets/skin)を使う」(skinImages)は、そのフォルダを指定したスキンへ移す
    if (saved.skin === undefined && saved.skinImages !== undefined) this.config.skin = saved.skinImages ? 'folder' : 'default';
    delete this.config.skinImages;
    // 壊れている / 古い形式の config でもレーン単位で直す(1 レーンの欠落で他 9 レーンを捨てない)
    const norm = normalizeBindings(this.config.bindings);
    this.config.bindings = norm.bindings;
    this._keysRepaired = norm.repaired; // 起動時に直したレーン(設定を開いたときに知らせる)
    const gbNorm = normalizeBindings(this.config.gbBindings, GB_KEY_DEFAULTS);
    this.config.gbBindings = gbNorm.bindings;
    this._gbKeysRepaired = gbNorm.repaired;
    this.config.gbLight = this.config.gbLight !== false;
    const midiNorm = normalizeMidiNotes(this.config.midiNotes);
    this.config.midiNotes = midiNorm.notes;
    this.config.midiVelocityMin = normalizeVelocityMin(this.config.midiVelocityMin);
    this._midiRepaired = midiNorm.repaired;
    // MIDI は曲をまたいで開いたままにする(設定画面のモニタと演奏の両方で使う)
    this.midi = new MidiInput({
      onHit: (lane, ts) => this.onMidiHit(lane, ts),
      onNote: (info) => { if (this.midiPanel) this.midiPanel.onNote(info); },
      onDevices: (change) => this.onMidiDevices(change),
    });
    this.midi.setBindings(this.config.midiNotes, this.config.midiVelocityMin);
    this.midiPanel = null;
    this.training = TrainingSettings.load();
    this.audio = new AudioEngine();
    this.audio.userLatencyMs = this.config.latencyMs;
    this.audio.setMasterVolume(this.config.masterVolume / 100);
    this.playInst = INSTRUMENT.DRUMS; // 演奏中の楽器(音量の振り分けとメニューに使う)
    this.applyVolumes();
    this.skin = null;
    this._skinLoad = null; // 設定に合わせた Skin の読み込み(loadSkin)。演奏開始はこれを待つ
    this._skinFiles = null; // 読み込んだスキンの画像 [{name, blob}](IndexedDB から一度だけ読む)
    this.pkg = null;
    this.player = null;
    this.renderer = null;
    this.menu = null;
    this.input = null;
    this.raf = 0;
    this.pacer = new FramePacer(); // 停止中の描画の間引き(画面の Hz は曲をまたいで持ち越す)
    this._loadGen = 0;
    this.keyPanel = null; // 設定の「キー割り当て」(js/ui/keypanel.js)
    this.gbKeyPanel = null; // 同じくギター / ベース
    this._seek = null; // 停止中のシークバー
    this._wakeLock = null;
    this._status = null; // ホームの状態表示 {msg, error}(言語の切り替えで作り直す)
    this._skinNotes = []; // スキンの下の注記(同上)
    this._lastZip = null; // 「前回の ZIP を開く」の {blob, name}
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    document.body.classList.toggle('touch', this.isTouch);
    document.body.classList.toggle('desktop', !this.isTouch);
  }

  async init() {
    this.applyLanguage();
    this.bindLanguage();
    this.bindHome();
    this.buildSettingsUi();
    this.bindSeekBar();
    if (this.config.midiEnabled) this.autoConnectMidi();
    this.loadSkin();
    const last = await loadLastZip();
    if (last && last.blob) this.showLastButton(last.blob, last.name);
    // ?zip=URL で同一サイト上の ZIP を直接開く(デモ配置・テスト用)
    const zipUrl = new URLSearchParams(location.search).get('zip');
    if (zipUrl) {
      try {
        this.setStatus(msg('load.fetching', { url: zipUrl }));
        const r = await fetch(zipUrl);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        await this.loadPackage(blob, zipUrl.split('/').pop(), { fromCache: true });
      } catch (e) {
        this.setStatus(msg('load.fetchFailed', { msg: e.message }), true);
      }
    }
  }

  showLastButton(blob, name) {
    const b = $('btn-last');
    this._lastZip = { blob, name };
    b.hidden = false;
    b.textContent = t('home.lastZip', { name: name || 'zip' });
    b.onclick = () => this.loadPackage(blob, name, { fromCache: true });
  }

  // ---- 表示言語(日本語 / English) ----

  bindLanguage() {
    for (const b of document.querySelectorAll('#lang-switch [data-lang]')) {
      b.addEventListener('click', () => this.setLanguage(b.dataset.lang));
    }
  }

  /** 言語を切り替えて保存し、画面の文言を書き直す。URL に ?lang= があればそれも合わせる(リロードで戻らないように)。 */
  setLanguage(lang) {
    if (lang === getLang()) return;
    setLang(lang);
    saveJSON('lang', getLang());
    try {
      const url = new URL(location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.set('lang', getLang());
        history.replaceState(history.state, '', url);
      }
    } catch (e) {
      // URL を書き換えられなくても切り替えは効く
    }
    this.applyLanguage();
    this.relocalize();
  }

  /** index.html の文言(data-i18n)と <html lang>、切り替えボタンの状態。英語のとき隠していた画面も出す。 */
  applyLanguage() {
    const lang = getLang();
    document.documentElement.lang = lang;
    applyDom(document);
    for (const b of document.querySelectorAll('#lang-switch [data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    document.documentElement.classList.remove('i18n-wait');
  }

  /** JS で組み立てた文言を今の言語で作り直す。切り替えはホーム画面でしかできないので、演奏画面の分は開くたびに作る。 */
  relocalize() {
    if (this._status) this.setStatus(this._status.msg, this._status.error);
    if (this._lastZip) this.showLastButton(this._lastZip.blob, this._lastZip.name);
    if (this.keyPanel) this.keyPanel.relocalize();
    if (this.gbKeyPanel) this.gbKeyPanel.relocalize();
    this.updateHelpKeys();
    if (this.pkg) this.renderSongList();
    if (this.midiPanel) this.midiPanel.relocalize();
    if (this.skin) this.renderSkinFilesInfo();
    this.renderSkinNote();
  }

  // ---- ホーム ----
  bindHome() {
    const dz = $('dropzone');
    $('file-zip').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.loadPackage(f, f.name, {});
      e.target.value = '';
    });
    $('file-dir').addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      if (files.length) this.loadFolder(files);
      e.target.value = '';
    });
    const onDrop = (e) => {
      const items = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (!items.length) return;
      const zip = items.find((f) => /\.zip$/i.test(f.name));
      if (zip) this.loadPackage(zip, zip.name, {});
      else this.loadFolder(items);
    };
    for (const ev of ['dragenter', 'dragover']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); });
    for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); });
    dz.addEventListener('drop', onDrop);
    // 枠の外に落としてもブラウザが ZIP を開いて(ダウンロードして)しまわないよう、ページ全体で受ける
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!$('screen-home').hidden && !dz.contains(e.target)) onDrop(e);
    });
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.onResize(), 200));
    window.addEventListener('blur', () => {
      if (this.menu) this.menu.releaseAll();
      this.cancelAssign(msg('keys.blur'));
    });
    // タブが隠れたら(スマホでアプリ切替など)演奏を一時停止し、ミスの山を作らない
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.player && this.player.state === PLAYER_STATE.PLAYING) this.player.togglePause();
      if (!document.hidden && this.audio.ctx && this.audio.ctx.state !== 'running') this.audio.ctx.resume().catch(() => {});
    });
  }

  /** 演奏中は画面スリープを抑止する(対応ブラウザのみ)。 */
  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !this._wakeLock) this._wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      this._wakeLock = null;
    }
  }

  releaseWakeLock() {
    if (this._wakeLock) {
      this._wakeLock.release().catch(() => {});
      this._wakeLock = null;
    }
  }

  /** ホームの状態表示。text は文字列か、今の言語の文言を返す関数(msg)。 */
  setStatus(text, error = false) {
    this._status = text ? { msg: text, error } : null;
    const el = $('pkg-status');
    const s = textOf(text);
    el.hidden = !s;
    el.textContent = s;
    el.classList.toggle('error', error);
  }

  async loadPackage(blob, name, opts) {
    const gen = ++this._loadGen;
    this.setStatus(msg('load.zip'));
    try {
      const pkg = await SongPackage.fromZip(blob, name);
      if (gen !== this._loadGen) { pkg.dispose(); return; } // 後から別の読み込みが始まった
      if (this.pkg) this.pkg.dispose();
      this.pkg = pkg;
      await this.showSongList();
      if (!opts.fromCache && blob.size < 400 * 1024 * 1024) {
        saveLastZip(blob, name).then((ok) => { if (ok && gen === this._loadGen) this.showLastButton(blob, name); });
      }
    } catch (e) {
      console.error(e);
      if (gen === this._loadGen) this.setStatus(msg('load.failed', { msg: e && e.message ? e.message : e }), true);
    }
  }

  async loadFolder(files) {
    const gen = ++this._loadGen;
    this.setStatus(msg('load.folder'));
    try {
      const pkg = await SongPackage.fromFiles(files);
      if (gen !== this._loadGen) { pkg.dispose(); return; }
      if (this.pkg) this.pkg.dispose();
      this.pkg = pkg;
      await this.showSongList();
    } catch (e) {
      console.error(e);
      if (gen === this._loadGen) this.setStatus(msg('load.failed', { msg: e && e.message ? e.message : e }), true);
    }
  }

  async showSongList() {
    const pkg = this.pkg;
    if (!pkg.songs.length) {
      $('song-list').innerHTML = '';
      this.setStatus(msg('load.noCharts'), true);
      return;
    }
    this.setStatus(msg('load.songCount', { name: pkg.name || 'ZIP', n: pkg.songs.length }));
    this.renderSongList();
  }

  /**
   * 曲の一覧。曲ごとに、楽器(ドラム / ギター / ベース)ごとの行に難易度のボタンを並べる。1 つの譜面にギターとベースが
   * 入っていれば両方の行に出る。楽器の判らない譜面(レベルもチップも無い)はドラムの行に置く(以前の一覧と同じ)。
   */
  renderSongList() {
    const pkg = this.pkg;
    const list = $('song-list');
    list.innerHTML = '';
    if (!pkg || !pkg.songs.length) return;
    for (const song of pkg.songs) {
      const li = document.createElement('li');
      li.className = 'song';
      const img = document.createElement('img');
      img.className = 'jacket';
      img.alt = '';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const h = song.charts[0].header;
      meta.innerHTML = `<div class="title"></div><div class="artist"></div>`;
      meta.querySelector('.title').textContent = song.title;
      meta.querySelector('.artist').textContent = [h.artist, h.bpm ? 'BPM ' + h.bpm : ''].filter(Boolean).join('  ');
      for (const inst of [INSTRUMENT.DRUMS, INSTRUMENT.GUITAR, INSTRUMENT.BASS]) {
        const charts = song.charts.filter((c) => chartHasInstrument(c.header, inst)
          || (inst === INSTRUMENT.DRUMS && ![0, 1, 2].some((i) => chartHasInstrument(c.header, i))));
        if (!charts.length) continue;
        const row = document.createElement('div');
        row.className = 'charts inst-' + inst;
        const tag = document.createElement('span');
        tag.className = 'inst';
        tag.textContent = t(INSTRUMENT_NAMES[inst]);
        row.appendChild(tag);
        for (const c of charts) {
          const b = document.createElement('button');
          b.innerHTML = `<span class="lbl"></span><span class="lv"></span>`;
          const label = c.label || c.header.title || c.path.split('/').pop();
          b.querySelector('.lbl').textContent = label;
          const levels = c.header.levels || [c.header.level, 0, 0];
          const decs = c.header.levelDecs || [c.header.levelDec, 0, 0];
          b.querySelector('.lv').textContent = levelText(levels[inst], decs[inst]);
          b.setAttribute('aria-label', t('song.playLabel', { inst: t(INSTRUMENT_NAMES[inst]), label }));
          b.onclick = () => this.startChart(song, c, inst);
          row.appendChild(b);
        }
        meta.appendChild(row);
      }
      li.appendChild(img);
      li.appendChild(meta);
      list.appendChild(li);
      if (h.preimage) pkg.imageUrl(song.dir, h.preimage).then((u) => { if (u) img.src = u; }).catch(() => {});
    }
  }

  // ---- キー割り当て UI(js/ui/keypanel.js) ----

  /** キー割り当ての待ち受けを畳む(割り当ては行わない)。reason を渡すと状態表示も書き換える。 */
  cancelAssign(reason) {
    if (this.keyPanel) this.keyPanel.cancelAssign(reason);
    if (this.gbKeyPanel) this.gbKeyPanel.cancelAssign(reason);
  }

  buildKeyUi() {
    // ドラムとギター / ベースの欄・電子ドラムの「叩いて追加」は同時には待たない(待ち受けを始めたらほかを畳む)
    const others = (self) => () => {
      for (const p of [this.keyPanel, this.gbKeyPanel]) if (p && p !== self) p.cancelAssign(msg('common.canceled'));
      if (this.midiPanel) this.midiPanel.cancelCapture(msg('common.canceled'));
    };
    this.keyPanel = new KeyBindPanel({
      list: $('key-list'),
      statusText: $('key-status-text'),
      undoButton: $('key-undo'),
      resetAllButton: $('btn-keys-default'),
      names: LANE_NAMES,
      defaults: LANE_KEY_DEFAULTS,
      getBindings: () => this.config.bindings,
      setBindings: (next) => { this.config.bindings = next; this.saveConfig(); },
      onChange: () => this.updateHelpKeys(),
    });
    this.keyPanel.beforeAssign = others(this.keyPanel);
    this.gbKeyPanel = new KeyBindPanel({
      list: $('gb-key-list'),
      statusText: $('gb-key-status-text'),
      undoButton: $('gb-key-undo'),
      resetAllButton: $('btn-gb-keys-default'),
      names: GB_BUTTON_NAMES,
      defaults: GB_KEY_DEFAULTS,
      getBindings: () => this.config.gbBindings,
      setBindings: (next) => { this.config.gbBindings = next; this.saveConfig(); },
      onChange: () => this.updateHelpKeys(),
    });
    this.gbKeyPanel.beforeAssign = others(this.gbKeyPanel);
    this.keyPanel.build(this._keysRepaired || []);
    this.gbKeyPanel.build(this._gbKeysRepaired || []);
    this.updateHelpKeys();
  }

  /** 操作方法パネルのドラム行とギター / ベース行を今の割り当てで書き直す。 */
  updateHelpKeys() {
    const el = $('help-keys');
    if (el) el.textContent = this.config.bindings.map((codes, lane) => `${LANE_NAMES[lane]}=${laneKeysText(codes)}`).join('  ');
    const gb = $('help-gb-keys');
    if (gb) gb.textContent = this.config.gbBindings.map((codes, b) => `${GB_BUTTON_NAMES[b]}=${laneKeysText(codes)}`).join('  ');
  }

  // ---- 電子ドラム(MIDI) ----

  /**
   * 前に「電子ドラムを使う」で開いた人だけ、起動時に開く。許可がまだ決まっていない(prompt)ときは
   * ページを開いただけでダイアログを出さないよう、ボタンを待つ。
   */
  async autoConnectMidi() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'midi', sysex: false });
        if (st.state === 'prompt') return;
      }
    } catch (e) {
      // 'midi' を問い合わせられないブラウザはそのまま試す
    }
    await this.midi.connect();
  }

  /** 電子ドラムの打鍵(しきい値を通り、まとめたあと)。演奏画面の準備ができているときだけ判定へ流す。 */
  onMidiHit(lane, ts) {
    if (!this.player || !this.input) return; // キーボードと同じく、読み込みが済んで入力を張ったあとから
    this.player.hit(lane, ts, {});
    this.pacer.forceNext();
  }

  onMidiDevices(change) {
    if (this.midiPanel) this.midiPanel.renderDevices();
    // 演奏中の抜き差しは画面に出す(叩いても鳴らない理由が分かるように)
    if (this.player && this.input && change) {
      if (change.added.length) this.player.showStatus(t('midi.connectedToast', { names: change.added.join(', ') }), 2500);
      if (change.removed.length) this.player.showStatus(t('midi.disconnectedToast', { names: change.removed.join(', ') }), 4000);
    }
  }

  // ---- 設定 UI ----
  buildSettingsUi() {
    const c = this.config;
    this.buildKeyUi();
    this.midiPanel = new MidiPanel({
      config: c,
      midi: this.midi,
      onChange: () => {
        this.midi.setBindings(c.midiNotes, c.midiVelocityMin);
        this.saveConfig();
      },
      beforeCapture: () => this.cancelAssign(msg('common.canceled')),
      visible: () => !$('screen-home').hidden && $('settings-panel').open,
    });
    this.midiPanel.build();
    $('settings-panel').addEventListener('toggle', () => this.midiPanel.refresh());
    const badMidi = (this._midiRepaired || []).map((l) => LANE_NAMES[l]);
    if (badMidi.length) this.midiPanel.setStatus(msg('midi.repaired', { lanes: badMidi.join(' / ') }));

    const bindRange = (id, key, apply) => {
      const el = $(id);
      const v = $(id + '-v');
      el.value = c[key];
      if (v) v.textContent = c[key];
      el.oninput = () => { c[key] = Number(el.value); if (v) v.textContent = c[key]; if (apply) apply(c[key]); this.saveConfig(); };
    };
    bindRange('cfg-volume', 'masterVolume', (v) => this.audio.setMasterVolume(v / 100));
    bindRange('cfg-chip', 'chipVolume', () => this.applyVolumes());
    bindRange('cfg-bgm', 'bgmVolume', () => this.applyVolumes());
    bindRange('cfg-gb', 'gbVolume', () => this.applyVolumes());
    const bad = $('cfg-gb-bad');
    bad.checked = !c.gbLight;
    bad.onchange = () => { c.gbLight = !bad.checked; this.saveConfig(); };
    const lat = $('cfg-latency');
    lat.value = c.latencyMs;
    lat.onchange = () => { c.latencyMs = Number(lat.value) || 0; this.audio.userLatencyMs = c.latencyMs; this.saveConfig(); };
    const lag = $('cfg-lag');
    lag.checked = !!c.showLag;
    lag.onchange = () => { c.showLag = lag.checked; if (this.renderer) this.renderer.showLag = c.showLag; this.saveConfig(); };
    const layout = $('cfg-layout');
    layout.value = c.layout || 'auto';
    layout.onchange = () => { c.layout = layout.value; this.saveConfig(); this.onResize(); };
    this.buildSkinUi();
    for (const [id, key] of [['cfg-hh', 'hhGroup'], ['cfg-ft', 'ftGroup'], ['cfg-cy', 'cyGroup'], ['cfg-bd', 'bdGroup']]) {
      const el = $(id);
      el.value = String(c[key]);
      el.onchange = () => { c[key] = Number(el.value); this.saveConfig(); };
    }
  }

  /** 設定の「スキン」(既定 / フォルダを指定 / 読み込んだ画像)。 */
  buildSkinUi() {
    const c = this.config;
    const sel = $('cfg-skin');
    const path = $('cfg-skin-path');
    const file = $('cfg-skin-file');
    const showRows = () => {
      $('cfg-skin-path-row').hidden = c.skin !== 'folder';
      $('cfg-skin-files-row').hidden = c.skin !== 'files';
    };
    sel.value = ['default', 'folder', 'files'].includes(c.skin) ? c.skin : 'default';
    c.skin = sel.value;
    path.value = c.skinPath = normalizeSkinPath(c.skinPath);
    showRows();
    sel.onchange = () => { c.skin = sel.value; showRows(); this.saveConfig(); this.loadSkin(); };
    path.onchange = () => { path.value = c.skinPath = normalizeSkinPath(path.value); this.saveConfig(); this.loadSkin(); };
    $('cfg-skin-pick').onclick = () => file.click();
    file.onchange = async () => {
      const picked = [...file.files];
      file.value = '';
      let files = [];
      try {
        files = await collectSkinFiles(picked);
      } catch (e) {
        console.warn('スキンの読み込みに失敗:', e);
      }
      if (!files.length) {
        this.setSkinNote(msg('skin.noneFound'));
        return;
      }
      this._skinFiles = files;
      const stored = await saveSkinFiles(files);
      c.skin = sel.value = 'files';
      showRows();
      this.saveConfig();
      await this.loadSkin();
      if (!stored) this.setSkinNote(msg('skin.notStored'), true);
    };
  }

  /** スキンの下の注記(足りない画像など)。text は文字列か msg。append なら今の注記に足す。 */
  setSkinNote(text, append = false) {
    this._skinNotes = append ? this._skinNotes.concat(text ? [text] : []) : text ? [text] : [];
    this.renderSkinNote();
  }

  renderSkinNote() {
    const note = $('cfg-skin-missing');
    note.textContent = this._skinNotes.map(textOf).filter(Boolean).join(' ');
    note.hidden = !note.textContent;
  }

  /** 「画像 / ZIP を選ぶ」の横の、読み込んだ画像の一覧。 */
  renderSkinFilesInfo() {
    $('cfg-skin-files-info').textContent = this._skinFiles && this._skinFiles.length
      ? t('skin.loaded', { names: this._skinFiles.map((f) => f.name).join(' / ') })
      : t('skin.notLoaded');
  }

  /** 設定のスキンの読み先(Skin.load に渡す)。既定のスキンなら null。 */
  async skinSource() {
    const c = this.config;
    if (c.skin === 'folder') return { base: normalizeSkinPath(c.skinPath) };
    if (c.skin === 'files') {
      if (!this._skinFiles) this._skinFiles = (await loadSkinFiles()) || [];
      return { files: new Map(this._skinFiles.map((f) => [f.name, f.blob])) };
    }
    return null;
  }

  /**
   * 設定のスキンを読み直す。設定パネルはホーム画面にしか無いので、演奏中の Renderer のスキンは差し替えない
   * (次の曲から効く)。読めない画像は既定のスキンで補い、それも読めなければ単色の図形で描く(Skin.load)。
   */
  loadSkin() {
    const load = this.skinSource()
      .then((src) => Skin.load(src))
      .catch((e) => {
        console.warn('スキンを読めなかったので既定のスキンで描きます:', e);
        return Skin.load(null);
      });
    this._skinLoad = load;
    load.then((skin) => {
      if (this._skinLoad !== load) return; // 読み込み中に設定が変わった
      this.skin = skin;
      const c = this.config;
      this.renderSkinFilesInfo();
      const files = skin.missing.join(' / ');
      if (c.skin === 'files' && !(this._skinFiles && this._skinFiles.length)) this.setSkinNote(msg('skin.untilLoaded'));
      else if (skin.missing.length && c.skin === 'folder') this.setSkinNote(msg('skin.missingFolder', { path: normalizeSkinPath(c.skinPath), files }));
      else if (skin.missing.length && c.skin === 'files') this.setSkinNote(msg('skin.missingFiles', { files }));
      else this.setSkinNote('');
    });
    return load;
  }

  /**
   * ドラム音量(ギター / ベースの演奏中はギター / ベース音量)と BGM 音量を AudioEngine のバスへ反映する(鳴っている音にも効く)。
   * 'chip' のバスは弾いている楽器の音、'bgm' のバスは BGM と伴奏(弾いていない楽器のチップ)。
   */
  applyVolumes() {
    this.audio.setBusVolume('chip', (this.config[this._volumeKey('chip')] || 0) / 100);
    this.audio.setBusVolume('bgm', (this.config.bgmVolume || 0) / 100);
  }

  /** 音量の種類 → 設定の項目('chip' は演奏中の楽器で変わる)。 */
  _volumeKey(kind) {
    if (kind === 'bgm') return 'bgmVolume';
    return this.playInst === INSTRUMENT.DRUMS ? 'chipVolume' : 'gbVolume';
  }

  /**
   * 音量を step ぶん動かして保存する(トレーニングメニューと設定パネルの共通入口)。
   * @param {'chip'|'bgm'} kind
   * @returns {boolean} 値が変わったら true
   */
  stepVolume(kind, step) {
    const key = this._volumeKey(kind);
    const before = this.config[key];
    const v = Math.max(0, Math.min(100, Math.round(before + step)));
    if (v === before) return false;
    this.config[key] = v;
    this.applyVolumes();
    this.saveConfig();
    const id = { bgmVolume: 'cfg-bgm', chipVolume: 'cfg-chip', gbVolume: 'cfg-gb' }[key];
    const el = $(id);
    if (el) el.value = String(v); // 設定パネルのスライダーもずらさない
    const label = $(id + '-v');
    if (label) label.textContent = String(v);
    return true;
  }

  volumeOf(kind) {
    return this.config[this._volumeKey(kind)] || 0;
  }

  saveConfig() {
    saveJSON('config', this.config);
  }

  // ---- 演奏 ----
  /**
   * @param {number} [inst] 弾く楽器(INSTRUMENT。省略でドラム)。ギター / ベースは譜面のそのパートを弾き、ほかは伴奏になる
   */
  async startChart(song, chartRef, inst = INSTRUMENT.DRUMS) {
    const c = this.config;
    this.cancelAssign();
    await this.audio.ensureContext();
    this.playInst = inst;
    this.applyVolumes();
    $('screen-home').hidden = true;
    $('screen-play').hidden = false;
    $('loading').hidden = false;
    $('loading-text').textContent = t('load.chart');
    $('loading-bar').value = 0;
    $('loading-sub').textContent = '';
    const instTag = inst === INSTRUMENT.DRUMS ? '' : '  ' + t(INSTRUMENT_NAMES[inst]);
    $('play-title').textContent = song.title + (chartRef.label ? '  [' + chartRef.label + ']' : '') + instTag;
    try {
      const skin = await this._skinLoad;
      const chart = await this.pkg.loadChart(chartRef.path);
      const base = { chipVolume: 1.0, autoChipVolume: 0.8 };
      let player;
      if (inst === INSTRUMENT.DRUMS) {
        player = new Player({
          audio: this.audio,
          settings: this.training,
          config: {
            ...base,
            hhGroup: c.hhGroup, ftGroup: c.ftGroup, cyGroup: c.cyGroup, bdGroup: c.bdGroup,
            hitRanges: HitRanges.default, pedalHitRanges: HitRanges.default,
          },
        });
      } else {
        if (!gbPart(chart, inst).notes.length) throw new Error(t('load.noPart', { inst: t(INSTRUMENT_NAMES[inst]) }));
        player = new GuitarPlayer({
          audio: this.audio,
          settings: this.training,
          inst,
          config: { ...base, gbHitRanges: HitRanges.default, light: c.gbLight },
        });
      }
      this.player = player;
      player.onQuit = () => this.leavePlay();
      const canvas = $('canvas');
      this.renderer = inst === INSTRUMENT.DRUMS ? new Renderer(canvas, skin, player) : new GuitarRenderer(canvas, skin, player);
      this.renderer.showLag = !!c.showLag;
      const lvl = chart.level[inst] ? 'LEVEL ' + levelText(chart.level[inst], chart.levelDec[inst]) : '';
      this.renderer.songInfo = { title: chart.title || song.title, artist: chart.artist, level: lvl, jacket: null };
      if (chart.preimage) {
        this.pkg.imageUrl(chart.dir, chart.preimage).then((u) => {
          if (!u) return;
          const img = new Image();
          img.onload = () => { if (this.renderer) this.renderer.songInfo.jacket = img; };
          img.src = u;
        }).catch(() => {});
      }
      await player.load(this.pkg, chart, (done, total, name) => {
        $('loading-text').textContent = t('load.sounds', { done, total });
        $('loading-bar').value = total ? (100 * done) / total : 0;
        $('loading-sub').textContent = name || '';
      });
      if (this.player !== player) return; // 読み込み中に戻った
      if (this.audio.failed.length) {
        console.warn('復号できなかった音源:', this.audio.failed);
        player.showStatus(t('load.soundsFailed', { n: this.audio.failed.length }), 4000);
      }
      this.setupPlayScreen();
      $('loading').hidden = true;
      this.training.save();
    } catch (e) {
      console.error(e);
      $('loading-text').textContent = t('load.failed', { msg: e && e.message ? e.message : e });
      $('loading-sub').innerHTML = `<button class="btn small secondary" id="btn-loadfail-back">${t('common.back')}</button>`;
      $('btn-loadfail-back').onclick = () => this.leavePlay();
    }
  }

  setupPlayScreen() {
    const player = this.player;
    const overlay = $('overlay');
    overlay.innerHTML = '';
    this.menu = new TrainingMenu(this.training, {
      instrument: this.playInst,
      sound: this.uiSounds(),
      onPlaySpeedStep: (d) => player.playSpeedStep(d),
      onChange: () => this.training.save(),
      getPositionMs: () => (this.player ? this.player.songMs : 0),
      canSeek: () => !!this.player && this.player.canSeek,
      onSeek: (ms) => !!this.player && this.player.seekTo(ms),
      getVolume: (kind) => this.volumeOf(kind),
      onVolumeStep: (kind, step) => this.stepVolume(kind, step),
    });
    this.menu.setChart(player.chart);
    this.menu.build(overlay);

    const onKey = (code, down, ev) => {
      this.pacer.forceNext(); // 停止中にメニューで変えた値(ハイスピード・現在位置など)も次のフレームで出す
      return this.onKey(code, down, ev);
    };
    if (this.playInst === INSTRUMENT.DRUMS) {
      this.input = new DrumInput({
        onHit: (lane, ts, source) => {
          player.hit(lane, ts, { touch: source === 'touch' });
          this.pacer.forceNext(); // 待機中の試し打ちの光も、停止中の間引きを待たずに出す
        },
        onKey,
      });
      this.input.setBindings(this.config.bindings);
    } else {
      this.input = new GuitarInput({
        onFret: (lane, down, ts) => { player.fret(lane, down, ts); this.pacer.forceNext(); },
        onPick: (ts, source) => { player.pick(ts, { touch: source === 'touch' }); this.pacer.forceNext(); },
        onWail: (ts) => { player.wail(ts); this.pacer.forceNext(); },
        onKey,
      });
      this.input.setBindings(this.config.gbBindings);
    }
    this.input.hitTest = (x, y) => this.renderer.hitTestLane(x, y);
    this.input.attach($('canvas'));

    $('btn-back').onclick = () => this.leavePlay();
    $('btn-start').onclick = () => player.command(MENU_COMMAND.START_STOP);
    $('btn-restart').onclick = () => player.command(MENU_COMMAND.RESTART);
    $('btn-pause').onclick = () => player.command(MENU_COMMAND.PAUSE_RESUME);
    $('btn-menu').onclick = () => this.toggleMenu();
    $('btn-fullscreen').onclick = () => this.toggleFullscreen();
    // ボタンにフォーカスが残ると Enter / Space(BD)でボタンが再度押されてしまうので、押したら外す
    for (const b of document.querySelectorAll('#playbar .pb')) b.addEventListener('click', () => b.blur());

    this.onResize();
    this.requestWakeLock();
    cancelAnimationFrame(this.raf);
    this.pacer.forceNext();
    const loop = (now) => {
      if (!this.player) return;
      this.pacer.tick(now);
      // 判定・指示・キーリピートは描くかどうかに関わらず毎 rAF 回す(リピートの間隔と開始の遅れを変えない)
      this.menu.update(now);
      this.player.update(now, this.menu);
      if (!this.player || !this.menu || !this.renderer) return; // update 内で終了した
      // 停止中(待機・一時停止)は 60 fps 前後で描く(省電力。360 Hz の画面で待機中も約 1 コア使っていた)。
      // 演奏中・開始待ち・演出の下敷きのフレームは毎回描き、演奏に移ったフレームも待たずに描く
      const st = this.player.state;
      const idle = (st === PLAYER_STATE.STANDBY || st === PLAYER_STATE.PAUSED) && this.renderer._warm <= 0;
      if (!this.pacer.shouldDraw(now, idle ? IDLE_DRAW_FPS : 0)) {
        this.raf = requestAnimationFrame(loop);
        return;
      }
      this.menu.playing = !this.player.isStandby;
      this.menu.paused = st === PLAYER_STATE.PAUSED;
      this.menu.stateText = this.player.stateText();
      this.menu.refresh();
      this.renderer.draw(now);
      this.updateSeekBar();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  onKey(code, down, ev) {
    if (!this.player || !this.menu) return false;
    if (!down) {
      this.menu.keyUp(code);
      return false;
    }
    // 決定・終了・AUTO 切替はキーの押し始めだけ(OS のキーリピートで連打しない)
    if (ev.repeat && (code === 'Enter' || code === 'NumpadEnter' || code === 'Escape' || code === 'F1')) return true;
    if (code === 'F1') {
      this.training.autoPlay = !this.training.autoPlay;
      this.training.save();
      this.menu.refresh();
      return true;
    }
    if (code === 'F11') return false;
    return this.menu.keyDown(code, ev.ctrlKey, performance.now());
  }

  toggleMenu() {
    if (!this.menu || !this.menu.root) return;
    if (document.body.classList.contains('portrait')) this.menu.root.classList.toggle('open');
    else this.menu.root.hidden = !this.menu.root.hidden;
  }

  toggleFullscreen() {
    const el = $('screen-play');
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  onResize() {
    if (!this.renderer) return;
    const stage = $('stage');
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bar = $('playbar').getBoundingClientRect();
    const topInset = Math.max(0, bar.bottom - stage.getBoundingClientRect().top);
    this.renderer.resize(w, h, dpr, this.config.layout || 'auto', topInset);
    this._placeSeekBar(topInset);
    // 大きさを変えるとキャンバスの中身が消えるので、停止中の間引きに当たっても次のフレームは必ず描く
    this.pacer.forceNext();
    const portrait = this.renderer.mode === 'portrait';
    document.body.classList.toggle('portrait', portrait);
    this._layoutMenu();
  }

  /** トレーニングメニューの置き場所(横画面はハイウェイの右のパネル、縦画面はボトムシート)。 */
  _layoutMenu() {
    if (!this.renderer) return;
    const stage = $('stage');
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const portrait = this.renderer.mode === 'portrait';
    if (this.menu && this.menu.root) {
      const m = this.menu.root;
      if (portrait) {
        // 縦: ボトムシート。表示は .open だけで制御する
        m.hidden = false;
        m.style.left = m.style.top = m.style.width = m.style.height = m.style.maxHeight = m.style.fontSize = '';
      } else {
        // 横: ハイウェイの右のパネル。小さい画面では文字を 16px 以上に保ち、枠の方を広げる
        m.classList.remove('open');
        const s = this.renderer.scale;
        const r = PANELS.trainingMenu;
        const font = Math.max(16, 25 * s);
        const width = Math.max(r.w * s, 330);
        const top = this.renderer.offsetY + (r.y - this.renderer.view.y) * s;
        let left = this.renderer.offsetX + (r.x - this.renderer.view.x) * s;
        left = Math.min(left, w - width);
        m.style.left = left + 'px';
        m.style.top = top + 'px';
        m.style.width = width + 'px';
        m.style.height = '';
        // シークバーが画面下にあるとき(ギター / ベース)は、その上で止める(下の行がシークバーの裏に隠れないように)
        const below = this._seekAtBottom ? this._seekBarHeight() : 0;
        m.style.maxHeight = Math.max(200, h - top - 8 - below) + 'px';
        m.style.fontSize = font + 'px';
      }
    }
  }

  /**
   * シークバーの位置。ふだんはプレイバーの直下(= ハイウェイの上端側。ドラムの判定ラインは画面下)。
   * ギター / ベースの判定ラインが画面上にあるとき(リバースでないとき)は、覆わないよう画面下に出す。
   * 縦画面は画面下をメニューのシートが使うので上のまま(止めている間だけ出るので、判定ラインに掛かっても演奏の邪魔にはならない)。
   */
  _placeSeekBar(topInset) {
    const bar = $('seekbar');
    const bottom = this._seekBelongsAtBottom();
    this._seekAtBottom = bottom;
    if (topInset !== undefined) this._seekTopInset = topInset;
    bar.classList.toggle('at-bottom', bottom);
    bar.style.top = bottom ? '' : (this._seekTopInset || 0) + 'px';
  }

  /** シークバーの高さ(CSS px)。止めている間だけ出るので、隠れているときは一瞬出して測る。 */
  _seekBarHeight() {
    const bar = $('seekbar');
    if (!bar.hidden) return bar.offsetHeight;
    bar.hidden = false;
    const hgt = bar.offsetHeight;
    bar.hidden = true;
    return hgt;
  }

  _seekBelongsAtBottom() {
    const r = this.renderer;
    return !!(r && r.seekBarAtBottom && r.mode !== 'portrait');
  }

  // ---- 停止中のシークバー(譜面の確認) ----
  // 演奏中以外(待機 / 開始待ち / 一時停止)だけ画面下に出す。#stage の兄弟なのでキャンバスの
  // pointerdown には届かず、停止中にタップしてもレーンの空打ち音は鳴らない。

  bindSeekBar() {
    if (this._seek) return; // #seekbar は曲をまたいで同じ DOM。2 重に張るとホイール 1 回で曲数ぶん進む
    const bar = $('seekbar');
    const track = $('seek-track');
    this._seek = {
      bar,
      track,
      fill: $('seek-fill'),
      thumb: $('seek-thumb'),
      loop: $('seek-loop'),
      pos: $('seek-pos'),
      dragging: false,
      pointerId: -1,
      shown: null,
      key: '',
    };

    const msFromX = (clientX) => {
      const p = this.player;
      const r = track.getBoundingClientRect();
      const t = r.width > 0 ? (clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(1, t)) * (p ? p.seekMaxMs : 0);
    };
    const onDown = (e) => {
      if (!this.player || !this.player.canSeek) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return; // 右・中クリックでは掴まない
      e.preventDefault();
      this._seek.dragging = true;
      this._seek.pointerId = e.pointerId;
      bar.classList.add('dragging');
      try { track.setPointerCapture(e.pointerId); } catch (err) { /* 非対応でも move は拾える */ }
      this.player.seekTo(msFromX(e.clientX));
      this.updateSeekBar();
    };
    const onMove = (e) => {
      if (!this._seek.dragging || !this.player) return;
      e.preventDefault();
      this.player.seekTo(msFromX(e.clientX));
      this.updateSeekBar();
    };
    const onUp = () => {
      if (!this._seek.dragging) return;
      this.endSeekDrag();
      this.snapSeekToMeasure(); // 1px が数百 ms になるので、離したら小節頭へ吸着させる
      this.updateSeekBar();
    };
    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
    track.addEventListener('lostpointercapture', onUp);
    // バーの上のホイールは「ループ位置単位」で 1 つずつ送る(ドラッグでは小節頭を狙えないため)
    bar.addEventListener('wheel', (e) => {
      if (!this.player || !this.player.canSeek) return;
      const d = e.deltaY || e.deltaX;
      if (!d) return;
      e.preventDefault();
      this.stepSeek(d > 0 ? 1 : -1);
    }, { passive: false });
    $('seek-prev10').onclick = () => this.stepSeek(-10);
    $('seek-prev').onclick = () => this.stepSeek(-1);
    $('seek-next').onclick = () => this.stepSeek(+1);
    $('seek-next10').onclick = () => this.stepSeek(+10);
  }

  endSeekDrag() {
    const s = this._seek;
    if (!s || !s.dragging) return;
    s.dragging = false;
    s.bar.classList.remove('dragging');
    try { if (s.pointerId >= 0) s.track.releasePointerCapture(s.pointerId); } catch (err) { /* 既に解放済み */ }
    s.pointerId = -1;
  }

  /** 「ループ位置単位」で delta 個ぶん送る。 */
  stepSeek(delta) {
    const p = this.player;
    if (!p || !p.canSeek) return;
    const v = stepLoopTime(p.songMs, delta, this.training.loopUnit, p.measureTimes, p.seekMaxMs);
    if (p.seekTo(v)) this.updateSeekBar();
  }

  /** 小節単位のときだけ、いちばん近い小節頭へ寄せる。 */
  snapSeekToMeasure() {
    const p = this.player;
    if (!p || !p.canSeek || this.training.loopUnit !== LOOP_UNIT.MEASURE) return;
    const times = p.measureTimes;
    if (!times || times.length < 2) return;
    const now = p.songMs;
    let best = times[0];
    for (const t of times) {
      if (Math.abs(t - now) < Math.abs(best - now)) best = t;
      if (t > now) break;
    }
    p.seekTo(best);
  }

  updateSeekBar() {
    const s = this._seek;
    const p = this.player;
    if (!s || !p) return;
    // メニューでリバースを切り替えると判定ラインが動くので、シークバーもついていく
    if (this._seekBelongsAtBottom() !== this._seekAtBottom) {
      this._placeSeekBar();
      this._layoutMenu();
    }
    const show = p.canSeek;
    if (s.shown !== show) {
      s.bar.hidden = !show;
      s.shown = show;
      if (!show) this.endSeekDrag();
    }
    if (!show) return;

    const max = Math.max(1, p.seekMaxMs);
    const now = Math.max(0, Math.min(max, p.songMs));
    const unit = this.training.loopUnit;
    const key = Math.round((now / max) * 4000) + '/' + p.loopBeginMs + '/' + p.loopEndMs + '/' + unit + '/' + Math.round(max);
    if (key === s.key) return;
    s.key = key;

    const pct = (v) => (Math.max(0, Math.min(1, v)) * 100).toFixed(3) + '%';
    s.fill.style.width = pct(now / max);
    s.thumb.style.left = pct(now / max);
    const hasLoop = p.loopEndMs >= 0 && p.loopEndMs > p.loopBeginMs;
    s.loop.hidden = !hasLoop;
    if (hasLoop) {
      const a = Math.max(0, p.loopBeginMs) / max;
      s.loop.style.left = pct(a);
      s.loop.style.width = pct(p.loopEndMs / max - a);
    }
    s.pos.textContent = formatLoopTime(now, unit, p.measureTimes) + '   ' + clockText(now) + ' / ' + clockText(max);
  }

  leavePlay() {
    cancelAnimationFrame(this.raf);
    this.endSeekDrag();
    $('seekbar').hidden = true;
    if (this._seek) this._seek.shown = false;
    this.releaseWakeLock();
    if (this.input) { this.input.detach(); this.input = null; }
    if (this.menu) { this.menu.destroy(); this.menu = null; }
    if (this.player) { this.player.dispose(); this.player = null; }
    if (this.renderer) this.renderer._releaseBase(); // キャンバスと同じ大きさの作り置きをすぐ手放す
    this.renderer = null;
    this.training.save();
    this.playInst = INSTRUMENT.DRUMS;
    this.applyVolumes();
    document.body.classList.remove('portrait');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    $('screen-play').hidden = true;
    $('screen-home').hidden = false;
    if (this.midiPanel) this.midiPanel.refresh(); // 演奏中に溜まった打鍵数などを出す
  }

  /** メニュー操作音(短い合成音)。 */
  uiSounds() {
    const beep = (freq, dur, vol) => {
      const ctx = this.audio.ctx;
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g);
      g.connect(this.audio.master);
      o.start();
      o.stop(ctx.currentTime + dur);
    };
    return {
      cursor: () => beep(1200, 0.04, 0.05),
      decide: () => beep(1600, 0.08, 0.06),
      cancel: () => beep(600, 0.08, 0.06),
    };
  }
}

const app = new App();
app.init();
window.dojo = app;
