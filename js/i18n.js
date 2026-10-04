// 画面の文言の日本語 / 英語の切り替え(元実装に無い追加。元実装は日本語のみ)。
//
// 既定は日本語。言語は URL の ?lang=ja / ?lang=en(英語版へのリンクを配るため)→ 保存した dojo.lang → 日本語
// の順で決める(initialLang)。index.html の <head> のスクリプトも同じ順で決め、英語なら文言を差し替えるまで
// 画面を隠す(日本語が一瞬見えないように)。
//
// 文言は STRINGS に [日本語, 英語] の組で置く。index.html には日本語をそのまま書いておき(JS が動く前と起動に
// 失敗したときに出る)、要素の data-i18n などに書いたキーで applyDom が差し替える:
//   data-i18n="キー"            textContent
//   data-i18n-html="キー"       innerHTML(<b> などを含む文。英語も同じ要素の並びにする)
//   data-i18n-title="キー"      title 属性
//   data-i18n-aria-label="キー" aria-label 属性
// index.html の日本語と STRINGS の日本語が食い違うとテスト(tests/i18n.test.js)が落ちる。
// 日本語を直したら隣の英語も直すこと。
//
// {name} は t() の vars で置き換える。{n|song|songs} は n が 1 なら song、それ以外は songs(英語の複数形用)。
// console に出すだけの文言(開発者向け)は訳さない。

export const LANGS = ['ja', 'en'];
export const DEFAULT_LANG = 'ja';

