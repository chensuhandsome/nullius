"""Local process supervision; copied with each independently installed runner skill."""
from __future__ import annotations

import argparse
import contextlib
import json
import hashlib
import math
import os
from pathlib import Path
from datetime import datetime, timezone
import signal
import subprocess
import sys
import time


def save(path: Path, state: dict) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2)+'\n')
    os.replace(temporary, path)


def remaining(state: dict) -> float | None:
    deadline = state['deadline_monotonic']
    return None if deadline is None else max(0, deadline-time.monotonic())


def stop_group(proc: subprocess.Popen) -> None:
    # The CLI may exit before its descendants; always address its whole group.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=0.3)
    except subprocess.TimeoutExpired:
        pass
    with contextlib.suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()


class Capture:
    """Claude stream adapter. Supervision uses kinds, counts and time only."""
    def __init__(self, raw: Path, partial: Path, trace: Path):
        self.raw, self.partial, self.trace = raw, partial, trace
        self.offset = 0
        self.pending = b""
        self.seen = set()
        self.answer = ""
        self.error_path = raw.with_suffix('.error.log')
        self.error_path.write_text("")
        self.terminal = None
        self.state = {"capture_health": "unknown", "event_count": 0,
                      "advancing_events": 0, "answer_chars": 0, "thinking_chars": 0,
                      "event_kinds": {}, "last_event_kind": None,
                      "last_advancing_monotonic": None, "reported_model": None,
                      "complete_result_seen": False, "unparsed_lines": 0}
        self.partial.write_text("")
        self.trace.with_suffix(".partial").write_text("")

    def read(self):
        with self.raw.open("rb") as stream:
            stream.seek(self.offset)
            chunk = stream.read()
        self.offset += len(chunk)
        self.pending += chunk
        while b"\n" in self.pending:
            line, self.pending = self.pending.split(b"\n", 1)
            try:
                obj = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                self.state["unparsed_lines"] += 1
                self.state["capture_health"] = "degraded"
                continue
            if not isinstance(obj, dict):
                self.state["capture_health"] = "degraded"
                continue
            typ = obj.get("type")
            kind = typ if typ in {"system", "assistant", "result", "stream_event", "user", "error", "rate_limit_event"} else "unknown"
            if kind == "unknown":
                self.state["capture_health"] = "degraded"
            self.state["event_count"] += 1
            self.state["last_event_kind"] = kind
            kinds = self.state["event_kinds"]
            kinds[kind] = kinds.get(kind, 0) + 1
            fingerprint_input = {"uuid":obj.get("uuid"), "event":obj.get("event")} if kind == "stream_event" else obj
            fingerprint = hashlib.sha256(json.dumps(fingerprint_input, sort_keys=True).encode()).digest()
            duplicate = fingerprint in self.seen
            self.seen.add(fingerprint)
            if kind == "error" or (kind == "result" and obj.get("is_error")):
                error = obj.get("error")
                message = error.get("message") if isinstance(error, dict) else error
                if not isinstance(message, str):
                    message = obj.get("message")
                if kind == "result" and not isinstance(message, str):
                    message = obj.get("result")
                if isinstance(message, str):
                    with self.error_path.open('a') as error_log:
                        error_log.write(message+'\n')
            if kind == "system" and isinstance(obj.get("model"), str):
                self.state["reported_model"] = obj["model"]
            if kind == "assistant" and isinstance(obj.get("message"), dict):
                message = obj["message"]
                if isinstance(message.get("model"), str):
                    self.state["reported_model"] = message["model"]
                # A full assistant snapshot may accompany partial deltas. Keep
                # the longer answer without counting that duplicate representation.
                body = "".join(item.get("text", "") for item in message.get("content", [])
                               if isinstance(item, dict) and item.get("type") == "text")
                if len(body) > len(self.answer):
                    self.answer = body
            event = obj.get("event") if kind == "stream_event" else None
            delta = event.get("delta") if isinstance(event, dict) else None
            advancing = 0
            if isinstance(delta, dict) and not duplicate:
                dtype = delta.get("type")
                if dtype == "text_delta" and isinstance(delta.get("text"), str):
                    self.answer += delta["text"]
                    advancing = len(delta["text"])
                    self.state["answer_chars"] += advancing
                elif dtype == "thinking_delta" and isinstance(delta.get("thinking"), str):
                    advancing = len(delta["thinking"])
                    self.state["thinking_chars"] += advancing
                if dtype in ("text_delta", "thinking_delta") and self.state["capture_health"] != "degraded":
                    self.state["capture_health"] = "observable"
            if advancing:
                self.state["advancing_events"] += 1
                self.state["last_advancing_monotonic"] = time.monotonic()
            if kind == "result":
                self.terminal = obj
                self.state["complete_result_seen"] = True
                self.trace.with_suffix(".result.json").write_text(json.dumps(obj, indent=2)+"\n")
            if self.answer:
                self.partial.write_text(self.answer)
                self.trace.with_suffix(".partial").write_text(self.answer)


