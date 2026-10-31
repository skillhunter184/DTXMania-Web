"""落とした E-GMD を学習用にまとめる: 音は 1 つの int16 の並び(drums.i16)、打点と BPM は index.json。

    python tools/adt/prepare_egmd.py D:/adtdata/egmd D:/adtdata/work

音のずれた録音(E-GMD のページにある、作り方の都合で使えない録音)は、MIDI の打点の所の立ち上がりが
ほかの所より目立たないもので見分けて除く。
"""

from __future__ import annotations

import csv
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pretty_midi
import soundfile as sf

sys.path.insert(0, os.path.dirname(__file__))
from common import CLASSES, PITCH_CLASS, SR  # noqa: E402


def load(args):
    src, row = args
    wav = os.path.join(src, row["audio_filename"])
    mid = os.path.join(src, row["midi_filename"])
    try:
        x, sr = sf.read(wav, dtype="int16")
    except Exception as ex:  # noqa: BLE001
        return None, f"read {wav}: {ex}"
    if sr != SR:
        return None, f"sr {sr}"
    if x.ndim > 1:
        x = x.mean(axis=1).astype(np.int16)
    pm = pretty_midi.PrettyMIDI(mid)
    on = {c: [] for c in CLASSES}
    vel = {c: [] for c in CLASSES}
    for inst in pm.instruments:
        for n in inst.notes:
            c = PITCH_CLASS.get(n.pitch)
            if c:
                on[c].append(round(n.start, 5))
                vel[c].append(n.velocity)
    for c in CLASSES:
        o = np.argsort(on[c])
        on[c] = [on[c][i] for i in o]
        vel[c] = [vel[c][i] for i in o]
    # 合っているか: 2 kHz より上の振幅の立ち上がりの、打点の ±20 ms の最大の平均 ÷ 全体の平均
    xf = x.astype(np.float32) / 32768
    if len(xf) < SR:
        return None, "short"
    rms = float(np.sqrt(np.mean(xf ** 2)))
    if rms < 1e-3:
        return None, f"silent {rms:.5f}"
    hop = 441
    n = len(xf) // hop
    fr = xf[: n * hop].reshape(n, hop)
    d = np.diff(np.abs(np.diff(fr, axis=1)).sum(axis=1), prepend=0).clip(0)
    allt = sorted(t for c in CLASSES for t in on[c])
    if not allt:
        return None, "no notes"
    idx = np.clip((np.array(allt) * SR / hop).astype(int), 0, n - 1)
    near = np.array([d[max(0, i - 2): i + 3].max() for i in idx])
    score = float(near.mean() / (d.mean() + 1e-9))
    return {
        "name": row["audio_filename"], "split": row["split"], "kit": row["kit_name"], "bpm": float(row["bpm"]),
        "beat_type": row["beat_type"], "onsets": on, "vel": vel, "align": score, "rms": rms,
    }, x


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    rows = list(csv.DictReader(open(os.path.join(src, "selected.csv"), encoding="utf-8")))
    index = []
    out = open(os.path.join(dst, "drums.i16"), "wb")
    off = 0
    bad = 0
    with ProcessPoolExecutor(12) as ex:
        for meta, x in ex.map(load, [(src, r) for r in rows], chunksize=8):
            if meta is None:
                bad += 1
                print("skip", x, file=sys.stderr)
                continue
            meta["off"] = off
            meta["len"] = len(x)
            out.write(x.tobytes())
            off += len(x)
            index.append(meta)
    out.close()
    sc = np.array([m["align"] for m in index])
    lim = max(2.0, float(np.percentile(sc, 2)))
    for m in index:
        m["ok"] = bool(m["align"] >= lim)
    print(f"{len(index)} files ({bad} unreadable), {off / SR / 3600:.1f} h; align p2={np.percentile(sc, 2):.2f} "
          f"median={np.median(sc):.2f}; dropped {sum(not m['ok'] for m in index)} (align < {lim:.2f})")
    with open(os.path.join(dst, "index.json"), "w") as fp:
        json.dump(index, fp)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
