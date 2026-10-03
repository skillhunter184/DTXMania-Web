# アーキテクチャと移植の方針

## 元実装との対応

| 本アプリ | 元 | 備考 |
|---|---|---|
| `js/core/dtx.js` | DTXManiaAI `Song/DtxChart.cs`, `DtxIfStack.cs`, `DtxHeader.cs` | NX CDTX のタイミング計算をそのまま移植。`docs/spec/dtx-audio.md` |
| `js/core/xa.js` | vid2dtx `xa.py`(DTXManiaCX XaDecoder) | DTXManiaAI の `libbjxa.cs` は出力を先頭ブロックへ書き続けるバグがあるので使わない |
| `js/core/setdef.js` | DTXManiaAI `Song/SetDef.cs` | |
| `js/core/synth.js` | DTXManiaAI `Audio/DrumSynth.cs` | 乱数列は非互換(音色は同等) |
| `js/game/hitranges.js` | DTXManiaAI `Core/HitRanges.cs`, `Core/DrumGroups.cs` | |
| `js/game/judge.js` | DTXManiaAI `Core/PerformanceResult.cs` + `PerformanceStage.Judge/AutoJudge` | `docs/spec/judge-score.md` |
| `js/game/training.js` | DTXManiaAI `Core/TrainingSettings.cs` | |
| `js/game/player.js` | DTXManiaAI `Stages/PerformanceStage.cs`(トレーニング分岐) | `docs/spec/training-state.md` |
| `js/ui/menu.js` | DTXManiaAI `Stages/TrainingMenu.cs` | `docs/spec/training-menu.md`。`refresh` は描画のたびに評価するが、DOM へは値が変わったときだけ書く(同じ値でも書くと毎フレームのレイアウト・ペイントになるため。見える結果は元実装と同じ) |
| `js/ui/keybind.js` | DTXManiaAI `Input/DrumBinding.cs` + CONFIG `Key Assign` | `docs/spec/nx-docs.md` §4。キーボードのみ(MIDI は下の midibind.js に別保存、ゲームパッドは未対応) |
| `js/ui/midi.js` | DTXManiaAI `Input/MidiInput.cs`(NX `CInputMIDI`) | `docs/spec/nx-docs.md` §7。winmm を Web MIDI に置き換え。全デバイスを開く・0x9n かつ vel≠0・しきい値以下を捨てる・ベロシティは音量に使わない、は同じ。(変更) 打鍵時刻はフレーム時刻ではなく `MIDIMessageEvent.timeStamp`(キーボードの `event.timeStamp` と同じ扱い)。そのため「同じレーンは 1 フレームに 1 打」はフレーム境界でなく、最後に通した打鍵から `MIDI_MERGE_MS`(16 ms)で切る。抜き差しは `statechange` で拾う |
| `js/ui/midibind.js` | DTXManiaAI `Input/MidiDrumPresets.cs`、`DrumBinding` の `Midi:38:12`、`ConfigIni` の GM 既定と `<PAD>VelocityMin` | (変更) 保存はキーボードと別(`config.midiNotes` = `{note, threshold}[][]`、`config.midiVelocityMin`)で、それぞれ 1 レーン 12 個まで。元実装はトークン列に混ぜて合計 12。保存が別なので「MIDI 対応前の設定へ GM を一度だけ流し込む」(`MidiDefaultsSeeded`)は要らない(キーが無ければ既定) |
| `js/ui/midipanel.js` | DTXManiaAI CONFIG `MIDI Setup` + `MIDI Velocity` | 2 ページを設定パネルの 1 節にまとめた。行の対応は冒頭の注記。(追加) 叩いたパッドの行き先の行を光らせる、モニタにしきい値で捨てた打鍵を `(弱)` と出す、1 段の「元に戻す」、レーン単位の「既定」「解除」。(変更) キーボードの割り当て待ち(Key Assign)は MIDI の打鍵を受けない(元実装は Key Assign でも叩いたノートが入る。Web 版は MIDI を別保存にしたので、MIDI は「＋ 叩いて追加」に一本化) |
| (追加) 停止中のシーク | 元実装に相当機能なし | `Player.seekTo` / `#seekbar` / メニュー「現在位置」。待機位置の同期はループ設定が動いたときだけに変更した |
| (追加) 停止中の描画の間引き | 元実装に相当機能なし | `js/ui/framepace.js`。待機・一時停止の間は 60 fps 前後で描く(画面の Hz を rAF の間隔から測り、k 回の更新に 1 回。144 Hz なら 72、90 Hz なら 45。SoundVoltexAnalyze の frameDivisor と同じ考え方)。省電力のためで処理落ち対策ではない(360 Hz の画面で待機中も約 1 コア使っていた)。間引くのは描画(`menu.refresh` / `renderer.draw` / `updateSeekBar`)だけで、判定・指示・キーリピートは毎 rAF。演奏中・開始待ち・演出の下敷きの間・resize と打鍵・キー入力の直後は毎回描く。演奏中に上限を掛けないのは、1 フレームの移動が k 倍になって見た目が粗くなるため |
| (追加) 音量バス | 元実装は音量を発音ごとに掛ける | `AudioEngine.setBusVolume('bgm'/'chip')`。鳴っている音にも効くので演奏中に調整できる。SE・歓声・メニュー音は master 直結 |
| (変更) ハイスピード | 移植元 DTXManiaAI の x1.0 は 0.675 px/ms で NX の約 2.5 倍速い | `SCROLL_BASE_PX_PER_MS`(js/game/player.js)を NX の式から導いた 0.268125 px/ms に。刻みも 0.5 → 0.1(`scrollSpeedTenth`、旧 `scrollSpeed` は読み込み時に ×5 で移行) |
| `js/ui/skin.js`, `js/ui/renderer.js` | vid2dtx `preview.py` | `docs/spec/vid2dtx-edit.md`。静止部分はキャンバスと同じ大きさで一度だけ作って等倍で貼る(vid2dtx §2.2 と同じ。ソフトウェア描画の 4K で 36〜48 → 60 fps)。(追加) 新しい Renderer の最初の 10 フレームは演出を静止部分の下に描き、GPU のシェーダを待機中に作る(`WARM_AGES` の注記)。(追加) 絵はスキンの画像の組(`skins/README.md`。既定のスキン `skins/default/` を同梱し、設定でフォルダか読み込んだ画像に替えられる。足りない画像は既定のスキンで補い、それも無ければ単色の図形。移植元は単色。§1.4)。画像は等倍の何倍でもよく、幅から倍率を求めて配置を掛ける(`SKIN_PARTS`)。チップは表示の画素数に縮めて作り置き、パッド列と判定ラインは画像の倍率のまま切り出して作り置く |

