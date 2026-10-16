"""Native process ownership checks; run these on Windows, POSIX keeps its own gates."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nullius_windows import process as windows

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows kernel Job Object integration")


def test_exact_argv_environment_and_binary_pipes(tmp_path):
    arguments = ["space 中文", "%PATH%", "a&b", "!value!", '(x)"y']
    command = [sys.executable, "-c", "import os,sys,json;sys.stdout.buffer.write(json.dumps([sys.argv[1:],os.environ['PRIVATE_TOKEN']],ensure_ascii=False).encode());sys.stderr.buffer.write(b'a\\x00b\\n')", *arguments]
    with windows.WindowsJobProcess(command, cwd=tmp_path, env={**os.environ, "PRIVATE_TOKEN": "kept-private"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        out, err = proc.communicate(timeout=5)
        assert json.loads(out) == [arguments, "kept-private"]
        assert err == b"a\0b\n"
        assert proc.returncode == 0


def test_managed_command_requires_exact_body_and_preserves_literal_argv(tmp_path):
    target = tmp_path / "native target.py"
    target.write_text("import json,sys;sys.stdout.buffer.write(json.dumps(sys.argv[1:],ensure_ascii=False).encode('utf-8'))", encoding="utf-8")
    argv = [sys.executable, str(target)]
    marker = "@rem nullius-managed-node-argv " + json.dumps(argv, ensure_ascii=False, separators=(",", ":"))
    source = "\r\n".join(["@echo off", marker, "setlocal DisableDelayedExpansion",
                             " ".join('"' + arg.replace("%", "%%") + '"' for arg in argv) + " %*", ""])
    wrapper = tmp_path / "nullius.cmd"
    wrapper.write_bytes(source.encode("utf-8"))
    arguments = ["", 'a&b%PATH%!"', "中文", "trailing\\"]
    with windows.WindowsJobProcess([str(wrapper), *arguments], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE) as proc:
        stdout, _ = proc.communicate(timeout=5)
        assert proc.returncode == 0
        assert json.loads(stdout) == arguments
    # Matching metadata cannot authorize an altered batch program.
    wrapper.write_bytes((source + "echo extra-program\r\n").encode("utf-8"))
    with pytest.raises(OSError, match="paired Bash|bash.exe"):
        windows.WindowsJobProcess([str(wrapper)], stdout=subprocess.PIPE)


def test_root_exit_does_not_orphan_descendant(tmp_path):
    marker = tmp_path / "late-effect"
    grandchild = f"import time;from pathlib import Path;time.sleep(0.7);Path({str(marker)!r}).write_text('orphan')"
    root = f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{grandchild!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print('ready',flush=True)"
    with windows.WindowsJobProcess([sys.executable, "-c", root], stdout=subprocess.PIPE) as proc:
        assert proc.stdout.readline().strip() == b"ready"
        assert proc.wait(5) == 0
        assert proc.tree_alive()
        proc.stop_tree()
        assert not proc.tree_alive()
    time.sleep(0.8)
    assert not marker.exists()


def test_timeout_then_communicate_stops_tree(tmp_path):
    ready = tmp_path / "ready"
    program = f"import time;from pathlib import Path;print('before',flush=True);Path({str(ready)!r}).write_text('ready');time.sleep(30)"
    with windows.WindowsJobProcess([sys.executable, "-c", program], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        deadline = time.monotonic() + 5
        while not ready.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists(), "child did not publish flushed output before the timeout probe"
        with pytest.raises(subprocess.TimeoutExpired):
            proc.communicate(timeout=0.1)
        proc.kill()
        out, _ = proc.communicate(timeout=5)
        assert out.strip() == b"before"


def test_communicate_timeout_includes_input_backpressure():
    with windows.WindowsJobProcess([sys.executable, "-c", "import time;time.sleep(30)"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        guard_fired = threading.Event()
        def stop_guard():
            guard_fired.set()
            proc.kill()
        guard = threading.Timer(2, stop_guard)
        guard.start()
        try:
            with pytest.raises(subprocess.TimeoutExpired):
                proc.communicate(input=b"x" * (1024 * 1024), timeout=0.1)
            assert not guard_fired.is_set(), "timeout waited for an external stop to unblock stdin"
        finally:
            guard.cancel()
        proc.kill()
        assert proc.communicate(timeout=5) == (b"", b"")


def test_root_exit_closes_inherited_pipes_and_preserves_utf8_output(tmp_path):
    ready = tmp_path / "descendant.pid"
    program = ("import subprocess,sys;from pathlib import Path;"
               "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);"
               "sys.stdout.buffer.write('partial λ\\n'.encode('utf-8'));sys.stdout.buffer.flush();"
               f"Path({str(ready)!r}).write_text(str(child.pid))")
    with windows.WindowsJobProcess([sys.executable, "-c", program], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        deadline = time.monotonic() + 5
        while not ready.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists()
        stdout, stderr = proc.communicate(input=b"x" * (1024 * 1024), timeout=2)
        assert stdout == "partial λ\n".encode("utf-8")
        assert stderr == b""
        handle = windows._api().OpenProcess(0x100000, False, int(ready.read_text()))
        if handle:
            try:
                assert windows._api().WaitForSingleObject(handle, 0) == 0
            finally:
                windows._api().CloseHandle(handle)


def test_killing_owner_closes_job_and_kills_descendants(tmp_path):
    marker = tmp_path / "orphan"
    root = f"import os,time;from pathlib import Path;print(os.getpid(),flush=True);time.sleep(0.8);Path({str(marker)!r}).write_text('orphan');time.sleep(30)"
    owner = subprocess.Popen([sys.executable, "-I", windows.__file__, "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        specification = {"argv": [sys.executable, "-c", root], "env": dict(os.environ), "cwd": str(tmp_path)}
        owner.stdin.write((json.dumps(specification) + "\n").encode())
        owner.stdin.flush()
        assert int(owner.stdout.readline()) > 0
        owner.kill()
        owner.wait(5)
        time.sleep(1)
        assert not marker.exists()
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait(5)
        for stream in (owner.stdin, owner.stdout, owner.stderr):
            stream.close()


def test_failed_atomic_job_attribute_never_executes_target(tmp_path, monkeypatch):
    marker = tmp_path / "must-not-run"
    api = windows._api()
    api.UpdateProcThreadAttribute = lambda *_: False
    monkeypatch.setattr(windows, "_api", lambda: api)
    with pytest.raises(OSError):
        windows.WindowsJobProcess([sys.executable, "-c", f"from pathlib import Path;Path({str(marker)!r}).touch()"])
    assert not marker.exists()


def test_bash_command_wrapper_preserves_arguments_without_evaluation(tmp_path):
    bash_directory = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin"
    if not (bash_directory / "bash.exe").is_file():
        pytest.skip("Git for Windows is not installed")
    echo = tmp_path / "echo.py"
    echo.write_text("import json,sys;print(json.dumps(sys.argv[1:]))", encoding="utf-8")
    (tmp_path / "tool.cmd").write_text("@echo off\r\nexit /b 99\r\n", encoding="utf-8")
    (tmp_path / "tool").write_text('#!/bin/sh\nexec ' + json.dumps(Path(sys.executable).as_posix()) + ' ' + json.dumps(echo.as_posix()) + ' "$@"\n', encoding="utf-8")
    arguments = ["space 中文", "%PATH%", "a&b", "!value!", '(x)"y', "$(touch forbidden)"]
    environment = {**os.environ, "PATH": str(bash_directory) + os.pathsep + os.environ["PATH"]}
    with windows.WindowsJobProcess([str(tmp_path / "tool.cmd"), *arguments], cwd=tmp_path,
                                   env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        out, err = proc.communicate(timeout=5)
        assert proc.returncode == 0, err
        assert json.loads(out) == arguments
        assert not (tmp_path / "forbidden").exists()


def test_explicit_batch_without_paired_shell_shim_fails_closed(tmp_path):
    target = tmp_path / "unsupported.cmd"
    target.write_text("@echo off\r\nexit /b 0\r\n", encoding="utf-8")
    with pytest.raises(OSError):
        windows.WindowsJobProcess([str(target)])


def test_cli_parent_identity_is_checked_before_target_effects(tmp_path):
    marker = tmp_path / "must-not-start"
    with pytest.raises(OSError):
        windows._cli(os.getpid(), 0, [sys.executable, "-c", f"from pathlib import Path;Path({str(marker)!r}).touch()"])
    assert not marker.exists()


def test_cli_tree_stops_when_original_launcher_parent_dies(tmp_path):
    marker = tmp_path / "late-cli-effect"
    target = f"import time;from pathlib import Path;print('target-ready',flush=True);time.sleep(1);Path({str(marker)!r}).touch();time.sleep(30)"
    script = f"""
