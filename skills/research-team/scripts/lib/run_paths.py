"""Canonical write admission and original-location evidence reads."""
from __future__ import annotations

import stat
import warnings
from pathlib import Path



def canonical_run_root(project_root: Path) -> Path:
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


def read_run_directories(project_root: Path) -> list[Path]:
    """Readable locations plus scoped warnings; never follow aliases."""
    directories = []
    for root in [canonical_run_root(project_root), project_root / 'team' / 'runs']:
        try:
            for component in [root.parent, root]:
                try:
                    mode = component.lstat().st_mode
                except FileNotFoundError:
                    continue
                if not stat.S_ISDIR(mode) or not mode & 0o444 or not mode & 0o111:
                    raise ValueError(f'run evidence directory is unavailable: {component}')
            if not root.is_dir():
                continue
            entries = sorted(root.iterdir())
        except (OSError, ValueError) as exc:
            if root.parent.name == 'artifacts':
                raise
            warnings.warn(f'HISTORICAL_RUN_ROOT_UNREADABLE: {exc}', stacklevel=2)
            continue
        for run in entries:
            if run.is_symlink():
                warnings.warn(f'RUN_DIRECTORY_UNREADABLE: run evidence must not be a symlink: {run}', stacklevel=2)
            elif run.is_dir():
                directories.append(run)
    return directories


def read_run_directory(project_root: Path, run_id: str) -> Path | None:
    if not run_id or Path(run_id).name != run_id or run_id in {'.', '..'}:
        raise ValueError('run id must be one path segment')
    matches = [run for run in read_run_directories(project_root) if run.name == run_id]
    for root in [project_root / 'artifacts' / 'runs', project_root / 'team' / 'runs']:
        try:
            modes = [component.lstat().st_mode for component in [root.parent, root]]
        except (FileNotFoundError, PermissionError):
            continue
        if any(not stat.S_ISDIR(mode) or not mode & 0o444 or not mode & 0o111 for mode in modes):
            continue
        candidate = root / run_id
        if candidate.is_symlink():
            raise ValueError(f'run evidence must not be a symlink: {candidate}')
    if len(matches) > 1:
        raise ValueError(f'ambiguous run id {run_id}: ' + ', '.join(str(run) for run in matches))
    if matches:
        mode = matches[0].lstat().st_mode
        if not mode & 0o444 or not mode & 0o111:
            raise ValueError(f'run evidence directory is unavailable: {matches[0]}')
    return matches[0] if matches else None


def read_team_payloads(project_root: Path) -> list[Path]:
    payloads = []
    for run in read_run_directories(project_root):
        mode = run.lstat().st_mode
        if not mode & 0o444 or not mode & 0o111:
            warnings.warn(f'RUN_DIRECTORY_UNREADABLE: {run}', stacklevel=2)
            continue
        nested = run / 'research_team'
        try:
            mode = nested.lstat().st_mode
        except FileNotFoundError:
            if run.parent == project_root / 'team' / 'runs':
                payloads.append(run)
            continue
        except OSError as exc:
            warnings.warn(f'RUN_DIRECTORY_UNREADABLE: {nested}: {exc}', stacklevel=2)
            continue
        if not stat.S_ISDIR(mode) or not mode & 0o444 or not mode & 0o111:
            warnings.warn(f'RUN_DIRECTORY_UNREADABLE: {nested}', stacklevel=2)
            continue
        payloads.append(nested)
    return payloads
