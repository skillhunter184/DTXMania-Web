// ギター / ベースの演奏コントローラ(NX CStagePerfCommonScreen のギター / ベース部分と DTXManiaAI GuitarPerformanceStage を、
// ドラムの Player のトレーニングの仕組み(時計・待機 / 開始待ち / 演奏 / 一時停止・ループ・シーク・演奏速度)に載せたもの)。
// 仕様は docs/spec/guitar-bass.md。弾くのは 1 パート(ギターかベース)だけで、もう一方のパートとドラムは伴奏として音だけ鳴らす
// (NX はギターとベースを 1 画面に並べて 2 人で弾く。本アプリは 1 人の練習なので 1 パートにした)。
//
// 入力: ネックの R G B Y P は押している間の状態(fret)、ピックとウェイリングは押した瞬間(pick / wail)。
// 押さえ方はピックの瞬間の状態で照合する(NX はフレームごとに読み、同じフレームの押さえ方を使う)。
// (変更) キーボードでピックとボタンをほぼ同時に押したときに取りこぼさないよう、押さえ方が合わないピックは
// PICK_SETTLE_MS だけ待ち、その間にボタンが合えばピックの時刻で判定する(NX は 60 fps なら同じフレームの
// 16.7 ms 以内の押下を拾う。本アプリは打鍵ごとに時刻を持つので、その代わりの猶予)。

import { Player, PLAYER_STATE, SCROLL_BASE_PX_PER_MS, buildAccompaniment } from './player.js';
import { AudioEngine } from '../core/audio.js';
import { gbPart, INSTRUMENT, GB_LANE_BITS, GB_LANE_COUNT, GB_BITS_MASK } from '../core/dtx.js';
import { HitRanges, JUDGE } from './hitranges.js';
import { GB_AUTO_COUNT, GB_AUTO_PICK, GB_AUTO_WAIL } from './training.js';
import {
  GbStats, findPickTarget, fretsMatch, autoPickHits, isAutoChip, allGbAuto, gbAutoMask, gbScoreRevise,
  gbAchievementRevise, WAIL_RESERVE_MS, WAIL_ACCEPT_MS, LN_TICK_MAX,
} from './gbjudge.js';

/**
 * ハイスピード x1.0 の速さ(1080p の px/ms)。NX CChip.ComputeDistanceFromBar はギター / ベースの式にドラムより
 * 0.5 が 1 つ多い(ScrollSpeedGuitar = (raw + 1) × 0.5 × 0.5 × 37.5 × 286 / 60000)ので、ドラムの半分。
 */
export const GB_SCROLL_BASE_PX_PER_MS = SCROLL_BASE_PX_PER_MS * 0.5;

/** 押さえ方が合わないピックを待つ時間(ms。上の注記。タッチは指が 2 本揃うまでを和音として待つので長め)。 */
export const PICK_SETTLE_MS = { key: 30, touch: 50 };

/** ネックのボタンのビットの全部(R G B Y P)。自動演奏では押さえ方を見ない。 */
const ALL_FRETS = GB_BITS_MASK;

