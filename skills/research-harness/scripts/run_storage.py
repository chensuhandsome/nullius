#!/usr/bin/env python3
"""Run storage: keep bulk run outputs out of git history without losing them.

Every byte of a tracked file exists once per checkout (the main checkout and
every linked worktree) plus once in the object store, and snapshot refs that
pin run origins keep historical blobs alive permanently. Small text evidence
(scripts, configs, tables, logs, manifests) belongs in git; bulk numerical or
binary outputs above a size threshold do not. This tool implements that
policy for a project repository.

Size policy
  A file under a run root (default ``artifacts/runs``) whose size is at or
  above the threshold (default 5 MiB) is BULK, whatever its format: large
  text tables cost as much per checkout as binary dumps. Bulk outputs are
  "stowed" after the run finishes: placed once, by sha256, into a content
  store shared by every worktree of the repository (default
  ``<git common dir>/nullius/store``; never checked out, untouched by
  ``git clean`` and ``git worktree remove``) as an independent file (a
  copy-on-write clone where the file system supports it, otherwise a
  verified copy). The run directory keeps its file, made read-only and
  readable in place; a tracked ``bulk_manifest.json`` records path, size and
  sha256, and a managed block in the run directory's ``.gitignore`` lists
  exactly those paths. The code-origin snapshot of later runs therefore
  carries the hashes of the bulk inputs, while the bulk bytes stay out of
  history.

  Optional ``.nullius/storage_policy.json``:
    {"schema": "storage_policy_v1", "bulk_threshold_bytes": 5242880,
     "run_roots": ["artifacts/runs"], "store_root": "/absolute/path"}

Subcommands
  check             report bulk files under the run roots (``--staged``: in
                    the index, i.e. about to be committed). Warns; exits 1
                    only with ``--strict``.
  stow              place a finished run's bulk outputs in the store (an
                    independent clone or verified copy; the run's file stays
                    in place, read-only) + manifest + ignore block.
  verify            check every manifest entry against its sha256, in place
                    or in the store.
  materialize       recreate missing manifest entries in place from the
                    store (e.g. in another worktree or clone).

Exit codes: 0 clean; 1 findings (strict-check violations, verification
problems, refused changes); 2 usage or environment error. POSIX (macOS/Linux)
only. Nothing here deletes data: a damaged store object is renamed aside,
never removed, and the only replacement of a run file is by a verified
clone of the same bytes.

Operating assumptions: one user's own files (not an adversarial setting),
and nothing still writing into a run directory that is being stowed. Hashes
are re-checked immediately before each step that records or replaces
anything, but a process that keeps a file open can still write after the
last check; run ``stow`` only after the producing processes have stopped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_THRESHOLD = 5 * 1024 * 1024
DEFAULT_RUN_ROOTS = ("artifacts/runs",)
POLICY_REL = ".nullius/storage_policy.json"
POLICY_SCHEMA = "storage_policy_v1"
MANIFEST_NAME = "bulk_manifest.json"
MANIFEST_SCHEMA = "bulk_manifest_v1"
GITIGNORE_BEGIN = "# >>> bulk outputs kept outside git history (run_storage.py stow) >>>"
GITIGNORE_END = "# <<< bulk outputs kept outside git history <<<"
STORE_SUBPATH = ("nullius", "store")


EXIT_OK, EXIT_FINDINGS, EXIT_ERROR = 0, 1, 2
CHUNK = 1024 * 1024


class StorageError(Exception):
    """Usage or environment problem (exit 2)."""


# ---------------------------------------------------------------- utilities

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024 or unit == "TiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} TiB"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_atomic(path: Path, data: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(path.parent)


def write_json_atomic(path: Path, obj) -> None:
    write_atomic(path, (json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))


def walk_error(error: OSError) -> None:
    """os.walk silently skips unreadable directories; every walk a verdict or
    record rests on stops instead."""
    raise StorageError(f"cannot read {getattr(error, 'filename', '') or error} ({error.strerror or error}); "
                       "an incomplete walk cannot support this result")


HEX = frozenset("0123456789abcdef")

def is_sha256_hex(value) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= HEX


def is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def emit(result: dict, as_json: bool, lines: "list[str]") -> None:
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    else:
        for line in lines:
            print(line)


# ---------------------------------------------------------------------- git

def git(args: "list[str]", cwd: Path, check: bool = True, input_bytes: "bytes | None" = None,
        literal_pathspecs: bool = True) -> subprocess.CompletedProcess:
    # Never fetch: a partial clone would otherwise download missing objects
    # (network, credentials, and new packs written into a copy being read).
    # File names are passed as literal pathspecs (a name like ":(exclude)x" is just a name).
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", LC_ALL="C", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    if literal_pathspecs:  # check-ignore dies in this mode (it takes plain path names anyway)
        env["GIT_LITERAL_PATHSPECS"] = "1"
    proc = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", *args],
        cwd=str(cwd), input=input_bytes, capture_output=True, env=env,
    )
    if check and proc.returncode != 0:
        raise StorageError(f"git {' '.join(args)} failed in {cwd}: {proc.stderr.decode(errors='replace').strip()}")
    return proc


def git_text(args: "list[str]", cwd: Path) -> str:
    return git(args, cwd).stdout.decode("utf-8", errors="surrogateescape").strip()


def git_z(args: "list[str]", cwd: Path) -> "list[str]":
    out = git(args, cwd).stdout.decode("utf-8", errors="surrogateescape")
    return [item for item in out.split("\0") if item]


class Repo:
    """A checkout (main or linked worktree) of a git repository."""

    def __init__(self, start: Path):
        start = Path(start).resolve()
        if start.is_file():
            start = start.parent
        if not start.exists():
            raise StorageError(f"path does not exist: {start}")
        proc = git(["rev-parse", "--show-toplevel"], start, check=False)
        if proc.returncode != 0:
            raise StorageError(f"not inside a git working tree: {start}")
        self.toplevel = Path(proc.stdout.decode().strip()).resolve()
        common = git_text(["rev-parse", "--git-common-dir"], self.toplevel)
        self.common_dir = (self.toplevel / common).resolve() if not os.path.isabs(common) else Path(common).resolve()
        git_dir = git_text(["rev-parse", "--git-dir"], self.toplevel)
        self.git_dir = (self.toplevel / git_dir).resolve() if not os.path.isabs(git_dir) else Path(git_dir).resolve()
        self.is_linked_worktree = self.git_dir != self.common_dir
        # With core.precomposeUnicode (set by `git init` on macOS) git names
        # files in composed (NFC) form whatever form the file system returns.
        self.precompose = git(["config", "--bool", "core.precomposeunicode"], self.toplevel,
                              check=False).stdout.decode().strip() == "true"
        self.policy = load_policy(self.toplevel)

    def git_form(self, rel: str) -> str:
        return unicodedata.normalize("NFC", rel) if self.precompose else rel

    @property
    def threshold(self) -> int:
        return self.policy["bulk_threshold_bytes"]

    @property
    def run_roots(self) -> "list[str]":
        return self.policy["run_roots"]

    def store(self, override: "str | None" = None) -> Path:
        if override:
            return Path(override).expanduser().resolve()
        configured = self.policy.get("store_root")
        if configured:
            return Path(configured).expanduser().resolve()
        return self.common_dir.joinpath(*STORE_SUBPATH)

    def rel(self, path: Path) -> str:
        """Repository-relative path; the final component is never followed,
        so a symlink inside the checkout keeps its own path."""
        path = Path(path)
        parent = Path(os.path.realpath(path.parent))
        try:
            rel = (parent / path.name).relative_to(self.toplevel).as_posix()
        except ValueError:
            raise StorageError(f"{path} resolves outside the repository {self.toplevel} "
                               "(a symlinked directory?); git does not track content behind symlinks")
        return self.git_form(rel)

    def tracked(self, pathspecs: "list[str]") -> "set[str]":
        return set(git_z(["ls-files", "-z", "--", *pathspecs], self.toplevel)) if pathspecs else set()

    def untracked(self, pathspecs: "list[str]") -> "set[str]":
        return set(git_z(["ls-files", "-z", "--others", "--exclude-standard", "--", *pathspecs], self.toplevel))

    def ignored(self, pathspecs: "list[str]") -> "set[str]":
        return set(git_z(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", *pathspecs],
                         self.toplevel))


def load_policy(toplevel: Path) -> dict:
    policy = {"bulk_threshold_bytes": DEFAULT_THRESHOLD, "run_roots": list(DEFAULT_RUN_ROOTS), "store_root": None}
    path = toplevel / POLICY_REL
    if not path.exists():
        return policy
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StorageError(f"{POLICY_REL}: unreadable ({exc})")
    if not isinstance(doc, dict) or doc.get("schema") != POLICY_SCHEMA:
        raise StorageError(f"{POLICY_REL}: expected an object with schema '{POLICY_SCHEMA}'")
    unknown = set(doc) - {"schema", "bulk_threshold_bytes", "run_roots", "store_root"}
    if unknown:
        raise StorageError(f"{POLICY_REL}: unknown fields {sorted(unknown)}")
    if "bulk_threshold_bytes" in doc:
        value = doc["bulk_threshold_bytes"]
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise StorageError(f"{POLICY_REL}: bulk_threshold_bytes must be a positive integer")
        policy["bulk_threshold_bytes"] = value
    if "run_roots" in doc:
        roots = doc["run_roots"]
        if (not isinstance(roots, list) or not roots
                or not all(isinstance(r, str) and r and not r.startswith("/") and ".." not in r.split("/")
                           for r in roots)):
            raise StorageError(f"{POLICY_REL}: run_roots must be a non-empty list of relative paths")
        policy["run_roots"] = [r.strip("/") for r in roots]
    if doc.get("store_root") is not None:
        root = doc["store_root"]
        if not isinstance(root, str) or not Path(root).expanduser().is_absolute():
            # A relative store would resolve inside each checkout, so removing a
            # worktree could delete the very store that was meant to outlive it.
            raise StorageError(f"{POLICY_REL}: store_root must be an absolute path (or start with ~)")
        policy["store_root"] = root
    return policy


def resolve_threshold(repo: "Repo | None", override: "int | None") -> int:
    if override is not None:
        if override <= 0:
            raise StorageError("--threshold must be positive")
        return override
    return repo.threshold if repo else DEFAULT_THRESHOLD


# ------------------------------------------------------------ content store

def store_path(store: Path, sha: str) -> Path:
    return store / "sha256" / sha[:2] / sha


def verify_store_object(obj: Path, sha: str) -> bool:
    """A store object counts only when it is a regular file (never a symlink)
    whose full sha256 equals the hash it is filed under."""
    try:
        st = obj.lstat()
    except OSError:
        return False
    if not stat.S_ISREG(st.st_mode):
        return False
    try:
        return sha256_file(obj) == sha
    except OSError:
        return False


def clone_file(src: Path, dst: Path) -> bool:
    """Copy-on-write clone of ``src`` at the new path ``dst``: an independent
    file that shares data blocks until either side is modified. True only
    when the file system really cloned (APFS clonefile, Linux FICLONE)."""
    if sys.platform == "darwin":
        try:
            import ctypes
            import ctypes.util
            libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
            fn = libc.clonefile
            fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
            fn.restype = ctypes.c_int
            return fn(os.fsencode(str(src)), os.fsencode(str(dst)), 0) == 0
        except (OSError, AttributeError):
            return False
    if sys.platform.startswith("linux"):
        import fcntl
        ficlone = 0x40049409
        try:
            with open(src, "rb") as s_fh, open(dst, "xb") as d_fh:
                fcntl.ioctl(d_fh.fileno(), ficlone, s_fh.fileno())
            return True
        except OSError:
            try:
                os.unlink(dst)
            except OSError:
                pass
            return False
    return False


def incoming_path(directory: Path) -> Path:
    return directory / f".incoming-{os.getpid()}-{secrets.token_hex(8)}"


def fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_file_durably(src: Path, dst: Path) -> None:
    with open(src, "rb") as s_fh, open(dst, "xb") as d_fh:
        shutil.copyfileobj(s_fh, d_fh, CHUNK)
        d_fh.flush()
        os.fsync(d_fh.fileno())


def set_aside_damaged(obj: Path) -> Path:
    """Move a store object whose bytes do not match its name out of the way.
    Nothing is deleted: the damaged bytes stay next to it for inspection."""
    aside = obj.with_name(f"{obj.name}.damaged-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
                          f"{secrets.token_hex(4)}")
    os.rename(obj, aside)
    print(f"run-storage: store object {obj} did not match its hash; moved to {aside.name}", file=sys.stderr)
    return aside


def publish(tmp: Path, dest: Path, sha: str) -> bool:
    """Create ``dest`` from the verified ``tmp`` without ever replacing an
    existing name. Returns False when an equal object was already there."""
    try:
        os.link(tmp, dest)
    except FileExistsError:
        if verify_store_object(dest, sha):
            return False
        set_aside_damaged(dest)
        os.link(tmp, dest)
    fsync_dir(dest.parent)
    return True


def store_put(path: Path, store: Path) -> "tuple[str, Path, str]":
    """Place ``path``'s bytes into ``store`` under their sha256, as a file
    independent of ``path``: a copy-on-write clone where the file system
    supports it (no extra blocks), otherwise a durable byte copy. The store
    never shares an inode with a user-visible file, so editing a run's file
    can never alter the stored evidence or another run's copy. An existing
    object is trusted only after its full hash is verified; a damaged one is
    set aside (never deleted) and replaced. The source is hashed before and
    after, so a file still being written is refused. Returns (sha256,
    object, method) with method in {"existing", "clone", "copy"}.
    """
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode):
        raise StorageError(f"not a regular file: {path}")
    sha = sha256_file(path)
    dest = store_path(store, sha)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        if verify_store_object(dest, sha):
            if sha256_file(path) != sha:
                raise StorageError(f"{path} changed while being stored; stow it after the run has finished writing")
            return sha, dest, "existing"
        set_aside_damaged(dest)
    tmp = incoming_path(dest.parent)
    try:
        if os.stat(dest.parent).st_dev == st.st_dev and clone_file(path, tmp):
            method = "clone"
        else:
            copy_file_durably(path, tmp)
            method = "copy"
        if sha256_file(tmp) != sha or sha256_file(path) != sha:
            raise StorageError(f"{path} changed while being stored; stow it after the run has finished writing")
        os.chmod(tmp, 0o444)
        fsync_file(tmp)
        if not publish(tmp, dest, sha):
            method = "existing"
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return sha, dest, method


def place_from_store(obj: Path, target: Path, sha: str) -> str:
    """Create ``target`` (absent) as an independent read-only file with the
    bytes of the verified store object: a clone, else a byte copy. Returns
    the method."""
    tmp = incoming_path(target.parent)
    try:
        if clone_file(obj, tmp):
            method = "clone"
        else:
            copy_file_durably(obj, tmp)
            method = "copy"
        if sha256_file(tmp) != sha:
            raise StorageError(f"placing {target} from the store produced different bytes")
        os.chmod(tmp, 0o444)
        os.link(tmp, target)  # never replaces an existing name
        fsync_dir(target.parent)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return method


# ------------------------------------------------------------- manifests

def load_manifest(run_dir: Path) -> "dict | None":
    path = run_dir / MANIFEST_NAME
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StorageError(f"{path}: unreadable ({exc})")
    if not isinstance(doc, dict) or doc.get("schema") != MANIFEST_SCHEMA or not isinstance(doc.get("entries"), list):
        raise StorageError(f"{path}: expected schema '{MANIFEST_SCHEMA}' with an entries list")
    seen: "set[str]" = set()
    for entry in doc["entries"]:
        rel = entry.get("path") if isinstance(entry, dict) else None
        if (not isinstance(rel, str) or not rel or posixpath.normpath(rel) != rel or rel.startswith("/")
                or ".." in rel.split("/") or not is_sha256_hex(entry.get("sha256"))
                or not isinstance(entry.get("size"), int) or isinstance(entry.get("size"), bool) or entry["size"] < 0):
            raise StorageError(f"{path}: malformed entry {entry!r}")
        if rel in seen:
            raise StorageError(f"{path}: the path {rel!r} is recorded more than once")
        seen.add(rel)
    return doc


def manifests_under(repo: Repo) -> "dict[str, tuple[Path, dict]]":
    """Map repository-relative path -> (run directory, manifest entry) for
    every bulk manifest under the run roots."""
    found: dict = {}
    for root in repo.run_roots:
        base = repo.toplevel / root
        if not base.is_dir() or base.is_symlink():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False, onerror=walk_error):
            if MANIFEST_NAME in filenames:
                run_dir = Path(dirpath)
                doc = load_manifest(run_dir)
                run_rel = run_dir.relative_to(repo.toplevel).as_posix()  # walked inside the checkout
                for entry in doc["entries"]:
                    # Lexical path: a symlinked ancestor must not move the key elsewhere.
                    found[repo.git_form(posixpath.join(run_rel, entry["path"]))] = (run_dir, entry)
    return found


def gitignore_escape(rel: str) -> str:
    if "\n" in rel or "\r" in rel:
        raise StorageError(f"cannot express a path containing a newline in .gitignore: {rel!r}")
    out = []
    for ch in rel:
        if ch in "\\*?[]!#":
            out.append("\\" + ch)
        else:
            out.append(ch)
    escaped = "".join(out)
    stripped = escaped.rstrip(" ")
    return "/" + stripped + "\\ " * (len(escaped) - len(stripped))


def check_ignore_markers(run_dir: Path) -> None:
    """The managed block must be absent or exactly one BEGIN ... END pair in
    that order; anything else would make the rewrite drop user rules."""
    path = run_dir / ".gitignore"
    if not path.exists():
        return
    inside, blocks = False, 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line == GITIGNORE_BEGIN:
            if inside:
                break
            inside, blocks = True, blocks + 1
        elif line == GITIGNORE_END:
            if not inside:
                inside = None
                break
            inside = False
    else:
        if not inside and blocks <= 1:
            return
    raise StorageError(f"{path}: the managed block markers are not one BEGIN...END pair (edited by hand?); "
                       "repair them before stowing so no user rule is lost")


def update_ignore_block(run_dir: Path, rel_paths: "list[str]") -> None:
    check_ignore_markers(run_dir)
    path = run_dir / ".gitignore"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    kept: "list[str]" = []
    inside = False
    for line in lines:
        if line == GITIGNORE_BEGIN:
            inside = True
            continue
        if line == GITIGNORE_END:
            inside = False
            continue
        if not inside:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    block = [GITIGNORE_BEGIN, *[gitignore_escape(p) for p in sorted(rel_paths)], GITIGNORE_END]
    text = "\n".join(kept + ([""] if kept else []) + block) + "\n"
    write_atomic(path, text.encode("utf-8"))


# ------------------------------------------------------------------ check

def staged_bulk(repo: Repo, threshold: int) -> "list[dict]":
    changed = git_z(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT", "--", *repo.run_roots],
                    repo.toplevel)
    if not changed:
        return []
    stage = git_z(["ls-files", "--stage", "-z", "--", *changed], repo.toplevel)
    shas: "dict[str, str]" = {}
    for item in stage:
        meta, _, path = item.partition("\t")
        parts = meta.split()
        if len(parts) >= 2 and parts[0] != "160000":
            shas[path] = parts[1]
    if not shas:
        return []
    batch = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], repo.toplevel,
                input_bytes=("\n".join(shas.values()) + "\n").encode()).stdout.decode().splitlines()
    sizes = {}
    for line in batch:
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            sizes[parts[0]] = int(parts[1])
    return sorted(({"path": p, "size": sizes[s]} for p, s in shas.items() if sizes.get(s, 0) >= threshold),
                  key=lambda r: (-r["size"], r["path"]))


def working_tree_bulk(repo: Repo, threshold: int) -> "dict[str, list[dict]]":
    roots = [r for r in repo.run_roots if (repo.toplevel / r).is_dir() and not (repo.toplevel / r).is_symlink()]
    skipped = [r for r in repo.run_roots if (repo.toplevel / r).is_symlink()]
    classes: "dict[str, list[dict]]" = {"tracked": [], "untracked": [], "ignored_unstowed": [],
                                        "stowed": [], "stowed_damaged": [],
                                        "skipped_symlinked_roots": [{"path": r, "size": 0} for r in skipped]}
    if not roots:
        return classes
    tracked = repo.tracked(roots)
    untracked = repo.untracked(roots)
    stowed = manifests_under(repo)
    store = repo.store()
    # Every recorded entry is checked by full hash, whatever its current size:
    # a stowed output that changed, shrank, vanished, or lost its store copy
    # is not "stowed" any more.
    for rel, (run_dir, entry) in sorted(stowed.items()):
        status = entry_status(run_dir, store, entry)
        record = {"path": rel, "size": entry["size"], "status": status["status"]}
        good = status["status"] in ("ok", "in_store_only")
        classes["stowed" if good else "stowed_damaged"].append(record)
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(repo.toplevel / root, followlinks=False, onerror=walk_error):
            for name in filenames:
                full = Path(dirpath) / name
                st = full.lstat()
                if not stat.S_ISREG(st.st_mode) or st.st_size < threshold:
                    continue
                rel = repo.rel(full)
                record = {"path": rel, "size": st.st_size}
                if rel in tracked:
                    classes["tracked"].append(record)
                elif rel in untracked:
                    classes["untracked"].append(record)
                elif rel in stowed:
                    continue  # classified above by hash
                else:
                    classes["ignored_unstowed"].append(record)
    for records in classes.values():
        records.sort(key=lambda r: (-r["size"], r["path"]))
    return classes


def cmd_check(args) -> int:
    repo = Repo(args.project_root)
    threshold = resolve_threshold(repo, args.threshold)
    if args.staged:
        found = staged_bulk(repo, threshold)
        result = {"mode": "staged", "threshold_bytes": threshold, "run_roots": repo.run_roots, "staged_bulk": found}
        lines = []
        if found:
            lines.append(f"run-storage: {len(found)} staged file(s) under {', '.join(repo.run_roots)} at or above "
                         f"{human(threshold)} would enter git history permanently:")
            lines += [f"  {human(r['size']):>12}  {r['path']}" for r in found]
            lines.append("  Keep bulk outputs out of history: git restore --staged <path>, then "
                         "run_storage.py stow <run_dir> (see research-harness: Run Storage).")
        else:
            lines.append(f"run-storage: no staged file at or above {human(threshold)} under the run roots.")
        emit(result, args.json, lines if (found or not args.quiet) else [])
        return EXIT_FINDINGS if (found and args.strict) else EXIT_OK
    classes = working_tree_bulk(repo, threshold)
    result = {"mode": "working_tree", "threshold_bytes": threshold, "run_roots": repo.run_roots,
              **{k: v for k, v in classes.items()}}
    labels = {
        "tracked": "already in git history (every checkout and the object store hold a copy)",
        "untracked": "untracked and not ignored (a plain `git add` would commit them)",
        "ignored_unstowed": "ignored but not stowed (lost if this checkout is removed)",
        "stowed_damaged": "recorded in a bulk manifest but changed, missing, or without a valid store copy",
        "stowed": "stowed (bytes match the manifest; valid copy in the content store)",
    }
    lines = [f"run-storage: bulk files (>= {human(threshold)}) under {', '.join(repo.run_roots)}:"]
    for r in classes.get("skipped_symlinked_roots", []):
        lines.append(f"  run root {r['path']} is a symbolic link; git does not track content behind it (skipped)")
    for key in ("stowed_damaged", "untracked", "ignored_unstowed", "tracked", "stowed"):
        records = classes[key]
        lines.append(f"  {len(records):5d} files {human(sum(r['size'] for r in records)):>12}  {labels[key]}")
        for r in records[: args.limit]:
            lines.append(f"        {human(r['size']):>12}  {r['path']}")
        if len(records) > args.limit:
            lines.append(f"        ... {len(records) - args.limit} more")
    emit(result, args.json, lines)
    violations = classes["untracked"] or classes["ignored_unstowed"] or classes["stowed_damaged"]
    return EXIT_FINDINGS if (violations and args.strict) else EXIT_OK


# ------------------------------------------------------------------ stow

def resolve_run_dir(repo: Repo, run_dir: str) -> Path:
    path = Path(run_dir)
    if not path.is_absolute():
        path = Path.cwd() / path
    if path.is_symlink() or not path.is_dir():
        raise StorageError(f"run directory must be a real directory: {path}")
    path = path.resolve()
    if not is_under(path, repo.toplevel):
        raise StorageError(f"{path} resolves outside the repository {repo.toplevel} (a symlinked run root?)")
    if not any(is_under(path, repo.toplevel / root) for root in repo.run_roots):
        raise StorageError(f"{path} is not under a run root ({', '.join(repo.run_roots)}); "
                           f"add its root to {POLICY_REL} if it should follow the bulk policy")
    if Repo(path).toplevel != repo.toplevel:
        raise StorageError(f"{path} belongs to a nested repository (a submodule?), not to {repo.toplevel}")
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False, onerror=walk_error):
        if ".git" in dirnames or ".git" in filenames:
            raise StorageError(f"{dirpath} holds a nested repository; its files follow that repository's rules")
    return path


def expressible_problem(rel: str) -> "str | None":
    """Why a path cannot be recorded in the manifest and ignore block, if so."""
    try:
        rel.encode("utf-8")
    except UnicodeEncodeError:
        return "not valid UTF-8"
    try:
        gitignore_escape(rel)
    except StorageError:
        return "contains a line break"
    return None


def make_read_only(path: Path) -> None:
    st = path.lstat()
    if stat.S_ISREG(st.st_mode):
        os.chmod(path, stat.S_IMODE(st.st_mode) & ~0o222)


def share_store_blocks(full: Path, obj: Path, sha: str) -> str:
    """Replace a run file whose bytes equal a verified store object with a
    copy-on-write clone of that object, so identical outputs of different
    runs occupy their data blocks once while remaining independent files.
    Without clone support the file is left as it is."""
    tmp = incoming_path(full.parent)
    try:
        if clone_file(obj, tmp):
            os.chmod(tmp, 0o444)
            method = "existing-shared-clone"
        else:
            return "existing-separate-copy-kept"
        if sha256_file(tmp) != sha or sha256_file(full) != sha:
            raise StorageError(f"{full} changed while being stowed")
        os.replace(tmp, full)
        fsync_dir(full.parent)
        return method
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def cmd_stow(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    threshold = resolve_threshold(repo, args.threshold)
    store = repo.store(args.store)
    tracked = repo.tracked([repo.rel(run_dir)])
    manifest = load_manifest(run_dir) or {"schema": MANIFEST_SCHEMA, "entries": []}
    entries = {e["path"]: e for e in manifest["entries"]}
    check_ignore_markers(run_dir)  # before anything is changed

    # 1. Every entry already recorded must still hold its recorded bytes,
    #    whatever its current size: a recorded result is never re-recorded.
    conflicts = []
    restore = []
    for rel_run, entry in sorted(entries.items()):
        status = entry_status(run_dir, store, entry)["status"]
        if status in ("mismatch", "missing", "store_mismatch", "unsafe_path"):
            conflicts.append((rel_run, status))
        elif status == "ok_in_place_only":
            restore.append(rel_run)  # good bytes in place, store copy lost: store again

    # 2. New bulk candidates.
    candidates, legacy, unexpressible = [], [], []
    for dirpath, dirnames, filenames in os.walk(run_dir, followlinks=False, onerror=walk_error):
        for name in sorted(filenames):
            full = Path(dirpath) / name
            rel_run = repo.git_form(full.relative_to(run_dir).as_posix())
            if rel_run in (MANIFEST_NAME, ".gitignore") or rel_run in entries:
                continue
            st = full.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_size < threshold:
                continue
            if repo.rel(full) in tracked:
                legacy.append({"path": rel_run, "size": st.st_size})
                continue
            problem = expressible_problem(rel_run)
            if problem:
                unexpressible.append((rel_run, problem))
                continue
            candidates.append((rel_run, full))
    if conflicts:
        print("run-storage: recorded outputs are changed or unavailable (nothing was changed). A changed "
              "result belongs in a new run; `missing`/`store_mismatch` entries need the store copy restored "
              "first (see `verify`):", file=sys.stderr)
        for rel_run, status in conflicts:
            print(f"  {status:>14}  {rel_run}", file=sys.stderr)
        return EXIT_FINDINGS
    if unexpressible:
        print("run-storage: these file names cannot be recorded in a manifest or ignore rule; rename them "
              "and stow again (nothing was changed):", file=sys.stderr)
        for rel_run, problem in unexpressible:
            print(f"  {problem}: {rel_run!r}", file=sys.stderr)
        return EXIT_ERROR
    plan = [(rel_run, run_dir / rel_run) for rel_run in restore] + candidates
    sizes = {rel_run: full.lstat().st_size for rel_run, full in plan}
    lines = [f"run-storage: {len(plan)} bulk file(s), {human(sum(sizes.values()))}, from {repo.rel(run_dir)} "
             f"into {store}"]
    if legacy:
        lines.append(f"  {len(legacy)} bulk file(s) are already tracked in git and stay as they are "
                     "(history is never rewritten here)")
    if args.dry_run:
        lines += [f"  would stow {human(sizes[r]):>12}  {r}" for r, _ in plan]
        emit({"dry_run": True, "planned": [{"path": r, "size": sizes[r]} for r, _ in plan],
              "already_tracked": legacy, "store": str(store)}, args.json, lines)
        return EXIT_OK

    # 3. Store, then record. The manifest is written after every store step
    #    succeeded, so a failure leaves no entry without a stored copy.
    stowed = []
    for rel_run, full in plan:
        make_read_only(full)
        sha, obj, method = store_put(full, store)
        if rel_run in entries and entries[rel_run]["sha256"] != sha:
            raise StorageError(f"{full} changed while being stowed")
        if method == "existing":
            method = share_store_blocks(full, obj, sha)
        if sha256_file(full) != sha:  # every branch: what is recorded is what is in place
            raise StorageError(f"{full} changed while being stowed; stow it after the run has finished writing")
        size = full.lstat().st_size
        if rel_run not in entries:
            entries[rel_run] = {"path": rel_run, "size": size, "sha256": sha, "stowed_utc": utc_now()}
        stowed.append({"path": rel_run, "size": size, "sha256": sha, "method": method})
        lines.append(f"  stowed {human(size):>12}  {rel_run}  ({method})")
    manifest["entries"] = sorted(entries.values(), key=lambda e: e["path"])
    manifest["threshold_bytes"] = threshold
    update_ignore_block(run_dir, [e["path"] for e in manifest["entries"]])
    write_json_atomic(run_dir / MANIFEST_NAME, manifest)
    not_ignored = []
    for entry in manifest["entries"]:
        target = run_dir / entry["path"]
        if git(["check-ignore", "-q", "--", os.path.relpath(target, repo.toplevel)], repo.toplevel,
               check=False, literal_pathspecs=False).returncode != 0:
            not_ignored.append(entry["path"])
    if not_ignored:
        print(f"run-storage: the ignore block does not cover {not_ignored}; a negation rule elsewhere "
              "re-includes them. Fix the ignore rules before committing.", file=sys.stderr)
        return EXIT_FINDINGS
    lines.append(f"  commit {repo.rel(run_dir / MANIFEST_NAME)} and {repo.rel(run_dir / '.gitignore')}; "
                 "stowed files are read-only (a corrected result goes to a new run)")
    emit({"stowed": stowed, "already_tracked": legacy, "store": str(store),
          "manifest": str(run_dir / MANIFEST_NAME)}, args.json, lines)
    return EXIT_OK


# ---------------------------------------------------------- verify / materialize

ENTRY_STATUSES = ("ok", "ok_in_place_only", "in_store_only", "mismatch", "store_mismatch", "missing", "unsafe_path")
GOOD_ENTRY_STATUSES = ("ok", "in_store_only")


def entry_path_is_safe(run_dir: Path, rel: str) -> bool:
    """A recorded path may not leave the run directory through a symlinked
    ancestor (its final component is never followed here)."""
    real_run = Path(os.path.realpath(run_dir))
    parent = Path(os.path.realpath((run_dir / rel).parent))
    return parent == real_run or is_under(parent, real_run)


def entry_status(run_dir: Path, store: Path, entry: dict) -> dict:
    """ok               in place with the recorded bytes, valid store copy
    ok_in_place_only    in place with the recorded bytes, store copy absent or damaged
    in_store_only       absent in place, valid store copy (`materialize` restores it)
    mismatch            something else occupies the path (other bytes, a symlink, a special file)
    store_mismatch      absent in place, store object damaged
    missing             absent in place and in the store
    unsafe_path         the recorded path leads out of the run directory"""
    target = run_dir / entry["path"]
    status = {"path": entry["path"], "size": entry["size"], "sha256": entry["sha256"]}
    if not entry_path_is_safe(run_dir, entry["path"]):
        status["status"] = "unsafe_path"
        return status
    store_ok = verify_store_object(store_path(store, entry["sha256"]), entry["sha256"])
    try:
        lst = target.lstat()
    except FileNotFoundError:
        lst = None
    except NotADirectoryError:  # an ancestor was replaced by a file: something else occupies the path
        status.update(status="mismatch", actual_sha256=None)
        return status
    if lst is not None:
        if not stat.S_ISREG(lst.st_mode):  # a symlink (dangling or not), FIFO, or device is not the record
            status.update(status="mismatch", actual_sha256=None)
            return status
        actual = sha256_file(target)
        if actual != entry["sha256"] or lst.st_size != entry["size"]:
            status.update(status="mismatch", actual_sha256=actual)
        else:
            status["status"] = "ok" if store_ok else "ok_in_place_only"
        return status
    obj = store_path(store, entry["sha256"])
    if store_ok:
        status["status"] = "in_store_only"
    elif obj.exists() or obj.is_symlink():
        status["status"] = "store_mismatch"
    else:
        status["status"] = "missing"
    return status


def cmd_verify(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    store = repo.store(args.store)
    manifest = load_manifest(run_dir)
    if manifest is None:
        raise StorageError(f"no {MANIFEST_NAME} in {run_dir}")
    statuses = [entry_status(run_dir, store, e) for e in manifest["entries"]]
    bad = [s for s in statuses if s["status"] not in GOOD_ENTRY_STATUSES]
    lines = [f"run-storage verify {repo.rel(run_dir)}: {len(statuses)} entr(y/ies)"]
    for s in statuses:
        lines.append(f"  {s['status']:>14}  {s['path']}")
    if any(s["status"] == "in_store_only" for s in statuses):
        lines.append("  in_store_only entries are intact in the store; `materialize` makes them readable in place")
    if any(s["status"] == "ok_in_place_only" for s in statuses):
        lines.append("  ok_in_place_only entries lost their store copy; `stow` stores them again")
    emit({"run_dir": str(run_dir), "store": str(store), "entries": statuses}, args.json, lines)
    return EXIT_FINDINGS if bad else EXIT_OK


def cmd_materialize(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    store = repo.store(args.store)
    manifest = load_manifest(run_dir)
    if manifest is None:
        raise StorageError(f"no {MANIFEST_NAME} in {run_dir}")
    done, problems = [], []
    for entry in manifest["entries"]:
        try:
            materialize_entry(run_dir, store, entry, args.dry_run, done, problems)
        except OSError as exc:  # e.g. an unreadable file or an ancestor that became a file
            problems.append({"path": entry["path"], "status": f"not_placed ({exc.strerror or exc})"})
    lines = [f"run-storage materialize {repo.rel(run_dir)}: {len(done)} restored, {len(problems)} unavailable"]
    lines += [f"  {d['method']:>8}  {d['path']}" for d in done]
    lines += [f"  {p['status']}  {p['path']} (left untouched)" for p in problems]
    emit({"restored": done, "unavailable": problems, "store": str(store)}, args.json, lines)
    return EXIT_FINDINGS if problems else EXIT_OK


def materialize_entry(run_dir: Path, store: Path, entry: dict, dry_run: bool, done: list, problems: list) -> None:
    """Restore one manifest entry from the store, or record why not."""
    target = run_dir / entry["path"]
    if not entry_path_is_safe(run_dir, entry["path"]):
        problems.append({"path": entry["path"], "status": "unsafe_path"})
        return
    if target.exists() or target.is_symlink():
        # Something occupies the path: fine only if it already holds the
        # recorded bytes; never overwritten.
        if target.is_symlink():
            problems.append({"path": entry["path"], "status": "occupied_by_symlink"})
        elif not target.is_file():
            problems.append({"path": entry["path"], "status": "occupied_by_non_file"})
        elif sha256_file(target) != entry["sha256"]:
            problems.append({"path": entry["path"], "status": "occupied_by_different_bytes"})
        return
    dest = store_path(store, entry["sha256"])
    if not verify_store_object(dest, entry["sha256"]):
        exists = dest.exists() or dest.is_symlink()
        problems.append({"path": entry["path"], "status": "store_mismatch" if exists else "missing"})
        return
    if dry_run:
        done.append({"path": entry["path"], "method": "planned"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    done.append({"path": entry["path"], "method": place_from_store(dest, target, entry["sha256"])})


# ------------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="run_storage.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, project=True, json_flag=True, limit=True):
        if project:
            p.add_argument("--project-root", default=None, help="repository checkout (default: from the path or cwd)")
        if json_flag:
            p.add_argument("--json", action="store_true", help="machine-readable output")
        if limit:
            p.add_argument("--limit", type=int, default=20, help="rows listed per category")

    p = sub.add_parser("check", help="report bulk files under the run roots")
    common(p)
    p.add_argument("--staged", action="store_true", help="only files staged for the next commit")
    p.add_argument("--threshold", type=int, default=None, help="bytes (default: policy, 5 MiB)")
    p.add_argument("--strict", action="store_true", help="exit 1 when bulk files would enter history")
    p.add_argument("--quiet", action="store_true", help="print nothing when there is nothing to report")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("stow", help="store a finished run's bulk outputs (independent copy; the file stays in place, read-only)")
    common(p)
    p.add_argument("run_dir")
    p.add_argument("--threshold", type=int, default=None)
    p.add_argument("--store", default=None, help="content store (default: policy or <git common dir>/nullius/store)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_stow)

    p = sub.add_parser("verify", help="check manifest entries against their sha256")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("materialize", help="recreate missing manifest entries from the store")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_materialize)

    return parser


SUBCOMMANDS = ("check", "stow", "verify", "materialize")


def main(argv: "list[str] | None" = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "project_root", None) is None and args.command == "check":
        args.project_root = "."
    try:
        return args.func(args)
    except StorageError as exc:
        print(f"run-storage: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except OSError as exc:
        print(f"run-storage: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
