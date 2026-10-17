// アプリ本体: 画面遷移(ホーム / 演奏)、設定 UI、入力とメニューの接続、描画ループ。

import { SongPackage, normKey } from './core/song.js';
import { AudioEngine } from './core/audio.js';
import { loadJSON, saveJSON, saveLastZip, loadLastZip, saveSkinFiles, loadSkinFiles } from './core/storage.js';
import { LANE_NAMES, INSTRUMENT, gbPart, replayRandom, msToPos, posToMs } from './core/dtx.js';
import { crc32 } from './core/zip.js';
import { EditSession } from './edit/session.js';
import { EditorScreen } from './edit/editor.js';
import { loadDraft, deleteDraft, listDrafts } from './edit/drafts.js';
import { resumeDialog } from './edit/dialogs.js';
import { downloadBlob, editedZipName } from './edit/save.js';
import { chartHasInstrument } from './core/instmerge.js';
import { TrainingSettings, LOOP_UNIT, stepLoopTime, formatLoopTime } from './game/training.js';
import { Player, PLAYER_STATE } from './game/player.js';
import { GuitarPlayer } from './game/gbplayer.js';
import { HitRanges } from './game/hitranges.js';
import { Skin, PANELS, LEGACY_SKIN_BASE, collectSkinFiles, normalizeSkinPath } from './ui/skin.js';
import { Renderer } from './ui/renderer.js';
import { GuitarRenderer } from './ui/gbrenderer.js';
import { FramePacer, FpsMeter, IDLE_DRAW_FPS } from './ui/framepace.js';
import { TrainingMenu, MENU_COMMAND } from './ui/menu.js';
import { DrumInput, LANE_KEY_DEFAULTS, eventCode, loadKeyboardLayout } from './ui/input.js';
import {
  GuitarInput, GB_KEY_DEFAULTS, GB_KEY_LEFTY, GB_KEY_NUMPAD, GB_KEY_HOME, GB_BUTTON_NAMES, migrateGbBindings,
} from './ui/gbinput.js';
import { defaultBindings, normalizeBindings, laneKeysText, isGbKeyCode } from './ui/keybind.js';
import { KeyBindPanel, keyboardDevice } from './ui/keypanel.js';
import { GamepadInput, GB_PAD_DEFAULTS, PAD_BUTTON_NAMES, PAD_START, isPadCode, padCodeLabel, padDevice } from './ui/gamepad.js';
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
  // ギターコントローラ(ゲームパッド)の割り当て(R G B Y P / PICK / WAIL / START。キーとは別。js/ui/gamepad.js)
  gbPadBindings: defaultBindings(GB_PAD_DEFAULTS),
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
  // (変更) CY だけ既定を共通にする(NX / DTXManiaAI は 0 = 打ち分け)。RD のチップは CY 列に CY と同じ絵で描くので
  // (js/ui/skin.js)、打ち分けでは見分けられず、右のシンバル 1 枚で叩くと片方のチップが全部 MISS になる
  // (GM の既定ではライドの 51 が RD。GITADORA から変換した譜面は右のシンバルを CY と RD に書き分けている)
  cyGroup: 1,
  bdGroup: 0,
};

/**
 * 保存する設定の版(config.configRev)。上げたら App の constructor に移し替えを足す。1: CY グループの既定を共通に変えた /
 * 2: ギター / ベースのキーの既定を NX の並び(F1〜F5)に変えた
 */
