// 演奏コントローラ(DTXManiaAI PerformanceStage.cs のドラム演奏＋トレーニング状態機械の移植)。
//
// 時計: AudioContext の時刻を基準にする。「聞こえている ctx 時刻」− ユーザーの遅延補正 を実時間(realMs)とし、
//   譜面時刻 songMs = anchorSong + (realMs − anchorReal) × 演奏速度。聞こえている ctx 時刻は getOutputTimestamp の組を
//   延ばして作り(AudioEngine.audibleCtxAt)、使えないときは ctx.currentTime − 推定の出力遅延 にする。
//   NX/DTXManiaAI は譜面時刻の方を伸縮するが、本実装は譜面時刻を不変にして時計の進み方を変える(等価)。
//   判定窓・スクロール速度は実時間 ms の量なので、譜面時刻差を演奏速度で割ってから使う。
// 状態: standby(待機) / startin(開始待ち) / playing / paused。
// 自動発音(BGM・SE・AUTO チップ)は AudioContext に先読みスケジュールして正確に鳴らす。

import { LANE_COUNT } from '../core/dtx.js';
import { AudioEngine } from '../core/audio.js';
import { HitRanges, JUDGE, searchLanes, tieHitsAll, applyChartDowngrade, LEFT_BASS_DRUM_CHANNEL } from './hitranges.js';
import { PlayStats } from './judge.js';
import { buildMeasureTimes, PLAY_SPEED_MIN, PLAY_SPEED_MAX } from './training.js';
import { isMutingSeChannel } from '../core/dtx.js';
import { t } from '../i18n.js';

/**
 * ハイスピード x1.0 の速さ(1080p の 1ms あたりピクセル数)。
 * DTXManiaNX の CChip.ComputeDistanceFromBar がそのまま出どころ:
 *   const double speed = 286;  // BPM150 の 1 小節の長さ[dot](720p)
 *   ScrollSpeedDrums = (raw + 1.0) * 0.5 * 37.5 * speed / 60000.0
 * raw=1(= x1.0)で 37.5 * 286 / 60000 = 0.17875 px/ms(720p)。本アプリは 1080p なので ×1.5。
 * 移植元の DTXManiaAI は同じ x1.0 を 0.675 px/ms としていて約 2.5 倍速かったため、NX 側に合わせた
 * (docs/spec/nx-docs.md:262 の「NX 0.17875 px/ms ≈ 2.5× slower」)。
 */
export const SCROLL_BASE_PX_PER_MS = (37.5 * 286) / 60000 * 1.5; // = 0.268125

/** なめらか変化の 1 歩(NX は raw を 0.012 ずつ。raw 1 = 倍率 0.5 なので倍率では半分)。 */
const SCROLL_RAMP_STEP = 0.006;

export const PLAYER_STATE = { STANDBY: 'standby', START_IN: 'startin', PLAYING: 'playing', PAUSED: 'paused' };

const FINISH_TAIL_MS = 2000;
const SCHEDULE_AHEAD_MS = 200; // 自動発音の先読み量(実時間)
const PEDAL_CHANNELS = new Set([0x13, 0x1b, 0x1c]);

export class Player {
  /**
   * @param {{audio: AudioEngine, settings: import('./training.js').TrainingSettings, config: object}} deps
   *   config: { hhGroup, ftGroup, cyGroup, bdGroup, hitRanges, pedalHitRanges, chipVolume, autoChipVolume, damageLevel, autoAddGage, metronome }
   * chipVolume / autoChipVolume は元実装どおりの相対音量(手動・全体 AUTO は前者、レーン別 AUTO は後者。
   * docs/spec/dtx-audio.md:458)。ユーザーが動かす「ドラム音量」「BGM 音量」は AudioEngine のバス側。
   */
  constructor({ audio, settings, config = {} }) {
    this.audio = audio;
    this.settings = settings;
    this.config = Object.assign({
      hhGroup: 0, ftGroup: 0, cyGroup: 0, bdGroup: 0,
      hitRanges: HitRanges.default, pedalHitRanges: HitRanges.default,
      chipVolume: 1.0, autoChipVolume: 0.8, damageLevel: 1, autoAddGage: false,
    }, config);
    this.chart = null;
    this.pkg = null;
    this.state = PLAYER_STATE.STANDBY;
    this.stats = new PlayStats();
    this.notes = [];
    this.hiddenNotes = [];
    this.judged = [];
    this.hiddenJudged = [];
    this.measureTimes = [0];
    this.groups = { hhGroup: 0, ftGroup: 0, cyGroup: 0, bdGroup: 0 };

    // 時計
    this.ratio = 1;
    this._anchorReal = 0;
    this._anchorSong = 0;
    this._pinnedSong = 0; // standby/startin/paused で固定する譜面時刻
    this.startMs = 0; // 待機位置(_trainStartMs)。停止中のシークでもここが動く
    this._lastStandbyDesired = 0; // 直前の standbyPositionMs(ループ設定が動いたときだけ待機位置を追従させる)
    this._seekDirty = false; // 停止中にシークしたか(一時停止から再開するとき成績を区切る)
    this.waitUntilReal = 0;
    this._lastReal = 0;
    this._clk = -Infinity; // nowReal が最後に返した値(後退を止める)
    this._clkPair = null; // その値が組の時計からか
    this._clkHold = false; // 式が切り替わった後退を、追いつくまで止めている
    this._usedPair = false; // 直前の _realFromPerf が組の時計を使ったか

    // 設定の反映値(ApplyTrainingSettings)
    this.auto = false;
    this.laneAuto = new Array(LANE_COUNT).fill(false);
    this.allLanesAuto = false;
    this.judgeOffsetMs = 0;
    this.noteDrawOffsetMs = 0;
    this.loopBeginMs = -1;
    this.loopEndMs = -1;
    this.scrollRatioSetting = 1; // ハイスピード倍率の目標
    this.scrollCurrentRatio = 1; // なめらか変化の現在値(NX CActPerfScrollSpeed)
    this._scrollRampReal = -1;

    // 自動発音のカーソル
    this._bgmIndex = 0;
    this._seIndex = 0;
    this._autoSoundIndex = 0; // notes の先読みカーソル(AUTO レーンの音)
    this._chartVoices = new Set(); // 自動発音した voice(ジャンプ/停止で止める)
    this._seLast = new Map(); // SE チャンネル → voice

    // 演出(実時間 ms、performance.now)
    this.laneFlashUntil = new Array(LANE_COUNT).fill(0);
    this.padHitAt = new Array(LANE_COUNT).fill(-1e9);
    this.judgeStr = Array.from({ length: LANE_COUNT }, () => ({ at: -1e9, judge: -1, lagMs: 0, auto: false }));
    this.fireAt = new Array(LANE_COUNT).fill(-1e9);
    this.comboJumpAt = -1e9;
    this.statusText = '';
    this.statusUntil = 0;
    this.judgeDisplayUntil = 0;
    this.playedMaxMs = 0;

    this.onStateChange = null;
    this.onQuit = null;
    this._perfBase = 0;
  }

