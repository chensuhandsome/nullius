from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/run_dsh.py"
SPEC = importlib.util.spec_from_file_location("dsh_runner", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def events(text="complete result"):
    config = {"provider": "chosen-route", "model": "chosen-model", "maxTokens": 2048, "reasoningEffort": "low"}
    return [
        {"type": "session", "version": 0},
        {"type": "turn/start", "seq": 1, "data": {"turn": 1}},
        {"type": "request/header", "seq": 2, "data": {"header": {"config": config, "tools": []}}},
        {"type": "assistant/message", "seq": 3, "data": {"message": {
            "source": {"kind": "model", "provider": "chosen-route", "model": "chosen-model", "replayState": {
                "response": {"provider": "chosen-route", "model": "chosen-model", "stopReason": "stop", "responseId": "fake-response"}}},
            "content": [{"type": "text", "text": text}]}}},
        {"type": "turn/end", "seq": 4, "data": {"turn": 1, "reason": {"kind": "completed"}}},
    ]


def check(rows):
    return runner.check_events(rows, "chosen-route", "chosen-model", 2048, "low")


def test_complete_message_and_full_unicode():
    text = "Result α\n" + "x" * 150000
    actual, evidence = check(events(text))
    assert actual == text
    assert evidence["provider_attestation"] == "unknown"


def test_canonical_header_omits_empty_tool_catalog():
    rows = events()
    del rows[2]["data"]["header"]["tools"]
    assert check(rows)[0] == "complete result"


def test_final_reasoning_only_message_cannot_reuse_earlier_text():
    rows = events()
    last = json.loads(json.dumps(rows[3]))
    last["seq"] = 4
    last["data"]["message"]["content"] = [{"type": "reasoning", "text": "unfinished"}]
    rows.insert(4, last)
    rows[-1]["seq"] = 5
    with pytest.raises(runner.RunError):
        check(rows)


@pytest.mark.parametrize("change", [
    "length", "error", "wrong-route", "tools", "wrong-cap", "wrong-effort", "missing-stop", "bad-sequence", "blank", "no-header", "no-terminal", "future-version",
])
def test_reject_misleading_success(change):
    rows = events()
    if change in ("length", "error"):
        rows[-1]["data"]["reason"]["kind"] = "max-tokens" if change == "length" else "error"
    elif change == "wrong-route":
        rows[2]["data"]["header"]["config"]["model"] = "other-model"
    elif change == "tools":
        rows[2]["data"]["header"]["tools"] = [{"name": "exit_plan_mode"}]
    elif change == "wrong-cap":
        rows[2]["data"]["header"]["config"]["maxTokens"] = 1024
    elif change == "wrong-effort":
        rows[2]["data"]["header"]["config"]["reasoningEffort"] = "high"
    elif change == "missing-stop":
        del rows[3]["data"]["message"]["source"]["replayState"]
    elif change == "bad-sequence":
        rows[3]["seq"] = 1
    elif change == "blank":
        rows[3]["data"]["message"]["content"] = [{"type": "reasoning", "text": "not final text"}]
    elif change == "no-header":
        del rows[2]
    elif change == "no-terminal":
        rows.pop()
    else:
        rows[0]["version"] = 99
    with pytest.raises(runner.RunError):
        check(rows)


@pytest.fixture
def dispatch(tmp_path):
    package = tmp_path / "@deepseek-ai/dsh"
    (package / "lib").mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh", "version": runner.SUPPORTED_VERSION}))
    ids = runner.EXTRA_DISABLED | {"llm-pi-ai", "agent-default-model", "session-persistence-jsonl", "system-prompt", "tools", "headless-runner", "tool-fs", "tool-web"}
    for name in ("dsh-base", "dsh-headless"):
        base = package.parent / name
        base.mkdir()
        (base / "cordis.patch.yml").write_text("\n".join(f"- id: {i}" for i in sorted(ids)))
    entry = package / "lib/bin.js"
    entry.write_text("// fake installed entry\n")
    fake_node = tmp_path / "fake node"
    fake_node.write_text("#!" + sys.executable + "\n" + '''
import json,os,sys,time,signal
from pathlib import Path
mode=os.environ.get("FAKE_DSH_CASE","complete")
if mode in ("timeout", "cancel"):
    print("usable partial output", flush=True)
    if mode == "cancel":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        Path(os.environ["FAKE_PID_FILE"]).write_text(str(os.getpid()))
    time.sleep(15)
patch=json.loads(Path(sys.argv[sys.argv.index("--patch")+1]).read_text())
assert next(r for r in patch if r["id"]=="plan-mode")["disabled"]
assert next(r for r in patch if r["id"]=="session-title-llm")["disabled"]
assert next(r for r in patch if r["id"]=="credentials")["disabled"]
assert Path.cwd().name == "workspace"
assert os.environ["DSH_TELEMETRY_DISABLED"] == "1"
assert "DSH_TOOLS_MODE" not in os.environ
assert sys.argv[-1].startswith("Task:\\n")
rows=json.loads(os.environ["FAKE_EVENTS"])
if mode == "length": rows[-1]["data"]["reason"]["kind"]="max-tokens"
if mode == "route": rows[2]["data"]["header"]["config"]["model"]="other-model"
root=Path(os.environ["DSH_HOME"])/"sessions/ws/session-fake"
root.mkdir(parents=True)
(root/"session.jsonl").write_text("".join(json.dumps(r)+"\\n" for r in rows))
print("wrong stdout" if mode == "mismatch" else "complete result")
sys.exit(1 if mode == "exit-failure" else 0)
''')
    fake_node.chmod(0o755)
    prompt = tmp_path / "prompt with spaces.txt"
    prompt.write_text("Inspect literal $(touch BAD) and `echo unsafe` inputs.")
    profile = tmp_path / "provider.json"
    profile.write_text(json.dumps({"apiKeyEnv": "TEST_MODEL_KEY", "models": [{"id": "chosen-model", "reasoningEfforts": {"low": "low"}}]}))
    out = tmp_path / "result.txt"
    env = os.environ | {"TEST_MODEL_KEY": "do-not-record-this-secret", "FAKE_EVENTS": json.dumps(events()), "DSH_TOOLS_MODE": "code", "DSH_HOME": str(tmp_path / "user-home")}
    cmd = [sys.executable, str(SCRIPT), "--cli-entry", str(entry), "--node-bin", str(fake_node), "--provider", "chosen-route", "--model", "chosen-model", "--provider-config-file", str(profile), "--prompt-file", str(prompt), "--out", str(out), "--max-tokens", "2048", "--reasoning", "low", "--timeout-secs", "4"]
    return cmd, env, out, tmp_path


def test_dispatch_capture_and_user_home_isolation(dispatch):
    cmd, env, out, root = dispatch
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=8)
    assert result.returncode == 0, result.stderr
    assert out.read_text() == "complete result\n"
    receipt = json.loads(next(Path(str(out) + ".attempts").glob("run.*/receipt.json")).read_text())
    assert receipt["status"] == "completed"
    assert receipt["evidence"]["requests"][0]["maxTokens"] == 2048
    assert not (root / "BAD").exists()
    assert not (root / "user-home").exists()
    assert "do-not-record-this-secret" not in result.stdout + result.stderr + json.dumps(receipt)