## 時計モデル

DTXManiaAI/NX は演奏速度を「譜面時刻の伸縮」で実装する(時計は常に実時間)。本アプリは逆に
**譜面時刻を不変にして時計の進み方を変える**:

```
realMs  = 聞こえている ctx 時刻 × 1000 − 遅延補正      … 「今聞こえている」実時間
songMs  = anchorSong + (realMs − anchorReal) × ratio    … ratio = 演奏速度 / 20
```

両者は等価だが、ループ位置・小節一覧・ノートの時刻を速度変更のたびに書き換えなくて済む。
その代わり、実時間 ms で定義されている量(判定窓、判定タイミング調整、ノーツ表示調整、
曲末の 2000 ms、スクロールの px/ms)は譜面時刻差を `ratio` で割ってから使う
(`player._w(ms) = ms × ratio` で譜面時刻差へ、`lag = Δchart / ratio` で実時間へ)。

### 聞こえている ctx 時刻(元実装に無い、このアプリ独自の作り)

元実装の SongClock は壁時計(GameTimer)で、音の時計の決まりは docs/spec に無い。本アプリは
`Player.realFromPerf(perfMs)` で performance.now 軸の時刻を「その瞬間に聞こえている ctx 時刻」に変換する。

- Chromium(Chrome / Edge): `ctx.getOutputTimestamp()` の組 {contextTime, performanceTime}(今スピーカーから
  出ている音の ctx 時刻と、それを出した performance.now の時刻)を perfMs まで延ばす(`AudioEngine.audibleCtxAt`)。
  SoundVoltexAnalyze の譜面シミュレータ(audio.js `_audibleCtx`)と同じ作り。
- それ以外のブラウザと、組が使えないとき(suspend 中、鳴り始めで組がまだ無い、組が 100 ms より古い、
  測った遅れ = currentTime − 聞こえている時刻 が 1〜500 ms の外): 以前の推定
  `ctx.currentTime − (baseLatency + outputLatency)`。Firefox の組は呼んだときの currentTime から作られて意味が無く、
  WebKit の組は何を指すかを確かめていないので使わない(`AudioEngine.trustsOutputTimestamp`)。

組を使う理由: Chrome の `currentTime` は音の処理の区切り(約 10 ms ごとに 8 / 10.67 ms ずつ)でしか進まないので、
推定の式の時計は階段になる。ヘッドレス Chrome・360 Hz の計測で、描いたフレームの 72% でチップが止まり、
残りのフレームで 10.67 ms ぶん跳んでいた(直線からのずれ RMS 2.97 ms。2560x1440 の x4.0 で 1 回 36 px)。
打鍵の変換も同じ階段に乗り、1 打ごとに RMS 3 ms(±5 ms 程度)の揺れが判定とずれの表示に入っていた。
組を延ばすと RMS 0.04 ms・止まり 0。処理落ち(フレームの重さ)の対策ではなく、時計の階段によるカクつきの対策。
同じ打鍵のずれ表示は Chrome で平均約 2 ms 遅い側(+)に出るようになった(推定の 50 ms と、組から測った遅れ約 48 ms の差。どちらも
ブラウザの見積もりで、実際の音にどちらが近いかは測っていない)。揺れより小さいので「遅延補正」は合わせ直さなくてよい。