  // ---- 読み込み ----

  /**
   * @param {import('../core/song.js').SongPackage} pkg
   * @param {any} chart parseDTX の結果
   * @param {(done:number,total:number,name:string)=>void} [onProgress]
   */
  async load(pkg, chart, onProgress) {
    this.pkg = pkg;
    this.chart = chart;
    this.notes = chart.notes;
    this.hiddenNotes = chart.hiddenNotes;
    this.judged = new Array(this.notes.length).fill(false);
    this.hiddenJudged = new Array(this.hiddenNotes.length).fill(false);
    this.stats = new PlayStats(this.notes.length, chart.bonusChipCount);
    this.stats.damageLevel = this.config.damageLevel;
    this.measureTimes = buildMeasureTimes(chart);
    const hasLC = chart.laneHasNotes[0];
    const hasRD = chart.laneHasNotes[9];
    this.groups = applyChartDowngrade(hasLC, hasRD, this.config);
    this.searchWindowMs = Math.max(this.config.hitRanges.searchWindowMs, this.config.pedalHitRanges.searchWindowMs);
    await this.audio.loadChartSounds(pkg, chart, onProgress);
    // 合成音(音源の無いチップ・チップの無いレーンの空打ち用)を読み込み中に作っておく。初めて使うときに作ると
    // 演奏中に 1 フレーム 5〜17 ms 止まり、その空打ち音も遅れる。作る時期だけの変更で、音の中身は同じ(元実装には無い)。
    // AudioEngine がバッファを持ち続けるので 2 曲目以降は何もしない。作れなければ今までどおり初回に作る
    try {
      this.audio.synthBuffer(0);
    } catch (e) {
      console.warn('合成音の準備に失敗:', e);
    }
    // ループ区間は譜面ごとに初期化(0〜譜面長)
    this.settings.loopBeginMs = 0;
    this.settings.loopEndMs = Math.max(0, chart.durationMs);
    this.ratio = this.settings.playSpeedRatio;
    this.scrollRatioSetting = this.settings.hiSpeedRatio;
    this.scrollCurrentRatio = this.scrollRatioSetting;
    this.applySettings();
    this.enterStandby(true);
  }

  // ---- 時計 ----

  /**
   * 今「聞こえている」実時間(ms)。時計が戻らないよう、次の後退は前の値で止める。止めるのはこの「今」の読みだけで、
   * 打鍵の時刻を変換する realFromPerf は止めない(過去の timeStamp を今の読みまで持ち上げると判定が遅れる)。
   * - 組の時計と推定の式が切り替わった直後の後退は、追いつくまで止める。音の処理が止まると(出力機器の切り替えなど)
   *   組の時計は組を延ばして約 1 出力遅延ぶん先へ進んでから推定の式(止まった currentTime − 推定の遅れ)へ移り、
   *   ctx の resume 直後は逆に推定の式が組より約 20 ms 先にある。どちらも数十 ms 戻るので、以前の時計と同じく
   *   「止まる」だけにする
   * - 同じ式のままの後退は 8 ms 未満だけ止める(SoundVoltexAnalyze と同じ)。遅延補正を大きく変えたときは戻る
   */
  nowReal() {
    const v = this._realFromPerf(performance.now());
    if (this._usedPair !== this._clkPair) this._clkHold = true;
    if (v < this._clk && (this._clkHold || this._clk - v < 8)) return this._clk;
    this._clk = v;
    this._clkPair = this._usedPair;
    this._clkHold = false;
    return v;
  }

  /** performance.now 時間軸の時刻 → 実時間(ms)。状態を持たない。 */
  realFromPerf(perfMs) {
    return this._realFromPerf(perfMs);
  }

  /** realFromPerf の本体。組の時計を使ったかを _usedPair に残す(nowReal が式の切り替わりを知るため)。 */
  _realFromPerf(perfMs) {
    const audio = this.audio;
    const ctx = audio.ctx;
    this._usedPair = false;
    if (!ctx) return perfMs;
    const now = performance.now();
    const aud = audio.audibleCtxAt ? audio.audibleCtxAt(perfMs, now) : null;
    if (aud !== null) {
      this._usedPair = true;
      return aud * 1000 - (audio.userLatencyMs || 0);
    }
    // 組が使えないとき: 同一瞬間の ctx.currentTime と performance.now() で両時間軸を対応付け、推定の出力遅延を引く
    const ctxAtPerf = ctx.currentTime + (perfMs - now) / 1000;
    return (ctxAtPerf - audio.outputLatencySec) * 1000;
  }

  /** 実時間 → 譜面時刻。 */
  songAt(realMs) {
    if (this.state === PLAYER_STATE.PLAYING) return this._anchorSong + (realMs - this._anchorReal) * this.ratio;
    return this._pinnedSong;
  }