import ctypes, os, subprocess, sys, time
sys.path.insert(0, {str(Path(windows.__file__).parents[1])!r})
from nullius_windows.process import _api
from ctypes import wintypes as w
k = _api()
c,e,a,b = (w.FILETIME() for _ in range(4))
k.GetProcessTimes(k.GetCurrentProcess(),ctypes.byref(c),ctypes.byref(e),ctypes.byref(a),ctypes.byref(b))
creation = (c.dwHighDateTime << 32) | c.dwLowDateTime
subprocess.Popen([sys.executable,'-I',{windows.__file__!r},'--cli',str(os.getpid()),str(creation),'--',sys.executable,'-c',{target!r}])
time.sleep(30)
"""
    parent = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert parent.stdout.readline().strip() == b"target-ready"
        parent.kill()
        parent.communicate(timeout=5)
        time.sleep(1.1)
        assert not marker.exists()
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.communicate(timeout=5)


def test_mcp_parent_loss_stops_tree_while_transport_input_is_blocked(tmp_path):
    marker = tmp_path / "backpressure-orphan"
    target = f"import time;from pathlib import Path;print('blocked-target-ready',flush=True);time.sleep(1);Path({str(marker)!r}).touch();time.sleep(30)"
    script = f"""
import json, os, subprocess, sys, threading, time
owner = subprocess.Popen([sys.executable,'-I',{windows.__file__!r},'--stdio'],stdin=subprocess.PIPE)
spec = {{'argv':[sys.executable,'-c',{target!r}],'env':dict(os.environ),'parent_pid':os.getpid()}}
owner.stdin.write((json.dumps(spec)+'\\n').encode()); owner.stdin.flush()
threading.Thread(target=lambda: owner.stdin.write(b'x'*(8*1024*1024)), daemon=True).start()
time.sleep(30)
"""
    parent = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert parent.stdout.readline().strip() == b"blocked-target-ready"
        parent.kill()
        parent.communicate(timeout=5)
        time.sleep(1.1)
        assert not marker.exists()
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.communicate(timeout=5)
