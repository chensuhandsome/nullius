"""Deterministic examiner transport witness; never an independent scientific review."""
import json
import subprocess
import sys
from pathlib import Path

ASSESSOR = Path(__file__).resolve().parents[1] / "scripts/bin/assess_independent_reproduction.py"


def create_assessment(proj, tag, ev_a, ev_b, model="claude/fixture"):
    launcher = proj / "fixture_assessor_launcher.py"
    backend = proj / "fixture_assessor_backend.py"
    backend.write_text('''import argparse,json,sys
p=argparse.ArgumentParser();p.add_argument("--prompt-file",dest="prompt");p.add_argument("--model",dest="models");p.add_argument("--out");a,_=p.parse_known_args();a.models="claude/"+a.models
packet=json.load(open(a.prompt)); records=[]
for i,d in enumerate(packet["derivations"]):
 source=d["derivation"]
 records.append({"index":i,"input_independent":a.models!="claude/contaminated","execution_independent":True,"construction_independent":a.models!="claude/rerun","method_applicable":a.models!="claude/method-defect","diagnostic":a.models!="claude/non-diagnostic","unresolved_defects":[],"evidence":{axis:{"source_span":d["construction_body"] if axis=="construction" else source,"reason":"Offline examiner witness inspected the exact raw-input sum construction and observed execution for "+axis} for axis in ("input","execution","construction","applicability","diagnostic")}})
result={"methods":["independent direct sum","independent direct sum"],"families":["fixture"],"independence_assessments":records}
open(a.out,"w").write(json.dumps(result))
if a.models=="claude/failure":sys.exit(1)
''', encoding="utf-8")
    backend_shell = proj / "fixture_assessor_backend.sh"
    backend_shell.write_text("#!/usr/bin/env bash\nexec " + repr(sys.executable) + " " + repr(str(backend)) + ' "$@"\n')
    backend_shell.chmod(0o755)
    common_bin = Path(__file__).resolve().parents[2] / "review-swarm/scripts/bin"
    launcher.write_text("import sys,os\nsys.path.insert(0," + repr(str(common_bin)) + ")\nimport run_multi_task\nos.environ['REVIEW_SWARM_NO_AUTO_CONFIG']='1'\nsys.argv += ['--claude-runner'," + repr(str(backend_shell)) + "]\nraise SystemExit(run_multi_task.main())\n",encoding="utf-8")
    out = proj / f"artifacts/runs/{tag}/research_team/independence_assessment.json"
    (proj / "fixture_assessor_invocation.json").write_text(json.dumps({"model": model, "runner": str(launcher)}))
    proc = subprocess.run([sys.executable, str(ASSESSOR), "--notes", str(proj / "notes.md"),
        "--project-root", str(proj), "--tag", tag, "--member-a", str(ev_a), "--member-b", str(ev_b),
        "--runner", str(launcher), "--model", model, "--context-tokens", "1000000", "--context-bytes", "800000", "--out", str(out)], cwd=proj, capture_output=True, text=True)
    return proc, out