export const STRINGS = {
  // ---- index.html: ホーム ----
  'home.tagline': [
    'DTX 譜面(ドラム・ギター・ベース)をブラウザで練習する。ZIP を選ぶだけ。キーボードでもタッチでも演奏できる。',
    'Practice DTX drum, guitar and bass charts in your browser. Just pick a ZIP. Play with a keyboard or by touch.',
  ],
  'home.drop': ['曲フォルダを ZIP にしたファイルをここにドロップ、または', 'Drop a ZIP of a song folder here, or'],
  'home.pickZip': ['ZIP を選ぶ', 'Choose ZIP'],
  'home.pickFolder': ['フォルダを選ぶ', 'Choose Folder'],
  'home.lastZip': ['前回の ZIP を開く({name})', 'Open Last ZIP ({name})'],
  'home.dropNote': [
    'set.def があれば難易度ごとに、無ければ .dtx ごとに一覧します。ドラム・ギター・ベースの譜面は楽器ごとの行に並び、'
      + '楽器別のファイルに分かれた同じ曲は 1 つにまとめます。音源は wav / ogg / mp3 / xa に対応。動画は再生しません。',
    'Charts are listed per difficulty when set.def exists, otherwise per .dtx file. Drum, guitar and bass charts are shown in a row '
      + 'per instrument, and a song split into per-instrument files is shown once. Audio: wav / ogg / mp3 / xa. Videos are not played.',
  ],
  'home.footer': [
    'レイアウトは vid2dtx の譜面プレビュー、練習機能は DTXManiaAI のトレーニングモードを基にしています。'
      + 'DTXMania の譜面を遊べる非公式のファンメイドのアプリで、DTXMania の各プロジェクトや KONAMI とは関係ありません'
      + '(GITADORA は KONAMI の商標)。ライセンスは MIT(一部 LGPL-2.1)。',
    'The layout is based on the chart preview of vid2dtx, and the practice features on the training mode of DTXManiaAI. '
      + 'This is an unofficial fan-made app for playing DTXMania charts and is not affiliated with any DTXMania project or KONAMI '
      + '(GITADORA is a trademark of KONAMI). Licensed under MIT (partly LGPL-2.1).',
  ],

  // ---- index.html: 設定 ----
  'settings.summary': [
    '設定(キー割り当て・電子ドラム・ギター / ベース・ギターコントローラ・音量・遅延補正・打ち分け)',
    'Settings (key bindings, e-drums, guitar / bass, guitar controller, volume, latency, lane grouping)',
  ],
  'settings.keys': ['キー割り当て', 'Key Bindings'],
  'settings.keyNote': [
    '1 レーンに複数のキーを割り当てられます(12 個まで)。'
      + '<b>キー名</b>を押すと差し替え / <b>×</b> で 1 個だけ外す / <b>＋ 追加</b> でもう 1 個足す。'
      + '<span class="key-note-kbd">キーボードだけなら Tab で行に入り、←→ でキー間・↑↓ でレーン間を移動、Enter で実行、Delete で削除。</span>'
      + '<span class="key-note-touch">キーの割り当てには物理キーボードが要ります(タッチで叩くときはレーンの列を直接タップ)。</span>'
      + '↑↓←→ / Enter / Esc / Tab / F1 はメニュー操作に使うため割り当てできません。',
    'Each lane can have several keys (up to 12). '
      + 'Press a <b>key name</b> to replace it / <b>×</b> to remove just that key / <b>＋ Add</b> to add another. '
      + '<span class="key-note-kbd">With the keyboard only: Tab into a row, ←→ moves between keys and ↑↓ between lanes, Enter runs, Delete removes. </span>'
      + '<span class="key-note-touch">Assigning keys needs a physical keyboard (to play by touch, tap the lane columns directly). </span>'
      + '↑↓←→ / Enter / Esc / Tab / F1 are used for menu control and cannot be assigned.',
  ],
  'settings.resetAll': ['全レーンを既定に戻す', 'Reset All Lanes'],
  'settings.gbKeys': ['ギター / ベースのキー割り当て', 'Guitar / Bass Key Bindings'],
  'settings.gbKeyNote': [
    '<b>R G B Y P</b>(ネック)は押している間だけ押さえた扱いで、<b>PICK</b> を押した瞬間に押さえ方とチップを照合します。'
      + '押さえ方はチップとちょうど同じにします(OPEN は何も押さえない)。<b>WAIL</b> はピックが当たった直後のウェイリング。'
      + 'ギターとベースで同じ割り当てを使い、ドラムの割り当てとは別です。操作は上のドラムのキー割り当てと同じです。'
      + 'メニューの「LEFT(左利き)」はボタンの並びを左右反転して描くだけで、キーはボタンに付いたままです。'
      + '左手でピックするなら「左利き用の並びにする」(R〜P = ; L K J H、PICK = F・D、WAIL = S)。',
    '<b>R G B Y P</b> (the neck) count as held while pressed, and pressing <b>PICK</b> checks the held buttons against the chip. '
      + 'Hold exactly the chip\'s buttons (nothing for OPEN). <b>WAIL</b> is the wailing right after a successful pick. '
      + 'Guitar and bass share these bindings, separate from the drum bindings. They work like the drum key bindings above. '
      + 'Left (Lefty) in the menu only draws the buttons in mirrored order; keys stay with their buttons. '
      + 'To pick with your left hand, use Lefty Layout (R–P = ; L K J H, PICK = F / D, WAIL = S).',
  ],
  'settings.resetAllButtons': ['全ボタンを既定に戻す', 'Reset All Buttons'],
  'settings.gbLeftyKeys': ['左利き用の並びにする', 'Lefty Layout'],
  'settings.gbPad': ['ギターコントローラ(ゲームパッド)', 'Guitar Controller (Gamepad)'],
  'settings.gbPadNote': [
    'ギターコントローラやゲームパッドのボタン・スティック・十字キー(ストラムバー)を <b>R G B Y P / PICK / WAIL</b> と <b>START</b>(演奏開始・停止)に割り当てます。キーボードと同時に使えます。既定は Xbox 360 の Guitar Hero / Rock Band ギターの配置です(フレットの緑・赤・黄・青・オレンジを R G B Y P、ストラムの上下を PICK、チルトとスターパワーを WAIL)。ほかのコントローラは「＋ 追加」を押してから、ボタンを押すかスティック・ストラムバーを倒すと入ります(押したままのボタンは数えません)。ストラムの上下どちらでも弾くには、両方を PICK に入れます。ブラウザはボタンを押すまでゲームパッドを見せません。',
    'Assign the buttons, sticks and D-pad (strum bar) of a guitar controller or gamepad to <b>R G B Y P / PICK / WAIL</b> and <b>START</b> (start / stop). It works together with the keyboard. The default matches Xbox 360 Guitar Hero / Rock Band guitars (green, red, yellow, blue and orange frets to R G B Y P, strum up / down to PICK, tilt and Star Power to WAIL). For other controllers, press "＋ Add" and then press a button or move a stick / the strum bar (buttons that stay held are ignored). To pick with both strum directions, put both on PICK. Browsers show a gamepad only after you press one of its buttons.',
  ],
  'settings.gbBad': ['空ピックでコンボを切る(BAD)', 'Break the combo on a wrong pick (BAD)'],
  'settings.gbBadNote': [
    '押さえ方の違うピックやチップの無いところのピックで、コンボを切りゲージを減らします(DTXMania の Light を OFF にしたのと同じ。既定はしない)。',
    'A pick with the wrong buttons, or where there is no chip, breaks the combo and lowers the gauge (the same as turning Light OFF in DTXMania; off by default).',
  ],
  'settings.midi': ['電子ドラム(MIDI)', 'Electronic Drums (MIDI)'],
  'settings.midiNote': [
    'USB や MIDI インターフェースでつないだ電子ドラムで叩けます(PC の Chrome / Edge / Firefox。iPhone / iPad は Web MIDI 付きのブラウザアプリで)。'
      + '初期値は GM ドラムマップ。合わないパッドは <b>＋ 叩いて追加</b> を押してからパッドを叩くと、そのノートがレーンに入ります'
      + '(ほかのレーンにあったノートは移ります)。機種に合わせたプリセット(GITADORA と同じ表)もあります。'
      + '<b>下限</b> 以下の強さの打鍵は捨てます(クロストーク対策)。ノートを押すとそのノートだけのしきい値を変えられます。'
      + 'キーボードの割り当てとは別々で、どちらでも叩けます。',
    'Play with electronic drums connected by USB or a MIDI interface (Chrome / Edge / Firefox on a PC; on iPhone / iPad, a browser app with Web MIDI). '
      + 'The default is the GM drum map. For a pad that does not match, press <b>＋ Hit to add</b> and then hit the pad to put its note on that lane '
      + '(a note on another lane moves over). There are also presets for specific kits (the same table as GITADORA). '
      + 'Hits at or below the <b>Min</b> velocity are ignored (against crosstalk). Press a note to set a threshold for that note only. '
      + 'This is separate from the keyboard bindings; you can play with either.',
  ],
  'settings.preset': ['プリセット', 'Preset'],
  'settings.apply': ['適用', 'Apply'],
  'settings.presetNote': [
    'AUTO はつないだ機器の名前から選びます。MIDI だけを入れ替え、RD は空になります。',
    'AUTO picks one from the connected device name. Only the MIDI notes are replaced, and RD becomes empty.',
  ],
  'settings.sound': ['音', 'Sound'],
  'settings.masterVolume': ['マスター音量', 'Master Volume'],
  'settings.drumVolume': ['ドラム音量', 'Drum Volume'],
  'settings.bgmVolume': ['BGM 音量', 'BGM Volume'],
  'settings.gbVolume': ['ギター / ベース音量', 'Guitar / Bass Volume'],
  'settings.volumeNote': [
    '楽器の音量と BGM 音量は演奏中でもトレーニングメニューから変えられます。BGM 音量は弾いていない楽器(伴奏)の音にも効きます。',
    'Instrument and BGM volume can also be changed from the training menu while playing. BGM volume also applies to the instruments you are not playing (accompaniment).',
  ],
  'settings.latency': ['遅延補正(ms)', 'Latency Offset (ms)'],
  'settings.latencyNote': ['音が遅れて聞こえるなら + 方向', 'Use + if the sound seems late'],
  'settings.display': ['表示', 'Display'],
  'settings.showLag': ['判定のズレ(ms)を表示', 'Show timing error (ms)'],
  'settings.layout': ['画面の向き', 'Orientation'],
  'settings.layoutAuto': ['自動', 'Auto'],
  'settings.layoutLandscape': ['横(フル画面)', 'Landscape (full screen)'],
  'settings.layoutPortrait': ['縦(ハイウェイのみ)', 'Portrait (highway only)'],
  'settings.skin': ['スキン', 'Skin'],
  'settings.skinDefault': ['既定', 'Default'],
  'settings.skinFolder': ['フォルダを指定', 'From a folder'],
  'settings.skinFiles': ['画像を読み込む', 'Load images'],
  'settings.skinPath': ['フォルダ', 'Folder'],
  'settings.skinPick': ['画像 / ZIP を選ぶ', 'Choose Images / ZIP'],
  'settings.skinNote': [
    'スキンは chips.png / pads.png / score_panel.png / song_panel.png / gb_chips.png / gb_neck.png の 6 枚の画像です'
      + '(作り方は skins/README.md。gb_ の 2 枚はギター / ベースの画面)。'
      + 'フォルダは index.html からの相対パスで指定します。足りない画像は既定のスキンで補います。',
    'A skin is a set of 6 images: chips.png / pads.png / score_panel.png / song_panel.png / gb_chips.png / gb_neck.png '
      + '(see skins/README.md; the two gb_ images are for the guitar / bass screen). '
      + 'Give the folder as a path relative to index.html. Missing images fall back to the default skin.',
  ],
  'settings.groups': ['打ち分け(NX と同じ)', 'Lane Grouping (same as NX)'],
  'settings.hhGroup': ['HH グループ', 'HH Group'],
  'settings.hh0': ['0: 全部打ち分け', '0: All separate'],
  'settings.hh1': ['1: HH のみ共通', '1: HH only shared'],
  'settings.hh2': ['2: LC のみ', '2: LC only'],
  'settings.hh3': ['3: 全部共通', '3: All shared'],
  'settings.ftGroup': ['FT グループ', 'FT Group'],
  'settings.cyGroup': ['CY グループ', 'CY Group'],
  'settings.group0': ['0: 打ち分け', '0: Separate'],
  'settings.group1': ['1: 共通', '1: Shared'],
  'settings.bdGroup': ['BD グループ', 'BD Group'],
  'settings.bd1': ['1: BD と LBD', '1: BD & LBD'],
  'settings.bd2': ['2: 左右ペダルのみ', '2: Left/right pedals only'],
  'settings.bd3': ['3: どっちも BD', '3: Both as BD'],
  'settings.groupNote': [
    '譜面に LC が無ければ HH は共通、RD が無ければ CY は共通に自動で下がります。タッチの CY 列は常に RD も拾います。',
    'If the chart has no LC, HH falls back to shared; if it has no RD, CY falls back to shared. The CY column on touch always picks up RD too.',
  ],

  // ---- index.html: 操作方法 ----
  'help.summary': ['操作方法', 'How to Play'],
  'help.drums': ['ドラム', 'Drums'],
  'help.guitar': ['ギター / ベース', 'Guitar / Bass'],
  'help.guitarNote': [
    '(曲の一覧でギター・ベースの行から選ぶ。ネックのボタンを押さえて PICK で弾く)',
    '(choose from the Guitar / Bass rows of the song list; hold the neck buttons and press PICK)',
  ],
  'help.gbPadTitle': ['ギターコントローラ', 'Guitar controller'],
  'help.gbPadNote': [
    '(設定の「ギターコントローラ(ゲームパッド)」で割り当て。START で演奏開始・停止)',
    '(assign them under Guitar Controller (Gamepad) in the settings; START starts / stops)',
  ],
  'help.guitarPlay': [
    '<b>ギター / ベースの演奏</b>: チップは下から上へ流れ、画面上の判定ラインで弾きます(メニューの「リバース」で上から下へ、'
      + '「LEFT(左利き)」でボタンの並びを左右反転)。'
      + '和音は全部のボタンを押さえてから 1 回ピック。少しずれて押さえても、ピックの直後なら間に合います。'
      + '帯の付いたチップ(ロングノート)は押さえ続けると加点。ピックが当たった直後に WAIL でウェイリングの加点。'
      + 'タッチではレーンを押すとそのボタンを押さえて弾き、レーンの外を押すと OPEN。弾いていないパートとドラムは自動で鳴ります。',
    '<b>Playing guitar / bass</b>: chips rise from the bottom and are played at the judge line at the top (Reverse in the menu makes them fall, '
      + 'and Left (Lefty) mirrors the button order). '
      + 'For a chord, hold all its buttons and pick once; a button pressed just after the pick still counts. '
      + 'Keep holding a chip with a tail (long note) for bonus points. Press WAIL right after a successful pick for the wailing bonus. '
      + 'By touch, pressing a lane holds that button and picks; pressing outside the lanes picks OPEN. The other part and the drums play automatically.',
  ],
  'help.drumsNote': [
    '(設定のキー割り当てで変更。1 レーンに複数キーを割り当てられます)',
    '(change them in Settings → Key Bindings; each lane can have several keys)',
  ],
  'help.midi': [
    '<b>電子ドラム</b>: 設定の「電子ドラム(MIDI)」で「電子ドラムを使う」を押して開く。パッドの割り当ては叩いて登録するか、'
      + '機種のプリセットを適用。叩いたパッドの行き先は同じ欄のモニタで確かめられます。',
    '<b>Electronic drums</b>: In Settings → "Electronic Drums (MIDI)", press "Use E-Drums" to connect. Assign pads by hitting them, '
      + 'or apply the preset for your kit. The monitor in the same section shows where each hit goes.',
  ],
  'help.menu': [
    '<b>トレーニングメニュー</b>: ↑↓ 項目 / ←→ 変更(Ctrl で 10 段) / Enter 決定 / Esc 戻る・終了 / F1 AUTO 切替',
    '<b>Training menu</b>: ↑↓ item / ←→ change (Ctrl: 10 steps) / Enter select / Esc back · exit / F1 toggle AUTO',
  ],
  'help.seek': [
    '<b>譜面の確認</b>: 停止中・一時停止中は画面上部(ギター / ベースの横画面は判定ラインが上にあるので画面下部。リバースでは上部)のシークバーで前後に送れます。'
      + 'バーをドラッグ(離すと小節頭に吸着)、'
      + '◀ ▶ で 1 つ送り、◀◀ ▶▶ で 10 送り、バーの上でホイール。メニューの「現在位置」でも ←→ で送れます(Ctrl で 10 段)。'
      + '送った位置から「演奏開始」で始まります(「リスタート」は曲頭・ループ開始位置から)。',
    '<b>Browsing the chart</b>: While stopped or paused, move back and forth with the seek bar at the top (at the bottom for guitar / bass '
      + 'in landscape, whose judge line is at the top; at the top with Reverse). Drag it (it snaps to the nearest measure on release), '
      + '◀ ▶ step by 1, ◀◀ ▶▶ step by 10, or use the mouse wheel over it. "Position" in the menu also moves with ←→ (Ctrl: 10 steps). '
      + '"Start" begins from that position ("Restart" begins from the top of the song or the loop start).',
  ],
  'help.touch': [
    '<b>タッチ</b>: レーンの列をタップで打鍵。メニューは「☰ メニュー」から。値の行は ◀ ▶ で変更、動作の行はタップで実行。',
    '<b>Touch</b>: Tap a lane column to hit it. Open the menu with "☰". Change values with ◀ ▶; tap an action row to run it.',
  ],
  'help.items': [
    '<b>メニュー項目</b>: 自動演奏 / AUTO プリセット(ギター / ベースのみ) / 自動演奏詳細(レーン別・ボタン別 AUTO) / ノーツ表示調整 / '
      + '判定タイミング調整 / ハイスピード / 演奏速度 / 開始待ち時間 / ドラム音量(ギター / ベース音量) / BGM 音量 / メトロノーム / '
      + 'リバース・LEFT(左利き)・空ピックで BAD(ギター / ベースのみ) / ループ演奏 / ループ位置単位 / '
      + 'ループ終了位置 / ループ開始位置 / 現在位置 / 演奏開始・停止 / リスタート / 一時停止 / トレーニング終了',
    '<b>Menu items</b>: Auto Play / Auto Preset (guitar / bass only) / Auto Lanes (per-lane / per-button AUTO) / Visual Offset / '
      + 'Judge Offset / Hi-Speed / Play Speed / Start Delay / Drum Volume (Guitar / Bass Volume) / BGM Volume / Metronome / '
      + 'Reverse · Left (Lefty) · Wrong Pick = BAD (guitar / bass only) / Loop / Loop Unit / '
      + 'Loop End / Loop Start / Position / Start · Stop / Restart / Pause / Exit Training',
  ],
  'help.misc': [
    '待機中に叩くと音だけ鳴ります(ウォーミングアップ)。ループ区間の折り返しごとに開始待ち時間を置きます。成績はどこにも保存しません。',
    'Hitting while on standby only plays the sound (warm-up). The start delay is applied again each time the loop wraps around. Scores are never saved.',
  ],

  // ---- index.html: 演奏画面 ----
  'play.back': ['曲選択へ戻る', 'Back to song select'],
  'play.startStop': ['演奏開始 / 停止', 'Start / Stop'],
  'play.restart': ['リスタート', 'Restart'],
  'play.pause': ['一時停止 / 再開', 'Pause / Resume'],
  'play.fullscreen': ['全画面', 'Full screen'],
  'play.menu': ['トレーニングメニュー', 'Training menu'],
  'seek.prev10': ['10 戻る', 'Back 10'],
  'seek.prev': ['1 戻る', 'Back 1'],
  'seek.track': ['演奏位置', 'Play position'],
  'seek.next': ['1 進む', 'Forward 1'],
  'seek.next10': ['10 進む', 'Forward 10'],

  // ---- 共通 ----
  'common.none': ['なし', 'none'],
  'common.remove': ['外す', 'Remove'],
  'common.default': ['既定', 'Default'],
  'common.clear': ['解除', 'Clear'],
  'common.cancel': ['中止', 'Cancel'],
  'common.canceled': ['中止しました', 'Canceled'],
  'common.timeout': ['時間切れで中止しました', 'Timed out and canceled'],
  'common.undo': ['元に戻す', 'Undo'],
  'common.undone': ['元に戻しました', 'Undone'],
  'common.back': ['戻る', 'Back'],

  // ---- 読み込み(js/main.js・js/core) ----
  'load.fetching': ['ZIP を取得中… {url}', 'Fetching ZIP… {url}'],
  'load.fetchFailed': ['ZIP の取得に失敗しました: {msg}', 'Failed to fetch the ZIP: {msg}'],
  'load.zip': ['ZIP を読み込み中…', 'Loading ZIP…'],
  'load.folder': ['フォルダを読み込み中…', 'Loading folder…'],
  'load.failed': ['読み込みに失敗しました: {msg}', 'Failed to load: {msg}'],
  'load.noCharts': ['この ZIP には .dtx 譜面が見つかりませんでした。', 'No .dtx charts were found in this ZIP.'],
  'load.songCount': ['{name}: {n} 曲', '{name}: {n} {n|song|songs}'],
  'load.chart': ['譜面を読み込み中…', 'Loading chart…'],
  'load.sounds': ['音源を読み込み中… {done} / {total}', 'Loading sounds… {done} / {total}'],
  'load.soundsFailed': ['音源 {n} 個が読めません(合成音で代用)', '{n} {n|sound|sounds} could not be read (synthesized sounds used instead)'],
  'load.noPart': ['この譜面には{inst}のチップがありません', 'This chart has no {inst} chips'],

  // ---- 曲の一覧 ----
  'song.drums': ['ドラム', 'Drums'],
  'song.guitar': ['ギター', 'Guitar'],
  'song.bass': ['ベース', 'Bass'],
  'song.playLabel': ['{inst}の {label} を演奏', 'Play {label} on {inst}'],
  'zip.fileMissing': ['ZIP 内にファイルがありません: {path}', 'File not found in the ZIP: {path}'],
  'zip.chartMissing': ['譜面が見つかりません: {path}', 'Chart not found: {path}'],
  'zip.notZip': ['ZIP ファイルではありません(EOCD が見つかりません)', 'Not a ZIP file (EOCD not found)'],
  'zip.badCentralDir': ['ZIP のセントラルディレクトリが壊れています', 'The ZIP central directory is corrupted'],
  'zip.badLocalHeader': ['ZIP のローカルヘッダが壊れています: {name}', 'A ZIP local header is corrupted: {name}'],
  'zip.truncated': ['ZIP のデータが途中で切れています: {name}', 'The ZIP data is truncated: {name}'],
  'zip.encrypted': ['暗号化された ZIP は未対応です: {name}', 'Encrypted ZIPs are not supported: {name}'],
  'zip.aes': ['AES 暗号化された ZIP は未対応です: {name}', 'AES-encrypted ZIPs are not supported: {name}'],
  'zip.method': ['未対応の圧縮方式({method}): {name}', 'Unsupported compression method ({method}): {name}'],

  // ---- キー割り当てと MIDI の割り当てで共通の言い回し ----
  'assign.movedFrom': ['。{lanes} から移しました', '. Moved from {lanes}'],
  'assign.takenFrom': ['。{lanes} から取り上げました', '. Taken from {lanes}'],
  'assign.nowEmpty': ['({lanes} は割り当てなしになりました)', ' ({lanes} left unassigned)'],
  'assign.resetLabel': ['{lane} を既定({list})に戻す', 'Reset {lane} to the default ({list})'],
  'assign.resetDone': ['{lane} を既定({list})に戻しました', 'Reset {lane} to the default ({list})'],

  // ---- キー割り当て(js/main.js) ----
  'keys.rowLabel': ['{lane} のキー割り当て', 'Key bindings for {lane}'],
  'keys.chip': ['{lane} の {key}。Enter で差し替え、Delete で削除', '{key} on {lane}. Enter to replace, Delete to remove'],
  'keys.chipCapturing': [
    '{lane} の {key} を差し替え中。割り当てるキーを押してください',
    'Replacing {key} on {lane}. Press the key to assign',
  ],
  'keys.removeLabel': ['{lane} から {key} を外す', 'Remove {key} from {lane}'],
  'keys.add': ['＋ 追加', '＋ Add'],
  'keys.waiting': ['⌨ 入力待ち', '⌨ Press a key'],
  'keys.addLabel': ['{lane} にキーを追加 ({n}/{max})', 'Add a key to {lane} ({n}/{max})'],
  'keys.fullLabel': ['{lane} は上限の {max} キーです', '{lane} already has the maximum of {max} keys'],
  'keys.clearLabel': ['{lane} のキーをすべて外す', 'Remove all keys from {lane}'],
  'keys.resetAllDone': ['全レーンを既定に戻しました', 'Reset all lanes to the default'],
  'keys.leftyDone': ['左利き用の並び(R〜P = ; L K J H、PICK = F・D、WAIL = S)にしました', 'Switched to the lefty layout (R–P = ; L K J H, PICK = F / D, WAIL = S)'],
  'keys.repaired': [
    '{lanes} の設定が使えないキーだったので、割り当て直しました。確認してください。',
    'The saved keys for {lanes} could not be used, so they were reassigned. Please check them.',
  ],
  'keys.blur': ['ウィンドウを離れたため中止しました', 'Canceled because the window lost focus'],
  'keys.fullHint': [
    '{lane} は上限の {max} キーです。× でどれか外すか、キー名を押して差し替えてください。',
    '{lane} already has the maximum of {max} keys. Remove one with × or press a key name to replace it.',
  ],
  'keys.reserved': [
    '{key} はメニュー操作に使うため割り当てできません。別のキーを押してください。',
    '{key} is used for menu control and cannot be assigned. Press another key.',
  ],
  'keys.promptAdd': [
    '{lane} にキーを追加します。割り当てるキーを押してください(Esc で中止)',
    'Adding a key to {lane}. Press the key to assign (Esc to cancel)',
  ],
  'keys.promptReplace': [
    '{lane} の {key} を差し替えます。新しいキーを押してください(Esc で中止)',
    'Replacing {key} on {lane}. Press the new key (Esc to cancel)',
  ],
  'keys.already': ['{key} は {lane} に登録済みです。別のキーを押してください。', '{key} is already on {lane}. Press another key.'],
  'keys.same': ['変更ありません', 'No change'],
  'keys.full': ['{lane} は上限の {max} キーです。', '{lane} already has the maximum of {max} keys.'],
  'keys.unassignable': ['{key} は割り当てできません。', '{key} cannot be assigned.'],
  'keys.added': ['{lane} に {key} を追加しました ({n}/{max})', 'Added {key} to {lane} ({n}/{max})'],
  'keys.replaced': ['{lane} の {old} を {key} に差し替えました', 'Replaced {old} with {key} on {lane}'],
  'keys.swapped': ['。{other} には {old} を入れ替えました', '. {other} got {old} in exchange'],
  'keys.swappedInLane': ['(同じレーン内で入れ替え)', ' (swapped within the lane)'],
  'keys.removedEmpty': [
    '{lane} から {key} を外しました。{lane} は割り当てなしです(既定には戻りません)。',
    'Removed {key} from {lane}. {lane} now has no keys (it does not go back to the default).',
  ],
  'keys.removed': ['{lane} から {key} を外しました ({n}/{max})', 'Removed {key} from {lane} ({n}/{max})'],
  'keys.cleared': [
    '{lane} のキーをすべて外しました(既定には戻りません)',
    'Removed all keys from {lane} (it does not go back to the default)',
  ],

  // ---- 電子ドラム(js/main.js・js/ui/midipanel.js) ----
  'midi.repaired': [
    '{lanes} の MIDI 設定が読めなかったので、既定に戻しました。確認してください。',
    'The saved MIDI settings for {lanes} could not be read, so they were reset to the default. Please check them.',
  ],
  'pad.labelButton': ['B{n}', 'B{n}'],
  'pad.labelAxis': ['軸{n}{dir}', 'Axis{n}{dir}'],
  'pad.labelHat': ['ハット{n}{dir}', 'Hat{n}{dir}'],
  'pad.unsupported': ['このブラウザはゲームパッドを読めません(Chrome / Edge / Firefox で開いてください)', 'This browser cannot read gamepads (use Chrome, Edge or Firefox)'],
  'pad.none': ['ゲームパッドが見つかりません。つないでボタンを押すと見つかります。', 'No gamepad found. Connect one and press a button.'],
  'pad.devices': ['接続中: {list}', 'Connected: {list}'],
  'pad.nonStandard': [
    '(標準でない配置のものは、既定の割り当てが合わないので「＋ 追加」で割り当ててください)',
    ' (devices without the standard layout do not match the default; assign them with "＋ Add")',
  ],
  'pad.monitorEmpty': ['ボタンを押すと、ここに入力と行き先が出ます', 'Press a button to see the input and where it goes'],
  'pad.monitor': ['最後の入力: {code} → {lane}(#{index})', 'Last input: {code} → {lane} (#{index})'],
  'pad.monitorUnbound': ['最後の入力: {code}(割り当てなし。#{index})', 'Last input: {code} (not assigned, #{index})'],
  'pad.connectedToast': ['ゲームパッド: {names} をつなぎました', 'Gamepad: {names} connected'],
  'pad.disconnectedToast': ['ゲームパッド: {names} が外れました', 'Gamepad: {names} disconnected'],
  'pad.rowLabel': ['{lane} のゲームパッドの割り当て', 'Gamepad bindings for {lane}'],
  'pad.chipCapturing': ['{lane} の {key} を差し替え中。割り当てる入力を押してください', 'Replacing {key} on {lane}. Press the input to assign'],
  'pad.waiting': ['… 入力待ち', '… Press a button'],
  'pad.addLabel': ['{lane} に入力を追加 ({n}/{max})', 'Add an input to {lane} ({n}/{max})'],
  'pad.fullLabel': ['{lane} は上限の {max} 個です', '{lane} already has the maximum of {max} inputs'],
  'pad.clearLabel': ['{lane} の入力をすべて外す', 'Remove all inputs from {lane}'],
  'pad.fullHint': [
    '{lane} は上限の {max} 個です。× でどれか外すか、入力の名前を押して差し替えてください。',
    '{lane} already has the maximum of {max} inputs. Remove one with × or press an input name to replace it.',
  ],
  'pad.promptAdd': [
    '{lane} に入力を追加します。コントローラのボタンを押すか、スティック・ストラムバーを倒してください(Esc で中止)',
    'Adding an input to {lane}. Press a button or move a stick / the strum bar on the controller (Esc to cancel)',
  ],
  'pad.promptReplace': [
    '{lane} の {key} を差し替えます。新しい入力を押してください(Esc で中止)',
    'Replacing {key} on {lane}. Press the new input (Esc to cancel)',
  ],
  'pad.already': ['{key} は {lane} に登録済みです。別の入力を押してください。', '{key} is already on {lane}. Press another input.'],
  'pad.full': ['{lane} は上限の {max} 個です。', '{lane} already has the maximum of {max} inputs.'],
  'pad.removedEmpty': [
    '{lane} から {key} を外しました。{lane} は割り当てなしです(既定には戻りません)。',
    'Removed {key} from {lane}. {lane} now has no inputs (it does not go back to the default).',
  ],
  'pad.cleared': ['{lane} の入力をすべて外しました(既定には戻りません)', 'Removed all inputs from {lane} (it does not go back to the default)'],
  'pad.repaired': [
    'ギターコントローラの {lanes} の設定が読めなかったので、既定に戻しました。確認してください。',
    'The saved gamepad inputs for {lanes} could not be read, so they were reset to the default. Please check them.',
  ],
  'midi.connectedToast': ['MIDI: {names} をつなぎました', 'MIDI: {names} connected'],
  'midi.disconnectedToast': ['MIDI: {names} が外れました', 'MIDI: {names} disconnected'],
  'midi.rowLabel': ['{lane} の MIDI 割り当て', 'MIDI assignments for {lane}'],
  'midi.min': ['下限', 'Min'],
  'midi.minTitle': [
    'このレーンの MIDI ベロシティの下限。これ以下の強さの打鍵は捨てる(0〜127。クロストーク対策。既定は HH だけ 20)',
    'Minimum MIDI velocity for this lane. Hits at or below it are ignored (0–127; against crosstalk; the default is 20 for HH only)',
  ],
  'midi.minLabel': ['{lane} のベロシティ下限', 'Minimum velocity for {lane}'],
  'midi.chipTitle': ['このノートだけのしきい値を変える', 'Change the threshold for this note only'],
  'midi.chipTitleNamed': ['{name}。このノートだけのしきい値を変える', '{name}. Change the threshold for this note only'],
  'midi.chipLabel': ['{lane} のノート {note}。押すとしきい値を変更', 'Note {note} on {lane}. Press to change its threshold'],
  'midi.chipLabelOwn': [
    '{lane} のノート {note}。しきい値 {th}。押すとしきい値を変更',
    'Note {note} on {lane}. Threshold {th}. Press to change its threshold',
  ],
  'midi.removeLabel': ['{lane} からノート {note} を外す', 'Remove note {note} from {lane}'],
  'midi.add': ['＋ 叩いて追加', '＋ Hit to add'],
  'midi.hitNow': ['🥁 叩いてください', '🥁 Hit a pad'],
  'midi.capturingLabel': ['{lane} に登録するパッドを叩いてください', 'Hit the pad to assign to {lane}'],
  'midi.fullLabel': ['{lane} は上限の {max} ノートです', '{lane} already has the maximum of {max} notes'],
  'midi.addLabel': ['{lane} にパッドを叩いて追加 ({n}/{max})', 'Hit a pad to add it to {lane} ({n}/{max})'],
  'midi.resetTitle': ['GM ドラムマップの {list} に戻す', 'Reset to {list} from the GM drum map'],
  'midi.clearLabel': ['{lane} の MIDI をすべて外す', 'Remove all MIDI notes from {lane}'],
  'midi.thTitle': ['ノート {note} のしきい値', 'Threshold for note {note}'],
  'midi.thDown': ['しきい値を下げる(Ctrl で 10)', 'Lower the threshold (Ctrl: by 10)'],
  'midi.thUp': ['しきい値を上げる(Ctrl で 10)', 'Raise the threshold (Ctrl: by 10)'],
  'midi.thLane': ['> {min}(レーンの下限)', '> {min} (lane minimum)'],
  'midi.thReset': ['レーンの下限に戻す', 'Use the lane minimum'],
  'midi.thHint': [
    'この強さ以下の打鍵を捨てる。Ctrl+クリックで 10 ずつ。0 より下げるとレーンの下限に従う',
    'Hits at or below this velocity are ignored. Ctrl+click for steps of 10. Going below 0 follows the lane minimum',
  ],
  'midi.unsupportedHttp': [
    'http の LAN アドレス(localhost 以外)で開いたページでは Web MIDI を使えません(HTTPS か localhost に限られる)。'
      + 'PC なら http://localhost:… で開いてください。'
      + 'iPhone / iPad は Safari も Chrome も非対応なので、Web MIDI 付きのブラウザアプリ(Web MIDI Browser など)で開いてください。',
    'Web MIDI is not available on a page opened from an http LAN address (other than localhost); it needs HTTPS or localhost. '
      + 'On a PC, open it as http://localhost:… instead. '
      + 'On iPhone / iPad neither Safari nor Chrome supports it, so open it in a browser app with Web MIDI (such as Web MIDI Browser).',
  ],
  'midi.unsupported': [
    'このブラウザは Web MIDI に対応していません。PC の Chrome / Edge / Firefox で開いてください(Safari は非対応)。'
      + 'iPhone / iPad は Safari も Chrome も非対応なので、Web MIDI 付きのブラウザアプリ(Web MIDI Browser など)で開いてください。',
    'This browser does not support Web MIDI. Open it in Chrome / Edge / Firefox on a PC (Safari is not supported). '
      + 'On iPhone / iPad neither Safari nor Chrome supports it, so open it in a browser app with Web MIDI (such as Web MIDI Browser).',
  ],
  'midi.connect': ['電子ドラムを使う', 'Use E-Drums'],
  'midi.stateOff': [
    '未接続。押すとブラウザが MIDI 機器の使用許可を尋ねます。',
    'Not connected. Pressing it makes the browser ask for permission to use MIDI devices.',
  ],
  'midi.connecting': ['接続中…', 'Connecting…'],
  'midi.stateRequesting': [
    'ブラウザが MIDI 機器の使用許可を尋ねていたら「許可」を押してください。',
    'If the browser asks for permission to use MIDI devices, press "Allow".',
  ],
  'midi.retry': ['もう一度試す', 'Try Again'],
  'midi.stateDenied': [
    'MIDI 機器の使用が許可されていません。アドレスバー左のサイト設定で MIDI を許可してから押してください。',
    'Permission to use MIDI devices was denied. Allow MIDI in the site settings (left of the address bar), then press it again.',
  ],
  'midi.stateError': ['MIDI を開けませんでした: {error}', 'Could not open MIDI: {error}'],
  'midi.reconnect': ['開き直す', 'Reconnect'],
  'midi.stateReady': ['{open} / {found} 台を開いています。', '{open} of {found} {found|device|devices} open.'],
  'midi.stateNoDevice': [
    'MIDI 機器が見つかりません。電子ドラムをつないで電源を入れてください(つなげば自動で開きます)。',
    'No MIDI devices found. Connect your electronic drums and turn them on (they open automatically once connected).',
  ],
  'midi.devFailed': [
    '(開けません。DTXMania などほかのアプリが使っていないか確認してください)',
    ' (cannot open; make sure no other app such as DTXMania is using it)',
  ],
  'midi.devOpening': ['(開いています…)', ' (opening…)'],
  'midi.devHits': ['   打鍵 {n}', '   hits {n}'],
  'midi.devLast': ['   最後 note {note} vel {vel}', '   last note {note} vel {vel}'],
  'midi.presetAuto': ['AUTO({name})', 'AUTO ({name})'],
  'midi.monitorEmpty': ['入力: (まだ届いていません)', 'Input: (nothing received yet)'],
  'midi.monitor': ['入力: {hits}', 'Input: {hits}'],
  'midi.weak': ['(弱)', '(weak)'],
  'midi.fullHint': ['{lane} は上限の {max} ノートです。× でどれか外してください。', '{lane} already has the maximum of {max} notes. Remove one with ×.'],
  'midi.opening': ['MIDI 機器を開いています…', 'Opening MIDI devices…'],
  'midi.cannotCapture': [
    'MIDI 機器を開けないため登録できません(上の表示を確認してください)。',
    'Cannot assign because the MIDI devices could not be opened (see the message above).',
  ],
  'midi.prompt': [
    '{lane} に登録するパッドを叩いてください(Esc で中止。1 打で複数のノートが届いたらいちばん強いものを登録します)',
    'Hit the pad to assign to {lane} (Esc to cancel; if one hit sends several notes, the strongest one is used)',
  ],
  'midi.already': ['ノート {note} は {lane} に登録済みです(v{vel} で届きました)', 'Note {note} is already on {lane} (received at v{vel})'],
  'midi.full': ['{lane} は上限の {max} ノートです。', '{lane} already has the maximum of {max} notes.'],
  'midi.invalid': ['ノート {note} は登録できません。', 'Note {note} cannot be assigned.'],
  'midi.added': ['{lane} にノート {note} を登録しました(v{vel}、{n}/{max})', 'Assigned note {note} to {lane} (v{vel}, {n}/{max})'],
  'midi.removedEmpty': [
    '{lane} からノート {note} を外しました。{lane} は MIDI の割り当てなしです(既定には戻りません)。',
    'Removed note {note} from {lane}. {lane} now has no MIDI notes (it does not go back to the default).',
  ],
  'midi.removed': ['{lane} からノート {note} を外しました', 'Removed note {note} from {lane}'],
  'midi.cleared': [
    '{lane} の MIDI をすべて外しました(既定には戻りません)',
    'Removed all MIDI notes from {lane} (it does not go back to the default)',
  ],
  'midi.resetAllDone': [
    '全レーンを既定(GM ドラムマップ。下限は HH だけ 20)に戻しました',
    'Reset all lanes to the default (GM drum map; minimum 20 for HH only)',
  ],
  'midi.presetApplied': [
    'プリセット「{name}」を適用しました。キーボードの割り当てはそのままです。'
      + 'RD は空になります(RD のチップは打ち分けの CY グループを「共通」にすると CY のパッドで叩けます)。',
    'Applied the preset "{name}". The keyboard bindings are unchanged. '
      + 'RD is now empty (set CY Group under Lane Grouping to "Shared" to hit RD chips with the CY pad).',
  ],
  'midi.minSet': [
    '{lane} の下限を {v} にしました({v} 以下の強さの打鍵を捨てます)',
    'Set the minimum for {lane} to {v} (hits at or below {v} are ignored)',
  ],
  'midi.thFollow': ['ノート {note} はレーンの下限({min})に従います', 'Note {note} now follows the lane minimum ({min})'],
  'midi.thSet': ['ノート {note} は強さ {th} 以下を捨てます', 'Note {note} now ignores hits at or below {th}'],

  // ---- スキン(js/main.js) ----
  'skin.noneFound': [
    'スキンの画像(chips.png / pads.png / score_panel.png / song_panel.png / gb_chips.png / gb_neck.png)が見つかりませんでした。',
    'No skin images (chips.png / pads.png / score_panel.png / song_panel.png / gb_chips.png / gb_neck.png) were found.',
  ],
  'skin.notStored': [
    '画像をブラウザに保存できなかったので、リロードすると読み込み直しになります。',
    'The images could not be stored in the browser, so you will need to load them again after a reload.',
  ],
  'skin.loaded': ['読み込み済み: {names}', 'Loaded: {names}'],
  'skin.notLoaded': ['まだ読み込んでいません', 'Nothing loaded yet'],
  'skin.untilLoaded': ['画像を読み込むまでは既定のスキンで描きます。', 'The default skin is used until images are loaded.'],
  'skin.missingFolder': [
    '{path} に {files} が無いので、その部分は既定のスキンで描いています。',
    '{files} not found in {path}; the default skin is used for those parts.',
  ],
  'skin.missingFiles': [
    '読み込んだ画像に {files} が無いので、その部分は既定のスキンで描いています。',
    'The loaded images lack {files}; the default skin is used for those parts.',
  ],

  // ---- 演奏画面(js/game/player.js・js/ui/renderer.js) ----
  'play.hintPortrait': ['メニューから「演奏開始」', 'Choose "Start" in the menu'],
  'play.hintLandscape': ['メニューの「演奏開始」(Enter)で開始', 'Choose "Start" (Enter) in the menu to begin'],
  'play.achievement': ['達成率', 'Achievement'],
  'play.toLoop': ['ループ区間へ', 'Moved into the loop range'],
  'play.beforeEnd': ['曲末より前から始めます', 'Starting before the end of the song'],
  'play.recount': ['成績をここから数え直します', 'The score is counted again from here'],

  // ---- トレーニングメニュー(js/ui/menu.js・js/game/training.js) ----
  // 元実装の名前は日本語だけなので、英語は本アプリで付けたもの
  'menu.autoPlay': ['自動演奏', 'Auto Play'],
  'menu.autoDetail': ['自動演奏詳細', 'Auto Lanes'],
  'menu.noteOffset': ['ノーツ表示調整', 'Visual Offset'],
  'menu.judgeOffset': ['判定タイミング調整', 'Judge Offset'],
  'menu.hiSpeed': ['ハイスピード', 'Hi-Speed'],
  'menu.playSpeed': ['演奏速度', 'Play Speed'],
  'menu.startWait': ['開始待ち時間', 'Start Delay'],
  'menu.drumVolume': ['ドラム音量', 'Drum Volume'],
  'menu.bgmVolume': ['BGM 音量', 'BGM Volume'],
  'menu.guitarVolume': ['ギター音量', 'Guitar Volume'],
  'menu.bassVolume': ['ベース音量', 'Bass Volume'],
  'menu.reverse': ['リバース', 'Reverse'],
  'menu.left': ['LEFT(左利き)', 'Left (Lefty)'],
  'menu.autoPreset': ['AUTO プリセット', 'Auto Preset'],
  'menu.presetNeck': ['ネック', 'Neck'],
  'menu.presetPick': ['ピック', 'Pick'],
  'menu.presetCustom': ['カスタム', 'Custom'],
  'menu.metronome': ['メトロノーム', 'Metronome'],
  'menu.gbBad': ['空ピックで BAD', 'Wrong Pick = BAD'],
  'menu.loop': ['ループ演奏', 'Loop'],
  'menu.loopUnit': ['ループ位置単位', 'Loop Unit'],
  'menu.loopEnd': ['ループ終了位置', 'Loop End'],
  'menu.loopBegin': ['ループ開始位置', 'Loop Start'],
  'menu.position': ['現在位置', 'Position'],
  'menu.start': ['演奏開始', 'Start'],
  'menu.stop': ['演奏停止', 'Stop'],
  'menu.restart': ['リスタート', 'Restart'],
  'menu.pause': ['一時停止', 'Pause'],
  'menu.resume': ['再開', 'Resume'],
  'menu.quit': ['トレーニング終了', 'Exit Training'],
  'menu.back': ['戻る', 'Back'],
  'menu.all': ['すべて', 'All'],
  'menu.none': ['なし', 'None'],
  'menu.manual': ['手動', 'Manual'],
  'menu.lanes': ['{n} レーン', '{n} {n|lane|lanes}'],
  'menu.buttons': ['{n} ボタン', '{n} {n|button|buttons}'],
  'menu.loopInvalid': ['ON (無効)', 'ON (invalid)'],
  'menu.unitMeasure': ['小節', 'Measure'],
  'menu.unitSecond': ['秒', 'Second'],
  'menu.measure': ['{n} 小節', 'Measure {n}'],
  'menu.autoHeader': ['TRAINING - 自動演奏詳細', 'TRAINING - Auto Lanes'],
  'menu.footer': ['↑↓ 選択   ←→ 変更(Ctrl:x10)<br>Enter 決定   Esc 終了', '↑↓ Select   ←→ Change (Ctrl: x10)<br>Enter OK   Esc Exit'],
  'menu.decrease': ['減らす', 'Decrease'],
  'menu.increase': ['増やす', 'Increase'],
};

