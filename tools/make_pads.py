"""パッド列と判定ラインの画像 assets/skin/DrumGame/drum_pads.png を元絵から作る(Pillow と numpy が必要)。

元絵(drum_pads_src.webp)は透明地の横長の 1 枚絵で、上から
  判定ライン(横幅いっぱい)
  灰色のパッド LC HH LP SD HT BD LT FT CY(レーンの並びで左から)
  点灯したパッド(同じ並び)
が描いてある(元の drum_icons.png と同じ並び)。判定ラインが JUDGE_W 幅になるよう縮小し、
js/ui/skin.js の PAD_SRC / PAD_ROW_GRAY / PAD_ROW_LIT / JUDGE_SRC が指す並びにして書き出す:
  y 0..89    灰色のパッド(COLUMN_ORDER の順に左から詰める)
  y 89..178  点灯版(灰色版と同じ x・同じ幅)
  y 178..    判定ライン
元絵の FT の点灯版は紫(元の drum_icons.png で FT のリングが紫だった名残り)なので、灰色版のリングの色相に塗り直す。
各パッドの [x, 幅] と判定ラインの位置を最後に表示するので、変わったら skin.js に写すこと。

  python tools/make_pads.py [元絵] [出力]
"""

from __future__ import annotations

import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = "assets/skin/DrumGame/drum_pads_src.webp"
OUT = "assets/skin/DrumGame/drum_pads.png"

COLUMN_ORDER = ["LC", "HH", "LP", "SD", "HT", "BD", "LT", "FT", "CY"]
PAD_H = 89  # skin.js の PAD_H
JUDGE_W = 780  # 縮小後の判定ラインの幅(元の drum_icons.png と同じ。レーン帯 778 より 2px 広い)
GAP = 2

ALPHA_MIN = 16  # これ以下の不透明度は元絵の圧縮ノイズとみなす(絵の外に薄く散っている)
EDGE = 2  # 絵の縁のノイズ以下の薄い画素を残す幅(px)
MIN_PIXELS = 200  # これより小さい塊はノイズ
HUE_FROM_RING = ["FT"]  # 点灯版の色相を灰色版のリングに合わせるパッド
RING_SAT = 150  # リングとみなす彩度(PIL の HSV。0..255)
TINT_SAT = 25  # 色相を塗り直す彩度の下限(これ以下の白・灰・影はそのまま)


def bands(alpha: np.ndarray) -> list[tuple[int, int]]:
    """不透明な画素のある行のまとまり [y0, y1)。"""
    rows = np.where((alpha > ALPHA_MIN).any(axis=1))[0]
    out: list[list[int]] = []
    for y in rows:
        if out and y == out[-1][1]:
            out[-1][1] = y + 1
        else:
            out.append([y, y + 1])
    return [(a, b) for a, b in out]


def components(mask: np.ndarray) -> tuple[np.ndarray, list[tuple[int, int, int]]]:
    """8 近傍でつながった塊のラベルと、各塊の (ラベル, x0, x1)(x1 は含まない)。小さい塊は捨てる。"""
    h, w = mask.shape
    label = np.zeros((h, w), np.int32)
    found = []
    n = 0
    for sy, sx in zip(*np.nonzero(mask)):
        if label[sy, sx]:
            continue
        n += 1
        label[sy, sx] = n
        queue = deque([(sy, sx)])
        count, x0, x1 = 0, sx, sx
        while queue:
            y, x = queue.popleft()
            count += 1
            x0, x1 = min(x0, x), max(x1, x)
            for ny in (y - 1, y, y + 1):
                for nx in (x - 1, x, x + 1):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not label[ny, nx]:
                        label[ny, nx] = n
                        queue.append((ny, nx))
        if count >= MIN_PIXELS:
            found.append((n, int(x0), int(x1) + 1))
    found.sort(key=lambda c: c[1])
    return label, found


def keep(px: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """mask を EDGE だけ広げた範囲の外を透明にする(ノイズと隣のパッドの縁を消す)。"""
    grown = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(EDGE * 2 + 1))
    out = px.copy()
    out[np.array(grown) == 0, 3] = 0
    return out


