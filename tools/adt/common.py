"""音から譜面の打点のモデル(js/gen/adtmodel.js)の、入力の作り方とモデルの形。JS と同じ計算にする。

入力: 44100 Hz・1 本(左右の平均)を、曲全体の RMS が RMS_TARGET になるよう大きさをそろえ、2048 点・刻み 441(100 fps)の
Hann 窓(周期の形)の振幅のスペクトログラムを、1 オクターブ 12 本の三角の帯域(20 Hz〜20 kHz。madmom の
LogarithmicFilterbank と同じ作り方)にまとめて log(1 + x)。コマ i の窓の真ん中は i / 100 + 1024 / 44100 秒。
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn

SR = 44100
NFFT = 2048
HOP = 441
FPS = SR / HOP
RMS_TARGET = 0.1
FRAME_C = (NFFT / 2) / SR  # コマの窓の真ん中(秒)
CLASSES = ["KD", "SD", "TT", "HH", "CY"]

# E-GMD(Roland の音の番号。Groove MIDI Dataset のページの表)→ 5 つ
PITCH_CLASS = {
    36: "KD", 35: "KD",
    38: "SD", 40: "SD", 37: "SD",
    48: "TT", 50: "TT", 45: "TT", 47: "TT", 43: "TT", 58: "TT",
    46: "HH", 26: "HH", 42: "HH", 22: "HH", 44: "HH",
    49: "CY", 55: "CY", 57: "CY", 52: "CY", 51: "CY", 59: "CY", 53: "CY",
}


def log_filterbank(sr=SR, nfft=NFFT, bpo=12, fmin=20.0, fmax=20000.0, fref=440.0):
    """三角の帯域(F = nfft/2 + 1 本の bin → B 本)。@returns (B, F) の重み(各帯域の和は 1)"""
    F = nfft // 2 + 1
    left = int(np.floor(np.log2(fmin / fref) * bpo))
    right = int(np.ceil(np.log2(fmax / fref) * bpo))
    freqs = fref * 2.0 ** (np.arange(left, right + 1) / bpo)
    freqs = freqs[(freqs >= fmin) & (freqs <= fmax)]
    bins = np.unique(np.round(freqs / (sr / nfft)).astype(int))
    bins = bins[(bins >= 0) & (bins < F)]
    fb = []
    for i in range(len(bins) - 2):
        start, center, stop = bins[i], bins[i + 1], bins[i + 2]
        if stop - start < 2:
            center, stop = start, start + 1
        w = np.zeros(F)
        # madmom の TriangularFilter: start〜center で 0→1、center〜stop で 1→0(両端は含まない)
        if center > start:
            w[start:center] = np.linspace(0, 1, center - start, endpoint=False)
        w[center:stop] = np.linspace(1, 0, stop - center, endpoint=False)
        if w.sum() <= 0:
            w[center] = 1
        fb.append(w / w.sum())
    return np.array(fb, dtype=np.float32)


FB = log_filterbank()
NBANDS = FB.shape[0]


def normalize(x: np.ndarray) -> np.ndarray:
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    return x * (RMS_TARGET / max(rms, 1e-6))


class Frontend(nn.Module):
    """波形 (N, S) → 対数の帯域 (N, T, B)。JS の stftMag(js/gen/adt.js)+ 帯域 + log1p と同じ。"""

    def __init__(self):
        super().__init__()
        self.register_buffer("win", torch.hann_window(NFFT, periodic=True))
        self.register_buffer("fb", torch.from_numpy(FB).T.contiguous())  # (F, B)

    def forward(self, x, eq=None):
        X = torch.stft(x, NFFT, HOP, window=self.win, center=False, return_complex=True)  # (N, F, T)
        mag = X.abs().transpose(1, 2)  # (N, T, F)
        if eq is not None:
            mag = mag * eq[:, None, :]
        return torch.log1p(mag @ self.fb)


class ConvBN(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.conv = nn.Conv2d(cin, cout, 3, padding=1, bias=False)
        self.bn = nn.BatchNorm2d(cout)

    def forward(self, x):
        return torch.relu(self.bn(self.conv(x)))


class ADTNet(nn.Module):
    """小さな CRNN: (N, T, B) → (N, T, 5) の確率の前の値(logit)。

    畳み込み 2 段 × 2(帯域の向きだけ 3 つずつまとめる)→ 双方向 GRU → 5 クラス。
    """

    def __init__(self, ch=(8, 16), hidden=48, dropout=0.2):
        super().__init__()
        c1, c2 = ch
        self.inbn = nn.BatchNorm2d(1)
        self.b1 = nn.Sequential(ConvBN(1, c1), ConvBN(c1, c1))
        self.b2 = nn.Sequential(ConvBN(c1, c2), ConvBN(c2, c2))
        self.f1 = NBANDS // 3
        self.f2 = self.f1 // 3
        self.drop = nn.Dropout(dropout)
        self.gru = nn.GRU(c2 * self.f2, hidden, batch_first=True, bidirectional=True)
        self.out = nn.Linear(2 * hidden, len(CLASSES))
        self.ch = ch
        self.hidden = hidden

    def forward(self, s):
        x = self.inbn(s[:, None])  # (N, 1, T, B)
        x = self.b1(x)
        x = nn.functional.max_pool2d(x[..., : self.f1 * 3], (1, 3))
        x = self.drop(x)
        x = self.b2(x)
        x = nn.functional.max_pool2d(x[..., : self.f2 * 3], (1, 3))
        x = self.drop(x)
        N, C, T, Fq = x.shape
        x = x.permute(0, 2, 1, 3).reshape(N, T, C * Fq)
        x, _ = self.gru(x)
        x = self.drop(x)
        return self.out(x)


def onset_targets(onsets: dict, T: int, t0: float = 0.0) -> np.ndarray:
    """打点(クラス → 秒の並び)から (T, 5) の的(一番近いコマを 1、その両隣を 0.5)。t0 は窓の頭の時刻。"""
    y = np.zeros((T, len(CLASSES)), np.float32)
    for k, name in enumerate(CLASSES):
        for t in onsets.get(name, ()):
            x = (t - t0 - FRAME_C) * FPS
            i = int(np.round(x))
            for d, v in ((-1, 0.5), (0, 1.0), (1, 0.5)):
                j = i + d
                if 0 <= j < T and y[j, k] < v:
                    y[j, k] = v
    return y


def pick_peaks(p: np.ndarray, thr: float, dist: int = 3):
    """確率の峰(±2 コマで一番高い・thr 以上・間は dist コマより空ける)。@returns [(秒, 値)]"""
    out = []
    last = -10
    for i in range(2, len(p) - 2):
        v = p[i]
        if v < thr or not (v > p[i - 1] and v >= p[i + 1] and v >= p[i - 2] and v >= p[i + 2]):
            continue
        if i - last <= dist:
            if out and v > out[-1][1]:
                out[-1] = (_refine(p, i), v)
            last = i
            continue
        out.append((_refine(p, i), v))
        last = i
    return out


def _refine(p, i):
    y0, y1, y2 = p[i - 1], p[i], p[i + 1]
    d = y0 - 2 * y1 + y2
    x = i + max(-0.5, min(0.5, 0.5 * (y0 - y2) / d)) if d < 0 else i
    return x / FPS + FRAME_C
