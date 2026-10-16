from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from install_skill_runtime.source_payload import collect_payload_files, is_reparse_path


def _write(root: Path, relative: str, content: str = "public example\n") -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _directory_link(target: Path, link: Path) -> None:
    if os.name == "nt":
        subprocess.run(["node", "-e", "require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                        str(target), str(link)], check=True)
    else:
        link.symlink_to(target, target_is_directory=True)
    assert is_reparse_path(link)


@pytest.fixture
def source(tmp_path):
    directory = tmp_path / "source"
    for relative in ("SKILL.md", "scripts/run.py", "scripts/a/helper.py", "scripts/a/helper.txt",
                     "scripts/deeper/a/end.py", "assets/logo.svg", "assets/nested/icon.svg",
                     "templates/readme.md", "tests/internal.py"):
        _write(directory, relative)
    return directory


@pytest.mark.parametrize("include,expected", [
    (["SKILL.md", "scripts/**/*.py"], {"SKILL.md", "scripts/run.py", "scripts/a/helper.py", "scripts/deeper/a/end.py"}),
    (["SKILL.md", "scripts/*/helper.?y"], {"SKILL.md", "scripts/a/helper.py"}),
    (["SKILL.md", "scripts/[ab]/helper.*"], {"SKILL.md", "scripts/a/helper.py", "scripts/a/helper.txt"}),
    (["SKILL.md", "assets"], {"SKILL.md", "assets/logo.svg", "assets/nested/icon.svg"}),
    (["SKILL.md", "assets/"], {"SKILL.md", "assets/logo.svg", "assets/nested/icon.svg"}),
    (["SKILL.md", "scripts/**"], {"SKILL.md", "scripts/run.py", "scripts/a/helper.py", "scripts/a/helper.txt", "scripts/deeper/a/end.py"}),
    (["SKILL.md", "**/assets/*.svg"], {"SKILL.md", "assets/logo.svg"}),
    (["**"], {"SKILL.md", "scripts/run.py", "scripts/a/helper.py", "scripts/a/helper.txt", "scripts/deeper/a/end.py",
               "assets/logo.svg", "assets/nested/icon.svg", "templates/readme.md"}),
])
def test_component_globs_and_included_directories(source, include, expected):
    result = collect_payload_files(source, include, [])
    assert {path.relative_to(source).as_posix() for path in result} == expected


def test_exclusion_policy_remains_per_filename_and_selected_privacy_remains_enforced(source):
    _write(source, "scripts/private/.env", "TOKEN=private_fixture_value\n")
    selected = collect_payload_files(source, ["SKILL.md", "scripts/**"], ["scripts/private/**", "scripts/a"])
    assert "scripts/a/helper.py" in {path.relative_to(source).as_posix() for path in selected}
    assert all("private" not in path.parts for path in selected)
    with pytest.raises(RuntimeError, match="sensitive filename") as error:
        collect_payload_files(source, ["SKILL.md", "scripts/**"], [])
    assert "private_fixture_value" not in str(error.value)


@pytest.mark.parametrize("include", [["SKILL.md", "scripts/**"], ["SKILL.md", "scripts/linked/*.txt"]])
def test_external_junction_is_refused_before_enumeration_or_read(source, tmp_path, monkeypatch, include):
    outside = tmp_path / "outside"
    _write(outside, "external-file.txt", "must never be read\n")
    link = source / "scripts/linked"
    _directory_link(outside, link)
    original_iterdir = Path.iterdir
    original_read = Path.read_bytes

    def guarded_iterdir(path):
        assert not is_reparse_path(path), f"traversed reparse directory: {path}"
        assert path != outside
        return original_iterdir(path)

    def guarded_read(path):
        assert path.resolve() != outside / "external-file.txt"
        return original_read(path)

    monkeypatch.setattr(Path, "iterdir", guarded_iterdir)
    monkeypatch.setattr(Path, "read_bytes", guarded_read)
    with pytest.raises(RuntimeError, match="outside source root"):
        collect_payload_files(source, include, [])
    assert (outside / "external-file.txt").read_text() == "must never be read\n"


def test_cycle_is_refused_and_excluded_junctions_are_not_traversed(source, tmp_path, monkeypatch):
    outside = tmp_path / "outside"
    _write(outside, "credentials.json", "private fixture\n")
    _directory_link(outside, source / "scripts/linked")
    _directory_link(source, source / "scripts/cycle")
    original_iterdir = Path.iterdir

    def guarded_iterdir(path):
        assert not is_reparse_path(path), f"traversed reparse directory: {path}"
        return original_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", guarded_iterdir)
    with pytest.raises(RuntimeError, match="symlink in selected payload"):
        collect_payload_files(source, ["SKILL.md", "scripts/cycle/**"], [])
    selected = collect_payload_files(source, ["**/*"], ["scripts/linked/**", "scripts/cycle/**"])
    assert all(not is_reparse_path(path) for path in selected)
    assert {path.relative_to(source).as_posix() for path in selected} == {
        "SKILL.md", "scripts/run.py", "scripts/a/helper.py", "scripts/a/helper.txt", "scripts/deeper/a/end.py",
        "assets/logo.svg", "assets/nested/icon.svg", "templates/readme.md",
    }
