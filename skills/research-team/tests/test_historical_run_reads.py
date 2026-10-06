from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import sys

import pytest

SKILL = Path(__file__).resolve().parents[1]
EXPORT = SKILL / 'scripts/bin/export_paper_bundle.py'
NEXT = SKILL / 'scripts/bin/next_team_tag.py'


def scaffold(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / 'project_charter.md').write_text('# Project\n')
    (root / 'research_contract.md').write_text('# Contract\n')
    old = root / 'team/runs/past'
    old.mkdir(parents=True)
    (old / 'report.md').write_text('original evidence\n')
    return old


def export(root: Path, *args: str):
    return subprocess.run([sys.executable, str(EXPORT), '--tag', 'past', *args], cwd=root,
                          capture_output=True, text=True, timeout=15)


def test_export_preserves_original_paths_bytes_and_permissions(tmp_path: Path):
    old = scaffold(tmp_path)
    (old / 'report.md').chmod(0o640)
    before = hashlib.sha256((old / 'report.md').read_bytes()).hexdigest()
    result = export(tmp_path)
    assert result.returncode == 0, result.stderr
    copied = tmp_path / 'export/paper_bundle_past/team/runs/past/report.md'
    assert hashlib.sha256(copied.read_bytes()).hexdigest() == before
    assert copied.stat().st_mode & 0o777 == 0o640
    assert hashlib.sha256((old / 'report.md').read_bytes()).hexdigest() == before
    assert not (tmp_path / 'artifacts/runs/past').exists()


@pytest.mark.parametrize('destination', ['team/runs/past', 'TEAM/RUNS/past', 'alias/past'])
def test_export_refuses_history_destinations_and_aliases(tmp_path: Path, destination: str):
    old = scaffold(tmp_path)
    (tmp_path / 'alias').symlink_to(tmp_path / 'team/runs', target_is_directory=True)
    before = (old / 'report.md').read_bytes()
    result = export(tmp_path, '--out', destination, '--force')
    assert result.returncode != 0
    assert (old / 'report.md').read_bytes() == before
    assert sorted(p.name for p in old.iterdir()) == ['report.md']


def test_force_export_cannot_delete_source_project(tmp_path: Path):
    root = tmp_path / 'paper_bundle_past'
    old = scaffold(root)
    before = (old / 'report.md').read_bytes()
    result = export(root, '--out', '..', '--force')
    assert result.returncode != 0
    assert (old / 'report.md').read_bytes() == before
    assert (root / 'research_contract.md').is_file()


def test_unavailable_nested_history_does_not_hide_readable_round(tmp_path: Path):
    scaffold(tmp_path)
    locked = tmp_path / 'team/runs/past/research_team'
    locked.mkdir(); locked.chmod(0)
    report = tmp_path / 'artifacts/runs/example-r2/research_team/example-r2_member_a.md'
    report.parent.mkdir(parents=True)
    report.write_text('## Verdict\npass\n')
    try:
        result = subprocess.run([sys.executable, str(NEXT), '--tag', 'example', '--out-dir', str(tmp_path / 'artifacts')],
                                capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'example-r3'
        assert 'RUN_DIRECTORY_UNREADABLE' in result.stderr
    finally:
        locked.chmod(0o755)
