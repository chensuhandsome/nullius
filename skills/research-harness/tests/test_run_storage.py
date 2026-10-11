"""Tests for run_storage.py (bulk run outputs kept out of git history)."""
from __future__ import annotations

import errno
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "run_storage.py"
_spec = importlib.util.spec_from_file_location("run_storage", _MOD)
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

SKILL_MD = Path(__file__).resolve().parent.parent / "SKILL.md"
THRESHOLD = 4096


@pytest.fixture(autouse=True)
def hermetic_git(monkeypatch, tmp_path):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    monkeypatch.setenv("GIT_AUTHOR_NAME", "test")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "test")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "test@example.invalid")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "test@example.invalid")


def sh(*args, cwd, check=True):
    proc = subprocess.run(list(args), cwd=str(cwd), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise AssertionError(f"{args} failed: {proc.stdout}\n{proc.stderr}")
    return proc


def make_repo(tmp_path: Path, policy: "dict | None" = None) -> Path:
    repo = tmp_path / "project"
    repo.mkdir()
    sh("git", "init", "-q", "-b", "main", cwd=repo)
    (repo / "README.md").write_text("project\n")
    (repo / "artifacts" / "runs").mkdir(parents=True)
    (repo / "artifacts" / "runs" / ".keep").write_text("")
    doc = {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD}
    if policy:
        doc.update(policy)
    (repo / ".nullius").mkdir()
    (repo / ".nullius" / "storage_policy.json").write_text(json.dumps(doc))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "init", cwd=repo)
    return repo


