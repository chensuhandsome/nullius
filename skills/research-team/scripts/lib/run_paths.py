"""Canonical run-path admission for local executor readers."""
from __future__ import annotations

import stat
import sys
from pathlib import Path

from literature_workflow_plan import _workspace_root


def canonical_run_root(project_root: Path) -> Path:
    sys.path.insert(0, str(_workspace_root() / 'packages/project-contracts/src'))
    from project_contracts.project_policy import assert_no_retired_run_root
    assert_no_retired_run_root(project_root)
    root = project_root / 'artifacts' / 'runs'
    for path in [root.parent, root]:
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(mode) or not mode & 0o444 or not mode & 0o111:
            raise ValueError(f'canonical run root must use readable real directories: {path}')
    return root


def canonical_output_runs(out_dir: Path) -> Path:
    if out_dir.name != 'artifacts':
        raise ValueError('run lookup requires the project artifacts directory')
    return canonical_run_root(out_dir.absolute().parent)
