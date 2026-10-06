from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[1]
sys.path.insert(0, str(SKILL / 'scripts' / 'lib'))
from review_paths import is_forbidden_review_path
from workspace_isolator import create_isolated_workspace


def test_case_variant_namespaces_do_not_expose_payload(tmp_path):
    payload = tmp_path / 'ARTIFACTS/RUNS/T0/RESEARCH_TEAM/member_b'
    payload.mkdir(parents=True)
    (payload / 'report.md').write_text('prior answer')
    (payload.parent.parent / 'production.json').write_text('original data')
    workspace = create_isolated_workspace(tmp_path / 'scratch', 'member_a', 'case', tmp_path, 'T1')
    assert not list(workspace.rglob('report.md'))
    assert list(workspace.rglob('production.json'))
    assert is_forbidden_review_path('member_a', 'T1', 'ARTIFACTS/RUNS/T0/RESEARCH_TEAM/member_b/report.md')
    assert is_forbidden_review_path('member_a', 'T1', 'ARTIFACTS/RUNS/T1/RESEARCH_TEAM/member_a/report.md')
    assert not is_forbidden_review_path('member_a', 'T1', 'artifacts/runs/T1/research_team/member_a/report.md')


def test_automatic_git_list_excludes_history_paths_but_retains_production(tmp_path):
    spec = importlib.util.spec_from_file_location('packet_listing', SKILL / 'scripts/bin/build_team_packet.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    history = tmp_path / 'artifacts/runs/T0/research_team/member_b/report.md'
    history.parent.mkdir(parents=True)
    history.write_text('original answer')
    production = tmp_path / 'source.py'
    production.write_text('x = 1\n')
    subprocess.run(['git', 'init', '-q'], cwd=tmp_path, check=True)
    subprocess.run(['git', 'add', '.'], cwd=tmp_path, check=True)
    subprocess.run(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], cwd=tmp_path, check=True)
    history.write_text('updated answer')
    production.write_text('x = 2\n')
    assert module._git_changed_files(tmp_path) == ['source.py']
    assert history.read_text() == 'updated answer'


def load_planner():
    spec = importlib.util.spec_from_file_location('relocation_inventory', SKILL / 'scripts/bin/inventory_run_relocation.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('suffix', ['member_b/report.md', 'logs/run.log', 'T1_adjudication.md', 'workspaces/a/result.txt'])
@pytest.mark.parametrize('tag', ['T0', 'T1', 'T2'])
def test_every_round_payload_is_denied_except_own_prefix(tag, suffix):
    assert is_forbidden_review_path('member_a', 'T1', f'artifacts/runs/{tag}/research_team/{suffix}')
    assert not is_forbidden_review_path('member_a', 'T1', 'artifacts/runs/T1/research_team/member_a/report.md')
    assert is_forbidden_review_path('member_a', 'T1', 'team/runs/T1/member_a/report.md')
    assert not is_forbidden_review_path('member_a', 'T1', 'artifacts/runs/T0/summary.json')


def test_snapshot_retains_production_and_omits_all_executor_rounds(tmp_path):
    for tag in ['T0', 'T1', 'T2']:
        run = tmp_path / 'artifacts/runs' / tag
        payload = run / 'research_team'
        payload.mkdir(parents=True)
        (run / 'summary.json').write_text('{"measurement": 1}')
        (payload / 'verdict.md').write_text('previous answer')
    (tmp_path / 'source.py').write_text('x = 1\n')
    own = tmp_path / 'artifacts/runs/T1/research_team'
    workspace = create_isolated_workspace(own, 'member_a', 'test', tmp_path, 'T1')
    assert (workspace / 'source.py').is_file()
    for tag in ['T0', 'T1', 'T2']:
        assert (workspace / 'artifacts/runs' / tag / 'summary.json').is_file()
        assert not (workspace / 'artifacts/runs' / tag / 'research_team').exists()
    assert not list(workspace.rglob('verdict.md'))


@pytest.mark.parametrize('output', ['team', 'custom'])
def test_policy_rejects_noncanonical_output_without_creating_paths(tmp_path, output):
    (tmp_path / 'research_contract.md').write_text('# contract\n')
    before = {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    result = subprocess.run([sys.executable, '-m', 'project_contracts.project_policy_cli', 'assert-run-paths', '--project-root', str(tmp_path), '--notes', str(tmp_path / 'research_contract.md'), '--out-dir', str(tmp_path / output), '--run-id', 'T1'], cwd=tmp_path, env={**os.environ, 'PYTHONPATH': str(REPO / 'packages/project-contracts/src')}, capture_output=True, text=True)
    assert result.returncode == 1
    assert 'canonical project artifacts' in result.stderr
    assert before == {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    assert not (tmp_path / output).exists()


def test_inventory_detects_collisions_paths_and_hashes_without_mutation(tmp_path):
    planner = load_planner()
    old = tmp_path / 'team/runs/T1'
    target = tmp_path / 'artifacts/runs/T1'
    old.mkdir(parents=True)
    (target / 'research_team').mkdir(parents=True)
    (old / 'run_origin.json').write_text('{"commit": "old"}')
    (target / 'run_origin.json').write_text('{"commit": "different"}')
    (old / 'cycle_state.json').write_text('{"packet_path": "team/runs/T1/packet.txt", "input_sha256": "' + 'a' * 64 + '"}')
    (tmp_path / 'project_index.md').write_text('<!-- PROJECT_INDEX_AUTO -->\n' + str(old) + '\n' + 'b' * 64 + '\n')
    (tmp_path / 'team/LATEST.md').write_text('runs/T1\n')
    pinned = planner._files(tmp_path)
    inventory = planner.inventory(tmp_path, pinned)
    assert inventory['bytes_unchanged'] and not inventory['apply_supported']
    assert planner._files(tmp_path) == pinned
    assert {c['kind'] for c in inventory['collisions']} == {'payload_target_exists', 'origin_records_share_target'}
    assert not next(c for c in inventory['collisions'] if c['kind'] == 'origin_records_share_target')['identical_bytes']
    assert {'absolute', 'project_relative', 'executor_relative', 'unmaintained_PROJECT_INDEX_AUTO'} <= {r['kind'] for r in inventory['references']}
    assert inventory['cycle_state_paths'] and inventory['registry_hash_bindings']
    assert any(f.get('kind') == 'unresolved_frozen_binding' for f in inventory['unresolved_frozen_dependencies'])
    (old / 'cycle_state.json').write_text('changed')
    with pytest.raises(ValueError, match='complete source manifest'):
        planner.inventory(tmp_path, pinned)


def test_missing_root_index_refuses_without_thin_scaffold_or_output_writes(tmp_path):
    (tmp_path / 'project_charter.md').write_text('# charter\n')
    (tmp_path / 'research_contract.md').write_text('# contract\n')
    before = {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    result = subprocess.run([sys.executable, str(SKILL / 'scripts/bin/update_project_map.py'), '--notes', str(tmp_path / 'research_contract.md')], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 2
    assert 'nullius init' in result.stdout
    assert before == {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    assert not (tmp_path / 'project_index.md').exists()
    assert not (tmp_path / 'team').exists()
