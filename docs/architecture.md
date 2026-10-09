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
| `js/ui/menu.js` | DTXManiaAI `Stages/TrainingMenu.cs` | `docs/spec/training-menu.md`。`refresh` は描画のたびに評価するが、DOM へは値が変わったときだけ書く(同じ値でも書くと毎フレームのレイアウト・ペイントになるため。見える結果は元実装と同じ)。(追加) ギター / ベースでは項目の並びを `GB_ITEMS` に替え、自動演奏詳細を R G B Y P PICK WAIL の 7 ボタン、ハイスピードと判定タイミング調整を別の値(`gbScrollSpeedTenth` / `gbJudgeOffsetMs`)、「ドラム音量」を弾くパートの音量にし、「AUTO プリセット」(NX のクイック設定の Auto Mode)・「リバース」・「LEFT(左利き)」・「空ピックで BAD」(アプリ設定の `gbLight` をフックで切り替える)を足す(元実装にギターのトレーニングは無い)。(追加) 行が枠からはみ出すときは、カーソルの行が見えるよう枠をスクロールする(カーソルが動いたときだけ測る) |
| `js/ui/keybind.js` | DTXManiaAI `Input/DrumBinding.cs` + CONFIG `Key Assign` | `docs/spec/nx-docs.md` §4。キーボード(MIDI は下の midibind.js に別保存)。ギターコントローラの割り当ても同じ規則で別に保存する(`config.gbPadBindings`。`normalizeBindings` に符号の検査を渡す) |
| `js/ui/gamepad.js` | NX `CInputJoystick` + `CPad`(DTXManiaAI `InputManager` の Gamepad) | `docs/spec/gb-config.md` §1.5、決めたことは `docs/spec/guitar-bass.md`。(変更) DirectInput を Gamepad API に置き換え。ブラウザは変化を知らせないので 4 ms ごとに `navigator.getGamepads()` を読み(ゲームパッドが無い間は 250 ms)、演奏中はフレームの頭でも読む。符号は `b3`(ボタン)/ `a3-`(軸の向き。NX と同じ 0.5 で押し、(追加) 0.35 で離す)/ `h9u`(Chrome / Firefox が軸に載せるハットの上下左右。斜めは両方)。時刻は `gamepad.timestamp`(1 秒以上ずれていれば読んだ時刻)。初めて見た入力は今の状態を基準にし、押したまま見つかったものを押した扱いにしない。押して追加は待ち始めの状態を基準に最初に変わった入力を取る。(追加) START の行(演奏開始・停止) |
| `js/ui/keypanel.js` | (上の keybind.js の UI) | 入力元(`device`)を差し替えられる: キーボード(既定)とギターコントローラ(`padDevice`。名前・待ち受け・「キー」を「入力」と言う文言)。ゲームパッドを待つ間、キーボードは Esc(中止)だけ受ける |
| `js/ui/midi.js` | DTXManiaAI `Input/MidiInput.cs`(NX `CInputMIDI`) | `docs/spec/nx-docs.md` §7。winmm を Web MIDI に置き換え。全デバイスを開く・0x9n かつ vel≠0・しきい値以下を捨てる・ベロシティは音量に使わない、は同じ。(変更) 打鍵時刻はフレーム時刻ではなく `MIDIMessageEvent.timeStamp`(キーボードの `event.timeStamp` と同じ扱い)。そのため「同じレーンは 1 フレームに 1 打」はフレーム境界でなく、最後に通した打鍵から `MIDI_MERGE_MS`(16 ms)で切る。抜き差しは `statechange` で拾う |
| `js/ui/midibind.js` | DTXManiaAI `Input/MidiDrumPresets.cs`、`DrumBinding` の `Midi:38:12`、`ConfigIni` の GM 既定と `<PAD>VelocityMin` | (変更) 保存はキーボードと別(`config.midiNotes` = `{note, threshold}[][]`、`config.midiVelocityMin`)で、それぞれ 1 レーン 12 個まで。元実装はトークン列に混ぜて合計 12。保存が別なので「MIDI 対応前の設定へ GM を一度だけ流し込む」(`MidiDefaultsSeeded`)は要らない(キーが無ければ既定) |
| `js/ui/midipanel.js` | DTXManiaAI CONFIG `MIDI Setup` + `MIDI Velocity` | 2 ページを設定パネルの 1 節にまとめた。行の対応は冒頭の注記。(追加) 叩いたパッドの行き先の行を光らせる、モニタにしきい値で捨てた打鍵を `(弱)` と出す、1 段の「元に戻す」、レーン単位の「既定」「解除」。(変更) キーボードの割り当て待ち(Key Assign)は MIDI の打鍵を受けない(元実装は Key Assign でも叩いたノートが入る。Web 版は MIDI を別保存にしたので、MIDI は「＋ 叩いて追加」に一本化) |
| `js/core/instmerge.js` | DTXManiaAI `Song/SongInstrumentMerge.cs` | 楽器別のファイルに分かれた同じ曲(set.def の「(Drum)」「(Guitar)」「(Bass)」のブロックなど)を曲の一覧で 1 項目にまとめる。題名の添え字の規則は同じ。まとめた曲は譜面の配列をつなげるだけで、一覧は譜面ごとの楽器(`header.noteMask` / `levels`)で楽器の行に分けて出す。`docs/spec/gb-config.md` §4.5 |
| `js/game/gbplayer.js`, `js/game/gbjudge.js` | NX `CStagePerfCommonScreen` のギター / ベース部分、DTXManiaAI `Stages/GuitarPerformanceStage.cs` / `Core/PerformanceResult.cs` | `docs/spec/guitar-bass.md`(決めたことの一覧)と `gb-judge.md` / `gb-score.md`。`GuitarPlayer` は `Player` を継承し、時計・状態機械・ループ・シーク・BGM / SE の予約はそのまま使う(`Player.load` を `_prepareChart` などの差し替え口に分けた)。(変更) 1 パートだけを弾き、もう一方のパートとドラムは伴奏。押さえ方が合わないピックは 30 ms(タッチ 50 ms)待つ。AUTO ピック中の手動ピックは無視 |
| (追加) 伴奏 | NX はバーの通過で音だけ鳴らす(ドラム画面のギター / ベース、ギター画面のドラム) | `Player.accomp`(`buildAccompaniment`)。弾いていない楽器のチップを BGM / SE と同じく先読みで予約し、ジャンプ・再開では鳴りかけの音を途中から鳴らす。ギター / ベースは同じパートの前の音を次の音の時刻で止める。BGM のバス・AUTO の相対音量 |
| `js/ui/gbinput.js` | DTXManiaAI のギター / ベースのキー(`GuitarKeys`) | ネックは押している間(同じボタンの複数のキー・指・ゲームパッドの入力をまとめ、変わったときだけ知らせる)、ピックとウェイリングは押した瞬間。(変更) 既定のキーは A S D F G / J・K / L(F キーと Ctrl はブラウザで使えない)。タッチはレーンを押す = 押さえてピック。ギターコントローラは `padInput` で同じ道を通る |
| `js/ui/gbrenderer.js` | NX `GuitarScreen/*`(DTXManiaAI `NxGuitarLayout.cs`) | `docs/spec/gb-screen.md`。`GuitarRenderer` は `Renderer` を継承し、静止部分・ハイウェイ・パネルの位置を差し替え口(`_drawStatic` / `_drawPlayfield` / `_drawHud` など)で替える(ドラムの描画は画素まで同じ)。NX の座標を 1.5 倍してドラムの帯の中央(x 928)に置き、判定ラインは画面上(リバースで画面下)。チップ・ネック・ボタンの絵はスキンの `gb_chips.png` / `gb_neck.png`(`tools/skinart/guitar.js`)、光の演出はコードで描く。(変更) 判定文字はドラムの 300 ms のアニメ、BAD は「BAD」の文字(NX は何も描かない)、押さえたボタンのつまみを光らせる(NX は押下を見せない)。LEFT(`player.left`)はボタン → 描く列を `gbSlot` で入れ替える(チップ・胴・フラッシュ・弦・ファイア・ボタン列・タッチ)。ボタン列はスキンに LEFT 用の行が無いので、`swapLaneColumns`(js/ui/skin.js)が画像のレーン 5 列を画像の画素の整数の境目で並べ替えて作る(何も無いキャンバスに写すので、透明な所のあるスキンでも元の並びが透けない)。静止部分の作り直しのキーに LEFT を含める |
| `js/ui/keypanel.js` | 設定の「キー割り当て」(以前は js/main.js の中) | ドラムの 10 レーンとギター / ベースの 7 ボタンで同じ部品を使うよう切り出した。規則(js/ui/keybind.js)は既定のキーを引数で受ける |
| (追加) 停止中のシーク | 元実装に相当機能なし | `Player.seekTo` / `#seekbar` / メニュー「現在位置」。待機位置の同期はループ設定が動いたときだけに変更した。ギター / ベースの横画面で判定ラインが上にあるとき(リバースでないとき)は、シークバーを画面下に出し、メニューの高さをその上までにする(`_placeSeekBar` / `_layoutMenu`) |
| (追加) リプレイとゴーストノーツ | 元実装に相当機能なし | `js/game/replay.js`(テイク)と `Player` の「記録」「リプレイ」の節。下の「記録とリプレイ」 |
| (追加) 停止中の描画の間引き | 元実装に相当機能なし | `js/ui/framepace.js`。待機・一時停止の間は 60 fps 前後で描く(画面の Hz を rAF の間隔から測り、k 回の更新に 1 回。144 Hz なら 72、90 Hz なら 45。SoundVoltexAnalyze の frameDivisor と同じ考え方)。省電力のためで処理落ち対策ではない(360 Hz の画面で待機中も約 1 コア使っていた)。間引くのは描画(`menu.refresh` / `renderer.draw` / `updateSeekBar`)だけで、判定・指示・キーリピートは毎 rAF。演奏中・開始待ち・演出の下敷きの間・resize と打鍵・キー入力の直後は毎回描く。演奏中に上限を掛けないのは、1 フレームの移動が k 倍になって見た目が粗くなるため |
| (追加) 表示言語(日本語 / 英語) | 元実装は日本語のみ | `js/i18n.js`。文言は `[日本語, 英語]` の組で持ち `t(key, vars)` で引く。index.html は日本語を書いたまま `data-i18n*` で差し替える(JS が動く前と起動に失敗したときは日本語)。言語は `?lang=` → 保存した `dojo.lang` → 日本語の順。英語のときは `<head>` のスクリプトが差し替えまで画面を隠す。ホームの状態表示は「今の言語で作り直す関数」で持ち、切り替えたら作り直す。切り替えはホームだけで、演奏画面の文言は開くたびに作る。英語の項目名(Auto Play など)は本アプリで付けたもの |
| (変更) メトロノーム | DTXManiaAI `Config.Metronome`(ON/OFF)+ `PerformanceStage.ProcessBarLines`(PS:2000-2011。`Metronome.ogg` を小節線 1.0 / 拍線 0.4 の音量で、ワンショットなので演奏速度でピッチが変わる)。NX `Metronome=`(docs/spec/training-state.md:169、nx-docs.md §1.6) | トレーニングメニューの「メトロノーム」(`TrainingSettings.metronomeVolume`、0〜100 % の 10 刻み、0 で OFF。ドラムとギター / ベースで共通)。`buildMetronome`(js/game/player.js)が小節線・拍線の時刻を拍にし、BGM と同じく `scheduleAutoSounds` で先読みして予約する。元実装と同じ: 拍線は小節線の 0.4 倍の音量、0xC2 で隠した線も鳴らす、曲頭のリードインの小節も刻む(カウントになる)、待機・開始待ち・一時停止中は鳴らない。違い: ON/OFF の設定を、練習中に耳で合わせられるようメニューの音量にした / 第三者の音を同梱しないので `AudioEngine.clickBuffer`(js/core/synth.js の `buildClick`、50 ms のサイン波)で合成し、小節の頭は高い音にもする(音量が小さくても分かるように)/ 演奏速度で音の高さを変えない(遅くしても拍の音が分かるように)/ master に出し BGM 音量に左右されない / 同じ時刻の線は 1 つにまとめる / ループの継ぎ目は終端の拍のクリックを止めず、開始位置の同じ拍を鳴らし直さない(二度鳴りしないように。ループ中は終端より後ろの拍を予約しない) |
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

