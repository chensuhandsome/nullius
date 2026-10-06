#!/usr/bin/env python3
"""
Suggest the next draft round tag using a clean scheme: <base>-r1, <base>-r2, ...

Policy:
- The "base" tag is the provided tag with any trailing "-r<digits>" segments stripped repeatedly
  (so D0-r1-r1 -> base D0).
- The next round is chosen by scanning OUT_DIR for existing draft reports named:
    <base>-rN_draft_member_a.md / <base>-rN_draft_member_b.md / <base>-rN_draft_member_c_leader.md
  and returning N = max(existing)+1. If none exist, return <base>-r1.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from run_paths import canonical_output_runs, read_team_payloads



ROUND_SUFFIX_RE = re.compile(r"(?:-r\d+)+$")


def canonical_base(tag: str) -> str:
    return ROUND_SUFFIX_RE.sub("", tag)


def find_max_round(base: str, out_dir: Path) -> int:
    canonical_output_runs(out_dir)
    max_n = 0
    pat = re.compile(rf"^{re.escape(base)}-r(\d+)_draft_member_(a|b|c_leader)\.md$")
    scan_dirs = read_team_payloads(out_dir.absolute().parent)

    for d in scan_dirs:
        for p in d.iterdir():
            if not p.is_file():
                continue
            m = pat.match(p.name)
            if not m:
                continue
            n = int(m.group(1))
            if n > max_n:
                max_n = n
    return max_n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tag", required=True, help="Current tag, e.g. D0 or D0-r1 or D0-r1-r1.")
    ap.add_argument("--out-dir", type=Path, required=True, help="Draft reviews output directory to scan (the project artifacts directory).")
    args = ap.parse_args()

    base = canonical_base(args.tag.strip())
    if not base:
        raise SystemExit("ERROR: empty base tag after stripping round suffixes")

    max_round = find_max_round(base, args.out_dir)
    print(f"{base}-r{max_round + 1}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