  /** 譜面時刻 → 実時間(演奏中のみ意味がある)。 */
  realAt(songMs) {
    return this._anchorReal + (songMs - this._anchorSong) / this.ratio;
  }

  /**
   * 譜面時刻 → AudioContext 時刻(秒)。
   * realMs は「聞こえている ctx 時刻」− 遅延補正 なので、ctx 時刻 T に start したバッファは
   * realMs が T − 遅延補正 のとき(遅延補正 0 なら T に達したとき)に聞こえる。よって start 時刻は
   * realAt(songMs) そのもの(遅延を足し直さない。遅延補正のぶんだけ譜面より早く・遅く鳴らすのが補正の意味)。
   */
  ctxTimeAt(songMs) {
    return this.realAt(songMs) / 1000;
  }

  /**
   * 今の ctx.currentTime(ms)。今から予約できるいちばん早い ctx 時刻で、演奏開始・再開のアンカーと先読みの基準にする。
   * 推定の時計では nowReal() + 推定の出力遅延 と同じ値。組の時計では推定と実際の遅れの差(数 ms)だけずれ、
   * currentTime より前に置くと開始位置の音の頭が欠けるので、currentTime を直接使う。
   */
  _ctxNowMs() {
    const ctx = this.audio.ctx;
    return ctx ? ctx.currentTime * 1000 : this.nowReal();
  }

  get songMs() {
    return this.songAt(this.nowReal());
  }

  get isPlaying() {
    return this.state === PLAYER_STATE.PLAYING;
  }
  get isStandby() {
    return this.state === PLAYER_STATE.STANDBY || this.state === PLAYER_STATE.START_IN;
  }

  /** メニューの状態行に出す文字列。 */
  stateText() {
    switch (this.state) {
      case PLAYER_STATE.START_IN: {
        const remain = Math.max(0, (this.waitUntilReal - this.nowReal()) / 1000);
        return 'START IN ' + remain.toFixed(1);
      }
      case PLAYER_STATE.STANDBY: return 'STANDBY';
      case PLAYER_STATE.PAUSED: return 'PAUSED';
      default: return 'PLAYING';
    }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (this.onStateChange) this.onStateChange(s);
  }

  // ---- 設定の反映(毎フレーム) ----

  applySettings() {
    const s = this.settings;
    this.auto = s.autoPlay;
    this.judgeOffsetMs = s.judgeOffsetMs;
    this.noteDrawOffsetMs = s.noteOffsetMs;
    this.scrollRatioSetting = s.hiSpeedRatio;
    let all = true;
    for (let i = 0; i < LANE_COUNT; i++) {
      this.laneAuto[i] = s.autoLanes[i];
      if (!s.autoLanes[i]) all = false;
    }
    this.allLanesAuto = all;
    const loopOn = s.loop && s.loopRangeValid;
    this.loopBeginMs = loopOn ? s.loopBeginMs : -1;
    this.loopEndMs = loopOn ? s.loopEndMs : -1;
    if (s.playSpeedRatio !== this.ratio) this._setRatio(s.playSpeedRatio);
  }

  /** 演奏速度の倍率を変える。演奏中なら現在位置を保って再アンカーし、自動音を鳴らし直す。 */
  _setRatio(ratio) {
    const song = this.songMs;
    this.ratio = ratio;
    if (this.state === PLAYER_STATE.PLAYING) {
      // 演奏中の切り替えは表示を途切れさせないよう今の実時間に置く(開始・再開の _ctxNowMs とは違う。
      // [song, song + 出力遅延] の音は playBuffer が遅れたぶん頭を飛ばして鳴らす)。jumpTo(開始待ち 0 のループ
      // 折り返し)も同じ: 開始位置の音の頭は出力遅延ぶん欠けるが、その間は終端の後ろの音が鳴っていて継ぎ目は
      // 1 フレーム以内。currentTime に置くと継ぎ目に出力遅延ぶんの空白が入り、拍どおりの打鍵が早く判定される
      this._anchorReal = this.nowReal();
      this._anchorSong = song;
      this.resyncAutoSounds(song);
    }
  }

  /** 待機位置(ループ ON なら開始位置、それ以外は曲頭)。 */
  get standbyPositionMs() {
    const s = this.settings;
    return s.loop && s.loopRangeValid ? Math.max(0, s.loopBeginMs) : 0;
  }

  /**
   * 待機中は表示位置をループ開始位置へ追従させる(SyncStandbyPosition)。
   * ただし追従させるのは「ループ設定が動いたとき」だけにする。startMs との比較にすると、
   * 停止中にユーザーが手で送った位置を毎フレーム引き戻してしまう。
   */
  syncStandbyPosition() {
    if (this.state !== PLAYER_STATE.STANDBY) return;
    const desired = this.standbyPositionMs;
    if (desired === this._lastStandbyDesired) return;
    this._lastStandbyDesired = desired;
    this.startMs = desired;
    this._seekDirty = false;
    this.jumpTo(this.startMs, false);
  }

  // ---- 停止中のシーク(譜面の確認) ----

  /** 停止中にシークできるか(演奏中は不可)。 */
  get canSeek() {
    return !!this.chart && this.state !== PLAYER_STATE.PLAYING;
  }

  /** シークの上限。最終ノートより後ろの小節も見たいので、最後の小節頭とどちらか遅い方。 */
  get seekMaxMs() {
    if (!this.chart) return 0;
    const lastMeasure = this.measureTimes.length ? this.measureTimes[this.measureTimes.length - 1] : 0;
    return Math.max(0, this.chart.durationMs, lastMeasure);
  }

