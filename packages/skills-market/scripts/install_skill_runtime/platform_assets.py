"""Distribute the same native Windows support bytes with independent skills."""
from __future__ import annotations

import hashlib
import pathlib
import shutil

from .source_payload import validate_payload_file


def copy_windows_runtime(source_dir: pathlib.Path, target_dir: pathlib.Path) -> dict[str, str]:
    # Catalog skill sources are exactly <workspace>/skills/<skill>. External
    # catalogs without these platform assets remain independent of Nullius.
    if not (source_dir / "scripts").is_dir():
        return {}
    source_root = source_dir.parent.parent
    support = source_root / "packages/shared/python/nullius_windows"
    if not support.is_dir():
        return {}
    if support.is_symlink() or not support.resolve().is_relative_to(source_root.resolve()):
        raise RuntimeError("Windows runtime source escapes its workspace")
    hashes: dict[str, str] = {}
    for original in sorted(support.glob("*.py")):
        relative = pathlib.PurePosixPath("scripts/_runtime/nullius_windows") / original.name
        if original.is_symlink():
            raise RuntimeError("Windows runtime source must not contain symlinks")
        validate_payload_file(original, relative)
        target = target_dir.joinpath(*relative.parts)
        if target.exists() or target.is_symlink():
            raise RuntimeError(f"platform runtime collides with selected payload: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target, follow_symlinks=False)
        hashes[relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
    if not hashes:
        raise RuntimeError("Windows runtime asset directory contains no Python modules")
    return hashes