export class GuitarPlayer extends Player {
  /**
   * @param {{audio: AudioEngine, settings: import('./training.js').TrainingSettings, config: object, inst: number}} deps
   *   inst は INSTRUMENT.GUITAR / BASS。config は Player の項目に加えて
   *   { gbHitRanges, light(空ピックを BAD にしない。NX 既定 ON) }。
   */
  constructor({ audio, settings, config = {}, inst }) {
    super({ audio, settings, config: Object.assign({ gbHitRanges: HitRanges.default, light: true }, config) });
    this.inst = inst;
    this.gb = null; // 弾くパートの譜面(chart.guitar / chart.bass)
    this.wailing = [];
    this.wailDone = []; // 予約できなくなった(成立した、または通過から 1 秒過ぎた)
    this.wailHit = []; // 成立した(画面から消す。通過したまま成立しなかったチップは流れて見えなくなるまで描く。NX)
    this.wailQueue = []; // ウェイリングの予約(wailing の添字)

    // 設定の反映値(applySettings)
    this.gbAuto = new Array(GB_AUTO_COUNT).fill(false);
    this.autoMask = 0; // AUTO のネックのボタンのビット
    this.autoPick = false;
    this.autoWail = false;
    this.allAuto = false; // ネックとピックが全部 AUTO(ウェイリングは見ない)
    this.scoreRev = 1; // スコアの AUTO 補正
    this.achievementRevise = 1; // 達成率の AUTO 補正
    this.reverse = false;
    this.left = false; // LEFT(描く列の左右反転。判定には関わらない)

    // 入力の状態
    this.fretHeld = new Array(GB_LANE_COUNT).fill(false);
    this._liveFrets = new Array(GB_LANE_COUNT).fill(false); // 実際に押しているボタン(リプレイ中は fretHeld が記録のボタンになる)
    this.pendingPick = null; // 押さえ方を待っているピック {perfTs, inputMs, target, deadline, touch}
    this._pendingTimer = 0;
    this._lastTouchPick = -1e9;
    this.holdIndex = -1; // 押さえ続けているロングノート(notes の添字)
    this.holdSegment = 0; // その加点の回数
    this.lastVoice = null; // 直前に鳴らしたこのパートの音(次の音で止める。NX tPlaySound)
    this._noteVoice = []; // チップの添字 → そのチップの音(押さえ続けたロングノートを離したときに、その音だけを止める)
    this._noChipIndex = 0;
    this.noChipWavId = ''; // 今の空ピック音(0xBA / 0xBB の通過したもの)
    this._wailSoundIndex = 0;
    this.wailSoundWavId = ''; // 今のウェイリング音(0x2F の通過したもの。ギターだけ)

    // 演出(performance.now の ms)
    this.fretAt = new Array(GB_LANE_COUNT).fill(-1e9); // ボタンを押した時刻
    this.fretUpAt = new Array(GB_LANE_COUNT).fill(-1e9); // ボタンを離した時刻(レーンフラッシュが 70 ms で消える)
    this.fireAt = new Array(GB_LANE_COUNT).fill(-1e9); // チップファイア
    this.pickAt = -1e9;
    this.gbJudge = { at: -1e9, judge: -1, lagMs: 0, auto: false, bad: false };
    this.wailAt = -1e9; // ウェイリング成立
    this.lnTickAt = -1e9; // ロングノートの加点
  }

  // ---- 読み込み ----

  _prepareChart(chart) {
    this.gb = gbPart(chart, this.inst);
    this.notes = this.gb.notes;
    this.hiddenNotes = [];
    this.judged = new Array(this.notes.length).fill(false);
    this.hiddenJudged = [];
    this.wailing = this.gb.wailing;
    this.wailDone = new Array(this.wailing.length).fill(false);
    this.wailHit = new Array(this.wailing.length).fill(false);
    this._noteVoice = new Array(this.notes.length).fill(null);
    this.stats = new GbStats(this.notes.length);
    this.stats.damageLevel = this.config.damageLevel;
    this.searchWindowMs = this.config.gbHitRanges.okMs; // ピックで探すのは Poor の窓の中(NX)
    this.accomp = buildAccompaniment(chart, this.inst);
  }

  _afterSoundsLoaded() {} // 音源の無いチップは鳴らさない(ドラムの合成音は使わない)

  /** 判定タイミング調整はドラムと別(NX InputAdjustTimeGuitar / Bass。ギターとベースは 1 つを共有)。 */
  get judgeOffsetSetting() {
    return this.settings.gbJudgeOffsetMs;
  }

  get hiSpeedSetting() {
    return this.settings.gbHiSpeedRatio;
  }

  get scrollBasePxPerMs() {
    return GB_SCROLL_BASE_PX_PER_MS;
  }

  /** 押さえているネックのボタンのビット。 */
  get heldBits() {
    let b = 0;
    for (let i = 0; i < GB_LANE_COUNT; i++) if (this.fretHeld[i]) b |= GB_LANE_BITS[i];
    return b;
  }

  /** 照合で見ないボタン(自動演奏なら全部、それ以外は AUTO のボタン)。 */
  get _matchMask() {
    return this.auto ? ALL_FRETS : this.autoMask;
  }

  applySettings() {
    super.applySettings();
    const s = this.settings;
    for (let i = 0; i < GB_AUTO_COUNT; i++) this.gbAuto[i] = !!s.gbAutoLanes[i];
    this._deriveGbAuto();
    this.reverse = !!s.gbReverse;
    this.left = !!s.gbLeft;
  }

  /** ボタン別 AUTO(gbAuto)から決まる値。 */
  _deriveGbAuto() {
    this.autoMask = gbAutoMask(this.gbAuto);
    this.autoPick = this.gbAuto[GB_AUTO_PICK];
    this.autoWail = this.gbAuto[GB_AUTO_WAIL];
    this.allAuto = allGbAuto(this.gbAuto);
    this.scoreRev = gbScoreRevise(this.gbAuto, this.config.autoAddGage);
    this.achievementRevise = gbAchievementRevise(this.gbAuto);
  }

  // ---- 位置 ----

