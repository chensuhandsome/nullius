"""Bounded source-discovery refusals; no model or scientific approval."""
import sys
import subprocess
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/lib'))
from source_inputs import local_source_closure


def test_aliased_sys_path_import_binds_actual_local_helper(tmp_path):
    source = tmp_path / 'main.py'; helper = tmp_path / 'src/helper.py'
    helper.parent.mkdir(); helper.write_text('value = 3\n')
    source.write_text("import sys as s\ns.path.insert(0, 'src')\nimport helper\nprint(helper.value)\n")
    assert set(local_source_closure([source], tmp_path)) == {source, helper}


def test_numeric_container_mutation_is_not_import_search_path_mutation(tmp_path):
    data=tmp_path/'raw.json';data.write_text('[17,25]')
    source=tmp_path/'main.py'
    source.write_text('import json\nfrom pathlib import Path\nraw=json.loads(Path("raw.json").read_text())\nvalues=[0]\nvalues[0]=raw[0]\nfor value in raw[1:]:\n    values.append(value)\nvalues.insert(0, 0)\nprint(sum(values))\n')
    actual=subprocess.run([sys.executable,str(source)],cwd=tmp_path,text=True,capture_output=True,timeout=5)
    assert actual.returncode==0 and actual.stdout.strip()=='42'
    assert set(local_source_closure([source],tmp_path))=={source,data}


def test_rebound_actual_sys_path_receiver_remains_unavailable(tmp_path):
    source=tmp_path/'main.py'
    source.write_text('import sys\nsys.path=[]\nsys.path.append("src")\n')
    with pytest.raises(ValueError,match='import.search'):
        local_source_closure([source],tmp_path)


@pytest.mark.parametrize('setup',[
    "search=sys.path\nsearch.insert(0,'plugins')",
    "search=sys.path\nalias=search\nalias.insert(0,'plugins')",
    "from sys import path as search\nsearch.insert(0,'plugins')",
    "sys.path[:]=['plugins']",
])
def test_actual_aliased_or_mutated_import_search_never_omits_loaded_source(tmp_path,setup):
    helper=tmp_path/'plugins/helper.py';helper.parent.mkdir();helper.write_text('value=37\n')
    source=tmp_path/'main.py';source.write_text('import sys\n'+setup+'\nimport helper\nprint(helper.value)\n')
    actual=subprocess.run([sys.executable,str(source)],cwd=tmp_path,text=True,capture_output=True,timeout=5)
    assert actual.returncode==0 and actual.stdout.strip()=='37'
    with pytest.raises(ValueError,match='unavailable.*import search'):
        local_source_closure([source],tmp_path)


@pytest.mark.parametrize('body', ["loader=__import__\nloader(input())\n", "reader=open\nreader(input()).read()\n", "evaluate=eval\nevaluate(input())\n"])
def test_aliasing_does_not_hide_an_unresolved_loader_or_read(tmp_path, body):
    source=tmp_path/'main.py';source.write_text(body)
    with pytest.raises(ValueError, match='unavailable'):
        local_source_closure([source],tmp_path)


def test_literal_local_package_binds_source_and_project_metadata(tmp_path):
    main=tmp_path/'main.jl'; main.write_text('using Helper\n')
    helper=tmp_path/'src/Helper.jl';helper.parent.mkdir();helper.write_text('module Helper\nconst value = 3\nend\n')
    project=tmp_path/'Project.toml';project.write_text('name = "Helper"\n')
    assert set(local_source_closure([main],tmp_path)) == {main,helper,project}
    helper.unlink()
    with pytest.raises(ValueError,match='local package entry'):
        local_source_closure([main],tmp_path)


@pytest.mark.parametrize('extension,body', [('.jl','include_string(Main, input)\n'),('.jl','Pkg.activate(destination)\n'),('.sh','python3 hidden.py\n'),('.sh','eval "$payload"\n'),('.R','eval(parse(text=payload))\n'),('.wl','ToExpression[payload]\n')])
def test_unobserved_nested_or_dynamic_source_execution_is_unavailable(tmp_path,extension,body):
    main=tmp_path/('main'+extension);main.write_text(body)
    with pytest.raises(ValueError,match='unavailable'):
        local_source_closure([main],tmp_path)