  /**
   * 停止中に表示位置だけ動かす(音は鳴らさない)。閲覧はループ区間に縛らず曲全体を見られる。
   * @returns {boolean} 位置が動いたら true
   */
  seekTo(targetMs) {
    if (!this.canSeek) return false;
    const target = Math.round(Math.max(0, Math.min(this.seekMaxMs, targetMs || 0)));
    if (target === Math.round(this._pinnedSong)) return false;
    this.jumpTo(target, false); // 停止中は必ず _stopChartVoices() に落ちるので無音
    this.startMs = target; // 「演奏開始」はここから始める
    this._seekDirty = true;
    return true;
  }

  /**
   * 演奏を始められる上限。seekMaxMs は最終ノートより後ろの小節まで含むが、そこから始めると
   * 最初のフレームで曲末判定(durationMs + FINISH_TAIL_MS)が走って待機に戻ってしまう。
   */
  get playableMaxMs() {
    return this.chart ? Math.max(0, this.chart.durationMs) : 0;
  }

  /**
   * 演奏を始められる位置へ寄せる。ループ中は区間内に収める
   * (終了位置ちょうどだと最初のフレームで折り返しが走って成績が消えるので 1 ms 手前まで)。
   */
  clampStartMs(ms) {
    let v = Math.round(Math.max(0, Math.min(this.playableMaxMs, ms || 0)));
    const s = this.settings;
    if (s.loop && s.loopRangeValid) {
      const hi = Math.max(s.loopBeginMs, s.loopEndMs - 1); // 区間が 1 ms 以下でも下限を割らない
      v = Math.max(s.loopBeginMs, Math.min(hi, v));
    }
    return v;
  }

  /** 演奏速度を ±delta(TrainingPlaySpeedStep)。譜面時刻は不変なので位置の伸縮は不要。 */
  playSpeedStep(delta) {
    const s = this.settings;
    const before = s.playSpeed;
    s.playSpeed = Math.max(PLAY_SPEED_MIN, Math.min(PLAY_SPEED_MAX, s.playSpeed + delta));
    this.showStatus('PLAY SPEED x' + s.playSpeedRatio.toFixed(2));
    if (s.playSpeed === before) return;
    this._setRatio(s.playSpeedRatio);
  }

  showStatus(text, ms = 1500) {
    this.statusText = text;
    this.statusUntil = performance.now() + ms;
  }

  // ---- 状態遷移 ----

  /** 待機へ(EnterStandby)。atMs を渡すとその位置で待つ(停止中にシークした位置から始めるため)。 */
  enterStandby(resetStats, atMs) {
    this._stopChartVoices();
    this.startMs = Number.isFinite(atMs) ? Math.round(Math.max(0, atMs)) : this.standbyPositionMs;
    if (resetStats) this.stats.reset();
    this._pinnedSong = this.startMs;
    this._lastStandbyDesired = this.standbyPositionMs;
    this._seekDirty = false;
    this._setState(PLAYER_STATE.STANDBY);
    // judged[] を開始位置に合わせ直してから演奏に入ること。ずれたまま始めると
    // 1 フレームで区間内のチップが全部 MISS になる。
    this.jumpTo(this.startMs, false);
  }

  /** 「リスタート」(StartTraining)。曲頭(ループ中はループ開始位置)から。 */
  startTraining() {
    this.enterStandby(true);
    this.beginStartWait();
  }

  /** 「演奏開始」。停止中に見ていた位置から始める(シークしていなければ待機位置と同じ)。 */
  startTrainingAt(atMs) {
    const want = Math.round(Math.max(0, atMs || 0));
    const at = this.clampStartMs(want);
    if (at !== want) {
      const s = this.settings;
      const outOfLoop = s.loop && s.loopRangeValid && (want < s.loopBeginMs || want > s.loopEndMs - 1);
      this.showStatus(t(outOfLoop ? 'play.toLoop' : 'play.beforeEnd'));
    }
    this.enterStandby(true, at);
    this.beginStartWait();
  }

  /** 開始待ち(BeginStartWait)。atMs を指定するとその位置で待つ(ループ折り返し用)。 */
  beginStartWait(atMs) {
    if (Number.isFinite(atMs)) this.startMs = Math.max(0, atMs);
    else if (this.state === PLAYER_STATE.PLAYING || this.state === PLAYER_STATE.PAUSED) {
      this.startMs = Math.max(0, Math.round(this.songMs));
    }
    this._stopChartVoices();
    this._pinnedSong = this.startMs;
    this.waitUntilReal = this.nowReal() + Math.max(0, this.settings.startWaitMs);
    this._setState(PLAYER_STATE.START_IN);
  }

  /**
   * 演奏開始(BeginPlaying)。開始位置の音を頭から鳴らせるよう、開始位置を今の ctx.currentTime の実時刻に合わせる
   * (今 start した音が聞こえる瞬間に開始位置が来る。聞こえている時刻より出力遅延ぶん先)。
   */
  beginPlaying() {
    // 開始待ち中にシークされているかもしれないので、ここでも演奏可能範囲へ寄せ直す。
    // judged[] を同じ値で張り直してから入ること(ずれたまま始めると 1 フレームで全部 MISS になる)。
    const at = this.clampStartMs(this.startMs);
    if (at !== this.startMs) {
      this.startMs = at;
      this.jumpTo(at, false);
    }
    this._seekDirty = false; // 演奏に入ったら持ち越さない(後の「再開」で成績が消えてしまう)
    this._anchorReal = this._ctxNowMs();
    this._anchorSong = this.startMs;
    this._setState(PLAYER_STATE.PLAYING);
    this.resyncAutoSounds(this.startMs);
  }

