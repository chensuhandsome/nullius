from __future__ import annotations

from pathlib import Path
import stat
import json


PROJECT_POLICY_REAL_PROJECT = "real_project"
PROJECT_POLICY_MAINTAINER_FIXTURE = "maintainer_fixture"
PROJECT_POLICY_CHOICES = (
    PROJECT_POLICY_REAL_PROJECT,
    PROJECT_POLICY_MAINTAINER_FIXTURE,
)


def dev_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def validate_project_policy(project_policy: str | None) -> str:
    policy = (project_policy or PROJECT_POLICY_REAL_PROJECT).strip() or PROJECT_POLICY_REAL_PROJECT
    if policy not in PROJECT_POLICY_CHOICES:
        expected = ", ".join(PROJECT_POLICY_CHOICES)
        raise ValueError(f"invalid project policy: {policy} (expected: {expected})")
    return policy


def resolve_user_path(path: Path | str, *, base: Path | None = None) -> Path:
    raw = Path(path).expanduser()
    if not raw.is_absolute():
        if base is None:
            raise ValueError(f"relative path requires base: {path}")
        raw = base / raw
    return raw.resolve()


def _path_is_within(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False


def maintainer_fixture_roots(*, repo_root: Path | None = None) -> tuple[Path, ...]:
    root = (repo_root or dev_repo_root()).resolve()
    return (
        root / "skills" / "research-team" / ".tmp",
    )


def _repo_internal_path_allowed(path: Path, *, repo_root: Path, project_policy: str) -> bool:
    if not _path_is_within(path, repo_root):
        return True
    if project_policy == PROJECT_POLICY_REAL_PROJECT:
        return False
    return any(_path_is_within(path, allowed) for allowed in maintainer_fixture_roots(repo_root=repo_root))


def _policy_violation_message(*, label: str, path: Path, repo_root: Path, project_policy: str) -> str:
    if project_policy == PROJECT_POLICY_REAL_PROJECT:
        return (
            f"{label} must resolve outside the nullius dev repo for real projects.\n"
            f"path={path}\nrepo_root={repo_root}"
        )
    allowed = ", ".join(str(item) for item in maintainer_fixture_roots(repo_root=repo_root))
    return (
        f"{label} is repo-internal but not under an allowed maintainer_fixture directory.\n"
        f"path={path}\nrepo_root={repo_root}\nallowed={allowed}"
    )


def _root_is_within(path: Path, base: Path) -> bool:
    if _path_is_within(path, base):
        return True
    if not base.exists():
        return False
    return any(candidate.exists() and candidate.samefile(base) for candidate in (path, *path.parents))


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _package_name(directory: Path) -> str | None:
    try:
        value = json.loads((directory / "package.json").read_text(encoding="utf-8"), parse_constant=_reject_json_constant)
    except (OSError, ValueError) as exc:
        raise ValueError("project root has ambiguous development-checkout metadata") from exc
    return value.get("name") if isinstance(value, dict) and isinstance(value.get("name"), str) else None


def _marker_present(marker: Path) -> bool:
    try:
        marker.lstat()
        return True
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError as exc:
        raise ValueError("project root has ambiguous development-checkout metadata") from exc


def _development_checkout_root(root: Path) -> Path | None:
    markers = ("pnpm-workspace.yaml", "package.json", "packages/orchestrator/package.json", "packages/shared/package.json")
    for current in (root, *root.parents):
        if all(_marker_present(current / marker) for marker in markers):
            root_name = _package_name(current)
            orchestrator_name = _package_name(current / "packages" / "orchestrator")
            shared_name = _package_name(current / "packages" / "shared")
            if root_name == "nullius" or (orchestrator_name == "@nullius/orchestrator" and shared_name == "@nullius/shared"):
                return current
    return None


def assert_project_root_allowed(
    project_root: Path | str,
    *,
    project_policy: str | None = None,
    repo_root: Path | None = None,
) -> Path:
    repo = (repo_root or dev_repo_root()).resolve()
    root = resolve_user_path(project_root)
    policy = validate_project_policy(project_policy)
    fixture_allowed = policy == PROJECT_POLICY_MAINTAINER_FIXTURE and any(
        _root_is_within(root, allowed) for allowed in maintainer_fixture_roots(repo_root=repo)
    )
    if root == root.parent or _root_is_within(repo, root) or (_root_is_within(root, repo) and not fixture_allowed):
        raise ValueError(
            _policy_violation_message(
                label="project root",
                path=root,
                repo_root=repo,
                project_policy=policy,
            )
        )
    checkout = _development_checkout_root(root)
    if checkout is not None and not (
        policy == PROJECT_POLICY_MAINTAINER_FIXTURE
        and any(_root_is_within(root, allowed) for allowed in maintainer_fixture_roots(repo_root=checkout))
    ):
        raise ValueError(
            _policy_violation_message(label="project root", path=root, repo_root=checkout, project_policy=policy)
        )
    return root


def assert_path_allowed(
    path: Path | str,
    *,
    project_policy: str | None = None,
    repo_root: Path | None = None,
    label: str = "path",
    base: Path | None = None,
) -> Path:
    repo = (repo_root or dev_repo_root()).resolve()
    resolved = resolve_user_path(path, base=base)
    policy = validate_project_policy(project_policy)
    if not _repo_internal_path_allowed(resolved, repo_root=repo, project_policy=policy):
        raise ValueError(
            _policy_violation_message(
                label=label,
                path=resolved,
                repo_root=repo,
                project_policy=policy,
            )
        )
    return resolved


def assert_path_within_project(path: Path | str, *, project_root: Path, label: str) -> Path:
    resolved = resolve_user_path(path)
    root = project_root.resolve()
    if not _path_is_within(resolved, root):
        raise ValueError(f"{label} must resolve inside project root.\npath={resolved}\nproject_root={root}")
    return resolved


def assert_no_retired_run_root(project_root: Path) -> None:
    if (project_root / "team").is_symlink():
        raise ValueError("retired team/runs parent must not be a symlink")
    root = project_root / "team" / "runs"
    try:
        metadata = root.lstat()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise ValueError(f"retired team/runs root cannot be inspected: {root}: {exc}") from exc
    if not stat.S_ISDIR(metadata.st_mode) or not metadata.st_mode & 0o444 or not metadata.st_mode & 0o111:
        raise ValueError(f"retired team/runs root must be a readable real directory: {root}")
    try:
        entries = list(root.iterdir())
        count = sum(stat.S_ISDIR(item.lstat().st_mode) for item in entries)
        symlinks = sum(item.is_symlink() for item in entries)
    except OSError as exc:
        raise ValueError(f"retired team/runs root cannot be inspected: {root}: {exc}") from exc
    if count or symlinks:
        raise ValueError(
            f"retired team/runs root contains {count} run directories and {symlinks} symlink entries; "
            "retain the prior runtime with matching skills or perform a separately reviewed migration before switching."
        )
