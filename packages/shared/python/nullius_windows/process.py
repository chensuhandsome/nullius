"""Owned Windows process trees using only the Python standard library.

Children join their Job Object atomically at CreateProcessW.  The job handle
is never inherited; closing its owner kills every remaining descendant.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

_PROCESSES: dict[int, "WindowsJobProcess"] = {}


def _windows():
    if sys.platform != "win32":
        raise OSError("Windows Job Objects require Windows")
    return ctypes.WinDLL("kernel32", use_last_error=True)


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _BASIC_LIMIT(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", w.DWORD), ("Affinity", ctypes.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class _EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BASIC_LIMIT), ("IoInfo", _IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class _ACCOUNTING(ctypes.Structure):
    _fields_ = [(name, ctypes.c_longlong) for name in ("TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime")] + [(name, w.DWORD) for name in ("TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]


class _STARTUPINFO(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD), ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD), ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD), ("lpReserved2", ctypes.POINTER(ctypes.c_byte)), ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class _STARTUPINFOEX(ctypes.Structure):
    _fields_ = [("StartupInfo", _STARTUPINFO), ("lpAttributeList", ctypes.c_void_p)]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class _SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", w.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p), ("bInheritHandle", w.BOOL)]


def _api():
    k = _windows()
    signatures = {
        "CreateJobObjectW": ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
        "SetInformationJobObject": ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD], w.BOOL),
        "QueryInformationJobObject": ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p], w.BOOL),
        "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "GetCurrentProcess": ([], w.HANDLE),
        "GetStdHandle": ([w.DWORD], w.HANDLE),
        "DuplicateHandle": ([w.HANDLE, w.HANDLE, w.HANDLE, ctypes.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD], w.BOOL),
        "CreatePipe": ([ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.POINTER(_SECURITY_ATTRIBUTES), w.DWORD], w.BOOL),
        "SetHandleInformation": ([w.HANDLE, w.DWORD, w.DWORD], w.BOOL),
        "InitializeProcThreadAttributeList": ([ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)], w.BOOL),
        "UpdateProcThreadAttribute": ([ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p], w.BOOL),
        "DeleteProcThreadAttributeList": ([ctypes.c_void_p], None),
        "CreateProcessW": ([w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.POINTER(_STARTUPINFOEX), ctypes.POINTER(_PROCESS_INFORMATION)], w.BOOL),
        "ResumeThread": ([w.HANDLE], w.DWORD),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "GetExitCodeProcess": ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
        "OpenProcess": ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
        "GetProcessTimes": ([w.HANDLE, ctypes.POINTER(w.FILETIME), ctypes.POINTER(w.FILETIME), ctypes.POINTER(w.FILETIME), ctypes.POINTER(w.FILETIME)], w.BOOL),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(k, name)
        fn.argtypes, fn.restype = args, result
    return k


def _check(value):
    if not value:
        raise ctypes.WinError(ctypes.get_last_error())
    return value


def _managed_command_argv(executable):
    """Recognize the exact native argv shim emitted by the Nullius installer.

    The comment is metadata only after the complete batch body matches. Never
    execute batch syntax or trust a marker appended to a different program.
    """
    if Path(executable).suffix.lower() != ".cmd":
        return None
    try:
        source = Path(executable).read_bytes().decode("utf-8")
        prefix = "@rem nullius-managed-node-argv "
        marker = next(line for line in source.splitlines() if line.startswith(prefix))
        argv = json.loads(marker[len(prefix):])
        if (not isinstance(argv, list) or len(argv) < 2
                or any(not isinstance(arg, str) or not os.path.isabs(arg)
                       or any(c in arg for c in '\"\r\n\0') for arg in argv)):
            return None
        expected = "\r\n".join([
            "@echo off", prefix + json.dumps(argv, ensure_ascii=False, separators=(",", ":")),
            "setlocal DisableDelayedExpansion",
            " ".join('"' + arg.replace("%", "%%") + '"' for arg in argv) + " %*", "",
        ])
        if (source != expected or Path(argv[0]).suffix.lower() not in (".exe", ".com")
                or not all(Path(arg).is_file() for arg in argv)):
            return None
        return argv
    except (OSError, UnicodeError, StopIteration, ValueError, TypeError):
        return None


def _resolve_command(args, environment, cwd):
    """Search explicit PATH directories, never an implicit Windows current dir."""
    def find(token):
        if os.path.dirname(token):
            candidate = Path(token)
            if not candidate.is_absolute():
                candidate = Path(cwd or os.getcwd()) / candidate
            return str(candidate.resolve()) if candidate.is_file() else None
        suffixes = [""] if Path(token).suffix else ["", ".exe", ".com", ".cmd", ".bat"]
        for directory in environment.get("PATH", "").split(os.pathsep):
            directory = directory.strip('"')
            if not os.path.isabs(directory):
                continue
            for suffix in suffixes:
                candidate = Path(directory) / (token + suffix)
                if candidate.is_file():
                    return str(candidate.resolve())
        return None
    executable = find(args[0])
    if not executable:
        raise FileNotFoundError(args[0])
    managed = _managed_command_argv(executable)
    if managed is not None:
        return managed[0], [*managed, *args[1:]]
    with open(executable, "rb") as source:
        script = source.read(2) == b"#!"
    if Path(executable).suffix.lower() in (".cmd", ".bat") or script:
        bash = find("bash.exe")
        if not bash:
            raise OSError("Git for Windows bash.exe is required to execute command wrappers")
        # MSYS parses embedded quotes differently from native CRT argv. Move
        # argument bytes through a private environment value instead; the fixed
        # Bash program uses builtins and never evaluates the decoded arguments.
        target = str(Path(executable).with_suffix("")) if Path(executable).suffix.lower() in (".cmd", ".bat") else executable
        if not Path(target).is_file():
            raise OSError("Batch commands require their paired Bash command shim or an explicit native executable")
        raw = b"\0".join(value.encode("utf-8") for value in [target.replace("\\", "/"), *args[1:]]) + b"\0"
        environment["_NULLIUS_WINDOWS_ARGV"] = "".join(f"\\x{byte:02x}" for byte in raw)
        script = 'mapfile -d "" -t _nullius_args < <(printf "%b" "$_NULLIUS_WINDOWS_ARGV"); unset _NULLIUS_WINDOWS_ARGV; exec "${_nullius_args[@]}"'
        return bash, [bash, "-c", script]
    return executable, [executable, *args[1:]]


class WindowsJobProcess:
    """A real child process and its owned Job, with Popen-shaped stream access."""

    def __init__(self, args, *, cwd=None, env=None, stdin=None, stdout=None, stderr=None,
                 text=False, encoding=None, allow_delivery_breakaway=False, start_new_session=False):
        import msvcrt
        self.args = list(args)
        if not self.args or not all(isinstance(s, str) and "\0" not in s for s in self.args):
            raise ValueError("process argv must contain non-NUL strings")
        self._k = k = _api()
        self._job = self._process = None
        self.pid = 0
        self.returncode = None
        self.stdin = self.stdout = self.stderr = None
        self._closed = False
        self._communication = None
        child_handles, parent_handles, files = [], {}, []
        attrs = None
        initialized_attributes = False
        pi = _PROCESS_INFORMATION()
        try:
            self._job = _check(k.CreateJobObjectW(None, None))
            limits = _EXTENDED_LIMIT()
            limits.BasicLimitInformation.LimitFlags = 0x2000 | (0x0800 if allow_delivery_breakaway else 0)
            _check(k.SetInformationJobObject(self._job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
            current = k.GetCurrentProcess()
            sa = _SECURITY_ATTRIBUTES(ctypes.sizeof(_SECURITY_ATTRIBUTES), None, True)
            for name, value, std_id in (("stdin", stdin, -10), ("stdout", stdout, -11), ("stderr", stderr, -12)):
                if value == subprocess.PIPE:
                    read, write = w.HANDLE(), w.HANDLE()
                    _check(k.CreatePipe(ctypes.byref(read), ctypes.byref(write), ctypes.byref(sa), 0))
                    child, parent = (read.value, write.value) if name == "stdin" else (write.value, read.value)
                    parent_handles[name] = parent
                    _check(k.SetHandleInformation(parent, 1, 0))
                else:
                    if value == subprocess.STDOUT:
                        if name != "stderr":
                            raise ValueError("STDOUT redirection is only valid for stderr")
                        original = child_handles[1]
                    elif value == subprocess.DEVNULL:
                        file = open(os.devnull, "rb" if name == "stdin" else "wb")
                        files.append(file)
                        original = msvcrt.get_osfhandle(file.fileno())
                    elif value is None:
                        original = k.GetStdHandle(std_id & 0xffffffff)
                        if not original or original == ctypes.c_void_p(-1).value:
                            file = open(os.devnull, "rb" if name == "stdin" else "wb")
                            files.append(file)
                            original = msvcrt.get_osfhandle(file.fileno())
                    else:
                        original = msvcrt.get_osfhandle(value if isinstance(value, int) else value.fileno())
                    duplicate = w.HANDLE()
                    _check(k.DuplicateHandle(current, original, current, ctypes.byref(duplicate), 0, True, 2))
                    child = duplicate.value
                child_handles.append(child)
            size = ctypes.c_size_t()
            k.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
            attrs = ctypes.create_string_buffer(size.value)
            _check(k.InitializeProcThreadAttributeList(attrs, 2, 0, ctypes.byref(size)))
            initialized_attributes = True
            jobs = (w.HANDLE * 1)(self._job)
            handles = (w.HANDLE * len(child_handles))(*child_handles)
            _check(k.UpdateProcThreadAttribute(attrs, 0, 0x2000D, jobs, ctypes.sizeof(jobs), None, None))
            _check(k.UpdateProcThreadAttribute(attrs, 0, 0x20002, handles, ctypes.sizeof(handles), None, None))
            startup = _STARTUPINFOEX()
            startup.StartupInfo.cb = ctypes.sizeof(startup)
            startup.StartupInfo.dwFlags = 0x100 | 0x1
            startup.StartupInfo.wShowWindow = 0
            startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = child_handles
            startup.lpAttributeList = ctypes.cast(attrs, ctypes.c_void_p)
            environment = dict(os.environ if env is None else env)
            if any("\0" in str(key) + str(value) or "=" in key for key, value in environment.items()):
                raise ValueError("invalid process environment")
            executable, actual_argv = _resolve_command(self.args, environment, cwd)
            env_block = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(environment.items(), key=lambda item: item[0].upper())) + "\0\0")
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline(actual_argv))
            _check(k.CreateProcessW(executable, command, None, None, True, 0x00080000 | 0x400 | 0x4 | 0x08000000,
                                   env_block, os.fspath(cwd) if cwd else None, ctypes.byref(startup), ctypes.byref(pi)))
            self._process, self.pid = pi.hProcess, pi.dwProcessId
            for name, handle in list(parent_handles.items()):
                writing = name == "stdin"
                fd = msvcrt.open_osfhandle(handle, os.O_BINARY | (os.O_WRONLY if writing else os.O_RDONLY))
                parent_handles.pop(name)
                stream = os.fdopen(fd, "wb" if writing else "rb", buffering=0)
                if text:
                    stream = io.TextIOWrapper(stream, encoding=encoding or "utf-8")
                setattr(self, name, stream)
            if k.ResumeThread(pi.hThread) == 0xffffffff:
                raise ctypes.WinError(ctypes.get_last_error())
            _PROCESSES[self.pid] = self
        except BaseException:
            if self._job:
                k.TerminateJobObject(self._job, 1)
            self.close()
            raise
        finally:
            if pi.hThread:
                k.CloseHandle(pi.hThread)
            if initialized_attributes:
                k.DeleteProcThreadAttributeList(attrs)
            for handle in [*child_handles, *parent_handles.values()]:
                k.CloseHandle(handle)
            for file in files:
                file.close()

    def root_exited(self, timeout=None):
        if self.returncode is not None:
            return True
        result = self._k.WaitForSingleObject(self._process, 0xffffffff if timeout is None else min(0xfffffffe, max(0, int(timeout * 1000))))
        if result == 0xffffffff:
            raise ctypes.WinError(ctypes.get_last_error())
        return result == 0

    def tree_alive(self):
        info = _ACCOUNTING()
        _check(self._k.QueryInformationJobObject(self._job, 1, ctypes.byref(info), ctypes.sizeof(info), None))
        return info.ActiveProcesses > 0

    def poll(self):
        if self.returncode is None and self.root_exited(0):
            code = w.DWORD()
            _check(self._k.GetExitCodeProcess(self._process, ctypes.byref(code)))
            self.returncode = code.value
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is not None:
            return self.returncode
        if not self.root_exited(timeout):
            raise subprocess.TimeoutExpired(self.args, timeout)
        return self.poll()

    def stop_tree(self, timeout=10):
        if not self._job:
            return
        _check(self._k.TerminateJobObject(self._job, 1))
        deadline = time.monotonic() + timeout
        info = _ACCOUNTING()
        while True:
            _check(self._k.QueryInformationJobObject(self._job, 1, ctypes.byref(info), ctypes.sizeof(info), None))
            if info.ActiveProcesses == 0:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Windows process tree did not stop")
            time.sleep(0.01)
        self.poll()

    def kill(self):
        self.stop_tree()

    terminate = kill

    def communicate(self, input=None, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        if self._communication is None:
            result, threads = {}, []
            self._communication = (result, threads)
            for name in ("stdout", "stderr"):
                stream = getattr(self, name)
                if stream is not None:
                    thread = threading.Thread(target=lambda n=name, s=stream: result.update({n: s.read()}), daemon=True)
                    thread.start()
                    threads.append(thread)
            if self.stdin is not None and not self.stdin.closed:
                def write_input():
                    try:
                        if input is not None:
                            offset = 0
                            while offset < len(input):
                                count = self.stdin.write(input[offset:])
                                if not count:
                                    raise OSError("process input pipe accepted no data")
                                offset += count
                    except BrokenPipeError:
                        pass
                    except BaseException as error:
                        result["input_error"] = error
                    finally:
                        try:
                            self.stdin.close()
                        except BrokenPipeError:
                            pass
                thread = threading.Thread(target=write_input, daemon=True)
                thread.start()
                threads.append(thread)
        result, threads = self._communication
        self.wait(None if deadline is None else max(0, deadline - time.monotonic()))
        self.stop_tree()
        for thread in threads:
            thread.join(None if deadline is None else max(0, deadline - time.monotonic()))
            if thread.is_alive():
                raise subprocess.TimeoutExpired(self.args, timeout, output=result.get("stdout"), stderr=result.get("stderr"))
        self.release_handles()
        if "input_error" in result:
            raise result["input_error"]
        return result.get("stdout"), result.get("stderr")

    def close(self):
        if self._closed:
            return
        self._closed = True
        for name in ("stdin", "stdout", "stderr"):
            stream = getattr(self, name, None)
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        self.release_handles()

    def release_handles(self):
        _PROCESSES.pop(self.pid, None)
        for name in ("_job", "_process"):
            handle = getattr(self, name, None)
            if handle:
                self._k.CloseHandle(handle)
                setattr(self, name, None)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            self.stop_tree()
        finally:
            self.close()


def child_exited(pid, timeout=None):
    return _PROCESSES[pid].root_exited(timeout)


def stop_process(proc):
    proc.stop_tree()
    code = proc.wait()
    proc.release_handles()
    return code


def signal_process_tree(pid, signum):
    proc = _PROCESSES.get(pid)
    if proc is None:
        return False
    if signum == 0:
        return proc.tree_alive()
    proc.stop_tree()
    return True


def _copy(source, target):
    try:
        while True:
            data = getattr(source, "read1", source.read)(65536)
            if not data:
                break
            target.write(data)
            target.flush()
    except (OSError, ValueError):
        pass
    finally:
        try:
            target.close()
        except (OSError, ValueError):
            pass


def _creation_time(k, process):
    created, ended, kernel, user = (w.FILETIME() for _ in range(4))
    _check(k.GetProcessTimes(process, ctypes.byref(created), ctypes.byref(ended), ctypes.byref(kernel), ctypes.byref(user)))
    return (created.dwHighDateTime << 32) | created.dwLowDateTime


def _open_parent(k, pid, expected_creation=None):
    handle = _check(k.OpenProcess(0x100000 | 0x1000, False, int(pid)))
    try:
        created = _creation_time(k, handle)
        # A reused parent PID was created after this helper. Retaining the
        # accepted handle then makes every later observation reuse-proof.
        if (expected_creation is not None and created != int(expected_creation)) \
                or created >= _creation_time(k, k.GetCurrentProcess()) \
                or k.WaitForSingleObject(handle, 0) == 0:
            raise OSError("the original launcher parent is no longer alive")
        return handle
    except BaseException:
        k.CloseHandle(handle)
        raise


def _stdio_supervisor():
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    # Never deserialize shell code; argv stays structured through CreateProcessW.
    initial = b""
    while b"\n" not in initial:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            raise ValueError("missing process launch specification")
        initial += chunk
    line, pending_input = initial.split(b"\n", 1)
    specification = json.loads(line)
    mode = specification.get("mode", "mcp")
    proc = None
    k, parent = _api(), None
    def report(value):
        sys.stderr.write(json.dumps(value) + "\n")
        sys.stderr.flush()
    try:
        parent = _open_parent(k, specification.get("parent_pid", os.getppid()))
        proc = WindowsJobProcess(specification["argv"], cwd=specification.get("cwd"), env=specification["env"],
                                 stdin=subprocess.PIPE if mode == "mcp" else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE if mode == "mcp" else subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL,
                                 allow_delivery_breakaway=bool(specification.get("allow_delivery_breakaway", False)))
        stop = threading.Event()
        def input_loop():
            try:
                data = pending_input
                while True:
                    if data and mode == "mcp":
                        proc.stdin.write(data)
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        break
            except (OSError, ValueError):
                pass
            finally:
                if proc.stdin is not None:
                    try:
                        proc.stdin.close()
                    except (OSError, ValueError):
                        pass
                stop.set()
        threading.Thread(target=input_loop, daemon=True).start()
        output_thread = None
        if mode == "mcp":
            output_thread = threading.Thread(target=_copy, args=(proc.stdout, sys.stdout.buffer), daemon=True)
            output_thread.start()
        reported = False
        while True:
            if k.WaitForSingleObject(parent, 0) == 0:
                break
            if not reported and proc.root_exited(0.01):
                report({"code": proc.wait(), "signal": None})
                reported = True
                if mode == "run":
                    break
            if stop.is_set():
                proc.root_exited(max(0, specification.get("shutdown_grace_ms", 250)) / 1000)
                break
        code = proc.poll()
        proc.stop_tree()
        if output_thread is not None:
            output_thread.join(5)
        if not reported:
            report({"code": proc.wait(), "signal": None})
        report({"tree_stopped": True})
        return code if code is not None and 0 <= code <= 255 else 1
    except BaseException as error:
        report({"error": type(error).__name__ + ": " + str(error)})
        return 1
    finally:
        if proc is not None:
            proc.close()
        if parent:
            k.CloseHandle(parent)


def _delivery_paths(supervisor, request):
    supervisor = Path(supervisor).resolve(strict=True)
    workspace = next((parent for parent in Path(__file__).resolve().parents
                      if (parent / "pnpm-workspace.yaml").is_file()), None)
    if workspace is None:
        raise ValueError("detached delivery requires an installed Nullius workspace")
    if supervisor != workspace / "packages/project-mcp/dist/supervisor.js":
        raise ValueError("detached delivery requires the canonical project supervisor")
    request_path = Path(request).resolve(strict=True)
    document = json.loads(request_path.read_text(encoding="utf-8"))
    root = Path(document["root"]).resolve(strict=True)
    delivery = document["delivery_id"]
    if not isinstance(delivery, str) or not delivery or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for c in delivery):
        raise ValueError("invalid delivery identity")
    if request_path != root / "artifacts/delegated-runs/project-mcp" / delivery / "delivery_request.json":
        raise ValueError("detached delivery request is outside its canonical journal")
    seconds = document["timeout_seconds"]
    if type(seconds) is not int or not 0 < seconds <= 3600:
        raise ValueError("invalid detached delivery deadline")
    return supervisor, request_path, root, seconds


def _launch_delivery(node, supervisor, request):
    supervisor, request, root, _ = _delivery_paths(supervisor, request)
    # Only this canonical path can intentionally leave an enclosing MCP Job.
    subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--owned-delivery", node, str(supervisor), str(request)],
                     cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     close_fds=True, creationflags=0x01000000 | 0x00000008 | 0x00000200)
    return 0


def _owned_delivery(node, supervisor, request):
    supervisor, request, root, seconds = _delivery_paths(supervisor, request)
    with WindowsJobProcess([node, str(supervisor), str(request)], cwd=root,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as proc:
        if not proc.root_exited(seconds + 10):
            proc.stop_tree()
            return 1
        code = proc.wait()
        proc.stop_tree()
        return code


def _cli(parent_pid, parent_creation_time, argv):
    """Keep a native console launcher and its complete transient tree together."""
    if not argv:
        raise ValueError("missing CLI target argv")
    k = _api()
    parent = _open_parent(k, parent_pid, parent_creation_time)
    try:
        # This mode is the trusted operator front door, not an execution
        # sandbox. It must permit canonical durable delivery to outlive the
        # front door, also when a generated project-local launcher is between
        # them. Bounded execution and generic MCP Jobs still forbid breakaway.
        with WindowsJobProcess(argv, allow_delivery_breakaway=True) as proc:
            while not proc.root_exited(0.05):
                if k.WaitForSingleObject(parent, 0) == 0:
                    proc.stop_tree()
                    return 143
            code = proc.wait()
            proc.stop_tree()
            return code
    finally:
        k.CloseHandle(parent)


if __name__ == "__main__":
    if sys.platform == "win32":
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    if len(sys.argv) >= 6 and sys.argv[1] == "--cli" and sys.argv[4] == "--":
        try:
            raise SystemExit(_cli(sys.argv[2], sys.argv[3], sys.argv[5:]))
        except (OSError, ValueError) as error:
            sys.stderr.write("[error] Windows CLI ownership: " + str(error) + "\n")
            raise SystemExit(1)
    if sys.argv[1:] == ["--stdio"]:
        raise SystemExit(_stdio_supervisor())
    if len(sys.argv) == 5 and sys.argv[1] == "--launch-delivery":
        raise SystemExit(_launch_delivery(*sys.argv[2:]))
    if len(sys.argv) == 5 and sys.argv[1] == "--owned-delivery":
        raise SystemExit(_owned_delivery(*sys.argv[2:]))
    raise SystemExit("expected --stdio or a canonical delivery launch")
