# SPDX-License-Identifier: LGPL-2.1-or-later
"""tests/fixtures/ のテスト用データ(音源・ZIP・期待値)を作る。依存無し(標準ライブラリだけ)。

音はすべてここで合成する(実曲パックの音源は再配布できないので使わない)。同じ入力からは毎回同じバイト列ができる。

  Bass.xa       キック風(周波数が下がるサイン + 立ち上がりのノイズ)。8 bit・モノラル
  SideStick.xa  サイドスティック風(短いノイズ + 2 つの共鳴)。4 bit・モノラル
  Snare.xa      スネア風(ノイズ + 胴鳴り。左右で少し違う)。6 bit・ステレオ
  tiny.wav      440 Hz のサイン 100 サンプル(16 bit・モノラル)
  pack_sjis.zip Shift-JIS 名の曲フォルダ(UTF-16 の set.def・Shift-JIS の .dtx・上の Kick / Snare)と、
                UTF-8 フラグ付きの名前のエントリ。deflate / 格納 / データディスクリプタを混ぜる
  pack_sjis.json, xa_refs.json  テストの期待値(xa_refs はこのファイルの Python 版デコーダで復号した結果)

.xa(KWD1 / bjXA ADPCM)の符号化・復号は js/core/xa.js と同じ形式を扱うので、xa.js と同じく LGPL-2.1-or-later とする
(THIRD_PARTY_NOTICES.md)。

  python tools/make_fixtures.py
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures")
RATE = 44100

# ---- 音の合成(int16 の列を返す) ----


def _i16(x: float) -> int:
    return max(-32768, min(32767, int(round(x * 32767))))


def synth_bass(n: int = 15000) -> list[int]:
    rnd = random.Random(1)
    out = []
    phase = 0.0
    for i in range(n):
        t = i / RATE
        f = 48 + 90 * math.exp(-t / 0.035)
        phase += 2 * math.pi * f / RATE
        body = math.sin(phase) * math.exp(-t / 0.16)
        click = (rnd.random() * 2 - 1) * math.exp(-t / 0.0025) * 0.6
        out.append(_i16(0.8 * body + click))
    return out


def synth_sidestick(n: int = 12000) -> list[int]:
    rnd = random.Random(2)
    out = []
    for i in range(n):
        t = i / RATE
        noise = (rnd.random() * 2 - 1) * math.exp(-t / 0.006)
        ring = 0.5 * math.sin(2 * math.pi * 1650 * t) * math.exp(-t / 0.03)
        wood = 0.4 * math.sin(2 * math.pi * 510 * t) * math.exp(-t / 0.05)
        out.append(_i16(0.7 * (noise + ring + wood)))
    return out


def synth_snare(n: int = 14000) -> tuple[list[int], list[int]]:
    chans = []
    for seed, pan in ((3, 0.9), (4, 1.0)):
        rnd = random.Random(seed)
        ch = []
        lp = 0.0
        for i in range(n):
            t = i / RATE
            lp += 0.55 * ((rnd.random() * 2 - 1) - lp)  # 少し丸めたノイズ(響き線)
            wires = lp * math.exp(-t / 0.11)
            shell = 0.6 * math.sin(2 * math.pi * 190 * t) * math.exp(-t / 0.05)
            ch.append(_i16(0.75 * pan * (wires + shell)))
        chans.append(ch)
    return chans[0], chans[1]


def tiny_wav() -> bytes:
    data = b"".join(struct.pack("<h", int(16383.5 * math.sin(2 * math.pi * 440 * i / RATE))) for i in range(100))  # 0 方向へ切り捨て
    fmt = struct.pack("<HHIIHH", 1, 1, RATE, RATE * 2, 2, 16)
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", len(data)) + data


# ---- .xa(KWD1)の符号化と復号 ----
# ヘッダ 32 バイト: 'KWD1' / データ長 / サンプル数 / レート(u16) / ビット数(u8) / チャンネル数(u8) / ループ位置 /
# 各 ch の直前 2 サンプル(int16 × 2 × 2) / 予備。本体は 32 サンプルのブロックの並びで、ブロックの中は
# ch ごとに「プロファイル 1 バイト(上位 4 bit = 予測係数の番号、下位 4 bit = 右シフト量)+ 32 個の符号」。

MAGIC = 0x3144574B
BLOCK = 32
GAIN = [(0, 0), (240, 0), (460, -208), (392, -220), (488, -240)]


def _div256(a: int) -> int:
    """0 方向へ切り捨てる a / 256(xa.js の Math.trunc と同じ)。"""
    q = abs(a) // 256
    return -q if a < 0 else q


def _clamp16(v: int) -> int:
    return 32767 if v > 32767 else -32768 if v < -32768 else v


def _encode_block(xs: list[int], state: list[int], bits: int) -> tuple[int, list[int], list[int]]:
    """32 サンプルを、復号した値の二乗誤差がいちばん小さい (係数, シフト, 符号) で符号化する。"""
    unit = 1 << (16 - bits)
    lo, hi = -(1 << (bits - 1)), (1 << (bits - 1)) - 1
    best = None
    for factor, (g0, g1) in enumerate(GAIN):
        for rng in range(13):
            p0, p1 = state
            err = 0
            codes = []
            for x in xs:
                pred = _div256(p0 * g0 + p1 * g1)
                c0 = max(lo, min(hi, round((x - pred) * (1 << rng) / unit)))
                pick = None
                for c in (c0 - 1, c0, c0 + 1):
                    if c < lo or c > hi:
                        continue
                    s = _clamp16(((c * unit) >> rng) + pred)
                    if pick is None or abs(s - x) < abs(pick[1] - x):
                        pick = (c, s)
                c, s = pick
                err += (s - x) * (s - x)
                if best is not None and err >= best[0]:
                    break
                codes.append(c)
                p1, p0 = p0, s
            else:
                best = (err, (factor << 4) | rng, codes, [p0, p1])
    _, profile, codes, end = best
    return profile, codes, end


def _pack(codes: list[int], bits: int) -> bytes:
    if bits == 8:
        return bytes(c & 0xFF for c in codes)
    if bits == 4:
        return bytes(((codes[i] & 0xF) << 4) | (codes[i + 1] & 0xF) for i in range(0, 32, 2))
    out = bytearray()
    for i in range(0, 32, 4):
        p = ((codes[i] & 0x3F) << 18) | ((codes[i + 1] & 0x3F) << 12) | ((codes[i + 2] & 0x3F) << 6) | (codes[i + 3] & 0x3F)
        out += bytes(((p >> 16) & 0xFF, (p >> 8) & 0xFF, p & 0xFF))
    return bytes(out)


def encode_xa(chans: list[list[int]], bits: int) -> bytes:
    n = len(chans[0])
    blocks = (n + BLOCK - 1) // BLOCK
    states = [[0, 0] for _ in chans]
    body = bytearray()
    for b in range(blocks):
        for ch, xs in enumerate(chans):
            seg = xs[b * BLOCK:(b + 1) * BLOCK]
            seg = seg + [0] * (BLOCK - len(seg))
            profile, codes, states[ch] = _encode_block(seg, states[ch], bits)
            body.append(profile)
            body += _pack(codes, bits)
    head = struct.pack("<IIIHBBI", MAGIC, len(body), n, RATE, bits, len(chans), 0) + bytes(12)
    return head + bytes(body)


def _unpack(block: bytes, bits: int) -> list[int]:
    """1 ch 分の符号を int16 の値(符号を上位ビットに寄せたもの)に戻す。"""
    def s16(v: int) -> int:
        v &= 0xFFFF
        return v - 0x10000 if v & 0x8000 else v

    if bits == 8:
        return [s16(b << 8) for b in block]
    if bits == 4:
        return [s16(v) for b in block for v in ((b & 0xF0) << 8, (b & 0x0F) << 12)]
    out = []
    for i in range(0, len(block), 3):
        p = (block[i] << 16) | (block[i + 1] << 8) | block[i + 2]
        out += [s16(((p >> sh) & 0x3F) << 10) for sh in (18, 12, 6, 0)]
    return out


def decode_xa(data: bytes) -> dict:
    """テストの期待値を作るための復号(js/core/xa.js とは別に書いたもの)。int16 を ch 順に交互に並べて返す。"""
    magic, dlen, n, rate, bits, chs, _ = struct.unpack_from("<IIIHBBI", data, 0)
    assert magic == MAGIC
    states = [list(struct.unpack_from("<hh", data, 20 + 4 * c)) for c in range(chs)]
    per = bits * 4 + 1
    pcm = [[] for _ in range(chs)]
    off = 32
    while off < 32 + dlen:
        for c in range(chs):
            profile = data[off]
            vals = _unpack(data[off + 1:off + per], bits)
            off += per
            g0, g1 = GAIN[profile >> 4]
            rng = profile & 0x0F
            p0, p1 = states[c]
            for v in vals:
                s = _clamp16((v >> rng) + _div256(p0 * g0 + p1 * g1))
                pcm[c].append(s)
                p1, p0 = p0, s
            states[c] = [p0, p1]
    inter = [pcm[c][i] for i in range(n) for c in range(chs)]
    return {"rate": rate, "channels": chs, "samples": n, "bits": bits, "int16": inter}


# ---- ZIP(Shift-JIS 名を UTF-8 フラグ無しで書くため、zipfile を使わずに組む) ----

DOS_DATE = (0 << 9) | (1 << 5) | 1  # 1980-01-01


def build_zip(entries: list[tuple[bytes, bytes, dict]]) -> bytes:
    """entries: (名前のバイト列, 中身, {deflate, utf8, descriptor})。"""
    out = bytearray()
    central = bytearray()
    for name, data, opt in entries:
        crc = zlib.crc32(data) & 0xFFFFFFFF
        if opt.get("deflate"):
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            comp = co.compress(data) + co.flush()
            method = 8
        else:
            comp = data
            method = 0
        flags = (0x800 if opt.get("utf8") else 0) | (0x8 if opt.get("descriptor") else 0)
        offset = len(out)
        if opt.get("descriptor"):
            out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, flags, method, 0, DOS_DATE, 0, 0, 0, len(name), 0)
            out += name + comp
            out += struct.pack("<IIII", 0x08074B50, crc, len(comp), len(data))
        else:
            out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, flags, method, 0, DOS_DATE, crc, len(comp), len(data), len(name), 0)
            out += name + comp
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, flags, method, 0, DOS_DATE, crc, len(comp), len(data),
                               len(name), 0, 0, 0, 0, 0, offset)
        central += name
    cd_off = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(central), cd_off, 0)
    return bytes(out)


SONG_DIR = "道場テスト/"
DTX_TEXT = (
    "; test chart\r\n#TITLE: テスト曲\r\n#ARTIST: 作者\r\n#BPM: 120\r\n#DLEVEL: 50\r\n#WAV01: BGM.ogg\r\n"
    "#WAV02: Sounds\\Kick.wav\r\n#VOLUME02: 80\r\n#WAV03: Sounds\\Snare.xa\r\n#PAN03: -20\r\n"
    "#00013: 02020202\r\n#00012: 00030003\r\n#00001: 01\r\n"
)
SETDEF_TEXT = "#TITLE: テストセット\r\n#L1LABEL: BASIC\r\n#L1FILE: 譜面.dtx\r\n"


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    sounds = {
        "Bass.xa": encode_xa([synth_bass()], 8),
        "SideStick.xa": encode_xa([synth_sidestick()], 4),
        "Snare.xa": encode_xa(list(synth_snare()), 6),
    }
    wav = tiny_wav()
    refs = []
    for name, data in sounds.items():
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        d = decode_xa(data)
        pcm = struct.pack("<%dh" % len(d["int16"]), *d["int16"])
        refs.append({
            "file": name, "rate": d["rate"], "channels": d["channels"], "samples": d["samples"],
            "sha256_int16": hashlib.sha256(pcm).hexdigest(), "first64": d["int16"][:64], "bits": d["bits"],
        })
    with open(os.path.join(OUT, "tiny.wav"), "wb") as f:
        f.write(wav)

    dtx = DTX_TEXT.encode("cp932")
    sj = lambda s: s.encode("cp932")  # noqa: E731
    pack = build_zip([
        (sj(SONG_DIR), b"", {}),
        (sj(SONG_DIR + "譜面.dtx"), dtx, {"deflate": True}),
        (sj(SONG_DIR + "set.def"), b"\xff\xfe" + SETDEF_TEXT.encode("utf-16-le"), {}),
        (sj(SONG_DIR + "Sounds/Kick.wav"), wav, {"deflate": True, "descriptor": True}),
        (sj(SONG_DIR + "Sounds/Snare.xa"), sounds["Snare.xa"], {"deflate": True}),
        ("utf8名前/readme.txt".encode("utf-8"), "utf-8 名前のエントリ".encode("utf-8"), {"utf8": True}),
    ])
    with open(os.path.join(OUT, "pack_sjis.zip"), "wb") as f:
        f.write(pack)
    with open(os.path.join(OUT, "pack_sjis.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"dtx_crc": zlib.crc32(dtx) & 0xFFFFFFFF, "wav_len": len(wav), "xa_len": len(sounds["Snare.xa"]),
                   "dtx_len": len(dtx)}, f)
    with open(os.path.join(OUT, "xa_refs.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(refs, f)
    for r in refs:
        print(f"{r['file']}: {r['bits']} bit / {r['channels']} ch / {r['samples']} samples")
    print("pack_sjis.zip:", len(pack), "bytes")


if __name__ == "__main__":
    main()
