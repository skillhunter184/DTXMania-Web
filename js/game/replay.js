// 演奏の記録とリプレイ(元実装に無い追加)。
//
// 演奏の 1 回の通し(演奏開始から停止・曲末まで。ループ演奏では 1 周ごと、一時停止中にシークして成績を数え直したら
// そこで区切る)を「テイク」として譜面時刻で記録する。記録するのは
//   - 出来事(events): 判定の結果(どのチップをどの判定・ずれにしたか)と、成績・演出を動かすもの(ギター / ベースの
//     ボタン・ロングノートの加点・ウェイリングなど)。成績の計算に渡したものをそのまま、記録した順に持つ
//   - 音(sounds): 鳴らしたチップの音と、それが聞こえた譜面時刻
//   - ゴースト(ghosts): 実際に叩いた(ピックした)時刻と、当たった判定。時刻は判定に使った譜面時刻
//     (判定タイミング調整を足したもの)なので、チップとの距離が判定のずれの表示と一致する
// で、リプレイは判定をやり直さず、出来事を同じ順に当て直す(Player._applyEvent)。だから成績は記録したときと必ず同じに
// なり、演奏速度を変えて見直しても変わらない(判定窓は実時間の量なので、入力を流し直す作りでは速度で判定が変わる)。
// 記録は演奏画面を離れるまでメモリにだけ持つ(成績と同じく保存しない)。

/** 成績(PlayStats / GbStats)の写し。配列は複製し、メソッドとゲッターは元のクラスのまま。 */
export function cloneStats(stats) {
  const c = Object.create(Object.getPrototypeOf(stats));
  for (const k of Object.keys(stats)) {
    const v = stats[k];
    c[k] = Array.isArray(v) ? v.slice() : v;
  }
  return c;
}

export class Take {
  /**
   * @param {number} startMs 始めた譜面時刻
   * @param {object} stats 始めたときの成績(写しを取る。ループの 2 周目以降はゲージなどを持ち越している)
   * @param {object} [init] 楽器ごとの始めの状態(ギター / ベースの押さえているボタン)
   */
  constructor(startMs, stats, init = null) {
    this.startMs = startMs;
    this.endMs = startMs;
    this.stats0 = cloneStats(stats);
    this.stats1 = null; // 終わったときの成績(リプレイを止めたらこれに戻す)
    this.init = init;
    this.flags = null; // 終わったときの AUTO の状態(達成率の補正と AUTO のボタンの点灯に使う)
    this.events = []; // {kind, timeMs, ...}(記録した順。timeMs は前の出来事より前にしない)
    this.sounds = []; // {timeMs, sched, ...}(finish で時刻順)
    this.ghosts = []; // {timeMs, judge, lane | bits}(finish で時刻順)
  }

  /**
   * 出来事を足す。時刻は前の出来事より前にしない(打鍵は押した時刻で判定するので、フレームで取ったミスより前の時刻の
   * ことがある。当て直す順を記録した順のまま保つため。ずれても 1 フレーム以内)。
   */
  event(ev, timeMs) {
    const last = this.events.length ? this.events[this.events.length - 1].timeMs : this.startMs;
    ev.timeMs = Math.max(timeMs, last);
    this.events.push(ev);
    this.reach(ev.timeMs);
  }

  /** 音を足す。sched は先読みで予約した音(まだ鳴っていない。dropScheduledFrom で消せる)。 */
  sound(s, timeMs, sched) {
    s.timeMs = timeMs;
    s.sched = sched;
    this.sounds.push(s);
  }

  /**
   * 予約しただけで鳴らなかった音を消す(一時停止・演奏速度の変更で予約を止めて鳴らし直すとき。消さないと同じ音が
   * 2 つ記録される)。すぐ鳴らした音(打鍵の音)は消さない。
   */
  dropScheduledFrom(songMs) {
    if (this.sounds.some((s) => s.sched && s.timeMs >= songMs)) this.sounds = this.sounds.filter((s) => !(s.sched && s.timeMs >= songMs));
  }

  ghost(g) {
    this.ghosts.push(g);
  }

  /** ここまで演奏した(譜面時刻)。 */
  reach(songMs) {
    if (songMs > this.endMs) this.endMs = songMs;
  }

  /** 何も起きなかった(叩く前に止めた)テイクは残さない。 */
  get empty() {
    return !this.events.length && !this.ghosts.length;
  }

  /** 締める: 終わりより後ろに予約した音を捨て、音とゴーストを時刻順に並べ、終わったときの成績と AUTO の状態を写す。 */
  finish(stats, flags) {
    const byTime = (a, b) => a.timeMs - b.timeMs;
    this.sounds = this.sounds.filter((s) => !s.sched || s.timeMs <= this.endMs).sort(byTime);
    this.ghosts.sort(byTime);
    this.stats1 = cloneStats(stats);
    this.flags = flags;
    return this;
  }
}
