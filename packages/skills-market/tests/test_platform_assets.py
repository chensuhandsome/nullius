from __future__ import annotations

import hashlib
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
from install_skill_runtime.platform_assets import copy_windows_runtime


def test_copied_runtime_is_self_contained_and_hash_bound(tmp_path):
    skill = tmp_path / "source/skills/example"
    (skill / "scripts").mkdir(parents=True)
    runtime = tmp_path / "source/packages/shared/python/nullius_windows"
    runtime.mkdir(parents=True)
    (runtime / "__init__.py").write_text("", encoding="utf-8")
    (runtime / "process.py").write_text("VALUE = 'from-source'\n", encoding="utf-8")
    target = tmp_path / "installed"
    recorded = copy_windows_runtime(skill, target)
    shutil_source = runtime / "process.py"
    shutil_source.unlink()
    installed = target / "scripts/_runtime/nullius_windows/process.py"
    assert installed.read_text(encoding="utf-8") == "VALUE = 'from-source'\n"
    assert recorded["scripts/_runtime/nullius_windows/process.py"] == hashlib.sha256(installed.read_bytes()).hexdigest()
    assert len(recorded) == 2


def test_platform_asset_collision_refuses_instead_of_overwriting(tmp_path):
    skill = tmp_path / "source/skills/example"
    (skill / "scripts").mkdir(parents=True)
    runtime = tmp_path / "source/packages/shared/python/nullius_windows"
    runtime.mkdir(parents=True)
    (runtime / "process.py").write_text("SOURCE\n", encoding="utf-8")
    target = tmp_path / "installed"
    occupied = target / "scripts/_runtime/nullius_windows/process.py"
    occupied.parent.mkdir(parents=True)
    occupied.write_text("USER\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="collides"):
        copy_windows_runtime(skill, target)
    assert occupied.read_text() == "USER\n"