  togglePause() {
    if (this.state === PLAYER_STATE.PLAYING) {
      this._pinnedSong = this.songMs;
      this._stopChartVoices();
      this._setState(PLAYER_STATE.PAUSED);
    } else if (this.state === PLAYER_STATE.PAUSED) {
      // シークして戻ったぶんは叩き直しになるので、ループ折り返しと同じ区切りを入れる
      // (入れないと同じチップが二重に数えられて達成率が壊れる)。
      if (this._seekDirty) {
        this.stats.resetForLoop();
        this._seekDirty = false;
        this.showStatus(t('play.recount'));
      }
      this._anchorReal = this._ctxNowMs(); // beginPlaying と同じ
      this._anchorSong = this._pinnedSong;
      this._setState(PLAYER_STATE.PLAYING);
      this.resyncAutoSounds(this._pinnedSong);
    }
  }

  /** 「演奏停止」(成績は残す)。 */
  stop() {
    this.enterStandby(false);
  }

  /** メニューの指示を処理する。 */
  command(cmd) {
    switch (cmd) {
      case 'startStop':
        if (this.isStandby) this.startTrainingAt(this._pinnedSong);
        else this.enterStandby(false);
        break;
      case 'restart':
        this.startTraining();
        break;
      case 'pauseResume':
        this.togglePause();
        break;
      case 'quit':
        // 以降のフレーム処理(自動発音のスケジュール等)を止めてから呼び出し側へ返す
        this._stopChartVoices();
        this.chart = null;
        if (this.onQuit) this.onQuit();
        break;
      default:
        break;
    }
  }

  /**
   * 曲内ジャンプ(JumpInSong)。target より前のチップは処理済み扱い、以降は未判定に戻す。
   * 成績は触らない。
   */
  jumpTo(targetMs, resyncAudio) {
    const target = Math.max(0, targetMs);
    for (let i = 0; i < this.notes.length; i++) {
      this.judged[i] = this.notes[i].timeMs < target;
      this.notes[i].soundScheduled = false;
    }
    for (let i = 0; i < this.hiddenNotes.length; i++) this.hiddenJudged[i] = this.hiddenNotes[i].timeMs < target;
    this._bgmIndex = countBefore(this.chart.bgmEvents, target);
    this._seIndex = countBefore(this.chart.seEvents, target);
    this._autoSoundIndex = countBefore(this.notes, target);
    this._seLast.clear();
    if (this.state === PLAYER_STATE.PLAYING) {
      this._anchorReal = this.nowReal();
      this._anchorSong = target;
    } else {
      this._pinnedSong = target;
    }
    if (resyncAudio && this.state === PLAYER_STATE.PLAYING) this.resyncAutoSounds(target);
    else this._stopChartVoices();
  }

  /** BGM/SE を現在位置から鳴らし直す(ResyncAutoSounds)。 */
  resyncAutoSounds(songMs) {
    this._stopChartVoices();
    this._seLast.clear();
    this._bgmIndex = countBefore(this.chart.bgmEvents, songMs);
    this._seIndex = countBefore(this.chart.seEvents, songMs);
    this._autoSoundIndex = countBefore(this.notes, songMs);
    // 未判定のチップは手動ヒット時に音を出せるよう、判定済みのものだけ発音済み扱いにする
    for (let i = 0; i < this.notes.length; i++) this.notes[i].soundScheduled = this.judged[i];
    // 開始時刻は songMs の実時刻(過去なら playBuffer が遅れたぶんだけ頭を飛ばす)
    const when = this.ctxTimeAt(songMs);
    const resync = (events, isBgm) => {
      for (const ev of events) {
        if (ev.timeMs >= songMs) break;
        const buf = this.audio.buffers.get(ev.wavId);
        if (!buf) continue;
        const offsetSec = (songMs - ev.timeMs) / 1000;
        if (offsetSec >= buf.duration) continue;
        const { volume, pan } = AudioEngine.gainPan(this.chart, ev.wavId);
        const v = this.audio.play(ev.wavId, { when, offset: offsetSec, volume, pan, rate: this.ratio, bus: isBgm ? 'bgm' : null });
        if (v) {
          this._trackVoice(v);
          if (!isBgm) this._seLast.set(ev.channel, v);
        }
      }
    };
    resync(this.chart.bgmEvents, true);
    resync(this.chart.seEvents, false);
  }

  /** 自動発音した voice を覚えておく(ジャンプ/停止で止める)。鳴り終わったら外す。 */
  _trackVoice(v) {
    this._chartVoices.add(v);
    if (v.src && v.src.addEventListener) v.src.addEventListener('ended', () => this._chartVoices.delete(v));
  }

  _stopChartVoices() {
    for (const v of this._chartVoices) this.audio.stopVoice(v);
    this._chartVoices.clear();
    this._seLast.clear();
  }

  // ---- 毎フレーム ----

  /**
   * @param {number} perfNow performance.now()
   * @param {{takeCommand?:()=>string}} [menu]
   */
  update(perfNow, menu) {
    if (!this.chart) return;
    this._perfBase = perfNow;
    const realNow = this.nowReal();
    this.updateScrollSpeed(realNow);

    if (this.state === PLAYER_STATE.START_IN && realNow >= this.waitUntilReal) this.beginPlaying();
    if (menu) {
      const cmd = menu.takeCommand();
      if (cmd && cmd !== 'none') this.command(cmd);
    }
    if (!this.chart) return; // 終了(quit)した
    this.applySettings();
    this.syncStandbyPosition();

    if (this.state !== PLAYER_STATE.PLAYING) return;

    let songMs = this.songAt(realNow);

    // ループ折り返し
    if (this.loopEndMs !== -1 && songMs > this.loopEndMs) {
      const begin = this.loopBeginMs === -1 ? 0 : this.loopBeginMs;
      this.jumpTo(begin, true);
      this.stats.resetForLoop();
      songMs = begin;
      if (this.settings.startWaitMs > 0) {
        this.beginStartWait(begin);
        return;
      }
    }

    this.scheduleAutoSounds(songMs, realNow);
    this.processJudgement(songMs, realNow, perfNow);
    if (songMs > this.playedMaxMs) this.playedMaxMs = songMs;

    // 曲末 → 待機(成績は残す)
    if (this.notes.length > 0 && this.loopEndMs === -1 && songMs > this.chart.durationMs + FINISH_TAIL_MS * this.ratio) {
      this.enterStandby(false);
    }
  }

