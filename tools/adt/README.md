# 音から譜面の打点のモデル(学習)

`js/gen/adtweights.js`(「曲の音から譜面を作る」の打点のモデルの重み)を作る手順。仕様と、学習に使ったデータの許諾は
[docs/spec/vid2dtx-gen.md](../../docs/spec/vid2dtx-gen.md) §6.1 と [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
データ・学習の途中の重みは git に入れない(下の `D:/adtdata` は例)。PyTorch(CUDA)・numpy・scipy・soundfile・pretty_midi・
requests が要る(作者は vid2dtx の ADT 用の venv で回した)。GPU の計算の順で、作り直した重みの値は少し変わる。

| ファイル | 役目 |
|---|---|
| `common.py` | 入力(スペクトログラム → 対数の帯域)とモデル(小さな CRNN)。`js/gen/adtmodel.js` と同じ計算 |
| `fetch_egmd.py` | E-GMD(CC BY 4.0)の一部を、90 GB の ZIP の中から範囲指定で落とす(9 GB) |
| `prepare_egmd.py` | 落とした E-GMD を 1 本の int16 の並びと打点の索引にまとめる。音のずれた録音を除く |
| `accomp.py` | 学習用の伴奏を合成する(このファイルの合成の楽器と NSynth の音。第三者の曲は使わない) |
| `kitdump.html` / `render_appkit.py` | 本アプリの合成のドラムの音で E-GMD の演奏を鳴らした音を作る |
| `train.py` | 学習(伴奏を混ぜる・音を変えるのは GPU の上で) |
| `refs.html` / `eval_ckpt.py` | 手元の確かめの曲(`tests/fixtures/local/audio/`。git 管理外)で打点の F を測る |
| `export.py` | 重みを `js/gen/adtweights.js` に、JS との突き合わせの値を `tests/fixtures/adt_check.json` に書き出す |

```
python tools/adt/fetch_egmd.py D:/adtdata/egmd
python tools/adt/prepare_egmd.py D:/adtdata/egmd D:/adtdata/work
```

NSynth の valid と test(<http://download.magenta.tensorflow.org/datasets/nsynth/nsynth-valid.jsonwav.tar.gz>・
`nsynth-test.jsonwav.tar.gz`。CC BY 4.0)を `D:/adtdata/nsynth/` に展開してから:

```
python tools/adt/accomp.py D:/adtdata/work D:/adtdata/nsynth
```

`python -m http.server 8765 --bind 127.0.0.1` で配信し、`http://localhost:8765/tools/adt/kitdump.html` で `appkit.json` を保存して:

```
python tools/adt/render_appkit.py D:/adtdata/egmd D:/adtdata/work D:/adtdata/appkit.json
python tools/adt/train.py D:/adtdata/work D:/adtdata/run2 --steps 20000
python tools/adt/train.py D:/adtdata/work D:/adtdata/run6 --steps 6000 --lr 5e-4 --appkit --init D:/adtdata/run2/last.pt --ema 0.999
python tools/adt/export.py D:/adtdata/run6/last.pt js/gen/adtweights.js --thr KD=0.2,SD=0.3,TT=0.25,HH=0.05,CY=0.02 --check tests/fixtures/adt_check.json
```

手元の曲で測るときは、`tests/fixtures/local/audio/` に `<名前>.ogg` と `<名前>.dtx` を置き、`http://localhost:8765/tools/adt/refs.html`
で保存した `ref.json` も同じ所に置いて、`train.py` に `--eval-dir tests/fixtures/local/audio` を付けるか
`python tools/adt/eval_ckpt.py <重み>.pt tests/fixtures/local/audio`(クラスごとに一番よいしきい値も出す)。
曲の音・譜面・それで測った途中の結果はコミットしない(結果の数だけを仕様書に書く)。