let current = DEFAULT_LANG;

export function getLang() {
  return current;
}

/** 言語を切り替える(知らない値なら既定の日本語)。保存と画面の書き直しは呼ぶ側(js/main.js)。 */
export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  return current;
}

/** 起動時の言語。URL の ?lang= → 保存した値 → 日本語。index.html の <head> のスクリプトと同じ順。 */
export function initialLang(search, stored) {
  let q = null;
  try { q = new URLSearchParams(search || '').get('lang'); } catch (e) { /* 壊れた URL は無視 */ }
  if (LANGS.includes(q)) return q;
  if (LANGS.includes(stored)) return stored;
  return DEFAULT_LANG;
}

const PLURAL_RE = /\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g;
const VAR_RE = /\{(\w+)\}/g;

/** キーの文言を今の言語で返す。vars の {name} を置き換える。知らないキーはキーそのもの。 */
export function t(key, vars) {
  const pair = STRINGS[key];
  if (!pair) {
    console.warn('i18n: 未定義のキー', key);
    return key;
  }
  let s = pair[LANGS.indexOf(current)];
  if (vars) {
    s = s.replace(PLURAL_RE, (m, k, one, many) => (k in vars ? (Number(vars[k]) === 1 ? one : many) : m));
    s = s.replace(VAR_RE, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return s;
}

/** root の中の data-i18n* の付いた要素を今の言語に書き換える。 */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}