def main() -> int:
    # macOS monotonic clocks share a process-independent reference from 3.10.
    # Never turn a per-process timestamp into a reusable absolute deadline.
    if sys.version_info < (3, 10):
        print('Runner supervision requires Python >= 3.10 for a cross-process monotonic deadline.', file=sys.stderr)
        return 2
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=['init', 'run', 'sleep', 'finish'])
    ap.add_argument('--state', type=Path, required=True)
    ap.add_argument('--max-attempts', type=int, default=3)
    ap.add_argument('--timeout-secs', type=float, default=0)
    ap.add_argument('--seconds', type=float, default=0)
    ap.add_argument('--stdin', type=Path)
    ap.add_argument('--stdout', type=Path)
    ap.add_argument('--stderr', type=Path)
    ap.add_argument('--exit-code', type=int, default=1)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--prompt-file', type=Path)
    ap.add_argument('--system-file', type=Path)
    ap.add_argument('--capture', action='store_true')
    ap.add_argument('--expected-secs', type=float, default=1200)
    ap.add_argument('--inactivity-secs', type=float, default=0)
    ap.add_argument('--inactivity-grace-secs', type=float, default=30)
    ap.add_argument('--session-id-file', type=Path)
    arguments = sys.argv[1:]
    separator = arguments.index('--') if '--' in arguments else len(arguments)
    args = ap.parse_args(arguments[:separator])
    command = arguments[separator+1:]
    if any(not math.isfinite(x) or x < 0 for x in (args.timeout_secs, args.expected_secs, args.inactivity_secs)) or not math.isfinite(args.inactivity_grace_secs) or args.inactivity_grace_secs <= 0 or args.max_attempts < 1:
        ap.error('budgets/estimates must be nonnegative, attempts and inactivity grace positive')
    if args.action == 'init':
        inputs = [p for p in (args.prompt_file,args.system_file) if p]
        artifacts = [args.out, Path(str(args.out)+'.partial')] if args.out else []
        for artifact in artifacts:
            for source in inputs:
                if artifact.resolve() == source.resolve() or (artifact.exists() and source.exists() and artifact.samefile(source)):
                    ap.error('output/partial path must differ from prompt inputs')
        for label,artifact in zip(('previous-output.txt','previous-partial.txt'),artifacts):
            if artifact.exists():
                (args.state.parent/label).write_bytes(artifact.read_bytes())
                artifact.unlink()
        now = time.monotonic()
        save(args.state, {'max_attempts':args.max_attempts, 'attempts_used':0,
                         'started_monotonic':now,
                         'deadline_monotonic':now+args.timeout_secs if args.timeout_secs else None,
                         'input_sha256':[hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs],
                         'python_version':sys.version.split()[0],
                         'clock':time.get_clock_info('monotonic').implementation,
                         'attempts':[], 'hard_budget_secs':args.timeout_secs or None,
                         'progress_policy':{'capture':args.capture, 'expected_secs':args.expected_secs,
                                            'inactivity_secs':args.inactivity_secs or None,
                                            'inactivity_grace_secs':args.inactivity_grace_secs}})
        return 0
    state = json.loads(args.state.read_text())
    if args.action == 'finish':
        state.update(status='completed' if args.exit_code == 0 else 'cancelled' if args.exit_code in (130,143) else 'failed',
                     runner_exit_code=args.exit_code, elapsed_secs=time.monotonic()-state['started_monotonic'])
        save(args.state, state)
        return 0
    left = remaining(state)
    if args.action == 'sleep':
        if left is not None and left <= args.seconds:
            time.sleep(left)
            return 124
        time.sleep(args.seconds)
        return 0
    if left is not None and left <= 0:
        print('Runner total deadline exhausted.', file=sys.stderr)
        return 124
    if state['attempts_used'] >= state['max_attempts']:
        print('Runner total call budget exhausted.', file=sys.stderr)
        return 125
    if not command: ap.error('command is required')
    entry = None
    state['attempts_used'] += 1
    index = state['attempts_used']
    entry = {'index':index, 'status':'running', 'actual_model':None,
             'requested_model':command[command.index('--model')+1] if '--model' in command else None}
    state['attempts'].append(entry)
    save(args.state, state)  # consume before spawning; no reset at fallback/continuation
    started = time.monotonic()
    cancelled = 0
    proc = None

    def cancel(signum, frame):
        nonlocal cancelled
        cancelled = signum
        if proc is not None: stop_group(proc)

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    code = 1
    capture = None
    termination_reason = None
    with contextlib.ExitStack() as stack:
        stdin = stack.enter_context(args.stdin.open('rb')) if args.stdin else subprocess.DEVNULL
        stdout = stack.enter_context(args.stdout.open('wb'))
        stderr = stack.enter_context(args.stderr.open('wb'))
        try:
            if cancelled: return 128+cancelled
            proc = subprocess.Popen(command, stdin=stdin, stdout=stdout,
                                    stderr=stderr, start_new_session=True)
            if cancelled: stop_group(proc)
            if args.capture:
                capture = Capture(args.stdout, Path(str(args.out)+'.partial'), args.stdout.with_suffix('.progress'))
            progress_path = args.stdout.with_suffix('.progress.json')
            progress = capture.state if capture else {"capture_health":"unknown", "last_advancing_monotonic":None}
            diagnostic_since = None
            diagnostics = []
            while True:
                now = time.monotonic()
                if capture: capture.read()
                progress.update(elapsed_secs=now-started, process_status='running' if proc.poll() is None else 'exited',
                                provider_status='terminal_result_seen' if capture and capture.terminal else 'unknown',
                                expected_duration_exceeded=bool(args.expected_secs and now-state['started_monotonic'] >= args.expected_secs))
                last = progress.get('last_advancing_monotonic')
                inactive = bool(args.inactivity_secs and last is not None and now-last >= args.inactivity_secs)
                if inactive and diagnostic_since is None:
                    diagnostic_since = now
                    diagnostics.append({"kind":"inactivity_diagnostic", "capture_health":progress['capture_health'],
                                        "last_advancing_monotonic":last, "observed_monotonic":now,
                                        "provider_status":progress['provider_status'], "process_status":progress['process_status']})
                if not inactive:
                    diagnostic_since = None
                progress['inactivity_diagnostics'] = diagnostics
                save(progress_path, progress)
                if cancelled:
                    code = 128+cancelled
                    termination_reason = 'user_cancelled'
                    break
                if proc.poll() is not None:
                    code = proc.returncode
                    break
                left = remaining(state)
                if left is not None and left <= 0:
                    termination_reason = 'hard_budget_exhausted'
                    code = 124
                    break
                if (diagnostic_since is not None and now-diagnostic_since >= args.inactivity_grace_secs
                        and progress['capture_health'] == 'observable'):
                    termination_reason = 'confirmed_inactivity'
                    code = 69
                    break
                time.sleep(0.05)
            # Save evidence before cleanup. Silence on unknown/degraded capture
            # never permits inactivity termination, even with explicit policy.
            progress['termination_reason'] = termination_reason
            save(progress_path, progress)
            stop_group(proc)
            if capture:
                capture.read()
                terminal = capture.terminal
                if code == 0:
                    if (not terminal or terminal.get('is_error') or terminal.get('subtype') != 'success'
                            or not isinstance(terminal.get('result'), str) or not terminal['result'].strip()):
                        code = 65
                        termination_reason = 'incomplete_or_error_result'
                    else:
                        args.out.write_text(terminal['result'])
                        if args.session_id_file and isinstance(terminal.get('session_id'), str):
                            args.session_id_file.write_text(terminal['session_id']+'\n')
                progress.update(termination_reason=termination_reason, process_status='exited', exit_code=code)
                save(progress_path, progress)
            if cancelled:
                code = 128+cancelled
                termination_reason = 'user_cancelled'
        except OSError as exc:
            stderr.write((str(exc)+'\n').encode())
            code = 127
    if entry is not None:
        # The raw files were opened in the durable attempt directory before
        # spawning. Retain their identity; no redundant post-exit raw copy.
        entry['stdout'] = args.stdout.name
        entry['stderr'] = args.stderr.name
        if capture: entry['reported_model'] = capture.state.get('reported_model')
        entry['termination_reason'] = termination_reason
        entry['progress'] = args.stdout.with_suffix('.progress.json').name
        entry.update(status='cancelled' if cancelled else 'timed_out' if code == 124 else 'exited',
                     exit_code=code, elapsed_secs=time.monotonic()-started)
        save(args.state, state)
    return code if code >= 0 else 128-code


if __name__ == '__main__':
    raise SystemExit(main())
