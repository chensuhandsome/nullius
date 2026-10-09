"""Actual proxy construction and source-origin protocol; no semantic science approval."""
import hashlib
import json
from pathlib import Path

import pytest

from test_independent_reproduction_gate import _make_project, _seed_member, _run_gate, _member_dir, TAG
from test_original_member_transport import rerun
from member_evidence import validate_original_transport, original_source_origin


def pair(tmp_path):
    project = _make_project(tmp_path)
    return project, _seed_member(project, 'member_a'), _seed_member(project, 'member_b')


def test_actual_proxy_writes_complete_utf8_bytes_and_typed_construction_refs(tmp_path):
    project = _make_project(tmp_path)
    body = '# Complete original Unicode and CRLF body\r\nlabel = "λ"\r\n' + '# untouched evidence\r\n' * 300
    evidence = _seed_member(project, 'member_a', {'original.py': body})
    source = _member_dir(project, 'member_a') / 'original.py'
    assert source.read_bytes() == body.encode('utf-8')
    ev = json.loads(evidence.read_text())
    record = ev['original_transport']['construction_refs'][0]
    assert record['created'] is True
    assert record['sha256'] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert record['size_bytes'] == len(source.read_bytes())
    original = validate_original_transport(ev, project)
    assert original_source_origin(source, original, project, 'member_a')['origin_stage'] == 'requests'
    assert original['material']['source_write[0]'] == body


@pytest.mark.parametrize('key,value', [('sha256','arbitrary'), ('size_bytes','150'), ('created','true'), ('origin_stage','final')])
def test_authored_or_stale_construction_refs_never_bypass_original_bytes(tmp_path, key, value):
    project, a, b = pair(tmp_path)
    ev = json.loads(a.read_text()); ev['original_transport']['construction_refs'][0][key] = value
    a.write_text(json.dumps(ev))
    with pytest.raises(ValueError, match='source construction differs'):
        validate_original_transport(ev, project)
    process, payload = _run_gate(project, a, b)
    assert process.returncode == 1 and payload['meta']['independent_confirmations'] == 0


@pytest.mark.parametrize('path', ['outside.py', 'artifacts/runs/other/research_team/member_a/independent/outside.py', f'artifacts/runs/{TAG}/research_team/member_b/independent/outside.py'])
def test_proxy_rejects_source_writes_outside_own_independent_scope(tmp_path, path):
    project, a, b = pair(tmp_path)
    request_path = project / 'member_a_fixture/requests.json'
    request = json.loads(request_path.read_text())
    request['files_written'].append({'path':path, 'content':'print("unpermitted")\n', 'purpose':'Protocol rejection specimen'})
    request_path.write_text(json.dumps(request))
    assert rerun(project, 'member_a').returncode == 2
    assert not (project / path).exists()
    with pytest.raises(ValueError, match='pending|missing/denied original source write'):
        validate_original_transport(json.loads(a.read_text()), project)
    process, payload = _run_gate(project, a, b)
    assert process.returncode == 1 and payload['meta']['independent_confirmations'] == 0


def test_arbitrary_preseed_source_cannot_be_approved_by_true_examiner_flags(tmp_path):
    project, a, b = pair(tmp_path)
    source = _member_dir(project, 'member_a') / 'unobserved_preseed.py'
    source.write_text('def unobserved_construction():\n    return "coordinator supplied"\n')
    process, payload = _run_gate(project, a, b)
    assert process.returncode == 1 and payload['meta']['independent_confirmations'] == 0
    assert 'UNVERIFIABLE_SOURCE_ORIGIN' in ' '.join(payload['reasons'])


def test_model_output_substring_does_not_establish_whole_source_origin(tmp_path):
    project, a, b = pair(tmp_path)
    source = _member_dir(project, 'member_a') / 'unbound_extra.py'
    source.write_text('for value in data["values"]: answer += value\n')
    process, payload = _run_gate(project, a, b)
    assert process.returncode == 1 and payload['meta']['independent_confirmations'] == 0
    assert 'UNVERIFIABLE_SOURCE_ORIGIN' in ' '.join(payload['reasons'])


def test_idempotent_same_bytes_are_recorded_and_differing_original_is_preserved(tmp_path):
    project, a, b = pair(tmp_path)
    assert rerun(project, 'member_a').returncode == 0
    ev = json.loads(a.read_text())
    assert ev['original_transport']['construction_refs'][0]['created'] is False
    validate_original_transport(ev, project)
    source = _member_dir(project, 'member_a') / 'constructed_sum.py'
    changed = source.read_bytes() + b'# coordinator changed source\n'
    source.write_bytes(changed)
    assert rerun(project, 'member_a').returncode == 2
    assert source.read_bytes() == changed
    with pytest.raises(ValueError, match='pending|missing/denied original source write'):
        validate_original_transport(json.loads(a.read_text()), project)


def test_complete_recursive_json_and_final_fence_origin_require_exact_bytes(tmp_path):
    project = _make_project(tmp_path)
    source = _member_dir(project, 'member_a') / 'original.py';source.parent.mkdir(parents=True)
    body = 'def own_function():\n    return 1\n'; source.write_bytes(body.encode())
    original = {'material': {'requests.output': json.dumps({'nested': [{'scientific_source_utf8':body}]}), 'final.output':'Original final report'}}
    assert original_source_origin(source, original, project, 'member_a')['origin_stage'] == 'requests'
    original['material']['requests.output'] = '{}'
    original['material']['final.output'] = 'Original complete code:\n```python\n'+body+'```\n'
    assert original_source_origin(source, original, project, 'member_a')['origin_stage'] == 'final'
    source.write_bytes(body.encode()+b'# unobserved addition\n')
    with pytest.raises(ValueError, match='UNVERIFIABLE_SOURCE_ORIGIN'):
        original_source_origin(source, original, project, 'member_a')
