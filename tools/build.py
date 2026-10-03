"""js/ の ES Modules を 1 本の通常スクリプト dist/dojo.bundle.js に束ねる。

index.html を file:// で直接開いたとき、ブラウザは <script type="module"> を読み込めない(CORS)。
そのため file:// では dist/dojo.bundle.js を、HTTP 配信時はそのまま ES Modules を読む。
ソースを変更したら `python tools/build.py` を実行し直すこと。

変換内容(依存無し・正規表現ベース):
  import { a, b as c } from './x.js'  →  const { a, b: c } = __require('js/core/x.js');
  export function/class/const/let     →  宣言のみ残し、モジュール末尾で exports に登録
  export { a, b as c };               →  末尾で exports に登録
各モジュールは独自の関数スコープに包むので、モジュール間の名前衝突は起きない。
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = "js/main.js"
OUT = "dist/dojo.bundle.js"

IMPORT_RE = re.compile(r"import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]\s*;?", re.S)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\}\s*;?[ \t]*$", re.M)
EXPORT_DECL_RE = re.compile(r"^export\s+(async function|function|class|const|let|var)\b(.*)$", re.M)


def resolve(from_file: str, spec: str) -> str:
    base = os.path.dirname(from_file)
    return os.path.normpath(os.path.join(base, spec)).replace("\\", "/")


def transform(path: str, deps: list[str]) -> str:
    src = open(os.path.join(ROOT, path), encoding="utf-8").read()
    if src.startswith("﻿"):
        src = src[1:]

    def imp(m: re.Match) -> str:
        dep = resolve(path, m.group(2))
        deps.append(dep)
        parts = []
        for n in m.group(1).split(","):
            n = n.strip()
            if not n:
                continue
            if " as " in n:
                a, b = [x.strip() for x in n.split(" as ")]
                parts.append(f"{a}: {b}")
            else:
                parts.append(n)
        return f"const {{ {', '.join(parts)} }} = __require('{dep}');"

    src = IMPORT_RE.sub(imp, src)
    if re.search(r"^\s*import\b", src, re.M):
        raise SystemExit(f"{path}: unsupported import form (only named imports are handled)")

    exports: list[tuple[str, str]] = []  # (exported name, local name)

    def exp_list(m: re.Match) -> str:
        for n in m.group(1).split(","):
            n = n.strip()
            if not n:
                continue
            if " as " in n:
                a, b = [x.strip() for x in n.split(" as ")]
                exports.append((b, a))
            else:
                exports.append((n, n))
        return ""

    src = EXPORT_LIST_RE.sub(exp_list, src)

    def exp_decl(m: re.Match) -> str:
        kind, rest = m.group(1), m.group(2)
        if kind in ("function", "async function", "class"):
            name = re.match(r"\s*(\w+)", rest).group(1)
            exports.append((name, name))
        else:
            for d in re.finditer(r"(\w+)\s*=", rest):
                exports.append((d.group(1), d.group(1)))
        return f"{kind}{rest}"

    src = EXPORT_DECL_RE.sub(exp_decl, src)
    if re.search(r"^\s*export\b", src, re.M):
        raise SystemExit(f"{path}: unsupported export form")

    reg = ", ".join(f"{e}: {l}" if e != l else e for e, l in exports)
    return (
        f"__define('{path}', function (exports) {{\n"
        f"{src}\n"
        f"Object.assign(exports, {{ {reg} }});\n"
        f"//# sourceURL={path}\n"
        f"}});\n"
    )


def main() -> None:
    modules: dict[str, str] = {}
    pending = [ENTRY]
    while pending:
        path = pending.pop()
        if path in modules:
            continue
        deps: list[str] = []
        modules[path] = transform(path, deps)
        for d in deps:
            if d not in modules:
                pending.append(d)

    prelude = (
        "// 自動生成: python tools/build.py が js/ から束ねたもの。直接編集しないこと。\n"
        "(function () {\n"
        "'use strict';\n"
        "const __defs = {};\n"
        "const __cache = {};\n"
        "function __define(id, fn) { __defs[id] = fn; }\n"
        "function __require(id) {\n"
        "  if (__cache[id]) return __cache[id];\n"
        "  if (!__defs[id]) throw new Error('module not bundled: ' + id);\n"
        "  const exports = {};\n"
        "  __cache[id] = exports;\n"
        "  __defs[id](exports);\n"
        "  return exports;\n"
        "}\n"
    )
    body = "".join(modules[p] for p in sorted(modules))
    tail = f"__require('{ENTRY}');\n}})();\n"
    out_path = os.path.join(ROOT, OUT)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(prelude + body + tail)
    size = os.path.getsize(out_path)
    print(f"wrote {OUT} ({size} bytes, {len(modules)} modules)")


if __name__ == "__main__":
    main()