const CONFIG_REV = 2;

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
    // 版 1 より前に保存した CY グループの 0 は、既定のままの値と見分けられないので一度だけ共通に直す(以後は選んだ値を残す)
    if (!(Number(saved.configRev) >= 1)) this.config.cyGroup = 1;
    this.config.configRev = CONFIG_REV;
    // 壊れている / 古い形式の config でもレーン単位で直す(1 レーンの欠落で他 9 レーンを捨てない)
    const norm = normalizeBindings(this.config.bindings);
    this.config.bindings = norm.bindings;
    this._keysRepaired = norm.repaired; // 起動時に直したレーン(設定を開いたときに知らせる)
    const gbNorm = normalizeBindings(this.config.gbBindings, GB_KEY_DEFAULTS, isGbKeyCode);
    // 既定を NX の並び(F1〜F5)に変えた(版 2)。版 2 より前の保存で以前の既定(A S D F G)のままなら新しい既定へ移す
    // (一度だけ。手で変えた割り当てはそのまま)。知らせは見てもらうまで残す(設定を開くか、ギター / ベースを弾いたとき)
    const gbMig = migrateGbBindings(gbNorm.bindings, saved.configRev);
    this.config.gbBindings = gbMig.bindings;
    this._gbKeysRepaired = gbNorm.repaired;
    if (gbMig.migrated) {
      this.config.gbKeysNotice = true;
      this.saveConfig();
    }
    this._gbKeyGuard = null; // 曲の読み込み中にギター / ベースのキーでブラウザが動かないようにする(_guardGbKeys)
    this._chartLoadSeq = 0; // 曲の読み込みの番号(startChart)
    this.config.gbLight = this.config.gbLight !== false;
    const padNorm = normalizeBindings(this.config.gbPadBindings, GB_PAD_DEFAULTS, isPadCode);
    this.config.gbPadBindings = padNorm.bindings;
    this._gbPadRepaired = padNorm.repaired;
    // ギターコントローラも曲をまたいで 1 つ(設定の監視・押して追加と演奏の両方で使う)
    this.gamepad = new GamepadInput({
      onButton: (button, down, ts, holder) => this.onPadButton(button, down, ts, holder),
      onInput: (info) => this.onPadInput(info),
      onDevices: (change) => this.onPadDevices(change),
    });
    this.gamepad.setBindings(this.config.gbPadBindings);
    this._padMonitor = null; // 設定の監視に出している最後の入力
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
    this.fpsMeter = new FpsMeter(); // 演奏画面の上部の FPS の表示
    this._loadGen = 0;
    this.keyPanel = null; // 設定の「キー割り当て」(js/ui/keypanel.js)
    this.gbKeyPanel = null; // 同じくギター / ベース
    this.gbPadPanel = null; // 同じくギターコントローラ
    this._seek = null; // 停止中のシークバー
    this._wakeLock = null;
    this._status = null; // ホームの状態表示 {msg, error}(言語の切り替えで作り直す)
    this._skinNotes = []; // スキンの下の注記(同上)
    this._lastZip = null; // 「前回の ZIP を開く」の {blob, name}
    // 譜面の編集(js/edit/。本アプリの追加)
    this.editor = null; // 開いている編集画面(EditorScreen)
    this._editSessions = new Map(); // 譜面のパス(normKey)→ EditSession(曲パックを開き直すまで持つ)
    this._editHintShown = false;
    this._editKeptShown = false;
    this._editBusy = false; // 編集画面を開いている・閉じている途中
    this._playing = null; // 演奏中の {song, chartRef, inst}(演奏画面の ✎ で編集画面へ)
    this._chartRolls = []; // 演奏中の譜面の #RANDOM の乱数(編集画面で同じ分岐を出す)
    this._returnToEditor = null; // テストプレイなら {song, chartRef}(演奏をやめたら編集画面へ戻る)
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    document.body.classList.toggle('touch', this.isTouch);
    document.body.classList.toggle('desktop', !this.isTouch);
  }

  async init() {
    this.applyLanguage();
    this.bindLanguage();
    this.bindHome();
    this.buildSettingsUi();
    // キーの名前をキーボードの配列に合わせる(JIS なら : や [。読めたら描き直す)
    loadKeyboardLayout().then((ok) => {
      if (!ok) return;
      if (this.keyPanel) this.keyPanel.relocalize();
      if (this.gbKeyPanel) this.gbKeyPanel.relocalize();
      this.updateHelpKeys();
    });
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
    if (this.gbPadPanel) this.gbPadPanel.relocalize();
    this.renderPadState();
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
    // 譜面の編集: ファイルにしていない編集があればページを閉じる前に確かめる(iPad の Safari は出さないので下書きも書く)
    window.addEventListener('beforeunload', (e) => {
      if (![...this._editSessions.values()].some((s) => s.unexported)) return;
      e.preventDefault();
      e.returnValue = '';
    });
    const edit = $('btn-edit-mode');
    if (edit) {
      edit.addEventListener('click', () => {
        this.config.editListMode = !this.config.editListMode;
        this.saveConfig();
        this.renderSongList();
      });
    }
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

  /**
   * 別の曲パックを開く前に、ファイルにしていない編集があれば確かめる(下書きには残る)。編集の状態は、新しい曲パックを
   * 開けたときに捨てる(開けなかった・別の読み込みに追い越されたときは、今の曲パックの編集をそのまま残す)。
   * @returns {boolean} 開いてよければ true
   */
  _confirmPackSwitch() {
    return !([...this._editSessions.values()].some((s) => s.unexported) && !window.confirm(t('edit.confirmReplacePack')));
  }

  async loadPackage(blob, name, opts) {
    if (!this._confirmPackSwitch()) return;
    const gen = ++this._loadGen;
    this._packLoading = gen; // 読み込み中は今の曲パックの譜面を開かない(読み終えると曲パックが替わるので)
    this.setStatus(msg('load.zip'));
    try {
      const pkg = await SongPackage.fromZip(blob, name);
      if (gen !== this._loadGen) { pkg.dispose(); return; } // 後から別の読み込みが始まった
      if (this.pkg) this.pkg.dispose();
      this.pkg = pkg;
      this._editSessions.clear();
      await this.showSongList();
      this.offerDraftRestore(pkg);
      if (!opts.fromCache && blob.size < 400 * 1024 * 1024) {
        saveLastZip(blob, name).then((ok) => { if (ok && gen === this._loadGen) this.showLastButton(blob, name); });
      }
    } catch (e) {
      console.error(e);
      if (gen === this._loadGen) this.setStatus(msg('load.failed', { msg: e && e.message ? e.message : e }), true);
    } finally {
      if (this._packLoading === gen) this._packLoading = 0;
    }
  }

  async loadFolder(files) {
    if (!this._confirmPackSwitch()) return;
    const gen = ++this._loadGen;
    this._packLoading = gen;
    this.setStatus(msg('load.folder'));
    try {
      const pkg = await SongPackage.fromFiles(files);
      if (gen !== this._loadGen) { pkg.dispose(); return; }
      if (this.pkg) this.pkg.dispose();
      this.pkg = pkg;
      this._editSessions.clear();
      await this.showSongList();
      this.offerDraftRestore(pkg);
    } catch (e) {
      console.error(e);
      if (gen === this._loadGen) this.setStatus(msg('load.failed', { msg: e && e.message ? e.message : e }), true);
    } finally {
      if (this._packLoading === gen) this._packLoading = 0;
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
    // 譜面の編集: 「✎ 譜面を編集」を押している間は、ドラムの譜面のボタンで編集画面を開く(ギター / ベースの行は出さない)
    const editing = !!this.config.editListMode;
    const tools = $('list-tools');
    if (tools) tools.hidden = !(pkg && pkg.songs.length);
    const toggle = $('btn-edit-mode');
    if (toggle) toggle.setAttribute('aria-pressed', String(editing));
    list.classList.toggle('editing', editing);
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
        if (editing && inst !== INSTRUMENT.DRUMS) continue;
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
          if (editing) {
            b.setAttribute('aria-label', t('edit.openLabel', { label }));
            b.onclick = () => this.openEditor(song, c);
          } else {
            b.setAttribute('aria-label', t('song.playLabel', { inst: t(INSTRUMENT_NAMES[inst]), label }));
            b.onclick = () => this.startChart(song, c, inst);
          }
          // 編集した譜面(重ねたもの・この画面で編集中のもの)に印
          const ses = this._editSessions.get(normKey(c.path));
          if (pkg.override(c.path) || (ses && ses.modified)) {
            const dot = document.createElement('span');
            dot.className = 'edited';
            dot.textContent = '●';
            dot.title = t('edit.editedBadge');
            b.appendChild(dot);
          }
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
    if (this.gbPadPanel) this.gbPadPanel.cancelAssign(reason);
  }

  buildKeyUi() {
    // ドラムとギター / ベースの欄・電子ドラムの「叩いて追加」は同時には待たない(待ち受けを始めたらほかを畳む)
    const others = (self) => () => {
      for (const p of [this.keyPanel, this.gbKeyPanel, this.gbPadPanel]) if (p && p !== self) p.cancelAssign(msg('common.canceled'));
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
      device: keyboardDevice(isGbKeyCode), // F1 とテンキーの Enter も割り当てられる(NX の既定)
      presets: [
        { button: $('btn-gb-keys-numpad'), bindings: GB_KEY_NUMPAD, done: 'keys.numpadDone' },
        { button: $('btn-gb-keys-home'), bindings: GB_KEY_HOME, done: 'keys.homeDone' },
        { button: $('btn-gb-keys-lefty'), bindings: GB_KEY_LEFTY, done: 'keys.leftyDone' },
      ],
    });
    this.gbKeyPanel.beforeAssign = others(this.gbKeyPanel);
    this.gbPadPanel = new KeyBindPanel({
      list: $('gbpad-list'),
      statusText: $('gbpad-status-text'),
      undoButton: $('gbpad-undo'),
      resetAllButton: $('btn-gbpad-default'),
      names: PAD_BUTTON_NAMES,
      defaults: GB_PAD_DEFAULTS,
      getBindings: () => this.config.gbPadBindings,
      setBindings: (next) => { this.config.gbPadBindings = next; this.gamepad.setBindings(next); this.saveConfig(); },
      onChange: () => this.updateHelpKeys(),
      device: padDevice(this.gamepad),
    });
    this.gbPadPanel.beforeAssign = others(this.gbPadPanel);
    this.keyPanel.build(this._keysRepaired || []);
    this.gbKeyPanel.build(this._gbKeysRepaired || []);
    if (this.config.gbKeysNotice) this.gbKeyPanel.setStatus(msg('keys.gbDefaultsChanged'));
    this.gbPadPanel.build(this._gbPadRepaired || []);
    this.updateHelpKeys();
  }

  /** 操作方法パネルのドラム行とギター / ベース行を今の割り当てで書き直す。 */
  updateHelpKeys() {
    const el = $('help-keys');
    if (el) el.textContent = this.config.bindings.map((codes, lane) => `${LANE_NAMES[lane]}=${laneKeysText(codes)}`).join('  ');
    const gb = $('help-gb-keys');
    if (gb) gb.textContent = this.config.gbBindings.map((codes, b) => `${GB_BUTTON_NAMES[b]}=${laneKeysText(codes)}`).join('  ');
    const pad = $('help-gb-pad');
    if (pad) pad.textContent = this.config.gbPadBindings.map((codes, b) => `${PAD_BUTTON_NAMES[b]}=${laneKeysText(codes, padCodeLabel)}`).join('  ');
  }

  // ---- ギターコントローラ(ゲームパッド) ----

  /** 割り当てた入力が押された / 離された(演奏中のギター / ベースだけに届ける)。 */
  onPadButton(button, down, ts, holder) {
    const input = this.input;
    if (!this.player || !(input instanceof GuitarInput)) return;
    if (button === PAD_START) {
      // 演奏開始・停止(本アプリの追加。画面の ▶ と同じ)
      if (down) { this.player.command(MENU_COMMAND.START_STOP); this.pacer.forceNext(); }
      return;
    }
    input.padInput(button, down, ts, holder);
    this.pacer.forceNext();
  }

  /** 設定の監視: 最後に動いた入力と、その行き先の行を出す。 */
  onPadInput(info) {
    if (!info.down || !this.gamepad.watchAll) return;
    this._padMonitor = info;
    this.renderPadMonitor();
    if (info.button >= 0 && this.gbPadPanel) this.gbPadPanel.hitLane(info.button);
  }

  onPadDevices(change) {
    this.renderPadState();
    // 演奏中の抜き差しは画面に出す(弾いても鳴らない理由が分かるように)
    if (this.player && this.input instanceof GuitarInput && change) {
      if (change.added.length) this.player.showStatus(t('pad.connectedToast', { names: change.added.join(', ') }), 2500);
      if (change.removed.length) this.player.showStatus(t('pad.disconnectedToast', { names: change.removed.join(', ') }), 4000);
    }
  }

  /** 設定の「ギターコントローラ」のつながっている機器。 */
  renderPadState() {
    const el = $('gbpad-state');
    if (!el) return;
    const g = this.gamepad;
    if (!g.supported) el.textContent = t('pad.unsupported');
    else if (!g.devices.length) el.textContent = t('pad.none');
    else {
      el.textContent = t('pad.devices', { list: g.devices.map((d) => `[${d.index}] ${d.id}`).join(' / ') })
        + (g.devices.some((d) => d.mapping !== 'standard') ? t('pad.nonStandard') : '');
    }
    this.renderPadMonitor();
  }

  renderPadMonitor() {
    const el = $('gbpad-monitor');
    if (!el) return;
    const m = this._padMonitor;
    if (!m) el.textContent = t('pad.monitorEmpty');
    else if (m.button >= 0) el.textContent = t('pad.monitor', { code: padCodeLabel(m.code), lane: PAD_BUTTON_NAMES[m.button], index: m.index });
    else el.textContent = t('pad.monitorUnbound', { code: padCodeLabel(m.code), index: m.index });
  }

  /** 設定を開いている間は、割り当てていない入力も見る(監視・押して追加)。閉じたら止める。 */
  syncPadWatch() {
    const on = !$('screen-home').hidden && $('settings-panel').open;
    this.gamepad.watchAll = on;
    if (on) {
      this.gamepad.activate('settings');
      this.gamepad.poll(); // 開いたときの状態を基準にする
      this.renderPadState();
    } else {
      this.gamepad.deactivate('settings');
      if (this.gbPadPanel) this.gbPadPanel.cancelAssign();
    }
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
    if (this.editor) {
      this.editor.onPadHit(lane, ts, 'midi'); // 譜面の編集画面では試し聞き(判定へは流さない)
      return;
    }
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
    $('settings-panel').addEventListener('toggle', () => {
      this.midiPanel.refresh();
      this.syncPadWatch();
      if ($('settings-panel').open) this.clearGbKeysNotice(); // 欄の状態表示で見てもらった
    });
    this.renderPadState();
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
    bad.onchange = () => this.setGbLight(!bad.checked);
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

  /**
   * 空ピックを BAD にしない(Light)を切り替えて保存する(設定パネルとトレーニングメニューの共通入口)。
   * 演奏中のギター / ベースにもすぐ効かせる(次のピックから)。
   */
  setGbLight(light) {
    this.config.gbLight = !!light;
    this.saveConfig();
    const bad = $('cfg-gb-bad');
    if (bad) bad.checked = !this.config.gbLight;
    if (this.player && this.playInst !== INSTRUMENT.DRUMS) this.player.config.light = this.config.gbLight;
  }

  saveConfig() {
    saveJSON('config', this.config);
  }

  // ---- 演奏 ----
  /**
   * @param {number} [inst] 弾く楽器(INSTRUMENT。省略でドラム)。ギター / ベースは譜面のそのパートを弾き、ほかは伴奏になる
   * @param {{startAtMs?: number, returnToEditor?: boolean, rolls?: number[], loopPos?: object}} [opts] 譜面の編集のテストプレイ:
   *   startAtMs から演奏を始め、やめたら編集画面へ戻る。rolls は #RANDOM の乱数(編集していた分岐)、loopPos はループ(位置で持つ)
   */
  async startChart(song, chartRef, inst = INSTRUMENT.DRUMS, opts = {}) {
    if (this._packLoading) return; // 別の曲パックを読み込み中(読み終えると今の曲パックは手放す)
    const c = this.config;
    const loadId = ++this._chartLoadSeq; // 戻ってから別の曲を始めたら、前の読み込みの失敗は画面に出さない
    this._playing = { song, chartRef, inst };
    this._returnToEditor = opts.returnToEditor ? { song, chartRef } : null;
    this.cancelAssign();
    await this.audio.ensureContext();
    this.playInst = inst;
    this.applyVolumes();
    $('screen-home').hidden = true;
    this.syncPadWatch(); // ホームを隠したので設定の監視(すべての入力を 4 ms ごと)は止める。読み込みに失敗しても
    this._guardGbKeys(inst !== INSTRUMENT.DRUMS);
    $('screen-play').hidden = false;
    $('loading').hidden = false;
    $('loading-text').textContent = t('load.chart');
    $('loading-bar').value = 0;
    $('loading-sub').textContent = '';
    const instTag = inst === INSTRUMENT.DRUMS ? '' : '  ' + t(INSTRUMENT_NAMES[inst]);
    const testTag = this._returnToEditor ? '  ' + t('edit.testPlayBadge') : '';
    $('play-title').textContent = song.title + (chartRef.label ? '  [' + chartRef.label + ']' : '') + instTag + testTag;
    try {
      const skin = await this._skinLoad;
      // #RANDOM の乱数を覚える(演奏画面の ✎ で編集画面へ行ったとき、同じ分岐を出す)。テストプレイは編集していた分岐
      const rolls = [];
      const random = opts.rolls ? replayRandom(opts.rolls) : () => { const v = Math.random(); rolls.push(v); return v; };
      const chart = await this.pkg.loadChart(chartRef.path, { random });
      this._chartRolls = opts.rolls ? opts.rolls.slice() : rolls;
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
      this._playChart = chart; // ループを位置で持つため(やめるときには player.chart が消えていることがある)
      if (this.audio.failed.length) {
        console.warn('復号できなかった音源:', this.audio.failed);
        player.showStatus(t('load.soundsFailed', { n: this.audio.failed.length }), 4000);
      }
      // テストプレイ: 編集画面で決めたループを戻す(Player.load は 0〜譜面の長さにする。位置で持っているので、
      // 編集でテンポや長さが変わっても同じ所。「曲の終わりまで」は新しい長さまで)
      if (opts.loopPos) {
        const lp = opts.loopPos;
        this.training.loopBeginMs = Math.max(0, posToMs(chart, lp.beginPos));
        this.training.loopEndMs = lp.endAtEnd ? chart.durationMs : Math.min(chart.durationMs, posToMs(chart, lp.endPos));
        player.applySettings();
        player.enterStandby(true);
      }
      this.setupPlayScreen();
      $('loading').hidden = true;
      this.training.save();
      if (Number.isFinite(opts.startAtMs)) player.startTrainingAt(opts.startAtMs);
    } catch (e) {
      console.error(e);
      if (loadId !== this._chartLoadSeq) return;
      this._guardGbKeys(false); // 読み込みは終わったので、F5 などはブラウザの動作に戻す
      $('loading-text').textContent = t('load.failed', { msg: e && e.message ? e.message : e });
      $('loading-sub').innerHTML = `<button class="btn small secondary" id="btn-loadfail-back">${t('common.back')}</button>`;
      $('btn-loadfail-back').onclick = () => this.leavePlay();
    }
  }

  /**
   * 曲を読み込んでいる間も、ギター / ベースに割り当てたキー(既定の F1〜F5 など)でブラウザが動かないようにする
   * (F5 の再読み込みで読み込みが消えたり、F1 でヘルプが開いたりしないように)。演奏の入力ができたら外す
   * (それからは GuitarInput が同じことをする)。
   */
  _guardGbKeys(on) {
    if (this._gbKeyGuard) {
      window.removeEventListener('keydown', this._gbKeyGuard, true);
      this._gbKeyGuard = null;
    }
    if (!on) return;
    const codes = new Set(this.config.gbBindings.flat());
    this._gbKeyGuard = (e) => { if (codes.has(eventCode(e))) e.preventDefault(); };
    window.addEventListener('keydown', this._gbKeyGuard, true);
  }

  /** 既定のキーを変えた知らせを見てもらったので消す。 */
  clearGbKeysNotice() {
    if (!this.config.gbKeysNotice) return;
    this.config.gbKeysNotice = false;
    this.saveConfig();
  }

  setupPlayScreen() {
    this._guardGbKeys(false);
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
      getGbBad: () => !this.config.gbLight,
      onGbBadToggle: () => this.setGbLight(!this.config.gbLight),
      canReplay: () => !!this.player && this.player.canReplay,
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
      // ギターコントローラは演奏の間だけ 4 ms ごとに読む(ゲームパッドが無ければ 250 ms ごとに確かめるだけ)
      this.gamepad.setBindings(this.config.gbPadBindings);
      this.gamepad.activate('play');
      if (this.config.gbKeysNotice) {
        this.player.showStatus(t('keys.gbDefaultsChangedShort'), 6000);
        this.clearGbKeysNotice();
      }
    }
    this.input.hitTest = (x, y) => this.renderer.hitTestLane(x, y);
    this.input.attach($('canvas'));

    $('btn-back').onclick = () => this.leavePlay();
    $('btn-back').title = t(this._returnToEditor ? 'edit.backToEditor' : 'play.back');
    // 譜面の編集へ(ドラムだけ。今の位置・分岐・ループを持っていく。本アプリの追加)
    const editBtn = $('btn-edit');
    editBtn.hidden = this.playInst !== INSTRUMENT.DRUMS;
    editBtn.title = t(this._returnToEditor ? 'edit.backToEditor' : 'edit.openFromPlay');
    editBtn.onclick = () => this.editFromPlay();
    $('btn-start').onclick = () => player.command(MENU_COMMAND.START_STOP);
    $('btn-restart').onclick = () => player.command(MENU_COMMAND.RESTART);
    $('btn-pause').onclick = () => player.command(MENU_COMMAND.PAUSE_RESUME);
    $('btn-replay').onclick = () => { player.command(MENU_COMMAND.REPLAY); this.pacer.forceNext(); };
    this.syncReplayButton();
    $('btn-menu').onclick = () => this.toggleMenu();
    $('btn-fullscreen').onclick = () => this.toggleFullscreen();
    // ボタンにフォーカスが残ると Enter / Space(BD)でボタンが再度押されてしまうので、押したら外す
    for (const b of document.querySelectorAll('#playbar .pb')) b.addEventListener('click', () => b.blur());

    this.onResize();
    this.requestWakeLock();
    cancelAnimationFrame(this.raf);
    this.pacer.forceNext();
    this.fpsMeter.reset();
    $('play-fps').textContent = '';
    const loop = (now) => {
      if (!this.player) return;
      this.pacer.tick(now);
      // ギターコントローラは 4 ms ごとにも読むが、フレームの頭でも読んで、そのフレームの判定に間に合わせる
      if (this.input instanceof GuitarInput) this.gamepad.poll();
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
      this.menu.replaying = !!this.player.replay;
      this.menu.stateText = this.player.stateText();
      this.menu.refresh();
      this.renderer.draw(now);
      this.updateSeekBar();
      this.syncReplayButton();
      if (this.fpsMeter.frame(now)) this.showFps();
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

  /**
   * プレイバーの「リプレイ」(直前の演奏を見直す。js/game/replay.js)。演奏したあとから出し、待機中とリプレイ中だけ押せる
   * (リプレイ中は押すと止まる)。毎フレーム呼ぶので、DOM へは変わったときだけ書く。
   */
  syncReplayButton() {
    const b = $('btn-replay');
    const p = this.player;
    const show = !!(p && p.lastTake);
    const enabled = !!(p && (p.replay || p.canReplay));
    if (b.hidden === show) b.hidden = !show;
    if (b.disabled === enabled) b.disabled = !enabled;
    b.classList.toggle('on', !!(p && p.replay));
  }

  /** 上部のバーの FPS(描いた回数。数え直したときだけ書く)。ツールチップに画面の Hz と停止中の間引きを出す。 */
  showFps() {
    const el = $('play-fps');
    el.textContent = this.fpsMeter.fps + ' fps';
    el.title = t('play.fpsTitle', { hz: Math.round(this.pacer.hz) || '?' });
  }

  toggleMenu() {
    if (!this.menu || !this.menu.root) return;
    if (document.body.classList.contains('portrait')) this.menu.root.classList.toggle('open');
    else this.menu.root.hidden = !this.menu.root.hidden;
    this.menu.invalidateScroll(); // 隠れている間に動いたカーソルの行を、出したときに見せる
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
    if (this.editor) this.editor.onResize();
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
      this.menu.invalidateScroll(); // 枠の大きさが変わったので、カーソルの行が見えているか測り直す
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
    // 帯はループ区間(リプレイ中はテイクの範囲。シークできるのはその中だけ)
    const take = p.replay ? p.replay.take : null;
    const bandBegin = take ? take.startMs : p.loopBeginMs;
    const bandEnd = take ? take.endMs : p.loopEndMs;
    const key = Math.round((now / max) * 4000) + '/' + bandBegin + '/' + bandEnd + '/' + unit + '/' + Math.round(max);
    if (key === s.key) return;
    s.key = key;

    const pct = (v) => (Math.max(0, Math.min(1, v)) * 100).toFixed(3) + '%';
    s.fill.style.width = pct(now / max);
    s.thumb.style.left = pct(now / max);
    const hasBand = bandEnd >= 0 && bandEnd > bandBegin;
    s.loop.hidden = !hasBand;
    s.loop.classList.toggle('replay', !!take);
    if (hasBand) {
      const a = Math.max(0, bandBegin) / max;
      s.loop.style.left = pct(a);
      s.loop.style.width = pct(bandEnd / max - a);
    }
    s.pos.textContent = formatLoopTime(now, unit, p.measureTimes) + '   ' + clockText(now) + ' / ' + clockText(max);
  }

  /**
   * @param {{keepHomeHidden?: boolean}} [opts] keepHomeHidden: 曲の一覧を出さない(そのまま編集画面を開く)
   */
  leavePlay(opts = {}) {
    // テストプレイなら、止めた位置とループを持って編集画面へ戻る
    const back = this._returnToEditor;
    this._returnToEditor = null;
    // 譜面を読み終える前にやめたら(読み込みの失敗も)、編集画面の位置とループはそのまま(undefined)
    const ready = !!(this.player && (this.player.chart || this._playChart));
    const lastMs = ready ? this.player.songMs : undefined;
    const loopPos = ready ? this._captureLoop(this.player) : undefined;
    this._playChart = null;
    const keepHome = !!opts.keepHomeHidden || !!back;
    cancelAnimationFrame(this.raf);
    this._chartLoadSeq++; // 読み込み中に戻ったら、その読み込みの失敗は出さない
    this._guardGbKeys(false);
    this.endSeekDrag();
    $('seekbar').hidden = true;
    if (this._seek) this._seek.shown = false;
    this.releaseWakeLock();
    if (this.input) { this.input.detach(); this.input = null; }
    this.gamepad.deactivate('play');
    if (this.menu) { this.menu.destroy(); this.menu = null; }
    if (this.player) { this.player.dispose(); this.player = null; }
    this.syncReplayButton(); // 直前の演奏は曲ごと(次の曲では出さない)
    if (this.renderer) this.renderer._releaseBase(); // キャンバスと同じ大きさの作り置きをすぐ手放す
    this.renderer = null;
    this.training.save();
    this.playInst = INSTRUMENT.DRUMS;
    this.applyVolumes();
    document.body.classList.remove('portrait');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    $('screen-play').hidden = true;
    this._playing = null;
    if (keepHome) {
      if (back) this.openEditor(back.song, back.chartRef, { atMs: lastMs, loopPos });
      return;
    }
    $('screen-home').hidden = false;
    if (this.midiPanel) this.midiPanel.refresh(); // 演奏中に溜まった打鍵数などを出す
    this.syncPadWatch(); // 設定を開いたままなら監視に戻る
  }

  // ---- 譜面の編集(js/edit/。本アプリの追加) ----

  /** ループの区間を位置(pos)で持つ(編集でテンポが変わっても同じ所。ループしていなければ null)。 */
  _captureLoop(player) {
    const s = this.training;
    const chart = player.chart || this._playChart; // Esc・トレーニング終了では player.chart が先に消える
    if (!chart || !s.loop || !s.loopRangeValid) return null;
    return { beginPos: msToPos(chart, s.loopBeginMs), endPos: msToPos(chart, s.loopEndMs), endAtEnd: s.loopEndMs >= chart.durationMs - 1 };
  }

  /** 演奏画面の ✎: 今の位置・分岐・ループを持って編集画面へ(テストプレイ中なら戻るのと同じ)。 */
  editFromPlay() {
    const p = this.player;
    const playing = this._playing;
    if (!p || !playing || this.playInst !== INSTRUMENT.DRUMS) return;
    if (this._returnToEditor) {
      this.leavePlay();
      return;
    }
    const atMs = p.songMs;
    const loopPos = this._captureLoop(p);
    const rolls = this._chartRolls.slice();
    this.leavePlay({ keepHomeHidden: true });
    this.openEditor(playing.song, playing.chartRef, { atMs, rolls, loopPos });
  }

  /**
   * 譜面の編集画面を開く。編集の状態(元に戻すの履歴など)は曲パックを開き直すまで譜面ごとに持つ。
   * @param {{atMs?: number, rolls?: number[], loopPos?: object}} [opts]
   */
  async openEditor(song, chartRef, opts = {}) {
    if (this._editBusy || this.editor || !this.pkg || this._packLoading) return;
    this._editBusy = true;
    $('draft-offer').hidden = true; // 下書きを戻すかの問いは、編集を始めたら古くなる
    try {
      await this.audio.ensureContext();
      this.cancelAssign();
      $('screen-home').hidden = true;
      this.syncPadWatch();
      const screen = $('screen-edit');
      screen.hidden = false;
      $('edit-loading').hidden = false;
      $('edit-loading-text').textContent = t('load.chart');
      const skin = await this._skinLoad;
      const pkg = this.pkg;
      const key = normKey(chartRef.path);
      let session = this._editSessions.get(key);
      if (!session) {
        const original = await pkg.readOriginalBytes(chartRef.path);
        const isNew = original === null;
        const originalBytes = original || (await pkg.readBytes(chartRef.path));
        let draft = await loadDraft(pkg, chartRef.path);
        if (draft) {
          $('edit-loading').hidden = true;
          const choice = await resumeDialog($('edit-dialog'), draft, draft.baseCrc !== crc32(originalBytes));
          if (choice === 'original') {
            await deleteDraft(pkg, chartRef.path);
            draft = null;
          }
        }
        session = new EditSession({ pkg, song, chartRef, originalBytes, draft, rolls: opts.rolls || [], isNew });
        this._editSessions.set(key, session);
      } else if (opts.rolls && opts.rolls.length) {
        session.setRolls(opts.rolls);
      }
      if (opts.loopPos !== undefined) session.loopPos = opts.loopPos;
      this.playInst = INSTRUMENT.DRUMS;
      this.applyVolumes();
      this.editor = new EditorScreen(this, session, skin, { atMs: opts.atMs });
      $('edit-loading').hidden = true;
      await this.editor.open();
    } catch (e) {
      console.error(e);
      $('edit-loading').hidden = true;
      $('screen-edit').hidden = true;
      this.editor = null;
      $('screen-home').hidden = false;
      this.setStatus(msg('load.failed', { msg: e && e.message ? e.message : e }), true);
    } finally {
      this._editBusy = false;
    }
  }

  /** 編集画面を閉じて曲の一覧へ(確かめない。編集は曲パックに重ね、下書きにも残る)。 */
  async closeEditor() {
    const ed = this.editor;
    if (!ed || this._editBusy) return;
    this._editBusy = true;
    try {
      await ed.close();
    } finally {
      this.editor = null;
      this._editBusy = false;
    }
    $('screen-home').hidden = false;
    this.syncPadWatch();
    this.renderSongList();
    if (!this._editKeptShown && [...this._editSessions.values()].some((s) => s.unexported)) {
      this._editKeptShown = true;
      this.setStatus(msg('edit.keptNote'));
    }
  }

  /** 編集画面から本物の演奏画面でテストプレイする(やめると編集画面へ戻る)。 */
  async startTestPlay(session, startAtMs) {
    const ed = this.editor;
    if (!ed || this._editBusy) return;
    this._editBusy = true;
    try {
      await ed.close({ toTest: true });
    } finally {
      this.editor = null;
      this._editBusy = false;
    }
    await this.startChart(session.song, session.chartRef, INSTRUMENT.DRUMS, {
      startAtMs, returnToEditor: true, rolls: session.rolls, loopPos: session.loopPos,
    });
  }

  /**
   * 編集した譜面を入れた曲パックの ZIP を書き出す(元の ZIP の中身はそのまま。次に「前回の ZIP」で開ける)。
   * onlyDir を渡すとその曲のフォルダだけ(「前回の ZIP」には残さない。開き直すとその曲だけの曲パックになるので)。
   */
  async exportEditedZip({ onlyDir = '' } = {}) {
    const pkg = this.pkg;
    if (!pkg) return;
    try {
      // 書き出している間も編集できるので、ZIP に入れた文書を覚えておき、それだけを「書き出した」にする
      const put = [];
      for (const s of this._editSessions.values()) {
        const doc = s.doc;
        await s.commit();
        put.push([s, doc]);
      }
      const blob = await pkg.exportZip({ onlyDir });
      const folder = onlyDir.replace(/\/$/, '');
      const name = editedZipName(onlyDir ? folder.slice(folder.lastIndexOf('/') + 1) || pkg.name : pkg.name);
      downloadBlob(blob, name);
      if (!onlyDir && pkg.zip && pkg.zip.blob && blob.size < 400 * 1024 * 1024) {
        saveLastZip(blob, name).then((ok) => { if (ok) this.showLastButton(blob, name); });
      }
      for (const [s, doc] of put) {
        if (!onlyDir || normKey(s.path).startsWith(normKey(onlyDir))) s.history.markExported(doc);
      }
      if (this.editor) this.editor._toast(t('edit.exported', { name }));
    } catch (e) {
      console.error(e);
      const m = t('edit.exportFailed', { msg: e && e.message ? e.message : e });
      if (this.editor) this.editor._toast(m, null, 8000);
      else this.setStatus(m, true);
    }
  }

  /** 曲パックを開いたとき、その曲パックの下書きがあれば戻すか聞く(戻すと一覧と演奏も直した譜面になる)。 */
  async offerDraftRestore(pkg) {
    const box = $('draft-offer');
    if (!box) return;
    box.hidden = true;
    const drafts = [];
    for (const d of await listDrafts(pkg)) {
      if (this.pkg !== pkg) return;
      const original = await pkg.readOriginalBytes(d.path).catch(() => null);
      if (original && crc32(original) === d.baseCrc) drafts.push(d);
    }
    if (!drafts.length || this.pkg !== pkg || this.editor) return;
    $('draft-offer-text').textContent = t('edit.draftsFound', { n: drafts.length });
    box.hidden = false;
    // 押したときに、もう編集画面で開いた譜面は除く(その譜面は編集の状態と新しい下書きの方が新しい)
    const live = () => drafts.filter((d) => !this._editSessions.has(normKey(d.path)));
    $('draft-restore').onclick = async () => {
      box.hidden = true;
      if (this.pkg !== pkg) return;
      const ds = live();
      for (const d of ds) pkg.setOverride(d.path, d.bytes);
      await pkg.rescan();
      this.renderSongList();
      this.setStatus(msg('edit.draftsRestored', { n: ds.length }));
    };
    $('draft-discard').onclick = async () => {
      box.hidden = true;
      for (const d of live()) await deleteDraft(pkg, d.path);
    };
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