@pytest.mark.parametrize("mode", ["length", "route", "mismatch", "exit-failure", "timeout"])
def test_failed_dispatch_never_delivers(dispatch, mode):
    cmd, env, out, root = dispatch
    env["FAKE_DSH_CASE"] = mode
    if mode == "timeout":
        cmd[-1] = "0.4"
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=8)
    assert result.returncode == 1
    assert not out.exists()
    run = next(Path(str(out) + ".attempts").glob("run.*"))
    receipt = json.loads((run / "receipt.json").read_text())
    assert receipt["status"] in ("failed", "interrupted")
    assert (run / "output.partial").exists()


@pytest.mark.parametrize("second_signal", [signal.SIGTERM, signal.SIGINT])
def test_repeated_cancellation_cannot_interrupt_group_cleanup(dispatch, second_signal):
    cmd, env, out, root = dispatch
    pid_file = root / "child.pid"
    env.update(FAKE_DSH_CASE="cancel", FAKE_PID_FILE=str(pid_file))
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = None
    try:
        deadline = time.monotonic() + 3
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert pid_file.exists(), "mock child did not launch"
        child = int(pid_file.read_text())
        proc.send_signal(signal.SIGTERM)
        time.sleep(0.2)
        proc.send_signal(second_signal)
        proc.communicate(timeout=4)
        assert proc.returncode == 1
        assert not out.exists()
        with pytest.raises(ProcessLookupError):
            os.kill(child, 0)
        run = next(Path(str(out) + ".attempts").glob("run.*"))
        assert (run / "output.partial").read_text() == "usable partial output\n"
        assert json.loads((run / "receipt.json").read_text())["status"] == "interrupted"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if child is not None:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_dry_run_without_credentials_does_not_launch(dispatch):
    cmd, env, out, root = dispatch
    del env["TEST_MODEL_KEY"]
    env["FAKE_DSH_CASE"] = "timeout"
    result = subprocess.run(cmd + ["--dry-run"], env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 0
    assert not out.exists()
    run = next(Path(str(out) + ".attempts").glob("run.*"))
    assert not (run / "stdout.txt").exists()


def test_existing_delivery_not_overwritten(dispatch):
    cmd, env, out, root = dispatch
    out.write_text("old delivery")
    result = subprocess.run(cmd, env=env, capture_output=True, timeout=4)
    assert result.returncode == 1
    assert out.read_text() == "old delivery"


def test_atomic_publication_never_leaves_partial_delivery(tmp_path, monkeypatch):
    out = tmp_path / "result"
    def disk_failure(_fd):
        raise OSError("simulated storage failure")
    monkeypatch.setattr(runner.os, "fsync", disk_failure)
    with pytest.raises(OSError):
        runner.publish_output(out, b"complete result")
    assert not out.exists()
    assert list(tmp_path.iterdir()) == []


def test_atomic_publication_refuses_existing_file(tmp_path):
    out = tmp_path / "result"
    out.write_text("previous result")
    with pytest.raises(FileExistsError):
        runner.publish_output(out, b"complete result")
    assert out.read_text() == "previous result"
    assert list(tmp_path.iterdir()) == [out]


def test_oversized_prompt_refused_before_launch(dispatch):
    cmd, env, out, root = dispatch
    (root / "prompt with spaces.txt").write_text("x" * (os.sysconf("SC_ARG_MAX") + 1))
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert "argument budget" in result.stderr
    assert not out.exists()


@pytest.mark.parametrize("bad", [{"headers": {"Authorization": "secret"}}, {"apiKey": "secret"}])
def test_inline_credentials_refused(dispatch, bad):
    cmd, env, out, root = dispatch
    p = root / "provider.json"
    profile = json.loads(p.read_text()) | bad
    p.write_text(json.dumps(profile))
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert "secret" not in result.stdout + result.stderr
