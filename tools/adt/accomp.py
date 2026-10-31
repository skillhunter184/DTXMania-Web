"""学習用の伴奏(ドラムの入っていない音)を合成する。第三者の曲は使わない。

楽器は 2 通り: このファイルの合成(歪んだギター・弦をはじく音・ピアノ風・パッド・ベース・リード・声に似せた音・アルペジオ・
ノイズの効果音)と、NSynth(Magenta、CC BY 4.0。1 音ずつの録音)の音を並べたもの。調・和音の進行・リズムの型は乱数で決め、
指定の BPM の拍に乗せる(ドラムと同じ所で鳴る音を打点と取り違えないように学ばせる)。

    python tools/adt/accomp.py D:/adtdata/work D:/adtdata/nsynth

出力: acc.i16(44100 Hz・1 本の int16 を並べたもの)と acc_index.json([{off, len, bpm}]。bpm 0 は拍に乗せない側)
"""

from __future__ import annotations

import glob
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import soundfile as sf
from scipy import signal

SR = 44100
CLIP_S = 30.0
PER_BPM = 6
FREE = 240

NSYNTH_FAMILIES = ["bass", "brass", "flute", "guitar", "keyboard", "mallet", "organ", "reed", "string", "synth_lead", "vocal"]
_NS = None


def nsynth_pool(root):
    """NSynth の音: 楽器 → {音の高さ: [ファイル]}(強さは問わない)。"""
    pool = {}
    for split in glob.glob(os.path.join(root, "nsynth-*")):
        meta = json.load(open(os.path.join(split, "examples.json")))
        for key, m in meta.items():
            if m["instrument_family_str"] not in NSYNTH_FAMILIES:
                continue
            inst = m["instrument_str"]
            pool.setdefault(inst, {"family": m["instrument_family_str"], "notes": {}})
            pool[inst]["notes"].setdefault(m["pitch"], []).append(os.path.join(split, "audio", key + ".wav"))
    return pool


def hz(m):
    return 440.0 * 2 ** ((np.asarray(m, float) - 69) / 12)


def biquad(kind, f0, q=0.707, gain_db=0.0):
    w0 = 2 * np.pi * min(f0, SR * 0.45) / SR
    al = np.sin(w0) / (2 * q)
    cs = np.cos(w0)
    A = 10 ** (gain_db / 40)
    if kind == "lp":
        b = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]; a = [1 + al, -2 * cs, 1 - al]
    elif kind == "hp":
        b = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]; a = [1 + al, -2 * cs, 1 - al]
    elif kind == "bp":
        b = [al, 0, -al]; a = [1 + al, -2 * cs, 1 - al]
    else:  # peak
        b = [1 + al * A, -2 * cs, 1 - al * A]; a = [1 + al / A, -2 * cs, 1 - al / A]
    return np.array(b) / a[0], np.array(a) / a[0]


def filt(x, kind, f0, q=0.707, gain_db=0.0):
    b, a = biquad(kind, f0, q, gain_db)
    return signal.lfilter(b, a, x)


def env_adsr(n, a, d, s, r, hold):
    """n 標本の包絡(a・d・r は秒、hold は鳴らしている長さ)。"""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = t > hold
    e[rel] *= np.exp(-(t[rel] - hold) / max(r, 1e-4))
    return e


_TABLES = {}
TABLE_N = 4096


def _table(kind, K):
    key = (kind, K)
    t = _TABLES.get(key)
    if t is None:
        ph = 2 * np.pi * np.arange(TABLE_N) / TABLE_N
        t = np.zeros(TABLE_N)
        for k in range(1, K + 1):
            amp = 1.0 / k if kind == "saw" else (1.0 / k if k % 2 else 0) if kind == "square" else \
                (1.0 / k ** 2 if k % 2 else 0)
            if amp:
                t += amp * np.sin(k * ph)
        t = np.append(t, t[0])
        _TABLES[key] = t
    return t