  /** 曲内ジャンプ。ギター / ベースの状態(ウェイリング・ロングノート・待っているピック)も位置に合わせる(NX tJumpInSong)。 */
  jumpTo(targetMs, resyncAudio) {
    this._cancelPendingPick();
    super.jumpTo(targetMs, resyncAudio);
    const target = Math.max(0, targetMs);
    for (let i = 0; i < this.wailing.length; i++) this.wailDone[i] = this.wailHit[i] = this.wailing[i].timeMs < target;
    this._noteVoice.fill(null);
    this.wailQueue = [];
    this.holdIndex = -1;
    this.holdSegment = 0;
    this.lastVoice = null;
    if (this.stats) this.stats.lnBonus = 0;
    // 空ピック音・ウェイリング音の切り替えは target までに通過した最後のもの
    this._noChipIndex = 0;
    this.noChipWavId = '';
    this._wailSoundIndex = 0;
    this.wailSoundWavId = '';
    this._latch(target);
  }

  /** 空ピック音・ウェイリング音の切り替えチップのうち、songMs までに通過したものを今の音にする(NX は通過で切り替える)。 */
  _latch(songMs) {
    const nc = this.gb ? this.gb.noChipEvents : [];
    while (this._noChipIndex < nc.length && nc[this._noChipIndex].timeMs <= songMs) this.noChipWavId = nc[this._noChipIndex++].wavId;
    // ウェイリング音の切り替え(0x2F)はギターだけ(NX はベースのウェイリング音を設定しない)
    const ws = this.chart && this.inst === INSTRUMENT.GUITAR ? this.chart.wailSoundEvents || [] : [];
    while (this._wailSoundIndex < ws.length && ws[this._wailSoundIndex].timeMs <= songMs) this.wailSoundWavId = ws[this._wailSoundIndex++].wavId;
  }

  // ---- 音 ----

  /**
   * このパートの音を鳴らす。前の音は止める(NX tPlaySound のギター / ベース: 1 パート 1 音)。when を渡すとその時刻に
   * 予約し、前の音もその時刻で止める。#WAV の無い音は鳴らさないが、前の音は止める(NX は止めてから鳴らそうとする)。
   */
  _playPart(wavId, vol, when, noteIndex = -1) {
    this._recordSound({ wavId, vol, noteIndex }, when); // 鳴らせない音も記録する(前の音を止めるので)
    if (this.lastVoice) this.audio.stopVoice(this.lastVoice, when);
    this.lastVoice = null;
    if (!wavId || !this.audio.hasBuffer(wavId)) return null;
    const { volume, pan } = AudioEngine.gainPan(this.chart, wavId);
    const v = this.audio.play(wavId, { when, volume: volume * vol, pan, rate: this.ratio, bus: 'chip' });
    if (v) {
      this.lastVoice = v;
      this._trackVoice(v);
      if (noteIndex >= 0) this._noteVoice[noteIndex] = v;
    }
    return v;
  }

  /**
   * AUTO ピックのチップの音は判定より先に予約する(成否に関わらず鳴る。NX は強制 Miss でもチップの音を鳴らす)。
   * 自動演奏はドラムの自動演奏と同じく手動の音量、AUTO ピックは AUTO の音量(NX のモニタ音量)。
   */
  _scheduleNoteSounds(limit) {
    while (this._autoSoundIndex < this.notes.length && this.notes[this._autoSoundIndex].timeMs <= limit) {
      const i = this._autoSoundIndex++;
      const n = this.notes[i];
      if (this.judged[i] || n.soundScheduled) continue;
      if (!this.auto && !this.autoPick) continue;
      n.soundScheduled = true;
      this._playPart(n.wavId, this.auto ? this.config.chipVolume : this.config.autoChipVolume, this.ctxTimeAt(n.timeMs), i);
    }
  }

  /** 空ピックの音: 今の空ピック音、無ければいちばん近いチップの音(判定済みかどうか・距離を問わない。同じ距離なら前のチップ)。 */
  _playEmptyPick(songMs) {
    let id = this.noChipWavId;
    if (!id) {
      let best = null;
      let bestAbs = Infinity;
      for (const n of this.notes) {
        const abs = Math.abs(n.timeMs - songMs);
        if (abs < bestAbs) {
          best = n;
          bestAbs = abs;
        } else if (n.timeMs > songMs) {
          break;
        }
      }
      if (best) id = best.wavId;
    }
    this._playPart(id, this.config.chipVolume);
  }

  // ---- 毎フレームの判定 ----

