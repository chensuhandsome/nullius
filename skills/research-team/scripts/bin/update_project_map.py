#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from run_paths import canonical_run_root, read_run_directory, read_team_payloads




def _utc_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Replace our own pointer entry; never open a symlink/hardlink target for writing.
    mode = path.stat().st_mode & 0o7777 if path.exists() else 0o600
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text.replace("\r\n", "\n").replace("\r", "\n"))
            os.fchmod(handle.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _assert_navigation_paths(project_root: Path, team_dir: Path, artifacts_dir: Path) -> None:
    outputs = [team_dir / name for name in ("LATEST.md", "LATEST_TEAM.md", "LATEST_DRAFT.md")]
    outputs.append(artifacts_dir / "LATEST.md")
    # A root carrier pointing at one of our entries observes its replacement
    # or removal just as it would an in-place write. Refuse before any output.
    index = project_root / "project_index.md"
    if index.is_symlink() or not index.is_file() or index.stat().st_nlink != 1:
        raise ValueError(f"root index must be an unshared regular file: {index}")
    for output in outputs:
        try:
            output.resolve().relative_to(project_root)
        except ValueError:
            raise ValueError(f"navigation output must stay within project root: {output}")
        for component in (output, *output.parents):
            if component == project_root:
                break
            if component.is_symlink():
                raise ValueError(f"navigation output alias is unsupported: {component}")
        if output.exists() and (not output.is_file() or output.stat().st_nlink != 1):
            raise ValueError(f"navigation output must be an unshared regular file: {output}")


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(8):
        # Prefer the canonical scaffold markers.
        if (cur / "project_charter.md").is_file() and (cur / "research_contract.md").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return seed.parent.resolve() if seed.is_file() else seed.resolve()


def _pick_latest_run_dir(team_dir: Path) -> Path | None:
    payloads = read_team_payloads(team_dir.absolute().parent)
    best: tuple[float, Path] | None = None
    for p in payloads:
        if not p.is_dir():
            continue
        try:
            mtime = p.stat().st_mtime
        except Exception:
            continue
        if best is None or mtime > best[0]:
            best = (mtime, p)
    return best[1] if best else None


def _infer_latest_tag_and_status(
    project_root: Path,
    team_dir: Path,
    tag_arg: str,
    status_arg: str,
    latest_kind: str,
) -> tuple[str, str]:
    tag = (tag_arg or "").strip()
    status = (status_arg or "").strip()

    if latest_kind == "draft":
        # Draft pointers must not infer state from generic team runs.
        return (tag, status) if tag and status else ("", "")

    if tag and status:
        return tag, status

    latest_dir = _pick_latest_run_dir(team_dir)
    if latest_dir is not None and not tag:
        tag = latest_dir.parent.name if latest_dir.name == "research_team" else latest_dir.name

    if tag and not status:
        traj = team_dir / "trajectory_index.json"
        if traj.is_file():
            try:
                obj = json.loads(_read_text(traj))
                runs = obj.get("runs", []) if isinstance(obj, dict) else []
                if isinstance(runs, list):
                    # Prefer converged/not_converged for this tag; otherwise take most recent stage.
                    candidates = [r for r in runs if isinstance(r, dict) and r.get("tag") == tag]
                    stage_rank = {"converged": 3, "not_converged": 2, "member_reports": 1, "preflight_ok": 0}
                    best = None
                    for r in candidates:
                        st = str(r.get("stage") or "")
                        rank = stage_rank.get(st, -1)
                        if best is None or rank > best[0]:
                            best = (rank, st)
                    if best is not None and best[1]:
                        status = best[1]
            except Exception:
                pass

    return tag, status


def _detect_latest_artifacts_dir(project_root: Path, tag: str) -> Path | None:
    if not tag:
        return None
    cand = read_run_directory(project_root, tag)
    if cand is not None:
        return cand
    return None


def _draft_template_path() -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / "team_latest_draft_template.md"


def _asset_template_path(name: str) -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / name


def _extract_pointer_field(text: str, prefix: str) -> str:
    needle = prefix.lower()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith(needle):
            return stripped.split(":", 1)[1].strip()
    return ""


def _detect_team_run_dir(team_dir: Path, tag: str) -> Path | None:
    if not _active_pointer_value(tag):
        return None
    run = read_run_directory(team_dir.absolute().parent, tag)
    if run is None:
        return None
    cand = run / "research_team"
    if cand.is_dir() and not cand.is_symlink():
        return cand
    if run.parent == team_dir.absolute() / "runs":
        return run
    return None


def _matches_placeholder_template(path: Path, template_name: str, *, fallback_tokens: tuple[str, ...]) -> bool:
    if not path.is_file():
        return False
    text = _read_text(path)
    try:
        return text == _read_text(_asset_template_path(template_name))
    except Exception:
        return all(token in text for token in fallback_tokens)


def _write_team_latest_index(team_dir: Path, *, include_team: bool = False, include_draft: bool = False) -> None:
    path = team_dir / "LATEST.md"
    lines: list[str] = []
    lines.append("# Latest pointers")
    lines.append("")
    if include_team:
        lines.append("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)")
    if include_draft:
        lines.append("- Draft cycle: [LATEST_DRAFT.md](LATEST_DRAFT.md)")
    lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(path, "\n".join(lines) + "\n")


def _write_latest_team_cycle(team_dir: Path, tag: str, status: str, run_dir: Path | None) -> None:
    path = team_dir / "LATEST_TEAM.md"
    lines: list[str] = []
    lines.append("# Latest Team Cycle")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append(f"- Latest tag: {tag or '(none)'}")
    lines.append(f"- Status: {status or '(unknown)'}")
    if run_dir is not None and run_dir.is_dir():
        rel = os.path.relpath(run_dir, team_dir)
        if not rel.startswith("."):
            rel = "./" + rel
        lines.append(f"- Run directory: [{rel}]({rel})")
        prefix = tag
        for name, label in (
            (f"{prefix}_member_a.md", "Member A report"),
            (f"{prefix}_member_b.md", "Member B report"),
            (f"{prefix}_member_c.md", "Member C report (if enabled)"),
            (f"{prefix}_adjudication.md", "Adjudication"),
            (f"team_packet_{prefix}.txt", "Team packet"),
        ):
            p = run_dir / name
            if p.is_file():
                relp = os.path.relpath(p, team_dir)
                if not relp.startswith("."):
                    relp = "./" + relp
                lines.append(f"- {label}: [{relp}]({relp})")
    lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(path, "\n".join(lines) + "\n")


def _write_latest_draft_cycle(team_dir: Path, tag: str, status: str, run_dir: Path | None) -> None:
    path = team_dir / "LATEST_DRAFT.md"
    lines: list[str] = []
    lines.append("# Latest Draft Cycle")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append("- Draft cycle state: active")
    lines.append(f"- Latest tag: {tag}")
    lines.append(f"- Status: {status}")
    if run_dir is not None and run_dir.is_dir():
        rel = os.path.relpath(run_dir, team_dir)
        if not rel.startswith("."):
            rel = "./" + rel
        lines.append(f"- Run directory: [{rel}]({rel})")
        prefix = tag
        for name, label in (
            (f"{prefix}_draft_packet.md", "Draft packet"),
            (f"{prefix}_draft_preflight.md", "Draft preflight report"),
            (f"{prefix}_draft_structure.json", "Draft structure JSON"),
            (f"{prefix}_draft_member_a.md", "Draft reviewer A"),
            (f"{prefix}_draft_member_b.md", "Draft reviewer B"),
            (f"{prefix}_draft_member_c_leader.md", "Draft leader audit (Member C)"),
            (f"{prefix}_draft_convergence_log.md", "Draft convergence log"),
            (f"{prefix}_draft_converged_summary.md", "Draft converged summary"),
        ):
            p = run_dir / name
            if p.is_file():
                relp = os.path.relpath(p, team_dir)
                if not relp.startswith("."):
                    relp = "./" + relp
                lines.append(f"- {label}: [{relp}]({relp})")
    lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(path, "\n".join(lines) + "\n")


def _is_disabled_draft_placeholder(path: Path) -> bool:
    if not path.is_file():
        return False
    text = _read_text(path)
    try:
        return text == _read_text(_draft_template_path())
    except Exception:
        return "treat this file as a disabled status marker" in text and "- Draft cycle state: optional / not configured" in text


def _is_default_team_placeholder(path: Path) -> bool:
    return _matches_placeholder_template(
        path,
        "team_latest_team_template.md",
        fallback_tokens=(
            "Older scaffolds created this placeholder eagerly",
            "- Latest tag: (none yet)",
            "- Status: (none yet)",
        ),
    )


def _is_default_artifacts_placeholder(path: Path) -> bool:
    return _matches_placeholder_template(
        path,
        "artifacts_latest_template.md",
        fallback_tokens=(
            "Older scaffolds created this placeholder eagerly",
            "- Latest tag: (none yet)",
            "- Artifacts directory: (none yet)",
        ),
    )


def _read_existing_team_state(team_dir: Path) -> tuple[str, str, bool]:
    path = team_dir / "LATEST_TEAM.md"
    if not path.is_file() or _is_default_team_placeholder(path):
        return "", "", False
    text = _read_text(path)
    tag = _extract_pointer_field(text, "- Latest tag:")
    status = _extract_pointer_field(text, "- Status:")
    active = _active_pointer_value(tag) and _active_pointer_value(status) and _detect_team_run_dir(team_dir, tag) is not None
    return tag, status, active


def _read_existing_draft_state(team_dir: Path) -> tuple[str, str, bool]:
    path = team_dir / "LATEST_DRAFT.md"
    if not path.is_file():
        return "", "", False
    if _is_disabled_draft_placeholder(path):
        return "", "", False
    text = _read_text(path)
    tag = _extract_pointer_field(text, "- Latest tag:")
    status = _extract_pointer_field(text, "- Status:")
    active = "- Draft cycle state: active" in text
    if not active and _active_pointer_value(tag) and _active_pointer_value(status):
        active = True
    if active and _detect_team_run_dir(team_dir, tag) is None:
        active = False
    return tag, status, active


def _remove_inactive_draft_pointer(team_dir: Path) -> bool:
    path = team_dir / "LATEST_DRAFT.md"
    if not _is_disabled_draft_placeholder(path):
        return False
    path.unlink()
    return True


def _remove_default_team_pointer(team_dir: Path) -> bool:
    path = team_dir / "LATEST_TEAM.md"
    if not _is_default_team_placeholder(path):
        return False
    path.unlink()
    return True


def _remove_default_artifacts_pointer(artifacts_dir: Path) -> bool:
    path = artifacts_dir / "LATEST.md"
    if not _is_default_artifacts_placeholder(path):
        return False
    path.unlink()
    return True


def _write_artifacts_latest(artifacts_dir: Path, tag: str, artifacts_run: Path | None) -> None:
    if artifacts_run is None or not artifacts_run.is_dir():
        return
    lines: list[str] = []
    lines.append("# Latest Artifacts")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append(f"- Latest tag: {tag}")
    rel = os.path.relpath(artifacts_run, artifacts_dir)
    if not rel.startswith("."):
        rel = "./" + rel
    label = "Canonical artifacts directory" if rel.startswith("./runs/") else "Legacy/provider artifacts directory"
    lines.append(f"- {label}: [{rel}]({rel})")
    _write_text(artifacts_dir / "LATEST.md", "\n".join(lines) + "\n")


def _active_pointer_value(value: str) -> bool:
    value = (value or "").strip()
    return bool(value) and value not in {
        "(none)",
        "(unknown)",
        "(no draft cycle has run yet)",
        "not configured",
    }


def _has_active_draft_state(team_dir: Path, state: dict[str, str]) -> bool:
    if (
        _active_pointer_value(state.get("draft_tag", ""))
        and _active_pointer_value(state.get("draft_status", ""))
        and _detect_team_run_dir(team_dir, state["draft_tag"]) is not None
    ):
        return True
    _, _, active = _read_existing_draft_state(team_dir)
    return active


def _has_live_artifacts_pointer(artifacts_dir: Path) -> bool:
    path = artifacts_dir / "LATEST.md"
    if not path.is_file() or _is_default_artifacts_placeholder(path):
        return False
    tag = _extract_pointer_field(_read_text(path), "- Latest tag:")
    return _active_pointer_value(tag) and _detect_latest_artifacts_dir(artifacts_dir.parent, tag) is not None


def main() -> int:
    ap = argparse.ArgumentParser(description="Update executor-local latest navigation pointers.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (used to locate project root).")
    ap.add_argument("--team-dir", type=Path, default=Path("team"), help="Team output directory (default: team).")
    ap.add_argument("--latest-kind", choices=("team", "draft"), default="team", help="Which pointer to update (team or draft).")
    ap.add_argument("--tag", default="", help="Latest tag to record (optional).")
    ap.add_argument("--status", default="", help="Status/stage to record (optional).")
    ap.add_argument("--run-dir", type=Path, default=None, help="Explicit run dir for the tag (optional).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    project_root = _find_project_root(args.notes)
    canonical_run_root(project_root)
    if not (project_root / "project_index.md").is_file():
        print("ERROR: project_index.md is missing; run nullius init first.")
        return 2
    team_dir = args.team_dir if args.team_dir.is_absolute() else (project_root / args.team_dir)
    artifacts_dir = project_root / "artifacts"
    try:
        _assert_navigation_paths(project_root, team_dir, artifacts_dir)
    except ValueError as error:
        print(f"ERROR: {error}")
        return 2
    team_dir.mkdir(parents=True, exist_ok=True)
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    state = {"team_tag": "", "team_status": "", "draft_tag": "", "draft_status": ""}
    existing_team_tag, existing_team_status, existing_team_active = _read_existing_team_state(team_dir)
    if existing_team_active:
        if not _active_pointer_value(state.get("team_tag", "")):
            state["team_tag"] = existing_team_tag
        if not _active_pointer_value(state.get("team_status", "")):
            state["team_status"] = existing_team_status
    existing_draft_tag, existing_draft_status, existing_draft_active = _read_existing_draft_state(team_dir)
    if existing_draft_active:
        if not _active_pointer_value(state.get("draft_tag", "")):
            state["draft_tag"] = existing_draft_tag
        if not _active_pointer_value(state.get("draft_status", "")):
            state["draft_status"] = existing_draft_status

    kind = args.latest_kind
    tag, status = _infer_latest_tag_and_status(project_root, team_dir, args.tag, args.status, kind)
    if kind == "team":
        if tag and status:
            state["team_tag"] = tag
            state["team_status"] = status
        elif not existing_team_active:
            state["team_tag"] = ""
            state["team_status"] = ""
    else:
        if tag and status:
            state["draft_tag"] = tag
            state["draft_status"] = status
        elif not existing_draft_active:
            state["draft_tag"] = ""
            state["draft_status"] = ""

    team_run_dir = None
    if kind == "team" and _active_pointer_value(state.get("team_tag", "")) and _active_pointer_value(state.get("team_status", "")):
        team_run_dir = args.run_dir
        if team_run_dir is not None and not team_run_dir.is_dir():
            team_run_dir = None
        if team_run_dir is None:
            team_run_dir = _detect_team_run_dir(team_dir, state["team_tag"])
    team_pointer_active = (
        _active_pointer_value(state.get("team_tag", ""))
        and _active_pointer_value(state.get("team_status", ""))
        and team_run_dir is not None
    )

    draft_run_dir = None
    if kind == "draft" and _active_pointer_value(state.get("draft_tag", "")) and _active_pointer_value(state.get("draft_status", "")):
        draft_run_dir = args.run_dir
        if draft_run_dir is not None and not draft_run_dir.is_dir():
            draft_run_dir = None
        if draft_run_dir is None:
            draft_run_dir = _detect_team_run_dir(team_dir, state["draft_tag"])
    draft_pointer_active = (
        _active_pointer_value(state.get("draft_tag", ""))
        and _active_pointer_value(state.get("draft_status", ""))
        and draft_run_dir is not None
    )

    if kind == "team":
        if team_pointer_active:
            _write_latest_team_cycle(team_dir, state["team_tag"], state["team_status"], team_run_dir)
        else:
            _remove_default_team_pointer(team_dir)
    else:
        if draft_pointer_active:
            _write_latest_draft_cycle(team_dir, state["draft_tag"], state["draft_status"], draft_run_dir)
        else:
            _remove_inactive_draft_pointer(team_dir)

    # Artifacts pointer: prefer a live TEAM tag, otherwise a live DRAFT tag.
    artifacts_tag = state["team_tag"] if team_pointer_active else state["draft_tag"] if draft_pointer_active else ""
    artifacts_run = _detect_latest_artifacts_dir(project_root, artifacts_tag)
    artifacts_updated = False
    if artifacts_run is not None:
        _write_artifacts_latest(artifacts_dir, artifacts_tag, artifacts_run)
        artifacts_updated = True
    else:
        _remove_default_artifacts_pointer(artifacts_dir)

    include_draft = _has_active_draft_state(team_dir, state)
    include_artifacts = artifacts_updated or _has_live_artifacts_pointer(artifacts_dir)

    _write_team_latest_index(team_dir, include_team=team_pointer_active, include_draft=include_draft)

    print(f"[ok] updated: {team_dir / 'LATEST.md'}")
    if kind == "team" and team_pointer_active:
        print(f"[ok] updated: {team_dir / 'LATEST_TEAM.md'}")
    elif kind == "team":
        print(f"[ok] skipped: {team_dir / 'LATEST_TEAM.md'} (no team tag/status)")
    elif include_draft:
        print(f"[ok] updated: {team_dir / 'LATEST_DRAFT.md'}")
    else:
        print(f"[ok] skipped: {team_dir / 'LATEST_DRAFT.md'} (no draft tag/status)")
    if include_artifacts:
        print(f"[ok] updated: {artifacts_dir / 'LATEST.md'}")
    else:
        print(f"[ok] skipped: {artifacts_dir / 'LATEST.md'} (no artifact run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
