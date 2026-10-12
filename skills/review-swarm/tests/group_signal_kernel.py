"""Test-only kernel observations and emulations for process-group signals.

Two kernel answers are reproduced so a test sees the same answers on every
kernel:

* A signal sent to a group number after the group's leader has been reaped
  (the leader's pid answers ESRCH to kill(pid, 0)) may reach an unrelated
  group to which the kernel has reissued the number. Such a signal is routed
  to a detached stand-in process that the test requires to survive.
* macOS answers EPERM to killpg for a group whose members have all exited
  while its leader is an unreaped zombie; Linux answers 0. On Linux the macOS
  answer is reproduced from /proc. On macOS the kernel's own answer is used.

This module observes processes through ps and /proc only; it shares no code
with the supervisors under test.
"""
from __future__ import annotations

import errno
import os
import subprocess
import sys
import time

LINUX = sys.platform.startswith("linux")


def _linux_stat(pid: int) -> tuple[str, int] | None:
    try:
        with open(f"/proc/{pid}/stat") as stream:
            text = stream.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    fields = text[text.rindex(")") + 2:].split()
    return fields[0], int(fields[2])  # state, process group


def is_zombie(pid: int) -> bool:
    if LINUX:
        stat = _linux_stat(pid)
        return stat is not None and stat[0] == "Z"
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                           capture_output=True, text=True).stdout.strip()
    return state.startswith("Z")


def wait_zombie(pid: int, timeout: float = 10) -> None:
    """Wait until an unreaped child has exited, observed from outside."""
    deadline = time.monotonic() + timeout
    while not is_zombie(pid):
        if time.monotonic() > deadline:
            raise AssertionError(f"process {pid} did not exit within {timeout}s")
        time.sleep(0.01)


def gone(pid: int) -> bool:
    """True once the process has exited (reaped, or a zombie awaiting a reaper)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return is_zombie(pid)


def wait_gone(pid: int, timeout: float = 10) -> bool:
    deadline = time.monotonic() + timeout
    while not gone(pid):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.02)
    return True


def _linux_has_live_member(pgid: int) -> bool:
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            stat = _linux_stat(int(entry))
            if stat is not None and stat[1] == pgid and stat[0] not in "ZX":
                return True
    return False


def emulated_killpg(real_killpg, standin_pgid: int | None = None, log_path: str | None = None):
    """killpg with the two kernel answers above; see the module docstring."""
    def killpg(pgid: int, signum: int) -> None:
        try:
            os.kill(pgid, 0)
        except ProcessLookupError:
            if log_path is not None:
                with open(log_path, "a") as log:
                    log.write(f"late {signum} {pgid}\n")
            if standin_pgid is None:
                return real_killpg(pgid, signum)
            try:  # the stand-in's fate is the evidence; its answers are not
                real_killpg(standin_pgid, signum)
            except OSError:
                pass
            return None
        except PermissionError:
            pass
        if LINUX and not _linux_has_live_member(pgid):
            raise PermissionError(errno.EPERM, os.strerror(errno.EPERM))
        return real_killpg(pgid, signum)
    return killpg


def emulated_getpgid(real_getpgid):
    """getpgid with the macOS answer for a zombie (ESRCH), reproduced on Linux."""
    def getpgid(pid: int) -> int:
        if LINUX and is_zombie(pid):
            raise ProcessLookupError(errno.ESRCH, os.strerror(errno.ESRCH))
        return real_getpgid(pid)
    return getpgid


SITECUSTOMIZE = '''\
import importlib.util, os
_spec = importlib.util.spec_from_file_location("group_signal_kernel", {path!r})
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
os.killpg = _module.emulated_killpg(os.killpg, int(os.environ["GROUP_SIGNAL_STANDIN"]),
                                    os.environ["GROUP_SIGNAL_LOG"])
'''


def install_for_children(site_dir, env: dict, standin_pgid: int, log_path) -> None:
    """Make every Python started with env use emulated_killpg (via sitecustomize)."""
    site_dir.mkdir(parents=True, exist_ok=True)
    (site_dir / "sitecustomize.py").write_text(SITECUSTOMIZE.format(path=os.path.abspath(__file__)))
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(site_dir), env.get("PYTHONPATH")]))
    env["GROUP_SIGNAL_STANDIN"] = str(standin_pgid)
    env["GROUP_SIGNAL_LOG"] = str(log_path)