  /**
   * 毎フレームの処理(NX の順: チップの列の処理(取り逃しの Miss・AUTO ピック・ウェイリングチップ)→ 入力(ロングノート))。
   * 打鍵の時刻までのフレームの処理を先に済ませるときにも呼ぶ(pick / wail。ドラムの hit と同じ)。
   */
  processJudgement(songMs, realNow, perfNow) {
    if (this.pendingPick && perfNow >= this.pendingPick.deadline) this._resolvePendingPick(perfNow);
    this._latch(songMs);
    if (this.auto || this.autoPick) {
      for (let i = 0; i < this.notes.length; i++) {
        if (this.judged[i]) continue;
        if (songMs < this.notes[i].timeMs) break;
        this._autoPickHit(i, perfNow);
      }
    } else {
      // 取り逃し: 判定時刻 + 調整 − チップの時刻 が Poor の窓を過ぎた未判定チップ
      const inputMs = songMs + this._w(this.judgeOffsetMs);
      const win = this._w(this.config.gbHitRanges.okMs);
      // 押さえ方を待っているピックの狙うチップは、その決着まで取り逃しにしない(窓の終わり際のピックが待っている間に消えないように)
      const waiting = this.pendingPick ? this.pendingPick.target : -1;
      for (let i = 0; i < this.notes.length; i++) {
        if (this.judged[i] || i === waiting) continue;
        const n = this.notes[i];
        const lagChart = inputMs - n.timeMs;
        if (lagChart > win) this._judgeChip(i, JUDGE.MISS, lagChart / this.ratio, perfNow, { auto: false });
        else if (n.timeMs > inputMs) break;
      }
    }
    // ウェイリング: AUTO なら予約をそのまま成立させる(加点なし)。通過から 1 秒過ぎたウェイリングチップは予約できなくする
    // (DTXManiaAI と同じ。成立していないチップは画面では流れ去るまで描く: wailHit)
    if ((this.auto || this.autoWail) && this.wailQueue.length) this._doWailing(songMs, perfNow, true);
    const accept = this._w(WAIL_ACCEPT_MS);
    for (let i = 0; i < this.wailing.length; i++) {
      if (this.wailDone[i]) continue;
      if (songMs <= this.wailing[i].timeMs + accept) break;
      this.wailDone[i] = true;
    }
    this._updateHold(songMs, perfNow);
  }

  /**
   * ロングノートを押さえ続けているか(NX 5354-5418)。押さえ方が合っていればファイアを続け、長さの 1/6 ごとに加点(5 回まで)。
   * 合っていなくても終端の Poor の窓の中なら待つ。窓の外で離したら保持を解いて音を止める
   * ((変更) NX は止める音の番号を取り違えていて音が止まらない。DTXManiaAI と同じく止める)。終端を過ぎたら正常に解く。
   */
  _updateHold(songMs, perfNow) {
    if (this.holdIndex < 0) return;
    const n = this.notes[this.holdIndex];
    if (songMs >= n.lnEndMs) {
      this.holdIndex = -1;
      return;
    }
    const held = this.heldBits;
    if (fretsMatch(n.bits, held, this._matchMask)) {
      this._fire(this._fireBits(n.bits, held, false), perfNow);
      if (this.holdSegment < LN_TICK_MAX) {
        const nextAt = n.timeMs + Math.floor(((this.holdSegment + 1) * (n.lnEndMs - n.timeMs)) / 6);
        if (songMs >= nextAt) {
          const ev = { kind: 'tick', rev: this.auto ? 1 : this.scoreRev };
          this._record(ev);
          this._applyTick(ev, perfNow);
        }
      }
      return;
    }
    const lag = (songMs + this._w(this.judgeOffsetMs) - n.lnEndMs) / this.ratio;
    if (HitRanges.default.judge(Math.abs(lag)) >= JUDGE.MISS) {
      this._record({ kind: 'release' });
      this._applyRelease(true);
    }
  }

  _applyTick(ev, perfNow) {
    this.stats.lnTick(ev.rev);
    this.holdSegment++;
    this.lnTickAt = perfNow;
  }

  /** ロングノートを途中で離した: 保持を解いて、このロングノートの音だけを止める(先読みで予約した次のチップの音を巻き込まない)。 */
  _applyRelease(stopSound) {
    const v = this.holdIndex >= 0 ? this._noteVoice[this.holdIndex] : null;
    this.holdIndex = -1;
    if (v && stopSound) {
      this.audio.stopVoice(v);
      if (this.lastVoice === v) this.lastVoice = null;
    }
  }

