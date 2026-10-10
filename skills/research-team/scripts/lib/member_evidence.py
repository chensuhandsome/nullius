#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_CAPTURE_BIN = Path(__file__).resolve().parents[3] / "review-swarm/scripts/bin"
if str(_CAPTURE_BIN) not in sys.path:
    sys.path.insert(0, str(_CAPTURE_BIN))
from runtime_capture_observation import verify_member_episode


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _run_capture(cmd: list[str], cwd: Path | None = None, timeout: int | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd is not None else None,
        timeout=timeout,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def detect_git_commit(project_root: Path) -> str:
    try:
        proc = _run_capture(["git", "rev-parse", "HEAD"], cwd=project_root, timeout=10)
        if proc.returncode == 0:
            out = proc.stdout.decode("utf-8", errors="replace").strip()
            if out:
                return out
    except Exception:
        pass
    return ""


def detect_python_version() -> str:
    try:
        proc = _run_capture(["python3", "-V"], timeout=5)
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", errors="replace").strip()
    except Exception:
        pass
    return ""


def detect_julia_version() -> str:
    try:
        proc = _run_capture(["julia", "--version"], timeout=5)
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", errors="replace").strip()
    except Exception:
        pass
    return ""


def default_environment(project_root: Path) -> dict[str, Any]:
    return {
        "os": platform.platform(),
        "python_version": detect_python_version(),
        "julia_version": detect_julia_version(),
        "git_commit": detect_git_commit(project_root),
        "cwd": str(Path.cwd()),
    }


def new_member_evidence(member_id: str, mode: str, project_root: Path) -> dict[str, Any]:
    return {
        "version": 1,
        "member_id": member_id,
        "mode": mode,
        "timestamps": {"start_utc": now_utc(), "end_utc": ""},
        "files_read": [],
        "commands_run": [],
        "network_queries": [],
        "fetched_sources": [],
        "outputs_produced": [],
        "environment": default_environment(project_root),
        "convention_mappings": [],
    }


def finalize_member_evidence(evidence: dict[str, Any]) -> None:
    ts = evidence.get("timestamps")
    if isinstance(ts, dict):
        ts["end_utc"] = now_utc()


def _append_list(evidence: dict[str, Any], key: str, item: dict[str, Any]) -> None:
    arr = evidence.get(key)
    if not isinstance(arr, list):
        arr = []
        evidence[key] = arr
    arr.append(item)


def artifact_ref(path: Path, project_root: Path) -> dict[str, Any]:
    p, root = path.resolve(), project_root.resolve()
    if not p.is_relative_to(root):
        raise ValueError(f"transport artifact outside project root: {p}")
    data = p.read_bytes()
    return {"path": p.relative_to(root).as_posix(), "sha256": sha256_bytes(data), "size_bytes": len(data)}


def record_original_stage(evidence: dict[str, Any], stage: str, invocation: dict[str, Any],
                          system: Path, prompt: Path, output: Path, project_root: Path) -> None:
    record = dict(invocation)
    for key, path in (("system", system), ("prompt", prompt), ("output", output)):
        record[key] = artifact_ref(path, project_root) if path.is_file() else None
        if record[key]:
            log_output_produced(evidence, record[key]["path"], record[key]["sha256"], f"original {stage} {key}")
    evidence.setdefault("original_transport", {"version": 1, "stages": {}})["stages"][stage] = record


def validate_original_transport(evidence: dict[str, Any], project_root: Path) -> dict[str, Any]:
    """Validate original member invocations before any independence assessment."""
    root = project_root.resolve()
    rec = evidence.get("original_transport")
    if not isinstance(rec, dict) or type(rec.get("version")) is not int or rec["version"] != 1:
        raise ValueError("missing typed original member transport")
    if rec.get("pending_operations"):
        raise ValueError("unavailable: original proxy requests remain pending")
    material: dict[str, str] = {}
    refs: list[dict[str, Any]] = []
    def read(ref: Any, label: str) -> str:
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
            raise ValueError(f"missing original {label}")
        p = (root / ref["path"]).resolve()
        if not p.is_relative_to(root) or p.relative_to(root).as_posix() != ref["path"]:
            raise ValueError(f"noncanonical original {label}")
        data = p.read_bytes()
        if (sha256_bytes(data) != ref.get("sha256") or type(ref.get("size_bytes")) is not int
                or len(data) != ref["size_bytes"]):
            raise ValueError(f"stale original {label}")
        refs.append(ref)
        text = data.decode("utf-8")
        material[label] = text
        return text
    packet = read(rec.get("packet"), "packet")
    read(rec.get("runner"), "runner")
    stages = rec.get("stages")
    if not isinstance(stages, dict) or set(stages) != {"requests", "final"}:
        raise ValueError("missing original requests/final invocation")
    for name in ("requests", "final"):
        stage = stages[name]
        if (not isinstance(stage, dict) or type(stage.get("exit_code")) is not int or stage["exit_code"] != 0
                or stage.get("inputs_unchanged") is not True or not isinstance(stage.get("argv"), list)
                or not stage["argv"] or not all(isinstance(x, str) for x in stage["argv"])):
            raise ValueError(f"failed/unverifiable original {name} invocation")
        for key in ("system", "prompt", "output"):
            read(stage.get(key), f"{name}.{key}")
        captured = stage.get("input_sha256")
        if not isinstance(captured, dict) or any(captured.get(key) != stage[key]["sha256"] for key in ("system", "prompt")) or captured.get("runner") != rec["runner"]["sha256"]:
            raise ValueError(f"original {name} input differs from pre-invocation full-byte capture")
        argv = stage["argv"]
        for flag, key in (("--prompt-file", "prompt"), ("--out", "output")):
            if flag not in argv or argv.index(flag) + 1 >= len(argv) or Path(argv[argv.index(flag)+1]).resolve() != (root / stage[key]["path"]).resolve():
                raise ValueError(f"original {name} {key} not bound to actual invocation")
        if "--system-prompt-file" in argv and Path(argv[argv.index("--system-prompt-file")+1]).resolve() != (root / stage["system"]["path"]).resolve():
            raise ValueError(f"original {name} system not bound to invocation")
        if packet not in material[f"{name}.prompt"]:
            raise ValueError(f"original packet absent from {name} input")
    if material["requests.system"] != material["final.system"]:
        raise ValueError("original system differs between invocations")
    # Parse exactly the request-stage raw output used by the proxy.
    raw = material["requests.output"]
    decoder = json.JSONDecoder(); request = None
    for i, c in enumerate(raw):
        if c == "{":
            try: request, _ = decoder.raw_decode(raw[i:]); break
            except ValueError: pass
    if not isinstance(request, dict):
        raise ValueError("unreadable original proxy request")
    request = request.get("requests", request)
    if not isinstance(request, dict):
        raise ValueError("invalid original proxy request")
    requested_writes = request.get("files_written", [])
    constructions = rec.get("construction_refs", [])
    if not isinstance(requested_writes, list) or not isinstance(constructions, list):
        raise ValueError("invalid typed original source constructions")
    write_indices = set()
    for entry in constructions:
        if not isinstance(entry, dict) or entry.get("kind") != "model_source_write":
            raise ValueError("invalid typed original source construction")
        index = entry.get("request_index")
        if type(index) is not int or not 0 <= index < len(requested_writes) or index in write_indices:
            raise ValueError("unbound/duplicate original source write")
        write_indices.add(index); original = requested_writes[index]
        if not isinstance(original, dict) or not all(isinstance(original.get(key), str) for key in ("path", "content", "purpose")):
            raise ValueError("invalid original source-write request")
        target = (root / entry.get("path", "")).resolve()
        # The actual invocation packet may live outside run artifacts; source path
        # itself supplies the run scope, validated independently below.
        parts = Path(entry.get("path", "")).parts
        if len(parts) < 7 or parts[:2] != ("artifacts", "runs") or parts[3:6] != ("research_team", evidence["member_id"], "independent"):
            raise ValueError("source construction outside own independent prefix")
        if not target.is_relative_to(root) or target.relative_to(root).as_posix() != entry["path"]:
            raise ValueError("noncanonical source construction")
        raw_content = read(entry.get("raw_input_ref"), f"source_write[{index}]")
        expected = original["content"].encode("utf-8")
        original_path = (root / original["path"]).resolve()
        if (type(entry.get("created")) is not bool or entry.get("origin_stage") != "requests" or entry.get("source_ref") != stages["requests"]["output"]
                or original_path != target or raw_content != original["content"]
                or type(entry.get("size_bytes")) is not int or entry["size_bytes"] != len(expected)
                or entry.get("sha256") != sha256_bytes(expected) or target.read_bytes() != expected):
            raise ValueError("source construction differs from complete original model bytes")
    if write_indices != set(range(len(requested_writes))):
        raise ValueError("missing/denied original source write")
    for field in ("files_read", "commands_run", "network_queries"):
        requested = request.get(field, []) or []
        if not isinstance(requested, list):
            raise ValueError(f"invalid original {field} request")
        indices = set()
        for entry in evidence.get(field, []):
            idx = entry.get("request_index")
            if type(idx) is not int or idx < 0 or idx >= len(requested) or idx in indices or not isinstance(requested[idx], dict):
                raise ValueError(f"unbound/duplicate original {field} item")
            indices.add(idx); original = requested[idx]
            if field == "commands_run":
                if entry.get("command") != str(original.get("command", "")).strip() or entry.get("requested_cwd") != (str(original.get("cwd", ".")).strip() or "."):
                    raise ValueError("proxy command differs from original request")
                if type(entry.get("exit_code")) is not int or entry["exit_code"] != 0:
                    raise ValueError("proxy command failed")
                inputs = entry.get("input_files")
                if not isinstance(inputs, list):
                    raise ValueError("missing original proxy command input closure")
                from source_inputs import local_source_closure
                current_inputs = [(root / item["path"]).resolve() for item in inputs]
                import shlex
                cwd = Path(entry.get("cwd", "."))
                cwd = cwd if cwd.is_absolute() else root / cwd
                if not cwd.resolve().is_relative_to(root):
                    raise ValueError("original proxy command working directory outside project")
                outputs = original.get("expected_outputs", []) or []
                if not isinstance(outputs, list) or not all(isinstance(x, str) for x in outputs):
                    raise ValueError("invalid original expected outputs")
                produced_paths = {(cwd / x).resolve() for x in outputs}
                direct_inputs = set()
                for token in shlex.split(original["command"])[1:]:
                    path = (cwd / token).resolve()
                    try:
                        local_file = path.is_relative_to(root) and path.is_file()
                    except OSError:
                        local_file = False
                    if local_file and path not in produced_paths:
                        direct_inputs.add(path)
                declared = original.get("input_files", [])
                if not isinstance(declared, list) or not all(isinstance(x, str) for x in declared):
                    raise ValueError("invalid original declared runtime inputs")
                for value in declared:
                    declared_path = (cwd / value).resolve()
                    if not declared_path.is_relative_to(root) or not declared_path.is_file():
                        raise ValueError("missing/outside original declared runtime input")
                    direct_inputs.add(declared_path)
                if not direct_inputs.issubset(set(current_inputs)):
                    raise ValueError("missing original direct proxy command input")
                if set(local_source_closure(current_inputs, root, cwd=cwd.resolve())) != set(current_inputs):
                    raise ValueError("missing original recursive proxy command input")
                for j, item in enumerate(inputs):
                    snapshot = read(item.get("raw_input_ref"), f"command_input[{idx},{j}]")
                    current = (root / item["path"]).resolve()
                    if not current.is_relative_to(root) or sha256_file(current) != item.get("sha256") or sha256_bytes(snapshot.encode("utf-8")) != item.get("sha256"):
                        raise ValueError("stale original proxy command input")
            elif field == "files_read":
                if entry.get("requested_path") != str(original.get("path", "")).strip():
                    raise ValueError("proxy file differs from original request")
                snapshot = read(entry.get("raw_input_ref"), f"file_read[{idx}]")
                current = (root / entry["path"]).resolve()
                if not current.is_relative_to(root) or sha256_file(current) != entry.get("sha256") or sha256_bytes(snapshot.encode("utf-8")) != entry.get("sha256"):
                    raise ValueError("stale full-byte proxy read")
            elif entry.get("query_or_url") != str(original.get("query_or_url", original.get("url", ""))).strip():
                raise ValueError("proxy network input differs from original request")
        if indices != set(range(len(requested))):
            raise ValueError(f"missing/denied original {field} request indices")
    proxy = read(rec.get("proxy_input"), "proxy_input")
    if proxy not in material["final.prompt"]:
        raise ValueError("recorded proxy input absent from actual final prompt")
    final = stages["final"]["output"]
    if not any(isinstance(x, dict) and x.get("path") == final["path"] and x.get("sha256") == final["sha256"] and x.get("description") == "member report" for x in evidence.get("outputs_produced", [])):
        raise ValueError("final raw output differs from member report")
    produced = {x.get("path"): x.get("sha256") for x in evidence.get("outputs_produced", []) if isinstance(x, dict)}
    if any(produced.get(ref["path"]) != ref["sha256"] for ref in refs):
        raise ValueError("original transport missing from outputs_produced closure")
    verify_member_episode(evidence, root)
    read(rec.get("runtime_observation"), "runtime_member_episode")
    report_paths = [x["path"] for x in evidence.get("outputs_produced", []) if isinstance(x, dict)
                    and isinstance(x.get("path"), str) and x.get("description") == "member report"
                    and x.get("sha256") == final["sha256"]]
    return {"refs": refs, "material": material, "report_path": final["path"], "report_paths": report_paths}



def original_source_origin(path: Path, original: dict[str, Any], project_root: Path, member: str) -> dict[str, Any]:
    """Bind an own-prefix source to one complete original model-emitted string.

    Whole JSON strings or whole fenced code bodies are allowed; substring matches,
    labels, base64 locators and source-assessor booleans cannot establish origin.
    Shared libraries outside the member construction prefix are assessed separately.
    """
    target, root = path.resolve(), project_root.resolve()
    if not target.is_relative_to(root):
        raise ValueError("source origin outside project root")
    parts = target.relative_to(root).parts
    if len(parts) < 7 or parts[:2] != ("artifacts", "runs") or parts[3:6] != ("research_team", member, "independent"):
        raise ValueError("source origin outside own independent prefix")
    data = target.read_bytes(); data.decode("utf-8")
    def strings(value: Any, locator: list[Any]):
        if isinstance(value, str):
            yield value, locator
        elif isinstance(value, dict):
            for key, item in value.items(): yield from strings(item, [*locator, key])
        elif isinstance(value, list):
            for index, item in enumerate(value): yield from strings(item, [*locator, index])
    import re
    for stage in ("requests", "final"):
        raw = original["material"][stage + ".output"]
        candidates = [(raw, ["whole_output"])]
        decoder = json.JSONDecoder()
        for index, character in enumerate(raw):
            if character not in "{[": continue
            try:
                value, _ = decoder.raw_decode(raw[index:])
            except ValueError: continue
            candidates.extend(strings(value, ["json", index]))
            break
        for index, match in enumerate(re.finditer(r"^```[^\n]*\n(.*?)^```[ \t]*$", raw, re.MULTILINE | re.DOTALL)):
            candidates.append((match.group(1), ["code_fence", index]))
        for candidate, locator in candidates:
            if candidate.encode("utf-8") == data:
                return {"kind": "complete_model_output_source", "member_id": member,
                        "path": target.relative_to(root).as_posix(), "sha256": sha256_bytes(data),
                        "size_bytes": len(data), "origin_stage": stage, "locator": locator}
    raise ValueError(f"UNVERIFIABLE_SOURCE_ORIGIN: {target.relative_to(root)} is not complete original {member} model-emitted source")


def log_file_read(evidence: dict[str, Any], path: str, anchor_or_line: str, purpose: str) -> None:
    _append_list(
        evidence,
        "files_read",
        {
            "path": path,
            "anchor_or_line": anchor_or_line,
            "purpose": purpose,
        },
    )


def log_command_run(
    evidence: dict[str, Any],
    command: str,
    cwd: str,
    exit_code: int,
    output_sha256: str,
    output_path: str,
) -> None:
    _append_list(
        evidence,
        "commands_run",
        {
            "command": command,
            "cwd": cwd,
            "timestamp_utc": now_utc(),
            "exit_code": int(exit_code),
            "output_sha256": output_sha256,
            "output_path": output_path,
        },
    )


def log_network_query(
    evidence: dict[str, Any],
    query_or_url: str,
    justification: str,
    downloaded_to: str,
) -> None:
    _append_list(
        evidence,
        "network_queries",
        {
            "query_or_url": query_or_url,
            "timestamp_utc": now_utc(),
            "justification": justification,
            "downloaded_to": downloaded_to,
        },
    )


def log_fetched_source(
    evidence: dict[str, Any],
    original_url: str,
    local_path_under_references: str,
    sha256: str,
    size_bytes: int,
) -> None:
    _append_list(
        evidence,
        "fetched_sources",
        {
            "original_url": original_url,
            "local_path_under_references": local_path_under_references,
            "sha256": sha256,
            "size_bytes": int(size_bytes),
        },
    )


def log_output_produced(evidence: dict[str, Any], path: str, sha256: str, description: str) -> None:
    _append_list(
        evidence,
        "outputs_produced",
        {
            "path": path,
            "sha256": sha256,
            "description": description,
        },
    )


def log_convention_mapping(evidence: dict[str, Any], mapping: dict[str, Any]) -> None:
    _append_list(evidence, "convention_mappings", mapping)


def load_evidence(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def save_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class EvidenceIssue:
    level: str  # ERROR/WARN
    message: str


def validate_member_evidence_schema(evidence: dict[str, Any]) -> list[EvidenceIssue]:
    issues: list[EvidenceIssue] = []

    def err(msg: str) -> None:
        issues.append(EvidenceIssue("ERROR", msg))

    def warn(msg: str) -> None:
        issues.append(EvidenceIssue("WARN", msg))

    if not isinstance(evidence, dict):
        return [EvidenceIssue("ERROR", f"expected JSON object, got {type(evidence).__name__}")]

    ver = evidence.get("version")
    if not isinstance(ver, int) or ver < 1:
        err("missing/invalid required field: version (int >= 1)")

    member_id = evidence.get("member_id")
    if not isinstance(member_id, str) or not member_id.strip():
        err("missing/invalid required field: member_id (non-empty string)")

    mode = evidence.get("mode")
    if not isinstance(mode, str) or mode not in ("full_access", "packet_only"):
        err("missing/invalid required field: mode (full_access|packet_only)")

    ts = evidence.get("timestamps")
    if not isinstance(ts, dict):
        err("missing/invalid required field: timestamps (object)")
    else:
        if not isinstance(ts.get("start_utc"), str) or not str(ts.get("start_utc")).strip():
            err("timestamps.start_utc must be a non-empty string")
        if "end_utc" in ts and ts.get("end_utc") is not None and not isinstance(ts.get("end_utc"), str):
            err("timestamps.end_utc must be a string (or empty)")

    for k in ("files_read", "commands_run", "network_queries", "fetched_sources", "outputs_produced", "convention_mappings"):
        if k not in evidence:
            err(f"missing required field: {k} (array)")
            continue
        if not isinstance(evidence.get(k), list):
            err(f"{k} must be an array")

    env = evidence.get("environment")
    if not isinstance(env, dict):
        err("missing/invalid required field: environment (object)")
    else:
        if not isinstance(env.get("os", ""), str):
            err("environment.os must be a string")
        if not isinstance(env.get("git_commit", ""), str):
            err("environment.git_commit must be a string")

    # Mode-specific constraints.
    if isinstance(mode, str) and mode == "packet_only":
        for k in ("files_read", "commands_run", "network_queries"):
            if isinstance(evidence.get(k), list) and len(evidence.get(k)) != 0:
                err(f"packet_only mode requires {k} to be an empty array")
    if isinstance(mode, str) and mode == "full_access":
        fr = evidence.get("files_read") if isinstance(evidence.get("files_read"), list) else []
        cr = evidence.get("commands_run") if isinstance(evidence.get("commands_run"), list) else []
        op = evidence.get("outputs_produced") if isinstance(evidence.get("outputs_produced"), list) else []
        if len(fr) == 0 and len(cr) == 0 and len(op) == 0:
            err("full_access mode requires at least one of files_read / commands_run / outputs_produced to be non-empty")

    # Lightweight sanity checks for item shapes (warn-only to keep backward compatibility as schema evolves).
    if isinstance(evidence.get("commands_run"), list):
        for i, it in enumerate(evidence["commands_run"]):
            if not isinstance(it, dict):
                warn(f"commands_run[{i}] is not an object")
                continue
            if not isinstance(it.get("command"), str) or not it.get("command", "").strip():
                warn(f"commands_run[{i}].command missing/invalid")
            if not isinstance(it.get("exit_code"), int):
                warn(f"commands_run[{i}].exit_code missing/invalid")
    if isinstance(evidence.get("outputs_produced"), list):
        for i, it in enumerate(evidence["outputs_produced"]):
            if not isinstance(it, dict):
                warn(f"outputs_produced[{i}] is not an object")
                continue
            if not isinstance(it.get("path"), str) or not it.get("path", "").strip():
                warn(f"outputs_produced[{i}].path missing/invalid")
            if not isinstance(it.get("sha256"), str) or not it.get("sha256", "").strip():
                warn(f"outputs_produced[{i}].sha256 missing/invalid")

    return issues