## 記録とリプレイ(元実装に無い追加)

演奏の通し(演奏に入ってから、待機へ戻る・ループの折り返し・一時停止中のシークからの再開(数え直し)まで)を
**テイク**として譜面時刻で記録し(`js/game/replay.js` の `Take`)、何か起きたテイクを `Player.lastTake` に残す。
リプレイ(`Player.startReplay`)は待機中だけ始められ、同じ状態機械(開始待ち → 演奏 ⇄ 一時停止)をテイクの範囲で回す。

- **判定をやり直さない**。成績と演出を動かす処理を「決める」と「当てる」に分け(`_judgeNote` → `_applyJudge`、
  ギター / ベースは `_judgeChip` → `_applyChip` など)、決めた結果を出来事として記録し、リプレイは `_applyEvent` で同じ順に
  当て直す。入力を流し直して判定し直す作りにしなかったのは、判定窓が実時間の量(`_w(ms) = ms × ratio`)で演奏速度を
  変えると判定が変わること、ギター / ベースの押さえ方を待つピック(30 ms)とロングノートの加点がフレームと performance.now で
  決まり、流し直すと食い違いうること、のため。成績はテイクの始めの写し(`stats0`。ループの 2 周目以降はゲージを持ち越している)
  から同じ順に当てるので必ず一致し、止めたら締めたときの写し(`stats1`)に戻す
