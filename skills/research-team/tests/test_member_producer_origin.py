"""Actual subprocess episode authority protocol, without scientific approval."""
import hashlib,json,sys,shutil
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts/lib"))
import pytest
from test_independent_reproduction_gate import _make_project,_seed_member,_run_gate,TAG
from member_evidence import validate_original_transport

def rehash(value, root):
    if isinstance(value,dict):
        if isinstance(value.get('path'),str):
            path=root/value['path']
            if path.is_file():
                value['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
                if 'size_bytes' in value:value['size_bytes']=len(path.read_bytes())
        for item in value.values():rehash(item,root)
    elif isinstance(value,list):
        for item in value:rehash(item,root)

def test_actual_two_stage_proxy_episode_is_authenticated(tmp_path):
    root=_make_project(tmp_path);path=_seed_member(root,'member_a');e=json.loads(path.read_text())
    original=validate_original_transport(e,root)
    observation=json.loads((root/e['original_transport']['runtime_observation']['path']).read_text())
    assert set(observation['payload']['models'])=={'requests','final'}
    assert all(v['exit_code']==0 and v['process_id']>0 for v in observation['payload']['models'].values())
    assert any(x.get('operation','').startswith('source_write[') for x in observation['payload']['operations'])
    assert original['material']['source_write[0]']
    assert original['report_path'] in original['report_paths']
    published = f'artifacts/runs/{TAG}/research_team/member_a/member_report.md'
    assert published in original['report_paths']

@pytest.mark.parametrize('surface',['packet','requests.prompt','requests.output','final.prompt','final.output','proxy_input','source','command'])
def test_complete_project_graph_rehash_cannot_mint_an_episode(tmp_path,surface):
    root=_make_project(tmp_path);path=_seed_member(root,'member_a');e=json.loads(path.read_text());r=e['original_transport']
    if surface=='command':e['commands_run'][0]['command']+=' unobserved'
    else:
        if surface=='source':ref=r['construction_refs'][0]['raw_input_ref']
        elif '.' in surface:
            stage,key=surface.split('.');ref=r['stages'][stage][key]
        else:ref=r[surface]
        p=root/ref['path'];p.write_bytes(p.read_bytes()+b'\nproject-only mutation\n')
    rehash(e,root)
    for stage in r['stages'].values():
        stage['input_sha256'].update({k:stage[k]['sha256'] for k in ('system','prompt')})
    path.write_text(json.dumps(e))
    with pytest.raises((ValueError,OSError)):
        validate_original_transport(e,root)

def test_project_forged_signed_payload_rejects_after_rehash(tmp_path):
    root=_make_project(tmp_path);path=_seed_member(root,'member_a');e=json.loads(path.read_text());r=e['original_transport'];p=root/r['runtime_observation']['path']
    obs=json.loads(p.read_text());obs['payload']['models']['requests']['argv']=['fabricated'];p.write_text(json.dumps(obs));rehash(e,root)
    with pytest.raises(ValueError,match='forged runtime member episode'):
        validate_original_transport(e,root)

def test_unsigned_history_cannot_grant_new_confirmation(tmp_path):
    root=_make_project(tmp_path);path=_seed_member(root,'member_a');e=json.loads(path.read_text());e['original_transport'].pop('runtime_observation')
    with pytest.raises(ValueError,match='absent runtime member episode'):
        validate_original_transport(e,root)


@pytest.mark.parametrize('layout',['canonical','read_only_history'])
def test_successful_isolated_workspace_cleanup_retains_complete_originals_and_fresh_gate(tmp_path,layout):
    root=_make_project(tmp_path)
    run_dir=root/'artifacts/runs'/TAG/'research_team' if layout=='canonical' else root/'team/runs'/TAG
    workspaces=run_dir/'workspaces'
    paths=[_seed_member(root, member, workspace_root=workspaces/member,run_dir=run_dir) for member in ('member_a','member_b')]
    episodes=[]
    for path in paths:
        e=json.loads(path.read_text())
        obs=json.loads((root/e['original_transport']['runtime_observation']['path']).read_text())
        assert set(obs['payload']['original_snapshots'])==set(obs['payload']['files'])
        assert any(Path(original).is_relative_to(workspaces) for original in obs['payload']['files'])
        episodes.append((e,obs))
    shutil.rmtree(workspaces)
    for e,obs in episodes:
        assert validate_original_transport(e,root)['report_path']
    proc,payload=_run_gate(root,*paths)
    assert proc.returncode==0,proc.stderr
    assert payload['status']=='converged' and payload['meta']['independent_confirmations']==2
    # No temporary source is needed, but a changed frozen original remains fatal.
    e,obs=episodes[0]
    snapshot=root/next(iter(obs['payload']['original_snapshots'].values()))['path']
    snapshot.write_bytes(snapshot.read_bytes()+b'changed after cleanup')
    with pytest.raises(ValueError,match='original material'):
        validate_original_transport(e,root)
