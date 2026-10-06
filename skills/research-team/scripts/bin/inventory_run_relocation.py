#!/usr/bin/env python3
"""Read-only inventory of a hash-pinned anonymous fixture; no migration apply mode."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path


def _files(root: Path) -> dict[str, str]:
    result = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in list(dirs):
            path = parent / name
            if path.is_symlink():
                names.append(name)
                dirs.remove(name)
        for name in names:
            path = parent / name
            data = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
            result[path.relative_to(root).as_posix()] = hashlib.sha256(data).hexdigest()
    return result


def _strings(value: object, field: str = ""):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _strings(item, f"{field}.{key}" if field else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _strings(item, f"{field}[{index}]")
    elif isinstance(value, str):
        yield field, value


def inventory(root: Path, pinned: dict[str, str]) -> dict:
    before = _files(root)
    if before != pinned:
        raise ValueError("fixture bytes do not match the complete source manifest")
    retired = root / "team" / "runs"
    if retired.is_symlink():
        raise ValueError("retired fixture root is a symlink; migration needs separate review")
    runs = sorted(p for p in retired.iterdir() if p.is_dir() and not p.is_symlink()) if retired.exists() else []
    mappings, collisions, references, cycle_paths, hash_bindings, frozen = [], [], [], [], [], []
    for run in runs:
        target = root / "artifacts" / "runs" / run.name
        payload = target / "research_team"
        source_prefix = run.relative_to(root).as_posix()
        target_prefix = payload.relative_to(root).as_posix()
        if payload.exists() or payload.is_symlink():
            collisions.append({"run_id": run.name, "kind": "payload_target_exists", "target": target_prefix})
        if (run / "run_origin.json").is_file() and (target / "run_origin.json").is_file() and not (run / "run_origin.json").is_symlink() and not (target / "run_origin.json").is_symlink() and not any(p.is_symlink() for p in [root / "artifacts", root / "artifacts" / "runs", target]):
            collisions.append({"run_id": run.name, "kind": "origin_records_share_target", "identical_bytes": (run / "run_origin.json").read_bytes() == (target / "run_origin.json").read_bytes()})
        mappings.append({"run_id": run.name, "source": source_prefix, "payload_target": target_prefix,
                         "origin_target": (target / "run_origin.json").relative_to(root).as_posix()})
        frozen.append({"run_id": run.name, "kind": "unresolved_runtime_and_skill_identity",
                       "reason": "Continuation and frozen input bindings require separately reviewed migration; directory movement alone does not establish them."})
    for rel, digest in before.items():
        path = root / rel
        if path.is_symlink():
            frozen.append({"source": rel, "kind": "unresolved_symlink", "target": os.readlink(path)})
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeError:
            frozen.append({"source": rel, "kind": "opaque_bytes", "sha256": digest})
            continue
        for mapping in mappings:
            old = mapping["source"]
            absolute = str(root / old)
            for kind, needle in [("absolute", absolute), ("project_relative", old), ("executor_relative", f"runs/{mapping['run_id']}")]:
                if needle in text:
                    references.append({"source": rel, "kind": kind, "reference": needle,
                                       "target": mapping["payload_target"], "rewrite_applied": False})
        if "PROJECT_INDEX_AUTO" in text:
            references.append({"source": rel, "kind": "unmaintained_PROJECT_INDEX_AUTO", "rewrite_applied": False})
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        for field, value in _strings(parsed):
            if rel.endswith("cycle_state.json") and ("/" in value or re.search(r"path|dir|root|workspace|packet|report", field)):
                cycle_paths.append({"source": rel, "field": field, "value": value,
                                    "kind": "absolute" if Path(value).is_absolute() else "relative"})
            if re.search(r"hash|sha|commit|frozen|binding|snapshot|dependency|manifest", field, re.I):
                frozen.append({"source": rel, "field": field, "value": value, "kind": "unresolved_frozen_binding"})
        if "registry" in rel.lower() or path.name == "project_index.md":
            for match in re.finditer(r"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])", text):
                hash_bindings.append({"source": rel, "sha256": match.group(0), "offset": match.start(), "verification": "binding observed; relocated carrier not validated"})
    after = _files(root)
    if after != before:
        raise RuntimeError("fixture changed during read-only inventory")
    return {"scope": "read_only_fixture_inventory", "apply_supported": False, "source_files": len(before),
            "bytes_unchanged": True, "runs": mappings, "collisions": collisions,
            "references": references, "cycle_state_paths": cycle_paths, "registry_hash_bindings": hash_bindings,
            "unresolved_frozen_dependencies": frozen}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-root", required=True, type=Path)
    parser.add_argument("--source-manifest", required=True, type=Path, help="Complete relative-path to SHA-256 fixture manifest.")
    args = parser.parse_args()
    pinned = json.loads(args.source_manifest.read_text())
    if not isinstance(pinned, dict) or not all(isinstance(k, str) and isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for k, v in pinned.items()):
        raise ValueError("source manifest must map relative fixture paths to SHA-256 values")
    print(json.dumps(inventory(args.fixture_root.resolve(), pinned), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