  /** チップの構成ボタンのうち、AUTO か押さえているボタン(OPEN の成功は全ボタン)のビット。ファイアを出すレーン。 */
  _fireBits(bits, held, open) {
    if (open) return ALL_FRETS;
    return bits & (this._matchMask | held);
  }

  /** ビットのレーンにファイアを出す。 */
  _fire(bits, perfNow) {
    for (let i = 0; i < GB_LANE_COUNT; i++) if (bits & GB_LANE_BITS[i]) this.fireAt[i] = perfNow;
  }

  /** AUTO ピック(と自動演奏)でバーを通過したチップ(NX 4297-4418)。 */
  _autoPickHit(i, perfNow) {
    const n = this.notes[i];
    const held = this.heldBits;
    const demo = this.auto;
    const hit = demo || autoPickHits(n.bits, held, this.gbAuto);
    const chipAuto = demo || isAutoChip(n, this.gbAuto);
    const fire = this._fireBits(n.bits, held, n.open && hit);
    let j = JUDGE.MISS;
    let lagMs = 0;
    if (hit) {
      // AUTO でないチップ(手動のボタンを含む)は判定タイミング調整のぶんずれた判定になる(NX: lag = 調整値)
      lagMs = chipAuto ? 0 : this.judgeOffsetMs;
      j = chipAuto ? JUDGE.PERFECT : this.config.gbHitRanges.judge(Math.abs(lagMs));
    }
    this._judgeChip(i, j, lagMs, perfNow, { auto: chipAuto, demo, fire });
    if (!n.soundScheduled) {
      n.soundScheduled = true;
      this._playPart(n.wavId, demo ? this.config.chipVolume : this.config.autoChipVolume, undefined, i);
    }
    if (hit) this._reserveWailing(n.timeMs + this._w(chipAuto ? 0 : this.judgeOffsetMs));
  }

  /**
   * チップ 1 個の判定の確定(NX tProcessChipHit のギター / ベース)。ロングノートの始端なら保持を始め、Miss はどのチップでも
   * 保持を解く。opts.auto は AUTO チップ、opts.demo は自動演奏(js/game/gbjudge.js GbStats.judge)、opts.fire はファイアを
   * 出すレーンのビット。成績と演出は _applyChip に分け、リプレイは記録からそれだけを当て直す。
   */
  _judgeChip(i, j, lagMs, perfNow, opts) {
    const ev = {
      kind: 'judge', i, judge: j, lagMs, auto: !!opts.auto, demo: !!opts.demo,
      rev: this.scoreRev, addGage: !!this.config.autoAddGage, fire: opts.fire || 0,
    };
    this._record(ev);
    this._applyChip(ev, perfNow);
  }

  _applyChip(ev, perfNow) {
    const j = ev.judge;
    const n = this.notes[ev.i];
    this.judged[ev.i] = true;
    if (n.lnEndMs >= 0 && j !== JUDGE.MISS) {
      this.holdIndex = ev.i;
      this.holdSegment = 0;
    }
    this.stats.judge(j, { auto: ev.auto, demo: ev.demo, lagMs: ev.lagMs, rev: ev.rev, autoAddGage: ev.addGage });
    if (j === JUDGE.MISS) this.holdIndex = -1;
    this.judgeDisplayUntil = perfNow + 500;
    const g = this.gbJudge;
    g.at = perfNow;
    g.judge = j;
    g.lagMs = ev.lagMs;
    g.auto = ev.auto || ev.demo;
    g.bad = false;
    this._fire(ev.fire, perfNow);
    if (j === JUDGE.PERFECT || j === JUDGE.GREAT || j === JUDGE.GOOD) this.comboJumpAt = perfNow;
  }

  /** Light OFF の空ピック(BAD)。 */
  _applyBad(perfNow) {
    this.stats.bad();
    const g = this.gbJudge;
    g.at = perfNow;
    g.judge = JUDGE.MISS;
    g.lagMs = 0;
    g.auto = false;
    g.bad = true;
  }

  // ---- 入力 ----

  /** 電子ドラム(MIDI)の打鍵はギター / ベースでは使わない。 */
  hit() {}

