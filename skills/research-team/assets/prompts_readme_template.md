# prompts/README.md

This folder contains prompt files used by the `research-team` workflow.

Note:
- Files prefixed with `_` are scaffolded defaults used by scripts.
- Customize them per project (they are meant to be edited).

Team cycle (theory+computation cross-check):
- `_team_packet.txt`: optional packet template (if you build packets manually)
- `_system_member_a.txt`: Member A system prompt (default host-native subagent; provider CLI override supported)
- `_system_member_b.txt`: Member B system prompt (default host-native subagent; provider CLI override supported)
- `_system_member_c_numerics.txt`: optional numerics sidecar (non-blocking)

Scientific notebook closeout:
- Member packets may contain short excerpts or deltas for selected-claim review;
  their verdicts do not establish whole-notebook acceptance.
- In file and engine mode, execute `nullius notebook review --model claude/opus` with
  required supporting files declared by repeated `--dependency`, then run
  unscoped `nullius notebook check --json`. It requires structural navigation and an accepted
  full-text review bound to SHA-256 of the current complete UTF-8 notebook
  (automatic block and uncommitted edits included) and necessary dependencies.
- The report needs every section covered with source-anchored reasoning on
  derivations, logic, notation, definitions, assumptions and conventions. Missing,
  partial, failed, unavailable, invalid or stale review does not pass; changed
  bytes require a new review while old reports remain readable.
- `--result` narrows only links; `--structure-only` establishes navigation alone.
  Links, formula counts, tables, checklists and writer self-assessment cannot
  supply a content verdict. Semantic acceptance is not scientific proof or
  decisive computation validation; retain the applicable claim-specific checks.
- Scaffolding preserves existing prompt copies. Merge updated guidance explicitly
  into project customizations; updating a skill does not update those files.

Automatically linked binary or oversized files are immutable opaque snapshots
and SHA-256 locators in `opaque_links`. They participate in review-swarm manifest
freshness, but are neither embedded nor read. The report's `opaque_sources` must
explain every path, hash and `required_for_reasoning`; a missing assessment or any
required unread source prevents acceptance. Supply independently checked readable
text dependencies for reasoning that depends on such material. Hash identity is
not semantic reading. The notebook and explicit `--dependency` inputs require
strict UTF-8; the text packet closure is limited to 1 MiB and total snapshot
storage to 64 MiB, with refusal rather than silent truncation. This review
currently accepts only tool mode `none`; other modes are unavailable. It executes
one reviewer and does not establish a cross-family quorum.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

Draft cycle (LaTeX-source-first):
- `_system_draft_member_a.txt`: correctness audit (derivations/methods/results consistency)
- `_system_draft_member_b.txt`: literature positioning + substance-first writing audit
- `_system_draft_member_c_leader.txt`: team-leader style audit (equation-by-equation physics/math recomputation; strict correctness-blocking)
  - Evidence gate (anti-hallucination): any concrete claim about data provenance/sampling/uncertainties/weighting must be backed by an explicit packet anchor; otherwise treat as a blocking evidence gap and request the minimal missing excerpt.
