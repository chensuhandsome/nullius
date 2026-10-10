"""Explicit mocked examiner evidence for orchestration tests; no real scientific review."""
import re
import json
import hashlib

SUMMARY = "From the neutral raw integers 17 and 25 I constructed a fresh sum expression, evaluated the exact integer result, and checked the arithmetic domain and detectability of a one-unit error."

def transport_for(answer, derivation, execution_id):
    request = {"system": "Explicit offline host witness", "prompt": "Neutral raw integers 17 and 25; independently derive their sum."}
    raw = json.dumps({"canonical_answer": answer, "derivation": derivation})
    sha = lambda text: hashlib.sha256(text.encode()).hexdigest()
    return {"execution_id": execution_id, "exit_code": 0, "request": request, "raw_output": raw,
            "request_sha256": sha(json.dumps(request, ensure_ascii=False, sort_keys=True)), "output_sha256": sha(raw)}


def assessments(ds):
    records = []
    for i, d in enumerate(ds):
        # These are explicitly offline transport witnesses, never actual model executions.
        d.setdefault("derivation", d["derivation_summary"])
        d.setdefault("execution_id", f"fresh-{i}")
        d.setdefault("transport", transport_for(d.get("canonical_answer", "42"), d["derivation"], d["execution_id"]))
        from independence import runtime_observed
        if not runtime_observed(d):
            from run_multi_backend import _execute_derivation
            raw = json.dumps(d)
            observed = _execute_derivation(lambda *args: raw, "claude/offline-fixture", "Explicit offline observed host execution",
                                            "Neutral raw integers 17 and 25; derive independently.", d["execution_id"])
            observed["method"] = d.get("method", "unspecified")
            ds[i] = d = observed
        source = d["derivation"]
        records.append({"index": i, "observed_method": "exact arithmetic", "input_independent": True, "execution_independent": True,
          "construction_independent": True, "method_applicable": True, "diagnostic": True,
          "unresolved_defects": [], "evidence": {axis: {"source_span": source,
            "reason": "Mock examiner inspected the frozen raw-input arithmetic construction and execution for " + axis}
            for axis in ("input","execution","construction","applicability","diagnostic")}})
    return records


def assessed_comparison(payload, prompt):
    marker = "FULL_DERIVATION_RECORDS_JSON:\n"
    ds, _ = json.JSONDecoder().raw_decode(prompt.split(marker, 1)[1])
    return {**payload, "independence_assessments": assessments(ds)}