  /**
   * ネックのボタンの押下状態(js/ui/gbinput.js から、変わったときだけ)。待っているピックがあれば押さえ方を照合し直す。
   * @param {number} lane 0..4(R G B Y P)
   * @param {number} [perfTimeStamp] event.timeStamp。待っているピックの締め切りより後の押下は、そのピックに数えない
   *   (重いフレームで入力がまとめて届いても、締め切りで決着させてから押さえ方を変える。判定がフレームの刻みで変わらないように)
   */
  fret(lane, down, perfTimeStamp) {
    if (lane < 0 || lane >= GB_LANE_COUNT) return;
    this._liveFrets[lane] = !!down;
    if (this.replay) return; // リプレイ中は記録したボタンを見せる(押している状態だけ覚えておき、止めたら戻す)
    const perfNow = performance.now();
    // 記録の時刻は押した時刻(一時停止中は止めた位置。押さえ方は再開後も続くので記録する)
    if (this._take) this._evMs = this.songAt(Number.isFinite(perfTimeStamp) ? Math.min(this.realFromPerf(perfTimeStamp), this.nowReal()) : this.nowReal());
    const p = this.pendingPick;
    if (p && Number.isFinite(perfTimeStamp) && perfTimeStamp > p.deadline) this._resolvePendingPick(perfNow);
    this._record({ kind: 'fret', lane, down: !!down });
    this._applyFret(lane, !!down, perfNow);
    const q = this.pendingPick;
    if (!q || this.state !== PLAYER_STATE.PLAYING) return;
    // 離して合うこともある(和音から単音へ移るときに、余分なボタンをピックの直後に離した)。ただしタッチは、レーンを押す = 押さえて
    // 弾く なので、待っている間に置いた指を足していくだけで、離した指は引かない(違うレーンを素早く叩いて OPEN が当たってしまう)
    if (q.touch) {
      if (!down) return;
      q.touchBits |= GB_LANE_BITS[lane];
    }
    if (this._tryPick(q, perfNow)) this._cancelPendingPick();
  }

  _applyFret(lane, down, perfNow) {
    this.fretHeld[lane] = down;
    if (down) this.fretAt[lane] = perfNow;
    else this.fretUpAt[lane] = perfNow;
  }

  /**
   * ピック(押した瞬間)。待機中は音と演出だけ。自動演奏・AUTO ピックの間は使わない((変更) NX は AUTO ピックでも手動のピックを
   * 受け付けて早いピックで先に当たることがあるが、DTXManiaAI と同じく無視する。ボタンだけを練習するための設定なので)。
   * @param {number} perfTimeStamp event.timeStamp
   * @param {{touch?: boolean}} [opts] タッチ(和音の指が揃うまで長めに待つ。続けて押した指は同じピックにまとめる)
   */
  pick(perfTimeStamp, opts = {}) {
    if (!this.chart || this.state === PLAYER_STATE.PAUSED || this.replay) return;
    const perfNow = performance.now();
    const touch = !!opts.touch;
    if (touch) {
      // 和音: 最初の指のピックから PICK_SETTLE_MS.touch 以内に置いた指は、押さえ方を足すだけ(ピックを増やさない)。
      // 窓は最初の指から数える(待っているピックの締め切りと同じ。後の指から数え直すと、締め切りの後の指が宙に浮く)
      if (perfTimeStamp - this._lastTouchPick <= PICK_SETTLE_MS.touch) return;
      this._lastTouchPick = perfTimeStamp;
    }
    this.pickAt = perfNow;
    if (this.isStandby) {
      this._playEmptyPick(this._pinnedSong);
      return;
    }
    const realIn = this.realFromPerf(perfTimeStamp);
    const songIn = this.songAt(Math.min(realIn, this.nowReal()));
    this._evMs = songIn;
    this._record({ kind: 'pick' }); // ピックの絵を光らせる(AUTO ピックの間の手動のピックも光る)
    if (this.auto || this.autoPick) return;
    // 押した時刻までのフレームの処理を先に済ませる(ドラムの hit と同じ)。待っているピックはここで決着させる
    const settleMs = this.loopEndMs === -1 ? songIn : Math.min(songIn, this.loopEndMs);
    this._evMs = settleMs;
    this.scheduleAutoSounds(settleMs, realIn);
    this.processJudgement(settleMs, realIn, perfNow);
    if (this.pendingPick) this._resolvePendingPick(perfNow);
    this._evMs = songIn;
    const inputMs = songIn + this._w(this.judgeOffsetMs);
    const target = findPickTarget(this.notes, this.judged, inputMs, this._w(this.config.gbHitRanges.okMs));
    const p = {
      perfTs: perfTimeStamp, inputMs, songMs: songIn, target, deadline: perfTimeStamp + PICK_SETTLE_MS[touch ? 'touch' : 'key'], touch,
      touchBits: touch ? this.heldBits : 0, // タッチのピックの押さえ方(ピックの時点の押さえ方 + 待っている間に置いた指)
    };
    if (this._tryPick(p, perfNow)) return;
    this.pendingPick = p;
    clearTimeout(this._pendingTimer);
    this._pendingTimer = setTimeout(() => {
      if (this.pendingPick !== p) return;
      this._evMs = this.songMs;
      this._resolvePendingPick(performance.now());
    }, Math.max(0, p.deadline - perfNow) + 1);
  }

