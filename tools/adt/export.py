"""学習したモデルを JS で読める形(js/gen/adtweights.js)に書き出す。

    python tools/adt/export.py D:/adtdata/run1/last.pt js/gen/adtweights.js [--thr KD=0.5,SD=0.5,...]

畳み込みの BatchNorm は重みに畳み込み、入力の BatchNorm は 1 つの掛け算と足し算にする(端の 0 埋めが入力の後なので
畳み込めない)。重みは float32 の並びを base64 にして JS の文字列に入れる(file:// でも fetch 無しで読めるように)。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from common import CLASSES, FB, FRAME_C, HOP, NFFT, RMS_TARGET, SR, ADTNet  # noqa: E402


def band_weights():
    """FB の各帯域の [最初の bin, [重み…]](0 でない所だけ)。"""
    out = []
    for w in FB:
        nz = np.nonzero(w)[0]
        k0, k1 = int(nz[0]), int(nz[-1]) + 1
        out.append([k0, [float(f"{v:.7g}") for v in w[k0:k1]]])
    return out


def check_signal(seconds=3.0):
    """JS と突き合わせる決まった音(tests/genaudio.test.js にも同じ式がある): 0.25 秒ごとにキック風・スネア風・ハイハット風。
    雑音は 32 bit の線形合同法(種 12345)。"""
    n = int(seconds * SR)
    noise = np.zeros(n)
    s = 12345
    for i in range(n):
        s = (s * 1664525 + 1013904223) % 4294967296
        noise[i] = s / 4294967296 * 2 - 1
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(int((seconds - 0.2) / 0.25)):
        t0 = 0.1 + 0.25 * k
        i0 = int(round(t0 * SR))
        u = t[i0:] - t[i0]
        kind = k % 3
        if kind == 0:
            x[i0:] += 0.8 * np.sin(2 * np.pi * 60 * u) * np.exp(-u / 0.08)
        elif kind == 1:
            x[i0:] += (0.5 * noise[i0:] + 0.4 * np.sin(2 * np.pi * 200 * u)) * np.exp(-u / 0.06)
        else:
            x[i0:] += 0.3 * np.diff(noise[i0 - 1:]) * np.exp(-u / 0.02)
    return x.astype(np.float32)


def write_check(m, path):
    from train import activations
    from common import Frontend
    x = check_signal()
    p = activations(m, Frontend(), x, "cpu")
    with open(path, "w", encoding="utf-8", newline="\n") as fp:
        json.dump({"note": "tools/adt/export.py --check が書き出す(js/gen/adtmodel.js が tools/adt/common.py と同じ値を出すかの確かめ)",
                   "T": int(p.shape[0]), "prob": [round(float(v), 5) for v in p.ravel()]}, fp)
    print(f"wrote {path}: {p.shape}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("out")
    ap.add_argument("--thr", default="")
    ap.add_argument("--note", default="")
    ap.add_argument("--check", default=None, help="JS と突き合わせる値の書き出し先(tests/fixtures/adt_check.json)")
    args = ap.parse_args()
    ck = torch.load(args.ckpt, map_location="cpu")
    m = ADTNet(tuple(ck["ch"]), ck["hidden"])
    m.load_state_dict(ck["model"])
    m.eval()
    chunks = []
    off = [0]

    def put(a):
        a = np.ascontiguousarray(a, np.float32).ravel()
        o = off[0]
        chunks.append(a)
        off[0] += a.size
        return o

    bn = m.inbn
    g = (bn.weight / torch.sqrt(bn.running_var + bn.eps)).item()
    inbn = [g, bn.bias.item() - bn.running_mean.item() * g]
    convs = []
    for blk in (m.b1, m.b2):
        for cb in blk:
            w = cb.conv.weight.detach().numpy()  # (cout, cin, 3, 3)
            s = (cb.bn.weight / torch.sqrt(cb.bn.running_var + cb.bn.eps)).detach().numpy()
            b = (cb.bn.bias - cb.bn.running_mean * torch.from_numpy(s)).detach().numpy()
            convs.append({"cin": w.shape[1], "cout": w.shape[0], "w": put(w * s[:, None, None, None]), "b": put(b)})
    gru = m.gru
    H = gru.hidden_size
    dirs = []
    for sfx in ("", "_reverse"):
        dirs.append({k: put(getattr(gru, f"{k}_l0{sfx}").detach().numpy()) for k in ("weight_ih", "weight_hh", "bias_ih", "bias_hh")})
    thr = {c: 0.5 for c in CLASSES}
    for kv in filter(None, args.thr.split(",")):
        k, v = kv.split("=")
        thr[k] = float(v)
    header = {
        "version": 1, "note": args.note, "classes": CLASSES, "sr": SR, "nfft": NFFT, "hop": HOP, "rmsTarget": RMS_TARGET,
        "frameC": FRAME_C, "bands": band_weights(), "inBN": inbn, "pool": [m.f1, m.f2], "convs": convs,
        "gru": {"input": gru.input_size, "hidden": H, "dirs": dirs},
        "out": {"w": put(m.out.weight.detach().numpy()), "b": put(m.out.bias.detach().numpy())},
        "thr": thr, "step": ck.get("step"),
    }
    blob = np.concatenate(chunks).astype("<f4").tobytes()
    b64 = base64.b64encode(blob).decode()
    lines = [b64[i:i + 120] for i in range(0, len(b64), 120)]
    with open(args.out, "w", encoding="utf-8", newline="\n") as fp:
        fp.write("// 音から譜面の打点のモデルの重み(tools/adt/export.py が書き出す。手で直さない)。\n")
        fp.write("// E-GMD(Magenta、CC BY 4.0)と合成の伴奏で学習した。出典と作り方は docs/spec/vid2dtx-gen.md §6.1・THIRD_PARTY_NOTICES.md。\n")
        fp.write(f"export const ADT_MODEL_HEADER = {json.dumps(header, ensure_ascii=False)};\n")
        fp.write("export const ADT_MODEL_WEIGHTS =\n")
        fp.write("\n".join(f"  '{ln}'" + (" +" if i < len(lines) - 1 else ";") for i, ln in enumerate(lines)) + "\n")
    print(f"wrote {args.out}: {off[0]} floats, {len(b64) / 1024:.0f} KB base64")
    if args.check:
        write_check(m, args.check)


if __name__ == "__main__":
    main()