def blob(n: int, seed: int = 0) -> bytes:
    pattern = bytes((i * 7 + seed) % 251 for i in range(251))
    return (pattern * (n // len(pattern) + 1))[:n]


def run_main(argv, cwd: Path, monkeypatch) -> int:
    monkeypatch.chdir(cwd)
    return rs.main(argv)


def store_of(repo: Path) -> Path:
    return repo / ".git" / "nullius" / "store"


def stow_json(run_dir, cwd, monkeypatch, capsys) -> dict:
    capsys.readouterr()
    assert run_main(["stow", str(run_dir), "--json"], cwd, monkeypatch) == rs.EXIT_OK
    return json.loads(capsys.readouterr().out)


def overwrite_in_place(path: Path, data: bytes) -> None:
    os.chmod(path, 0o644)
    with open(path, "r+b") as fh:
        fh.write(data)


# ------------------------------------------------------------------ check

def test_check_staged_warns_and_strict_blocks(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.dat").write_bytes(blob(THRESHOLD + 10))
    (run / "small.txt").write_text("summary\n")
    sh("git", "add", "-A", cwd=repo)
    assert run_main(["check", "--staged"], repo, monkeypatch) == rs.EXIT_OK
    out = capsys.readouterr().out
    assert "artifacts/runs/r1/big.dat" in out and "small.txt" not in out
    assert run_main(["check", "--staged", "--strict"], repo, monkeypatch) == rs.EXIT_FINDINGS
    sh("git", "restore", "--staged", "artifacts/runs/r1/big.dat", cwd=repo)
    capsys.readouterr()
    assert run_main(["check", "--staged", "--strict", "--quiet"], repo, monkeypatch) == rs.EXIT_OK
    assert capsys.readouterr().out == ""


def test_check_working_tree_classifies_bulk(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    (runs / "legacy").mkdir()
    (runs / "legacy" / "tracked.dat").write_bytes(blob(THRESHOLD, 1))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy bulk", cwd=repo)
    (runs / "new").mkdir()
    (runs / "new" / "untracked.dat").write_bytes(blob(THRESHOLD, 2))
    (runs / "stowed").mkdir()
    (runs / "stowed" / "out.dat").write_bytes(blob(THRESHOLD, 3))
    assert run_main(["stow", "artifacts/runs/stowed"], repo, monkeypatch) == rs.EXIT_OK
    (runs / "ignored").mkdir()
    (runs / "ignored" / ".gitignore").write_text("*.dat\n")
    (runs / "ignored" / "lost.dat").write_bytes(blob(THRESHOLD, 4))
    capsys.readouterr()
    assert run_main(["check", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    paths = {k: [r["path"] for r in doc[k]] for k in ("tracked", "untracked", "stowed", "stowed_damaged",
                                                      "ignored_unstowed")}
    assert paths == {
        "tracked": ["artifacts/runs/legacy/tracked.dat"],
        "untracked": ["artifacts/runs/new/untracked.dat"],
        "stowed": ["artifacts/runs/stowed/out.dat"],
        "stowed_damaged": [],
        "ignored_unstowed": ["artifacts/runs/ignored/lost.dat"],
    }
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_FINDINGS


@pytest.mark.parametrize("damage", ["rewrite_by_rename", "shrink_below_threshold", "store_object_lost"])
def test_check_strict_flags_stowed_outputs_that_no_longer_match(tmp_path, monkeypatch, capsys, damage):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 5))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    sha = rs.sha256_file(run / "a.bin")
    if damage == "rewrite_by_rename":  # read-only bits do not stop a rename over the file
        (run / ".tmp").write_bytes(blob(THRESHOLD, 6))
        os.replace(run / ".tmp", run / "a.bin")
    elif damage == "shrink_below_threshold":
        (run / "a.bin").unlink()
        (run / "a.bin").write_bytes(b"small now")
    else:
        rs.store_path(store_of(repo), sha).unlink()
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["stowed_damaged"]] == ["artifacts/runs/r1/a.bin"] and doc["stowed"] == []


@pytest.mark.parametrize("defect", ["duplicate_path", "hash_not_hex", "size_bool", "size_negative", "path_not_normal"])
@pytest.mark.parametrize("command", ["check", "verify", "stow", "materialize"])
def test_malformed_manifests_are_refused_by_every_reader(tmp_path, monkeypatch, defect, command):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 83))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    entry = manifest["entries"][0]
    if defect == "duplicate_path":  # a damaged first record followed by a valid one
        manifest["entries"] = [{**entry, "sha256": "f" * 64}, entry]
    elif defect == "hash_not_hex":
        entry["sha256"] = "z" * 64
    elif defect == "size_bool":
        entry["size"] = True
    elif defect == "size_negative":
        entry["size"] = -1
    else:
        entry["path"] = "./a.bin"
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    argv = {"check": ["check", "--strict"], "verify": ["verify", str(run)], "stow": ["stow", str(run)],
            "materialize": ["materialize", str(run)]}[command]
    assert run_main(argv, repo, monkeypatch) == rs.EXIT_ERROR


def test_verify_compares_the_recorded_size_too(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 84))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"][0]["size"] += 1  # inconsistent record, right hash
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["mismatch"]


