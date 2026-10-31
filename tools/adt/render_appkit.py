"""E-GMD の演奏(MIDI)を本アプリの合成のドラムの音(js/core/synth.js の buildKitSounds)で鳴らした学習用の音を作る。

E-GMD のキットは録音した太鼓の音なので、それだけで学習したモデルは、合成音の単純なドラム(正弦波を下げるキックなど)を
ドラムと見なかった(tests/genaudio.test.js の合成の曲でキック 14 %)。本アプリの音は自前のコード(MIT)なので学習に足せる。
音ごとに高さ(読む速さ ±15 %)と大きさ(±4 dB)を曲ごとに変える。

    python tools/adt/render_appkit.py D:/adtdata/egmd D:/adtdata/work D:/adtdata/appkit.json

appkit.json は buildKitSounds の波形(ブラウザで書き出したもの。{種類: [標本…]})。
出力: work/appkit.i16 と work/appkit_index.json(index.json と同じ形)
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pretty_midi

sys.path.insert(0, os.path.dirname(__file__))
from common import CLASSES, PITCH_CLASS, SR  # noqa: E402

# Roland の音の番号 → 本アプリの音の種類
PITCH_SOUND = {
    36: "BD", 35: "BD", 38: "SD", 40: "SD", 37: "SD",
    48: "HT", 50: "HT", 45: "LT", 47: "LT", 43: "FT", 58: "FT",
    42: "HHC", 22: "HHC", 44: "LP", 46: "HHO", 26: "HHO",
    49: "CY", 57: "CY", 55: "LC", 52: "LC", 51: "RD", 59: "RD", 53: "RD",
}
HOURS_TRAIN = 4.0
N_VAL = 30
SEED = 4242


def main(src, work, kit_json):
    kit = {k: np.array(v, np.float32) for k, v in json.load(open(kit_json)).items()}
    idx = json.load(open(os.path.join(work, "index.json")))
    rng = np.random.default_rng(SEED)
    train = [m for m in idx if m["split"] == "train" and m["ok"]]
    val = [m for m in idx if m["split"] == "validation" and m["ok"]]
    rng.shuffle(train)
    pick = []
    sec = 0.0
    for m in train:
        if sec >= HOURS_TRAIN * 3600:
            break
        pick.append(m)
        sec += m["len"] / SR
    rng.shuffle(val)
    pick += val[:N_VAL]
    out = open(os.path.join(work, "appkit.i16"), "wb")
    meta = []
    off = 0
    for m in pick:
        pm = pretty_midi.PrettyMIDI(os.path.join(src, m["name"].replace(".wav", ".midi")))
        notes = [n for inst in pm.instruments for n in inst.notes if n.pitch in PITCH_SOUND]
        L = m["len"] + SR
        x = np.zeros(L, np.float64)
        var = {}
        for k, d in kit.items():
            r = rng.uniform(0.85, 1.15)
            n = int(len(d) / r)
            var[k] = (np.interp(np.arange(n) * r, np.arange(len(d)), d), 10 ** (rng.uniform(-4, 4) / 20))
        on = {c: [] for c in CLASSES}
        for nt in notes:
            snd, g = var[PITCH_SOUND[nt.pitch]]
            i0 = int(round(nt.start * SR))
            if i0 >= L:
                continue
            seg = snd[: L - i0]
            x[i0: i0 + len(seg)] += seg * g * (nt.velocity / 127) ** 1.3
            on[PITCH_CLASS[nt.pitch]].append(round(nt.start, 5))
        for c in CLASSES:
            on[c].sort()
        pk = np.max(np.abs(x)) + 1e-9
        x16 = (x / pk * 0.9 * 32767).astype(np.int16)
        out.write(x16.tobytes())
        meta.append({"name": "appkit:" + m["name"], "split": m["split"], "kit": "app-synth", "bpm": m["bpm"],
                     "beat_type": m["beat_type"], "onsets": on, "ok": True, "off": off, "len": len(x16)})
        off += len(x16)
    out.close()
    json.dump(meta, open(os.path.join(work, "appkit_index.json"), "w"))
    print(f"{len(meta)} files, {off / SR / 3600:.2f} h")


if __name__ == "__main__":
    main(*sys.argv[1:4])
