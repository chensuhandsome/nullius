#!/usr/bin/env python3
"""Bounded, tool-free file-prompt execution through the installed DSH CLI."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

# Resolve only the shipped skill payload or this exact source checkout.
if sys.platform == "win32":
    _script_dir = Path(__file__).resolve().parent
    _scripts = _script_dir.parent if _script_dir.name == "bin" else _script_dir
    _windows_runtime = _scripts / "_runtime"
    if not (_windows_runtime / "nullius_windows/process.py").is_file():
        _windows_runtime = _scripts.parents[2] / "packages/shared/python"
    if not (_windows_runtime / "nullius_windows/process.py").is_file():
        raise RuntimeError("Windows process support is missing; refresh this skill installation")
    sys.path.insert(0, str(_windows_runtime))
    from nullius_windows.process import WindowsJobProcess, child_exited as _windows_child_exited, signal_process_tree as _windows_signal_tree, stop_process as _windows_stop

def _OwnedPopen(*args, **kwargs):
    return WindowsJobProcess(*args, **kwargs) if sys.platform == "win32" else subprocess.Popen(*args, **kwargs)

import re
import shutil
import signal
import tempfile
import time


SUPPORTED_VERSION = "0.1.0-rc.7"
EXTRA_DISABLED = {
    "session-title-llm", "agent-instructions", "skill-filesystem", "skill-badge",
    "plan-mode", "repeat-tool-reminder", "settings", "credentials", "llm-deepseek",
}


class RunError(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def publish_output(path: Path, raw: bytes) -> None:
    """Publish complete bytes atomically without replacing an existing delivery."""
    fd, name = tempfile.mkstemp(prefix=".dsh-output-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def runtime(entry: str | None, node: str) -> tuple[list[str], Path, dict]:
    binary = entry or shutil.which("dsh")
    if not binary:
        raise RunError("dsh not found; supply --cli-entry /absolute/path/to/dsh/lib/bin.js")
    path = Path(binary).expanduser().resolve(strict=True)
    root = path.parent.parent
    package = json.loads((root / "package.json").read_text())
    if package.get("name") != "@deepseek-ai/dsh" or package.get("version") != SUPPORTED_VERSION:
        raise RunError(f"unsupported DSH runtime; this runner supports {SUPPORTED_VERSION}")
    if path != (root / "lib/bin.js").resolve():
        raise RunError("--cli-entry must resolve to the installed DSH lib/bin.js")
    node_path = shutil.which(node)
    if not node_path:
        raise RunError("Node executable not found")
    return [node_path, str(path)], root, {
        "package": package["name"], "version": package["version"],
        "entry": str(path), "entry_sha256": digest(path.read_bytes()),
    }


def provider_profile(path: Path, model: str, cap: int | None, effort: str | None) -> dict:
    profile = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(profile, dict):
        raise RunError("provider config must be a JSON object")
    key_ref = profile.get("apiKeyEnv")
    if not isinstance(key_ref, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_ref):
        raise RunError("provider config requires an apiKeyEnv environment-variable reference")
    # Headers and inline credentials can leak through configuration receipts.
    if any(key in profile for key in ("apiKey", "api_key", "headers")):
        raise RunError("inline credentials and headers are unsupported; use apiKeyEnv")
    models = profile.get("models")
    if not isinstance(models, list) or not models or not all(isinstance(m, dict) for m in models):
        raise RunError("provider config requires an explicit nonempty models list")
    selected = [m for m in models if m.get("id") == model]
    if len(selected) != 1:
        raise RunError("requested model must occur exactly once in provider config")
    selected = selected[0]
    # Register only the selected model; do not discover or silently switch routes.
    profile["models"] = [selected]
    if cap is not None:
        selected["maxTokens"] = cap
    if effort is not None:
        levels = selected.get("reasoningEfforts")
        if not isinstance(levels, dict) or effort not in levels:
            raise RunError("reasoning level must be explicitly declared in selected model reasoningEfforts")
        profile["reasoning"] = effort
    profile["retryPolicy"] = {"mode": "normal", "maxRetries": 0}
    return profile


def overlay(root: Path, run: Path, profile: dict, provider: str, model: str, persona: str) -> list:
    base = root.parent / "dsh-base/cordis.patch.yml"
    headless = root.parent / "dsh-headless/cordis.patch.yml"
    ids = set(re.findall(r"^\s*- id: ([\w-]+)\s*$", base.read_text() + "\n" + headless.read_text(), re.M))
    needed = EXTRA_DISABLED | {"llm-pi-ai", "agent-default-model", "session-persistence-jsonl", "system-prompt", "tools", "headless-runner"}
    if not needed <= ids:
        raise RunError("installed profile rows do not match the supported isolation contract")
    rows = [{"id": i, "disabled": True} for i in sorted(ids) if i.startswith("tool-") or i in EXTRA_DISABLED]
    rows += [
        {"id": "tools", "config": {"mode": "native"}},
        {"id": "system-prompt", "config": {"persona": persona}},
        {"id": "llm-pi-ai", "config": {"providers": {provider: profile}}},
        {"id": "agent-default-model", "config": {"provider": provider, "model": model}},
        {"id": "session-persistence-jsonl", "config": {
            "root": str(run / "home/sessions"), "compression": "none", "packChunks": False,
        }},
    ]
    return rows


def check_events(events: list[dict], provider: str, model: str, cap: int | None, effort: str | None) -> tuple[str, dict]:
    if not events or events[0].get("type") != "session" or events[0].get("version") != 0:
        raise RunError("missing or unsupported session log header")
    seqs = [e.get("seq") for e in events[1:]]
    if not seqs or any(not isinstance(s, int) for s in seqs) or seqs != sorted(set(seqs)):
        raise RunError("malformed session event sequence")
    headers = [e["data"]["header"] for e in events if e.get("type") == "request/header"]
    if not headers:
        raise RunError("no durable model request header")
    configs = []
    for header in headers:
        config = header.get("config", {})
        # rc.7 canonical request headers omit tools when the catalog is empty
        # (dsh-session/request-header); a present value must be the empty list.
        if header.get("tools", []) != [] or (config.get("provider"), config.get("model")) != (provider, model):
            raise RunError("unexpected model route or exposed tools")
        if cap is not None and config.get("maxTokens") != cap:
            raise RunError("requested output cap was not applied")
        if effort is not None and config.get("reasoningEffort") != effort:
            raise RunError("requested reasoning level was not applied")
        configs.append(config)
    turns = [e for e in events if e.get("type") == "turn/start"]
    ends = [e for e in events if e.get("type") == "turn/end"]
    if len(turns) != 1 or len(ends) != 1 or ends[0]["data"].get("reason", {}).get("kind") != "completed":
        raise RunError("DSH turn did not complete normally")
    if any(e["seq"] > ends[0]["seq"] and e.get("type") in ("assistant/message", "request/header", "assistant/chunk") for e in events[1:]):
        raise RunError("model events occur after the terminal event")
    texts = []
    sources = []
    for event in events:
        if event.get("type") != "assistant/message":
            continue
        if not turns[0]["seq"] < event["seq"] < ends[0]["seq"]:
            raise RunError("assistant message occurs outside the completed turn")
        message = event["data"]["message"]
        source = message.get("source", {})
        if source.get("kind") != "model" or (source.get("provider"), source.get("model")) != (provider, model):
            raise RunError("assistant message route differs from request")
        response = source.get("replayState", {}).get("response", {})
        if response.get("stopReason") != "stop" or (response.get("provider"), response.get("model")) != (provider, model):
            raise RunError("assistant message lacks a normal provider stop")
        if any(b.get("type") == "tool-call" for b in message["content"]):
            raise RunError("unexpected assistant tool call")
        sources.append({k: response.get(k) for k in ("provider", "model", "responseId", "stopReason")})
        text = "".join(b["text"] for b in message["content"] if b.get("type") == "text")
        texts.append(text)
    if not texts or not texts[-1].strip():
        raise RunError("no complete nonblank assistant text")
    return texts[-1], {"requests": configs, "response_metadata": sources, "provider_attestation": "unknown", "assistant_messages": len(sources)}


def terminate(proc: subprocess.Popen) -> None:
    if sys.platform == "win32":
        _windows_stop(proc)
        return
    # Repeated user cancellation must not abort cleanup and orphan the group.
    handlers = {s: signal.signal(s, signal.SIG_IGN) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        # The leader may exit while descendants ignore TERM.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 10):
        print("dsh-cli-runner requires Python 3.10+", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli-entry", help="Installed DSH lib/bin.js (otherwise resolve dsh on PATH)")
    parser.add_argument("--node-bin", default="node")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--provider-config-file", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--system-prompt-file", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--trace-dir", type=Path)
    parser.add_argument("--timeout-secs", type=float, required=True, help="Total local deadline; strictly positive")
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--reasoning")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    started = time.monotonic()
    run = None
    receipt = {"status": "preflight_failed", "provider": args.provider, "model": args.model, "attempt_limit": 1, "timeout_secs": args.timeout_secs}
    try:
        if not math.isfinite(args.timeout_secs) or args.timeout_secs <= 0:
            raise RunError("timeout-secs must be finite and strictly positive")
        if args.max_tokens is not None and args.max_tokens <= 0:
            raise RunError("max-tokens must be strictly positive")
        if not args.provider.strip() or not args.model.strip():
            raise RunError("provider and model must be nonblank")
        out = args.out.expanduser().absolute()
        if out.exists() or out.is_symlink():
            raise RunError("output path already exists; choose a fresh output path")
        prompt = args.prompt_file.read_text(encoding="utf-8")
        if not prompt.strip() or "\0" in prompt:
            raise RunError("prompt must be nonblank UTF-8 without NUL")
        persona = args.system_prompt_file.read_text(encoding="utf-8") if args.system_prompt_file else ""
        command, root, identity = runtime(args.cli_entry, args.node_bin)
        profile = provider_profile(args.provider_config_file, args.model, args.max_tokens, args.reasoning)
        if not args.dry_run and not os.environ.get(profile["apiKeyEnv"]):
            raise RunError("selected apiKeyEnv is not exported; no credential stores are copied or read")
        trace = (args.trace_dir or Path(str(out) + ".attempts")).expanduser().absolute()
        trace.mkdir(parents=True, exist_ok=True)
        run = Path(tempfile.mkdtemp(prefix="run.", dir=trace))
        run.chmod(0o700)
        (run / "workspace").mkdir()
        (run / "home").mkdir()
        patch = run / "dispatch.patch.json"
        write_json(patch, overlay(root, run, profile, args.provider, args.model, persona))
        env = os.environ.copy()
        env.update(DSH_HOME=str(run / "home"), DSH_TELEMETRY_DISABLED="1")
        env.pop("DSH_TOOLS_MODE", None)
        task = "Task:\n" + prompt
        cmd = command + ["--profile", "headless", "--patch", str(patch), task]
        # execve limits include argv, environment and pointers; Linux also has
        # a per-string 32-page cap. Oversized input is refused, never truncated.
        arg_max = os.sysconf("SC_ARG_MAX")
        size = sum(len(os.fsencode(s)) + 1 for s in cmd) + sum(len(os.fsencode(k + "=" + v)) + 1 for k, v in env.items())
        size += (len(cmd) + len(env) + 2) * 8
        if size + 16384 >= arg_max or (sys.platform.startswith("linux") and len(task.encode()) + 1 > 32 * os.sysconf("SC_PAGE_SIZE")):
            raise RunError("prompt exceeds exec argument budget; partition the task before dispatch")
        receipt.update(runtime=identity, prompt_sha256=digest(prompt.encode()), system_sha256=digest(persona.encode()),
                       provider_config_sha256=digest(args.provider_config_file.read_bytes()), argv_bytes=size,
                       isolated_cwd=str(run / "workspace"), trace=str(run), tool_mode="none")
        if args.dry_run:
            receipt["status"] = "dry_run"
            return 0
        stdout = run / "stdout.txt"
        stderr = run / "stderr.txt"
        with stdout.open("wb") as sout, stderr.open("wb") as serr:
            remaining = args.timeout_secs - (time.monotonic() - started)
            if remaining <= 0:
                raise RunError("deadline exhausted before launch")
            proc = _OwnedPopen(cmd, cwd=run / "workspace", env=env, stdout=sout, stderr=serr, start_new_session=True)
            old_term = signal.getsignal(signal.SIGTERM)
            def cancel(_signum, _frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, cancel)
            try:
                proc.wait(timeout=remaining)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                terminate(proc)
                partial = stdout.read_bytes()
                if partial.strip():
                    (run / "output.partial").write_bytes(partial)
                receipt["status"] = "interrupted"
                raise RunError("deadline or cancellation interrupted the local process group")
            finally:
                signal.signal(signal.SIGTERM, old_term)
                if sys.platform == "win32":
                    _windows_stop(proc)
        receipt["exit_code"] = proc.returncode
        raw = stdout.read_bytes()
        if raw.strip():
            (run / "output.partial").write_bytes(raw)
        if proc.returncode != 0:
            raise RunError("DSH exited unsuccessfully; retain stderr and session log as failure evidence")
        logs = list((run / "home/sessions").rglob("session.jsonl"))
        if len(logs) != 1:
            raise RunError("expected exactly one durable plaintext session log")
        events = [json.loads(line) for line in logs[0].read_text(encoding="utf-8").splitlines()]
        final, evidence = check_events(events, args.provider, args.model, args.max_tokens, args.reasoning)
        if raw.decode("utf-8") != final + "\n":
            raise RunError("stdout differs from the complete committed final assistant text")
        if time.monotonic() - started >= args.timeout_secs:
            raise RunError("deadline exhausted before output delivery")
        out.parent.mkdir(parents=True, exist_ok=True)
        receipt.update(status="completed", evidence=evidence, output_sha256=digest(raw), session_log=str(logs[0]))
        receipt["elapsed_secs"] = time.monotonic() - started
        write_json(run / "receipt.json", receipt)
        publish_output(out, raw)
        return 0
    except (RunError, OSError, ValueError, KeyError, TypeError) as exc:
        receipt["error"] = str(exc) if isinstance(exc, RunError) else f"invalid input or runtime evidence ({type(exc).__name__})"
        if receipt["status"] != "interrupted":
            receipt["status"] = "failed"
        print("dsh-cli-runner: " + receipt["error"], file=sys.stderr)
        return 1
    finally:
        if run is not None:
            if receipt["status"] != "completed":
                receipt["elapsed_secs"] = time.monotonic() - started
                write_json(run / "receipt.json", receipt)
            print(f"dsh-cli-runner: receipt {run / 'receipt.json'}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
