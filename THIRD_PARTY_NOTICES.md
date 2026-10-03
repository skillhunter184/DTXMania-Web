# 第三者の著作物とライセンス

> This repository contains code derived from DTXMania (DTXManiaNX) and libbjxa.
> Their copyright notices and licenses are reproduced below.
> The repository is licensed under the MIT License ([LICENSE](LICENSE)), except that
> `js/core/xa.js` and `tools/make_fixtures.py` are licensed under LGPL-2.1-or-later
> ([LICENSES/LGPL-2.1.txt](LICENSES/LGPL-2.1.txt)), not under the MIT License.

このリポジトリのコードは MIT ライセンス([LICENSE](LICENSE))で配布する。ただし `js/core/xa.js` と
`tools/make_fixtures.py` は LGPL-2.1-or-later で、MIT ではない(下の「libbjxa」の節)。
<!-- LICENSE には MIT の本文だけを置く。GitHub はファイル全体が MIT の雛形と一致しないとライセンスを
     「NOASSERTION」と表示するので、例外の注記はこのファイルに書く。 -->
DTXMania Web は非公式のファンメイドのアプリで、DTXMania の各プロジェクトや株式会社コナミデジタルエンタテインメントとは
関係がない(名前の DTXMania は、遊べる譜面の形式と移植元を表すもの)。

## DTXMania(DTXManiaNX)

譜面(`.dtx` / `set.def`)の読み込みとタイミング計算、判定・スコア・ゲージ・達成率、演奏画面の状態の扱いは、
[DTXManiaNX](https://github.com/limyz/DTXmaniaNX) を作者が Unity に移植した DTXManiaAI から、さらに移植したもの
(主に `js/core/` と `js/game/`)。DTXManiaNX 同梱の `Runtime/Licenses/dtxmania.txt` の許諾に従い、著作権表示と許諾文を載せる。

```
DTXMania 使用許諾
Copyright (C) 2000 2010 DTXMania Group

以下に定める条件に従い、本ソフトウェアおよび関連文書のファイル
（以下「ソフトウェア」）の複製を取得するすべての人に対し、
ソフトウェアを無制限に扱うことを無償で許可します。
これには、ソフトウェアの複製を使用、複写、変更、結合、掲載、頒布、
サブライセンス、および/または販売する権利、およびソフトウェアを
提供する相手に同じことを許可する権利も無制限に含まれます。

上記の著作権表示および本許諾表示を、ソフトウェアのすべての複製
または重要な部分に記載するものとします。

ソフトウェアは「現状のまま」で、明示であるか暗黙であるかを問わず、
何らの保証もなく提供されます。ここでいう保証とは、商品性、特定の
目的への適合性、および権利非侵害についての保証も含みますが、それに
限定されるものではありません。
作者または著作権者は、契約行為、不法行為、またはそれ以外であろうと、
ソフトウェアに起因または関連し、あるいはソフトウェアの使用または
その他の扱いによって生じる一切の請求、損害、その他の義務について
何らの責任も負わないものとします。
```

## libbjxa(`js/core/xa.js`、`tools/make_fixtures.py`)

`.xa`(KWD1 / bjXA ADPCM)の復号は libbjxa と同じ手順で、その系統の実装(DTXManiaCX の XaDecoder.cs、
vid2dtx の xa.py)を移植して書いた。libbjxa は GPL-3.0-or-later と LGPL-2.1-or-later のどちらかを選べるので、
この 2 ファイルは **LGPL-2.1-or-later** とする(全文は [LICENSES/LGPL-2.1.txt](LICENSES/LGPL-2.1.txt))。
`tools/make_fixtures.py` はテスト用の `.xa` を作る符号化器と、期待値を作る復号器を含む。

```
Copyright (C) 2018-2019  Dridi Boukelmoune

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Alternatively, you can also redistribute this library and/or
modify it under the terms of the GNU Lesser General Public
License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version.

This library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
Lesser General Public License for more details.
```

`dist/dojo.bundle.js`(`build.bat` で作る束ね版)には `js/core/xa.js` がそのまま入る。差し替えるときは `js/core/xa.js` を
書き換えて束ね直せばよい。

## 実行時に読み込むもの(同梱しない)

- [@wasm-audio-decoders/ogg-vorbis](https://github.com/eshaz/wasm-audio-decoders) 0.1.20(Ethan Halsall、MIT)。
  Ogg Vorbis をネイティブで復号できないブラウザ(iOS Safari)のときだけ jsDelivr から読み込む(`js/core/audio.js`)。

## リポジトリに含めていないもの

- `assets/`(手元のスキン・ドラム音)。同梱の既定のスキン `skins/default/` の画像は、このリポジトリで描いた独自のデザイン
  (`tools/skinart/` の描画から作ったもの)で、ほかのファイルと同じ MIT。
- `tests/fixtures/local/`(実曲パック)。
- `tests/fixtures/` の音と ZIP はすべて `tools/make_fixtures.py` で合成したもの。`demo_*.dtx` は DTXManiaAI のテスト譜面。

## 商標

GITADORA は株式会社コナミデジタルエンタテインメントの商標。このアプリの説明やコードでは、レーンの並びや
電子ドラムのプリセットが何に合わせたものかを示すためにだけ名前を使っている。
