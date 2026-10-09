#!/usr/bin/env python3
"""Freeze an explicitly supplied neutral problem packet for reproduction members."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from team_config import load_team_config


def prepare_packet(notes: Path, root: Path, candidate_packet: Path, output: Path,
                   explicit_source: Path | None = None) -> Path:
    root = root.resolve()
    cfg = load_team_config(notes)
    enabled = cfg.feature_enabled("independent_reproduction_gate", default=False)
    if not enabled and explicit_source is None:
        return candidate_packet.resolve()
    block = cfg.data.get("independent_reproduction", {})
    if not isinstance(block, dict):
        raise ValueError("independent_reproduction must be an object")
    configured = block.get("blind_packet")
    if configured is not None and (not isinstance(configured, str) or not configured.strip()):
        raise ValueError("independent_reproduction.blind_packet must be a nonempty path or null")
    source = explicit_source if explicit_source is not None else root / configured if configured else None
    if source is None:
        raise ValueError("Independent reproduction requires --reproduction-packet or independent_reproduction.blind_packet containing the neutral question and raw inputs. The full candidate packet cannot substitute.")
    source = source.absolute()
    if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root):
        raise ValueError("Reproduction packet must be a regular file within the project root")
    for parent in source.parents:
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError("Reproduction packet path cannot traverse symlinks")
    raw = source.read_bytes()
    if not raw.decode("utf-8").strip() or b"\x00" in raw:
        raise ValueError("Reproduction packet must be complete nonempty UTF-8 text")
    output = output.absolute()
    if not output.resolve().is_relative_to(root) or output.is_symlink():
        raise ValueError("Reproduction packet output must remain within the project root")
    for parent in output.parents:
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError("Reproduction packet output cannot traverse symlinks")
    receipt = {"source_path": str(source.relative_to(root)), "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw), "packet_path": str(output.relative_to(root)),
        "input_scope": "explicit neutral problem and raw inputs; actual member reads and commands still require independent source assessment"}
    origin = output.with_suffix(output.suffix + ".origin.json")
    if output.exists():
        if not output.is_file() or output.read_bytes() != raw or not origin.is_file() or json.loads(origin.read_text(encoding="utf-8")) != receipt:
            raise ValueError("Reproduction packet history differs; use a fresh run")
        return output
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        stream.write(raw)
    origin.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def prepare_system(source: Path, output: Path, root: Path) -> None:
    frame = Path(__file__).resolve().parents[2] / "assets/system_independent_reproducer.txt"
    raw = source.read_text(encoding="utf-8") + "\n\n" + frame.read_text(encoding="utf-8")
    if output.is_symlink() or not output.resolve().is_relative_to(root.resolve()) or any(parent.is_symlink() for parent in output.absolute().parents):
        raise ValueError("Reproduction system output cannot traverse symlinks or leave the project")
    if output.exists():
        if not output.is_file() or output.read_text(encoding="utf-8") != raw:
            raise ValueError("Reproduction system history differs; use a fresh run")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as stream:
            stream.write(raw)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True)
    p.add_argument("--project-root", type=Path, required=True)
    p.add_argument("--packet", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--source", type=Path)
    p.add_argument("--system-a", type=Path)
    p.add_argument("--system-b", type=Path)
    p.add_argument("--system-a-out", type=Path)
    p.add_argument("--system-b-out", type=Path)
    a = p.parse_args()
    try:
        packet = prepare_packet(a.notes, a.project_root, a.packet, a.out, a.source)
        if packet != a.packet.resolve():
            for source, output in ((a.system_a, a.system_a_out), (a.system_b, a.system_b_out)):
                if source is None or output is None:
                    raise ValueError("Neutral reproduction packet requires both original member systems and frozen stage system paths")
                prepare_system(source, output, a.project_root)
        print(packet)
        return 0
    except (ValueError, OSError, UnicodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