  /**
   * ハイスピードのなめらか変化(2ms ごとに目標へ近づける)。
   * NX は内部の raw 値を 1 回 0.012 ずつ動かす。raw 1 = 倍率 0.5 なので、倍率では 0.006 ずつ。
   */
  updateScrollSpeed(realNow) {
    const target = this.scrollRatioSetting;
    if (this._scrollRampReal < 0) {
      this._scrollRampReal = realNow;
      this.scrollCurrentRatio = target;
      return;
    }
    if (this.state === PLAYER_STATE.PAUSED) {
      this._scrollRampReal = realNow;
      return;
    }
    let steps = Math.floor((realNow - this._scrollRampReal) / 2);
    if (steps <= 0) return;
    this._scrollRampReal += steps * 2;
    if (steps > 500) steps = 500;
    for (let i = 0; i < steps && this.scrollCurrentRatio !== target; i++) {
      if (Math.abs(this.scrollCurrentRatio - target) <= SCROLL_RAMP_STEP) this.scrollCurrentRatio = target;
      else this.scrollCurrentRatio += this.scrollCurrentRatio < target ? SCROLL_RAMP_STEP : -SCROLL_RAMP_STEP;
    }
  }

  /** 実時間 1ms あたりのピクセル数(1080p)。 */
  get pixelsPerMs() {
    return SCROLL_BASE_PX_PER_MS * this.scrollCurrentRatio;
  }

  /** 描画用の譜面時刻(ノーツ表示調整を反映。判定には使わない)。 */
  get drawMs() {
    return this.songMs - this.noteDrawOffsetMs * this.ratio;
  }

  /** 自動発音(BGM・SE・AUTO レーンのチップ)を先読みして AudioContext にスケジュールする。 */
  scheduleAutoSounds(songMs, realNow) {
    const chart = this.chart;
    // ctx.currentTime から 200 ms 先まで予約する。聞こえている時刻(realNow)からは出力遅延ぶん多く読む必要があり、
    // そうしないと遅延の大きい端末で毎回「遅れて頭を飛ばす」経路に落ちる。leadMs は出力遅延 + 遅延補正 なので、
    // 遅延補正が大きく負だと負になる。そのときも聞こえている時刻から 200 ms 先より短くしない(短いと AUTO チップが
    // 予約より先に判定に達し、予約の無い即時の経路で譜面より早く鳴る)
    if (!Number.isFinite(realNow)) realNow = this.nowReal();
    const leadMs = Math.max(0, this._ctxNowMs() - realNow);
    const limit = songMs + (SCHEDULE_AHEAD_MS + leadMs) * this.ratio;
    // BGM
    while (this._bgmIndex < chart.bgmEvents.length && chart.bgmEvents[this._bgmIndex].timeMs <= limit) {
      const ev = chart.bgmEvents[this._bgmIndex++];
      const { volume, pan } = AudioEngine.gainPan(chart, ev.wavId);
      const v = this.audio.play(ev.wavId, { when: this.ctxTimeAt(ev.timeMs), volume, pan, rate: this.ratio, bus: 'bgm' });
      if (v) this._trackVoice(v);
    }
    // SE(SE01-05 は同一チャンネルの前音を止める)
    while (this._seIndex < chart.seEvents.length && chart.seEvents[this._seIndex].timeMs <= limit) {
      const ev = chart.seEvents[this._seIndex++];
      const when = this.ctxTimeAt(ev.timeMs);
      if (isMutingSeChannel(ev.channel)) {
        const prev = this._seLast.get(ev.channel);
        if (prev) this.audio.stopVoice(prev, when);
      }
      const { volume, pan } = AudioEngine.gainPan(chart, ev.wavId);
      const v = this.audio.play(ev.wavId, { when, volume, pan, rate: this.ratio });
      if (v) {
        this._trackVoice(v);
        this._seLast.set(ev.channel, v);
      }
    }
    // AUTO チップの音(判定は processJudgement で songMs 到達時に行う)
    while (this._autoSoundIndex < this.notes.length && this.notes[this._autoSoundIndex].timeMs <= limit) {
      const i = this._autoSoundIndex++;
      const n = this.notes[i];
      if (this.judged[i] || n.soundScheduled) continue;
      const laneAuto = this.laneAuto[n.lane];
      if (!this.auto && !laneAuto) continue;
      n.soundScheduled = true;
      const vol = this.auto ? this.config.chipVolume : this.config.autoChipVolume;
      const v = this.playChipSound(n, vol, this.ctxTimeAt(n.timeMs));
      if (v) this._trackVoice(v);
    }
  }

  /** チップの音を鳴らす(PlayHit)。#WAV が無ければレーンの合成音。 */
  playChipSound(note, vol, when) {
    const id = note.wavId;
    const { volume, pan } = AudioEngine.gainPan(this.chart, id);
    if (this.audio.hasBuffer(id)) {
      return this.audio.play(id, { when, volume: volume * vol, pan, rate: this.ratio, bus: 'chip' });
    }
    return this.audio.playBuffer(this.audio.synthBuffer(note.lane), { when, volume: vol, rate: this.ratio, key: 'synth' + note.lane, bus: 'chip' });
  }

  // ---- 判定 ----

  rangesFor(channel) {
    return PEDAL_CHANNELS.has(channel) ? this.config.pedalHitRanges : this.config.hitRanges;
  }

  /** 実時間 ms の判定窓を譜面時刻差に変換する。 */
  _w(ms) {
    return ms * this.ratio;
  }

