"""Exercise the real Windows runner boundary, rather than POSIX signal mocks."""
import importlib.util
import os
from pathlib import Path
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="native Windows process backend")


def _module(path, name):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_review_runner_preserves_output_and_timeout_outcome(tmp_path, monkeypatch):
    scripts = Path(__file__).resolve().parents[1] / "scripts/bin"
    runtime = _module(scripts / "run_multi_task.py", "windows_real_review_runtime")
    success = runtime._run_with_timeout([sys.executable, "-c", "print('complete')"], timeout_secs=3)
    assert success == {"timed_out": False, "exit_code": 0, "stdout": "complete\n", "stderr": ""}
    ready = tmp_path / "ready"
    spawn = runtime._OwnedPopen
    def started_process(*args, **kwargs):
        child = spawn(*args, **kwargs)
        deadline = time.monotonic() + 5
        while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        if not ready.exists():
            child.stop_tree()
            child.close()
            pytest.fail("real child did not publish flushed output before the timeout probe")
        return child
    monkeypatch.setattr(runtime, "_OwnedPopen", started_process)
    program = f"import time;from pathlib import Path;print('partial',flush=True);Path({str(ready)!r}).write_text('ready');time.sleep(30)"
    expired = runtime._run_with_timeout([sys.executable, "-c", program], timeout_secs=0.2)
    assert expired["timed_out"] is True
    assert expired["exit_code"] is None
    assert expired["stdout"] == "partial\n"


def test_reproduction_keeps_string_entry_and_reports_its_actual_exit(tmp_path):
    workspace = Path(__file__).resolve().parents[3]
    runtime = _module(workspace / "skills/research-harness/scripts/independent_reproduction_check.py", "windows_real_reproduction")
    bash_directory = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin"
    if not (bash_directory / "sh.exe").is_file():
        pytest.skip("Git for Windows is not installed")
    environment = {**os.environ, "PATH": str(bash_directory) + os.pathsep + os.environ["PATH"]}
    command = '"' + Path(sys.executable).as_posix() + '" -c "print(17)"'
    out, err = tmp_path / "stdout", tmp_path / "stderr"
    result = runtime.run_entry(command, tmp_path, 5, out, err, environment)
    assert result["exit_code"] == 0
    assert result["timed_out"] is False
    assert out.read_text().strip() == "17"
    assert result["command"] == command
    kept, dropped = runtime.sanitize_child_env({"MIXED": str(tmp_path).upper().replace("\\", "/")}, [tmp_path])
    assert "MIXED" not in kept
    assert "MIXED" in dropped
