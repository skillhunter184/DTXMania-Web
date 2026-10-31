"""E-GMD(Magenta の Expanded Groove MIDI Dataset、CC BY 4.0)の一部だけを落とす。

90 GB の ZIP を丸ごと落とさず、HTTP の範囲指定で中央ディレクトリを読み、選んだ曲の WAV と MIDI だけを取り出す。
選び方: 学習の側(split = train)は同じ演奏(id)ごとにキットを KITS_PER_SEQ 個、検証の側(validation)は 1 個、
乱数(種を決めてある)で選ぶ。キットの数が偏らないよう、使った回数の少ないキットから選ぶ。

    python tools/adt/fetch_egmd.py D:/adtdata/egmd

出典: https://magenta.tensorflow.org/datasets/e-gmd (Callender, Hawthorne, Engel. "Improving Perceptual Quality of
Drum Transcription with the Expanded Groove MIDI Dataset", 2020)
"""

from __future__ import annotations

import csv
import io
import os
import random
import struct
import sys
import threading
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor

import requests

URL = "https://storage.googleapis.com/magentadata/datasets/e-gmd/v1.0.0/e-gmd-v1.0.0.zip"
CSV_URL = "https://storage.googleapis.com/magentadata/datasets/e-gmd/v1.0.0/e-gmd-v1.0.0.csv"
KITS_PER_SEQ = 5
VAL_KITS_PER_SEQ = 1
SEED = 20261101


class RangeFile(io.RawIOBase):
    """範囲指定で読む、シークできるファイル(zipfile が中央ディレクトリを読むのに使う)。"""

    def __init__(self, url: str):
        self.url = url
        self.s = requests.Session()
        r = self.s.head(url)
        self.size = int(r.headers["Content-Length"])
        self.pos = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        r = self.s.get(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        r.raise_for_status()
        b = r.content
        self.pos += len(b)
        return b

    def readinto(self, buf):
        b = self.read(len(buf))
        buf[: len(b)] = b
        return len(b)


_local = threading.local()


def fetch_member(info: zipfile.ZipInfo, out_path: str) -> int:
    """1 つのファイルを 1 回の範囲指定で読んで展開する(局所ヘッダの長さは余分に読んで合わせる)。"""
    if os.path.exists(out_path) and os.path.getsize(out_path) == info.file_size:
        return 0
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
    start = info.header_offset
    end = start + 30 + len(info.orig_filename.encode()) + 1024 + info.compress_size
    for attempt in range(5):
        try:
            r = s.get(URL, headers={"Range": f"bytes={start}-{end}"}, timeout=120)
            r.raise_for_status()
            b = r.content
            sig, = struct.unpack_from("<I", b, 0)
            assert sig == 0x04034B50, "local header"
            n, e = struct.unpack_from("<HH", b, 26)
            data = b[30 + n + e: 30 + n + e + info.compress_size]
            assert len(data) == info.compress_size, "short read"
            if info.compress_type == zipfile.ZIP_DEFLATED:
                raw = zlib.decompressobj(-15).decompress(data)
            else:
                raw = data
            assert len(raw) == info.file_size, "size"
            assert zlib.crc32(raw) == info.CRC, "crc"
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path + ".part", "wb") as fp:
                fp.write(raw)
            os.replace(out_path + ".part", out_path)
            return len(data)
        except Exception as ex:  # noqa: BLE001
            print("retry", info.filename, ex, file=sys.stderr)
    raise RuntimeError(f"failed: {info.filename}")


def choose(rows: list[dict]) -> list[dict]:
    rng = random.Random(SEED)
    used = {}
    out = []
    by_id: dict[str, list[dict]] = {}
    for r in rows:
        by_id.setdefault((r["split"], r["id"]), []).append(r)
    for (split, _id), rs in sorted(by_id.items()):
        k = KITS_PER_SEQ if split == "train" else VAL_KITS_PER_SEQ if split == "validation" else 0
        if not k:
            continue
        rng.shuffle(rs)
        rs.sort(key=lambda r: used.get(r["kit_name"], 0))
        for r in rs[:k]:
            used[r["kit_name"]] = used.get(r["kit_name"], 0) + 1
            out.append(r)
    return out


def main(dest: str):
    os.makedirs(dest, exist_ok=True)
    csv_path = os.path.join(dest, "e-gmd-v1.0.0.csv")
    if not os.path.exists(csv_path):
        with open(csv_path, "wb") as fp:
            fp.write(requests.get(CSV_URL).content)
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    sel = choose(rows)
    hours = sum(float(r["duration"]) for r in sel) / 3600
    print(f"selected {len(sel)} files, {hours:.1f} h "
          f"(train {sum(r['split'] == 'train' for r in sel)}, val {sum(r['split'] == 'validation' for r in sel)})")
    with open(os.path.join(dest, "selected.csv"), "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(sel)
    zf = zipfile.ZipFile(io.BufferedReader(RangeFile(URL), buffer_size=1 << 20))
    names = {i.filename: i for i in zf.infolist()}
    prefix = next(iter(names)).split("/")[0] + "/"
    jobs = []
    for r in sel:
        for key in ("audio_filename", "midi_filename"):
            name = prefix + r[key]
            if name not in names:
                print("missing", name, file=sys.stderr)
                continue
            jobs.append((names[name], os.path.join(dest, r[key])))
    total = 0
    done = 0
    with ThreadPoolExecutor(16) as ex:
        for nbytes in ex.map(lambda j: fetch_member(*j), jobs):
            total += nbytes
            done += 1
            if done % 200 == 0:
                print(f"{done}/{len(jobs)} files, {total / 1e9:.2f} GB", flush=True)
    print("done", done, f"{total / 1e9:.2f} GB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "D:/adtdata/egmd")
