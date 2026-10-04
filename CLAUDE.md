# DTXMania Web(旧称 DTXMania Dojo)

DTX 譜面をブラウザで練習する Web アプリ。素の ES Modules + Canvas、ビルド依存なし。
2026-10 に公開に合わせて DTXMania Dojo から改名した。画面と文書の名前だけを変え、フォルダ名・GitHub の開発用リポジトリ名と、
内部の識別子(`window.dojo`、localStorage の `dojo.*`、IndexedDB の `dtxmania-dojo`、`dist/dojo.bundle.js`)は
保存済みの設定を引き継ぐため旧名のまま。
移植元は DTXManiaAI(トレーニングモード)と vid2dtx(譜面プレビューのレイアウト)。

## 一次資料は docs/spec

`docs/spec/*.md` は元実装から抽出した挙動仕様で、移植の根拠。判定窓・スコア式・音量・
メニュー項目・既定キーなどの「なぜこの値か」はここに書いてある。実装を変える前に該当節を読み、
仕様と違えるなら理由をコードのコメントか docs に残すこと。元実装に無い追加機能はその旨を明記する
(例: トレーニングメニューの「ドラム音量」「BGM 音量」「現在位置」)。

## テスト

Node は入っていない。テストはブラウザで動かす。

```
python -m http.server 8765 --bind 127.0.0.1
```

`http://localhost:8765/tests/index.html` を開く。結果は DOM と `window.__testResults` に出る
(`{done, total, failed, results}`)。新しいテストファイルは `tests/index.html` に import を足す。

電子ドラム(Web MIDI)の実機が無いときは、アプリのページで
`dojo.midi.handleMessage([0x99, 38, 100], performance.now())` のようにメッセージを流し込めば、
演奏中なら判定へ、設定パネルを開いていればモニタと「叩いて追加」へ届く。

## ビルド(file:// のときだけ必要)

HTTP 配信なら `js/` をそのまま読むのでビルドは不要。`index.html` を file:// で直接開くときだけ
`dist/dojo.bundle.js` が要る。

```
build.bat
```

**`dist/dojo.bundle.js` は git 管理外。** 生成物を追跡していた頃は、並行セッションが必ず触るので
毎回衝突し、しかも git のテキスト統合が「どちらの正しい出力でもないファイル」を黙って作っていた。
コミットしないこと。file:// で確認するときは自分で `build.bat` を実行する。

`assets/`(スキン画像・音)と `tests/fixtures/local/`(実曲パック)も管理外。
検証でコピーしてきても、コミットに含めない。

## 公開(GitHub Pages)

`main` の直下を GitHub Pages で <https://skillhunter184.github.io/DTXMania-Web/> に配信している。
**`main` を push すると 1〜2 分でそのまま公開ページに出る。** テストが通っていない `main` を push しない。
公開ページは `/DTXMania-Web/` の下にあるのでパスは相対で書き、直下の `.nojekyll` は消さない
(詳細は README の「公開(GitHub Pages)」)。

## 並行セッションの扱い

このリポジトリは worktree を切った複数セッションが同時に動くことがある。

- **作業を始める前に main の位置を確認する**(`git -C <repo> log --oneline -1`)。
- **マージ前にもう一度確認する。** `git merge --ff-only` が通らなければ、自分のブランチを
  `git rebase main` してから ff する。先に進んでいた側を巻き戻さない。
- **リベース / マージのあとは必ずテストを回し直す。** ファイルが重ならなくても、相手の変更で
  自分の前提が崩れることがある(例: ハイウェイが全画面化され、画面下端に置いていた
  シークバーが判定ラインを覆った)。これはツールでは防げないので、こまめに main に合わせて
  差分を小さく保つ。

## 細かい約束

- コメントとコミットメッセージは日本語。周囲の密度に合わせる。
- `Space` は BD の既定キーなので、UI の決定キーに使わない(決定は `Enter`)。
- 画面に出す文言は `js/i18n.js` の `STRINGS` に `[日本語, 英語]` で足し、`t('キー')` で引く(index.html は日本語を書いたまま
  `data-i18n` などでキーを付ける)。index.html の日本語を変えたら `STRINGS` も揃え、隣の英語も直す(`tests/i18n.test.js` が
  突き合わせる)。console にだけ出す文言は訳さない。既定の言語は日本語。
- 演奏中にアプリが消費するキー(矢印 / Enter / NumpadEnter / Esc / F1)はレーンに割り当てられない
  (`js/ui/keybind.js` の `RESERVED_CODES`)。増やすときは両方を合わせる。
- 時計は「譜面時刻を不変にして時計の進み方を変える」モデル。詳細は `docs/architecture.md`。
- 絵はスキンの画像(6 枚の組。ドラムの 4 枚とギター / ベースの 2 枚。`skins/README.md`)で描く。既定のスキン `skins/default/` は `tools/skinart/` の描画から
  `python tools/make_skin.py` で作る画像で、絵を変えたら画像も作り直してコミットする。アプリは描画コードを読まない。
  画像の決まり(名前・配置・数を重ねる位置)を変えるときは `js/ui/skin.js` の `SKIN_PARTS`・`skins/README.md`・
  `tools/skinart/` を揃える。
- **手元の DrumGame スキン(`assets/skin/`)はゲーム画面由来なので、既定のスキンに写さない**(画素を測ってなぞらない)。
  なぞっていた旧版の描画はメインのチェックアウトの `assets/skinart-original/` に退避してある(git 管理外)。
- 公開しているので、第三者の素材(実曲パックの音・譜面・画像)をコミットしない。テスト用の音や ZIP は
  `tools/make_fixtures.py` で合成する。移植したコードのライセンス表示は `THIRD_PARTY_NOTICES.md`。
