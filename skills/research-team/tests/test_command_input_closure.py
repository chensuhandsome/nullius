"""Offline command-source/data closure checks; no semantic/model approval."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

LIB = Path(__file__).resolve().parents[1] / 'scripts/lib'
sys.path.insert(0, str(LIB))
from source_inputs import local_source_closure


def write(root, name, text):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def frozen(closure):
    return {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in closure}


def assert_fresh(snapshot):
    if any(hashlib.sha256(p.read_bytes()).hexdigest() != digest for p, digest in snapshot.items()):
        raise ValueError('stale actual command input')


@pytest.mark.parametrize('changed', ['support/helper.py', 'inputs/value.txt'])
def test_actual_python_process_freezes_helper_and_runtime_data_before_execution(tmp_path, changed):
    write(tmp_path, 'support/__init__.py', 'from .helper import transform\n')
    write(tmp_path, 'support/helper.py', 'def transform(value): return value + 1\n')
    write(tmp_path, 'inputs/value.txt', '6\n')
    source = write(tmp_path, 'main.py', 'import support\nfrom pathlib import Path\nprint(support.transform(int(Path("inputs/value.txt").read_text())))\n')
    closure = local_source_closure([source], tmp_path)
    snapshot = frozen(closure)
    assert set(p.relative_to(tmp_path).as_posix() for p in closure) == {'main.py', 'support/__init__.py', 'support/helper.py', 'inputs/value.txt'}
    actual = subprocess.run([sys.executable, str(source)], cwd=tmp_path, capture_output=True, text=True)
    assert actual.returncode == 0 and actual.stdout.strip() == '7'
    assert_fresh(snapshot)
    target = tmp_path / changed
    target.write_text(target.read_text() + ('# changed after execution\n' if target.suffix == '.py' else '9\n'))
    with pytest.raises(ValueError, match='stale actual command input'):
        assert_fresh(snapshot)


def test_actual_shell_literal_source_and_data_are_bound(tmp_path):
    write(tmp_path, 'helper.sh', 'label=original\n')
    write(tmp_path, 'input.txt', 'original data\n')
    source = write(tmp_path, 'main.sh', 'source "helper.sh"\ncat "input.txt"\n')
    closure = local_source_closure([source], tmp_path)
    snapshot = frozen(closure)
    actual = subprocess.run(['bash', str(source)], cwd=tmp_path, capture_output=True, text=True)
    assert actual.returncode == 0 and actual.stdout == 'original data\n'
    assert {p.name for p in closure} == {'main.sh', 'helper.sh', 'input.txt'}
    (tmp_path / 'helper.sh').write_text('label=changed\n')
    with pytest.raises(ValueError, match='stale actual command input'):
        assert_fresh(snapshot)


@pytest.mark.parametrize('name,source,dependency', [
    ('main.jl', 'include("helper.jl")\n', 'helper.jl'),
    ('main.R', 'source("helper.R")\n', 'helper.R'),
    ('main.wl', 'Get["helper.wl"];\n', 'helper.wl'),
])
def test_literal_non_python_closure_protocol_only(tmp_path, name, source, dependency):
    # These languages are parsed as offline protocol witnesses. No Julia/R/
    # Mathematica execution or scientific confirmation is claimed here.
    primary = write(tmp_path, name, source)
    support = write(tmp_path, dependency, '# literal dependency\n' if not dependency.endswith('.wl') else 'value = 1;\n')
    assert set(local_source_closure([primary], tmp_path)) == {primary, support}


@pytest.mark.parametrize('name,source', [
    ('main.py', 'import importlib\nimportlib.import_module(variable)\n'),
    ('main.py', 'from pathlib import Path\nPath(variable).read_text()\n'),
    ('main.py', 'open(variable).read()\n'),
    ('main.py', 'exec(open("helper.py").read())\n'),
    ('main.py', 'from builtins import open as reader\nreader(variable)\n'),
    ('main.py', 'from importlib import import_module as loader\nloader(variable)\n'),
    ('main.py', 'from pathlib import Path\ngetattr(Path("file"), "read_text")()\n'),
    ('main.py', 'import subprocess\nsubprocess.run(["python3", "helper.py"])\n'),
    ('main.py', 'from pathlib import Path\nlist(Path(".").glob("*.dat"))\n'),
    ('main.py', 'import sys\nsys.path.insert(0, variable)\n'),
    ('main.jl', 'include(variable)\n'),
    ('main.jl', 'read(variable, String)\n'),
    ('main.sh', 'source "$VARIABLE"\n'),
    ('main.sh', 'cat "$VARIABLE"\n'),
    ('main.R', 'source(variable)\n'),
    ('main.wl', 'Get[variable];\n'),
])
def test_unresolved_dynamic_source_or_read_is_unavailable(tmp_path, name, source):
    primary = write(tmp_path, name, source)
    with pytest.raises(ValueError, match='unavailable'):
        local_source_closure([primary], tmp_path)


@pytest.mark.parametrize('name,source', [('main.py', 'open("missing.dat").read()\n'), ('main.jl', 'include("missing.jl")\n'), ('main.sh', 'source missing.sh\n'), ('main.R', 'source("missing.R")\n'), ('main.wl', 'Get["missing.wl"];\n')])
def test_missing_literal_dependency_is_unavailable(tmp_path, name, source):
    primary = write(tmp_path, name, source)
    with pytest.raises(ValueError, match='unavailable local command input'):
        local_source_closure([primary], tmp_path)


def test_reads_resolve_against_command_cwd_and_explicit_raw_inputs_are_seeds(tmp_path):
    primary = write(tmp_path, 'code/main.py', 'from pathlib import Path\nprint(Path("value.dat").read_text())\n')
    data = write(tmp_path, 'work/value.dat', 'original\n')
    extra = write(tmp_path, 'work/declared.dat', 'declared raw input\n')
    closure = local_source_closure([primary, extra], tmp_path, cwd=tmp_path / 'work')
    assert set(closure) == {primary, data, extra}


def test_literal_alias_and_path_open_bind_inputs_but_write_paths_are_outputs(tmp_path):
    data = write(tmp_path, 'input.txt', 'original\n')
    source = write(tmp_path, 'main.py', 'from pathlib import Path as P\nfrom builtins import open as reader\nprint(reader(file="input.txt").read())\nprint(P("input.txt").open().read())\nP("new-output.txt").open("w").write("output")\n')
    assert set(local_source_closure([source], tmp_path)) == {source, data}


def test_literal_project_import_search_path_is_bound(tmp_path):
    helper = write(tmp_path, 'src/helper.py', 'value=7\n')
    source = write(tmp_path, 'main.py', 'import sys\nsys.path.insert(0, "src")\nimport helper\nprint(helper.value)\n')
    assert set(local_source_closure([source], tmp_path)) == {source, helper}


def test_unsupported_source_language_is_unavailable(tmp_path):
    source = write(tmp_path, 'main.js', 'const data = require("fs").readFileSync(variable);\n')
    with pytest.raises(ValueError, match='source language dependency closure is not supported'):
        local_source_closure([source], tmp_path)


@pytest.mark.parametrize('changed', ['support/helper.py', 'input.dat'])
def test_member_packet_rejects_current_helper_or_data_after_real_offline_proxy(tmp_path, changed):
    from test_independent_reproduction_gate import _make_project, _seed_member, TAG
    from test_original_member_transport import rerun
    from check_independent_reproduction import assessment_packet, _collect_member_sources
    from member_evidence import validate_original_transport
    project = _make_project(tmp_path)
    a, b = _seed_member(project, 'member_a', construction=False), _seed_member(project, 'member_b')
    write(project, 'support/__init__.py', 'from .helper import transform\n')
    write(project, 'support/helper.py', 'def transform(value): return value + 1\n')
    write(project, 'input.dat', '6\n')
    request_file = project / 'member_a_fixture/requests.json'
    request = json.loads(request_file.read_text())
    source = {'path': f'artifacts/runs/{TAG}/research_team/member_a/independent/constructed_input.py',
              'purpose': 'Complete original source with literal data and helper inputs'}
    request['files_written'] = [source]
    result = f'artifacts/runs/{TAG}/research_team/member_a/independent/result.json'
    source['content'] = 'import sys,json\nsys.path.insert(0, ".")\nimport support\nfrom pathlib import Path\nvalue=support.transform(int(Path("input.dat").read_text()))\nprint(value)\nPath('+repr(result)+').write_text(json.dumps({"value":value})+"\\n")\n'
    request['commands_run'] = [{'command': 'python3 '+source['path'], 'cwd': '.',
                               'input_files': ['input.dat'], 'expected_outputs': [result]}]
    request_file.write_text(json.dumps(request))
    actual = rerun(project, 'member_a')
    assert actual.returncode == 0, actual.stderr
    evidence = json.loads(a.read_text())
    paths = {item['path'] for item in evidence['commands_run'][0]['input_files']}
    assert {'support/__init__.py', 'support/helper.py', 'input.dat'} <= paths
    sources = {m: _collect_member_sources(m, project / f'artifacts/runs/{TAG}/research_team/{m}/independent') for m in ('member_a', 'member_b')}
    packet = assessment_packet(sources, {'member_a': a, 'member_b': b}, project)
    assert packet['sources']['input.dat'] == hashlib.sha256((project / 'input.dat').read_bytes()).hexdigest()
    target = project / changed
    target.write_text(target.read_text() + ('# changed after execution\n' if target.suffix == '.py' else '9\n'))
    with pytest.raises(ValueError, match='stale|changed|mismatch'):
        validate_original_transport(evidence, project)
    with pytest.raises(ValueError, match='stale|changed|mismatch'):
        assessment_packet(sources, {'member_a': a, 'member_b': b}, project)
