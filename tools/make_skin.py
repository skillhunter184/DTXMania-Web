"""既定のスキン skins/default/ の画像(chips.png / pads.png / score_panel.png / song_panel.png / gb_chips.png / gb_neck.png)を作る。

絵は tools/skinart/ の Canvas の描画で、tools/skinart/render.html をヘッドレスの Chrome(か Edge)で開いて画像にする。
アプリはこのコードを読まず、出来上がった画像だけを使う。絵を変えたら実行し直して、画像もコミットする。

  python tools/make_skin.py [--scale 2] [--url http://localhost:8765/] [--browser パス]

--url を省くと、このリポジトリをその場で一時的に配信して開く(終わったら止める)。
ブラウザは --browser、環境変数 CHROME、よくあるインストール先の順に探す。Pillow があれば PNG を最適化して書く。
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "skins", "default")
NAMES = ["chips.png", "pads.png", "score_panel.png", "song_panel.png", "gb_chips.png", "gb_neck.png"]

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome", "chromium", "chromium-browser", "microsoft-edge",
]


def find_browser(explicit: str | None) -> str:
    for cand in [explicit, os.environ.get("CHROME"), *BROWSERS]:
        if not cand:
            continue
        if os.path.isfile(cand):
            return cand
        found = shutil.which(cand)
        if found:
            return found
    sys.exit("Chrome / Edge が見つからない。--browser で実行ファイルを指定する")


def optimize_png(raw: bytes) -> bytes:
    """Pillow があれば同じ画素のまま圧縮し直す(ブラウザの PNG は大きい)。"""
    try:
        import io

        from PIL import Image
    except ImportError:
        return raw
    out = io.BytesIO()
    Image.open(io.BytesIO(raw)).save(out, "PNG", optimize=True)
    return out.getvalue() if out.tell() < len(raw) else raw


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def log_message(self, *args):  # 配信のログは出さない
        pass


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--scale", type=float, default=2, help="等倍(skins/README.md の大きさ)に対する倍率(2 で 4K まで足りる)")
    ap.add_argument("--url", help="このリポジトリを配信している URL(末尾 /)。省くと一時的に配信する")
    ap.add_argument("--browser", help="Chrome / Edge の実行ファイル")
    args = ap.parse_args()

    browser = find_browser(args.browser)
    server = None
    base = args.url
    if not base:
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=ROOT))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/"
    url = f"{base.rstrip('/')}/tools/skinart/render.html?scale={args.scale:g}"
    try:
        with tempfile.TemporaryDirectory() as profile:
            run = subprocess.run(
                [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={profile}",
                 "--virtual-time-budget=15000", "--dump-dom", url],
                capture_output=True, timeout=180,
            )
    finally:
        if server:
            server.shutdown()
    dom = run.stdout.decode("utf-8", "replace")
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip():
        sys.exit("画像を受け取れなかった(" + url + " をブラウザで開いてエラーを確かめる)")
    data = json.loads(html.unescape(m.group(1)))
    os.makedirs(OUT, exist_ok=True)
    for name in NAMES:
        head, b64 = data[name].split(",", 1)
        assert head == "data:image/png;base64", head
        raw = optimize_png(base64.b64decode(b64))
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(raw)
        w, h = int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
        print(f"{name}: {w}x{h} ({len(raw)} bytes)")


if __name__ == "__main__":
    main()
