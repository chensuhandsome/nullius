from __future__ import annotations

import fnmatch
from functools import lru_cache
import os
import pathlib
import re
import shutil
import stat
import subprocess
from typing import Sequence
from urllib.parse import unquote

DEFAULT_EXCLUDES = {
    ".git",
    ".git/**",
    "**/.git/**",
    "tests/**",
    "test/**",
    "**/.pytest_cache/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/.DS_Store",
}


def is_reparse_path(path: pathlib.Path) -> bool:
    return path.is_symlink() or (os.name == "nt" and bool(
        path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ))


def _payload_descendants(directory: pathlib.Path, excluded):
    for child in directory.iterdir():
        if is_reparse_path(child) or child.is_file():
            if not excluded(child):
                yield child
        elif child.is_dir():
            # Excludes apply to each selected relative filename. A directory
            # named by an exclude need not exclude its descendants, so keep
            # walking ordinary source directories without changing that policy.
            yield from _payload_descendants(child, excluded)


def _glob_matches(parts: tuple[str, ...], pattern: tuple[str, ...], *, prefix: bool = False) -> bool:
    """Component globbing without filesystem traversal; ** may match zero parts.

    prefix identifies a reparse entry that an include would otherwise traverse.
    Such an entry must reach the existing refusal gate, never be silently omitted.
    """
    @lru_cache(maxsize=None)
    def match(index: int, token: int) -> bool:
        if token == len(pattern):
            return index == len(parts)
        if pattern[token] == "**":
            return match(index, token + 1) or (index < len(parts) and match(index + 1, token))
        if index == len(parts):
            return prefix
        return fnmatch.fnmatch(parts[index], pattern[token]) and match(index + 1, token + 1)

    return match(0, 0)


# This gate inspects the selected bytes, including ignored/untracked source files.
# Never include a matched value in diagnostics: only its category and relative path.
def sensitive_file_name(relative: pathlib.PurePosixPath) -> bool:
    """Match the source privacy guard's filename policy (locked by parity tests)."""
    name = relative.name.lower()
    if re.search(r"\.(?:example|sample|template)(?:\.[a-z0-9]+)?$", name):
        return False
    return bool(
        re.fullmatch(r"\.env(?:rc|\..+)?", name)
        or re.fullmatch(r"(?:\.?(?:oauth|auth|credentials?|secrets?|tokens?)\.(?:json|jsonl|ya?ml|toml)|oauth[-_]?(?:tokens?|creds|credentials)\.json|google_accounts\.json|service[-_]account\.json|client_secret[^/]*\.json)", name)
        or re.fullmatch(r"(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc)", name)
        or re.search(r"\.(?:pem|key|p12|pfx|keystore|jks)$", name)
        or re.search(r"(?:^|/)\.(?:aws/credentials|docker/config\.json|ssh/config|kube/config)$", relative.as_posix().lower())
    )


SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----"),
    re.compile(r"\bsk_live_[A-Za-z0-9]{24,}\b"),
    re.compile(r"\bsk-(?:proj-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{24,}\b"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
)
HOME_PATTERNS = (
    re.compile(r"/(?:Users|home)/([\w][\w.-]*)(?=/|[\s\"'`),;:]|$)"),
    re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+([\w][\w.-]*)(?=[\\/]|[\s\"'`),;:]|$)"),
)
HOME_PLACEHOLDERS = {"user", "username", "your-user", "your-username", "example", "placeholder"}


def validate_payload_file(file_path: pathlib.Path, relative: pathlib.PurePosixPath) -> None:
    if sensitive_file_name(relative):
        raise RuntimeError(f"sensitive filename in selected payload: {relative}")
    data = file_path.read_bytes()
    text = data.decode("utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8", errors="ignore")
    text = unquote(text)
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        raise RuntimeError(f"high-confidence credential in selected payload: {relative}")
    if any(match.group(1).lower() not in HOME_PLACEHOLDERS
           for pattern in HOME_PATTERNS for match in pattern.finditer(text)):
        raise RuntimeError(f"concrete machine home path in selected payload: {relative}")


def run_checked(cmd: Sequence[str], *, cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "command failed:\n"
            f"$ {' '.join(cmd)}\n"
            f"exit={proc.returncode}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    return proc


def git_head(repo_path: pathlib.Path) -> str | None:
    try:
        return run_checked(["git", "-C", str(repo_path), "rev-parse", "HEAD"]).stdout.strip() or None
    except RuntimeError:
        return None


def clone_source_repo(repo: str, ref: str, temp_dir: pathlib.Path) -> pathlib.Path:
    clone_dir = temp_dir / f"{repo.replace('/', '__')}@{ref}"
    if clone_dir.exists():
        return clone_dir
    clone_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_checked(["git", "clone", "--depth", "1", "--branch", ref, f"https://github.com/{repo}.git", str(clone_dir)])
    except RuntimeError:
        run_checked(["git", "clone", f"https://github.com/{repo}.git", str(clone_dir)])
        run_checked(["git", "-C", str(clone_dir), "checkout", ref])
    return clone_dir


def collect_payload_files(source_dir: pathlib.Path, include: list[str], exclude: list[str]) -> list[pathlib.Path]:
    if not source_dir.is_dir():
        raise RuntimeError(f"source subpath does not exist: {source_dir}")
    source_root = source_dir.resolve()
    excluded_patterns = list(DEFAULT_EXCLUDES) + exclude

    def is_excluded(rel_path: pathlib.PurePosixPath) -> bool:
        rel = rel_path.as_posix()
        for pattern in excluded_patterns:
            if rel_path.match(pattern) or fnmatch.fnmatch(rel, pattern):
                return True
            if pattern.endswith("/**"):
                prefix = pattern[:-3].rstrip("/")
                if rel == prefix or rel.startswith(prefix + "/"):
                    return True
        return False

    # pathlib's recursive glob follows Windows junctions even when its own
    # DirEntry.is_dir(follow_symlinks=False) is used. Discover the tree once,
    # refusing to recurse through any reparse entry before matching patterns.
    patterns = [(pathlib.PurePosixPath(pattern).parts, pattern.endswith("/")) for pattern in include]
    selected: set[pathlib.Path] = set()
    excluded = lambda candidate: is_excluded(pathlib.PurePosixPath(candidate.relative_to(source_dir).as_posix()))
    for candidate in _payload_descendants(source_dir, excluded):
        parts = pathlib.PurePosixPath(candidate.relative_to(source_dir).as_posix()).parts
        reparse = is_reparse_path(candidate)
        for pattern, directory_only in patterns:
            # An included directory selects all descendants, as Path.glob's
            # previous directory expansion did; ordinary * stays per-component.
            matched = any(_glob_matches(parts[:depth], pattern)
                          for depth in range(len(parts) + (not directory_only)))
            if matched or (reparse and _glob_matches(parts, pattern, prefix=True)):
                selected.add(candidate)
                break

    if not selected:
        raise RuntimeError(f"include patterns matched no files under {source_dir}")

    final_files: list[pathlib.Path] = []
    for file_path in sorted(selected):
        rel_path = pathlib.PurePosixPath(file_path.relative_to(source_dir).as_posix())
        if is_excluded(rel_path):
            continue
        try:
            file_path.resolve().relative_to(source_root)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"selected payload resolves outside source root: {rel_path}") from exc
        if is_reparse_path(file_path):
            raise RuntimeError(f"symlink in selected payload: {rel_path}")
        validate_payload_file(file_path, rel_path)
        final_files.append(file_path)

    if not any(file_path.relative_to(source_dir).as_posix() == "SKILL.md" for file_path in final_files):
        raise RuntimeError("payload must include SKILL.md")
    return final_files


def safe_remove(path: pathlib.Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