@pytest.mark.parametrize('body', [
    "data='safe.txt'\ndef consume(data):\n    return Path(data).read_text()\nprint(consume('other.txt'))\n",
    "data='safe.txt'\nprint([Path(data).read_text() for data in ['other.txt']])\n",
    "data='safe.txt'\nfor data in ['other.txt']:\n    print(Path(data).read_text())\n",
    "data='safe.txt'\nprint(Path(data:='other.txt').read_text())\n",
])
def test_actual_shadowed_read_does_not_freeze_an_unread_global_file(tmp_path,body):
    (tmp_path/'safe.txt').write_text('unread global')
    (tmp_path/'other.txt').write_text('actual local input')
    main=tmp_path/'main.py';main.write_text('from pathlib import Path\n'+body)
    executed=subprocess.run([sys.executable,str(main)],cwd=tmp_path,text=True,capture_output=True,check=False)
    assert executed.returncode == 0 and 'actual local input' in executed.stdout
    with pytest.raises(ValueError,match='unavailable'):
        local_source_closure([main],tmp_path)


@pytest.mark.parametrize('body', [
    "data='safe.txt'\ndata, = ['other.txt']\nprint(Path(data).read_text())\n",
    "data='safe.txt'\n[data] = ['other.txt']\nprint(Path(data).read_text())\n",
    "data='safe.txt'\n((data,),) = (('other.txt',),)\nprint(Path(data).read_text())\n",
    "data='safe.txt'\n*unused, data = ['discarded', 'other.txt']\nprint(Path(data).read_text())\n",
    "data='safe.txt'\ndata *= 0\ndata += 'other.txt'\nprint(Path(data).read_text())\n",
    "data='safe.txt'\nfrom selector import data\nprint(Path(data).read_text())\n",
    "data='safe.txt'\ndata='other.txt'\nprint(Path(data).read_text())\n",
    "data='safe.txt'\nmatch 'other.txt':\n    case data: pass\nprint(Path(data).read_text())\n",
    "data='safe.txt'\nmatch {'path':'other.txt'}:\n    case {'path':data}: pass\nprint(Path(data).read_text())\n",
    "data='safe.txt'\nmatch ['discarded','other.txt']:\n    case [*unused, data]: pass\nprint(Path(data).read_text())\n",
    "data='safe.txt'\ndel data\ndata='other.txt'\nprint(Path(data).read_text())\n",
    "data='safe.txt'\ndef consume():\n    global data\n    data, = ['other.txt']\nconsume()\nprint(Path(data).read_text())\n",
    "reader=Path('other.txt').read_text\nprint(reader())\n",
    "reader=Path('other.txt').read_text\nalias=reader\nprint(alias())\n",
    "from builtins import open as reader\nreader, = [open]\nprint(reader('other.txt').read())\n",
])
def test_actual_non_simple_bindings_never_mint_complete_wrong_input_closure(tmp_path, body):
    (tmp_path/'safe.txt').write_text('unread global')
    (tmp_path/'other.txt').write_text('actual changed-binding input')
    (tmp_path/'selector.py').write_text("data='other.txt'\n")
    main=tmp_path/'main.py';main.write_text('from pathlib import Path\n'+body)
    actual=subprocess.run([sys.executable,str(main)],cwd=tmp_path,capture_output=True,text=True,timeout=5)
    assert actual.returncode == 0, actual.stderr
    assert 'actual changed-binding input' in actual.stdout
    with pytest.raises(ValueError,match='unavailable'):
        local_source_closure([main],tmp_path)


@pytest.mark.parametrize('body', [
    "data='other.txt'\nprint(Path(data).read_text())\n",
    "data: str='other.txt'\nprint(Path(data).read_text())\n",
    "data=copy='other.txt'\nprint(Path(copy).read_text())\n",
    "base='other'\ndata=base+'.txt'\nprint(Path(data).read_text())\n",
    "data=Path('other.txt').resolve()\nprint(data.read_text())\n",
    "from pathlib import Path as P\np=P('other.txt')\nprint(p.open().read())\n",
])
def test_unique_module_literal_bindings_keep_complete_actual_input(tmp_path, body):
    data=tmp_path/'other.txt';data.write_text('complete supported literal input')
    main=tmp_path/'main.py';main.write_text('from pathlib import Path\n'+body)
    actual=subprocess.run([sys.executable,str(main)],cwd=tmp_path,capture_output=True,text=True,timeout=5)
    assert actual.returncode == 0 and 'complete supported literal input' in actual.stdout
    assert set(local_source_closure([main],tmp_path)) == {main,data}