  /** 毎フレームの判定処理(ProcessJudgement): 不可視チップの消費 → AUTO → ミス検出。 */
  processJudgement(songMs, realNow, perfNow) {
    // 不可視チップ: 通過したら無音で消費
    for (let i = 0; i < this.hiddenNotes.length; i++) {
      if (this.hiddenJudged[i]) continue;
      if (this.hiddenNotes[i].timeMs < songMs) this.hiddenJudged[i] = true;
      else break;
    }
    if (this.auto) {
      for (let i = 0; i < this.notes.length; i++) {
        if (this.judged[i]) continue;
        if (songMs < this.notes[i].timeMs) break;
        this._judgeNote(i, JUDGE.PERFECT, 0, perfNow, { auto: true });
      }
      return;
    }
    // レーン別 AUTO
    for (let i = 0; i < this.notes.length; i++) {
      if (this.judged[i]) continue;
      if (songMs < this.notes[i].timeMs) break;
      if (this.laneAuto[this.notes[i].lane]) this._autoJudgeNote(i, perfNow);
    }
    // ミス検出
    const inputMs = songMs + this._w(this.judgeOffsetMs);
    for (let i = 0; i < this.notes.length; i++) {
      if (this.judged[i]) continue;
      const n = this.notes[i];
      const lagChart = inputMs - n.timeMs;
      if (lagChart > this._w(this.rangesFor(n.channel).searchWindowMs)) {
        this._judgeNote(i, JUDGE.MISS, lagChart / this.ratio, perfNow, { miss: true });
      } else if (n.timeMs > inputMs) {
        break;
      }
    }
  }

  /**
   * パッド入力(キーボード/タッチ)。
   * @param {number} pad レーン番号
   * @param {number} perfTimeStamp event.timeStamp(performance.now 時間軸)
   */
  hit(pad, perfTimeStamp, opts = {}) {
    if (!this.chart) return;
    const perfNow = performance.now();
    if (this.state === PLAYER_STATE.PAUSED) return;
    // タッチの CY 列は RD チップも拾う(RD は CY 列に描かれるため)
    const groups = opts.touch && pad === 8 ? { ...this.groups, cyGroup: 1 } : this.groups;
    if (this.isStandby) {
      this._warmUpHit(pad, perfNow, groups);
      return;
    }
    if (this.auto) return; // 全レーン AUTO 中はパッドは何もしない
    const realIn = this.realFromPerf(perfTimeStamp);
    const songIn = this.songAt(Math.min(realIn, this.nowReal()));
    // 打鍵は押した時刻で判定するので、その時刻までのフレームの処理(自動発音の予約 → 不可視チップの消化 →
    // レーン別 AUTO → MISS)を先に済ませて時刻の順を保つ。元実装はパッドもフレーム時刻で読み、フレーム内は
    // 「不可視 → AUTO → パッド → ミス」(docs/spec/judge-score.md §2)なので、フレームが十分短ければ同じ順になる。
    // これが無いと、次のフレームより前の打鍵が未消化の不可視チップに吸われたり、コンボが MISS より先に数えられたり
    // して、判定と成績がフレームの刻み(画面の Hz・処理落ち)で変わる。予約を判定より先にするのは update と同じ順に
    // するため(長いフレームの空白の後で、過ぎた AUTO チップの音が予約を経ずに頭からまとめて鳴らないように)。
    // ループの終端より後ろは折り返しのフレームに任せる(終端までは済ませる)
    const settleMs = this.loopEndMs === -1 ? songIn : Math.min(songIn, this.loopEndMs);
    this.scheduleAutoSounds(settleMs, realIn);
    this.processJudgement(settleMs, realIn, perfNow);
    const inputMs = songIn + this._w(this.judgeOffsetMs);
    const lanes = searchLanes(pad, groups);
    const lbdOnlyLane = pad === 5 && groups.bdGroup === 1 ? 2 : -1;
    let best = -1;
    let bestAbs = 0;
    let bestHidden = -1;
    let bestHiddenAbs = 0;
    for (const lane of lanes) {
      const filter = lane === lbdOnlyLane ? LEFT_BASS_DRUM_CHANNEL : 0;
      const r = this._findNearest(this.notes, this.judged, lane, inputMs, filter, false);
      const h = this._findNearest(this.hiddenNotes, this.hiddenJudged, lane, inputMs, filter, true);
      if (h.index >= 0 && (r.index < 0 || h.abs < r.abs)) {
        if (bestHidden < 0 || this.hiddenNotes[h.index].timeMs < this.hiddenNotes[bestHidden].timeMs) {
          bestHidden = h.index;
          bestHiddenAbs = h.abs;
        }
        continue;
      }
      if (r.index < 0) continue;
      if (best < 0 || this.notes[r.index].timeMs < this.notes[best].timeMs) {
        best = r.index;
        bestAbs = r.abs;
      }
    }
    if (bestHidden >= 0 && (best < 0 || this.hiddenNotes[bestHidden].timeMs < this.notes[best].timeMs)) {
      this._hitHidden(bestHidden, bestHiddenAbs, perfNow);
      return;
    }
    if (best >= 0) {
      const hitNote = this.notes[best];
      const hitTime = hitNote.timeMs;
      const lagMs = (inputMs - hitTime) / this.ratio;
      this._judgeNote(best, this.rangesFor(hitNote.channel).judge(bestAbs / this.ratio), lagMs, perfNow, {});
      if (tieHitsAll(pad)) {
        for (const lane of lanes) {
          if (lane === hitNote.lane) continue;
          const filter = lane === lbdOnlyLane ? LEFT_BASS_DRUM_CHANNEL : 0;
          const r = this._findNearest(this.notes, this.judged, lane, inputMs, filter, false);
          if (r.index >= 0 && this.notes[r.index].timeMs === hitTime) {
            this._judgeNote(r.index, this.rangesFor(this.notes[r.index].channel).judge(r.abs / this.ratio), lagMs, perfNow, {});
          }
          const h = this._findNearest(this.hiddenNotes, this.hiddenJudged, lane, inputMs, filter, true);
          if (h.index >= 0 && this.hiddenNotes[h.index].timeMs === hitTime) this._hitHidden(h.index, h.abs, perfNow);
        }
      }
      return;
    }
    // 空打ち: パッドのレーンを光らせ、いちばん近いチップの音(無ければ合成音)
    this._laneEffects(pad, perfNow);
    const borrow = this._findNearestAny(pad, lanes, inputMs);
    if (borrow) this.playChipSound(borrow, this.config.chipVolume);
    else this.audio.playBuffer(this.audio.synthBuffer(pad), { volume: this.config.chipVolume, rate: this.ratio, key: 'synth' + pad, bus: 'chip' });
  }

