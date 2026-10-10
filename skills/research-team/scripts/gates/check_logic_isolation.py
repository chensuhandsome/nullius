#!/usr/bin/env python3
"""
Logic isolation gate for full_access independent reproduction scripts.

Goal: reject call-through of declared tested kernels. Shared utilities, own
relative helpers and same algorithm names are inspected by the source-grounded
independent-reproduction assessment, not rejected solely by import identity.

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (forbidden imports detected)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    message: str


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config and project root).")
    p.add_argument("--tag", required=True, help="Resolved tag (e.g. M2-r3).")
    p.add_argument("--project-root", type=Path, default=None, help="Override project root.")
    p.add_argument("--max-violations", type=int, default=60)
    return p.parse_args()


def _safe_tag(tag: str) -> str:
    t = tag.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", t) or t == "." or ".." in t:
        raise ValueError(f"tag must be one safe path segment using only [A-Za-z0-9._-], not '.' and no '..': {tag}")
    return t


def _project_root(notes: Path) -> Path:
    cfg = load_team_config(notes)
    cfg_path = getattr(cfg, "path", None)
    if isinstance(cfg_path, Path) and cfg_path.is_file():
        return cfg_path.parent.resolve()
    return notes.parent.resolve()


def _local_module_roots(project_root: Path) -> set[str]:
    roots: set[str] = set()
    # Top-level packages: dirs with __init__.py
    for d in project_root.iterdir():
        if not d.is_dir():
            continue
        if d.name.startswith("."):
            continue
        if (d / "__init__.py").is_file():
            roots.add(d.name)
    # Top-level modules: *.py files
    for f in project_root.glob("*.py"):
        if f.is_file() and not f.name.startswith("."):
            roots.add(f.stem)
    return roots


def _allowed_local_roots(cfg_data: dict) -> set[str]:
    li = cfg_data.get("logic_isolation", {})
    if not isinstance(li, dict):
        li = {}
    roots = li.get("allowed_local_import_roots", ["shared_utils", "toolkit"])
    if isinstance(roots, list):
        out = {str(x).strip() for x in roots if str(x).strip()}
        return out
    return {"shared_utils", "toolkit"}


def _python_import_roots(path: Path) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return out
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name or ""
                root = name.split(".", 1)[0].strip()
                if root:
                    out.append((getattr(node, "lineno", 1), root))
        elif isinstance(node, ast.ImportFrom):
            # Relative import is always forbidden for "independent reproduction".
            if getattr(node, "level", 0) and getattr(node, "lineno", None):
                out.append((int(node.lineno), "__RELATIVE__"))
                continue
            mod = (node.module or "").strip()
            root = mod.split(".", 1)[0].strip() if mod else ""
            if root:
                out.append((getattr(node, "lineno", 1), root))
    return out


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("logic_isolation_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (logic_isolation_gate disabled by config)")
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`")
        print(f"- Review access mode: {mode or 'packet_only'}")
        print("- Gate: SKIP (review_access_mode != full_access)")
        return 0

    project_root = args.project_root.resolve() if args.project_root is not None else _project_root(args.notes)
    cfg_data = getattr(cfg, "data", {})
    if not isinstance(cfg_data, dict):
        cfg_data = {}

    from check_independent_reproduction import _collect_member_sources, _scan_declared_kernels, _config_kernel_modules
    local_roots = _local_module_roots(project_root)
    allowed = _allowed_local_roots(cfg_data)
    kernels = _config_kernel_modules(cfg)

    tag = args.tag.strip()
    try:
        st = _safe_tag(tag)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    violations: list[Violation] = []
    for member in ("member_a", "member_b"):
        ind_dir = project_root / "artifacts" / "runs" / st / "research_team" / member / "independent"
        if not ind_dir.is_dir():
            continue
        sources = _collect_member_sources(member, ind_dir)
        for issue in _scan_declared_kernels(sources, kernels):
            violations.append(Violation(ind_dir, 1, issue.message))

    print(f"- Notes: `{args.notes}`")
    print(f"- Project root: `{project_root}`")
    print(f"- Tag: {tag} (safe={st})")
    print(f"- Local module roots: {len(local_roots)} (allowed: {sorted(allowed)})")
    if not violations:
        print("- Gate: PASS")
        return 0

    print(f"- Violations: {len(violations)}")
    for v in violations[: args.max_violations]:
        rel = None
        try:
            rel = v.path.resolve().relative_to(project_root.resolve())
        except Exception:
            rel = v.path
        print(f"ERROR: {rel}:{v.line}: {v.message}")
    if len(violations) > args.max_violations:
        print(f"... ({len(violations) - args.max_violations} more)")
    print("")
    print("Fix: remove tested-kernel call-through; shared utilities and independent construction need source-grounded assessment.")
    print("- Gate: FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
