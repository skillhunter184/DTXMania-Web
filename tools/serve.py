"""iPad などほかの端末から遊べるように、リポジトリを LAN へ HTTP 配信する。serve.bat から呼ぶ。

テスト用の `python -m http.server 8765 --bind 127.0.0.1` との違い:
  - 0.0.0.0 で待ち受け、iPad で開く URL(この PC の LAN 側のアドレス)を表示する
  - .js の MIME を固定する。Windows はレジストリ次第で .js が text/plain になり、Safari は
    それを ES Modules として読まない
  - Cache-Control: no-cache を付ける。js/ を変えたあと iPad が古いモジュールを使い続けないように
    (変わっていなければ 304 で返るので重くはない)
  - ポートはテスト用(8765)と分ける。iPad 側の設定と前回の ZIP はオリジン(ポート込み)ごとに
    保存されるので、空いていないときに別のポートへ逃げると引き継がれない。逃げずに止める
  - 1 リクエストごとのログは出さない。端末ごとの初回接続とエラーだけ出す
"""

from __future__ import annotations

import os
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PORT = 8770
ZIP_LIST_MAX = 10


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
    }
    clients: set[str] = set()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_request(self, code="-", size="-") -> None:
        ip = self.client_address[0]
        if ip not in Handler.clients:
            Handler.clients.add(ip)
            print(f"{ip} からつながりました")
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        # Safari が勝手に取りに来るアイコンの 404 は出さない
        name = self.path.split("?", 1)[0].rsplit("/", 1)[-1]
        if status >= 400 and not name.startswith(("favicon", "apple-touch-icon")):
            super().log_request(code, size)

    def log_error(self, format, *args) -> None:
        pass  # 中身は log_request が要求行ごと出す


class Server(ThreadingHTTPServer):
    # Windows の SO_REUSEADDR は使用中のポートにも重ねて bind できてしまい、
    # ほかのサーバーと同じポートを黙って取り合う。排他にして、使用中なら失敗させる
    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def lan_addresses() -> list[str]:
    """iPad から届くこの PC のアドレス。既定経路の出口を優先する(WSL などの仮想アダプタを避ける)。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # UDP の connect はパケットを送らず経路を決めるだけ。宛先は文書用の予約アドレス
        s.connect(("192.0.2.1", 1))
        addr = s.getsockname()[0]
        if not addr.startswith(("127.", "0.")):
            return [addr]
    except OSError:
        pass
    finally:
        s.close()
    try:
        addrs = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        return []
    return [a for a in addrs if not a.startswith("127.")]


def find_zips() -> list[str]:
    """配信フォルダの中の ZIP(?zip= で開ける)。隠しフォルダ(.git / .claude)は見ない。"""
    found = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for f in sorted(filenames):
            if f.lower().endswith(".zip"):
                found.append(os.path.relpath(os.path.join(dirpath, f), ROOT).replace("\\", "/"))
    return found


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(line_buffering=True)
    try:
        port = int(argv[0]) if argv else DEFAULT_PORT
    except ValueError:
        print(f"ポート番号が読めません: {argv[0]}(例: serve.bat {DEFAULT_PORT})")
        return 1

    try:
        httpd = Server(("0.0.0.0", port), partial(Handler, directory=ROOT))
    except OSError as e:
        print(f"ポート {port} で待ち受けられません({e.strerror or e})。")
        print(f"ほかのサーバーが使っていないか確かめるか、serve.bat {port + 1} のように別のポートを指定してください。")
        print("(iPad 側の設定と前回の ZIP はポートごとに別々に保存されます)")
        return 1

    addrs = lan_addresses()
    base = f"http://{addrs[0]}:{port}/" if addrs else None
    print(f"DTXMania Web を配信しています({ROOT})")
    print()
    for a in addrs:
        print(f"  iPad / スマホ:  http://{a}:{port}/")
    if not addrs:
        print("  この PC の LAN 側のアドレスが見つかりません(ネットワークにつながっていますか)")
    print(f"  この PC:        http://localhost:{port}/")

    zips = find_zips()
    if zips and base:
        print()
        print("  ここにある ZIP をそのまま開く(iPad では「フォルダを選ぶ」が使えないので):")
        for z in zips[:ZIP_LIST_MAX]:
            print(f"    {base}?zip={quote(z, safe='/')}")
        if len(zips) > ZIP_LIST_MAX:
            print(f"    ほか {len(zips) - ZIP_LIST_MAX} 個")

    print()
    print("iPad から開けないとき:")
    print("  - PC と iPad が同じ Wi-Fi / LAN にいるか")
    print("  - Windows のファイアウォールで Python が許可されているか。初回に出るダイアログで許可する。")
    print("    ネットワークが「パブリック」だと既定で止められるので、自宅なら「プライベート」にしてから許可する")
    print("  - つながると、この窓に「(iPad のアドレス) からつながりました」と出る")
    print("電子ドラム(Web MIDI)は iPad の Safari / Chrome では使えない。Web MIDI 付きのブラウザアプリ")
    print("(Web MIDI Browser など)で開く。PC の Chrome でも LAN のアドレスで開くと使えない(HTTPS か localhost に限られる)。")
    print()
    print("止めるときは Ctrl+C か、この窓を閉じる。動いている間はこのフォルダの中身を LAN のどの端末からも読めます。")

    with httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("止めました。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