- 出来事の時刻は `_evMs`(update では今のフレームの譜面時刻、打鍵では押した時刻、打鍵の前の処理(hit の注記)ではその時刻)。
  押した時刻はフレームで取ったミスより前のことがあるので、記録した順を保つよう前の出来事より前にはしない(ずれは 1 フレーム以内)
- 音は判定と別に、鳴った譜面時刻で記録し、リプレイは BGM と同じく先読みで予約する(打鍵の音も叩いた時刻ちょうどに鳴る)。
  先読みで予約した音は一時停止・演奏速度の変更で止めて予約し直すので、そのときに記録からも消す(`dropScheduledFrom`)
- ゴーストノーツは打鍵(ピック)ごとに、判定に使った時刻 `inputMs`(判定タイミング調整を足したもの)・当たったチップのレーン
  (ギター / ベースは押さえていたボタン。AUTO のボタンはチップのとおり)・判定を持つ。チップとの距離が判定のずれの表示と一致する
- AUTO の状態はテイクのもの(`flags`)をリプレイ中に使う(達成率の補正・AUTO のボタンの点灯)。演奏速度・ハイスピード・
  ノーツ表示調整は今の設定で見る。ループの折り返しはしない。シークはテイクの範囲の中だけで、成績を数え直さず
  テイクの頭からその位置までの出来事を演出なしで当て直す(`_replayRebuild`)
- リプレイ中の打鍵・ピックは使わない。ギター / ベースのボタンは実際に押している状態を別に覚えておき、止めたら戻す

## 譜面編集(将来)への布石

- `parseDTX` の各ノートは `{measure, tick, channel, wavId, pos}` を持つ。`chart.rawLines` に元テキストの行を残す
- vid2dtx と同じ保存方式: ドラムチャンネル行(0x11〜0x1C)以外は原文のまま残し、ドラム行だけを
  `#mmmCC: …`(gcd で分割数を決める)で再生成する。ZIP 内の譜面を書き換えて再ダウンロードする形になる
- レーン→(小節, tick)の変換に必要な `measureTimes` / `barLines` は既に `chart` にある