`nowReal()`(今の読み)だけは時計が戻らないよう後退を前の値で止める。組と推定の式が切り替わった直後は追いつくまで
止める(音の処理が止まると、組の時計は組を延ばして約 1 出力遅延ぶん先へ進んでから推定の式へ移り、ctx の resume
直後は逆に推定の式が約 20 ms 先にある。どちらも数十 ms 戻るので、以前の時計と同じく止まるだけにする)。同じ式のままの
後退は 8 ms 未満だけ止める(遅延補正を大きく変えたときは戻る)。打鍵の `timeStamp` を変換する `realFromPerf` は止めない(過去の時刻を今の読みまで持ち上げると判定が遅れる)。

### 予約とアンカー

自動発音(BGM・SE・AUTO レーンのチップ)は ctx.currentTime から 200 ms 先まで先読みして AudioContext 時刻に予約する
(聞こえている時刻からは 200 ms + 出力遅延 + 遅延補正 先。遅延補正が大きく負でも、聞こえている時刻から 200 ms 先より
短くしない。短いと AUTO チップが予約より先に判定に達し、予約の無い即時の経路で譜面より早く鳴る)。
ctx 時刻 T に start したバッファは聞こえている ctx 時刻が T のとき(realMs = T − 遅延補正。遅延補正 0 なら
realMs が T に達したとき)に聞こえるので、予約時刻は
`ctxTimeAt(songMs) = realAt(songMs) / 1000` そのもの(**遅延を足し直さない**。足すと BGM が判定より遅れて鳴り、
設定の「遅延補正」も効かなくなる — レビューで見つかった不具合)。演奏開始・再開時はアンカーを今の
`ctx.currentTime` に置き(`Player._ctxNowMs`。今 start した音が聞こえる瞬間に開始位置が来る)、開始位置の音を頭から鳴らす。
推定の式なら `nowReal() + 出力遅延` と同じ値だが、組の時計では推定と実際の遅れの差だけ currentTime より前になり、
開始位置の音の頭が欠けるので currentTime を直接使う。演奏中の速度変更・ジャンプは、表示を途切れさせないよう
今の realMs に置く。フレーム落ちしても音は正確に鳴る。判定・演出はフレームで行う。

ただし打鍵は押した時刻(`event.timeStamp`)で判定するので、`Player.hit` はその時刻までのフレームの処理
(不可視チップの消化 → レーン別 AUTO → MISS。`processJudgement`)を先に済ませてから打鍵を探す。元実装はパッドも
フレーム時刻で読み、フレーム内は「不可視 → AUTO → パッド → ミス」(docs/spec/judge-score.md §2)なので、フレームが
十分短ければ同じ順になる。これが無いと、次のフレームより前の打鍵が未消化の不可視チップに吸われたり、コンボが
MISS より先に数えられたりして、判定と成績が画面の Hz や処理落ちで変わっていた。自動発音の予約も update と
同じく判定より先に済ませる(長いフレームの空白の後で、過ぎた AUTO チップの音が予約を経ずにまとめて鳴らないように)。
ループの終端より後ろは折り返しのフレームに任せる(終端までは済ませる)。成績が揃うのは、上の時計の階段が無いときに限る。

## 状態機械(トレーニング)

```
STANDBY ──演奏開始/リスタート──▶ START IN(実時間で待つ) ──▶ PLAYING ⇄ PAUSED
   ▲                                     ▲                     │
   └── 曲末(成績は残す)/ 演奏停止 ────────┼─────────────────────┘
                                          └── ループ折り返し(開始待ち > 0 のとき)
```

- 待機中は songMs を `startMs`(ループ ON なら開始位置、それ以外は 0)に固定し、打鍵は音と演出だけ
- `jumpTo(t)` は `timeMs < t` のチップを処理済みにする(通過扱い・ミスにしない)。成績は触らない
- ループ折り返しは counts / combo / maxCombo / score をリセットし、ゲージと countsIncAuto は残す

## 譜面編集(将来)への布石

- `parseDTX` の各ノートは `{measure, tick, channel, wavId, pos}` を持つ。`chart.rawLines` に元テキストの行を残す
- vid2dtx と同じ保存方式: ドラムチャンネル行(0x11〜0x1C)以外は原文のまま残し、ドラム行だけを
  `#mmmCC: …`(gcd で分割数を決める)で再生成する。ZIP 内の譜面を書き換えて再ダウンロードする形になる
- レーン→(小節, tick)の変換に必要な `measureTimes` / `barLines` は既に `chart` にある
