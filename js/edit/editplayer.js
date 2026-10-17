// 譜面の編集画面の再生(本アプリの追加)。DTXCreator は一時ファイルを書いて DTXViewer / DTXMania を起動するが
// (docs/spec/dtxcreator-ui.md §12)、本アプリは演奏の Player をそのまま使い、全部 AUTO で鳴らす。
//
// - トレーニングの設定(dojo.training)には触れない。自分だけの TrainingSettings を持つ(保存しない)
// - 始められる範囲はグリッドの終わりまで、止まるのは「譜面の終わり・最後のデータ小節・BGM の終わり」の遅い方の後ろ
//   (チップの無い・BGM だけの譜面でも止まる。演奏の曲末の判定はチップがあるときだけ)
// - リプレイは記録しない

import { Player } from '../game/player.js';
import { TrainingSettings } from '../game/training.js';

const TAIL_MS = 2000;

export class EditorPlayer extends Player {
  /**
   * @param {{audio: import('../core/audio.js').AudioEngine, config?: object}} deps
   */
  constructor({ audio, config = {} }) {
    const s = new TrainingSettings();
    s.autoPlay = true;
    s.startWaitMs = 0;
    s.loop = false;
    s.noteOffsetMs = 0;
    s.metronomeVolume = 0;
    s.playSpeed = 20;
    super({ audio, settings: s, config });
    this.startMaxMs = 0;
    this.stopAtMs = 0;
  }

  /** 編集画面の範囲(ms)。startMaxMs = 始められる上限、stopAtMs = これを過ぎて少ししたら止まる。 */
  setRange({ startMaxMs, stopAtMs }) {
    this.startMaxMs = Math.max(0, startMaxMs || 0);
    this.stopAtMs = Math.max(0, stopAtMs || 0);
  }

  get playableMaxMs() {
    return Math.max(super.playableMaxMs, this.startMaxMs);
  }

  get seekMaxMs() {
    return Math.max(super.seekMaxMs, this.startMaxMs);
  }

  _isSongEnd(songMs) {
    return this.loopEndMs === -1 && songMs > Math.max(this.stopAtMs, this.startMs) + TAIL_MS * this.ratio;
  }

  _beginTake() {
    this._take = null;
  }
}
