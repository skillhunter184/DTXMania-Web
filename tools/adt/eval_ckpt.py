"""学習したモデルの打点を手元の曲で測る(しきい値をクラスごとに振る)。

    python tools/adt/eval_ckpt.py D:/adtdata/run1/last.pt tests/fixtures/local/audio

曲は git 管理外(tests/fixtures/local/)。ref.json は正解の時刻(tests/fixtures/local/audio/ref.html が書き出す)。
しきい値は 3 曲まとめて一番よい値(クラスごと)と、0.5 の両方を出す。
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from common import CLASSES, ADTNet, Frontend  # noqa: E402
from train import activations, eval_songs, load_song  # noqa: E402

GRID = [0.02, 0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]


def main(ckpt, d, songs=None):
    ck = torch.load(ckpt, map_location="cpu")
    m = ADTNet(tuple(ck["ch"]), ck["hidden"])
    m.load_state_dict(ck["model"])
    m.eval()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m.to(dev)
    fe = Frontend().to(dev)
    refs = json.load(open(os.path.join(d, "ref.json")))
    names = songs or list(refs)
    acts = {s: activations(m, fe, load_song(os.path.join(d, s + ".ogg")), dev) for s in names}
    base = eval_songs(acts, refs, {c: 0.5 for c in CLASSES})
    print("thr 0.5:")
    for s, v in base.items():
        print(" ", s, v)
    # クラスごとに 3 曲の F の平均が一番よいしきい値
    best = {}
    for c in CLASSES:
        sc = []
        for th in GRID:
            ev = eval_songs(acts, refs, {k: (th if k == c else 0.5) for k in CLASSES})
            sc.append(np.mean([v[c] for v in ev.values()]))
        best[c] = GRID[int(np.argmax(sc))]
    ev = eval_songs(acts, refs, best)
    print("best thr:", best)
    for s, v in ev.items():
        print(" ", s, v)
    print("mean all", round(float(np.mean([v["all"] for v in ev.values()])), 3))
    return best, ev


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