def test_policy_file_is_validated(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    policy = repo / ".nullius" / "storage_policy.json"
    for doc in ({"schema": "other"},
                {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": 0},
                {"schema": rs.POLICY_SCHEMA, "run_roots": ["../outside"]},
                # a relative store would live inside each checkout and die with a removed worktree
                {"schema": rs.POLICY_SCHEMA, "store_root": ".nullius/store"}):
        policy.write_text(json.dumps(doc))
        assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR, doc


# ------------------------------------------------------------------- stow

def test_stow_stores_once_and_keeps_the_file_readable_in_place(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    data = blob(THRESHOLD * 3, 5)
    (run / "sub" / "field.bin").write_bytes(data)
    (run / "log.txt").write_text("small log\n")
    [stowed] = stow_json(run, repo, monkeypatch, capsys)["stowed"]
    target = run / "sub" / "field.bin"
    obj = rs.store_path(store_of(repo), stowed["sha256"])
    assert stowed["method"] in ("clone", "link", "copy")
    assert rs.verify_store_object(obj, stowed["sha256"]) and target.read_bytes() == data
    assert stat.S_IMODE(target.stat().st_mode) & 0o222 == 0, "stowed output is read-only"
    if stowed["method"] == "clone":
        assert not os.path.samestat(obj.stat(), target.stat()), "a clone is an independent file"
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    assert manifest["schema"] == rs.MANIFEST_SCHEMA
    assert [(e["path"], e["size"], e["sha256"]) for e in manifest["entries"]] == \
        [("sub/field.bin", len(data), stowed["sha256"])]
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/sub/field.bin", cwd=repo, check=False).returncode == 0
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/log.txt", cwd=repo, check=False).returncode == 1
    sh("git", "add", "-A", cwd=repo)
    staged = sh("git", "diff", "--cached", "--name-only", cwd=repo).stdout.split()
    assert "artifacts/runs/r1/sub/field.bin" not in staged
    assert {"artifacts/runs/r1/bulk_manifest.json", "artifacts/runs/r1/.gitignore",
            "artifacts/runs/r1/log.txt"} <= set(staged)
    assert stow_json(run, repo, monkeypatch, capsys)["stowed"] == [], "second stow is a no-op"


def test_identical_outputs_share_one_store_object(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(blob(THRESHOLD * 2, 9))
    stow_json(runs / "a", repo, monkeypatch, capsys)
    [second] = stow_json(runs / "b", repo, monkeypatch, capsys)["stowed"]
    assert second["method"].startswith("existing")
    objects = [e for e in (store_of(repo) / "sha256").rglob("*") if e.is_file()]
    assert len(objects) == 1
    for name in ("a", "b"):
        assert run_main(["verify", str(runs / name)], repo, monkeypatch) == rs.EXIT_OK


def test_in_place_edit_is_refused_and_never_spreads_to_other_runs(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    original = blob(THRESHOLD * 2, 12)
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(original)
    [first] = stow_json(runs / "a", repo, monkeypatch, capsys)["stowed"]
    assert first["method"] in ("clone", "copy"), "the store never shares an inode with a run file"
    overwrite_in_place(runs / "a" / "out.bin", b"CORRUPT")  # deliberate edit of a stowed output
    sha = rs.hashlib.sha256(original).hexdigest()
    assert rs.verify_store_object(rs.store_path(store_of(repo), sha), sha), "the edit never reaches the store"
    capsys.readouterr()
    assert run_main(["stow", str(runs / "a")], repo, monkeypatch) == rs.EXIT_FINDINGS, "changed result refused"
    # Run b holds the original bytes; stowing it must never replace them with damaged ones,
    # whether or not the edit above reached the store (it does when the store shares an inode).
    stow_json(runs / "b", repo, monkeypatch, capsys)
    assert (runs / "b" / "out.bin").read_bytes() == original
    assert rs.verify_store_object(rs.store_path(store_of(repo), sha), sha)
    assert run_main(["verify", str(runs / "b")], repo, monkeypatch) == rs.EXIT_OK
    overwrite_in_place(runs / "b" / "out.bin", b"LATER")  # an edit of run b never reaches run a's evidence
    assert rs.verify_store_object(rs.store_path(store_of(repo), sha), sha)


def test_stow_without_clone_support_still_keeps_independent_copies(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)  # e.g. a file system without copy-on-write
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD, 18)
    (run / "out.bin").write_bytes(data)
    [stowed] = stow_json(run, repo, monkeypatch, capsys)["stowed"]
    obj = rs.store_path(store_of(repo), stowed["sha256"])
    assert stowed["method"] == "copy" and not os.path.samestat(obj.stat(), (run / "out.bin").stat())
    overwrite_in_place(run / "out.bin", b"EDIT")
    assert rs.verify_store_object(obj, stowed["sha256"])


def test_a_damaged_store_object_is_set_aside_not_trusted(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    original = blob(THRESHOLD * 2, 13)
    (runs / "a").mkdir()
    (runs / "a" / "out.bin").write_bytes(original)
    sha = stow_json(runs / "a", repo, monkeypatch, capsys)["stowed"][0]["sha256"]
    obj = rs.store_path(store_of(repo), sha)
    forged = obj.with_name("forged")
    forged.write_bytes(blob(len(original), 14))  # same size, different bytes, under the right name
    os.replace(forged, obj)
    assert run_main(["verify", str(runs / "a")], repo, monkeypatch) == rs.EXIT_FINDINGS  # ok_in_place_only
    (runs / "b").mkdir()
    (runs / "b" / "out.bin").write_bytes(original)
    stow_json(runs / "b", repo, monkeypatch, capsys)
    assert (runs / "b" / "out.bin").read_bytes() == original
    assert rs.verify_store_object(obj, sha)
    assert [p.name for p in obj.parent.iterdir() if ".damaged-" in p.name], "damaged bytes kept for inspection"
    assert run_main(["verify", str(runs / "a")], repo, monkeypatch) == rs.EXIT_OK


def test_stow_leaves_tracked_bulk_alone_and_refuses_outside_run_roots(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "legacy"
    run.mkdir()
    (run / "tracked.bin").write_bytes(blob(THRESHOLD, 11))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy", cwd=repo)
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert doc["stowed"] == [] and [r["path"] for r in doc["already_tracked"]] == ["tracked.bin"]
    other = repo / "elsewhere"
    other.mkdir()
    assert run_main(["stow", str(other)], repo, monkeypatch) == rs.EXIT_ERROR


def test_stow_refuses_unrecordable_names_before_changing_anything(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "fine.bin").write_bytes(blob(THRESHOLD, 15))
    (run / "line\nbreak.bin").write_bytes(blob(THRESHOLD, 16))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (run / rs.MANIFEST_NAME).exists() and not (run / ".gitignore").exists()
    assert stat.S_IMODE((run / "fine.bin").stat().st_mode) & 0o200, "nothing was made read-only"
    assert not store_of(repo).exists()


@pytest.mark.skipif(sys.platform == "darwin", reason="macOS file systems refuse names that are not valid UTF-8")
def test_stow_refuses_names_that_are_not_utf8(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "fine.bin").write_bytes(blob(THRESHOLD, 15))
    with open(os.path.join(os.fsencode(run), b"bad\xff.bin"), "wb") as fh:
        fh.write(blob(THRESHOLD, 19))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (run / rs.MANIFEST_NAME).exists()
    assert stat.S_IMODE((run / "fine.bin").stat().st_mode) & 0o200


def test_materialize_without_clone_support_places_an_independent_read_only_copy(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD, 68)
    (run / "out.bin").write_bytes(data)
    sha = stow_json(run, repo, monkeypatch, capsys)["stowed"][0]["sha256"]
    (run / "out.bin").unlink()
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert [r["method"] for r in json.loads(capsys.readouterr().out)["restored"]] == ["copy"]
    obj = rs.store_path(store_of(repo), sha)
    placed = run / "out.bin"
    assert placed.read_bytes() == data and not os.path.samestat(placed.stat(), obj.stat())
    assert stat.S_IMODE(placed.stat().st_mode) & 0o222 == 0


def test_stow_rehashes_the_source_on_the_existing_object_branch(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    original = blob(THRESHOLD, 69)
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(original)
    stow_json(runs / "a", repo, monkeypatch, capsys)

    def writer_then_no_clone(src, dst):  # an open writer changes run b between hashing and recording
        target = runs / "b" / "out.bin"
        os.chmod(target, 0o644)
        target.write_bytes(blob(THRESHOLD, 70))
        return False

    monkeypatch.setattr(rs, "clone_file", writer_then_no_clone)
    assert run_main(["stow", str(runs / "b")], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (runs / "b" / rs.MANIFEST_NAME).exists(), "nothing recorded for bytes that are not in place"


@pytest.mark.parametrize("command", ["verify", "check", "stow", "materialize"])
def test_symlinks_at_or_above_recorded_paths_are_never_trusted(tmp_path, monkeypatch, capsys, command):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 71))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    os.symlink(tmp_path / "nowhere", run / "a.bin")  # dangling symlink at a recorded path
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, run / "link")  # a symlinked ancestor of a recorded path
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"].append({"path": "link/escape.bin", "size": THRESHOLD, "sha256": manifest["entries"][0]["sha256"]})
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    capsys.readouterr()
    argv = {"verify": ["verify", str(run), "--json"], "check": ["check", "--strict", "--json"],
            "stow": ["stow", str(run)], "materialize": ["materialize", str(run), "--json"]}[command]
    assert run_main(argv, repo, monkeypatch) == rs.EXIT_FINDINGS
    out = capsys.readouterr().out
    if command == "verify":
        assert {e["path"]: e["status"] for e in json.loads(out)["entries"]} == {
            "a.bin": "mismatch", "link/escape.bin": "unsafe_path"}
    if command == "check":
        assert len(json.loads(out)["stowed_damaged"]) == 2
    assert list(outside.iterdir()) == [], "nothing is created outside the run directory"


def test_stow_refuses_a_recorded_path_that_escapes_through_a_symlinked_ancestor(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 74))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "escape.bin").write_bytes(blob(THRESHOLD, 75))
    os.chmod(outside / "escape.bin", 0o644)
    os.symlink(outside, run / "link")
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"].append({"path": "link/escape.bin", "size": THRESHOLD,
                                "sha256": rs.sha256_file(outside / "escape.bin")})
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    (run / "new.bin").write_bytes(blob(THRESHOLD, 76))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert stat.S_IMODE((outside / "escape.bin").stat().st_mode) == 0o644, "nothing outside is touched"
    assert stat.S_IMODE((run / "new.bin").stat().st_mode) & 0o200, "nothing is changed at all"


def test_materialize_never_overwrites_an_occupied_path(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 64))
    (run / "b.bin").write_bytes(blob(THRESHOLD, 65))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    os.symlink(tmp_path / "nowhere", run / "a.bin")  # dangling
    (run / "b.bin").unlink()
    (run / "b.bin").write_bytes(b"other bytes")
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert {p["path"]: p["status"] for p in doc["unavailable"]} == {
        "a.bin": "occupied_by_symlink", "b.bin": "occupied_by_different_bytes"}
    assert (run / "b.bin").read_bytes() == b"other bytes"