  /** 押さえ方が合えばヒットにする。合わなければ false(何もしない)。 */
  _tryPick(p, perfNow) {
    const i = p.target;
    if (i < 0 || this.judged[i]) return false;
    const n = this.notes[i];
    const held = p.touch ? p.touchBits : this.heldBits;
    if (!fretsMatch(n.bits, held, this._matchMask)) return false;
    const lagChart = p.inputMs - n.timeMs;
    const j = this.config.gbHitRanges.judge(Math.abs(lagChart) / this.ratio);
    if (j === JUDGE.MISS) return false;
    const successOpen = n.open && (held & ~this._matchMask & ALL_FRETS) === 0;
    const fire = this._fireBits(n.bits, held, successOpen);
    // ゴースト: ピックの時刻(判定に使った時刻)に、弾いた押さえ方(AUTO のボタンはチップのとおり)を判定の色で
    this._ghostPick(p.inputMs, held | (n.bits & this._matchMask), j);
    this._judgeChip(i, j, lagChart / this.ratio, perfNow, { auto: false, fire });
    n.soundScheduled = true;
    this._playPart(n.wavId, this.config.chipVolume, undefined, i);
    this._reserveWailing(p.inputMs);
    return true;
  }

  /** 待っていたピックを決着させる: 押さえ方が合わないまま時間切れなら空ピック(音。Light OFF なら BAD)。 */
  _resolvePendingPick(perfNow) {
    const p = this.pendingPick;
    if (!p) return;
    this._cancelPendingPick();
    if (!this.chart) return; // 終了した
    if (this._tryPick(p, perfNow)) return;
    this._ghostPick(p.inputMs, p.touch ? p.touchBits : this.heldBits, -1);
    this._playEmptyPick(p.songMs);
    if (!this.config.light) {
      this._record({ kind: 'bad' });
      this._applyBad(perfNow);
    }
  }

  /** ピックのゴースト(時刻・押さえていたボタンのビット(0 は OPEN)・判定。判定なしは -1)。 */
  _ghostPick(timeMs, bits, judge) {
    if (this._take) this._take.ghost({ timeMs, bits, judge });
  }

  _cancelPendingPick() {
    this.pendingPick = null;
    clearTimeout(this._pendingTimer);
    this._pendingTimer = 0;
  }

  /** ピックが当たったら、近くのウェイリングチップ(± 140 ms・過去優先・未消化)を予約する(NX 5484-5490)。 */
  _reserveWailing(inputMs) {
    const w = findPickTarget(this.wailing, this.wailDone, inputMs, this._w(WAIL_RESERVE_MS));
    // (変更) 同じチップを 2 度予約しない(NX は 2 回のピックで同じチップを 2 度積み、1 回のウェイリングで 2 度加点する)
    if (w >= 0 && this.wailQueue.indexOf(w) < 0) this.wailQueue.push(w);
  }

  /**
   * ウェイリング(押した瞬間)。予約したウェイリングチップのうち、チップの時刻から 1 秒以内のものを成立させて加点する
   * (NX DoWailingFromQueue。加点は今のコンボで決まる。AUTO のウェイリングは成立させるだけで加点しない)。
   */
  wail(perfTimeStamp) {
    if (!this.chart || this.state === PLAYER_STATE.PAUSED || this.replay) return;
    const perfNow = performance.now();
    if (this.isStandby) {
      this.wailAt = perfNow;
      return;
    }
    const realIn = this.realFromPerf(perfTimeStamp);
    const songIn = this.songAt(Math.min(realIn, this.nowReal()));
    const settleMs = this.loopEndMs === -1 ? songIn : Math.min(songIn, this.loopEndMs);
    this._evMs = settleMs;
    this.processJudgement(settleMs, realIn, perfNow);
    this._evMs = songIn;
    this._doWailing(songIn, perfNow, this.auto || this.autoWail);
  }

  _doWailing(songMs, perfNow, autoWail) {
    const accept = this._w(WAIL_ACCEPT_MS);
    const queue = this.wailQueue;
    this.wailQueue = [];
    for (const idx of queue) {
      if (this.wailDone[idx]) continue;
      if (songMs - this.wailing[idx].timeMs > accept) continue;
      // ウェイリング音(0x2F の通過したもの。ギターだけ)。NX の既定スキンの歓声は持っていないので、無ければ鳴らさない
      const sound = this.wailSoundWavId && this.audio.hasBuffer(this.wailSoundWavId) ? this.wailSoundWavId : '';
      const ev = { kind: 'wail', i: idx, auto: autoWail, rev: this.scoreRev, sound };
      this._record(ev);
      this._applyWail(ev, perfNow, true);
    }
  }

