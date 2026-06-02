"""Decode the latest game-engine MCP screenshot JSON into a PNG on disk.

Usage:
  python tools/decode_screenshot.py <input_json_or_file> <output_png>

The screenshot response shape is `{"status":"ok","result":{"text":..., "images":["<base64>", ...]}}`.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: decode_screenshot.py <input.json> <output.png>", file=sys.stderr)
        return 2

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    raw = src.read_text(encoding="utf-8")
    # tool-results files start with a <persisted-output> banner — strip it
    if raw.startswith("<persisted-output>"):
        idx = raw.find("{")
        raw = raw[idx:]
    # tool-results files also have a trailing "..." preview marker — find first balanced JSON
    if "\n..." in raw:
        raw = raw.split("\n...")[0]

    payload = json.loads(raw)
    images = payload["result"]["images"]
    if not images:
        raise RuntimeError("no images in payload")
    png_b64 = images[0]
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(base64.b64decode(png_b64))
    print(f"wrote {dst} ({dst.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
