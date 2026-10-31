"""打点のモデル(common.ADTNet)を E-GMD のドラム + 合成の伴奏で学習する。

    python tools/adt/train.py D:/adtdata/work D:/adtdata/run1 [--steps 20000] [--eval-dir tests/fixtures/local/audio]

学習の例ごとに: E-GMD の 1 曲から 8 秒を切り出し、伴奏(accomp.py)を混ぜ(6 割は同じ BPM の拍に合わせる)、
ドラムと伴奏の比・全体の大きさ・軽い歪み(マスタリングのリミッタの代わり)・周波数の傾き(EQ)を乱数で変える。
--eval-dir があれば、そこの曲(*.ogg と、ref.json の正解の時刻)で打点の F を測る(手元の確かめ。学習には使わない)。
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(__file__))
from common import CLASSES, FPS, HOP, NFFT, RMS_TARGET, SR, ADTNet, Frontend, onset_targets, pick_peaks  # noqa: E402

T_FRAMES = 800
S_LEN = (T_FRAMES - 1) * HOP + NFFT


class GpuMix:
    """学習の例を GPU でまとめて作る(音は全部 RAM に置き、窓の頭をコマの刻みにそろえて的もまとめて引く)。

    1 つの例: E-GMD の 1 曲から T_FRAMES コマ分を切り出し、伴奏を混ぜ(align_p の割合は同じ BPM の拍に合わせる)、
    ドラムと伴奏の比・軽い歪み(マスタリングのリミッタの代わり)・小さな雑音・全体の大きさを乱数で変える。
    """

    def __init__(self, work, split, device, seed=0, acc_p=0.85, align_p=0.6, drum_fx=0.0, appkit=False):
        sources = [("index.json", "drums.i16")] + ([("appkit_index.json", "appkit.i16")] if appkit else [])
        self.files = []
        for ij, raw in sources:
            arr = np.memmap(os.path.join(work, raw), np.int16, "r")
            for m in json.load(open(os.path.join(work, ij))):
                if m["split"] == split and m["ok"]:
                    m["src"] = arr
                    self.files.append(m)
        acc = np.memmap(os.path.join(work, "acc.i16"), np.int16, "r")
        # 選んだ曲だけを 1 本の並びに詰める(appkit: 本アプリの合成音で鳴らした E-GMD の演奏も。render_appkit.py)
        parts = []
        labs = []
        self.f_off = []
        self.f_frames = []
        off = 0
        foff = 0
        for m in self.files:
            x = np.asarray(m.pop("src")[m["off"]: m["off"] + m["len"]])
            if len(x) < S_LEN:  # 短い曲(フィル)は後ろを無音で埋める
                x = np.pad(x, (0, S_LEN - len(x)))
            parts.append(x)
            nfr = (len(x) - S_LEN) // HOP + 1  # 窓の頭に選べるコマ
            T = nfr + T_FRAMES
            m["w"] = m["len"] / HOP
            y = onset_targets(m["onsets"], T, 0.0)
            labs.append(np.rint(y * 2).astype(np.uint8))
            self.f_off.append(off)
            self.f_frames.append(foff)
            m["nfr"] = nfr
            off += len(x)
            foff += T
        self.drums = torch.from_numpy(np.concatenate(parts))
        self.labels = torch.from_numpy(np.concatenate(labs))
        self.acc = torch.from_numpy(np.array(acc))
        self.gen = None
        self.acc_meta = json.load(open(os.path.join(work, "acc_index.json")))
        self.by_bpm = {}
        for i, a in enumerate(self.acc_meta):
            self.by_bpm.setdefault(int(a["bpm"]), []).append(i)
        w = np.array([m["w"] for m in self.files], float)
        self.p = w / w.sum()
        self.rng = np.random.default_rng(seed)
        self.dev = device
        self.acc_p = acc_p
        self.align_p = align_p
        self.drum_fx = drum_fx
        self.ar = torch.arange(S_LEN)
        self.arT = torch.arange(T_FRAMES)

    def drum_effects(self, d, n, U):
        """ドラムだけの音色の幅(キットの違いの代わり): drum_fx の割合で、周波数の山 3 つ(±9 dB)と傾き(±6 dB)、
        半分はさらに軽い歪み(太鼓の音を潰した録音の代わり)。FFT で掛ける。"""
        Fq = S_LEN // 2 + 1
        f = torch.linspace(0, 1, Fq, device=self.dev)
        lf = torch.log2(1 + f * 1000) / math.log2(1001)
        eq = (U(n, 1) - 0.5) * 12 * (lf - 0.5)
        for _ in range(3):
            eq = eq + (U(n, 1) - 0.5) * 18 * torch.exp(-0.5 * ((lf - U(n, 1)) / (0.03 + 0.08 * U(n, 1))) ** 2)
        on = U(n, 1) < self.drum_fx
        gain = torch.where(on, 10 ** (eq / 20), torch.ones_like(eq))
        y = torch.fft.irfft(torch.fft.rfft(d) * gain, n=S_LEN)
        sat = (U(n, 1) < 0.5) & on
        g = 1 + 2 * U(n, 1)
        pk = y.abs().amax(1, keepdim=True) + 1e-6
        ys = torch.tanh(g * y / pk) / torch.tanh(g) * pk
        return torch.where(sat, ys, y)

    def batch(self, n):
        rng = self.rng
        fi = rng.choice(len(self.files), size=n, p=self.p)
        d0 = np.zeros(n, np.int64)
        l0 = np.zeros(n, np.int64)
        a0 = np.zeros(n, np.int64)
        use_acc = rng.random(n) < self.acc_p
        for j, f in enumerate(fi):
            m = self.files[f]
            k = int(rng.integers(0, m["nfr"]))
            d0[j] = self.f_off[f] + k * HOP
            l0[j] = self.f_frames[f] + k
            bpm = int(round(m["bpm"]))
            if rng.random() < self.align_p and bpm in self.by_bpm:
                a = self.acc_meta[self.by_bpm[bpm][rng.integers(len(self.by_bpm[bpm]))]]
                beat = 60.0 / bpm * SR
                ph = (k * HOP) % beat
                kmax = int((a["len"] - S_LEN - ph) // beat)
                st = int(ph + beat * rng.integers(0, max(1, kmax)))
            else:
                a = self.acc_meta[rng.integers(len(self.acc_meta))]
                st = int(rng.integers(0, max(1, a["len"] - S_LEN)))
            a0[j] = a["off"] + min(st, a["len"] - S_LEN)
        d = torch.stack([self.drums[o: o + S_LEN] for o in d0]).to(self.dev, non_blocking=True).float() / 32768
        acc = torch.stack([self.acc[o: o + S_LEN] for o in a0]).to(self.dev, non_blocking=True).float() / 32768
        y = torch.stack([self.labels[o: o + T_FRAMES] for o in l0]).to(self.dev).float() / 2
        if self.gen is None:
            self.gen = torch.Generator(device=self.dev)
            self.gen.manual_seed(int(rng.integers(1 << 31)))
        g = self.gen
        U = lambda *s: torch.rand(*s, generator=g, device=self.dev)  # noqa: E731
        if self.drum_fx:
            d = self.drum_effects(d, n, U)
        rd = d.pow(2).mean(1, keepdim=True).sqrt() + 1e-6
        ra = acc.pow(2).mean(1, keepdim=True).sqrt() + 1e-6
        ratio_db = -10 + 18 * U(n, 1)  # ドラム ÷ 伴奏
        ga = (rd / ra) * 10 ** (-ratio_db / 20) * torch.from_numpy(use_acc[:, None].astype(np.float32)).to(self.dev)
        x = d + acc * ga
        clip = U(n, 1) < 0.5
        gdrive = 1 + 3 * U(n, 1)
        pk = x.abs().amax(1, keepdim=True) + 1e-6
        xc = torch.tanh(gdrive * x / pk) / torch.tanh(gdrive) * pk
        x = torch.where(clip, xc, x)
        noise = (U(n, 1) < 0.2).float() * 10 ** (-4.5 + 1.5 * U(n, 1))
        x = x + noise * torch.randn(n, S_LEN, generator=g, device=self.dev)
        r = x.pow(2).mean(1, keepdim=True).sqrt() + 1e-6
        x = x * (RMS_TARGET / r) * 10 ** ((-8 + 12 * U(n, 1)) / 20)
        return x, y


def random_eq(n, F, device, gen, tilt_db=12.0, lp_p=0.75):
    """周波数の傾き(±tilt_db / 全体)と山(±6 dB)を乱数で(4 割はそのまま)。lp_p の割合で、圧縮した音の
    高い所の切れ(11〜19.5 kHz より上を 0.3 kHz ほどで −60 dB まで)も付ける(手元の曲は動画の音で 16 kHz より上が無い)。"""
    f = torch.linspace(0, 1, F, device=device)
    lf = torch.log2(1 + f * 1000) / math.log2(1001)
    R = lambda: torch.rand(n, 1, device=device, generator=gen)  # noqa: E731
    eq = torch.zeros(n, F, device=device)
    eq += (R() - 0.5) * 2 * tilt_db * (lf - 0.5)
    for _ in range(3):
        c = R()
        g = (R() - 0.5) * 2 * 6
        w = 0.03 + 0.1 * R()
        eq += g * torch.exp(-0.5 * ((lf - c) / w) ** 2)
    eq = torch.where(R() < 0.4, torch.zeros_like(eq), eq)
    hz = f * (SR / 2)
    fc = 11000 + 8500 * R()
    width = 100 + 400 * R()
    lp = (-60 * ((hz - fc) / width).clamp(0, 1))
    eq += torch.where(R() < lp_p, lp, torch.zeros_like(lp))
    return 10 ** (eq / 20)


# ---- 確かめ(手元の曲) ----

def load_song(path):
    import soundfile as sf
    from scipy import signal
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != SR:
        g = math.gcd(SR, sr)
        x = signal.resample_poly(x, SR // g, sr // g).astype(np.float32)
    return x


@torch.no_grad()
def activations(model, fe, x, device):
    r = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) + 1e-9
    w = torch.from_numpy(x * (RMS_TARGET / r)).to(device)[None]
    s = fe(w)
    return torch.sigmoid(model(s))[0].cpu().numpy()


def match(det, ref, off, tol=0.025):
    ref = np.sort(np.asarray(ref))
    used = np.zeros(len(ref), bool)
    tp = 0
    for t0 in det:
        t = t0 - off
        j = np.searchsorted(ref, t - tol)
        best, bd = -1, tol
        while j < len(ref) and ref[j] <= t + tol:
            if not used[j] and abs(ref[j] - t) <= bd:
                bd, best = abs(ref[j] - t), j
            j += 1
        if best >= 0:
            used[best] = True
            tp += 1
    return tp


def f1(tp, nd, nr):
    p = tp / nd if nd else 0
    r = tp / nr if nr else 0
    return 2 * p * r / (p + r) if p + r else 0


def eval_songs(acts, refs, thr):
    """曲ごとの 5 クラスの F と全体の F(全体のずれはキック・スネアの差の中央値で合わせる)。"""
    out = {}
    for s, act in acts.items():
        ref = refs[s]
        det = {c: [t for t, v in pick_peaks(act[:, k], thr[c])] for k, c in enumerate(CLASSES)}
        diffs = [t - g for c in ("KD", "SD") for t in det[c] for g in ref[c] if abs(t - g) < 0.05]
        off = float(np.median(diffs)) if diffs else 0.0
        res = {"off_ms": round(off * 1000, 1)}
        TP = ND = NR = 0
        for c in CLASSES:
            tp = match(det[c], ref[c], off)
            res[c] = round(f1(tp, len(det[c]), len(ref[c])), 3)
            TP += tp
            ND += len(det[c])
            NR += len(ref[c])
        res["all"] = round(f1(TP, ND, NR), 3)
        out[s] = res
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("out")
    ap.add_argument("--steps", type=int, default=20000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--ch", default="8,16")
    ap.add_argument("--hidden", type=int, default=48)
    ap.add_argument("--eval-dir", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--drum-fx", type=float, default=0.0, help="ドラムだけに EQ・歪みを掛ける割合")
    ap.add_argument("--appkit", action="store_true", help="本アプリの合成音で鳴らした演奏も使う(render_appkit.py)")
    ap.add_argument("--init", default=None, help="続きから学習する重み(.pt)")
    ap.add_argument("--ema", type=float, default=0.0, help="重みの移動平均の係数(0 で使わない)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    dev = "cuda"
    torch.backends.cudnn.benchmark = True
    torch.manual_seed(args.seed)
    model = ADTNet(tuple(int(c) for c in args.ch.split(",")), args.hidden).to(dev)
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location=dev)["model"])
    # 重みの移動平均(書き出しと確かめはこちら。歩ごとの手元の曲の F のぶれが大きかったので)
    ema = copy.deepcopy(model).eval() if args.ema else model
    fe = Frontend().to(dev)
    print("params", sum(p.numel() for p in model.parameters()), flush=True)
    data = GpuMix(args.work, "train", dev, seed=args.seed, drum_fx=args.drum_fx, appkit=args.appkit)
    print("train files", len(data.files), "frames", len(data.labels), flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.steps, pct_start=0.05)
    bce = nn.BCEWithLogitsLoss()
    gen = torch.Generator(device=dev)
    gen.manual_seed(1)
    # 検証: E-GMD の validation の曲に伴奏を混ぜたもの(種を決めて 1 回だけ作る)
    vds = GpuMix(args.work, "validation", "cpu", seed=7)
    vx, vy = zip(*[vds.batch(16) for _ in range(6)])
    vx = torch.cat(vx)
    vy = torch.cat(vy)
    del vds
    songs = {}
    refs = {}
    if args.eval_dir:
        refs = json.load(open(os.path.join(args.eval_dir, "ref.json")))
        for s in refs:
            songs[s] = load_song(os.path.join(args.eval_dir, s + ".ogg"))
    thr = {c: 0.5 for c in CLASSES}
    log = open(os.path.join(args.out, "log.txt"), "a")
    t_start = time.time()
    step = 0
    run = 0.0
    best = -1
    while True:
        model.train()
        xb, yb = data.batch(args.batch)
        with torch.no_grad():
            eq = random_eq(xb.shape[0], NFFT // 2 + 1, dev, gen)
            s = fe(xb, eq)
        logit = model(s)
        loss = bce(logit, yb)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
        sched.step()
        if args.ema:
            with torch.no_grad():
                for pe, pm in zip(ema.parameters(), model.parameters()):
                    pe.mul_(args.ema).add_(pm, alpha=1 - args.ema)
                for be, bm in zip(ema.buffers(), model.buffers()):
                    be.copy_(bm)
        run = 0.98 * run + 0.02 * loss.item() if step else loss.item()
        step += 1
        if step % 1000 == 0 or step == args.steps:
            model.eval()
            with torch.no_grad():
                vl = 0.0
                for i in range(0, len(vx), 16):
                    vl += bce(ema(fe(vx[i:i + 16].to(dev))), vy[i:i + 16].to(dev)).item() * len(vx[i:i + 16])
                vl /= len(vx)
            msg = f"step {step} loss {run:.4f} val {vl:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time() - t_start:.0f}s"
            if songs:
                acts = {s: activations(ema, fe, x, dev) for s, x in songs.items()}
                ev = eval_songs(acts, refs, thr)
                mean_all = float(np.mean([v["all"] for v in ev.values()]))
                msg += " | " + " ".join(f"{s}:{' '.join(f'{c}={v[c]}' for c in CLASSES)} all={v['all']}" for s, v in ev.items())
                msg += f" | mean {mean_all:.3f}"
            print(msg, flush=True)
            log.write(msg + "\n")
            log.flush()
            torch.save({"model": ema.state_dict(), "ch": model.ch, "hidden": model.hidden, "step": step},
                       os.path.join(args.out, "last.pt"))
            if -vl > best or best == -1:
                best = -vl
                torch.save({"model": ema.state_dict(), "ch": model.ch, "hidden": model.hidden, "step": step},
                           os.path.join(args.out, "best_val.pt"))
        if step >= args.steps:
            break


if __name__ == "__main__":
    main()
