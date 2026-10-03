// アプリ本体: 画面遷移(ホーム / 演奏)、設定 UI、入力とメニューの接続、描画ループ。

import { SongPackage } from './core/song.js';
import { AudioEngine } from './core/audio.js';
import { loadJSON, saveJSON, saveLastZip, loadLastZip, saveSkinFiles, loadSkinFiles } from './core/storage.js';
import { LANE_NAMES } from './core/dtx.js';
import { TrainingSettings, LOOP_UNIT, stepLoopTime, formatLoopTime } from './game/training.js';
import { Player, PLAYER_STATE } from './game/player.js';
import { HitRanges } from './game/hitranges.js';
import { Skin, PANELS, LEGACY_SKIN_BASE, collectSkinFiles, normalizeSkinPath } from './ui/skin.js';
import { Renderer } from './ui/renderer.js';
import { FramePacer, IDLE_DRAW_FPS } from './ui/framepace.js';
import { TrainingMenu, MENU_COMMAND } from './ui/menu.js';
import { DrumInput, LANE_KEY_DEFAULTS, keyLabel, eventCode } from './ui/input.js';
import {
  LANE_COUNT, MAX_KEYS_PER_LANE, addKey, replaceKey, removeKey, clearLane, resetLane,
  defaultBindings, normalizeBindings, isAssignableCode, isModifierCode, laneKeysText,
} from './ui/keybind.js';
import { MidiInput } from './ui/midi.js';
import { defaultMidiNotes, defaultVelocityMin, normalizeMidiNotes, normalizeVelocityMin } from './ui/midibind.js';
import { MidiPanel } from './ui/midipanel.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_CONFIG = {
  bindings: defaultBindings(),
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

/** #DLEVEL の表示(DTXMania と同じ 2 桁レベルは 1/10、3 桁は 1/100 の小数表記)。 */
function levelText(level, dec) {
  if (!level) return '';
  const v = level >= 100 ? level / 10 : level / 10 + (dec || 0) / 100;
  return v.toFixed(2);
}

class App {
  constructor() {
    const saved = loadJSON('config', {}) || {};
    this.config = Object.assign({}, DEFAULT_CONFIG, saved);
    // 以前の「スキン画像(assets/skin)を使う」(skinImages)は、そのフォルダを指定したスキンへ移す
    if (saved.skin === undefined && saved.skinImages !== undefined) this.config.skin = saved.skinImages ? 'folder' : 'default';
    delete this.config.skinImages;
    // 壊れている / 古い形式の config でもレーン単位で直す(1 レーンの欠落で他 9 レーンを捨てない)
    const norm = normalizeBindings(this.config.bindings);
    this.config.bindings = norm.bindings;
    this._keysRepaired = norm.repaired; // 起動時に直したレーン(設定を開いたときに知らせる)
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
    this._assign = null; // キー割り当ての待ち受け {lane, mode, index, finish}
    this._keysUndo = null; // 直前の bindings(1 段だけの「元に戻す」)
    this._keysUndoLane = null; // その操作をしたレーン(undo 後にフォーカスを戻す先)
    this._keyPos = new Array(LANE_COUNT).fill(0); // 行ごとのカーソル位置(ローミング tabindex)
    this._seek = null; // 停止中のシークバー
    this._wakeLock = null;
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    document.body.classList.toggle('touch', this.isTouch);
    document.body.classList.toggle('desktop', !this.isTouch);
  }

