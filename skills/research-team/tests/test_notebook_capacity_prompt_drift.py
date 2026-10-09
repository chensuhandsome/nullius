"""Keep actual scaffolded agent inputs consistent with notebook capacity truth."""
from pathlib import Path


ASSETS = Path(__file__).resolve().parents[1] / "assets"


def test_active_system_inputs_do_not_restore_retired_text_or_snapshot_limits():
    for path in ASSETS.glob("system*.txt"):
        text = path.read_text(encoding="utf-8")
        for obsolete in ("binary or oversized files", "limited to 1 MiB", "storage to 64 MiB"):
            assert obsolete not in text, path.name


def test_notebook_agent_inputs_preserve_original_joint_scope_and_budget_controls():
    for name in ("system_member_a.txt", "system_member_b.txt", "system_leader_main.txt", "system_leader_verifier.txt"):
        text = (ASSETS / name).read_text(encoding="utf-8")
        assert "512 MiB" in text and "256 files" in text, name
        assert "--snapshot-bytes" in text and "--max-files" in text, name
        assert "complete original text closure" in text, name
        assert "never rewrites old evidence" in text, name
        assert "Multiple batches are one semantic review" in text, name