def ring_hue(px: np.ndarray) -> int:
    """不透明で彩度の高い画素(= リング)の色相の中央値(PIL の HSV。0..255)。"""
    hsv = np.array(Image.fromarray(px, "RGBA").convert("RGB").convert("HSV"))
    ring = (px[..., 3] > 250) & (hsv[..., 1] > RING_SAT)
    if not ring.any():
        raise SystemExit("リングの色が見つからない")
    return int(np.median(hsv[..., 0][ring]))


def set_hue(px: np.ndarray, hue: int) -> np.ndarray:
    """色の付いた画素の色相を hue にする(彩度と明るさはそのまま)。"""
    hsv = np.array(Image.fromarray(px, "RGBA").convert("RGB").convert("HSV"))
    tinted = hsv[..., 1] > TINT_SAT
    hsv[..., 0] = hue
    out = px.copy()
    out[tinted, :3] = np.array(Image.fromarray(hsv, "HSV").convert("RGB"))[tinted]
    return out


def main() -> None:
    src = os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else SRC)
    out = os.path.join(ROOT, sys.argv[2] if len(sys.argv) > 2 else OUT)
    sheet = np.array(Image.open(src).convert("RGBA"))
    alpha = sheet[..., 3]

    found = bands(alpha)
    if len(found) != 3:
        raise SystemExit(f"判定ライン・灰色・点灯の 3 段のはずが {len(found)} 段ある: {found}")
    judge_rows, gray_rows, lit_rows = found
    scale = JUDGE_W / sheet.shape[1]

    # 段ごとに塊を左から COLUMN_ORDER に当てる。灰色版と点灯版は x の範囲を合わせ、同じ幅で切り出す
    band_h = max(gray_rows[1] - gray_rows[0], lit_rows[1] - lit_rows[0])
    rows = {}
    for key, (y0, _) in (("gray", gray_rows), ("lit", lit_rows)):
        px = sheet[y0:y0 + band_h]
        label, comps = components(px[..., 3] > ALPHA_MIN)
        if len(comps) != len(COLUMN_ORDER):
            raise SystemExit(f"{key}: パッドが {len(COLUMN_ORDER)} 個のはずが {len(comps)} 個ある")
        rows[key] = (px, label, comps)

    h = round(band_h * scale)
    if h > PAD_H:
        raise SystemExit(f"縮小後の高さ {h} がパッド列 {PAD_H} を超える")
    pads = {}
    for i, name in enumerate(COLUMN_ORDER):
        x0 = min(rows[k][2][i][1] for k in rows)
        x1 = max(rows[k][2][i][2] for k in rows)
        crops = {}
        for key, (px, label, comps) in rows.items():
            crops[key] = keep(px[:, x0:x1], label[:, x0:x1] == comps[i][0])
        if name in HUE_FROM_RING:
            crops["lit"] = set_hue(crops["lit"], ring_hue(crops["gray"]))
        w = round((x1 - x0) * scale)
        pads[name] = {k: Image.fromarray(v, "RGBA").resize((w, h), Image.LANCZOS) for k, v in crops.items()}

    jy0, jy1 = judge_rows
    judge = keep(sheet[jy0:jy1], alpha[jy0:jy1] > ALPHA_MIN)
    judge = Image.fromarray(judge, "RGBA").resize((JUDGE_W, round((jy1 - jy0) * scale)), Image.LANCZOS)

    width = max(sum(p["gray"].width for p in pads.values()) + GAP * (len(pads) - 1), judge.width)
    result = Image.new("RGBA", (width, PAD_H * 2 + judge.height), (0, 0, 0, 0))
    pad_src = {}
    x = 0
    y = (PAD_H - h) // 2
    for name in COLUMN_ORDER:
        result.paste(pads[name]["gray"], (x, y))
        result.paste(pads[name]["lit"], (x, PAD_H + y))
        pad_src[name] = (x, pads[name]["gray"].width)
        x += pads[name]["gray"].width + GAP
    result.paste(judge, (0, PAD_H * 2))

    result.save(out)
    print(f"{os.path.relpath(out, ROOT)}: {result.width}x{result.height}(縮小率 {scale:.4f})")
    print("PAD_SRC = {", ", ".join(f"{n}: [{sx}, {sw}]" for n, (sx, sw) in pad_src.items()), "}")
    print(f"JUDGE_SRC = [0, {PAD_H * 2}, {judge.width}, {judge.height}]")


if __name__ == "__main__":
    main()