  async init() {
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
        this.setStatus('ZIP を取得中… ' + zipUrl);
        const r = await fetch(zipUrl);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        await this.loadPackage(blob, zipUrl.split('/').pop(), { fromCache: true });
      } catch (e) {
        this.setStatus('ZIP の取得に失敗しました: ' + e.message, true);
      }
    }
  }

  showLastButton(blob, name) {
    const b = $('btn-last');
    b.hidden = false;
    b.textContent = '前回の ZIP を開く(' + (name || 'zip') + ')';
    b.onclick = () => this.loadPackage(blob, name, { fromCache: true });
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
      this.cancelAssign('ウィンドウを離れたため中止しました');
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

  setStatus(text, error = false) {
    const el = $('pkg-status');
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('error', error);
  }

  async loadPackage(blob, name, opts) {
    const gen = ++this._loadGen;
    this.setStatus('ZIP を読み込み中…');
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
      if (gen === this._loadGen) this.setStatus('読み込みに失敗しました: ' + (e && e.message ? e.message : e), true);
    }
  }

  async loadFolder(files) {
    const gen = ++this._loadGen;
    this.setStatus('フォルダを読み込み中…');
    try {
      const pkg = await SongPackage.fromFiles(files);
      if (gen !== this._loadGen) { pkg.dispose(); return; }
      if (this.pkg) this.pkg.dispose();
      this.pkg = pkg;
      await this.showSongList();
    } catch (e) {
      console.error(e);
      if (gen === this._loadGen) this.setStatus('読み込みに失敗しました: ' + (e && e.message ? e.message : e), true);
    }
  }

  async showSongList() {
    const pkg = this.pkg;
    const list = $('song-list');
    list.innerHTML = '';
    if (!pkg.songs.length) {
      this.setStatus('この ZIP には .dtx 譜面が見つかりませんでした。', true);
      return;
    }
    this.setStatus(`${pkg.name || 'ZIP'}: ${pkg.songs.length} 曲`);
    for (const song of pkg.songs) {
      const li = document.createElement('li');
      li.className = 'song';
      const img = document.createElement('img');
      img.className = 'jacket';
      img.alt = '';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const h = song.charts[0].header;
      meta.innerHTML = `<div class="title"></div><div class="artist"></div><div class="charts"></div>`;
      meta.querySelector('.title').textContent = song.title;
      meta.querySelector('.artist').textContent = [h.artist, h.bpm ? 'BPM ' + h.bpm : ''].filter(Boolean).join('  ');
      const charts = meta.querySelector('.charts');
      for (const c of song.charts) {
        const b = document.createElement('button');
        b.innerHTML = `<span class="lbl"></span><span class="lv"></span>`;
        b.querySelector('.lbl').textContent = c.label || c.header.title || c.path.split('/').pop();
        b.querySelector('.lv').textContent = levelText(c.header.level, c.header.levelDec);
        b.onclick = () => this.startChart(song, c);
        charts.appendChild(b);
      }
      li.appendChild(img);
      li.appendChild(meta);
      list.appendChild(li);
      if (h.preimage) pkg.imageUrl(song.dir, h.preimage).then((u) => { if (u) img.src = u; }).catch(() => {});
    }
  }

  // ---- キー割り当て UI ----
  // 1 レーン = 1 行のチップ列。キー名を押すと差し替え、× で 1 個外す、＋ 追加で足す。
  // タブ停止点は 1 行 1 個だけにして(ローミング tabindex)、行内は ←→、レーン間は ↑↓ で移動する。

  /** キー割り当ての待ち受けを畳む(割り当ては行わない)。reason を渡すと状態表示も書き換える。 */
  cancelAssign(reason) {
    const a = this._assign;
    if (!a) return;
    this._assign = null;
    a.finish();
    if (reason) this.setKeyStatus(reason);
  }

  _keyRow(lane) {
    return $('key-list').querySelector('.key-row[data-lane="' + lane + '"]');
  }

  /**
   * 行内のカーソル対象ボタン(DOM 順)。
   * 「中止」は待ち受け中だけ現れて消えるので対象から外す。含めると、中止を押した拍子に
   * カーソルが 1 つ手前(= レーンを空にする「解除」)へ滑ってしまう。
   */
  _keyItems(lane) {
    const row = this._keyRow(lane);
    return row ? Array.from(row.querySelectorAll('button:not(.chip-cancel)')) : [];
  }

  /** 行のタブ停止点をカーソル位置の 1 個だけにする。 */
  _keyApplyTabIndex(lane) {
    const items = this._keyItems(lane);
    if (!items.length) return;
    const pos = Math.max(0, Math.min(this._keyPos[lane], items.length - 1));
    this._keyPos[lane] = pos;
    items.forEach((b, i) => { b.tabIndex = i === pos ? 0 : -1; });
  }

  _keyFocus(lane, pos) {
    const items = this._keyItems(lane);
    if (!items.length) return;
    this._keyPos[lane] = Math.max(0, Math.min(pos, items.length - 1));
    this._keyApplyTabIndex(lane);
    items[this._keyPos[lane]].focus({ preventScroll: true });
  }

  _keyFocusEl(lane, el) {
    const i = el ? this._keyItems(lane).indexOf(el) : -1;
    if (i >= 0) this._keyFocus(lane, i);
  }

  buildKeyUi() {
    const list = $('key-list');
    list.textContent = '';
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const row = document.createElement('div');
      row.className = 'key-row';
      row.dataset.lane = String(lane);
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', LANE_NAMES[lane] + ' のキー割り当て');
      const name = document.createElement('span');
      name.className = 'key-lane';
      name.setAttribute('aria-hidden', 'true');
      name.textContent = LANE_NAMES[lane];
      const chips = document.createElement('div');
      chips.className = 'chips';
      row.appendChild(name);
      row.appendChild(chips);
      list.appendChild(row);
    }
    // マウスで押したときもカーソル位置を合わせる(再描画後のフォーカス復帰に使う)
    list.addEventListener('focusin', (e) => {
      const row = e.target.closest ? e.target.closest('.key-row') : null;
      if (!row) return;
      const lane = Number(row.dataset.lane);
      const i = this._keyItems(lane).indexOf(e.target);
      if (i >= 0 && i !== this._keyPos[lane]) { this._keyPos[lane] = i; this._keyApplyTabIndex(lane); }
    });
    list.addEventListener('keydown', (e) => this.onKeyListKey(e));
    $('key-undo').onclick = () => this.undoKeys();
    $('btn-keys-default').onclick = () => {
      this.cancelAssign();
      const before = this.config.bindings.map((a) => a.slice());
      this.commitBindings(defaultBindings(), '全レーンを既定に戻しました', before);
      this.renderAllKeyLanes();
      $('btn-keys-default').focus({ preventScroll: true });
    };
    this.renderAllKeyLanes();
    this.updateHelpKeys();
    const bad = (this._keysRepaired || []).map((l) => LANE_NAMES[l]);
    this.setKeyStatus(bad.length
      ? `${bad.join(' / ')} の設定が使えないキーだったので、割り当て直しました。確認してください。`
      : '');
  }

  /** 1 レーン分だけ描き直す(変化した行以外のフォーカスとハンドラを壊さない)。 */
  renderKeyLane(lane) {
    const row = this._keyRow(lane);
    if (!row) return;
    const chips = row.querySelector('.chips');
    const hadFocus = row.contains(document.activeElement);
    const codes = this.config.bindings[lane]; // 毎回読み直す(差し替え前の配列を掴まない)
    const cap = this._assign && this._assign.lane === lane ? this._assign : null;
    const name = LANE_NAMES[lane];
    chips.textContent = '';

    codes.forEach((code, i) => {
      const capturing = !!cap && cap.mode === 'replace' && cap.index === i;
      const chip = document.createElement('span');
      chip.className = 'chip';
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'chip-key' + (capturing ? ' listening' : '');
      key.textContent = capturing ? '⌨' : keyLabel(code);
      key.setAttribute('aria-label', capturing
        ? `${name} の ${keyLabel(code)} を差し替え中。割り当てるキーを押してください`
        : `${name} の ${keyLabel(code)}。Enter で差し替え、Delete で削除`);
      key.onclick = () => this.startAssign(lane, 'replace', i);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.textContent = '×';
      del.title = '外す';
      del.setAttribute('aria-label', `${name} から ${keyLabel(code)} を外す`);
      del.onclick = () => this.removeKeyAt(lane, i);
      chip.appendChild(key);
      chip.appendChild(del);
      chips.appendChild(chip);
    });
    if (!codes.length) {
      const none = document.createElement('span');
      none.className = 'chip-empty';
      none.textContent = 'なし';
      chips.appendChild(none);
    }

    const adding = !!cap && cap.mode === 'add';
    const full = codes.length >= MAX_KEYS_PER_LANE;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip-add' + (adding ? ' listening' : '') + (full && !adding ? ' is-full' : '');
    add.textContent = adding ? '⌨ 入力待ち' : '＋ 追加';
    if (full && !adding) add.setAttribute('aria-disabled', 'true');
    add.setAttribute('aria-label', full
      ? `${name} は上限の ${MAX_KEYS_PER_LANE} キーです`
      : `${name} にキーを追加 (${codes.length}/${MAX_KEYS_PER_LANE})`);
    add.onclick = () => this.startAssign(lane, 'add', -1);
    chips.appendChild(add);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'chip-lane-cmd';
    reset.textContent = '既定';
    reset.setAttribute('aria-label', `${name} を既定(${laneKeysText(LANE_KEY_DEFAULTS[lane])})に戻す`);
    reset.onclick = () => this.resetKeyLane(lane);
    chips.appendChild(reset);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip-lane-cmd';
    clear.textContent = '解除';
    clear.setAttribute('aria-label', `${name} のキーをすべて外す`);
    clear.onclick = () => this.clearKeyLane(lane);
    chips.appendChild(clear);

    if (cap) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chip-cancel';
      cancel.textContent = '中止';
      cancel.tabIndex = 0; // _keyItems の対象外なので自前で持たせる
      cancel.onclick = () => this.cancelAssign('中止しました');
      chips.appendChild(cancel);
    }

    if (hadFocus) this._keyFocus(lane, this._keyPos[lane]);
    else this._keyApplyTabIndex(lane);
  }

  renderAllKeyLanes() {
    for (let lane = 0; lane < LANE_COUNT; lane++) this.renderKeyLane(lane);
  }

  /** 他レーンから取り上げた / 入れ替えた行を 1 秒だけ光らせる(気付かれずに変わらないように)。 */
  flashKeyLane(lane) {
    const row = this._keyRow(lane);
    if (!row) return;
    row.classList.remove('row-changed');
    void row.offsetWidth; // アニメーションを再start させる
    row.classList.add('row-changed');
    setTimeout(() => row.classList.remove('row-changed'), 1000);
  }

  setKeyStatus(text) {
    $('key-status-text').textContent = text || '';
    // 「元に戻す」の有無はスナップショットの生死だけで決める。案内や中止のメッセージで消さない
    // (取り上げ / スワップに気付いて次の操作を始めた瞬間に復旧手段が消えてしまうため)。
    $('key-undo').hidden = !this._keysUndo;
  }

  /** bindings を差し替えて保存する。before を渡すと「元に戻す」を出す。 */
  commitBindings(next, text, before, lane) {
    if (before) {
      this._keysUndo = before;
      this._keysUndoLane = lane === undefined ? null : lane;
    }
    this.config.bindings = next;
    this.saveConfig();
    this.updateHelpKeys();
    this.setKeyStatus(text);
  }

  undoKeys() {
    const prev = this._keysUndo;
    if (!prev) return;
    const lane = this._keysUndoLane;
    // 「元に戻す」自身が消えるので、フォーカスを body に落とさないよう先に逃がす
    const hadFocus = document.activeElement === $('key-undo');
    this.cancelAssign();
    this._keysUndo = null;
    this._keysUndoLane = null;
    this.config.bindings = prev;
    this.saveConfig();
    this.updateHelpKeys();
    this.renderAllKeyLanes();
    if (hadFocus) {
      if (lane !== null) this._keyFocus(lane, this._keyPos[lane]);
      else $('btn-keys-default').focus({ preventScroll: true });
    }
    this.setKeyStatus('元に戻しました');
  }

  /** 操作方法パネルのドラム行を今の割り当てで書き直す。 */
  updateHelpKeys() {
    const el = $('help-keys');
    if (!el) return;
    el.textContent = this.config.bindings.map((codes, lane) => `${LANE_NAMES[lane]}=${laneKeysText(codes)}`).join('  ');
  }

  /** #key-list 内のキー操作(カーソル移動と Delete)。キャプチャ中はここまで来ない。 */
  onKeyListKey(e) {
    const row = e.target.closest ? e.target.closest('.key-row') : null;
    if (!row) return;
    const lane = Number(row.dataset.lane);
    const items = this._keyItems(lane);
    const pos = items.indexOf(e.target);
    const code = eventCode(e);
    // Space はボタンの既定の活性化を殺す。BD の試し打ちで割り当てが暴発するのを防ぐ(実行は Enter)。
    if (code === 'Space') { e.preventDefault(); return; }
    if (code === 'ArrowLeft' || code === 'ArrowRight') {
      e.preventDefault();
      this._keyFocus(lane, pos + (code === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (code === 'Home' || code === 'End') {
      e.preventDefault();
      this._keyFocus(lane, code === 'Home' ? 0 : items.length - 1);
      return;
    }
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      e.preventDefault();
      const next = (lane + (code === 'ArrowUp' ? -1 : 1) + LANE_COUNT) % LANE_COUNT;
      this._keyFocus(next, this._keyPos[next]);
      return;
    }
    if (code === 'Delete' || code === 'Backspace') {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      e.preventDefault();
      const index = Array.from(row.querySelectorAll('.chip')).indexOf(chip);
      if (index >= 0) this.removeKeyAt(lane, index);
    }
  }

  /**
   * キー入力の待ち受けを始める。
   * @param {number} lane
   * @param {'add'|'replace'} mode
   * @param {number} index replace のときの位置
   */
  startAssign(lane, mode, index) {
    this.cancelAssign();
    if (this.midiPanel) this.midiPanel.cancelCapture('中止しました'); // 電子ドラムの「叩いて追加」と同時には待たない
    const name = LANE_NAMES[lane];
    const codes = this.config.bindings[lane];
    if (mode === 'add' && codes.length >= MAX_KEYS_PER_LANE) {
      this.setKeyStatus(`${name} は上限の ${MAX_KEYS_PER_LANE} キーです。× でどれか外すか、キー名を押して差し替えてください。`);
      return;
    }
    if (mode === 'replace' && codes[index] === undefined) return;

    const onKey = (e) => {
      const code = eventCode(e);
      if (isModifierCode(code)) return; // 修飾キー単体は押し途中なので無視
      e.preventDefault();
      e.stopPropagation(); // 待ち受け中はアプリのホットキーもブラウザの既定も通さない
      if (code === 'Escape') { this.cancelAssign('中止しました'); return; }
      if (!isAssignableCode(code)) {
        this.setKeyStatus(`${keyLabel(code)} はメニュー操作に使うため割り当てできません。別のキーを押してください。`);
        return; // 待ち受けは続ける
      }
      this.applyAssign(code);
    };
    const onOutside = (e) => { if (!$('key-list').contains(e.target)) this.cancelAssign('中止しました'); };
    const onVisibility = () => { if (document.hidden) this.cancelAssign('中止しました'); };
    // 安全網。無言で畳まず理由を出す(旧実装は 10 秒で無通知だった)。
    const timer = setTimeout(() => this.cancelAssign('時間切れで中止しました'), 30000);
    const finish = () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onOutside, true); // pointerdown だとスクロール開始で誤爆する
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
      this.renderKeyLane(lane);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onOutside, true);
    document.addEventListener('visibilitychange', onVisibility);

    this._assign = { lane, mode, index, finish };
    this.renderKeyLane(lane);
    this.setKeyStatus(mode === 'add'
      ? `${name} にキーを追加します。割り当てるキーを押してください(Esc で中止)`
      : `${name} の ${keyLabel(codes[index])} を差し替えます。新しいキーを押してください(Esc で中止)`);
  }

  /** 待ち受け中に押されたキーを割り当てる。 */
  applyAssign(code) {
    const a = this._assign;
    if (!a) return;
    const { lane, mode, index } = a;
    const name = LANE_NAMES[lane];
    const before = this.config.bindings.map((x) => x.slice());
    const old = mode === 'replace' ? this.config.bindings[lane][index] : null;
    const r = mode === 'add'
      ? addKey(this.config.bindings, lane, code)
      : replaceKey(this.config.bindings, lane, index, code);

    if (!r.ok) {
      if (r.reason === 'already') {
        this.setKeyStatus(`${keyLabel(code)} は ${name} に登録済みです。別のキーを押してください。`);
        return; // 待ち受け継続
      }
      if (r.reason === 'same') this.cancelAssign('変更ありません');
      else if (r.reason === 'full') this.cancelAssign(`${name} は上限の ${MAX_KEYS_PER_LANE} キーです。`);
      else this.cancelAssign(`${keyLabel(code)} は割り当てできません。`);
      return;
    }

    const other = mode === 'add' ? r.stolenFrom : r.swappedWith;
    let text;
    if (mode === 'add') {
      text = `${name} に ${keyLabel(code)} を追加しました (${r.bindings[lane].length}/${MAX_KEYS_PER_LANE})`;
      if (other !== null && other !== lane) {
        text += `。${LANE_NAMES[other]} から移しました`;
        if (r.stolenEmptied) text += `(${LANE_NAMES[other]} は割り当てなしになりました)`;
      }
    } else {
      text = `${name} の ${keyLabel(old)} を ${keyLabel(code)} に差し替えました`;
      if (other !== null && other !== lane) text += `。${LANE_NAMES[other]} には ${keyLabel(old)} を入れ替えました`;
      else if (other === lane) text += `(同じレーン内で入れ替え)`;
    }

    this.commitBindings(r.bindings, text, before, lane);
    this.cancelAssign(); // finish() が lane を描き直す
    if (other !== null && other !== lane) { this.renderKeyLane(other); this.flashKeyLane(other); }
    const row = this._keyRow(lane);
    this._keyFocusEl(lane, mode === 'add'
      ? row.querySelector('.chip-add') // 続けてもう 1 個足せるように
      : row.querySelectorAll('.chip-key')[index]);
  }

  removeKeyAt(lane, index) {
    this.cancelAssign();
    const before = this.config.bindings.map((a) => a.slice());
    const r = removeKey(this.config.bindings, lane, index);
    if (!r.ok) return;
    const name = LANE_NAMES[lane];
    this.commitBindings(r.bindings, r.emptied
      ? `${name} から ${keyLabel(r.removed)} を外しました。${name} は割り当てなしです(既定には戻りません)。`
      : `${name} から ${keyLabel(r.removed)} を外しました (${r.bindings[lane].length}/${MAX_KEYS_PER_LANE})`, before, lane);
    this.renderKeyLane(lane);
    // 左隣のチップの「キー名」へ(そこなら Delete の連打がそのまま効く)。無ければ先頭 / ＋ 追加。
    // チップ 1 個 = キー名 + × の 2 ボタンなので、index 番目の左隣のキー名は (index - 1) * 2。
    if (index > 0) this._keyFocus(lane, index * 2 - 2);
    else this._keyFocusEl(lane, this._keyRow(lane).querySelector(r.emptied ? '.chip-add' : '.chip-key'));
  }

  resetKeyLane(lane) {
    this.cancelAssign();
    const before = this.config.bindings.map((a) => a.slice());
    const r = resetLane(this.config.bindings, lane);
    const name = LANE_NAMES[lane];
    let text = `${name} を既定(${laneKeysText(r.bindings[lane])})に戻しました`;
    const stolen = r.stolenFrom.filter((l) => l !== lane);
    if (stolen.length) text += `。${stolen.map((l) => LANE_NAMES[l]).join(' / ')} から取り上げました`;
    const emptied = r.stolenEmptied.filter((l) => l !== lane);
    if (emptied.length) text += `(${emptied.map((l) => LANE_NAMES[l]).join(' / ')} は割り当てなしになりました)`;
    this.commitBindings(r.bindings, text, before, lane);
    this.renderKeyLane(lane);
    for (const l of stolen) { this.renderKeyLane(l); this.flashKeyLane(l); }
    this._keyFocusEl(lane, this._keyRow(lane).querySelector('.chip-key'));
  }

  clearKeyLane(lane) {
    this.cancelAssign();
    const before = this.config.bindings.map((a) => a.slice());
    const r = clearLane(this.config.bindings, lane);
    const name = LANE_NAMES[lane];
    this.commitBindings(r.bindings, `${name} のキーをすべて外しました(既定には戻りません)`, before, lane);
    this.renderKeyLane(lane);
    this._keyFocusEl(lane, this._keyRow(lane).querySelector('.chip-add'));
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
      if (change.added.length) this.player.showStatus('MIDI: ' + change.added.join(', ') + ' をつなぎました', 2500);
      if (change.removed.length) this.player.showStatus('MIDI: ' + change.removed.join(', ') + ' が外れました', 4000);
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
      beforeCapture: () => this.cancelAssign('中止しました'),
      visible: () => !$('screen-home').hidden && $('settings-panel').open,
    });
    this.midiPanel.build();
    $('settings-panel').addEventListener('toggle', () => this.midiPanel.refresh());
    const badMidi = (this._midiRepaired || []).map((l) => LANE_NAMES[l]);
    if (badMidi.length) this.midiPanel.setStatus(`${badMidi.join(' / ')} の MIDI 設定が読めなかったので、既定に戻しました。確認してください。`);

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
        this.setSkinNote('スキンの画像(chips.png / pads.png / score_panel.png / song_panel.png)が見つかりませんでした。');
        return;
      }
      this._skinFiles = files;
      const stored = await saveSkinFiles(files);
      c.skin = sel.value = 'files';
      showRows();
      this.saveConfig();
      await this.loadSkin();
      if (!stored) this.setSkinNote('画像をブラウザに保存できなかったので、リロードすると読み込み直しになります。', true);
    };
  }

  /** スキンの下の注記(足りない画像など)。append なら今の注記に足す。 */
  setSkinNote(text, append = false) {
    const note = $('cfg-skin-missing');
    note.textContent = append && note.textContent ? note.textContent + ' ' + text : text;
    note.hidden = !note.textContent;
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
      const info = $('cfg-skin-files-info');
      info.textContent = this._skinFiles && this._skinFiles.length
        ? '読み込み済み: ' + this._skinFiles.map((f) => f.name).join(' / ')
        : 'まだ読み込んでいません';
      const where = c.skin === 'folder' ? normalizeSkinPath(c.skinPath) + ' ' : '読み込んだ画像';
      if (c.skin === 'files' && !(this._skinFiles && this._skinFiles.length)) this.setSkinNote('画像を読み込むまでは既定のスキンで描きます。');
      else if (skin.missing.length && c.skin !== 'default') this.setSkinNote(`${where}に ${skin.missing.join(' / ')} が無いので、その部分は既定のスキンで描いています。`);
      else this.setSkinNote('');
    });
    return load;
  }

  /** ドラム音量 / BGM 音量を AudioEngine のバスへ反映する(鳴っている音にも効く)。 */
  applyVolumes() {
    this.audio.setBusVolume('chip', (this.config.chipVolume || 0) / 100);
    this.audio.setBusVolume('bgm', (this.config.bgmVolume || 0) / 100);
  }

  /**
   * 音量を step ぶん動かして保存する(トレーニングメニューと設定パネルの共通入口)。
   * @param {'chip'|'bgm'} kind
   * @returns {boolean} 値が変わったら true
   */
  stepVolume(kind, step) {
    const key = kind === 'bgm' ? 'bgmVolume' : 'chipVolume';
    const before = this.config[key];
    const v = Math.max(0, Math.min(100, Math.round(before + step)));
    if (v === before) return false;
    this.config[key] = v;
    this.applyVolumes();
    this.saveConfig();
    const el = $(kind === 'bgm' ? 'cfg-bgm' : 'cfg-chip');
    if (el) el.value = String(v); // 設定パネルのスライダーもずらさない
    const label = $((kind === 'bgm' ? 'cfg-bgm' : 'cfg-chip') + '-v');
    if (label) label.textContent = String(v);
    return true;
  }

  volumeOf(kind) {
    return this.config[kind === 'bgm' ? 'bgmVolume' : 'chipVolume'] || 0;
  }

  saveConfig() {
    saveJSON('config', this.config);
  }

  // ---- 演奏 ----
  async startChart(song, chartRef) {
    const c = this.config;
    this.cancelAssign();
    await this.audio.ensureContext();
    $('screen-home').hidden = true;
    $('screen-play').hidden = false;
    $('loading').hidden = false;
    $('loading-text').textContent = '譜面を読み込み中…';
    $('loading-bar').value = 0;
    $('loading-sub').textContent = '';
    $('play-title').textContent = song.title + (chartRef.label ? '  [' + chartRef.label + ']' : '');
    try {
      const skin = await this._skinLoad;
      const chart = await this.pkg.loadChart(chartRef.path);
      const player = new Player({
        audio: this.audio,
        settings: this.training,
        config: {
          hhGroup: c.hhGroup, ftGroup: c.ftGroup, cyGroup: c.cyGroup, bdGroup: c.bdGroup,
          hitRanges: HitRanges.default, pedalHitRanges: HitRanges.default,
          chipVolume: 1.0, autoChipVolume: 0.8,
        },
      });
      this.player = player;
      player.onQuit = () => this.leavePlay();
      const canvas = $('canvas');
      this.renderer = new Renderer(canvas, skin, player);
      this.renderer.showLag = !!c.showLag;
      const lvl = chart.level[0] ? 'LEVEL ' + levelText(chart.level[0], chart.levelDec[0]) : '';
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
        $('loading-text').textContent = `音源を読み込み中… ${done} / ${total}`;
        $('loading-bar').value = total ? (100 * done) / total : 0;
        $('loading-sub').textContent = name || '';
      });
      if (this.player !== player) return; // 読み込み中に戻った
      if (this.audio.failed.length) {
        console.warn('復号できなかった音源:', this.audio.failed);
        player.showStatus(`音源 ${this.audio.failed.length} 個が読めません(合成音で代用)`, 4000);
      }
      this.setupPlayScreen();
      $('loading').hidden = true;
      this.training.save();
    } catch (e) {
      console.error(e);
      $('loading-text').textContent = '読み込みに失敗しました: ' + (e && e.message ? e.message : e);
      $('loading-sub').innerHTML = '<button class="btn small secondary" id="btn-loadfail-back">戻る</button>';
      $('btn-loadfail-back').onclick = () => this.leavePlay();
    }
  }

  setupPlayScreen() {
    const player = this.player;
    const overlay = $('overlay');
    overlay.innerHTML = '';
    this.menu = new TrainingMenu(this.training, {
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

    this.input = new DrumInput({
      onHit: (lane, ts, source) => {
        player.hit(lane, ts, { touch: source === 'touch' });
        this.pacer.forceNext(); // 待機中の試し打ちの光も、停止中の間引きを待たずに出す
      },
      onKey: (code, down, ev) => {
        this.pacer.forceNext(); // 停止中にメニューで変えた値(ハイスピード・現在位置など)も次のフレームで出す
        return this.onKey(code, down, ev);
      },
    });
    this.input.setBindings(this.config.bindings);
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
    $('seekbar').style.top = topInset + 'px'; // プレイバーの直下に出す
    this.renderer.resize(w, h, dpr, this.config.layout || 'auto', topInset);
    // 大きさを変えるとキャンバスの中身が消えるので、停止中の間引きに当たっても次のフレームは必ず描く
    this.pacer.forceNext();
    const portrait = this.renderer.mode === 'portrait';
    document.body.classList.toggle('portrait', portrait);
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
        m.style.maxHeight = Math.max(200, h - top - 8) + 'px';
        m.style.fontSize = font + 'px';
      }
    }
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