def test_stow_refuses_a_run_directory_holding_a_nested_repository(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    nested = run / "dep"
    nested.mkdir(parents=True)
    sh("git", "init", "-q", cwd=nested)
    (nested / "big.bin").write_bytes(blob(THRESHOLD, 85))
    assert run_main(["stow", str(run), "--project-root", str(repo)], repo, monkeypatch) == rs.EXIT_ERROR
    assert stat.S_IMODE((nested / "big.bin").stat().st_mode) & 0o200 and not (run / rs.MANIFEST_NAME).exists()


def test_symlinked_run_root_is_refused_cleanly(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    outside = tmp_path / "outside-runs"
    (outside / "r1").mkdir(parents=True)
    (outside / "r1" / "big.bin").write_bytes(blob(THRESHOLD, 17))
    shutil.rmtree(repo / "artifacts" / "runs")
    os.symlink(outside, repo / "artifacts" / "runs")
    assert run_main(["stow", "artifacts/runs/r1"], repo, monkeypatch) == rs.EXIT_ERROR
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_OK


def test_ignore_block_escapes_special_names(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    names = ["a[1]*.bin", "#hash.bin", "!bang.bin", "trailing.bin ", "back\\slash.bin", "tab\there.bin"]
    for i, name in enumerate(names):
        (run / name).write_bytes(blob(THRESHOLD, 20 + i))
    (run / "a1x.bin").write_bytes(b"small")
    (run / ".gitignore").write_text("# user rule kept\n*.tmp\n")
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    for name in names:
        rel = f"artifacts/runs/r1/{name}"
        assert sh("git", "check-ignore", "-q", "--no-index", rel, cwd=repo, check=False).returncode == 0, name
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/a1x.bin", cwd=repo, check=False).returncode == 1
    text = (run / ".gitignore").read_text()
    assert text.startswith("# user rule kept\n*.tmp\n") and text.count(rs.GITIGNORE_BEGIN) == 1


@pytest.mark.skipif(sys.platform != "darwin", reason="decomposed file names are a macOS file-system behaviour")
def test_decomposed_unicode_names_are_recorded_in_git_form(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "é.bin").write_bytes(blob(THRESHOLD, 30))  # NFD on disk
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert sh("git", "status", "--porcelain", "--untracked-files=all", cwd=repo).stdout.count(".bin") == 0
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["stowed_damaged"] == [] and doc["ignored_unstowed"] == []
    assert [r["path"] for r in doc["stowed"]] == ["artifacts/runs/r1/é.bin"]


def test_store_put_copies_across_file_systems(tmp_path, monkeypatch):
    src = tmp_path / "f.bin"
    src.write_bytes(blob(THRESHOLD, 30))

    def no_link(a, b):
        raise OSError(errno.EXDEV, "cross-device link")

    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)
    real_link = rs.os.link
    monkeypatch.setattr(rs.os, "link", lambda a, b: no_link(a, b) if Path(a) == src else real_link(a, b))
    sha, dest, method = rs.store_put(src, tmp_path / "store")
    assert method == "copy" and dest.read_bytes() == src.read_bytes()
    assert not os.path.samestat(dest.stat(), src.stat())


# ------------------------------------------------------- verify / materialize

def test_verify_reports_every_state(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    for name, seed in (("ok.bin", 40), ("gone.bin", 41), ("lost.bin", 42), ("bad.bin", 43), ("nostore.bin", 44)):
        (run / name).write_bytes(blob(THRESHOLD, seed))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    capsys.readouterr()
    assert run_main(["verify", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "gone.bin").unlink()
    lost_sha = rs.sha256_file(run / "lost.bin")
    (run / "lost.bin").unlink()
    rs.store_path(store_of(repo), lost_sha).unlink()
    rs.store_path(store_of(repo), rs.sha256_file(run / "nostore.bin")).unlink()
    (run / "bad.bin").unlink()
    (run / "bad.bin").write_bytes(blob(THRESHOLD, 99))
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    statuses = {e["path"]: e["status"] for e in json.loads(capsys.readouterr().out)["entries"]}
    assert statuses == {"ok.bin": "ok", "gone.bin": "in_store_only", "lost.bin": "missing",
                        "bad.bin": "mismatch", "nostore.bin": "ok_in_place_only"}


def test_verify_reports_an_ancestor_replaced_by_a_file_and_continues(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    (run / "sub" / "out.bin").write_bytes(blob(THRESHOLD, 77))
    (run / "ok.bin").write_bytes(blob(THRESHOLD, 78))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    shutil.rmtree(run / "sub")
    (run / "sub").write_text("now a file")
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert {e["path"]: e["status"] for e in json.loads(capsys.readouterr().out)["entries"]} == {
        "ok.bin": "ok", "sub/out.bin": "mismatch"}


def test_materialize_reports_a_broken_entry_and_restores_the_rest(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "a").mkdir(parents=True)
    (run / "a" / "out.bin").write_bytes(blob(THRESHOLD, 79))
    (run / "z.bin").write_bytes(blob(THRESHOLD, 80))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    shutil.rmtree(run / "a")
    (run / "a").write_text("now a file")  # sorts before z.bin
    (run / "z.bin").unlink()
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [d["path"] for d in doc["restored"]] == ["z.bin"] and (run / "z.bin").exists()
    assert [p["path"] for p in doc["unavailable"]] == ["a/out.bin"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable files")
def test_materialize_continues_past_an_unreadable_occupied_entry(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 81))
    (run / "z.bin").write_bytes(blob(THRESHOLD, 82))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    os.chmod(run / "a.bin", 0)
    (run / "z.bin").unlink()
    try:
        capsys.readouterr()
        assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
        doc = json.loads(capsys.readouterr().out)
        assert [d["path"] for d in doc["restored"]] == ["z.bin"]
        assert [p["path"] for p in doc["unavailable"]] == ["a.bin"]
    finally:
        os.chmod(run / "a.bin", 0o444)


def test_materialize_in_linked_worktree(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD * 2, 50)
    (run / "out.bin").write_bytes(data)
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "run with manifest", cwd=repo)
    wt = tmp_path / "wt"
    sh("git", "worktree", "add", "-q", "-b", "lane", str(wt), cwd=repo)
    wt_run = wt / "artifacts" / "runs" / "r1"
    assert (wt_run / rs.MANIFEST_NAME).exists() and not (wt_run / "out.bin").exists()
    assert run_main(["verify", str(wt_run)], wt, monkeypatch) == rs.EXIT_OK  # intact in the shared store
    capsys.readouterr()
    assert run_main(["materialize", str(wt_run), "--json"], wt, monkeypatch) == rs.EXIT_OK
    [restored] = json.loads(capsys.readouterr().out)["restored"]
    assert restored["method"] in ("clone", "copy")
    assert (wt_run / "out.bin").read_bytes() == data
    capsys.readouterr()
    assert run_main(["verify", str(wt_run), "--json"], wt, monkeypatch) == rs.EXIT_OK
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["ok"]


# ------------------------------------------------------------- worktrees

def _worktree(repo: Path, tmp_path: Path, name: str, *extra) -> Path:
    wt = tmp_path / name
    sh("git", "worktree", "add", "-q", *extra, "-b", name, str(wt), cwd=repo)
    return wt


# ----------------------------------------------------------------- sparse


# ----------------------------------------------------------------- report


# --------------------------------------------------------------- closeout


@pytest.mark.parametrize("layout", ["begin_only", "end_before_begin", "two_blocks"])
def test_stow_refuses_malformed_managed_block_markers_before_changing_anything(tmp_path, monkeypatch, layout):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 66))
    b, e = rs.GITIGNORE_BEGIN, rs.GITIGNORE_END
    text = {"begin_only": f"user-rule-1\n{b}\nuser-rule-2\n",
            "end_before_begin": f"{e}\nuser-rule-1\n{b}\nuser-rule-2\n",
            "two_blocks": f"{b}\n{e}\nuser-rule-1\n{b}\n{e}\n"}[layout]
    (run / ".gitignore").write_text(text)
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert (run / ".gitignore").read_text() == text
    assert stat.S_IMODE((run / "big.bin").stat().st_mode) & 0o200 and not store_of(repo).exists()


def test_verify_never_opens_a_special_file_at_a_recorded_path(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 67))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "out.bin").unlink()
    os.mkfifo(run / "out.bin")
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["mismatch"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable directories")
@pytest.mark.parametrize("command", ["check", "stow"])
def test_walks_that_records_rest_on_stop_at_unreadable_directories(tmp_path, monkeypatch, command):
    root = make_repo(tmp_path)
    hidden = root / "artifacts" / "runs" / "r1" / "sealed"
    hidden.mkdir(parents=True)
    (hidden / "big.bin").write_bytes(blob(2 * 1024 * 1024, 93))
    os.chmod(hidden, 0)
    try:
        argv = {"check": ["check", "--strict"], "stow": ["stow", "artifacts/runs/r1"]}[command]
        assert run_main(argv, root, monkeypatch) == rs.EXIT_ERROR
    finally:
        os.chmod(hidden, 0o755)


# ------------------------------------------------------- documentation lock

def test_skill_documents_exactly_the_implemented_subcommands_and_statuses():
    parser_choices = set(rs.build_parser()._subparsers._group_actions[0].choices)
    assert parser_choices == set(rs.SUBCOMMANDS)
    text = SKILL_MD.read_text(encoding="utf-8")
    match = re.search(r"^## Run Storage\b.*?(?=^## )", text, flags=re.S | re.M)
    assert match, "SKILL.md must have a '## Run Storage' section"
    section = match.group(0)
    documented = set(re.findall(r"run_storage\.py (\b[a-z][a-z-]+\b)", section))
    assert documented == set(rs.SUBCOMMANDS), (sorted(documented ^ set(rs.SUBCOMMANDS)))
    for status in rs.ENTRY_STATUSES:
        assert f"`{status}`" in section, status
    for phrase in ("bulk_manifest.json", "git worktree remove", "refs/nullius/runs", "5 MiB"):
        assert phrase in section, phrase