  /** 待機中の打鍵: 音と演出だけ(判定・成績には触れない)。 */
  _warmUpHit(pad, perfNow, groups = this.groups) {
    this._laneEffects(pad, perfNow);
    const lanes = searchLanes(pad, groups);
    const borrow = this._findNearestAny(pad, lanes, this._pinnedSong);
    if (borrow) this.playChipSound(borrow, this.config.chipVolume);
    else this.audio.playBuffer(this.audio.synthBuffer(pad), { volume: this.config.chipVolume, rate: this.ratio, key: 'synth' + pad, bus: 'chip' });
  }

  /**
   * レーン内でいちばん近い未判定チップ(判定窓内)。同じ |dt| なら早い方。
   * @returns {{index:number, abs:number}}
   */
  _findNearest(list, judgedFlags, lane, inputMs, filter, hidden) {
    let best = -1;
    let bestAbs = Infinity;
    const globalWin = this._w(hidden ? HitRanges.default.searchWindowMs : this.searchWindowMs);
    for (let i = 0; i < list.length; i++) {
      if (judgedFlags[i]) continue;
      const n = list[i];
      if (n.lane !== lane) continue;
      if (filter && n.channel !== filter) continue;
      const dt = n.timeMs - inputMs;
      if (dt > globalWin) break;
      const abs = Math.abs(dt);
      const win = this._w(hidden ? HitRanges.default.searchWindowMs : this.rangesFor(n.channel).searchWindowMs);
      if (abs <= win && abs < bestAbs) {
        best = i;
        bestAbs = abs;
      }
    }
    return { index: best, abs: bestAbs };
  }

  /** 空打ち音の候補: 自レーン優先で、判定済みかどうかを問わず距離無制限にいちばん近いチップ(同距離なら可視)。 */
  _findNearestAny(pad, lanes, timeMs) {
    const order = [pad, ...lanes.filter((l) => l !== pad)];
    for (const lane of order) {
      let best = null;
      let bestAbs = Infinity;
      const scan = (list) => {
        for (const n of list) {
          if (n.lane !== lane) continue;
          const abs = Math.abs(n.timeMs - timeMs);
          if (abs < bestAbs) {
            best = n;
            bestAbs = abs;
          } else if (n.timeMs > timeMs) {
            break;
          }
        }
      };
      scan(this.notes);
      scan(this.hiddenNotes);
      if (best) return best;
    }
    return null;
  }

  _laneEffects(lane, perfNow) {
    this.laneFlashUntil[lane] = perfNow + 120;
    this.padHitAt[lane] = perfNow;
  }

  _startJudgeString(lane, judge, lagMs, auto, perfNow) {
    const js = this.judgeStr[lane];
    js.at = perfNow;
    js.judge = judge;
    js.lagMs = lagMs;
    js.auto = auto;
  }

  /** 手動/ミス/全 AUTO の判定確定(Judge)。 */
  _judgeNote(i, j, lagMs, perfNow, opts) {
    const n = this.notes[i];
    this.judged[i] = true;
    this.stats.judge(j, n, lagMs, { auto: !!opts.auto });
    this.judgeDisplayUntil = perfNow + 500;
    this._startJudgeString(n.lane, j, lagMs, !!opts.auto, perfNow);
    if (j !== JUDGE.MISS) {
      this._laneEffects(n.lane, perfNow);
      if (!n.soundScheduled) {
        n.soundScheduled = true;
        this.playChipSound(n, this.config.chipVolume);
      }
      if (j !== JUDGE.OK) this.fireAt[n.lane] = perfNow;
    }
    if (j === JUDGE.PERFECT || j === JUDGE.GREAT || j === JUDGE.GOOD) this.comboJumpAt = perfNow;
  }

  /** レーン別 AUTO の判定(AutoJudge)。 */
  _autoJudgeNote(i, perfNow) {
    const n = this.notes[i];
    this.judged[i] = true;
    this.stats.autoJudge(n, { allLanesAuto: this.allLanesAuto, autoAddGage: this.config.autoAddGage });
    this._startJudgeString(n.lane, JUDGE.PERFECT, 0, true, perfNow);
    this._laneEffects(n.lane, perfNow);
    if (!n.soundScheduled) {
      n.soundScheduled = true;
      this.playChipSound(n, this.config.autoChipVolume);
    }
    this.fireAt[n.lane] = perfNow;
    if (this.allLanesAuto) this.comboJumpAt = perfNow;
  }

  /** 不可視チップのヒット(HitHiddenNote): 音と演出のみ。 */
  _hitHidden(i, abs, perfNow) {
    const n = this.hiddenNotes[i];
    this.hiddenJudged[i] = true;
    this._laneEffects(n.lane, perfNow);
    this.playChipSound(n, this.config.chipVolume);
    if (HitRanges.default.judge(abs / this.ratio) !== JUDGE.OK) this.fireAt[n.lane] = perfNow;
  }

  dispose() {
    this._stopChartVoices();
    this.chart = null;
    this.audio.stopAll();
  }
}

/** timeMs < target となるイベント数(先頭から。時刻順が前提)。 */
function countBefore(list, target) {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].timeMs < target) n++;
    else break;
  }
  return n;
}