  /** ウェイリングの成立(AUTO のウェイリングは加点しない)。withSound でウェイリング音も鳴らす。 */
  _applyWail(ev, perfNow, withSound) {
    this.wailDone[ev.i] = this.wailHit[ev.i] = true;
    this.wailAt = perfNow;
    if (!ev.auto) this.stats.wail(ev.rev);
    if (withSound && ev.sound) {
      const { volume, pan } = AudioEngine.gainPan(this.chart, ev.sound);
      this.audio.play(ev.sound, { volume: volume * this.config.autoChipVolume, pan, rate: this.ratio, bus: 'bgm' });
    }
  }

  /**
   * 曲を最後まで弾いたらフルコンボの加点(NX は演奏の終わりに足す)。この回(曲頭からの演奏で、ループの折り返しや
   * 一時停止中のシークで数え直していない)に全部のチップを判定したときだけ。
   */
  _onSongEnd() {
    if (this.stats.lapJudged < this.notes.length) return;
    const ev = { kind: 'fullCombo', allAuto: this.allAuto && !this.auto };
    this._record(ev);
    this.stats.fullComboBonus(ev.allAuto);
  }

  // ---- 記録とリプレイ(js/game/replay.js。Player の差し替え) ----

  _takeInit() {
    return { frets: this.fretHeld.slice() };
  }

  _autoFlags() {
    const f = super._autoFlags();
    f.gbAuto = this.gbAuto.slice();
    return f;
  }

  _useAutoFlags(f) {
    if (!f) return;
    super._useAutoFlags(f);
    for (let i = 0; i < GB_AUTO_COUNT; i++) this.gbAuto[i] = !!f.gbAuto[i];
    this._deriveGbAuto();
  }

  /** リプレイの始めの状態: テイクより前のウェイリングチップは済み、押さえているボタンはテイクを始めたときのもの。 */
  _replayInit(take) {
    for (let i = 0; i < this.wailing.length; i++) this.wailDone[i] = this.wailHit[i] = this.wailing[i].timeMs < take.startMs;
    this.wailQueue = [];
    this.holdIndex = -1;
    this.holdSegment = 0;
    const frets = take.init ? take.init.frets : null;
    for (let i = 0; i < GB_LANE_COUNT; i++) this.fretHeld[i] = !!(frets && frets[i]);
  }

  /**
   * リプレイの毎フレーム: 押さえ続けているロングノートのファイア(加点と離したことは記録の出来事で来る)。
   * 終端を過ぎたら保持を解く(演奏の _updateHold と同じ)。
   */
  _replayFrame(songMs, perfNow) {
    if (this.holdIndex < 0) return;
    const n = this.notes[this.holdIndex];
    if (songMs >= n.lnEndMs) {
      this.holdIndex = -1;
      return;
    }
    const held = this.heldBits;
    if (fretsMatch(n.bits, held, this._matchMask)) this._fire(this._fireBits(n.bits, held, false), perfNow);
  }

  /** リプレイを止めたら、押さえているボタンを実際のものに戻す。 */
  _afterReplay() {
    for (let i = 0; i < GB_LANE_COUNT; i++) this.fretHeld[i] = this._liveFrets[i];
  }

  _applyEvent(ev, perfNow, quiet) {
    switch (ev.kind) {
      case 'judge': this._applyChip(ev, perfNow); break;
      case 'bad': this._applyBad(perfNow); break;
      case 'wail': this._applyWail(ev, perfNow, !quiet); break;
      case 'tick': this._applyTick(ev, perfNow); break;
      case 'release': this._applyRelease(!quiet); break;
      case 'fullCombo': this.stats.fullComboBonus(ev.allAuto); break;
      case 'fret': this._applyFret(ev.lane, ev.down, perfNow); break;
      case 'pick': this.pickAt = perfNow; break;
      default: break;
    }
  }

  _replaySound(s, when) {
    this._playPart(s.wavId, s.vol, when, s.noteIndex); // パートの音として鳴らす(前の音を止める。覚えておくのも _playPart)
  }

  /** 達成率(%)。自動演奏はドラムと同じく補正しない。 */
  achievement() {
    return this.stats.achievement(this.auto ? 1 : this.achievementRevise);
  }

  dispose() {
    this._cancelPendingPick();
    super.dispose();
  }
}
