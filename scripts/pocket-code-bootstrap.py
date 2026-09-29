"""Network-free bootstrap for the TypeScript pocket-code production CLI."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import discover_repository_root, resolve_node_runtime, StartupError  # noqa: E402


def main() -> int:
    invocation_cwd = os.getcwd()
    root = discover_repository_root(Path(__file__))
    try:
        node = resolve_node_runtime(root)
    except StartupError as error:
        sys.stderr.write(f"pocket-code: {error}\n")
        return 1
    entry = root / "apps" / "pocket-cli" / "src" / "pocket-code.ts"
    tsx_package = root / "node_modules" / "tsx" / "package.json"
    if not tsx_package.is_file() or not entry.is_file():
        sys.stderr.write("pocket-code: Codex Pocket dependencies are missing.\n")
        return 1
    environment = dict(os.environ)
    environment["CODEX_POCKET_NODE_EXE"] = str(node)
    environment["CODEX_POCKET_INVOKE_CWD"] = invocation_cwd
    environment["PYTHONUTF8"] = "1"
    return subprocess.run([str(node), "--import", "tsx", str(entry), *sys.argv[1:]], cwd=root, env=environment).returncode


if __name__ == "__main__":
    raise SystemExit(main())