def wavetable(kind, phase, fmax, kmax=40):
    """位相(周期 1)から帯域を限った波形を引く(倍音は fmax で 18 kHz を越えない数)。"""
    K = int(max(1, min(kmax, 18000 // max(fmax, 20))))
    t = _table(kind, K)
    x = (phase % 1.0) * TABLE_N
    i = x.astype(np.int64)
    fr = x - i
    return t[i] * (1 - fr) + t[i + 1] * fr


def additive(f, n, kind="saw", kmax=40, detune=0.0, rng=None):
    ph0 = rng.uniform(0, 1) if rng is not None else 0
    fd = f * (1 + detune)
    return wavetable(kind, ph0 + fd * np.arange(n) / SR, fd, kmax)


def karplus(f, n, decay=0.996, bright=0.5, rng=None):
    N = max(2, int(SR / f))
    exc = np.zeros(n)
    burst = rng.uniform(-1, 1, N)
    burst = filt(burst, "lp", 1000 + 9000 * bright)
    exc[: min(N, n)] = burst[:n]
    a = np.zeros(N + 2)
    a[0] = 1
    a[N] = -decay / 2
    a[N + 1] = -decay / 2
    return signal.lfilter([1.0], a, exc)


class Synth:
    def __init__(self, rng, ns_pool):
        self.rng = rng
        self.ns = ns_pool
        self.cache = {}

    # ---- 1 音を作る(長さ n 標本) ----
    def note(self, inst, m, n, hold, vel):
        r = self.rng
        f = float(hz(m))
        if inst["kind"] == "dist":
            x = sum(additive(f, n, "saw", 30, d, r) for d in (-0.004, 0.004))
            x += 0.5 * additive(f / 2 if inst.get("oct") else f * 1.5, n, "square", 20, 0.002, r)
            e = env_adsr(n, 0.003, inst["decay"], inst["sus"], 0.05, hold)
            x = np.tanh(inst["drive"] * filt(x * e, "hp", 90))
            return x * vel
        if inst["kind"] == "pluck":
            return karplus(f, n, inst["decay"], inst["bright"], r) * vel * env_adsr(n, 0.001, 10, 1, 0.08, hold)
        if inst["kind"] == "piano":
            t = np.arange(n) / SR
            B = 0.0004
            x = np.zeros(n)
            for k in range(1, 13):
                fk = k * f * np.sqrt(1 + B * k * k)
                if fk > 16000:
                    break
                x += (1 / k ** 1.1) * np.sin(2 * np.pi * fk * t) * np.exp(-t * (0.8 + 0.5 * k) * inst["damp"])
            click = filt(r.normal(0, 1, min(n, 400)) * np.exp(-np.arange(min(n, 400)) / 60), "bp", 2500, 0.8)
            x[: len(click)] += inst["click"] * click
            return x * vel * env_adsr(n, 0.001, 10, 1, 0.15, hold)
        if inst["kind"] == "pad":
            x = sum(additive(f, n, "saw", 24, d, r) for d in np.linspace(-0.008, 0.008, 5))
            return x * vel * env_adsr(n, inst["att"], 1.0, 0.8, 0.4, hold) / 3
        if inst["kind"] == "bass":
            x = additive(f, n, inst["wave"], 25, 0, r) + 0.7 * np.sin(2 * np.pi * f * np.arange(n) / SR)
            x = filt(x, "lp", inst["cut"])
            if inst.get("drive"):
                x = np.tanh(inst["drive"] * x)
            return x * vel * env_adsr(n, 0.002, inst["decay"], inst["sus"], 0.06, hold)
        if inst["kind"] in ("lead", "vocal"):
            t = np.arange(n) / SR
            vib = 1 + inst["vib"] * np.sin(2 * np.pi * inst["vibf"] * t) * np.clip(t / 0.3, 0, 1)
            x = wavetable("saw", np.cumsum(f * vib) / SR, f * (1 + inst["vib"]), 30)
            if inst["kind"] == "vocal":
                fs = inst["formants"]
                x = sum(g * filt(x, "bp", fc, 6) for fc, g in fs) + 0.02 * filt(r.normal(0, 1, n), "bp", 6000, 1)
                return x * vel * env_adsr(n, 0.04, 0.5, 0.8, 0.12, hold)
            return filt(x, "lp", inst["cut"]) * vel * env_adsr(n, 0.01, 0.3, 0.7, 0.1, hold)
        if inst["kind"] == "nsynth":
            notes = inst["notes"]
            ps = np.array(sorted(notes))
            p = int(ps[np.argmin(np.abs(ps - m))])
            path = notes[p][int(r.integers(len(notes[p])))]
            x = self.cache.get(path)
            if x is None:
                x, _ = sf.read(path, dtype="float32")
                x = signal.resample_poly(x, 441, 160)
                self.cache[path] = x
            if p != m:
                x = signal.resample(x, int(len(x) / 2 ** ((m - p) / 12)))
            x = x[:n]
            if len(x) < n:
                x = np.pad(x, (0, n - len(x)))
            return x * vel * env_adsr(n, 0.001, 10, 1, 0.1, hold)
        raise ValueError(inst["kind"])

    def instrument(self, role):
        r = self.rng
        if role == "nsynth":
            if not self.ns:
                return self.instrument(["guitar", "keys", "pad", "lead"][r.integers(4)])
            name = r.choice(sorted(self.ns))
            return {"kind": "nsynth", "notes": self.ns[name]["notes"], "family": self.ns[name]["family"]}
        if role == "guitar":
            if r.random() < 0.65:
                return {"kind": "dist", "drive": r.uniform(3, 25), "decay": r.uniform(0.1, 2), "sus": r.uniform(0.2, 0.9),
                        "oct": r.random() < 0.5, "cab": r.uniform(2500, 6000)}
            return {"kind": "pluck", "decay": r.uniform(0.990, 0.999), "bright": r.uniform(0.2, 0.9)}
        if role == "keys":
            if r.random() < 0.6:
                return {"kind": "piano", "damp": r.uniform(0.5, 2), "click": r.uniform(0, 0.6)}
            return {"kind": "pluck", "decay": r.uniform(0.985, 0.997), "bright": r.uniform(0.5, 1)}
        if role == "pad":
            return {"kind": "pad", "att": r.uniform(0.05, 0.8), "cut": r.uniform(1500, 6000)}
        if role == "bass":
            return {"kind": "bass", "wave": r.choice(["saw", "square", "tri"]), "cut": r.uniform(250, 2500),
                    "decay": r.uniform(0.1, 1.5), "sus": r.uniform(0.2, 0.9), "drive": r.choice([0, 0, r.uniform(1, 6)])}
        if role == "lead":
            return {"kind": "lead", "vib": r.uniform(0, 0.012), "vibf": r.uniform(4, 7), "cut": r.uniform(2000, 9000)}
        if role == "vocal":
            vowels = [[(730, 1), (1090, 0.5), (2440, 0.3)], [(530, 1), (1840, 0.5), (2480, 0.3)],
                      [(270, 1), (2290, 0.4), (3010, 0.3)], [(570, 1), (840, 0.5), (2410, 0.3)],
                      [(300, 1), (870, 0.4), (2240, 0.2)]]
            return {"kind": "vocal", "vib": r.uniform(0.004, 0.02), "vibf": r.uniform(4.5, 6.5),
                    "formants": vowels[r.integers(len(vowels))]}
        raise ValueError(role)


PATTERNS = [
    "x...............", "x.......x.......", "x...x...x...x...", "x.x.x.x.x.x.x.x.", "xxxxxxxxxxxxxxxx",
    "x..x..x...x..x..", "x..x..x.x..x..x.", "..x...x...x...x.", "x.....x.....x...", "x..x....x..x....",
    "x.xx.xx.x.xx.xx.", "x...x.x...x.x...", "x......x..x.....",
]


def render_clip(seed, bpm, ns_pool, seconds=CLIP_S):
    rng = np.random.default_rng(seed)
    syn = Synth(rng, ns_pool)
    free = bpm == 0
    if free:
        bpm = rng.uniform(70, 220)
    beat = 60.0 / bpm
    s16 = beat / 4
    n = int(seconds * SR)
    out = np.zeros(n)
    key = int(rng.integers(0, 12))
    minor = rng.random() < 0.5
    scale = [0, 2, 3, 5, 7, 8, 10] if minor else [0, 2, 4, 5, 7, 9, 11]
    prog = rng.choice([[0, 5, 3, 4], [0, 3, 4, 0], [5, 3, 0, 4], [0, 4, 5, 3], [0, 6, 5, 4], [3, 4, 2, 5], [0, 0, 3, 4]])
    bars_per_chord = int(rng.choice([1, 1, 2]))
    nbars = int(np.ceil(seconds / (4 * beat))) + 1

    def chord(bar, octave=48, size=3):
        deg = prog[(bar // bars_per_chord) % len(prog)]
        return [key + octave + scale[(deg + 2 * i) % 7] + 12 * ((deg + 2 * i) // 7) for i in range(size)]

    roles = []
    for role, p in (("guitar", 0.6), ("guitar", 0.25), ("bass", 0.8), ("keys", 0.45), ("pad", 0.45), ("lead", 0.3),
                    ("vocal", 0.5), ("nsynth", 0.6), ("nsynth", 0.4), ("nsynth", 0.25)):
        if rng.random() < p:
            roles.append(role)
    if not roles:
        roles = ["nsynth"]
    for role in roles:
        inst = syn.instrument(role)
        level = 10 ** (rng.uniform(-14, 0) / 20)
        part = np.zeros(n)
        pat = PATTERNS[rng.integers(len(PATTERNS))]
        melodic = role in ("lead", "vocal") or (role == "nsynth" and rng.random() < 0.5)
        mel = int(rng.integers(0, 7))
        jitter = rng.uniform(0, 0.012) if free else rng.uniform(0, 0.006)
        for bar in range(nbars):
            if rng.random() < 0.08:
                continue  # 休み
            ch = chord(bar, 36 if role == "bass" else 48 + 12 * int(rng.random() < 0.3))
            steps = [i for i, c in enumerate(pat) if c == "x"] if not melodic else \
                sorted(rng.choice(16, size=int(rng.integers(2, 9)), replace=False))
            for j, st in enumerate(steps):
                t0 = (bar * 16 + st) * s16 + rng.normal(0, jitter)
                if t0 < 0 or t0 >= seconds:
                    continue
                nxt = steps[j + 1] if j + 1 < len(steps) else 16
                hold = (nxt - st) * s16 * rng.uniform(0.4, 1.0)
                if melodic:
                    mel = int(np.clip(mel + rng.integers(-2, 3), -3, 10))
                    ps = [key + 60 + scale[mel % 7] + 12 * (mel // 7) - (12 if inst.get("family") == "bass" else 0)]
                elif role == "bass":
                    ps = [ch[0] - 12 * int(rng.random() < 0.3)]
                elif inst["kind"] == "dist":
                    ps = [ch[0] - 12, ch[0] - 5]
                else:
                    ps = ch
                tail = 0.6 if inst["kind"] in ("pad", "nsynth") else 0.3
                L = int(min(hold + tail, 4.0) * SR)
                i0 = int(t0 * SR)
                L = min(L, n - i0)
                if L <= 64:
                    continue
                vel = rng.uniform(0.5, 1.0)
                for p in ps:
                    part[i0: i0 + L] += syn.note(inst, p, L, hold, vel) / len(ps) ** 0.5
        if inst["kind"] == "dist":
            part = filt(filt(part, "lp", inst["cab"], 0.9), "peak", rng.uniform(800, 2500), 1.0, rng.uniform(-4, 6))
        rms = np.sqrt(np.mean(part ** 2)) + 1e-9
        out += part / rms * level
    # ノイズの効果音(上がっていくノイズ・吹き抜ける音)
    if rng.random() < 0.25:
        for _ in range(int(rng.integers(1, 3))):
            L = int(rng.uniform(1, 4) * 4 * beat * SR / 4)
            i0 = int(rng.uniform(0, max(1, n - L)))
            L = min(L, n - i0)
            noise = rng.normal(0, 1, L)
            fc = np.geomspace(rng.uniform(300, 1500), rng.uniform(4000, 14000), 32)
            seg = np.array_split(np.arange(L), 32)
            y = np.concatenate([filt(noise[s], "bp", fc[k], 1.5) for k, s in enumerate(seg)])
            y *= np.linspace(0, 1, L) ** 2
            out[i0: i0 + L] += y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * 10 ** (rng.uniform(-18, -6) / 20)
    # 残響(指数で減るノイズ)
    if rng.random() < 0.8:
        rt = rng.uniform(0.3, 2.0)
        L = int(rt * SR)
        ir = rng.normal(0, 1, L) * np.exp(-6.9 * np.arange(L) / L)
        ir = filt(ir, "lp", rng.uniform(3000, 9000))
        wet = signal.fftconvolve(out, ir)[:n]
        wet *= np.sqrt(np.mean(out ** 2)) / (np.sqrt(np.mean(wet ** 2)) + 1e-9)
        out = out + rng.uniform(0.1, 0.5) * wet
    out = filt(out, "hp", 30)
    out /= np.max(np.abs(out)) + 1e-9
    return (out * 0.9 * 32767).astype(np.int16)


def _job(args):
    seed, bpm, ns_root = args
    global _NS
    if _NS is None:
        _NS = nsynth_pool(ns_root) if ns_root else {}
    for k in range(5):
        try:
            return seed, bpm, render_clip(seed + 1000003 * k, bpm, _NS)
        except Exception as ex:  # noqa: BLE001
            print("clip failed", seed, k, repr(ex), file=sys.stderr, flush=True)
    raise RuntimeError(seed)


def main(work, ns_root):
    idx = json.load(open(os.path.join(work, "index.json")))
    bpms = sorted({round(m["bpm"]) for m in idx})
    jobs = [(1000 + i, b, ns_root) for i, b in enumerate(b for b in bpms for _ in range(PER_BPM))]
    jobs += [(900000 + i, 0, ns_root) for i in range(FREE)]
    print(len(bpms), "bpms;", len(jobs), "clips", flush=True)
    out = open(os.path.join(work, "acc.i16"), "wb")
    meta = []
    off = 0
    with ProcessPoolExecutor(14) as ex:
        for k, (seed, bpm, x) in enumerate(ex.map(_job, jobs)):
            out.write(x.tobytes())
            meta.append({"off": off, "len": len(x), "bpm": bpm, "seed": seed})
            off += len(x)
            if k % 50 == 0:
                print(k, flush=True)
    out.close()
    json.dump(meta, open(os.path.join(work, "acc_index.json"), "w"))
    print("done", off / SR / 3600, "h")


if __name__ == "__main__":
    if sys.argv[1] == "demo":
        ns = nsynth_pool(sys.argv[2]) if len(sys.argv) > 2 else {}
        for i in range(4):
            x = render_clip(77 + i, [120, 160, 0, 200][i], ns, 12)
            sf.write(os.path.join(sys.argv[3] if len(sys.argv) > 3 else ".", f"acc_demo{i}.wav"), x, SR)
    else:
        main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
